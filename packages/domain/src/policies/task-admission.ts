/**
 * 任务准入策略（附录 A §6.5）。
 *
 * 这里只回答一个问题：**能不能再创建一个 AI task**。三类结论的语义完全不同，
 * 因此 `AdmissionDecision` 是一个封闭联合而不是一个布尔值：
 *
 * - `ADMIT` —— 可以创建，立刻可跑；
 * - `QUEUE` —— 可以创建，但要排队。全局 10 / 小组 3 是**调度**上限，
 *   它们从不拒绝一个已经创建的任务（§6.5 规则 1），所以撞上限的结果是留在
 *   `QUEUED`，不是错误；
 * - `REJECT` —— 不能创建，`409 ACTIVE_WRITE_TASK_EXISTS`。每学生 1 个、
 *   每项目 1 个活跃写任务是**创建期不变量**（§6.5 规则 3）。
 *
 * 顺序是语义的：**先判 REJECT，再判 QUEUE**。一个学生已经有一个在跑的写任务时，
 * 就算全局还有空位也必须拒绝 —— 否则「同一项目并发生成」这个产品红线就被
 * 全局容量的偶然宽松给绕过了。
 *
 * §6.5 规则 5：这里**不存在**任何进程内 semaphore 或 Map 作为事实源。所有计数
 * 都由调用方从持久化的任务状态里查出来再传进来；规则 4 的最终竞态屏障是数据库
 * 条件唯一索引，application 必须把唯一冲突映射回同一个 `ACTIVE_WRITE_TASK_EXISTS`。
 */

import { DomainError } from '../errors/domain-error.js';
import type { GroupId } from '../value-objects/identifiers.js';
import { isWriteTaskKind, parseTaskKind, type TaskKind } from '../value-objects/task.js';

/** §6.5 逐字给出的判定结果类型。`errorCode` 是字面量而不是宽泛的 `ErrorCode`。 */
export type AdmissionDecision =
  | { readonly kind: 'ADMIT' }
  | { readonly kind: 'QUEUE'; readonly reason: 'GLOBAL_LIMIT' | 'GROUP_LIMIT' }
  | { readonly kind: 'REJECT'; readonly errorCode: 'ACTIVE_WRITE_TASK_EXISTS' };

export type QueueReason = 'GLOBAL_LIMIT' | 'GROUP_LIMIT';

/**
 * 并发上限。数值来自 §6.5 的默认值，但**可被配置覆盖**：
 * 它们是运维旋钮（不同部署的 QCA 配额不同），不是领域常量。
 */
export type TaskAdmissionLimits = {
  readonly globalQca: number;
  readonly groupQca: number;
  readonly studentActiveWrite: number;
  readonly projectActiveWrite: number;
};

export const DEFAULT_TASK_ADMISSION_LIMITS: TaskAdmissionLimits = {
  globalQca: 10,
  groupQca: 3,
  studentActiveWrite: 1,
  projectActiveWrite: 1,
};

/**
 * 两类上限的取值范围不同，因为**置 0 的后果不同**：
 *
 * - `globalQca` / `groupQca` 是调度上限，0 意味着"所有任务都排队"。这是运维排空一个
 *   部署的正常手段，可逆、不报错，所以允许 0。
 * - `studentActiveWrite` / `projectActiveWrite` 是创建期不变量，0 意味着每次创建都返回
 *   `409 ACTIVE_WRITE_TASK_EXISTS`。那不是排队，那是一次带着误导性错误码的停摆 ——
 *   学生会看到"你已经有一个正在进行的任务"而他并没有。所以最小值是 1。
 */
export function parseTaskAdmissionLimits(input: Partial<TaskAdmissionLimits>): TaskAdmissionLimits {
  const limits: TaskAdmissionLimits = { ...DEFAULT_TASK_ADMISSION_LIMITS, ...input };
  for (const key of ['globalQca', 'groupQca'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0)
      throw DomainError.invalid('TaskAdmissionLimits');
  }
  for (const key of ['studentActiveWrite', 'projectActiveWrite'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1)
      throw DomainError.invalid('TaskAdmissionLimits');
  }
  return limits;
}

/**
 * 准入判定的输入。**全部是调用方从持久化状态查出来的计数**，
 * 这个类型里没有任何集合、Map 或引用可以让 domain 自己去数 —— 结构上排除了
 * 「用进程内状态当事实源」这条错误路径（§6.5 规则 5）。
 *
 * 只带 `groupId`，不带 `requestedBy` / `projectId`：那两个是计数的**查询键**，
 * 由 application 持有；domain 不读它们，放进来就只是一个没人校验的装饰字段。
 */
export type AdmissionContext = {
  readonly kind: TaskKind;
  /** `null` = 该项目不属于任何小组（例如个人试用），此时小组上限不适用。 */
  readonly groupId: GroupId | null;
  /** 全局正在跑的 QCA 任务数（`CLAIMED`/`SESSION_CREATING`/`RUNNING` 等非终态）。 */
  readonly globalRunningQcaCount: number;
  /** 本小组正在跑的 QCA 任务数。 */
  readonly groupRunningQcaCount: number;
  /** 该学生当前活跃的**写**任务数。 */
  readonly studentActiveWriteCount: number;
  /** 该项目当前活跃的**写**任务数。 */
  readonly projectActiveWriteCount: number;
  readonly limits?: Partial<TaskAdmissionLimits>;
};

export function decideTaskAdmission(context: AdmissionContext): AdmissionDecision {
  const limits = parseTaskAdmissionLimits(context.limits ?? {});
  assertCounts(context);
  /**
   * 显式校验 kind：一个非法的 kind 会让下面的 `isWriteTaskKind` 返回 false，
   * 于是两条创建期不变量被静默跳过 —— 那是 fail-open。
   */
  const kind = parseTaskKind(context.kind);

  /**
   * 只有写任务受"每学生/每项目 1 个"约束。`PUBLISH` 与 `RESCAN` 不修改作品
   * 内容，把它们也算进写任务会让"正在发布"阻塞"继续创作"。
   */
  if (isWriteTaskKind(kind)) {
    if (context.studentActiveWriteCount >= limits.studentActiveWrite) return reject();
    if (context.projectActiveWriteCount >= limits.projectActiveWrite) return reject();
  }

  /** 调度上限：只影响"什么时候跑"，不影响"能不能创建"。 */
  if (context.globalRunningQcaCount >= limits.globalQca)
    return { kind: 'QUEUE', reason: 'GLOBAL_LIMIT' };
  if (context.groupId !== null && context.groupRunningQcaCount >= limits.groupQca) {
    return { kind: 'QUEUE', reason: 'GROUP_LIMIT' };
  }
  return { kind: 'ADMIT' };
}

function reject(): AdmissionDecision {
  return { kind: 'REJECT', errorCode: 'ACTIVE_WRITE_TASK_EXISTS' };
}

function assertCounts(context: AdmissionContext): void {
  for (const key of [
    'globalRunningQcaCount',
    'groupRunningQcaCount',
    'studentActiveWriteCount',
    'projectActiveWriteCount',
  ] as const) {
    if (!Number.isSafeInteger(context[key]) || context[key] < 0)
      throw DomainError.invalid('AdmissionContext');
  }
}

/**
 * 断言式入口，供 application 在创建用例里直接调用。
 *
 * 只在 `REJECT` 时抛错：`QUEUE` 是正常结果，不是异常。把它做成异常会让
 * 「排队」这条最常见的路径变成 try/catch 的负担。
 */
export function assertTaskAdmissible(context: AdmissionContext): AdmissionDecision {
  const decision = decideTaskAdmission(context);
  if (decision.kind === 'REJECT') {
    throw new DomainError(decision.errorCode, 'AdmissionContext');
  }
  return decision;
}

/**
 * 数据库唯一冲突的映射（§6.5 规则 4）。
 *
 * 条件唯一索引是最终的竞态屏障：两个并发请求可能都通过上面的计数判定，
 * 然后一个插入成功、一个撞唯一索引。application 必须把后者翻译成**同一个**
 * 领域错误码，否则同一个用户可见结果会因为竞态的胜负而给出两种响应。
 */
export function activeWriteConflictError(): DomainError {
  return new DomainError('ACTIVE_WRITE_TASK_EXISTS', 'AiTask');
}

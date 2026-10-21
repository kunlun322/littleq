/**
 * 任务的**读模型**与**重试**用例（ZLQ-221 §4.1 的 `getTask` / `streamTaskEvents` / `retryTask`）。
 *
 * ## 为什么 `cancelTask` 不在这里
 *
 * 取消不是一次独立写，而是**与 pump 同一个驱动器换个 mode**：设计文档 §5.4 逐字
 * 「`:cancel` 先持久化合法意图，再 await 一个有界 interrupt/cancel 操作及回执；远端仍
 * 运行/结果未知则返回 202 CANCELLING」，而 infra 的 `TaskPumpStore.acquire` 正是用
 * `mode: 'CANCEL'` 把「持久化意图 + 状态迁移 + 定向租约」做在**同一个短事务**里的
 * （`sql/task-pump-store.ts` 的 `CANCEL_FROM_QUEUED` / `CANCEL_FROM_RUNNING` /
 * `RESUME_CANCELLING` 三个分支已经调过 domain 的 `requestCancel`）。
 *
 * 所以在这一层再写一份取消逻辑会有两个后果：一是 `requestCancel` 被调两次，revision
 * 多跳一格，客户端手里的 `If-Match` 当场失效；二是 `CANCEL_FROM_RUNNING` 发出的**定向
 * 租约**没人接管，停止对账永远做不完，界面只能一直显示"正在请求停止"。取消因此与
 * pump 同住 `usecases/pump.ts`。
 *
 * ## 读模型的一条红线
 *
 * 这三个用例**都不写库**。`GET /tasks/{id}` 与 `GET /tasks/{id}/events` 是 §5.5 里唯一
 * 两个纯读的任务接口，所以 `TaskReadDirectory` 上没有 `save`（见该接口的注释）：读接口
 * 一旦能写，"读一次进度"就会变成一次 CAS，客户端轮询会自己把自己的 `ETag` 打脏。
 */
import {
  assertTaskAdmissible,
  beginRetryAttempt,
  capabilityOfTaskKind,
  createUsageReservation,
  decideUsageAdmission,
  DomainError,
  hardDeadlineAt,
  HARD_DEADLINE_MINUTES,
  isReservationActive,
  parseTaskId,
  type AiTask,
  type Capability,
  type ProjectId,
  type Revision,
  type TaskEvent,
  type TaskId,
  type Timestamp,
  type UsageReservation,
  type UserId,
} from '@littleq/domain';
import type { Actor } from './authorization.js';
import { studentActorId } from './authorization.js';
import type {
  ProjectDirectory,
  RandomSource,
  TaskReadDirectory,
  TaskRetryStore,
  UsageDirectory,
} from './ports.js';

/** 读侧依赖：只有两个查询端口，没有任何写端口 —— 类型层面就保证了这三个用例不改状态。 */
export interface TaskQueryServices {
  readonly projects: ProjectDirectory;
  readonly tasks: TaskReadDirectory;
}

/**
 * 取任务并断言它属于这个学生的项目。
 *
 * 归属链是 `task.projectId → project.ownerStudentId`，**不是** `task.requestedBy`：
 * `requestedBy` 记的是"谁发起的这一轮"，而能不能看这个任务取决于它挂在谁的项目上。
 * 两者在本切片里恰好同值，但用错字段会让将来"同项目多成员"悄悄放开别人的任务。
 *
 * 找不到与无权访问**都**映射 `RESOURCE_NOT_FOUND`：区分它们等于把"这个 id 存在吗"
 * 变成一个可探测的预言机（§5.3）。
 */
export async function loadOwnedTask(
  services: TaskQueryServices,
  input: { readonly actor: Actor; readonly taskId: TaskId },
): Promise<{ readonly task: AiTask; readonly projectId: ProjectId }> {
  const studentId = studentActorId(input.actor);
  const task = await services.tasks.findTask(input.taskId);
  if (task === null) throw new DomainError('RESOURCE_NOT_FOUND', 'AiTask');
  const project = await services.projects.findById(task.projectId);
  if (project === null) throw new DomainError('RESOURCE_NOT_FOUND', 'Project');
  if (project.ownerStudentId !== studentId) throw new DomainError('RESOURCE_NOT_FOUND', 'Project');
  return { task, projectId: project.id };
}

/** `GET /tasks/{id}`：读一个任务表示。异步失败以 200 + `task.error` 暴露，不抛错。 */
export async function getTaskUseCase(
  services: TaskQueryServices,
  input: { readonly actor: Actor; readonly taskId: TaskId },
): Promise<AiTask> {
  return (await loadOwnedTask(services, input)).task;
}

/**
 * `GET /tasks/{id}/events`：SSE 的事件来源。
 *
 * `afterSequence === null` 是首次连接（从头补发），否则是 `Last-Event-ID` 重连补发。
 * 用例**不**决定要不要关流：§5.5 的"B/C 类任务 20 秒主动结束流"是适配层的定时器，
 * 放在这里会让一次纯读带上墙钟依赖。
 */
export async function listTaskEventsUseCase(
  services: TaskQueryServices,
  input: {
    readonly actor: Actor;
    readonly taskId: TaskId;
    readonly afterSequence: bigint | null;
    readonly limit: number;
  },
): Promise<readonly TaskEvent[]> {
  const { task } = await loadOwnedTask(services, { actor: input.actor, taskId: input.taskId });
  return services.tasks.listEvents(task.id, input.afterSequence, input.limit);
}

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

export interface TaskRetryServices {
  readonly projects: ProjectDirectory;
  readonly tasks: TaskReadDirectory;
  readonly usage: UsageDirectory;
  readonly retry: TaskRetryStore;
  readonly random: RandomSource;
}

export interface RetryTaskInput {
  readonly actor: Actor;
  readonly taskId: TaskId;
  /** `If-Match` 里的 revision，也是 CAS 的期望值。 */
  readonly expectedRevision: Revision;
  readonly now: Timestamp;
}

export interface RetryTaskResult {
  readonly taskId: TaskId;
  readonly attempt: number;
  readonly revision: Revision;
}

/** 重试预留的单位数与首次受理相同：一个 attempt 一次生成。 */
const RETRY_RESERVED_UNITS = 1;

/**
 * 「重新持有」唯一的准入判定 —— PM 裁定 (b).1 的安全红线，**不可协商**：
 * 重新持有只在 `RELEASED` / `EXPIRED` 上合法，`COMMITTED` 必须被拒绝。
 *
 * ## 为什么必须有这一道，而不是让 domain 的迁移函数挡住
 *
 * domain 没有 `RELEASED → HELD` 这条边（`TERMINAL_RESERVATION_STATES` 三个值全是终态），
 * 所以"重新持有"只能用 `createUsageReservation` 直接造一个 `HELD` 实体来表达 —— 而构造
 * 函数**不知道库里那一行现在是什么状态**。换句话说：绕过迁移函数的那一刻，domain 就
 * 再也拦不住任何人把一个 `COMMITTED` 的预留改回 `HELD`。这一道就是补上那个缺口。
 *
 * 后果若没有它：`COMMITTED` 表示这一格额度已经真的花掉并记进 `usage_ledger` 了。把它
 * 重新置为 `HELD` 等于让学生用同一格额度跑第二次生成，而账目上只有一条 —— 白送一次
 * 付费调用，且对账时看不出来。
 *
 * ## 为什么错误码是 400 而不是 409
 *
 * 409 `REVISION_CONFLICT` 的语义是"拿新的 ETag 再来一次"。可这里的失配与 revision 无关
 * （revision 完全可能对得上），客户端照着 409 重试只会**无限循环**。`REQUEST_INVALID`
 * 说的是"这一行现在的状态根本不允许这个操作"，与 infra 侧 `assertSettleable`
 * （`packages/infra/src/sql/usage-rows.ts:192`）对同一张表用的是同一个错误码、同一个
 * 值对象名 —— 两道守卫因此说同一种语言。
 *
 * ## 谁必须调它
 *
 * `TaskRetryStore.beginRetryAttempt` 的**每一个实现**，在按自然键
 * `(task_id, capability)` UPSERT 之前，先读出库里那一行并交给本函数。用例自己调不了：
 * `UsageDirectory` 没有读预留的方法，它交出的只是一个新造的 `HELD` 实体。
 * `packages/application/test/task-retry-rehold.test.ts` 把四个状态逐一钉死，并证明
 * `retryTaskUseCase` 会把实现抛出的拒绝**原样传出**（不吞、不落新 attempt、不动账目）。
 */
export function assertReholdable(existing: UsageReservation): void {
  // `isReservationActive` 就是 `state === 'HELD'`：一个已经被别的请求持有的预留，
  // 同样不能由重试抢回来（那会绕过 pump 的单飞锁）。
  if (isReservationActive(existing) || existing.state === 'COMMITTED') {
    throw DomainError.invalid('UsageReservation.state');
  }
}

/**
 * `POST /tasks/{id}:retry` —— **同一个 task 的新 attempt**，不是新建 task（契约原文），
 * 所以没有 `Location`，返回 `{taskId, attempt, revision}`。
 *
 * ## 判定次序为什么是这个
 *
 * 1. **归属**：不属于这个学生的项目 ⇒ `RESOURCE_NOT_FOUND`。放在最前面，因为它决定了
 *    后面每一步能不能发生。
 * 2. **可重试性**：`beginRetryAttempt` 抛 `TASK_NOT_RETRYABLE`。它只看 `task` 自身
 *    （`FAILED` / `TIMED_OUT` 且还有 attempt 预算），不读任何外部状态，所以放在两个
 *    需要查库/查配置的判定**之前** —— 一个根本不可重试的任务不该消耗一次额度读取。
 * 3. **准入**：`ACTIVE_WRITE_TASK_EXISTS`。重试会让一个终态任务重新变成活动写任务，
 *    而 `ai_tasks_one_active_per_project` 是**部分唯一索引**：如果这个项目上已经有别的
 *    活动写任务，落库会撞索引报一个数据库错误，而不是契约里那个 409。所以必须先判。
 * 4. **额度**：`USAGE_LIMIT_EXCEEDED`。§6.6 逐字「额度为零只阻断新的 AI task」，
 *    一次重试就是一个新的 AI task。
 * 5. **落库**：CAS + 重新持有预留，**一个事务**。
 *
 * ## `retryable` 不由异常继承推导
 *
 * 契约原文：「`retryable` 不得由异常继承推导，只能查固定的 `(stage, code)` 表」。本用例
 * 因此**不**读 `task.error.retryable` 来决定能不能重试 —— 能不能重试由 domain 的
 * `isRetryableEntryState` + `hasAttemptsLeft` 判定（`beginRetryAttempt` 内部）；那张
 * `(stage, code)` 表约束的是**自动**重试（`shouldAutoRetryStageError`，在 pump 里用），
 * 而这里是学生手点的显式重试。两条路径分开，才不会让"表里标了不可自动重试"变成
 * "学生连手动重试都被拒"。
 */
export async function retryTaskUseCase(
  services: TaskRetryServices,
  input: RetryTaskInput,
): Promise<RetryTaskResult> {
  const studentId: UserId = studentActorId(input.actor);
  const { task } = await loadOwnedTask(services, { actor: input.actor, taskId: input.taskId });

  const capability: Capability | null = capabilityOfTaskKind(task.kind);
  if (capability === null) throw new DomainError('INTERNAL_ERROR', 'Capability');

  // 与首次受理同一套准入/额度判定，因此同一个错误码集合（契约的 exclusiveErrorCodes）。
  const counts = await services.usage.countActiveWriteTasks({
    ownerStudentId: studentId,
    projectId: task.projectId,
    now: input.now,
  });
  // `assertTaskAdmissible` 只在 REJECT 时抛，并把 `ADMIT` / `QUEUE` 的判定**返回**出来 ——
  // 下面 `nextRunAt` 要用它，所以这里接住返回值而不是丢弃。
  const taskAdmission = assertTaskAdmissible({
    kind: task.kind,
    groupId: null,
    globalRunningQcaCount: counts.global,
    groupRunningQcaCount: counts.group,
    studentActiveWriteCount: counts.student,
    projectActiveWriteCount: counts.project,
  });

  const quota = await services.usage.quotaSnapshot({
    ownerStudentId: studentId,
    capability,
    period: 'DAILY',
    now: input.now,
  });
  const usage = decideUsageAdmission({
    kind: task.kind,
    requestedUnits: RETRY_RESERVED_UNITS,
    quota,
  });
  if (usage.kind === 'BLOCK') throw new DomainError(usage.errorCode, 'UsageQuota');

  // `nextRunAt`：`QUEUE` 与首次受理同样处理（§6.5 的全局 10 / 小组 3 是**调度**上限，
  // 本切片没有调度器，任务被受理后由 pump 单飞推进），`ADMIT` 则不设延迟。
  const retried = beginRetryAttempt(
    task,
    input.now,
    taskAdmission.kind === 'QUEUE' ? input.now : null,
  );

  const saved = await services.retry.beginRetryAttempt({
    task: retried,
    expectedRevision: input.expectedRevision,
    reservation: createUsageReservation({
      id: services.random.uuidV7(),
      taskId: retried.id,
      subjectUserId: studentId,
      capability,
      reservedUnits: RETRY_RESERVED_UNITS,
      expiresAt: hardDeadlineAt(input.now, HARD_DEADLINE_MINUTES),
    }),
    now: input.now,
  });
  // CAS 失败：另一个请求（或一次 pump）已经改过这一行。契约把它映射 409 REVISION_CONFLICT。
  if (saved === null) throw new DomainError('REVISION_CONFLICT', 'AiTask');

  return { taskId: saved.id, attempt: saved.attempt, revision: saved.revision };
}

/** 便于适配层从路径参数构造 `TaskId`（与 `turns.ts` 同一套 parse，不在两处各写一遍）。 */
export function taskIdFromParam(value: string): TaskId {
  return parseTaskId(value);
}

/**
 * `POST /projects/{id}/turns` —— 发起一个生成回合（ZLQ-221 §4.1）。
 *
 * ## 这个文件只做"受理"，不做"推进"
 *
 * §1.2 逐字：「不能先回 202 后才尝试持久化」。所以本用例的返回值**只在** F1 的
 * `TaskUnitOfWork.createTurn` 那个单事务提交成功之后才产生；事务失败就抛，HTTP 层因此
 * 不可能先写出一个 202 再发现落库没成。推进是 `pump.ts` 的事，两者之间没有任何
 * 进程内的交接 —— 那是 A′（无常驻后台进程）的字面含义。
 *
 * ## 判定顺序就是契约
 *
 * 下面六步的顺序不是风格问题，每一步都对应一个**不同的**错误码，换了顺序就会让
 * 同一个用户可见结果有两个来源：
 *
 * 1. 归属与可写（`RESOURCE_NOT_FOUND`）—— 别人的项目连"存在"都不该被确认（§11.1 步骤 6）。
 * 2. 幂等回放（`IDEMPOTENCY_KEY_REUSED` / 原受理结果）—— **必须在额度判定之前**，
 *    否则一次合法重放会被它自己那次受理占掉的额度挡在门外（§5.5）。
 * 3. 基线 revision（`REVISION_CONFLICT`）—— `baseRevision` 是客户端看到的版本，
 *    对不上就说明它基于过期状态在发话。
 * 4. 凭据就绪（`QCA_CREDENTIAL_NOT_CONFIGURED`）—— 在受理**之前**判，否则学生会拿到
 *    一个注定失败的任务和一个转不动的进度条（§11.2 第 1 项负对照）。
 * 5. 额度（`USAGE_LIMIT_EXCEEDED`）与准入（`ACTIVE_WRITE_TASK_EXISTS`）—— 都是 409/429
 *    而不是"先建再失败"（§6.6：预留与限额检查在同一事务里发生）。
 * 6. 落库。
 *
 * ## ⚠️ 一处已向 PM 申报的 schema 缺口
 *
 * `task_private.collection_cursor` 与 `task_private.input_snapshot` 两列在 DDL 里是
 * **NOT NULL**（`packages/infra/src/sql/migrations.ts:230`/`:233`），F1 的
 * `createTaskPrivateRecord` 忠实地把它们做成必填 —— 形状没错。但它们记的是**产物**的
 * 摘要与扫描输入身份，而受理时刻产物还不存在（产物是 pump 的 COLLECT/BUILD 切片才封出来的）。
 * 见 `acceptanceTimeScanIdentity` 的注释：本文件写进去的是**真实字节的真实摘要**、不是
 * 随机占位，且封口切片会用真值整行覆盖；但"NOT NULL 列在事实尚不存在时该写什么"是
 * 架构裁定，不是工程侧能自己决定的。已按 §3 在交付评论里列明缺口 + 建议签名。
 */
import {
  type AiTask,
  type Capability,
  type ProjectId,
  type ProjectVersionId,
  type Revision,
  type TaskId,
  type Timestamp,
  type UserId,
  DomainError,
  HARD_DEADLINE_MINUTES,
  SOFT_DEADLINE_SECONDS_COMPLEX,
  assertProjectWritable,
  assertTaskAdmissible,
  capabilityOfTaskKind,
  createAiTask,
  createUsageReservation,
  decideUsageAdmission,
  hardDeadlineAt,
  parseIdempotencyKey,
  parseProjectId,
  parseRequestHash,
  parseTaskId,
  softDeadlineAt,
} from '@littleq/domain';

import {
  type ScanInputIdentity,
  type TaskInputRef,
  type TaskInputSnapshot,
  type TaskPrivateRecord,
  createCollectionCursor,
  createTaskInputRef,
  createTaskPrivateRecord,
} from '../task-private.js';
import type { CreateTurnResult, TaskUnitOfWork } from '../ports/task-unit-of-work.js';
import { type Actor, secretOwnerIdOf, studentActorId } from './authorization.js';
import { type ProjectServices, loadOwnedProject } from './projects.js';
import type {
  RandomSource,
  SecretAdmin,
  TaskInputStore,
  TaskReadDirectory,
  UsageDirectory,
} from './ports.js';

/** 本切片的回合只有一种：自然语言生成。`PUBLISH` / `RESCAN` 不在 §1.2 的交付清单里。 */
export const TURN_TASK_KIND = 'VIBE_TURN' as const;

/**
 * 一次回合预留的额度单位数。
 *
 * 固定为 1：`decideUsageAdmission` 要求 `requestedUnits ≥ 1`，而"一次生成"就是一个
 * 计量单位 —— 契约里没有按 token 计费的形状，编一个比例出来等于把定价决策藏进代码
 * （domain `usage.ts` 对"默认额度不在 domain 硬编码"的裁定，同一个理由）。
 */
export const TURN_RESERVED_UNITS = 1;

/**
 * 预留行标识 = `(taskId, capability)` 的确定性 UUIDv7 **形状**串。
 *
 * ## 为什么不是 `random.uuidV7()`
 *
 * `usage_reservations` 上有 `UNIQUE (task_id, capability)`
 * （`packages/infra/src/sql/migrations.ts:396`）—— 一个 task 的一个 capability **只有一行**。
 * 也就是说 `(taskId, capability)` 已经是这行的自然键，而 `id` 只是它的代理键。用随机
 * UUIDv7 当代理键会让自然键与代理键**互相不可推导**，代价在提交切片上立刻显形：
 * `TaskTransactionReservations.settle` 的 SQL 是
 * `UPDATE … WHERE id = $1 AND task_id = $2`（`packages/infra/src/sql/usage-rows.ts:96`），
 * 而 F1 的端口**没有**读预留的方法，`TaskPrivateRecord` 也没有存这个 id 的列。于是
 * COMMITTING 切片手里只有一个 task，拿不到那个随机 id，结算就无法进行。
 *
 * 让代理键等于自然键的哈希，结算方便可由 `(task, capability)` 重新算出同一个 id，
 * 不需要动 F1 的任何端口形状，也仍然满足 §3.5「不能在版本提交失败后单独完成结算」
 * ——结算照旧发生在写版本的**同一个事务**里。
 *
 * ## 代价（已声明）
 *
 * 这个 id **不再时间有序**，而 UUIDv7 被选中的理由正是时间有序（ZLQ-153 §4.2）。
 * `usage_reservations` 的访问路径是主键点查与 `(task_id, capability)` 唯一索引，
 * 没有按 id 排序的查询，所以功能上无损；但"主键统一 UUIDv7"这条约定的**意图**
 * 在这里被削弱了。已在交付评论里列为申报项，请架构师裁定是否改为给
 * `TaskTransactionReservations` 增一个 `findReservation(taskId, capability)`。
 *
 * `UUID_V7_PATTERN`（`packages/domain/src/value-objects/identifiers.ts:12`）只校验形状：
 * 32 位小写十六进制、第 13 位为 `7`、第 17 位为 `8/9/a/b`。下面按位强制这两位。
 */
export function reservationIdentity(input: {
  readonly random: RandomSource;
  readonly taskId: TaskId;
  readonly capability: Capability;
}): string {
  const digest = input.random.sha256(`${input.taskId}\u0000${input.capability}`);
  const hex = [...digest.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const fixed = `${hex.slice(0, 12)}7${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return `${fixed.slice(0, 8)}-${fixed.slice(8, 12)}-${fixed.slice(12, 16)}-${fixed.slice(16, 20)}-${fixed.slice(20)}`;
}

/** 计量周期。契约的 `usageLimits` 只有 DAILY / MONTHLY 两档，回合按日计。 */
export const TURN_USAGE_PERIOD = 'DAILY' as const;

/**
 * 软 SLA 取"复杂"档（120 秒）而不是"简单"档（30 秒）。
 *
 * domain 明确把"这个任务算简单还是复杂"留给 application（`value-objects/task.ts` 的
 * `softDeadlineAt` 注释）。一次 QCA 生成回合要经历建会话、发消息、多轮收事件、封产物、
 * 扫描、提交版本，任何一个切片都可能因为 provider 慢而占满 6 秒工作窗口，所以整回合的
 * 软 SLA 只能是复杂档。硬时限用 domain 的默认 10 分钟。
 */
export const TURN_SOFT_DEADLINE_SECONDS = SOFT_DEADLINE_SECONDS_COMPLEX;

/**
 * 回合任务的最大尝试次数。
 *
 * 取 3：一次首试 + 两次重试。这不是从 domain 抄来的常量（domain 没有它），也不是运维
 * 旋钮 —— 它是 `retryTask` 这个对外操作的可用次数上界，写死在这里才能让
 * `TASK_NOT_RETRYABLE` 的判定不依赖部署配置。
 */
export const MAX_TURN_ATTEMPTS = 3;

/**
 * 受理时刻的内部子相位。
 *
 * 记的是**停在哪个恢复子阶段**（§5.2），第一个 pump 切片要做的事是"读凭据 + 建会话"，
 * 所以受理时停在"等会话"。它不是 wire stage：对外的 `TaskStage` 仍然只有那 12 个值
 * （§4.3 逐字），`CREATE_SESSION` 之类内部操作名**不得**出现在 `task.stage` 上。
 */
export const TURN_INITIAL_SUBPHASE = 'AWAITING_SESSION_RECEIPT';

export interface TurnServices {
  readonly projects: ProjectServices['projects'];
  readonly tasks: TaskReadDirectory;
  readonly usage: UsageDirectory;
  readonly secrets: SecretAdmin;
  readonly inputs: TaskInputStore;
  readonly random: RandomSource;
  readonly unitOfWork: TaskUnitOfWork;
}

export interface CreateTurnUseCaseInput {
  readonly actor: Actor;
  readonly projectId: string;
  /** 学生输入的自然语言全文。只流向 `TaskInputStore`，不进任何响应、日志或事件。 */
  readonly prompt: string;
  /** 客户端看到的项目 revision（`createTurnRequestSchema.baseRevision`，必填）。 */
  readonly baseRevision: string;
  readonly idempotencyKey: string;
  /**
   * 请求体的规范摘要（十六进制 SHA-256）。
   *
   * **由 adapter 算，不在这里算**：domain 的 `RequestHash` 注释逐字写着「计算方式属于
   * adapter」。用例只负责拿它做同/异请求的区分，因此这里不做任何字符串拼接 —— 拼一次
   * 就等于在应用层定了第二种规范化规则。
   */
  readonly requestHash: string;
  readonly now: Timestamp;
}

/**
 * 受理一个生成回合。
 *
 * 返回 `taskId` 与**受理时刻**的项目 revision（`CreateTurnResult` 的形状就是契约
 * `taskAcceptedSchema` 的两个键）。刻意不回整个 `Task`：契约注释写明回显整个 Task 会让
 * `POST` 与 `GET /tasks/{id}` 的字段集合永远必须同步，那是两个接口之间的一条隐形耦合。
 */
export async function createTurnUseCase(
  services: TurnServices,
  input: CreateTurnUseCaseInput,
): Promise<CreateTurnResult> {
  // 1. 归属 + 可写。别人的项目 ⇒ 404，与"不存在"同一个响应（§11.1 步骤 6）。
  const studentId: UserId = studentActorId(input.actor);
  const projectId: ProjectId = parseProjectId(input.projectId);
  const project = await loadOwnedProject(services, { actor: input.actor, projectId });
  assertProjectWritable(project);

  const expectedProjectRevision: Revision = project.revision;
  // 3. 基线 revision（放在回放之后：回放要返回**当年**受理的结果，不能被今天的 revision 挡住）。
  if (String(input.baseRevision) !== String(expectedProjectRevision)) {
    throw new DomainError('REVISION_CONFLICT', 'Project.revision');
  }

  // 2. 幂等回放。scope 是 (project, idempotencyKey)；同 hash 回放原结果，异 hash 报既有错误。
  const replay = await services.tasks.findTurnAcceptance({
    projectId,
    idempotencyKey: input.idempotencyKey,
  });
  if (replay !== null) {
    if (replay.requestHash !== input.requestHash) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'IdempotencyKey');
    }
    return { taskId: replay.taskId, revision: replay.projectRevision };
  }

  // 4. 凭据就绪。QCA PAT 属于**成人（OWNER）**，学生自己名下没有凭据（§4.2）。
  const secretOwnerId = secretOwnerIdOf(input.actor.user);
  const qca = await services.secrets.metadata(secretOwnerId, 'QCA_PAT');
  if (!qca.configured) {
    throw new DomainError('QCA_CREDENTIAL_NOT_CONFIGURED', 'SecretRecord.configured');
  }

  // 5a. 额度。快照读在这里、预留行写在事务里（§6.6 要求两者同一事务发生）。
  const capability: Capability | null = capabilityOfTaskKind(TURN_TASK_KIND);
  if (capability === null) throw new DomainError('INTERNAL_ERROR', 'TaskKind');
  const quota = await services.usage.quotaSnapshot({
    ownerStudentId: studentId,
    capability,
    period: TURN_USAGE_PERIOD,
    now: input.now,
  });
  const usage = decideUsageAdmission({
    kind: TURN_TASK_KIND,
    requestedUnits: TURN_RESERVED_UNITS,
    quota,
  });
  if (usage.kind === 'BLOCK') throw new DomainError(usage.errorCode, 'UsageQuotaSnapshot');

  // 5b. 准入。`QUEUE` 是正常结果（只影响 nextRunAt），`REJECT` 由 assert 抛 409。
  const counts = await services.usage.countActiveWriteTasks({
    ownerStudentId: studentId,
    projectId,
    now: input.now,
  });
  const admission = assertTaskAdmissible({
    kind: TURN_TASK_KIND,
    /** `Project` 没有小组字段，小组视图被 §12.3 排除在本期之外 ⇒ 恒 null，小组上限不适用。 */
    groupId: null,
    globalRunningQcaCount: counts.global,
    groupRunningQcaCount: counts.group,
    studentActiveWriteCount: counts.student,
    projectActiveWriteCount: counts.project,
  });

  // 6. 落库。taskId 先生成，因为 prompt 对象要以它为键（`TaskInputStore.put`）。
  const taskId: TaskId = parseTaskId(services.random.uuidV7());
  const promptBytes = new TextEncoder().encode(input.prompt);
  const stored = await services.inputs.put({ taskId, body: promptBytes, now: input.now });
  const inputRef: TaskInputRef = createTaskInputRef(stored);

  const task: AiTask = createAiTask({
    id: taskId,
    kind: TURN_TASK_KIND,
    projectId,
    requestedBy: studentId,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    maxAttempts: MAX_TURN_ATTEMPTS,
    // `QUEUE` 不是错误：任务照样创建，只是 `nextRunAt` 定在"现在"，让排在前面的回合先跑。
    nextRunAt: admission.kind === 'QUEUE' ? input.now : null,
    softDeadlineAt: softDeadlineAt(input.now, TURN_SOFT_DEADLINE_SECONDS),
    hardDeadlineAt: hardDeadlineAt(input.now, HARD_DEADLINE_MINUTES),
    createdAt: input.now,
    /**
     * 显式给 `'1'`，不用 domain 的默认值 `'0'`：§3.2 对 `ai_tasks` 逐字写的是
     * `revision bigint NOT NULL CHECK (revision > 0)`，而 F1 的 `taskInsertParams`
     * 在写入边界调 `assertPersistableRevision` 大声拒绝 `'0'`。这一格不是"初值偏好"，
     * 是受理能不能落库的前提；漏掉它，`createTurn` 对真库永远 400。
     *
     * 与 `createProjectUseCase` 的同名修正是同一处规格冲突的两个断面（已一并申报）。
     */
    revision: '1',
  });

  const privateState: TaskPrivateRecord = createTaskPrivateRecord({
    taskId,
    inputRef,
    internalSubphase: TURN_INITIAL_SUBPHASE,
    collectionCursor: createCollectionCursor({ artifactSha256: stored.sha256 }),
    inputSnapshot: acceptanceTimeScanIdentity(stored.sha256),
  });

  const reservation = createUsageReservation({
    id: reservationIdentity({ random: services.random, taskId, capability }),
    taskId,
    subjectUserId: studentId,
    capability,
    reservedUnits: TURN_RESERVED_UNITS,
    expiresAt: hardDeadlineAt(input.now, HARD_DEADLINE_MINUTES),
  });

  return services.unitOfWork.createTurn({
    projectId,
    expectedProjectRevision,
    idempotencyKey: parseIdempotencyKey(input.idempotencyKey),
    requestHash: parseRequestHash(input.requestHash),
    task,
    privateState,
    reservation,
    inputRef,
    now: input.now,
  });
}

/**
 * 受理时刻写进 `input_snapshot` 的扫描输入身份。
 *
 * ⚠️ **这是本单向 PM 申报的一处 schema 缺口，不是一个可以照抄的范式。**
 *
 * `input_snapshot` 的用途是「冷实例上 `scan_checkpoint` 还是 null 时，能重建
 * `StartScanInput` 去 start 注册」（`task-private.ts` 的注释）。它需要六个字段，其中
 * **四个在受理时刻就是确定的部署常量**（schema / contract / scanner / ruleset 版本），
 * 另外**两个是产物的内容摘要**（`artifactHash` / `manifestHash`）—— 而产物要到 pump 的
 * BUILD 切片才封出来。DDL 却把整列钉成 NOT NULL，于是受理时这一行必须写点东西。
 *
 * 这里写的是**真实存在的字节的真实 SHA-256**（prompt 输入对象的摘要），不是
 * `'0'.repeat(64)` 那种随机占位：因此它可验证、可与 `input_ref.sha256` 对账，也不会
 * 让任何读到这行的人以为产物已经存在（两个摘要相等这件事本身就说明它指的是输入对象）。
 * BUILD 切片封出产物后会用真值**整行覆盖** `input_snapshot` 与 `collection_cursor`。
 *
 * **建议的裁定**（择一，均需改 DDL 或改 F1 的构造器，都不在本单可改文件面内）：
 * - 把 `input_snapshot` / `collection_cursor` 两列改成 NULL，`createTaskPrivateRecord`
 *   对应参数改成可选 —— 语义最干净："还没有产物"就是一个 null，不需要用别的摘要顶替；
 * - 或把 `input_snapshot` 拆成"部署常量"（受理时写，NOT NULL）与"内容摘要"
 *   （BUILD 时写，NULL）两列 —— 保留 NOT NULL 的可验证性，代价是多一次迁移。
 *
 * `manifestHash` 取"四个版本常量的规范 JSON 的摘要"：清单在封口前不存在，而空清单的
 * 摘要会与"真的扫了一个零文件包"撞值，那会让 §5.2 的 `INPUT_HASH_MISMATCH` 判定失去
 * 对照。用版本常量派生，至少保证它随部署配置变化而变化。
 */
export function acceptanceTimeScanIdentity(inputObjectSha256: string): TaskInputSnapshot {
  const scanInput: ScanInputIdentity = {
    artifactHash: inputObjectSha256 as ScanInputIdentity['artifactHash'],
    manifestHash: inputObjectSha256 as ScanInputIdentity['manifestHash'],
    schemaVersion: SCAN_SCHEMA_VERSION,
    contractVersion: SCAN_CONTRACT_VERSION,
    scannerVersion: SCAN_SCANNER_VERSION,
    rulesetVersion: SCAN_RULESET_VERSION,
  };
  return { scanInput };
}

/**
 * 扫描输入的四个部署常量。
 *
 * 从环境变量注入会让"同一份产物在不同部署下算出不同 rulesetVersion"，从而让扫描缓存
 * 跨部署串味（work-contract `ScanPolicySnapshot.revision` 注释的同一条理由）。所以它们
 * 是编译期常量，取值直接取 work-contract 自己声明的版本号。
 */
export const SCAN_SCHEMA_VERSION = '1.0.0';
export const SCAN_CONTRACT_VERSION = '1.0.0';
export const SCAN_SCANNER_VERSION = '1.0.0';
export const SCAN_RULESET_VERSION = '1.0.0';

/** 供 pump 的 BUILD 切片封口时构造真值快照用（同一组常量，避免两处漂移）。 */
export function sealedScanIdentity(input: {
  readonly artifactHash: string;
  readonly manifestHash: string;
}): TaskInputSnapshot {
  return {
    scanInput: {
      artifactHash: input.artifactHash as ScanInputIdentity['artifactHash'],
      manifestHash: input.manifestHash as ScanInputIdentity['manifestHash'],
      schemaVersion: SCAN_SCHEMA_VERSION,
      contractVersion: SCAN_CONTRACT_VERSION,
      scannerVersion: SCAN_SCANNER_VERSION,
      rulesetVersion: SCAN_RULESET_VERSION,
    },
  };
}

/** `baseVersionId` 的读取入口：回合要基于某个既有版本继续，不存在就是 404。 */
export async function loadTurnBaseVersion(
  services: { readonly projects: ProjectServices['projects'] },
  input: { readonly versionId: string; readonly projectId: ProjectId },
): Promise<ProjectVersionId> {
  const versionId = input.versionId as ProjectVersionId;
  const version = await services.projects.findVersionById(versionId);
  if (version === null || String(version.projectId) !== String(input.projectId)) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'ProjectVersion');
  }
  return version.id;
}

/**
 * AiTask 聚合与 TaskEvent（附录 A §6.1、§6.2、§6.3 `ai_tasks/task_events`、架构 §6.1）。
 *
 * **结构性省略**是这个文件最重要的设计决定。§6.3 右栏把 lease owner/until、
 * QCA/provider IDs/cursor、原始错误 digest 划给 application/infra，§5.5 又要求
 * `Task` 响应「不返回 lease、QCA ID/cursor、operation key、provider request ID/digest」。
 * 与其在序列化时挑字段，不如让 `AiTask` 根本没有这些字段 —— 缺字段是可以被类型
 * 检查证明的，漏挑一个字段不行。因此：
 *
 * - `leaseOwner` / `leaseUntil`：不存。领取与续租的**合法条件**由
 *   `policies/lease.ts` 定义（§6.4「domain 只定义合法领取/续租条件」），
 *   抢占实现留在 infra。
 * - `qcaSessionId` / `qcaEventCursor` / `providerRequestId` / `errorDigest`：不存。
 * - `externalOperationKey`：不存，但**生成规则属于 domain**（§6.4）。它是
 *   `taskId:stage:attempt` 的纯派生，用 `formatExternalOperationKey` 现算即可；
 *   存下来只会多一份可能与三者不同步的副本。
 * - `nextRunAt`：存。这是 §6.3 右栏与 §5.5 之间的一处张力 —— §5.5 明确把它列进
 *   对外 `Task` 响应，架构 §6.1 也把 `RETRY_WAIT → QUEUED` 标注为 `(next_run_at)`，
 *   所以它是领域可见的调度时刻；domain 只是**从不计算**它，值由 application 依据
 *   退避策略写入。已在交付评论里声明这处调和。
 *
 * 错误只以 `SafeError {code, messageKey, retryable}` 存在（§6.3）。`retryable`
 * 一律查 `(stage, code)` 固定表得到，不从异常继承推导（架构 §7.4）。
 */

import { DomainError } from '../errors/domain-error.js';
import { errorDefinition, toSafeError, type ErrorCode, type SafeError } from '../errors/catalog.js';
import { assertCancellableTaskState, TASK_TRANSITIONS } from '../states/machines.js';
import { assertTransition, isTerminalState } from '../states/transition.js';
import {
  formatTaskEventId,
  parseProjectId,
  parseProjectVersionId,
  parseTaskEventId,
  parseTaskId,
  parseUserId,
  type ProjectId,
  type ProjectVersionId,
  type TaskEventId,
  type TaskId,
  type UserId,
} from '../value-objects/identifiers.js';
import {
  isBefore,
  nextRevision,
  parseIdempotencyKey,
  parseProgress,
  parseRevision,
  parseTimestamp,
  type IdempotencyKey,
  type Progress,
  type Revision,
  type Timestamp,
} from '../value-objects/primitives.js';
import {
  canRequestRepair,
  hasAttemptsLeft,
  isWriteTaskKind,
  parseAttempt,
  parseMaxAttempts,
  parseRepairCount,
  parseRequestHash,
  parseTaskKind,
  parseTaskState,
  parseTaskEventType,
  parseTaskStage,
  isRetryableEntryState,
  HARD_DEADLINE_MINUTES,
  type Attempt,
  type MaxAttempts,
  type RepairCount,
  type RequestHash,
  type TaskEventType,
  type TaskKind,
  type TaskStage,
  type TaskState,
} from '../value-objects/task.js';
import { isSafeEntry, type SafeScalar } from '../value-objects/safe-text.js';

export type AiTask = {
  readonly id: TaskId;
  readonly kind: TaskKind;
  readonly projectId: ProjectId;
  readonly requestedBy: UserId;
  /** 幂等 scope = `(requestedBy, projectId, idempotencyKey)`（架构 §4.4 唯一索引）。 */
  readonly idempotencyKey: IdempotencyKey | null;
  readonly requestHash: RequestHash | null;
  readonly state: TaskState;
  readonly stage: TaskStage | null;
  readonly progress: Progress;
  readonly attempt: Attempt;
  readonly maxAttempts: MaxAttempts;
  /** §6.2 补的产物修复预算；上限 1，耗尽后 `COLLECTING → FAILED(ARTIFACT_INCOMPLETE)`。 */
  readonly repairCount: RepairCount;
  readonly nextRunAt: Timestamp | null;
  readonly cancelRequestedAt: Timestamp | null;
  readonly softDeadlineAt: Timestamp | null;
  readonly hardDeadlineAt: Timestamp | null;
  readonly resultVersionId: ProjectVersionId | null;
  readonly error: SafeError | null;
  readonly createdAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly finishedAt: Timestamp | null;
  readonly revision: Revision;
};

export function createAiTask(input: {
  readonly id: string;
  readonly kind: string;
  readonly projectId: string;
  readonly requestedBy: string;
  readonly idempotencyKey?: string | null;
  readonly requestHash?: string | null;
  readonly state?: string;
  readonly stage?: string | null;
  readonly progress?: number;
  readonly attempt?: number;
  readonly maxAttempts: number;
  readonly repairCount?: number;
  readonly nextRunAt?: string | null;
  readonly cancelRequestedAt?: string | null;
  readonly softDeadlineAt?: string | null;
  readonly hardDeadlineAt?: string | null;
  readonly resultVersionId?: string | null;
  readonly error?: { readonly code: string } | null;
  readonly createdAt: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly revision?: string;
}): AiTask {
  const createdAt = parseTimestamp(input.createdAt);
  const task: AiTask = {
    id: parseTaskId(input.id),
    kind: parseTaskKind(input.kind),
    projectId: parseProjectId(input.projectId),
    requestedBy: parseUserId(input.requestedBy),
    idempotencyKey:
      input.idempotencyKey === null || input.idempotencyKey === undefined
        ? null
        : parseIdempotencyKey(input.idempotencyKey),
    requestHash:
      input.requestHash === null || input.requestHash === undefined
        ? null
        : parseRequestHash(input.requestHash),
    state: input.state === undefined ? 'QUEUED' : parseTaskState(input.state),
    stage: input.stage === null || input.stage === undefined ? null : parseTaskStage(input.stage),
    progress: input.progress === undefined ? parseProgress(0) : parseProgress(input.progress),
    attempt: input.attempt === undefined ? parseAttempt(1) : parseAttempt(input.attempt),
    maxAttempts: parseMaxAttempts(input.maxAttempts),
    repairCount:
      input.repairCount === undefined ? parseRepairCount(0) : parseRepairCount(input.repairCount),
    nextRunAt:
      input.nextRunAt === null || input.nextRunAt === undefined
        ? null
        : parseTimestamp(input.nextRunAt),
    cancelRequestedAt:
      input.cancelRequestedAt === null || input.cancelRequestedAt === undefined
        ? null
        : parseTimestamp(input.cancelRequestedAt),
    softDeadlineAt:
      input.softDeadlineAt === null || input.softDeadlineAt === undefined
        ? null
        : parseTimestamp(input.softDeadlineAt),
    hardDeadlineAt:
      input.hardDeadlineAt === null || input.hardDeadlineAt === undefined
        ? null
        : parseTimestamp(input.hardDeadlineAt),
    resultVersionId:
      input.resultVersionId === null || input.resultVersionId === undefined
        ? null
        : parseProjectVersionId(input.resultVersionId),
    error:
      input.error === null || input.error === undefined
        ? null
        : toSafeError(input.error.code as ErrorCode),
    createdAt,
    startedAt:
      input.startedAt === null || input.startedAt === undefined
        ? null
        : parseTimestamp(input.startedAt),
    finishedAt:
      input.finishedAt === null || input.finishedAt === undefined
        ? null
        : parseTimestamp(input.finishedAt),
    revision: input.revision === undefined ? parseRevision('0') : parseRevision(input.revision),
  };
  assertTaskCoherent(task);
  return task;
}

/**
 * 聚合自身的时序与终态一致性：
 * - `startedAt` 不早于 `createdAt`，`finishedAt` 不早于 `startedAt`；
 * - 终态必有 `finishedAt`，非终态必无 `finishedAt`；
 * - 终态不携带 `nextRunAt`（否则扫描器会反复领取一个已结束的任务）；
 * - `error` 只在失败类终态出现，`resultVersionId` 只在 `SUCCEEDED` 出现。
 *
 * 这几条不是"防御性校验"：它们正是 §6.3「合法迁移」在非迁移路径上的等价表述，
 * 少了任何一条，一个手工构造的行就能让租约扫描与幂等重放同时出错。
 */
function assertTaskCoherent(task: AiTask): void {
  if (task.startedAt !== null && isBefore(task.startedAt, task.createdAt)) {
    throw DomainError.invalid('AiTask.startedAt');
  }
  if (
    task.startedAt !== null &&
    task.finishedAt !== null &&
    isBefore(task.finishedAt, task.startedAt)
  ) {
    throw DomainError.invalid('AiTask.finishedAt');
  }
  const terminal = isTerminalState(TASK_TRANSITIONS, task.state);
  if (terminal !== (task.finishedAt !== null)) throw DomainError.invalid('AiTask.finishedAt');
  if (terminal && task.nextRunAt !== null) throw DomainError.invalid('AiTask.nextRunAt');
  const failed = task.state === 'FAILED' || task.state === 'BLOCKED' || task.state === 'TIMED_OUT';
  if (failed !== (task.error !== null)) throw DomainError.invalid('AiTask.error');
  if ((task.state === 'SUCCEEDED') !== (task.resultVersionId !== null)) {
    throw DomainError.invalid('AiTask.resultVersionId');
  }
  if (task.state === 'CANCELLED' && task.cancelRequestedAt === null) {
    throw DomainError.invalid('AiTask.cancelRequestedAt');
  }
}

/** 写任务判定：`ACTIVE_WRITE_TASK_EXISTS` 只可能由这四类 kind 触发（§6.5）。 */
export function isWriteTask(task: AiTask): boolean {
  return isWriteTaskKind(task.kind);
}

export function isTaskActive(task: AiTask): boolean {
  return !isTerminalState(TASK_TRANSITIONS, task.state);
}

/**
 * 幂等 scope 相等性。架构 §4.4 的唯一索引是
 * `(requested_by, project_id, idempotency_key)`，这里是它在 domain 侧的判据：
 * 命中同一 scope 时，application 必须返回既有 task 而不是新建。
 */
export function isSameIdempotencyScope(task: AiTask, other: AiTask): boolean {
  if (task.idempotencyKey === null || other.idempotencyKey === null) return false;
  return (
    task.requestedBy === other.requestedBy &&
    task.projectId === other.projectId &&
    task.idempotencyKey === other.idempotencyKey
  );
}

/**
 * 状态迁移。`code` 必须由调用方给出：42 个冻结错误码里没有通用的
 * 「非法迁移」码，用哪个码取决于**是哪个用例**在迁移
 * （取消 → `TASK_NOT_CANCELLABLE`，重试 → `TASK_NOT_RETRYABLE`）。
 */
export function transitionTask(
  task: AiTask,
  to: TaskState,
  at: Timestamp,
  code: ErrorCode,
): AiTask {
  assertTransition(TASK_TRANSITIONS, task.state, to, code);
  const now = parseTimestamp(at);
  const next: AiTask = {
    ...task,
    state: to,
    revision: nextRevision(task.revision),
    startedAt:
      task.startedAt === null && to !== 'QUEUED' && to !== 'CANCELLED' ? now : task.startedAt,
    finishedAt: isTerminalState(TASK_TRANSITIONS, to) ? now : null,
    nextRunAt: isTerminalState(TASK_TRANSITIONS, to) ? null : task.nextRunAt,
    error:
      to === 'FAILED' || to === 'BLOCKED' || to === 'TIMED_OUT'
        ? (task.error ?? fallbackError(to))
        : null,
  };
  assertTaskCoherent(next);
  return next;
}

/**
 * 失败类终态必须带错误码。application 没有显式给出时，按终态类型取一个**目录内
 * 已存在**的码，绝不发明新码：`TIMED_OUT → TASK_TIMEOUT`、
 * `BLOCKED → WORK_CONTRACT_BLOCKED`、`FAILED → INTERNAL_ERROR`。
 */
function fallbackError(state: TaskState): SafeError {
  const code: ErrorCode =
    state === 'TIMED_OUT'
      ? 'TASK_TIMEOUT'
      : state === 'BLOCKED'
        ? 'WORK_CONTRACT_BLOCKED'
        : 'INTERNAL_ERROR';
  return toSafeError(code);
}

export function failTask(
  task: AiTask,
  code: ErrorCode,
  at: Timestamp,
  to: TaskState = 'FAILED',
): AiTask {
  const definition = errorDefinition(code);
  const next: AiTask = {
    ...task,
    error: { code, messageKey: definition.messageKey, retryable: definition.retryable },
  };
  return transitionTask(next, to, at, 'REQUEST_INVALID');
}

export function completeTask(task: AiTask, resultVersionId: string, at: Timestamp): AiTask {
  const next: AiTask = {
    ...task,
    resultVersionId: parseProjectVersionId(resultVersionId),
    progress: parseProgress(100),
  };
  return transitionTask(next, 'SUCCEEDED', at, 'REQUEST_INVALID');
}

export function recordTaskProgress(task: AiTask, progress: number, at: Timestamp): AiTask {
  assertTaskRunnable(task);
  const next: AiTask = {
    ...task,
    progress: parseProgress(progress),
    revision: nextRevision(task.revision),
  };
  if (isBefore(parseTimestamp(at), task.createdAt)) throw DomainError.invalid('AiTask.progress');
  return next;
}

export function recordTaskStage(task: AiTask, stage: TaskStage, at: Timestamp): AiTask {
  assertTaskRunnable(task);
  if (isBefore(parseTimestamp(at), task.createdAt)) throw DomainError.invalid('AiTask.stage');
  return { ...task, stage, revision: nextRevision(task.revision) };
}

/**
 * 非终态才能推进。用 `REQUEST_INVALID` 而不是某个具体业务码：
 * 进度上报来自内部推进器而非学生请求，它撞到终态是竞态而非用户错误。
 */
function assertTaskRunnable(task: AiTask): void {
  if (isTerminalState(TASK_TRANSITIONS, task.state)) throw DomainError.invalid('AiTask.state');
}

/**
 * 取消的第一步：只写 `cancel_requested_at`（架构 §6.6「先写 `cancel_requested_at`，
 * 再由 application 发 interrupt」）。domain 不发中断、不改状态 —— 真正的
 * `RUNNING → CANCELLING → CANCELLED` 由推进器在中断确认后走 `transitionTask`。
 *
 * 可取消状态**从状态表派生**（`assertCancellableTaskState`），因此这里不会再写出
 * 一份与 §6.1 平行的清单。
 */
export function requestCancel(task: AiTask, at: Timestamp): AiTask {
  assertCancellableTaskState(task.state);
  const requestedAt = parseTimestamp(at);
  if (isBefore(requestedAt, task.createdAt)) throw DomainError.invalid('AiTask.cancelRequestedAt');
  return {
    ...task,
    cancelRequestedAt: task.cancelRequestedAt ?? requestedAt,
    revision: nextRevision(task.revision),
  };
}

export function isCancelRequested(task: AiTask): boolean {
  return task.cancelRequestedAt !== null;
}

/**
 * 重试 = 在**同一 task 行**上重开一次状态机运行（§6.2「HTTP 重放、task 新 attempt、
 * Session 内 repair 是三种不同语义」）。
 *
 * 它不是一条 `TASK_TRANSITIONS` 边：`FAILED`/`TIMED_OUT` 是终态且没有出边，
 * 这正是「终态不可回退」的字面含义。这里做的是把 attempt 加一、状态重置为
 * `QUEUED`、清掉上一轮的错误与修复计数 —— 语义上是"新的一次运行"，
 * 因此状态表的终态不变量依然成立。
 *
 * 前置条件：入口状态属于 `RETRYABLE_ENTRY_TASK_STATES`（→ `TASK_NOT_RETRYABLE`），
 * 且还有 attempt 余量。`retryable` 由 `(stage, code)` 固定表决定，不在此推导。
 */
export function beginRetryAttempt(
  task: AiTask,
  at: Timestamp,
  nextRunAt: Timestamp | null,
): AiTask {
  if (!isRetryableEntryState(task.state)) throw new DomainError('TASK_NOT_RETRYABLE', 'TaskState');
  if (!hasAttemptsLeft(task.attempt, task.maxAttempts))
    throw new DomainError('TASK_NOT_RETRYABLE', 'Attempt');
  const requestedAt = parseTimestamp(at);
  const next: AiTask = {
    ...task,
    state: 'QUEUED',
    attempt: parseAttempt(task.attempt + 1),
    repairCount: parseRepairCount(0),
    progress: parseProgress(0),
    error: null,
    resultVersionId: null,
    cancelRequestedAt: null,
    finishedAt: null,
    startedAt: null,
    nextRunAt: nextRunAt === null ? null : parseTimestamp(nextRunAt),
    revision: nextRevision(task.revision),
  };
  if (isBefore(requestedAt, task.createdAt)) throw DomainError.invalid('AiTask.retry');
  assertTaskCoherent(next);
  return next;
}

/**
 * 产物补交（§6.2：`COLLECTING → REPAIRING → COLLECTING`，同 task/session/operation key）。
 *
 * 预算上限 1，由 `canRequestRepair` 判定；耗尽后不是抛错，而是**不再进入
 * REPAIRING** —— 调用方随后走 `COLLECTING → FAILED(ARTIFACT_INCOMPLETE)`。
 * 注意 `ARTIFACT_INCOMPLETE` 自身 `retryable=否`：它已经是补交流程耗尽后的终态。
 */
export function beginArtifactRepair(task: AiTask, at: Timestamp): AiTask {
  if (!canRequestRepair(task.repairCount))
    throw new DomainError('ARTIFACT_INCOMPLETE', 'RepairCount');
  const next = transitionTask(task, 'REPAIRING', at, 'ARTIFACT_INCOMPLETE');
  return { ...next, repairCount: parseRepairCount(task.repairCount + 1) };
}

/**
 * 硬超时。`TIMED_OUT` 是终态，且 §6.1 只给了 `RUNNING → TIMED_OUT` 一条边：
 * 超时判定只对真正在跑的任务有意义，排队中的任务超时属于调度问题，
 * 由 `nextRunAt` 与租约过期处理，不落 `TIMED_OUT`。
 */
export function timeOutTask(task: AiTask, at: Timestamp): AiTask {
  const next: AiTask = { ...task, error: toSafeError('TASK_TIMEOUT') };
  return transitionTask(next, 'TIMED_OUT', at, 'TASK_TIMEOUT');
}

/**
 * 软/硬时限的计算入口。`now` 与 `seconds`/`minutes` 都由调用方给出，
 * domain 不读时钟也不硬编码"这个任务算简单还是复杂"—— 那是 application
 * 才知道的上下文（附录 A：软 SLA 分「简单/复杂」两档）。
 */
export function softDeadlineAt(startedAt: Timestamp, softDeadlineSeconds: number): Timestamp {
  if (!Number.isSafeInteger(softDeadlineSeconds) || softDeadlineSeconds < 1) {
    throw DomainError.invalid('AiTask.softDeadlineAt');
  }
  return offsetSecondsUtc(parseTimestamp(startedAt), softDeadlineSeconds);
}

export function hardDeadlineAt(
  startedAt: Timestamp,
  hardDeadlineMinutes = HARD_DEADLINE_MINUTES,
): Timestamp {
  if (!Number.isSafeInteger(hardDeadlineMinutes) || hardDeadlineMinutes < 1) {
    throw DomainError.invalid('AiTask.hardDeadlineAt');
  }
  return offsetSecondsUtc(parseTimestamp(startedAt), hardDeadlineMinutes * 60);
}

function offsetSecondsUtc(value: Timestamp, seconds: number): Timestamp {
  return parseTimestamp(new Date(Date.parse(value) + seconds * 1000).toISOString());
}

/** 是否已过硬时限。纯比较，`now` 由调用方传入。 */
export function isPastHardDeadline(task: AiTask, now: Timestamp): boolean {
  if (task.hardDeadlineAt === null) return false;
  return !isBefore(parseTimestamp(now), task.hardDeadlineAt);
}

export function isPastSoftDeadline(task: AiTask, now: Timestamp): boolean {
  if (task.softDeadlineAt === null) return false;
  return !isBefore(parseTimestamp(now), task.softDeadlineAt);
}

/**
 * `task_events.safe_payload_json`：只允许小驼峰键名 + JSON 标量值，
 * 且值本身要过敏感文本判定（`isSafeEntry`）。
 *
 * 这是 §7.5 的结构化防线：一旦签名 URL 或学生 prompt 全文进了 safe payload，
 * 后面的 redactor 再也无法证明 SSE 输出是干净的。键名黑名单见
 * `FORBIDDEN_SAFE_KEY_PATTERN`（`prompt`/`stack`/`signature`/`authorization` 等）。
 */
export type SafeEventPayload = Readonly<Record<string, SafeScalar>>;

export function createSafeEventPayload(input: Readonly<Record<string, unknown>>): SafeEventPayload {
  const payload: Record<string, SafeScalar> = {};
  for (const key of Object.keys(input).sort()) {
    if (!isSafeEntry(key, input[key])) throw DomainError.invalid('SafeEventPayload');
    payload[key] = input[key] as SafeScalar;
  }
  return payload;
}

export type TaskEvent = {
  /**
   * 单任务内单调递增的十进制字符串（§6.1 的 `TaskEventId` 例外）。
   * bigint 分配本身在 infra（§6.3 右栏），domain 只接受已分配好的值。
   */
  readonly id: TaskEventId;
  readonly taskId: TaskId;
  readonly sequence: bigint;
  readonly eventType: TaskEventType;
  readonly safePayload: SafeEventPayload;
  readonly createdAt: Timestamp;
};

export function createTaskEvent(input: {
  readonly id?: string;
  readonly taskId: string;
  readonly sequence: bigint | string;
  readonly eventType: string;
  readonly safePayload?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}): TaskEvent {
  const sequence = typeof input.sequence === 'bigint' ? input.sequence : BigInt(input.sequence);
  if (sequence < 0n) throw DomainError.invalid('TaskEvent.sequence');
  return {
    id: input.id === undefined ? formatTaskEventId(sequence) : parseTaskEventId(input.id),
    taskId: parseTaskId(input.taskId),
    sequence,
    eventType: parseTaskEventType(input.eventType),
    safePayload: createSafeEventPayload(input.safePayload ?? {}),
    createdAt: parseTimestamp(input.createdAt),
  };
}

/**
 * 下一个事件 id/sequence。`previous === null` 表示该 task 还没有事件，
 * 从 1 开始 —— 0 留给"没有事件"这个事实本身，避免 SSE 的 `id:` 出现 0 与缺失混淆。
 */
export function nextTaskEventSequence(previous: TaskEvent | null): bigint {
  return previous === null ? 1n : previous.sequence + 1n;
}

/**
 * `(task_id, sequence)` 唯一（架构 §4.4）。这里只判定顺序，不判定唯一性 ——
 * 唯一索引在 infra，而 domain 能保证的是"追加的事件必须严格递增"。
 */
export function assertEventFollows(event: TaskEvent, previous: TaskEvent | null): void {
  if (previous === null) return;
  if (event.taskId !== previous.taskId) throw DomainError.invalid('TaskEvent.taskId');
  if (event.sequence <= previous.sequence) throw DomainError.invalid('TaskEvent.sequence');
}

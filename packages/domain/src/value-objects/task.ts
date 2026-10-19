import { integerValueObject, SHA256_PATTERN, textValueObject } from './primitives.js';
import { stringEnum } from './enum.js';
import { DomainError } from '../errors/domain-error.js';
import { brand, type Branded } from './brand.js';

/**
 * Task 聚合的值对象（ZLQ-153 §4.5、§6.1、§6.6、§7.4 / 附录 A §6.1–§6.5）。
 *
 * `lease_owner/lease_until/next_run_at` 的**持久化与抢占实现**、QCA 的
 * `agentId/environmentId/sessionId/eventCursor/providerRequestId` 与原始错误
 * digest 都不属于 domain（附录 A §6.3、§6.4）。domain 只定义状态、阶段、
 * 幂等范围、截止时间的语义，以及「什么条件下可以领取/续租/取消/重试」。
 */

export const TASK_KINDS = [
  'VIBE_TURN',
  'BAILIAN_IMAGE',
  'TTS',
  'STT',
  'PUBLISH',
  'RESCAN',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
const taskKindEnum = stringEnum<TaskKind>('TaskKind', TASK_KINDS);
export const isTaskKind = taskKindEnum.is;
export const parseTaskKind = taskKindEnum.parse;

/**
 * 主状态机（架构 §6.1）+ 附录 A §6.2 补齐的 `REPAIRING`。
 *
 * 顺序即 OpenAPI enum 顺序：先按主流程排，再排等待与取消，最后排五个终态。
 */
export const TASK_STATES = [
  'QUEUED',
  'CLAIMED',
  'SESSION_CREATING',
  'RUNNING',
  'COLLECTING',
  'REPAIRING',
  'VALIDATING',
  'COMMITTING',
  'RETRY_WAIT',
  'CANCELLING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export type TaskState = (typeof TASK_STATES)[number];
const taskStateEnum = stringEnum<TaskState>('TaskState', TASK_STATES);
export const isTaskState = taskStateEnum.is;
export const parseTaskState = taskStateEnum.parse;

/** 终态不可回退（架构 §6.1 / 附录 A §6.2）。 */
export const TERMINAL_TASK_STATES = [
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];

export function isTerminalTaskState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/**
 * 阶段分类（架构 §7.4）。
 *
 * 前 10 个逐字来自 §7.4 的 `(stage, code)` 失败分类表；`DEPENDENCY` 与
 * `INTERNAL` 是附录 A §5.4「每个 TaskKind 的错误码集合必须含 dependency/internal
 * 码」要求的落点 —— 该表按 stage 索引，没有这两个 stage 就无处登记
 * `DEPENDENCY_UNAVAILABLE` / `INTERNAL_ERROR`。
 */
export const TASK_STAGES = [
  'AUTH',
  'QUOTA',
  'TRANSPORT',
  'AGENT_RUN',
  'COLLECT',
  'BUILD',
  'CONTRACT',
  'CONTENT',
  'TIMEOUT',
  'CANCEL',
  'DEPENDENCY',
  'INTERNAL',
] as const;
export type TaskStage = (typeof TASK_STAGES)[number];
const taskStageEnum = stringEnum<TaskStage>('TaskStage', TASK_STAGES);
export const isTaskStage = taskStageEnum.is;
export const parseTaskStage = taskStageEnum.parse;

/** `task_events.event_type`（附录 A §5.5 的 SSE 事件名就是它的小写形式）。 */
export const TASK_EVENT_TYPES = ['STATE_CHANGED', 'PROGRESS', 'SAFE_MESSAGE', 'COMPLETED'] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];
const taskEventTypeEnum = stringEnum<TaskEventType>('TaskEventType', TASK_EVENT_TYPES);
export const isTaskEventType = taskEventTypeEnum.is;
export const parseTaskEventType = taskEventTypeEnum.parse;

/**
 * `POST /tasks/{id}:pump` 的结果分类（附录 §3.2 步骤 5 的单飞推进 + §12.2 的
 * 「不存在等待完整 QCA 的 HTTP 请求」）。
 *
 * 顺序即 OpenAPI `enum` 顺序：从「真的推进了」到「再也不会推进了」，客户端据此决定
 * 下一步动作 —— 前两个继续轮询，`NO_OP_WAITING` 稍后再试，后两个停。
 *
 * - `ADVANCED`：本次 pump 拿到了推进权，完成了一个**有界切片**并提交了新的 revision。
 * - `COALESCED_IN_FLIGHT`：同一 revision 上已有一次 pump 正在推进。单飞合并：不重复
 *   推进、不报错、不改 revision。这是「单飞」在 HTTP 层的可见结果 —— 前端轮询与
 *   多标签页同时轮询都落在这一支。
 * - `NO_OP_WAITING`：`RETRY_WAIT` 且 `now < nextRunAt`。pump **不得**抹掉退避，
 *   否则客户端就能用它把 provider 打成筛子。
 * - `NO_OP_CANCELLING`：任务正在取消，推进与已记录的取消请求直接矛盾。
 * - `NO_OP_TERMINAL`：终态。无副作用、不复活状态机、不改 revision；要重来请用
 *   `retryTask`（它有自己的 `TASK_NOT_RETRYABLE` 与 attempt 预算）。
 *
 * 三个 `NO_OP_*` 一律是 **200**，不是 409：pump 是幂等的机械推进，「没什么可做的」
 * 是一次成功的回答，不是冲突。409 只留给 `REVISION_CONFLICT`（客户端拿着旧 revision
 * 来 pump，而任务已经被别人推进过），因为那种情况下客户端**必须**重新 GET 才能继续，
 * 用 200 会把这个义务藏起来。
 */
export const TASK_PUMP_OUTCOMES = [
  'ADVANCED',
  'COALESCED_IN_FLIGHT',
  'NO_OP_WAITING',
  'NO_OP_CANCELLING',
  'NO_OP_TERMINAL',
] as const;
export type TaskPumpOutcome = (typeof TASK_PUMP_OUTCOMES)[number];
const taskPumpOutcomeEnum = stringEnum<TaskPumpOutcome>('TaskPumpOutcome', TASK_PUMP_OUTCOMES);
export const isTaskPumpOutcome = taskPumpOutcomeEnum.is;
export const parseTaskPumpOutcome = taskPumpOutcomeEnum.parse;

/**
 * 「写项目任务」= 会产生或修改项目产物内容的任务。
 *
 * `PUBLISH` 与 `RESCAN` 只作用于**已提交的不可变版本**（架构 §6.6：额度为零时
 * 「发布已有版本…不受影响」），因此不计入 §6.5(3) 的活跃写任务不变量。
 * 这条划分是本次实现对该不变量的解释，交付评论里已声明。
 */
export const WRITE_TASK_KINDS = ['VIBE_TURN', 'BAILIAN_IMAGE', 'TTS', 'STT'] as const;
export type WriteTaskKind = (typeof WRITE_TASK_KINDS)[number];

export function isWriteTaskKind(kind: TaskKind): kind is WriteTaskKind {
  return (WRITE_TASK_KINDS as readonly string[]).includes(kind);
}

export type Attempt = Branded<number, 'Attempt'>;
export type MaxAttempts = Branded<number, 'MaxAttempts'>;
export type RepairCount = Branded<number, 'RepairCount'>;

const attemptValue = integerValueObject('Attempt', 1, 1000);
const maxAttemptsValue = integerValueObject('MaxAttempts', 1, 1000);
const repairCountValue = integerValueObject('RepairCount', 0, 1000);

export function parseAttempt(value: number): Attempt {
  return attemptValue.parse(value);
}

export function parseMaxAttempts(value: number): MaxAttempts {
  return maxAttemptsValue.parse(value);
}

export function parseRepairCount(value: number): RepairCount {
  return repairCountValue.parse(value);
}

/**
 * 同 Session 内的产物补交预算（附录 A §6.2）。
 *
 * `REPAIRING` 不新增 Session、不增加 task attempt、不复活终态；预算耗尽后才落
 * `FAILED(ARTIFACT_INCOMPLETE)`。HTTP 重放、task 新 attempt、Session 内 repair
 * 是三种互不折算的语义。
 */
export const TASK_REPAIR_BUDGET = 1;

export function canRequestRepair(repairCount: RepairCount): boolean {
  return repairCount < TASK_REPAIR_BUDGET;
}

export function hasAttemptsLeft(attempt: Attempt, maxAttempts: MaxAttempts): boolean {
  return attempt < maxAttempts;
}

/**
 * 请求体哈希：`(actor, project, idempotencyKey)` 命中已有任务时，用它区分
 * 「同一请求重放」与「同 key 不同请求」（架构 §3.3 → `IDEMPOTENCY_KEY_REUSED`）。
 * 计算方式属于 adapter，domain 只要求它是一个 SHA-256 十六进制串。
 */
export type RequestHash = Branded<string, 'RequestHash'>;

export function isRequestHash(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function parseRequestHash(value: string): RequestHash {
  if (!isRequestHash(value)) throw DomainError.invalid('RequestHash');
  return brand<string, 'RequestHash'>(value);
}

/**
 * 学生 prompt 的长度边界（1..8000）。
 *
 * 故意**不**建模成持有文本的值对象：prompt 全文是 §5 明令禁止进入 domain、
 * 快照、日志与 fixture 的内容之一。领域层只需要边界，持有它只会增加泄漏面。
 */
export const PROMPT_MIN_LENGTH = 1;
export const PROMPT_MAX_LENGTH = 8000;

export function isAcceptablePromptLength(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= PROMPT_MIN_LENGTH &&
    value.length <= PROMPT_MAX_LENGTH
  );
}

/** `retryTask.reason` / `restoreProjectVersion.reason`：运维备注，1..200。 */
export const OPERATOR_NOTE_MAX_LENGTH = 200;
const operatorNoteText = textValueObject('OperatorNote', 1, OPERATOR_NOTE_MAX_LENGTH);
export type OperatorNote = ReturnType<typeof operatorNoteText.parse>;
export const isOperatorNote = operatorNoteText.is;
export const parseOperatorNote = operatorNoteText.parse;

/**
 * 生命周期时限（架构 §6.6）。软 SLA 分「简单/复杂」两档，硬超时默认 10 分钟；
 * 「简单/复杂」的判定属于 application（它才知道任务上下文），domain 只提供数值。
 */
export const SOFT_DEADLINE_SECONDS_SIMPLE = 30;
export const SOFT_DEADLINE_SECONDS_COMPLEX = 120;
export const HARD_DEADLINE_MINUTES = 10;
/** 租约过期扫描周期（架构 §6.6）。 */
export const LEASE_SCAN_INTERVAL_MINUTES = 5;

/**
 * 可重试的入口状态。
 *
 * 这里只回答「状态机是否允许发起一次新 attempt」；**是否真的可重试由
 * `(stage, code)` 固定表决定**（架构 §7.4、附录 A §6.6），两者是 AND 关系：
 * `TASK_NOT_RETRYABLE` 由状态判定给出，`error.retryable` 由错误码表给出。
 *
 * `FAILED` / `TIMED_OUT` 都是终态，而终态在迁移表里**没有出边**。新 attempt 不是
 * 一条状态迁移，而是「同一个 task 行上重开一次状态机运行」—— 附录 A §6.2 把
 * HTTP 重放、task 新 attempt、Session 内 repair 明确区分为三种语义，所以它不进
 * `TASK_TRANSITIONS`，由实体侧的 `beginRetryAttempt` 表达。
 *
 * 「可取消的状态」不在此处硬列：它从迁移表派生（`states/machines.ts` 的
 * `cancellableTaskStates`），避免同一事实写两遍后各自漂移。
 */
export const RETRYABLE_ENTRY_TASK_STATES = ['FAILED', 'TIMED_OUT'] as const;

export function isRetryableEntryState(state: TaskState): boolean {
  return (RETRYABLE_ENTRY_TASK_STATES as readonly string[]).includes(state);
}

export function assertRetryableEntryState(state: TaskState): void {
  if (!isRetryableEntryState(state)) throw new DomainError('TASK_NOT_RETRYABLE');
}

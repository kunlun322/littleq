import { DomainError } from '../errors/domain-error.js';
import { ACCOUNT_STATUSES, type AccountStatus } from '../value-objects/account.js';
import { ACCOUNT_SESSION_STATUSES, type AccountSessionStatus } from '../value-objects/session.js';
import { GROUP_STATUSES, type GroupStatus } from '../value-objects/group.js';
import { PROJECT_STATUSES, type ProjectStatus } from '../value-objects/project.js';
import {
  PUBLICATION_STATUSES,
  WORK_STATUSES,
  type PublicationStatus,
  type WorkStatus,
} from '../value-objects/work.js';
import { TASK_STATES, type TaskState } from '../value-objects/task.js';
import { RESERVATION_STATES, type ReservationState } from '../value-objects/usage.js';
import {
  ASSIGNMENT_STATUSES,
  COURSE_STATUSES,
  LEARNING_PROGRESS_STATES,
  SUBMISSION_STATUSES,
  type AssignmentStatus,
  type CourseStatus,
  type LearningProgressState,
  type SubmissionStatus,
} from '../value-objects/teaching.js';
import {
  canTransition,
  isTerminalState,
  transitionTable,
  type TransitionTable,
} from './transition.js';

/**
 * 十二张状态迁移表 —— 附录 A §6.2「补齐未定义状态」的机器可读形态。
 *
 * 每张表的 `states` 直接复用值对象层的枚举常量，因此「枚举有哪些成员」只有一个
 * 事实源；OpenAPI 的 `enum` 也从同一处派生，顺序一致（附录 A §4.1 要求 enum 的
 * 语义顺序不被归一化重排）。
 *
 * 两张「可恢复」的表（Project、Work）把恢复目标的**并集**画进边里，具体恢复到哪个
 * 状态由实体侧的 `deletedFromStatus` 决定 —— 迁移表回答「形状上允许吗」，实体回答
 * 「这一条记录允许回到哪里」。把两者混在一张表里就需要给边加条件谓词，那会让表
 * 不再是纯数据，也就没法直接生成快照。
 */

/** User：`ACTIVE ↔ LOCKED`；两者都可 `→ DELETED`，DELETED 不可逆。 */
export const USER_TRANSITIONS: TransitionTable<AccountStatus> = transitionTable<AccountStatus>({
  name: 'AccountStatus',
  states: ACCOUNT_STATUSES,
  terminal: ['DELETED'],
  edges: [
    { from: 'ACTIVE', to: 'LOCKED' },
    { from: 'LOCKED', to: 'ACTIVE' },
    { from: 'ACTIVE', to: 'DELETED' },
    { from: 'LOCKED', to: 'DELETED' },
  ],
});

export const USER_INITIAL_STATUS: AccountStatus = 'ACTIVE';

/**
 * AccountSession：`ACTIVE → EXPIRED | REVOKED`，两个都是终态。
 *
 * 分成两个终态而不是一个 `INACTIVE`，是因为它们的**证据不同**：`EXPIRED` 由时间推导
 * （`now >= min(空闲, 绝对)`，扫描任务把推导结果落库），`revokedAt` 保持 `null`；
 * `REVOKED` 由一次决定产生（注销 / 改密 / 管理员强制 / 账号锁定 / 账号删除），
 * `revokedAt` 与 `revocationReason` 必须同时非空。合并成一个状态就把「谁结束的这条
 * 会话」这个审计事实丢掉了，而 §5 恰恰要求可追溯。
 *
 * 没有回到 `ACTIVE` 的边：一条会话结束后不能复活，用户再登录是**签发一条新会话**。
 * 这与 `Submission` 的「重交创建新的 Submission，不覆盖历史」是同一条设计取向 ——
 * 身份凭据尤其不该有可复活的历史行，否则「旧 cookie 又能用了」这类问题无从排查。
 *
 * `ACTIVE → EXPIRED` 与 `ACTIVE → REVOKED` 之间也没有边：超时之后再撤销是同一条会话
 * 上的第二次结束，没有意义。
 */
export const ACCOUNT_SESSION_TRANSITIONS: TransitionTable<AccountSessionStatus> =
  transitionTable<AccountSessionStatus>({
    name: 'AccountSessionStatus',
    states: ACCOUNT_SESSION_STATUSES,
    terminal: ['EXPIRED', 'REVOKED'],
    edges: [
      { from: 'ACTIVE', to: 'EXPIRED' },
      { from: 'ACTIVE', to: 'REVOKED' },
    ],
  });

export const ACCOUNT_SESSION_INITIAL_STATUS: AccountSessionStatus = 'ACTIVE';

/**
 * Group：`ACTIVE ↔ ARCHIVED`。归档后只读、作品保留，Owner 可以解档，所以 ARCHIVED
 * **不是**终态 —— 这张表没有终态。
 */
export const GROUP_TRANSITIONS: TransitionTable<GroupStatus> = transitionTable<GroupStatus>({
  name: 'GroupStatus',
  states: GROUP_STATUSES,
  terminal: [],
  edges: [
    { from: 'ACTIVE', to: 'ARCHIVED' },
    { from: 'ARCHIVED', to: 'ACTIVE' },
  ],
});

export const GROUP_INITIAL_STATUS: GroupStatus = 'ACTIVE';

/**
 * Project：`ACTIVE ↔ ARCHIVED`；两者都可 `→ DELETED`；30 天内 `DELETED →
 * deletedFromStatus`。删除与恢复都可逆，因此这张表也没有终态。
 */
export const PROJECT_TRANSITIONS: TransitionTable<ProjectStatus> = transitionTable<ProjectStatus>({
  name: 'ProjectStatus',
  states: PROJECT_STATUSES,
  terminal: [],
  edges: [
    { from: 'ACTIVE', to: 'ARCHIVED' },
    { from: 'ARCHIVED', to: 'ACTIVE' },
    { from: 'ACTIVE', to: 'DELETED' },
    { from: 'ARCHIVED', to: 'DELETED' },
    { from: 'DELETED', to: 'ACTIVE' },
    { from: 'DELETED', to: 'ARCHIVED' },
  ],
});

export const PROJECT_INITIAL_STATUS: ProjectStatus = 'ACTIVE';

/** Work：`ACTIVE → DELETED`，30 天内可回到 `ACTIVE`。可见性与删除状态相互独立。 */
export const WORK_TRANSITIONS: TransitionTable<WorkStatus> = transitionTable<WorkStatus>({
  name: 'WorkStatus',
  states: WORK_STATUSES,
  terminal: [],
  edges: [
    { from: 'ACTIVE', to: 'DELETED' },
    { from: 'DELETED', to: 'ACTIVE' },
  ],
});

export const WORK_INITIAL_STATUS: WorkStatus = 'ACTIVE';

/**
 * Publication：`PREPARING → LIVE/BLOCKED`；`LIVE → REVOKED`。
 *
 * BLOCKED 与 REVOKED 都是终态：发布记录**不可覆盖**，重新发布产生一条新的
 * publication，下架靠状态与 Runtime deny-list 立即生效（架构 §4.4）。
 */
export const PUBLICATION_TRANSITIONS: TransitionTable<PublicationStatus> =
  transitionTable<PublicationStatus>({
    name: 'PublicationStatus',
    states: PUBLICATION_STATUSES,
    terminal: ['BLOCKED', 'REVOKED'],
    edges: [
      { from: 'PREPARING', to: 'LIVE' },
      { from: 'PREPARING', to: 'BLOCKED' },
      { from: 'LIVE', to: 'REVOKED' },
    ],
  });

export const PUBLICATION_INITIAL_STATUS: PublicationStatus = 'PREPARING';

/**
 * AiTask：架构 §6.1 的主状态机，加上附录 A §6.2 补齐的一次产物修复。
 *
 * 相对架构原图的三处差异，逐条说明：
 *
 * 1. **新增** `COLLECTING → REPAIRING → COLLECTING`（§6.2 明写的勘误）。保持同
 *    task / 同 session / 同 operation key，修复次数上限 1，不新增 Session、不增加
 *    attempt、不复活终态。
 * 2. **保留** `COLLECTING → FAILED`。§6.2 说「耗尽后才 `→ FAILED(ARTIFACT_INCOMPLETE)`」，
 *    而「耗尽」意味着第二次 collect 仍然不完整时，任务已经回不到 REPAIRING（预算
 *    为 0），此时必须有一条从 COLLECTING 直达 FAILED 的边，否则任务卡死在非终态。
 *    预算判定在实体侧（`canRequestRepair`），迁移表只给出形状。
 * 3. **新增** `RETRY_WAIT → FAILED`。架构 §7.4 给自动重试设了上界（`QCA_UNREACHABLE`
 *    最多 2 次、`AGENT_FAILED` 1 次），但 §6.1 的 `RETRY_WAIT` 只有 `→ QUEUED` 一条
 *    出边：预算耗尽后没有任何合法终态可去，机器会停在非终态上。这条边与 §6.2 补
 *    `REPAIRING` 属于同一类「原图缺边」的显式补齐，同样不扩大重试预算。
 *
 * `COMMITTING` 没有失败边是**有意保留架构原样**：架构 §6.1 声明每一步都可重入
 * （先读持久状态、带 operation key 调外部 API、再以 revision CAS 保存），崩溃后租约
 * 过期由其它实例继续，因此 COMMITTING 只会重试而不会失败。硬超时能否从 COMMITTING
 * 触发属于设计缺口，已在交付评论中声明待裁定，这里不擅自加边。
 */
export const TASK_TRANSITIONS: TransitionTable<TaskState> = transitionTable<TaskState>({
  name: 'TaskState',
  states: TASK_STATES,
  terminal: ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'TIMED_OUT'],
  edges: [
    { from: 'QUEUED', to: 'CLAIMED' },
    { from: 'QUEUED', to: 'CANCELLED' },
    { from: 'CLAIMED', to: 'SESSION_CREATING' },
    { from: 'CLAIMED', to: 'QUEUED' },
    { from: 'SESSION_CREATING', to: 'RUNNING' },
    { from: 'SESSION_CREATING', to: 'RETRY_WAIT' },
    { from: 'RUNNING', to: 'COLLECTING' },
    { from: 'RUNNING', to: 'RETRY_WAIT' },
    { from: 'RUNNING', to: 'CANCELLING' },
    { from: 'RUNNING', to: 'TIMED_OUT' },
    { from: 'COLLECTING', to: 'VALIDATING' },
    { from: 'COLLECTING', to: 'REPAIRING' },
    { from: 'COLLECTING', to: 'FAILED' },
    { from: 'REPAIRING', to: 'COLLECTING' },
    { from: 'VALIDATING', to: 'COMMITTING' },
    { from: 'VALIDATING', to: 'BLOCKED' },
    { from: 'COMMITTING', to: 'SUCCEEDED' },
    { from: 'CANCELLING', to: 'CANCELLED' },
    { from: 'RETRY_WAIT', to: 'QUEUED' },
    { from: 'RETRY_WAIT', to: 'FAILED' },
  ],
});

export const TASK_INITIAL_STATE: TaskState = 'QUEUED';

/**
 * 可取消的状态：**从迁移表派生**，即「存在一条通往 `CANCELLING` 或 `CANCELLED` 的边」。
 *
 * 派生结果是 `QUEUED`、`RUNNING`、`CANCELLING` 三个：
 *
 * - `QUEUED → CANCELLED` 与 `RUNNING → CANCELLING` 是架构 §6.1 画出的两条边，对应
 *   「还没起 Session」和「Session 正在跑」两种取消路径。
 * - `CANCELLING` 也在集合里，因为它有一条 `→ CANCELLED` 的出边。这是**有意的**：取消
 *   请求本身是幂等的（`requestCancel` 只写 `cancel_requested_at`，且保留最早的那个），
 *   对一个正在取消的任务再收一次请求应当是 202 而不是 409 —— 回 `TASK_NOT_CANCELLABLE`
 *   （文案 `task.cancel.notAllowed`）等于告诉学生「这个任务不能取消」，而它恰恰正在被
 *   取消。
 *
 * 反过来，`CLAIMED` / `SESSION_CREATING` **不在**集合里：这两个状态期间取消会留下
 * 一个已经创建却没人回收的 QCA Session，因此不接受取消请求，让它先跑到 `RUNNING`。
 */
export const CANCELLABLE_TASK_STATES: readonly TaskState[] = TASK_STATES.filter(
  (state) =>
    canTransition(TASK_TRANSITIONS, state, 'CANCELLING') ||
    canTransition(TASK_TRANSITIONS, state, 'CANCELLED'),
);

export function isCancellableTaskState(state: TaskState): boolean {
  return (CANCELLABLE_TASK_STATES as readonly string[]).includes(state);
}

export function assertCancellableTaskState(state: TaskState): void {
  if (!isCancellableTaskState(state)) throw new DomainError('TASK_NOT_CANCELLABLE', 'TaskState');
}

/**
 * 可被 `:pump` 推进的状态：**从迁移表派生**，即「非终态，且不是 `CANCELLING`」。
 *
 * 派生结果是 9 个：`QUEUED`、`CLAIMED`、`SESSION_CREATING`、`RUNNING`、`COLLECTING`、
 * `REPAIRING`、`VALIDATING`、`COMMITTING`、`RETRY_WAIT`。
 *
 * - **终态不在集合里**，这是 §12.2「完整回合由多个 pump 完成」的安全边界：一个已经
 *   `SUCCEEDED` / `FAILED` / `CANCELLED` 的任务再收 pump 必须是无副作用的 no-op
 *   （200 + `NO_OP_TERMINAL`），既不重开状态机、也不复活 Session、也不改 revision。
 *   否则「前端单飞轮询」就等价于「无限重试」，而重试是 `retryTask` 的语义，
 *   有自己的 `TASK_NOT_RETRYABLE` 与 attempt 预算。
 * - **`CANCELLING` 不在集合里**：它正在被拆除，再推进一步工作会与已经记录的取消请求
 *   直接矛盾。注意这与可取消集合的处理**相反** —— `CANCELLING` 可以再收一次取消
 *   （取消是幂等的），但不可以再收一次推进。
 * - **`RETRY_WAIT` 在集合里**，但能不能真的推进还要看 `nextRunAt`：等待期内的 pump
 *   返回 `NO_OP_WAITING` 而不是把任务提前放回队列。少了这道时间闸，客户端就能用
 *   pump 抹掉退避、把 provider 打成筛子；过了 `nextRunAt` 之后，pump 与租约扫描
 *   谁能先把它推回 `QUEUED` 就谁赢，两者都走同一条 CAS，不会产生两次推进。
 */
export const PUMPABLE_TASK_STATES: readonly TaskState[] = TASK_TRANSITIONS.states.filter(
  (state) => !isTerminalState(TASK_TRANSITIONS, state) && state !== 'CANCELLING',
);

export function isPumpableTaskState(state: TaskState): boolean {
  return (PUMPABLE_TASK_STATES as readonly string[]).includes(state);
}

/** UsageReservation：`HELD → COMMITTED/RELEASED/EXPIRED`，三个都是终态，不可回退。 */
export const RESERVATION_TRANSITIONS: TransitionTable<ReservationState> =
  transitionTable<ReservationState>({
    name: 'ReservationState',
    states: RESERVATION_STATES,
    terminal: ['COMMITTED', 'RELEASED', 'EXPIRED'],
    edges: [
      { from: 'HELD', to: 'COMMITTED' },
      { from: 'HELD', to: 'RELEASED' },
      { from: 'HELD', to: 'EXPIRED' },
    ],
  });

export const RESERVATION_INITIAL_STATE: ReservationState = 'HELD';

/** Course：`DRAFT → PUBLISHED → ARCHIVED`，归档后只读。 */
export const COURSE_TRANSITIONS: TransitionTable<CourseStatus> = transitionTable<CourseStatus>({
  name: 'CourseStatus',
  states: COURSE_STATUSES,
  terminal: ['ARCHIVED'],
  edges: [
    { from: 'DRAFT', to: 'PUBLISHED' },
    { from: 'PUBLISHED', to: 'ARCHIVED' },
  ],
});

export const COURSE_INITIAL_STATUS: CourseStatus = 'DRAFT';

/** Assignment：`DRAFT → PUBLISHED → CLOSED → ARCHIVED`，单向。 */
export const ASSIGNMENT_TRANSITIONS: TransitionTable<AssignmentStatus> =
  transitionTable<AssignmentStatus>({
    name: 'AssignmentStatus',
    states: ASSIGNMENT_STATUSES,
    terminal: ['ARCHIVED'],
    edges: [
      { from: 'DRAFT', to: 'PUBLISHED' },
      { from: 'PUBLISHED', to: 'CLOSED' },
      { from: 'CLOSED', to: 'ARCHIVED' },
    ],
  });

export const ASSIGNMENT_INITIAL_STATUS: AssignmentStatus = 'DRAFT';

/**
 * Submission：`SUBMITTED → GRADED/REVISION_REQUESTED`。两个都是终态 —— 重交创建
 * **新的** Submission，不覆盖历史（架构 §4.7），所以不存在回到 SUBMITTED 的边。
 */
export const SUBMISSION_TRANSITIONS: TransitionTable<SubmissionStatus> =
  transitionTable<SubmissionStatus>({
    name: 'SubmissionStatus',
    states: SUBMISSION_STATUSES,
    terminal: ['GRADED', 'REVISION_REQUESTED'],
    edges: [
      { from: 'SUBMITTED', to: 'GRADED' },
      { from: 'SUBMITTED', to: 'REVISION_REQUESTED' },
    ],
  });

export const SUBMISSION_INITIAL_STATUS: SubmissionStatus = 'SUBMITTED';

/**
 * LearningProgress：派生状态，不是数据库列；「逾期」是与之正交的独立 flag。
 *
 * 相对 §6.2 的箭头链多了一条 `REVISION_REQUIRED → SUBMITTED`：被要求修改之后学生
 * 当然要再交一次，少了这条边 `REVISION_REQUIRED` 就成了既非终态又无出边的死胡同。
 * `GRADED` 是终态（这份作业的进度到此为止）。
 */
export const LEARNING_PROGRESS_TRANSITIONS: TransitionTable<LearningProgressState> =
  transitionTable<LearningProgressState>({
    name: 'LearningProgressState',
    states: LEARNING_PROGRESS_STATES,
    terminal: ['GRADED'],
    edges: [
      { from: 'NOT_STARTED', to: 'IN_PROGRESS' },
      { from: 'IN_PROGRESS', to: 'SUBMITTED' },
      { from: 'SUBMITTED', to: 'GRADED' },
      { from: 'SUBMITTED', to: 'REVISION_REQUIRED' },
      { from: 'REVISION_REQUIRED', to: 'SUBMITTED' },
    ],
  });

export const LEARNING_PROGRESS_INITIAL_STATE: LearningProgressState = 'NOT_STARTED';

/**
 * 全部迁移表，按名字升序。契约层与测试都从这里遍历，避免「新增一张表但忘了接线」
 * ——排序是为了让任何遍历结果与宿主、与声明顺序都无关。
 */
export const TRANSITION_TABLES = [
  {
    name: 'AccountSessionStatus',
    table: ACCOUNT_SESSION_TRANSITIONS,
    initial: ACCOUNT_SESSION_INITIAL_STATUS,
  },
  { name: 'AccountStatus', table: USER_TRANSITIONS, initial: USER_INITIAL_STATUS },
  { name: 'AssignmentStatus', table: ASSIGNMENT_TRANSITIONS, initial: ASSIGNMENT_INITIAL_STATUS },
  { name: 'CourseStatus', table: COURSE_TRANSITIONS, initial: COURSE_INITIAL_STATUS },
  { name: 'GroupStatus', table: GROUP_TRANSITIONS, initial: GROUP_INITIAL_STATUS },
  {
    name: 'LearningProgressState',
    table: LEARNING_PROGRESS_TRANSITIONS,
    initial: LEARNING_PROGRESS_INITIAL_STATE,
  },
  { name: 'ProjectStatus', table: PROJECT_TRANSITIONS, initial: PROJECT_INITIAL_STATUS },
  {
    name: 'PublicationStatus',
    table: PUBLICATION_TRANSITIONS,
    initial: PUBLICATION_INITIAL_STATUS,
  },
  { name: 'ReservationState', table: RESERVATION_TRANSITIONS, initial: RESERVATION_INITIAL_STATE },
  { name: 'SubmissionStatus', table: SUBMISSION_TRANSITIONS, initial: SUBMISSION_INITIAL_STATUS },
  { name: 'TaskState', table: TASK_TRANSITIONS, initial: TASK_INITIAL_STATE },
  { name: 'WorkStatus', table: WORK_TRANSITIONS, initial: WORK_INITIAL_STATUS },
] as const;

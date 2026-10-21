import type {
  AiTask,
  IdempotencyKey,
  Project,
  ProjectId,
  ProjectVersion,
  ProjectVersionId,
  RequestHash,
  Revision,
  TaskEvent,
  TaskId,
  Timestamp,
  UsageLedgerEntry,
  UsageReservation,
} from '@littleq/domain';
import type { TaskInputRef, TaskPrivateRecord } from '../task-private.js';
import type { TaskLease } from '../task-lease.js';

/**
 * 装配端口 2／2：`TaskUnitOfWork` —— 把"一次推进"变成**一个事务**（ZLQ-216 §3.5）。
 *
 * ## 它解决的问题
 *
 * §3.5 逐字：「现有 `save/appendEvent` 也没有事务/lease 参数；逐个调用全局仓储不等于
 * 同事务。」一次有界切片要同时写 `ai_tasks`、`task_private`、`task_events`、
 * `project_versions`、`projects`、`usage_*`，还要在写之前证明"我仍是租约持有者、
 * revision 没被人推进过"。逐个调用全局仓储的话，任意两次调用之间进程崩掉就是部分提交
 * —— 版本写进去了而 task 还停在 `COMMITTING`，或者 reservation 结算了而版本没写。
 *
 * 所以这里给的不是"更多的仓储方法"，而是**一个作用域**：`run` 的回调里拿到的每个
 * 句柄都绑在同一个 `DatabaseTransaction` 上，事务外拿不到，回滚时一起消失。
 *
 * ## 归属
 *
 * §10.2：「application 内部由 F1 拥有 ports、F2 拥有 use-cases。」本文件是 ports。
 * 「先固定 prompt 快照、再校验 baseRevision、再 CAS」这套**编排**属于 F2 的用例；
 * 这里只规定"同一事务里能做什么、CAS 失配会怎样"。
 */

/**
 * 事务内的 task 句柄。
 *
 * §3.5 逐字：「`tasks` 实现原 `TaskRepository` **且不改变其签名**」，所以这里把那份
 * 冻结接口逐字重述一遍，一个方法都不增不减。重述而不是 `import type` 的原因与
 * `TaskLease` 完全相同（见 `../task-lease.ts` 的文件头）：infra 要 `implements` 本端口，
 * 反向 import 会让 `tsc -b` 的项目引用成环。双向可赋值断言在
 * `packages/infra/test/task-pump-store-transaction.test.ts`。
 *
 * `claim` 在事务作用域内没有意义（它是队列语义，而本端口是定向语义），但删掉它就
 * 等于改了签名，所以原样保留。
 *
 * §3.5 对事务内使用的额外约束（实现必须满足，签名表达不了，写在这里）：
 * 「每次返回实际 AiTask，**下一调用的 expectedRevision 取上一次结果**，不沿用初始
 * revision」；「appendEvent 产生的新增 revision 也进入 payload/响应 ETag」。
 */
export interface TaskTransactionTasks {
  claim(input: TaskTransactionClaimInput): Promise<readonly TaskLease[]>;
  renewLease(input: {
    readonly lease: TaskLease;
    readonly now: Timestamp;
    readonly leaseSeconds: number;
  }): Promise<TaskLease | null>;
  reacquireLease(input: {
    readonly taskId: TaskId;
    readonly workerId: string;
    readonly now: Timestamp;
    readonly leaseSeconds: number;
  }): Promise<TaskLease | null>;
  requeueOnLeaseExpiry(input: {
    readonly taskId: TaskId;
    readonly now: Timestamp;
  }): Promise<boolean>;
  releaseLease(input: { readonly lease: TaskLease; readonly now: Timestamp }): Promise<void>;
  save(input: {
    readonly task: AiTask;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null>;
  appendEvent(input: {
    readonly event: TaskEvent;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null>;
  scheduleNextRun(input: {
    readonly taskId: TaskId;
    readonly nextRunAt: Timestamp;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null>;
  findById(taskId: TaskId): Promise<AiTask | null>;
}

/** 冻结的 `TaskClaimInput`，逐字重述（理由同上）。 */
export interface TaskTransactionClaimInput {
  readonly workerId: string;
  readonly now: Timestamp;
  readonly leaseSeconds: number;
  readonly limit: number;
}

/**
 * 事务内的 project 句柄。
 *
 * §3.5：「CAS 失配返回 `null`，**必须使整事务失败**；提交前确认 `currentVersionId`
 * 属于同项目。」后半句对应 §3.2 表尾的「事务提交时保证当前版本属于同项目」——
 * `projects.current_version_id` 与 `versions.project_id` 之间没有 FK 能表达这条
 * （两个方向都 nullable / 后建），所以它只能由事务内的一次断言来保证。
 */
export interface TaskTransactionProjects {
  findById(id: ProjectId): Promise<Project | null>;
  save(input: {
    readonly project: Project;
    readonly expectedRevision: Revision;
  }): Promise<Project | null>;
}

/**
 * 事务内的 version 句柄。
 *
 * §3.5：「`UNIQUE(source_task_id)` 与 `UNIQUE(project_id, sequence)` 防重复。重入先读
 * 该 task 既有 version，内容一致才复用，不生成第二版本；sequence 从**本事务锁定
 * project 的现有版本**递增。」
 *
 * `findBySourceTaskId` 是"重入不生成第二版本"的唯一判据，所以它是端口的一部分而不是
 * 实现的便利方法：`COMMITTING` 是可重入的（§3.5 尾段），第二次进来必须先看见第一次
 * 已经写下的那一行。
 */
export interface TaskTransactionVersions {
  findById(id: ProjectVersionId): Promise<ProjectVersion | null>;
  findBySourceTaskId(taskId: TaskId): Promise<ProjectVersion | null>;
  insert(version: ProjectVersion): Promise<ProjectVersion>;
}

/**
 * 事务内的 `task_private` 句柄。
 *
 * §3.5：「事务**同时锁定该 task_private 行**，读取最新 journal 并保留已有不可变回执，
 * 再合并本步 checkpoint/subphase，**不能拿外呼前旧快照覆盖新回执**。只写本 task，
 * 与 task/event 共同提交，不是事务外另一个连接。」
 *
 * "保留已有回执"是这条端口存在的理由：整行覆盖写会把别的持有者刚补记进来的回执抹掉，
 * 而那正是 §3.5 尾段「不能让旧持有者调用全局 save 绕过 lease 检查」要防的事在私有状态
 * 上的翻版。
 */
export interface TaskTransactionPrivateState {
  findByTaskId(taskId: TaskId): Promise<TaskPrivateRecord | null>;
  save(record: TaskPrivateRecord): Promise<void>;
}

/**
 * 事务内的用量句柄。
 *
 * §3.5：「`reserve/settle` 使用现有用量实体与判据；task＋结算阶段唯一键，重复同事实
 * 幂等，**不能在版本提交失败后单独完成结算**。」最后半句就是"为什么它们在同一个事务里"
 * 的答案：结算一旦独立提交，版本回滚之后额度已经扣掉，学生的账与作品对不上。
 *
 * 两个方法都只接受 domain 实体（`UsageReservation` / `UsageLedgerEntry`），
 * 「按实际量结算、差额自动释放」的判据在 domain 的 `commitUsage` / `settlementDelta`
 * 里，本端口不复述数值。
 */
export interface TaskTransactionReservations {
  reserve(reservation: UsageReservation): Promise<void>;
  settle(input: {
    readonly reservation: UsageReservation;
    readonly ledger: UsageLedgerEntry;
  }): Promise<void>;
}

/**
 * 事务作用域内可获得的全部句柄。
 *
 * 所有句柄绑在**同一个** `DatabaseTransaction` / 连接上，事务外拿不到 —— 这是类型的
 * 一部分：`run` 是唯一会把 `TaskTransaction` 交出来的地方，而它只在回调执行期间有效。
 */
export interface TaskTransaction {
  readonly tasks: TaskTransactionTasks;
  readonly projects: TaskTransactionProjects;
  readonly versions: TaskTransactionVersions;
  readonly privateState: TaskTransactionPrivateState;
  readonly reservations: TaskTransactionReservations;
}

/**
 * `createTurn` 的入参（§3.5）。
 *
 * `privateState` 是**对 §3.5 输入清单的一处必要补充**，交付说明里已列明：清单写的是
 * 「再 INSERT task/private/reservation」，而要 INSERT private 就得有它的完整记录，
 * 单靠 `inputRef` 拼不出 `operationJournal` / `collectionCursor` / `inputSnapshot`。
 *
 * `now` 同理：`createTurn` 要写 `task_events`（`STATE_CHANGED`）与 reservation 的
 * `expiresAt`，两者都需要时刻，而 domain 一律把"现在几点"作为入参。
 */
export type CreateTurnInput = {
  readonly projectId: ProjectId;
  readonly expectedProjectRevision: Revision;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestHash: RequestHash;
  readonly task: AiTask;
  readonly privateState: TaskPrivateRecord;
  readonly reservation: UsageReservation;
  readonly inputRef: TaskInputRef;
  readonly now: Timestamp;
};

/**
 * `createTurn` 的结果。
 *
 * `revision` 是**受理时**的 project revision，取自 `ai_tasks.accepted_project_revision`
 * （§3.2 新增列）。§3.5 逐字：「原受理 project revision 存 ai_tasks 的
 * `accepted_project_revision bigint`，**回放不取后来变动的 revision**。」
 *
 * 这一条决定了幂等重放的正确性：同一个 Idempotency-Key 重放要还原**当初**那次受理的
 * 响应（含 ETag），而如果去读 project 当前的 revision，第二次重放会因为期间别人推进过
 * 项目而返回一个不同的 ETag —— 客户端据此认为"我的请求被改了"。
 */
export type CreateTurnResult = {
  readonly taskId: TaskId;
  readonly revision: Revision;
};

/** `run` 的入参（§3.5：「开始用 DB 时钟核验同 taskId、leaseToken、未到期与 expectedRevision」）。 */
export type TaskRunInput = {
  readonly lease: TaskLease;
  readonly expectedRevision: Revision;
};

export interface TaskUnitOfWork {
  /**
   * 创建一次 turn：**单事务**。
   *
   * §3.5 逐字：「单事务锁 project，先按该 project/key 查重：同 hash 回放原受理结果，
   * 异 hash 报既有 `IDEMPOTENCY_KEY_REUSED`；新 key 才比较项目 revision 与可写 /
   * active-task 判据，再 INSERT task/private/reservation 并 CAS project。」
   *
   * 顺序是有意义的：**查重在 CAS 之前**。反过来做的话，同一个 key 的并发重放会先各自
   * 把 project revision 推一格，然后其中一个 CAS 失败 —— 客户端看到的是 409，而正确的
   * 回答是"这就是你上一次那个 task"。
   *
   * 「无 TaskLease、不调用旧 `tasks.save` 冒充首次 INSERT」（§3.5 尾段）：此时任务还
   * 不属于任何 worker，铸一份租约等于凭空宣称有人在推进它；而 `save` 是 CAS 语义，
   * 用它做首次写入会让"行不存在"与"revision 失配"两种情况无法区分。
   *
   * 「DB 失败不得返回成功」（§3.4 步骤 2）。
   */
  createTurn(input: CreateTurnInput): Promise<CreateTurnResult>;

  /**
   * 在一个事务里执行一次有界推进。
   *
   * §3.5 逐字：「开始用 DB 时钟核验同 taskId、leaseToken、未到期与 expectedRevision；
   * **最终写入再检查 token/到期，并使用事务内最后一次实际返回的 revision，不能仍比较
   * 初始 revision**。回调抛错或任一 CAS 返回 `null` 均回滚，向用例返回既有
   * `REVISION_CONFLICT`；成功才提交并返回值。」
   *
   * "最后一次实际返回的 revision"这条最容易写错：`appendEvent` 自己也会推进 revision，
   * 于是"保存 task → 追加 COMPLETED 事件"之后，手里的 revision 已经比入参那个大两格。
   * 拿入参的 revision 去做最终校验，校验的是一行早就不存在的状态。
   *
   * **外呼不在这里**：§3.5 尾段「外呼必须在这些短事务之外」，§5.1 的 8 s / 6 s 预算也
   * 不允许把一个 provider 往返圈进 DB 事务。回调只做纯计算与 DB 读写。
   */
  run<T>(input: TaskRunInput, work: (bound: TaskTransaction) => Promise<T>): Promise<T>;
}

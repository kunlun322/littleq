/**
 * 端口 2／5：`TaskRepository` —— claim、lease、revision CAS、appendEvent、next_run_at
 * （ZLQ-194 §6.2、arch §6.1）。
 *
 * ## 判定在 domain，持久化在这里
 * 「能不能领」「能不能续租」「能不能接管孤儿」这三件事的**判据**已经由
 * `@littleq/domain` 的 `canClaimTask` / `canRenewLease` / `canReacquireLease` /
 * `canRequeueOnLeaseExpiry` 给死了；本端口负责把它们变成**原子的**持久化操作。分开的原因是
 * 判据是纯函数（可穷举、可复算），而原子性只有在存储层才能表达 —— 一个「先 SELECT 再
 * UPDATE」的实现就算调对了判据，也照样会在两个 worker 之间双领。
 *
 * `nextRunAt` 的归属也在这条边界上：domain 的注释写明它「只是被比较，不被计算」，值由 infra
 * 在 `RETRY_WAIT → QUEUED` 时写入，所以 `scheduleNextRun` 是本端口的方法而不是 domain 的。
 *
 * ## CAS 的返回约定
 * 所有带 `expectedRevision` 的方法在不匹配时返回 `null`，**不抛**。理由是 revision 冲突是
 * 正常运行时事件（两个 worker 抢同一个任务），把它做成异常会让调用方用 try/catch 表达控制流，
 * 而 `null` 逼出一次显式的「重读 → 重试」。对外映射到 `REVISION_CONFLICT`（409）是 D5 的事。
 */
import type { AiTask, Branded, Revision, TaskEvent, TaskId, Timestamp } from '@littleq/domain';

/**
 * 租约令牌：不透明、单次租约内唯一。
 *
 * 有了它，「我以为我还持有这个任务」就不再是一种可能：过期后被别人接管的租约，令牌已经变了，
 * 旧 worker 的 `renewLease` 会拿到 `null` 而不是把别人的租约又延长一段。
 */
export type LeaseToken = Branded<string, 'LeaseToken'>;

export interface TaskLease {
  readonly taskId: TaskId;
  readonly leaseToken: LeaseToken;
  readonly leaseUntil: Timestamp;
  readonly revision: Revision;
}

export interface TaskClaimInput {
  readonly workerId: string;
  readonly now: Timestamp;
  /**
   * 租约时长（秒）。**必须是正整数**：非正数会铸出一份当场就已过期的租约，而
   * `canReacquireLease` 只看「租约持有态 + 已过期」，于是别人立刻就能接管 —— 同一时刻两个
   * 推进器驱动同一个任务，正是租约要消灭的那件事。违规抛 `LEASE_TTL_OUT_OF_RANGE`。
   *
   * 注意这条下界**不在** domain 的判据里：`canClaimTask` 等谓词只比较调用方给的时间，
   * 「时长本身合不合法」是铸造租约这一刻的事，所以它归 infra。
   */
  readonly leaseSeconds: number;
  /** 一次最多领几个；上界由调用方按 worker 并发度给，本端口不复述具体数值。 */
  readonly limit: number;
}

export interface TaskRepository {
  /** 原子领取：只可能拿到 `canClaimTask` 为真的任务，且拿到即已持有租约。 */
  claim(input: TaskClaimInput): Promise<readonly TaskLease[]>;

  /** 续租；令牌不符或已过期 ⇒ `null`（那已经是抢占，走 `reacquireLease`）。 */
  renewLease(input: {
    readonly lease: TaskLease;
    readonly now: Timestamp;
    readonly leaseSeconds: number;
  }): Promise<TaskLease | null>;

  /** 接管孤儿租约：租约已过期且任务仍在被驱动的状态。 */
  reacquireLease(input: {
    readonly taskId: TaskId;
    readonly workerId: string;
    readonly now: Timestamp;
    readonly leaseSeconds: number;
  }): Promise<TaskLease | null>;

  /** 仅 `CLAIMED` 且租约已过期时退回 `QUEUED`；返回是否真的退回了。 */
  requeueOnLeaseExpiry(input: {
    readonly taskId: TaskId;
    readonly now: Timestamp;
  }): Promise<boolean>;

  /** 主动交还租约（任务完成、被取消、worker 优雅退出）。 */
  releaseLease(input: { readonly lease: TaskLease; readonly now: Timestamp }): Promise<void>;

  /** revision CAS 落库。 */
  save(input: {
    readonly task: AiTask;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null>;

  /** 追加事件并推进 revision；`assertEventFollows` 的序列约束由 domain 判定。 */
  appendEvent(input: {
    readonly event: TaskEvent;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null>;

  /** `RETRY_WAIT → QUEUED` 时写入 `next_run_at`（arch §6.1 的 `(next_run_at)` 注解）。 */
  scheduleNextRun(input: {
    readonly taskId: TaskId;
    readonly nextRunAt: Timestamp;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null>;

  findById(taskId: TaskId): Promise<AiTask | null>;
}

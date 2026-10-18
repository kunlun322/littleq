/**
 * 租约策略（附录 A §6.4：「`leaseOwner/leaseUntil/nextRunAt` 的持久化与抢占实现」
 * 属于 application/infra，「**domain 只定义合法领取/续租条件**」）。
 *
 * 总体架构 line 581 是这条边界的出处：「每一步都是可重入的：先读持久状态，调用外部
 * API 时带 `external_operation_key`，再以 revision CAS 保存结果。推进器崩溃后租约过期，
 * 其他实例继续。」所以这里全是**纯谓词**：输入是调用方从数据库读出来的状态与时间，
 * 输出是一个布尔值。domain 不持有任何租约、不记时钟、不做抢占 —— 抢占是
 * `UPDATE … WHERE lease_until < now` 这种 infra 语句的事。
 *
 * 两个操作必须分开，混在一起会造出真实缺陷：
 *
 * - **领取一个新任务** = `QUEUED → CLAIMED` 的**状态迁移**（arch §6.1 的 lease 边）；
 * - **接管一个孤儿租约** = 状态**不变**，只有 infra 侧的 `lease_owner` / `lease_until`
 *   换人。推进器在 `RUNNING` 崩掉时，任务并不回到 `QUEUED`：QCA Session 还活着，
 *   下一个实例要接着推进它，而不是从头再来一遍（那会重复计费）。
 *
 * `CLAIMED → QUEUED (lease expired)` 是第三种情形，也是 arch §6.1 里唯一一条租约过期
 * 回退边：任务已被领取但**还没有产生任何外部副作用**，此时重来是安全的，所以只有
 * `CLAIMED` 有这条边。`canRequeueOnLeaseExpiry` 因此把状态钉死在 `CLAIMED`。
 */

import { TASK_TRANSITIONS } from '../states/machines.js';
import { canTransition, isTerminalState } from '../states/transition.js';
import { parseTimestamp, type Timestamp } from '../value-objects/primitives.js';
import { parseTaskState, type TaskState } from '../value-objects/task.js';

/**
 * 没有任何推进器在驱动的状态。
 *
 * 这是**显式常量**，不是从迁移表派生的：迁移表编码的是「哪些迁移合法」，而租约问的是
 * 「此刻有没有人在推进它」，两者不是同一个事实。`RETRY_WAIT` 就是反例 —— 它有出边
 * （`→ QUEUED`、`→ FAILED`），但它靠 `next_run_at` 等待，没有推进器持有它；
 * `QUEUED` 同理，它是被领取的对象而不是被持有的对象。硬要派生就只能把这两个状态名
 * 写进派生规则里，那只是把常量藏起来。
 */
export const IDLE_TASK_STATES = ['QUEUED', 'RETRY_WAIT'] as const satisfies readonly TaskState[];

/** 可能持有租约的状态：非终态，且不是 idle。顺序沿用 `TASK_STATES`（对外 enum 顺序）。 */
export const LEASE_HOLDING_TASK_STATES: readonly TaskState[] = TASK_TRANSITIONS.states.filter(
  (state) =>
    !isTerminalState(TASK_TRANSITIONS, state) &&
    !(IDLE_TASK_STATES as readonly TaskState[]).includes(state),
);

export function isIdleTaskState(state: TaskState): boolean {
  return (IDLE_TASK_STATES as readonly TaskState[]).includes(parseTaskState(state));
}

export function isLeaseHoldingTaskState(state: TaskState): boolean {
  return LEASE_HOLDING_TASK_STATES.includes(parseTaskState(state));
}

/** 租约已过期。`leaseUntil` 缺失视为**没有租约**，而不是"永不过期"。 */
export function isLeaseExpired(leaseUntil: Timestamp | null, now: Timestamp): boolean {
  if (leaseUntil === null) return true;
  return Date.parse(parseTimestamp(leaseUntil)) <= Date.parse(parseTimestamp(now));
}

/**
 * 能否领取一个新任务：只有 `QUEUED`，且 `next_run_at` 已到（或本来就没有）。
 *
 * `nextRunAt` 在这里只是**被比较**，不被计算 —— 它的值由 infra 在 `RETRY_WAIT → QUEUED`
 * 时写入（arch §6.1 的 `(next_run_at)` 注解）。
 */
export function canClaimTask(
  state: TaskState,
  nextRunAt: Timestamp | null,
  now: Timestamp,
): boolean {
  parseTaskState(state);
  if (state !== 'QUEUED') return false;
  if (nextRunAt !== null && Date.parse(parseTimestamp(nextRunAt)) > Date.parse(parseTimestamp(now)))
    return false;
  return canTransition(TASK_TRANSITIONS, 'QUEUED', 'CLAIMED');
}

/**
 * 能否续租：任务仍在被驱动，且当前租约还没过期。
 *
 * 过期之后就不叫续租了 —— 那已经是抢占，走 `canReacquireLease`。把两者分开是为了让
 * 「我以为我还持有它」这种 bug 变成一次显式的判定失败，而不是一次静默的租约延长。
 */
export function canRenewLease(
  state: TaskState,
  leaseUntil: Timestamp | null,
  now: Timestamp,
): boolean {
  if (!isLeaseHoldingTaskState(state)) return false;
  return !isLeaseExpired(leaseUntil, now);
}

/**
 * 能否接管孤儿租约：租约已过期，且任务仍处在有人本该驱动它的状态。
 *
 * 注意**不包含** `QUEUED`：那是 `canClaimTask` 的活儿，走的是状态迁移；也不包含终态，
 * 终态任务不该被任何实例捡起来（§6.2「终态不可回退」）。
 */
export function canReacquireLease(
  state: TaskState,
  leaseUntil: Timestamp | null,
  now: Timestamp,
): boolean {
  if (!isLeaseHoldingTaskState(state)) return false;
  return isLeaseExpired(leaseUntil, now);
}

/**
 * 租约过期后能否退回 `QUEUED` 重来：**仅 `CLAIMED`**。
 *
 * 这是 arch §6.1 里唯一的租约过期回退边。`SESSION_CREATING` 及之后的状态可能已经产生了
 * 外部副作用（Session 已建、Agent 已跑），把它们退回 `QUEUED` 会让下一个实例重新调用
 * provider —— 那正是 §6.2 划出的三种语义（HTTP 重放 / task 新 attempt / Session 内 repair）
 * 之外非法的第四种。这些状态过期后走 `canReacquireLease`，接着原来的进度推进。
 */
export function canRequeueOnLeaseExpiry(
  state: TaskState,
  leaseUntil: Timestamp | null,
  now: Timestamp,
): boolean {
  parseTaskState(state);
  if (state !== 'CLAIMED') return false;
  if (!isLeaseExpired(leaseUntil, now)) return false;
  return canTransition(TASK_TRANSITIONS, 'CLAIMED', 'QUEUED');
}

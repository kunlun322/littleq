/**
 * `:pump` 的推进决策（附录 §3.2 步骤 5「前端单飞调用 `:pump` 推进」+ §12.2
 * 「将单请求测试上限压到 10 秒，完整回合仍可由多个 pump 完成；不存在等待完整 QCA
 * 的 HTTP 请求」）。
 *
 * ## 这一层决定什么、不决定什么
 *
 * 与 `lease.ts` 同一条边界：这里全是**纯决策**。输入是调用方从数据库读出来的一组事实，
 * 输出是一个可以直接执行的判定。domain 不持有 in-flight 表、不记时钟、不做抢占 ——
 * §6.5 规则 5 说得很硬：「进程内 semaphore 或 Map **不是**事实源」。
 *
 * 于是「单飞」不是这里的一把锁，而是三件既有机制的合成，`decideTaskPump` 只负责
 * 把它们的结果翻译成一个可执行的判定：
 *
 * 1. **revision CAS**：推进的落库是 `UPDATE … WHERE id = ? AND revision = ?`。同时到达
 *    的多个 pump 里只有一个能改到行，其余的影响行数为 0。这是唯一的事实源。
 * 2. **租约**：`drivenByAnother` 由 infra 用 `lease_owner` / `lease_until` 判定后传入。
 *    已经有人在推进时，第二个 pump 不该再起一个切片 —— 那是重复计费，不是并发控制。
 * 3. **`external_operation_key`**（`taskId:stage:attempt`）：即使前两道都漏了，provider
 *    侧看到的仍是同一个键，不会产生第二个 Session。这是最后一道，也是最贵的一道。
 *
 * ## 四种判定
 *
 * - `ADVANCE`：执行一个有界切片，然后 CAS 提交新 revision。200 + `ADVANCED`。
 * - `COALESCE`：同一 revision 上已有人在推进。200 + `COALESCED_IN_FLIGHT`，
 *   无副作用、不改 revision。前端把「我发的这一次」和「别人发的那一次」合并成同一个
 *   进度流，所以轮询频率可以随便高 —— 这正是「单飞」在 HTTP 层的可见结果。
 * - `NO_OP`：三种不需要客户端重新 GET 的「没活干」。200，无副作用。
 * - `CONFLICT`：`If-Match` 与当前 revision 不一致。409 `REVISION_CONFLICT`，客户端
 *   **必须**重新 GET 才能继续 —— 用 200 回答会把这条义务藏起来。
 *
 * 判定顺序是**语义**的一部分，不是随手写的：终态与取消先于 `If-Match` 比较。一个已经
 * `SUCCEEDED` 的任务，客户端手里的 revision 几乎必然是旧的（它是从 SSE 或上一次 GET
 * 拿的），若先比 `If-Match` 就会回 409，而 409 的含义是「重新 GET 再试」—— 那条路
 * 永远走不到头。先判终态，前端一次就能停下轮询。
 */

import { TASK_TRANSITIONS } from '../states/machines.js';
import { isTerminalState } from '../states/transition.js';
import {
  compareRevisions,
  compareTimestamps,
  parseRevision,
  parseTimestamp,
  type Revision,
  type Timestamp,
} from '../value-objects/primitives.js';
import { parseTaskState, type TaskPumpOutcome, type TaskState } from '../value-objects/task.js';

/** 三个 no-op 结果；`ADVANCED` 与 `COALESCED_IN_FLIGHT` 各自对应一种判定，不在此列。 */
export type TaskPumpNoOpOutcome = Extract<
  TaskPumpOutcome,
  'NO_OP_WAITING' | 'NO_OP_CANCELLING' | 'NO_OP_TERMINAL'
>;

export type TaskPumpDecision =
  | { readonly kind: 'ADVANCE' }
  | { readonly kind: 'COALESCE' }
  | { readonly kind: 'NO_OP'; readonly outcome: TaskPumpNoOpOutcome }
  | { readonly kind: 'CONFLICT' };

export type TaskPumpFacts = {
  readonly state: TaskState;
  /** 任务当前 revision（从数据库读出来的那一个，不是客户端声称的那一个）。 */
  readonly revision: Revision;
  /** `If-Match` 回填的 revision。pump 是条件写，契约上这个头必填。 */
  readonly ifMatchRevision: Revision;
  readonly nextRunAt: Timestamp | null;
  /**
   * 是否有**别的**执行者持有未过期租约。
   *
   * 由 infra 判定后传入：`lease_owner` 是 infra 的字段，domain 见不到它，也不该见到
   * （附录 A §6.4）。调用方拿自己的 owner 标识与 `lease_owner` / `lease_until` 比较，
   * 把结果压成这一个布尔值 —— 与 `canReacquireLease` 接收 `leaseUntil` 是同一套分工。
   */
  readonly drivenByAnother: boolean;
  readonly now: Timestamp;
};

/**
 * 退避是否仍在生效。`nextRunAt` 为 `null` 视为**不等待**，与 `isLeaseExpired` 把
 * `leaseUntil === null` 视为「没有租约」是同一种保守方向：缺失的字段不该被解释成
 * 「无限期阻塞」。
 */
export function isRetryBackoffActive(nextRunAt: Timestamp | null, now: Timestamp): boolean {
  if (nextRunAt === null) return false;
  return compareTimestamps(now, parseTimestamp(nextRunAt)) < 0;
}

export function decideTaskPump(facts: TaskPumpFacts): TaskPumpDecision {
  const state = parseTaskState(facts.state);
  const revision = parseRevision(facts.revision);
  const ifMatchRevision = parseRevision(facts.ifMatchRevision);

  if (isTerminalState(TASK_TRANSITIONS, state)) return { kind: 'NO_OP', outcome: 'NO_OP_TERMINAL' };
  // `CANCELLING` 是唯一一个「非终态但不可 pump」的状态：`PUMPABLE_TASK_STATES` 就是
  // 按「非终态且不是 CANCELLING」派生的，所以走完这两个分支之后 state 必然可 pump，
  // 不需要再问一次 `isPumpableTaskState`。
  if (state === 'CANCELLING') return { kind: 'NO_OP', outcome: 'NO_OP_CANCELLING' };
  if (compareRevisions(ifMatchRevision, revision) !== 0) return { kind: 'CONFLICT' };
  if (state === 'RETRY_WAIT' && isRetryBackoffActive(facts.nextRunAt, facts.now)) {
    return { kind: 'NO_OP', outcome: 'NO_OP_WAITING' };
  }
  if (facts.drivenByAnother) return { kind: 'COALESCE' };
  return { kind: 'ADVANCE' };
}

/**
 * 判定 → 200 响应里的 `outcome`。`CONFLICT` 返回 `null`：它以 409 结束，没有结果体。
 *
 * 这层映射放在 domain 而不是留给每个调用方，是为了让「四种判定对应五个 outcome」
 * 只有一处写法 —— 少了它，`ADVANCE` 与 `COALESCE` 谁对应哪个字符串就只存在于
 * 某个 use case 的 switch 里，而那种地方是没人会去测的。
 */
export function taskPumpOutcomeOf(decision: TaskPumpDecision): TaskPumpOutcome | null {
  switch (decision.kind) {
    case 'ADVANCE':
      return 'ADVANCED';
    case 'COALESCE':
      return 'COALESCED_IN_FLIGHT';
    case 'NO_OP':
      return decision.outcome;
    case 'CONFLICT':
      return null;
  }
}

/**
 * 判定 → 拒绝用的错误码。只有 `CONFLICT` 会拒绝，且只用 `REVISION_CONFLICT`。
 *
 * **没有 `TASK_NOT_PUMPABLE` 这种码**，也不该有：错误码目录冻结在 42 个
 * （`catalog-code-added` 是破坏性变更），而「不可 pump」的三种情形全是 200 no-op，
 * 本来就不需要错误码。这条函数存在的意义是把「pump 只可能因为一个原因失败」写成
 * 类型上可检查的事实。
 */
export function taskPumpRejectionOf(decision: TaskPumpDecision): 'REVISION_CONFLICT' | null {
  return decision.kind === 'CONFLICT' ? 'REVISION_CONFLICT' : null;
}

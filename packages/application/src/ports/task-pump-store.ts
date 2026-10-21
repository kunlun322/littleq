import type { AiTask, Revision, TaskId, TaskPumpOutcome, Timestamp } from '@littleq/domain';
import type { JournalOperationKey, OperationReceipt, TaskPrivateRecord } from '../task-private.js';
import type { TaskLease } from '../task-lease.js';

/**
 * 装配端口 1／2：`TaskPumpStore` —— **定向**领取与推进权（ZLQ-216 §3.5）。
 *
 * ## 为什么不能直接用 `TaskRepository.claim`
 *
 * §3.5 的第一句就是裁定理由：「现有 `TaskRepository.claim({workerId,now,leaseSeconds,limit})`
 * **没有 taskId**；`limit:1` 仍可能领取另一个学生的任务。`:pump` 不可调用它充当定向
 * 领取。」—— `POST /tasks/{id}:pump` 是**针对某个 task** 的请求，而 `claim` 是队列语义：
 * 它会从 `(next_run_at, id)` 索引里挑出"第一个可领的"，那个 task 完全可能属于别人。
 * 用 `claim` 实现 `:pump`，等于让学生 A 的一次点击去推进学生 B 的任务。
 *
 * 所以本端口的 `acquire` 只锁 `$1` 那一行（`SELECT … WHERE id=$1 FOR UPDATE`），
 * **不查询队列"第一条"**。
 *
 * ## 为什么 `save` / `appendEvent` 也不够
 *
 * §3.5 同段：「现有 `save/appendEvent` 也没有事务/lease 参数；逐个调用全局仓储不等于
 * 同事务。」推进一个有界切片要同时写 task 行、task_private 行、事件行，并且要证明
 * "我还是租约持有者"。三个独立调用之间没有原子性，崩溃在中间就是部分提交。
 * 那部分由 `TaskUnitOfWork.run` 承担（见 `task-unit-of-work.ts`）；本端口只负责
 * **拿到推进权**与**补记回执**。
 *
 * ## 冻结端口签名不动
 *
 * §3.5 逐字：「本期不改这份冻结端口签名，F1 在 application 定义以下两个装配端口，
 * infra 以现有 `DatabaseAdapter.transaction` 实现，F2 只消费它们。」
 * 因此 `TaskRepository` 原样保留，本端口是**新增**的，不是它的替代。
 */

/**
 * `acquire` 的两种模式。
 *
 * 分成两个模式而不是"先领取再取消"，是 §3.5 步骤 3 的要求：「CANCEL 模式的 QUEUED
 * 直接按 domain 取消成 CANCELLED，**不先领取成不可取消的 CLAIMED**」。
 * `CANCELLABLE_TASK_STATES` 是 `QUEUED / RUNNING / CANCELLING` —— `CLAIMED` 不在其中。
 * 走"先 claim 再 cancel"的路线会在中间态把任务变成不可取消的，学生点"停止"反而得到
 * `TASK_NOT_CANCELLABLE`。
 */
export const TASK_PUMP_MODES = ['PUMP', 'CANCEL'] as const;
export type TaskPumpMode = (typeof TASK_PUMP_MODES)[number];

export type TaskAcquireInput = {
  readonly taskId: TaskId;
  readonly expectedRevision: Revision;
  readonly workerId: string;
  /**
   * 租约时长（秒），**正整数** —— 与冻结的 `TaskClaimInput.leaseSeconds` 同一条下界
   * 与同一个理由：非正数会铸出一份当场过期的租约，别人立刻能接管，两个推进器同时
   * 驱动同一个任务。违规抛 `LEASE_TTL_OUT_OF_RANGE`。
   *
   * §3.5 步骤 4：「时长用现有正整数规则与请求预算配置，**不增加 TTL 专项**。」
   */
  readonly leaseSeconds: number;
  readonly mode: TaskPumpMode;
  /**
   * 判据时刻。
   *
   * 这是**对 §3.5 输入清单的一处必要补充**，交付说明里已列明。理由是 domain 的
   * `canClaimTask` / `canReacquireLease` / `isReservationExpired` 全是 `now` 的纯函数
   * （ZLQ-153 附录 A：「所有'现在几点'都是入参」），端口不给 `now` 就无法调用它们。
   * 冻结的 `TaskClaimInput` 同样带 `now`，这里保持一致。
   *
   * `TaskUnitOfWork.run` 是另一回事：§3.5 明令它「开始用 **DB 时钟**核验」，
   * 因为那是 CAS 的时刻，跨实例时钟偏移会直接变成误判。
   */
  readonly now: Timestamp;
};

/**
 * `acquire` 的两种结果。
 *
 * `LEASED` 带 `privateState`：§3.5 逐字「privateState 为 §3.2 的 task_private 完整
 * 记录」。必须在**同一个短事务**里一起读出来 —— 领取之后再单独读一次 private，
 * 读到的可能已经是别人的那一步写下的 checkpoint。
 *
 * `RESULT` 不带 lease：这三种情况本来就没有推进权可发（终态、正在取消、退避未到），
 * 或者推进已经在事务内完成（`RETRY_WAIT` 到期写 `QUEUED`、`CANCEL` 模式直接取消），
 * 本请求**不外呼**。
 */
export type TaskAcquireResult =
  | {
      readonly kind: 'LEASED';
      readonly task: AiTask;
      readonly privateState: TaskPrivateRecord;
      readonly lease: TaskLease;
    }
  | {
      readonly kind: 'RESULT';
      readonly outcome: TaskPumpOutcome;
      readonly task: AiTask;
    };

/**
 * 每一项判据适用的模式。`BOTH` 表示 `PUMP` 与 `CANCEL` 都要过这一关。
 *
 * 这不是装饰：`CANCELLING_NO_OP` 只在 `PUMP` 下成立（`CANCEL` 模式遇到 `CANCELLING`
 * 要走 `RESUME_CANCELLING` 发定向租约恢复停止对账），而 `CANCEL_FROM_*` 三项只在
 * `CANCEL` 下存在。把模式写进同一张表，实现就不可能"顺手"用一份顺序服务两种模式。
 */
export const TASK_ACQUIRE_DECISION_MODES = {
  LIVE_LEASE_COALESCE: 'PUMP',
  TERMINAL_NO_OP: 'BOTH',
  CANCELLING_NO_OP: 'PUMP',
  IF_MATCH_REVISION: 'BOTH',
  BACKOFF_WAITING: 'PUMP',
  RETRY_WAIT_DUE: 'PUMP',
  CLAIM_QUEUED: 'PUMP',
  QUEUED_NOT_DUE_WAITING: 'PUMP',
  REACQUIRE_LEASE: 'PUMP',
  CANCEL_FROM_QUEUED: 'CANCEL',
  CANCEL_FROM_RUNNING: 'CANCEL',
  RESUME_CANCELLING: 'CANCEL',
  REJECT_NOT_CANCELLABLE: 'CANCEL',
} as const satisfies Record<TaskAcquireDecision, 'PUMP' | 'CANCEL' | 'BOTH'>;

/**
 * `acquire` 的**判据顺序**，一级一项，从上到下短路。
 *
 * §7.1 把「`TaskPumpStore.acquire` 的排序判据」列为本单必须自证的一项，所以顺序在这里
 * 是一个**具名常量**，而不是散在实现里的一串 `if`：实现必须按这个数组的顺序判，
 * 测试按同一份数组逐条钉住，两边不可能各自漂移。
 *
 * ## 顺序本身就是契约：两处对 domain `decideTaskPump` 的裁定性偏离
 *
 * **① `LIVE_LEASE_COALESCE` 排在 `IF_MATCH_REVISION` 之前。**
 * §3.5 步骤 1 逐字：「活租约存在时先返回 `COALESCED_IN_FLIGHT`＋当前 task，
 * **即使请求携带旧 revision 也不先报 409**；这是当前 pump 契约的优先级。」
 * 而 domain 的 `decideTaskPump` 恰好相反 —— 它把 `compareRevisions(ifMatch, revision) !== 0`
 * 判在 `facts.drivenByAnother` 之前。两者都不能改：`decideTaskPump` 的行为被既有测试钉死，
 * §3.5 是本期裁定。解法在实现侧：**存在活租约时短路，不把失配的 revision 交给
 * `decideTaskPump`**；domain 的判据只服务"没有活租约"那一支。
 *
 * **② `TERMINAL_NO_OP` 仍排在 `IF_MATCH_REVISION` 之前**（即不跟着 ① 一起前移）。
 * §3.5 的步骤编号把 If-Match 写在步骤 1、终态写在步骤 2，字面上意味着"终态也要先比
 * revision"。本实现**不采**这个字面读法，理由有三条，交付说明里单列请裁定：
 * - 步骤 1 自己给的理由是「这是当前 **pump 契约**的优先级」，而当前 pump 契约
 *   （`decideTaskPump`）恰恰把终态判在 If-Match **之前**：该函数只讨论
 *   coalesce↔If-Match 这一对，没有裁定 terminal↔If-Match。
 * - `decideTaskPump` 的头部把这条写成了可观察缺陷：「一个已经 `SUCCEEDED` 的任务，
 *   客户端手里的 revision 几乎必然是旧的……若先比 `If-Match` 就会回 409，而 409 的
 *   含义是「重新 GET 再试」—— 那条路永远走不到头。先判终态，前端一次就能停下轮询。」
 *   照字面读法实现，就是把这条既有缺陷重新装回去。
 * - 门禁 18 要求「原有状态机/安全/证明测试不删不跳」；`decideTaskPump` 的终态优先级
 *   正属于被钉住的既有语义。
 *
 * **③ `LIVE_LEASE_COALESCE` 只适用于 `PUMP`。** 同一条步骤 1 的落点是「这是当前
 * **pump** 契约的优先级」。若 `CANCEL` 也先 coalesce，那么"另一个 worker 正持有活租约"
 * 就会让 `POST /tasks/{id}:cancel`（§4.1 冻结接口）静默丢掉取消请求：`cancelRequestedAt`
 * 从未落库，持有者也就永远看不到它。§3.5 步骤 3 给 `CANCEL` 的裁定是
 * 「`RUNNING` 进入 `CANCELLING` 后获得**定向**租约」，即接管，不是合并。
 */
export const TASK_ACQUIRE_DECISION_ORDER = [
  /** 步骤 1 前半（PUMP）：有活租约 ⇒ `COALESCED_IN_FLIGHT` + 当前 task，不看 revision。 */
  'LIVE_LEASE_COALESCE',
  /** 步骤 2：终态 ⇒ `NO_OP_TERMINAL`。无副作用、不复活状态机、不改 revision。 */
  'TERMINAL_NO_OP',
  /** 步骤 2（PUMP）：`CANCELLING` ⇒ `NO_OP_CANCELLING`。 */
  'CANCELLING_NO_OP',
  /** 步骤 1 后半：无活租约时才比 If-Match；失配 ⇒ 抛 `REVISION_CONFLICT`（409）。 */
  'IF_MATCH_REVISION',
  /**
   * 步骤 2（PUMP）：`RETRY_WAIT` 且 `now < nextRunAt` ⇒ `NO_OP_WAITING`，**不领取**。
   * 由 `decideTaskPump` 内部的 `isRetryBackoffActive` 给出，不得抹掉退避。
   */
  'BACKOFF_WAITING',
  /** 步骤 2（PUMP）：`RETRY_WAIT` 到期 ⇒ 事务内写 `QUEUED`，返回 `ADVANCED`，不外呼、不发租约。 */
  'RETRY_WAIT_DUE',
  /** 步骤 3（PUMP）：`QUEUED` 且 `canClaimTask` ⇒ `CLAIMED` + 新租约。 */
  'CLAIM_QUEUED',
  /**
   * 步骤 3（PUMP）：`QUEUED` 但 `nextRunAt` 未到 ⇒ `NO_OP_WAITING`。
   *
   * 这一项不在 §3.5 的编号里，是**判据完备性**要求的：`decideTaskPump` 的退避分支只认
   * `RETRY_WAIT`，于是一个 `nextRunAt` 在未来的 `QUEUED` 任务会得到 `ADVANCE`；而
   * `canClaimTask` 对它返回 `false`、`canReacquireLease` 也不认（`QUEUED` 属于
   * `IDLE_TASK_STATES`，不是租约持有态）。少了这一项就会掉到 `REJECT_*` 之外无处可去。
   * 结论取 `NO_OP_WAITING`，依据是 §5.1「`NO_OP_WAITING` 不提前」。
   */
  'QUEUED_NOT_DUE_WAITING',
  /** 步骤 3（PUMP）：其余非终态 ⇒ `canReacquireLease` 接管已释放/过期租约，状态与 attempt 不变。 */
  'REACQUIRE_LEASE',
  /** 步骤 3（CANCEL）：`QUEUED` ⇒ 直接 `CANCELLED`，不先领取成不可取消的 `CLAIMED`。 */
  'CANCEL_FROM_QUEUED',
  /** 步骤 3（CANCEL）：`RUNNING` ⇒ `requestCancel` 进 `CANCELLING` 并发定向租约。 */
  'CANCEL_FROM_RUNNING',
  /** 步骤 3（CANCEL）：`CANCELLING` ⇒ 发定向租约恢复停止对账（§5.2「首版停止仅在 QUEUED/RUNNING/CANCELLING」）。 */
  'RESUME_CANCELLING',
  /** 步骤 3（CANCEL）：其余 ⇒ 抛既有 `TASK_NOT_CANCELLABLE`。 */
  'REJECT_NOT_CANCELLABLE',
] as const;
export type TaskAcquireDecision = (typeof TASK_ACQUIRE_DECISION_ORDER)[number];

/**
 * `recordReceipt` 的入参（§3.5 尾段）。
 *
 * 「外呼必须在这些短事务之外。原意图的回执若返回时已失租约，只能经私有
 * `recordReceipt({taskId,operationKey,requestHash,receipt})` 单独事务补证：
 * 锁定原 journal 项、确认已有 intent 及相同 requestHash，同回执幂等、异回执拒绝；
 * **不修改 task/revision/checkpoint**。新持有者对账后再推进。」
 */
export type RecordReceiptInput = {
  readonly taskId: TaskId;
  readonly operationKey: JournalOperationKey;
  readonly requestHash: string;
  readonly receipt: OperationReceipt;
  readonly now: Timestamp;
};

export interface TaskPumpStore {
  /**
   * 定向取得推进权或给出"没有推进权可做"的结论。
   *
   * 判据顺序见 `TASK_ACQUIRE_DECISION_ORDER`。抛出的错误只用既有 42 码：
   * `REVISION_CONFLICT`（If-Match 失配）、`TASK_NOT_CANCELLABLE`（CANCEL 模式非法态）、
   * `RESOURCE_NOT_FOUND`（taskId 不存在）、`LEASE_TTL_OUT_OF_RANGE`（时长非正整数）。
   */
  acquire(input: TaskAcquireInput): Promise<TaskAcquireResult>;

  /**
   * 失租约后补记回执。**单独事务**，与 task/revision/checkpoint 无关。
   *
   * 幂等：同一 `operationKey` + 同一 `requestHash` + 同一份回执（按
   * `canonicalOperationReceipt` 比较）重复调用不产生第二次写入。
   * 异回执拒绝：抛 `REVISION_CONFLICT`（409）—— 同一个意图上出现两份不同的 provider
   * 回执，意味着"到底发出去的是哪一次"已经不可判定，只能让调用方去对账，
   * 不能让后到的那份悄悄覆盖先到的。
   *
   * journal 里没有这个 `operationKey`、或 intent 仍是 `INTENDED`（从未发出）时同样拒绝：
   * 补记的前提是"当初确实带着这个意图发过"。
   */
  recordReceipt(input: RecordReceiptInput): Promise<void>;
}

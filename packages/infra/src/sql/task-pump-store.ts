import {
  type AiTask,
  type Revision,
  type Timestamp,
  DomainError,
  TASK_TRANSITIONS,
  canClaimTask,
  canReacquireLease,
  compareRevisions,
  isLeaseExpired,
  isRetryBackoffActive,
  isTerminalState,
  requestCancel,
  transitionTask,
} from '@littleq/domain';
import {
  TASK_ACQUIRE_DECISION_MODES,
  TASK_ACQUIRE_DECISION_ORDER,
  canonicalOperationReceipt,
  createTaskPrivateRecord,
  type OperationJournalEntry,
  type RecordReceiptInput,
  type TaskAcquireDecision,
  type TaskAcquireInput,
  type TaskAcquireResult,
  type TaskPumpMode,
  type TaskPumpStore,
} from '@littleq/application';

import { infraError } from '../errors.js';
import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';
import type { TaskLease } from '../ports/task-repository.js';
import type { SqlExecutor } from './executor.js';
import { executorBound, executorOf } from './executor.js';
import { leaseUntilOf, newLeaseToken } from './lease.js';
import { toJsonb } from './rows.js';
import { TASK_PRIVATE_UPDATE_JOURNAL_SQL, lockPrivateState } from './task-private-rows.js';
import { type LockedTask, casTaskEntity, lockTask, setTaskLease } from './task-rows.js';

/**
 * 装配端口 `TaskPumpStore` 的生产 Postgres 驱动（ZLQ-216 §3.5、ZLQ-220 §4 条 4）。
 *
 * ## `acquire` 的形状：一次短事务 + 一遍判据表
 *
 * §3.5 逐字：「用短事务 `SELECT … WHERE id=$1 FOR UPDATE` 锁 task 与 task_private，
 * **不查询队列"第一条"**……**不能**先解锁再 UPDATE。」本实现照字面做：`lockTask` 锁
 * `ai_tasks` 那一行，`lockPrivateState` 锁 `task_private` 那一行，两者都在
 * `this.#execute` 打开的同一个事务里；判据全部走 `TASK_ACQUIRE_DECISION_ORDER`，
 * 写入也在同一事务内提交。
 *
 * 锁顺序固定为「先 task 后 private」，与 `createTurn` 的 INSERT 顺序一致（见 `lockTask`
 * 的注释）：反过来的两个事务会死锁，而 Postgres 的死锁处置是随机挑一个牺牲品回滚，
 * 表现出来就是一次查不出原因的 `REVISION_CONFLICT`。
 *
 * ## 判据一律不在 SQL 里重写
 *
 * `WHERE` 只出现在 `id = $1`。"能不能领取""能不能接管""退避到没到"全部由 domain 的
 * `canClaimTask` / `canReacquireLease` / `isRetryBackoffActive` 回答。理由与
 * `PostgresTaskRepository` 逐字相同：把判据在 SQL 里再实现一遍，两份就会漂移，而漂移的
 * 方向确定是"SQL 那份少一个条件"，代价是两个推进器同时驱动同一个任务。
 *
 * ## 三处裁定性偏离与两处补充
 *
 * 全部记录在端口的 `TASK_ACQUIRE_DECISION_ORDER` 注释里（① 活租约先于 If-Match、
 * ② 终态仍在 If-Match 之前、③ coalesce 只适用于 PUMP），本驱动只负责**照那份数组的
 * 顺序判**。这里额外申报两处只存在于实现侧的选择：
 *
 * 1. **活租约的判据不含 owner 比较。** `decideTaskPump` 的 `drivenByAnother` 字面是
 *    "**别的**执行者持有未过期租约"，本实现在 `lease_owner === input.workerId` 时**同样**
 *    返回 `COALESCED_IN_FLIGHT`。理由：`acquire` 是一次新的 HTTP 请求触发的，持有租约的
 *    那一次 `run()` 是**另一个在飞的事务**，即使 workerId 字符串相同也不是同一次推进；
 *    真正合法的持有者不需要再 `acquire`，它手里已经有 `TaskLease`；而"同一个 worker 崩了
 *    又重试"恰恰是租约到期 + `REACQUIRE_LEASE` 存在的意义 —— 在 TTL 内抢先接管只会让
 *    两次推进重叠。
 * 2. **CANCEL 模式下真正改了状态的两种情形都返回 `ADVANCED`。** `TaskPumpOutcome` 的
 *    五个取值里没有取消专用的那一个（错误码目录与 outcome 集合都是冻结的，新增是破坏性
 *    变更），而 `CANCEL_FROM_QUEUED` / `CANCEL_FROM_RUNNING` 确实推进了状态机 —— 按
 *    `taskPumpOutcomeOf` 的既有映射，"推进了"就是 `ADVANCED`。取消**是否被接受**由
 *    重新 GET 到的 `state` / `cancelRequestedAt` 表达，不由 outcome 表达。
 */
export class PostgresTaskPumpStore implements TaskPumpStore {
  readonly #execute: SqlExecutor;
  #leaseSerial = 0;

  private constructor(execute: SqlExecutor) {
    this.#execute = execute;
  }

  /** 独立语境：每次调用自己开一个短事务。`:pump` / `:cancel` 走这一条。 */
  static of(db: DatabaseAdapter): PostgresTaskPumpStore {
    return new PostgresTaskPumpStore(executorOf(db));
  }

  /**
   * 绑定语境：复用调用方的事务。
   *
   * `TaskUnitOfWork.run` 的回调里若要补记回执，必须用这一条 —— §3.5 要求事务内的句柄
   * 「全部绑定**同一个** `DatabaseTransaction`」。
   */
  static bound(tx: DatabaseTransaction): PostgresTaskPumpStore {
    return new PostgresTaskPumpStore(executorBound(tx));
  }

  async acquire(input: TaskAcquireInput): Promise<TaskAcquireResult> {
    // 时长先验，验完才开事务：一次被拒的领取不该在库里留下任何痕迹。这与
    // `PostgresTaskRepository` 那处已申报的收紧是同一条（冻结端口原文说的是输入而不是
    // 队列内容），两个驱动必须一致，否则同一份非法 `leaseSeconds` 在两条路上结果不同。
    const leaseUntil = leaseUntilOf(input.now, input.leaseSeconds);

    return this.#execute(async (tx) => {
      const locked = await lockTask(tx, input.taskId);
      // 端口列的四个错误码里，"taskId 不存在"就是 `RESOURCE_NOT_FOUND`；§4.1 要求它
      // **不含对象细节**，所以这里不透出"行存在但不属于你"这类区分。
      if (locked === null) throw infraError('TASK_NOT_FOUND');

      for (const decision of TASK_ACQUIRE_DECISION_ORDER) {
        if (!appliesTo(decision, input.mode)) continue;
        const result = await this.#step(tx, decision, { locked, leaseUntil, input });
        if (result !== null) return result;
      }
      // 走完整张表还没有结论，只可能是端口新增了一项判据而本实现没跟上（编译期由
      // `#step` 末尾的 `never` 守卫拦住），或者 13 项对 15 个状态的覆盖证明失效了
      // （`test/task-pump-store-transaction.test.ts` 逐状态钉住）。两种都不是"输掉一次
      // 竞争"，重试不会变好，所以是不可重试的内部错误而不是 409。
      throw infraError('STORED_ROW_INCONSISTENT');
    });
  }

  async recordReceipt(input: RecordReceiptInput): Promise<void> {
    await this.#execute(async (tx) => {
      const record = await lockPrivateState(tx, input.taskId);
      const entry = record.operationJournal.find((item) => item.operationKey === input.operationKey);

      // 端口原文把四种拒绝并列（异回执、journal 里没有这个 key、intent 仍是 INTENDED、
      // 以及"确认相同 requestHash"失败），并且只给了一个对外形态：`REVISION_CONFLICT`。
      // 于是这里刻意**不**为它们各开一个码 —— 分开的话，调用方就能用错误码差异枚举
      // "这个 operationKey 到底存不存在"，而 operationKey 里含 taskId。
      if (entry === undefined) throw receiptConflict();
      if (entry.intent === 'INTENDED') throw receiptConflict();
      if (entry.requestHash !== input.requestHash) throw receiptConflict();

      if (entry.intent === 'RECEIPT_RECORDED') {
        // 幂等：同 key + 同 hash + 同回执（按 `canonicalOperationReceipt` 规范化比较，
        // 所以键序不影响判定）⇒ **一次写入都不做**。不写也就不会把 `recordedAt` 推后，
        // 于是重复补记在库里完全无痕。
        const already = canonicalOperationReceipt(entry.receipt ?? {});
        if (already === canonicalOperationReceipt(input.receipt)) return;
        throw receiptConflict();
      }

      const journal: readonly OperationJournalEntry[] = record.operationJournal.map((item) =>
        item.operationKey === input.operationKey
          ? {
              ...item,
              intent: 'RECEIPT_RECORDED',
              receipt: input.receipt,
              // ⚠️ 已申报的解释：`RecordReceiptInput.now` 只可能落在这里，而 `recordedAt`
              // 与两个可变字段（`intent` / `receipt`）并列，读作"当前这份内容是什么时候
              // 记下的"。§3.5 要求的是「保留已有**不可变**回执」—— 回执从这一刻起不可变
              // （重复调用在上面就短路了），原来的 intent 时刻不属于回执。
              recordedAt: input.now,
            }
          : item,
      );
      // 过一遍构造器：journal 项的 `operationKey` 唯一性与 `recordedAt` 可解析性由它判定，
      // 而写进 jsonb 的东西必须是构造器认可的形状，否则这一行读回来时 `taskPrivateFromRow`
      // 会抛，整行就成了永远读不出来的毒行。
      const merged = createTaskPrivateRecord({ ...record, operationJournal: journal });

      // **只**写 journal 一列：§3.5 逐字「不修改 task/revision/checkpoint」。用整行
      // UPDATE 也能达到同样效果（其余字段原样写回），但那条保证就得靠论证；用只碰一列的
      // 语句，`scan_checkpoint` / `internal_subphase` / `collection_cursor` 根本不在语句里。
      const written = await tx.execute(TASK_PRIVATE_UPDATE_JOURNAL_SQL, [
        input.taskId,
        toJsonb(merged.operationJournal),
      ]);
      // 行是刚刚 `FOR UPDATE` 锁住的，影响行数不可能是 0。真的是 0 只有一种解释：有东西
      // 绕过行锁删了/改了库。
      if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
    });
  }

  /**
   * 判据表的一项。返回 `null` 表示"这一项不适用，继续往下判"。
   *
   * 写成 `switch` 而不是十三段 `if`，是为了让端口那份数组与这里的分支**同名**：
   * 测试可以按 `TASK_ACQUIRE_DECISION_ORDER` 逐条钉，实现这边一条不多一条不少。
   */
  async #step(
    tx: DatabaseTransaction,
    decision: TaskAcquireDecision,
    context: {
      readonly locked: LockedTask;
      readonly leaseUntil: Timestamp;
      readonly input: TaskAcquireInput;
    },
  ): Promise<TaskAcquireResult | null> {
    const { locked, leaseUntil, input } = context;
    const { task, lease } = locked;

    switch (decision) {
      case 'LIVE_LEASE_COALESCE':
        // §3.5 步骤 1：「活租约存在时先返回 `COALESCED_IN_FLIGHT`＋当前 task，
        // **即使请求携带旧 revision 也不先报 409**。」所以这一项排在 `IF_MATCH_REVISION`
        // 之前，而且返回的 task 是**行上那一个**，不是入参声称的 revision。
        return lease !== null && !isLeaseExpired(lease.leaseUntil, input.now)
          ? { kind: 'RESULT', outcome: 'COALESCED_IN_FLIGHT', task }
          : null;

      case 'TERMINAL_NO_OP':
        // 无副作用、不复活状态机、不改 revision —— 终态没有出边，`transitionTask` 在这里
        // 一定抛，所以这一项只能是纯读。
        return isTerminalState(TASK_TRANSITIONS, task.state)
          ? { kind: 'RESULT', outcome: 'NO_OP_TERMINAL', task }
          : null;

      case 'CANCELLING_NO_OP':
        return task.state === 'CANCELLING'
          ? { kind: 'RESULT', outcome: 'NO_OP_CANCELLING', task }
          : null;

      case 'IF_MATCH_REVISION':
        // 走到这里说明没有活租约，于是 If-Match 才轮到判。失配抛 409：客户端**必须**
        // 重新 GET 才能继续，用 200 回答会把这条义务藏起来。
        if (compareRevisions(input.expectedRevision, task.revision) !== 0) {
          throw new DomainError('REVISION_CONFLICT', 'AiTask.revision');
        }
        return null;

      case 'BACKOFF_WAITING':
        // `isRetryBackoffActive` 把 `nextRunAt === null` 判成"不等待"，与 `isLeaseExpired`
        // 把 `null` 判成"没有租约"是同一种保守方向：缺失的字段不该被解释成无限期阻塞。
        return task.state === 'RETRY_WAIT' && isRetryBackoffActive(task.nextRunAt, input.now)
          ? { kind: 'RESULT', outcome: 'NO_OP_WAITING', task }
          : null;

      case 'RETRY_WAIT_DUE': {
        if (task.state !== 'RETRY_WAIT') return null;
        // 退避已到 ⇒ 事务内写 `QUEUED`，返回 `ADVANCED`，**不外呼、不发租约**：这一步的
        // 产物是"下一次 pump 可以领取它"，领取是另一次请求的事。
        const requeued = transitionTask(task, 'QUEUED', input.now, 'REVISION_CONFLICT');
        await casTaskEntity(tx, requeued, task.revision);
        // 交出租约。留着一个未过期的 `lease_until` 会让下一次 PUMP 直接撞上
        // `LIVE_LEASE_COALESCE` —— 一个没人驱动的任务被"合并"到一次不存在的在飞推进上，
        // 直到 TTL 自然耗尽。与 `requeueOnLeaseExpiry` 同一条处置。
        await setTaskLease(tx, requeued.id, null, null, null);
        return { kind: 'RESULT', outcome: 'ADVANCED', task: requeued };
      }

      case 'CLAIM_QUEUED': {
        // SQL 没有替本项做过滤（`WHERE` 只有 `id = $1`），所以 `canClaimTask` 是唯一判据。
        if (!canClaimTask(task.state, task.nextRunAt, input.now)) return null;
        const claimed = transitionTask(task, 'CLAIMED', input.now, 'REVISION_CONFLICT');
        return await this.#leaseOut(tx, claimed, task.revision, input.workerId, leaseUntil);
      }

      case 'QUEUED_NOT_DUE_WAITING':
        // 走到这里 state 仍是 `QUEUED` 的唯一可能是 `nextRunAt` 在未来（`canClaimTask`
        // 因此返回 false）。判据完备性要求这一项存在，否则 `QUEUED` 会一路掉到
        // `REACQUIRE_LEASE`，而 `canReacquireLease` 不认 `QUEUED`（它属于 IDLE 态）。
        return task.state === 'QUEUED' ? { kind: 'RESULT', outcome: 'NO_OP_WAITING', task } : null;

      case 'REACQUIRE_LEASE': {
        // 其余非终态：接管已释放/已过期的租约，**状态与 attempt 都不变**。
        // `lease?.leaseUntil ?? null`：三列租约全 NULL 时 `leaseFromRow` 给 null，而
        // `canReacquireLease` 把"没有租约"判成"已过期" —— 于是 `RUNNING` 却没有持有者的
        // 孤儿行照样能被接管，这正是 §3.5 步骤 3 要的。
        if (!canReacquireLease(task.state, lease?.leaseUntil ?? null, input.now)) return null;
        return await this.#leaseOut(tx, task, task.revision, input.workerId, leaseUntil);
      }

      case 'CANCEL_FROM_QUEUED': {
        if (task.state !== 'QUEUED') return null;
        // 两步而不是一步：`assertTaskCoherent` 要求 `state === 'CANCELLED'` 时
        // `cancelRequestedAt !== null`，而 `transitionTask` 不写那个字段。先 `requestCancel`
        // 落下取消时刻（revision +1），再迁移到终态（revision +1），最后一次 CAS 落库。
        // §3.5 步骤 3 逐字：「**不先领取成不可取消的 CLAIMED**」—— `CLAIMED` 不在
        // `CANCELLABLE_TASK_STATES` 里，绕道领取会让学生点"停止"得到 409。
        const cancelled = transitionTask(
          requestCancel(task, input.now),
          'CANCELLED',
          input.now,
          'TASK_NOT_CANCELLABLE',
        );
        await casTaskEntity(tx, cancelled, task.revision);
        await setTaskLease(tx, cancelled.id, null, null, null);
        return { kind: 'RESULT', outcome: 'ADVANCED', task: cancelled };
      }

      case 'CANCEL_FROM_RUNNING': {
        if (task.state !== 'RUNNING') return null;
        // §3.5 步骤 3：「`RUNNING` 进入 `CANCELLING` 后获得**定向**租约。」即接管，不是
        // 合并 —— 否则另一个 worker 的活租约会让取消请求静默丢掉，`cancelRequestedAt`
        // 从未落库，持有者也就永远看不到它。
        const cancelling = transitionTask(
          requestCancel(task, input.now),
          'CANCELLING',
          input.now,
          'TASK_NOT_CANCELLABLE',
        );
        return await this.#leaseOut(tx, cancelling, task.revision, input.workerId, leaseUntil);
      }

      case 'RESUME_CANCELLING':
        // 已在取消中：不改状态（`CANCELLING → CANCELLING` 不是迁移表里的边），只发一份
        // 定向租约让接管者把停止对账做完。取消请求本身是幂等的，`cancelRequestedAt`
        // 保留最早那一个（`requestCancel` 的语义），所以这里不必再调它。
        if (task.state !== 'CANCELLING') return null;
        return await this.#leaseOut(tx, task, task.revision, input.workerId, leaseUntil);

      case 'REJECT_NOT_CANCELLABLE':
        // `CLAIMED` / `SESSION_CREATING` / `RETRY_WAIT` / `COLLECTING` …… 落在这里。
        // 用 domain 既有的那一个码与既有的那一个 valueObject 名，与
        // `assertCancellableTaskState` 逐字相同 —— 两处必须给出同一个对外形态，
        // 否则同一个"不能取消"在 `:cancel` 与在别处会是两个错误。
        throw new DomainError('TASK_NOT_CANCELLABLE', 'TaskState');
    }

    return unreachableDecision(decision);
  }

  /**
   * 铸一份定向租约并落库，同时读出 `privateState`。
   *
   * `privateState` 必须在**同一个短事务**里读（§3.5：「privateState 为 §3.2 的
   * task_private 完整记录」）：领取之后再单独读一次，读到的可能已经是别人的那一步写下
   * 的 checkpoint。
   *
   * `lease.revision` 取**将要落库的那个** revision（`task.revision`，即已推进过的），
   * 而 `expectedRevision` 是行上读出来的旧值 —— 两者相差的正是本次推进的格数。
   * 与冻结的 `TaskRepository.claim` 同调（它返回的也是 `claimed.revision`）。
   */
  async #leaseOut(
    tx: DatabaseTransaction,
    task: AiTask,
    expectedRevision: Revision,
    workerId: string,
    leaseUntil: Timestamp,
  ): Promise<TaskAcquireResult> {
    const privateState = await lockPrivateState(tx, task.id);
    const lease: TaskLease = {
      taskId: task.id,
      leaseToken: this.#nextLeaseToken(),
      leaseUntil,
      revision: task.revision,
    };
    await casTaskEntity(tx, task, expectedRevision);
    await setTaskLease(tx, task.id, workerId, lease.leaseToken, leaseUntil);
    return { kind: 'LEASED', task, privateState, lease };
  }

  /**
   * 令牌序号。**只是诊断用的进程内计数**，不是任何判定的事实源（§6.5 规则 5）：
   * 所有权凭据是它后面那 8 字节随机数，两个进程各自从 1 开始数也不会撞令牌。
   */
  #nextLeaseToken() {
    this.#leaseSerial += 1;
    return newLeaseToken(this.#leaseSerial);
  }
}

/** 这一项判据在 `input.mode` 下是否成立。模式表与顺序表并列，所以两者不可能各自漂移。 */
function appliesTo(decision: TaskAcquireDecision, mode: TaskPumpMode): boolean {
  const allowed = TASK_ACQUIRE_DECISION_MODES[decision];
  return allowed === 'BOTH' || allowed === mode;
}

/**
 * 判据表完备性的**编译期**守卫。
 *
 * `#step` 的 switch 覆盖了 `TaskAcquireDecision` 的全部 13 个成员，所以调用点上这个实参
 * 的类型只能是 `never`：端口将来加了第 14 项而这里没跟上，`pnpm typecheck`（门 1）当场
 * 就红，不会退化成一次运行时的 `STORED_ROW_INCONSISTENT`。参数名带 `_` 前缀是
 * `eslint.config.mjs` 里 `argsIgnorePattern: '^_'` 的用法 —— 它的唯一职责是出现在
 * **签名**里，运行期到不了这里。
 */
function unreachableDecision(_decision: never): TaskAcquireResult {
  throw infraError('STORED_ROW_INCONSISTENT');
}

/** `recordReceipt` 的唯一对外形态：409 `REVISION_CONFLICT`。 */
function receiptConflict(): DomainError {
  return new DomainError('REVISION_CONFLICT', 'OperationJournalEntry.receipt');
}

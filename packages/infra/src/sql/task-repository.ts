import {
  type AiTask,
  type Revision,
  type TaskEvent,
  type TaskId,
  type Timestamp,
  assertEventFollows,
  canClaimTask,
  canReacquireLease,
  canRenewLease,
  canRequeueOnLeaseExpiry,
  compareRevisions,
  createAiTask,
  nextRevision,
  transitionTask,
} from '@littleq/domain';

import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';
import type { TaskClaimInput, TaskLease, TaskRepository } from '../ports/task-repository.js';
import type { SqlExecutor } from './executor.js';
import { executorBound, executorOf } from './executor.js';
import { leaseUntilOf, newLeaseToken } from './lease.js';
import { toTimestamptz } from './rows.js';
import {
  type AiTaskRow,
  type TaskEventRow,
  AI_TASK_ENTITY_CAS_SQL,
  AI_TASK_LEASE_CLEAR_SQL,
  AI_TASK_SELECT_BY_ID_SQL,
  AI_TASK_SELECT_DUE_FOR_CLAIM_SQL,
  TASK_EVENT_INSERT_SQL,
  TASK_EVENT_LAST_SQL,
  casTaskEntity,
  lockTask,
  setTaskLease,
  taskEntityCasParams,
  taskEventFromRow,
  taskEventInsertParams,
  taskFromRow,
} from './task-rows.js';

/**
 * 冻结端口 `TaskRepository` 的生产 Postgres 驱动（ZLQ-220 §4 条 1、ZLQ-216 §3.1／§3.5）。
 *
 * ## 为什么是「`SELECT … FOR UPDATE` → domain 谓词 → `UPDATE`」，而不是一条条件 UPDATE
 *
 * 端口头注释里那句警告是真的：「一个『先 SELECT 再 UPDATE』的实现就算调对了判据，也照样会
 * 在两个 worker 之间双领。」但它警告的是**无锁**的先读后写。这里两步在同一个事务里，而且
 * 第一步就 `FOR UPDATE` 把行锁住 —— 锁在提交前不释放，所以第二个 worker 的 `SELECT`
 * 要么阻塞要么（`claim` 里用 `SKIP LOCKED`）直接跳过这一行。原子性由锁提供，不由"语句
 * 条数"提供。
 *
 * 明明可以写成一条 `UPDATE … WHERE lease_token = $1 AND lease_until > $2 AND state = ANY($3)`，
 * 为什么不用？因为那要把 `canRenewLease` 在 SQL 里**再实现一遍**。两份判据漂移的方向是
 * 确定的：SQL 那份少一个条件，于是生产比内存替身宽松，而宽松的代价是两个推进器同时驱动
 * 同一个任务。判据留在 domain 就只有一份。
 *
 * 第二个理由来自 §3.1：「独立列从验证后的实体派生，仓储读取时**检查一致性**」。条件 UPDATE
 * 判的是 `state` **列**，而权威值是 `payload`。走 `taskFromRow` 才会跑 `assertColumnMatches`
 * —— 一个列与 payload 分叉的行在这里**抛** `STORED_ROW_INCONSISTENT`，在条件 UPDATE 里则被
 * 静默地按列判掉。
 *
 * 代价是一次额外的往返和一个短命的单行锁。这五个方法全是单行操作，锁在事务提交时释放。
 *
 * ## 与内存替身 `InMemoryTaskRepository` 的两处**已申报**差异
 *
 * 两处都是**收紧**，不是放宽（ZLQ-220 §8 只禁止放宽）：
 *
 * 1. `leaseSeconds < 1` 在**开事务之前**就抛 `LEASE_TTL_OUT_OF_RANGE`。替身是在铸造租约那一刻
 *    抛的，所以队列里一个可领任务都没有时它返回 `[]` 而不抛 —— 同一个非法输入的结果取决于
 *    队列内容。冻结端口的原文是「`leaseSeconds` **必须是正整数**……违规抛」，说的是输入而不是
 *    队列，所以这里让它与队列无关。
 * 2. `save` 一个**不存在**的 task 返回 `null`。替身的 `save` 兼作插入（`?? input.task` 那条
 *    基线），本驱动不做。理由是签名装不下：`§3.2` 的 `ai_tasks` 有一列 `accepted_project_revision`
 *    —— §3.5 `createTurn` 受理那一刻的项目版本证据 —— 而 `save({task, expectedRevision})`
 *    没有地方放它。让 `save` 兼作插入就只能写 NULL，于是一条 `save` 能凭空造出一个**没有受理
 *    证据**的 task 行。task 的唯一合法创建者是 `createTurn`。
 *
 * ## 不重新验证入参实体
 *
 * `save` / `appendEvent` 收到的已经是 `AiTask` / `TaskEvent`（构造期跑完全部不变量的类型），
 * 这里不在持久化边界上再跑一遍 `createAiTask`：那会让 `save` 在替身返回值的地方抛
 * `DomainError`，是一处**行为**分叉而不只是收紧。§3.1 要求的一致性检查放在**读**方向
 * （`taskFromRow`），写方向的保证来自"所有写入都走 domain 构造器"这条调用链约定。
 */
export class PostgresTaskRepository implements TaskRepository {
  readonly #execute: SqlExecutor;
  #leaseSerial = 0;

  private constructor(execute: SqlExecutor) {
    this.#execute = execute;
  }

  /** 独立语境：每次调用自己开一个短事务。 */
  static of(db: DatabaseAdapter): PostgresTaskRepository {
    return new PostgresTaskRepository(executorOf(db));
  }

  /**
   * 绑定语境：复用调用方的事务。
   *
   * §3.5 要求 `TaskUnitOfWork.run` 事务内的句柄「全部绑定**同一个** `DatabaseTransaction`」，
   * 本工厂就是那条要求的落点 —— 绑定之后 `FOR UPDATE` 的锁一直握到外层事务结束，
   * 中途任何一次 CAS 失败都能整体回滚。
   */
  static bound(tx: DatabaseTransaction): PostgresTaskRepository {
    return new PostgresTaskRepository(executorBound(tx));
  }

  async claim(input: TaskClaimInput): Promise<readonly TaskLease[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) return [];
    // 时长先验，验完才开事务：一次被拒的领取不该在库里留下任何痕迹（差异 1）。
    const leaseUntil = leaseUntilOf(input.now, input.leaseSeconds);

    return this.#execute(async (tx) => {
      const rows = await tx.query<AiTaskRow>(AI_TASK_SELECT_DUE_FOR_CLAIM_SQL, [
        toTimestamptz(input.now),
        input.limit,
      ]);

      const leases: TaskLease[] = [];
      for (const row of rows) {
        const task = taskFromRow(row);
        // SQL 的 `WHERE` 是**过滤器**，domain 的 `canClaimTask` 才是**判定**。
        // 两者对同一件事各写一遍不是冗余：过滤器可以因为一次 SQL 改写而变宽，
        // 而这一行让变宽的过滤器领不到东西。
        if (!canClaimTask(task.state, task.nextRunAt, input.now)) continue;

        // `canClaimTask` 内部已经问过迁移表，所以这里的 code 参数走不到。选
        // `REVISION_CONFLICT` 与替身同调：「领不到」按定义就是一次输掉的竞争，对外正是 409。
        const claimed = transitionTask(task, 'CLAIMED', input.now, 'REVISION_CONFLICT');
        const lease: TaskLease = {
          taskId: claimed.id,
          leaseToken: this.#nextLeaseToken(),
          leaseUntil,
          revision: claimed.revision,
        };

        await casTaskEntity(tx, claimed, task.revision);
        await setTaskLease(tx, claimed.id, input.workerId, lease.leaseToken, leaseUntil);
        leases.push(lease);
      }
      return leases;
    });
  }

  async renewLease(input: {
    readonly lease: TaskLease;
    readonly now: Timestamp;
    readonly leaseSeconds: number;
  }): Promise<TaskLease | null> {
    const leaseUntil = leaseUntilOf(input.now, input.leaseSeconds);

    return this.#execute(async (tx) => {
      const locked = await lockTask(tx, input.lease.taskId);
      if (locked === null) return null;
      // 令牌是唯一凭据：被接管过的租约令牌已经换了，旧 worker 在这里拿到 `null`，
      // 而不是把别人的租约又延长一段。刻意**不**比较 `revision` —— 续租不该因为任务
      // 在租约期内被推进过而失败。
      if (locked.lease === null || locked.lease.leaseToken !== input.lease.leaseToken) return null;
      if (!canRenewLease(locked.task.state, locked.lease.leaseUntil, input.now)) return null;

      const renewed: TaskLease = { ...locked.lease, leaseUntil };
      // owner 从行上取而不是从入参取：`TaskLease` 不带 workerId，而令牌既然匹配，
      // 行上的 owner 就一定是本 worker。
      await setTaskLease(tx, renewed.taskId, locked.owner, renewed.leaseToken, leaseUntil);
      return renewed;
    });
  }

  async reacquireLease(input: {
    readonly taskId: TaskId;
    readonly workerId: string;
    readonly now: Timestamp;
    readonly leaseSeconds: number;
  }): Promise<TaskLease | null> {
    const leaseUntil = leaseUntilOf(input.now, input.leaseSeconds);

    return this.#execute(async (tx) => {
      const locked = await lockTask(tx, input.taskId);
      if (locked === null) return null;
      // 没有租约行（三列全 NULL）时 `leaseFromRow` 给 null，而 `canReacquireLease` 把
      // "没有租约"判成"已过期" —— 于是 `RUNNING` 却没有持有者的孤儿行照样能被接管。
      if (!canReacquireLease(locked.task.state, locked.lease?.leaseUntil ?? null, input.now)) {
        return null;
      }

      // 状态**不变**，只换持有人：`RUNNING` 崩掉时 QCA Session 还活着，接管者要接着推进，
      // 从头再来一遍就是重复计费。
      const lease: TaskLease = {
        taskId: locked.task.id,
        leaseToken: this.#nextLeaseToken(),
        leaseUntil,
        revision: locked.task.revision,
      };
      await setTaskLease(tx, lease.taskId, input.workerId, lease.leaseToken, leaseUntil);
      return lease;
    });
  }

  async requeueOnLeaseExpiry(input: {
    readonly taskId: TaskId;
    readonly now: Timestamp;
  }): Promise<boolean> {
    return this.#execute(async (tx) => {
      const locked = await lockTask(tx, input.taskId);
      if (locked === null) return false;
      if (
        !canRequeueOnLeaseExpiry(locked.task.state, locked.lease?.leaseUntil ?? null, input.now)
      ) {
        return false;
      }

      const requeued = transitionTask(locked.task, 'QUEUED', input.now, 'REVISION_CONFLICT');
      await casTaskEntity(tx, requeued, locked.task.revision);
      // 退回 `QUEUED` 就必须交出租约：留着 lease_until 会让 `claim` 之后立刻又被
      // `canReacquireLease` 判成孤儿。三列一起置 NULL（owner 也清，不留一个指向
      // 已放弃任务的 worker 名）。
      await setTaskLease(tx, requeued.id, null, null, null);
      return true;
    });
  }

  async releaseLease(input: { readonly lease: TaskLease; readonly now: Timestamp }): Promise<void> {
    await this.#execute(async (tx) => {
      // 影响行数刻意**不看**：端口返回 void，而"没匹配上"正是期望行为之一 ——
      // `AI_TASK_LEASE_CLEAR_SQL` 带 `AND lease_token = $2`，一个已经失租约的旧持有者
      // 来收尾时影响 0 行，新持有者的推进权原封不动。
      await tx.execute(AI_TASK_LEASE_CLEAR_SQL, [input.lease.taskId, input.lease.leaseToken]);
    });
  }

  async save(input: {
    readonly task: AiTask;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null> {
    return this.#execute(async (tx) => {
      // 影响行数就是 CAS 的判决：1 = 改到了，0 = 版本不匹配**或行不存在**，两者都是
      // `null`（差异 2）。不抛 —— revision 冲突是正常运行时事件，两个 worker 抢同一个
      // 任务时它每次都会发生。
      const written = await tx.execute(
        AI_TASK_ENTITY_CAS_SQL,
        taskEntityCasParams(input.task, input.expectedRevision),
      );
      return written === 1 ? input.task : null;
    });
  }

  async appendEvent(input: {
    readonly event: TaskEvent;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null> {
    return this.#execute(async (tx) => {
      const locked = await lockTask(tx, input.event.taskId);
      if (locked === null) return null;
      if (compareRevisions(locked.task.revision, input.expectedRevision) !== 0) return null;

      const lastRows = await tx.query<TaskEventRow>(TASK_EVENT_LAST_SQL, [input.event.taskId]);
      const [lastRow] = lastRows;
      const last = lastRow === undefined ? null : taskEventFromRow(lastRow);
      // 序列约束由 domain 判定，违规时抛的是 `DomainError`：那是业务规则失败，与
      // 「版本冲突」不是一回事，所以这里刻意不翻译它（与替身同调）。
      assertEventFollows(input.event, last);
      await tx.execute(TASK_EVENT_INSERT_SQL, taskEventInsertParams(input.event));

      const bumped = withNextRevision(locked.task);
      await casTaskEntity(tx, bumped, locked.task.revision);
      return bumped;
    });
  }

  async scheduleNextRun(input: {
    readonly taskId: TaskId;
    readonly nextRunAt: Timestamp;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null> {
    return this.#execute(async (tx) => {
      const locked = await lockTask(tx, input.taskId);
      if (locked === null) return null;
      if (compareRevisions(locked.task.revision, input.expectedRevision) !== 0) return null;

      // 只写 `next_run_at` 与 revision，不走 `transitionTask`：`RETRY_WAIT → QUEUED` 那条边
      // 由调用方（`:pump` 的重试策略）负责迁移，本方法是它落库 `next_run_at` 的那一步。
      const scheduled = createAiTask({
        ...locked.task,
        nextRunAt: input.nextRunAt,
        revision: nextRevision(locked.task.revision),
      } as Parameters<typeof createAiTask>[0]);
      await casTaskEntity(tx, scheduled, locked.task.revision);
      return scheduled;
    });
  }

  async findById(taskId: TaskId): Promise<AiTask | null> {
    return this.#execute(async (tx) => {
      const rows = await tx.query<AiTaskRow>(AI_TASK_SELECT_BY_ID_SQL, [taskId]);
      const [row] = rows;
      return row === undefined ? null : taskFromRow(row);
    });
  }

  /**
   * 令牌序号。**只是诊断用的进程内计数**，不是任何判定的事实源（§6.5 规则 5：不用进程内
   * 信号量/Map 当事实源）：所有权凭据是它后面那 8 字节随机数，两个进程各自从 1 开始数也
   * 不会撞令牌。
   */
  #nextLeaseToken() {
    this.#leaseSerial += 1;
    return newLeaseToken(this.#leaseSerial);
  }
}

/**
 * 只推进 revision 的实体副本（`appendEvent` 用它）。
 *
 * 走 `createAiTask` 而不是对象展开：写进 `payload` 的东西必须是构造器认可的实体，
 * 否则读回来时 `taskFromRow` 会抛，那一行就成了永远读不出来的毒行。
 */
function withNextRevision(task: AiTask): AiTask {
  return createAiTask({
    ...task,
    revision: nextRevision(task.revision),
  } as Parameters<typeof createAiTask>[0]);
}

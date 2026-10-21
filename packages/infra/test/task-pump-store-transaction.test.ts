/**
 * `PostgresTaskPumpStore` 的**事务形状**与**判据完备性**（ZLQ-220 §4 条 4、§3.5、§11.2）。
 *
 * ## 这个文件名不是我起的
 * `src/sql/task-pump-store.ts:121-125` 那段注释逐字写着：走完整张判据表还没有结论，只可能是
 * 「13 项对 15 个状态的覆盖证明失效了（`test/task-pump-store-transaction.test.ts` 逐状态钉住）」。
 * 也就是说，那句 `throw infraError('STORED_ROW_INCONSISTENT')` 之所以敢写成**不可重试的内部
 * 错误**而不是一次 409，唯一的依据就是本文件真的把 15 个状态逐个走过了。删掉本文件，那段注释
 * 就变成一句没兑现的承诺，而 `:125` 退化成一条谁也走不到、于是谁也验不了的死码。
 *
 * ## 与 `packages/application/test/acquire-order.test.ts` 的分工
 * 那份钉的是**端口**：13 项判据的名字、顺序、模式归属，以及三处裁定性偏离。它一句都没提到
 * Postgres。本文件钉的是**驱动**，四件事，一件都不与它重叠：
 *
 * 1. **一次 `acquire` 恰好开一个事务**，`ai_tasks` 的行锁**先于** `task_private`
 *    （`lockTask` 的注释给了理由：反序就是死锁，而 Postgres 只随机挑一个牺牲品回滚，
 *    表现出来是一次查不出原因的 `REVISION_CONFLICT`）；
 * 2. **纯读判据真的不写**，且同一批用例还证明那个事务**确实跑了** —— "零写入"在"什么都没
 *    发生"时同样成立，所以语句清单必须逐字等于那一句 `SELECT … FOR UPDATE`，不能只数个 0；
 * 3. **`bound(tx)` 一个新事务都不开**（§3.5：事务内的句柄「全部绑定**同一个**
 *    `DatabaseTransaction`」），并且有一条正对照证明记录器**看得见**第二个事务；
 * 4. **判据表对 15 个状态 × 2 个模式完备**，逐状态钉住结论、落库状态、revision 增量、租约列，
 *    以及抛错那 7 个状态的**整行回滚**。
 *
 * ## §11.2 落在本文件的两项负对照
 * 「付费写回执丢失」与「DB 断开」。两项都按 §11.2 的三段式走：先正对照，再注入确认红，
 * 再恢复确认绿。**不用任何进程内替身**（§2.2 逐字：「不把 DB 换成进程内或浏览器存储来假
 * 交付」）—— 观察手段是一个只记录、不改行为的装饰器，套在真适配器外面。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AiTask,
  type Revision,
  type TaskId,
  type TaskPumpOutcome,
  type TaskState,
  type Timestamp,
  DomainError,
  IDLE_TASK_STATES,
  LEASE_HOLDING_TASK_STATES,
  TASK_STATES,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
  canClaimTask,
  canReacquireLease,
  isRetryBackoffActive,
  isTerminalState,
} from '@littleq/domain';
import {
  TASK_ACQUIRE_DECISION_MODES,
  TASK_ACQUIRE_DECISION_ORDER,
  formatJournalOperationKey,
  type JournalOperationKey,
  type OperationIntentState,
  type OperationJournalEntry,
  type OperationReceipt,
  type RecordReceiptInput,
  type TaskAcquireDecision,
  type TaskAcquireInput,
  type TaskAcquireResult,
  type TaskPumpMode,
} from '@littleq/application';

import { isInfraError } from '../src/errors.js';
import type { DatabaseAdapter, DatabaseTransaction } from '../src/ports/database-adapter.js';
import { newLeaseToken } from '../src/sql/lease.js';
import { fromNullableTimestamptz, fromRevisionColumn } from '../src/sql/rows.js';
import { PostgresTaskPumpStore } from '../src/sql/task-pump-store.js';
import {
  AI_TASK_ENTITY_CAS_SQL,
  AI_TASK_LEASE_SET_SQL,
  AI_TASK_SELECT_BY_ID_FOR_UPDATE_SQL,
  setTaskLease,
} from '../src/sql/task-rows.js';
import {
  TASK_PRIVATE_COLUMNS,
  TASK_PRIVATE_SELECT_FOR_UPDATE_SQL,
  TASK_PRIVATE_UPDATE_JOURNAL_SQL,
  type TaskPrivateRow,
  taskPrivateFromRow,
} from '../src/sql/task-private-rows.js';
import { at, atSeconds, uuidAt } from './support.js';
import {
  type SeededAccounts,
  type TestDatabaseHarness,
  createTestDatabaseHarness,
  queryHarness,
  secondaryAdapter,
  seedAccounts,
  seedPrivateState,
  seedTask,
  type SeedTaskOptions,
} from './support-database.js';

/* -------------------------------------------------------------------------- */
/* 观察手段：一个只记录、不改行为的装饰器                                      */
/* -------------------------------------------------------------------------- */

/**
 * 把 SQL 压成一行，好与 `src/sql/*.ts` 导出的常量逐字比较。
 *
 * 那些常量里带换行与缩进（为了在源码里可读），而记录器拿到的是同一个字符串对象，所以
 * 比较两侧都必须过这一道归一 —— 只归一侧会得到 15 条全红的假失败。
 */
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * 只看**首词**。用"包含 UPDATE"会把一条 SELECT 判成写：`AI_TASK_COLUMNS` 里没有
 * `updated_at`，但 `PROJECT_*` 与 `USAGE_*` 有，而判据一旦写成"包含"，将来任何一句带
 * `updated_at` 的 SELECT 都会被算成写入，于是"纯读零写入"这条断言会**假红**，
 * 修它的人就会顺手把断言删掉。
 */
function isWrite(sql: string): boolean {
  return /^(INSERT|UPDATE|DELETE)\b/i.test(sql);
}

type Recording = {
  readonly adapter: DatabaseAdapter;
  /** 每个元素是一次 `transaction()` 里按发出顺序记录的语句（已单行化）。 */
  readonly transactions: readonly (readonly string[])[];
};

function recording(db: DatabaseAdapter): Recording {
  const transactions: string[][] = [];
  const adapter: DatabaseAdapter = {
    transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> => {
      const statements: string[] = [];
      // **先登记再执行**：一次最终回滚的事务同样要留下它试图发出的语句。「抛了所以什么都没
      // 写」与「抛了但已经写过、靠回滚撤掉」是两件不同的事，后者才是 Layer C 那 7 个
      // THROW 状态要证明的东西。
      transactions.push(statements);
      return db.transaction(async (tx) => {
        const wrapped: DatabaseTransaction = {
          query: <TRow>(sql: string, params: readonly unknown[]): Promise<readonly TRow[]> => {
            statements.push(oneLine(sql));
            return tx.query<TRow>(sql, params);
          },
          execute: (sql: string, params: readonly unknown[]): Promise<number> => {
            statements.push(oneLine(sql));
            return tx.execute(sql, params);
          },
        };
        return work(wrapped);
      });
    },
    migrate: () => db.migrate(),
    health: () => db.health(),
    close: () => db.close(),
  };
  return { adapter, transactions };
}

function writesOf(transaction: readonly string[]): readonly string[] {
  return transaction.filter(isWrite);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

/** `null` 表示"没抛"。刻意不用哨兵字符串：那会与某个真实错误码混淆。 */
function codeOf(error: unknown): string {
  if (isInfraError(error)) return error.code;
  if (error instanceof DomainError) return error.code;
  if (error === null) return '<没有抛>';
  return `<不是已知错误：${String(error)}>`;
}

/* -------------------------------------------------------------------------- */
/* Layer A：判据完备性的代数（纯函数，不需要数据库）                            */
/* -------------------------------------------------------------------------- */

/** 某个模式下**适用**的判据，按端口那份顺序表的次序。 */
function decisionsFor(mode: TaskPumpMode): readonly TaskAcquireDecision[] {
  return TASK_ACQUIRE_DECISION_ORDER.filter((decision) => {
    const allowed = TASK_ACQUIRE_DECISION_MODES[decision];
    return allowed === 'BOTH' || allowed === mode;
  });
}

/** 与 `task-pump-store.ts` 里那个私有 `appliesTo` 同形；本层用它反推驱动该走哪几项。 */
function indexOf(decision: TaskAcquireDecision): number {
  return (TASK_ACQUIRE_DECISION_ORDER as readonly TaskAcquireDecision[]).indexOf(decision);
}

describe('判据表对 15 个状态完备（纯函数层，不碰数据库）', () => {
  const terminal = [...TERMINAL_TASK_STATES];
  // 显式放宽成 `TaskState[]`：`IDLE_TASK_STATES` 是窄元组，不放宽的话
  // `idle.includes(state)` 会因为 `state: TaskState` 不是 `'QUEUED' | 'RETRY_WAIT'` 而编译不过。
  const idle: readonly TaskState[] = [...IDLE_TASK_STATES];
  const reacquire = LEASE_HOLDING_TASK_STATES.filter((state) => state !== 'CANCELLING');

  it('15 个状态被划成互斥且穷尽的四桶：终态 5 / 空闲 2 / 取消中 1 / 可接管 7', () => {
    expect(terminal).toHaveLength(5);
    expect(idle).toEqual(['QUEUED', 'RETRY_WAIT']);
    expect(reacquire).toHaveLength(7);

    const union: readonly TaskState[] = [...terminal, ...idle, 'CANCELLING', ...reacquire];
    expect(new Set(union).size, '四桶必须互斥，否则同一个状态会被两项判据争夺').toBe(union.length);
    expect(union).toHaveLength(15);
    expect([...union].sort()).toEqual([...TASK_STATES].sort());
  });

  it('canReacquireLease(·, null, now) 恰好等于「非终态且非空闲」那 8 个状态', () => {
    // 这一条是 PUMP 模式不会走到 `:125` 的全部依据：`LIVE_LEASE_COALESCE` 已经为任何未过期
    // 租约返回过结论，所以能走到 `REACQUIRE_LEASE` 的任务，其租约必然已过期（或根本没有），
    // 于是 `isLeaseExpired(lease?.leaseUntil ?? null, now)` 恒真，剩下的唯一变量就是状态。
    for (const state of TASK_STATES) {
      const expected = !isTerminalState(TASK_TRANSITIONS, state) && !idle.includes(state);
      expect(canReacquireLease(state, null, at(0)), `${state} 的可接管性`).toBe(expected);
    }
    // 正对照：上面那圈不是一边倒 —— 8 真 7 假，且真的那 8 个正是端口派生出来的那个数组。
    const truths = TASK_STATES.filter((state) => canReacquireLease(state, null, at(0)));
    expect(truths).toHaveLength(8);
    expect([...LEASE_HOLDING_TASK_STATES].sort()).toEqual([...truths].sort());
  });

  it('CANCELLING 也在接管桶里，但两个模式各自有更早的一项截住它', () => {
    expect(canReacquireLease('CANCELLING', null, at(0))).toBe(true);
    // PUMP：`CANCELLING_NO_OP` 先于 `REACQUIRE_LEASE` ⇒ 永远轮不到接管。
    expect(TASK_ACQUIRE_DECISION_MODES.CANCELLING_NO_OP).toBe('PUMP');
    expect(indexOf('CANCELLING_NO_OP')).toBeLessThan(indexOf('REACQUIRE_LEASE'));
    // CANCEL：`REACQUIRE_LEASE` 根本不适用，接管由 `RESUME_CANCELLING` 独家处置。
    expect(TASK_ACQUIRE_DECISION_MODES.RESUME_CANCELLING).toBe('CANCEL');
    expect(decisionsFor('CANCEL')).not.toContain('REACQUIRE_LEASE');
    expect(decisionsFor('PUMP')).not.toContain('RESUME_CANCELLING');
  });

  it('canClaimTask 只对 QUEUED 为真，其余 14 个状态一律为假', () => {
    for (const state of TASK_STATES) {
      expect(canClaimTask(state, null, at(0)), `canClaimTask(${state}, null)`).toBe(
        state === 'QUEUED',
      );
    }
  });

  it('未到点的 QUEUED 既领不了也接管不了 ⇒ 必须有 QUEUED_NOT_DUE_WAITING 那一项', () => {
    expect(canClaimTask('QUEUED', at(600), at(0))).toBe(false);
    expect(canReacquireLease('QUEUED', null, at(0)), 'QUEUED 属于空闲态，不在接管桶里').toBe(false);
    // 两项都不认，而 PUMP 的适用集里没有别的项目会返回 QUEUED 的结论 ⇒ 少了
    // `QUEUED_NOT_DUE_WAITING`，未到点的 QUEUED 就会一路掉到 `:125`。
    expect(indexOf('QUEUED_NOT_DUE_WAITING')).toBeLessThan(indexOf('REACQUIRE_LEASE'));
  });

  it('isRetryBackoffActive 的三种边界：null 不等待、未来等待、恰好到点不等待', () => {
    expect(isRetryBackoffActive(null, at(0))).toBe(false);
    expect(isRetryBackoffActive(at(600), at(0))).toBe(true);
    expect(isRetryBackoffActive(at(0), at(0)), '到点即视为不再等待（<= 语义）').toBe(false);
  });

  it('PUMP 适用 9 项、末项是接管；CANCEL 适用 6 项、末项是无条件抛 ⇒ 两个模式各自封闭', () => {
    const pump = decisionsFor('PUMP');
    const cancel = decisionsFor('CANCEL');
    expect(pump).toHaveLength(9);
    expect(cancel).toHaveLength(6);
    expect(pump[pump.length - 1]).toBe('REACQUIRE_LEASE');
    expect(cancel[cancel.length - 1]).toBe('REJECT_NOT_CANCELLABLE');
    // 端口那 13 项被两个模式瓜分：9 + 6 = 15，其中 `TERMINAL_NO_OP` 与 `IF_MATCH_REVISION`
    // 是 BOTH，各被数了两次 ⇒ 15 - 2 = 13，一项不多一项不少。
    expect(pump.length + cancel.length - 13).toBe(2);
    const both = TASK_ACQUIRE_DECISION_ORDER.filter(
      (decision) => TASK_ACQUIRE_DECISION_MODES[decision] === 'BOTH',
    );
    expect(both).toEqual(['TERMINAL_NO_OP', 'IF_MATCH_REVISION']);
  });
});

/* -------------------------------------------------------------------------- */
/* 真 Postgres 夹具                                                            */
/* -------------------------------------------------------------------------- */

const harness = await createTestDatabaseHarness();

afterAll(async () => {
  await harness.dispose();
});

beforeAll(async () => {
  await harness.adapter.migrate();
});

/** `harness` 已非空（挂具拿不到库就抛），这一层只是把「这里要真库」写在调用点上。 */
function db(): TestDatabaseHarness {
  return harness;
}

const WORKER = 'worker-a';
const LEASE_SECONDS = 60;

function acquireInput(
  taskId: TaskId,
  expectedRevision: Revision,
  mode: TaskPumpMode,
  overrides: Partial<TaskAcquireInput> = {},
): TaskAcquireInput {
  return {
    taskId,
    expectedRevision,
    workerId: WORKER,
    leaseSeconds: LEASE_SECONDS,
    mode,
    now: at(0),
    ...overrides,
  };
}

/**
 * 播一个任务**和**它的 `task_private` 行（都用默认值）。装配端口的用例几乎都要两行齐备。
 *
 * `seedTask` 刻意**不**顺手播 private 行 —— §3.5 那个「一个事务里两行」的作者是装配端口本身，
 * 夹具替它做了，`createTurn` 的顺序断言就永远为真；分开播还让「有 task 行而没有 private 行」
 * 变得可构造，那是 `lockPrivateState` 抛错分支唯一的进入方式。
 *
 * 需要在 journal 里播条目时不要用本函数：条目的 `operationKey` 内嵌 `taskId`，必须先拿到
 * `seedTask` 的结果，所以那种用例直接写 `seedTask` + `seedPrivateState` 两步
 * （`task_private.task_id` 是主键，播两次会 23505）。
 */
async function seedState(options: SeedTaskOptions = {}): Promise<AiTask> {
  const task = await seedTask(db(), options);
  await seedPrivateState(db(), task.id);
  return task;
}

type TaskRowSnapshot = {
  readonly state: string;
  readonly revision: unknown;
  readonly next_run_at: unknown;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_until: unknown;
  readonly cancel_requested_at: string | null;
};

/**
 * `cancelRequestedAt` 与 `finishedAt` **不是列**，只在 `payload` 里（`AI_TASK_COLUMNS` 逐字
 * 可查）。所以取消时刻要从 jsonb 取；而 `revision` / 三列租约 / `next_run_at` 是列。
 */
const TASK_ROW_SNAPSHOT_SQL = `
SELECT state, revision, next_run_at, lease_owner, lease_token, lease_until,
       payload->>'cancelRequestedAt' AS cancel_requested_at
FROM ai_tasks WHERE id = $1`;

type RowFingerprint = {
  readonly state: string;
  readonly revision: string;
  readonly nextRunAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseUntil: string | null;
  readonly cancelRequestedAt: string | null;
};

async function snapshotOf(taskId: TaskId): Promise<RowFingerprint> {
  const rows = await queryHarness<TaskRowSnapshot>(db(), TASK_ROW_SNAPSHOT_SQL, [taskId]);
  const [row] = rows;
  if (row === undefined) throw new Error(`夹具失败：ai_tasks 里没有 ${taskId}`);
  return {
    state: row.state,
    // `revision` 是 `bigint` 列，node-pg 把它交回**字符串**（OID 20），所以走读方向编解码器。
    revision: fromRevisionColumn(row.revision),
    // 三个时间列都过 `fromNullableTimestamptz`：node-pg 把 `timestamptz` 交回 `Date`，
    // 直接 `String(date)` 会按宿主时区渲染（本机 GMT+8），断言就成了机器相关的。
    nextRunAt: fromNullableTimestamptz(row.next_run_at),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseUntil: fromNullableTimestamptz(row.lease_until),
    cancelRequestedAt: row.cancel_requested_at,
  };
}

function revisionOf(value: string): bigint {
  return BigInt(value);
}

/** 用生产写句柄种一份租约，不用裸 SQL：顺带让 `setTaskLease` 的"恰好 1 行"参与测试。 */
async function plantLease(taskId: TaskId, owner: string, until: Timestamp): Promise<string> {
  const token = newLeaseToken(1);
  await db().adapter.transaction(async (tx) => {
    await setTaskLease(tx, taskId, owner, token, until);
  });
  return token;
}

function verdictOf(result: TaskAcquireResult): string {
  return result.kind === 'LEASED' ? 'LEASED' : `RESULT:${result.outcome}`;
}

describe('真 Postgres：事务形状', () => {
  const TASK_LOCK = oneLine(AI_TASK_SELECT_BY_ID_FOR_UPDATE_SQL);
  const PRIVATE_LOCK = oneLine(TASK_PRIVATE_SELECT_FOR_UPDATE_SQL);
  const CAS = oneLine(AI_TASK_ENTITY_CAS_SQL);
  const LEASE_SET = oneLine(AI_TASK_LEASE_SET_SQL);

  it('一次 acquire 恰好开一个事务，且 ai_tasks 的行锁先于 task_private', async () => {
    const task = await seedState({ state: 'RUNNING' });
    const recorded = recording(db().adapter);
    const result = await PostgresTaskPumpStore.of(recorded.adapter).acquire(
      acquireInput(task.id, task.revision, 'PUMP'),
    );

    expect(result.kind).toBe('LEASED');
    expect(recorded.transactions, '一次 acquire 不许开第二个事务').toHaveLength(1);
    const [statements] = recorded.transactions;
    expect(statements).toEqual([TASK_LOCK, PRIVATE_LOCK, CAS, LEASE_SET]);
  });

  it('发租约的那一句序列与领取路径无关：CLAIM 与 REACQUIRE 给出同样四句', async () => {
    const claimed = await seedState({ state: 'QUEUED' });
    const claimRecorded = recording(db().adapter);
    await PostgresTaskPumpStore.of(claimRecorded.adapter).acquire(
      acquireInput(claimed.id, claimed.revision, 'PUMP'),
    );
    expect(claimRecorded.transactions[0]).toEqual([TASK_LOCK, PRIVATE_LOCK, CAS, LEASE_SET]);

    const reacquired = await seedState({ state: 'COLLECTING' });
    const reacquireRecorded = recording(db().adapter);
    await PostgresTaskPumpStore.of(reacquireRecorded.adapter).acquire(
      acquireInput(reacquired.id, reacquired.revision, 'PUMP'),
    );
    expect(reacquireRecorded.transactions[0]).toEqual([TASK_LOCK, PRIVATE_LOCK, CAS, LEASE_SET]);
  });

  /**
   * 四条纯读判据的共同断言。
   *
   * 每条都把语句清单**逐字**钉成那一句 `SELECT … FOR UPDATE`，而不是只断言"写语句数为 0"：
   * 后者在"事务根本没跑"时同样成立，那是一条空断言。逐字清单同时证明了事务跑了、跑了什么、
   * 以及在哪一项判据上短路 —— 少一句会红，多一句也会红。
   */
  async function assertPureRead(task: AiTask, outcome: TaskPumpOutcome): Promise<void> {
    const before = await snapshotOf(task.id);
    const recorded = recording(db().adapter);

    const result = await PostgresTaskPumpStore.of(recorded.adapter).acquire(
      acquireInput(task.id, task.revision, 'PUMP'),
    );

    expect(result).toMatchObject({ kind: 'RESULT', outcome });
    expect(recorded.transactions, '一次纯读 acquire 只开一个事务').toHaveLength(1);
    expect(recorded.transactions[0], '只发了那一句锁行 SELECT').toEqual([TASK_LOCK]);
    expect(writesOf(recorded.transactions[0] ?? []), '零写入').toEqual([]);
    expect(await snapshotOf(task.id), '整行必须与调用前逐字段相同').toEqual(before);
  }

  it('纯读零写入：终态（SUCCEEDED）走 TERMINAL_NO_OP', async () => {
    // `assertTaskCoherent` 要求终态必须有 `finishedAt`，SUCCEEDED 还必须有 `resultVersionId`。
    // `ai_tasks.result_version_id` **没有外键**（`migrations.ts` 逐条可查），所以这里可以填一个
    // 合成的 uuid 而不必再播一行 `versions`。
    const task = await seedState({
      state: 'SUCCEEDED',
      finishedAt: atSeconds(100),
      resultVersionId: uuidAt(901),
    });
    await assertPureRead(task, 'NO_OP_TERMINAL');
  });

  it('纯读零写入：取消中走 CANCELLING_NO_OP（PUMP 专属，CANCEL 模式另有处置）', async () => {
    const task = await seedState({ state: 'CANCELLING', cancelRequestedAt: atSeconds(50) });
    await assertPureRead(task, 'NO_OP_CANCELLING');
  });

  it('纯读零写入：退避未到点的 RETRY_WAIT 走 BACKOFF_WAITING', async () => {
    const task = await seedState({ state: 'RETRY_WAIT', nextRunAt: atSeconds(600) });
    await assertPureRead(task, 'NO_OP_WAITING');
  });

  it('纯读零写入：未到点的 QUEUED 走 QUEUED_NOT_DUE_WAITING（前面七项都返回 null）', async () => {
    const task = await seedState({ state: 'QUEUED', nextRunAt: atSeconds(600) });
    // 关键：`LIVE_LEASE_COALESCE` / `TERMINAL_NO_OP` / `CANCELLING_NO_OP` / `IF_MATCH_REVISION`
    // / `BACKOFF_WAITING` / `RETRY_WAIT_DUE` / `CLAIM_QUEUED` 七项都返回了 null，
    // 而**一句额外的 SQL 都没发** —— 判据全在 TypeScript 里，SQL 的 `WHERE` 只有 `id = $1`。
    await assertPureRead(task, 'NO_OP_WAITING');
  });

  it('bound(tx) 一个新事务都不开，语句直接落在调用方那个事务里', async () => {
    const task = await seedState({ state: 'VALIDATING' });
    const recorded = recording(db().adapter);

    await recorded.adapter.transaction(async (tx) => {
      const result = await PostgresTaskPumpStore.bound(tx).acquire(
        acquireInput(task.id, task.revision, 'PUMP'),
      );
      expect(result.kind).toBe('LEASED');
    });

    expect(recorded.transactions, '§3.5：绑定语境必须复用同一个事务').toHaveLength(1);
    expect(recorded.transactions[0]).toEqual([TASK_LOCK, PRIVATE_LOCK, CAS, LEASE_SET]);
  });

  it('正对照：同一个记录器看得见"嵌套开了第二个事务"，所以上一条的 1 不是空的', async () => {
    const task = await seedState({ state: 'REPAIRING' });
    const recorded = recording(db().adapter);

    await recorded.adapter.transaction(async () => {
      // 刻意用**独立**语境 `of()`：它会自己再开一个事务，于是记录器必须数到 2。
      await PostgresTaskPumpStore.of(recorded.adapter).acquire(
        acquireInput(task.id, task.revision, 'PUMP'),
      );
    });

    expect(recorded.transactions).toHaveLength(2);
  });

  it('§3.5 步骤 1：活租约排在 If-Match 之前，旧 revision 也返回 COALESCED 而不是 409', async () => {
    const task = await seedState({ state: 'RUNNING' });
    await plantLease(task.id, 'worker-other', at(600));

    const result = await PostgresTaskPumpStore.of(db().adapter).acquire(
      // 携带一个明显过期的 revision：域内 `decideTaskPump` 会先报 409，本驱动必须不报。
      acquireInput(task.id, '999' as Revision, 'PUMP'),
    );

    expect(result).toMatchObject({ kind: 'RESULT', outcome: 'COALESCED_IN_FLIGHT' });
    if (result.kind !== 'RESULT') throw new Error('上一句已经断言过 kind');
    // 交回的是**行上那一个** task，不是入参声称的 revision。
    expect(result.task.revision).toBe(task.revision);
    expect(result.task.state).toBe('RUNNING');
  });

  it('申报的解释 ①：活租约的判据不比较 owner，同一个 workerId 也 coalesce', async () => {
    const task = await seedState({ state: 'COMMITTING' });
    await plantLease(task.id, WORKER, at(600));

    const result = await PostgresTaskPumpStore.of(db().adapter).acquire(
      acquireInput(task.id, task.revision, 'PUMP'),
    );

    // 字面读 `decideTaskPump` 的 `drivenByAnother`（"**别的**执行者持有未过期租约"）会期待
    // 这里发出一份新租约；本驱动刻意不比较 owner，理由写在 `src/sql/task-pump-store.ts`
    // 头部的申报 ① 里。这条断言就是那份申报的钉子。
    expect(verdictOf(result)).toBe('RESULT:COALESCED_IN_FLIGHT');
  });

  it('对照：没有活租约时，同一个旧 revision 就是 409 REVISION_CONFLICT', async () => {
    const task = await seedState({ state: 'RUNNING' });
    const before = await snapshotOf(task.id);

    const error = await captureError(
      PostgresTaskPumpStore.of(db().adapter).acquire(
        acquireInput(task.id, '999' as Revision, 'PUMP'),
      ),
    );

    expect(codeOf(error)).toBe('REVISION_CONFLICT');
    expect(await snapshotOf(task.id), '409 必须无副作用').toEqual(before);
  });

  it('申报的偏离 ③：coalesce 只适用于 PUMP，CANCEL 模式不吃活租约', async () => {
    const task = await seedState({ state: 'RUNNING' });
    const otherToken = await plantLease(task.id, 'worker-other', at(600));

    const result = await PostgresTaskPumpStore.of(db().adapter).acquire(
      acquireInput(task.id, task.revision, 'CANCEL'),
    );

    // 不是 COALESCED，而是**接管**：`RUNNING → CANCELLING` 后发一份定向租约。
    expect(result.kind).toBe('LEASED');
    if (result.kind !== 'LEASED') throw new Error('上一句已经断言过 kind');
    expect(result.task.state).toBe('CANCELLING');
    const after = await snapshotOf(task.id);
    expect(after.leaseOwner).toBe(WORKER);
    expect(after.leaseToken, '接管必须换掉令牌，否则原持有者还以为自己拿着').not.toBe(otherToken);
  });

  it('CANCEL 模式同样过 If-Match：活租约 + 旧 revision ⇒ 409', async () => {
    const task = await seedState({ state: 'RUNNING' });
    await plantLease(task.id, 'worker-other', at(600));

    const error = await captureError(
      PostgresTaskPumpStore.of(db().adapter).acquire(
        acquireInput(task.id, '999' as Revision, 'CANCEL'),
      ),
    );

    // coalesce 是 PUMP-only ⇒ 活租约在 CANCEL 模式下**挡不住** If-Match。
    expect(codeOf(error)).toBe('REVISION_CONFLICT');
  });

  it('taskId 不存在 ⇒ TASK_NOT_FOUND，只发那一句锁行 SELECT', async () => {
    const recorded = recording(db().adapter);
    const error = await captureError(
      PostgresTaskPumpStore.of(recorded.adapter).acquire(
        acquireInput(uuidAt(777) as TaskId, '1' as Revision, 'PUMP'),
      ),
    );

    expect(codeOf(error)).toBe('TASK_NOT_FOUND');
    expect(recorded.transactions[0]).toEqual([TASK_LOCK]);
  });

  it('leaseSeconds 非法 ⇒ LEASE_TTL_OUT_OF_RANGE，且**一个事务都没开**', async () => {
    const task = await seedState({ state: 'QUEUED' });
    const recorded = recording(db().adapter);

    for (const leaseSeconds of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await captureError(
        PostgresTaskPumpStore.of(recorded.adapter).acquire(
          acquireInput(task.id, task.revision, 'PUMP', { leaseSeconds }),
        ),
      );
      expect(codeOf(error), `leaseSeconds=${String(leaseSeconds)}`).toBe('LEASE_TTL_OUT_OF_RANGE');
    }

    // 时长先验在 `#execute` 之前 ⇒ "一次被拒的领取不该在库里留下任何痕迹"是字面成立的。
    expect(recorded.transactions).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §11.2 负对照：付费写回执丢失 / DB 断开                                      */
/* -------------------------------------------------------------------------- */

const OPERATION = 'qca-session-create';
const REQUEST_HASH = 'e'.repeat(64);
const RECEIPT: OperationReceipt = { sessionId: 'sess_0198f2a4', status: 'created' };
const PROVIDER_SNAPSHOT = {
  identityId: 'idn_1',
  templateId: 'tpl_1',
  environmentId: 'env_1',
  templateVersion: '1',
} as const;

function entryFor(
  taskId: TaskId,
  intent: OperationIntentState,
  recordedAt: Timestamp,
  receipt: OperationReceipt | null = null,
): OperationJournalEntry {
  return {
    operationKey: journalKey(taskId),
    requestHash: REQUEST_HASH,
    externalKey: 'ext-1',
    providerSnapshot: PROVIDER_SNAPSHOT,
    intent,
    receipt,
    recordedAt,
  };
}

/** 这些用例里的外呼只有一种，所以键的四个组成部分里三个是常量。 */
function journalKey(taskId: TaskId, ordinal = 1): JournalOperationKey {
  return formatJournalOperationKey({ taskId, operation: OPERATION, attempt: 1, ordinal });
}

function receiptInput(
  taskId: TaskId,
  overrides: Partial<RecordReceiptInput> = {},
): RecordReceiptInput {
  return {
    taskId,
    operationKey: journalKey(taskId),
    requestHash: REQUEST_HASH,
    receipt: RECEIPT,
    now: at(200),
    ...overrides,
  };
}

/**
 * 读回 journal 的唯一那一项。走生产读路径（`taskPrivateFromRow`），不用裸 SQL 拆 jsonb ——
 * 拆错了会读出一份"看起来正常"的对象，于是"回执整体消失"那条断言假绿。
 */
async function journalOf(taskId: TaskId): Promise<readonly OperationJournalEntry[]> {
  const rows = await queryHarness<TaskPrivateRow>(
    db(),
    `SELECT ${TASK_PRIVATE_COLUMNS} FROM task_private WHERE task_id = $1`,
    [taskId],
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`夹具失败：task_private 里没有 ${taskId}`);
  return taskPrivateFromRow(row).operationJournal;
}

describe('真 Postgres：recordReceipt 与 §11.2 负对照', () => {
  const PRIVATE_LOCK = oneLine(TASK_PRIVATE_SELECT_FOR_UPDATE_SQL);
  const JOURNAL_UPDATE = oneLine(TASK_PRIVATE_UPDATE_JOURNAL_SQL);

  /**
   * 播一个「外呼已经发出去、回执还没补记」的任务：journal 里恰好一条指定 intent 的条目。
   *
   * 条目的 `operationKey` 内嵌 `taskId`，所以必须两步播（先 `seedTask` 拿到 id，再
   * `seedPrivateState`），不能塞进 `seedState` 的默认值里。
   */
  async function seedAwaitingReceipt(
    state: TaskState,
    intent: OperationIntentState = 'SENT',
  ): Promise<AiTask> {
    const task = await seedTask(db(), { state });
    await seedPrivateState(db(), task.id, {
      operationJournal: [entryFor(task.id, intent, at(100))],
    });
    return task;
  }

  it('recordReceipt 的事务从不碰 ai_tasks（§3.5「不修改 task/revision/checkpoint」）', async () => {
    const task = await seedAwaitingReceipt('SESSION_CREATING');
    const before = await snapshotOf(task.id);
    const recorded = recording(db().adapter);

    await PostgresTaskPumpStore.of(recorded.adapter).recordReceipt(receiptInput(task.id));

    expect(recorded.transactions).toHaveLength(1);
    expect(recorded.transactions[0]).toEqual([PRIVATE_LOCK, JOURNAL_UPDATE]);
    for (const statement of recorded.transactions[0] ?? []) {
      expect(statement, '补记回执不许写 task 表').not.toContain('ai_tasks');
    }
    expect(await snapshotOf(task.id), 'task 行必须一动没动').toEqual(before);

    const [entry] = await journalOf(task.id);
    expect(entry?.intent).toBe('RECEIPT_RECORDED');
    expect(entry?.receipt).toEqual(RECEIPT);
    expect(entry?.recordedAt).toBe(atSeconds(200));
  });

  it('只写 journal 一列：checkpoint / subphase / cursor 不在语句里，读回来也原样', async () => {
    const task = await seedTask(db(), { state: 'COLLECTING' });
    const seeded = await seedPrivateState(db(), task.id, {
      operationJournal: [entryFor(task.id, 'SENT', at(100))],
    });

    await PostgresTaskPumpStore.of(db().adapter).recordReceipt(receiptInput(task.id));

    const rows = await queryHarness<{
      readonly internal_subphase: string;
      readonly collection_cursor: unknown;
      readonly scan_checkpoint: unknown;
    }>(
      db(),
      `SELECT internal_subphase, collection_cursor, scan_checkpoint
       FROM task_private WHERE task_id = $1`,
      [task.id],
    );
    const [row] = rows;
    expect(row?.internal_subphase).toBe(seeded.internalSubphase);
    expect(row?.scan_checkpoint, '本用例没播 checkpoint，它必须仍是 NULL').toBe(null);
    // cursor 是 jsonb：node-pg 交回普通对象，直接结构比较。刻意**不**用
    // `canonicalOperationReceipt` —— 那个规范化只认 `Record<string, string>`，
    // 而 `sealedPaths` 是数组，`.length` 会被当成"字符串长度"算成 0，比较就成了永真。
    expect(row?.collection_cursor).toEqual({
      artifactSha256: seeded.collectionCursor.artifactSha256,
      sealedPaths: seeded.collectionCursor.sealedPaths,
    });
  });

  it('§11.2 付费写回执丢失：正对照 → 提交前死亡 ⇒ 回执整体消失 → 重放恢复', async () => {
    // —— 正对照：同一个事务正常提交时，回执确实落库。
    const committed = await seedAwaitingReceipt('SESSION_CREATING');
    await PostgresTaskPumpStore.of(db().adapter).recordReceipt(receiptInput(committed.id));
    expect((await journalOf(committed.id))[0]?.intent, '正对照必须先绿').toBe('RECEIPT_RECORDED');

    // —— 注入：外呼已经发出去了（journal 是 SENT），但补记回执的那个事务在 COMMIT 之前死掉。
    // 用 `bound(tx)` 把补记挂进一个随后抛错的**外层**事务，正是 §11.2 说的那个形状：
    // 驱动自己没有回滚能力，它只承诺"我这一个短事务要么全写要么全不写"。
    const lost = await seedAwaitingReceipt('SESSION_CREATING');
    const failure = new Error('模拟进程在提交前死亡');
    const thrown = await captureError(
      db().adapter.transaction(async (tx) => {
        await PostgresTaskPumpStore.bound(tx).recordReceipt(receiptInput(lost.id));
        throw failure;
      }),
    );
    expect(thrown, '注入必须真的是那一次抛错，不能被适配器吞掉').toBe(failure);

    // 确认红：回执**整体**消失，没有半写状态 —— intent 仍是 SENT，receipt 仍是 null。
    const [afterRollback] = await journalOf(lost.id);
    expect(afterRollback?.intent).toBe('SENT');
    expect(afterRollback?.receipt).toBe(null);

    // —— 恢复：正因为没有半写状态，对账可以原样重放，而重放会成功。
    await PostgresTaskPumpStore.of(db().adapter).recordReceipt(receiptInput(lost.id));
    const [replayed] = await journalOf(lost.id);
    expect(replayed?.intent).toBe('RECEIPT_RECORDED');
    expect(replayed?.receipt).toEqual(RECEIPT);
  });

  it('幂等重放：同 key + 同 hash + 同回执 ⇒ 一次写入都不做，recordedAt 不推后', async () => {
    const task = await seedAwaitingReceipt('SESSION_CREATING');
    const store = PostgresTaskPumpStore.of(db().adapter);
    await store.recordReceipt(receiptInput(task.id));
    const first = (await journalOf(task.id))[0];

    const recorded = recording(db().adapter);
    await PostgresTaskPumpStore.of(recorded.adapter).recordReceipt(
      receiptInput(task.id, { now: at(900) }),
    );

    expect(recorded.transactions[0], '幂等短路 ⇒ 只有那句锁行 SELECT').toEqual([PRIVATE_LOCK]);
    const second = (await journalOf(task.id))[0];
    expect(second?.recordedAt, '重复补记在库里必须完全无痕').toBe(first?.recordedAt);
  });

  it('四条拒绝共用一个码 REVISION_CONFLICT：异回执 / 未知 key / intent 仍 INTENDED / hash 不符', async () => {
    const task = await seedAwaitingReceipt('SESSION_CREATING');
    const store = PostgresTaskPumpStore.of(db().adapter);

    const wrongHash = await captureError(
      store.recordReceipt(receiptInput(task.id, { requestHash: 'f'.repeat(64) })),
    );
    expect(codeOf(wrongHash), 'hash 不符').toBe('REVISION_CONFLICT');

    const unknownKey = await captureError(
      store.recordReceipt(receiptInput(task.id, { operationKey: journalKey(task.id, 2) })),
    );
    expect(codeOf(unknownKey), 'journal 里没有这个 key').toBe('REVISION_CONFLICT');

    const intended = await seedAwaitingReceipt('SESSION_CREATING', 'INTENDED');
    const stillIntended = await captureError(store.recordReceipt(receiptInput(intended.id)));
    expect(codeOf(stillIntended), 'intent 仍是 INTENDED').toBe('REVISION_CONFLICT');

    await store.recordReceipt(receiptInput(task.id));
    const differentReceipt = await captureError(
      store.recordReceipt(receiptInput(task.id, { receipt: { sessionId: 'sess_other' } })),
    );
    expect(codeOf(differentReceipt), '同 key 同 hash 但回执不同').toBe('REVISION_CONFLICT');
  });

  it('申报的解释 ④：有 task 行而没有 private 行 ⇒ STORED_ROW_INCONSISTENT，不是 null', async () => {
    // `seedTask` 刻意**不**顺带建 private 行，所以这个状态是可构造的。
    const task = await seedTask(db(), { state: 'RUNNING' });

    const acquireError = await captureError(
      PostgresTaskPumpStore.of(db().adapter).acquire(acquireInput(task.id, task.revision, 'PUMP')),
    );
    expect(codeOf(acquireError), 'acquire 要发租约，必须先读到 privateState').toBe(
      'STORED_ROW_INCONSISTENT',
    );

    const receiptError = await captureError(
      PostgresTaskPumpStore.of(db().adapter).recordReceipt(receiptInput(task.id)),
    );
    expect(codeOf(receiptError), 'recordReceipt 同样先锁 private 行').toBe(
      'STORED_ROW_INCONSISTENT',
    );
  });

  it('§11.2 DB 断开：正对照 → 关闭连接池确认红 → 换活适配器确认绿', async () => {
    const second = await secondaryAdapter(db());
    try {
      const task = await seedState({ state: 'RUNNING' });
      const store = PostgresTaskPumpStore.of(second.adapter);

      // 正对照：断开之前，同一份代码在同一个池上领得到租约。
      const before = await store.acquire(acquireInput(task.id, task.revision, 'PUMP'));
      expect(before.kind, '正对照必须先绿').toBe('LEASED');

      // 注入：池关闭。`now` 推到租约到期之后，好让"恢复"那一步走接管而不是 coalesce。
      await second.dispose();
      const closedError = await captureError(
        store.acquire(acquireInput(task.id, task.revision, 'PUMP', { now: at(600) })),
      );
      expect(codeOf(closedError)).toBe('PROVIDER_UNAVAILABLE');

      // 恢复：换一个还活着的适配器，同一份判定立刻又绿 —— 证明红来自连接，不来自判据。
      const revived = await PostgresTaskPumpStore.of(db().adapter).acquire(
        acquireInput(task.id, task.revision, 'PUMP', { now: at(600) }),
      );
      expect(revived.kind).toBe('LEASED');
    } finally {
      await second.dispose();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Layer C：15 个状态 × 2 个模式，逐状态钉住                                   */
/* -------------------------------------------------------------------------- */

type Expectation = {
  /** `LEASED` / `RESULT:<outcome>` / `THROW:<code>`。 */
  readonly verdict: string;
  readonly stateAfter: TaskState;
  readonly revisionDelta: bigint;
  /** 调用之后三列租约是否非空。 */
  readonly leaseSetAfter: boolean;
  /** 整行必须与调用前逐字段相同 —— 抛错那几条用它证明事务真的回滚了。 */
  readonly unchangedAfter: boolean;
  readonly cancelRequestedAtAfter?: string | null;
};

function leased(stateAfter: TaskState, revisionDelta: bigint): Expectation {
  return {
    verdict: 'LEASED',
    stateAfter,
    revisionDelta,
    leaseSetAfter: true,
    unchangedAfter: false,
  };
}

function noOp(outcome: TaskPumpOutcome, stateAfter: TaskState): Expectation {
  return {
    verdict: `RESULT:${outcome}`,
    stateAfter,
    revisionDelta: 0n,
    leaseSetAfter: false,
    unchangedAfter: true,
  };
}

function notCancellable(stateAfter: TaskState): Expectation {
  return {
    verdict: 'THROW:TASK_NOT_CANCELLABLE',
    stateAfter,
    revisionDelta: 0n,
    leaseSetAfter: false,
    unchangedAfter: true,
  };
}

/**
 * PUMP 模式的逐状态预期。
 *
 * 每一格都能对着 `src/sql/task-pump-store.ts` 的 `#step` 复核：
 * - `QUEUED` ⇒ `CLAIM_QUEUED`，迁移到 `CLAIMED`（+1）后 `#leaseOut`；
 * - 7 个接管态 ⇒ `REACQUIRE_LEASE`，**状态与 attempt 都不变**，`#leaseOut(tx, task, task.revision)`
 *   写回同一个 revision（+0）；
 * - `RETRY_WAIT`（`nextRunAt` 为 null ⇒ 已到点）⇒ `RETRY_WAIT_DUE`，写 `QUEUED`（+1）并**交出
 *   租约**（留着一个未过期的 `lease_until` 会让下一次 pump 撞上 `LIVE_LEASE_COALESCE`，
 *   把一个没人驱动的任务合并到一次不存在的在飞推进上）；
 * - `CANCELLING` ⇒ `CANCELLING_NO_OP`，纯读；
 * - 5 个终态 ⇒ `TERMINAL_NO_OP`，纯读。
 */
const PUMP_EXPECTATIONS: Readonly<Record<TaskState, Expectation>> = {
  QUEUED: leased('CLAIMED', 1n),
  CLAIMED: leased('CLAIMED', 0n),
  SESSION_CREATING: leased('SESSION_CREATING', 0n),
  RUNNING: leased('RUNNING', 0n),
  COLLECTING: leased('COLLECTING', 0n),
  REPAIRING: leased('REPAIRING', 0n),
  VALIDATING: leased('VALIDATING', 0n),
  COMMITTING: leased('COMMITTING', 0n),
  RETRY_WAIT: {
    verdict: 'RESULT:ADVANCED',
    stateAfter: 'QUEUED',
    revisionDelta: 1n,
    leaseSetAfter: false,
    unchangedAfter: false,
  },
  CANCELLING: noOp('NO_OP_CANCELLING', 'CANCELLING'),
  SUCCEEDED: noOp('NO_OP_TERMINAL', 'SUCCEEDED'),
  FAILED: noOp('NO_OP_TERMINAL', 'FAILED'),
  BLOCKED: noOp('NO_OP_TERMINAL', 'BLOCKED'),
  CANCELLED: noOp('NO_OP_TERMINAL', 'CANCELLED'),
  TIMED_OUT: noOp('NO_OP_TERMINAL', 'TIMED_OUT'),
};

/**
 * CANCEL 模式的逐状态预期。
 *
 * 注意三点：
 * - **5 个终态是 `NO_OP_TERMINAL` 而不是抛**：`TERMINAL_NO_OP` 是 BOTH 且排在
 *   `REJECT_NOT_CANCELLABLE` 之前；
 * - `QUEUED` ⇒ `CANCEL_FROM_QUEUED`，**+2**（`requestCancel` 一格、`transitionTask` 一格，
 *   最后一次 CAS 落库），且 §3.5 逐字要求「**不先领取成不可取消的 CLAIMED**」；
 * - `RUNNING` ⇒ `CANCEL_FROM_RUNNING`，`CANCELLING` 也是 **+2**；`CANCELLING` ⇒
 *   `RESUME_CANCELLING`，状态不变（`CANCELLING → CANCELLING` 不是迁移表里的边）、revision +0，
 *   只补一份定向租约，`cancelRequestedAt` 保留播种时那一个（`requestCancel` 不再被调用）。
 * - 申报的解释 ③：真正改了状态的两种情形都返回 `ADVANCED`（outcome 集合与错误码目录都是
 *   冻结的），取消**是否被接受**由 `state` / `cancelRequestedAt` 表达。
 */
const CANCEL_EXPECTATIONS: Readonly<Record<TaskState, Expectation>> = {
  QUEUED: {
    verdict: 'RESULT:ADVANCED',
    stateAfter: 'CANCELLED',
    revisionDelta: 2n,
    leaseSetAfter: false,
    unchangedAfter: false,
    cancelRequestedAtAfter: atSeconds(0),
  },
  CLAIMED: notCancellable('CLAIMED'),
  SESSION_CREATING: notCancellable('SESSION_CREATING'),
  RUNNING: {
    ...leased('CANCELLING', 2n),
    cancelRequestedAtAfter: atSeconds(0),
  },
  COLLECTING: notCancellable('COLLECTING'),
  REPAIRING: notCancellable('REPAIRING'),
  VALIDATING: notCancellable('VALIDATING'),
  COMMITTING: notCancellable('COMMITTING'),
  RETRY_WAIT: notCancellable('RETRY_WAIT'),
  CANCELLING: {
    ...leased('CANCELLING', 0n),
    cancelRequestedAtAfter: atSeconds(50),
  },
  SUCCEEDED: noOp('NO_OP_TERMINAL', 'SUCCEEDED'),
  FAILED: noOp('NO_OP_TERMINAL', 'FAILED'),
  BLOCKED: noOp('NO_OP_TERMINAL', 'BLOCKED'),
  CANCELLED: noOp('NO_OP_TERMINAL', 'CANCELLED'),
  TIMED_OUT: noOp('NO_OP_TERMINAL', 'TIMED_OUT'),
};

/**
 * 每个状态**除 `state` 之外**还要播什么。`state` 本身由 `seedFor` 从表键取，不在这里重复 ——
 * 重复就等于把同一个事实写两遍，而两遍不一致时先写的那一遍会被静默覆盖。
 *
 * 终态那五格不是可选的：`assertTaskCoherent` 逐条要求 终态 ⟺ `finishedAt !== null`、
 * `FAILED`/`BLOCKED`/`TIMED_OUT` ⟺ `error !== null`、`SUCCEEDED` ⟺ `resultVersionId !== null`、
 * `CANCELLED` ⇒ `cancelRequestedAt !== null`。少一格，播种当场抛 `REQUEST_INVALID`，
 * 于是那五个状态一个用例都走不到 —— 而 `TERMINAL_NO_OP` 是 BOTH，两个模式都靠它兜底。
 */
const STATE_SEED_EXTRAS: Readonly<Record<TaskState, SeedTaskOptions>> = {
  QUEUED: {},
  CLAIMED: {},
  SESSION_CREATING: {},
  RUNNING: {},
  COLLECTING: {},
  REPAIRING: {},
  VALIDATING: {},
  COMMITTING: {},
  RETRY_WAIT: {},
  CANCELLING: { cancelRequestedAt: atSeconds(50) },
  SUCCEEDED: { finishedAt: atSeconds(100), resultVersionId: uuidAt(901) },
  FAILED: { finishedAt: atSeconds(100), error: { code: 'AGENT_FAILED' } },
  BLOCKED: { finishedAt: atSeconds(100), error: { code: 'AGENT_FAILED' } },
  CANCELLED: { finishedAt: atSeconds(100), cancelRequestedAt: atSeconds(50) },
  TIMED_OUT: { finishedAt: atSeconds(100), error: { code: 'AGENT_FAILED' } },
};

describe('真 Postgres：判据表逐状态完备（15 × 2）', () => {
  let accounts: SeededAccounts | null = null;

  beforeAll(async () => {
    accounts = await seedAccounts(db());
  });

  /** 每个用例一个全新项目 + 全新任务：`ai_tasks_one_active_per_project` 是部分唯一索引。 */
  async function seedFor(state: TaskState): Promise<AiTask> {
    if (accounts === null) throw new Error('夹具失败：beforeAll 没有播成账号');
    const task = await seedTask(db(), {
      state,
      ...STATE_SEED_EXTRAS[state],
      requestedBy: accounts.studentId,
    });
    // 这条断言不是装饰：`SeedTaskOptions.state` 是可选的，忘了传就一律播成 `QUEUED`，
    // 而 `QUEUED` 恰好是 15 个状态里唯一"默认值也对"的那一个 —— 少了它，另外 14 个状态
    // 会静默地全都在测 QUEUED，两个模式各 14 条假绿。
    expect(task.state, '播种必须真的落在预期状态上').toBe(state);
    await seedPrivateState(db(), task.id);
    return task;
  }

  const pumpSeen: TaskState[] = [];
  const cancelSeen: TaskState[] = [];
  const internalErrors: string[] = [];

  async function runState(
    mode: TaskPumpMode,
    state: TaskState,
    expected: Expectation,
  ): Promise<void> {
    const task = await seedFor(state);
    const before = await snapshotOf(task.id);
    const store = PostgresTaskPumpStore.of(db().adapter);

    // 结果与错误**一起**接住。不能用 `captureError`：它在成功那条上返回 `null`，把
    // `TaskAcquireResult` 整个丢掉，于是 `LEASED` 与 `RESULT:…` 两种结论都无从比较，
    // 30 个状态里那 23 个不抛的会一律假红。
    const outcome = await store.acquire(acquireInput(task.id, task.revision, mode)).then(
      (result): { readonly result: TaskAcquireResult | null; readonly error: unknown } => ({
        result,
        error: null,
      }),
      (error: unknown) => ({ result: null, error }),
    );
    const after = await snapshotOf(task.id);

    const verdict =
      outcome.error !== null
        ? `THROW:${codeOf(outcome.error)}`
        : outcome.result === null
          ? '<既没抛也没返回>'
          : verdictOf(outcome.result);
    // `:125` 那条 fall-through 是唯一"重试也不会变好"的失败，单独记下来给末尾那条汇总。
    if (verdict === 'THROW:STORED_ROW_INCONSISTENT') internalErrors.push(`${mode}/${state}`);
    expect(verdict, `${mode} ${state} 的结论`).toBe(expected.verdict);

    expect(after.state, `${mode} ${state} 落库状态`).toBe(expected.stateAfter);
    expect(
      revisionOf(after.revision) - revisionOf(before.revision),
      `${mode} ${state} 的 revision 增量`,
    ).toBe(expected.revisionDelta);
    expect(after.leaseOwner !== null, `${mode} ${state} 的租约是否发出`).toBe(
      expected.leaseSetAfter,
    );
    expect(after.leaseToken !== null).toBe(expected.leaseSetAfter);
    expect(after.leaseUntil !== null).toBe(expected.leaseSetAfter);

    if (expected.unchangedAfter) {
      expect(after, `${mode} ${state} 必须整行不变（纯读或已回滚）`).toEqual(before);
    }
    if (expected.cancelRequestedAtAfter !== undefined) {
      expect(after.cancelRequestedAt, `${mode} ${state} 的取消时刻`).toBe(
        expected.cancelRequestedAtAfter,
      );
    }
  }

  for (const state of TASK_STATES) {
    it(`PUMP：${state}`, async () => {
      pumpSeen.push(state);
      await runState('PUMP', state, PUMP_EXPECTATIONS[state]);
    });
  }

  for (const state of TASK_STATES) {
    it(`CANCEL：${state}`, async () => {
      cancelSeen.push(state);
      await runState('CANCEL', state, CANCEL_EXPECTATIONS[state]);
    });
  }

  /**
   * 反空转汇总。
   *
   * 依赖 vitest 在同一个文件内按声明顺序跑 `it`（根配置没有 `sequence.shuffle`）。这个依赖的
   * **失败方向是安全的**：万一顺序变了，下面两条会红，不会绿 —— 而红正是我想要的信号。
   */
  it('两个模式各自走遍了 15 个状态，且一次都没落到 :125', () => {
    expect(pumpSeen, 'PUMP 必须逐个状态都跑过').toEqual([...TASK_STATES]);
    expect(cancelSeen, 'CANCEL 必须逐个状态都跑过').toEqual([...TASK_STATES]);
    expect(
      internalErrors,
      'STORED_ROW_INCONSISTENT 意味着判据表有状态没被覆盖 —— 那不是"输掉一次竞争"',
    ).toEqual([]);
  });

  it('LEASED 交回的租约与库里那三列逐字一致，privateState 是完整记录', async () => {
    const task = await seedFor('RUNNING');
    const result = await PostgresTaskPumpStore.of(db().adapter).acquire(
      acquireInput(task.id, task.revision, 'PUMP'),
    );

    expect(result.kind).toBe('LEASED');
    if (result.kind !== 'LEASED') throw new Error('上一句已经断言过 kind');

    const after = await snapshotOf(task.id);
    expect(after.leaseOwner).toBe(WORKER);
    expect(after.leaseToken, '交出去的令牌必须就是落库那一个').toBe(result.lease.leaseToken);
    // 两侧都过同一套归一（`shiftTimestamp` 与 `fromTimestamptz` 都产出 `toISOString()` 形态），
    // 所以这是逐字比较，不是"差不多"。
    expect(after.leaseUntil).toBe(result.lease.leaseUntil);
    expect(result.lease.taskId).toBe(task.id);
    // 租约上的 revision 是**将要落库的那个**，与行上一致（接管不改状态 ⇒ 与入参也一致）。
    expect(result.lease.revision).toBe(after.revision);

    // §3.5：「privateState 为 §3.2 的 task_private **完整记录**」—— 不是几个挑出来的字段。
    expect(result.privateState.taskId).toBe(task.id);
    expect(result.privateState.inputRef.sha256).toHaveLength(64);
    expect(result.privateState.collectionCursor.artifactSha256).toHaveLength(64);
    expect(result.privateState.operationJournal).toEqual([]);
    expect(result.privateState.inputSnapshot.scanInput.schemaVersion).toBe('1.0.0');
  });

  it('CANCEL 的 7 个不可取消状态：抛错之后整行回滚，连"试图写过的痕迹"都不留', async () => {
    const rejected: readonly TaskState[] = [
      'CLAIMED',
      'SESSION_CREATING',
      'RETRY_WAIT',
      'COLLECTING',
      'REPAIRING',
      'VALIDATING',
      'COMMITTING',
    ];
    for (const state of rejected) {
      const task = await seedFor(state);
      const before = await snapshotOf(task.id);
      const recorded = recording(db().adapter);

      const thrown = await captureError(
        PostgresTaskPumpStore.of(recorded.adapter).acquire(
          acquireInput(task.id, task.revision, 'CANCEL'),
        ),
      );

      expect(codeOf(thrown), `${state}`).toBe('TASK_NOT_CANCELLABLE');
      // `REJECT_NOT_CANCELLABLE` 是无条件抛，它前面那五项在 CANCEL 模式下都不适用 ⇒
      // 事务里只该有那一句锁行 SELECT，一句写都没有。
      expect(writesOf(recorded.transactions[0] ?? []), `${state} 不该有任何写语句`).toEqual([]);
      expect(await snapshotOf(task.id), `${state} 必须整行不变`).toEqual(before);
    }
    // 正对照：这 7 个恰好是 CANCEL 适用集里前五项都不认的那些状态。
    expect(rejected).toHaveLength(7);
    expect([...rejected].sort()).toEqual(
      TASK_STATES.filter(
        (state) =>
          !isTerminalState(TASK_TRANSITIONS, state) &&
          state !== 'QUEUED' &&
          state !== 'RUNNING' &&
          state !== 'CANCELLING',
      ).sort(),
    );
  });
});

/**
 * `TaskRepository` 的生产 Postgres 驱动 —— 补上 `task-lease-cas.test.ts` **自己声明**证明不了的两件事。
 *
 * ## 这个文件为什么存在，由另一份文件的诚实分层决定
 *
 * `task-lease-cas.test.ts` 的文件头有一段「本文件**不能**证明、明确留给 D5/D6 的」，逐字是：
 *
 * > ❌ **跨进程互斥**。两个 worker 同时 `claim` 在单进程替身里必然只有一个赢 —— 这个结论
 * >   来自 JavaScript 的单线程语义，不来自实现。**本用例的「只有一个赢」不是那条语句的证明。**
 * > ❌ 真 PostgreSQL 的 `FOR UPDATE SKIP LOCKED` 语义、索引是否真的被用上（`(next_run_at)`）；
 *
 * 那两条 ❌ 就是本文件 Layer B 的前几个用例。替身把话说清楚了，这里负责把它兑现 ——
 * 否则「只有一个赢」会一直是一条**由 JS 单线程语义供给的假绿**。
 *
 * `lease.ts:18` 另外点名了本文件：内存替身与生产驱动各有一份逐字相同的 `leaseUntilOf`，
 * 「那条测试是这份重复的唯一守卫。删掉它，两处就会各自漂移 —— 而漂移的方向恰好是
 * 『生产比替身宽松』」。那是 Layer A，不需要数据库，因此任何机器上都跑。
 *
 * ## 一处**已申报**的形态分歧
 *
 * 替身文件头预测真互斥会由「D5 那**一条**原子语句」给出（一条带子查询的条件 `UPDATE`）。
 * 生产驱动没有那样写：它是 `SELECT … FOR UPDATE SKIP LOCKED` → domain 谓词 → `UPDATE`，
 * 理由记在 `task-repository.ts:53-61`（条件 UPDATE 要把 `canClaimTask` 在 SQL 里再实现一遍，
 * 而两份判据漂移的方向是确定的：SQL 那份少一个条件 ⇒ 生产比替身宽松；且 §3.1 的一致性
 * 检查只有走 `taskFromRow` 才会跑）。互斥因此由**行锁**提供，不由语句条数提供。
 * 本文件按**实际形态**证明互斥成立，不替这个分歧做裁定 —— 已在交付说明里单列申报。
 *
 * ## 为什么每个用例前要把队列清空
 *
 * `AI_TASK_SELECT_DUE_FOR_CLAIM_SQL` 的 `WHERE` 里**没有** project 也没有 worker 维度：
 * 一个 worker 按设计就是可以领取全表任何到期任务。于是同一个库上先后跑的两个用例，
 * 前一个留下的 `QUEUED` 行会被后一个的 `claim` 领走 —— 表现出来是"数量对不上"，
 * 看起来像驱动坏了，其实是夹具没隔离。`beforeEach` 把残留的 `QUEUED` 一律推到 `CANCELLED`
 * （终态，不再被队列查询选中），**同时改 payload**：只改列不改 payload 会让 §3.1 的
 * `assertColumnMatches` 在下一次读这一行时抛 `STORED_ROW_INCONSISTENT`，那是给自己埋雷。
 *
 * ## 没有数据库时
 * Layer A 照跑；Layer B 直接**红**：挂具在探测不到 Postgres 时抛（见 `support-database.ts`
 * 文件头），模块收集失败，用例记成 failed 而不是 skipped。早先这里用
 * `describe.skipIf(harness === null)`，被 `readiness-no-retirement-tokens` 判成 17 处违规 ——
 * 那道门把 `skipIf` 与 `skip`/`only`/`todo` 并列禁掉，理由是「被跳过的用例不会变红，
 * 只会消失」，而指望交付评论去报 skipped 计数并不满足它：计数只有有人读才可见。
 * §2.2 明确禁止用进程内存储假装交付，所以这里不提供替身路径。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type TaskId, type Timestamp, brand, createTaskEvent } from '@littleq/domain';

import { InMemoryTaskRepository, isInfraError } from '../src/index.js';
import { leaseUntilOf } from '../src/sql/lease.js';
import { fromTimestamptz } from '../src/sql/rows.js';
import { PostgresTaskRepository } from '../src/sql/task-repository.js';
import { AI_TASK_SELECT_DUE_FOR_CLAIM_SQL, setTaskLease } from '../src/sql/task-rows.js';
import { at, makeTask } from './support.js';
import {
  createTestDatabaseHarness,
  queryHarness,
  secondaryAdapter,
  seedTask,
  type TestDatabaseHarness,
} from './support-database.js';

/* -------------------------------------------------------------------------- */
/* Layer A：租约时长下界 —— 两份实现给出同一份判决（不需要数据库）              */
/* -------------------------------------------------------------------------- */

type Verdict =
  | { readonly outcome: 'rejected'; readonly code: string }
  | { readonly outcome: 'leased'; readonly leaseUntil: string };

function codeOf(error: unknown): string {
  return isInfraError(error) ? error.code : `<不是 InfraError：${String(error)}>`;
}

/** 生产那一份：`src/sql/lease.ts` 导出的纯函数。 */
function productionVerdict(now: Timestamp, leaseSeconds: number): Verdict {
  try {
    return { outcome: 'leased', leaseUntil: leaseUntilOf(now, leaseSeconds) };
  } catch (error) {
    return { outcome: 'rejected', code: codeOf(error) };
  }
}

/**
 * 替身那一份：`reference-backends.ts` 的 `leaseUntilOf` 是**模块私有**的，只能经公开面进去。
 *
 * 进去的那条路是 `claim`，而 `claim` 只在**真有可领任务**时才铸造租约（`#newLease` 在循环里），
 * 所以每次都必须先 `seed` 一个 `QUEUED` 任务 —— 空队列上它会返回 `[]` 而不抛，那是
 * `task-repository.ts:69-72` 申报的差异 1，不是本层要钉的东西（Layer B 钉它）。
 * 每个时长值用一个全新的替身：`claim` 会把任务改成 `CLAIMED`，复用会让第二个值领不到东西。
 */
async function substituteVerdict(now: Timestamp, leaseSeconds: number): Promise<Verdict> {
  const memory = new InMemoryTaskRepository();
  memory.seed(makeTask({ state: 'QUEUED' }));
  try {
    const [lease] = await memory.claim({ workerId: 'worker-a', now, leaseSeconds, limit: 1 });
    // 哨兵值刻意不是一个错误码：让「返回了空数组」与「抛了某个码」在配对里不可混淆，
    // 于是两边不可能靠两种不同的失败方式"恰好一致"。
    if (lease === undefined) return { outcome: 'rejected', code: '<既没抛也没铸出租约>' };
    return { outcome: 'leased', leaseUntil: lease.leaseUntil };
  } catch (error) {
    return { outcome: 'rejected', code: codeOf(error) };
  }
}

/**
 * 被拒绝的时长集合。
 *
 * `0.5` / `NaN` / `Infinity` 与 `0` / 负数走的是**两条不同分支**却必须给同一个码：
 * 前者 `Number.isSafeInteger` 为假，绕过 `< 1` 那个判断，落到 `shiftTimestamp`
 * （`types.ts:225`）由它拒绝。把两条分支都列进来，才证明"公开形态一致"这句话是真的，
 * 而不只是整数那一半。
 */
const REJECTED_LEASE_SECONDS: readonly number[] = [
  -5,
  -1,
  0,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
];
const ACCEPTED_LEASE_SECONDS: readonly number[] = [1, 2, 60, 3600];
const LEASE_SECONDS_TABLE: readonly number[] = [
  ...REJECTED_LEASE_SECONDS,
  ...ACCEPTED_LEASE_SECONDS,
];

describe('租约时长下界：生产驱动与内存替身给出同一份判决', () => {
  it('正对照：这份时长表两边都既有被拒的也有被接受的', () => {
    // 没有这一条，"两边一致"可以靠"两边全都抛"或"两边全都不抛"达成 —— 那是空门。
    expect(REJECTED_LEASE_SECONDS.length).toBe(6);
    expect(ACCEPTED_LEASE_SECONDS.length).toBe(4);
    expect(LEASE_SECONDS_TABLE.length).toBe(10);
  });

  it('`leaseSeconds = 0` 从**两个**实现都得到 LEASE_TTL_OUT_OF_RANGE（lease.ts:18 点名的那一对）', async () => {
    const now = at(0);
    expect(productionVerdict(now, 0)).toEqual({
      outcome: 'rejected',
      code: 'LEASE_TTL_OUT_OF_RANGE',
    });
    expect(await substituteVerdict(now, 0)).toEqual({
      outcome: 'rejected',
      code: 'LEASE_TTL_OUT_OF_RANGE',
    });
  });

  it('对表里每一个时长值，两边的判决（拒绝码或到期时刻）逐字相同', async () => {
    const now = at(0);
    const divergences: string[] = [];
    let leased = 0;
    let rejected = 0;
    for (const leaseSeconds of LEASE_SECONDS_TABLE) {
      const production = productionVerdict(now, leaseSeconds);
      const substitute = await substituteVerdict(now, leaseSeconds);
      if (production.outcome === 'leased') leased += 1;
      else rejected += 1;
      if (JSON.stringify(production) !== JSON.stringify(substitute)) {
        divergences.push(
          `leaseSeconds=${String(leaseSeconds)}: 生产 ${JSON.stringify(production)} vs 替身 ${JSON.stringify(substitute)}`,
        );
      }
    }
    // 正对照：配对本身不是空的。两个计数里任何一个为 0，都说明这张表只覆盖了一种结局。
    expect(leased, '表里没有任何被接受的时长').toBe(ACCEPTED_LEASE_SECONDS.length);
    expect(rejected, '表里没有任何被拒绝的时长').toBe(REJECTED_LEASE_SECONDS.length);
    expect(divergences).toEqual([]);
  });

  it('被接受时两边算出的到期时刻相同，且等于 now + leaseSeconds', () => {
    // 只比"拒/不拒"会漏掉一种漂移：两边都接受，但一边多算了一秒。那种漂移的表现是
    // 生产的租约比替身短，于是接管窗口提前打开 —— 仍然是"生产比替身宽松"。
    const now = at(0);
    for (const leaseSeconds of ACCEPTED_LEASE_SECONDS) {
      expect(leaseUntilOf(now, leaseSeconds)).toBe(at(leaseSeconds));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Layer B：真 Postgres 上的领取互斥、令牌所有权、CAS 与 bigint 精度            */
/* -------------------------------------------------------------------------- */

const harness = await createTestDatabaseHarness();

afterAll(async () => {
  await harness.dispose();
});

beforeAll(async () => {
  await harness.adapter.migrate();
});

type CountRow = { readonly n: string };

type LeaseColumns = {
  readonly state: string;
  readonly revision: unknown;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_until: unknown;
};

const LEASE_COLUMNS_SQL = `
SELECT state, revision, lease_owner, lease_token, lease_until FROM ai_tasks WHERE id = $1`;

/** 文件头那一节讲的就是它。列与 payload 一起改，否则留给 `assertColumnMatches` 一颗雷。 */
const DRAIN_QUEUE_SQL = `
UPDATE ai_tasks
SET state = 'CANCELLED', payload = jsonb_set(payload, '{state}', '"CANCELLED"')
WHERE state = 'QUEUED'`;

beforeEach(async () => {
  await harness.adapter.transaction(async (tx) => {
    await tx.execute(DRAIN_QUEUE_SQL, []);
  });
});

/** `harness` 已非空（挂具拿不到库就抛），这一层只是把「这里要真库」写在调用点上。 */
function db(): TestDatabaseHarness {
  return harness;
}

async function leaseColumnsOf(taskId: TaskId): Promise<LeaseColumns> {
  const rows = await queryHarness<LeaseColumns>(db(), LEASE_COLUMNS_SQL, [taskId]);
  const [row] = rows;
  if (row === undefined) throw new Error(`夹具失败：ai_tasks 里没有 ${taskId}`);
  return row;
}

async function countQueued(): Promise<number> {
  const rows = await queryHarness<CountRow>(
    db(),
    "SELECT COUNT(*) AS n FROM ai_tasks WHERE state = 'QUEUED'",
    [],
  );
  return Number(rows[0]?.n ?? '-1');
}

/** 生产写句柄，不是裸 SQL：顺带让 `setTaskLease` 的"断言恰好 1 行"也参与测试。 */
async function forceLease(
  taskId: TaskId,
  owner: string | null,
  token: string | null,
  until: Timestamp | null,
): Promise<void> {
  await db().adapter.transaction(async (tx) => {
    await setTaskLease(tx, taskId, owner, token, until);
  });
}

function repository(): PostgresTaskRepository {
  return PostgresTaskRepository.of(db().adapter);
}

const CLAIM_INPUT = { workerId: 'worker-a', now: at(0), leaseSeconds: 60, limit: 1 } as const;

/** 一条合法的安全事件。`eventType` 只能取 `TASK_EVENT_TYPES` 的四个值之一。 */
function makeEvent(taskId: TaskId, sequence: number) {
  return createTaskEvent({
    taskId,
    sequence: BigInt(sequence),
    eventType: 'STATE_CHANGED',
    // 键名要过 `SAFE_KEY_PATTERN` 与 `FORBIDDEN_SAFE_KEY_PATTERN`；`from`/`to` 都干净。
    safePayload: { from: 'QUEUED', to: 'CLAIMED' },
    createdAt: at(5),
  });
}

describe('真 Postgres：跨连接池的领取互斥', () => {
  it('两个独立连接池抢**同一个**任务，恰好一个赢，输的拿到空数组', async () => {
    // 这是替身文件头第一条 ❌ 的兑现。仲裁者必须真的是数据库：两个池 ⇒ 两条真连接 ⇒
    // 两个真后端，`FOR UPDATE SKIP LOCKED` 才有东西可裁。共用一个池会被池排到同一条连接上。
    const task = await seedTask(db());
    const second = await secondaryAdapter(db());
    try {
      const left = PostgresTaskRepository.of(db().adapter);
      const right = PostgresTaskRepository.of(second.adapter);
      const [a, b] = await Promise.all([
        left.claim({ ...CLAIM_INPUT, workerId: 'worker-a' }),
        right.claim({ ...CLAIM_INPUT, workerId: 'worker-b' }),
      ]);
      const winner = a.length === 1 ? a[0] : b[0];
      const winnerWorker = a.length === 1 ? 'worker-a' : 'worker-b';
      expect([a.length, b.length], '两边必须是一赢一输').toEqual(expect.arrayContaining([1, 0]));
      expect(a.length + b.length, '恰好一个租约被铸出').toBe(1);
      expect(winner?.taskId).toBe(task.id);

      const columns = await leaseColumnsOf(task.id);
      expect(columns.state).toBe('CLAIMED');
      expect(columns.lease_owner).toBe(winnerWorker);
      // 行上的令牌必须是赢者的那一个 —— 「只有一个赢」不只是返回值的形状，还得落到了库里。
      expect(columns.lease_token).toBe(winner?.leaseToken);
      expect(columns.lease_until).not.toBeNull();
    } finally {
      await second.dispose();
    }
  });

  it('两个独立连接池各领一个（limit 1，队列里两个任务），互不相同且都不为空', async () => {
    // 比上一条更强：`SKIP LOCKED` 的语义是"跳过被锁的行去拿下一行"，不是"阻塞等锁"。
    // 少了 `SKIP LOCKED`，第二个 worker 会阻塞到第一个提交，然后读到一行已经变成
    // `CLAIMED` 的任务、白跑一趟 —— 那条路上本用例会红（有一边拿到空数组）。
    const first = await seedTask(db());
    const second = await seedTask(db());
    const other = await secondaryAdapter(db());
    try {
      const left = PostgresTaskRepository.of(db().adapter);
      const right = PostgresTaskRepository.of(other.adapter);
      const [a, b] = await Promise.all([
        left.claim({ ...CLAIM_INPUT, workerId: 'worker-a' }),
        right.claim({ ...CLAIM_INPUT, workerId: 'worker-b' }),
      ]);
      expect(a, 'worker-a 应当恰好领到一个').toHaveLength(1);
      expect(b, 'worker-b 应当恰好领到一个').toHaveLength(1);
      const claimed = [a[0]?.taskId, b[0]?.taskId].sort();
      expect(claimed, '两个 worker 领到了同一个任务').toEqual([first.id, second.id].sort());
      expect(await countQueued(), '两个任务都该离开队列').toBe(0);
    } finally {
      await other.dispose();
    }
  });

  it('正对照：同一个适配器上顺序领取两次，第一次拿到、第二次队列已空', async () => {
    // 没有这一条，上面两个用例的"恰好一个赢"可能来自夹具根本没播种成功。
    await seedTask(db());
    expect(await countQueued(), '正对照：播种确实产出了一个可领任务').toBe(1);
    const repo = repository();
    const first = await repo.claim({ ...CLAIM_INPUT, workerId: 'worker-a' });
    const second = await repo.claim({ ...CLAIM_INPUT, workerId: 'worker-b' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('领取语句真的带 FOR UPDATE，而 ORDER BY 的 COALESCE 决定了索引供不出次序', async () => {
    // 替身文件头第二条 ❌ 的后半句：「索引是否真的被用上（`(next_run_at)`）」。
    // 关掉顺序扫不是作弊，而是把"优化器**能不能**用这条索引"与"在一张只有几行的表上
    // 它**愿不愿意**用"分开 —— 后者永远选顺序扫，于是那条 ❌ 在小库上根本问不出答案。
    //
    // `SET LOCAL` 与 `EXPLAIN` 必须分两次发：node-pg 的参数化（extended）协议不接受一次
    // 提交多条语句，`SET LOCAL …; EXPLAIN …` 会报
    // `cannot insert multiple commands into a prepared statement`。而 `SET LOCAL` 只在事务内
    // 有效，所以两条都放进同一个 `transaction`。
    //
    // 列名是 `QUERY PLAN`（带空格、大写）—— PostgreSQL 对 `EXPLAIN` 输出列的固定命名，
    // 而且**不能**在语句里给它起别名。按 `row.plan` 取会得到 11 个 `undefined`，
    // join 出来是一串空行，看起来像"计划里没有索引"，实际是键名读错了。
    const planOf = (sql: string): Promise<string> =>
      db().adapter.transaction(async (tx) => {
        await tx.execute('SET LOCAL enable_seqscan = off', []);
        const plan = await tx.query<{ readonly 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, [
          at(0),
          10,
        ]);
        return plan.map((row) => row['QUERY PLAN']).join('\n');
      });
    const text = await planOf(AI_TASK_SELECT_DUE_FOR_CLAIM_SQL);

    // 只断言**由 SQL 文本决定**的两件事。第一件是互斥的来源：`FOR UPDATE` 真的在驱动发出的
    // 语句里（不是只写在常量字符串里好看），所以计划里有 `LockRows` 节点。
    expect(text, `计划里应当有 LockRows 节点；实际计划：\n${text}`).toContain('LockRows');
    // 第二件是那条 ❌ 的真实答案的一半：出现了独立的排序节点，而排序键是 `COALESCE` 表达式。
    expect(text, `计划里应当有显式 Sort 节点；实际计划：\n${text}`).toContain('Sort Key:');
    expect(text, `排序键应当是 COALESCE 表达式；实际计划：\n${text}`).toContain(
      'COALESCE(next_run_at',
    );

    // 正对照：把加锁子句从**同一条**语句里摘掉，`LockRows` 就消失。没有这一步，上面那条
    // `toContain('LockRows')` 只证明了"计划文本里有这个词"，没证明它来自 `FOR UPDATE`。
    // 用锚在末尾的正则而不是字面量：常量里子句前是**换行**，写成 `' FOR UPDATE …'` 匹配不上，
    // `replace` 静默返回原串，正对照就成了空的 —— 那条 `not.toBe` 守卫正是为此存在。
    const unlocked = AI_TASK_SELECT_DUE_FOR_CLAIM_SQL.replace(/\s*FOR UPDATE SKIP LOCKED$/, '');
    expect(unlocked, '摘除必须真的改到语句，否则这条正对照是空的').not.toBe(
      AI_TASK_SELECT_DUE_FOR_CLAIM_SQL,
    );
    const unlockedPlan = await planOf(unlocked);
    expect(
      unlockedPlan,
      `摘掉加锁子句后不该再有 LockRows；实际计划：\n${unlockedPlan}`,
    ).not.toContain('LockRows');

    // ## 刻意**不**断言优化器选了哪条索引 —— 实测那是统计信息的函数，不是契约
    //
    // 这一条最初写的是 `toContain('ai_tasks_queue_idx')`，而且在整个文件跑下来时是绿的。
    // 用故意写错的期望值做负对照时才看见真相：**单独**跑本用例（表是空的）优化器选的是
    // `ai_tasks_one_active_per_project`，`next_run_at` 只出现在 `Filter` 里；跑完前面几个
    // 用例（表里已经有行）才换成 `ai_tasks_queue_idx`，而且是 `BitmapOr` 把 `IS NULL` 与
    // `<= $1` 两个析取分支各扫一次。两份实测计划（PostgreSQL 17.11）：
    //
    //     空表：  Bitmap Index Scan on ai_tasks_one_active_per_project
    //               Recheck Cond: (state <> ALL ('{SUCCEEDED,FAILED,…}'))
    //               Filter: ((next_run_at IS NULL) OR (next_run_at <= …)) AND (state = 'QUEUED')
    //     有行：  BitmapOr
    //               -> Bitmap Index Scan on ai_tasks_queue_idx  Index Cond: (next_run_at IS NULL)
    //               -> Bitmap Index Scan on ai_tasks_queue_idx  Index Cond: (next_run_at <= …)
    //
    // 所以那句"绿"是**由用例执行顺序供给的**：它钉的不是驱动行为，而是前面的用例在表里留了
    // 多少行。放宽成"两个索引名任一即可"只是把假绿换个写法，因此改成只断言上面三件与统计
    // 无关的事实，索引这件事作为**已申报的发现**记进交付说明：`(next_run_at, id)` 能被
    // `WHERE` 的析取用上，但**永远供不出这条查询的次序**，因为次序键是
    // `COALESCE(next_run_at, (payload->>'createdAt')::timestamptz)` —— 表达式排序不由列索引供给。
  });
});

describe('真 Postgres：令牌是唯一的所有权凭据', () => {
  it('接管过期租约后状态不变、令牌换掉，旧令牌续租得到 null', async () => {
    // `SESSION_CREATING` 而不是 `CLAIMED`：`canRequeueOnLeaseExpiry` 只认 `CLAIMED`，
    // 于是这个状态上"接管"与"退回队列"两条路可区分（下面那组用例钉另一半）。
    const task = await seedTask(db(), { state: 'SESSION_CREATING' });
    const staleToken = brand<string, 'LeaseToken'>('lease_deadbeef_deadbeefdeadbeef');
    await forceLease(task.id, 'worker-dead', staleToken, at(30));

    const repo = repository();
    const stale = {
      taskId: task.id,
      leaseToken: staleToken,
      leaseUntil: at(30),
      revision: task.revision,
    };
    const taken = await repo.reacquireLease({
      taskId: task.id,
      workerId: 'worker-live',
      now: at(120),
      leaseSeconds: 60,
    });
    expect(taken, '过期租约应当能被接管').not.toBeNull();
    expect(taken?.leaseToken, '接管必须换令牌，否则旧持有者仍自认有效').not.toBe(staleToken);
    expect(taken?.leaseUntil).toBe(at(180));

    const columns = await leaseColumnsOf(task.id);
    // §3.5：接管**不换状态**。`SESSION_CREATING` 崩掉时 QCA Session 还活着，退回 `QUEUED`
    // 会让下一个实例重新调用 provider —— 那是重复计费。
    expect(columns.state, '接管不得改变状态').toBe('SESSION_CREATING');
    expect(columns.lease_owner).toBe('worker-live');
    expect(columns.lease_token).toBe(taken?.leaseToken);

    // 旧 worker 醒来收尾：它手里的令牌已经不是行上那一个了。
    expect(await repo.renewLease({ lease: stale, now: at(130), leaseSeconds: 60 })).toBeNull();
    // 而它的一次"正常释放"也不能抹掉新持有者的推进权（§3.5 步骤 4：仅匹配自己的 token）。
    await repo.releaseLease({ lease: stale, now: at(131) });
    const afterStaleRelease = await leaseColumnsOf(task.id);
    expect(afterStaleRelease.lease_owner, '旧持有者的释放清掉了新租约').toBe('worker-live');
    expect(afterStaleRelease.lease_token).toBe(taken?.leaseToken);
  });

  it('新持有者自己释放时，三列租约一起变 NULL，实体一个字段都不动', async () => {
    const task = await seedTask(db());
    const [lease] = await repository().claim({ ...CLAIM_INPUT, workerId: 'worker-a' });
    if (lease === undefined) throw new Error('正对照失败：任务本应可领');
    const before = await repository().findById(task.id);

    await repository().releaseLease({ lease, now: at(10) });
    const columns = await leaseColumnsOf(task.id);
    expect(columns.lease_owner).toBeNull();
    expect(columns.lease_token).toBeNull();
    expect(columns.lease_until).toBeNull();
    // 释放租约**不动实体**：state 仍是 CLAIMED，revision 仍是领取时那一个。
    expect(columns.state).toBe('CLAIMED');
    expect(await repository().findById(task.id)).toEqual(before);
  });

  it('续租把到期时刻推后，且不因任务被推进过而失败', async () => {
    const task = await seedTask(db());
    const repo = repository();
    const [lease] = await repo.claim({ ...CLAIM_INPUT, workerId: 'worker-a' });
    if (lease === undefined) throw new Error('正对照失败：任务本应可领');
    expect(lease.leaseUntil, '正对照：领取时铸出的到期时刻').toBe(at(60));
    const renewed = await repo.renewLease({ lease, now: at(30), leaseSeconds: 60 });
    expect(renewed?.leaseUntil).toBe(at(90));
    expect(renewed?.leaseToken, '续租不换令牌').toBe(lease.leaseToken);
    // 到期时刻真的落到了库里，不只是返回值里好看：`at(90)` = EPOCH + 90s。
    // 走 `fromTimestamptz` 而不是 `String(date)`：node-pg 把 timestamptz 读成 `Date`，
    // `String()` 出来是**本机时区**的文本（GMT+8 上是 `08:01:30`），那条断言就会只在 UTC
    // 机器上过 —— 正是 `support.ts` 文件头禁止的"依赖宿主状态、分歧不报错"。
    expect(fromTimestamptz((await leaseColumnsOf(task.id)).lease_until)).toBe(at(90));
  });

  it('未过期的租约不能被别人接管', async () => {
    const task = await seedTask(db(), { state: 'SESSION_CREATING' });
    await forceLease(task.id, 'worker-live', 'lease_cafebabe_0011223344556677', at(300));
    const taken = await repository().reacquireLease({
      taskId: task.id,
      workerId: 'worker-thief',
      now: at(120),
      leaseSeconds: 60,
    });
    expect(taken, '租约未到期就被接管＝两个推进器同时驱动一个任务').toBeNull();
    expect((await leaseColumnsOf(task.id)).lease_owner).toBe('worker-live');
  });

  it('不存在的 task 上接管／续租都得到 null，而不是抛', async () => {
    const ghostId = makeTask().id;
    const repo = repository();
    expect(
      await repo.reacquireLease({ taskId: ghostId, workerId: 'w', now: at(0), leaseSeconds: 60 }),
    ).toBeNull();
    expect(
      await repo.renewLease({
        lease: {
          taskId: ghostId,
          leaseToken: brand<string, 'LeaseToken'>('lease_00000001_0011223344556677'),
          leaseUntil: at(60),
          revision: brand<string, 'Revision'>('1'),
        },
        now: at(0),
        leaseSeconds: 60,
      }),
    ).toBeNull();
  });
});

describe('真 Postgres：租约过期回退仅限 CLAIMED', () => {
  it('CLAIMED + 已过期 ⇒ 退回 QUEUED 并交出三列租约', async () => {
    const task = await seedTask(db());
    const [lease] = await repository().claim({ ...CLAIM_INPUT, workerId: 'worker-a' });
    expect(lease, '正对照：任务本应可领').toBeDefined();

    expect(await repository().requeueOnLeaseExpiry({ taskId: task.id, now: at(600) })).toBe(true);
    const columns = await leaseColumnsOf(task.id);
    expect(columns.state).toBe('QUEUED');
    // 留着 lease_until 会让它立刻又被 `canReacquireLease` 判成孤儿。
    expect(columns.lease_owner).toBeNull();
    expect(columns.lease_token).toBeNull();
    expect(columns.lease_until).toBeNull();
  });

  it('SESSION_CREATING + 已过期 ⇒ false（已有外部副作用，退回会让 provider 被重复调用）', async () => {
    const task = await seedTask(db(), { state: 'SESSION_CREATING' });
    await forceLease(task.id, 'worker-dead', 'lease_deadbeef_deadbeefdeadbeef', at(30));
    expect(await repository().requeueOnLeaseExpiry({ taskId: task.id, now: at(600) })).toBe(false);
    expect((await leaseColumnsOf(task.id)).state).toBe('SESSION_CREATING');
  });

  it('CLAIMED + **未**过期 ⇒ false，且三列租约原样留着', async () => {
    const task = await seedTask(db());
    const [lease] = await repository().claim({ ...CLAIM_INPUT, workerId: 'worker-a' });
    expect(lease, '正对照：任务本应可领').toBeDefined();
    const before = await leaseColumnsOf(task.id);

    // `now` 在到期时刻之前：这一次不是"过期回退"，而是一次不该被批准的抢占。
    expect(await repository().requeueOnLeaseExpiry({ taskId: task.id, now: at(30) })).toBe(false);
    expect(await leaseColumnsOf(task.id)).toEqual(before);
  });
});

describe('真 Postgres：revision CAS 返回 null 而不抛', () => {
  it('期望版本不匹配 ⇒ null，且行一个字节都没变', async () => {
    const task = await seedTask(db());
    const before = await leaseColumnsOf(task.id);
    const saved = await repository().save({
      task,
      expectedRevision: brand<string, 'Revision'>('99'),
    });
    expect(saved, 'CAS 不匹配必须返回 null（端口约定：不抛）').toBeNull();
    expect(await leaseColumnsOf(task.id)).toEqual(before);
  });

  it('期望版本匹配 ⇒ 返回实体，且 revision 落到了库里', async () => {
    const task = await seedTask(db());
    const saved = await repository().save({ task, expectedRevision: task.revision });
    expect(saved).toEqual(task);
    expect(String((await leaseColumnsOf(task.id)).revision)).toBe(task.revision);
  });

  it('save 一个**不存在**的 task ⇒ null，且没有凭空插出一行（申报的差异 2）', async () => {
    const seeded = await seedTask(db());
    // 用真项目/真账号，只让 id 是新的：否则外键会先炸，用例测到的就不是"没有 INSERT"。
    const ghost = makeTask({
      projectId: seeded.projectId,
      requestedBy: seeded.requestedBy,
      revision: '1',
    });
    expect(await repository().save({ task: ghost, expectedRevision: ghost.revision })).toBeNull();
    const rows = await queryHarness<CountRow>(
      db(),
      'SELECT COUNT(*) AS n FROM ai_tasks WHERE id = $1',
      [ghost.id],
    );
    expect(rows[0]?.n, 'save 不得兼作 INSERT：那会造出一个没有受理证据的 task 行').toBe('0');
  });

  it('appendEvent 在期望版本不匹配时返回 null，且不写事件', async () => {
    const task = await seedTask(db());
    const result = await repository().appendEvent({
      event: makeEvent(task.id, 1),
      expectedRevision: brand<string, 'Revision'>('99'),
    });
    expect(result).toBeNull();
    const rows = await queryHarness<CountRow>(
      db(),
      'SELECT COUNT(*) AS n FROM task_events WHERE task_id = $1',
      [task.id],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('appendEvent 在期望版本匹配时写事件并把 revision 推进一格', async () => {
    const task = await seedTask(db());
    const bumped = await repository().appendEvent({
      event: makeEvent(task.id, 1),
      expectedRevision: task.revision,
    });
    expect(bumped?.revision).toBe('2');
    expect(String((await leaseColumnsOf(task.id)).revision)).toBe('2');
    const rows = await queryHarness<{ readonly event_type: string }>(
      db(),
      'SELECT event_type FROM task_events WHERE task_id = $1 ORDER BY sequence ASC',
      [task.id],
    );
    expect(rows.map((row) => row.event_type)).toEqual(['STATE_CHANGED']);
  });
});

describe('真 Postgres：非法租约时长在开事务之前就拒（申报的差异 1）', () => {
  it('空队列上 leaseSeconds = 0 也抛 LEASE_TTL_OUT_OF_RANGE，而替身在这种情况下返回空数组', async () => {
    // 正对照：队列此刻确实是空的（`beforeEach` 清过），否则本用例测的就不是"空队列"。
    const drained = await repository().claim({
      ...CLAIM_INPUT,
      workerId: 'worker-drain',
      limit: 100,
    });
    expect(drained).toEqual([]);
    expect(await countQueued(), '夹具应当已把队列领空').toBe(0);

    let thrown: unknown = null;
    try {
      await repository().claim({ workerId: 'worker-a', now: at(0), leaseSeconds: 0, limit: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('LEASE_TTL_OUT_OF_RANGE');

    // 同输入打到替身上：空队列 ⇒ `[]`，不抛。这条差异是**收紧**（§8 只禁止放宽），
    // 把它写下来，免得将来有人以为两边"应当"完全同形而把生产的先验拆掉。
    const memory = new InMemoryTaskRepository();
    expect(
      await memory.claim({ workerId: 'worker-a', now: at(0), leaseSeconds: 0, limit: 1 }),
    ).toEqual([]);
  });

  it('limit 非法时返回空数组而不抛，且不动库', async () => {
    const task = await seedTask(db());
    const repo = repository();
    for (const limit of [0, -1, 1.5]) {
      expect(await repo.claim({ ...CLAIM_INPUT, limit }), `limit=${limit} 应当返回空数组`).toEqual(
        [],
      );
    }
    const columns = await leaseColumnsOf(task.id);
    expect(columns.state).toBe('QUEUED');
    expect(columns.lease_token).toBeNull();
  });
});

describe('真 Postgres：领取是原子的', () => {
  it('批次里一个任务的 payload 损坏 ⇒ 整批回滚，同批的另一个任务不留半个领取', async () => {
    const healthy = await seedTask(db());
    const poisoned = await seedTask(db());
    // 注入：只改 payload 的一个字段，`state` 列仍是 QUEUED，于是它照样会被队列查询选中，
    // 然后在 `taskFromRow` → `createAiTask` 上抛。改 `state` 不行 —— 那样它就压根不被选中，
    // 用例会在"什么都没发生"上绿掉。
    await db().adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE ai_tasks SET payload = jsonb_set(payload, '{kind}', '"NOT_A_KIND"') WHERE id = $1`,
        [poisoned.id],
      );
    });

    let thrown: unknown = null;
    try {
      await repository().claim({ ...CLAIM_INPUT, workerId: 'worker-a', limit: 10 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, '损坏的 payload 必须炸出来，不能被静默跳过').not.toBeNull();

    // §11.2 的形状：注入 → 确认红 → 恢复 → 确认绿。这里是"红"的那一半：
    // 一个健康的任务不能因为同批里另一个坏了就被留在 CLAIMED 却没有租约的半成品状态。
    for (const taskId of [healthy.id, poisoned.id]) {
      const columns = await leaseColumnsOf(taskId);
      expect(columns.state, `${taskId} 在回滚后仍是被领取的样子`).not.toBe('CLAIMED');
      expect(columns.lease_owner).toBeNull();
      expect(columns.lease_token).toBeNull();
    }

    // 恢复：把 payload 修回去，同一个仓储立刻能正常领取 —— 证明上面的红来自注入，不来自夹具。
    await db().adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE ai_tasks SET payload = jsonb_set(payload, '{kind}', '"VIBE_TURN"') WHERE id = $1`,
        [poisoned.id],
      );
    });
    const recovered = await repository().claim({ ...CLAIM_INPUT, workerId: 'worker-a', limit: 10 });
    expect(recovered, '恢复后应当能领到两个任务').toHaveLength(2);
    expect(recovered.map((lease) => lease.taskId).sort(), '领到的应当正是这两个任务').toEqual(
      [healthy.id, poisoned.id].sort(),
    );
  });
});

describe('真 Postgres：findById 往返与 bigint 精度', () => {
  it('未知 id ⇒ null（不是抛，也不是一个空实体）', async () => {
    await seedTask(db());
    expect(await repository().findById(makeTask().id)).toBeNull();
  });

  it('播种的任务读回来与写进去的逐字段相同', async () => {
    const task = await seedTask(db(), { idempotencyKey: 'idem-roundtrip-1', nextRunAt: at(45) });
    expect(await repository().findById(task.id)).toEqual(task);
  });

  it('revision 超过 Number.MAX_SAFE_INTEGER 时往返不丢精度（§4 条 2 逐字要求）', async () => {
    // 2^53 + 1：JS number 表示不了它（`9007199254740993 === 9007199254740992` 为真），
    // 所以只要中途过一次 Number，读回来必然变成偶数。这两条正对照把"测试值确实越界"钉住，
    // 否则用一个小数字跑这条用例也会绿，而它什么都证明不了。
    const beyondSafe = '9007199254740993';
    expect(Number(beyondSafe) > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(Number(beyondSafe).toString(), '这个值经 Number 必然变形').not.toBe(beyondSafe);

    const task = await seedTask(db(), { revision: beyondSafe });
    const loaded = await repository().findById(task.id);
    expect(loaded?.revision, 'bigint 列必须按十进制**字符串**回到调用方').toBe(beyondSafe);
    expect(String((await leaseColumnsOf(task.id)).revision)).toBe(beyondSafe);
  });
});

/**
 * `database-transaction-atomicity` —— 端口 1 的行为不变量（ZLQ-194 §6.2、arch §6.1）。
 *
 * ## 为什么这条能力值得单独一个文件
 * `five-port-contract` 证明的是**形状**：五个端口都声明了、方法都在、类型键集合对得上。
 * 但 `DatabaseAdapter` 注释里真正要紧的话是行为约定 ——「`work` 抛错 ⇒ 回滚且不返回它的
 * 值；正常返回 ⇒ 提交」，以及「所有 revision CAS 都必须落在一个事务里」。形状断言碰不到
 * 这两句：一个把提交缓冲做成实例字段、回滚时照样 flush 的实现，方法签名完全一样，
 * `five-port-contract` 会绿。本文件就是让那两句话可红可绿。
 *
 * ## 诚实分层（ZLQ-194 §16）：替身证明到哪一步为止
 * `InMemoryDatabaseAdapter` **不解释 SQL** —— 它只记录「哪些语句在哪个事务里发出过、
 * 哪个事务提交了」。所以本文件能证明的是：
 *   ✅ 提交点唯一、且在 `work` 正常返回之后；抛错 ⇒ 一条都不留（含抛错前已发出的）；
 *   ✅ 事务之间缓冲互不串味；事务计数在异常路径上不泄漏；
 *   ✅ `migrate()` 幂等，且中途失败时「已应用清单」本身一起回滚；
 *   ✅ `health().detail` 只装内部错误码或 null，结构上装不下驱动原文（含连接串）。
 * 本文件**不能**证明、明确留给 D5/D6 的：
 *   ❌ 真 PostgreSQL 的 `BEGIN/COMMIT/ROLLBACK` 语义、隔离级别、死锁重试；
 *   ❌ Neon 运行时池化 URL 与迁移期直连 URL 两条连接的实际接线；
 *   ❌ 跨进程的事务互斥（替身活在单进程里，`task-lease-cas` 里有同一条声明）；
 *   ❌ 真 SQL 语句本身的正确性 —— 替身不解析它，`execute` 的返回值来自注入的 backend。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  INFRA_ERROR_CODES,
  InMemoryDatabaseAdapter,
  type DatabaseTransaction,
  type InfraErrorCode,
} from '../src/index.js';
import { rejectedCode } from './support.js';

const CAPABILITY = 'database-transaction-atomicity';

const SOURCE_PATH = fileURLToPath(new URL('../src/reference-backends.ts', import.meta.url));

/**
 * 一句**故意带上假连接串**的驱动原文报错。它不是真凭据，是一个形状样本，用来断言
 * `health().detail` 装不下这种东西 —— 真报错里带的正是这样的串（DSN 含用户名与口令）。
 */
const RAW_DRIVER_MESSAGE =
  'connect ECONNREFUSED postgresql://littleq:not-a-real-password@ep-sample.invalid:5432/littleq';

interface FakeBackend extends DatabaseTransaction {
  /** 按调用顺序记下的每条语句。 */
  readonly calls: string[];
  /** 置为某条语句 ⇒ 下一次执行到它时抛 `RAW_DRIVER_MESSAGE`；置为 null ⇒ 不再失败。 */
  failOn: string | null;
}

/**
 * 一个把每条语句都记下来的 backend。
 *
 * `failOn` 是**可切换**的，这不是随手留的口子：`migrate()` 的原子性只在「先失败、后成功」
 * 这一条时间线上才可观测 —— 一个构造完就固定失败的 backend 永远测不出「失败时已应用清单
 * 有没有一起回滚」，因为没有第二次机会去暴露它。
 */
function fakeBackend(options: { readonly affected?: number } = {}): FakeBackend {
  const calls: string[] = [];
  const backend: FakeBackend = {
    calls,
    failOn: null,
    async query<TRow>(sql: string): Promise<readonly TRow[]> {
      calls.push(sql);
      if (backend.failOn !== null && sql === backend.failOn) throw new Error(RAW_DRIVER_MESSAGE);
      return [] as readonly TRow[];
    },
    async execute(sql: string): Promise<number> {
      calls.push(sql);
      if (backend.failOn !== null && sql === backend.failOn) throw new Error(RAW_DRIVER_MESSAGE);
      return options.affected ?? 1;
    },
  };
  return backend;
}

/**
 * 取出某个方法的源码正文（到下一个同缩进成员为止），用来做结构性断言。
 *
 * 用**行首锚定的正则**而不是 `indexOf('  async name(')`：`transaction` 是泛型方法，
 * 源码里写的是 `async transaction<T>(`，带左括号的字面量匹配不到它 —— 那种写法会让本用例
 * 报「找不到方法」，看起来像扫描器坏了，其实是扫描器自己被一个签名细节绊住了。
 */
function methodBody(name: string): string {
  const text = readFileSync(SOURCE_PATH, 'utf8');
  const start = text.search(new RegExp(`^  async ${name}[<(]`, 'm'));
  if (start < 0) throw new Error(`找不到方法 ${name}`);
  const rest = text.slice(start);
  const next = rest.slice(2).search(/\n {2}(?:async |get |readonly #|#|[a-zA-Z])/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

describe(CAPABILITY, () => {
  it(`${CAPABILITY}: work 正常返回 ⇒ 提交，语句按发出顺序落进 committedStatements`, async () => {
    const backend = fakeBackend();
    const db = new InMemoryDatabaseAdapter({ backend });

    const returned = await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO ai_tasks (id) VALUES ($1)', ['t1']);
      await tx.query('SELECT id FROM ai_tasks', []);
      await tx.execute('UPDATE ai_tasks SET revision = $1 WHERE id = $2', ['r2', 't1']);
      return 'work-result';
    });

    expect(returned).toBe('work-result');
    expect(db.committedStatements).toEqual([
      'INSERT INTO ai_tasks (id) VALUES ($1)',
      'SELECT id FROM ai_tasks',
      'UPDATE ai_tasks SET revision = $1 WHERE id = $2',
    ]);
    expect(db.openTransactions).toBe(0);
    expect(db.closed).toBe(false);
    // 反空转：backend 真的被调到了，语句不是只在缓冲里过了一遍。
    expect(backend.calls).toHaveLength(3);
  });

  it(`${CAPABILITY}: work 抛错 ⇒ 一条都不提交，连抛错前已发出的也回滚`, async () => {
    const db = new InMemoryDatabaseAdapter({ backend: fakeBackend() });

    const boom = new Error('业务逻辑失败');
    let surfaced: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute('DELETE FROM ai_tasks WHERE id = $1', ['t1']);
        await tx.execute('UPDATE projects SET updated_at = now()', []);
        throw boom;
      });
    } catch (error) {
      surfaced = error;
    }
    // 抛的是 `work` 自己的错，**原样透出**（不被翻译成 infra 码）：调用方要靠它做控制流，
    // 而且端口注释写的是「不返回它的值」，不是「换个错再抛」。
    expect(surfaced).toBe(boom);
    expect(db.committedStatements).toEqual([]);
    expect(db.openTransactions).toBe(0);

    // **反空转对照**：同一个 db 上做一次成功的事务，语句确实会落进去。
    // 没有这一步，上面的 `toEqual([])` 在一个「什么都不记录」的实现上也会绿。
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO ok VALUES (1)', []);
    });
    expect(db.committedStatements).toEqual(['INSERT INTO ok VALUES (1)']);
  });

  it(`${CAPABILITY}: 提交点唯一 —— 事务交错了也不串味，失败方的语句一个字都不漏给成功方`, async () => {
    const db = new InMemoryDatabaseAdapter({ backend: fakeBackend() });

    // A 与 B 同时进行：A 会提交，B 会在发出两条语句之后抛错。
    // 一个把缓冲做成实例字段（而不是每次 `transaction` 一个局部数组）的实现，
    // 会让 B 的语句混进 A 的提交里 —— 这就是本用例要抓的缺陷。
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = db.transaction(async (tx) => {
      await tx.execute('A-first', []);
      await gateA;
      await tx.execute('A-second', []);
      return 'A';
    });
    const b = db.transaction(async (tx) => {
      await tx.execute('B-first', []);
      await tx.execute('B-second', []);
      throw new Error('B 失败');
    });

    // `transaction` 在第一个 await 之前就把计数加上去了，所以这里同步可读。
    expect(db.openTransactions).toBe(2);
    await expect(b).rejects.toThrow('B 失败');
    // B 已经结束、A 还开着：计数必须只减一 —— 不减是泄漏，归零是把 A 也算成结束了。
    expect(db.openTransactions).toBe(1);
    // B 已失败但 A 未提交 ⇒ 此刻**一条都不该出现**（B 回滚 + A 还没走到提交点）。
    expect(db.committedStatements).toEqual([]);

    releaseA();
    expect(await a).toBe('A');
    expect(db.openTransactions).toBe(0);
    expect(db.committedStatements).toEqual(['A-first', 'A-second']);
  });

  it(`${CAPABILITY}: 没有注入 backend 时 execute 返回 0 —— 那正是端口注释里的 CAS 失败信号`, async () => {
    const db = new InMemoryDatabaseAdapter();
    await db.transaction(async (tx) => {
      // 一个不解释 SQL 的实现只能诚实地报「什么都没改到」。调用方据此把「改到 0 行」
      // 识别成一次输掉的 CAS，而不是成功 —— 这条约定必须在本层就能跑通。
      expect(await tx.execute('UPDATE ai_tasks SET state = $1 WHERE revision = $2', [])).toBe(0);
      expect(await tx.query('SELECT 1', [])).toEqual([]);
    });
    expect(db.committedStatements).toHaveLength(2);

    // 对照：注入了 backend，`execute` 就把 backend 的行数透出来，不再恒为 0。
    const withBackend = new InMemoryDatabaseAdapter({ backend: fakeBackend({ affected: 7 }) });
    await withBackend.transaction(async (tx) => {
      expect(await tx.execute('UPDATE x SET y = 1', [])).toBe(7);
    });
  });

  it(`${CAPABILITY}: migrate 幂等 —— 第二次调用 applied 为空、schemaVersion 不动、语句不重放`, async () => {
    const backend = fakeBackend();
    const db = new InMemoryDatabaseAdapter({
      backend,
      migrations: [
        {
          id: '0001_init',
          statements: [
            'CREATE TABLE ai_tasks (id uuid)',
            'CREATE INDEX next_run_at ON ai_tasks (y)',
          ],
        },
        { id: '0002_events', statements: ['CREATE TABLE task_events (id text)'] },
      ],
    });

    const first = await db.migrate();
    expect(first.applied).toEqual(['0001_init', '0002_events']);
    expect(first.schemaVersion).toBe(2);
    expect(backend.calls).toEqual([
      'CREATE TABLE ai_tasks (id uuid)',
      'CREATE INDEX next_run_at ON ai_tasks (y)',
      'CREATE TABLE task_events (id text)',
    ]);

    const second = await db.migrate();
    expect(second.applied).toEqual([]);
    expect(second.schemaVersion).toBe(2);
    // 幂等的真正含义是**语句不重放**：只断言 `applied` 为空，一个照样重放语句的实现也会绿。
    expect(backend.calls).toHaveLength(3);

    // 迁移整体在一个事务里 ⇒ 提交后语句出现在 committedStatements，且事务已关闭。
    expect(db.committedStatements).toHaveLength(3);
    expect(db.openTransactions).toBe(0);
  });

  it(`${CAPABILITY}: migrate 中途失败 ⇒ 已应用清单一起回滚，修好后两条都补齐`, async () => {
    const backend = fakeBackend();
    const migrations = [
      { id: '0001_init', statements: ['CREATE TABLE ai_tasks (id uuid)'] },
      { id: '0002_events', statements: ['CREATE TABLE task_events (id text)'] },
    ];
    const db = new InMemoryDatabaseAdapter({ backend, migrations });

    backend.failOn = 'CREATE TABLE task_events (id text)';
    await expect(db.migrate()).rejects.toThrow(RAW_DRIVER_MESSAGE);
    expect(db.committedStatements).toEqual([]);
    expect(db.openTransactions).toBe(0);

    // 关键的一步：把故障去掉之后重试，**两条都必须重新应用**。
    // 若 `#applied` 在事务提交之前就更新过，0001 会被当成已应用而跳过，
    // 于是库里永久缺一张表 —— 而 `applied` 只报 `['0002_events']`，看上去还挺合理。
    backend.failOn = null;
    const retried = await db.migrate();
    expect(retried.applied).toEqual(['0001_init', '0002_events']);
    expect(retried.schemaVersion).toBe(2);
    expect(backend.calls.filter((sql) => sql === 'CREATE TABLE ai_tasks (id uuid)')).toHaveLength(
      2,
    );
    expect(
      backend.calls.filter((sql) => sql === 'CREATE TABLE task_events (id text)'),
    ).toHaveLength(2);
    expect(db.committedStatements).toHaveLength(2);
  });

  it(`${CAPABILITY}: 迁移清单里的重复 id 只应用一次`, async () => {
    const backend = fakeBackend();
    const db = new InMemoryDatabaseAdapter({
      backend,
      migrations: [
        { id: '0001_init', statements: ['S1'] },
        { id: '0001_init', statements: ['S1-duplicate'] },
      ],
    });
    const report = await db.migrate();
    expect(report.applied).toEqual(['0001_init']);
    expect(report.schemaVersion).toBe(1);
    expect(backend.calls).toEqual(['S1']);
  });

  it(`${CAPABILITY}: health().detail 只装内部错误码或 null，结构上装不下驱动原文`, async () => {
    const db = new InMemoryDatabaseAdapter();

    const ok = await db.health();
    expect(ok.status).toBe('ok');
    expect(ok.detail).toBeNull();
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ok.checkedAt).toBeInstanceOf(Date);
    expect(Object.keys(ok).sort()).toEqual(['checkedAt', 'detail', 'latencyMs', 'status']);

    // 逐个内部码都试一遍：`detail` 必须**逐字**等于那个码，不多一个字。
    const probe: readonly InfraErrorCode[] = [
      'PROVIDER_UNAVAILABLE',
      'MASTER_KEY_UNAVAILABLE',
      'SECRET_DECRYPT_FAILED',
      'OBJECT_READ_GRANT_EXPIRED',
    ];
    for (const code of probe) {
      expect(INFRA_ERROR_CODES).toContain(code);
      db.failHealthWith(code);
      const degraded = await db.health();
      expect(degraded.status).toBe('degraded');
      expect(degraded.detail).toBe(code);
      expect(degraded.detail).not.toContain('postgres');
    }

    // 清掉故障 ⇒ 回到 ok。证明上面那圈不是「一旦 degraded 就永远 degraded」的假绿。
    db.failHealthWith(null);
    expect((await db.health()).status).toBe('ok');
    expect((await db.health()).detail).toBeNull();

    await db.close();
    const closed = await db.health();
    expect(closed.status).toBe('unavailable');
    expect(closed.detail).toBe('PROVIDER_UNAVAILABLE');
    expect(db.closed).toBe(true);
    // close 幂等。
    await db.close();
    expect(db.closed).toBe(true);
  });

  it(`${CAPABILITY}: 驱动原文（含假 DSN）会在事务路径上原样透出，但进不了 health`, async () => {
    // `health()` 根本不碰 backend，所以「原文报错传不进 detail」不是它克制，而是它**没有
    // 那条路径**。这件事运行时断言到不了，只能扫源码 —— 但要带对照，否则空正文也会绿。
    const healthBody = methodBody('health');
    expect(healthBody).toContain('#healthDetail');
    expect(healthBody).not.toContain('#backend');
    expect(healthBody).not.toContain('catch');

    // **反空转对照**：同一套扫描在 `transaction` 上必须报「有 `#backend`」。
    const transactionBody = methodBody('transaction');
    expect(transactionBody).toContain('#backend');
    expect(transactionBody.length).toBeGreaterThan(healthBody.length);

    // 而驱动原文确实会在**事务路径**上出现（原样透出，不被吞掉）。所以「它进不了 health」
    // 与「它哪儿都进不去」是两件事，前者才是本用例的主张。
    const backend = fakeBackend();
    backend.failOn = 'BOOM';
    const db = new InMemoryDatabaseAdapter({ backend });
    let surfaced: string | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute('BOOM', []);
      });
    } catch (error) {
      surfaced = (error as Error).message;
    }
    expect(surfaced).toBe(RAW_DRIVER_MESSAGE);
    expect(surfaced).toContain('not-a-real-password');

    // 同一次失败之后，health 仍然干干净净：没有 detail、没有原文、状态是 ok。
    const after = await db.health();
    expect(after.status).toBe('ok');
    expect(after.detail).toBeNull();
    expect(db.committedStatements).toEqual([]);
  });

  it(`${CAPABILITY}: close 之后 transaction 与 migrate 都报 PROVIDER_UNAVAILABLE，且不开事务`, async () => {
    const db = new InMemoryDatabaseAdapter({ backend: fakeBackend() });
    await db.close();

    expect(await rejectedCode(db.transaction(async () => 'never'))).toBe<InfraErrorCode>(
      'PROVIDER_UNAVAILABLE',
    );
    expect(await rejectedCode(db.migrate())).toBe<InfraErrorCode>('PROVIDER_UNAVAILABLE');
    expect(db.openTransactions).toBe(0);
    expect(db.committedStatements).toEqual([]);
  });

  it(`${CAPABILITY}: 端口注释里那条「CAS 必须落在一个事务里」在替身上真的可执行`, async () => {
    // 把 `TaskRepository.save` / `SecretStore.rotate` 用的那个「读版本 → 写版本」窗口写成
    // 一个事务，证明端口给的 `tx` 足以表达它：读到 0 行就返回 null，第三条语句根本不发出。
    const backend = fakeBackend({ affected: 0 });
    const db = new InMemoryDatabaseAdapter({ backend });

    const outcome = await db.transaction(async (tx) => {
      const rows = await tx.query<{ revision: string }>(
        'SELECT revision FROM ai_tasks WHERE id = $1',
        ['t1'],
      );
      const expected = rows[0]?.revision ?? 'r0';
      const affected = await tx.execute(
        'UPDATE ai_tasks SET revision = $1 WHERE id = $2 AND revision = $3',
        ['r1', 't1', expected],
      );
      if (affected === 0) return null;
      await tx.execute('INSERT INTO task_events VALUES ($1)', ['e1']);
      return 'saved';
    });

    expect(outcome).toBeNull();
    // 走了 CAS 失败分支 ⇒ 第三条语句**没发出**（不是发出后回滚）。
    expect(backend.calls).toHaveLength(2);
    // 但事务本身是成功返回的，所以前两条照常提交：CAS 落空是一次正常回答，不是错误。
    expect(db.committedStatements).toHaveLength(2);

    // 对照：affected ≠ 0 时第三条语句才发出，事务返回 'saved'。
    const hit = fakeBackend({ affected: 1 });
    const db2 = new InMemoryDatabaseAdapter({ backend: hit });
    const saved = await db2.transaction(async (tx) => {
      await tx.query('SELECT revision FROM ai_tasks WHERE id = $1', ['t1']);
      const affected = await tx.execute('UPDATE ai_tasks SET revision = $1', ['r1']);
      if (affected === 0) return null;
      await tx.execute('INSERT INTO task_events VALUES ($1)', ['e1']);
      return 'saved';
    });
    expect(saved).toBe('saved');
    expect(hit.calls).toHaveLength(3);
  });
});

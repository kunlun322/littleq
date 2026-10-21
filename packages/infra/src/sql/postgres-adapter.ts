import { infraError } from '../errors.js';
import type {
  DatabaseAdapter,
  DatabaseTransaction,
  MigrationReport,
} from '../ports/database-adapter.js';
import type { HealthResult } from '../types.js';
import type { SqlClient, SqlClientSource } from './client.js';
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  SCHEMA_MIGRATIONS_BOOTSTRAP_DDL,
  SQL_MIGRATIONS,
  migrationChecksum,
  type SqlMigration,
} from './migrations.js';

/**
 * `DatabaseAdapter` 的真实 Postgres 实现。
 *
 * ## 这个适配器承担什么、不承担什么
 *
 * 冻结端口的文件头写着「真正的 Neon 驱动接线是 D5 的事」；ZLQ-216 §10.2 把这件事交给
 * F1。它承担的是**四件**事，一件也不多：
 *
 * 1. 事务边界（`BEGIN` / `COMMIT` / 失败回滚）；
 * 2. `execute` 返回**受影响行数**，这是所有 CAS 的判据；
 * 3. 幂等的、按版本/checksum 驱动的迁移；
 * 4. 不把驱动原文泄漏进 `HealthResult.detail`。
 *
 * 它**不**承担业务：没有任何一句 SQL 认识 task、project 或 secret。§3.4 的六个事务边界
 * 由 §3.5 的两个装配端口（`TaskUnitOfWork` / `TaskPumpStore`）在这个 `transaction` 之上
 * 表达，仓储驱动只负责把行读成 domain 对象、把 domain 对象写回行。这样"哪些语句必须在
 * 同一个事务里"这件事只有装配端口知道，适配器无从越权。
 *
 * ## 一个事务 = 一个独占连接
 *
 * `transaction()` 每次 `connect()` 签出一个专用连接，`work` 里的所有语句都跑在它上面，
 * 结束时归还。这是原子性的**物理**前提：两个并发事务若共用一个后端会话，
 * `BEGIN`/`COMMIT` 会互相穿插，一个回滚会连带回滚另一个，而两边的调用方都收到了
 * "成功"。见 `sql/client.ts` 的 `connect()` 契约。
 *
 * ## 不支持嵌套事务
 *
 * 端口签名里没有 savepoint 的位置，本实现也不假装支持：在 `work` 里再调一次
 * `transaction()` 会签出**第二个**连接，两个事务互不相干，内层提交后外层回滚照样把
 * 外层写的东西撤掉，而内层写的留下了 —— 正是 §3.4 边界 5 明令禁止的"部分提交"。
 * §3.5 之所以把 `TaskTransaction` 的各个 handle 绑定到**同一个** `DatabaseTransaction`
 * 上、并且规定这些 handle「在事务外无法取得」，就是为了从结构上排除这条错误路径。
 */
export type PostgresDatabaseAdapterOptions = {
  readonly source: SqlClientSource;
  /** 缺省即 §3.2/§3.3 的那一份。测试可以传一份更小的清单来验证 runner 本身。 */
  readonly migrations?: readonly SqlMigration[];
};

export class PostgresDatabaseAdapter implements DatabaseAdapter {
  readonly #source: SqlClientSource;
  readonly #migrations: readonly SqlMigration[];
  #closed = false;

  constructor(options: PostgresDatabaseAdapterOptions) {
    this.#source = options.source;
    this.#migrations = options.migrations ?? SQL_MIGRATIONS;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    if (this.#closed) throw infraError('PROVIDER_UNAVAILABLE');
    const client = await this.#source.connect();
    let committed = false;
    try {
      await client.query('BEGIN', []);
      const result = await work(bindTransaction(client));
      await client.query('COMMIT', []);
      committed = true;
      return result;
    } finally {
      // 提交成功之后连接必须归还，归还失败要**冒出去**：那意味着池里少了一个连接，
      // 藏起来会让泄漏直到池耗尽才以"卡死"的形式出现。
      // 提交没成功时反过来：`ROLLBACK` 与 `release` 的异常一律吞掉，因为调用方需要看到
      // 的是**原始**失败（CAS 冲突、约束冲突、domain 校验），而不是"回滚时连接已断"。
      if (committed) {
        await client.release();
      } else {
        await discard(client);
      }
    }
  }

  async migrate(): Promise<MigrationReport> {
    return this.transaction(async (tx) => {
      // 互斥：两个实例同时冷启动时，第二个会在这里等到第一个提交。advisory lock 是
      // **事务级**的，提交即释放，进程崩溃也不会留下死锁。
      await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        MIGRATION_ADVISORY_LOCK_KEY.toString(),
      ]);
      // 引导记录表。迁移不能创建记录自己的那张表，所以这一步在循环之外、锁之内。
      await tx.execute(SCHEMA_MIGRATIONS_BOOTSTRAP_DDL, []);

      const rows = await tx.query<{ readonly version: string; readonly checksum: string }>(
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
        [],
      );
      const recorded = new Map<string, string>(rows.map((row) => [row.version, row.checksum]));
      const applied: string[] = [];

      for (const migration of this.#migrations) {
        const checksum = migrationChecksum(migration);
        const previous = recorded.get(migration.version);
        if (previous !== undefined) {
          // 幂等：同版本同 checksum ⇒ 什么都不做。同版本**不同** checksum ⇒ 已经应用的
          // 迁移被事后改写过，两个环境的 schema 会静默分叉，必须停下而不是跳过。
          if (previous !== checksum) throw infraError('MIGRATION_CHECKSUM_MISMATCH');
          continue;
        }
        for (const statement of migration.statements) await tx.execute(statement, []);
        await tx.execute('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [
          migration.version,
          checksum,
        ]);
        applied.push(migration.version);
      }

      const total = await tx.query<{ readonly count: string }>(
        'SELECT count(*) AS count FROM schema_migrations',
        [],
      );
      return { applied, schemaVersion: Number(total[0]?.count ?? 0) };
    });
  }

  /**
   * `SELECT 1` 往返一次。
   *
   * 这里的 `catch` **故意不带绑定**：驱动抛出的 `Error.message` 里通常原样印着连接目标，
   * 而连接串带着口令。端口文件头已经把这条写成契约（「detail 只能是内部错误码，不能是
   * 驱动原文」），所以失败时唯一能出去的是 `PROVIDER_UNAVAILABLE` 这个码。吞掉原文不是
   * 丢失信息，是把信息留在它不该离开的进程里。
   */
  async health(): Promise<HealthResult> {
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt);
    if (this.#closed) {
      return {
        status: 'unavailable',
        checkedAt,
        latencyMs: Date.now() - startedAt,
        detail: 'PROVIDER_UNAVAILABLE',
      };
    }
    try {
      const client = await this.#source.connect();
      try {
        await client.query('SELECT 1', []);
      } finally {
        await discard(client);
      }
      return { status: 'ok', checkedAt, latencyMs: Date.now() - startedAt, detail: null };
    } catch {
      return {
        status: 'unavailable',
        checkedAt,
        latencyMs: Date.now() - startedAt,
        detail: 'PROVIDER_UNAVAILABLE',
      };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#source.end();
  }
}

/**
 * 把一个独占连接包成冻结端口的 `DatabaseTransaction`。
 *
 * 两个方法的差别就是 §3.5 全部 CAS 逻辑的地基：`query` 给行，`execute` 给**受影响行数**。
 * `UPDATE … WHERE revision = $n` 命中时行集合是空的，只有 `rowCount === 1` 能证明这次
 * 比较成功；把 `execute` 实现成 `rows.length` 会让每一次 CAS 都被判成失配，
 * `TaskUnitOfWork.run` 于是永远回滚 —— 一个所有测试都能通过、只有真实并发才暴露的错误。
 */
function bindTransaction(client: SqlClient): DatabaseTransaction {
  return {
    async query<TRow>(sql: string, params: readonly unknown[]): Promise<readonly TRow[]> {
      return (await client.query<TRow>(sql, params)).rows;
    },
    async execute(sql: string, params: readonly unknown[]): Promise<number> {
      return (await client.query(sql, params)).rowCount;
    },
  };
}

/** 尽力而为地结束一个连接：先回滚再归还，两步的异常都不冒出去。 */
async function discard(client: SqlClient): Promise<void> {
  try {
    await client.query('ROLLBACK', []);
  } catch {
    // 连接可能已经断了；此时 ROLLBACK 失败是预期的，后端会话随连接一起消失。
  }
  try {
    await client.release();
  } catch {
    // 同上。归还一个已死连接失败不影响调用方需要看到的那个原始错误。
  }
}

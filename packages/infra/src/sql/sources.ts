import type { SqlClient, SqlClientSource, SqlQueryResult } from './client.js';

/**
 * §2.1 点名的两个真实驱动的来源工厂。
 *
 * ## 为什么是 `await import(...)` 而不是顶部 `import`
 *
 * infra 现有约定是**平台 SDK 只以 `import type` 进入模块图**（见
 * `drivers/vercel-blob.ts`：它 `import type` 了 `@vercel/blob` 的五个形状，真正调用 SDK
 * 的对象由外部注入）。那条约定的理由是"infra 的单元可在没有该 SDK 的环境里被加载与
 * 测试"。本文件要**真的**发 SQL，无法只靠类型，于是把静态依赖换成动态导入：模块本身
 * 仍然可以在没有数据库的环境里被 import，只有调用工厂的那一刻才会去解析 SDK。
 *
 * 这也让两个来源可以并存于同一个 bundle 而不互相拖累 —— 迁移工具用 `pg`，Serverless
 * 运行时用 Neon，谁都没被谁拖进冷启动。
 *
 * ## 为什么只接 `connectionString` 与 `maxConnections`
 *
 * 不发明 TLS 选项、不猜超时、不塞应用名。连接串是部署期秘密（§3.2「凭据不写
 * migration SQL」的同一条理由），它已经携带了 `sslmode` 之类的参数；在这里再加一层
 * "默认 ssl: require" 只会在本地 Postgres 上把连接弄坏，并且让人以为改这里就能改
 * 传输安全。池大小给一个显式上限是因为 Serverless 实例数 × 池大小会直接决定 Neon 的
 * 连接配额是否被打爆 —— 但**默认值交给 SDK**，不在这里编一个数。
 */

export type SqlClientSourceOptions = {
  /** 部署期秘密。不落日志、不进错误消息、不写迁移 SQL。 */
  readonly connectionString: string;
  readonly maxConnections?: number;
};

/**
 * `pg@8.23.1` —— §2.1 指定给**迁移**用的驱动。
 *
 * 迁移是一次性的、长连接的、需要在同一个后端会话里持有 advisory lock 直到提交的操作，
 * Neon 的 HTTP driver 做不到（它不支持跨语句事务），WebSocket 池能做到但迁移通常在
 * 部署期跑、不在请求路径上，用 `pg` 的 TCP 连接更直白。
 */
export async function createPgClientSource(
  options: SqlClientSourceOptions,
): Promise<SqlClientSource> {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
  });
  return {
    async connect(): Promise<SqlClient> {
      const client = await pool.connect();
      return {
        async query<TRow>(
          text: string,
          values: readonly unknown[],
        ): Promise<SqlQueryResult<TRow>> {
          const result = await client.query(text, [...values]);
          const rows = result.rows as readonly TRow[];
          return { rows, rowCount: result.rowCount ?? rows.length };
        },
        async release(): Promise<void> {
          client.release();
        },
      };
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * `@neondatabase/serverless@1.2.0` —— §2.1 指定给**运行连接**用的驱动。
 *
 * 用的是它的 `Pool`（WebSocket）而不是 `neon()`（HTTP）：§3.4 的六个边界里有四个是
 * 「短事务 + CAS」，HTTP driver 一次只能发一条语句、没有事务，`createTurn` 的
 * 「锁 project → 查 Idempotency-Key → INSERT task/private/reservation → CAS project」
 * 在它上面根本无法表达成原子操作。
 */
export async function createNeonClientSource(
  options: SqlClientSourceOptions,
): Promise<SqlClientSource> {
  const { Pool } = await import('@neondatabase/serverless');
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
  });
  return {
    async connect(): Promise<SqlClient> {
      const client = await pool.connect();
      return {
        async query<TRow>(
          text: string,
          values: readonly unknown[],
        ): Promise<SqlQueryResult<TRow>> {
          const result = await client.query(text, [...values]);
          const rows = result.rows as readonly TRow[];
          return { rows, rowCount: result.rowCount ?? rows.length };
        },
        async release(): Promise<void> {
          client.release();
        },
      };
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

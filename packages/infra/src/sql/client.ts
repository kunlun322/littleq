/**
 * 真实 SQL 客户端的**最窄**抽象。
 *
 * ## 为什么不直接在适配器里 `import { Pool } from 'pg'`
 *
 * ZLQ-216 §2.1 规定了两个不同的驱动：「运行连接采用既有 `@neondatabase/serverless@1.2.0`，
 * 迁移用 `pg@8.23.1`」。两者的 `Pool` 形状几乎相同但**不是同一个类型**：Neon 走 WebSocket
 * 到 Neon proxy，`pg` 走 TCP。如果适配器直接依赖其中一个，另一个就得再写一遍事务/CAS
 * 逻辑 —— 而两份实现之间必然漂移，漂移的那一份正是生产上跑的那一份。
 *
 * 于是这里只声明三件事：拿到一个**独占**连接、在它上面发一条参数化语句、把它还回去。
 * 两个 SDK 各自实现这三件事（`sql/sources.ts`），适配器只面向这个接口。
 *
 * ## 为什么 `connect()` 返回独占连接而不是一个池
 *
 * `transaction()` 的原子性完全依赖「这一个事务的所有语句都跑在同一个连接上」。池化连接
 * 若被两个并发事务共用，`BEGIN` / `COMMIT` 会互相穿插，结果是两个事务的语句混在一个
 * 后端事务里 —— 一个回滚会把另一个一起回滚，而调用方看到的是"成功"。所以本接口的
 * 契约是：`connect()` 给出的 `SqlClient` 在 `release()` 之前**只属于调用者**。
 * `pg.Pool.connect()` 与 Neon 的 `Pool.connect()` 都满足这一条（它们签出一个专用
 * client），这不是本文件的发明，只是把它写进契约。
 *
 * ## 为什么 `rowCount` 与 `rows` 分开
 *
 * CAS 的判据是**受影响行数**，而 `UPDATE … WHERE revision = $n` 成功时 `rows` 是空的。
 * 若把 `execute` 实现成 `rows.length`，每一次 CAS 命中都会被判成未命中，
 * §3.5 的 `run` 会永远回滚。两个 SDK 都在 `rowCount` 上给出这个数，但类型是
 * `number | null`（某些不报告行数的命令给 null），归一化在 source 层做完，适配器
 * 拿到的永远是 `number`。
 */

/** 一条语句的结果：行集合与受影响行数。 */
export type SqlQueryResult<TRow = Record<string, unknown>> = {
  readonly rows: readonly TRow[];
  readonly rowCount: number;
};

/**
 * 一个已签出的独占连接。
 *
 * `query` 的 `text` 必须是**带 `$n` 占位符的参数化语句**（§3.1「所有生产 SQL 参数化」）。
 * 接口上没有"拼接 SQL"的入口，也没有 `unsafe`/`raw` 逃逸口 —— 想注入字符串只能改这个
 * 接口本身，而那会在评审里显眼得多。
 */
export interface SqlClient {
  query<TRow = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>>;
  release(): Promise<void>;
}

/** 连接来源。`end()` 关掉底层池，之后 `connect()` 的行为由具体 SDK 决定（应拒绝）。 */
export interface SqlClientSource {
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
}

/** Postgres SQLSTATE `23505` = `unique_violation`。 */
const UNIQUE_VIOLATION = '23505';

/**
 * 一次失败是哪一条唯一约束冲突，不是就返回 `null`。
 *
 * ## 为什么这个判定住在**这一层**
 *
 * §6.5 规则 4 要求「数据库唯一冲突」被翻译成**同一个**领域错误码，否则同一个用户可见
 * 结果会因为竞态的胜负而给出两种响应。要翻译就得先认出来，而"认出来"意味着读驱动抛出的
 * 错误形状 —— 那是 SDK 的知识，不该散落到各个仓储驱动里。`pg` 与
 * `@neondatabase/serverless` 都把 SQLSTATE 放在 `error.code`、把约束名放在
 * `error.constraint` 上，所以这里只认这两个字段，两个 source 共用，将来换驱动也只改这一处。
 *
 * ## 为什么返回**约束名**而不是一个布尔值
 *
 * 同一句 `INSERT` 可以撞好几条唯一约束，而它们意味着完全不同的事：`createTurn` 撞
 * `ai_tasks_one_active_per_project` 是「这个项目已经有一个在跑的回合」（409
 * `ACTIVE_WRITE_TASK_EXISTS`），撞 `ai_tasks_pkey` 是调用方重复使用了 task id（内部错误）。
 * 只回答"撞了"就必须二选一，选错的那一个会把运维事故报成用户冲突 —— 而用户会照着 409
 * 去重试，永远重试不成功。
 *
 * ## 为什么是结构化嗅探而不是 `instanceof`
 *
 * 两个 SDK 各自有自己的错误类，`instanceof` 需要把它们的类型拉进模块图 —— 而本文件的
 * 全部意义就是让适配器**不**静态依赖任何一个 SDK。SQLSTATE 与约束名是 Postgres 协议的
 * 一部分，比任一 SDK 的类层次都稳定。
 *
 * 只认 `code` / `constraint`，不看 `message` / `detail`：那两段里带着出冲突的**值**
 * （`detail: Key (idempotency_key)=(…) already exists.`）。拿它做判据等于把可能含用户
 * 数据的一段文本变成控制流的一部分，而 §8 明令真实秘密与用户数据不进日志。
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  if (candidate.code !== UNIQUE_VIOLATION) return null;
  return typeof candidate.constraint === 'string' ? candidate.constraint : null;
}

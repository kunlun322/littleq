/**
 * 端口 1／5：`DatabaseAdapter` —— Neon PostgreSQL 的事务、迁移与健康检查
 * （ZLQ-194 §6.2）。
 *
 * `@neondatabase/serverless@1.2.0`（运行时池化 URL）与 `pg@8.23.1`（迁移期直连 URL）都在
 * `packages/infra/package.json` 的冻结清单里，两者都不上移到 domain：`domain-no-platform-sdk`
 * 这条依赖图规则就是为了让 PostgreSQL 的形状停在这一层。
 *
 * 本端口只描述**能力**，不复述任何 SQL 方言细节或可观测值（表名、行数、耗时都属于观测，
 * 契约不承载）。真正的 Neon 驱动接线是 D5 的事；本单交付的是端口契约本身，以及一个能让
 * 端口不变量跑成可红可绿的内存实现。
 */
import type { HealthResult } from '../types.js';

/** 一个事务内的执行句柄；事务外拿不到它，因此「忘了开事务」在类型层就编不过。 */
export interface DatabaseTransaction {
  query<TRow>(sql: string, params: readonly unknown[]): Promise<readonly TRow[]>;
  /** 返回受影响行数；调用方用它把「改到了 0 行」识别成一次 CAS 失败，而不是成功。 */
  execute(sql: string, params: readonly unknown[]): Promise<number>;
}

export interface MigrationReport {
  /** 本次实际执行的迁移标识，按执行顺序；已经是最新时为空数组。 */
  readonly applied: readonly string[];
  readonly schemaVersion: number;
}

export interface DatabaseAdapter {
  /**
   * 在**一个**事务里跑完 `work`。
   *
   * 不变量：`work` 抛错 ⇒ 回滚且不返回它的值；正常返回 ⇒ 提交。所有 revision CAS
   * （`TaskRepository.save` / `SecretStore.rotate`）都必须落在一个事务里，否则「读到版本 →
   * 写入版本」之间的窗口就是一次静默的丢更新。
   */
  transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;

  /** 幂等：重复执行不重复应用。 */
  migrate(): Promise<MigrationReport>;

  /** 健康检查；`detail` 只能是内部错误码，不能是驱动的原文报错（原文里带连接串）。 */
  health(): Promise<HealthResult>;

  close(): Promise<void>;
}

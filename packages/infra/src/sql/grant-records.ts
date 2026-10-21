/**
 * `GrantRecordStore` 的 Postgres 实现 —— ZLQ-216 §3.2 的 `object_read_grants` /
 * `grant_read_leases` 两张表，§10.2 点名的「grant 驱动」。
 *
 * ## 它替代的是什么
 *
 * `grant/memory-records.ts` 的文件头自己写明了边界：「⚠️ **这是替身，不是真链路证明。**
 * …真实的 grant 表在 D5：`tokenHash` 上的唯一索引、`revokedAt` 的一次原子 UPDATE、
 * 以及把并发计数落到一条数据库约束上。」本文件就是那三件事。
 *
 * 三件事各自防的是什么：
 *
 * 1. **`tokenHash` 唯一索引** —— 两个并发 `issue()` 撞出同一个 token 的概率是 2⁻²⁵⁶，
 *    真正要防的是**重放**：同一张 grant 被写两次就会有两行，`findByTokenHash` 读到哪一行
 *    取决于顺序，于是"已撤销的那一行"可能被跳过。
 * 2. **`revokedAt` 的原子 UPDATE** —— 内存版是"读出来、判一下、写回去"，两个进程同时撤销
 *    会各自把计数器 +1；SQL 版用 `WHERE revoked_at IS NULL` 让第二个撤销影响 0 行。
 * 3. **并发计数落库** —— 这是本文件相对内存版**新增**的能力，也是它存在的核心理由：
 *    `ObjectReadGrantService` 的 `#leases` 是一张进程内 Map，跨实例/冷启动后它认为是 0，
 *    于是 `MAX_CONCURRENT_READS = 8` 在每个实例上各放行 8 条。§3.2 逐字：「每次读取授权
 *    与计量通过持久实现，**不拿 Runtime Map 当权威**。」
 *
 * ## 为什么 `activeLeaseCount` 不在 `GrantRecordStore` 端口上
 *
 * 冻结端口只有五个方法（`save/findByTokenHash/findById/markRevoked/addCommittedBytes`），
 * 本单不改它（§3.5：「本期不改这份冻结端口签名」，同一条纪律适用于全部既有端口）。
 * 所以持久并发计数以一个**端口之外**的方法 `countActiveLeases` 暴露，由装配层
 * （`ObjectReadGrantService` 的调用方）决定要不要用它做权威判定 —— 与
 * `PostgresBlobDigestIndex.recordByteLength` 的处理方式完全一致。
 *
 * ## 执行语境
 *
 * 与 digest index 同样有两种：独立（自己开短事务）与绑定（复用调用方事务）。
 * `revoke` 的"写库＋打断在飞租约在同一次调用里完成"要求两条语句同事务，所以它
 * 一律走 `#execute`，绝不拆成两次独立调用。
 */
import type { Timestamp } from '@littleq/domain';

import { infraError } from '../errors.js';
import type { GrantRecordStore, StoredGrant } from '../grant/object-read-grant.js';
import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';
import { parseObjectRef, parseStoredDigest } from '../types.js';
import type { SqlExecutor } from './executor.js';
import { executorBound, executorOf } from './executor.js';
import {
  GRANT_READ_LEASES_ACTIVE_COUNT_SQL,
  GRANT_READ_LEASES_DELETE_BY_GRANT_SQL,
  GRANT_READ_LEASES_DELETE_EXPIRED_SQL,
} from './migrations.js';
import {
  fromBigintColumn,
  fromHexBytea,
  fromJsonString,
  fromNullableTimestamptz,
  fromTextColumn,
  fromTimestamptz,
  toHexBytea,
  toJsonb,
  toNullableTimestamptz,
  toTimestamptz,
} from './rows.js';

export const OBJECT_READ_GRANT_COLUMNS = `grant_id, token_hash, object_ref, artifact_hash,
  audience, max_bytes, max_concurrent_reads, issued_at, expires_at, revoked_at, committed_bytes`;

export type ObjectReadGrantRow = {
  readonly grant_id: string;
  readonly token_hash: unknown;
  readonly object_ref: unknown;
  readonly artifact_hash: string;
  readonly audience: string;
  readonly max_bytes: unknown;
  readonly max_concurrent_reads: unknown;
  readonly issued_at: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
  readonly committed_bytes: unknown;
};

export function grantFromRow(row: ObjectReadGrantRow): StoredGrant {
  return {
    grantId: fromTextColumn(row.grant_id),
    tokenHash: fromHexBytea(row.token_hash),
    objectRef: parseObjectRef(fromJsonString(row.object_ref)),
    artifactHash: parseStoredDigest(row.artifact_hash, 'STORED_ROW_INCONSISTENT'),
    audience: fromTextColumn(row.audience),
    maxBytes: fromBigintColumn(row.max_bytes),
    maxConcurrentReads: fromBigintColumn(row.max_concurrent_reads),
    issuedAt: fromTimestamptz(row.issued_at),
    expiresAt: fromTimestamptz(row.expires_at),
    revokedAt: fromNullableTimestamptz(row.revoked_at),
    committedBytes: fromBigintColumn(row.committed_bytes),
  };
}

/**
 * `save` 是 **upsert**，不是纯 INSERT。
 *
 * `ObjectReadGrantService` 在 `issue()` 之外还会用 `save` 回写"账本重新播种"后的记录
 * （见 `grant/object-read-grant.ts` 文件头的边界 1），所以同一个 `grant_id` 被写两次是
 * 正常路径。但 upsert **刻意不覆盖** `token_hash` / `object_ref` / `artifact_hash` /
 * `audience` / `issued_at`：这五列是一张 grant 的**身份**，改了它就不再是同一张授权，
 * 而"同一 grant_id 换一张身份"正是重放攻击想要的效果。可变的只有 `expires_at` /
 * `revoked_at` / `committed_bytes` / `max_*` 四项配额与状态。
 */
export const OBJECT_READ_GRANT_UPSERT_SQL = `
INSERT INTO object_read_grants(
  grant_id, token_hash, object_ref, artifact_hash, audience,
  max_bytes, max_concurrent_reads, issued_at, expires_at, revoked_at, committed_bytes
) VALUES (
  $1, $2, $3::jsonb, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11
)
ON CONFLICT (grant_id) DO UPDATE SET
  max_bytes = EXCLUDED.max_bytes,
  max_concurrent_reads = EXCLUDED.max_concurrent_reads,
  expires_at = EXCLUDED.expires_at,
  revoked_at = EXCLUDED.revoked_at,
  committed_bytes = EXCLUDED.committed_bytes
`;

export function grantUpsertParams(grant: StoredGrant): readonly unknown[] {
  return [
    grant.grantId,
    toHexBytea(grant.tokenHash),
    toJsonb(grant.objectRef),
    grant.artifactHash,
    grant.audience,
    grant.maxBytes,
    grant.maxConcurrentReads,
    toTimestamptz(grant.issuedAt),
    toTimestamptz(grant.expiresAt),
    toNullableTimestamptz(grant.revokedAt),
    grant.committedBytes,
  ];
}

export const OBJECT_READ_GRANT_SELECT_BY_TOKEN_HASH_SQL = `
SELECT ${OBJECT_READ_GRANT_COLUMNS} FROM object_read_grants WHERE token_hash = $1`;

export const OBJECT_READ_GRANT_SELECT_BY_ID_SQL = `
SELECT ${OBJECT_READ_GRANT_COLUMNS} FROM object_read_grants WHERE grant_id = $1`;

/**
 * 撤销：一次原子 UPDATE，**且**同事务删掉在飞读租约。
 *
 * `WHERE revoked_at IS NULL` 让"已经撤销过"的那一次影响 0 行 —— 内存版靠读出来再判，
 * 两个进程同时撤销会各自把 `revocationCount` +1；这里第二个撤销拿到的就是 0 行，
 * 于是幂等语义（重复撤销返回原样、不推进计数）由数据库而不是调用顺序保证。
 *
 * `RETURNING` 全列是因为端口要求返回撤销后的 `StoredGrant`；影响 0 行时再单独读一次，
 * 以区分"这一行不存在"（返回 `null`）与"这一行早就撤销了"（返回原样）。
 */
export const OBJECT_READ_GRANT_MARK_REVOKED_SQL = `
UPDATE object_read_grants SET revoked_at = $2::timestamptz
WHERE grant_id = $1 AND revoked_at IS NULL
RETURNING ${OBJECT_READ_GRANT_COLUMNS}`;

/**
 * 字节账回写：`committed_bytes = committed_bytes + $2`，**在数据库里做加法**。
 *
 * 不在应用层"读旧值 + delta 再写回"的原因与撤销相同：两个实例同时交付字节时，
 * 应用层的读-改-写会丢掉其中一次增量，于是 `maxBytes` 这条累计预算被悄悄放大。
 * `RETURNING committed_bytes` 给出加法之后的权威值，正是端口要求的返回。
 *
 * `CHECK (committed_bytes >= 0)` 挡住了负 delta 把账本减成负数（那等于凭空扩预算）。
 */
export const OBJECT_READ_GRANT_ADD_COMMITTED_BYTES_SQL = `
UPDATE object_read_grants SET committed_bytes = committed_bytes + $2
WHERE grant_id = $1
RETURNING committed_bytes`;

/** 一次读租约：`grant_read_leases` 的一行。§3.2：「用于现成 grant acquire/commit/release 端口的 SQL 实现」。 */
export const GRANT_READ_LEASE_INSERT_SQL = `
INSERT INTO grant_read_leases(read_id, grant_id, reserved_bytes, expires_at)
VALUES ($1, $2, $3, $4::timestamptz)
ON CONFLICT (read_id) DO NOTHING`;

export const GRANT_READ_LEASE_DELETE_SQL = `DELETE FROM grant_read_leases WHERE read_id = $1`;

export class PostgresGrantRecordStore implements GrantRecordStore {
  readonly #execute: SqlExecutor;

  private constructor(execute: SqlExecutor) {
    this.#execute = execute;
  }

  static of(db: DatabaseAdapter): PostgresGrantRecordStore {
    return new PostgresGrantRecordStore(executorOf(db));
  }

  static bound(tx: DatabaseTransaction): PostgresGrantRecordStore {
    return new PostgresGrantRecordStore(executorBound(tx));
  }

  async save(grant: StoredGrant): Promise<void> {
    await this.#execute((tx) =>
      tx.execute(OBJECT_READ_GRANT_UPSERT_SQL, grantUpsertParams(grant)),
    ).then(() => undefined);
  }

  async findByTokenHash(tokenHash: string): Promise<StoredGrant | null> {
    const rows = await this.#execute((tx) =>
      tx.query<ObjectReadGrantRow>(OBJECT_READ_GRANT_SELECT_BY_TOKEN_HASH_SQL, [
        toHexBytea(tokenHash),
      ]),
    );
    const row = rows[0];
    return row === undefined ? null : grantFromRow(row);
  }

  async findById(grantId: string): Promise<StoredGrant | null> {
    const rows = await this.#execute((tx) =>
      tx.query<ObjectReadGrantRow>(OBJECT_READ_GRANT_SELECT_BY_ID_SQL, [grantId]),
    );
    const row = rows[0];
    return row === undefined ? null : grantFromRow(row);
  }

  async markRevoked(grantId: string, now: Timestamp): Promise<StoredGrant | null> {
    return this.#execute(async (tx) => {
      const updated = await tx.query<ObjectReadGrantRow>(OBJECT_READ_GRANT_MARK_REVOKED_SQL, [
        grantId,
        toTimestamptz(now),
      ]);
      /**
       * 撤销生效的那一刻就把在飞租约行删掉。放在 `updated.length === 0` 的分支之外、
       * 但只在**真的写成了撤销**时执行：重复撤销不重复删（那些租约在首次撤销时已经没了），
       * 而 grant 不存在时删一个不存在的 grant 的租约只是空操作，也没必要做。
       */
      if (updated.length === 0) {
        const existing = await tx.query<ObjectReadGrantRow>(OBJECT_READ_GRANT_SELECT_BY_ID_SQL, [
          grantId,
        ]);
        const row = existing[0];
        return row === undefined ? null : grantFromRow(row);
      }
      await tx.execute(GRANT_READ_LEASES_DELETE_BY_GRANT_SQL, [grantId]);
      const row = updated[0];
      if (row === undefined) throw infraError('OBJECT_READ_GRANT_UNKNOWN');
      return grantFromRow(row);
    });
  }

  async addCommittedBytes(grantId: string, delta: number): Promise<number> {
    if (!Number.isSafeInteger(delta)) throw infraError('OBJECT_READ_BUDGET_EXCEEDED');
    const rows = await this.#execute((tx) =>
      tx.query<{ readonly committed_bytes: unknown }>(OBJECT_READ_GRANT_ADD_COMMITTED_BYTES_SQL, [
        grantId,
        delta,
      ]),
    );
    const row = rows[0];
    /** 0 行＝这张 grant 不在库里。端口的内存版在这里抛 `OBJECT_READ_GRANT_UNKNOWN`，照抄。 */
    if (row === undefined) throw infraError('OBJECT_READ_GRANT_UNKNOWN');
    return fromBigintColumn(row.committed_bytes);
  }

  /**
   * 持久化的在飞读租约数 —— 端口之外的方法，理由见文件头。
   *
   * `now` 由调用方给（domain 一律把"现在几点"作为入参），过期行不计入。计数之前先删掉
   * 已过期行，否则一张长期不用的 grant 会永远背着一堆死租约，把并发上限占满。
   */
  async countActiveLeases(grantId: string, now: Timestamp): Promise<number> {
    return this.#execute(async (tx) => {
      await tx.execute(GRANT_READ_LEASES_DELETE_EXPIRED_SQL, [toTimestamptz(now)]);
      const rows = await tx.query<{ readonly active: unknown }>(
        GRANT_READ_LEASES_ACTIVE_COUNT_SQL,
        [grantId, toTimestamptz(now)],
      );
      const row = rows[0];
      if (row === undefined) throw infraError('STORED_ROW_INCONSISTENT');
      return fromBigintColumn(row.active);
    });
  }

  /** 登记一条读租约。`read_id` 由 `ObjectReadGrantService` 铸出（`lease_` + 16 hex）。 */
  async acquireLease(input: {
    readonly readId: string;
    readonly grantId: string;
    readonly reservedBytes: number;
    readonly expiresAt: Timestamp;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.reservedBytes) || input.reservedBytes < 0) {
      throw infraError('OBJECT_READ_BUDGET_EXCEEDED');
    }
    const affected = await this.#execute((tx) =>
      tx.execute(GRANT_READ_LEASE_INSERT_SQL, [
        input.readId,
        input.grantId,
        input.reservedBytes,
        toTimestamptz(input.expiresAt),
      ]),
    );
    return affected > 0;
  }

  /** 交还一条读租约。已经过期并被回收的行再释放一次是空操作，不报错。 */
  async releaseLease(readId: string): Promise<void> {
    await this.#execute((tx) => tx.execute(GRANT_READ_LEASE_DELETE_SQL, [readId])).then(
      () => undefined,
    );
  }
}

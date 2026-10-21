import type { ArtifactDigest } from '@littleq/domain';

import type { BlobDigestIndex } from '../drivers/vercel-blob.js';
import { infraError } from '../errors.js';
import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';
import { parseStoredDigest } from '../types.js';
import { executorBound, executorOf, type SqlExecutor } from './executor.js';
import {
  BLOB_DIGEST_INDEX_SELECT_SQL,
  BLOB_DIGEST_INDEX_SET_BYTE_LENGTH_SQL,
  BLOB_DIGEST_INDEX_UPSERT_SQL,
} from './migrations.js';

/**
 * `BlobDigestIndex` 的 SQL 实现 —— ZLQ-216 §3.3，本单**唯一**从 ZLQ-208 接过来的东西。
 *
 * ## 这张表为什么不可省
 *
 * `drivers/vercel-blob.ts` 的 `BlobDigestIndex` 注释已经写明了因果：Vercel Blob 的
 * `head` / `get` **不提供**内容摘要（只有 `etag`，而分片上传时它不是内容 sha256），也没有
 * 用户自定义元数据字段可藏；而 `StoredObjectMetadata.sha256` 是 `ObjectStore` 端口的必填项。
 * 所以摘要必须由平台自己记。§3.3 把这一点收成一句禁令：「不得 head/ETag 冒充摘要。」
 *
 * 它同时是一条**安全性质**：`digestOf` 返回 `null` 意味着「provider 里有这个 key，但平台
 * 从没通过本 driver 写过它」，`VercelBlobObjectStore` 于是把 `head` 与整对象 `getPrivate`
 * 一律当作**不存在**。§3.3 的原话：「索引缺失的对象不能当作已校验产物放行 Range/read。」
 * 即便有人能往 Blob store 里塞对象，也拿不到一条可读路径。
 *
 * ## 三条路径都由 upsert 的返回行数区分（§3.3 逐字）
 *
 * - 首次插入 ⇒ 一行；
 * - 同 pathname 同摘要 ⇒ 一行（幂等成功）；
 * - 同 pathname **不同**摘要 ⇒ **零行**，按现有 ObjectStore 冲突错误拒绝，**不覆盖摘要**。
 *
 * 拒绝用的码是 `OBJECT_ALREADY_EXISTS`：`VercelBlobObjectStore.putImmutable` 在 `put` 之前
 * 就用它表达「同一个 key 已经被别的内容占了」，对外映射 `REVISION_CONFLICT`（409）。
 * §3.3 说「按现有 ObjectStore 冲突错误拒绝」，指的就是这一个码 —— 换一个新码会让
 * `OBJECT_STORE_INVARIANTS` 里"同 key 不同内容必须被拒"那条在生产实现上失去可断言性。
 *
 * ## 事务性
 *
 * `remember` 被 `putImmutable` 在**任何数据库事务之外**调用，所以默认语境自己开一个短事务。
 * 但 §3.4 第 4 步（固化）要求「逐文件上传不可变对象、核实 digest index」发生在**一个短步**
 * 里，而 §3.5 的 `TaskTransaction` 把 `task_private.collection_cursor` 的推进与这一步绑在
 * 同一事务。`PostgresBlobDigestIndex.bound(tx)` 因此存在：同一个类，两种执行语境，
 * 端口签名一个字都没改。
 */

/** 一次执行语境：要么自己开事务，要么复用调用方已经开着的那个。定义见 `./executor.ts`。 */
export class PostgresBlobDigestIndex implements BlobDigestIndex {
  readonly #execute: SqlExecutor;

  /**
   * 私有构造器：执行语境只有两种合法来源，做成 `constructor(dbOrTx)` 会让调用方能写出
   * 一个两者皆无的实例，而那个错误要到第一次 `remember` 才炸。两个静态工厂把它变成编译期
   * 就分得清的选择。
   */
  private constructor(execute: SqlExecutor) {
    this.#execute = execute;
  }

  /** 独立语境：每次调用自己开一个短事务。`VercelBlobObjectStore` 用的就是这一种。 */
  static of(db: DatabaseAdapter): PostgresBlobDigestIndex {
    return new PostgresBlobDigestIndex(executorOf(db));
  }

  /** 绑定语境：复用调用方已经打开的事务，随它一起提交或回滚。 */
  static bound(tx: DatabaseTransaction): PostgresBlobDigestIndex {
    return new PostgresBlobDigestIndex(executorBound(tx));
  }

  /** §3.3：一行＝首次插入或同摘要幂等成功；零行＝同 pathname 不同摘要 ⇒ 拒绝，不覆盖。 */
  async remember(pathname: string, sha256: ArtifactDigest): Promise<void> {
    await this.#execute(async (tx) => {
      const rows = await tx.query<{ readonly pathname: string }>(BLOB_DIGEST_INDEX_UPSERT_SQL, [
        pathname,
        sha256,
      ]);
      if (rows.length === 0) throw infraError('OBJECT_ALREADY_EXISTS');
    });
  }

  /** §3.3：「没有行返回 null」。 */
  async digestOf(pathname: string): Promise<ArtifactDigest | null> {
    const rows = await this.#execute((tx) =>
      tx.query<{ readonly sha256: string }>(BLOB_DIGEST_INDEX_SELECT_SQL, [pathname]),
    );
    const row = rows[0];
    if (row === undefined) return null;
    // DDL 里的 `CHECK (sha256 ~ '^[0-9a-f]{64}$')` 已经挡住了坏摘要；真读到一个不合法的，
    // 说明有人绕过约束改过库，那是行损坏而不是"没有摘要"—— 不能返回 null 假装对象不存在。
    return parseStoredDigest(row.sha256, 'STORED_ROW_INCONSISTENT');
  }

  /**
   * 补齐 `byte_length` —— §3.3：「byte_length 可由作品固化记录补齐，不改变两参数接口；
   * 不强迫 `remember` 伪造不知道的大小。」
   *
   * 因此它是端口之外的**独立**方法：`remember` 永远只带两个参数。`WHERE sha256 = $2` 是
   * 防呆 —— 只给"摘要仍是这一个"的行补大小，避免与并发的冲突拒绝路径交错出
   * "pathname 的摘要已被拒绝、大小却写进去了"的半更新。返回是否真的补上了一行。
   */
  async recordByteLength(
    pathname: string,
    sha256: ArtifactDigest,
    byteLength: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw infraError('OBJECT_DECLARED_BYTES_MISMATCH');
    }
    const affected = await this.#execute((tx) =>
      tx.execute(BLOB_DIGEST_INDEX_SET_BYTE_LENGTH_SQL, [pathname, sha256, byteLength]),
    );
    return affected > 0;
  }
}

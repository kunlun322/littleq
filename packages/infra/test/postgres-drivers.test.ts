/**
 * 能力：`blob-digest-index` / `secret-record-store` 的**真库**行为 —— ZLQ-216 §3.3、§3.2，
 * 以及 §11.2 里两条离线可验的否定对照（「Blob 不存在或索引缺失」、「摘要故意错误」）。
 *
 * ## 为什么这两个驱动必须连真库，而替身证明不了
 *
 * 基线里已经有 `object-store-private-access.test.ts` 与 `secret-store-encrypted-lifecycle.test.ts`，
 * 它们用**内存替身**跑通了 `VercelBlobObjectStore` 与 `EncryptedSecretStore` 的端口行为。
 * 本文件不重复那些断言，只补替身在结构上给不出的四件事：
 *
 * 1. **`BlobDigestIndex` 的三条路径靠的是 upsert 的返回行数**，而
 *    `ON CONFLICT(pathname) DO UPDATE SET sha256 = blob_digest_index.sha256
 *    WHERE blob_digest_index.sha256 = EXCLUDED.sha256 RETURNING pathname` 这句的
 *    「零行」只有在真 PostgreSQL 的冲突仲裁下才成立。替身用 `Map.has` 模拟，
 *    模拟的是**我以为的语义**，不是数据库的语义。
 * 2. **`owner_secrets_cipher_shape` 是一条数据库级 CHECK**（`configured=false` ⇒
 *    密文四列全 NULL）。替身里没有这条约束，所以「撤销即销毁」在替身上只是应用层纪律；
 *    这里用一条**裸 INSERT** 去撞它，要求 SQLSTATE 23514。E7 是这条约束的**唯一**覆盖。
 * 3. **跨连接的 generation CAS。** 替身把 CAS 做成「读当前值、不等就返回 null」，形状正确，
 *    但两个进程各持一个 Map 时它什么都不拦。这里 CAS 落在
 *    `UPDATE … WHERE generation = $11` 的**影响行数**上。E3 用 `secondaryAdapter`
 *    开第二个独立连接池去读回第一个写下的东西 —— PM 复算项①要求的「写进去，再**从另一条
 *    连接**读回来」。
 * 4. **旧代 ref 结构性不可解析。** 替身靠 `save` 里手动 `this.#refs.delete(stale)` 摘索引，
 *    漏一行就是「轮换后旧 ref 仍能读出明文」。这里不需要摘：`current_ref` 是一列且 UNIQUE，
 *    轮换时被覆盖、撤销时被 CHECK 逼成 NULL，旧 ref 于是得到与「从未存在过」**完全同形**的
 *    0 行（E4）。
 *
 * ## 这里的 SDK 替身**不违反** §2.2
 *
 * §2.2 禁止的是「拿不到真库就用进程内或浏览器存储假交付」。**数据库没有被替换**：
 * `digests` 传进去的是真的 `PostgresBlobDigestIndex`，`records` 传进去的是真的
 * `PostgresSecretRecordStore`，两者都走 `LQ_TEST_DATABASE_URL` 上的真 PostgreSQL。
 * 被替换的只有 provider 传输层（Vercel Blob 的 HTTP 客户端），而那是本单**不允许**引入的
 * 东西：`drivers/vercel-blob.ts` 的文件头写明「凭据不进这一层」，真 Blob store 与真凭据
 * 属于 D5/D6 的验收。
 *
 * `VercelBlobObjectStoreOptions` 同时注入 `sdk` 与 `digests`，所以「真索引 + 假传输」这个
 * 组合是端口本来就支持的，不需要为测试放宽任何签名。
 *
 * ## 刻意不复用基线里的 `RecordingBlobSdk`
 *
 * `object-store-private-access.test.ts` 里那个替身记录得更全（`putOptions` / `listCalls` /
 * `failWith` / `renameTo`），但它是**那个文件私有的**。要复用得先把它导出（等于从一个测试
 * 文件对外发布 API），或者搬进 `support.ts`（而 `support.ts` 的章程是「字面量与确定性值、
 * 无可变状态」，一个带 `Map` 与调用记录的可变替身放进去会破坏那条章程）。
 * 在门禁即将开跑的时刻改动 `support.ts` 的风险大于收益，所以这里写一个 ~50 行的最小替身。
 * 若以后出现第三个消费者，就应该建 `support-blob.ts` 并把两处都迁过去 —— 这条留档在此。
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { ArtifactDigest } from '@littleq/domain';

import {
  type BlobDigestIndex,
  type BlobGetOptions,
  type BlobGetResult,
  type BlobHeadResult,
  type BlobListResult,
  type BlobPutOptions,
  type BlobPutResult,
  type BlobSdkSurface,
  VercelBlobObjectStore,
} from '../src/drivers/vercel-blob.js';
import { idleAbortSignal, streamFromBytes } from '../src/object-store/budget.js';
import type { ObjectStore } from '../src/ports/object-store.js';
import {
  type SecretPurpose,
  type SecretRevokeInput,
  type SecretRotateInput,
  type SecretSetInput,
} from '../src/ports/secret-store.js';
import { SecretCipher, loadMasterKey, parseMasterKey } from '../src/secret-store/cipher.js';
import {
  EncryptedSecretStore,
  newSecretRef,
  purposeOf,
  unconfiguredStoredSecret,
} from '../src/secret-store/store.js';
import { PostgresBlobDigestIndex } from '../src/sql/blob-digest-index.js';
import { PostgresSecretRecordStore } from '../src/sql/secret-records.js';
import { parseObjectRef } from '../src/types.js';

import {
  TEST_MASTER_KEY_HEX,
  at,
  bytes,
  collect,
  rejectedCode,
  sha256Of,
  streamFrom,
} from './support.js';
import {
  createTestDatabaseHarness,
  queryHarness,
  secondaryAdapter,
  seedAccounts,
  type TestDatabaseHarness,
} from './support-database.js';

import { afterAll, describe, expect, it } from 'vitest';

// 真库可达性探针。不可达时整组**大声跳过**（`skipIf`），而不是静默通过 ——
// 所以报数时 skipped 必须单列。
const probe = await createTestDatabaseHarness();

afterAll(async () => {
  await probe?.dispose();
});

/** 一次一个已迁移的库；用完即弃，避免用例之间靠残留行互相污染。 */
async function withMigratedDatabase<T>(
  run: (harness: TestDatabaseHarness) => Promise<T>,
): Promise<T> {
  const harness = await createTestDatabaseHarness();
  if (harness === null) throw new Error('本组需要可达的 Postgres；skipIf 应当已经跳过本用例');
  try {
    await harness.adapter.migrate();
    return await run(harness);
  } finally {
    await harness.dispose();
  }
}

/** 索引表里某个 pathname 的行数。用真 SQL 数，不用驱动的返回值 —— 那是要被验的东西。 */
async function digestRowCount(harness: TestDatabaseHarness, pathname: string): Promise<string> {
  const rows = await queryHarness<{ readonly total: unknown }>(
    harness,
    'SELECT COUNT(*)::bigint AS total FROM blob_digest_index WHERE pathname = $1',
    [pathname],
  );
  const row = rows[0];
  return row === undefined ? '' : String(row.total);
}

/** 读出索引里存的摘要与大小（`byte_length` 用 `::text` 避免 bigint 的字符串/数字歧义）。 */
async function digestRow(
  harness: TestDatabaseHarness,
  pathname: string,
): Promise<{ readonly sha256: string; readonly byteLength: string | null } | null> {
  const rows = await queryHarness<{
    readonly sha256: unknown;
    readonly byte_length: unknown;
  }>(
    harness,
    'SELECT sha256, byte_length::text AS byte_length FROM blob_digest_index WHERE pathname = $1',
    [pathname],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    sha256: String(row.sha256),
    byteLength: row.byte_length === null ? null : String(row.byte_length),
  };
}

interface FakeBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
}

/** provider 异常按**类名**匹配，所以替身必须用同样的类名。 */
class BlobNotFoundError extends Error {}

/** 最小替身：只实现 `VercelBlobObjectStore` 真的会调的五个方法，并记录调用轨迹。 */
class FakeBlobSdk implements BlobSdkSurface {
  readonly blobs = new Map<string, FakeBlob>();
  readonly putPathnames: string[] = [];
  readonly headCalls: string[] = [];
  readonly getOptions: BlobGetOptions[] = [];

  async put(pathname: string, body: Uint8Array, options: BlobPutOptions): Promise<BlobPutResult> {
    this.putPathnames.push(pathname);
    if (this.blobs.has(pathname) && !options.allowOverwrite) {
      throw new BlobPreconditionFailedError(`already exists: ${pathname}`);
    }
    // ETag 刻意**不是**内容 sha256：§3.3 的禁令是「不得 head/ETag 冒充摘要」，
    // 所以要证它，替身的 etag 必须与真摘要可区分。这里用 key 本身。
    const etag = `"${pathname}"`;
    this.blobs.set(pathname, {
      bytes: new Uint8Array(body),
      contentType: options.contentType,
      etag,
    });
    return { pathname, etag };
  }

  async get(pathname: string, options: BlobGetOptions): Promise<BlobGetResult | null> {
    this.getOptions.push(options);
    const found = this.blobs.get(pathname);
    if (found === undefined) return null;
    return {
      statusCode: 200,
      stream: streamFromBytes(found.bytes),
      size: found.bytes.byteLength,
      contentType: found.contentType,
    };
  }

  async head(pathname: string): Promise<BlobHeadResult | null> {
    this.headCalls.push(pathname);
    const found = this.blobs.get(pathname);
    if (found === undefined) return null;
    return {
      size: found.bytes.byteLength,
      contentType: found.contentType,
      uploadedAt: new Date(0),
      etag: found.etag,
    };
  }

  async del(pathnames: readonly string[]): Promise<void> {
    for (const pathname of pathnames) this.blobs.delete(pathname);
  }

  async list(): Promise<BlobListResult> {
    return { blobs: [], hasMore: false, cursor: undefined };
  }
}

// 与替身里的类名一致；单独声明一次，避免 `put` 里引用一个未定义的符号。
class BlobPreconditionFailedError extends Error {}

function putInput(
  body: Uint8Array,
  key: string,
  sha256: ArtifactDigest,
  contentType = 'application/octet-stream',
): Parameters<ObjectStore['putImmutable']>[0] {
  return {
    key,
    body: streamFrom(body),
    declaredBytes: body.byteLength,
    maxBytes: 1024,
    sha256,
    contentType,
    abortSignal: idleAbortSignal(),
  };
}

function makeStore(sdk: BlobSdkSurface, digests: BlobDigestIndex): ObjectStore {
  return new VercelBlobObjectStore({ sdk, digests, now: () => new Date(0) });
}

const KIND = 'QCA_PAT';

function secretInput(ownerId: string, plaintext: Uint8Array): SecretSetInput {
  return { ownerId, kind: KIND, plaintext };
}

function rotateInput(
  ownerId: string,
  plaintext: Uint8Array,
  expectedVersion: number,
): SecretRotateInput {
  return { ownerId, kind: KIND, plaintext, expectedVersion };
}

function revokeInput(ownerId: string, expectedVersion: number): SecretRevokeInput {
  return { ownerId, kind: KIND, expectedVersion };
}

/** 一个固定的钟：`EncryptedSecretStore` 只用它填 `lastRotatedAt` / `revokedAt`。 */
function makeSecretStore(cipher: SecretCipher, harness: TestDatabaseHarness) {
  return new EncryptedSecretStore({
    cipher,
    records: PostgresSecretRecordStore.of(harness.adapter),
    now: () => at(0),
  });
}

/** `owner_secrets` 的裸行。密文列用 `::text` 读，只为了断言「是否为 NULL」与「不含明文」。 */
type RawSecretRow = {
  readonly configured: unknown;
  readonly generation: unknown;
  readonly current_ref: unknown;
  readonly record: unknown;
  readonly ciphertext: unknown;
  readonly nonce: unknown;
  readonly tag: unknown;
  readonly key_version: unknown;
};

const RAW_SECRET_SELECT_SQL = `
SELECT configured, generation, current_ref, record::text AS record,
       ciphertext::text AS ciphertext, nonce::text AS nonce,
       tag::text AS tag, key_version::text AS key_version
FROM owner_secrets WHERE owner_id = $1 AND kind = $2`;

async function rawSecretRow(
  harness: TestDatabaseHarness,
  ownerId: string,
): Promise<RawSecretRow | null> {
  const rows = await queryHarness<RawSecretRow>(harness, RAW_SECRET_SELECT_SQL, [ownerId, KIND]);
  return rows[0] ?? null;
}

async function secretRowCount(harness: TestDatabaseHarness, ownerId: string): Promise<string> {
  const rows = await queryHarness<{ readonly total: unknown }>(
    harness,
    'SELECT COUNT(*)::bigint AS total FROM owner_secrets WHERE owner_id = $1',
    [ownerId],
  );
  const row = rows[0];
  return row === undefined ? '' : String(row.total);
}

/** 另一把 32 字节根密钥（同版本、不同字节），用来把「版本不符」与「密钥不符」分开。 */
function differentKeyBytes(): string {
  return createHash('sha256').update('a deliberately different master key').digest('hex');
}

describe.skipIf(probe === null)('C 组 · BlobDigestIndex 的三条路径（§3.3，真库）', () => {
  it('C1 · 首次插入 ⇒ 恰好一行，且 digestOf 读回同一个摘要', async () => {
    await withMigratedDatabase(async (harness) => {
      const index = PostgresBlobDigestIndex.of(harness.adapter);
      const pathname = 'artifacts/cc/first';
      const sha256 = sha256Of(bytes(16, 1));

      await index.remember(pathname, sha256);

      expect(await digestRowCount(harness, pathname)).toBe('1');
      expect(await index.digestOf(pathname)).toBe(sha256);
      expect((await digestRow(harness, pathname))?.sha256).toBe(sha256);
    });
  });

  it('C2 · 同 pathname 同摘要 ⇒ 幂等成功，仍然只有一行', async () => {
    await withMigratedDatabase(async (harness) => {
      const index = PostgresBlobDigestIndex.of(harness.adapter);
      const pathname = 'artifacts/cc/idempotent';
      const sha256 = sha256Of(bytes(16, 2));

      await index.remember(pathname, sha256);
      // 第二次不许抛。`remember` 的返回类型是 void，所以「成功」只能靠不抛来表达。
      await index.remember(pathname, sha256);
      await index.remember(pathname, sha256);

      expect(await digestRowCount(harness, pathname)).toBe('1');
      expect(await index.digestOf(pathname)).toBe(sha256);
    });
  });

  it('C3 · 同 pathname **不同**摘要 ⇒ 拒绝，且**不覆盖**已存的摘要', async () => {
    await withMigratedDatabase(async (harness) => {
      const index = PostgresBlobDigestIndex.of(harness.adapter);
      const pathname = 'artifacts/cc/conflict';
      const first = sha256Of(bytes(16, 3));
      const second = sha256Of(bytes(16, 4));
      expect(second).not.toBe(first);

      await index.remember(pathname, first);
      const code = await rejectedCode(index.remember(pathname, second));

      expect(code).toBe('OBJECT_ALREADY_EXISTS');
      // 零行是这个 upsert 的判据；对外表现是「拒绝且原值不动」。
      expect(await digestRowCount(harness, pathname)).toBe('1');
      expect((await digestRow(harness, pathname))?.sha256).toBe(first);
      expect(await index.digestOf(pathname)).toBe(first);
      expect(await index.digestOf(pathname)).not.toBe(second);
    });
  });

  it('C4 · 索引里没有的 pathname ⇒ digestOf 返回 null（不是抛，也不是空串）', async () => {
    await withMigratedDatabase(async (harness) => {
      const index = PostgresBlobDigestIndex.of(harness.adapter);
      expect(await index.digestOf('artifacts/cc/never-written')).toBeNull();
      expect(await digestRowCount(harness, 'artifacts/cc/never-written')).toBe('0');
    });
  });

  it('C5 · recordByteLength 只能补一次，且只给「摘要仍是这一个」的行补', async () => {
    await withMigratedDatabase(async (harness) => {
      const index = PostgresBlobDigestIndex.of(harness.adapter);
      const pathname = 'artifacts/cc/with-size';
      const sha256 = sha256Of(bytes(16, 5));
      await index.remember(pathname, sha256);

      // 刚记住时 byte_length 是 NULL —— `remember` 不伪造它不知道的大小（§3.3）。
      expect((await digestRow(harness, pathname))?.byteLength).toBeNull();

      expect(await index.recordByteLength(pathname, sha256, 16)).toBe(true);
      expect((await digestRow(harness, pathname))?.byteLength).toBe('16');

      // 第二次返回 false：`WHERE … AND byte_length IS NULL` 让它不再命中。
      expect(await index.recordByteLength(pathname, sha256, 99)).toBe(false);
      expect((await digestRow(harness, pathname))?.byteLength).toBe('16');

      // 摘要不符 ⇒ 一行都不该被改（防呆的 `WHERE sha256 = $2`）。
      expect(await index.recordByteLength(pathname, sha256Of(bytes(16, 6)), 7)).toBe(false);
      expect((await digestRow(harness, pathname))?.byteLength).toBe('16');
      // 未知 pathname 同样是 false，而不是抛。
      expect(await index.recordByteLength('artifacts/cc/nope', sha256, 1)).toBe(false);
    });
  });

  it('C6 · 非法大小在**任何 SQL 之前**就被拒，库里不留半更新', async () => {
    await withMigratedDatabase(async (harness) => {
      const index = PostgresBlobDigestIndex.of(harness.adapter);
      const pathname = 'artifacts/cc/bad-size';
      const sha256 = sha256Of(bytes(16, 7));
      await index.remember(pathname, sha256);

      expect(await rejectedCode(index.recordByteLength(pathname, sha256, -1))).toBe(
        'OBJECT_DECLARED_BYTES_MISMATCH',
      );
      expect(await rejectedCode(index.recordByteLength(pathname, sha256, Number.NaN))).toBe(
        'OBJECT_DECLARED_BYTES_MISMATCH',
      );
      expect(await digestRowCount(harness, pathname)).toBe('1');
      expect((await digestRow(harness, pathname))?.byteLength).toBeNull();
    });
  });

  it('C7 · bound(tx) 真的复用调用方事务：回滚后索引里一行都不留', async () => {
    await withMigratedDatabase(async (harness) => {
      const pathname = 'artifacts/cc/rolled-back';
      const sha256 = sha256Of(bytes(16, 8));

      await expect(
        harness.adapter.transaction(async (tx) => {
          await PostgresBlobDigestIndex.bound(tx).remember(pathname, sha256);
          // 同一事务里制造一次失败：主键冲突。
          await tx.execute('INSERT INTO blob_digest_index(pathname, sha256) VALUES ($1, $2)', [
            pathname,
            sha256,
          ]);
          await tx.execute('INSERT INTO blob_digest_index(pathname, sha256) VALUES ($1, $2)', [
            pathname,
            sha256,
          ]);
        }),
      ).rejects.toThrow(/duplicate key/);

      // 若 `bound` 悄悄自己开了事务，这一行就会留下来 —— 那正是本用例要判红的形状。
      expect(await digestRowCount(harness, pathname)).toBe('0');
    });
  });
});

describe.skipIf(probe === null)(
  'D 组 · §11.2 否定对照：真索引 + 假 provider 传输（每条都先跑阳性对照）',
  () => {
    it('D1 · 阳性对照：写进去，再从**另一条连接**读回来，摘要与字节都对', async () => {
      await withMigratedDatabase(async (harness) => {
        const sdk = new FakeBlobSdk();
        const store = makeStore(sdk, PostgresBlobDigestIndex.of(harness.adapter));
        const key = 'artifacts/dd/positive';
        const body = bytes(32, 11);
        const sha256 = sha256Of(body);

        const ref = await store.putImmutable(putInput(body, key, sha256));
        expect(ref).toBe(parseObjectRef(key));
        // provider 收到的 access 必须是字面量 private，且不许覆盖。
        expect(sdk.putPathnames).toEqual([key]);

        // PM 复算项①：读回要走**另一条连接**，而不是同一个池里刚用过的那条。
        const secondary = await secondaryAdapter(harness);
        try {
          const otherIndex = PostgresBlobDigestIndex.of(secondary.adapter);
          expect(await otherIndex.digestOf(key)).toBe(sha256);

          const otherStore = makeStore(sdk, otherIndex);
          const metadata = await otherStore.head(ref);
          expect(metadata?.sha256).toBe(sha256);
          // §3.3 的禁令：ETag 不是摘要，且两者必须可区分。
          expect(metadata?.etag).toBe(`"${key}"`);
          expect(metadata?.etag).not.toBe(sha256);
          expect(metadata?.byteLength).toBe(body.byteLength);

          const stream = await otherStore.getPrivate({
            ref,
            maxBytes: 1024,
            abortSignal: idleAbortSignal(),
          });
          expect(stream.sha256).toBe(sha256);
          expect(await collect(stream.body)).toEqual(body);
        } finally {
          await secondary.dispose();
        }
      });
    });

    it('D2 · 注入「索引缺失」：provider 里有对象，但平台没写过它 ⇒ head 与 getPrivate（含 Range）一律 404', async () => {
      await withMigratedDatabase(async (harness) => {
        const sdk = new FakeBlobSdk();
        const index = PostgresBlobDigestIndex.of(harness.adapter);
        const store = makeStore(sdk, index);
        const key = 'artifacts/dd/unindexed';
        const body = bytes(24, 12);

        // 阳性对照先跑：同样的形状（provider 有对象）在**索引存在**时是可读的。
        await index.remember(key, sha256Of(body));
        sdk.blobs.set(key, {
          bytes: body,
          contentType: 'application/octet-stream',
          etag: `"${key}"`,
        });
        expect((await store.head(parseObjectRef(key)))?.sha256).toBe(sha256Of(body));

        // 注入：只删索引行，provider 里的对象**不动**。
        await harness.adapter.transaction(async (tx) => {
          await tx.execute('DELETE FROM blob_digest_index WHERE pathname = $1', [key]);
        });
        expect(sdk.blobs.has(key)).toBe(true);
        expect(await index.digestOf(key)).toBeNull();

        // 变红。
        expect(await store.head(parseObjectRef(key))).toBeNull();
        expect(
          await rejectedCode(
            store.getPrivate({
              ref: parseObjectRef(key),
              maxBytes: 1024,
              abortSignal: idleAbortSignal(),
            }),
          ),
        ).toBe('OBJECT_NOT_FOUND');
        // Range 读取也必须被挡：只挡整对象读取的话，攻击者改用 `bytes=0-0` 就能读通。
        expect(
          await rejectedCode(
            store.getPrivate({
              ref: parseObjectRef(key),
              range: { start: 0, endInclusive: 0 },
              maxBytes: 1024,
              abortSignal: idleAbortSignal(),
            }),
          ),
        ).toBe('OBJECT_NOT_FOUND');

        // 还原 ⇒ 变绿。
        await index.remember(key, sha256Of(body));
        expect((await store.head(parseObjectRef(key)))?.sha256).toBe(sha256Of(body));
      });
    });

    it('D3 · 注入「摘要故意错误」：provider **根本没被联系**，索引里也不留行', async () => {
      await withMigratedDatabase(async (harness) => {
        const sdk = new FakeBlobSdk();
        const index = PostgresBlobDigestIndex.of(harness.adapter);
        const store = makeStore(sdk, index);
        const key = 'artifacts/dd/wrong-digest';
        const body = bytes(24, 13);

        // 阳性对照：摘要正确时能写成。记下此刻的调用轨迹，好在注入之后比对「一次都没多」。
        const goodKey = 'artifacts/dd/right-digest';
        await store.putImmutable(putInput(body, goodKey, sha256Of(body)));
        expect(sdk.putPathnames).toEqual([goodKey]);
        const putsBefore = sdk.putPathnames.length;
        const headsBefore = sdk.headCalls.length;
        expect(headsBefore).toBe(1);

        // 注入：同一份内容，声称一个**不同**的合法摘要。
        const wrong = sha256Of(bytes(24, 14));
        expect(wrong).not.toBe(sha256Of(body));
        expect(await rejectedCode(store.putImmutable(putInput(body, key, wrong)))).toBe(
          'OBJECT_HASH_MISMATCH',
        );

        // 变红，且红在**联系 provider 之前**：`putImmutable` 先收满流、验完摘要，才 `head`/`put`。
        // 所以 provider 侧一次调用都没多出来，store 里也不会留一个没人认账的对象。
        expect(sdk.putPathnames.length).toBe(putsBefore);
        expect(sdk.headCalls.length).toBe(headsBefore);
        expect(sdk.blobs.has(key)).toBe(false);
        expect(await digestRowCount(harness, key)).toBe('0');
        expect(await index.digestOf(key)).toBeNull();

        // 还原：把摘要改对，同一个 key 就能写成。
        await store.putImmutable(putInput(body, key, sha256Of(body)));
        expect(sdk.blobs.has(key)).toBe(true);
        expect(await index.digestOf(key)).toBe(sha256Of(body));
      });
    });

    it('D4 · 注入「Blob 不存在」：索引里有行、provider 里没有对象 ⇒ 404，且不泄漏「索引里有」', async () => {
      await withMigratedDatabase(async (harness) => {
        const sdk = new FakeBlobSdk();
        const index = PostgresBlobDigestIndex.of(harness.adapter);
        const store = makeStore(sdk, index);
        const key = 'artifacts/dd/missing-blob';
        const body = bytes(24, 15);
        const sha256 = sha256Of(body);

        // 阳性对照：两边都有时可读。
        await store.putImmutable(putInput(body, key, sha256));
        expect((await store.head(parseObjectRef(key)))?.sha256).toBe(sha256);

        // 注入：只从 provider 侧删掉对象，索引行**不动**。
        sdk.blobs.delete(key);
        expect(await index.digestOf(key)).toBe(sha256);

        // 变红：与 D2 同一个码。两种缺失（索引缺 / 对象缺）对外**同形**，
        // 探测者无法据此区分「平台写过但对象丢了」与「平台从没写过」。
        expect(await store.head(parseObjectRef(key))).toBeNull();
        expect(
          await rejectedCode(
            store.getPrivate({
              ref: parseObjectRef(key),
              maxBytes: 1024,
              abortSignal: idleAbortSignal(),
            }),
          ),
        ).toBe('OBJECT_NOT_FOUND');

        // 还原 ⇒ 变绿。
        await store.putImmutable(putInput(body, key, sha256));
        expect((await store.head(parseObjectRef(key)))?.sha256).toBe(sha256);
      });
    });

    it('D5 · provider 抛 not-found 时按类名翻译成 OBJECT_NOT_FOUND，不读 message', async () => {
      await withMigratedDatabase(async (harness) => {
        const sdk = new FakeBlobSdk();
        const store = makeStore(sdk, PostgresBlobDigestIndex.of(harness.adapter));
        const key = 'artifacts/dd/provider-404';
        // 让 `get` 抛一个真 SDK 形状的异常，而不是返回 null。
        sdk.get = async () => {
          throw new BlobNotFoundError(`Vercel Blob: not found https://example.invalid/${key}`);
        };
        const code = await rejectedCode(
          store.getPrivate({
            ref: parseObjectRef(key),
            maxBytes: 1024,
            abortSignal: idleAbortSignal(),
          }),
        );
        expect(code).toBe('OBJECT_NOT_FOUND');
      });
    });
  },
);

describe.skipIf(probe === null)('E 组 · owner_secrets 的密文持久化（§3.2，真库）', () => {
  it('E1 · set 之后：configured=true，密文四列非空，而明文在整个行里**不出现**', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 1);
      const store = makeSecretStore(cipher, harness);
      const plaintext = new TextEncoder().encode('a-secret-value-that-must-never-be-stored');

      const ref = await store.set(secretInput(ownerId, plaintext));
      expect(ref.startsWith('sec_')).toBe(true);

      const row = await rawSecretRow(harness, ownerId);
      expect(row).not.toBeNull();
      expect(row?.configured).toBe(true);
      expect(String(row?.generation)).toBe('1');
      expect(row?.current_ref).toBe(ref);
      for (const column of ['ciphertext', 'nonce', 'tag', 'key_version'] as const) {
        expect(row?.[column], `${column} 不该为 NULL`).not.toBeNull();
      }

      // 明文不出现在任何一列里。`record::text` 是 jsonb 的文本形式，覆盖了整个 payload。
      const plaintextText = new TextDecoder().decode(plaintext);
      const serialized = JSON.stringify(row);
      // 阳性对照：同一份序列化里必须能扫到「已知会在库里出现」的东西，
      // 否则「扫不到明文」可能只是因为查询返回了空对象而恒真。
      expect(serialized).toContain(ref);
      expect(serialized).toContain('QCA_PAT');
      expect(serialized).not.toContain(plaintextText);
      // 明文的 hex 形式也不能出现（bytea 列是以 `\x…` 十六进制文本读回来的）。
      const plaintextHex = Buffer.from(plaintext).toString('hex');
      expect(serialized).not.toContain(plaintextHex);
      expect(plaintextHex.includes(plaintextHex)).toBe(true);
    });
  });

  it('E2 · revoke 之后：configured=false，密文**四列全 NULL**（撤销即销毁）', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 1);
      const store = makeSecretStore(cipher, harness);
      await store.set(secretInput(ownerId, new TextEncoder().encode('to-be-destroyed')));
      expect((await rawSecretRow(harness, ownerId))?.ciphertext).not.toBeNull();

      await store.revoke(revokeInput(ownerId, 1));

      const row = await rawSecretRow(harness, ownerId);
      expect(row?.configured).toBe(false);
      expect(row?.current_ref).toBeNull();
      // PM 复算项⑤说的是「三个密文列」，DDL 的 `owner_secrets_cipher_shape` 要求的是
      // **四列**（含 `key_version`）。这里按 DDL 断言四列，差异在交付说明里申报。
      expect(row?.ciphertext).toBeNull();
      expect(row?.nonce).toBeNull();
      expect(row?.tag).toBeNull();
      expect(row?.key_version).toBeNull();
      // 撤销不删行：审计需要的 `revokedAt` 还在 payload 里。
      expect(await secretRowCount(harness, ownerId)).toBe('1');
    });
  });

  it('E3 · generation CAS：拿旧版本号去写 ⇒ null（不是抛），且库里仍是新的一代', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 1);
      const store = makeSecretStore(cipher, harness);
      const records = PostgresSecretRecordStore.of(harness.adapter);

      const first = await store.set(secretInput(ownerId, new TextEncoder().encode('generation-1')));
      const second = await store.rotate(
        rotateInput(ownerId, new TextEncoder().encode('generation-2'), 1),
      );
      expect(second).not.toBe(first);
      expect(String((await rawSecretRow(harness, ownerId))?.generation)).toBe('2');

      // 直接打仓储层：拿旧版本号 1 去写，必须得到 null。
      const stale = await records.load(ownerId, KIND);
      if (stale === null) throw new Error('load 不该返回 null：刚刚才写过两代');
      expect(stale.record.generation).toBe(2);
      const saved = await records.save(ownerId, { record: stale.record, secret: stale.secret }, 1);
      expect(saved).toBeNull();
      // 没被旧版本号覆盖掉。
      expect(String((await rawSecretRow(harness, ownerId))?.generation)).toBe('2');

      // 经端口层：同一件事表现为 SECRET_VERSION_CONFLICT。
      expect(
        await rejectedCode(store.rotate(rotateInput(ownerId, new TextEncoder().encode('x'), 1))),
      ).toBe('SECRET_VERSION_CONFLICT');
      expect(await rejectedCode(store.revoke(revokeInput(ownerId, 1)))).toBe(
        'SECRET_VERSION_CONFLICT',
      );

      // 另一条连接上的第二个仓储实例看到的也是同一代 —— CAS 落在行锁上，不是落在进程内存里。
      const secondary = await secondaryAdapter(harness);
      try {
        const other = PostgresSecretRecordStore.of(secondary.adapter);
        const loaded = await other.load(ownerId, KIND);
        expect(loaded?.record.generation).toBe(2);
        expect(loaded?.record.currentRef).toBe(second);
        expect(await other.findByRef(first)).toBeNull();
      } finally {
        await secondary.dispose();
      }
    });
  });

  it('E4 · 轮换与撤销之后，旧 ref 与「从未存在过的 ref」**完全同形**', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 1);
      const store = makeSecretStore(cipher, harness);
      const records = PostgresSecretRecordStore.of(harness.adapter);
      const purpose: SecretPurpose = purposeOf(KIND);

      const first = await store.set(secretInput(ownerId, new TextEncoder().encode('generation-1')));
      const second = await store.rotate(
        rotateInput(ownerId, new TextEncoder().encode('generation-2'), 1),
      );

      // 轮换后旧 ref 立刻不可读，新 ref 可读。
      expect(await rejectedCode(store.read(first, purpose))).toBe('SECRET_NOT_CONFIGURED');
      expect(await store.read(second, purpose)).toEqual(new TextEncoder().encode('generation-2'));
      expect(await records.findByRef(first)).toBeNull();

      await store.revoke(revokeInput(ownerId, 2));
      expect(await records.findByRef(second)).toBeNull();

      // 同形性：三个 ref（轮换掉的、撤销掉的、从没存在过的）在仓储层得到的是同一个答案。
      // `newSecretRef()` 造一个形状合法但库里没有的句柄，比手写一串 0 更像真实探测。
      const neverExisted = newSecretRef();
      expect(neverExisted).not.toBe(first);
      expect(neverExisted).not.toBe(second);
      const answers = [
        await records.findByRef(first),
        await records.findByRef(second),
        await records.findByRef(neverExisted),
      ];
      expect(answers).toEqual([null, null, null]);
      // 端口层同样同形：三个都是 SECRET_NOT_CONFIGURED，没有一种会多出细节。
      // 撤销掉的 ref 也是这个码，不是 SECRET_REVOKED —— 见本用例末尾的申报。
      const codes = [
        await rejectedCode(store.read(first, purpose)),
        await rejectedCode(store.read(second, purpose)),
        await rejectedCode(store.read(neverExisted, purpose)),
      ];
      expect(codes).toEqual([
        'SECRET_NOT_CONFIGURED',
        'SECRET_NOT_CONFIGURED',
        'SECRET_NOT_CONFIGURED',
      ]);

      // ⚠️ 申报（**基线代码**里的发现，本单不改它）：`EncryptedSecretStore.#decrypt` 里
      // `SECRET_REVOKED` 与 `SECRET_NOT_CONFIGURED` 这两个码在两个调用点上都不可达 ——
      // `read` 先经 `findByRef`，而 ref 能解析就意味着 `current_ref` 非 NULL，
      // domain 的不变量 `configured === (currentRef !== null)` 于是保证 `configured` 为真，
      // `#decrypt` 的 `!record.configured` 分支进不去；`set` 里的 `#decrypt` 也只在
      // `current.record.configured` 为真时才被调用。也就是说「已撤销」在端口层的真实表现是
      // `SECRET_NOT_CONFIGURED`，`SECRET_REVOKED` 只能从 domain 的 `revokeSecretRecord`
      // 一侧产生。这是一条对外语义的事实（撤销与从未配置同形），不是缺陷 —— 裁定一的
      // 不变量 1 恰恰要求这种同形。按「申报冲突、不自行裁定」留痕，不改基线代码。
    });
  });

  it('E5 · 根密钥与密文都不经仓储层：MASTER_KEY_UNAVAILABLE / VERSION_MISMATCH / DECRYPT_FAILED 三个码各自可达', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      const plaintext = new TextEncoder().encode('versioned-secret');
      const cipherV1 = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 1);
      const storeV1 = makeSecretStore(cipherV1, harness);
      const ref = await storeV1.set(secretInput(ownerId, plaintext));
      expect(await storeV1.read(ref, purposeOf(KIND))).toEqual(plaintext);

      // ① 版本不符：写进去的是 1，用 2 去读。
      //    这条**只有**真库能证明 —— `key_version` 是从列里读回来的，不是就地填成当前版本。
      //    若 `secretFromRow` 把它填成「现在这把」，这个码就永远不可达。
      const cipherV2 = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 2);
      const storeV2 = makeSecretStore(cipherV2, harness);
      expect(await rejectedCode(storeV2.read(ref, purposeOf(KIND)))).toBe(
        'MASTER_KEY_VERSION_MISMATCH',
      );
      expect(String((await rawSecretRow(harness, ownerId))?.key_version)).toBe('1');

      // ② 同版本、不同密钥字节 ⇒ 只有一个码，不区分「标签不对」与「AAD 不对」。
      const wrongKey = new SecretCipher(parseMasterKey(differentKeyBytes()), 1);
      const storeWrongKey = makeSecretStore(wrongKey, harness);
      expect(await rejectedCode(storeWrongKey.read(ref, purposeOf(KIND)))).toBe(
        'SECRET_DECRYPT_FAILED',
      );

      // ③ 环境变量里没有根密钥 ⇒ 连 cipher 都造不出来，谈不上读库。
      expect(await rejectedCode(Promise.resolve().then(() => loadMasterKey({}, 1)))).toBe(
        'MASTER_KEY_UNAVAILABLE',
      );

      // 元数据的结构里没有任何能装明文/密文的字段。
      const metadata = await storeV1.metadata(ownerId, KIND);
      expect(Object.keys(metadata).sort()).toEqual([
        'configured',
        'revokedAt',
        'rotatedAt',
        'version',
      ]);
      expect(JSON.stringify(metadata)).not.toContain(new TextDecoder().decode(plaintext));
      expect(metadata.version).toBe(1);
    });
  });

  it('E6 · owner_secrets_cipher_shape 是数据库级 CHECK：configured=false 却带密文 ⇒ 23514', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      // 先写一行合法的 configured=false（撤销态），证明这张表本身能收这种行。
      const unconfigured = unconfiguredStoredSecret(KIND);
      const records = PostgresSecretRecordStore.of(harness.adapter);
      expect(await records.save(ownerId, unconfigured, 0)).not.toBeNull();
      const ok = await rawSecretRow(harness, ownerId);
      expect(ok?.configured).toBe(false);
      expect(ok?.ciphertext).toBeNull();

      // 注入：绕过应用层，直接用裸 SQL 写一行「未配置却带密文」。
      // 这一条必须由**数据库**拒绝，而不是由 `assertStoredSecretShape` 拒绝 ——
      // 后者是应用层纪律，忘了调用就没了；前者忘了也没用。
      const error = await harness.adapter
        .transaction(async (tx) => {
          await tx.execute(
            `UPDATE owner_secrets SET ciphertext = $1::bytea WHERE owner_id = $2 AND kind = $3`,
            [Buffer.from([1, 2, 3]), ownerId, KIND],
          );
        })
        .then(
          () => null,
          (cause: unknown) => cause,
        );
      expect(error).not.toBeNull();
      // CHECK 违反的 SQLSTATE 是 23514。node-pg 把 SQLSTATE 放在 `.code` 上，
      // **不在** message 里，所以 `String(error)` 扫不到它 —— 必须读 `.code`。
      expect((error as { readonly code?: unknown }).code).toBe('23514');
      expect(String(error)).toContain('owner_secrets_cipher_shape');

      // 库里仍是原来那一行：事务回滚了。
      const after = await rawSecretRow(harness, ownerId);
      expect(after?.configured).toBe(false);
      expect(after?.ciphertext).toBeNull();
    });
  });

  it('E7 · owner_secrets_ref_shape：configured 与 current_ref 必须同生同灭', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      const records = PostgresSecretRecordStore.of(harness.adapter);
      await records.save(ownerId, unconfiguredStoredSecret(KIND), 0);

      // 未配置却带 ref ⇒ 数据库拒绝。
      const error = await harness.adapter
        .transaction(async (tx) => {
          await tx.execute(
            `UPDATE owner_secrets SET current_ref = $1 WHERE owner_id = $2 AND kind = $3`,
            ['sec_11111111111111111111111111111111', ownerId, KIND],
          );
        })
        .then(
          () => null,
          (cause: unknown) => cause,
        );
      expect(error).not.toBeNull();
      expect((error as { readonly code?: unknown }).code).toBe('23514');
      expect(String(error)).toContain('owner_secrets_ref_shape');
      expect((await rawSecretRow(harness, ownerId))?.current_ref).toBeNull();
    });
  });

  it('E8 · 仓储层的三条前置拒绝：空 ownerId、形状不符、purpose 与 kind 不匹配', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 1);
      const store = makeSecretStore(cipher, harness);
      const records = PostgresSecretRecordStore.of(harness.adapter);

      // 空 ownerId 是调用方的编程错误，不是冲突；放在 SQL 之前判，
      // 因为空串会被 uuid 列拒成驱动原文，而那段文本里带着连接目标（§4.1 禁止外泄）。
      expect(await rejectedCode(records.load('', KIND))).toBe('SECRET_CONTEXT_INVALID');
      expect(await rejectedCode(records.save('', unconfiguredStoredSecret(KIND), 0))).toBe(
        'SECRET_CONTEXT_INVALID',
      );

      // configured 与 secret 分叉 ⇒ 形状检查拒绝，且**没有**碰库。
      const mismatched = {
        record: unconfiguredStoredSecret(KIND).record,
        secret: cipher.encrypt(new TextEncoder().encode('x'), {
          ownerId,
          kind: KIND,
          version: 1,
        }),
      };
      expect(await rejectedCode(records.save(ownerId, mismatched, 0))).toBe(
        'SECRET_DECRYPT_FAILED',
      );
      expect(await secretRowCount(harness, ownerId)).toBe('0');

      // 跨 purpose 读取：把 QCA PAT 当百炼 key 发出去是一次跨 provider 的凭据泄漏。
      const ref = await store.set(secretInput(ownerId, new TextEncoder().encode('pat-value')));
      expect(await rejectedCode(store.read(ref, 'bailian-call'))).toBe('SECRET_PURPOSE_MISMATCH');
      // 正确的 purpose 仍然可读（证明上一条不是因为「什么都读不了」而假绿）。
      expect(await store.read(ref, purposeOf(KIND))).toEqual(new TextEncoder().encode('pat-value'));
      expect(purposeOf(KIND)).toBe('qca-call');
    });
  });

  it('E9 · `save` 的五种情形：不存在+非0代 ⇒ null；不存在+0代 ⇒ 插入；存在+旧代 ⇒ null', async () => {
    await withMigratedDatabase(async (harness) => {
      const { ownerId } = await seedAccounts(harness);
      const records = PostgresSecretRecordStore.of(harness.adapter);
      const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 1);
      const store = makeSecretStore(cipher, harness);
      expect(await records.load(ownerId, KIND)).toBeNull();

      // 情形②：行不存在 + expectedVersion ≠ 0 ⇒ 直接 null，连 INSERT 都不发。
      expect(await records.save(ownerId, unconfiguredStoredSecret(KIND), 3)).toBeNull();
      expect(await secretRowCount(harness, ownerId)).toBe('0');

      // 情形①：行不存在 + expectedVersion === 0 ⇒ INSERT 成功。
      expect(await records.save(ownerId, unconfiguredStoredSecret(KIND), 0)).not.toBeNull();
      expect(await secretRowCount(harness, ownerId)).toBe('1');

      // 把 generation 推到 1，才能验情形④。
      await store.set(secretInput(ownerId, new TextEncoder().encode('generation-1')));
      expect(String((await rawSecretRow(harness, ownerId))?.generation)).toBe('1');

      // 情形④：行已存在（generation=1）+ expectedVersion=0 ⇒ UPDATE 不命中，
      // 接着 INSERT 撞 `(owner_id, kind)` 唯一索引被 `DO NOTHING` 收成 0 行 ⇒ null。
      // 这一条是「先 UPDATE 再 INSERT」写法里唯一的巧处，替身模拟不出来。
      expect(await records.save(ownerId, unconfiguredStoredSecret(KIND), 0)).toBeNull();
      // 而且没被覆盖回去。
      expect(String((await rawSecretRow(harness, ownerId))?.generation)).toBe('1');

      // 情形③：generation 相等 ⇒ UPDATE 命中 1 行 ⇒ 成功（幂等重写同一代）。
      const current = await records.load(ownerId, KIND);
      if (current === null) throw new Error('load 不该返回 null');
      expect(await records.save(ownerId, current, 1)).not.toBeNull();

      // 情形⑤：行已存在 + expectedVersion ≠ 0 且不等 ⇒ 直接 null。
      expect(await records.save(ownerId, current, 7)).toBeNull();
      expect(await secretRowCount(harness, ownerId)).toBe('1');
    });
  });
});

/**
 * `ObjectStore` 的 Vercel Blob 实现（ZLQ-194 §6.2、ZLQ-201 裁定一 §1）。
 *
 * ## 为什么这里只有「形状」，没有 SDK 的运行时导入
 * 本文件对 `@vercel/blob` **只做 `import type`**，真正调用 SDK 的是一个 `BlobSdkSurface`。
 * 两个理由，都不是为了测试方便：
 *
 * 1. **`BlobSdkSurface` 里没有任何 URL 字段。** SDK 的 `PutBlobResult` / `HeadBlobResult` /
 *    `GetBlobResult.blob` 全都带着 `url` 与 `downloadUrl`，而裁定一要求这两个值**根本不出现在
 *    对外交付物里**。把它们挡在 driver 之外，「不发 Blob URL」就不是每个调用点都要记得的纪律，
 *    而是这个类型装不下一个 URL —— 和 `ObjectRef` 的语法里没有 `:` 是同一招。
 * 2. **凭据不进这一层。** SDK 从 `BLOB_READ_WRITE_TOKEN` / `VERCEL_OIDC_TOKEN` 读凭据；把 SDK
 *    组装成 `BlobSdkSurface` 的那个适配器属于 D5（那里才有环境变量清单）。本单不引入任何凭据。
 *
 * ⚠️ 诚实分层：本文件的行为由**替身 surface** 测出来（见 `test/object-store-private-access`）。
 * 对**真实** private Blob store 的未授权拒绝、过期拒绝、真实日志无 provider URL，本单做不到，
 * 也**不声称做到** —— 那是 D5/D6 的验收。
 */
import { Buffer } from 'node:buffer';

import type { BlobAccessType } from '@vercel/blob';
import type { ArtifactDigest } from '@littleq/domain';

import { type InfraError, type InfraErrorCode, infraError, isInfraError } from '../errors.js';
import {
  type ByteRange,
  type HealthResult,
  type ObjectRef,
  type StoredObjectMetadata,
  type StoredObjectStream,
  byteRangeLength,
  isObjectRef,
  parseByteRange,
  parseObjectRef,
  parseStoredDigest,
} from '../types.js';
import {
  type ObjectStore,
  type GetPrivateInput,
  type PutImmutableInput,
} from '../ports/object-store.js';
import { collectStream, createBudgetTransform, throwIfAborted } from '../object-store/budget.js';

/**
 * 写入访问级别。**必须是 `'private'`** —— 这一行就是本单变异对照①的靶点：把它改成
 * `'public'`，`test/object-store-private-access.test.ts` 必须变红。
 */
export const PRIVATE_BLOB_ACCESS: BlobAccessType = 'private';

/** `list` 的单页上限（SDK 默认值）。`deletePrefix` 靠 `hasMore` + `cursor` 翻页。 */
export const BLOB_LIST_PAGE_SIZE = 1000;

/** put 的可选项。**全部必填**：漏掉 `allowOverwrite: false` 会让不可覆盖性悄悄失效。 */
export interface BlobPutOptions {
  readonly access: BlobAccessType;
  readonly addRandomSuffix: boolean;
  readonly allowOverwrite: boolean;
  readonly contentType: string;
  readonly maximumSizeInBytes: number;
  readonly abortSignal: AbortSignal;
}

export interface BlobGetOptions {
  readonly access: BlobAccessType;
  readonly useCache: boolean;
  readonly abortSignal: AbortSignal;
}

/** 摊平后的读结果：没有 `url` / `downloadUrl`，也没有 `blob` 子对象。 */
export interface BlobGetResult {
  readonly statusCode: number;
  readonly stream: ReadableStream<Uint8Array> | null;
  readonly size: number | null;
  readonly contentType: string | null;
}

export interface BlobHeadResult {
  readonly size: number;
  readonly contentType: string;
  readonly uploadedAt: Date;
  readonly etag: string;
}

export interface BlobPutResult {
  readonly pathname: string;
  readonly etag: string;
}

export interface BlobListResult {
  readonly blobs: readonly { readonly pathname: string }[];
  readonly cursor?: string;
  readonly hasMore: boolean;
}

export interface BlobSdkSurface {
  put(pathname: string, body: Uint8Array, options: BlobPutOptions): Promise<BlobPutResult>;
  get(pathname: string, options: BlobGetOptions): Promise<BlobGetResult | null>;
  /** `null` 表示不存在（适配器把 SDK 的 not-found 异常翻成 `null`）；抛出来的一律算真失败。 */
  head(pathname: string): Promise<BlobHeadResult | null>;
  del(pathnames: readonly string[]): Promise<void>;
  list(options: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<BlobListResult>;
}

/**
 * key → 内容 sha256 的旁路索引。
 *
 * 为什么绕不开：`StoredObjectMetadata.sha256` 是端口的必填项，而 Vercel Blob 的
 * `head` / `get` **不提供**内容摘要（只有 `etag`，分片上传时它不是内容 sha256），也没有
 * 用户自定义元数据字段可藏。所以摘要必须由平台自己记。D5 的实现是一张 SQL 表；本单的
 * 替身在 `test/` 里。
 *
 * 这带来一个**安全性质**（不是妥协）：`digestOf` 返回 `null` 意味着「provider 里有这个 key，
 * 但平台从没通过本 driver 写过它」，此时 `head` / 整对象 `getPrivate` 一律当作**不存在**。
 * 于是即便有人能往 store 里塞对象，也拿不到一条可读路径。
 */
export interface BlobDigestIndex {
  remember(pathname: string, sha256: ArtifactDigest): Promise<void>;
  digestOf(pathname: string): Promise<ArtifactDigest | null>;
}

export interface VercelBlobObjectStoreOptions {
  readonly sdk: BlobSdkSurface;
  readonly digests: BlobDigestIndex;
  /** 只用于 `health().checkedAt`；测试注入固定钟。 */
  readonly now?: () => Date;
}

/**
 * provider 异常 → 内部错误码。
 *
 * 只认**类名**，绝不读 `message`：SDK 的 `BlobError` 把原始报文拼进 message
 * （`Vercel Blob: ${message}`），而报文里可能带请求 URL。`InfraError` 上没有任何字段装得下
 * 它，所以「原始签名 URL 不落日志」在这一层是结构性的。匹配不上就退到
 * `PROVIDER_UNAVAILABLE`（对外 503，可重试）—— 猜一个更具体的码比承认不知道更危险。
 */
const BLOB_ERROR_CODES: ReadonlyMap<string, InfraErrorCode> = new Map<string, InfraErrorCode>([
  ['BlobNotFoundError', 'OBJECT_NOT_FOUND'],
  ['BlobFileTooLargeError', 'OBJECT_UPLOAD_TOO_LARGE'],
  ['BlobRequestAbortedError', 'OBJECT_UPLOAD_ABORTED'],
  ['BlobServiceRateLimited', 'OBJECT_READ_CONCURRENCY_LIMIT'],
  ['BlobPreconditionFailedError', 'OBJECT_ALREADY_EXISTS'],
]);

export function mapBlobError(error: unknown): InfraError {
  if (isInfraError(error)) return error;
  const name = error instanceof Error ? error.constructor?.name : undefined;
  const code = name === undefined ? undefined : BLOB_ERROR_CODES.get(name);
  return infraError(code ?? 'PROVIDER_UNAVAILABLE');
}

export class VercelBlobObjectStore implements ObjectStore {
  readonly #sdk: BlobSdkSurface;
  readonly #digests: BlobDigestIndex;
  readonly #now: () => Date;

  constructor(options: VercelBlobObjectStoreOptions) {
    this.#sdk = options.sdk;
    this.#digests = options.digests;
    this.#now = options.now ?? (() => new Date());
  }

  async putImmutable(input: PutImmutableInput): Promise<ObjectRef> {
    throwIfAborted(input.abortSignal);
    if (!isObjectRef(input.key)) throw infraError('OBJECT_KEY_INVALID');
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
      throw infraError('OBJECT_UPLOAD_TOO_LARGE');
    }
    if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 0) {
      throw infraError('OBJECT_DECLARED_BYTES_MISMATCH');
    }
    if (input.declaredBytes > input.maxBytes) throw infraError('OBJECT_UPLOAD_TOO_LARGE');

    // 先收满、验完，**再**联系 provider。反过来的话，一次摘要不符就得靠补偿删除来收残留，
    // 而补偿删除本身也可能失败 —— 那样 store 里会留下一个没人认账的对象。
    const budget = createBudgetTransform(input.maxBytes, 'OBJECT_UPLOAD_TOO_LARGE');
    const bytes = await collectStream(input.body.pipeThrough(budget.transform), input.abortSignal);
    if (budget.accounting.exceeded() || budget.accounting.bytes() !== bytes.byteLength) {
      throw infraError('OBJECT_UPLOAD_TOO_LARGE');
    }
    if (bytes.byteLength !== input.declaredBytes) {
      throw infraError('OBJECT_DECLARED_BYTES_MISMATCH');
    }
    const sha256 = parseStoredDigest(budget.accounting.digestHex(), 'OBJECT_HASH_MISMATCH');
    if (sha256 !== input.sha256) throw infraError('OBJECT_HASH_MISMATCH');

    // 非原子的快路径，只为给出精确的 `OBJECT_ALREADY_EXISTS`；真正的守卫是下面那个
    // `allowOverwrite: false`，它由 provider 在写入时判定。
    if ((await this.#guard(() => this.#sdk.head(input.key))) !== null) {
      throw infraError('OBJECT_ALREADY_EXISTS');
    }
    const result = await this.#guard(() =>
      this.#sdk.put(input.key, Buffer.from(bytes), {
        access: PRIVATE_BLOB_ACCESS,
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: input.contentType,
        maximumSizeInBytes: input.maxBytes,
        abortSignal: input.abortSignal,
      }),
    );
    // provider 若擅自改了 pathname（例如 `addRandomSuffix` 被打开），返回的 ref 就会指向
    // 一个不存在的 key。这一行让那种失误当场失败，而不是等到第一次读取。
    if (result.pathname !== input.key) throw infraError('OBJECT_KEY_INVALID');
    await this.#digests.remember(input.key, sha256);
    return parseObjectRef(input.key);
  }

  async getPrivate(input: GetPrivateInput): Promise<StoredObjectStream> {
    throwIfAborted(input.abortSignal, 'OBJECT_READ_ABORTED');
    const found = await this.#guard(() =>
      this.#sdk.get(input.ref, {
        access: PRIVATE_BLOB_ACCESS,
        // 关掉 CDN 缓存：读的是刚固化的产物，宁可慢也不能读到旧副本。
        useCache: false,
        abortSignal: input.abortSignal,
      }),
    );
    if (found === null) throw infraError('OBJECT_NOT_FOUND');
    if (found.statusCode !== 200 || found.stream === null || found.size === null) {
      throw infraError('PROVIDER_UNAVAILABLE');
    }
    const total = found.size;
    const requested =
      input.range === undefined
        ? null
        : parseByteRange(input.range.start, input.range.endInclusive);
    if (requested !== null && requested.start >= total) {
      throw infraError('OBJECT_RANGE_NOT_SATISFIABLE');
    }
    const range =
      requested === null
        ? null
        : { start: requested.start, endInclusive: Math.min(requested.endInclusive, total - 1) };

    // 索引查不到 = 平台从没通过本 driver 写过这个 key，一律当作不存在，**Range 读取也一样**：
    // 只在整对象读取时查的话，「塞进 store 的对象拿不到可读路径」就只剩一半 —— 攻击者改用
    // `Range: bytes=0-0` 就能把同一条路径读通。摘要本身仍只在整对象读取时交出（Range 读取的
    // 摘要没有意义，产物级摘要由固化清单承载）。
    const knownDigest = await this.#digests.digestOf(input.ref);
    if (knownDigest === null) throw infraError('OBJECT_NOT_FOUND');
    const sha256 = range === null ? knownDigest : null;

    const budget = createBudgetTransform(input.maxBytes, 'OBJECT_READ_BUDGET_EXCEEDED');
    const source = range === null ? found.stream : sliceRange(found.stream, range);
    return {
      ref: input.ref,
      byteLength: range === null ? total : byteRangeLength(range),
      contentType: found.contentType ?? 'application/octet-stream',
      sha256,
      range,
      body: source.pipeThrough(budget.transform),
      deliveredBytes: () => budget.accounting.bytes(),
    };
  }

  async head(ref: ObjectRef): Promise<StoredObjectMetadata | null> {
    const result = await this.#guard(() => this.#sdk.head(ref));
    if (result === null) return null;
    const sha256 = await this.#digests.digestOf(ref);
    if (sha256 === null) return null;
    return {
      ref,
      byteLength: result.size,
      contentType: result.contentType,
      sha256,
      createdAt: result.uploadedAt,
      etag: result.etag,
    };
  }

  /**
   * 逐页列出、把 key 收齐，**再**批量删。**空前缀直接返回**：`prefix: ''` 会列出整个 store，
   * 照做等于把平台所有产物一次删光，而调用方多半只是传了个没算好的变量。
   *
   * 之所以不是「翻一页删一页」：那样游标指向的位置会随着删除往前挪，而 provider 的 cursor
   * 是否「删除稳定」并没有写进契约 —— 一旦它是偏移量语义，第二次 list 就会跳过一批本该删掉
   * 的 key。那种漏删不报错，只会留下一堆没人认账的对象，比抛异常难查得多。收齐再删的代价
   * 是一份 key 列表的内存，而它天然有界（一个产物的孤儿分片、一个项目的 originals）。
   */
  async deletePrefix(prefix: string): Promise<void> {
    if (prefix === '') return;
    const pathnames: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#guard(() =>
        this.#sdk.list({ prefix, limit: BLOB_LIST_PAGE_SIZE, cursor }),
      );
      for (const blob of page.blobs) pathnames.push(blob.pathname);
      if (!page.hasMore || page.cursor === undefined) break;
      cursor = page.cursor;
    }
    for (let start = 0; start < pathnames.length; start += BLOB_LIST_PAGE_SIZE) {
      const batch = pathnames.slice(start, start + BLOB_LIST_PAGE_SIZE);
      await this.#guard(() => this.#sdk.del(batch));
    }
  }

  async health(): Promise<HealthResult> {
    const startedAt = Date.now();
    try {
      await this.#sdk.list({ limit: 1 });
      return {
        status: 'ok',
        checkedAt: this.#now(),
        latencyMs: Date.now() - startedAt,
        detail: null,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        checkedAt: this.#now(),
        latencyMs: Date.now() - startedAt,
        detail: mapBlobError(error).code,
      };
    }
  }

  async #guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw mapBlobError(error);
    }
  }
}

/**
 * 只从 provider 的流里取 `[start, endInclusive]`，取够立刻 `cancel()` 上游。
 *
 * 不 cancel 的话，一个 1 KiB 的 Range 会把整个对象（上界 15 MiB）从 CDN 拖下来：预算挡得住
 * 「交给调用方多少字节」，挡不住「provider 为我们发了多少字节」。
 */
function sliceRange(
  source: ReadableStream<Uint8Array>,
  range: ByteRange,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || value === undefined) {
          controller.close();
          return;
        }
        const chunkStart = offset;
        offset += value.byteLength;
        const from = Math.max(chunkStart, range.start);
        const to = Math.min(offset - 1, range.endInclusive);
        if (from <= to) {
          controller.enqueue(value.subarray(from - chunkStart, to - chunkStart + 1));
        }
        if (offset > range.endInclusive) {
          controller.close();
          await reader.cancel();
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

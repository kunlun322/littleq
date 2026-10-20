/**
 * 能力：`object-store-private-access` —— ZLQ-194 §14 第 1 项「未授权直读」在**端口这一侧**
 * 能证明的全部东西。
 *
 * ## 这里断言了什么
 * 1. `put` 传给 provider 的 `access` 是字面量 `'private'`（**变异对照 ①** 的靶子）；
 * 2. `get` 同样显式 `'private'`，并且 `useCache: false`；
 * 3. `allowOverwrite: false` / `addRandomSuffix: false` / `maximumSizeInBytes` 透传；
 * 4. 端口交出去的是**内部 key**，形状上装不下一个 URL（`ObjectRef` 的语法里没有 `:`）；
 * 5. provider 里存在、但平台从没通过本 driver 写过的 key，`head` 与 `getPrivate`（**含
 *    Range 读取**）一律当作不存在；
 * 6. provider 异常只按**类名**翻译，`message` 里的原始报文（可能带签名 URL）不出现在
 *    `InfraError` 的任何字段上；
 * 7. `deletePrefix('')` 是 no-op —— 空前缀会列出整个 store，照做等于删光平台所有产物；
 * 8. `health().detail` 只能是一个内部错误码。
 *
 * ## 这里**没有**证明什么
 * 真实 private Vercel Blob 的「未授权直读被 provider 拒绝」「Blob URL 不对外发」「过期 URL
 * 被拒」属于 **D5/D6** 的验收：那需要一个生产 Blob store 与真凭据，本单没有也不允许引入。
 * 下面的 SDK 是**本地替身**，它证明的是「driver 会不会把 `access` 传错、会不会把 URL 泄漏
 * 出去」，不是「Vercel 的服务端会不会拒绝一个匿名请求」。
 */
import { describe, expect, it } from 'vitest';

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
  PRIVATE_BLOB_ACCESS,
  VercelBlobObjectStore,
  mapBlobError,
} from '../src/drivers/vercel-blob.js';
import { idleAbortSignal, streamFromBytes } from '../src/object-store/budget.js';
import type { ObjectStore } from '../src/ports/object-store.js';
import { isObjectRef, parseObjectRef } from '../src/types.js';

import { bytes, readFailureCode, rejectedCode, sha256Of } from './support.js';

// provider SDK 的异常是按**类名**匹配的，所以替身必须用同样的类名。
class BlobNotFoundError extends Error {}
class BlobFileTooLargeError extends Error {}
class BlobPreconditionFailedError extends Error {}

interface RecordedBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
}

interface ListCall {
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** 记录每一次调用的入参，好让测试断言「driver 到底传了什么给 provider」。 */
class RecordingBlobSdk implements BlobSdkSurface {
  readonly blobs = new Map<string, RecordedBlob>();
  readonly putOptions: BlobPutOptions[] = [];
  readonly putPathnames: string[] = [];
  readonly getOptions: BlobGetOptions[] = [];
  readonly headCalls: string[] = [];
  readonly listCalls: ListCall[] = [];
  readonly delCalls: string[][] = [];
  /** 每次 `list` 最多返回几个 blob；用来逼出分页分支。 */
  listPageSize = 1000;
  /** 非 null 时下一次 SDK 调用抛它。 */
  failWith: Error | null = null;
  /** 非 null 时 `put` 返回这个 pathname（模拟 provider 擅自改 key）。 */
  renameTo: string | null = null;

  async put(pathname: string, body: Uint8Array, options: BlobPutOptions): Promise<BlobPutResult> {
    this.putOptions.push(options);
    this.putPathnames.push(pathname);
    if (this.failWith !== null) throw this.takeFailure();
    if (this.blobs.has(pathname) && !options.allowOverwrite) {
      throw new BlobPreconditionFailedError(`already exists: ${pathname}`);
    }
    const etag = `"${pathname}"`;
    this.blobs.set(pathname, {
      bytes: new Uint8Array(body),
      contentType: options.contentType,
      etag,
    });
    return { pathname: this.renameTo ?? pathname, etag };
  }

  async get(pathname: string, options: BlobGetOptions): Promise<BlobGetResult | null> {
    this.getOptions.push(options);
    if (this.failWith !== null) throw this.takeFailure();
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
    if (this.failWith !== null) throw this.takeFailure();
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
    this.delCalls.push([...pathnames]);
    if (this.failWith !== null) throw this.takeFailure();
    for (const pathname of pathnames) this.blobs.delete(pathname);
  }

  async list(options: ListCall): Promise<BlobListResult> {
    this.listCalls.push(options);
    if (this.failWith !== null) throw this.takeFailure();
    const all = [...this.blobs.keys()]
      .filter((key) => options.prefix === undefined || key.startsWith(options.prefix))
      .sort();
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const page = all.slice(start, start + this.listPageSize);
    const next = start + page.length;
    return {
      blobs: page.map((pathname) => ({ pathname })),
      hasMore: next < all.length,
      cursor: next < all.length ? String(next) : undefined,
    };
  }

  /** 直接塞一个对象进 provider，绕过 driver —— 用来造「平台没写过但 store 里有」的形状。 */
  seed(pathname: string, payload: Uint8Array, contentType = 'application/octet-stream'): void {
    this.blobs.set(pathname, { bytes: payload, contentType, etag: `"${pathname}"` });
  }

  private takeFailure(): Error {
    const failure = this.failWith;
    this.failWith = null;
    if (failure === null) throw new Error('替身状态不一致：failWith 被读走了两次');
    return failure;
  }
}

class RecordingDigestIndex implements BlobDigestIndex {
  readonly digests = new Map<string, ArtifactDigest>();

  async remember(pathname: string, sha256: ArtifactDigest): Promise<void> {
    this.digests.set(pathname, sha256);
  }

  async digestOf(pathname: string): Promise<ArtifactDigest | null> {
    return this.digests.get(pathname) ?? null;
  }
}

function harness(): {
  readonly store: ObjectStore & VercelBlobObjectStore;
  readonly sdk: RecordingBlobSdk;
  readonly digests: RecordingDigestIndex;
} {
  const sdk = new RecordingBlobSdk();
  const digests = new RecordingDigestIndex();
  const store = new VercelBlobObjectStore({ sdk, digests, now: () => new Date(0) });
  return { store, sdk, digests };
}

const KEY = 'artifacts/aa/bb/private-probe';

function putInput(payload: Uint8Array, key = KEY) {
  return {
    key,
    body: streamFromBytes(payload),
    declaredBytes: payload.byteLength,
    maxBytes: 1024,
    sha256: sha256Of(payload),
    contentType: 'application/octet-stream',
    abortSignal: idleAbortSignal(),
  };
}

describe('object-store-private-access：写入必须以 private 落到 provider', () => {
  it('put 传出去的 access 是字面量 private（变异对照 ①）', async () => {
    const { store, sdk } = harness();
    const payload = bytes(64, 11);

    const ref = await store.putImmutable(putInput(payload));

    expect(sdk.putOptions).toHaveLength(1);
    const options = sdk.putOptions[0];
    if (options === undefined) throw new Error('替身没记下 put 的入参');
    // 断言字面量，不断言 `PRIVATE_BLOB_ACCESS`：把常量改成 'public' 与把调用点改成
    // 'public' 是同一种失误的两种写法，只有字面量能同时抓住两者。
    expect(options.access).toBe('private');
    expect(options.access).not.toBe('public');
    expect(ref).toBe(KEY);
  });

  it('PRIVATE_BLOB_ACCESS 常量本身就是 private，且不是 public', () => {
    expect(PRIVATE_BLOB_ACCESS).toBe('private');
    expect(['public', 'private']).toContain(PRIVATE_BLOB_ACCESS);
  });

  it('put 关掉覆盖与随机后缀，并把大小上界透传给 provider', async () => {
    const { store, sdk } = harness();
    const signal = idleAbortSignal();

    await store.putImmutable({ ...putInput(bytes(32, 3)), abortSignal: signal });

    const options = sdk.putOptions[0];
    if (options === undefined) throw new Error('替身没记下 put 的入参');
    expect(options.allowOverwrite).toBe(false);
    expect(options.addRandomSuffix).toBe(false);
    expect(options.maximumSizeInBytes).toBe(1024);
    expect(options.contentType).toBe('application/octet-stream');
    expect(options.abortSignal).toBe(signal);
  });

  it('写入后把内容摘要记进旁路索引，body 交给 provider 的字节与入参一致', async () => {
    const { store, sdk, digests } = harness();
    const payload = bytes(80, 5);

    await store.putImmutable(putInput(payload));

    expect(digests.digests.get(KEY)).toBe(sha256Of(payload));
    const sent = sdk.blobs.get(KEY);
    if (sent === undefined) throw new Error('provider 替身里没有这个 key');
    expect(sent.bytes).toEqual(payload);
  });

  it('provider 已存在同一个 key 时拒绝覆盖（OBJECT_ALREADY_EXISTS）', async () => {
    const { store, sdk } = harness();
    const payload = bytes(24, 7);
    sdk.seed(KEY, payload);

    const code = await rejectedCode(store.putImmutable(putInput(payload)));

    expect(code).toBe('OBJECT_ALREADY_EXISTS');
    expect(sdk.putOptions).toHaveLength(0);
  });

  it('head 快路径漏掉时，provider 的 allowOverwrite:false 仍是最终守卫', async () => {
    const { store, sdk } = harness();
    const payload = bytes(24, 9);
    sdk.seed(KEY, payload);
    // 让快路径看不到它：head 返回 null，但 put 仍会因为 key 已存在而被 provider 拒。
    const realHead = sdk.head.bind(sdk);
    sdk.head = async (pathname: string) => {
      sdk.headCalls.push(pathname);
      return null;
    };

    const code = await rejectedCode(store.putImmutable(putInput(payload)));

    expect(code).toBe('OBJECT_ALREADY_EXISTS');
    expect(sdk.putOptions).toHaveLength(1);
    sdk.head = realHead;
  });

  it('provider 擅自改 pathname 时当场失败，不返回一个指向别处的 ref', async () => {
    const { store, sdk } = harness();
    sdk.renameTo = `${KEY}-random-suffix`;

    const code = await rejectedCode(store.putImmutable(putInput(bytes(16, 2))));

    expect(code).toBe('OBJECT_KEY_INVALID');
  });
});

describe('object-store-private-access：读取同样走 private，且不对外交出 URL', () => {
  it('get 传出去的 access 是字面量 private，并关掉 CDN 缓存', async () => {
    const { store, sdk } = harness();
    const payload = bytes(48, 13);
    await store.putImmutable(putInput(payload));
    sdk.getOptions.length = 0;

    const stream = await store.getPrivate({
      ref: parseObjectRef(KEY),
      maxBytes: 1024,
      abortSignal: idleAbortSignal(),
    });

    expect(sdk.getOptions).toHaveLength(1);
    const options = sdk.getOptions[0];
    if (options === undefined) throw new Error('替身没记下 get 的入参');
    expect(options.access).toBe('private');
    expect(options.useCache).toBe(false);
    expect(stream.ref).toBe(KEY);
  });

  it('端口交出去的是内部 key，形状上装不下 URL', async () => {
    const { store, sdk } = harness();
    const payload = bytes(40, 17);
    const ref = await store.putImmutable(putInput(payload));

    expect(isObjectRef(ref)).toBe(true);
    expect(ref).not.toContain('://');
    expect(ref).not.toContain('?');
    const putResultKeys = Object.keys((await sdk.head(KEY)) ?? {}).sort();
    expect(putResultKeys).toEqual(['contentType', 'etag', 'size', 'uploadedAt']);
    const metadata = await store.head(ref);
    if (metadata === null) throw new Error('刚写完就 head 不到');
    expect(Object.keys(metadata).sort()).toEqual([
      'byteLength',
      'contentType',
      'createdAt',
      'etag',
      'ref',
      'sha256',
    ]);
    expect(JSON.stringify(metadata)).not.toContain('://');
  });

  it('provider 里有、平台没写过的 key：head 与整对象读取都当作不存在', async () => {
    const { store, sdk, digests } = harness();
    const foreign = 'artifacts/ff/foreign-object';
    sdk.seed(foreign, bytes(32, 21));
    expect(digests.digests.has(foreign)).toBe(false);

    expect(await store.head(parseObjectRef(foreign))).toBeNull();
    const code = await rejectedCode(
      store.getPrivate({
        ref: parseObjectRef(foreign),
        maxBytes: 1024,
        abortSignal: idleAbortSignal(),
      }),
    );
    expect(code).toBe('OBJECT_NOT_FOUND');
  });

  it('同一个未索引对象，Range 读取也拿不到路径（不能靠 bytes=0-0 绕开）', async () => {
    const { store, sdk } = harness();
    const foreign = 'artifacts/ff/range-probe';
    sdk.seed(foreign, bytes(64, 23));

    const code = await rejectedCode(
      store.getPrivate({
        ref: parseObjectRef(foreign),
        range: { start: 0, endInclusive: 7 },
        maxBytes: 1024,
        abortSignal: idleAbortSignal(),
      }),
    );

    expect(code).toBe('OBJECT_NOT_FOUND');
  });

  it('已索引对象的 Range 读取成功，但不交出整对象摘要', async () => {
    const { store } = harness();
    const payload = bytes(64, 29);
    const ref = await store.putImmutable(putInput(payload));

    const stream = await store.getPrivate({
      ref,
      range: { start: 8, endInclusive: 15 },
      maxBytes: 1024,
      abortSignal: idleAbortSignal(),
    });

    expect(stream.sha256).toBeNull();
    expect(stream.byteLength).toBe(8);
    expect(stream.range).toEqual({ start: 8, endInclusive: 15 });
    const whole = await store.getPrivate({
      ref,
      maxBytes: 1024,
      abortSignal: idleAbortSignal(),
    });
    expect(whole.sha256).toBe(sha256Of(payload));
  });

  it('provider 返回非 200 或缺流时按依赖不可用处理，不当成空对象', async () => {
    const { store, sdk } = harness();
    await store.putImmutable(putInput(bytes(16, 31)));
    const realGet = sdk.get.bind(sdk);
    sdk.get = async (pathname: string, options: BlobGetOptions) => {
      const found = await realGet(pathname, options);
      return found === null ? null : { ...found, statusCode: 503, stream: null, size: null };
    };

    const code = await rejectedCode(
      store.getPrivate({
        ref: parseObjectRef(KEY),
        maxBytes: 1024,
        abortSignal: idleAbortSignal(),
      }),
    );

    expect(code).toBe('PROVIDER_UNAVAILABLE');
    sdk.get = realGet;
  });
});

describe('object-store-private-access：provider 异常只按类名翻译', () => {
  it('已知的 SDK 异常类名映射到内部码，message 里的签名 URL 一个字都不留', () => {
    const raw = 'https://blob.vercel-storage.example/x?sig=SHOULD-NOT-APPEAR&token=abc';

    const mapped = mapBlobError(new BlobNotFoundError(raw));

    expect(mapped.code).toBe('OBJECT_NOT_FOUND');
    expect(mapped.publicCode).toBe('RESOURCE_NOT_FOUND');
    expect(mapped.message).toBe('OBJECT_NOT_FOUND');
    expect(mapped.message).not.toContain('sig=');
    expect(JSON.stringify({ ...mapped, message: mapped.message })).not.toContain('vercel-storage');
    expect(mapBlobError(new BlobFileTooLargeError(raw)).code).toBe('OBJECT_UPLOAD_TOO_LARGE');
    expect(mapBlobError(new BlobPreconditionFailedError(raw)).code).toBe('OBJECT_ALREADY_EXISTS');
  });

  it('认不出的异常一律退到 PROVIDER_UNAVAILABLE，不猜一个更具体的码', () => {
    class SomethingNew extends Error {}

    const mapped = mapBlobError(new SomethingNew('boom'));

    expect(mapped.code).toBe('PROVIDER_UNAVAILABLE');
    expect(mapped.publicCode).toBe('DEPENDENCY_UNAVAILABLE');
    expect(mapped.retryable).toBe(true);
    expect(mapBlobError('not-an-error').code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('已经是 InfraError 的原样穿过，不被二次翻译', () => {
    const { store, sdk } = harness();
    void store;
    void sdk;
    const original = mapBlobError(new BlobNotFoundError('x'));
    expect(mapBlobError(original)).toBe(original);
  });

  it('health 失败时 detail 只是一个内部错误码', async () => {
    const { store, sdk } = harness();
    sdk.failWith = new BlobNotFoundError('https://provider.example/health?sig=SECRET');

    const result = await store.health();

    expect(result.status).toBe('unavailable');
    expect(result.detail).toBe('OBJECT_NOT_FOUND');
    expect(result.checkedAt.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('health 正常时 latencyMs 有值、detail 为 null', async () => {
    const { store } = harness();

    const result = await store.health();

    expect(result.status).toBe('ok');
    expect(result.detail).toBeNull();
    expect(typeof result.latencyMs).toBe('number');
  });
});

describe('object-store-private-access：空前缀删除是 no-op', () => {
  it('deletePrefix("") 既不 list 也不 del，store 一个字节都没少', async () => {
    const { store, sdk } = harness();
    await store.putImmutable(putInput(bytes(16, 41), 'artifacts/aa/one'));
    await store.putImmutable(putInput(bytes(16, 43), 'artifacts/bb/two'));
    const before = sdk.blobs.size;

    await store.deletePrefix('');

    expect(sdk.listCalls).toHaveLength(0);
    expect(sdk.delCalls).toHaveLength(0);
    expect(sdk.blobs.size).toBe(before);
  });

  it('按前缀删除只动匹配的那些，并会翻页', async () => {
    const { store, sdk } = harness();
    sdk.listPageSize = 1;
    await store.putImmutable(putInput(bytes(8, 47), 'artifacts/aa/one'));
    await store.putImmutable(putInput(bytes(8, 51), 'artifacts/aa/two'));
    await store.putImmutable(putInput(bytes(8, 53), 'artifacts/bb/three'));

    await store.deletePrefix('artifacts/aa/');

    expect([...sdk.blobs.keys()].sort()).toEqual(['artifacts/bb/three']);
    expect(sdk.delCalls.flat().sort()).toEqual(['artifacts/aa/one', 'artifacts/aa/two']);
    expect(sdk.listCalls.length).toBeGreaterThan(1);
    expect(sdk.listCalls.every((call) => call.prefix === 'artifacts/aa/')).toBe(true);
  });
});

describe('object-store-private-access：读取预算由端口自己兜住', () => {
  it('超出 maxBytes 的读取以预算码结束，不静默截断', async () => {
    const { store } = harness();
    const payload = bytes(64, 59);
    const ref = await store.putImmutable(putInput(payload));

    const stream = await store.getPrivate({
      ref,
      maxBytes: 16,
      abortSignal: idleAbortSignal(),
    });

    expect(await readFailureCode(stream.body)).toBe('OBJECT_READ_BUDGET_EXCEEDED');
    expect(stream.deliveredBytes()).toBeLessThanOrEqual(16);
  });

  it('写入前已经 abort 时，连 provider 都不联系', async () => {
    const { store, sdk } = harness();
    const controller = new AbortController();
    controller.abort();

    const code = await rejectedCode(
      store.putImmutable({
        ...putInput(bytes(16, 61)),
        abortSignal: controller.signal,
      }),
    );

    expect(code).toBe('OBJECT_UPLOAD_ABORTED');
    expect(sdk.putOptions).toHaveLength(0);
    expect(sdk.blobs.size).toBe(0);
  });
});

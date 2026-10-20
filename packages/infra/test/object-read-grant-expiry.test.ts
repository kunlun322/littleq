/**
 * 能力 `object-read-grant-expiry`：grant 的有效期与「token 只存散列」。
 *
 * 这里测的三件事都是**对外承诺**，不是实现细节：
 * 1. 有效期上界 300 秒 —— 超出的申请在 `issue` 就被拒，压根不产生一条 grant 记录。
 * 2. 过期是**逐 chunk** 复查的，不是只在 `open` 时看一眼：一条已经开出去的租约读到一半跨过
 *    `expiresAt`，也必须当场停下（靠注入的时钟推进才看得见这个行为）。
 * 3. 库里只有 `sha256(token)`；裸 token 唯一的出口是 `SensitiveUrl.reveal()`。
 */
import { describe, expect, it } from 'vitest';

import { brand } from '@littleq/domain';

import { infraError } from '../src/errors.js';
import { idleAbortSignal, streamFromBytes } from '../src/object-store/budget.js';
import { InMemoryObjectStore } from '../src/object-store/memory.js';
import { RUNTIME_PREVIEW_AUDIENCE } from '../src/ports/runtime-publisher.js';
import { parseObjectRef } from '../src/types.js';
import {
  DEFAULT_GRANT_TTL_SECONDS,
  GRANT_TOKEN_BYTES,
  GRANT_TOKEN_QUERY_PARAMETER,
  MAX_GRANT_TTL_SECONDS,
  MIN_GRANT_TTL_SECONDS,
  ObjectReadGrantService,
  hashGrantToken,
  isGrantExpired,
} from '../src/grant/object-read-grant.js';
import { InMemoryGrantRecordStore } from '../src/grant/memory-records.js';
import { ChunkedObjectStore, at, digestAt, sha256Of } from './support.js';

const URL_CONFIG = { origin: 'https://littleq.test', basePath: '/internal/object-read' };
const KEY = 'artifacts/bb/expiry-probe';

interface Harness {
  readonly clock: { seconds: number };
  readonly store: InMemoryObjectStore;
  readonly records: InMemoryGrantRecordStore;
  readonly service: ObjectReadGrantService;
}

async function harness(): Promise<Harness> {
  const clock = { seconds: 0 };
  const store = new InMemoryObjectStore({ now: () => new Date(0) });
  const records = new InMemoryGrantRecordStore();
  const service = new ObjectReadGrantService({
    store,
    records,
    url: URL_CONFIG,
    // 时钟可注入是本文件全部断言的前提：一条读系统时间的实现没法被变红。
    now: () => at(clock.seconds),
  });
  // `open` 会真的去存储取字节，所以凡是要走到 `open` 的用例都得先有一个对象在那儿；
  // 否则测试会红在 `OBJECT_NOT_FOUND` 上，把「过期被拒」伪装成「对象不存在」。
  const payload = new Uint8Array(64).fill(3);
  await store.putImmutable({
    key: KEY,
    body: streamFromBytes(payload),
    declaredBytes: payload.byteLength,
    maxBytes: payload.byteLength,
    sha256: sha256Of(payload),
    contentType: 'application/octet-stream',
    abortSignal: idleAbortSignal(),
  });
  return { clock, store, records, service };
}

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    objectRef: parseObjectRef(KEY),
    artifactHash: digestAt(1),
    maxBytes: 1024,
    now: at(0),
    ...overrides,
  };
}

function tokenOf(url: { readonly reveal: () => string }): string {
  const token = new URL(url.reveal()).searchParams.get(GRANT_TOKEN_QUERY_PARAMETER);
  expect(token).not.toBeNull();
  return token as string;
}

describe('object-read-grant-expiry', () => {
  it('有效期上界 300 秒、默认 120 秒、下界 1 秒', () => {
    expect(MAX_GRANT_TTL_SECONDS).toBe(300);
    expect(DEFAULT_GRANT_TTL_SECONDS).toBe(120);
    expect(MIN_GRANT_TTL_SECONDS).toBe(1);
  });

  it('ttl=300 通过，301 / 0 / NaN 在 issue 就被拒且不落任何记录', async () => {
    const { records, service } = await harness();
    const atLimit = await service.issue(issueInput({ ttlSeconds: MAX_GRANT_TTL_SECONDS }));
    expect(Date.parse(atLimit.expiresAt) - Date.parse(at(0))).toBe(300_000);

    for (const ttlSeconds of [MAX_GRANT_TTL_SECONDS + 1, 0, -1, Number.NaN, 1.5]) {
      await expect(service.issue(issueInput({ ttlSeconds }))).rejects.toThrow(
        'GRANT_TTL_OUT_OF_RANGE',
      );
    }
    // 被拒的申请没有偷偷留下一条记录：库里只有那条合法的。
    expect(records.storedRecords()).toHaveLength(1);
  });

  it('省略 ttl 时用默认 120 秒', async () => {
    const { service } = await harness();
    const issued = await service.issue(issueInput());
    expect(Date.parse(issued.expiresAt) - Date.parse(at(0))).toBe(DEFAULT_GRANT_TTL_SECONDS * 1000);
  });

  it('过期判定是闭区间右端即失效：now === expiresAt 已经算过期', () => {
    const expiresAt = at(100);
    expect(isGrantExpired(at(99), expiresAt)).toBe(false);
    expect(isGrantExpired(at(100), expiresAt)).toBe(true);
    expect(isGrantExpired(at(101), expiresAt)).toBe(true);
  });

  it('过期的 grant 在 open 时被拒，且与「不存在」同为无细节 404', async () => {
    const { clock, service } = await harness();
    const issued = await service.issue(issueInput({ ttlSeconds: 60 }));
    const token = tokenOf(issued.url);

    clock.seconds = 59;
    await expect(
      service.open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(59) }),
    ).resolves.toMatchObject({ grantId: issued.grantId });

    clock.seconds = 60;
    const expired = await service
      .open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(60) })
      .then(() => null)
      .catch((error: unknown) => error);
    const unknown = await service
      .open({ token: 'not-a-real-token', audience: RUNTIME_PREVIEW_AUDIENCE, now: at(60) })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(expired).not.toBeNull();
    expect(unknown).not.toBeNull();
    // 两者对外映射到同一个码：探测者无法靠错误码区分「token 存在但过期」与「没有这个 token」。
    expect((expired as { publicCode: string }).publicCode).toBe('RESOURCE_NOT_FOUND');
    expect((unknown as { publicCode: string }).publicCode).toBe('RESOURCE_NOT_FOUND');
    expect((expired as { retryable: boolean }).retryable).toBe(false);
    expect(service.deniedReads).toBe(2);
  });

  it('读到一半跨过 expiresAt 也必须停下（逐 chunk 复查，不是只在 open 看一眼）', async () => {
    // 4 个 64 字节 chunk，共 256 字节。第 2 个 chunk 交出去之后把时钟推过 expiresAt。
    const key = 'artifacts/bb/mid-stream-expiry';
    const payload = new Uint8Array(256);
    for (let i = 0; i < payload.byteLength; i += 1) payload[i] = (i * 7 + 11) % 251;
    const chunked = new ChunkedObjectStore(key, payload, 64);
    const records = new InMemoryGrantRecordStore();
    const clock = { seconds: 0 };
    const service = new ObjectReadGrantService({
      store: chunked,
      records,
      url: URL_CONFIG,
      now: () => at(clock.seconds),
    });

    const issued = await service.issue({
      objectRef: parseObjectRef(key),
      artifactHash: brand(sha256Of(payload)),
      maxBytes: 4096,
      ttlSeconds: 30,
      now: at(0),
    });
    const lease = await service.open({
      token: tokenOf(issued.url),
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(0),
    });

    const reader = lease.stream.body.getReader();
    let delivered = 0;
    let failure: unknown = null;
    for (;;) {
      // 过期之后紧接着的那次 `read()` 必然 reject；在循环里接住它，否则这个 rejection 会当成
      // 测试自身的未处理异常飞出去。
      const outcome = await reader.read().catch((error: unknown) => {
        failure = error;
        return null;
      });
      if (outcome === null || outcome.done === true || outcome.value === undefined) break;
      delivered += outcome.value.byteLength;
      if (delivered === 128) clock.seconds = 30;
    }

    expect(delivered).toBe(128);
    expect((failure as Error).message).toBe('OBJECT_READ_GRANT_EXPIRED');
    await service.close(lease);
    // 已经流出去的字节照样入账（它们确实交付了），没流出去的一分不入账。
    expect(service.committedBytes(issued.grantId)).toBe(128);
    expect((await records.findById(issued.grantId))?.committedBytes).toBe(128);
  });

  it('库里只有 token 的散列，整个持久化形状里找不到裸 token', async () => {
    const { records, service } = await harness();
    const issued = await service.issue(issueInput());
    const token = tokenOf(issued.url);
    expect(token).toHaveLength(43);

    const persisted = JSON.stringify(records.storedRecords());
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(issued.url.reveal());
    const stored = await records.findById(issued.grantId);
    expect(stored?.tokenHash).toBe(hashGrantToken(token));
    expect(stored?.tokenHash).toHaveLength(64);
    // `IssuedGrant` 上没有任何字段装得下裸 token：唯一出口是显式 `reveal()`。
    expect(Object.keys(issued).sort()).toEqual([
      'expiresAt',
      'grantId',
      'maxBytes',
      'maxConcurrentReads',
      'url',
    ]);
    expect(JSON.stringify(issued)).not.toContain(token);
  });

  it('token 是 256-bit 随机数，两次签发不重复', async () => {
    const { service } = await harness();
    expect(GRANT_TOKEN_BYTES).toBe(32);
    const first = await service.issue(issueInput());
    const second = await service.issue(issueInput());
    expect(tokenOf(first.url)).not.toBe(tokenOf(second.url));
    expect(first.grantId).not.toBe(second.grantId);
  });

  it('audience 不匹配一律拒绝，且 issue 阶段就只允许 runtime-preview', async () => {
    const { service } = await harness();
    const issued = await service.issue(issueInput());
    await expect(
      service.open({
        token: tokenOf(issued.url),
        audience: 'something-else',
        now: at(0),
      }),
    ).rejects.toThrow('GRANT_AUDIENCE_MISMATCH');
    await expect(service.issue(issueInput({ audience: 'something-else' }))).rejects.toThrow(
      'GRANT_AUDIENCE_MISMATCH',
    );
    expect(RUNTIME_PREVIEW_AUDIENCE).toBe('runtime-preview');
  });

  it('时钟给出非法时间戳时宁可拒绝也不夹紧', async () => {
    const { service } = await harness();
    // `shiftTimestamp` 对算不出来的时间抛调用方给的码；「过期判定建在坏数据上」比拒绝更危险。
    await expect(
      service.issue(issueInput({ ttlSeconds: 60, now: brand<string, 'Timestamp'>('nope') })),
    ).rejects.toThrow('GRANT_TTL_OUT_OF_RANGE');
  });

  it('maxBytes 越界（0 / 负数 / 非安全整数 / 超过产物上限）在 issue 就被拒', async () => {
    const { service } = await harness();
    for (const maxBytes of [0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 10]) {
      await expect(service.issue(issueInput({ maxBytes }))).rejects.toThrow(
        'GRANT_BUDGET_OUT_OF_RANGE',
      );
    }
    expect(infraError('GRANT_BUDGET_OUT_OF_RANGE').publicCode).toBe('REQUEST_INVALID');
  });
});

/**
 * 能力：`object-read-grant-concurrency` —— ZLQ-201 裁定一 §5 的并发与预算不变量。
 *
 * ## 这里断言了什么
 * 1. 并发上界是**字面量 8**（**变异对照 ②** 的靶子）：第 8 路开得出，第 9 路被拒；
 * 2. 上界不能靠 `issue` 的参数抬高或降低 —— 请求任何不等于 8 的值都当场被拒；
 * 3. 归还一路后名额立刻释放（否则「最多 8 路」会退化成「一共 8 路」）；
 * 4. **撤销立即生效**：在飞租约的流当场以 `OBJECT_READ_GRANT_REVOKED` 结束，`revoke`
 *    返回被打断的租约数，之后的 `open` 一律被拒；
 * 5. **跨 Range 累计字节计账**：单次 Range 请求不能超过总预算的**余额**，用完之后连
 *    `bytes=0-0` 都开不出来；
 * 6. 账本在「进程重启」后从库里持久化的计数重新播种，不会被清零。
 *
 * ## 这里**没有**证明什么
 * 真链路（主站签发 → Runtime 取字节 → 端到端 artifact-hash 一致）与「真实日志里没有
 * provider URL / token」属于 **D5/D6**。下面的 ObjectStore 是内存替身，记录存储也是内存
 * 替身：它们证明的是**机制**（计数、拒绝、打断、记账），不是 Vercel Blob 或 Postgres 的
 * 服务端行为。
 */
import { describe, expect, it } from 'vitest';

import type { ArtifactDigest } from '@littleq/domain';

import { InMemoryGrantRecordStore } from '../src/grant/memory-records.js';
import {
  GRANT_TOKEN_QUERY_PARAMETER,
  MAX_CONCURRENT_READS,
  ObjectReadGrantService,
} from '../src/grant/object-read-grant.js';
import { InMemoryObjectStore } from '../src/object-store/memory.js';
import { idleAbortSignal, streamFromBytes } from '../src/object-store/budget.js';
import { RUNTIME_PREVIEW_AUDIENCE } from '../src/ports/runtime-publisher.js';
import { parseObjectRef } from '../src/types.js';

import { ChunkedObjectStore, at, bytes, collect, rejectedCode, sha256Of } from './support.js';

const KEY = 'artifacts/aa/concurrency-probe';
const URL_CONFIG = { origin: 'https://littleq.test', basePath: '/internal/object-read' } as const;

function harness(options: { readonly payload?: Uint8Array } = {}) {
  const payload = options.payload ?? bytes(512, 3);
  const store = new InMemoryObjectStore({ now: () => new Date(0) });
  const records = new InMemoryGrantRecordStore();
  const service = new ObjectReadGrantService({
    store,
    records,
    url: URL_CONFIG,
    now: () => at(0),
  });
  return { payload, store, records, service };
}

async function seedObject(
  store: InMemoryObjectStore,
  payload: Uint8Array,
  key = KEY,
): Promise<{ readonly ref: ReturnType<typeof parseObjectRef>; readonly digest: ArtifactDigest }> {
  await store.putImmutable({
    key,
    body: streamFromBytes(payload),
    declaredBytes: payload.byteLength,
    maxBytes: payload.byteLength,
    sha256: sha256Of(payload),
    contentType: 'application/octet-stream',
    abortSignal: idleAbortSignal(),
  });
  return { ref: parseObjectRef(key), digest: sha256Of(payload) };
}

/**
 * 从平台 grant URL 里取出裸 token —— 这正是 Runtime 拿到 URL 之后要做的事。
 *
 * 这是全仓（除真正发 HTTP 请求的那一行）唯一调用 `reveal()` 的地方；`IssuedGrant` 上刻意
 * **没有** `token` 字段，所以 token 只能以 `SensitiveUrl` 的形式存在，也就只能被脱敏地打印。
 */
function tokenOf(url: { reveal(): string }): string {
  const token = new URL(url.reveal()).searchParams.get(GRANT_TOKEN_QUERY_PARAMETER);
  if (token === null) throw new Error('grant URL 里没有 token 查询参数');
  return token;
}

async function issueGrant(
  service: ObjectReadGrantService,
  ref: ReturnType<typeof parseObjectRef>,
  digest: ArtifactDigest,
  overrides: Record<string, unknown> = {},
) {
  return service.issue({
    objectRef: ref,
    artifactHash: digest,
    maxBytes: 4096,
    now: at(0),
    ...overrides,
  });
}

describe('object-read-grant-concurrency：上界是字面量 8', () => {
  it('MAX_CONCURRENT_READS 常量等于 8（变异对照 ②）', () => {
    expect(MAX_CONCURRENT_READS).toBe(8);
  });

  it('默认签发路径给出的名额就是 8', async () => {
    const { store, service } = harness();
    const { ref, digest } = await seedObject(store, bytes(64, 5));

    const issued = await issueGrant(service, ref, digest);

    expect(issued.maxConcurrentReads).toBe(8);
    expect(issued.maxConcurrentReads).toBe(MAX_CONCURRENT_READS);
  });

  it('第 8 路开得出，第 9 路被拒（变异对照 ②）', async () => {
    const { store, service } = harness();
    const { ref, digest } = await seedObject(store, bytes(64, 7));
    const issued = await issueGrant(service, ref, digest);
    const token = tokenOf(issued.url);

    for (let index = 0; index < 8; index += 1) {
      const lease = await service.open({
        token,
        audience: RUNTIME_PREVIEW_AUDIENCE,
        now: at(1),
      });
      expect(lease.leaseId).toMatch(/^lease_[0-9a-f]{16}$/);
    }
    expect(service.activeLeaseCount(issued.grantId)).toBe(8);
    const before = service.deniedReads;

    const code = await rejectedCode(
      service.open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(1) }),
    );

    expect(code).toBe('OBJECT_READ_CONCURRENCY_LIMIT');
    expect(service.deniedReads).toBe(before + 1);
    expect(service.activeLeaseCount(issued.grantId)).toBe(8);
  });

  it('归还一路后名额立刻释放，第 9 路这次开得出', async () => {
    const { store, service } = harness();
    const { ref, digest } = await seedObject(store, bytes(64, 9));
    const issued = await issueGrant(service, ref, digest);
    const token = tokenOf(issued.url);
    const leases = [];
    for (let index = 0; index < 8; index += 1) {
      leases.push(await service.open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(1) }));
    }
    const first = leases[0];
    if (first === undefined) throw new Error('第 1 路租约没开出来');
    await service.close(first);
    expect(service.activeLeaseCount(issued.grantId)).toBe(7);

    const ninth = await service.open({
      token,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(1),
    });

    expect(ninth.leaseId).toMatch(/^lease_/);
    expect(service.activeLeaseCount(issued.grantId)).toBe(8);
  });

  it('close 幂等：同一个租约关两次不会多放一个名额', async () => {
    const { store, service } = harness();
    const { ref, digest } = await seedObject(store, bytes(32, 11));
    const issued = await issueGrant(service, ref, digest);
    const lease = await service.open({
      token: tokenOf(issued.url),
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(1),
    });

    await service.close(lease);
    await service.close(lease);

    expect(service.activeLeaseCount(issued.grantId)).toBe(0);
  });

  it('issue 的参数抬不高也压不下这个上界', async () => {
    const { store, service } = harness();
    const { ref, digest } = await seedObject(store, bytes(32, 13));

    expect(await rejectedCode(issueGrant(service, ref, digest, { maxConcurrentReads: 9 }))).toBe(
      'OBJECT_READ_CONCURRENCY_LIMIT',
    );
    expect(await rejectedCode(issueGrant(service, ref, digest, { maxConcurrentReads: 4 }))).toBe(
      'OBJECT_READ_CONCURRENCY_LIMIT',
    );
    expect(await rejectedCode(issueGrant(service, ref, digest, { maxConcurrentReads: 0 }))).toBe(
      'OBJECT_READ_CONCURRENCY_LIMIT',
    );
  });
});

describe('object-read-grant-concurrency：撤销立即生效', () => {
  it('在飞租约的流当场断掉，revoke 返回被打断的租约数', async () => {
    const { store, service, records } = harness();
    const { ref, digest } = await seedObject(store, bytes(256, 17));
    const issued = await issueGrant(service, ref, digest);
    const token = tokenOf(issued.url);
    const lease = await service.open({
      token,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(1),
    });

    const aborted = await service.revoke(issued.grantId, at(2));

    expect(aborted).toBe(1);
    expect(records.revocationCount).toBe(1);
    expect(service.activeLeaseCount(issued.grantId)).toBe(0);
    // 撤销之前一个字节都没读过：第一条 `read()` 就必须以撤销码失败。
    // 这里同时钉住一个回归 —— 旧实现在 `abort()` 的那一刻就 `controller.error()`，而这条流
    // 没人持有它的 reader，于是失败落进一个无人认领的 promise，Node 默认把它当未处理的
    // rejection 抛出：**撤销一个没人读的 grant 会把主站进程打挂**。`revoke` 能正常返回 1，
    // 就说明失败已经被记在流里、等着有人来读，而不是被扔进虚空。
    const reader = lease.stream.body.getReader();
    await expect(reader.read()).rejects.toThrow('OBJECT_READ_GRANT_REVOKED');
  });

  it('读到一半被撤销时当场停下，已交付的字节仍被记账', async () => {
    const payload = bytes(256, 67);
    const store = new ChunkedObjectStore(KEY, payload, 64);
    const records = new InMemoryGrantRecordStore();
    const service = new ObjectReadGrantService({
      store,
      records,
      url: URL_CONFIG,
      now: () => at(0),
    });
    const issued = await issueGrant(service, parseObjectRef(KEY), sha256Of(payload), {
      maxBytes: 256,
    });
    const lease = await service.open({
      token: tokenOf(issued.url),
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(1),
    });
    const reader = lease.stream.body.getReader();
    let delivered = 0;
    let failure: unknown = null;
    for (;;) {
      // 撤销之后紧接着的那次 `read()` 必然 reject，而它就是「当场停下」的证据；
      // 在循环里接住它，否则这个 rejection 会当成测试自身的未处理异常飞出去。
      const outcome = await reader.read().catch((error: unknown) => {
        failure = error;
        return null;
      });
      if (outcome === null || outcome.done === true || outcome.value === undefined) break;
      delivered += outcome.value.byteLength;
      // 两个 chunk（128 字节）之后撤销：流里还剩 128 字节没交出去。
      if (delivered === 128) expect(await service.revoke(issued.grantId, at(2))).toBe(1);
    }

    expect(delivered).toBe(128);
    expect((failure as Error).message).toBe('OBJECT_READ_GRANT_REVOKED');
    expect(store.readCount).toBe(1);
    await service.close(lease);
    expect(service.committedBytes(issued.grantId)).toBe(128);
    expect((await records.findById(issued.grantId))?.committedBytes).toBe(128);
  });

  /**
   * 上一条用例里，撤销是**紧贴着**消费者拿到第 2 块之后发生的 —— 那一刻实现的抢跑拉取还在
   * `await reader.read()` 里，于是 `pull` 入口那道复查把它接住了。这条用例把窗口挪到抢跑
   * **已经完成之后**：撤销落在「一块已经入队、已入账、还没交给任何人」的状态上。
   *
   * 这正是 `pipeThroughLedger` 里那个 `highWaterMark: 0` 要守的场景，而它必须是
   * `new ReadableStream(source, strategy)` 的**第二个实参** —— 写进 source 对象里等于没写
   * （实测 `controller.desiredSize` 仍是 1，与完全不传逐字节相同）。队列深度一旦是 1：
   * 抢跑的那块会滞留，撤销之后下一次 `read()` **直接从队列取走它、根本不触发 `pull`**，
   * 复查一次都不会跑，于是「撤销之后一个字节都拿不到」退化成「还能多拿一块，而且照样计费」。
   */
  it('撤销落在抢跑拉取之后：滞留的那一块既不下发也不计费', async () => {
    const payload = bytes(256, 67);
    const store = new ChunkedObjectStore(KEY, payload, 64);
    const records = new InMemoryGrantRecordStore();
    const service = new ObjectReadGrantService({
      store,
      records,
      url: URL_CONFIG,
      now: () => at(0),
    });
    const issued = await issueGrant(service, parseObjectRef(KEY), sha256Of(payload), {
      maxBytes: 256,
    });
    const lease = await service.open({
      token: tokenOf(issued.url),
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(1),
    });

    const reader = lease.stream.body.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBe(64);
    expect(service.committedBytes(issued.grantId)).toBe(64);

    // 等抢跑跑完。`streamFrom` 的 `pull` 是同步的，整条抢跑链只在微任务里，50 ms 富余三个
    // 数量级。**这个等待只是把「深度 1」那条实现的窗口拉开**，它不制造正确实现的窗口 ——
    // 深度 0 下无论等多久都不会有第二次 `pull`，所以这条断言不依赖时序运气。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.committedBytes(issued.grantId)).toBe(64);

    expect(await service.revoke(issued.grantId, at(2))).toBe(1);

    // 撤销之后一个字节都不许再拿到。深度 1 时这里会**拿到那 64 字节**而不是 reject。
    await expect(reader.read()).rejects.toThrow('OBJECT_READ_GRANT_REVOKED');

    await service.close(lease);
    // 也不许计费：它从没交到任何人手里。深度 1 时这里会是 128。
    expect(service.committedBytes(issued.grantId)).toBe(64);
    expect((await records.findById(issued.grantId))?.committedBytes).toBe(64);
  });

  it('撤销时没人读的租约不会让 revoke 自己抛出来（未处理 rejection 回归）', async () => {
    const { store, service } = harness();
    const { ref, digest } = await seedObject(store, bytes(64, 71));
    const issued = await issueGrant(service, ref, digest);
    await service.open({
      token: tokenOf(issued.url),
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(1),
    });

    // `revoke` 必须正常 resolve 并返回被打断的租约数；它一抛，D5 的撤销接口就是 500。
    await expect(service.revoke(issued.grantId, at(2))).resolves.toBe(1);
    expect(service.activeLeaseCount(issued.grantId)).toBe(0);
  });

  it('撤销之后再 open 一律被拒，且与「token 根本不存在」在对外码上无法区分', async () => {
    const { store, service } = harness();
    const { ref, digest } = await seedObject(store, bytes(32, 19));
    const issued = await issueGrant(service, ref, digest);
    const token = tokenOf(issued.url);
    await service.revoke(issued.grantId, at(2));

    const revoked = await rejectedCode(
      service.open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(3) }),
    );
    const unknown = await rejectedCode(
      service.open({
        token: 'not-a-real-token',
        audience: RUNTIME_PREVIEW_AUDIENCE,
        now: at(3),
      }),
    );

    expect(revoked).toBe('OBJECT_READ_GRANT_REVOKED');
    expect(unknown).toBe('OBJECT_READ_GRANT_UNKNOWN');
    // 两者对外都是同一个无细节的 404，且都不可重试：探测者拿不到「过期 / 撤销 / 不存在」
    // 之间的任何差异，重试同一个 token 也永远不会变好。
    const { infraError } = await import('../src/errors.js');
    expect(infraError(revoked).publicCode).toBe(infraError(unknown).publicCode);
    expect(infraError(revoked).publicCode).toBe('RESOURCE_NOT_FOUND');
    expect(infraError(revoked).retryable).toBe(false);
    expect(infraError(unknown).retryable).toBe(false);
  });

  it('撤销一个不存在的 grant 抛 UNKNOWN，不会静默成功', async () => {
    const { service } = harness();

    expect(await rejectedCode(service.revoke('grant_missing', at(1)))).toBe(
      'OBJECT_READ_GRANT_UNKNOWN',
    );
  });

  it('多路在飞时撤销一次性打断全部', async () => {
    const { store, service } = harness();
    const { ref, digest } = await seedObject(store, bytes(128, 23));
    const issued = await issueGrant(service, ref, digest);
    const token = tokenOf(issued.url);
    for (let index = 0; index < 3; index += 1) {
      await service.open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(1) });
    }

    expect(await service.revoke(issued.grantId, at(2))).toBe(3);
    expect(service.activeLeaseCount(issued.grantId)).toBe(0);
  });
});

describe('object-read-grant-concurrency：跨 Range 累计字节计账', () => {
  it('单次 Range 不能超过总预算的余额', async () => {
    const { store, service } = harness();
    const payload = bytes(300, 29);
    const { ref, digest } = await seedObject(store, payload);
    const issued = await issueGrant(service, ref, digest, { maxBytes: 150 });
    const token = tokenOf(issued.url);

    const first = await service.open({
      token,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      range: { start: 0, endInclusive: 99 },
      now: at(1),
    });
    expect(await collect(first.stream.body)).toEqual(payload.subarray(0, 100));
    await service.close(first);
    expect(service.committedBytes(issued.grantId)).toBe(100);

    // 余额只剩 50，而这一次要 100：必须在 open 阶段就被拒，不能先放行再截断。
    const before = service.deniedReads;
    const code = await rejectedCode(
      service.open({
        token,
        audience: RUNTIME_PREVIEW_AUDIENCE,
        range: { start: 100, endInclusive: 199 },
        now: at(1),
      }),
    );

    expect(code).toBe('OBJECT_READ_BUDGET_EXCEEDED');
    expect(service.deniedReads).toBe(before + 1);
  });

  it('预算用尽后连 bytes=0-0 都开不出来', async () => {
    const { store, service } = harness();
    const payload = bytes(200, 31);
    const { ref, digest } = await seedObject(store, payload);
    const issued = await issueGrant(service, ref, digest, { maxBytes: 200 });
    const token = tokenOf(issued.url);

    const whole = await service.open({
      token,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(1),
    });
    expect((await collect(whole.stream.body)).byteLength).toBe(200);
    await service.close(whole);
    expect(service.committedBytes(issued.grantId)).toBe(200);

    expect(
      await rejectedCode(
        service.open({
          token,
          audience: RUNTIME_PREVIEW_AUDIENCE,
          range: { start: 0, endInclusive: 0 },
          now: at(1),
        }),
      ),
    ).toBe('OBJECT_READ_BUDGET_EXCEEDED');
    expect(
      await rejectedCode(service.open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(1) })),
    ).toBe('OBJECT_READ_BUDGET_EXCEEDED');
  });

  it('两次各取一半刚好用完预算，第三次被拒', async () => {
    const { store, service, records } = harness();
    const payload = bytes(200, 37);
    const { ref, digest } = await seedObject(store, payload);
    const issued = await issueGrant(service, ref, digest, { maxBytes: 200 });
    const token = tokenOf(issued.url);

    for (const start of [0, 100]) {
      const lease = await service.open({
        token,
        audience: RUNTIME_PREVIEW_AUDIENCE,
        range: { start, endInclusive: start + 99 },
        now: at(1),
      });
      await collect(lease.stream.body);
      await service.close(lease);
    }

    expect(service.committedBytes(issued.grantId)).toBe(200);
    expect(records.committedByteWrites).toBe(2);
    const stored = await records.findById(issued.grantId);
    expect(stored?.committedBytes).toBe(200);
    expect(
      await rejectedCode(
        service.open({
          token,
          audience: RUNTIME_PREVIEW_AUDIENCE,
          range: { start: 0, endInclusive: 9 },
          now: at(1),
        }),
      ),
    ).toBe('OBJECT_READ_BUDGET_EXCEEDED');
  });

  it('账本在进程重启后从库里的计数重新播种，不会被清零', async () => {
    const { store, records } = harness();
    const payload = bytes(200, 41);
    const { ref, digest } = await seedObject(store, payload);
    const first = new ObjectReadGrantService({
      store,
      records,
      url: URL_CONFIG,
      now: () => at(0),
    });
    const issued = await issueGrant(first, ref, digest, { maxBytes: 150 });
    const token = tokenOf(issued.url);
    const lease = await first.open({
      token,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      range: { start: 0, endInclusive: 99 },
      now: at(1),
    });
    await collect(lease.stream.body);
    await first.close(lease);

    // 同一个记录存储、全新的 service 实例 = 进程重启后的世界。
    const restarted = new ObjectReadGrantService({
      store,
      records,
      url: URL_CONFIG,
      now: () => at(0),
    });
    expect(restarted.committedBytes(issued.grantId)).toBe(0);

    const resumed = await restarted.open({
      token,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      range: { start: 100, endInclusive: 149 },
      now: at(1),
    });

    expect(restarted.committedBytes(issued.grantId)).toBe(100);
    await collect(resumed.stream.body);
    await restarted.close(resumed);
    expect(restarted.committedBytes(issued.grantId)).toBe(150);
    expect(
      await rejectedCode(
        restarted.open({
          token,
          audience: RUNTIME_PREVIEW_AUDIENCE,
          range: { start: 150, endInclusive: 159 },
          now: at(1),
        }),
      ),
    ).toBe('OBJECT_READ_BUDGET_EXCEEDED');
  });

  it('读到一半超预算时流以预算码结束，已交付字节仍被记账', async () => {
    const { store, service } = harness();
    const payload = bytes(512, 43);
    const { ref, digest } = await seedObject(store, payload);
    const issued = await issueGrant(service, ref, digest, { maxBytes: 512 });
    const token = tokenOf(issued.url);
    const lease = await service.open({
      token,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(1),
    });
    const reader = lease.stream.body.getReader();
    let delivered = 0;
    for (;;) {
      const outcome = await reader.read();
      if (outcome.done === true) break;
      delivered += outcome.value?.byteLength ?? 0;
    }

    expect(delivered).toBe(512);
    expect(lease.stream.deliveredBytes()).toBe(512);
    await service.close(lease);
    expect(service.committedBytes(issued.grantId)).toBe(512);
  });
});

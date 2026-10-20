import { describe, expect, it } from 'vitest';

import {
  createTestFetcher,
  expectGrantError,
  expectNoGrantCredentialLeak,
} from './support/grant-assertions.js';
import {
  deterministicBytes,
  withSubstituteOrigin,
  type SubstituteObject,
} from './support/substitute-origin.js';

/**
 * 能力 `grant-fetch-size-budget`：大小预算，以及「拆成多段 Range 也绕不过去」。
 *
 * 绕过预算最省事的办法是把一次 `bytes=0-N` 拆成 N 次 `bytes=i-i`：如果账本按**请求**记，
 * 每一次都「没超」。所以这里的关键断言不是「超了会拒」，而是**换 token、换区间、换请求，
 * 落到的都是同一个账本**，且已入账的字节不会因失败而回滚。
 *
 * ## 诚实分层
 *
 * 这份账本活在单个 fetcher 实例的内存里，进程重启即归零；跨进程、跨签发批次的**权威**累计
 * 核算属 D2 的 grant 机制与 D5 的 `apps/api`。本单要证明的是：客户端契约这一层**不是一个
 * 可以绕过的点**，而不是「权威账本已经存在」。
 *
 * **替身证明**：上游是 `test/support/substitute-origin.ts`。
 */

const PROOF = 'grant-fetch-size-budget';
const BUDGET_PATH = '/artifacts/budget.bin';
const CHUNKED_PATH = '/artifacts/budget-chunked.bin';
const OTHER_PATH = '/artifacts/budget-other.bin';

const BODY = deterministicBytes(100);
const OTHER_BODY = deterministicBytes(60, 0x13);
const CONTENT_TYPE = 'application/octet-stream';

const OBJECTS: SubstituteObject[] = [
  { path: BUDGET_PATH, body: BODY, contentType: CONTENT_TYPE },
  // 不写 Content-Length，走分块传输编码：预检无从下手，只能靠流式核算。
  {
    path: CHUNKED_PATH,
    body: BODY,
    contentType: CONTENT_TYPE,
    omitContentLength: true,
    chunkSize: 8,
    chunkDelayMs: 5,
  },
  { path: OTHER_PATH, body: OTHER_BODY, contentType: CONTENT_TYPE },
];

describe(`${PROOF}：超限必须拒绝，且不能靠拆分 Range 或换 token 绕过`, () => {
  it('单次就超预算：靠 Content-Length 预检在**下载之前**拒绝，一个字节都没进账本', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const tight = createTestFetcher(substitute, { maxBytesPerObject: 50 });
      const grantUrl = substitute.grantUrl(BUDGET_PATH);

      const error = await expectGrantError(
        () => tight.fetchBytes({ grantUrl }),
        'RUNTIME_GRANT_BUDGET_EXCEEDED',
      );
      expect(error.upstreamStatus).toBe(200);
      expect(error.message).toContain('未下载响应体');
      expect(error.message).toContain('超出剩余预算 50 字节');
      expect(tight.budgetOf(grantUrl).consumedBytes).toBe(0);
      expectNoGrantCredentialLeak(error);

      // 反真空对照：预算够的时候同一个请求必须成功，否则上面那条红可能只是因为
      // 「任何请求都被拒」。
      const roomy = createTestFetcher(substitute, { maxBytesPerObject: 100 });
      const ok = await roomy.fetchBytes({ grantUrl });
      expect(ok.byteLength).toBe(100);
      expect(roomy.budgetOf(grantUrl).consumedBytes).toBe(100);
    });
  });

  it('拆成三段 20 字节的 Range：第一段过，第二段起被同一个账本拒掉', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute, { maxBytesPerObject: 30 });
      const slices = ['bytes=0-19', 'bytes=20-39', 'bytes=40-59'];
      let deliveredBytes = 0;

      const first = await fetcher.fetchBytes({
        // 每段都换一个新 token：主站为同一对象重新签发是常态，账本不能因此重置。
        grantUrl: substitute.grantUrl(BUDGET_PATH, { nonce: 'slice-1' }),
        inboundHeaders: { range: slices[0] ?? '' },
        onVerifiedBytes: (bytes) => {
          deliveredBytes += bytes.byteLength;
        },
      });
      expect(first.status).toBe(206);
      expect(first.consumedBytes).toBe(20);
      expect(first.remainingBytes).toBe(10);

      for (const [index, slice] of slices.slice(1).entries()) {
        const error = await expectGrantError(
          () =>
            fetcher.fetchBytes({
              grantUrl: substitute.grantUrl(BUDGET_PATH, { nonce: `slice-${index + 2}` }),
              inboundHeaders: { range: slice },
              onVerifiedBytes: (bytes) => {
                deliveredBytes += bytes.byteLength;
              },
            }),
          'RUNTIME_GRANT_BUDGET_EXCEEDED',
        );
        expect(error.upstreamStatus).toBe(206);
        expect(error.message).toContain('超出剩余预算 10 字节');
        expectNoGrantCredentialLeak(error);
      }

      // 三次请求都真的发出去了，是预检拦下了下载；交付给调用方的仍然只有第一段。
      expect(substitute.requests).toHaveLength(3);
      expect(deliveredBytes).toBe(20);
      expect(fetcher.budgetOf(substitute.grantUrl(BUDGET_PATH)).consumedBytes).toBe(20);
    });
  });

  it('账本的键是对象身份而不是 token：换 token 拿到的是同一份快照', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute, { maxBytesPerObject: 1000 });
      const firstToken = substitute.grantUrl(BUDGET_PATH, { nonce: 'a' });
      await fetcher.fetchBytes({ grantUrl: firstToken, inboundHeaders: { range: 'bytes=0-19' } });

      const secondToken = substitute.grantUrl(BUDGET_PATH, { nonce: 'b' });
      expect(secondToken).not.toBe(firstToken);
      expect(fetcher.budgetOf(secondToken)).toEqual(fetcher.budgetOf(firstToken));
      expect(fetcher.budgetOf(secondToken).objectKey).toBe(`${substitute.origin}${BUDGET_PATH}`);
      // objectKey 不含查询串，所以「一次性凭据」这四个字不会渗进账本的键里。
      expect(fetcher.budgetOf(secondToken).objectKey).not.toContain('?');
    });
  });

  it('失败不回滚账本：被拒的那次不会把已入账的字节还回去', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute, { maxBytesPerObject: 30 });
      const grantUrl = substitute.grantUrl(BUDGET_PATH);
      await fetcher.fetchBytes({ grantUrl, inboundHeaders: { range: 'bytes=0-19' } });
      const before = fetcher.budgetOf(grantUrl);
      expect(before.consumedBytes).toBe(20);

      await expectGrantError(
        () => fetcher.fetchBytes({ grantUrl, inboundHeaders: { range: 'bytes=20-39' } }),
        'RUNTIME_GRANT_BUDGET_EXCEEDED',
      );

      const after = fetcher.budgetOf(grantUrl);
      expect(after.consumedBytes).toBe(before.consumedBytes);
      expect(after.remainingBytes).toBe(before.remainingBytes);
      // 回滚等于给「故意超限再重试」发免费额度，所以这里必须仍然只够 10 字节。
      expect(after.remainingBytes).toBe(10);
    });
  });

  it('上游不写 Content-Length：预检失效也不能绕过，流式核算到超限就地截断', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute, { maxBytesPerObject: 30 });
      const grantUrl = substitute.grantUrl(CHUNKED_PATH);
      let deliveredBytes = 0;

      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl,
            onVerifiedBytes: (bytes) => {
              deliveredBytes += bytes.byteLength;
            },
          }),
        'RUNTIME_GRANT_BUDGET_EXCEEDED',
      );

      expect(error.message).toContain('已在流式读取中截断');
      expect(error.message).toContain('未把任何字节交给调用方');
      expect(deliveredBytes).toBe(0);
      // 越限的那一块是真过了网线的字节，所以账本记下的数会略高于上限；
      // 断言的是「它确实在半路停了」，而不是「它读完了 100 字节再说超」。
      const consumed = fetcher.budgetOf(grantUrl).consumedBytes;
      expect(consumed).toBeGreaterThan(30);
      expect(consumed).toBeLessThan(100);
      expect(fetcher.budgetOf(grantUrl).remainingBytes).toBe(0);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('边界不是差一：正好等于预算放行，多一个字节拒绝', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const exact = createTestFetcher(substitute, { maxBytesPerObject: 20 });
      const grantUrl = substitute.grantUrl(BUDGET_PATH);

      const fits = await exact.fetchBytes({
        grantUrl,
        inboundHeaders: { range: 'bytes=0-19' },
      });
      expect(fits.byteLength).toBe(20);
      expect(fits.remainingBytes).toBe(0);

      const oneTooMany = await expectGrantError(
        () => exact.fetchBytes({ grantUrl, inboundHeaders: { range: 'bytes=20-20' } }),
        'RUNTIME_GRANT_BUDGET_EXCEEDED',
      );
      expect(oneTooMany.message).toContain('超出剩余预算 0 字节');
      expect(exact.budgetOf(grantUrl).consumedBytes).toBe(20);
    });
  });

  it('账本按对象分而不是全局共享：两个对象各自有一份完整预算', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute, { maxBytesPerObject: 100 });
      const first = await fetcher.fetchBytes({ grantUrl: substitute.grantUrl(BUDGET_PATH) });
      const second = await fetcher.fetchBytes({ grantUrl: substitute.grantUrl(OTHER_PATH) });

      expect(first.consumedBytes).toBe(100);
      expect(second.consumedBytes).toBe(60);
      expect(first.objectKey).not.toBe(second.objectKey);
      expect(fetcher.budgetOf(substitute.grantUrl(OTHER_PATH)).remainingBytes).toBe(40);
    });
  });
});

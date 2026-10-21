import { describe, expect, it } from 'vitest';

import { artifactResponseHeaders } from '../src/index.js';
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
 * 能力 `grant-fetch-range-forwarding`：Range 转发与 206/200 语义回填。
 *
 * D4 要证明的不是「把请求头抄过去」，而是**无论上游认不认 Range，交给浏览器的响应都必须是
 * 合法的 206/200 语义**。所以这里三件事各自判红绿：客户端的 `Range` 逐字转发到上游、上游不认
 * 时由运行时自己切片并合成 `Content-Range`、上游「嘴上说给了哪一段」与请求对不上时拒绝交付。
 *
 * **替身证明**：上游是 `test/support/substitute-origin.ts`。真实对象存储的 Range 行为、
 * 真实私有 Blob 的授权拒绝属 D5/D6。
 */

const PROOF = 'grant-fetch-range-forwarding';
const RANGE_PATH = '/artifacts/range-forwarding.bin';
const IGNORE_RANGE_PATH = '/artifacts/range-ignored.bin';
const LYING_RANGE_PATH = '/artifacts/range-lying.bin';
const STAR_TOTAL_PATH = '/artifacts/range-star-total.bin';
const REDIRECT_PATH = '/artifacts/range-redirect.bin';
const REDIRECT_TARGET_PATH = '/artifacts/range-redirect-target.bin';
const UNSATISFIABLE_STATUS_PATH = '/artifacts/range-unsolicited-206.bin';
const UPSTREAM_ERROR_PATH = '/artifacts/range-upstream-500.bin';
const REVOKED_PATH = '/artifacts/range-revoked.bin';

const BODY = deterministicBytes(100);
const CONTENT_TYPE = 'application/octet-stream';

function rangeObject(path: string, extra: Partial<SubstituteObject> = {}): SubstituteObject {
  return { path, body: BODY, contentType: CONTENT_TYPE, ...extra };
}

const OBJECTS: SubstituteObject[] = [
  rangeObject(RANGE_PATH),
  rangeObject(IGNORE_RANGE_PATH, { ignoreRange: true }),
  rangeObject(LYING_RANGE_PATH, { contentRangeOverride: 'bytes 0-9/100' }),
  rangeObject(STAR_TOTAL_PATH, { contentRangeOverride: 'bytes 10-19/*' }),
  rangeObject(REDIRECT_PATH, { redirectTo: REDIRECT_TARGET_PATH }),
  rangeObject(REDIRECT_TARGET_PATH),
  rangeObject(UNSATISFIABLE_STATUS_PATH, { status: 206 }),
  rangeObject(UPSTREAM_ERROR_PATH, { status: 500 }),
  rangeObject(REVOKED_PATH, { alwaysForbidden: true }),
];

describe(`${PROOF}：Range 逐字转发，且交付出去的一定是合法的 206/200 语义`, () => {
  it('闭区间 bytes=10-19：逐字转发，上游兑现，回填成合法 206', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl(RANGE_PATH),
        // 混进一堆主站/浏览器头：只有白名单里的 `range` 允许出现在上游请求上。
        inboundHeaders: {
          range: 'bytes=10-19',
          cookie: 'not-a-value-anyone-should-see',
          'user-agent': 'not-a-value-anyone-should-see',
        },
      });

      expect(substitute.requests).toHaveLength(1);
      expect(substitute.requests[0]?.range).toBe('bytes=10-19');
      expect(substitute.requests[0]?.cookie).toBeNull();

      expect(result.status).toBe(206);
      expect(result.rangeHonoredBy).toBe('upstream');
      expect(result.contentRange).toBe('bytes 10-19/100');
      expect(result.byteLength).toBe(10);
      expect(result.bytes).toEqual(BODY.subarray(10, 20));
      expect(result.consumedBytes).toBe(10);

      // 交付面自洽：这份结果可以直接写进一个合法的 206 响应。
      const headers = artifactResponseHeaders({
        status: result.status,
        byteLength: result.byteLength,
        upstreamContentType: result.upstreamContentType,
        filename: 'work.bin',
        contentRange: result.contentRange,
        sha256: result.sha256,
      });
      expect(headers['content-range']).toBe('bytes 10-19/100');
      expect(headers['content-length']).toBe('10');
    });
  });

  it('不带 Range：交付 200 全量，rangeHonoredBy 为 none 且不合成 Content-Range', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl(RANGE_PATH),
      });

      expect(substitute.requests[0]?.range).toBeNull();
      expect(result.status).toBe(200);
      expect(result.rangeHonoredBy).toBe('none');
      expect(result.contentRange).toBeNull();
      expect(result.byteLength).toBe(100);
      expect(result.bytes).toEqual(BODY);
    });
  });

  it('后缀区间 bytes=-8：转发原样，回填的是运行时求解出的绝对区间', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl(RANGE_PATH),
        inboundHeaders: { range: 'bytes=-8' },
      });

      expect(substitute.requests[0]?.range).toBe('bytes=-8');
      expect(result.status).toBe(206);
      expect(result.contentRange).toBe('bytes 92-99/100');
      expect(result.bytes).toEqual(BODY.subarray(92, 100));
    });
  });

  it('开区间 bytes=20-：一直取到对象末尾', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl(RANGE_PATH),
        inboundHeaders: { range: 'bytes=20-' },
      });

      expect(result.status).toBe(206);
      expect(result.contentRange).toBe('bytes 20-99/100');
      expect(result.byteLength).toBe(80);
      expect(result.bytes).toEqual(BODY.subarray(20, 100));
    });
  });

  it('上游忽略 Range 回了 200：由运行时自己切片并合成 Content-Range，预算按实际下载的全量计', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl(IGNORE_RANGE_PATH),
        inboundHeaders: { range: 'bytes=10-19' },
      });

      expect(substitute.requests[0]?.range).toBe('bytes=10-19');
      expect(result.status).toBe(206);
      expect(result.rangeHonoredBy).toBe('runtime');
      expect(result.contentRange).toBe('bytes 10-19/100');
      expect(result.byteLength).toBe(10);
      expect(result.bytes).toEqual(BODY.subarray(10, 20));
      // 客户端只要了 10 字节，但网线上过来的是 100 字节 —— 预算必须按后者记，
      // 否则「找一个不认 Range 的上游」就成了放大预算的办法。
      expect(result.consumedBytes).toBe(100);
      expect(result.remainingBytes).toBe(924);
    });
  });

  it('区间超出对象长度：上游 416，判 RANGE_NOT_SATISFIABLE 并带上上游状态', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl: substitute.grantUrl(RANGE_PATH),
            inboundHeaders: { range: 'bytes=9999-' },
          }),
        'RUNTIME_GRANT_RANGE_NOT_SATISFIABLE',
      );

      expect(error.upstreamStatus).toBe(416);
      expect(error.message).toContain('bytes=9999-');
      expectNoGrantCredentialLeak(error);
    });
  });

  it('多段 Range bytes=0-9,20-29：一个请求都不发就拒收，因为这正是拆分绕预算的形状', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const grantUrl = substitute.grantUrl(RANGE_PATH);
      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl,
            inboundHeaders: { range: 'bytes=0-9,20-29' },
          }),
        'RUNTIME_GRANT_RANGE_NOT_SATISFIABLE',
      );

      expect(substitute.requests).toHaveLength(0);
      expect(error.upstreamStatus).toBeNull();
      expect(error.message).toContain('绕过大小预算');
      expect(fetcher.budgetOf(grantUrl).consumedBytes).toBe(0);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('上游 206 声称的区间与请求对不上：判 RANGE_MISMATCH，拒绝把对不上的字节当那一段交付', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl: substitute.grantUrl(LYING_RANGE_PATH),
            inboundHeaders: { range: 'bytes=10-19' },
          }),
        'RUNTIME_GRANT_RANGE_MISMATCH',
      );

      expect(error.upstreamStatus).toBe(206);
      expect(error.message).toContain('bytes 0-9/100');
      expect(error.message).toContain('bytes=10-19');
      expectNoGrantCredentialLeak(error);
    });
  });

  it('上游 206 用星号形式表示总长未知：无法交叉校验，判 RANGE_MISMATCH', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl: substitute.grantUrl(STAR_TOTAL_PATH),
            inboundHeaders: { range: 'bytes=10-19' },
          }),
        'RUNTIME_GRANT_RANGE_MISMATCH',
      );

      expect(error.upstreamStatus).toBe(206);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('grant URL 返回 302：判 URL_REJECTED 且不跟随跳转，重定向目标一次都没被请求', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const error = await expectGrantError(
        () => fetcher.fetchBytes({ grantUrl: substitute.grantUrl(REDIRECT_PATH) }),
        'RUNTIME_GRANT_URL_REJECTED',
      );

      expect(error.upstreamStatus).toBe(302);
      expect(error.message).toContain('不跟随跳转');
      // 跳转目标就在同一个替身源上，所以「有没有跟过去」是可观测的。
      expect(substitute.requests).toHaveLength(1);
      expect(
        substitute.requests.some((record) => record.url.startsWith(REDIRECT_TARGET_PATH)),
      ).toBe(false);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('没发 Range 却收到 206：响应形状与请求不一致，判 UNEXPECTED_STATUS 而不是照单交付', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const error = await expectGrantError(
        () => fetcher.fetchBytes({ grantUrl: substitute.grantUrl(UNSATISFIABLE_STATUS_PATH) }),
        'RUNTIME_GRANT_UNEXPECTED_STATUS',
      );

      expect(error.upstreamStatus).toBe(206);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('上游 500：判 UNEXPECTED_STATUS，只接受 200 与 206', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const error = await expectGrantError(
        () => fetcher.fetchBytes({ grantUrl: substitute.grantUrl(UPSTREAM_ERROR_PATH) }),
        'RUNTIME_GRANT_UNEXPECTED_STATUS',
      );

      expect(error.upstreamStatus).toBe(500);
      expect(error.message).toContain('500');
      expectNoGrantCredentialLeak(error);
    });
  });

  it('token 不对（401）与已吊销（403）：判 UPSTREAM_REJECTED，且账本一分未记', async () => {
    await withSubstituteOrigin(OBJECTS, async (substitute) => {
      const fetcher = createTestFetcher(substitute);

      const unauthorized = await expectGrantError(
        () => fetcher.fetchBytes({ grantUrl: substitute.badTokenGrantUrl(RANGE_PATH) }),
        'RUNTIME_GRANT_UPSTREAM_REJECTED',
      );
      expect(unauthorized.upstreamStatus).toBe(401);
      expectNoGrantCredentialLeak(unauthorized, 'not-the-grant-token');

      const forbiddenUrl = substitute.grantUrl('/artifacts/range-revoked.bin');
      const forbidden = await expectGrantError(
        () => fetcher.fetchBytes({ grantUrl: forbiddenUrl }),
        'RUNTIME_GRANT_UPSTREAM_REJECTED',
      );
      expect(forbidden.upstreamStatus).toBe(403);
      expect(fetcher.budgetOf(forbiddenUrl).consumedBytes).toBe(0);
      expectNoGrantCredentialLeak(forbidden);
    });
  });
});

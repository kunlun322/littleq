import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { GRANT_MAX_VALIDITY_MS, type IncrementalSha256, type Sha256Factory } from '../src/index.js';
import {
  createTestFetcher,
  expectGrantError,
  expectNoGrantCredentialLeak,
} from './support/grant-assertions.js';
import {
  SUBSTITUTE_GRANT_TOKEN,
  deterministicBytes,
  startSubstituteOrigin,
  withSubstituteOrigin,
  type SubstituteObject,
} from './support/substitute-origin.js';

/**
 * 能力 `grant-fetch-timeout-abort`：超时与调用方中止。
 *
 * 两条路径必须是**不同的失败码**，而且都必须在有限时间内确定性地发生 —— 用注入的时钟和
 * 「在第一块字节到达的那一刻中止」来做，不靠 sleep 去猜时机：猜时机的中止用例在慢机器上
 * 会翻成 TIMEOUT，于是同一个 bug 在 CI 上时红时绿，等于没有这条断言。
 *
 * **替身证明**：这里的上游是 `test/support/substitute-origin.ts`。真实私有 Blob 的
 * 过期拒绝与撤销即时生效属 D5/D6，替身通过不代表真实链路通过。
 */

const PROOF = 'grant-fetch-timeout-abort';
const OBJECT_PATH = '/artifacts/timeout-abort.bin';
const BODY = deterministicBytes(256);

function hangingObject(): SubstituteObject {
  return { path: OBJECT_PATH, body: BODY, contentType: 'application/octet-stream', hangMs: 4000 };
}

function slowObject(): SubstituteObject {
  return {
    path: OBJECT_PATH,
    body: BODY,
    contentType: 'application/octet-stream',
    chunkSize: 16,
    chunkDelayMs: 40,
  };
}

describe(`${PROOF}：超时与中止是两条不同的确定性失败路径`, () => {
  it('上游迟迟不响应：在 timeoutMs 内判 TIMEOUT，账本一分未记', async () => {
    await withSubstituteOrigin([hangingObject()], async (substitute) => {
      const fetcher = createTestFetcher(substitute, { timeoutMs: 60 });
      const grantUrl = substitute.grantUrl(OBJECT_PATH);
      const startedAt = Date.now();

      const error = await expectGrantError(
        () => fetcher.fetchBytes({ grantUrl }),
        'RUNTIME_GRANT_TIMEOUT',
      );
      const elapsedMs = Date.now() - startedAt;

      // 上游要挂 4000ms；如果这条用例真的等到了上游，就说明超时没有生效。
      expect(elapsedMs).toBeLessThan(3000);
      expect(error.message).toContain('60ms');
      expect(error.upstreamStatus).toBeNull();
      expect(substitute.requests).toHaveLength(1);
      expect(fetcher.budgetOf(grantUrl).consumedBytes).toBe(0);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('响应体太慢：传输中途判 TIMEOUT，一个字节都不交给调用方，已过网线的字节照记', async () => {
    await withSubstituteOrigin([slowObject()], async (substitute) => {
      const fetcher = createTestFetcher(substitute, { timeoutMs: 120 });
      const grantUrl = substitute.grantUrl(OBJECT_PATH);
      let deliveredBytes = 0;

      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl,
            onVerifiedBytes: (bytes) => {
              deliveredBytes += bytes.byteLength;
            },
          }),
        'RUNTIME_GRANT_TIMEOUT',
      );

      expect(deliveredBytes).toBe(0);
      // 不回滚：字节确实过了网络。回滚等于给「故意拖到超时再重试」发免费额度。
      expect(fetcher.budgetOf(grantUrl).consumedBytes).toBeGreaterThan(0);
      expect(fetcher.budgetOf(grantUrl).consumedBytes).toBeLessThanOrEqual(1024);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('调用方在发起前就已中止：判 ABORTED，且一个请求都没发到平台源', async () => {
    await withSubstituteOrigin([hangingObject()], async (substitute) => {
      const fetcher = createTestFetcher(substitute, { timeoutMs: 60_000 });
      const caller = new AbortController();
      caller.abort();

      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl: substitute.grantUrl(OBJECT_PATH),
            signal: caller.signal,
          }),
        'RUNTIME_GRANT_ABORTED',
      );

      expect(error.message).toContain('之前就已中止');
      expect(substitute.requests).toHaveLength(0);
      expect(fetcher.budgetOf(substitute.grantUrl(OBJECT_PATH)).consumedBytes).toBe(0);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('传输中途中止：判 ABORTED 而不是 TIMEOUT，且不留下半截交付', async () => {
    await withSubstituteOrigin([slowObject()], async (substitute) => {
      const caller = new AbortController();
      let hashedChunks = 0;
      // `update()` 是在读循环里被同步调用的，所以「收到第一块之后就中止」是确定性的。
      const sha256Factory: Sha256Factory = () => {
        const inner = createHash('sha256');
        const wrapper: IncrementalSha256 = {
          update: (chunk) => {
            hashedChunks += 1;
            if (hashedChunks === 1) caller.abort();
            return inner.update(chunk);
          },
          digest: (encoding) => inner.digest(encoding),
        };
        return wrapper;
      };
      const fetcher = createTestFetcher(substitute, { timeoutMs: 60_000, sha256Factory });
      const grantUrl = substitute.grantUrl(OBJECT_PATH);
      let deliveredBytes = 0;

      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl,
            signal: caller.signal,
            onVerifiedBytes: (bytes) => {
              deliveredBytes += bytes.byteLength;
            },
          }),
        'RUNTIME_GRANT_ABORTED',
      );

      expect(hashedChunks).toBe(1);
      expect(deliveredBytes).toBe(0);
      // 中止发生在第一块（16 字节）入账之后：账本记下的是真实过网线的量。
      expect(fetcher.budgetOf(grantUrl).consumedBytes).toBe(16);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('超过 300 秒使用窗口：拒绝再用同一对象的 grant，越窗时不发任何请求', async () => {
    expect(GRANT_MAX_VALIDITY_MS).toBe(300_000);
    const small: SubstituteObject = {
      path: OBJECT_PATH,
      body: deterministicBytes(32),
      contentType: 'application/octet-stream',
    };

    await withSubstituteOrigin([small], async (substitute) => {
      let clock = 1_000;
      const fetcher = createTestFetcher(substitute, { now: () => clock });
      expect(fetcher.maxValidityMs).toBe(GRANT_MAX_VALIDITY_MS);

      const firstUrl = substitute.grantUrl(OBJECT_PATH);
      await fetcher.fetchBytes({ grantUrl: firstUrl });
      expect(fetcher.firstUseAt(firstUrl)).toBe(1_000);

      // 反真空对照：窗口内的第二次使用必须成功。少了这一步，「越窗被拒」可能只是因为
      // 第二次使用总是被拒，而那条用例照样是绿的。
      clock += GRANT_MAX_VALIDITY_MS - 1;
      await fetcher.fetchBytes({ grantUrl: substitute.grantUrl(OBJECT_PATH, { nonce: 'b' }) });
      expect(substitute.requests).toHaveLength(2);

      clock += 2; // 距首次使用 300_001ms
      const lateUrl = substitute.grantUrl(OBJECT_PATH, { nonce: 'c' });
      const error = await expectGrantError(
        () => fetcher.fetchBytes({ grantUrl: lateUrl }),
        'RUNTIME_GRANT_OUTSIDE_VALIDITY_WINDOW',
      );

      expect(error.message).toContain('300000ms');
      expect(substitute.requests).toHaveLength(2);
      // 换了新 token 也不重置窗口：对象身份 = origin + pathname，不含查询串。
      expect(fetcher.firstUseAt(lateUrl)).toBe(1_000);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('平台源不可达：判 UPSTREAM_UNREACHABLE，且诊断里只有异常名，没有 URL 查询串', async () => {
    const substitute = await startSubstituteOrigin({
      token: SUBSTITUTE_GRANT_TOKEN,
      objects: [hangingObject()],
    });
    const grantUrl = substitute.grantUrl(OBJECT_PATH);
    const fetcher = createTestFetcher(substitute, { timeoutMs: 5_000 });
    // 先关掉再取：连接被拒。undici 的 `fetch failed` 会把带完整 URL 的原因挂在 cause 上，
    // 而 grant URL 的查询串就是一次性凭据 —— 所以只允许报 cause 的 name。
    await substitute.close();

    const error = await expectGrantError(
      () => fetcher.fetchBytes({ grantUrl }),
      'RUNTIME_GRANT_UPSTREAM_UNREACHABLE',
    );

    expect(error.message).toContain('平台 grant 源不可达');
    expect(error.message).not.toContain('ECONNREFUSED');
    expectNoGrantCredentialLeak(error);
  });
});

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  artifactResponseHeaders,
  type IncrementalSha256,
  type Sha256Factory,
} from '../src/index.js';
import {
  createTestFetcher,
  expectGrantError,
  expectNoGrantCredentialLeak,
} from './support/grant-assertions.js';
import {
  deterministicBytes,
  sha256Hex,
  withSubstituteOrigin,
  type SubstituteObject,
} from './support/substitute-origin.js';

/**
 * 能力 `grant-fetch-streaming-sha256`：边收边算，且摘要对不上就一个字节都不交出去。
 *
 * ## 「边收边算」怎么才算被证明了
 *
 * 数分块个数不行：内核怎么合并写是它的事，同一份实现在两台机器上会得到不同的块数。
 * 观测「服务端发完的时刻」也不行：`Content-Length` 一声明，客户端收满字节就算读完了，
 * 它并不等 FIN，于是服务端那句「我发完了」天然晚于客户端 —— 那是竞态，不是证明。
 *
 * 这里的办法是**握手**：替身写完第一块就停下来，等客户端证明它已经处理过这一块才继续发。
 * 攒齐再算的实现在处理途中不会去算摘要，握手永不达成，取字节超时判红。也就是说
 * 「不是流式」这个反例**自己会失败**，而不是碰巧躲过一个时间窗。
 *
 * ## 摘要覆盖的是交付出去的那一份
 *
 * 上游忽略 Range、由运行时自己切片时，流式那份哈希覆盖的是**上游全量**。把全量的摘要贴在
 * 切片的字节上是这条能力最容易犯的错，所以单独有一条用例钉死它。
 *
 * **替身证明**：上游是 `test/support/substitute-origin.ts`。「主站签发 → 运行外交付」端到端的
 * 产物哈希一致性属 D5/D6。
 */

const PROOF = 'grant-fetch-streaming-sha256';
const STREAM_PATH = '/artifacts/sha256-stream.bin';
const PLAIN_PATH = '/artifacts/sha256-plain.bin';
const DECLARED_OK_PATH = '/artifacts/sha256-declared-ok.bin';
const DECLARED_BAD_PATH = '/artifacts/sha256-declared-bad.bin';
const IGNORE_RANGE_PATH = '/artifacts/sha256-range-ignored.bin';

const BODY = deterministicBytes(256);
const SLICE = BODY.subarray(10, 20);
const CONTENT_TYPE = 'application/octet-stream';

function buildObjects(): SubstituteObject[] {
  return [
    { path: PLAIN_PATH, body: BODY, contentType: CONTENT_TYPE },
    {
      path: DECLARED_OK_PATH,
      body: BODY,
      contentType: CONTENT_TYPE,
      declaredSha256: sha256Hex(BODY),
    },
    {
      path: DECLARED_BAD_PATH,
      body: BODY,
      contentType: CONTENT_TYPE,
      // 一个形状合法、值错误的摘要：正是「清单和字节对不上」的样子。
      declaredSha256: sha256Hex(deterministicBytes(256, 0x99)),
    },
    { path: IGNORE_RANGE_PATH, body: BODY, contentType: CONTENT_TYPE, ignoreRange: true },
  ];
}

describe(`${PROOF}：边收边算，摘要不一致就拒绝交付`, () => {
  it('全量取回：运行时报出的摘要等于交付字节的摘要，并写进交付响应头', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const result = await fetcher.fetchBytes({ grantUrl: substitute.grantUrl(PLAIN_PATH) });

      expect(result.status).toBe(200);
      expect(result.sha256).toBe(sha256Hex(BODY));
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

      const headers = artifactResponseHeaders({
        status: result.status,
        byteLength: result.byteLength,
        upstreamContentType: result.upstreamContentType,
        filename: 'work.bin',
        contentRange: result.contentRange,
        sha256: result.sha256,
      });
      // 写出去的是运行时自己算的那一个，不是上游自称的那一个。
      expect(headers['x-artifact-sha256']).toBe(sha256Hex(BODY));
      expect(headers['content-length']).toBe('256');
    });
  });

  it('传输推进的前提是「已经算过一块」：攒齐再算的实现会在这里握手失败并超时', async () => {
    let updateCalls = 0;
    let maxChunkBytes = 0;
    let handshakeDone = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sha256Factory: Sha256Factory = () => {
      const inner = createHash('sha256');
      const wrapper: IncrementalSha256 = {
        update: (chunk) => {
          updateCalls += 1;
          maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
          // 第一块一到就放行服务端继续发。这是握手的客户端一侧：只有**在传输途中**
          // 就算摘要的实现才走得到这里；攒齐再算的实现走不到，于是取字节超时判红。
          if (updateCalls === 1) {
            handshakeDone = true;
            release();
          }
          return inner.update(chunk);
        },
        digest: (encoding) => inner.digest(encoding),
      };
      return wrapper;
    };

    const objects: SubstituteObject[] = [
      {
        path: STREAM_PATH,
        body: BODY,
        contentType: CONTENT_TYPE,
        chunkSize: 16,
        gateAfterChunks: 1,
        gate: () => gate,
      },
    ];

    await withSubstituteOrigin(objects, async (substitute) => {
      const fetcher = createTestFetcher(substitute, { sha256Factory, timeoutMs: 5000 });
      const result = await fetcher.fetchBytes({ grantUrl: substitute.grantUrl(STREAM_PATH) });

      expect(handshakeDone).toBe(true);
      // 一次 update 吞下整个对象的话，这两条会分别是 1 与 256。
      expect(updateCalls).toBeGreaterThanOrEqual(2);
      expect(maxChunkBytes).toBeLessThan(BODY.byteLength);
      expect(result.status).toBe(200);
      expect(result.bytes).toEqual(BODY);
      expect(result.sha256).toBe(sha256Hex(BODY));
    });
  });

  it('上游自称的摘要对不上：判 HASH_MISMATCH，字节全部丢弃且回调一次都不触发', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const grantUrl = substitute.grantUrl(DECLARED_BAD_PATH);
      let deliveredBytes = 0;

      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl,
            onVerifiedBytes: (bytes) => {
              deliveredBytes += bytes.byteLength;
            },
          }),
        'RUNTIME_GRANT_HASH_MISMATCH',
      );

      expect(error.upstreamStatus).toBe(200);
      expect(error.message).toContain('按实收字节为准并拒绝交付');
      expect(deliveredBytes).toBe(0);
      // 字节确实过了网线，所以账本照记：拒绝交付不等于没消耗预算。
      expect(fetcher.budgetOf(grantUrl).consumedBytes).toBe(256);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('上游自称的摘要一致：放行', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl(DECLARED_OK_PATH),
      });
      expect(result.sha256).toBe(sha256Hex(BODY));
      expect(result.byteLength).toBe(256);
    });
  });

  it('调用方给的产物哈希对不上：判 HASH_MISMATCH，已收到的字节全部丢弃', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const grantUrl = substitute.grantUrl(PLAIN_PATH);
      let deliveredBytes = 0;

      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl,
            expectedSha256: sha256Hex(deterministicBytes(256, 0x77)),
            onVerifiedBytes: (bytes) => {
              deliveredBytes += bytes.byteLength;
            },
          }),
        'RUNTIME_GRANT_HASH_MISMATCH',
      );

      expect(error.message).toContain('全部丢弃');
      expect(error.message).toContain('未交给调用方');
      expect(deliveredBytes).toBe(0);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('调用方给的哈希不是十六进制：无法校验就拒绝，绝不放行未经验证的字节', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      let deliveredBytes = 0;

      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl: substitute.grantUrl(PLAIN_PATH),
            expectedSha256: 'not-a-hex-digest',
            onVerifiedBytes: (bytes) => {
              deliveredBytes += bytes.byteLength;
            },
          }),
        'RUNTIME_GRANT_HASH_MISMATCH',
      );

      expect(error.message).toContain('不是十六进制摘要');
      expect(deliveredBytes).toBe(0);
      expectNoGrantCredentialLeak(error);
    });
  });

  it('调用方给的哈希是大写：归一化后照常校验通过，且回调恰好触发一次', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const seen: Uint8Array[] = [];

      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl(PLAIN_PATH),
        expectedSha256: sha256Hex(BODY).toUpperCase(),
        onVerifiedBytes: (bytes) => {
          seen.push(bytes);
        },
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(result.bytes);
      expect(result.sha256).toBe(sha256Hex(BODY));
    });
  });

  it('上游兑现 Range：摘要覆盖上游给的那一段', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl(PLAIN_PATH),
        inboundHeaders: { range: 'bytes=10-19' },
      });

      expect(result.rangeHonoredBy).toBe('upstream');
      expect(result.bytes).toEqual(SLICE);
      expect(result.sha256).toBe(sha256Hex(SLICE));
      expect(result.sha256).not.toBe(sha256Hex(BODY));
    });
  });

  it('运行时自己切片：摘要覆盖切片而不是上游全量 —— 不许把全量的摘要贴在切片上', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      const grantUrl = substitute.grantUrl(IGNORE_RANGE_PATH);
      const result = await fetcher.fetchBytes({
        grantUrl,
        inboundHeaders: { range: 'bytes=10-19' },
        expectedSha256: sha256Hex(SLICE),
      });

      expect(result.rangeHonoredBy).toBe('runtime');
      expect(result.status).toBe(206);
      expect(result.contentRange).toBe('bytes 10-19/256');
      expect(result.bytes).toEqual(SLICE);
      expect(result.sha256).toBe(sha256Hex(SLICE));
      expect(result.sha256).not.toBe(sha256Hex(BODY));
      // 网线上过来的是全量，预算按全量记。
      expect(fetcher.budgetOf(grantUrl).consumedBytes).toBe(256);
    });
  });

  it('运行时切片后摘要对不上：判 HASH_MISMATCH，不把切片交出去', async () => {
    await withSubstituteOrigin(buildObjects(), async (substitute) => {
      const fetcher = createTestFetcher(substitute);
      let deliveredBytes = 0;

      const error = await expectGrantError(
        () =>
          fetcher.fetchBytes({
            grantUrl: substitute.grantUrl(IGNORE_RANGE_PATH),
            inboundHeaders: { range: 'bytes=10-19' },
            // 拿全量的摘要去校验切片：这正是上面那条要防的错，这里从调用方一侧再堵一次。
            expectedSha256: sha256Hex(BODY),
            onVerifiedBytes: (bytes) => {
              deliveredBytes += bytes.byteLength;
            },
          }),
        'RUNTIME_GRANT_HASH_MISMATCH',
      );

      expect(deliveredBytes).toBe(0);
      expect(error.message).toContain('已收到的 256 字节全部丢弃');
      expectNoGrantCredentialLeak(error);
    });
  });
});

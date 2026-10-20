/**
 * 门禁证明点 `separate-origin-content`：作品内容由独立源提供，不与主站共享
 * Cookie / 数据库 / AI 凭证。
 *
 * ## 这份测试证明什么
 *
 * 1. **凭据流向**（运行时行为，可判红绿）：浏览器带来的 `Cookie` / `Authorization` /
 *    `x-littleq-*` 一律进不了处理链，也一律不会出现在发往内容源的请求里；发往内容源的
 *    头只有 `Range`。用本地 authenticated substitute 实跑一遍，替身把收到的头记录下来，
 *    于是「主站会话凭据没有跟着走」是被观测到的事实，不是自述。
 * 2. **源钉死**：grant URL 的源不是被钉住的那一个就拒绝，运行时不会去任意源取字节。
 * 3. **依赖面为空**：`apps/runtime/package.json` 一个依赖都不声明 —— 没有数据库驱动、
 *    没有对象存储 SDK、没有模型供应商 SDK，也就没有能触达主站数据面的代码路径。
 *
 * ## 这份测试**不**证明什么（诚实分层）
 *
 * 导入层面的禁令（`apps/runtime` 不得 import `packages/infra` / `apps/api`）由
 * `pnpm dep-graph` 与 `test/isolation.test.ts` 权威判定，本文件不重复实现一份弱化版扫描器。
 * 真实私有 Blob 的未授权/过期拒绝、撤销即时生效、真实日志中不含供应商 URL/token，
 * 属 D5/D6 的验收范围：这里对接的是**本地替身**，替身通过不等于真实链路通过。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  INBOUND_HEADER_ALLOWLIST,
  MAIN_SITE_CREDENTIAL_HEADERS,
  MAIN_SITE_HEADER_PREFIX,
  UPSTREAM_HEADER_ALLOWLIST,
  artifactResponseHeaders,
  assertNoMainSiteCredentialHeaders,
  buildUpstreamHeaders,
  createGrantByteFetcher,
  findMainSiteCredentialHeaders,
  isMainSiteCredentialHeader,
  pinGrantUrl,
  runtimeOriginContract,
  sanitizeInboundRequestHeaders,
} from '../src/index.js';
import {
  deterministicBytes,
  sha256Hex,
  withSubstituteOrigin,
  type SubstituteObject,
} from './support/substitute-origin.js';

const PROOF = 'separate-origin-content';

const runtimeManifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../package.json',
);

/** 主站源的替身值。真实值属部署配置；这里只需要一个与内容源不同的源来断言「不共享」。 */
const MAIN_SITE_ORIGIN = 'https://main-site.invalid';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** 一份「浏览器会带上来的一切」，其中大部分必须被剥掉。 */
const BROWSER_HEADERS = {
  range: 'bytes=0-9',
  accept: '*/*',
  'accept-language': 'zh-CN',
  'if-none-match': '"some-etag"',
  'if-modified-since': 'Mon, 20 Oct 2026 00:00:00 GMT',
  cookie: 'littleq_session=not-a-value-anyone-should-see',
  authorization: 'Bearer not-a-value-anyone-should-see',
  'proxy-authorization': 'Basic not-a-value-anyone-should-see',
  'x-littleq-tenant': 'not-a-value-anyone-should-see',
  'x-littleq-ai-key': 'not-a-value-anyone-should-see',
  referer: 'https://main-site.invalid/projects/1',
  'user-agent': 'some-browser',
  host: 'main-site.invalid',
};

function objectOf(body: Uint8Array, extra: Partial<SubstituteObject> = {}): SubstituteObject[] {
  return [
    {
      path: '/artifacts/demo.bin',
      body,
      contentType: 'application/octet-stream',
      ...extra,
    },
  ];
}

describe(`门禁证明点 ${PROOF}：作品字节来自独立源，且不携带主站凭据`, () => {
  it('运行时源契约声明四项共享全为 false', () => {
    expect(runtimeOriginContract.sharesMainSiteCookies).toBe(false);
    expect(runtimeOriginContract.sharesMainSiteDatabase).toBe(false);
    expect(runtimeOriginContract.sharesAiCredentials).toBe(false);
    expect(runtimeOriginContract.servesMainSiteSession).toBe(false);
  });

  it('入站头净化是默认拒绝：只有白名单里的头能进入处理链', () => {
    const sanitized = sanitizeInboundRequestHeaders(BROWSER_HEADERS);
    expect(Object.keys(sanitized).sort()).toEqual([...INBOUND_HEADER_ALLOWLIST].sort());
    expect(sanitized['range']).toBe('bytes=0-9');
    expect(sanitized).not.toHaveProperty('cookie');
    expect(sanitized).not.toHaveProperty('authorization');
    expect(sanitized).not.toHaveProperty('x-littleq-tenant');
  });

  it('每一个主站凭据头都被识别为凭据面，白名单里的头都不是', () => {
    for (const name of MAIN_SITE_CREDENTIAL_HEADERS) {
      expect(isMainSiteCredentialHeader(name), `${name} 必须被识别为凭据面`).toBe(true);
      expect(isMainSiteCredentialHeader(name.toUpperCase()), `${name} 大小写不敏感`).toBe(true);
    }
    expect(isMainSiteCredentialHeader(`${MAIN_SITE_HEADER_PREFIX}anything`)).toBe(true);
    for (const name of UPSTREAM_HEADER_ALLOWLIST) {
      expect(isMainSiteCredentialHeader(name)).toBe(false);
    }
    expect(
      findMainSiteCredentialHeaders(BROWSER_HEADERS).every(
        (name) =>
          name === 'authorization' ||
          name === 'cookie' ||
          name === 'proxy-authorization' ||
          name.startsWith(MAIN_SITE_HEADER_PREFIX),
      ),
    ).toBe(true);
    expect(findMainSiteCredentialHeaders(BROWSER_HEADERS).length).toBe(5);
  });

  it('上游头白名单不含任何凭据面，构造结果里也一个都没有', () => {
    for (const name of UPSTREAM_HEADER_ALLOWLIST) {
      expect(MAIN_SITE_CREDENTIAL_HEADERS).not.toContain(name);
    }
    const upstream = buildUpstreamHeaders(sanitizeInboundRequestHeaders(BROWSER_HEADERS));
    expect(upstream).toEqual({ range: 'bytes=0-9' });
    expect(findMainSiteCredentialHeaders(upstream)).toEqual([]);
  });

  it('外发前那道独立的锁：带头凭据就抛，不带就放行', () => {
    for (const name of [...MAIN_SITE_CREDENTIAL_HEADERS, 'x-littleq-session']) {
      expect(
        () => assertNoMainSiteCredentialHeaders({ [name]: 'whatever' }, '测试上下文'),
        `${name} 必须触发拒绝`,
      ).toThrow(TypeError);
    }
    expect(() =>
      assertNoMainSiteCredentialHeaders({ range: 'bytes=0-9', accept: '*/*' }, '测试上下文'),
    ).not.toThrow();
  });

  it('grant URL 的源必须是被钉住的那一个，别的源直接拒绝', () => {
    const pinned = pinGrantUrl('https://platform.invalid/a/b?token=x', 'https://platform.invalid');
    expect(pinned.origin).toBe('https://platform.invalid');
    expect(pinned.objectKey).toBe('https://platform.invalid/a/b');
    expect(() =>
      pinGrantUrl('https://elsewhere.invalid/a/b?token=x', 'https://platform.invalid'),
    ).toThrow(/不是本运行时钉住的平台源/);
    expect(() =>
      pinGrantUrl('https://user:pass@platform.invalid/a/b', 'https://platform.invalid'),
    ).toThrow(/不得内嵌 userinfo/);
  });

  it('apps/runtime 的 package.json 不声明任何依赖（数据库 / 对象存储 / 模型 SDK 都进不来）', () => {
    const manifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    for (const field of DEPENDENCY_FIELDS) {
      const declared = manifest[field] as Record<string, string> | undefined;
      expect(Object.keys(declared ?? {}), `${field} 必须为空`).toEqual([]);
    }
  });

  it('实跑替身源：主站 Cookie / Authorization 没有跟着取字节请求走出去', async () => {
    const body = deterministicBytes(64);
    await withSubstituteOrigin(objectOf(body), async (substitute) => {
      const fetcher = createGrantByteFetcher({
        allowedOrigin: substitute.origin,
        maxBytesPerObject: 4096,
        timeoutMs: 5000,
      });
      const result = await fetcher.fetchBytes({
        grantUrl: substitute.grantUrl('/artifacts/demo.bin'),
        inboundHeaders: BROWSER_HEADERS,
      });

      // 内容源与主站源是两个源：这不是措辞，是可断言的字符串不相等。
      expect(result.objectKey.startsWith(substitute.origin)).toBe(true);
      expect(substitute.origin).not.toBe(MAIN_SITE_ORIGIN);
      // 请求带了 `Range: bytes=0-9`，所以交付的是切片；顺带钉住 206 语义与摘要覆盖的是
      // **交付出去的那一份**（把全量摘要贴在切片上是这项能力最容易犯的错）。
      const slice = body.subarray(0, 10);
      expect(result.status).toBe(206);
      expect(result.contentRange).toBe('bytes 0-9/64');
      expect(result.bytes).toEqual(slice);
      expect(result.byteLength).toBe(10);
      expect(result.sha256).toBe(sha256Hex(slice));

      // 替身把实收的头记了下来。整个请求里没有 Range 之外的任何应用层头，
      // 更没有任何主站凭据 —— grant 的凭据在 URL 查询串里，由主站签发、单对象、限时。
      expect(substitute.requests.length).toBe(1);
      const recorded = substitute.requests[0];
      expect(recorded?.range).toBe('bytes=0-9');
      expect(recorded?.cookie).toBeNull();
      expect(recorded?.authorization).toBeNull();
      const seenHeaderNames = recorded?.headerNames ?? [];
      expect(seenHeaderNames.filter((name) => isMainSiteCredentialHeader(name))).toEqual([]);
      for (const name of ['cookie', 'authorization', 'proxy-authorization', 'x-littleq-tenant']) {
        expect(seenHeaderNames, `${name} 不得出现在发往内容源的请求里`).not.toContain(name);
      }

      // 回给浏览器的那一份响应头里也没有 Set-Cookie：运行时不种会话，也不回显上游地址。
      const responseHeaderNames = Object.keys(
        artifactResponseHeaders({
          status: result.status,
          byteLength: result.byteLength,
          upstreamContentType: result.upstreamContentType,
          contentRange: result.contentRange,
          sha256: result.sha256,
        }),
      );
      expect(responseHeaderNames.filter((name) => isMainSiteCredentialHeader(name))).toEqual([]);
      expect(responseHeaderNames.join('\n')).not.toContain(substitute.origin);
    });
  });
});

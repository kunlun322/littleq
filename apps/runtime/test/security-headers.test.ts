/**
 * 门禁证明点 `security-headers`：独立源上每一个响应都必须带的那一组安全头。
 *
 * 这份测试是**钉版**的：期望值在这里逐条写死，不从 `src/security-headers.ts` 反推。
 * 于是「漏一个头」「值写错」「悄悄放宽某一项」都会先在这里变红，而不是等到线上。
 *
 * 两条反真空绿的对照也写在里面：键集合与记录必须双向相等（少一个键、多一个没有键的值都红），
 * 并且每一项的值都必须非空字符串 —— 否则「逐项断言」可以在一份空记录上全部通过。
 */

import { describe, expect, it } from 'vitest';

import {
  FALLBACK_CONTENT_TYPE,
  RUNTIME_CONTENT_SECURITY_POLICY,
  RUNTIME_PERMISSIONS_POLICY,
  RUNTIME_SECURITY_HEADER_KEYS,
  artifactResponseHeaders,
  assertHeaderValueSafe,
  runtimeSecurityHeaders,
  sanitizeContentType,
  sanitizeFilename,
  withRuntimeSecurityHeaders,
} from '../src/index.js';

const PROOF = 'security-headers';

/** 期望的 CSP：16 项，逐项写死。顺序也纳入断言，改序即改 diff。 */
const EXPECTED_CSP_DIRECTIVES = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "script-src 'none'",
  "style-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "connect-src 'none'",
  "manifest-src 'none'",
  'sandbox',
  'upgrade-insecure-requests',
];

const EXPECTED_PERMISSIONS = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'display-capture=()',
  'clipboard-read=()',
  'clipboard-write=()',
];

/** 期望的安全头键集合：10 项，写死。 */
const EXPECTED_HEADER_KEYS = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'cache-control',
];

/** 拓宽一次索引类型，好让键可以来自上面那份写死的清单而不是字面量。 */
const HEADERS: Readonly<Record<string, string>> = runtimeSecurityHeaders;

describe(`门禁证明点 ${PROOF}：运行时源的安全响应头逐项钉死`, () => {
  it('键清单与头记录双向相等，且每一项都是非空字符串（反真空绿）', () => {
    expect([...RUNTIME_SECURITY_HEADER_KEYS]).toEqual(EXPECTED_HEADER_KEYS);
    expect(Object.keys(runtimeSecurityHeaders).sort()).toEqual([...EXPECTED_HEADER_KEYS].sort());
    for (const key of EXPECTED_HEADER_KEYS) {
      const value = HEADERS[key];
      expect(typeof value, `${key} 必须存在`).toBe('string');
      expect((value ?? '').trim().length, `${key} 不得为空`).toBeGreaterThan(0);
    }
  });

  it('content-security-policy 是 deny-all 且带 sandbox', () => {
    expect(RUNTIME_CONTENT_SECURITY_POLICY).toBe(EXPECTED_CSP_DIRECTIVES.join('; '));
    expect(runtimeSecurityHeaders['content-security-policy']).toBe(
      EXPECTED_CSP_DIRECTIVES.join('; '),
    );
    for (const directive of EXPECTED_CSP_DIRECTIVES) {
      expect(RUNTIME_CONTENT_SECURITY_POLICY, `CSP 必须含 ${directive}`).toContain(directive);
    }
    // 不可信内容源上任何一条放宽都是事故，所以这里反向钉死「不许出现」。
    for (const banned of ["'unsafe-inline'", "'unsafe-eval'", "'self'", '*', 'data:']) {
      expect(RUNTIME_CONTENT_SECURITY_POLICY, `CSP 不得含 ${banned}`).not.toContain(banned);
    }
  });

  it('permissions-policy 逐项关闭八个能力', () => {
    expect(RUNTIME_PERMISSIONS_POLICY).toBe(EXPECTED_PERMISSIONS.join(', '));
    expect(runtimeSecurityHeaders['permissions-policy']).toBe(EXPECTED_PERMISSIONS.join(', '));
  });

  it('x-content-type-options 为 nosniff', () => {
    expect(runtimeSecurityHeaders['x-content-type-options']).toBe('nosniff');
  });

  it('x-frame-options 为 DENY（不是 SAMEORIGIN）', () => {
    expect(runtimeSecurityHeaders['x-frame-options']).toBe('DENY');
  });

  it('referrer-policy 为 no-referrer：grant URL 里带一次性凭据，不许被 Referer 带出去', () => {
    expect(runtimeSecurityHeaders['referrer-policy']).toBe('no-referrer');
  });

  it('三项 cross-origin-* 头分别为 same-origin / require-corp / same-origin', () => {
    expect(runtimeSecurityHeaders['cross-origin-opener-policy']).toBe('same-origin');
    expect(runtimeSecurityHeaders['cross-origin-embedder-policy']).toBe('require-corp');
    expect(runtimeSecurityHeaders['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('strict-transport-security 两年 + 子域，但不含 preload（不可逆的运维承诺不在此单做出）', () => {
    expect(runtimeSecurityHeaders['strict-transport-security']).toBe(
      'max-age=63072000; includeSubDomains',
    );
    expect(runtimeSecurityHeaders['strict-transport-security']).not.toContain('preload');
  });

  it('cache-control 基线为 no-store, max-age=0', () => {
    expect(runtimeSecurityHeaders['cache-control']).toBe('no-store, max-age=0');
  });

  it('合并时安全基线永远赢：调用方同名头覆盖不掉任何一项', () => {
    const merged = withRuntimeSecurityHeaders({
      'x-frame-options': 'ALLOWALL',
      'content-security-policy': 'default-src *',
      'cache-control': 'public, max-age=31536000',
      'x-artifact-sha256': 'deadbeef',
    });
    for (const key of EXPECTED_HEADER_KEYS) {
      expect(merged[key], `${key} 不得被调用方覆盖`).toBe(HEADERS[key]);
    }
    // 非安全基线的头仍然可以带出去。
    expect(merged['x-artifact-sha256']).toBe('deadbeef');
  });

  it('作品响应：200 形状带齐安全头、attachment 与收紧后的 cache-control', () => {
    const headers = artifactResponseHeaders({
      status: 200,
      byteLength: 1234,
      upstreamContentType: 'image/png; charset=bogus',
      filename: 'my work.png',
      sha256: 'a'.repeat(64),
    });
    for (const key of EXPECTED_HEADER_KEYS) {
      expect(headers[key], `${key} 必须出现在作品响应里`).toBeDefined();
    }
    expect(headers['content-security-policy']).toBe(EXPECTED_CSP_DIRECTIVES.join('; '));
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-type']).toBe('image/png');
    expect(headers['content-length']).toBe('1234');
    expect(headers['content-disposition']).toBe('attachment; filename="my work.png"');
    expect(headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(headers['x-artifact-sha256']).toBe('a'.repeat(64));
    expect(headers).not.toHaveProperty('content-range');
    expect(headers).not.toHaveProperty('set-cookie');
  });

  it('作品响应：206 形状必须带 content-range，缺了就抛', () => {
    const headers = artifactResponseHeaders({
      status: 206,
      byteLength: 10,
      contentRange: 'bytes 0-9/100',
      upstreamContentType: null,
      filename: null,
    });
    expect(headers['content-range']).toBe('bytes 0-9/100');
    expect(headers['content-length']).toBe('10');
    expect(headers['content-type']).toBe(FALLBACK_CONTENT_TYPE);
    expect(headers['content-disposition']).toBe('attachment; filename="artifact.bin"');
    expect(() => artifactResponseHeaders({ status: 206, byteLength: 10 })).toThrow(TypeError);
    expect(() =>
      artifactResponseHeaders({ status: 206, byteLength: 10, contentRange: null }),
    ).toThrow(/206 必须带 contentRange/);
  });

  it('头注入：CR / LF / NUL 一律拒绝写出', () => {
    expect(assertHeaderValueSafe('x-test', 'plain value')).toBe('plain value');
    for (const injected of ['a\r\nb', 'a\nb', 'a\rb', 'a\0b']) {
      expect(() => assertHeaderValueSafe('x-test', injected)).toThrow(TypeError);
      expect(() => withRuntimeSecurityHeaders({ 'x-test': injected })).toThrow(TypeError);
    }
  });

  it('上游自称的 Content-Type 被削成主令牌，形状不合法就退回 application/octet-stream', () => {
    expect(sanitizeContentType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(sanitizeContentType('IMAGE/PNG')).toBe('image/png');
    expect(sanitizeContentType('text/html"><script>alert(1)</script>')).toBe(FALLBACK_CONTENT_TYPE);
    expect(sanitizeContentType('not-a-content-type')).toBe(FALLBACK_CONTENT_TYPE);
    expect(sanitizeContentType('')).toBe(FALLBACK_CONTENT_TYPE);
    expect(sanitizeContentType(null)).toBe(FALLBACK_CONTENT_TYPE);
    expect(sanitizeContentType(undefined)).toBe(FALLBACK_CONTENT_TYPE);
    expect(sanitizeContentType('text/html\r\nx-injected: 1')).toBe(FALLBACK_CONTENT_TYPE);
    expect(FALLBACK_CONTENT_TYPE).toBe('application/octet-stream');
  });

  it('文件名净化：先取 basename 再去引号与控制字符，空值退回 artifact.bin', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system.ini')).toBe('system.ini');
    expect(sanitizeFilename('a"b\\c/d.txt')).toBe('d.txt');
    expect(sanitizeFilename('evil\r\nx-disposition: inline')).toBe('evilx-disposition: inline');
    expect(sanitizeFilename('   ')).toBe('artifact.bin');
    expect(sanitizeFilename('.')).toBe('artifact.bin');
    expect(sanitizeFilename('..')).toBe('artifact.bin');
    expect(sanitizeFilename('')).toBe('artifact.bin');
    expect(sanitizeFilename(null)).toBe('artifact.bin');
    expect(sanitizeFilename(undefined)).toBe('artifact.bin');
  });

  it('净化后的文件名与 Content-Type 里不含任何 CR/LF/NUL（拼进响应头是安全的）', () => {
    const hostile = 'a\r\nb\0c"d\\e/f';
    const headers = artifactResponseHeaders({
      status: 200,
      byteLength: 1,
      upstreamContentType: hostile,
      filename: hostile,
    });
    for (const [name, value] of Object.entries(headers)) {
      expect(value, `${name} 不得含控制字符`).not.toMatch(/[\r\n\0]/);
      expect(name, `${name} 不得含控制字符`).not.toMatch(/[\r\n\0]/);
    }
  });
});

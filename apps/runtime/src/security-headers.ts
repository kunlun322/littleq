/**
 * 独立源的安全响应头（D4 的 `security-headers` 黑盒证明面）。
 *
 * ## 这一份为什么比主站那一份更严
 *
 * `apps/web/vercel.json` 服务的是**我们自己写的**页面，所以它给 `script-src 'self'`、
 * `style-src 'self'` 开了口子。`apps/runtime` 服务的是**学生作品**，也就是不可信内容，
 * 而且它跑在与主站不同的源上（ZLQ-194 §8.3）。因此这里的基线是 `default-src 'none'`
 * 加上逐项 `'none'`，再叠一个 `sandbox`。
 *
 * ## 一个显式的边界决定（交给 D6 / 架构师，不在本单自行放宽）
 *
 * `frame-ancestors 'none'`、`X-Frame-Options: DENY` 与 `cross-origin-resource-policy: same-origin`
 * 三项合起来意味着**运行时源当前不允许被任何其它源嵌入或加载**。主站壳页面要怎么集成作品
 * （顶层导航、iframe + `sandbox` 允许列表、还是服务端代理）是 D6 的产品与架构决定；本单
 * 刻意交付**最严**的基线，于是任何放宽都会成为一次带 diff 的显式评审，而不是一个默认值。
 *
 * 与之配套：作品字节一律以 `Content-Disposition: attachment` 交付。不可信的作品因此**不可能**
 * 在运行时源上变成活动文档，上面的 deny-all CSP 与它自洽。
 *
 * ## 头注入
 *
 * 上游给的 `Content-Type` 与文件名都是不可信输入，直接拼进响应头就是 CRLF 注入。这里两个都过
 * 白名单式净化：净化不了就退回 `application/octet-stream` / `artifact.bin`，并且任何值在写进
 * 结果前都断言不含 CR、LF 与 NUL。
 */

/** deny-all 的内容安全策略。逐项列出而不是只写 `default-src 'none'`：显式比继承可审。 */
export const RUNTIME_CONTENT_SECURITY_POLICY = [
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
].join('; ');

export const RUNTIME_PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'display-capture=()',
  'clipboard-read=()',
  'clipboard-write=()',
].join(', ');

/**
 * 运行时源上**每一个**响应都必须带的安全头。键按断言顺序排列，
 * `apps/runtime/test/security-headers.test.ts` 逐项钉死键与值。
 */
export const RUNTIME_SECURITY_HEADER_KEYS = [
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
] as const;

export type RuntimeSecurityHeaderKey = (typeof RUNTIME_SECURITY_HEADER_KEYS)[number];

export const runtimeSecurityHeaders: Readonly<Record<RuntimeSecurityHeaderKey, string>> =
  Object.freeze({
    'content-security-policy': RUNTIME_CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // `no-referrer` 而不是主站的 `strict-origin-when-cross-origin`：作品响应与 grant 取回的
    // Referer 一旦外泄，带出去的可能正是主站签发的一次性凭据所在的 URL。
    'referrer-policy': 'no-referrer',
    'permissions-policy': RUNTIME_PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
    // 不含 `preload`：进 HSTS preload 列表是不可逆的运维承诺，留给运维/架构师决定。
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'cache-control': 'no-store, max-age=0',
  });

const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;

/** 任何要写进响应头的值都必须先过这一关。 */
export function assertHeaderValueSafe(name: string, value: string): string {
  if (HEADER_VALUE_FORBIDDEN.test(value)) {
    throw new TypeError(`响应头 ${name} 的值含 CR/LF/NUL，拒绝写出（头注入）`);
  }
  return value;
}

const CONTENT_TYPE_TOKEN = /^[a-z0-9!#$%&'*+.^_|~-]+\/[a-z0-9!#$%&'*+.^_|~-]+$/;

export const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * 净化上游自称的 `Content-Type`：只保留 `type/subtype` 主令牌，丢掉全部参数。
 * 形状不合法（含参数、含控制字符、含引号）一律退回 `application/octet-stream` ——
 * 配合 `x-content-type-options: nosniff`，浏览器就没有任何余地把它猜成 HTML。
 */
export function sanitizeContentType(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return FALLBACK_CONTENT_TYPE;
  const primary = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return CONTENT_TYPE_TOKEN.test(primary) ? primary : FALLBACK_CONTENT_TYPE;
}

const FALLBACK_FILENAME = 'artifact.bin';
const FILENAME_FORBIDDEN = /[\r\n\0"\\]/g;
const PATH_SEPARATOR = /[\\/]/;

/**
 * 净化 `Content-Disposition` 里的文件名。
 *
 * 先取 basename 再删字符 —— 顺序反了的话 `../../etc/passwd` 里的分隔符会先被删掉，
 * 于是「取 basename」这一步无东西可取，路径穿越被拼成了一个看似无害的长名字。
 */
export function sanitizeFilename(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return FALLBACK_FILENAME;
  const basename = raw.split(PATH_SEPARATOR).pop() ?? '';
  const cleaned = basename.replace(FILENAME_FORBIDDEN, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? FALLBACK_FILENAME : cleaned;
}

/**
 * 把运行时安全头合并进一组响应头，**运行时这边永远赢**：
 * 上游或调用方传进来的同名头不会覆盖掉安全基线。
 */
export function withRuntimeSecurityHeaders(
  headers: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    merged[name.toLowerCase()] = assertHeaderValueSafe(name.toLowerCase(), value);
  }
  for (const key of RUNTIME_SECURITY_HEADER_KEYS) {
    merged[key] = runtimeSecurityHeaders[key];
  }
  return merged;
}

export interface ArtifactResponseInit {
  /** 只有 200 与 206 两种合法交付形状。 */
  readonly status: 200 | 206;
  readonly byteLength: number;
  /** 上游自称的 Content-Type，不可信，会被净化。 */
  readonly upstreamContentType?: string | null;
  readonly filename?: string | null;
  /** `status === 206` 时必填。 */
  readonly contentRange?: string | null;
  /** 运行时**自己算出来并已校验通过**的 SHA-256，不是上游自称的那个。 */
  readonly sha256?: string | null;
}

/**
 * 交给浏览器的作品响应头 = 运行时安全基线 + 本次交付的事实。
 *
 * `content-disposition` 固定为 `attachment`：见文件头「显式的边界决定」。
 */
export function artifactResponseHeaders(init: ArtifactResponseInit): Record<string, string> {
  if (init.status === 206 && (init.contentRange === null || init.contentRange === undefined)) {
    throw new TypeError('status 206 必须带 contentRange，否则响应不是合法的 206 语义');
  }
  const headers = withRuntimeSecurityHeaders({
    'content-type': sanitizeContentType(init.upstreamContentType),
    'content-length': String(init.byteLength),
    'content-disposition': `attachment; filename="${sanitizeFilename(init.filename)}"`,
    ...(init.status === 206 && init.contentRange !== undefined && init.contentRange !== null
      ? { 'content-range': init.contentRange }
      : {}),
    ...(init.sha256 === undefined || init.sha256 === null
      ? {}
      : { 'x-artifact-sha256': init.sha256 }),
  });
  // `cache-control` 是安全基线里唯一允许被交付事实**收紧**（不是放宽）的一项：
  // 基线是 `no-store, max-age=0`，作品字节额外加 `private`。放在合并之后赋值，
  // 因为 withRuntimeSecurityHeaders 的语义是「基线永远赢」。
  headers['cache-control'] = assertHeaderValueSafe('cache-control', 'private, no-store, max-age=0');
  return headers;
}

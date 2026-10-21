/**
 * 「作品内容由独立源提供」的客户端侧契约（D4 的 `separate-origin-content` 证明面）。
 *
 * ZLQ-194 §8.3 的要求是：作品运行时是隔离侧进程，**不访问主站 Cookie / 数据库 / AI 凭证**。
 * 这句话在 D4 能被判定成红/绿的部分不是「有没有连数据库」（那要等 D5/D6 的真实链路），
 * 而是**头与凭据的流向**：
 *
 * - 入站：浏览器带来的头只有白名单里的能进入处理链，`Cookie` / `Authorization` 一律被剥掉；
 * - 出站（向上游 grant URL）：只发白名单里的头，且**永不**发主站凭据 —— grant URL 的查询串
 *   里承载的是主站签发的、单对象、≤300 秒的一次性凭据，那不是主站会话凭据，两者必须分开；
 * - 出站（向浏览器）：永不下发 `Set-Cookie`，永不回显上游 URL 或 token。
 *
 * 依赖侧的同一句话由 `config/dependency-graph.json` 的 `runtime-no-main-site-units` /
 * `runtime-no-main-site-secrets` 与 `test/isolation.test.ts` 双向锁死，本文件不重复它。
 */

export interface RuntimeOriginContract {
  readonly sharesMainSiteCookies: false;
  readonly sharesMainSiteDatabase: false;
  readonly sharesAiCredentials: false;
  readonly servesMainSiteSession: false;
  /** 浏览器入站头里唯一允许进入处理链的那些。 */
  readonly inboundHeaderAllowlist: readonly string[];
  /** 运行时向平台 grant URL 发出的头，唯一允许的那些。 */
  readonly upstreamHeaderAllowlist: readonly string[];
}

/**
 * 入站白名单刻意很短：运行时只需要「取哪一段字节」与「协商缓存」两件事。
 * `Range` 是 D4 的四项验收之一，其余四项是条件请求与内容协商的常规头。
 */
export const INBOUND_HEADER_ALLOWLIST = [
  'range',
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
] as const;

/**
 * 上游只需要知道「取哪一段」。刻意**不含** `authorization`：grant URL 自带凭据，
 * 运行时不持有任何主站凭据，也就没有任何东西可以放到这个头里。
 */
export const UPSTREAM_HEADER_ALLOWLIST = ['range'] as const;

export const runtimeOriginContract: RuntimeOriginContract = Object.freeze({
  sharesMainSiteCookies: false,
  sharesMainSiteDatabase: false,
  sharesAiCredentials: false,
  servesMainSiteSession: false,
  inboundHeaderAllowlist: INBOUND_HEADER_ALLOWLIST,
  upstreamHeaderAllowlist: UPSTREAM_HEADER_ALLOWLIST,
});

/** 一旦出现就说明隔离面被穿透的头。 */
export const MAIN_SITE_CREDENTIAL_HEADERS = [
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
] as const;

/** 主站自有头的命名空间；`x-littleq-*` 一律视作主站凭据面。 */
export const MAIN_SITE_HEADER_PREFIX = 'x-littleq-';

export function isMainSiteCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(MAIN_SITE_HEADER_PREFIX)) return true;
  return (MAIN_SITE_CREDENTIAL_HEADERS as readonly string[]).includes(lower);
}

export type RawHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;

function firstValue(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  const single = Array.isArray(value) ? value[0] : value;
  if (single === undefined) return null;
  return HEADER_VALUE_FORBIDDEN.test(single) ? null : single;
}

/**
 * 把入站请求头削成白名单内的、值安全的子集。
 *
 * 这是**默认拒绝**：不在 `INBOUND_HEADER_ALLOWLIST` 里的头不是被「过滤掉敏感项」，
 * 而是根本不存在。所以往运行时里加一个新的头必须改这份白名单，那是一次显式改动。
 */
export function sanitizeInboundRequestHeaders(headers: RawHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!(INBOUND_HEADER_ALLOWLIST as readonly string[]).includes(name)) continue;
    const value = firstValue(rawValue);
    if (value === null) continue;
    out[name] = value;
  }
  return out;
}

/** 列出这批头里所有属于主站凭据面的键（已小写、已排序，便于逐条断言）。 */
export function findMainSiteCredentialHeaders(headers: RawHeaders): string[] {
  return Object.keys(headers)
    .filter((name) => isMainSiteCredentialHeader(name))
    .map((name) => name.toLowerCase())
    .sort();
}

/**
 * 向任何外部源发出请求之前的最后一道锁。
 *
 * 与白名单是两把独立的锁：白名单管「什么能进来」，这一条管「主站凭据绝不允许出现在
 * 即将外发的头里」。两把都过，才发请求。
 */
export function assertNoMainSiteCredentialHeaders(headers: RawHeaders, context: string): void {
  const found = findMainSiteCredentialHeaders(headers);
  if (found.length > 0) {
    throw new TypeError(
      `${context}：待外发的头里出现主站凭据面 ${found.join(', ')} —— 运行时是隔离侧进程，不得携带主站 Cookie / 会话`,
    );
  }
}

/**
 * 构造发往上游 grant URL 的头：入站净化结果 ∩ 上游白名单。
 * 单独一个函数，是为了让「转发给上游的只有 Range」这件事有一处可断言的实现。
 */
export function buildUpstreamHeaders(
  inbound: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(inbound)) {
    if (!(UPSTREAM_HEADER_ALLOWLIST as readonly string[]).includes(name.toLowerCase())) continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}

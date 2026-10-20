/**
 * `@littleq/runtime` 的进程内部错误面。
 *
 * 这里的码**不在** `contracts/errors/v1/error-catalog.json` 的冻结目录里，也不新增任何公开
 * OpenAPI 操作 —— 它们只描述「运行时向平台 grant URL 取字节」这一次进程内调用的失败形状。
 * 对外的 HTTP 映射（404 / 422 / 429）属 `apps/api` = D5 的职责。
 *
 * 本文件只保证一件与安全直接相关的事：**任何错误消息里都不出现 grant URL 的查询串**，
 * 因为那里承载着主站签发的一次性凭据；消息里只允许出现 `redactGrantUrl` 之后的形状。
 */

export type RuntimeGrantErrorCode =
  | 'RUNTIME_GRANT_URL_REJECTED'
  | 'RUNTIME_GRANT_OUTSIDE_VALIDITY_WINDOW'
  | 'RUNTIME_GRANT_TIMEOUT'
  | 'RUNTIME_GRANT_ABORTED'
  | 'RUNTIME_GRANT_UPSTREAM_UNREACHABLE'
  | 'RUNTIME_GRANT_UPSTREAM_REJECTED'
  | 'RUNTIME_GRANT_UNEXPECTED_STATUS'
  | 'RUNTIME_GRANT_RANGE_NOT_SATISFIABLE'
  | 'RUNTIME_GRANT_RANGE_MISMATCH'
  | 'RUNTIME_GRANT_BUDGET_EXCEEDED'
  | 'RUNTIME_GRANT_HASH_MISMATCH';

export class RuntimeGrantError extends Error {
  readonly code: RuntimeGrantErrorCode;
  /** 脱敏后的 grant URL（不含查询串）；给日志与调用方看的唯一 URL 形状。 */
  readonly redactedUrl: string;
  /** 上游 HTTP 状态，仅在失败确实来自上游响应时存在。 */
  readonly upstreamStatus: number | null;

  constructor(
    code: RuntimeGrantErrorCode,
    redactedUrl: string,
    message: string,
    upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = 'RuntimeGrantError';
    this.code = code;
    this.redactedUrl = redactedUrl;
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * 把 grant URL 削成「源 + 路径」，查询串整体替换为 `<REDACTED>`。
 *
 * 刻意不做 URL 解析后再序列化：解析失败时 `new URL` 会抛，而**抛异常的那条路径恰恰是
 * 最需要打日志的**。这里只做字符串裁剪，任何输入都能得到一个不含凭据的可打印形状。
 */
export function redactGrantUrl(url: string): string {
  const queryAt = url.indexOf('?');
  const head = queryAt === -1 ? url : url.slice(0, queryAt);
  const fragmentAt = head.indexOf('#');
  const bare = fragmentAt === -1 ? head : head.slice(0, fragmentAt);
  return queryAt === -1 ? bare : `${bare}?<REDACTED>`;
}

/** 十六进制摘要归一化：大小写不敏感，且拒绝带前缀/空格的形状。 */
export function normalizeHexDigest(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]+$/.test(trimmed) ? trimmed : null;
}

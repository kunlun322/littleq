import { DomainError } from '../errors/domain-error.js';

/**
 * 敏感文本识别 —— 领域层的最后一道结构性防线。
 *
 * ZLQ-153 §7.5 要求日志、`task_events` 与审计明细里不得出现凭证、签名 URL、
 * 原始 provider body、学生 prompt 全文与 stack。redactor 本身在 infra（它要处理
 * 任意来源的字符串），但**进入领域值的文本**必须在这里就被拒绝：一旦
 * `SafeEventPayload` 或 `ArtifactRef` 里装进了签名 URL，后面任何一层都无法再
 * 证明它是干净的。
 *
 * 这里只做**形状**判定，不做内容解密、不做熵估算以外的语义猜测；判定失败的
 * 统一归类为 `REQUEST_INVALID`，错误消息里只带值对象名，绝不回显被拒绝的文本。
 */

export type SensitiveTextReason =
  | 'CONTROL_CHARACTER'
  | 'ABSOLUTE_URL'
  | 'PROTOCOL_RELATIVE_URL'
  | 'URL_QUERY_STRING'
  | 'SIGNED_URL_PARAMETER'
  | 'BEARER_TOKEN'
  | 'JWT_LIKE'
  | 'CREDENTIAL_ASSIGNMENT';

// 控制字符**就是** no-control-regex 要拦的东西：这里的字符类是「拒绝把不可见字符
// 带进自由文本」的判据本身，不是误写。说明写在上面一行，指令必须紧贴被禁的那行。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const PROTOCOL_RELATIVE_PATTERN = /^\/\//;
const QUERY_STRING_PATTERN = /[?&][^\s]*=/;
const SIGNED_URL_PARAMETER_PATTERN =
  /[?&](sig|signature|token|access_token|expires|x-amz-[a-z0-9-]+|x-goog-[a-z0-9-]+|se|sp|sv)=/i;
const BEARER_TOKEN_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/i;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|pat|token)\s*[:=]\s*\S/i;
/** 三段式且足够长才当 JWT；短的点分标识符（`work.json`、`v1.0.0`）不能被误伤。 */
const JWT_LIKE_PATTERN = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/;

const SENSITIVE_TEXT_RULES: readonly {
  readonly reason: SensitiveTextReason;
  readonly pattern: RegExp;
}[] = [
  { reason: 'CONTROL_CHARACTER', pattern: CONTROL_CHARACTER_PATTERN },
  { reason: 'ABSOLUTE_URL', pattern: ABSOLUTE_URL_PATTERN },
  { reason: 'PROTOCOL_RELATIVE_URL', pattern: PROTOCOL_RELATIVE_PATTERN },
  { reason: 'SIGNED_URL_PARAMETER', pattern: SIGNED_URL_PARAMETER_PATTERN },
  { reason: 'BEARER_TOKEN', pattern: BEARER_TOKEN_PATTERN },
  { reason: 'CREDENTIAL_ASSIGNMENT', pattern: CREDENTIAL_ASSIGNMENT_PATTERN },
  { reason: 'JWT_LIKE', pattern: JWT_LIKE_PATTERN },
  { reason: 'URL_QUERY_STRING', pattern: QUERY_STRING_PATTERN },
];

/**
 * 返回第一个命中的敏感形状，全部未命中返回 `null`。
 *
 * 规则顺序是**语义的**：`SIGNED_URL_PARAMETER` 必须排在 `URL_QUERY_STRING` 之前，
 * 否则所有签名 URL 都只会报「带查询参数」，把真正的原因埋掉。
 */
export function detectSensitiveText(value: string): SensitiveTextReason | null {
  if (typeof value !== 'string') return 'CONTROL_CHARACTER';
  for (const rule of SENSITIVE_TEXT_RULES) {
    if (rule.pattern.test(value)) return rule.reason;
  }
  return null;
}

export function isSensitiveText(value: string): boolean {
  return detectSensitiveText(value) !== null;
}

/**
 * 断言文本不含敏感形状。抛出的 `DomainError` 只带值对象名 —— 被拒绝的原文
 * 既不进 message，也不进 stack，因此不会经由错误 envelope 二次泄漏。
 */
export function assertNotSensitiveText(value: string, name: string): void {
  if (detectSensitiveText(value) !== null) throw DomainError.invalid(name);
}

/**
 * 安全载荷（`task_events.safe_payload_json`、`audit_logs.safe_details_json`）
 * 的键名黑名单。
 *
 * `pat` 用词边界匹配，避免误伤 `path`；`key` 不做子串匹配，因为
 * `idempotencyKey` / `eventKey` / `sourceEventKey` 是合法的领域概念。
 */
const FORBIDDEN_SAFE_KEY_PATTERN =
  /(password|passwd|secret|signature|authorization|cookie|credential|prompt|stack|trace|digest|x-amz|x-goog|bearer|session[_-]?token)|(^|[^a-z])pat([^a-z]|$)/i;

export function isForbiddenSafeKey(key: string): boolean {
  return FORBIDDEN_SAFE_KEY_PATTERN.test(key);
}

/** 安全载荷的键名形状：小驼峰，1..64 字符。 */
const SAFE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;

export function isSafeKey(key: string): boolean {
  return SAFE_KEY_PATTERN.test(key) && !isForbiddenSafeKey(key);
}

/** 安全载荷允许的值类型：JSON 标量。对象与数组一律拒绝，防止嵌套夹带。 */
export type SafeScalar = string | number | boolean | null;

/**
 * `NaN` / `Infinity` 虽然 `typeof === 'number'`，但 JSON 会把它们序列化成 `null`：
 * 放进安全载荷等于静默丢字段，所以在这里就拒掉。
 */
export function isSafeScalar(value: unknown): value is SafeScalar {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string';
}

/**
 * 键值对级别的安全判定：键名过 `isSafeKey`，字符串值再过一次敏感形状检查。
 *
 * 键名黑名单挡的是「字段名就宣告了这是凭证」，值形状挡的是「字段名无害但内容是
 * 签名 URL」—— 两者缺一不可，`safe_payload_json` 与 `safe_details_json` 都靠它。
 */
export function isSafeEntry(key: string, value: unknown): boolean {
  if (!isSafeKey(key) || !isSafeScalar(value)) return false;
  return typeof value !== 'string' || detectSensitiveText(value) === null;
}

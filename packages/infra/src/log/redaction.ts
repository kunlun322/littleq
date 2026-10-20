/**
 * 日志脱敏（ZLQ-201 裁定一 §6 / ZLQ-194 §14 第 6 项：原始签名 URL 不落日志）。
 *
 * 这一层存在的理由是：脱敏**不能**依赖每个调用点记得做。所以它同时提供两种保护——
 *
 * 1. **结构性**：`InfraLogger` 是唯一被允许写日志的入口，它在写入前对 message 与每个字段值
 *    跑一遍 `redactText`，对字段名跑一遍 deny-list。调用方就算把 `SensitiveUrl` 或 token
 *    直接塞进来，落盘的也是脱敏后的形状。
 * 2. **可判定**：`fingerprint()` 给的是 sha256 前 12 位十六进制 —— 不可逆、可关联，正好是
 *    裁定允许进日志的那一类值（grantId 指纹、内部 objectId、状态码、字节数、耗时）。
 *
 * 允许进日志的与禁止进日志的，两边都在这里点名，测试直接对着这两个清单断言。
 */
import { createHash } from 'node:crypto';

export const REDACTED = '[redacted]';

/** 字段名 deny-list：命中即整值替换，不做部分脱敏（部分脱敏等于留了个可爆破的前缀）。 */
export const DENY_LISTED_FIELD_NAME_PARTS = [
  'authorization',
  'bloburl',
  'ciphertext',
  'cookie',
  'downloadurl',
  'granturl',
  'masterkey',
  'nonce',
  'oidctoken',
  'password',
  'plaintext',
  'presign',
  'secret',
  'signature',
  'tag',
  'token',
  'url',
] as const;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** 真正落地的那一层（console、结构化采集器、测试 spy）；本包只依赖这个形状。 */
export interface LogSink {
  write(record: LogRecord): void;
}

export interface InfraLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * 不可逆短指纹。12 位十六进制 = 48 bit，足够在一段日志里把同一个 grant 串起来，
 * 又不足以反推原值（grantId 本身是 128 bit 随机）。
 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

const URL_RUN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>)]+/g;

/**
 * 把一个绝对 URL 缩成「scheme + host + `[redacted]`」。
 *
 * path / query / fragment / userinfo 全部丢掉，而不是逐参数过滤：provider 的签名就在 query
 * 里（`?token=`、`X-Amz-Signature=`、`se=`/`sig=`），逐参数过滤永远会漏掉下一个新参数名；
 * path 里则可能嵌着 grantId 与内部 key，裁定只允许它们的**指纹**进日志。
 */
export function redactUrlText(raw: string): string {
  const schemeEnd = raw.indexOf('://');
  if (schemeEnd <= 0) return REDACTED;
  const scheme = raw.slice(0, schemeEnd);
  const rest = raw.slice(schemeEnd + 3);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : authority.slice(at + 1);
  return `${scheme}://${host.length === 0 ? REDACTED : host}/${REDACTED}`;
}

/** 把文本里每一段绝对 URL 换成脱敏形式。 */
export function redactText(text: string): string {
  return text.replace(URL_RUN, (match) => redactUrlText(match));
}

function isDenyListedName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return DENY_LISTED_FIELD_NAME_PARTS.some((part) => normalized.includes(part));
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= 4) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const source = value as Record<string, unknown>;
  // SensitiveUrl / 任何自带 toJSON 的值对象：走它自己的脱敏形状，不去展开私有字段。
  if (typeof source['toJSON'] === 'function') return redactValue(source['toJSON'](), depth + 1);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    out[key] = isDenyListedName(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return out;
}

/** 对一条记录的 message 与字段整体脱敏；返回**新对象**，不改调用方手里的那份。 */
export function redactRecord(record: LogRecord): LogRecord {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    fields[key] = isDenyListedName(key) ? REDACTED : redactValue(value, 0);
  }
  return { level: record.level, message: redactText(record.message), fields };
}

/**
 * 包一层脱敏的 logger。
 *
 * `sink` 收到的永远是脱敏后的记录，所以「测试里挂一个 spy sink，断言原文没出现」这句话
 * 是对**真实写入路径**做的断言，不是对某个旁路函数做的。
 */
export function createRedactingLogger(sink: LogSink): InfraLogger {
  const emit =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}) => {
      sink.write(redactRecord({ level, message, fields }));
    };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

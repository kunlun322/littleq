/**
 * 基础设施端口共用的五个值类型（ZLQ-203 §3）。
 *
 * `ObjectRef` / `StoredObjectStream` / `StoredObjectMetadata` / `HealthResult` / `SensitiveUrl`
 * 这五个名字在本单之前全仓 0 命中。PM 的裁定是**就地声明在 `packages/infra`**，不进
 * `packages/domain`：它们描述的是「字节存在哪、怎么被读出来」，属于基础设施形状，不是业务
 * 事实。业务事实仍归 domain（`ArtifactDigest`、`SecretKind`、`SecretRef`、42 个公开错误码），
 * 本文件反过来复用它们，所以两层不会各自长出一套摘要/密钥类型。
 *
 * ## 两个结构性保证（不靠调用方自觉）
 *
 * 1. `ObjectRef` 的语法里**没有 `:`**，因此 `https://…` 这类 provider URL 根本无法通过
 *    `parseObjectRef`。「对外不发 Blob URL / presign URL」不是每个调用点都要记得的纪律，
 *    而是 ref 这个类型装不下一个 URL。
 * 2. `SensitiveUrl` 的原文放在**私有字段**里，实例上唯一可枚举的属性是脱敏结果，所以
 *    `JSON.stringify`、`util.inspect` 的默认展开、`{ ...grant }` 浅拷贝都拿不到原文。
 *    要原文只有一条路：显式调用 `reveal()`，全仓只有真正发 HTTP 请求的那一行会调它。
 */
import {
  type ArtifactDigest,
  type Branded,
  type Timestamp,
  brand,
  isArtifactDigest,
  isTimestamp,
} from '@littleq/domain';

import { infraError, type InfraErrorCode } from './errors.js';
import { redactUrlText } from './log/redaction.js';

/**
 * 内部对象引用：就是对象在存储里的 key 本身，不是 URL、也不是可猜测的对外标识。
 *
 * 允许 key 与 ref 同形，是因为 §6.2 要求 `head(ref)` / `deletePrefix(prefix)` 能在不额外
 * 维护一张 ref→key 索引的前提下工作；而 key 的语法（`artifacts/{hash}/chunks/{n}-{hash}`、
 * `originals/{projectId}/{revisionId}`）只含哈希与内部 id，不含凭据，所以它同时满足裁定里
 * 「日志可以带 internal objectId」这一条。
 */
export type ObjectRef = Branded<string, 'ObjectRef'>;

export const OBJECT_REF_MAX_LENGTH = 512;

/** 首字符必须是字母数字，因此排除了 `//host` 与 `/abs/path` 两种 URL/绝对路径形状。 */
const OBJECT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,511}$/;

export function isObjectRef(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= OBJECT_REF_MAX_LENGTH &&
    OBJECT_REF_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.endsWith('/')
  );
}

/**
 * 形状不对的 ref 一律抛 `OBJECT_NOT_FOUND`（对外映射成无细节的 404）。
 *
 * 这里**故意**不区分「不存在」和「格式非法」：ZLQ-201 裁定一要求未授权直读在对外表现上
 * 是一个统一的、不带细节的 404，攻击者不能靠错误码差异枚举出哪些 key 存在。
 */
export function parseObjectRef(value: string): ObjectRef {
  if (!isObjectRef(value)) throw infraError('OBJECT_NOT_FOUND');
  return brand<string, 'ObjectRef'>(value);
}

/** 闭区间字节范围，`start` 与 `endInclusive` 都是 0 起的绝对偏移。 */
export interface ByteRange {
  readonly start: number;
  readonly endInclusive: number;
}

export function byteRangeLength(range: ByteRange): number {
  return range.endInclusive - range.start + 1;
}

export function parseByteRange(start: number, endInclusive: number): ByteRange {
  if (!Number.isSafeInteger(start) || start < 0) throw infraError('GRANT_BUDGET_OUT_OF_RANGE');
  if (!Number.isSafeInteger(endInclusive) || endInclusive < start) {
    throw infraError('GRANT_BUDGET_OUT_OF_RANGE');
  }
  return { start, endInclusive };
}

/**
 * 一次私有读取的结果：流 + 这次读取的**契约形状**。
 *
 * `byteLength` 是这次读取承诺交出的字节数（Range 读取时是 range 的长度，不是整个对象的
 * 大小），预算判定一律以它为准；`sha256` 只在整对象读取时非 null —— 分片读取的摘要没有
 * 意义，产物级摘要由固化清单（见 `artifact-sealer`）承载。
 */
export interface StoredObjectStream {
  readonly ref: ObjectRef;
  readonly byteLength: number;
  readonly contentType: string;
  readonly sha256: ArtifactDigest | null;
  readonly range: ByteRange | null;
  /**
   * 单次消费的字节流。超出 `getPrivate` 的 `maxBytes` 时以 `OBJECT_READ_BUDGET_EXCEEDED`
   * 结束，而不是静默截断：截断会让 Runtime 把一个残缺产物当成完整的固化下来。
   */
  readonly body: ReadableStream<Uint8Array>;
  /** 已经真正交给调用方的字节数；正常读完后等于 `byteLength`。 */
  readonly deliveredBytes: () => number;
}

/** 对象的不可变元数据；`head` 在对象不存在时返回 `null`，不抛。 */
export interface StoredObjectMetadata {
  readonly ref: ObjectRef;
  readonly byteLength: number;
  readonly contentType: string;
  readonly sha256: ArtifactDigest;
  readonly createdAt: Date;
  /** provider 的 etag 只在内部用于缓存协商，可能为 null；它不是平台对外的标识。 */
  readonly etag: string | null;
}

export const HEALTH_STATUSES = ['ok', 'degraded', 'unavailable'] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export function isHealthStatus(value: string): value is HealthStatus {
  return (HEALTH_STATUSES as readonly string[]).includes(value);
}

/**
 * 健康检查结果。
 *
 * `detail` 只能是一个**错误码**，不能是 provider 的原文消息：provider 的报错里经常带着
 * 请求 URL（含签名 query），把它抄进健康检查就等于把它抄进日志。
 */
export interface HealthResult {
  readonly status: HealthStatus;
  readonly checkedAt: Date;
  readonly latencyMs: number | null;
  readonly detail: InfraErrorCode | null;
}

/** 必须是一个带 scheme 的绝对 URL；相对路径、裸 token、空串都进不来。 */
const SENSITIVE_URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/;

/**
 * 一个「拿到手就是为了发请求、绝不该被打印」的 URL。
 *
 * 平台对外的 grant URL、provider 的 presign URL、Blob 的 `downloadUrl` 都必须包成这个类型
 * 才能在端口之间流动。类型系统因此能替我们回答「这个字符串会不会被顺手塞进日志」：只要参数
 * 类型是 `SensitiveUrl`，`console.log(url)` 就编不过（除非显式 `reveal()`）。
 */
export class SensitiveUrl {
  readonly sensitiveUrl = true as const;

  #raw: string;
  #redacted: string;

  private constructor(raw: string, redacted: string) {
    this.#raw = raw;
    this.#redacted = redacted;
  }

  /** 唯一入口；空串与非 URL 形状（没有 `scheme://`）一律拒绝，token 不能借道这里变成 URL。 */
  static from(raw: string): SensitiveUrl {
    if (!SENSITIVE_URL_PATTERN.test(raw)) throw infraError('SENSITIVE_URL_INVALID');
    return new SensitiveUrl(raw, redactUrlText(raw));
  }

  /** 脱敏形式，可安全进日志与快照。 */
  get redacted(): string {
    return this.#redacted;
  }

  /** 取原文。全仓只允许真正发起 HTTP 请求的那一行调用。 */
  reveal(): string {
    return this.#raw;
  }

  /** 让 `JSON.stringify` 只看到脱敏结果，而不是抛异常或漏原文。 */
  toJSON(): { readonly sensitiveUrl: true; readonly redacted: string } {
    return { sensitiveUrl: true, redacted: this.#redacted };
  }

  toString(): string {
    return this.#redacted;
  }
}

/** `SensitiveUrl.from` 的语义化别名：调用点读到的是「这里在标记一个敏感 URL」。 */
export function markSensitiveUrl(raw: string): SensitiveUrl {
  return SensitiveUrl.from(raw);
}

/**
 * 摘要校验：所有 sha256 都复用 domain 的 `ArtifactDigest`（小写十六进制），不另立类型。
 *
 * `code` 由调用方给，理由与下面的 `parseStoredTimestamp` 完全相同，而且这里的两类调用点
 * 差别更实在：一类校验的是**我们自己刚算出来**的摘要（失败即代码有 bug，对外说什么都不
 * 冤枉），另一类校验的是**从存储里读回来**的摘要 —— 后者失败意味着清单已损坏，对外必须是
 * `ARTIFACT_INCOMPLETE`；沿用上传侧的 `OBJECT_HASH_MISMATCH`（对外 `REQUEST_INVALID`）
 * 会把一次存储损坏说成调用方请求写错了，而那是 400 与「重试也没用」的区别。
 */
export function parseStoredDigest(value: string, code: InfraErrorCode): ArtifactDigest {
  if (!isArtifactDigest(value)) throw infraError(code);
  return brand<string, 'ArtifactDigest'>(value);
}

/**
 * 时间戳校验：同样复用 domain 的 `Timestamp`，但失败时抛 infra 自己的码。
 *
 * 不让 domain 的 `DomainError` 冒出来，是因为调用方（固化清单解析）需要把「存储里的东西
 * 坏了」和「业务规则不满足」区分开：前者对外是 `ARTIFACT_INCOMPLETE`，重试也没用。
 */
export function parseStoredTimestamp(value: string, code: InfraErrorCode): Timestamp {
  if (!isTimestamp(value)) throw infraError(code);
  return brand<string, 'Timestamp'>(value);
}

/**
 * 时间戳算术。全仓只有两处需要它 —— grant 的 `expiresAt` 与任务租约的 `leaseUntil` ——
 * 但两处的失败语义必须一致：算出一个非法 ISO 串，等于把「过期判定」建在坏数据上，
 * 那比拒绝这次操作危险得多，所以这里宁可抛也不夹紧。
 *
 * `code` 由调用方给：同一个「时间算不出来」在 grant 层是 `GRANT_TTL_OUT_OF_RANGE`，
 * 在别的层就该是别的码，本函数不替调用方决定对外说什么。
 */
export function shiftTimestamp(value: Timestamp, seconds: number, code: InfraErrorCode): Timestamp {
  if (!Number.isSafeInteger(seconds)) throw infraError(code);
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) throw infraError(code);
  return parseStoredTimestamp(new Date(millis + seconds * 1000).toISOString(), code);
}

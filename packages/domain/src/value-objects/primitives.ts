import { DomainError } from '../errors/domain-error.js';
import { brand, type Branded } from './brand.js';

/**
 * 跨聚合复用的原始值对象。
 *
 * 全部是「已校验的不可透明标量」：类型层阻止裸 `string`/`number` 混入，
 * 运行时校验集中在 parse 函数里，序列化仍是原始标量，因此快照与 API 输出
 * 不需要任何适配。
 */

const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SLUG_PATTERN = /^[a-z0-9-]{3,80}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const E_TAG_PATTERN = /^"rev-(?:0|[1-9][0-9]*)"$/;
// 控制字符**就是** no-control-regex 要拦的东西：这里的字符类是「拒绝把不可见字符
// 带进自由文本」的判据本身，不是误写。说明写在上面一行，指令必须紧贴被禁的那行。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

/**
 * 乐观并发版本号。用十进制**字符串**而不是 number：`revision bigint` 经 JSON
 * 会丢精度，而它同时要充当 ETag 的比较基准。
 */
export type Revision = Branded<string, 'Revision'>;

export function isRevision(value: string): boolean {
  return DECIMAL_PATTERN.test(value);
}

export function parseRevision(value: string): Revision {
  if (!isRevision(value)) throw DomainError.invalid('Revision');
  return brand<string, 'Revision'>(value);
}

export function formatRevision(value: bigint | number): Revision {
  if (typeof value === 'number' && (!Number.isInteger(value) || value < 0)) {
    throw DomainError.invalid('Revision');
  }
  if (typeof value === 'bigint' && value < 0n) throw DomainError.invalid('Revision');
  return brand<string, 'Revision'>(value.toString());
}

export function nextRevision(current: Revision): Revision {
  return formatRevision(BigInt(current) + 1n);
}

export function compareRevisions(left: Revision, right: Revision): -1 | 0 | 1 {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 强校验 ETag，形如 `"rev-<Revision>"`（含字面双引号）。
 * 弱校验值（`W/"…"`）不是本设计的一部分，直接拒绝。
 */
export type ETag = Branded<string, 'ETag'>;

export function formatETag(revision: Revision): ETag {
  return brand<string, 'ETag'>(`"rev-${revision}"`);
}

export function isETag(value: string): boolean {
  return E_TAG_PATTERN.test(value);
}

export function parseETag(value: string): ETag {
  if (!isETag(value)) throw DomainError.invalid('ETag');
  return brand<string, 'ETag'>(value);
}

export function revisionFromETag(etag: ETag): Revision {
  return parseRevision(etag.slice('"rev-'.length, -1));
}

/** If-Match 不匹配统一映射 `REVISION_CONFLICT`。 */
export function etagMatches(etag: ETag, revision: Revision): boolean {
  return etag === formatETag(revision);
}

/**
 * UTC RFC3339 时间戳。允许 1–6 位小数秒（数据库是微秒精度），但要求以 `Z`
 * 结尾且日历字段真实存在 —— 领域内一律 UTC，不做时区换算。
 */
export type Timestamp = Branded<string, 'Timestamp'>;

type TimestampParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  fraction: string;
};

function timestampParts(value: string): TimestampParts | null {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;
  return {
    year: match[1] ?? '',
    month: match[2] ?? '',
    day: match[3] ?? '',
    hour: match[4] ?? '',
    minute: match[5] ?? '',
    second: match[6] ?? '',
    fraction: match[7] ?? '',
  };
}

function timestampMillis(parts: TimestampParts): string {
  return parts.fraction.padEnd(3, '0').slice(0, 3);
}

export function isTimestamp(value: string): boolean {
  const parts = timestampParts(value);
  if (!parts) return false;
  const canonical =
    `${parts.year}-${parts.month}-${parts.day}T` +
    `${parts.hour}:${parts.minute}:${parts.second}.${timestampMillis(parts)}Z`;
  const parsed = Date.parse(canonical);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString() === canonical;
}

export function parseTimestamp(value: string): Timestamp {
  if (!isTimestamp(value)) throw DomainError.invalid('Timestamp');
  return brand<string, 'Timestamp'>(value);
}

/** 定宽排序键：把小数秒补齐到 6 位后，字典序即时间序。 */
export function timestampSortKey(value: Timestamp): string {
  const parts = timestampParts(value);
  if (!parts) throw DomainError.invalid('Timestamp');
  return `${value.slice(0, 19)}.${parts.fraction.padEnd(6, '0')}Z`;
}

export function compareTimestamps(left: Timestamp, right: Timestamp): -1 | 0 | 1 {
  const a = timestampSortKey(left);
  const b = timestampSortKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isBefore(left: Timestamp, right: Timestamp): boolean {
  return compareTimestamps(left, right) < 0;
}

/**
 * 只用于派生策略时刻（例如 30 天恢复窗口）；输出固定为毫秒精度 UTC。
 * 全程使用 `Date.UTC` / `toISOString`，不读宿主时区、不走 locale 格式化。
 */
export function plusDaysUtc(value: Timestamp, days: number): Timestamp {
  if (!Number.isInteger(days)) throw DomainError.invalid('Timestamp');
  const parts = timestampParts(value);
  if (!parts) throw DomainError.invalid('Timestamp');
  const base = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    Number(timestampMillis(parts)),
  );
  return parseTimestamp(new Date(base + days * 86_400_000).toISOString());
}

/** 不透明分页游标：base64url，排序键编码在内部，对外不泄露 SQL offset。 */
export type Cursor = Branded<string, 'Cursor'>;

export function isCursor(value: string): boolean {
  return BASE64URL_PATTERN.test(value);
}

export function parseCursor(value: string): Cursor {
  if (!isCursor(value)) throw DomainError.invalid('Cursor');
  return brand<string, 'Cursor'>(value);
}

/** 公开作品 slug。 */
export type Slug = Branded<string, 'Slug'>;

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function parseSlug(value: string): Slug {
  if (!isSlug(value)) throw DomainError.invalid('Slug');
  return brand<string, 'Slug'>(value);
}

/** 单安装唯一登录名；唯一性按 `lower(login_name)` 判定（ZLQ-153 §4.3）。 */
export type LoginName = Branded<string, 'LoginName'>;

export const LOGIN_NAME_MAX_LENGTH = 64;
export const NICKNAME_MAX_LENGTH = 64;
export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

function isBoundedText(value: string, max: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= max &&
    !hasControlCharacter(value) &&
    value.trim().length > 0
  );
}

export function isLoginName(value: string): boolean {
  return isBoundedText(value, LOGIN_NAME_MAX_LENGTH);
}

export function parseLoginName(value: string): LoginName {
  if (!isLoginName(value)) throw DomainError.invalid('LoginName');
  return brand<string, 'LoginName'>(value);
}

/** `toLowerCase()` 由 ECMAScript 规范定义，与宿主 locale 无关。 */
export function loginNameKey(value: LoginName): string {
  return value.toLowerCase();
}

/** 学生只需昵称，不存真实姓名。 */
export type Nickname = Branded<string, 'Nickname'>;

export function isNickname(value: string): boolean {
  return isBoundedText(value, NICKNAME_MAX_LENGTH);
}

export function parseNickname(value: string): Nickname {
  if (!isNickname(value)) throw DomainError.invalid('Nickname');
  return brand<string, 'Nickname'>(value);
}

/**
 * 幂等键：16–128 个 ASCII 字符，`^[A-Za-z0-9._:-]+$`。
 * turn / publish 必填；唯一约束是 `(actor, project, key)`。
 */
export type IdempotencyKey = Branded<string, 'IdempotencyKey'>;

export function isIdempotencyKey(value: string): boolean {
  return (
    value.length >= IDEMPOTENCY_KEY_MIN_LENGTH &&
    value.length <= IDEMPOTENCY_KEY_MAX_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(value)
  );
}

export function parseIdempotencyKey(value: string): IdempotencyKey {
  if (!isIdempotencyKey(value)) throw DomainError.invalid('IdempotencyKey');
  return brand<string, 'IdempotencyKey'>(value);
}

/** 完整包 hash（sha256 十六进制小写）；publication 的 content_hash 同形。 */
export type ArtifactDigest = Branded<string, 'ArtifactDigest'>;

export function isArtifactDigest(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function parseArtifactDigest(value: string): ArtifactDigest {
  if (!isArtifactDigest(value)) throw DomainError.invalid('ArtifactDigest');
  return brand<string, 'ArtifactDigest'>(value);
}

/** 作品契约版本，例如 `1.0.0`。 */
export type ContractVersion = Branded<string, 'ContractVersion'>;

export function isContractVersion(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function parseContractVersion(value: string): ContractVersion {
  if (!isContractVersion(value)) throw DomainError.invalid('ContractVersion');
  return brand<string, 'ContractVersion'>(value);
}

/** 项目内版本序号，`(project_id, sequence)` 唯一，从 1 开始。 */
export type VersionSequence = Branded<number, 'VersionSequence'>;

export function isVersionSequence(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

export function parseVersionSequence(value: number): VersionSequence {
  if (!isVersionSequence(value)) throw DomainError.invalid('VersionSequence');
  return brand<number, 'VersionSequence'>(value);
}

/** 任务进度 0–100，仅作提示，不作为完成依据。 */
export type Progress = Branded<number, 'Progress'>;

export function isProgress(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

export function parseProgress(value: number): Progress {
  if (!isProgress(value)) throw DomainError.invalid('Progress');
  return brand<number, 'Progress'>(value);
}

/**
 * 不可透明口令摘要。Argon2id 的计算在 adapter 侧，domain 只保存摘要本身，
 * 因此这里没有格式校验 —— 任何格式假设都会把算法泄漏进领域层。
 */
export type PasswordDigest = Branded<string, 'PasswordDigest'>;

export function opaquePasswordDigest(value: string): PasswordDigest {
  if (value.length === 0) throw DomainError.invalid('PasswordDigest');
  return brand<string, 'PasswordDigest'>(value);
}

/** 批改分数：非负整数；满分由 rubric 决定，rubric 的物理 JSON 属于 infra。 */
export type Score = Branded<number, 'Score'>;

export function parseScore(value: number): Score {
  if (!Number.isInteger(value) || value < 0) throw DomainError.invalid('Score');
  return brand<number, 'Score'>(value);
}

/** 激励积分：非负整数。 */
export type Points = Branded<number, 'Points'>;

export function parsePoints(value: number): Points {
  if (!Number.isInteger(value) || value < 0) throw DomainError.invalid('Points');
  return brand<number, 'Points'>(value);
}

/** 成长等级：正整数。 */
export type GrowthLevel = Branded<number, 'GrowthLevel'>;

export function parseGrowthLevel(value: number): GrowthLevel {
  if (!Number.isInteger(value) || value < 1) throw DomainError.invalid('GrowthLevel');
  return brand<number, 'GrowthLevel'>(value);
}

/** 作业截止时间；「逾期」是独立派生 flag，不塞进状态枚举。与 `Timestamp` 同构。 */
export type DueAt = Timestamp;

export function parseDueAt(value: string): DueAt {
  return parseTimestamp(value);
}

/**
 * 有界文本值对象的工厂。
 *
 * 各聚合的显示文本（小组名、项目标题、批改反馈、操作备注、学生 prompt）长度上限
 * 都由传输契约固定，领域侧复用同一套校验：非空、长度闭区间、不含控制字符、
 * 不是纯空白。拒绝控制字符不是为了美观 —— 它挡住把换行/回车塞进单行字段从而
 * 伪造日志或 SSE 帧的做法（ZLQ-153 §7.5）。
 */
export type TextValueObject<Name extends string> = {
  readonly name: Name;
  readonly minLength: number;
  readonly maxLength: number;
  readonly is: (value: string) => boolean;
  readonly parse: (value: string) => Branded<string, Name>;
};

export function textValueObject<Name extends string>(
  name: Name,
  minLength: number,
  maxLength: number,
): TextValueObject<Name> {
  if (
    !Number.isInteger(minLength) ||
    !Number.isInteger(maxLength) ||
    minLength < 1 ||
    maxLength < minLength
  ) {
    throw new Error(`invalid text value object bounds: ${name} ${minLength}..${maxLength}`);
  }
  const is = (value: string): boolean =>
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength &&
    !hasControlCharacter(value) &&
    value.trim().length > 0;
  return {
    name,
    minLength,
    maxLength,
    is,
    parse: (value: string) => {
      if (!is(value)) throw DomainError.invalid(name);
      return brand<string, Name>(value);
    },
  };
}

/**
 * 有界整数值对象的工厂：闭区间 `[min, max]`，只接受 JS 安全整数。
 * 用于 memberLimit、attempt、fileCount、totalBytes 这类计数与量值。
 */
export type IntegerValueObject<Name extends string> = {
  readonly name: Name;
  readonly min: number;
  readonly max: number;
  readonly is: (value: number) => boolean;
  readonly parse: (value: number) => Branded<number, Name>;
};

export function integerValueObject<Name extends string>(
  name: Name,
  min: number,
  max: number,
): IntegerValueObject<Name> {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new Error(`invalid integer value object bounds: ${name} ${min}..${max}`);
  }
  const is = (value: number): boolean =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  return {
    name,
    min,
    max,
    is,
    parse: (value: number) => {
      if (!is(value)) throw DomainError.invalid(name);
      return brand<number, Name>(value);
    },
  };
}

/** 安全整数上限；超出它的计数一律视为契约错误，不接受「大约对」。 */
export const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

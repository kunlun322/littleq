/**
 * 行 ↔ domain 编解码器（`apps/api` 侧）。
 *
 * ## ⚠️ 这是 `packages/infra/src/sql/rows.ts` 的**部分重述**，不是复用
 *
 * infra 的 barrel 只导出端口与驱动，`sql/rows.ts` 与 `sql/*-rows.ts` 都不在导出面上
 * （`packages/infra/package.json` 的 `exports` 只有 `.` 与 `./env`）。本单不改 F1 交出来的
 * 任何文件，所以「把 `bigint` 读成字符串还是 number」「`bytea` 该传 `Buffer` 还是
 * `Uint8Array`」这三条转换事实只能在这里再写一遍。
 *
 * **由此产生的风险已申报给 PM／架构师**：同一份编解码规则现在存在于两处，一处改了另一处
 * 不会红。干净的修法是 infra 增加一个 `./sql-rows` 子路径导出（属于 D0 级的 `package.json`
 * 修订，不在本单文件面内）。在那之前，本文件的每个函数都**逐字对齐** infra 版本的语义，
 * 并且只保留本单用得到的子集 —— 少一份代码就少一处漂移面。
 *
 * 三条不可协商的转换事实（与 infra 同）：
 * 1. `bigint` / `int8` 读回来是**十进制字符串**，`revision` 因此全程不经过 double。
 * 2. 写 `bytea` 必须传 `Buffer`；裸 `Uint8Array` 会被序列化成 `{"0":12,…}`。
 * 3. `timestamptz` 存微秒、JS `Date` 只有毫秒 ⇒ 写入前归一到恰好 3 位小数，保证 round-trip 恒等。
 */
import {
  DomainError,
  parseRevision,
  parseTimestamp,
  type Revision,
  type Timestamp,
} from '@littleq/domain';
import { infraError } from '@littleq/infra';

/** 写 `timestamptz` 前把小数位归一到恰好 3 位（`toISOString()` 恒为 3 位）。 */
export function toTimestamptz(value: Timestamp): string {
  return new Date(Date.parse(value)).toISOString();
}

export function toNullableTimestamptz(value: Timestamp | null): string | null {
  return value === null ? null : toTimestamptz(value);
}

export function fromTimestamptz(value: unknown): Timestamp {
  if (value instanceof Date) return checkedTimestamp(value.toISOString());
  if (typeof value === 'string') return checkedTimestamp(toTimestamptz(checkedTimestamp(value)));
  throw infraError('STORED_ROW_INCONSISTENT');
}

export function fromNullableTimestamptz(value: unknown): Timestamp | null {
  return value === null || value === undefined ? null : fromTimestamptz(value);
}

function checkedTimestamp(value: string): Timestamp {
  try {
    return parseTimestamp(value);
  } catch {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
}

/** `bigint` → JS number。只用于语义上必然远小于 2^53 的计数列；`revision` 不走这里。 */
export function fromBigintColumn(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw infraError('STORED_ROW_INCONSISTENT');
  return parsed;
}

export function fromNullableBigintColumn(value: unknown): number | null {
  return value === null || value === undefined ? null : fromBigintColumn(value);
}

/** `bigint` → `bigint`。`task_events.sequence` 在 domain 里就是 `bigint`，不绕道 number。 */
export function fromBigIntColumn(value: unknown): bigint {
  try {
    return typeof value === 'bigint' ? value : BigInt(String(value));
  } catch {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
}

export function fromTextColumn(value: unknown): string {
  if (typeof value !== 'string') throw infraError('STORED_ROW_INCONSISTENT');
  return value;
}

export function fromNullableTextColumn(value: unknown): string | null {
  return value === null || value === undefined ? null : fromTextColumn(value);
}

export function fromBooleanColumn(value: unknown): boolean {
  if (typeof value !== 'boolean') throw infraError('STORED_ROW_INCONSISTENT');
  return value;
}

export function toBytea(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

export function fromBytea(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw infraError('STORED_ROW_INCONSISTENT');
  return new Uint8Array(value);
}

/**
 * `bigint` 在 JSON 里无法表达（`JSON.stringify(1n)` 抛 `TypeError`），而 `TaskEvent.sequence`
 * 在 domain 里就是 `bigint` ⇒ 入库前转十进制字符串，读回时 `createTaskEvent` 接受 `bigint | string`。
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) result[key] = jsonSafe(source[key]);
    return result;
  }
  return value;
}

/** 写 `jsonb` 的参数形态：**已序列化的字符串**，SQL 侧一律带 `::jsonb` 显式转换。 */
export function toJsonb(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

export function fromJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  return value as Record<string, unknown>;
}

/** 读回一个存成 `jsonb` 的**字符串标量**（例如 `task_private.input_ref` 的 `objectRef`）。 */
export function fromJsonString(value: unknown): string {
  if (typeof value !== 'string') throw infraError('STORED_ROW_INCONSISTENT');
  return value;
}

/**
 * §3.1 的一致性检查：派生列必须与 payload 重建出的实体一致。
 *
 * 不一致不是「以哪个为准」的选择题：派生列是唯一索引与 CAS `WHERE` 的依据，payload 是权威值，
 * 两者分叉说明有人绕过仓储写过库 —— 继续跑就会拿错的 `revision` 去 CAS。
 */
export function assertColumnMatches(derived: unknown, authoritative: unknown): void {
  if (derived !== authoritative) throw infraError('STORED_ROW_INCONSISTENT');
}

const DECIMAL_TEXT_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export function fromRevisionColumn(value: unknown): Revision {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  if (text === null || !DECIMAL_TEXT_PATTERN.test(text)) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  try {
    return parseRevision(text);
  } catch {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
}

/**
 * §3.2 对 `users` / `projects` / `ai_tasks` 都写了 `revision bigint CHECK (revision > 0)`，
 * 而 domain 的实体工厂把 `revision` 默认成 `'0'` ⇒ 写入边界必须大声拒绝，不静默改成 `'1'`
 * （那会让调用方手里的实体与库里的行从此不同，接着拿 `'0'` 去做一次永远失败的 409 CAS）。
 */
export function assertPersistableRevision(revision: Revision, field: string): void {
  if (revision === '0') throw DomainError.invalid(field);
}

import {
  DomainError,
  parseRevision,
  parseTimestamp,
  type Revision,
  type Timestamp,
} from '@littleq/domain';

import { infraError } from '../errors.js';

/**
 * 行 ↔ domain 之间的编解码。
 *
 * ## 为什么需要这一层，而不是每个仓储自己 `row.foo as string`
 *
 * ZLQ-216 §3.1：「业务实体以完整 domain 形态存 `payload jsonb`，查询/唯一性/并发所需字段
 * 作独立列……独立列从验证后的实体派生，仓储读取时检查一致性。」这条规则在每个读点上都是
 * 同一套动作：把列值转回 domain 类型、把 payload 交回构造器、比对两者。复制七遍的结果是
 * 七份**各自略有不同**的转换 —— 而转换的细微差别正是精度丢失与静默截断的藏身处。
 *
 * ## 三个不可协商的转换事实
 *
 * 1. **`bigint` 读回来是字符串。** `node-pg` 对 `int8`（OID 20）默认返回原始十进制字符串，
 *    因为 JS 的 `number` 装不下 int64。这是好事：`revision` 因此全程不经过 double
 *    （§3.1「不能 JS Number 精度丢失」）。代价是必须走 `fromRevisionColumn`，任何一处
 *    `Number(row.revision)` 都会把这条保证悄悄抹掉 —— `fromBigintColumn` 因此显式检查
 *    `Number.isSafeInteger`，宁可在超界时报错也不静默截断。
 * 2. **`bytea` 写进去必须是 `Buffer`。** `node-pg` 的参数序列化只认 `Buffer.isBuffer`；
 *    一个裸 `Uint8Array` 会被 `JSON.stringify` 成 `{"0":12,"1":34,…}` 再写进 bytea 列 ——
 *    写成功、读回来是一串垃圾，密文就这样无声损坏。读回来是 `Buffer`（它本身就是
 *    `Uint8Array` 的子类），但为了不把"驱动恰好返回 Buffer"变成契约，这里一律复制成新的
 *    `Uint8Array`。
 * 3. **`timestamptz` 的精度是微秒，JS `Date` 的是毫秒。** 见 `toTimestamptz`。
 *
 * ## 出错时为什么不带上下文
 *
 * 所有形状不符都抛同一个 `STORED_ROW_INCONSISTENT`，**不带列名、不带读到的值**。列名本来
 * 无害，但 `InfraError` 上没有任何可以塞文本的字段（这是 `errors.ts` 的结构性保证），
 * 而读到的值可能正是 payload 里的原 prompt、provider ID 或密文列 —— 把它抄进异常消息
 * 等于抄进日志，违反 §4.1「不返回连接串、URL、原异常、原响应头」。
 */

/**
 * 写入 `timestamptz` 前把小数位归一到**恰好 3 位**。
 *
 * 不是为了好看，而是为了让「写进去再读回来」得到**逐字相同**的字符串：Postgres 存微秒，
 * `node-pg` 把它解析成 JS `Date`（只有毫秒），`Date.toISOString()` 又恒为 3 位小数。于是
 *
 * - 不归一：`'…T04:05:06Z'` 写进去，读回来是 `'…T04:05:06.000Z'` —— 同一个时刻，两个字符串。
 *   任何拿 `Timestamp` 做相等比较的代码（grant 的过期判定、仓储的一致性检查、`nextRunAt`
 *   的回读）都会认为它变了。
 * - 归一到 3 位：写入与读回都恒为 3 位，round-trip 恒等。
 *
 * **已声明的取舍**：domain 的 `TIMESTAMP_PATTERN` 允许 1–6 位小数，所以一个带微秒的
 * `Timestamp` 在这里会被截断到毫秒（`…06.123456Z` → `…06.123Z`）。要保住微秒就得把列改成
 * `text`，而 §3.2 明确要求「时间用 timestamptz」；截断是有损但**稳定**的（同一输入永远得到
 * 同一输出），而改列类型会让 `next_run_at` 索引与 `ORDER BY` 退化成字符串比较。
 *
 * ## 实现为什么绕道 `Date`，而不是就地拼字符串
 *
 * 归一的目的是**固定小数位数**，而位数的来源有两个：`TIMESTAMP_PATTERN` 允许小数**整体缺省**
 * （`…T00:00:00Z` 合法），也允许 1–6 位。字符串手术要正确处理这两端就得同时处理"有没有小数点"
 * 与"有几位"，第一版正是在这里出错：`replace(/\.(\d+)Z$/, 'Z')` 只替换**匹配上**的部分，
 * 没有小数的输入原样穿过，再拼上 `.000Z` 就得到 `…T00:00:00Z.000Z` —— 一个非法 ISO 串，
 * 于是**每一次** `timestamptz` 写入都失败。
 *
 * 绕道 `Date` 把两端合并成一件事：`toISOString()` **恒为 3 位小数**，且 `TIMESTAMP_PATTERN`
 * 要求末尾 `Z`、不允许时区偏移，所以 `Date.parse` 对任何合法 `Timestamp` 都无歧义且有限。
 */
export function toTimestamptz(value: Timestamp): string {
  return new Date(Date.parse(value)).toISOString();
}

/** `toTimestamptz` 的可空版本。NULL 在 SQL 里是"没有这个时刻"，不能被归一成 epoch。 */
export function toNullableTimestamptz(value: Timestamp | null): string | null {
  return value === null ? null : toTimestamptz(value);
}

/**
 * 读回 `timestamptz`。
 *
 * 同时接受 `Date` 与字符串：`node-pg` 与 Neon 的 serverless 驱动都返回 `Date`，但一次
 * `::text` 显式转换、或某个替身驱动，会给字符串。两条路都归一到 3 位小数，所以
 * `fromTimestamptz(toTimestamptz(t)) === t`（毫秒精度内）对两者都成立。
 */
export function fromTimestamptz(value: unknown): Timestamp {
  if (value instanceof Date) return checkedTimestamp(value.toISOString());
  if (typeof value === 'string') return checkedTimestamp(toTimestamptz(checkedTimestamp(value)));
  throw infraError('STORED_ROW_INCONSISTENT');
}

/**
 * `fromTimestamptz` 的可空版本，只用于列本身 `NULL` 的场合。
 *
 * 两个读编解码器的入参都是 `unknown`，所以**类型系统不会拦住把它们用错方向**：
 * `fromNullableTimestamptz(entity.updatedAt)` 编译得过、跑起来也"对"（它内部会调
 * `toTimestamptz` 归一），代价是写路径上报出来的异常码是读侧的那一个，而且 `NOT NULL`
 * 列配可空编解码器会让"库里是 NULL"这种不可能状态看起来是被处理过的。选编解码器的判据
 * 只有一条：**参数是从 `row` 来的就用 `from*`，是要进 SQL 的就用 `to*`**；可空与否照抄
 * §3.2 那一列的 `NULL` / `NOT NULL`，不照抄实体的可选性。
 */
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

/**
 * `bigint` 列 → JS number。
 *
 * 只用于**语义上必然远小于 2^53** 的计数列（字节数、数量、序号）。`revision` 不走这里 ——
 * 它的整个意义就在于可以超过安全整数，所以走 `fromRevisionColumn`。
 */
export function fromBigintColumn(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw infraError('STORED_ROW_INCONSISTENT');
  return parsed;
}

export function fromNullableBigintColumn(value: unknown): number | null {
  return value === null || value === undefined ? null : fromBigintColumn(value);
}

/** `bigint` 列 → `bigint`。`task_events.sequence` 在 domain 里就是 `bigint`，不绕道 number。 */
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

/** 写 `bytea`：必须是 `Buffer`，理由见文件头的事实 2。 */
export function toBytea(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

/**
 * `toBytea` 的可空版本。
 *
 * NULL 在这里有语义，不是"没值"：`owner_secrets_cipher_shape` 要求 `configured=false` 时
 * 四个密文列**全部**为 NULL —— 撤销即销毁。把 `null` 编成空 `Buffer` 会写进去一个零长度的
 * `bytea`，CHECK 判定它 `IS NOT NULL` 于是撤销写不进去；即便 CHECK 放宽了，读回来也是
 * `assertCipherShape` 的 `SECRET_DECRYPT_FAILED`，而正确的答案是 `SECRET_REVOKED`。
 */
export function toNullableBytea(value: Uint8Array | null): Buffer | null {
  return value === null ? null : toBytea(value);
}

export function fromBytea(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw infraError('STORED_ROW_INCONSISTENT');
  return new Uint8Array(value);
}

export function fromNullableBytea(value: unknown): Uint8Array | null {
  return value === null || value === undefined ? null : fromBytea(value);
}

/**
 * 十六进制摘要 ↔ `bytea`。
 *
 * §3.2 把 `account_sessions.token_hash`、`object_read_grants.token_hash`、
 * `preview_tickets.token_hash` 三列都定为 `bytea`，而既有代码里这三个值一律是
 * sha256 的 64 位十六进制**字符串**（`hashGrantToken`、`hashTicketToken`）。
 * 解码成 32 字节入库是无损可逆的，所以列类型照 §3.2 走，转换只发生在这两个函数里。
 *
 * `fromHexBytea` 严格校验长度与字符集：一个 31 字节或含大写的列值说明有人绕过仓储
 * 改过库，那是行损坏，报 `STORED_ROW_INCONSISTENT`，不能悄悄补零或转小写当成正常值
 * —— 补出来的十六进制串与当初写进去的不是同一个 token 摘要，读路径会永远找不到它。
 */
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

export function toHexBytea(hex: string): Buffer {
  if (!HEX_64_PATTERN.test(hex)) throw infraError('STORED_ROW_INCONSISTENT');
  return Buffer.from(hex, 'hex');
}

export function fromHexBytea(value: unknown): string {
  const bytes = fromBytea(value);
  if (bytes.length !== 32) throw infraError('STORED_ROW_INCONSISTENT');
  const hex = Buffer.from(bytes).toString('hex');
  if (!HEX_64_PATTERN.test(hex)) throw infraError('STORED_ROW_INCONSISTENT');
  return hex;
}

/**
 * 写 `jsonb` 前把值变成 JSON 能表达的形状。
 *
 * 唯一需要处理的是 `bigint`：`JSON.stringify(1n)` 直接抛 `TypeError`，而
 * `TaskEvent.sequence` 在 domain 里就是 `bigint`。转成十进制字符串是安全的，因为读回时
 * `createTaskEvent` 接受 `bigint | string`。
 *
 * 其余 branded 值在运行时**就是**普通 string/number（`Branded` 只是类型层的标记），
 * 所以不需要逐字段拆包 —— 这也是 §3.1「以完整 domain 形态存 payload」能成立的前提。
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

/**
 * 写 `jsonb` 的参数形态：**已序列化的字符串**，SQL 侧一律带 `::jsonb` 显式转换。
 *
 * 不依赖 `node-pg` 「对象会被自动 `JSON.stringify`」这条便利行为，有两个理由：
 * 1. 那条行为对 `bigint` 直接抛 `TypeError`，而 `TaskEvent.sequence`、`ScanCheckpoint`
 *    的游标字段都可能是 bigint —— 先过 `jsonSafe` 再自己 stringify，写入路径就与驱动
 *    的便利行为无关，Neon serverless 驱动与 `pg` 得到**逐字相同**的参数。
 * 2. `::jsonb` 让参数类型在任何上下文里都是 jsonb。裸 `$1` 的类型由 PG 从上下文推断，
 *    一旦某条语句把它放进 `COALESCE` 或比较表达式里，推断结果会变成 text，
 *    报错信息是「column is of type jsonb but expression is of type text」——
 *    一个与业务无关、却要读半天才能定位的失败。
 */
export function toJsonb(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

export function toNullableJsonb(value: unknown): string | null {
  return value === null || value === undefined ? null : toJsonb(value);
}

/** 读回 `jsonb` 并要求它是一个对象（不是数组、不是标量、不是 null）。 */
export function fromJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  return value as Record<string, unknown>;
}

export function fromJsonArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw infraError('STORED_ROW_INCONSISTENT');
  return value;
}

/**
 * 读回一个存成 `jsonb` 的**字符串标量**。
 *
 * §3.2 把 `object_ref` 定为 `jsonb`，而 `ObjectRef` 在 infra 里是一个 branded string，
 * 所以入库形态是 JSON 字符串（`"artifacts/ab/…"`），`pg` 读回来就是 JS `string`。
 * 用 `fromJsonObject` 读它会抛"不是对象"，而真正的信息是"这行不是我们写的形状"。
 */
export function fromJsonString(value: unknown): string {
  if (typeof value !== 'string') throw infraError('STORED_ROW_INCONSISTENT');
  return value;
}

/**
 * §3.1 的一致性检查：派生列必须与 payload 重建出的实体一致。
 *
 * 不一致不是"以哪个为准"的选择题，而是一个必须停下来的事实：派生列是唯一索引与 CAS 的
 * `WHERE` 依据，payload 是权威值；两者分叉说明有人绕过仓储写过库，继续跑就会拿错的
 * `revision` 去做 CAS，把一个已经推进过的任务当旧版本覆盖掉。
 */
export function assertColumnMatches(derived: unknown, authoritative: unknown): void {
  if (derived !== authoritative) throw infraError('STORED_ROW_INCONSISTENT');
}

/**
 * `Revision` 列（`bigint`）→ domain 的十进制字符串。
 *
 * 刻意**不**走 `fromBigintColumn`：那个函数会把值变成 JS `number`，而 `revision` 的全部意义
 * 就在于它可以超过 `Number.MAX_SAFE_INTEGER`。这里只校验形状，再交给 domain 的
 * `parseRevision` 做真正的验证 —— 验证失败同样是"这行不是我们写的"。
 */
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
 * 插入前判定 `revision` 是否可落库 —— §3.2 对 `users` / `projects` / `ai_tasks` 三张表都写了
 * `revision bigint CHECK (revision > 0)`，而 domain 的**每一个**实体工厂都把 `revision`
 * 默认成 `'0'`（`entities/*.ts` 里九处 `parseRevision('0')`）。
 *
 * 两边都不是 F1 能改的：§3.2 的 DDL 是逐字冻结的规格，`packages/domain/src/entities/**`
 * 不在 §10.2 给本单的文件面里。所以这条冲突只能在**写入边界**上和解，而和解方式只有
 * "大声拒绝"这一种是安全的：
 *
 * - **不静默改成 `'1'`。** 那会让调用方手里的实体（`revision: '0'`）与库里的行
 *   （`revision: 1`）从此不同，而调用方接下来必然拿 `'0'` 去做 CAS 的 `expectedRevision`
 *   —— 一次永远失败的 409，且看起来像并发冲突。
 * - **不放给数据库 CHECK 去拦。** 那样得到的是一个 SQLSTATE 23514 与一句
 *   `check constraint "…" of relation "…" failed`，既没有域名也不指向字段，而真正的信息是
 *   "调用方构造实体时漏传了 revision"。
 *
 * 抛 `DomainError.invalid` 而不是 `InfraError`：这是领域不变量（与 `assertVersionInsertable`
 * 同理），事实源在 domain；用 infra 的码会把"用例的 bug"与"库坏了"在日志里混成一种。
 *
 * ⚠️ 这是一处**已申报的规格冲突**（见 ZLQ-220 交付评论）：干净的修法要么是让 domain 的
 * 默认值变成 `'1'`，要么是把 §3.2 的 CHECK 放宽到 `>= 0`，两者都要架构师裁定。
 */
export function assertPersistableRevision(revision: Revision, field: string): void {
  if (revision === '0') throw DomainError.invalid(field);
}

/**
 * UUIDv7 生成器。
 *
 * ## 为什么 infra 里会长出一个 ID 生成器
 *
 * ZLQ-216 §3.2 逐字要求「ID 用现有 UUIDv7 生成器」，但**仓库里并不存在**这么一个生成器：
 * `packages/domain/src/value-objects/identifiers.ts` 只有 `UUID_V7_PATTERN` /
 * `isUuidV7` / `parseUuidV7` / `uuidV7Parser` 与 18 个 `parse*Id`，全部是**校验**，
 * 没有一个字节是**产生**。基线之前不需要它 —— 所有 ID 都来自测试夹具
 * （`packages/infra/test/support.ts` 的 `uuidAt(index)`）。F1 是第一次要往真表里
 * `INSERT` 一行新客户数据，于是生成器必须存在。
 *
 * PostgreSQL 17 也没有内置 `uuidv7()`（那是 PG18 的函数），所以不能把这件事推给数据库。
 *
 * 这处与工单前提的偏离在交付说明里单列。
 *
 * ## 放在 infra 而不是 domain 的理由
 *
 * 依赖图规则 `domain-no-platform-sdk` 与 `domain-and-application-no-drivers` 都在守同一件事：
 * domain 是纯决策层。一个读系统熵源（`node:crypto` 的 `randomFillSync`）、结果不可复现的
 * 函数是**平台能力**，不是领域判据；domain 该继续只做"这个字符串是不是合法 UUIDv7"。
 * 生成器与校验器分居两层，正是既有分工的延续。
 *
 * ## 布局（RFC 9562 §5.7）
 *
 * ```text
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                         unix_ts_ms (48 bit)                     |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |          unix_ts_ms           |  ver  |       rand_a          |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |var|                        rand_b                             |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                            rand_b                             |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * ```
 *
 * 时间戳占高 48 位，所以按字符串排序 == 按创建时刻排序 —— `ai_tasks` 的
 * `(next_run_at, id)` 索引与 `projects` 的 `(owner_student_id, updated_at DESC, id)`
 * 索引在 `id` 这一列上都能得到稳定的插入序，不需要额外的序列列。
 */
import { randomFillSync } from 'node:crypto';

import { parseUuidV7, type UuidV7 } from '@littleq/domain';

const UUID_BYTE_LENGTH = 16;
/**
 * 版本号与变体位所在的字节下标，各自成常量。
 *
 * 这两个下标**差 2 而不是差 1**：连字符把 16 字节切成 8-4-4-4-12，于是版本半字节落在
 * 第 3 组的第一个字符（byte 6 的高 4 位），而变体的两个位落在第 4 组的第一个字符
 * （byte 8 的高 2 位）。写成 7 会得到一个"约 1/4 概率合法"的生成器 —— 每次调用独立掷骰，
 * 大部分失败但偶尔通过，是最难查的那种错。所以两个下标都写成有名字的常量，而不是
 * 散在位运算里的魔数。
 */
const UUID_V7_VERSION_BYTE_INDEX = 6;
const UUID_V7_VARIANT_BYTE_INDEX = 8;
const UUID_V7_VERSION_NIBBLE = 0x70;
const UUID_VARIANT_RFC4122_MASK = 0x3f;
const UUID_VARIANT_RFC4122_BITS = 0x80;
/** `Date.now()` 的上界：2^48 - 1 毫秒（公元 10889 年）。超出即视为时钟异常，不静默截断。 */
const MAX_UNIX_TS_MS = 2 ** 48 - 1;

/**
 * 产生一个 UUIDv7 字符串（小写、带连字符），并用 domain 的 `parseUuidV7` 回验一次。
 *
 * 回验不是防御性冗余：它是"生成器与校验器不会各自漂移"的**执行期**证明。若哪天有人改了
 * `UUID_V7_PATTERN`（例如要求 rand_a 单调），生成器会立刻抛错，而不是开始产出会被
 * `parse*Id` 拒绝、却在 `INSERT` 时通过 `uuid` 列类型的值 —— 那种不一致要等到读回时才炸。
 */
export function newUuidV7(now: number = Date.now()): UuidV7 {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_UNIX_TS_MS) {
    throw new RangeError('newUuidV7: now must be a non-negative safe integer within 48 bits');
  }
  const bytes = new Uint8Array(UUID_BYTE_LENGTH);
  randomFillSync(bytes);

  // 48-bit 大端时间戳覆盖前 6 字节（随机位被无条件丢弃，不做"保留熵"的把戏）。
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // 版本：byte 6 高 4 位写死 7，低 4 位保留 rand_a 的熵。
  bytes[UUID_V7_VERSION_BYTE_INDEX] =
    ((bytes[UUID_V7_VERSION_BYTE_INDEX] ?? 0) & 0x0f) | UUID_V7_VERSION_NIBBLE;
  // 变体：byte 8 高 2 位写死 10，低 6 位保留 rand_b 的熵。
  bytes[UUID_V7_VARIANT_BYTE_INDEX] =
    ((bytes[UUID_V7_VARIANT_BYTE_INDEX] ?? 0) & UUID_VARIANT_RFC4122_MASK) |
    UUID_VARIANT_RFC4122_BITS;

  const hex = Buffer.from(bytes).toString('hex');
  return parseUuidV7(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * 取出一个 UUIDv7 里编码的毫秒时间戳。
 *
 * 给测试用：断言"这一行的 ID 是在这个时刻附近生成的"，比断言字符串前缀更能说明布局正确。
 */
export function unixTsMsOfUuidV7(value: UuidV7): number {
  const hex = value.replaceAll('-', '');
  return Number.parseInt(hex.slice(0, 12), 16);
}

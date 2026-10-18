import { DomainError, type ErrorCode } from '../src/index.js';

/**
 * 领域测试的共享夹具。
 *
 * 这里的每一个值都是**写死的字面量，或由字面量确定性派生**，没有一个来自宿主状态
 * （当前时间、环境变量、时区、`node_modules`、平台差异）。附录 A G6 明确禁止把宿主
 * 相关的中间值当作期望值来源 —— 那样写出来的测试在本机绿、在 ubuntu 上红，而红灯的
 * 原因与被测代码无关。
 *
 * 时间原点是固定的：所有"多久之后"都相对 `EPOCH` 计算，`Date#toISOString()` 输出
 * UTC，因此与运行测试的机器时区无关。
 */

/** 测试用的固定时间原点。 */
export const EPOCH = '2026-03-01T00:00:00.000Z';

const EPOCH_MS = Date.parse(EPOCH);

/** 原点之后 `seconds` 秒的 UTC RFC3339 时间戳。 */
export function atSeconds(seconds: number): string {
  return new Date(EPOCH_MS + seconds * 1000).toISOString();
}

/** 原点之后 `days` 天的 UTC RFC3339 时间戳。 */
export function atDays(days: number): string {
  return atSeconds(days * 86_400);
}

/**
 * 形状合法的 UUIDv7：第 13 位是版本号 `7`，第 17 位是变体 `8`。
 *
 * 只有前 48 位随 `index` 变化，因此同一批夹具 ID 在任何宿主上逐字节相同。
 */
export function uuidAt(index: number): string {
  return `0190f3a4-b5c6-7d7e-8f90-${index.toString(16).padStart(12, '0')}`;
}

/** 64 位小写十六进制的 SHA-256 形状串。 */
export function digestAt(index: number): string {
  return index.toString(16).padStart(64, '0');
}

/** 满足 `^[A-Za-z0-9._:-]+$` 且长度落在 16–128 的幂等键。 */
export function idempotencyKeyAt(index: number): string {
  return `idem-key-${index.toString().padStart(10, '0')}`;
}

/** 64 位十六进制的请求哈希。 */
export function requestHashAt(index: number): string {
  return `a${index.toString(16).padStart(63, '0')}`;
}

/**
 * 执行 `fn`，取出它抛出的 `DomainError` 本体。
 *
 * 不用 `expect(fn).toThrow(...)` 是因为这里要断言的是**错误码与 valueObject**而不是
 * 消息文本：消息里带不带原文属于 §7.5 的脱敏要求，由 `thrownMessage` 单独检查。抛出
 * 的不是 `DomainError`（例如 `RangeError`）时原样重抛，避免把类型错误误读成断言失败。
 */
export function thrownDomainError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('期望抛出 DomainError，但调用正常返回了');
}

/** `thrownDomainError` 的错误码快捷方式。 */
export function thrownCode(fn: () => unknown): ErrorCode {
  return thrownDomainError(fn).code;
}

/** 执行 `fn`，取出它抛出的错误的 `message`（用于脱敏断言）。 */
export function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('期望抛出错误，但调用正常返回了');
}

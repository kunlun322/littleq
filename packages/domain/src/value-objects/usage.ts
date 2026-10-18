import { DomainError } from '../errors/domain-error.js';
import {
  integerValueObject,
  parseTimestamp,
  textValueObject,
  type Timestamp,
} from './primitives.js';
import { stringEnum } from './enum.js';
import { brand, type Branded } from './brand.js';
import type { TaskKind } from './task.js';

/**
 * Usage 聚合的值对象（ZLQ-153 §4.6 / 附录 A §6.1、§6.6）。
 *
 * 行锁、事务、provider report 解析与唯一 `event_key` 的**实现**属于 infra；
 * domain 只持有能力、周期、单位、预留状态与结算不变量。
 */

/**
 * 可计量的能力。
 *
 * 与 `TaskKind` 不是一对一：`PUBLISH` / `RESCAN` 只作用于已提交的不可变版本，
 * 不产生新的计量消耗（架构 §6.6「额度为零只阻断新的 AI task；……发布已有版本、
 * 批改和浏览不受影响」），因此 `capabilityOfTaskKind` 对它们返回 `null`。
 */
export const CAPABILITIES = ['QCA_TASK', 'IMAGE_GENERATION', 'TTS', 'STT'] as const;
export type Capability = (typeof CAPABILITIES)[number];
const capabilityEnum = stringEnum<Capability>('Capability', CAPABILITIES);
export const isCapability = capabilityEnum.is;
export const parseCapability = capabilityEnum.parse;

export const USAGE_PERIODS = ['DAILY', 'MONTHLY'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
const usagePeriodEnum = stringEnum<UsagePeriod>('UsagePeriod', USAGE_PERIODS);
export const isUsagePeriod = usagePeriodEnum.is;
export const parseUsagePeriod = usagePeriodEnum.parse;

/**
 * 计量单位按 provider 的计费维度取，一个能力对应一个单位。
 * `CREDIT` 是 QCA 的归一化额度；其余三项分别是图片张数、字符数与秒数。
 */
export const USAGE_UNITS = ['CREDIT', 'IMAGE', 'CHARACTER', 'SECOND'] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];
const usageUnitEnum = stringEnum<UsageUnit>('UsageUnit', USAGE_UNITS);
export const isUsageUnit = usageUnitEnum.is;
export const parseUsageUnit = usageUnitEnum.parse;

/**
 * 归一化的 provider 标签（`usage_ledger.provider`，架构 §4.6）。
 *
 * 这**不是** Provider 抽象层（附录 A §7.2 明令禁止）：domain 不接受任何 provider
 * SDK、client 或响应体，只接受一个已经归一化的字符串标签，用于把用量归账。
 */
export const USAGE_PROVIDERS = ['QCA', 'BAILIAN'] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];
const usageProviderEnum = stringEnum<UsageProvider>('UsageProvider', USAGE_PROVIDERS);
export const isUsageProvider = usageProviderEnum.is;
export const parseUsageProvider = usageProviderEnum.parse;

export const RESERVATION_STATES = ['HELD', 'COMMITTED', 'RELEASED', 'EXPIRED'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];
const reservationStateEnum = stringEnum<ReservationState>('ReservationState', RESERVATION_STATES);
export const isReservationState = reservationStateEnum.is;
export const parseReservationState = reservationStateEnum.parse;

/** 非 `HELD` 的三个状态都是终态，不可回退（附录 A §6.2）。 */
export const TERMINAL_RESERVATION_STATES = ['COMMITTED', 'RELEASED', 'EXPIRED'] as const;

export function isTerminalReservationState(state: ReservationState): boolean {
  return (TERMINAL_RESERVATION_STATES as readonly string[]).includes(state);
}

const nonNegativeInteger = integerValueObject('UsageQuantity', 0, Number.MAX_SAFE_INTEGER);

export type UsageQuantity = Branded<number, 'UsageQuantity'>;
export type Credits = Branded<number, 'Credits'>;
export type DurationMs = Branded<number, 'DurationMs'>;

export function parseUsageQuantity(value: number): UsageQuantity {
  return nonNegativeInteger.parse(value);
}

export function parseCredits(value: number): Credits {
  if (!Number.isSafeInteger(value) || value < 0) throw DomainError.invalid('Credits');
  return brand<number, 'Credits'>(value);
}

export function parseDurationMs(value: number): DurationMs {
  if (!Number.isSafeInteger(value) || value < 0) throw DomainError.invalid('DurationMs');
  return brand<number, 'DurationMs'>(value);
}

/**
 * `usage_limits.timezone`：IANA 时区名。
 *
 * 只做形状校验（`Area/Location`，允许可选的地区后缀），**不解析偏移** ——
 * 偏移随夏令时变化，而且查表要用 `Intl`，那是宿主相关的（附录 A G6）。
 * 真正的偏移由调用方作为 `TimezoneOffsetMinutes` 显式传入。
 */
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9+_./-]*(?:\/[A-Za-z0-9+._-]+)+$/;

export type Timezone = Branded<string, 'Timezone'>;

export function isTimezone(value: string): boolean {
  return typeof value === 'string' && value.length <= 64 && TIMEZONE_PATTERN.test(value);
}

export function parseTimezone(value: string): Timezone {
  if (!isTimezone(value)) throw DomainError.invalid('Timezone');
  return brand<string, 'Timezone'>(value);
}

/** 由调用方解析出的 UTC 偏移（分钟），范围覆盖现实中的 -12:00..+14:00。 */
export type TimezoneOffsetMinutes = Branded<number, 'TimezoneOffsetMinutes'>;

export function parseTimezoneOffsetMinutes(value: number): TimezoneOffsetMinutes {
  if (!Number.isSafeInteger(value) || value < -840 || value > 840) {
    throw DomainError.invalid('TimezoneOffsetMinutes');
  }
  return brand<number, 'TimezoneOffsetMinutes'>(value);
}

/**
 * 用量周期的账期键。
 *
 * 纯函数：输入是 UTC 时间戳与**显式传入**的偏移分钟数，输出 `YYYY-MM-DD`（DAILY）
 * 或 `YYYY-MM`（MONTHLY）。不读时钟、不读宿主时区、不用 `Intl`，因此同一输入在
 * macOS 与 ubuntu 上给出逐字相同的结果（附录 A G6）。
 */
export function periodKey(
  occurredAt: Timestamp,
  period: UsagePeriod,
  offsetMinutes: TimezoneOffsetMinutes,
): string {
  const local = new Date(Date.parse(occurredAt) + offsetMinutes * 60_000).toISOString();
  return period === 'DAILY' ? local.slice(0, 10) : local.slice(0, 7);
}

/** `usage_ledger.event_key`：全局唯一，由调用方按确定性规则生成。 */
export const LEDGER_EVENT_KEY_MAX_LENGTH = 128;
const ledgerEventKeyValue = textValueObject('LedgerEventKey', 1, LEDGER_EVENT_KEY_MAX_LENGTH);
export type LedgerEventKey = ReturnType<typeof ledgerEventKeyValue.parse>;
export const isLedgerEventKey = ledgerEventKeyValue.is;
export const parseLedgerEventKey = ledgerEventKeyValue.parse;

const CAPABILITY_BY_TASK_KIND: Readonly<Record<TaskKind, Capability | null>> = {
  VIBE_TURN: 'QCA_TASK',
  BAILIAN_IMAGE: 'IMAGE_GENERATION',
  TTS: 'TTS',
  STT: 'STT',
  PUBLISH: null,
  RESCAN: null,
};

/** 该任务是否计量；`null` 表示不产生用量，因而不受额度为零的阻断。 */
export function capabilityOfTaskKind(kind: TaskKind): Capability | null {
  return CAPABILITY_BY_TASK_KIND[kind];
}

const UNIT_BY_CAPABILITY: Readonly<Record<Capability, UsageUnit>> = {
  QCA_TASK: 'CREDIT',
  IMAGE_GENERATION: 'IMAGE',
  TTS: 'CHARACTER',
  STT: 'SECOND',
};

export function unitOfCapability(capability: Capability): UsageUnit {
  return UNIT_BY_CAPABILITY[capability];
}

const PROVIDER_BY_CAPABILITY: Readonly<Record<Capability, UsageProvider>> = {
  QCA_TASK: 'QCA',
  IMAGE_GENERATION: 'BAILIAN',
  TTS: 'BAILIAN',
  STT: 'BAILIAN',
};

export function providerOfCapability(capability: Capability): UsageProvider {
  return PROVIDER_BY_CAPABILITY[capability];
}

/**
 * 预留过期时刻：`expires_at` 由调用方给出的时限决定，domain 不硬编码时长，
 * 但要保证它落在任务硬超时之后 —— 否则预留会在任务还活着的时候被回收，
 * 造成同一笔消耗被记两次。
 */
export function assertReservationOutlivesTask(
  expiresAt: Timestamp,
  hardDeadlineAt: Timestamp,
): void {
  if (Date.parse(expiresAt) < Date.parse(parseTimestamp(hardDeadlineAt))) {
    throw new Error('UsageReservation.expiresAt must not precede the task hard deadline');
  }
}

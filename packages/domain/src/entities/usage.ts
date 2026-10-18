/**
 * Usage 聚合（附录 A §6.1、§6.3 `usage_*`、§6.6 用量规则）。
 *
 * domain 侧持有：limit、period、capability、reservation/ledger 的状态与结算不变量。
 * 行锁、事务边界、provider report 解析、`event_key` 唯一性的**实现**都在 infra
 * （§6.3 右栏）—— 但 `eventKey` 与 reservation 的 `taskId` 唯一是领域事实，
 * 这里以"不可变且构造期必填"的方式表达：一条没有 eventKey 的 ledger 无法存在。
 *
 * §6.6 的结算语义在这里落成三个互斥出口：
 * - 成功 → `COMMITTED`，并按实际量**释放差额**；
 * - 取消或未调用 provider → `RELEASED`；
 * - 过期 → `EXPIRED`。
 * 三者都是终态，终态不可回退（§6.2）。
 *
 * 「调用已发生即写 ledger，即使任务失败」是一条容易被实现漏掉的规则：
 * `commitUsage` 因此接受任何 `actualQuantity`（含 0），并**不检查 task 是否成功** ——
 * 失败任务的消耗同样要入账，否则额度会被无声地退回。
 */

import { DomainError } from '../errors/domain-error.js';
import { RESERVATION_TRANSITIONS } from '../states/machines.js';
import { assertTransition } from '../states/transition.js';
import {
  parseUsageLedgerEntryId,
  parseUsageLimitId,
  parseUsageReservationId,
  parseTaskId,
  parseUserId,
  type TaskId,
  type UsageLedgerEntryId,
  type UsageLimitId,
  type UsageReservationId,
  type UserId,
} from '../value-objects/identifiers.js';
import {
  isBefore,
  nextRevision,
  parseRevision,
  parseTimestamp,
  type Revision,
  type Timestamp,
} from '../value-objects/primitives.js';
import {
  parseCapability,
  parseLedgerEventKey,
  parseReservationState,
  parseUsagePeriod,
  parseUsageProvider,
  parseUsageQuantity,
  parseTimezone,
  unitOfCapability,
  type Capability,
  type LedgerEventKey,
  type ReservationState,
  type Timezone,
  type UsagePeriod,
  type UsageProvider,
  type UsageQuantity,
  type UsageUnit,
} from '../value-objects/usage.js';
import {
  parseCredits,
  parseDurationMs,
  parseModelId,
  type Credits,
  type DurationMs,
  type ModelId,
} from '../value-objects/index.js';

export type UsageLimit = {
  readonly id: UsageLimitId;
  readonly subjectUserId: UserId;
  readonly capability: Capability;
  readonly period: UsagePeriod;
  readonly limitUnits: UsageQuantity;
  readonly timezone: Timezone;
  readonly enabled: boolean;
  readonly revision: Revision;
  readonly updatedAt: Timestamp;
};

export function createUsageLimit(input: {
  readonly id: string;
  readonly subjectUserId: string;
  readonly capability: string;
  readonly period: string;
  readonly limitUnits: number;
  readonly timezone: string;
  readonly enabled?: boolean;
  readonly revision?: string;
  readonly updatedAt: string;
}): UsageLimit {
  return {
    id: parseUsageLimitId(input.id),
    subjectUserId: parseUserId(input.subjectUserId),
    capability: parseCapability(input.capability),
    period: parseUsagePeriod(input.period),
    limitUnits: parseUsageQuantity(input.limitUnits),
    timezone: parseTimezone(input.timezone),
    enabled: input.enabled ?? true,
    revision: input.revision === undefined ? parseRevision('0') : parseRevision(input.revision),
    updatedAt: parseTimestamp(input.updatedAt),
  };
}

/**
 * 改额度。`enabled=false` 与 `limitUnits=0` 语义不同：前者是"这条限制不生效"，
 * 后者是"额度用尽/被设为零"，两者都只阻断新的 AI task（§6.6），但 UI 文案不同，
 * 所以不能合并成一个布尔值。
 */
export function updateUsageLimit(
  limit: UsageLimit,
  input: { readonly limitUnits: number; readonly enabled: boolean; readonly updatedAt: string },
): UsageLimit {
  if (typeof input.enabled !== 'boolean') throw DomainError.invalid('UsageLimit.enabled');
  return {
    ...limit,
    limitUnits: parseUsageQuantity(input.limitUnits),
    enabled: input.enabled,
    revision: nextRevision(limit.revision),
    updatedAt: parseTimestamp(input.updatedAt),
  };
}

export type UsageReservation = {
  readonly id: UsageReservationId;
  /** 一个 task 至多一条 reservation（架构 §4.4 唯一约束）。 */
  readonly taskId: TaskId;
  readonly subjectUserId: UserId;
  readonly capability: Capability;
  readonly reservedUnits: UsageQuantity;
  readonly state: ReservationState;
  readonly expiresAt: Timestamp;
};

export function createUsageReservation(input: {
  readonly id: string;
  readonly taskId: string;
  readonly subjectUserId: string;
  readonly capability: string;
  readonly reservedUnits: number;
  readonly state?: string;
  readonly expiresAt: string;
}): UsageReservation {
  return {
    id: parseUsageReservationId(input.id),
    taskId: parseTaskId(input.taskId),
    subjectUserId: parseUserId(input.subjectUserId),
    capability: parseCapability(input.capability),
    reservedUnits: parseUsageQuantity(input.reservedUnits),
    state: input.state === undefined ? 'HELD' : parseReservationState(input.state),
    expiresAt: parseTimestamp(input.expiresAt),
  };
}

/**
 * 提交：按**实际量**结算，差额自动释放（§6.6）。
 *
 * `actualUnits` 大于预留量是允许的 —— 生成过程中途才知道真实消耗，
 * 此时账本记实际值，预留的"欠额"由 `settlementDelta` 显式返回给 application，
 * 让它决定是否要在同一事务里追加一次额度检查。domain 不偷偷截断到预留量：
 * 那会让账本与真实消耗不符。
 */
export function commitUsage(reservation: UsageReservation, actualUnits: number): UsageReservation {
  parseUsageQuantity(actualUnits);
  return toReservationState(reservation, 'COMMITTED');
}

/** 释放：取消或从未调用 provider（§6.6）。 */
export function releaseUsage(reservation: UsageReservation): UsageReservation {
  return toReservationState(reservation, 'RELEASED');
}

/** 过期：预留到期仍未结算。终态，不可回退。 */
export function expireUsage(reservation: UsageReservation, now: Timestamp): UsageReservation {
  if (!isReservationExpired(reservation, now))
    throw DomainError.invalid('UsageReservation.expiresAt');
  return toReservationState(reservation, 'EXPIRED');
}

function toReservationState(
  reservation: UsageReservation,
  state: ReservationState,
): UsageReservation {
  assertTransition(RESERVATION_TRANSITIONS, reservation.state, state, 'REQUEST_INVALID');
  return { ...reservation, state };
}

/**
 * 结算差额：正数表示预留多了、要退回；负数表示实际消耗超过预留。
 * `COMMITTED` 之后才有意义，其余状态一律为 0（预留原样退回或尚未发生）。
 */
export function settlementDelta(reservation: UsageReservation, actualUnits: number): number {
  const actual = parseUsageQuantity(actualUnits);
  if (reservation.state !== 'COMMITTED') return 0;
  return reservation.reservedUnits - actual;
}

export function isReservationActive(reservation: UsageReservation): boolean {
  return reservation.state === 'HELD';
}

export function isReservationExpired(reservation: UsageReservation, now: Timestamp): boolean {
  return !isBefore(parseTimestamp(now), reservation.expiresAt);
}

export type UsageLedgerEntry = {
  readonly id: UsageLedgerEntryId;
  /** 全局唯一（架构 §4.4）。缺失就无法保证幂等重放不重复入账。 */
  readonly eventKey: LedgerEventKey;
  readonly taskId: TaskId | null;
  readonly subjectUserId: UserId;
  readonly capability: Capability;
  readonly quantity: UsageQuantity;
  readonly unit: UsageUnit;
  readonly provider: UsageProvider;
  readonly modelId: ModelId | null;
  readonly estimatedCredits: Credits | null;
  readonly providerReportedCredits: Credits | null;
  readonly durationMs: DurationMs | null;
  readonly occurredAt: Timestamp;
};

/**
 * 账本行是**追加写、不可变**的：本文件没有任何修改既有 ledger 的入口。
 *
 * `unit` 不来自入参而由 `capability` 派生（`unitOfCapability`）：同一 capability
 * 在账本上出现两种量纲会让 §6.6 的"按实际量结算"无法比对。
 */
export function createUsageLedgerEntry(input: {
  readonly id: string;
  readonly eventKey: string;
  readonly taskId?: string | null;
  readonly subjectUserId: string;
  readonly capability: string;
  readonly quantity: number;
  readonly provider: string;
  readonly modelId?: string | null;
  readonly estimatedCredits?: number | null;
  readonly providerReportedCredits?: number | null;
  readonly durationMs?: number | null;
  readonly occurredAt: string;
}): UsageLedgerEntry {
  const capability = parseCapability(input.capability);
  const estimatedCredits = input.estimatedCredits ?? null;
  const reportedCredits = input.providerReportedCredits ?? null;
  const durationMs = input.durationMs ?? null;
  const modelId = input.modelId ?? null;
  return {
    id: parseUsageLedgerEntryId(input.id),
    eventKey: parseLedgerEventKey(input.eventKey),
    taskId: input.taskId === null || input.taskId === undefined ? null : parseTaskId(input.taskId),
    subjectUserId: parseUserId(input.subjectUserId),
    capability,
    quantity: parseUsageQuantity(input.quantity),
    unit: unitOfCapability(capability),
    provider: parseUsageProvider(input.provider),
    modelId: modelId === null ? null : parseModelId(modelId),
    estimatedCredits: estimatedCredits === null ? null : parseCredits(estimatedCredits),
    providerReportedCredits: reportedCredits === null ? null : parseCredits(reportedCredits),
    durationMs: durationMs === null ? null : parseDurationMs(durationMs),
    occurredAt: parseTimestamp(input.occurredAt),
  };
}

/**
 * 账本行的量纲一致性。`providerReportedCredits` 与 `estimatedCredits` 可以同时存在
 * （估算值 + provider 实报值），但 `durationMs` 只对按时长计量的 capability 有意义。
 * 越界不抛错而是返回 false：这是一条**审计**判定，调用方要能记录不一致而不是中断入账
 * —— §6.6「调用已发生即写 ledger」优先于账本的整洁。
 */
export function isLedgerEntryCoherent(entry: UsageLedgerEntry): boolean {
  if (entry.unit !== unitOfCapability(entry.capability)) return false;
  if (entry.durationMs !== null && entry.unit !== 'SECOND') return false;
  return true;
}

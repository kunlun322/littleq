import {
  DomainError,
  createUsageLedgerEntry,
  createUsageReservation,
  isReservationActive,
  type UsageLedgerEntry,
  type UsageReservation,
} from '@littleq/domain';

import {
  assertColumnMatches,
  fromBigintColumn,
  fromJsonObject,
  fromNullableBigintColumn,
  fromNullableTextColumn,
  fromTimestamptz,
  toJsonb,
  toTimestamptz,
} from './rows.js';

/**
 * `usage_reservations` / `usage_ledger` 的编解码与结算 SQL —— ZLQ-216 §3.5 的
 * `reservations` 句柄。
 *
 * ## 「不能在版本提交失败后单独完成结算」是怎么变成结构的
 *
 * §3.5 逐字：「`reserve/settle` 使用现有用量实体与判据；task＋结算阶段唯一键，
 * 重复同事实幂等，**不能在版本提交失败后单独完成结算**。」最后半句不是靠调用方自觉，
 * 而是靠**这两个方法只接受 `DatabaseTransaction`**：本文件导出的 SQL 常量没有任何一条
 * 能脱离事务执行，`TaskTransaction.reservations` 也只在 `TaskUnitOfWork.run` 的回调里
 * 拿得到。于是"版本回滚了、额度却扣了"这件事在类型上就无从表达。
 *
 * ## 两张表、两个唯一键，各管一件事
 *
 * - `usage_reservations` 的 `UNIQUE (task_id, capability)` 管**预留不重复**：同一个 task
 *   的同一能力只能占一份额度。它是 §3.5「task＋结算阶段唯一键」的前半。
 * - `usage_ledger` 的 `UNIQUE (event_key)` 管**账目不重复**：同一次结算事实只记一行。
 *   它是后半，也是"重复同事实幂等"的落点 —— 重入的提交事务再调一次 `settle`，
 *   `ON CONFLICT DO NOTHING` 让第二行写不进去，而**不报错**：报错会让重入变成失败，
 *   §5.2 的 `COMMITTING` 可重入就名存实亡。
 */

export const USAGE_RESERVATION_COLUMNS = `id, task_id, owner_student_id, capability,
  reserved_units, state, expires_at, payload`;

export type UsageReservationRow = {
  readonly id: string;
  readonly task_id: string;
  readonly owner_student_id: string;
  readonly capability: string;
  readonly reserved_units: unknown;
  readonly state: string;
  readonly expires_at: unknown;
  readonly payload: unknown;
};

export function reservationFromRow(row: UsageReservationRow): UsageReservation {
  const reservation = createUsageReservation(
    fromJsonObject(row.payload) as Parameters<typeof createUsageReservation>[0],
  );
  assertColumnMatches(row.id, reservation.id);
  assertColumnMatches(row.task_id, reservation.taskId);
  assertColumnMatches(row.owner_student_id, reservation.subjectUserId);
  assertColumnMatches(row.capability, reservation.capability);
  assertColumnMatches(fromBigintColumn(row.reserved_units), reservation.reservedUnits);
  assertColumnMatches(row.state, reservation.state);
  assertColumnMatches(fromTimestamptz(row.expires_at), reservation.expiresAt);
  return reservation;
}

export const USAGE_RESERVATION_INSERT_SQL = `
INSERT INTO usage_reservations(
  id, task_id, owner_student_id, capability, reserved_units, state, expires_at, payload
) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
ON CONFLICT (task_id, capability) DO NOTHING`;

export function reservationInsertParams(reservation: UsageReservation): readonly unknown[] {
  return [
    reservation.id,
    reservation.taskId,
    reservation.subjectUserId,
    reservation.capability,
    reservation.reservedUnits,
    reservation.state,
    // `expires_at` 是 `NOT NULL`（§3.2），实体侧也不可空，所以走非空的写编解码器。
    toTimestamptz(reservation.expiresAt),
    toJsonb(reservation),
  ];
}

export const USAGE_RESERVATION_SELECT_BY_TASK_SQL = `
SELECT ${USAGE_RESERVATION_COLUMNS} FROM usage_reservations
WHERE task_id = $1 AND capability = $2`;

/** 结算写状态：`WHERE id AND task_id`，两个键都给，避免只按 id 写时误伤别的 task 的行。 */
export const USAGE_RESERVATION_SETTLE_SQL = `
UPDATE usage_reservations SET state = $3, payload = $4::jsonb
WHERE id = $1 AND task_id = $2`;

export const USAGE_LEDGER_COLUMNS = `id, event_key, task_id, owner_student_id, capability,
  quantity, unit, provider, model_id, estimated_credits, provider_reported_credits,
  duration_ms, occurred_at, payload`;

export type UsageLedgerRow = {
  readonly id: string;
  readonly event_key: string;
  readonly task_id: string | null;
  readonly owner_student_id: string;
  readonly capability: string;
  readonly quantity: unknown;
  readonly unit: string;
  readonly provider: string;
  readonly model_id: string | null;
  readonly estimated_credits: unknown;
  readonly provider_reported_credits: unknown;
  readonly duration_ms: unknown;
  readonly occurred_at: unknown;
  readonly payload: unknown;
};

export function ledgerFromRow(row: UsageLedgerRow): UsageLedgerEntry {
  const entry = createUsageLedgerEntry(
    fromJsonObject(row.payload) as Parameters<typeof createUsageLedgerEntry>[0],
  );
  assertColumnMatches(row.id, entry.id);
  assertColumnMatches(row.event_key, entry.eventKey);
  assertColumnMatches(row.task_id, entry.taskId);
  assertColumnMatches(row.owner_student_id, entry.subjectUserId);
  assertColumnMatches(row.capability, entry.capability);
  assertColumnMatches(fromBigintColumn(row.quantity), entry.quantity);
  // `unit` 不是入参，是 domain 从 `capability` 派生的（`unitOfCapability`）。列与实体
  // 都比一遍：列错说明有人绕过仓储写过，实体错说明派生表变了 —— 两种都要在读出来时炸。
  assertColumnMatches(row.unit, entry.unit);
  assertColumnMatches(row.provider, entry.provider);
  assertColumnMatches(fromNullableTextColumn(row.model_id), entry.modelId);
  assertColumnMatches(fromNullableBigintColumn(row.estimated_credits), entry.estimatedCredits);
  assertColumnMatches(
    fromNullableBigintColumn(row.provider_reported_credits),
    entry.providerReportedCredits,
  );
  assertColumnMatches(fromNullableBigintColumn(row.duration_ms), entry.durationMs);
  assertColumnMatches(fromTimestamptz(row.occurred_at), entry.occurredAt);
  return entry;
}

export const USAGE_LEDGER_INSERT_SQL = `
INSERT INTO usage_ledger(
  id, event_key, task_id, owner_student_id, capability, quantity, unit, provider, model_id,
  estimated_credits, provider_reported_credits, duration_ms, occurred_at, payload
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::jsonb
)
ON CONFLICT (event_key) DO NOTHING`;

export function ledgerInsertParams(entry: UsageLedgerEntry): readonly unknown[] {
  return [
    entry.id,
    entry.eventKey,
    entry.taskId,
    entry.subjectUserId,
    entry.capability,
    entry.quantity,
    entry.unit,
    entry.provider,
    entry.modelId,
    entry.estimatedCredits,
    entry.providerReportedCredits,
    entry.durationMs,
    toTimestamptz(entry.occurredAt),
    toJsonb(entry),
  ];
}

export const USAGE_LEDGER_SELECT_BY_EVENT_KEY_SQL = `
SELECT ${USAGE_LEDGER_COLUMNS} FROM usage_ledger WHERE event_key = $1`;

/**
 * 结算前置判定：**只有 `COMMITTED` 的预留能结算**。
 *
 * 三种非法输入各对应一个真实后果，所以这里不给"宽容"留口子：
 *
 * - `HELD`（还是 `isReservationActive`）—— 尚未结算。此时写账本，等真正的结算到来时
 *   `event_key` 已被占用，第二次 `ON CONFLICT DO NOTHING` 静默丢弃，于是**记进账本的
 *   是那个还没发生的量**。
 * - `RELEASED` —— 从未调用 provider，没有消耗可记。
 * - `EXPIRED` —— 同上，而且它是终态（`TERMINAL_RESERVATION_STATES`），不可回退。
 *
 * 判据用 domain 的 `isReservationActive` 而不是自己写 `state === 'HELD'`：状态的语义
 * 归属在 domain，这里只补"其余两个终态也不能结算"这一层，因为 domain 没有一个
 * 「可结算」谓词，而新造一个 domain 函数超出本单的文件面。
 */
export function assertSettleable(reservation: UsageReservation): void {
  if (isReservationActive(reservation) || reservation.state !== 'COMMITTED') {
    throw DomainError.invalid('UsageReservation.state');
  }
}

/**
 * 计量列一律走 `fromBigintColumn` / `fromNullableBigintColumn` 再与实体字段比对，
 * 因为 node-pg 把 `bigint`（OID 20）读成十进制**字符串**：直接拿 `'123' === 123` 比
 * 会永远为假，于是每一行都报"损坏"。转换集中在 `rows.ts` 一处，比较式里只看数字。
 */

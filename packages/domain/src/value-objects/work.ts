import { isBefore, plusDaysUtc, type Timestamp } from './primitives.js';
import { stringEnum } from './enum.js';

/**
 * Work 聚合的值对象（ZLQ-153 §4.4 / 附录 A §6.2、§6.3）。
 *
 * 可见性与删除状态是**两个正交维度**：删除不改变可见性，恢复也不改变它。
 * `immutable_key`、`runtime_path`、CSP hashes 与 deny-list 写入属于 infra。
 */

export const VISIBILITIES = ['PRIVATE', 'GROUP', 'PUBLIC'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
const visibilityEnum = stringEnum<Visibility>('Visibility', VISIBILITIES);
export const isVisibility = visibilityEnum.is;
export const parseVisibility = visibilityEnum.parse;

export const WORK_STATUSES = ['ACTIVE', 'DELETED'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
const workStatusEnum = stringEnum<WorkStatus>('WorkStatus', WORK_STATUSES);
export const isWorkStatus = workStatusEnum.is;
export const parseWorkStatus = workStatusEnum.parse;

export const PUBLICATION_STATUSES = ['PREPARING', 'LIVE', 'BLOCKED', 'REVOKED'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
const publicationStatusEnum = stringEnum<PublicationStatus>(
  'PublicationStatus',
  PUBLICATION_STATUSES,
);
export const isPublicationStatus = publicationStatusEnum.is;
export const parsePublicationStatus = publicationStatusEnum.parse;

/** 30 天恢复窗口（附录 A §6.2：`ACTIVE → DELETED`，30 天内 `DELETED → ACTIVE`）。 */
export const WORK_RESTORE_WINDOW_DAYS = 30;

/**
 * 与 `isWithinRestoreWindow` 同判据：半开区间 `[deletedAt, deletedAt + windowDays)`。
 * 可见性与删除状态是两个正交维度，恢复窗口只看后者。
 */
export function isWithinWorkRestoreWindow(
  deletedAt: Timestamp,
  now: Timestamp,
  windowDays = WORK_RESTORE_WINDOW_DAYS,
): boolean {
  if (!Number.isSafeInteger(windowDays) || windowDays < 1) {
    throw new Error(`invalid restore window: ${String(windowDays)}`);
  }
  if (isBefore(now, deletedAt)) return false;
  return isBefore(now, plusDaysUtc(deletedAt, windowDays));
}

/**
 * `GET /public/works/{slug}` 的可服务判定。
 *
 * 不满足时统一 404 + 同一机器码（附录 A §5.3）：不存在、PRIVATE、REVOKED、
 * DELETED 对外不可区分，防止用作品 slug 枚举私有能力与账号状态。
 * 因此这个函数返回布尔值而不返回原因 —— 原因本身就是泄漏面。
 */
export function canServePublicWork(input: {
  readonly visibility: Visibility;
  readonly workStatus: WorkStatus;
  readonly publicationStatus: PublicationStatus;
}): boolean {
  return (
    input.visibility === 'PUBLIC' &&
    input.workStatus === 'ACTIVE' &&
    input.publicationStatus === 'LIVE'
  );
}

/** 发布是否可被撤销：只有正在服务的 publication 才谈得上撤销。 */
export function isRevocablePublication(status: PublicationStatus): boolean {
  return status === 'LIVE';
}

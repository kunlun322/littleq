import { DomainError } from '../errors/domain-error.js';
import {
  integerValueObject,
  isBefore,
  plusDaysUtc,
  textValueObject,
  type Timestamp,
} from './primitives.js';
import { stringEnum } from './enum.js';
import type { ArtifactRef } from './refs.js';

/**
 * Project 聚合的值对象（ZLQ-153 §4.4 / 附录 A §6.1–§6.3）。
 *
 * `manifest_object_key`、物理文件位置与条件唯一索引属于 infra；domain 只持有
 * 不可透明引用与业务结论。回滚**创建新版本**，从不原地改写既有版本。
 */

export const WORK_TYPES = ['GAME', 'WEB', 'ANIMATION', 'PICTURE_BOOK'] as const;
export type WorkType = (typeof WORK_TYPES)[number];
const workTypeEnum = stringEnum<WorkType>('WorkType', WORK_TYPES);
export const isWorkType = workTypeEnum.is;
export const parseWorkType = workTypeEnum.parse;

export const HELP_LEVELS = ['LV1', 'LV2', 'LV3'] as const;
export type HelpLevel = (typeof HELP_LEVELS)[number];
const helpLevelEnum = stringEnum<HelpLevel>('HelpLevel', HELP_LEVELS);
export const isHelpLevel = helpLevelEnum.is;
export const parseHelpLevel = helpLevelEnum.parse;

export const PROJECT_STATUSES = ['ACTIVE', 'ARCHIVED', 'DELETED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
const projectStatusEnum = stringEnum<ProjectStatus>('ProjectStatus', PROJECT_STATUSES);
export const isProjectStatus = projectStatusEnum.is;
export const parseProjectStatus = projectStatusEnum.parse;

/**
 * `DELETED → deletedFromStatus` 的合法目标（附录 A §6.2）。
 * `DELETED` 自身不在其中：从 `DELETED` 恢复到 `DELETED` 没有意义。
 */
export const RESTORABLE_PROJECT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type RestorableProjectStatus = (typeof RESTORABLE_PROJECT_STATUSES)[number];

export function isRestorableProjectStatus(value: string): value is RestorableProjectStatus {
  return (RESTORABLE_PROJECT_STATUSES as readonly string[]).includes(value);
}

/** 30 天恢复窗口（附录 A §6.2）。 */
export const PROJECT_RESTORE_WINDOW_DAYS = 30;

/**
 * 是否仍在恢复窗口内。`now` 由调用方传入，domain 不读时钟 —— 同一条规则
 * 在任何宿主、任何时区都给出同一结果（附录 A G6）。
 *
 * 窗口是**半开区间** `[deletedAt, deletedAt + windowDays)`：删除那一刻立即可恢复，
 * 到 `deletedAt + 30 天` 这一瞬间起不可恢复。写成 `!isBefore(now, limit)` 会把区间
 * 反过来 —— 变成「窗口过期后才可恢复」，而两个调用方（`restoreProject`、
 * `isProjectRestorable`）都是正向使用它的。
 */
export function isWithinRestoreWindow(
  deletedAt: Timestamp,
  now: Timestamp,
  windowDays = PROJECT_RESTORE_WINDOW_DAYS,
): boolean {
  if (!Number.isSafeInteger(windowDays) || windowDays < 1) {
    throw new Error(`invalid restore window: ${String(windowDays)}`);
  }
  if (isBefore(now, deletedAt)) return false;
  return isBefore(now, plusDaysUtc(deletedAt, windowDays));
}

export const PROJECT_TITLE_MAX_LENGTH = 100;
const projectTitleText = textValueObject('ProjectTitle', 1, PROJECT_TITLE_MAX_LENGTH);
export type ProjectTitle = ReturnType<typeof projectTitleText.parse>;
export const isProjectTitle = projectTitleText.is;
export const parseProjectTitle = projectTitleText.parse;

export const BUILD_STATUSES = ['VALID', 'INVALID'] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];
const buildStatusEnum = stringEnum<BuildStatus>('BuildStatus', BUILD_STATUSES);
export const isBuildStatus = buildStatusEnum.is;
export const parseBuildStatus = buildStatusEnum.parse;

export const SCAN_STATUSES = ['PASS', 'BLOCK', 'CONFIRM_REQUIRED'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
const scanStatusEnum = stringEnum<ScanStatus>('ScanStatus', SCAN_STATUSES);
export const isScanStatus = scanStatusEnum.is;
export const parseScanStatus = scanStatusEnum.parse;

export type FindingCount = ReturnType<typeof findingCountValue.parse>;

const findingCountValue = integerValueObject('FindingCount', 0, Number.MAX_SAFE_INTEGER);

export function parseFindingCount(value: number): FindingCount {
  return findingCountValue.parse(value);
}

/**
 * 扫描结论的**安全摘要**：只有计数与不可透明报告引用。
 *
 * 不携带规则名、消息文本或命中片段 —— 那些可能包含学生代码原文，属于
 * B1–B13 扫描器（后续行）的产物，绝不进入 API 响应或快照。
 */
export type SafeScanSummary = {
  readonly blockedCount: FindingCount;
  readonly warningCount: FindingCount;
  readonly confirmRequiredCount: FindingCount;
  readonly reportRef: ArtifactRef | null;
  readonly scannedAt: Timestamp;
};

export function createSafeScanSummary(input: {
  readonly blockedCount: number;
  readonly warningCount: number;
  readonly confirmRequiredCount: number;
  readonly reportRef: ArtifactRef | null;
  readonly scannedAt: Timestamp;
}): SafeScanSummary {
  return {
    blockedCount: parseFindingCount(input.blockedCount),
    warningCount: parseFindingCount(input.warningCount),
    confirmRequiredCount: parseFindingCount(input.confirmRequiredCount),
    reportRef: input.reportRef,
    scannedAt: input.scannedAt,
  };
}

/**
 * 版本是否可回滚：产物必须构建通过且扫描未被硬拦截（附录 A §5.2
 * `VERSION_NOT_RESTORABLE`）。`CONFIRM_REQUIRED` 允许回滚 —— 它是需要人工确认
 * 的软结论，不是产物不可运行。
 */
export function isRestorableVersion(input: {
  readonly buildStatus: BuildStatus;
  readonly scanStatus: ScanStatus;
}): boolean {
  return input.buildStatus === 'VALID' && input.scanStatus !== 'BLOCK';
}

export function assertRestorableVersion(input: {
  readonly buildStatus: BuildStatus;
  readonly scanStatus: ScanStatus;
}): void {
  if (!isRestorableVersion(input)) throw new DomainError('VERSION_NOT_RESTORABLE');
}

/**
 * 版本是否可预览（`VERSION_NOT_PREVIEWABLE`，422）。
 * 与可回滚同判据：预览跑的是同一份不可变产物。
 */
export function isPreviewableVersion(input: {
  readonly buildStatus: BuildStatus;
  readonly scanStatus: ScanStatus;
}): boolean {
  return isRestorableVersion(input);
}

/**
 * 版本是否可发布（`VERSION_NOT_PUBLISHABLE`，422）。
 * 发布面向公网，比预览更严：`CONFIRM_REQUIRED` 必须先由 Owner 确认，
 * 不能靠发布绕过。
 */
export function isPublishableVersion(input: {
  readonly buildStatus: BuildStatus;
  readonly scanStatus: ScanStatus;
}): boolean {
  return input.buildStatus === 'VALID' && input.scanStatus === 'PASS';
}

export function assertPublishableVersion(input: {
  readonly buildStatus: BuildStatus;
  readonly scanStatus: ScanStatus;
}): void {
  if (!isPublishableVersion(input)) throw new DomainError('VERSION_NOT_PUBLISHABLE');
}

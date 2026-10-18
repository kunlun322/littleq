/**
 * Project 聚合与 ProjectVersion（附录 A §6.1、§6.2、§6.3 `projects/project_versions`）。
 *
 * domain 侧持有：项目字段、状态与恢复元数据、version sequence/DAG、artifact digest、
 * contract/build/scan 结论。`manifest_object_key`、物理文件位置与条件唯一索引属于
 * application/infra（§6.3 右栏），因此这里不出现任何 object key —— 产物位置只以
 * `ArtifactDigest` 这一不可变摘要的形式存在。
 *
 * 回滚的语义是**创建新版本**（§6.3「回滚创建新版本」），不是把指针改回旧版本：
 * version DAG 一旦允许回退，`sequence` 就不再单调，SSE 事件与账本都会失去可比对的
 * 时间轴。所以本文件没有「把 currentVersionId 指回旧版本」的入口。
 */

import { DomainError } from '../errors/domain-error.js';
import { PROJECT_TRANSITIONS } from '../states/machines.js';
import { assertTransition } from '../states/transition.js';
import {
  parseProjectId,
  parseProjectVersionId,
  parseTaskId,
  parseTemplateId,
  parseUserId,
  type ProjectId,
  type ProjectVersionId,
  type TaskId,
  type TemplateId,
  type UserId,
} from '../value-objects/identifiers.js';
import {
  isBefore,
  nextRevision,
  parseArtifactDigest,
  parseContractVersion,
  parseRevision,
  parseTimestamp,
  parseVersionSequence,
  type ArtifactDigest,
  type ContractVersion,
  type Revision,
  type Timestamp,
  type VersionSequence,
} from '../value-objects/primitives.js';
import {
  assertRestorableVersion,
  createSafeScanSummary,
  isWithinRestoreWindow,
  parseAgeBand,
  parseBuildStatus,
  parseHelpLevel,
  parseProjectStatus,
  parseProjectTitle,
  parseScanStatus,
  parseWorkType,
  isRestorableProjectStatus,
  type AgeBand,
  type BuildStatus,
  type HelpLevel,
  type ProjectStatus,
  type ProjectTitle,
  type RestorableProjectStatus,
  type SafeScanSummary,
  type ScanStatus,
  type WorkType,
} from '../value-objects/index.js';
import { parseArtifactRef, type ArtifactRef } from '../value-objects/refs.js';

export type Project = {
  readonly id: ProjectId;
  readonly ownerStudentId: UserId;
  readonly title: ProjectTitle;
  readonly workType: WorkType;
  readonly ageBand: AgeBand;
  readonly helpLevel: HelpLevel;
  readonly templateId: TemplateId | null;
  readonly currentVersionId: ProjectVersionId | null;
  readonly status: ProjectStatus;
  /** 仅 `status === 'DELETED'` 时非 null（§6.2）。 */
  readonly deletedAt: Timestamp | null;
  /** 删除前的状态，恢复的目标；仅 `status === 'DELETED'` 时非 null。 */
  readonly deletedFromStatus: RestorableProjectStatus | null;
  readonly lastOpenedAt: Timestamp | null;
  readonly revision: Revision;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
};

export type ProjectVersion = {
  readonly id: ProjectVersionId;
  readonly projectId: ProjectId;
  readonly sequence: VersionSequence;
  readonly parentVersionId: ProjectVersionId | null;
  readonly sourceTaskId: TaskId | null;
  readonly artifactSha256: ArtifactDigest;
  readonly contractVersion: ContractVersion;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly buildStatus: BuildStatus;
  readonly scanStatus: ScanStatus;
  readonly safeScanSummary: SafeScanSummary | null;
  readonly createdBy: UserId;
  readonly createdAt: Timestamp;
};

export function createProject(input: {
  readonly id: string;
  readonly ownerStudentId: string;
  readonly title: string;
  readonly workType: string;
  readonly ageBand: string;
  readonly helpLevel: string;
  readonly templateId?: string | null;
  readonly currentVersionId?: string | null;
  readonly status?: string;
  readonly deletedAt?: string | null;
  readonly deletedFromStatus?: string | null;
  readonly lastOpenedAt?: string | null;
  readonly revision?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): Project {
  const createdAt = parseTimestamp(input.createdAt);
  const updatedAt = parseTimestamp(input.updatedAt);
  if (isBefore(updatedAt, createdAt)) throw DomainError.invalid('Project.updatedAt');
  const status = input.status === undefined ? 'ACTIVE' : parseProjectStatus(input.status);
  const project: Project = {
    id: parseProjectId(input.id),
    ownerStudentId: parseUserId(input.ownerStudentId),
    title: parseProjectTitle(input.title),
    workType: parseWorkType(input.workType),
    ageBand: parseAgeBand(input.ageBand),
    helpLevel: parseHelpLevel(input.helpLevel),
    templateId:
      input.templateId === null || input.templateId === undefined
        ? null
        : parseTemplateId(input.templateId),
    currentVersionId:
      input.currentVersionId === null || input.currentVersionId === undefined
        ? null
        : parseProjectVersionId(input.currentVersionId),
    status,
    deletedAt:
      input.deletedAt === null || input.deletedAt === undefined
        ? null
        : parseTimestamp(input.deletedAt),
    deletedFromStatus:
      input.deletedFromStatus === null || input.deletedFromStatus === undefined
        ? null
        : parseRestorableProjectStatus(input.deletedFromStatus),
    lastOpenedAt:
      input.lastOpenedAt === null || input.lastOpenedAt === undefined
        ? null
        : parseTimestamp(input.lastOpenedAt),
    revision: input.revision === undefined ? parseRevision('0') : parseRevision(input.revision),
    createdAt,
    updatedAt,
  };
  assertDeletionMetadataCoherent(project);
  return project;
}

/**
 * 删除元数据的互斥不变量：`deletedAt`/`deletedFromStatus` 必须同时出现或同时缺席，
 * 且只在 `DELETED` 状态下出现。
 *
 * §6.3 明确 `projects.deletedFromStatus/deletedAt` 是为冻结 PRD 的归档/30 天恢复语义
 * 补齐的未来数据库契约字段。把它们的一致性写成断言，是为了让下一行的 migration
 * 无法只落一列就通过测试。
 */
function assertDeletionMetadataCoherent(project: Project): void {
  const deleted = project.status === 'DELETED';
  if (
    deleted !== (project.deletedAt !== null) ||
    deleted !== (project.deletedFromStatus !== null)
  ) {
    throw DomainError.invalid('Project.deletedFromStatus');
  }
}

function parseRestorableProjectStatus(value: string): RestorableProjectStatus {
  if (!isRestorableProjectStatus(value)) throw DomainError.invalid('Project.deletedFromStatus');
  return value;
}

export function createProjectVersion(input: {
  readonly id: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly parentVersionId?: string | null;
  readonly sourceTaskId?: string | null;
  readonly artifactSha256: string;
  readonly contractVersion: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly buildStatus: string;
  readonly scanStatus: string;
  readonly safeScanSummary?: {
    readonly blockedCount: number;
    readonly warningCount: number;
    readonly confirmRequiredCount: number;
    readonly reportRef: string | null;
    readonly scannedAt: string;
  } | null;
  readonly createdBy: string;
  readonly createdAt: string;
}): ProjectVersion {
  const summary = input.safeScanSummary ?? null;
  return {
    id: parseProjectVersionId(input.id),
    projectId: parseProjectId(input.projectId),
    sequence: parseVersionSequence(input.sequence),
    parentVersionId:
      input.parentVersionId === null || input.parentVersionId === undefined
        ? null
        : parseProjectVersionId(input.parentVersionId),
    sourceTaskId:
      input.sourceTaskId === null || input.sourceTaskId === undefined
        ? null
        : parseTaskId(input.sourceTaskId),
    artifactSha256: parseArtifactDigest(input.artifactSha256),
    contractVersion: parseContractVersion(input.contractVersion),
    fileCount: parseCount(input.fileCount, 'ProjectVersion.fileCount'),
    totalBytes: parseCount(input.totalBytes, 'ProjectVersion.totalBytes'),
    buildStatus: parseBuildStatus(input.buildStatus),
    scanStatus: parseScanStatus(input.scanStatus),
    safeScanSummary:
      summary === null
        ? null
        : createSafeScanSummary({
            blockedCount: summary.blockedCount,
            warningCount: summary.warningCount,
            confirmRequiredCount: summary.confirmRequiredCount,
            reportRef:
              summary.reportRef === null
                ? null
                : (parseArtifactRef(summary.reportRef) as ArtifactRef),
            scannedAt: parseTimestamp(summary.scannedAt),
          }),
    createdBy: parseUserId(input.createdBy),
    createdAt: parseTimestamp(input.createdAt),
  };
}

function parseCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw DomainError.invalid(name);
  return value;
}

/**
 * `sequence` 在同一项目内单调且唯一，由 infra 的 `(project_id, sequence)` 唯一索引
 * 兜底；domain 侧只保证**新版本一定大于父版本**，否则 DAG 的父子关系与顺序会互相
 * 矛盾，回滚创建的版本可能排在自己祖先之前。
 */
export function nextVersionSequence(parent: ProjectVersion | null): VersionSequence {
  return parseVersionSequence(parent === null ? 1 : parent.sequence + 1);
}

export function assertVersionFollowsParent(
  version: ProjectVersion,
  parent: ProjectVersion | null,
): void {
  if (parent === null) return;
  if (version.sequence <= parent.sequence) throw DomainError.invalid('ProjectVersion.sequence');
  if (version.projectId !== parent.projectId) throw DomainError.invalid('ProjectVersion.projectId');
}

/**
 * 记录扫描结论。构建与扫描都是对**已固定的产物摘要**下结论，
 * 因此写入时不修改 `artifactSha256`：摘要一旦可变，账本与恢复判定都失去依据。
 */
export function recordVersionScan(
  version: ProjectVersion,
  input: {
    readonly buildStatus: string;
    readonly scanStatus: string;
    readonly safeScanSummary?: {
      readonly blockedCount: number;
      readonly warningCount: number;
      readonly confirmRequiredCount: number;
      readonly reportRef: string | null;
      readonly scannedAt: string;
    } | null;
  },
): ProjectVersion {
  const next = createProjectVersion({
    ...version,
    artifactSha256: version.artifactSha256,
    contractVersion: version.contractVersion,
    buildStatus: input.buildStatus,
    scanStatus: input.scanStatus,
    safeScanSummary:
      input.safeScanSummary === undefined ? version.safeScanSummary : input.safeScanSummary,
  });
  if (next.id !== version.id || next.sequence !== version.sequence) {
    throw new Error('recordVersionScan must not change version identity');
  }
  return next;
}

export function archiveProject(project: Project, updatedAt: Timestamp): Project {
  return withProjectStatus(project, 'ARCHIVED', updatedAt);
}

export function reactivateProject(project: Project, updatedAt: Timestamp): Project {
  return withProjectStatus(project, 'ACTIVE', updatedAt);
}

/**
 * 软删除。`deletedFromStatus` 记录**删除前**的状态，恢复时回到它，
 * 这样「归档后被删」不会在恢复时变成一个活跃项目。
 */
export function deleteProject(project: Project, deletedAt: Timestamp): Project {
  assertTransition(PROJECT_TRANSITIONS, project.status, 'DELETED', 'REQUEST_INVALID');
  if (project.status === 'DELETED') throw DomainError.invalid('Project.status');
  const deletedFromStatus = project.status;
  if (!isRestorableProjectStatus(deletedFromStatus))
    throw DomainError.invalid('Project.deletedFromStatus');
  return {
    ...project,
    status: 'DELETED',
    deletedAt: parseTimestamp(deletedAt),
    deletedFromStatus,
    revision: nextRevision(project.revision),
    updatedAt: parseTimestamp(deletedAt),
  };
}

/**
 * 30 天窗口内恢复到 `deletedFromStatus`（§6.2）。
 *
 * `now` 必须由调用方传入：domain 不读时钟，所以同一对时间戳在任何宿主上都给出
 * 同一结论（附录 A G6）。窗口外抛 `RESOURCE_NOT_FOUND` 而不是「已过期」——
 * 与 §5.3「对象存在但不可达时对外统一 404」一致，避免用状态探测删除时间。
 */
export function restoreProject(project: Project, now: Timestamp): Project {
  if (
    project.status !== 'DELETED' ||
    project.deletedAt === null ||
    project.deletedFromStatus === null
  ) {
    throw DomainError.invalid('Project.status');
  }
  if (!isWithinRestoreWindow(project.deletedAt, now)) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Project');
  }
  return {
    ...project,
    status: project.deletedFromStatus,
    deletedAt: null,
    deletedFromStatus: null,
    revision: nextRevision(project.revision),
    updatedAt: now,
  };
}

export function isProjectRestorable(project: Project, now: Timestamp): boolean {
  if (project.status !== 'DELETED' || project.deletedAt === null) return false;
  return isWithinRestoreWindow(project.deletedAt, now);
}

function withProjectStatus(project: Project, status: ProjectStatus, updatedAt: Timestamp): Project {
  assertTransition(PROJECT_TRANSITIONS, project.status, status, 'REQUEST_INVALID');
  if (status === 'DELETED') throw new Error('use deleteProject to keep deletion metadata coherent');
  return {
    ...project,
    status,
    revision: nextRevision(project.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

export function renameProject(project: Project, title: string, updatedAt: Timestamp): Project {
  assertProjectWritable(project);
  return {
    ...project,
    title: parseProjectTitle(title),
    revision: nextRevision(project.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

export function changeHelpLevel(
  project: Project,
  helpLevel: string,
  updatedAt: Timestamp,
): Project {
  assertProjectWritable(project);
  return {
    ...project,
    helpLevel: parseHelpLevel(helpLevel),
    revision: nextRevision(project.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

/**
 * 已删除的项目不接受任何写：它对外表现为不存在（§5.3）。
 * 归档的项目**可以**继续生成回合 —— 归档是「收起来」，不是「封禁」。
 */
export function assertProjectWritable(project: Project): void {
  if (project.status === 'DELETED') throw new DomainError('RESOURCE_NOT_FOUND', 'Project');
}

/**
 * 版本推进：把 `currentVersionId` 指向新创建的版本。
 *
 * 只接受「新版本的 parent 就是当前版本」，从而在聚合内维持单链 DAG；
 * 分叉（同一父版本派生两个子版本）不是一次推进能表达的，留给 application
 * 明确决定，而不是靠这里的宽松判定悄悄允许。
 */
export function advanceToVersion(
  project: Project,
  version: ProjectVersion,
  updatedAt: Timestamp,
): Project {
  assertProjectWritable(project);
  if (version.projectId !== project.id) throw DomainError.invalid('ProjectVersion.projectId');
  const expectedParent = project.currentVersionId;
  const actualParent = version.parentVersionId;
  if (expectedParent !== actualParent) throw DomainError.invalid('ProjectVersion.parentVersionId');
  return {
    ...project,
    currentVersionId: version.id,
    revision: nextRevision(project.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

export function recordProjectOpened(project: Project, lastOpenedAt: Timestamp): Project {
  assertProjectWritable(project);
  return { ...project, lastOpenedAt: parseTimestamp(lastOpenedAt) };
}

/**
 * 回滚 = 以旧版本为父创建**新版本**（§6.3）。
 *
 * 这里只判定可回滚性并返回新版本的字段模板；`id` 与 `sequence` 由调用方分配，
 * 因为它们是持久化身份，domain 不生成 UUID、也不假设 sequence 的存储方式。
 */
export function prepareRestoreVersion(
  source: ProjectVersion,
  input: {
    readonly id: string;
    readonly sequence: number;
    readonly createdBy: string;
    readonly createdAt: string;
  },
): ProjectVersion {
  assertRestorableVersion({ buildStatus: source.buildStatus, scanStatus: source.scanStatus });
  const restored = createProjectVersion({
    id: input.id,
    projectId: source.projectId,
    sequence: input.sequence,
    parentVersionId: source.id,
    sourceTaskId: null,
    artifactSha256: source.artifactSha256,
    contractVersion: source.contractVersion,
    fileCount: source.fileCount,
    totalBytes: source.totalBytes,
    buildStatus: source.buildStatus,
    scanStatus: source.scanStatus,
    safeScanSummary: source.safeScanSummary,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  });
  assertVersionFollowsParent(restored, source);
  return restored;
}

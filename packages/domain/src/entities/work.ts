/**
 * Work 聚合与 Publication（附录 A §6.1、§6.2、§6.3 `works/publications`）。
 *
 * domain 侧持有：visibility、commentsEnabled、work status、publication 状态。
 * `immutable_key`、CSP hashes 与 deny-list 写入属于 application/infra（§6.3 右栏）。
 *
 * 三条不变量：
 * 1. **发布不可覆盖**（§6.2）—— 一次发布产生一条新 `Publication`，旧记录永不改写；
 * 2. **撤销立即生效** —— `LIVE → REVOKED` 是状态写，不是异步清理，撤销后
 *    `canServePublicWork` 立刻返回 false；
 * 3. **可见性与删除状态分离**（§6.2）—— `visibility=PUBLIC` 与 `status=DELETED`
 *    互不蕴含，公开性判定必须同时看两者，任何一处漏看都会把已删除作品放回公网。
 */

import { DomainError } from '../errors/domain-error.js';
import { PUBLICATION_TRANSITIONS, WORK_TRANSITIONS } from '../states/machines.js';
import { assertTransition } from '../states/transition.js';
import {
  parsePublicationId,
  parseProjectId,
  parseProjectVersionId,
  parseWorkId,
  type ProjectId,
  type ProjectVersionId,
  type PublicationId,
  type WorkId,
} from '../value-objects/identifiers.js';
import {
  isBefore,
  nextRevision,
  parseContractVersion,
  parseRevision,
  parseSlug,
  parseTimestamp,
  type ContractVersion,
  type Revision,
  type Slug,
  type Timestamp,
} from '../value-objects/primitives.js';
import {
  canServePublicWork,
  isRevocablePublication,
  isWithinWorkRestoreWindow,
  parsePublicationStatus,
  parseVisibility,
  parseWorkStatus,
  type PublicationStatus,
  type Visibility,
  type WorkStatus,
} from '../value-objects/work.js';
import { parseRuntimeRef, type RuntimeRef } from '../value-objects/refs.js';

export type Work = {
  readonly id: WorkId;
  readonly projectId: ProjectId;
  readonly slug: Slug;
  readonly visibility: Visibility;
  readonly commentsEnabled: boolean;
  readonly status: WorkStatus;
  readonly latestPublicationId: PublicationId | null;
  /** 仅 `status === 'DELETED'` 时非 null（§6.2）。 */
  readonly deletedAt: Timestamp | null;
  readonly revision: Revision;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
};

/**
 * 一次发布。
 *
 * `runtimeRef` 以 provider-neutral opaque value 的形式进入 domain（§6.1 把
 * `RuntimeRef` 列为 Work 的值对象，§6.4 明确允许 `ArtifactRef/RuntimeRef/SecretRef`
 * 三类不透明引用）；从它到物理 runtime path 的映射、CSP hash 计算与 deny-list
 * 写入留在 infra（§6.3 右栏）。`BLOCKED` 与 `REVOKED` 的 publication 从不携带
 * 可服务的 ref，因此这里允许 null。
 */
export type Publication = {
  readonly id: PublicationId;
  readonly workId: WorkId;
  readonly projectVersionId: ProjectVersionId;
  readonly contractVersion: ContractVersion;
  readonly status: PublicationStatus;
  readonly runtimeRef: RuntimeRef | null;
  readonly publishedAt: Timestamp | null;
  readonly revokedAt: Timestamp | null;
};

export function createWork(input: {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly visibility?: string;
  readonly commentsEnabled?: boolean;
  readonly status?: string;
  readonly latestPublicationId?: string | null;
  readonly deletedAt?: string | null;
  readonly revision?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): Work {
  const createdAt = parseTimestamp(input.createdAt);
  const updatedAt = parseTimestamp(input.updatedAt);
  if (isBefore(updatedAt, createdAt)) throw DomainError.invalid('Work.updatedAt');
  const work: Work = {
    id: parseWorkId(input.id),
    projectId: parseProjectId(input.projectId),
    slug: parseSlug(input.slug),
    visibility: input.visibility === undefined ? 'PRIVATE' : parseVisibility(input.visibility),
    commentsEnabled: input.commentsEnabled ?? true,
    status: input.status === undefined ? 'ACTIVE' : parseWorkStatus(input.status),
    latestPublicationId:
      input.latestPublicationId === null || input.latestPublicationId === undefined
        ? null
        : parsePublicationId(input.latestPublicationId),
    deletedAt:
      input.deletedAt === null || input.deletedAt === undefined
        ? null
        : parseTimestamp(input.deletedAt),
    revision: input.revision === undefined ? parseRevision('0') : parseRevision(input.revision),
    createdAt,
    updatedAt,
  };
  assertDeletionMetadataCoherent(work);
  return work;
}

function assertDeletionMetadataCoherent(work: Work): void {
  if ((work.status === 'DELETED') !== (work.deletedAt !== null)) {
    throw DomainError.invalid('Work.deletedAt');
  }
}

export function createPublication(input: {
  readonly id: string;
  readonly workId: string;
  readonly projectVersionId: string;
  readonly contractVersion: string;
  readonly status?: string;
  readonly runtimeRef?: string | null;
  readonly publishedAt?: string | null;
  readonly revokedAt?: string | null;
}): Publication {
  const status = input.status === undefined ? 'PREPARING' : parsePublicationStatus(input.status);
  const publication: Publication = {
    id: parsePublicationId(input.id),
    workId: parseWorkId(input.workId),
    projectVersionId: parseProjectVersionId(input.projectVersionId),
    contractVersion: parseContractVersion(input.contractVersion),
    status,
    runtimeRef:
      input.runtimeRef === null || input.runtimeRef === undefined
        ? null
        : parseRuntimeRef(input.runtimeRef),
    publishedAt:
      input.publishedAt === null || input.publishedAt === undefined
        ? null
        : parseTimestamp(input.publishedAt),
    revokedAt:
      input.revokedAt === null || input.revokedAt === undefined
        ? null
        : parseTimestamp(input.revokedAt),
  };
  assertPublicationCoherent(publication);
  return publication;
}

/**
 * 状态与时间戳的互斥不变量：`publishedAt` 只在离开 `PREPARING` 后出现，
 * `revokedAt` 只在 `REVOKED` 上出现。
 *
 * 把这条写死在构造期，是为了让「已撤销但仍带 publishedAt 且没有 revokedAt」
 * 这种在 deny-list 语义下会立刻重新上架的记录无法存在。
 */
function assertPublicationCoherent(publication: Publication): void {
  const live = publication.status === 'LIVE' || publication.status === 'REVOKED';
  if (live !== (publication.publishedAt !== null))
    throw DomainError.invalid('Publication.publishedAt');
  if ((publication.status === 'REVOKED') !== (publication.revokedAt !== null)) {
    throw DomainError.invalid('Publication.revokedAt');
  }
  if (publication.status === 'PREPARING' && publication.runtimeRef !== null) {
    throw DomainError.invalid('Publication.runtimeRef');
  }
}

/**
 * 发布上线。旧 publication 由调用方在同一事务里置为 `REVOKED`，
 * 但**绝不删除或改写**它：`latestPublicationId` 只是指针，历史行是不可变的。
 */
export function publishPublication(publication: Publication, publishedAt: Timestamp): Publication {
  assertTransition(PUBLICATION_TRANSITIONS, publication.status, 'LIVE', 'REQUEST_INVALID');
  return createPublication({
    id: publication.id,
    workId: publication.workId,
    projectVersionId: publication.projectVersionId,
    contractVersion: publication.contractVersion,
    status: 'LIVE',
    runtimeRef: publication.runtimeRef,
    publishedAt,
    revokedAt: null,
  });
}

/**
 * 内容扫描不通过（`WORK_CONTRACT_BLOCKED` / `CONTENT_REJECTED` 的落点）。
 *
 * `BLOCKED` 是终态：同一次发布不能"再试一次变成 LIVE"，必须重新发起一次
 * 发布，产生新的 publication 行 —— 否则 `PUBLICATION_IN_PROGRESS` 的幂等语义
 * 就无法与历史区分。
 */
export function blockPublication(publication: Publication): Publication {
  assertTransition(PUBLICATION_TRANSITIONS, publication.status, 'BLOCKED', 'REQUEST_INVALID');
  return createPublication({
    id: publication.id,
    workId: publication.workId,
    projectVersionId: publication.projectVersionId,
    contractVersion: publication.contractVersion,
    status: 'BLOCKED',
    runtimeRef: null,
    publishedAt: null,
    revokedAt: null,
  });
}

/** 撤销立即生效（§6.2）：状态写完成的瞬间，公开读取就查不到这个作品。 */
export function revokePublication(publication: Publication, revokedAt: Timestamp): Publication {
  if (!isRevocablePublication(publication.status)) {
    throw DomainError.invalid('Publication.status');
  }
  assertTransition(PUBLICATION_TRANSITIONS, publication.status, 'REVOKED', 'REQUEST_INVALID');
  return createPublication({
    id: publication.id,
    workId: publication.workId,
    projectVersionId: publication.projectVersionId,
    contractVersion: publication.contractVersion,
    status: 'REVOKED',
    runtimeRef: null,
    publishedAt: publication.publishedAt,
    revokedAt,
  });
}

/**
 * 公开可读判定。委托给值对象层的 `canServePublicWork`，
 * 保证 §5.3「不存在、PRIVATE、REVOKED、DELETED 一律 404 且同一机器码」
 * 只有一处实现。
 */
export function isPubliclyReadable(work: Work, publication: Publication | null): boolean {
  if (publication === null) return false;
  return canServePublicWork({
    visibility: work.visibility,
    workStatus: work.status,
    publicationStatus: publication.status,
  });
}

export function changeVisibility(work: Work, visibility: string, updatedAt: Timestamp): Work {
  assertWorkWritable(work);
  return {
    ...work,
    visibility: parseVisibility(visibility),
    revision: nextRevision(work.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

export function changeCommentsEnabled(
  work: Work,
  commentsEnabled: boolean,
  updatedAt: Timestamp,
): Work {
  assertWorkWritable(work);
  if (typeof commentsEnabled !== 'boolean') throw DomainError.invalid('Work.commentsEnabled');
  return {
    ...work,
    commentsEnabled,
    revision: nextRevision(work.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

/** 指针更新：发布成功后指向新的 publication。旧的 publication 行保持不变。 */
export function pointToPublication(
  work: Work,
  publication: Publication,
  updatedAt: Timestamp,
): Work {
  assertWorkWritable(work);
  if (publication.workId !== work.id) throw DomainError.invalid('Publication.workId');
  return {
    ...work,
    latestPublicationId: publication.id,
    revision: nextRevision(work.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

/**
 * 软删除。`deletedAt` 落字段，30 天内可恢复到 `ACTIVE`（§6.2）。
 * 恢复到 `ACTIVE` 而不是"删除前的状态"：Work 只有两个状态，
 * 与 Project 的 `deletedFromStatus` 机制不同，这里不需要额外元数据。
 */
export function deleteWork(work: Work, deletedAt: Timestamp): Work {
  assertTransition(WORK_TRANSITIONS, work.status, 'DELETED', 'REQUEST_INVALID');
  return {
    ...work,
    status: 'DELETED',
    deletedAt: parseTimestamp(deletedAt),
    revision: nextRevision(work.revision),
    updatedAt: parseTimestamp(deletedAt),
  };
}

export function restoreWork(work: Work, now: Timestamp): Work {
  if (work.status !== 'DELETED' || work.deletedAt === null)
    throw DomainError.invalid('Work.status');
  if (!isWithinWorkRestoreWindow(work.deletedAt, now)) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Work');
  }
  return {
    ...work,
    status: 'ACTIVE',
    deletedAt: null,
    revision: nextRevision(work.revision),
    updatedAt: now,
  };
}

export function isWorkRestorable(work: Work, now: Timestamp): boolean {
  if (work.status !== 'DELETED' || work.deletedAt === null) return false;
  return isWithinWorkRestoreWindow(work.deletedAt, now);
}

/**
 * 已删除作品对外表现为不存在（§5.3），因此写入一律 404 而不是 409：
 * 用 `RESOURCE_NOT_FOUND` 可以让「作品不存在」与「作品已删除」在错误码上不可区分。
 */
export function assertWorkWritable(work: Work): void {
  if (work.status === 'DELETED') throw new DomainError('RESOURCE_NOT_FOUND', 'Work');
}

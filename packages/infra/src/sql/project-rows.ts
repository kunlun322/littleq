import {
  DomainError,
  assertVersionFollowsParent,
  createProject,
  createProjectVersion,
  nextVersionSequence,
  type Project,
  type ProjectVersion,
} from '@littleq/domain';

import {
  assertColumnMatches,
  assertPersistableRevision,
  fromJsonObject,
  fromRevisionColumn,
  fromTimestamptz,
  toJsonb,
  toTimestamptz,
} from './rows.js';

/**
 * `projects` / `versions` 两张表的编解码 —— ZLQ-216 §3.1 的读法在聚合根上的落地。
 *
 * ## 与 `task-rows.ts` 逐字相同的三步
 *
 * `payload jsonb` 经 domain 构造器重建实体 → 逐列比对派生列 → **返回重建出来的实体**。
 * 派生列存在的理由只有三个（唯一索引、队列扫描、CAS 的 `WHERE`），而 `Project` 的 15 个
 * 字段里只有 6 个上了列：把列当权威就等于把 `title` / `workType` / `helpLevel` /
 * `deletedAt` / `lastOpenedAt` 降级成"payload 里的注释"，写进去读出来全靠运气。
 *
 * ## `versions` 的 `sequence` 为什么要在事务里再查一次
 *
 * §3.5 逐字：「sequence 从**本事务锁定 project 的现有版本**递增」。调用方（F2 的提交用例）
 * 用 `nextVersionSequence(parent)` 算出 sequence，而 `parent` 是它**进事务之前**读到的
 * `project.currentVersionId`。两个并发提交拿到同一个 parent 时，两边算出的 sequence 相同
 * —— `UNIQUE(project_id, sequence)` 会让其中一个在写入时炸 23505，而那已经是整个短事务
 * 白跑一遍之后。
 *
 * 所以 `VERSION_NEXT_SEQUENCE_SQL` 在**已锁定 project 行**的事务里重算一次期望值，
 * 不一致就当场拒绝：失败发生在写入之前，回滚成本是一句话而不是一整个事务。
 * 唯一索引仍然是最终屏障（它防的是绕过本仓储的写入），这里防的是"算错了才发现"。
 */

export const PROJECT_COLUMNS = `id, owner_student_id, revision, current_version_id, status,
  updated_at, payload`;

export type ProjectRow = {
  readonly id: string;
  readonly owner_student_id: string;
  readonly revision: unknown;
  readonly current_version_id: string | null;
  readonly status: string;
  readonly updated_at: unknown;
  readonly payload: unknown;
};

export function projectFromRow(row: ProjectRow): Project {
  const project = createProject(fromJsonObject(row.payload) as Parameters<typeof createProject>[0]);
  assertColumnMatches(row.id, project.id);
  assertColumnMatches(row.owner_student_id, project.ownerStudentId);
  assertColumnMatches(fromRevisionColumn(row.revision), project.revision);
  assertColumnMatches(row.current_version_id, project.currentVersionId);
  assertColumnMatches(row.status, project.status);
  assertColumnMatches(fromTimestamptz(row.updated_at), project.updatedAt);
  return project;
}

export const PROJECT_SELECT_BY_ID_SQL = `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`;

/** §3.5：「单事务**锁 project**」—— 创建 turn 与提交版本都从这一句开始。 */
export const PROJECT_SELECT_BY_ID_FOR_UPDATE_SQL = `
SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1 FOR UPDATE`;

export const PROJECT_INSERT_SQL = `
INSERT INTO projects(id, owner_student_id, revision, current_version_id, status, updated_at, payload)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)`;

export function projectInsertParams(project: Project): readonly unknown[] {
  assertPersistableRevision(project.revision, 'Project.revision');
  return [
    project.id,
    project.ownerStudentId,
    project.revision,
    project.currentVersionId,
    project.status,
    // 写方向用 `to*`：`updated_at` 在 §3.2 是 `NOT NULL`。见 `rows.ts` 的 `fromNullableTimestamptz`。
    toTimestamptz(project.updatedAt),
    toJsonb(project),
  ];
}

/**
 * 项目行的 CAS 更新。与 `AI_TASK_ENTITY_CAS_SQL` 同构：`WHERE id AND revision`，
 * 不带 `RETURNING`（调用方要的是影响行数，不是"改成了什么"）。
 *
 * `current_version_id` 在这里写，但它**不构成**「当前版本属于本项目」的证明 ——
 * `projects.current_version_id` 与 `versions.project_id` 之间没有 FK（两列都 nullable、
 * 且 `versions` 后建），所以那条不变量只能由 domain 的 `advanceToVersion` 在写入前判定
 * （它同时检查 `version.projectId === project.id` 与 parent 链）。§3.5 的
 * 「提交前确认 currentVersionId 属于同项目」指的就是它，不是一条 SQL 约束。
 */
export const PROJECT_CAS_SQL = `
UPDATE projects SET
  owner_student_id = $2,
  revision = $3,
  current_version_id = $4,
  status = $5,
  updated_at = $6::timestamptz,
  payload = $7::jsonb
WHERE id = $1 AND revision = $8`;

export function projectCasParams(project: Project, expectedRevision: string): readonly unknown[] {
  return [
    project.id,
    project.ownerStudentId,
    project.revision,
    project.currentVersionId,
    project.status,
    toTimestamptz(project.updatedAt),
    toJsonb(project),
    expectedRevision,
  ];
}

export const VERSION_COLUMNS = `id, project_id, sequence, source_task_id, artifact_sha256, payload`;

export type VersionRow = {
  readonly id: string;
  readonly project_id: string;
  readonly sequence: number;
  readonly source_task_id: string | null;
  readonly artifact_sha256: string;
  readonly payload: unknown;
};

export function versionFromRow(row: VersionRow): ProjectVersion {
  const version = createProjectVersion(
    fromJsonObject(row.payload) as Parameters<typeof createProjectVersion>[0],
  );
  assertColumnMatches(row.id, version.id);
  assertColumnMatches(row.project_id, version.projectId);
  assertColumnMatches(row.sequence, version.sequence);
  assertColumnMatches(row.source_task_id, version.sourceTaskId);
  assertColumnMatches(row.artifact_sha256, version.artifactSha256);
  return version;
}

export const VERSION_SELECT_BY_ID_SQL = `SELECT ${VERSION_COLUMNS} FROM versions WHERE id = $1`;

/** §3.5：「重入先读该 task 既有 version，内容一致才复用，不生成第二版本。」 */
export const VERSION_SELECT_BY_SOURCE_TASK_ID_SQL = `
SELECT ${VERSION_COLUMNS} FROM versions WHERE source_task_id = $1`;

export const VERSION_INSERT_SQL = `
INSERT INTO versions(id, project_id, sequence, source_task_id, artifact_sha256, payload)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)`;

export function versionInsertParams(version: ProjectVersion): readonly unknown[] {
  return [
    version.id,
    version.projectId,
    version.sequence,
    version.sourceTaskId,
    version.artifactSha256,
    toJsonb(version),
  ];
}

export const VERSION_NEXT_SEQUENCE_SQL = `
SELECT COALESCE(MAX(sequence), 0) + 1 AS expected_sequence
FROM versions WHERE project_id = $1`;

/**
 * 校验一个待插入的版本：parent 链成立，且 sequence **恰好**是下一个。
 *
 * `parent` 是本事务内读到的 `project.currentVersionId` 对应版本，第一个版本时为 `null`。
 * 两道判定分工明确：
 *
 * - `assertVersionFollowsParent` 是 domain 的，管"sequence 严格大于 parent、同项目"；
 * - `nextVersionSequence` 的相等比较管"没有跳号"。前者放过 `parent.sequence + 5`，
 *   而跳号会让 §4.1 的「历史版本追加式分页」出现空洞 —— 客户端按 sequence 连续翻页时
 *   漏掉一段，而且**看不出来**漏了。
 *
 * 抛 `DomainError.invalid` 而不是 `InfraError`：sequence 是领域不变量，判据的事实源在
 * domain。infra 自己的码只表达"存储层出了问题"，用在这里会让「调用方算错了」与
 * 「库坏了」在日志里长成同一个样子 —— 而前者是 F2 用例的 bug，后者是运维事故。
 */
export function assertVersionInsertable(
  version: ProjectVersion,
  parent: ProjectVersion | null,
): void {
  assertVersionFollowsParent(version, parent);
  if (version.sequence !== nextVersionSequence(parent)) {
    throw DomainError.invalid('ProjectVersion.sequence');
  }
}

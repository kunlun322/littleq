/**
 * 项目、版本与生成式回合的 DTO。
 *
 * 这个文件承载了契约里最重的一条泄漏边界：`ProjectVersion` **不含 object key**
 * （对象清单与物理文件位置属于 infra，附录 A §6.3 右栏），`createPreview` 的 `url`
 * 是短期独立源地址、契约只声明它是一个字符串而**不给示例值** —— 一个示例签名 URL
 * 就是一份可复用的凭证模板（§5 禁止签名 URL 进入快照与 fixture）。
 */
import { z } from 'zod';

import {
  ageBandSchema,
  buildStatusSchema,
  contractVersionSchema,
  countSchema,
  cursorSchema,
  helpLevelSchema,
  listLimitSchema,
  operatorNoteSchema,
  pageSchema,
  projectStatusSchema,
  projectTitleSchema,
  promptSchema,
  revisionSchema,
  scanStatusSchema,
  sha256Schema,
  timestampSchema,
  uuidV7Schema,
  versionSequenceSchema,
  visibilitySchema,
  workTypeSchema,
} from './common.js';
import { taskSchema } from './tasks.js';

/**
 * 项目读模型 —— §5.5 的 13 个字段，一个不多一个不少。
 *
 * domain 的 `Project` 另有 `deletedAt` 与 `deletedFromStatus`（§6.2 的 30 天恢复窗口），
 * 但 §5.5 的对外清单里没有它们，所以线上只有 `status: 'DELETED'` 这一个可见信号，
 * 窗口何时到期客户端算不出来。这是**按契约交付**、并在交付评论里声明待裁定的缺口，
 * 不是遗漏：契约层的字段集合由 §5.5 逐字锁定，加字段属于契约变更，要走架构师修订。
 */
export const projectSchema = z
  .object({
    id: uuidV7Schema,
    ownerStudentId: uuidV7Schema,
    title: projectTitleSchema,
    workType: workTypeSchema,
    ageBand: ageBandSchema,
    helpLevel: helpLevelSchema,
    templateId: uuidV7Schema.nullable(),
    currentVersionId: uuidV7Schema.nullable(),
    status: projectStatusSchema,
    lastOpenedAt: timestampSchema.nullable(),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .meta({ id: 'Project' });

export const projectPageSchema = pageSchema(projectSchema, 'ProjectPage');

/** 脱敏扫描摘要：仅计数、报告引用与扫描时刻（架构 §4.4 `scan_summary_json`）。 */
export const safeScanSummarySchema = z
  .object({
    blockedCount: countSchema,
    warningCount: countSchema,
    confirmRequiredCount: countSchema,
    reportRef: z.string().max(512).nullable(),
    scannedAt: timestampSchema,
  })
  .meta({ id: 'SafeScanSummary' });

/**
 * 项目的不可变版本。
 *
 * `artifactSha256` 是内容摘要，不是下载地址；对象清单（manifest object key）与
 * 物理文件位置留在 infra（§6.3 右栏），因此这个 schema 里没有任何 object key 字段。
 */
export const projectVersionSchema = z
  .object({
    id: uuidV7Schema,
    projectId: uuidV7Schema,
    sequence: versionSequenceSchema,
    parentVersionId: uuidV7Schema.nullable(),
    sourceTaskId: uuidV7Schema.nullable(),
    artifactSha256: sha256Schema,
    contractVersion: contractVersionSchema,
    fileCount: countSchema,
    totalBytes: countSchema,
    buildStatus: buildStatusSchema,
    scanStatus: scanStatusSchema,
    safeScanSummary: safeScanSummarySchema.nullable(),
    createdBy: uuidV7Schema,
    createdAt: timestampSchema,
  })
  .meta({ id: 'ProjectVersion' });

export const projectVersionPageSchema = pageSchema(projectVersionSchema, 'ProjectVersionPage');

/** `GET /projects` 的查询参数。Student 调用时 `ownerStudentId` 由服务端固定，不接受客户端指定。 */
export const listProjectsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: listLimitSchema,
  status: projectStatusSchema.optional(),
  ownerStudentId: uuidV7Schema.optional(),
});

export const listProjectVersionsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: listLimitSchema,
});

/**
 * 创建项目。
 *
 * `templateId` 用 `.nullable().optional()`：domain 的 `Project.templateId` 是
 * `ProjectVersionId | null`，客户端「没有模板」既可以省略这个键也可以显式传 `null`。
 * 两种写法都接受是**放宽**服务端接受集合（§4.2 的非破坏方向），比只认一种更安全。
 */
export const createProjectRequestSchema = z
  .object({
    title: projectTitleSchema,
    workType: workTypeSchema,
    ageBand: ageBandSchema,
    helpLevel: helpLevelSchema,
    templateId: uuidV7Schema.nullable().optional(),
  })
  .meta({ id: 'CreateProjectRequest' });

/**
 * `GET /projects/{id}` 的聚合响应。
 *
 * 一次拿到项目、当前版本与在跑的任务，是为了让编辑器首屏不必发三个请求再自己拼装
 * 竞态。两个可空字段按 §6.4 投影成 **required 但 nullable**，不是 optional。
 */
export const getProjectResponseSchema = z
  .object({
    project: projectSchema,
    currentVersion: projectVersionSchema.nullable(),
    activeTask: taskSchema.nullable(),
  })
  .meta({ id: 'GetProjectResponse' });

/**
 * 发起一个生成式回合。
 *
 * `baseRevision` 是必填的乐观并发基准：回合是长任务，服务端要在**创建时**就知道
 * 客户端看到的是哪一版项目，否则两个并发回合会各自基于过期状态生成（§6.6 的
 * `ACTIVE_WRITE_TASK_EXISTS` 是第二道闸，不是替代）。
 */
export const createTurnRequestSchema = z
  .object({
    prompt: promptSchema,
    baseRevision: revisionSchema,
    baseVersionId: uuidV7Schema.nullable().optional(),
  })
  .meta({ id: 'CreateTurnRequest' });

/** `POST /projects/{id}/versions/{v}:restore` 的路径参数。
 *
 * `{v}` 取**版本的 UUIDv7 标识**而不是 `sequence`：本 API 里每个标识对象的路径参数
 * 都是 UUIDv7，而 `sequence` 只在单个项目内唯一 —— 用它寻址会让同一个 URL 在恢复
 * 出分支版本之后指向不同的对象。`createPreview` 的 `versionId` 同样是 UUID，两处
 * 保持一致。这一处 §5.4 的路由表只写了 `{v}`，取值口径是工程侧按上述理由确定的，
 * 已在交付评论里声明。
 */
export const restoreProjectVersionPathSchema = z.object({
  id: uuidV7Schema,
  v: uuidV7Schema,
});

export const restoreProjectVersionRequestSchema = z
  .object({
    reason: operatorNoteSchema.optional(),
  })
  .meta({ id: 'RestoreProjectVersionRequest' });

export const restoreProjectVersionResponseSchema = z
  .object({
    version: projectVersionSchema,
    projectRevision: revisionSchema,
  })
  .meta({ id: 'RestoreProjectVersionResponse' });

/** 预览请求。省略 `versionId` 即预览当前版本。 */
export const createPreviewRequestSchema = z
  .object({
    versionId: uuidV7Schema.nullable().optional(),
  })
  .meta({ id: 'CreatePreviewRequest' });

/**
 * 预览响应。
 *
 * `url` 是短期、独立源（与主站不同 origin）的地址：独立源才能让浏览器把作品运行时
 * 隔离在单独的 origin 里，短期才能限制链接被转发后的暴露窗口。契约只声明它是一个
 * 不超过 512 字符的字符串，**不给示例值**，也不声明它的 host、query 或签名算法 ——
 * 那些属于 infra，写进契约就等于承诺一个具体的签名方案。
 */
export const createPreviewResponseSchema = z
  .object({
    url: z.string().min(1).max(512),
    expiresAt: timestampSchema,
    versionId: uuidV7Schema,
  })
  .meta({ id: 'CreatePreviewResponse' });

export const publishProjectRequestSchema = z
  .object({
    versionId: uuidV7Schema,
    visibility: visibilitySchema,
    commentsEnabled: z.boolean(),
  })
  .meta({ id: 'PublishProjectRequest' });

export const publishProjectResponseSchema = z
  .object({
    publicationTaskId: uuidV7Schema,
    revision: revisionSchema,
  })
  .meta({ id: 'PublishProjectResponse' });

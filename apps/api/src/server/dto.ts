/**
 * 契约投影：domain 实体 → §4.1 冻结的线上形状。
 *
 * ## 为什么这一层只有 `.parse()`，没有第二套 DTO 规则
 *
 * 附录 A §3.5：「`apps/api` 后续只能引用本包（api-contract）的 schema，不得再声明第二套
 * DTO 校验规则。」所以这里**每一个**投影都以契约 schema 的 `parse` 收尾，而不是手写
 * 字段挑选。两个方向分开处理，因为它们的失败含义完全相反：
 *
 * - **请求方向**（`parseRequest`）：校验失败是客户端的错 ⇒ 400 `REQUEST_INVALID`。
 *   envelope 里没有 `details` 字段，所以「不回显 offending value」是结构性的而不是纪律性的
 *   —— 这一点对 `prompt` 尤其要紧：§5 禁止 prompt 全文出现在响应、日志、快照里，而 400
 *   恰恰是最容易顺手把入参贴回去的地方。
 * - **响应方向**（`toWire`）：投影失败只可能是我们的缺陷（domain 实体已经过构造函数
 *   校验，契约 schema 是它的窄面）⇒ 500 `INTERNAL_ERROR`，并且**不带**原始 message：
 *   zod 的报错文本里含字段路径与实际取值，把 `prompt` 或秘密明文回显出去正是 §5 要拦的。
 *
 * ## `.parse()` 顺带兑现的一条安全性质
 *
 * zod object 默认 **strip** 未知键。于是 domain 里那些「不上线」的字段不可能因为一次
 * 手误的展开而泄漏：`Project.deletedAt` / `deletedFromStatus`、`AiTask.requestedBy` /
 * `idempotencyKey` / `requestHash` / `repairCount`。这条保证由 schema 的形状提供，
 * 不依赖谁记得挑字段 —— 而 `projectDto` 这类函数写的就是 `{ ...project }`。
 *
 * ## 为什么不需要 `import { z } from 'zod'`
 *
 * zod 不是 `apps/api` 的依赖（`package.json` 里没有它，也不该有：契约层是唯一持有 zod
 * 的单元）。这里只用 schema **对象上的方法**，因此不需要 zod 的类型；`parseRequest` 的
 * 形参写成结构类型 `{ parse(data: unknown): T }`，任何 zod schema 都满足它。
 */
import {
  errorEnvelopeSchema,
  getProjectResponseSchema,
  ifMatchSchema,
  liveHealthSchema,
  projectPageSchema,
  projectSchema,
  projectVersionSchema,
  readyHealthSchema,
  secretMetadataSchema,
  taskAcceptedSchema,
  taskEventSchema,
  taskPumpResultSchema,
  taskSchema,
} from '@littleq/api-contract';
import type { Page } from '@littleq/application';
import {
  DomainError,
  parseRevision,
  type AiTask,
  type ErrorCode,
  type Project,
  type ProjectVersion,
  type Revision,
  type TaskEvent,
} from '@littleq/domain';

/** `If-Match` / `ETag` 的字面前缀。与 `E_TAG_WIRE_PATTERN` 的 `"rev-…"` 同源。 */
const E_TAG_PREFIX = '"rev-';

/**
 * 请求方向的校验入口。
 *
 * `label` 是**值对象名**，进 `DomainError.valueObject`，最终只出现在服务端日志里；
 * 它不回给客户端（envelope 只有四个字段）。
 */
export function parseRequest<T>(
  label: string,
  schema: { parse(data: unknown): T },
  raw: unknown,
): T {
  try {
    return schema.parse(raw);
  } catch {
    throw new DomainError('REQUEST_INVALID', label);
  }
}

/** 响应方向的投影入口：失败即我们的缺陷，统一 500，且不把原始报错带出去。 */
export function toWire(label: string, project: () => unknown): unknown {
  try {
    return project();
  } catch {
    throw new DomainError('INTERNAL_ERROR', label);
  }
}

/** `Project` → `ProjectSchema`。`deletedAt` / `deletedFromStatus` 由 strip 去掉。 */
export function projectDto(project: Project): unknown {
  return toWire('Project', () => projectSchema.parse({ ...project }));
}

export function projectVersionDto(version: ProjectVersion): unknown {
  return toWire('ProjectVersion', () => projectVersionSchema.parse({ ...version }));
}

/** `AiTask`（24 字段）→ `Task`（18 字段）。四个私有字段由 strip 去掉。 */
export function taskDto(task: AiTask): unknown {
  return toWire('Task', () => taskSchema.parse({ ...task }));
}

/**
 * `TaskEvent` → `TaskEvent` schema。
 *
 * 唯一需要手写的一处：domain 的 `sequence` 是 `bigint`（单任务内单调递增，bigint 分配
 * 在 infra），而线上的 `sequence` 是 `countSchema`（number）。`JSON.stringify` 遇到
 * bigint 会**抛**，所以这一转换不是可选的。事件 id 走同一列，线上是十进制字符串，
 * 因此用 `String(...)` 而不是 `Number(...)`。
 */
export function taskEventDto(event: TaskEvent): unknown {
  return toWire('TaskEvent', () =>
    taskEventSchema.parse({
      id: String(event.id),
      sequence: Number(event.sequence),
      eventType: event.eventType,
      safePayload: event.safePayload,
      createdAt: event.createdAt,
    }),
  );
}

export function projectPageDto(page: Page<Project>): unknown {
  return toWire('ProjectPage', () =>
    projectPageSchema.parse({
      items: page.items.map((project) => ({ ...project })),
      nextCursor: page.nextCursor,
    }),
  );
}

/**
 * `GET /projects/{id}` 的三键响应。
 *
 * 两个 nullable 键**必须存在**（§4.1）：`currentVersion` 在从未生成过版本时是 `null`，
 * `activeTask` 在没有未终态写任务时是 `null`。契约 schema 把它们声明成
 * `.nullable()` 而不是 `.optional()`，所以「键缺失」过不了 `parse` —— 形状本身就在
 * 钉这条要求，不需要额外的断言。
 */
export function getProjectResponseDto(view: {
  readonly project: Project;
  readonly currentVersion: ProjectVersion | null;
  readonly activeTask: AiTask | null;
}): unknown {
  return toWire('GetProjectResponse', () =>
    getProjectResponseSchema.parse({
      project: { ...view.project },
      currentVersion: view.currentVersion === null ? null : { ...view.currentVersion },
      activeTask: view.activeTask === null ? null : { ...view.activeTask },
    }),
  );
}

export function taskAcceptedDto(result: {
  readonly taskId: string;
  readonly revision: Revision;
}): unknown {
  return toWire('TaskAccepted', () =>
    taskAcceptedSchema.parse({ taskId: result.taskId, revision: result.revision }),
  );
}

export function taskPumpResultDto(result: {
  readonly outcome: string;
  readonly task: AiTask;
}): unknown {
  return toWire('TaskPumpResult', () =>
    taskPumpResultSchema.parse({
      taskId: result.task.id,
      outcome: result.outcome,
      task: { ...result.task },
    }),
  );
}

/**
 * BYO 凭据的**唯一**出站形状：`kind` / `configured` / `lastRotatedAt`。
 *
 * 三个字段里没有 value、没有 hash、没有 ref —— 这不是「记得别放」，而是
 * `secretMetadataSchema` 只有这三个键，多写一个就过不了 `parse`。契约层同样没有任何
 * `/settings/secrets/*` 的响应 schema 带出站正文，所以秘密在协议上只有**入向**路径。
 */
export function secretMetadataDto(metadata: {
  readonly kind: string;
  readonly configured: boolean;
  readonly lastRotatedAt: string | null;
}): unknown {
  return toWire('SecretMetadata', () => secretMetadataSchema.parse({ ...metadata }));
}

export function errorEnvelopeDto(input: {
  readonly code: ErrorCode;
  readonly messageKey: string;
  readonly retryable: boolean;
  readonly traceId: string;
}): unknown {
  return toWire('ErrorEnvelope', () => errorEnvelopeSchema.parse({ ...input }));
}

export function liveHealthDto(): unknown {
  return toWire('LiveHealth', () => liveHealthSchema.parse({ status: 'ok' }));
}

export function readyHealthDto(): unknown {
  return toWire('ReadyHealth', () => readyHealthSchema.parse({ status: 'ready' }));
}

/** revision → 强校验 ETag（含字面双引号，RFC 9110 entity-tag 语法）。 */
export function eTagOf(revision: Revision): string {
  return `${E_TAG_PREFIX}${revision}"`;
}

/**
 * `If-Match` 头 → `Revision`。
 *
 * 形式不合法（不是 `"rev-<十进制>"`）走 `parseRequest` ⇒ 400 `REQUEST_INVALID`；
 * 形式合法但与被寻址资源的 revision 不等，是用例/存储侧的 CAS 失配 ⇒ 409
 * `REVISION_CONFLICT`。两者分开：前者是「你没按语法写」，后者是「有人比你先改了」。
 */
export function revisionFromETag(label: string, raw: string): Revision {
  const matched = parseRequest(label, ifMatchSchema, raw);
  return parseRevision(matched.slice(E_TAG_PREFIX.length, -1));
}

/**
 * 异步任务的 DTO —— §5.5 的 `Task` / `TaskEvent` 加上任务接口的请求与受理响应。
 *
 * 这个文件是 §5「不得泄漏 provider 生命周期」的落点：`Task` 里**结构上不存在**
 * lease、QCA session id、事件 cursor、operation key、provider request id、error digest。
 * 缺字段比多字段容易证明，所以这份「不含」清单由 `test/schemas.test.ts` 逐条断言。
 */
import { z } from 'zod';

import {
  attemptSchema,
  countSchema,
  operatorNoteSchema,
  progressSchema,
  revisionSchema,
  taskEventIdSchema,
  taskEventTypeSchema,
  taskKindSchema,
  taskStageSchema,
  taskStateSchema,
  timestampSchema,
  uuidV7Schema,
} from './common.js';

/**
 * task representation 内嵌的安全错误投影（domain 的 `SafeError`）。
 *
 * 只有三个字段：`traceId` 属于同步 envelope，异步失败经 `GET /tasks/{id}` 以
 * HTTP 200 返回，客户端拿 `code` 查文案、拿 `retryable` 决定要不要自动重试。
 * 不含 provider 原始错误体、headers 或 stack（§5）。
 */
export const taskErrorSchema = z
  .object({
    code: z.string().min(1),
    messageKey: z.string().min(1),
    retryable: z.boolean(),
  })
  .meta({ id: 'TaskError' });

/**
 * 异步任务表示。
 *
 * 结构上不含：`leaseOwner` / `leaseUntil`（抢占实现属于 infra）、`qcaSessionId` /
 * `qcaEventCursor` / `externalOperationKey` / `providerRequestId` / `errorDigest`
 * （provider 生命周期字段）、`requestedBy`（调用方已知）、`idempotencyKey` /
 * `requestHash`（幂等 scope 不回显）、`repairCount`（内部预算）。
 */
export const taskSchema = z
  .object({
    id: uuidV7Schema,
    kind: taskKindSchema,
    projectId: uuidV7Schema,
    state: taskStateSchema,
    stage: taskStageSchema.nullable(),
    progress: progressSchema,
    attempt: attemptSchema,
    maxAttempts: attemptSchema,
    nextRunAt: timestampSchema.nullable(),
    cancelRequestedAt: timestampSchema.nullable(),
    softDeadlineAt: timestampSchema.nullable(),
    hardDeadlineAt: timestampSchema.nullable(),
    resultVersionId: uuidV7Schema.nullable(),
    error: taskErrorSchema.nullable(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    finishedAt: timestampSchema.nullable(),
    revision: revisionSchema,
  })
  .meta({ id: 'Task' });

/**
 * SSE 事件载荷。
 *
 * `safePayload` 用开放的 object 而不是收紧的 union：它是「可向前端公开的安全进度」
 * 的容器，按 §4.2「收窄响应值集合但不删除字段/type」是非破坏性的，因此 v1 从宽
 * 声明；将来收紧不会破坏已有客户端。反方向（v1 收紧、后来放宽）才是破坏性的。
 */
export const taskEventSchema = z
  .object({
    id: taskEventIdSchema,
    sequence: countSchema,
    eventType: taskEventTypeSchema,
    safePayload: z.record(z.string(), z.unknown()),
    createdAt: timestampSchema,
  })
  .meta({ id: 'TaskEvent' });

/**
 * `Last-Event-ID` 请求头：SSE 断线重连时回填最后收到的 `TaskEvent.sequence`。
 *
 * 与 `TaskEventId` 共用同一条十进制 pattern（两者本来就是同一个数的两个方向），
 * 因此这里不注册新的 component id —— 注册了也只会在快照里多一个逐字相同的 schema。
 */
export const streamTaskEventsHeaderSchema = z.object({
  'Last-Event-ID': taskEventIdSchema.optional(),
});

/**
 * 受理响应：`202` 只回任务标识与新的项目 revision。
 *
 * 不回完整 `Task`：受理时刻的任务除了 `QUEUED` 之外没有任何客户端不知道的信息，
 * 回完整表示等于要求 `POST` 与 `GET /tasks/{id}` 保持逐字段同步。`Location` 头
 * 指向 `GET /tasks/{id}`，客户端从那里拿状态。
 */
export const taskAcceptedSchema = z
  .object({
    taskId: uuidV7Schema,
    revision: revisionSchema,
  })
  .meta({ id: 'TaskAccepted' });

/** 重试受理响应。`attempt` 让客户端立刻知道这是同一 task 的第几次尝试（§5.4）。 */
export const taskRetryAcceptedSchema = z
  .object({
    taskId: uuidV7Schema,
    attempt: attemptSchema,
    revision: revisionSchema,
  })
  .meta({ id: 'TaskRetryAccepted' });

/**
 * 重试原因。可选、纯运维注记。
 *
 * 刻意**不**建模成「重试策略」：能不能重试由 domain 的 `RETRYABLE_ENTRY_TASK_STATES`
 * 与 `(stage, code)` 固定表决定（§6.6「`retryable` 不得通过异常继承推导」），
 * 客户端传的理由不参与判定，因此契约也不给它任何枚举。
 */
export const retryTaskRequestSchema = z
  .object({
    reason: operatorNoteSchema.optional(),
  })
  .meta({ id: 'RetryTaskRequest' });

import type { TaskId } from '@littleq/domain';
import {
  createAiTask,
  createTaskEvent,
  type AiTask,
  type TaskEvent,
  type Timestamp,
} from '@littleq/domain';

import { infraError } from '../errors.js';
import type { DatabaseTransaction } from '../ports/database-adapter.js';
import type { TaskLease } from '../ports/task-repository.js';
import { leaseFromRow } from './lease.js';
import {
  assertColumnMatches,
  assertPersistableRevision,
  fromBigIntColumn,
  fromJsonObject,
  fromNullableTimestamptz,
  fromRevisionColumn,
  fromTextColumn,
  fromTimestamptz,
  toNullableTimestamptz,
  toJsonb,
  toTimestamptz,
} from './rows.js';

/**
 * `ai_tasks` / `task_events` 的行 ↔ domain 编解码（ZLQ-216 §3.1、§3.2）。
 *
 * ## 一句 `SELECT *` 之后为什么还要再跑一遍构造器
 *
 * §3.1 逐字：「业务实体以完整 domain 形态存 `payload jsonb`，查询/唯一性/并发所需字段作
 * 独立列……独立列从验证后的实体派生，仓储读取时**检查一致性**。」于是读一行是三步：
 * `payload` 交回 `createAiTask`（**验证**，不是解析）、逐列与重建结果比对（**一致性**）、
 * 返回重建结果（**权威值是 payload**）。
 *
 * 权威值取 payload 而不是列，是因为列存在的目的只有三个：唯一索引、队列扫描、CAS 的
 * `WHERE`。三者都是**查找**用途，而 `AiTask` 的 22 个字段里只有 11 个被派生成列 ——
 * 以列为权威等于把没上列的字段（`progress`、`cancelRequestedAt`、`softDeadlineAt`……）
 * 悄悄降级成"只在 payload 里的备注"。
 *
 * ## `payload` 交给构造器时那个 `as` 是安全的
 *
 * `fromJsonObject` 给的是 `Record<string, unknown>`，`createAiTask` 要的是一个具体形状，
 * 中间必须有一次类型断言。它不会让脏数据溜过去：`createAiTask` 对**每一个**字段都跑
 * `parse*`，任何形状不符都抛 `DomainError`。断言改变的只是"编译期知不知道"，
 * 不改变"运行期验不验"。这正是 §3.1「写入只走现有构造器/策略验证；**禁止**从 HTTP
 * 直接任意更新 JSON」在读方向上的对偶。
 */

/** `ai_tasks` 的列清单。显式点名而不是 `SELECT *`：加一列不该静默改变行形状。 */
export const AI_TASK_COLUMNS = `id, project_id, requested_by, idempotency_key, request_hash,
  accepted_project_revision, state, stage, attempt, revision, next_run_at,
  lease_owner, lease_token, lease_until, payload`;

export type AiTaskRow = {
  readonly id: string;
  readonly project_id: string;
  readonly requested_by: string;
  readonly idempotency_key: string | null;
  readonly request_hash: string | null;
  readonly accepted_project_revision: unknown;
  readonly state: string;
  readonly stage: string | null;
  readonly attempt: number;
  readonly revision: unknown;
  readonly next_run_at: unknown;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_until: unknown;
  readonly payload: unknown;
};

/**
 * 行 → `AiTask`。
 *
 * 一致性检查覆盖**全部**派生列，包括那些看起来不可能不一致的（`project_id`、`state`）。
 * 理由是 §3.1 那条规则的目的不是"抓 bug"，而是让「有人绕过仓储写过库」这件事在下一次读
 * 时就停下来：绕过仓储的写入通常只改列不改 payload（改 payload 要构造一个合法实体，
 * 那还不如走仓储），所以最容易分叉的恰恰是这些"不可能"的列。
 */
export function taskFromRow(row: AiTaskRow): AiTask {
  const task = createAiTask(fromJsonObject(row.payload) as Parameters<typeof createAiTask>[0]);
  assertColumnMatches(row.id, task.id);
  assertColumnMatches(row.project_id, task.projectId);
  assertColumnMatches(row.requested_by, task.requestedBy);
  assertColumnMatches(row.idempotency_key, task.idempotencyKey);
  assertColumnMatches(row.request_hash, task.requestHash);
  assertColumnMatches(row.state, task.state);
  assertColumnMatches(row.stage, task.stage);
  assertColumnMatches(row.attempt, task.attempt);
  assertColumnMatches(fromRevisionColumn(row.revision), task.revision);
  assertColumnMatches(fromNullableTimestamptz(row.next_run_at), task.nextRunAt);
  return task;
}

/** `ai_tasks` 的 15 个插入参数（顺序与 `AI_TASK_INSERT_SQL` 的占位符一致）。 */
export function taskInsertParams(
  task: AiTask,
  acceptedProjectRevision: string | null,
  lease: { readonly owner: string; readonly token: string; readonly until: Timestamp } | null,
): readonly unknown[] {
  assertPersistableRevision(task.revision, 'AiTask.revision');
  return [
    task.id,
    task.projectId,
    task.requestedBy,
    task.idempotencyKey,
    task.requestHash,
    acceptedProjectRevision,
    task.state,
    task.stage,
    task.attempt,
    task.revision,
    toNullableTimestamptz(task.nextRunAt),
    lease?.owner ?? null,
    lease?.token ?? null,
    lease === null ? null : toNullableTimestamptz(lease.until),
    toJsonb(task),
  ];
}

export const AI_TASK_INSERT_SQL = `
INSERT INTO ai_tasks(
  id, project_id, requested_by, idempotency_key, request_hash, accepted_project_revision,
  state, stage, attempt, revision, next_run_at, lease_owner, lease_token, lease_until, payload
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13, $14::timestamptz, $15::jsonb
)`;

/**
 * 实体列的 CAS 更新。
 *
 * `WHERE id = $1 AND revision = $12` 是 domain `task-pump.ts` 头部点名的事实源：
 * 「推进的落库是 `UPDATE … WHERE id = ? AND revision = ?`。同时到达的多个 pump 里只有
 * 一个能改到行，其余的影响行数为 0。」所以本语句**不带** `RETURNING`：调用方要的是
 * 影响行数，拿行数判 CAS，拿返回行判"改成了什么"会把两件事混成一件。
 *
 * 刻意**不**写 `accepted_project_revision`：它不是 `AiTask` 的字段，是 §3.5 `createTurn`
 * 受理那一刻的项目版本，「回放不取后来变动的 revision」。让它跟着实体更新走，
 * 一次普通的 `save` 就会把受理证据改掉。
 *
 * 同样刻意**不**写三列租约字段：租约由 `AI_TASK_LEASE_*_SQL` 单独改。混在一起会让
 * `releaseLease`（只清租约、不动实体、不动 revision）无法表达。
 */
export const AI_TASK_ENTITY_CAS_SQL = `
UPDATE ai_tasks SET
  project_id = $2,
  requested_by = $3,
  idempotency_key = $4,
  request_hash = $5,
  state = $6,
  stage = $7,
  attempt = $8,
  revision = $9,
  next_run_at = $10::timestamptz,
  payload = $11::jsonb
WHERE id = $1 AND revision = $12`;

export function taskEntityCasParams(task: AiTask, expectedRevision: string): readonly unknown[] {
  return [
    task.id,
    task.projectId,
    task.requestedBy,
    task.idempotencyKey,
    task.requestHash,
    task.state,
    task.stage,
    task.attempt,
    task.revision,
    toNullableTimestamptz(task.nextRunAt),
    toJsonb(task),
    expectedRevision,
  ];
}

export const AI_TASK_SELECT_BY_ID_SQL = `SELECT ${AI_TASK_COLUMNS} FROM ai_tasks WHERE id = $1`;

/** §3.5：`acquire` 用短事务 `SELECT … WHERE id=$1 FOR UPDATE`，**不查询队列"第一条"**。 */
export const AI_TASK_SELECT_BY_ID_FOR_UPDATE_SQL = `
SELECT ${AI_TASK_COLUMNS} FROM ai_tasks WHERE id = $1 FOR UPDATE`;

/**
 * `createTurn` 的查重（§3.5：「单事务锁 project，**先按该 project/key 查重**」）。
 *
 * 键是 `(project_id, idempotency_key)` —— 与 §3.2 那条 `UNIQUE (project_id,
 * idempotency_key)` 逐字对应，也正是它保证这一句至多返回一行。不带 `FOR UPDATE`：
 * 调用方（`PostgresTaskUnitOfWork.createTurn`）已经锁住了同一项目的 `projects` 行，
 * 而任何一次 `createTurn` 都必须先过那把锁，所以同一项目下不可能有第二个写者在这里
 * 与我并发。再锁一次 task 行只会把锁顺序变成"有时 project 先、有时 task 先"。
 *
 * 只取三列：判"是不是同一次请求"需要 `request_hash`，回放需要 `id` 与
 * `accepted_project_revision`。**不取 `payload`** —— 回放返回的是当初受理的结果
 * （`{taskId, revision}`），不是任务的当前状态；把整行读回来会诱使调用方拿它当
 * `AiTask` 用，而它可能早已被 worker 推进过。
 */
export const AI_TASK_SELECT_BY_IDEMPOTENCY_KEY_SQL = `
SELECT id, request_hash, accepted_project_revision FROM ai_tasks
WHERE project_id = $1 AND idempotency_key = $2`;

/**
 * 本项目的**非终态**任务（§3.2「每项目非终态 task 唯一的部分索引」的读侧）。
 *
 * 终态清单作为 `$2` 由调用方传 `TASK_TRANSITIONS.terminal`，不在 SQL 里重抄一遍：
 * 抄一遍就有了两个事实源，而 domain 加一个终态时不会有人想起这条语句 ——
 * 结果是"已取消的任务仍然挡住新回合"，一个只在取消之后才出现、且看起来像卡死的故障。
 *
 * 那条部分唯一索引让本句至多返回一行，但**不依赖**这一点：判定在 TypeScript 里逐行做，
 * 索引只是竞态屏障（§6.5 规则 4），不是查询语义。
 */
export const AI_TASK_SELECT_ACTIVE_STATE_BY_PROJECT_SQL = `
SELECT state FROM ai_tasks
WHERE project_id = $1 AND NOT (state = ANY($2::text[]))`;

/**
 * §3.2 那条部分唯一索引的名字。
 *
 * 单独导出是因为 `createTurn` 要用它把 23505 翻译成 `ACTIVE_WRITE_TASK_EXISTS`
 * （§6.5 规则 4），而同一个 `INSERT` 撞 `ai_tasks_pkey` 是另一回事（调用方重复使用了
 * task id，属内部错误）。DDL 里那个名字是字面量 —— 迁移文本一改 checksum 就变，所以
 * 不把它插值进去；两处的绑定由 `test/sql-schema-pinning.test.ts` 钉住。
 */
export const AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX = 'ai_tasks_one_active_per_project';

/**
 * 冻结端口 `TaskRepository.claim` 的队列查询。
 *
 * 排序 `COALESCE(next_run_at, (payload->>'createdAt')::timestamptz), id` 逐字对应内存替身
 * 的 `claimOrder(task) = timestampSortKey(nextRunAt ?? createdAt) + ' ' + id` —— 也就是
 * §6.1 的 `(next_run_at, id)` 索引语义。**没有 `createdAt` 列**（§3.2 的 `ai_tasks` 不含它），
 * 所以回退项从 payload 取；`toTimestamptz` 把小数位归一到 3 位，ISO-8601 UTC 串的字典序
 * 与时序一致，这个 cast 因此是纯语义的，不引入时区偏移。
 *
 * `FOR UPDATE SKIP LOCKED`：两个 worker 同时扫队列时各领各的，谁也不等谁。少了
 * `SKIP LOCKED`，第二个 worker 会**阻塞**在第一个已锁的行上，等它提交后再读到一行
 * 已经变成 `CLAIMED` 的任务 —— 于是白跑一趟，而 `limit:1` 的语义变成"最多领到一个"。
 *
 * 谓词与 domain 的 `canClaimTask` 同调：只认 `state = 'QUEUED'`，且 `next_run_at` 为空或
 * 已到（`canClaimTask` 用 `nextRunAt > now` 拒绝，取反就是 `<= now`）。
 * `QUEUED → CLAIMED` 这条边在 `TASK_TRANSITIONS` 里恒存在，所以不需要在 SQL 里再判一次。
 */
export const AI_TASK_SELECT_DUE_FOR_CLAIM_SQL = `
SELECT ${AI_TASK_COLUMNS} FROM ai_tasks
WHERE state = 'QUEUED' AND (next_run_at IS NULL OR next_run_at <= $1::timestamptz)
ORDER BY COALESCE(next_run_at, (payload->>'createdAt')::timestamptz), id
LIMIT $2
FOR UPDATE SKIP LOCKED`;

export const AI_TASK_LEASE_SET_SQL = `
UPDATE ai_tasks SET lease_owner = $2, lease_token = $3, lease_until = $4::timestamptz
WHERE id = $1`;

/**
 * 释放租约，**只匹配自己的 token**。
 *
 * §3.5 步骤 4 逐字：「本步结束按原端口释放，仅匹配自己的 token，不清别人租约。」
 * `AND lease_token = $2` 就是这条裁定：一个已经失租约的旧持有者来释放时，行上的 token
 * 早已换成新持有者的，`WHERE` 不成立、影响行数 0，新租约原封不动。少了这个条件，
 * 旧持有者的一次正常收尾会把新持有者的推进权抹掉。
 */
export const AI_TASK_LEASE_CLEAR_SQL = `
UPDATE ai_tasks SET lease_owner = NULL, lease_token = NULL, lease_until = NULL
WHERE id = $1 AND lease_token = $2`;

/**
 * 两个写句柄 —— 与它们各自的 SQL 常量放在一起，因为「这条语句该怎么判影响行数」是语句
 * 语义的一部分，拆到别处就会各自漂移。
 *
 * 两者都断言**恰好 1 行**，并因此都要求调用方**已经** `FOR UPDATE` 锁住了那一行、且
 * `expectedRevision` 就是刚刚从同一行读出来的那个。在这两个前提下影响行数不可能是 0；
 * 真的是 0 只有一种解释 —— 有东西绕过行锁改了库（或列与 payload 已分叉到 `taskFromRow`
 * 都没抓住）。那不是「输掉一次竞争」，重试也不会变好，所以报 `STORED_ROW_INCONSISTENT`
 * （对外 `INTERNAL_ERROR`、不可重试）而不是 `REVISION_CONFLICT`（409）。
 *
 * 「输掉竞争 ⇒ 返回 `null`」那条语义在**另一个**地方，即 `PostgresTaskRepository.save`：
 * 它不持锁，影响行数 0 是正常结果。两条路径刻意不共用一个包装。
 */
export async function casTaskEntity(
  tx: DatabaseTransaction,
  task: AiTask,
  expectedRevision: string,
): Promise<void> {
  const written = await tx.execute(AI_TASK_ENTITY_CAS_SQL, taskEntityCasParams(task, expectedRevision));
  if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
}

/** 写三列租约字段（`until` 传 `null` 即清空租约）。断言 1 行，理由同上。 */
export async function setTaskLease(
  tx: DatabaseTransaction,
  taskId: TaskId,
  owner: string | null,
  token: string | null,
  until: Timestamp | null,
): Promise<void> {
  const written = await tx.execute(AI_TASK_LEASE_SET_SQL, [
    taskId,
    owner,
    token,
    until === null ? null : toTimestamptz(until),
  ]);
  if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
}

/**
 * `task_events`：同事务追加安全事件并更新 task revision（§3.2）。
 *
 * 没有 `id` 列 —— `TaskEventId` 就是 `sequence` 的十进制串（`formatTaskEventId`），
 * 读回时由 `createTaskEvent` 重新派生。存两遍会让"哪一个是权威"变成每次读取都要回答的问题。
 */
export const TASK_EVENT_INSERT_SQL = `
INSERT INTO task_events(task_id, sequence, event_type, safe_payload, created_at)
VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`;

export function taskEventInsertParams(event: TaskEvent): readonly unknown[] {
  return [
    event.taskId,
    event.sequence.toString(),
    event.eventType,
    toJsonb(event.safePayload),
    toNullableTimestamptz(event.createdAt),
  ];
}

export const TASK_EVENT_COLUMNS = `task_id, sequence, event_type, safe_payload, created_at`;

/** 最后一条事件。`assertEventFollows` 只需要它，不需要整段历史。 */
export const TASK_EVENT_LAST_SQL = `
SELECT ${TASK_EVENT_COLUMNS} FROM task_events
WHERE task_id = $1 ORDER BY sequence DESC LIMIT 1`;

export const TASK_EVENT_LIST_SQL = `
SELECT ${TASK_EVENT_COLUMNS} FROM task_events WHERE task_id = $1 ORDER BY sequence ASC`;

export type TaskEventRow = {
  readonly task_id: string;
  readonly sequence: unknown;
  readonly event_type: string;
  readonly safe_payload: unknown;
  readonly created_at: unknown;
};

/**
 * 行 → `TaskEvent`。
 *
 * `safePayload` 走 `createSafeEventPayload`（在 `createTaskEvent` 内部）而不是原样返回：
 * 那个构造器会按 `FORBIDDEN_SAFE_KEY_PATTERN` 拒绝 `prompt` / `stack` / `authorization`
 * 一类键名。读回来再验一次不是多余 —— 「写进去时验过」的前提是**所有**写入都走了
 * `EncryptedSecretStore` 那样的受控路径，而 §3.1 的一致性检查存在的理由恰恰是不假设这一点。
 */
export function taskEventFromRow(row: TaskEventRow): TaskEvent {
  return createTaskEvent({
    taskId: fromTextColumn(row.task_id),
    sequence: fromBigIntColumn(row.sequence),
    eventType: fromTextColumn(row.event_type),
    safePayload: fromJsonObject(row.safe_payload),
    createdAt: fromTimestamptz(row.created_at),
  });
}

/** 一行 task 被锁住之后能拿到的全部事实。 */
export interface LockedTask {
  readonly task: AiTask;
  readonly lease: TaskLease | null;
  readonly owner: string | null;
}

/**
 * 锁住并解码一行 task —— 三个 task 驱动（`PostgresTaskRepository` /
 * `PostgresTaskPumpStore` / `PostgresTaskUnitOfWork`）共用这一个入口。
 *
 * 共用不是为了省几行，而是为了**锁顺序**只有一种写法：本层一律先锁 `ai_tasks` 再锁
 * `task_private`（`lockPrivateState`），与 `createTurn` 的 INSERT 顺序一致。两个事务
 * 以相反的顺序锁同两行就是死锁，而 Postgres 的死锁检测只会挑一个牺牲品回滚 ——
 * 表现出来是一次随机的 `REVISION_CONFLICT`，谁都查不出原因。
 *
 * `FOR UPDATE` 是这一层的全部价值：它把「读到什么」和「改到什么」变成同一个事实。
 * 返回 `null` **只**表示行不存在；能不能领取、能不能接管、该不该 coalesce 一律留给
 * domain 谓词与 `TASK_ACQUIRE_DECISION_ORDER`，这里一条都不判。
 */
export async function lockTask(tx: DatabaseTransaction, taskId: TaskId): Promise<LockedTask | null> {
  const rows = await tx.query<AiTaskRow>(AI_TASK_SELECT_BY_ID_FOR_UPDATE_SQL, [taskId]);
  const [row] = rows;
  if (row === undefined) return null;
  return { task: taskFromRow(row), lease: leaseFromRow(row), owner: row.lease_owner };
}

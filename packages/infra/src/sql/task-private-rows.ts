import { brand, parseTimestamp, type TaskId } from '@littleq/domain';
import {
  createCollectionCursor,
  createTaskInputRef,
  createTaskPrivateRecord,
  type CollectionCursor,
  type OperationJournalEntry,
  type OperationReceipt,
  type ProviderIdentitySnapshot,
  type TaskInputRef,
  type TaskPrivateRecord,
} from '@littleq/application';

import { infraError } from '../errors.js';
import type { DatabaseTransaction } from '../ports/database-adapter.js';
import { fromJsonObject, fromNullableTextColumn, fromTextColumn, toJsonb } from './rows.js';

/**
 * `task_private` 的行 ↔ 记录编解码（ZLQ-216 §3.2、§3.5）。
 *
 * ## 这张表为什么**没有**一致性检查
 *
 * `ai_tasks` 是"payload 权威 + 派生列"，所以读的时候要比对两者。`task_private` 不是：
 * 它的每一列都是**唯一的**存放处（`internal_subphase` 没有第二份，`operation_journal`
 * 没有派生列）。没有两个来源就没有"哪个为准"的问题，硬加一次比对只会造出一个
 * 永远为真的断言 —— 那是把门禁做成装饰。
 *
 * 唯一被比对的是 `task_id`：它同时是 `ai_tasks` 的外键与本表主键，分叉意味着这一行
 * 挂到了别的任务上，而 §3.5 明令 `privateState`「只写本 task」。
 *
 * ## `scan_checkpoint` / `scan_failure` 为什么只做形状断言、不做内容验证
 *
 * 验证 checkpoint 是**扫描器**的职责，而且它有专门的错误码（`CHECKPOINT_INVALID`）与
 * 专门的处置（§5.2：`INTERNAL/INTERNAL_ERROR → BLOCKED`）。本层若先验一遍，就有两套
 * 判据；两套判据一旦宽严不同，宽的那套永远不生效，严的那套会把一个扫描器本想亲自拒绝
 * 并据此 `BLOCKED` 的 checkpoint 变成 infra 的 `STORED_ROW_INCONSISTENT` —— 而后者是
 * **不可重试**的，任务不会走到 `BLOCKED`，学生会看到一个没有解释的内部错误。
 *
 * §5.4 的冷实例路径也要求这一点：「冷实例先用同一 `StartScanInput` 再 `start` 注册，
 * 旧 checkpoint `step`」—— checkpoint 必须**原样**交到扫描器手里。
 */

export const TASK_PRIVATE_COLUMNS = `task_id, input_ref, qca_session_id, qca_event_cursor,
  round_boundary, internal_subphase, operation_journal, collection_cursor,
  scan_checkpoint, scan_failure, input_snapshot`;

export type TaskPrivateRow = {
  readonly task_id: string;
  readonly input_ref: unknown;
  readonly qca_session_id: string | null;
  readonly qca_event_cursor: string | null;
  readonly round_boundary: string | null;
  readonly internal_subphase: string;
  readonly operation_journal: unknown;
  readonly collection_cursor: unknown;
  readonly scan_checkpoint: unknown;
  readonly scan_failure: unknown;
  readonly input_snapshot: unknown;
};

export function taskPrivateFromRow(row: TaskPrivateRow): TaskPrivateRecord {
  const record = createTaskPrivateRecord({
    taskId: row.task_id,
    inputRef: inputRefFromJson(row.input_ref),
    qcaSessionId: fromNullableTextColumn(row.qca_session_id),
    qcaEventCursor: fromNullableTextColumn(row.qca_event_cursor),
    roundBoundary: fromNullableTextColumn(row.round_boundary),
    internalSubphase: fromTextColumn(row.internal_subphase),
    operationJournal: journalFromJson(row.operation_journal),
    collectionCursor: collectionCursorFromJson(row.collection_cursor),
    scanCheckpoint: nullableObject(row.scan_checkpoint) as TaskPrivateRecord['scanCheckpoint'],
    scanFailure: nullableObject(row.scan_failure) as TaskPrivateRecord['scanFailure'],
    inputSnapshot: fromJsonObject(row.input_snapshot) as TaskPrivateRecord['inputSnapshot'],
  });
  if (String(record.taskId) !== row.task_id) throw infraError('STORED_ROW_INCONSISTENT');
  return record;
}

export const TASK_PRIVATE_SELECT_BY_TASK_ID_SQL = `
SELECT ${TASK_PRIVATE_COLUMNS} FROM task_private WHERE task_id = $1`;

/** §3.5：`privateState` 句柄「事务同时**锁定**该 task_private 行」。 */
export const TASK_PRIVATE_SELECT_FOR_UPDATE_SQL = `
SELECT ${TASK_PRIVATE_COLUMNS} FROM task_private WHERE task_id = $1 FOR UPDATE`;

export const TASK_PRIVATE_INSERT_SQL = `
INSERT INTO task_private(
  task_id, input_ref, qca_session_id, qca_event_cursor, round_boundary, internal_subphase,
  operation_journal, collection_cursor, scan_checkpoint, scan_failure, input_snapshot
) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)`;

/**
 * 整行覆盖。
 *
 * 不是"合并式 UPDATE"（`SET operation_journal = $x || operation_journal` 那种）：
 * §3.5 要求的是「读取最新 journal 并保留已有不可变回执，再合并本步 checkpoint/subphase，
 * **不能拿外呼前旧快照覆盖新回执**」。那条规则的实现位置是**调用方在同一事务里先
 * `SELECT … FOR UPDATE` 再合并**，不是把合并下推给 SQL。下推会让"合并结果是什么"
 * 变成一段没有测试能覆盖的 jsonb 表达式，而先锁后读再整行写，合并逻辑就落在
 * TypeScript 里、被单元测试钉住。
 *
 * 行锁保证了整行覆盖是安全的：同一事务内没有第二个写者能看到中间态。
 */
export const TASK_PRIVATE_UPDATE_SQL = `
UPDATE task_private SET
  input_ref = $2::jsonb,
  qca_session_id = $3,
  qca_event_cursor = $4,
  round_boundary = $5,
  internal_subphase = $6,
  operation_journal = $7::jsonb,
  collection_cursor = $8::jsonb,
  scan_checkpoint = $9::jsonb,
  scan_failure = $10::jsonb,
  input_snapshot = $11::jsonb
WHERE task_id = $1`;

export function taskPrivateParams(record: TaskPrivateRecord): readonly unknown[] {
  return [
    record.taskId,
    toJsonb(record.inputRef),
    record.qcaSessionId,
    record.qcaEventCursor,
    record.roundBoundary,
    record.internalSubphase,
    toJsonb(record.operationJournal),
    toJsonb(record.collectionCursor),
    toJsonb(record.scanCheckpoint),
    toJsonb(record.scanFailure),
    toJsonb(record.inputSnapshot),
  ];
}

/**
 * **只**写 `operation_journal` 一列 —— `TaskPumpStore.recordReceipt` 专用。
 *
 * 整行 UPDATE 也能表达同一次写入（读出来的其余字段原样写回去），但 §3.5 对补记回执的
 * 要求是「**不修改 task/revision/checkpoint**」。用一条只碰一列的语句，这条保证就从
 * "论证出来的"变成"读一眼就能看见的"：`scan_checkpoint` / `internal_subphase` /
 * `collection_cursor` 根本不在语句里，于是不可能被写坏，也不需要靠"jsonb 往返是否
 * 逐字节相同"这种论证来兜底。
 *
 * 与整行 UPDATE 一样，安全性来自行锁：调用方必须在同一事务里先 `FOR UPDATE`。
 */
export const TASK_PRIVATE_UPDATE_JOURNAL_SQL = `
UPDATE task_private SET operation_journal = $2::jsonb WHERE task_id = $1`;

/**
 * 锁住并解码一行 `task_private`。
 *
 * 与 `lockTask`（`task-rows.ts`）配成一对，锁顺序固定为「先 task 后 private」—— 理由写在
 * `lockTask` 的注释里，一句话：两个事务以相反顺序锁同两行就是死锁，而死锁的表现形式是
 * 一次随机的 `REVISION_CONFLICT`。
 *
 * 行不存在时报 `STORED_ROW_INCONSISTENT` 而不是返回 `null`：`createTurn` 在同一个事务里
 * INSERT 这两行（§3.5「再 INSERT task/private/reservation」），所以「有 task 行而没有
 * private 行」不是"还没建好"，是有人绕过装配端口写过库。返回 `null` 会让调用方去猜
 * 该不该新建一份 private —— 而新建的那一份 `operationJournal` 是空的，等于把别的持有者
 * 刚补记进来的回执抹掉，正是 §3.5「不能拿外呼前旧快照覆盖新回执」要防的事。
 */
export async function lockPrivateState(
  tx: DatabaseTransaction,
  taskId: TaskId,
): Promise<TaskPrivateRecord> {
  const rows = await tx.query<TaskPrivateRow>(TASK_PRIVATE_SELECT_FOR_UPDATE_SQL, [taskId]);
  const [row] = rows;
  if (row === undefined) throw infraError('STORED_ROW_INCONSISTENT');
  return taskPrivateFromRow(row);
}

/** 不锁的读取版；`TaskTransactionPrivateState.findByTaskId` 用它（端口签名允许 `null`）。 */
export async function readPrivateState(
  tx: DatabaseTransaction,
  taskId: TaskId,
): Promise<TaskPrivateRecord | null> {
  const rows = await tx.query<TaskPrivateRow>(TASK_PRIVATE_SELECT_BY_TASK_ID_SQL, [taskId]);
  const [row] = rows;
  return row === undefined ? null : taskPrivateFromRow(row);
}

function inputRefFromJson(value: unknown): TaskInputRef {
  const raw = fromJsonObject(value);
  return createTaskInputRef({
    objectRef: fromTextColumn(raw.objectRef),
    sha256: fromTextColumn(raw.sha256),
    byteLength: numberOf(raw.byteLength),
  });
}

function collectionCursorFromJson(value: unknown): CollectionCursor {
  const raw = fromJsonObject(value);
  const sealed = raw.sealedPaths;
  if (!Array.isArray(sealed)) throw infraError('STORED_ROW_INCONSISTENT');
  return createCollectionCursor({
    artifactSha256: fromTextColumn(raw.artifactSha256),
    sealedPaths: sealed.map((path) => fromTextColumn(path)),
  });
}

/**
 * journal 的每一项都重新过一遍构造器。
 *
 * `operationKey` 是 branded string，运行时就是普通字符串，所以 `brand` 足够；但
 * `recordedAt` 必须走 `parseTimestamp` —— 一个被手工改成 `'昨天'` 的时间戳若原样回到
 * 用例手里，§5.3 的"payload 不因重开/当前时间/随机重新变动"就无法判定。
 */
function journalFromJson(value: unknown): readonly OperationJournalEntry[] {
  const raw = value;
  if (!Array.isArray(raw)) throw infraError('STORED_ROW_INCONSISTENT');
  return raw.map((item) => {
    const entry = fromJsonObject(item);
    const providerSnapshot = fromJsonObject(entry.providerSnapshot);
    return {
      operationKey: brand<string, 'JournalOperationKey'>(fromTextColumn(entry.operationKey)),
      requestHash: fromTextColumn(entry.requestHash),
      externalKey: fromTextColumn(entry.externalKey),
      providerSnapshot: {
        identityId: fromTextColumn(providerSnapshot.identityId),
        templateId: fromTextColumn(providerSnapshot.templateId),
        environmentId: fromTextColumn(providerSnapshot.environmentId),
        templateVersion: fromTextColumn(providerSnapshot.templateVersion),
      } satisfies ProviderIdentitySnapshot,
      intent: intentOf(entry.intent),
      receipt: entry.receipt === null ? null : receiptOf(entry.receipt),
      recordedAt: parseTimestamp(fromTextColumn(entry.recordedAt)),
    } satisfies OperationJournalEntry;
  });
}

function intentOf(value: unknown): OperationJournalEntry['intent'] {
  const text = fromTextColumn(value);
  if (text !== 'INTENDED' && text !== 'SENT' && text !== 'RECEIPT_RECORDED') {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  return text;
}

function receiptOf(value: unknown): OperationReceipt {
  const raw = fromJsonObject(value);
  const receipt: Record<string, string> = {};
  for (const key of Object.keys(raw)) receipt[key] = fromTextColumn(raw[key]);
  return receipt;
}

function nullableObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return fromJsonObject(value);
}

function numberOf(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw infraError('STORED_ROW_INCONSISTENT');
  return parsed;
}

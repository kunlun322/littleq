import {
  DomainError,
  TASK_TRANSITIONS,
  activeWriteConflictError,
  assertProjectWritable,
  compareRevisions,
  createProject,
  isLeaseExpired,
  nextRevision,
  parseTaskId,
  type AiTask,
  type Project,
  type ProjectId,
  type ProjectVersion,
  type Revision,
  type TaskId,
  type Timestamp,
  type UsageLedgerEntry,
  type UsageReservation,
} from '@littleq/domain';
import {
  createTaskPrivateRecord,
  type CreateTurnInput,
  type CreateTurnResult,
  type OperationJournalEntry,
  type TaskPrivateRecord,
  type TaskRunInput,
  type TaskTransaction,
  type TaskTransactionPrivateState,
  type TaskTransactionProjects,
  type TaskTransactionReservations,
  type TaskTransactionTasks,
  type TaskTransactionVersions,
  type TaskUnitOfWork,
} from '@littleq/application';

import { infraError } from '../errors.js';
import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';
import { uniqueViolationConstraint } from './client.js';
import {
  PROJECT_CAS_SQL,
  PROJECT_SELECT_BY_ID_FOR_UPDATE_SQL,
  PROJECT_SELECT_BY_ID_SQL,
  VERSION_INSERT_SQL,
  VERSION_SELECT_BY_ID_SQL,
  VERSION_SELECT_BY_SOURCE_TASK_ID_SQL,
  projectCasParams,
  projectFromRow,
  versionFromRow,
  versionInsertParams,
  type ProjectRow,
  type VersionRow,
} from './project-rows.js';
import { fromNullableTextColumn, fromRevisionColumn, fromTimestamptz, toJsonb } from './rows.js';
import { PostgresTaskRepository } from './task-repository.js';
import {
  TASK_PRIVATE_INSERT_SQL,
  TASK_PRIVATE_UPDATE_SQL,
  lockPrivateState,
  readPrivateState,
  taskPrivateParams,
} from './task-private-rows.js';
import {
  AI_TASK_INSERT_SQL,
  AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX,
  AI_TASK_SELECT_ACTIVE_STATE_BY_PROJECT_SQL,
  AI_TASK_SELECT_BY_IDEMPOTENCY_KEY_SQL,
  lockTask,
  taskInsertParams,
  type AiTaskRow,
  type LockedTask,
} from './task-rows.js';
import {
  USAGE_LEDGER_INSERT_SQL,
  USAGE_RESERVATION_INSERT_SQL,
  USAGE_RESERVATION_SELECT_BY_TASK_SQL,
  USAGE_RESERVATION_SETTLE_SQL,
  assertSettleable,
  ledgerInsertParams,
  reservationFromRow,
  reservationInsertParams,
  type UsageReservationRow,
} from './usage-rows.js';

/**
 * 装配端口 2／2 的真实实现：把"一次推进"变成**一个事务**（ZLQ-216 §3.5）。
 *
 * ## 为什么这个类**没有** `bound(tx)`
 *
 * 其余每个 SQL 驱动都是 `of(db)` / `bound(tx)` 两个工厂（见 `sql/executor.ts`），因为
 * 它们既能自己开一个短事务，也能被装配端口圈进一个更大的事务。`TaskUnitOfWork` 反过来：
 * 它**就是**那个更大的事务。给它一个 `bound(tx)` 等于允许把 `createTurn` 塞进别人的事务
 * 里 —— 而 `run` 的全部保证（回调抛错就回滚、CAS 失配就回滚）建立在自己掌握
 * `BEGIN`/`COMMIT` 之上。嵌进外层事务之后，"回滚"只能回滚到外层的 savepoint（端口没有
 * savepoint），或者把外层一起回滚掉（调用方没同意）。两种都不是本端口承诺的语义，
 * 所以构造器只接受 `DatabaseAdapter`，结构上没有第二种用法。
 *
 * ## 三处按字面实现 §3.5 的地方，和它们各自防的故障
 *
 * 1. **`run` 用 DB 时钟，而且用 `clock_timestamp()` 不是 `now()`。**
 *    `now()` 是**事务开始**时刻，在同一个事务里恒定；用它做「最终写入再检查到期」
 *    会让那次检查与开头那次逐字相同 —— 一个永远为真的门禁。`clock_timestamp()` 才
 *    反映事务真实跑掉的时长，于是"一个短事务跑过了租约 TTL"这件事在提交前被抓到。
 * 2. **最终校验用「事务内最后一次实际返回的 revision」**，不是入参那个。
 *    `appendEvent` 自己也推进 revision，所以"保存 task → 追加 COMPLETED 事件"之后手里的
 *    revision 已经比入参大两格。`#latest` 由三个 CAS 方法逐次覆盖，就是为了这个。
 * 3. **`createTurn` 的查重在 CAS 之前。** 反过来做的话，同一个 key 的并发重放会先各自把
 *    project revision 推一格，然后其中一个 CAS 失败 —— 客户端看到 409，而正确的回答是
 *    "这就是你上一次那个 task"。
 *
 * ## 一处必须申报的解释：`accepted_project_revision` 存**受理后**的 revision
 *
 * §3.5 只说「原受理 project revision 存 `accepted_project_revision`，回放不取后来变动的
 * revision」，没有钉死"受理前"还是"受理后"。本实现取**受理后**（`nextRevision`），
 * 理由是两种读法都满足那句话的字面，而只有一种能让 API 自洽：受理会把项目 revision 从
 * R 推到 R+1，若返回 R，客户端拿到的 ETag 立刻就是过期的，下一次 `If-Match: rev-R`
 * 必然 409。取 R+1 则「回放不取后来变动的 revision」这条仍然成立 —— 存下来的值不随
 * 项目后续推进而变。交付评论里已列明，供架构师裁定。
 */

/** DB 时钟。`clock_timestamp()` 而非 `now()`，理由见文件头第 1 条。 */
const DB_CLOCK_SQL = `SELECT clock_timestamp() AS db_now`;

export class PostgresTaskUnitOfWork implements TaskUnitOfWork {
  readonly #db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.#db = db;
  }

  async createTurn(input: CreateTurnInput): Promise<CreateTurnResult> {
    assertInputRefConsistent(input);
    return this.#db.transaction(async (tx) => {
      const project = await lockProject(tx, input.projectId);

      // 查重**先于**一切判据：同 key 同 hash 要回放原受理结果，而同 hash 的第二次请求
      // 携带的 `expectedProjectRevision` 几乎必然是过期的（第一次受理已经推进了它）。
      // 先比 revision 就会把一次合法的幂等重试报成 409。
      const replay = await replayAcceptedTurn(tx, input);
      if (replay !== null) return replay;

      // 可写判定**先于** revision 比较：已删除的项目对外表现为不存在（§5.3），
      // 先报 409 等于承认"这个项目存在，只是你的版本号旧了"。
      assertProjectWritable(project);
      if (compareRevisions(project.revision, input.expectedProjectRevision) !== 0) {
        throw revisionConflict('Project.revision');
      }
      await assertNoActiveTask(tx, project.id);

      const acceptedRevision = nextRevision(project.revision);
      await insertTask(tx, input, acceptedRevision);
      await insertPrivateState(tx, input.privateState);
      await insertReservation(tx, input.reservation);
      await casProjectOnAccept(tx, project, acceptedRevision, input.now);

      return { taskId: input.task.id, revision: acceptedRevision };
    });
  }

  async run<T>(input: TaskRunInput, work: (bound: TaskTransaction) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      const startedAt = await dbClock(tx);
      const locked = await lockTask(tx, input.lease.taskId);
      if (locked === null) throw infraError('TASK_NOT_FOUND');
      assertLeaseHeld(locked, input.lease, startedAt);
      if (compareRevisions(locked.task.revision, input.expectedRevision) !== 0) {
        throw revisionConflict('AiTask.revision');
      }

      const latest: LatestRevision = { revision: locked.task.revision };
      const result = await work(bindTransactionHandles(tx, latest));

      // 「最终写入再检查 token/到期」+「使用事务内最后一次实际返回的 revision」。
      // 行锁从开头一直握到这里，所以别的持有者改不动这一行；能被这两次检查抓到的只有
      // 两种真故障：回调自己把租约释放了，以及事务跑过了 `lease_until`。
      const finishedAt = await dbClock(tx);
      const final = await lockTask(tx, input.lease.taskId);
      if (final === null) throw infraError('TASK_NOT_FOUND');
      assertLeaseHeld(final, input.lease, finishedAt);
      if (compareRevisions(final.task.revision, latest.revision) !== 0) {
        throw revisionConflict('AiTask.revision');
      }
      return result;
    });
  }
}

/** 事务内**最后一次实际返回**的 task revision（§3.5）。可变是刻意的：它是累加器。 */
type LatestRevision = { revision: Revision };

function bindTransactionHandles(
  tx: DatabaseTransaction,
  latest: LatestRevision,
): TaskTransaction {
  return {
    tasks: bindTasks(tx, latest),
    projects: bindProjects(tx),
    versions: bindVersions(tx),
    privateState: bindPrivateState(tx),
    reservations: bindReservations(tx),
  };
}

/**
 * `tasks` 句柄 = 冻结的 `PostgresTaskRepository` 绑在同一个事务上，外加两条 §3.5 规则。
 *
 * - 三个**实体 CAS** 方法（`save` / `appendEvent` / `scheduleNextRun`）返回 `null` 就抛
 *   `REVISION_CONFLICT`，从而回滚整事务（§3.5：「任一 CAS 返回 `null` 均回滚，向用例
 *   返回既有 `REVISION_CONFLICT`」）。
 * - 它们的非 `null` 结果逐次覆盖 `latest`，供 `run` 的最终校验使用。
 *
 * 四个租约方法**不**参与这两条：`renewLease` / `reacquireLease` 返回 `null` 是一条
 * 信息（"你续不上了"），把它变成回滚会让"续不上就把手里这一步收尾"无法表达；而它们
 * 只写三列租约字段、不动 `revision`，所以也不影响 `latest`。租约是否仍然有效由 `run`
 * 的最终检查统一裁定，不在这里各判一次。
 */
function bindTasks(tx: DatabaseTransaction, latest: LatestRevision): TaskTransactionTasks {
  const repo = PostgresTaskRepository.bound(tx);
  return {
    claim: (claimInput) => repo.claim(claimInput),
    renewLease: (renewInput) => repo.renewLease(renewInput),
    reacquireLease: (reacquireInput) => repo.reacquireLease(reacquireInput),
    requeueOnLeaseExpiry: (requeueInput) => repo.requeueOnLeaseExpiry(requeueInput),
    releaseLease: (releaseInput) => repo.releaseLease(releaseInput),
    findById: (taskId) => repo.findById(taskId),
    save: async (saveInput) => track(await repo.save(saveInput), latest),
    appendEvent: async (eventInput) => track(await repo.appendEvent(eventInput), latest),
    scheduleNextRun: async (scheduleInput) =>
      track(await repo.scheduleNextRun(scheduleInput), latest),
  };
}

function track(task: AiTask | null, latest: LatestRevision): AiTask {
  if (task === null) throw revisionConflict('AiTask.revision');
  latest.revision = task.revision;
  return task;
}

function bindProjects(tx: DatabaseTransaction): TaskTransactionProjects {
  return {
    async findById(id: ProjectId): Promise<Project | null> {
      const rows = await tx.query<ProjectRow>(PROJECT_SELECT_BY_ID_SQL, [id]);
      const [row] = rows;
      return row === undefined ? null : projectFromRow(row);
    },
    async save(input: {
      readonly project: Project;
      readonly expectedRevision: Revision;
    }): Promise<Project | null> {
      // §3.5「提交前确认 `currentVersionId` 属于同项目」。`projects.current_version_id`
      // 与 `versions.project_id` 之间没有 FK 能表达这条（两列都 nullable、versions 后建），
      // 所以它只能是这里的一次断言；`PROJECT_CAS_SQL` 的注释已说明为什么不是 SQL 约束。
      await assertCurrentVersionBelongsToProject(tx, input.project);
      const written = await tx.execute(
        PROJECT_CAS_SQL,
        projectCasParams(input.project, input.expectedRevision),
      );
      return written === 1 ? input.project : null;
    },
  };
}

function bindVersions(tx: DatabaseTransaction): TaskTransactionVersions {
  return {
    async findById(id) {
      const rows = await tx.query<VersionRow>(VERSION_SELECT_BY_ID_SQL, [id]);
      const [row] = rows;
      return row === undefined ? null : versionFromRow(row);
    },
    async findBySourceTaskId(taskId) {
      const rows = await tx.query<VersionRow>(VERSION_SELECT_BY_SOURCE_TASK_ID_SQL, [taskId]);
      const [row] = rows;
      return row === undefined ? null : versionFromRow(row);
    },
    async insert(version: ProjectVersion): Promise<ProjectVersion> {
      // `UNIQUE(source_task_id)` / `UNIQUE(project_id, sequence)` 撞了就让 23505 冒出去：
      // §3.5 规定重入**先**用 `findBySourceTaskId` 读既有版本，走到 `insert` 说明调用方
      // 跳过了那一步。把它翻译成 `REVISION_CONFLICT` 会让"你漏了重入检查"与"你输了一次
      // 并发竞争"在日志里长成同一个样子，而前者是 F2 用例的 bug。
      const written = await tx.execute(VERSION_INSERT_SQL, versionInsertParams(version));
      if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
      return version;
    },
  };
}

function bindPrivateState(tx: DatabaseTransaction): TaskTransactionPrivateState {
  return {
    findByTaskId: (taskId) => readPrivateState(tx, taskId),
    async save(record: TaskPrivateRecord): Promise<void> {
      // 先锁再合并：§3.5「不能拿外呼前旧快照覆盖新回执」。锁保证了"读到的 journal"
      // 与"写回的 journal"之间没有第二个写者。
      const stored = await lockPrivateState(tx, record.taskId);
      const merged = mergeJournal(stored, record);
      const written = await tx.execute(TASK_PRIVATE_UPDATE_SQL, taskPrivateParams(merged));
      if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
    },
  };
}

/**
 * 合并 journal：**已落定的回执不可被覆盖**，其余以调用方传入的本步状态为准。
 *
 * 三条规则，各防一件具体的事：
 *
 * - 传入快照里**没有**的项一律保留。那些是外呼之后由 `recordReceipt` 补记进来的，
 *   而调用方手里的快照是外呼**之前**读的 —— 丢弃它就是 §3.5 明令禁止的那件事。
 * - 传入快照里有、且库里那项已经 `RECEIPT_RECORDED`：保留库里的。回执是不可变事实，
 *   "我又发了一次同样的请求"不能把它改回 `SENT`。
 * - 其余（`INTENDED` / `SENT`）用传入的覆盖，本步的推进才写得进去；传入快照里全新的
 *   项追加到末尾。
 *
 * 结果重新过一遍 `createTaskPrivateRecord`：它会在 `operationKey` 重复时抛错。合并逻辑
 * 若把同一 key 追加了两遍，那是一次静默的数据损坏，构造器让它当场炸。
 */
function mergeJournal(
  stored: TaskPrivateRecord,
  incoming: TaskPrivateRecord,
): TaskPrivateRecord {
  const byKey = new Map<string, OperationJournalEntry>(
    incoming.operationJournal.map((entry) => [String(entry.operationKey), entry]),
  );
  const storedKeys = new Set<string>(stored.operationJournal.map((e) => String(e.operationKey)));
  const kept: OperationJournalEntry[] = stored.operationJournal.map((entry) => {
    const next = byKey.get(String(entry.operationKey));
    if (next === undefined) return entry;
    return entry.intent === 'RECEIPT_RECORDED' ? entry : next;
  });
  const appended = incoming.operationJournal.filter(
    (entry) => !storedKeys.has(String(entry.operationKey)),
  );
  return createTaskPrivateRecord({ ...incoming, operationJournal: [...kept, ...appended] });
}

function bindReservations(tx: DatabaseTransaction): TaskTransactionReservations {
  return {
    async reserve(reservation: UsageReservation): Promise<void> {
      const written = await tx.execute(
        USAGE_RESERVATION_INSERT_SQL,
        reservationInsertParams(reservation),
      );
      if (written === 1) return;
      // `ON CONFLICT (task_id, capability) DO NOTHING` ⇒ 已经有一行了。「重复同事实幂等」
      // 的前提是**同事实**：额度不同的两条预留撞在同一个键上不是幂等，是两笔账争一个位置，
      // 静默放过会让学生的额度按先到的那条扣、而任务以为自己预留了另一条。
      const stored = await readReservation(tx, reservation.taskId, reservation.capability);
      if (stored === null || !sameReservation(stored, reservation)) {
        throw revisionConflict('UsageReservation.reservedUnits');
      }
    },
    async settle(input: {
      readonly reservation: UsageReservation;
      readonly ledger: UsageLedgerEntry;
    }): Promise<void> {
      assertSettleable(input.reservation);
      const written = await tx.execute(USAGE_RESERVATION_SETTLE_SQL, [
        input.reservation.id,
        input.reservation.taskId,
        input.reservation.state,
        toJsonb(input.reservation),
      ]);
      if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
      // `ON CONFLICT (event_key) DO NOTHING`：重入的提交事务再结算一次是**成功**而不是
      // 报错（§5.2 的 `COMMITTING` 可重入）。第二行写不进去，第一行原样留着。
      await tx.execute(USAGE_LEDGER_INSERT_SQL, ledgerInsertParams(input.ledger));
    },
  };
}

async function readReservation(
  tx: DatabaseTransaction,
  taskId: TaskId,
  capability: UsageReservation['capability'],
): Promise<UsageReservation | null> {
  const rows = await tx.query<UsageReservationRow>(USAGE_RESERVATION_SELECT_BY_TASK_SQL, [
    taskId,
    capability,
  ]);
  const [row] = rows;
  return row === undefined ? null : reservationFromRow(row);
}

function sameReservation(left: UsageReservation, right: UsageReservation): boolean {
  return (
    left.id === right.id &&
    left.taskId === right.taskId &&
    left.subjectUserId === right.subjectUserId &&
    left.capability === right.capability &&
    left.reservedUnits === right.reservedUnits &&
    left.state === right.state &&
    left.expiresAt === right.expiresAt
  );
}

async function dbClock(tx: DatabaseTransaction): Promise<Timestamp> {
  const rows = await tx.query<{ readonly db_now: unknown }>(DB_CLOCK_SQL, []);
  const [row] = rows;
  if (row === undefined) throw infraError('STORED_ROW_INCONSISTENT');
  return fromTimestamptz(row.db_now);
}

/**
 * 核验"我仍然是这一行的租约持有者，而且租约还没到期"。
 *
 * 三处失败一律映射到 `REVISION_CONFLICT`：§3.5 只给了这一个用例可见的失败码
 * （「回调抛错或任一 CAS 返回 `null` 均回滚，向用例返回既有 `REVISION_CONFLICT`」），
 * 而"租约被别人接管"与"revision 被别人推进"对用户是同一件事 —— 你的这一次推进不算数，
 * 重新读一遍再来。分开报会在 401/403/409 之间制造一个可被枚举的差异，而 §4.1 要求
 * 别人的 task 一律 404、不含对象细节。
 */
function assertLeaseHeld(
  locked: LockedTask,
  lease: TaskRunInput['lease'],
  now: Timestamp,
): void {
  const held = locked.lease;
  if (held === null || held.leaseToken !== lease.leaseToken) {
    throw revisionConflict('TaskLease.leaseToken');
  }
  if (isLeaseExpired(held.leaseUntil, now)) throw revisionConflict('TaskLease.leaseUntil');
}

async function lockProject(tx: DatabaseTransaction, projectId: ProjectId): Promise<Project> {
  const rows = await tx.query<ProjectRow>(PROJECT_SELECT_BY_ID_FOR_UPDATE_SQL, [projectId]);
  const [row] = rows;
  // 与 `assertProjectWritable` 对 `DELETED` 的处置一致：不存在与已删除都报 404，
  // 不让调用方靠错误码差异区分"没这个项目"和"这个项目被删了"。
  if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 'Project');
  return projectFromRow(row);
}

type IdempotentTaskRow = {
  readonly id: string;
  readonly request_hash: string | null;
  readonly accepted_project_revision: unknown;
};

/**
 * 同 `(project, idempotencyKey)` 已有受理记录时，回放**当初**的结果。
 *
 * `request_hash` 不同 ⇒ 既有 `IDEMPOTENCY_KEY_REUSED`：同一个 key 被拿去发第二个不同的
 * 请求，这不是重试，是键管理出了问题，静默回放第一个结果会让客户端以为第二个请求成功了。
 *
 * 库里的 `request_hash` 为 `NULL` 时也报 `IDEMPOTENCY_KEY_REUSED` 而不是回放：无法证明
 * "同一个请求"，而键已经被占用 —— 此时创建第二个任务会撞
 * `ai_tasks_project_idempotency_key`，回放一个证不出来的结果则可能把别人的任务当成自己的
 * 返回。两者里前者至少不会给出错误的所有权。
 */
async function replayAcceptedTurn(
  tx: DatabaseTransaction,
  input: CreateTurnInput,
): Promise<CreateTurnResult | null> {
  const rows = await tx.query<IdempotentTaskRow>(AI_TASK_SELECT_BY_IDEMPOTENCY_KEY_SQL, [
    input.projectId,
    input.idempotencyKey,
  ]);
  const [row] = rows;
  if (row === undefined) return null;
  if (fromNullableTextColumn(row.request_hash) !== input.requestHash) {
    throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'IdempotencyKey');
  }
  if (row.accepted_project_revision === null || row.accepted_project_revision === undefined) {
    // 这一行是本语句自己写的，`accepted_project_revision` 恒非空；为空说明有人绕过
    // `createTurn` 插过任务。回放一个猜出来的 revision 会让客户端拿到一个与库里不符的 ETag。
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  return {
    taskId: parseTaskId(row.id),
    revision: fromRevisionColumn(row.accepted_project_revision),
  };
}

/**
 * 「每项目至多一个在跑的任务」（§3.2 的部分唯一索引）在写入**之前**的判定。
 *
 * 判据刻意与索引同调 —— **任何**非终态任务都挡，而不只写任务。domain 的
 * `decideTaskAdmission` 把 `PUBLISH` / `RESCAN` 排除在"每项目 1 个写任务"之外
 * （`isWriteTaskKind`），而 §3.2 那条索引不区分 kind；两者在"发布中还能不能开新回合"上
 * 不一致。本实现按**索引**判，因为索引是 DDL 里的既成事实、也是唯一能在竞态下兜住的屏障，
 * 而让预检查比索引宽松只会把 409 推迟到 INSERT 那一刻。这处不一致已在交付评论里列明。
 */
async function assertNoActiveTask(tx: DatabaseTransaction, projectId: ProjectId): Promise<void> {
  const rows = await tx.query<AiTaskRow>(AI_TASK_SELECT_ACTIVE_STATE_BY_PROJECT_SQL, [
    projectId,
    [...TASK_TRANSITIONS.terminal],
  ]);
  if (rows.length > 0) throw activeWriteConflictError();
}

async function insertTask(
  tx: DatabaseTransaction,
  input: CreateTurnInput,
  acceptedRevision: Revision,
): Promise<void> {
  // 「无 TaskLease、不调用旧 `tasks.save` 冒充首次 INSERT」（§3.5 尾段）：三列租约字段
  // 一律 NULL。此时任务不属于任何 worker，铸一份租约等于凭空宣称有人在推进它。
  try {
    const written = await tx.execute(
      AI_TASK_INSERT_SQL,
      taskInsertParams(input.task, acceptedRevision, null),
    );
    if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
  } catch (error) {
    // §6.5 规则 4：条件唯一索引是最终竞态屏障，撞它必须翻译成**同一个**领域错误码，
    // 否则同一个用户可见结果会因为竞态胜负给出两种响应。撞主键不翻译 —— 那是调用方
    // 重复使用了 task id，属内部错误，报成 409 会让用户去重试一件永远不会成功的事。
    if (uniqueViolationConstraint(error) === AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX) {
      throw activeWriteConflictError();
    }
    throw error;
  }
}

async function insertPrivateState(
  tx: DatabaseTransaction,
  privateState: TaskPrivateRecord,
): Promise<void> {
  const written = await tx.execute(TASK_PRIVATE_INSERT_SQL, taskPrivateParams(privateState));
  if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
}

async function insertReservation(
  tx: DatabaseTransaction,
  reservation: UsageReservation,
): Promise<void> {
  const written = await tx.execute(
    USAGE_RESERVATION_INSERT_SQL,
    reservationInsertParams(reservation),
  );
  // 0 行只可能是 `ON CONFLICT (task_id, capability) DO NOTHING` 命中，而 task 是刚插进去的
  // 新 id ⇒ 命中就意味着这个 task id 上已经挂着一份别人的预留。放行会让任务按一份
  // 自己没申请过的额度跑。
  if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
}

/**
 * 受理时把项目 revision 推一格，并以**推之前**的 revision 作为 CAS 的 `WHERE`。
 *
 * 这一格是 If-Match 的屏障：两个并发 `createTurn` 携带同一个 `expectedProjectRevision`
 * 时，`SELECT … FOR UPDATE` 把它们串起来，第二个读到的已经是 R+1，于是在前面的
 * revision 比较处就得到 409，而不是两个任务都受理成功。
 *
 * 走 `createProject` 而不是对象展开：写进 `payload` 的必须是构造器认可的实体，
 * 而且它会顺带验 `updatedAt >= createdAt`（调用方给了一个早于项目创建时刻的 `now`
 * 时当场拒绝，而不是写进库里等下一次读取时炸）。
 */
async function casProjectOnAccept(
  tx: DatabaseTransaction,
  project: Project,
  acceptedRevision: Revision,
  now: Timestamp,
): Promise<void> {
  const accepted = createProject({
    ...project,
    revision: acceptedRevision,
    updatedAt: now,
  } as Parameters<typeof createProject>[0]);
  const written = await tx.execute(PROJECT_CAS_SQL, projectCasParams(accepted, project.revision));
  if (written !== 1) throw revisionConflict('Project.revision');
}

async function assertCurrentVersionBelongsToProject(
  tx: DatabaseTransaction,
  project: Project,
): Promise<void> {
  if (project.currentVersionId === null) return;
  const rows = await tx.query<VersionRow>(VERSION_SELECT_BY_ID_SQL, [project.currentVersionId]);
  const [row] = rows;
  if (row === undefined) throw DomainError.invalid('Project.currentVersionId');
  if (versionFromRow(row).projectId !== project.id) {
    throw DomainError.invalid('Project.currentVersionId');
  }
}

/**
 * `CreateTurnInput` 同时带 `inputRef` 与 `privateState`，而后者内部也有一个 `inputRef`
 * —— 一处冗余，来自 §3.5 的输入清单只有 `inputRef`、而 INSERT `task_private` 需要整条
 * 记录（本端口补上 `privateState` 时已申报）。
 *
 * 冗余本身不危险，**两份不一致**才危险：那意味着"存进 `task_private` 的输入指纹"与
 * "调用方声称的输入指纹"是两个东西，而 §5.4 的冷实例恢复要拿前者去重新定位对象。
 * 所以在开事务之前比一次，不一致按请求非法拒绝，而不是挑一份信。
 */
function assertInputRefConsistent(input: CreateTurnInput): void {
  const declared = input.inputRef;
  const stored = input.privateState.inputRef;
  if (
    declared.objectRef !== stored.objectRef ||
    declared.sha256 !== stored.sha256 ||
    declared.byteLength !== stored.byteLength
  ) {
    throw DomainError.invalid('TaskPrivateRecord.inputRef');
  }
  if (input.privateState.taskId !== input.task.id) {
    throw DomainError.invalid('TaskPrivateRecord.taskId');
  }
  if (input.reservation.taskId !== input.task.id) {
    throw DomainError.invalid('UsageReservation.taskId');
  }
  if (input.task.projectId !== input.projectId) {
    throw DomainError.invalid('AiTask.projectId');
  }
}

function revisionConflict(valueObject: string): DomainError {
  return new DomainError('REVISION_CONFLICT', valueObject);
}

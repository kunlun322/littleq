/**
 * `apps/api` 侧的**存储适配层**：把 `@littleq/application` 的读侧端口接到真 Postgres。
 *
 * ## 为什么这些实现落在组合根，而不是 `packages/infra`
 *
 * `packages/application/src/usecases/ports.ts` 的文件头已经把这条约束写死了：application
 * 不得 import infra（`tsc -b` 的项目引用会成环，因为 infra 反过来 `implements` 这些端口），
 * 而 infra 的 `exports` 只有 `.` 与 `./env`，`sql/*-rows.ts` 那套行编解码器**不在导出面上**。
 * 于是「怎么把一行 `projects` 读成 `Project`」这件事只能停在 `apps/api` —— 它是唯一同时
 * 看得见 infra 驱动与 application 端口的单元。
 *
 * ## 与 F1 写侧的**逐字对齐**要求
 *
 * `ai_tasks` / `task_private` / `task_events` / `usage_reservations` 这四张表的行**不是本文件
 * 写的**，是 `PostgresTaskUnitOfWork` 写的（`packages/infra/src/sql/task-unit-of-work.ts`）。
 * 本文件只读它们，所以读法必须与 F1 的 `task-rows.ts` / `usage-rows.ts` 逐字同调：
 * 列清单相同、`bigint` 走字符串、`payload` 交回 domain 构造器、逐列 `assertColumnMatches`。
 * 一处漂移的表现不是报错，而是「读回来一个 revision 与库不符的任务」，接着 CAS 永远失败。
 *
 * ## §3.1 的读法（每个实体都一样）
 *
 * `payload jsonb` 是**权威值**，派生列只服务唯一索引／队列扫描／CAS 的 `WHERE`。所以读一行
 * 是三步：payload 交回构造器（**验证**，不是解析）→ 逐列比对派生列（**一致性**）→ 返回重建
 * 出来的实体。不一致一律抛 `STORED_ROW_INCONSISTENT`（对外 `INTERNAL_ERROR`、不可重试）：
 * 那说明有人绕过仓储写过库，继续跑就会拿错的 revision 去 CAS。
 *
 * ## 所有读都包在 `transaction()` 里
 *
 * `DatabaseAdapter` 只有 `transaction` / `migrate` / `health` / `close` 四个方法，**没有**
 * 非事务的 query 入口。一次只读查询也走 `transaction()`：单语句事务在 Postgres 里与普通查询
 * 同价（没有额外的 `BEGIN` 往返开销可言，驱动会把它折成一次隐式事务），而换来的是"读到的
 * 一组行来自同一个快照"。
 */
import {
  TASK_TRANSITIONS,
  WRITE_TASK_KINDS,
  createAccountSession,
  createAiTask,
  createProject,
  createProjectVersion,
  createTaskEvent,
  createUser,
  createUsageReservation,
  parseLoginName,
  parseMaxFailedAttempts,
  parseLockDurationMinutes,
  parseNickname,
  parseRevision,
  parseTaskId,
  releaseUsage,
  type AccountLockPolicy,
  type AccountSession,
  type AiTask,
  type Capability,
  type Project,
  type ProjectId,
  type ProjectVersion,
  type ProjectVersionId,
  type TaskEvent,
  type TaskId,
  type Timestamp,
  type UsagePeriod,
  type UsageQuotaSnapshot,
  type UsageReservation,
  type User,
  type UserId,
} from '@littleq/domain';
import type {
  AccountDirectory,
  ListProjectsInput,
  ListVersionsInput,
  Page,
  PasswordCredentialRecord,
  ProjectDirectory,
  SessionDirectory,
  StoredAccount,
  StoredSession,
  TaskReadDirectory,
  TaskReservationReleaser,
  TurnAcceptanceRecord,
  UsageDirectory,
} from '@littleq/application';
import { infraError, type DatabaseAdapter, type DatabaseTransaction } from '@littleq/infra';

import {
  assertColumnMatches,
  assertPersistableRevision,
  fromBigIntColumn,
  fromBigintColumn,
  fromBytea,
  fromJsonObject,
  fromJsonString,
  fromNullableTimestamptz,
  fromRevisionColumn,
  fromTextColumn,
  fromTimestamptz,
  toBytea,
  toJsonb,
  toTimestamptz,
} from './rows.js';

/** 终态清单来自 domain，不在 SQL 里重抄：抄一遍就有了两个事实源。 */
const TERMINAL_TASK_STATES: readonly string[] = [...TASK_TRANSITIONS.terminal];
const WRITE_TASK_KIND_LIST: readonly string[] = [...WRITE_TASK_KINDS];

// ---------------------------------------------------------------------------
// users / password_credentials
// ---------------------------------------------------------------------------

const USER_COLUMNS = 'id, role, login_name, owner_id, age_band, status, revision, payload';

type UserRow = {
  readonly id: string;
  readonly role: string;
  readonly login_name: string;
  readonly owner_id: string | null;
  readonly age_band: string | null;
  readonly status: string;
  readonly revision: unknown;
  readonly payload: unknown;
};

/**
 * 从 `payload jsonb` 重建 `User`。
 *
 * `loginName` / `nickname` 与 `lockPolicy` 的两个整数在 domain 里是 **branded 值对象**，而
 * JSON 里只有裸字符串与裸数字 ⇒ 这四个值**显式重新解析**，不整块 `as`。整块断言会跳过
 * `parseLoginName` / `parseNickname` / `parseMaxFailedAttempts`，于是"payload 权威"退化成
 * "payload 里写什么就信什么"，而 payload 是库里可被绕过仓储改动的一列。
 */
function userFromPayload(payload: Record<string, unknown>): User {
  const rawLockPolicy = fromJsonObject(payload['lockPolicy']);
  const lockPolicy: AccountLockPolicy = {
    maxFailedAttempts: parseMaxFailedAttempts(fromBigintColumn(rawLockPolicy['maxFailedAttempts'])),
    lockDurationMinutes: parseLockDurationMinutes(
      fromBigintColumn(rawLockPolicy['lockDurationMinutes']),
    ),
  };
  const ageBand = payload['ageBand'];
  const ownerId = payload['ownerId'];
  return createUser({
    id: fromJsonString(payload['id']),
    role: fromJsonString(payload['role']),
    loginName: parseLoginName(fromJsonString(payload['loginName'])),
    nickname: parseNickname(fromJsonString(payload['nickname'])),
    ageBand: ageBand === null ? null : fromJsonString(ageBand),
    status: fromJsonString(payload['status']),
    ownerId: ownerId === null ? null : fromJsonString(ownerId),
    lockPolicy,
    revision: fromJsonString(payload['revision']),
  });
}

function userFromRow(row: UserRow): User {
  const user = userFromPayload(fromJsonObject(row.payload));
  assertColumnMatches(row.id, user.id);
  assertColumnMatches(row.role, user.role);
  assertColumnMatches(row.login_name, user.loginName);
  assertColumnMatches(row.owner_id, user.ownerId);
  assertColumnMatches(row.age_band, user.ageBand);
  assertColumnMatches(row.status, user.status);
  assertColumnMatches(fromRevisionColumn(row.revision), user.revision);
  return user;
}

/** §4.3 的判定键：`lower(login_name)`。参数由调用方传**已小写化**的键。 */
const USER_SELECT_BY_LOGIN_NAME_KEY_SQL = `
SELECT ${USER_COLUMNS} FROM users WHERE lower(login_name) = $1`;

const USER_SELECT_BY_ID_SQL = `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`;

const USER_INSERT_SQL = `
INSERT INTO users(id, role, login_name, owner_id, age_band, status, revision, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`;

function userInsertParams(user: User): readonly unknown[] {
  assertPersistableRevision(user.revision, 'User.revision');
  return [
    user.id,
    user.role,
    user.loginName,
    user.ownerId,
    user.ageBand,
    user.status,
    user.revision,
    toJsonb(user),
  ];
}

const PASSWORD_CREDENTIAL_COLUMNS = `user_id, salt, password_hash, scrypt_n, scrypt_r,
  scrypt_p, hash_bytes`;

type PasswordCredentialRow = {
  readonly user_id: string;
  readonly salt: unknown;
  readonly password_hash: unknown;
  readonly scrypt_n: unknown;
  readonly scrypt_r: unknown;
  readonly scrypt_p: unknown;
  readonly hash_bytes: unknown;
};

/**
 * 读回校验材料，**不做参数合法性判定** —— 那是 `verifyPassword` 的职责。在这里再判一次
 * 就会有两个"哪些 scrypt 参数可接受"的事实源，而它们必须只有一个。
 */
function credentialFromRow(row: PasswordCredentialRow): PasswordCredentialRecord {
  return {
    salt: fromBytea(row.salt),
    passwordHash: fromBytea(row.password_hash),
    scryptN: fromBigintColumn(row.scrypt_n),
    scryptR: fromBigintColumn(row.scrypt_r),
    scryptP: fromBigintColumn(row.scrypt_p),
    hashBytes: fromBigintColumn(row.hash_bytes),
  };
}

const PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL = `
SELECT ${PASSWORD_CREDENTIAL_COLUMNS} FROM password_credentials WHERE user_id = $1`;

const PASSWORD_CREDENTIAL_INSERT_SQL = `
INSERT INTO password_credentials(
  user_id, salt, password_hash, scrypt_n, scrypt_r, scrypt_p, hash_bytes
) VALUES ($1, $2::bytea, $3::bytea, $4, $5, $6, $7)`;

async function readCredential(
  tx: DatabaseTransaction,
  userId: UserId,
): Promise<PasswordCredentialRecord | null> {
  const rows = await tx.query<PasswordCredentialRow>(PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL, [
    userId,
  ]);
  const [row] = rows;
  return row === undefined ? null : credentialFromRow(row);
}

export class PostgresAccountDirectory implements AccountDirectory {
  readonly #db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.#db = db;
  }

  async findByLoginNameKey(loginNameKey: string): Promise<StoredAccount | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<UserRow>(USER_SELECT_BY_LOGIN_NAME_KEY_SQL, [loginNameKey]);
      const [row] = rows;
      if (row === undefined) return null;
      const user = userFromRow(row);
      return { user, credential: await readCredential(tx, user.id) };
    });
  }

  async findById(userId: UserId): Promise<User | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<UserRow>(USER_SELECT_BY_ID_SQL, [userId]);
      const [row] = rows;
      return row === undefined ? null : userFromRow(row);
    });
  }
}

// ---------------------------------------------------------------------------
// account_sessions
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = `id, token_hash, user_id, status, idle_expires_at, absolute_expires_at,
  payload`;

type SessionRow = {
  readonly id: string;
  readonly token_hash: unknown;
  readonly user_id: string;
  readonly status: string;
  readonly idle_expires_at: unknown;
  readonly absolute_expires_at: unknown;
  readonly payload: unknown;
};

function sessionFromRow(row: SessionRow): StoredSession {
  const session = createAccountSession(
    fromJsonObject(row.payload) as Parameters<typeof createAccountSession>[0],
  );
  assertColumnMatches(row.id, session.id);
  assertColumnMatches(row.user_id, session.userId);
  assertColumnMatches(row.status, session.status);
  assertColumnMatches(fromTimestamptz(row.idle_expires_at), session.idleExpiresAt);
  assertColumnMatches(fromTimestamptz(row.absolute_expires_at), session.absoluteExpiresAt);
  return { session, tokenHash: fromBytea(row.token_hash) };
}

const SESSION_INSERT_SQL = `
INSERT INTO account_sessions(
  id, token_hash, user_id, status, idle_expires_at, absolute_expires_at, payload
) VALUES ($1, $2::bytea, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb)`;

/**
 * 覆盖 payload **与全部派生列**。
 *
 * 端口注释只说「覆盖 `payload`」，但 §3.1 的一致性检查要求派生列跟着走：滑动过期改的正是
 * `idle_expires_at`，撤销改的正是 `status`。只写 payload 会让下一次读取在
 * `assertColumnMatches` 上炸成 `STORED_ROW_INCONSISTENT` —— 一个自己造出来的"库坏了"。
 */
const SESSION_UPDATE_SQL = `
UPDATE account_sessions SET
  user_id = $2,
  status = $3,
  idle_expires_at = $4::timestamptz,
  absolute_expires_at = $5::timestamptz,
  payload = $6::jsonb
WHERE id = $1`;

const SESSION_SELECT_BY_TOKEN_HASH_SQL = `
SELECT ${SESSION_COLUMNS} FROM account_sessions WHERE token_hash = $1`;

export class PostgresSessionDirectory implements SessionDirectory {
  readonly #db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.#db = db;
  }

  async insert(stored: StoredSession): Promise<void> {
    const { session, tokenHash } = stored;
    await this.#db.transaction((tx) =>
      tx
        .execute(SESSION_INSERT_SQL, [
          session.id,
          toBytea(tokenHash),
          session.userId,
          session.status,
          toTimestamptz(session.idleExpiresAt),
          toTimestamptz(session.absoluteExpiresAt),
          toJsonb(session),
        ])
        .then((written) => {
          if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
        }),
    );
  }

  async findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<SessionRow>(SESSION_SELECT_BY_TOKEN_HASH_SQL, [
        toBytea(tokenHash),
      ]);
      const [row] = rows;
      return row === undefined ? null : sessionFromRow(row);
    });
  }

  async save(session: AccountSession): Promise<void> {
    await this.#db.transaction((tx) =>
      tx
        .execute(SESSION_UPDATE_SQL, [
          session.id,
          session.userId,
          session.status,
          toTimestamptz(session.idleExpiresAt),
          toTimestamptz(session.absoluteExpiresAt),
          toJsonb(session),
        ])
        .then((written) => {
          if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
        }),
    );
  }
}

// ---------------------------------------------------------------------------
// projects / versions
// ---------------------------------------------------------------------------

const PROJECT_COLUMNS = `id, owner_student_id, revision, current_version_id, status,
  updated_at, payload`;

type ProjectRow = {
  readonly id: string;
  readonly owner_student_id: string;
  readonly revision: unknown;
  readonly current_version_id: string | null;
  readonly status: string;
  readonly updated_at: unknown;
  readonly payload: unknown;
};

function projectFromRow(row: ProjectRow): Project {
  const project = createProject(fromJsonObject(row.payload) as Parameters<typeof createProject>[0]);
  assertColumnMatches(row.id, project.id);
  assertColumnMatches(row.owner_student_id, project.ownerStudentId);
  assertColumnMatches(fromRevisionColumn(row.revision), project.revision);
  assertColumnMatches(row.current_version_id, project.currentVersionId);
  assertColumnMatches(row.status, project.status);
  assertColumnMatches(fromTimestamptz(row.updated_at), project.updatedAt);
  return project;
}

const PROJECT_INSERT_SQL = `
INSERT INTO projects(id, owner_student_id, revision, current_version_id, status, updated_at, payload)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)`;

const PROJECT_SELECT_BY_ID_SQL = `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`;

/**
 * 项目清单（§5.5 游标分页）。
 *
 * 排序逐字对应 `projects_owner_updated_idx (owner_student_id, updated_at DESC, id)`：
 * 键集分页（keyset）而不是 `OFFSET`，因为 `OFFSET` 翻页时一次插入就会让客户端重复看到或
 * 跳过一行，而"跳过一行"在 UI 上表现为"我的作品少了一个"，查不出来。
 *
 * 游标是 `(updated_at, id)` 的 base64url —— 客户端不解释它，服务端也不该让它可读成
 * 一个可篡改的偏移量。
 *
 * `$4` 必须铸成 `uuid` 而不是 `text`：Postgres 在**解析期**就要为行比较的每一对
 * 列/参数解析出 `<` 运算符，而 `uuid < text` 不存在。写成 text 时这个错误与游标是否
 * 为 NULL 无关（`OR` 短路是运行期的事），于是**每一次** list 都在计划阶段就炸，表现
 * 为 `GET /projects` 无条件 500 `INTERNAL_ERROR` —— 而 `envelopeOf` 对非
 * DomainError / 非 InfraError 的异常一律不回原始 message，所以从响应体上完全看不出
 * 是运算符解析失败。这条竖切正是被它挡住的。
 */
const PROJECT_LIST_SQL = `
SELECT ${PROJECT_COLUMNS} FROM projects
WHERE owner_student_id = $1
  AND ($2::text IS NULL OR status = $2::text)
  AND (
    $3::timestamptz IS NULL
    OR (updated_at, id) < ($3::timestamptz, $4::uuid)
  )
ORDER BY updated_at DESC, id
LIMIT $5`;

const VERSION_COLUMNS = 'id, project_id, sequence, source_task_id, artifact_sha256, payload';

type VersionRow = {
  readonly id: string;
  readonly project_id: string;
  readonly sequence: number;
  readonly source_task_id: string | null;
  readonly artifact_sha256: string;
  readonly payload: unknown;
};

function versionFromRow(row: VersionRow): ProjectVersion {
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

const VERSION_INSERT_SQL = `
INSERT INTO versions(id, project_id, sequence, source_task_id, artifact_sha256, payload)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)`;

const VERSION_SELECT_BY_ID_SQL = `SELECT ${VERSION_COLUMNS} FROM versions WHERE id = $1`;

/** 历史版本按 `sequence DESC`：最新的一版排第一，`versions_project_sequence` 就是它的索引。 */
const VERSION_LIST_SQL = `
SELECT ${VERSION_COLUMNS} FROM versions
WHERE project_id = $1 AND ($2::bigint IS NULL OR sequence < $2::bigint)
ORDER BY sequence DESC
LIMIT $3`;

function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * 解游标。**解不开就当没有游标**（从头开始），不抛 400：
 *
 * 游标是服务端自己签发的不透明串，一个解不开的游标只可能来自跨版本升级或客户端拼接错误。
 * 对它报 400 会让"翻到第三页"变成一个用户看得见、却无法自救的错误；从头开始则最多多看
 * 几条已经看过的作品。这里刻意**不**接受"看起来像数字"的宽松解析 —— 只认 base64url。
 */
function decodeCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  return decoded === '' ? null : decoded;
}

export class PostgresProjectDirectory implements ProjectDirectory {
  readonly #db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.#db = db;
  }

  async insert(project: Project): Promise<void> {
    assertPersistableRevision(project.revision, 'Project.revision');
    await this.#db.transaction((tx) =>
      tx
        .execute(PROJECT_INSERT_SQL, [
          project.id,
          project.ownerStudentId,
          project.revision,
          project.currentVersionId,
          project.status,
          toTimestamptz(project.updatedAt),
          toJsonb(project),
        ])
        .then((written) => {
          if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
        }),
    );
  }

  async findById(projectId: ProjectId): Promise<Project | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<ProjectRow>(PROJECT_SELECT_BY_ID_SQL, [projectId]);
      const [row] = rows;
      return row === undefined ? null : projectFromRow(row);
    });
  }

  async insertVersion(version: ProjectVersion): Promise<void> {
    await this.#db.transaction((tx) =>
      tx
        .execute(VERSION_INSERT_SQL, [
          version.id,
          version.projectId,
          version.sequence,
          version.sourceTaskId,
          version.artifactSha256,
          toJsonb(version),
        ])
        .then((written) => {
          if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
        }),
    );
  }

  async findVersionById(versionId: ProjectVersionId): Promise<ProjectVersion | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<VersionRow>(VERSION_SELECT_BY_ID_SQL, [versionId]);
      const [row] = rows;
      return row === undefined ? null : versionFromRow(row);
    });
  }

  async list(input: ListProjectsInput): Promise<Page<Project>> {
    const cursor = decodeCursor(input.cursor);
    const bounds: readonly [string | null, string | null] =
      cursor === null ? [null, null] : splitProjectCursor(cursor);
    const [cursorUpdatedAt, cursorId] = bounds;
    const rows = await this.#db.transaction((tx) =>
      tx.query<ProjectRow>(PROJECT_LIST_SQL, [
        input.ownerStudentId,
        input.status,
        cursorUpdatedAt,
        cursorId,
        input.limit + 1,
      ]),
    );
    const hasMore = rows.length > input.limit;
    const items = (hasMore ? rows.slice(0, input.limit) : rows).map(projectFromRow);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last !== undefined ? encodeCursor(`${last.updatedAt}|${last.id}`) : null,
    };
  }

  async listVersions(input: ListVersionsInput): Promise<Page<ProjectVersion>> {
    const cursor = decodeCursor(input.cursor);
    const rows = await this.#db.transaction((tx) =>
      tx.query<VersionRow>(VERSION_LIST_SQL, [input.projectId, cursor, input.limit + 1]),
    );
    const hasMore = rows.length > input.limit;
    const items = (hasMore ? rows.slice(0, input.limit) : rows).map(versionFromRow);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last !== undefined ? encodeCursor(String(last.sequence)) : null,
    };
  }
}

/** `(updated_at, id)` 游标的两半。缺 `|` 的串按"没有游标"处理，理由见 `decodeCursor`。 */
function splitProjectCursor(decoded: string): readonly [string | null, string | null] {
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0 || separator === decoded.length - 1) return [null, null];
  return [decoded.slice(0, separator), decoded.slice(separator + 1)];
}

// ---------------------------------------------------------------------------
// ai_tasks / task_events（只读）
// ---------------------------------------------------------------------------

const AI_TASK_COLUMNS = `id, project_id, requested_by, idempotency_key, request_hash,
  accepted_project_revision, state, stage, attempt, revision, next_run_at,
  lease_owner, lease_token, lease_until, payload`;

type AiTaskRow = {
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

/** 与 infra `taskFromRow` 逐字同一套一致性检查（覆盖全部派生列，包括"看起来不可能不一致"的）。 */
function taskFromRow(row: AiTaskRow): AiTask {
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

const AI_TASK_SELECT_BY_ID_SQL = `SELECT ${AI_TASK_COLUMNS} FROM ai_tasks WHERE id = $1`;

/**
 * 本项目的**非终态**任务。`ai_tasks_one_active_per_project` 这条部分唯一索引保证至多一行，
 * 但这里仍然 `LIMIT 1` + 逐行解码：索引是竞态屏障，不是查询语义。
 *
 * 终态清单由参数传入（`TERMINAL_TASK_STATES` ← `TASK_TRANSITIONS.terminal`），不在 SQL 里
 * 写字面量：domain 加一个终态时不会有人想起这条语句，而漏掉的后果是"已完成的项目再也无法
 * 发起新回合"。
 */
const AI_TASK_SELECT_ACTIVE_BY_PROJECT_SQL = `
SELECT ${AI_TASK_COLUMNS} FROM ai_tasks
WHERE project_id = $1 AND NOT (state = ANY($2::text[]))
ORDER BY id LIMIT 1`;

/**
 * 幂等 scope 内既有受理记录的只读投影。
 *
 * 只取三列，**不取 `payload`**：回放要返回的是当年受理的结果（`{taskId, projectRevision}`），
 * 不是任务的当前状态。把整行读回来会诱使调用方拿它当 `AiTask` 用，而它可能早已被推进过。
 */
const AI_TASK_SELECT_ACCEPTANCE_SQL = `
SELECT id, request_hash, accepted_project_revision FROM ai_tasks
WHERE project_id = $1 AND idempotency_key = $2`;

type AcceptanceRow = {
  readonly id: string;
  readonly request_hash: string | null;
  readonly accepted_project_revision: unknown;
};

const TASK_EVENT_COLUMNS = 'task_id, sequence, event_type, safe_payload, created_at';

type TaskEventRow = {
  readonly task_id: string;
  readonly sequence: unknown;
  readonly event_type: string;
  readonly safe_payload: unknown;
  readonly created_at: unknown;
};

/**
 * `safePayload` 走 `createSafeEventPayload`（在 `createTaskEvent` 内部）而不是原样返回：
 * 那个构造器按 `FORBIDDEN_SAFE_KEY_PATTERN` 拒绝 `prompt` / `stack` / `authorization`
 * 一类键名。读回来再验一次不是多余 —— §5 的"事件里不含原文"这条红线值得在读侧也有一道。
 */
function taskEventFromRow(row: TaskEventRow): TaskEvent {
  return createTaskEvent({
    taskId: fromTextColumn(row.task_id),
    sequence: fromBigIntColumn(row.sequence),
    eventType: fromTextColumn(row.event_type),
    safePayload: fromJsonObject(row.safe_payload),
    createdAt: fromTimestamptz(row.created_at),
  });
}

const TASK_EVENT_LIST_AFTER_SQL = `
SELECT ${TASK_EVENT_COLUMNS} FROM task_events
WHERE task_id = $1 AND ($2::bigint IS NULL OR sequence > $2::bigint)
ORDER BY sequence ASC LIMIT $3`;

/**
 * 活跃**写**任务的计数（§6.5）。
 *
 * `ai_tasks` 没有 `kind` 列（kind 只在 payload 里），所以按 `payload->>'kind'` 过滤。这不是
 * 把 JSON 当索引用：三个计数各自都是 `count(*)`，谓词的选择性由 `state` 那一半承担，而
 * §6.5 规则 5 要求的是"计数来自持久化状态"，不是"计数必须走索引"。
 *
 * 一律数**非终态**任务，不数"正在跑"的：本切片没有常驻 worker，`CLAIMED` / `RUNNING`
 * 与 `QUEUED` 之间的区别只体现在租约列上，而按租约过滤会让一个刚受理还没被领取的回合
 * 不占额度 —— 那正是 §6.5 要防的超发。
 */
const ACTIVE_WRITE_TASK_COUNT_GLOBAL_SQL = `
SELECT count(*)::bigint AS total FROM ai_tasks
WHERE NOT (state = ANY($1::text[])) AND payload->>'kind' = ANY($2::text[])`;

const ACTIVE_WRITE_TASK_COUNT_STUDENT_SQL = `
SELECT count(*)::bigint AS total FROM ai_tasks t
JOIN projects p ON p.id = t.project_id
WHERE p.owner_student_id = $1
  AND NOT (t.state = ANY($2::text[]))
  AND t.payload->>'kind' = ANY($3::text[])`;

const ACTIVE_WRITE_TASK_COUNT_PROJECT_SQL = `
SELECT count(*)::bigint AS total FROM ai_tasks
WHERE project_id = $1
  AND NOT (state = ANY($2::text[]))
  AND payload->>'kind' = ANY($3::text[])`;

export class PostgresTaskReadDirectory implements TaskReadDirectory {
  readonly #db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.#db = db;
  }

  async findTask(taskId: TaskId): Promise<AiTask | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<AiTaskRow>(AI_TASK_SELECT_BY_ID_SQL, [taskId]);
      const [row] = rows;
      return row === undefined ? null : taskFromRow(row);
    });
  }

  async findActiveWriteTask(projectId: ProjectId): Promise<AiTask | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<AiTaskRow>(AI_TASK_SELECT_ACTIVE_BY_PROJECT_SQL, [
        projectId,
        TERMINAL_TASK_STATES,
      ]);
      const [row] = rows;
      return row === undefined ? null : taskFromRow(row);
    });
  }

  async listEvents(
    taskId: TaskId,
    afterSequence: bigint | null,
    limit: number,
  ): Promise<readonly TaskEvent[]> {
    const rows = await this.#db.transaction((tx) =>
      tx.query<TaskEventRow>(TASK_EVENT_LIST_AFTER_SQL, [
        taskId,
        afterSequence === null ? null : afterSequence.toString(),
        limit,
      ]),
    );
    return rows.map(taskEventFromRow);
  }

  async findTurnAcceptance(input: {
    projectId: ProjectId;
    idempotencyKey: string;
  }): Promise<TurnAcceptanceRecord | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<AcceptanceRow>(AI_TASK_SELECT_ACCEPTANCE_SQL, [
        input.projectId,
        input.idempotencyKey,
      ]);
      const [row] = rows;
      if (row === undefined) return null;
      return {
        taskId: parseTaskId(row.id),
        // 一次 turn 受理必然带 requestHash 与 accepted_project_revision（§3.5）；
        // 读到 NULL 说明这行不是受理路径写的 ⇒ 行损坏，不是"没有受理记录"。
        requestHash: fromTextColumn(row.request_hash),
        projectRevision: fromRevisionColumn(row.accepted_project_revision),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// 用量额度
// ---------------------------------------------------------------------------

/**
 * 本周期已提交的量。周期起点用 `date_trunc(... AT TIME ZONE 'UTC')` 显式钉在 UTC：
 * 不钉的话 `date_trunc` 按会话时区截断，同一份数据在本地与 CI（UTC）上会得到两个"本周期"，
 * 而额度判定是钱相关的。
 */
const USAGE_COMMITTED_IN_PERIOD_SQL = `
SELECT COALESCE(SUM(quantity), 0)::bigint AS total FROM usage_ledger
WHERE owner_student_id = $1 AND capability = $2
  AND occurred_at >= (date_trunc($3::text, $4::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * 本周期仍被占住的量。
 *
 * 预留行没有 `occurred_at`，所以"在本周期内"只能读成**仍然有效**（`state = 'HELD'` 且
 * `expires_at > now`）：一份还没结算的预留无论何时创建，它占的都是**现在**这一格额度。
 * 已过期的预留不计入 —— 它的额度由 `expiresAt` 这条硬截止自动还回去。
 */
const USAGE_HELD_SQL = `
SELECT COALESCE(SUM(reserved_units), 0)::bigint AS total FROM usage_reservations
WHERE owner_student_id = $1 AND capability = $2
  AND state = 'HELD' AND expires_at > $3::timestamptz`;

/**
 * ⚠️ 已申报的规格缺口：§3.2 的 DDL 里**没有**额度上限表（既无 `usage_quotas` 也无
 * `usage_limits`），所以 `limit` 只能是 `{kind:'ABSENT'}`。
 *
 * 这不是"把上限设成无限"的偷懒：`UsageLimitRecord` 把 `ABSENT`（没有这一行 ⇒ 不限）与
 * `CONFIGURED`（有行，`limitUnits` 可能就是 0）显式分成两个分支，而 §6.6 的原文是
 * 「未设上限 ⇒ ADMIT、额度为 0 ⇒ 只阻断新 AI task」。编一张上限表出来（或把 `ABSENT`
 * 谎报成 `CONFIGURED {limitUnits: 0}`）都会让这两种语义混成一种，前者是新增未被裁定的
 * 数据库契约，后者会把整个产品关死。补表属于架构师裁定，不在本单。
 */
export class PostgresUsageDirectory implements UsageDirectory {
  readonly #db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.#db = db;
  }

  async quotaSnapshot(input: {
    ownerStudentId: UserId;
    capability: Capability;
    period: UsagePeriod;
    now: Timestamp;
  }): Promise<UsageQuotaSnapshot> {
    const truncUnit = input.period === 'DAILY' ? 'day' : 'month';
    return this.#db.transaction(async (tx) => {
      const committedRows = await tx.query<{ readonly total: unknown }>(
        USAGE_COMMITTED_IN_PERIOD_SQL,
        [input.ownerStudentId, input.capability, truncUnit, toTimestamptz(input.now)],
      );
      const heldRows = await tx.query<{ readonly total: unknown }>(USAGE_HELD_SQL, [
        input.ownerStudentId,
        input.capability,
        toTimestamptz(input.now),
      ]);
      return {
        capability: input.capability,
        period: input.period,
        committedInPeriod: fromBigintColumn(committedRows[0]?.total ?? 0),
        heldInPeriod: fromBigintColumn(heldRows[0]?.total ?? 0),
        limit: { kind: 'ABSENT' },
      };
    });
  }

  async countActiveWriteTasks(input: {
    ownerStudentId: UserId;
    projectId: ProjectId;
    now: Timestamp;
  }): Promise<{
    readonly global: number;
    readonly group: number;
    readonly student: number;
    readonly project: number;
  }> {
    return this.#db.transaction(async (tx) => {
      const [globalRows, studentRows, projectRows] = await Promise.all([
        tx.query<{ readonly total: unknown }>(ACTIVE_WRITE_TASK_COUNT_GLOBAL_SQL, [
          TERMINAL_TASK_STATES,
          WRITE_TASK_KIND_LIST,
        ]),
        tx.query<{ readonly total: unknown }>(ACTIVE_WRITE_TASK_COUNT_STUDENT_SQL, [
          input.ownerStudentId,
          TERMINAL_TASK_STATES,
          WRITE_TASK_KIND_LIST,
        ]),
        tx.query<{ readonly total: unknown }>(ACTIVE_WRITE_TASK_COUNT_PROJECT_SQL, [
          input.projectId,
          TERMINAL_TASK_STATES,
          WRITE_TASK_KIND_LIST,
        ]),
      ]);
      return {
        global: fromBigintColumn(globalRows[0]?.total ?? 0),
        /**
         * `Project` 没有小组字段，小组视图被 §12.3 排除在本期之外 ⇒ 恒 0。键仍然保留，
         * 因为 `AdmissionContext` 要它；删掉就等于在这里另编一份准入输入形状。
         */
        group: 0,
        student: fromBigintColumn(studentRows[0]?.total ?? 0),
        project: fromBigintColumn(projectRows[0]?.total ?? 0),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// 取消路径的额度释放
// ---------------------------------------------------------------------------

const USAGE_RESERVATION_COLUMNS = `id, task_id, owner_student_id, capability,
  reserved_units, state, expires_at, payload`;

type UsageReservationRow = {
  readonly id: string;
  readonly task_id: string;
  readonly owner_student_id: string;
  readonly capability: string;
  readonly reserved_units: unknown;
  readonly state: string;
  readonly expires_at: unknown;
  readonly payload: unknown;
};

function reservationFromRow(row: UsageReservationRow): UsageReservation {
  const reservation = createUsageReservation(
    fromJsonObject(row.payload) as Parameters<typeof createUsageReservation>[0],
  );
  assertColumnMatches(row.id, reservation.id);
  assertColumnMatches(row.task_id, reservation.taskId);
  assertColumnMatches(row.owner_student_id, reservation.subjectUserId);
  assertColumnMatches(row.capability, reservation.capability);
  assertColumnMatches(fromBigintColumn(row.reserved_units), reservation.reservedUnits);
  assertColumnMatches(row.state, reservation.state);
  assertColumnMatches(fromTimestamptz(row.expires_at), reservation.expiresAt);
  return reservation;
}

const USAGE_RESERVATION_SELECT_SQL = `
SELECT ${USAGE_RESERVATION_COLUMNS} FROM usage_reservations
WHERE task_id = $1 AND capability = $2`;

/**
 * 按自然键 `(task_id, capability)` UPSERT，**保留库里那一行的 `id`**。
 *
 * 保留 `id` 不是为了省事：`usage_reservations` 上有 `UNIQUE (task_id, capability)`，一个 task
 * 的一个 capability 只有一行，所以"释放"在语义上永远是**改这一行**，不是插第二行。用实体
 * 自带的（可能是新造的）`id` 去写会让代理键与自然键互相不可推导。
 */
const USAGE_RESERVATION_RELEASE_SQL = `
UPDATE usage_reservations SET state = $3, expires_at = $4::timestamptz, payload = $5::jsonb
WHERE id = $1 AND task_id = $2`;

export class PostgresTaskReservationReleaser implements TaskReservationReleaser {
  readonly #db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.#db = db;
  }

  /**
   * **幂等**：同一 `(taskId, capability)` 重复调用得到同一结果，不追加第二行。
   *
   * 端口注释点名了它可以发生在取消事务之外（§3.5 的原子性要求只约束**结算**，而释放只会把
   * 额度还回去），代价就是必须幂等。已经是 `RELEASED` 的行原样返回 —— `releaseUsage` 会在
   * `RELEASED → RELEASED` 上抛"自迁移"，所以这里**先判再迁**，而不是靠 catch。
   */
  async releaseReservation(input: {
    readonly taskId: TaskId;
    readonly capability: Capability;
    readonly now: Timestamp;
  }): Promise<UsageReservation | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.query<UsageReservationRow>(USAGE_RESERVATION_SELECT_SQL, [
        input.taskId,
        input.capability,
      ]);
      const [row] = rows;
      if (row === undefined) return null;
      const existing = reservationFromRow(row);
      const released = existing.state === 'RELEASED' ? existing : releaseUsage(existing);
      const written = await tx.execute(USAGE_RESERVATION_RELEASE_SQL, [
        existing.id,
        existing.taskId,
        released.state,
        toTimestamptz(released.expiresAt),
        toJsonb(released),
      ]);
      if (written !== 1) throw infraError('STORED_ROW_INCONSISTENT');
      return released;
    });
  }
}

// ---------------------------------------------------------------------------
// 账号预置（§4.2）
// ---------------------------------------------------------------------------

/**
 * 预置一个 OWNER 与其 STUDENT。
 *
 * ## 为什么不用 infra 的 `bootstrapAccounts`
 *
 * 那个工具是 **TTY 门禁**的（没有交互终端就拒绝运行），因为它要人在终端里输入首个口令。
 * 本单的验收证据必须在 vitest 里可复现，所以这里走同一条**写入形状**（`users` +
 * `password_credentials` 两表、scrypt 参数随行），口令由调用方以受控输入传入、
 * **从不落盘、从不进日志、从不进任何响应**。
 *
 * §1.3 的"首个口令"前提因此**仍未满足**：本函数是给测试与运维脚本用的装配入口，不是一个
 * 面向用户的注册通道 —— 公开注册照 §4.2 关闭，这里也没有 `register` / `me` 端点。
 *
 * `lockPolicy` 是**入参**而不是常量：domain 的注释逐字写了「阈值与锁定时长**不在 domain
 * 硬编码默认值**……产品数值由配置注入」，infra 的 `bootstrapAccounts` 也是把它做成命令行
 * 参数（默认 5 / 15）。在组合根里抄一份 5 / 15 就有了第二个事实源，所以照搬同一形状。
 */
export interface SeedAccountInput {
  readonly id: string;
  readonly role: 'OWNER' | 'STUDENT';
  readonly loginName: string;
  readonly nickname: string;
  readonly ageBand: string | null;
  readonly ownerId: string | null;
  readonly password: string;
  readonly credential: PasswordCredentialRecord;
}

const SEED_REVISION = parseRevision('1');

export async function seedAccounts(
  db: DatabaseAdapter,
  lockPolicy: AccountLockPolicy,
  accounts: readonly SeedAccountInput[],
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const account of accounts) {
      const user = createUser({
        id: account.id,
        role: account.role,
        loginName: parseLoginName(account.loginName),
        nickname: parseNickname(account.nickname),
        ageBand: account.ageBand,
        status: 'ACTIVE',
        ownerId: account.ownerId,
        lockPolicy,
        revision: SEED_REVISION,
      });
      const writtenUser = await tx.execute(USER_INSERT_SQL, userInsertParams(user));
      if (writtenUser !== 1) throw infraError('STORED_ROW_INCONSISTENT');
      const writtenCredential = await tx.execute(PASSWORD_CREDENTIAL_INSERT_SQL, [
        user.id,
        toBytea(account.credential.salt),
        toBytea(account.credential.passwordHash),
        account.credential.scryptN,
        account.credential.scryptR,
        account.credential.scryptP,
        account.credential.hashBytes,
      ]);
      if (writtenCredential !== 1) throw infraError('STORED_ROW_INCONSISTENT');
    }
  });
}

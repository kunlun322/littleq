import { createHash } from 'node:crypto';

/**
 * ZLQ-216 §3.2 / §3.3 的建表迁移。
 *
 * ## 为什么这是一份**逐字**照抄设计的清单
 *
 * §3.2 开头就写死了两条不可协商的规则：「ID 用现有 UUIDv7 生成器，不替换成 provider
 * ID；时间用 timestamptz。」所以本文件里没有任何一处 `serial` / `bigserial` / `DEFAULT
 * gen_random_uuid()` / `timestamp without time zone`。ID 由 `sql/uuidv7.ts` 在应用侧生成，
 * 数据库只负责存 —— 换成 provider ID 会让「同一次生成在崩溃重放后拿到同一个 task id」
 * 这条幂等事实失效（§5.3 的 journal 全部以 taskId 为键）。
 *
 * ## §3.1 的存储形态在这里落成什么
 *
 * §3.1：「业务实体以完整 domain 形态存 `payload jsonb`，查询/唯一性/并发所需字段作独立列。
 * 写入只走现有构造器/策略验证；**禁止**从 HTTP 直接任意更新 JSON。独立列从验证后的实体
 * 派生，仓储读取时检查一致性。」
 *
 * 因此凡是 §3.2 列出 `payload jsonb` 的表，独立列**都是派生列**，权威值是 payload；
 * 派生列存在的唯一理由是索引、唯一约束与 CAS 的 `WHERE`。这也解释了为什么本文件**不给
 * 枚举列加 CHECK**（除 §3.2 明确要求的那几处）：枚举验证按 §3.1 归仓储/domain 构造器，
 * 在 DDL 里再钉一遍会让 domain 增加一个状态时必须同时改迁移，而 §3.2 只对它点名的
 * `users.role` / `age_band` / `status` 要求「按 domain 枚举验证」。
 *
 * ## `revision` 为什么是 `bigint` 而不是 `integer`
 *
 * §3.1：「revision 在 DB 是正整数 bigint，线上按现有十进制字符串编码，ETag 为
 * `"rev-N"`；不能 JS Number 精度丢失。」`node-pg` 把 `int8` 读成**字符串**（默认
 * parser 不做 Number 转换），于是 `bigint → string → parseRevision` 全程不经过
 * double，`Number.MAX_SAFE_INTEGER` 之上的 revision 也不会被悄悄截断。这条链路的
 * 断点在 `parseInt` 而不在数据库，所以仓储读回来时必须走 `parseRevision(row.revision)`
 * 而不是 `Number(row.revision)`。
 */

/**
 * 一条迁移。`statements` 顺序执行、同一事务内提交 —— §3.2 尾段要求的建表次序
 * （`versions.source_task_id` 的 FK 在 `ai_tasks` 建好后添加；`projects.current_version_id`
 * 在 `versions` 建好后添加，避免建表循环）就是靠这个顺序表达的。
 */
export type SqlMigration = {
  readonly version: string;
  readonly statements: readonly string[];
};

/**
 * `schema_migrations` 自身的 DDL。
 *
 * **它不是一条迁移**：迁移 runner 需要一张表来记录"哪些迁移跑过了"，而没有任何迁移
 * 能创建记录自己的那张表（先有鸡还是先有蛋）。所以 runner 在任何迁移之前用
 * `CREATE TABLE IF NOT EXISTS` 引导它，列集合与 §3.2 的 `schema_migrations` 行逐字一致：
 * 「version text PK；checksum text；applied_at timestamptz」。
 *
 * §3.2 同段还有一条硬约束：「迁移 runner 按版本/checksum 执行；**凭据不写 migration
 * SQL**」—— 本文件因此不含任何连接串、口令、PAT 或主密钥，连注释里都不出现。
 */
export const SCHEMA_MIGRATIONS_BOOTSTRAP_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text        PRIMARY KEY,
  checksum   text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)
`;

/**
 * 迁移互斥用的 advisory lock 键。
 *
 * 两个实例同时冷启动会同时跑迁移：`CREATE TABLE IF NOT EXISTS` 本身是幂等的，但
 * 「读 `schema_migrations` → 发现缺失 → 执行 → 插入版本行」这个复合动作不是，第二个
 * 实例会撞 PK 冲突并把整个启动请求变成 500。`pg_advisory_xact_lock` 是**事务级**的，
 * 提交即释放，不需要额外的解锁语句，也不会因为进程崩溃而留下死锁。
 *
 * 取一个固定的 64 位常量而不是从表名派生，是为了让键值在日志里可辨认；这个值只在本
 * 项目内需要唯一。
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 7_610_216n;

const USERS_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id         uuid   PRIMARY KEY,
  role       text   NOT NULL CHECK (role IN ('OWNER', 'STUDENT')),
  login_name text   NOT NULL UNIQUE,
  owner_id   uuid   NULL REFERENCES users(id),
  age_band   text   NULL CHECK (age_band IS NULL OR age_band IN ('L1', 'L2', 'L3')),
  status     text   NOT NULL CHECK (status IN ('ACTIVE', 'LOCKED', 'DELETED')),
  revision   bigint NOT NULL CHECK (revision > 0),
  payload    jsonb  NOT NULL,
  CONSTRAINT users_role_shape CHECK (
    (role = 'OWNER' AND owner_id IS NULL AND age_band IS NULL)
    OR (role = 'STUDENT' AND owner_id IS NOT NULL AND age_band IS NOT NULL)
  )
)
`;

const PASSWORD_CREDENTIALS_DDL = `
CREATE TABLE IF NOT EXISTS password_credentials (
  user_id       uuid    PRIMARY KEY REFERENCES users(id),
  salt          bytea   NOT NULL,
  password_hash bytea   NOT NULL,
  scrypt_n      integer NOT NULL CHECK (scrypt_n > 1),
  scrypt_r      integer NOT NULL CHECK (scrypt_r > 0),
  scrypt_p      integer NOT NULL CHECK (scrypt_p > 0),
  hash_bytes    integer NOT NULL CHECK (hash_bytes > 0)
)
`;

const ACCOUNT_SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS account_sessions (
  id                  uuid        PRIMARY KEY,
  token_hash          bytea       NOT NULL UNIQUE,
  user_id             uuid        NOT NULL REFERENCES users(id),
  status              text        NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  payload             jsonb       NOT NULL
)
`;

const ACCOUNT_SESSIONS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS account_sessions_user_id_idx ON account_sessions(user_id)
`;

const PROJECTS_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id                 uuid        PRIMARY KEY,
  owner_student_id   uuid        NOT NULL REFERENCES users(id),
  revision           bigint      NOT NULL CHECK (revision > 0),
  current_version_id uuid        NULL,
  status             text        NOT NULL,
  updated_at         timestamptz NOT NULL,
  payload            jsonb       NOT NULL
)
`;

const PROJECTS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS projects_owner_updated_idx
ON projects(owner_student_id, updated_at DESC, id)
`;

/**
 * `idempotency_key` 与 `request_hash` 可为 NULL，是**跟着 domain 走的**，不是放宽约束：
 * `AiTask.idempotencyKey` / `AiTask.requestHash` 的类型就是 `IdempotencyKey | null` /
 * `RequestHash | null`（`PUBLISH`、`RESCAN` 这类由平台自己发起的 task 没有外部请求可幂等）。
 * 冻结的 `TaskRepository.save` 必须能存下**任何**合法 `AiTask`，把这两列写成 NOT NULL
 * 会让一个 domain 认可的任务在 INSERT 时撞 23505 —— 数据库比 domain 更严是漂移，不是防护。
 *
 * `UNIQUE (project_id, idempotency_key)` 在 NULL 上仍然成立：Postgres 的唯一约束把
 * NULL 视为互不相同，所以多个"无幂等键"的任务可以共存，而带键的照旧唯一。
 * `accepted_project_revision` 同理可空 —— 只有 §3.5 的 `createTurn` 会产生它。
 */
const AI_TASKS_DDL = `
CREATE TABLE IF NOT EXISTS ai_tasks (
  id                        uuid         PRIMARY KEY,
  project_id                uuid         NOT NULL REFERENCES projects(id),
  requested_by              uuid         NOT NULL REFERENCES users(id),
  idempotency_key           varchar(128) NULL,
  request_hash              text         NULL CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  accepted_project_revision bigint       NULL
    CHECK (accepted_project_revision IS NULL OR accepted_project_revision > 0),
  state                     text         NOT NULL,
  stage                     text         NULL,
  attempt                   integer      NOT NULL CHECK (attempt >= 0),
  revision                  bigint       NOT NULL CHECK (revision > 0),
  next_run_at               timestamptz  NULL,
  lease_owner               text         NULL,
  lease_token               text         NULL,
  lease_until               timestamptz  NULL,
  payload                   jsonb        NOT NULL,
  CONSTRAINT ai_tasks_project_idempotency_key UNIQUE (project_id, idempotency_key)
)
`;

const AI_TASKS_QUEUE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ai_tasks_queue_idx ON ai_tasks(next_run_at, id)
`;

/**
 * §3.2 逐字给出的部分唯一索引，**一个字都没改**。
 *
 * 「每项目非终态 task 唯一」这条约束不能只在应用层判：`createTurn` 的判据是
 * 「查同 project 有没有活跃 task」，两个并发请求都在各自事务里读到"没有"，然后都
 * INSERT —— 没有这条数据库唯一索引，`ACTIVE_WRITE_TASK_EXISTS` 就是一道纸糊的门。
 * 索引在 INSERT 冲突时报 23505，事务回滚，第二个请求拿到的是既有的 409 语义。
 *
 * 注意它列出的 5 个终态与 `TERMINAL_TASK_STATES` 必须一致；domain 若新增终态而这里
 * 没跟上，结果是一个已完成的项目再也无法发起新 turn（部分索引把 SUCCEEDED 也算活跃）。
 * `migrations.test.ts` 用 domain 的 `TASK_TRANSITIONS.terminal` 反向钉住这份清单。
 */
const AI_TASKS_ONE_ACTIVE_PER_PROJECT_INDEX_DDL = `
CREATE UNIQUE INDEX ai_tasks_one_active_per_project
ON ai_tasks(project_id)
WHERE state NOT IN ('SUCCEEDED','FAILED','BLOCKED','CANCELLED','TIMED_OUT')
`;

const VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS versions (
  id              uuid    PRIMARY KEY,
  project_id      uuid    NOT NULL REFERENCES projects(id),
  sequence        integer NOT NULL CHECK (sequence > 0),
  source_task_id  uuid    NULL REFERENCES ai_tasks(id),
  artifact_sha256 text    NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  payload         jsonb   NOT NULL,
  CONSTRAINT versions_project_sequence UNIQUE (project_id, sequence),
  CONSTRAINT versions_source_task_id_key UNIQUE (source_task_id)
)
`;

/**
 * §3.2 尾段：「`projects.current_version_id` 在 `versions` 建好后添加，避免建表循环。」
 *
 * `projects → versions → projects` 是一个真的循环：两张表互相引用对方还不存在的 OID。
 * Postgres 允许**自引用**（`users.owner_id` 就是），但不允许前向引用一张尚未创建的表。
 * 解法就是设计写的这个：先建 `projects`（带列、不带 FK），建完 `versions` 再补 FK。
 */
const PROJECTS_CURRENT_VERSION_FK_DDL = `
ALTER TABLE projects
ADD CONSTRAINT projects_current_version_id_fkey
FOREIGN KEY (current_version_id) REFERENCES versions(id)
`;

const TASK_PRIVATE_DDL = `
CREATE TABLE IF NOT EXISTS task_private (
  task_id           uuid   PRIMARY KEY REFERENCES ai_tasks(id),
  input_ref         jsonb  NOT NULL,
  qca_session_id    text   NULL,
  qca_event_cursor  text   NULL,
  round_boundary    text   NULL,
  internal_subphase text   NOT NULL,
  operation_journal jsonb  NOT NULL,
  collection_cursor jsonb  NOT NULL,
  scan_checkpoint   jsonb  NULL,
  scan_failure      jsonb  NULL,
  input_snapshot    jsonb  NOT NULL
)
`;

const TASK_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS task_events (
  task_id      uuid        NOT NULL REFERENCES ai_tasks(id),
  sequence     bigint      NOT NULL CHECK (sequence > 0),
  event_type   text        NOT NULL,
  safe_payload jsonb       NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (task_id, sequence)
)
`;

/**
 * ## ⚠️ 一处**已申报的** §3.2 列补充：`key_version integer`
 *
 * §3.2 给 `owner_secrets` 列的是「ciphertext/nonce/tag bytea nullable」三列，但既有冻结代码
 * 里存进数据库的密文形态是**四个**字段 —— `EncryptedSecret = {ciphertext, nonce, tag,
 * keyVersion}`（`secret-store/cipher.ts:57`），而 `decrypt` 的第一件事就是
 * `if (secret.keyVersion !== this.keyVersion) throw MASTER_KEY_VERSION_MISMATCH`（:165）。
 *
 * 少了这一列，读回时只能把 `keyVersion` 就地填成"当前 cipher 的版本"，那条比较于是恒真、
 * `MASTER_KEY_VERSION_MISMATCH` 永远不可达 —— 这是**放宽一条已交付的加密校验**，ZLQ-220 §8
 * 明令禁止（「现有的 CAS／加密／会话／grant 校验保持原语义，不许放宽」）。塞进 `record`
 * jsonb 也不行：§3.1 要求 jsonb 装的是 domain 实体，而 `SecretRecord` 没有这个字段
 * （`domain/value-objects/refs.ts:238`），多塞一个键会让 `createSecretRecord` 的重建与
 * payload 的权威值不再逐字相同。
 *
 * 所以这里**只增不减**：§3.2 列出的每一列都按原类型原样保留，额外补一列 `key_version`，
 * 并把它并进同一条「configured ⟺ 密文齐全」的 CHECK —— 撤销即销毁，销毁时版本号一起清掉，
 * 不留一个指向已不存在密文的孤儿数字。冲突已申报给 PM／架构师裁定。
 */
const OWNER_SECRETS_DDL = `
CREATE TABLE IF NOT EXISTS owner_secrets (
  owner_id    uuid    NOT NULL REFERENCES users(id),
  kind        text    NOT NULL CHECK (kind IN ('QCA_PAT', 'BAILIAN_API_KEY')),
  generation  bigint  NOT NULL CHECK (generation >= 0),
  current_ref text    NULL UNIQUE,
  configured  boolean NOT NULL,
  record      jsonb   NOT NULL,
  ciphertext  bytea   NULL,
  nonce       bytea   NULL,
  tag         bytea   NULL,
  key_version integer NULL,
  PRIMARY KEY (owner_id, kind),
  CONSTRAINT owner_secrets_cipher_shape CHECK (
    (configured AND ciphertext IS NOT NULL AND nonce IS NOT NULL
      AND tag IS NOT NULL AND key_version IS NOT NULL)
    OR (NOT configured AND ciphertext IS NULL AND nonce IS NULL
      AND tag IS NULL AND key_version IS NULL)
  ),
  CONSTRAINT owner_secrets_ref_shape CHECK (configured = (current_ref IS NOT NULL))
)
`;

const ARTIFACT_FILES_DDL = `
CREATE TABLE IF NOT EXISTS artifact_files (
  artifact_sha256 text   NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  path            text   NOT NULL,
  file_sha256     text   NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length     bigint NOT NULL CHECK (byte_length >= 0),
  object_ref      jsonb  NOT NULL,
  media_type      text   NOT NULL,
  PRIMARY KEY (artifact_sha256, path)
)
`;

/**
 * §7.2 的内部能力票据。明文 ticket 不入库、不进日志，所以主键是它的 sha256 **原始 32 字节**
 * （§3.2 逐字给的 `token_hash bytea PK`）而不是 64 位十六进制文本：同一份摘要存成 `text`
 * 会占两倍空间，也让"库里到底有没有明文形态的凭据"这句话需要额外解释。
 */
const PREVIEW_TICKETS_DDL = `
CREATE TABLE IF NOT EXISTS preview_tickets (
  token_hash bytea       NOT NULL PRIMARY KEY,
  version_id uuid        NOT NULL REFERENCES versions(id),
  expires_at timestamptz NOT NULL,
  grant_ids  jsonb       NOT NULL,
  created_at timestamptz NOT NULL
)
`;

/**
 * ## ⚠️ 一处**已申报的** §3.2 列类型偏离：`grant_id text`，不是 `uuid`
 *
 * §3.2 写的是「`grant_id uuid PK`」。但 `grant_id` 的值不是本层生成的 —— 它由**已交付且
 * 被测试钉住**的 `ObjectReadGrantService.issue()` 铸出，格式是 `grant_` + 32 位十六进制
 * （`packages/infra/src/grant/object-read-grant.ts:221`），带前缀，**不是** UUID。
 * `grant_read_leases.read_id` 同理（`lease_` + 16 位十六进制，`:314`），且
 * `packages/infra/test/object-read-grant-concurrency.test.ts:124` 用
 * `expect(lease.leaseId).toMatch(/^lease_[0-9a-f]{16}$/)` 把这个形状钉成了断言。
 *
 * 于是「按 §3.2 用 `uuid`」与「不动既有 grant 语义、不删不 skip 既有安全测试」
 * （§9.2 第 18 门 / 本单 §8 硬边界）在同一列上直接冲突，二者不可同时满足。
 * 这里选择**保住已交付的安全语义**，用 `text` + 一条钉住真实格式的 CHECK 约束，
 * 并把冲突申报给 PM／架构师裁定，而不是自行改写 `issue()` 的 ID 格式去凑 `uuid`。
 * 若裁定要求改成 `uuid`，那是一次**独立的**安全线改动（要连
 * `object-read-grant-concurrency.test.ts` 的两处形状断言一起改），不属于本单「不动
 * cipher/现有安全语义」的范围。
 *
 * `token_hash` 则**照 §3.2 用 `bytea`**：`hashGrantToken` 产出的是十六进制字符串，
 * 解码成 32 字节入库是无损可逆的，没有理由偏离。
 */
const OBJECT_READ_GRANTS_DDL = `
CREATE TABLE IF NOT EXISTS object_read_grants (
  grant_id             text        NOT NULL PRIMARY KEY
    CHECK (grant_id ~ '^grant_[0-9a-f]{32}$'),
  token_hash           bytea       NOT NULL UNIQUE,
  object_ref           jsonb       NOT NULL,
  artifact_hash        text        NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  audience             text        NOT NULL,
  max_bytes            bigint      NOT NULL CHECK (max_bytes >= 0),
  max_concurrent_reads integer     NOT NULL CHECK (max_concurrent_reads > 0),
  issued_at            timestamptz NOT NULL,
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz NULL,
  committed_bytes      bigint      NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0)
)
`;

/** `read_id` 的列类型偏离理由与 `grant_id` 完全相同，见 `OBJECT_READ_GRANTS_DDL` 的注释。 */
const GRANT_READ_LEASES_DDL = `
CREATE TABLE IF NOT EXISTS grant_read_leases (
  read_id        text        NOT NULL PRIMARY KEY
    CHECK (read_id ~ '^lease_[0-9a-f]{16}$'),
  grant_id       text        NOT NULL REFERENCES object_read_grants(grant_id),
  reserved_bytes bigint      NOT NULL CHECK (reserved_bytes >= 0),
  expires_at     timestamptz NOT NULL
)
`;

/** `grant_read_leases` 上要跑的两条查询：某 grant 的在飞租约、以及过期租约的回收。 */
export const GRANT_READ_LEASES_ACTIVE_COUNT_SQL = `
SELECT count(*)::bigint AS active FROM grant_read_leases
WHERE grant_id = $1 AND expires_at > $2::timestamptz
`;

export const GRANT_READ_LEASES_DELETE_EXPIRED_SQL = `
DELETE FROM grant_read_leases WHERE expires_at <= $1::timestamptz
`;

/**
 * 撤销必须**立即**切断在飞的读租约 —— `GrantRecordStore.markRevoked` 的注释逐字：
 * 「写库与打断在飞的租约在同一次调用里完成」。`object_read_grants.revoked_at` 只是让
 * **下一次** `open` 被拒；已经签出去的 `grant_read_leases` 行若留着，持有它的读取方在
 * `expires_at` 之前仍能继续按租约取字节。所以撤销要连租约行一起删，且两者同事务。
 */
export const GRANT_READ_LEASES_DELETE_BY_GRANT_SQL = `
DELETE FROM grant_read_leases WHERE grant_id = $1
`;

const USAGE_RESERVATIONS_DDL = `
CREATE TABLE IF NOT EXISTS usage_reservations (
  id               uuid        PRIMARY KEY,
  task_id          uuid        NOT NULL REFERENCES ai_tasks(id),
  owner_student_id uuid        NOT NULL REFERENCES users(id),
  capability       text        NOT NULL,
  reserved_units   bigint      NOT NULL CHECK (reserved_units >= 0),
  state            text        NOT NULL,
  expires_at       timestamptz NOT NULL,
  payload          jsonb       NOT NULL,
  CONSTRAINT usage_reservations_task_capability_key UNIQUE (task_id, capability)
)
`;

const USAGE_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS usage_ledger (
  id                        uuid        PRIMARY KEY,
  event_key                 text        NOT NULL UNIQUE,
  task_id                   uuid        NULL REFERENCES ai_tasks(id),
  owner_student_id          uuid        NOT NULL REFERENCES users(id),
  capability                text        NOT NULL,
  quantity                  bigint      NOT NULL CHECK (quantity >= 0),
  unit                      text        NOT NULL,
  provider                  text        NOT NULL,
  model_id                  text        NULL,
  estimated_credits         bigint      NULL CHECK (estimated_credits IS NULL OR estimated_credits >= 0),
  provider_reported_credits bigint      NULL
    CHECK (provider_reported_credits IS NULL OR provider_reported_credits >= 0),
  duration_ms               bigint      NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  occurred_at               timestamptz NOT NULL,
  payload                   jsonb       NOT NULL
)
`;

/**
 * §3.3 逐字给出的表 —— 这是本单**唯一**从 ZLQ-208 接过来的东西。
 *
 * ZLQ-216 §12.3 把 D5 的其余前置裁定 park 在 `backlog`（「停止非删除」），而 §3.3 的
 * `BlobDigestIndex` SQL 被 F1 明确点名要交付，因为只有它能把 `ObjectStore` 的生产实现
 * 从「Blob 说 put 成功了」升级成「服务端完整读回并实测字节 hash 与已持久化 expected
 * hash 一致」。§3.3 的原话：「索引缺失的对象不能当作已校验产物放行 Range/read。」
 * 「不得 head/ETag 冒充摘要」—— Blob 的 ETag 不是 SHA-256，这一点在
 * `drivers/vercel-blob.ts` 的 `BlobHeadResult.etag` 上尤其容易被误用。
 */
const BLOB_DIGEST_INDEX_DDL = `
CREATE TABLE blob_digest_index (
  pathname text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
)
`;

/**
 * 本期唯一一条迁移。
 *
 * 顺序即依赖：`users` → `password_credentials` / `account_sessions` → `projects`（无
 * `current_version_id` FK）→ `ai_tasks` → `versions`（`source_task_id` FK 内联，因为
 * `ai_tasks` 已存在）→ 补 `projects.current_version_id` FK → `task_private` →
 * `task_events` → `owner_secrets` → `artifact_files` → `preview_tickets` →
 * `object_read_grants` → `grant_read_leases` → `usage_reservations` → `usage_ledger` →
 * `blob_digest_index`。
 *
 * 全部语句用 `IF NOT EXISTS`（除 §3.3 逐字抄来的 `blob_digest_index`，它必须原样），
 * 这样一条**已经跑过一半就崩溃**的迁移重跑时不会因为"表已存在"而永久卡死；真正的
 * 原子性由 runner 的单事务保证 —— 崩溃时整条迁移回滚，`schema_migrations` 里没有版本
 * 行，下次重跑从头再来。
 */
export const SQL_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: '0001_initial_slice',
    statements: [
      USERS_DDL,
      PASSWORD_CREDENTIALS_DDL,
      ACCOUNT_SESSIONS_DDL,
      ACCOUNT_SESSIONS_INDEX_DDL,
      PROJECTS_DDL,
      PROJECTS_INDEX_DDL,
      AI_TASKS_DDL,
      AI_TASKS_QUEUE_INDEX_DDL,
      AI_TASKS_ONE_ACTIVE_PER_PROJECT_INDEX_DDL,
      VERSIONS_DDL,
      PROJECTS_CURRENT_VERSION_FK_DDL,
      TASK_PRIVATE_DDL,
      TASK_EVENTS_DDL,
      OWNER_SECRETS_DDL,
      ARTIFACT_FILES_DDL,
      PREVIEW_TICKETS_DDL,
      OBJECT_READ_GRANTS_DDL,
      GRANT_READ_LEASES_DDL,
      USAGE_RESERVATIONS_DDL,
      USAGE_LEDGER_DDL,
      BLOB_DIGEST_INDEX_DDL,
    ],
  },
];

/** §3.2 表清单（16 张）＋ §3.3 的 `blob_digest_index`，共 17 张。 */
export const SLICE_TABLE_NAMES = [
  'users',
  'password_credentials',
  'account_sessions',
  'projects',
  'versions',
  'ai_tasks',
  'task_private',
  'task_events',
  'owner_secrets',
  'artifact_files',
  'preview_tickets',
  'object_read_grants',
  'grant_read_leases',
  'usage_reservations',
  'usage_ledger',
  'schema_migrations',
  'blob_digest_index',
] as const;
export type SliceTableName = (typeof SLICE_TABLE_NAMES)[number];

/**
 * 迁移 checksum。
 *
 * §3.2：「迁移 runner 按版本/checksum 执行」。checksum 的用途是**发现已应用的迁移被
 * 事后改写** —— 一个已经跑过 `0001` 的数据库，如果代码里的 `0001` 变了，runner 必须
 * 报错而不是静默跳过，否则两个环境的 schema 会分叉且无人知晓。
 *
 * 归一化只做「按语句拼接」这一件事：空白与换行不影响语义，但**语句顺序影响**，所以
 * 用 `\u0000` 分隔而不是空格 —— 分隔符不可能出现在 SQL 文本里，`['a b','c']` 与
 * `['a','b c']` 就不会撞出同一个 checksum。
 */
export function migrationChecksum(migration: SqlMigration): string {
  return createHash('sha256')
    .update(migration.version)
    .update('\u0000')
    .update(migration.statements.join('\u0000'))
    .digest('hex');
}

/**
 * `blob_digest_index` 的幂等 upsert —— §3.3 逐字给出的语句。
 *
 * 这条 SQL 的精妙之处全在 `WHERE`：`ON CONFLICT … DO UPDATE SET sha256 =
 * blob_digest_index.sha256`（把自己赋给自己，即"什么都不改"）配一个
 * `WHERE blob_digest_index.sha256 = EXCLUDED.sha256`。于是
 *
 * - 首次插入 ⇒ `RETURNING` 一行；
 * - 同 pathname 同摘要 ⇒ 冲突、`WHERE` 成立、执行一次无变化的 UPDATE ⇒ `RETURNING` 一行；
 * - 同 pathname **不同**摘要 ⇒ 冲突、`WHERE` 不成立、UPDATE 被跳过 ⇒ `RETURNING` **零行**。
 *
 * 「返回一行 vs 零行」因此成了唯一需要判定的信号，§3.3：「零行＝同 pathname 不同摘要，
 * 按现有 ObjectStore 冲突错误拒绝，**不覆盖摘要**。」这比"先 SELECT 再 INSERT"强的地方
 * 是它没有竞态窗口：两个并发 `remember` 里必有一个看到零行。
 *
 * 参数化是硬性要求（§3.1「所有生产 SQL 参数化」），pathname 与 sha256 都来自外部。
 */
export const BLOB_DIGEST_INDEX_UPSERT_SQL = `
INSERT INTO blob_digest_index(pathname, sha256)
VALUES ($1, $2)
ON CONFLICT(pathname) DO UPDATE SET sha256 = blob_digest_index.sha256
WHERE blob_digest_index.sha256 = EXCLUDED.sha256
RETURNING pathname
`;

/** §3.3：「`digestOf`：`SELECT sha256 FROM blob_digest_index WHERE pathname=$1`，没有行返回 null。」 */
export const BLOB_DIGEST_INDEX_SELECT_SQL = `
SELECT sha256 FROM blob_digest_index WHERE pathname = $1
`;

/**
 * §3.3：「byte_length 可由作品固化记录补齐，不改变两参数接口；不强迫 `remember`
 * 伪造不知道的大小。」
 *
 * 所以补大小是一条**独立**语句，只在调用方确实知道字节数时执行；`remember` 永远只带
 * 两个参数，与冻结的 `BlobDigestIndex` 端口签名一致。`WHERE sha256 = $2` 是防呆：
 * 只给"摘要仍是这一个"的行补大小，避免与并发的冲突拒绝路径交错出"pathname 的摘要已
 * 被拒绝、大小却被写进去"的半更新。
 */
export const BLOB_DIGEST_INDEX_SET_BYTE_LENGTH_SQL = `
UPDATE blob_digest_index SET byte_length = $3
WHERE pathname = $1 AND sha256 = $2 AND byte_length IS NULL
`;

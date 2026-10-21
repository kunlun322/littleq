/**
 * F2 用例消费的**存储与能力接口**（ZLQ-221 §3：「你只写用例，不改 F1 交出来的 ports 形状」）。
 *
 * ## 为什么这些接口不在 `ports/` 目录里
 *
 * `ports/` 是 F1 的产物，本单**一个字都没动它**。把 F2 新增的接口放进同一个目录，会让
 * 「谁拥有这个文件」变成一句需要翻 git log 才能回答的话；放在 `usecases/` 下，接口与它
 * 唯一的消费者相邻，所有权跟着用例走。F1 已经交出的 `TaskUnitOfWork` / `TaskPumpStore`
 * 仍然从 `../ports/*.js` 导入，签名逐字未改。
 *
 * ## 为什么接口在这里、实现在 `apps/api`
 *
 * `packages/application` 的 `package.json` 只有两个工作区依赖、**零第三方生产依赖**，
 * 并且不得 import `@littleq/infra`（`tsc -b` 的项目引用会成环：infra `implements` 这些
 * 端口）。所以「怎么把 `User` 存进 Postgres」这件事只能停在组合根：`apps/api` 是唯一
 * 同时看得见 `@littleq/infra` 的驱动与本文件的单元，依赖图规则
 * `api-contract-no-platform-coupling` 的入向白名单也正是为此留着 `apps/api`。
 *
 * 副作用是**确定性的**：这一层的每个用例都可以在没有数据库的情况下跑成可红可绿
 * （内存替身实现同一批接口），而真实 SQL 的正确性由 `apps/api/test/**` 对着真库验证。
 *
 * ## 一条贯穿全文件的红线
 *
 * 每个方法的 `now` 都是**入参**。这一层不读时钟、不读环境变量、不做 IO —— 与 domain
 * 同一条约束（附录 A §6.3）。「现在几点」由调用方（HTTP 适配层）决定并传进来，用例因此
 * 可复现，超时与过期判定也不会因为跑测试的机器慢而漂移。
 */
import type {
  AccountSession,
  AiTask,
  Project,
  ProjectId,
  ProjectStatus,
  ProjectVersion,
  ProjectVersionId,
  Revision,
  SecretKind,
  SecretRef,
  TaskEvent,
  TaskId,
  Timestamp,
  User,
  UserId,
} from '@littleq/domain';

// ---------------------------------------------------------------------------
// 随机性与摘要
// ---------------------------------------------------------------------------

/**
 * 会话令牌、CSRF 令牌、幂等摘要所需的**唯一**外部不确定源。
 *
 * 做成端口而不是直接 `import { randomBytes } from 'node:crypto'`：本层的用例必须能在
 * 测试里跑成确定性的（给定同一个随机源，登录两次得到同一个令牌），否则「令牌哈希真的
 * 被存下来了、明文没有被存下来」这类断言只能靠运气。
 */
export interface RandomSource {
  /** 密码学安全随机字节。 */
  bytes(length: number): Uint8Array;
  /** SHA-256。字符串入参按 UTF-8 编码。 */
  sha256(input: Uint8Array | string): Uint8Array;
  /** 新的 UUIDv7（时间有序，供主键使用）。 */
  uuidV7(): string;
}

// ---------------------------------------------------------------------------
// 账号与会话
// ---------------------------------------------------------------------------

/**
 * 口令凭据的**存储形态**，字段与 `password_credentials` 表逐列对应。
 *
 * 参数（`scryptN` / `scryptR` / `scryptP` / `hashBytes`）随行走，不是全局常量：这样
 * 提高成本参数不需要重算既有哈希，校验时按行里的参数重算即可。
 * `packages/infra` 的 `password/scrypt.ts` 写的就是这份形状，两边互操作。
 */
export interface PasswordCredentialRecord {
  readonly salt: Uint8Array;
  readonly passwordHash: Uint8Array;
  readonly scryptN: number;
  readonly scryptR: number;
  readonly scryptP: number;
  readonly hashBytes: number;
}

export interface StoredAccount {
  readonly user: User;
  /** `null` = 这个账号没有口令凭据（本切片不产生这种账号，但形状上必须允许）。 */
  readonly credential: PasswordCredentialRecord | null;
}

export interface AccountDirectory {
  /**
   * 按**归一化登录名键**查找。
   *
   * 键由 domain 的 `userLoginNameKey` 算出（`users.login_name` 上有 UNIQUE 约束）。
   * 用例不得拿原始 `loginName` 直接比字符串 —— 大小写与首尾空白的归一化规则属于
   * domain，在这里重抄一遍就会漂移。
   */
  findByLoginNameKey(loginNameKey: string): Promise<StoredAccount | null>;
  findById(userId: UserId): Promise<User | null>;
}

/**
 * 会话的存储形态：**令牌明文不在其中**。
 *
 * `account_sessions.token_hash` 是 `bytea UNIQUE`，存的是令牌的 SHA-256。cookie 里带的
 * 明文令牌只在签发那一刻存在于响应头，落库的只有摘要 —— 拖库不等于拿到会话（§5）。
 * 因此 `SessionDirectory` 的两个方法一个收明文摘要、一个还明文摘要，谁都没有机会把
 * 明文写进这张表。
 */
export interface StoredSession {
  readonly session: AccountSession;
  readonly tokenHash: Uint8Array;
}

export interface SessionDirectory {
  insert(stored: StoredSession): Promise<void>;
  findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null>;
  /** 覆盖 `payload`（滑动过期、撤销原因都在这里落地）。以 `session.id` 定位行。 */
  save(session: AccountSession): Promise<void>;
}

export interface PasswordHasher {
  /**
   * 常量时间比较的口令校验。
   *
   * 实现必须按 `credential` 里随行的参数重算，并且**不论账号是否存在都花掉一次
   * scrypt**（见 `login` 用例的注释）—— 否则响应时间就成了「这个登录名存在吗」的
   * 预言机。
   */
  verify(plaintext: string, credential: PasswordCredentialRecord): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 项目与版本
// ---------------------------------------------------------------------------

/** 游标分页结果。`nextCursor === null` 表示没有下一页（§5.5）。 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ListProjectsInput {
  /** 服务端固定为已认证学生的 id；调用方传什么都会被覆盖（§5.3）。 */
  readonly ownerStudentId: UserId;
  readonly status: ProjectStatus | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ListVersionsInput {
  readonly projectId: ProjectId;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ProjectDirectory {
  insert(project: Project): Promise<void>;
  findById(projectId: ProjectId): Promise<Project | null>;
  insertVersion(version: ProjectVersion): Promise<void>;
  findVersionById(versionId: ProjectVersionId): Promise<ProjectVersion | null>;
  list(input: ListProjectsInput): Promise<Page<Project>>;
  listVersions(input: ListVersionsInput): Promise<Page<ProjectVersion>>;
}

// ---------------------------------------------------------------------------
// 任务读模型
// ---------------------------------------------------------------------------

/**
 * 任务与事件的**只读**通道。
 *
 * 写方向不在这里：`createTurn` 走 F1 的 `TaskUnitOfWork.createTurn`，pump 的事务走
 * `TaskUnitOfWork.run`，事件追加走 `TaskTransactionTasks.appendEvent`。本接口只服务
 * `GET /tasks/{id}` 与 `GET /tasks/{id}/events`，所以它没有 `save`。
 */
export interface TaskReadDirectory {
  findTask(taskId: TaskId): Promise<AiTask | null>;
  /**
   * 该项目当前**未终态**的写任务，至多一个 —— `ai_tasks_one_active_per_project`
   * 这条部分唯一索引就是它的存储侧保证，所以这里不需要 `limit`。没有则 `null`。
   *
   * `GET /projects/{id}` 的 `activeTask` 键取它（§4.1：两个 nullable 键必须存在）。
   */
  findActiveWriteTask(projectId: ProjectId): Promise<AiTask | null>;
  /**
   * 按 `sequence` 升序返回 `sequence > afterSequence` 的事件；`afterSequence === null`
   * 表示从头开始（SSE 首次连接），否则是 `Last-Event-ID` 重连补发（§5.5）。
   */
  listEvents(
    taskId: TaskId,
    afterSequence: bigint | null,
    limit: number,
  ): Promise<readonly TaskEvent[]>;
}

// ---------------------------------------------------------------------------
// 秘密（BYO 凭据）
// ---------------------------------------------------------------------------

/**
 * 与 `@littleq/infra` 的 `SecretPurpose` **同形但各自声明**。
 *
 * 本层不得 import infra（见文件头），而复用它的类型会让「契约层/应用层依赖基础设施层」
 * 这条被禁止的边偷偷成立。F1 在 `task-lease.ts` 里对 `TaskLease` 用了同一手法；这里的
 * 双向可赋值断言放在 `apps/api/test/application-infra-port-parity.test.ts`，因为组合根
 * 是唯一同时看得见两份声明的单元。
 */
export const SECRET_PURPOSES = ['qca-call', 'bailian-call'] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

export function isSecretPurpose(value: string): value is SecretPurpose {
  return (SECRET_PURPOSES as readonly string[]).includes(value);
}

/** 与 infra 的 `InternalSecretMetadata` 同形。`version` 是内部 generation，**不上线**。 */
export interface InternalSecretMetadata {
  readonly configured: boolean;
  readonly version: number | undefined;
  readonly rotatedAt: Timestamp | undefined;
  readonly revokedAt: Timestamp | undefined;
}

/**
 * BYO 凭据管理端口。
 *
 * 这是 infra 那份冻结 `SecretStore` 的**逐字重述**（理由同上：本层不得 import infra，
 * 而 infra 要 `implements` 它，反向 import 会让 `tsc -b` 的项目引用成环）。双向可赋值
 * 断言在 `apps/api/test/application-infra-port-parity.test.ts` —— 组合根是唯一同时
 * 看得见两份声明的单元，所以看守只能放在那里。
 *
 * ## 为什么这一层不翻译错误
 *
 * `set` 在「已配置且异值」时抛的是下层的 `InfraError('SECRET_ALREADY_CONFIGURED')`，
 * 本层**不**把它翻译成自己的错误类型。三个理由：
 * - `packages/infra/src/errors.ts` 里那张 `PUBLIC_ERROR_CODE` 表已经把它钉成
 *   `REVISION_CONFLICT`、把 `SECRET_NOT_CONFIGURED` 钉成 kind-aware 的
 *   `QCA_CREDENTIAL_NOT_CONFIGURED` / `BAILIAN_CREDENTIAL_NOT_CONFIGURED`。
 *   在应用层再编一套等于制造第二个映射事实源，而 §4.1 的响应形状是冻结的。
 * - 用例**不需要**区分这三种失败来决定下一步：§4.1 把 `PUT` 与 `:rotate` 定成两个
 *   独立操作，「已配置 ⇒ 客户端改走 `:rotate`」是契约的形状，不是用例里的自动回退。
 *   在这里做自动回退反而会静默覆盖一份已配置的凭据。
 * - 因此本层的职责只是「调它、把结果投影成 DTO」，错误原样穿透到组合根的封套映射。
 */
export interface SecretAdmin {
  metadata(ownerId: string, kind: SecretKind): Promise<InternalSecretMetadata>;
  /**
   * 首次配置。已配置且**同值**时幂等返回既有 ref；已配置且**异值**时失败 ——
   * 不许静默覆盖（§3.4 逐字），客户端必须改走 `rotate`。
   */
  set(input: {
    ownerId: string;
    kind: SecretKind;
    plaintext: Uint8Array;
  }): Promise<SecretRef>;
  rotate(input: {
    ownerId: string;
    kind: SecretKind;
    plaintext: Uint8Array;
    expectedVersion: number;
  }): Promise<SecretRef>;
  revoke(input: { ownerId: string; kind: SecretKind; expectedVersion: number }): Promise<void>;
  /** 取明文。只有真正要外呼 provider 的用例才调它；任何响应形状里都没有它的返回值。 */
  read(ref: SecretRef, purpose: SecretPurpose): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// 任务提交与产物
// ---------------------------------------------------------------------------

/** 一次 turn 的输入落库结果：prompt 全文写进对象存储，只把引用带回私有状态。 */
export interface TaskInputStore {
  /**
   * 把用户输入封成一个不可变对象，返回引用与摘要。
   *
   * prompt 全文**不进** `task_private`、不进日志、不进快照（§5）。这张表里只有
   * `input_ref`（对象引用 + sha256 + 字节数），是 `TaskInputRef` 的存储形态。
   */
  put(input: {
    taskId: TaskId;
    body: Uint8Array;
    now: Timestamp;
  }): Promise<{ readonly objectRef: string; readonly sha256: string; readonly byteLength: number }>;
  get(objectRef: string): Promise<Uint8Array>;
}

/** 用量额度读侧：`createTurn` 需要它把「额度耗尽」判成 409 而不是先建任务再失败。 */
export interface UsageDirectory {
  /**
   * 当前周期内该学生某能力的已用总量。
   *
   * `null` 表示没有配置限额（不限），`0` 表示额度就是零（§6.6：额度为零只阻断新的
   * AI task，不阻断读取）。
   */
  availableUnits(input: {
    ownerStudentId: UserId;
    capability: string;
    period: string;
    now: Timestamp;
  }): Promise<number | null>;
  /** 活动中的写任务数（准入判定用；§6.5：全局 10 / 小组 3 是**调度**上限）。 */
  countActiveWriteTasks(input: {
    ownerStudentId: UserId;
    projectId: ProjectId;
  }): Promise<{ readonly global: number; readonly project: number; readonly student: number }>;
}

/** 版本提交后写 `projects.current_version_id` 的 CAS。 */
export interface ProjectVersionCommitter {
  /**
   * 在**一个**事务里把版本追加到项目并推进 `currentVersionId`。
   *
   * 返回 `null` 表示 CAS 失败（项目 revision 已变），调用方映射 `REVISION_CONFLICT`。
   */
  commit(input: {
    project: Project;
    version: ProjectVersion;
    expectedRevision: Revision;
  }): Promise<Project | null>;
}

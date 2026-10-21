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
  ArtifactDigest,
  Capability,
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
  UsagePeriod,
  UsageQuotaSnapshot,
  UsageReservation,
  User,
  UserId,
} from '@littleq/domain';
import type { ScanFileSource } from '@littleq/work-contract';

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
  /**
   * 幂等 scope 内既有受理记录的**只读**投影，没有则 `null`。
   *
   * scope 是 `(projectId, idempotencyKey)`（§5.5：幂等键在项目内唯一，不是全局唯一）。
   * 只取回放分支需要的三个事实：`taskId`（回给客户端）、`requestHash`（区分"同请求重放"
   * 与"同 key 不同请求"→ `IDEMPOTENCY_KEY_REUSED`）、`projectRevision`
   * （**受理时刻**的项目 revision，来自 `ai_tasks.accepted_project_revision` ——
   * 回放必须返回当年那个值，不能现读项目当前 revision，否则重放会"看见"后来的改动）。
   *
   * ## 为什么用例要先读一次，`TaskUnitOfWork.createTurn` 内部还要再查一次
   *
   * 事务内那次是**竞态屏障**，也是事实源；这一次是**排序需要**：额度与准入判定必须发生在
   * 回放短路**之后**，否则一次合法重放会因为额度已被它自己那次受理占满而拿到
   * `USAGE_LIMIT_EXCEEDED` —— 幂等接口对同一个键给出两种响应，正是 §5.5 要防的事。
   * 两次读之间的窗口由事务内那次兜住，所以先读不会放宽任何不变量。
   */
  findTurnAcceptance(input: {
    projectId: ProjectId;
    idempotencyKey: string;
  }): Promise<TurnAcceptanceRecord | null>;
}

/** `TaskReadDirectory.findTurnAcceptance` 的返回形状。 */
export interface TurnAcceptanceRecord {
  readonly taskId: TaskId;
  readonly requestHash: string;
  readonly projectRevision: Revision;
}

/**
 * 重试的写侧：**一个事务**里 CAS 更新 task 行并重新持有该任务的额度预留。
 *
 * ## 为什么它不在 F1 的 `TaskUnitOfWork` 里
 *
 * `TaskUnitOfWork` 只有两个入口：`createTurn`（受理，自带 project 锁与幂等去重）与
 * `run`（**已领取租约**后的推进）。重试两头都不沾 —— 任务处在 `FAILED` / `TIMED_OUT`
 * 终态，没有租约可领，而 `run` 的入参就是 `{lease, expectedRevision}`。把它塞进 `run`
 * 只能先伪造一份租约；而租约是**推进权**的凭证，不是"我想改这一行"的凭证，伪造它等于
 * 让重试与真实推进抢同一把单飞锁。所以重试需要自己的端口，且由 F2 拥有（放在
 * `usecases/` 下），F1 的 `ports/` 一个字没动。
 *
 * ## 为什么是"重新持有"而不是"再插一行"
 *
 * `usage_reservations` 上有 `CONSTRAINT usage_reservations_task_capability_key UNIQUE
 * (task_id, capability)`（`packages/infra/src/sql/migrations.ts:396`）—— 一个 task 的一个
 * capability **只有一行**预留。于是第二次 attempt 不可能 INSERT 出新行：实现必须按这个
 * 唯一键 UPSERT，把既有那一行重新置为 `HELD` 并刷新 `reserved_units` / `expires_at`。
 *
 * 行身份（`id`）因此归实现所有；用例只交出一个用 domain 公开构造函数造的 `HELD`
 * `UsageReservation` 实体，由实现决定保留旧 `id` 还是采用新的。
 *
 * ⚠️ **已声明给 PM 的一处语义缺口**：domain 只有 `commitUsage` / `releaseUsage` /
 * `expireUsage` 三个迁移函数，**没有** `RELEASED → HELD` 的回退，所以"重新持有"只能用
 * 构造函数直接造一个 `HELD` 实体来表达，绕过了状态迁移函数（本单不改 domain，故只能如此）。
 * 账目本身不丢：真正记账的是 `usage_ledger`（append-only、`event_key UNIQUE`），预留行
 * 只是并发占位的凭证。
 */
export interface TaskRetryStore {
  /**
   * 返回 `null` 表示 CAS 失败（`expectedRevision` 不匹配），调用方映射 `REVISION_CONFLICT`。
   * 成功时返回**落库后的** `AiTask`，其 `revision` 就是响应 `ETag` 的来源。
   */
  beginRetryAttempt(input: {
    readonly task: AiTask;
    readonly expectedRevision: Revision;
    readonly reservation: UsageReservation;
    readonly now: Timestamp;
  }): Promise<AiTask | null>;
}

/**
 * 取消路径的额度**释放**：把 `(taskId, capability)` 那一行预留置为 `RELEASED`。
 *
 * ## 为什么它也不在 F1 的 `TaskUnitOfWork` 里
 *
 * `TaskTransactionReservations` 只有 `reserve` 与 `settle` 两个方法，而 `settle` 在实现侧
 * 有 `assertSettleable`（`packages/infra/src/sql/usage-rows.ts:192`）：
 * `isReservationActive(r) || r.state !== 'COMMITTED'` 就抛错。也就是说**这个端口在语义上
 * 只能"提交"，不能"释放"** —— 拿一个 `RELEASED` 实体去调 `settle` 会被 infra 当场拒掉。
 * `reserve` 也不行：它是 `INSERT … ON CONFLICT (task_id, capability) DO NOTHING`，对已存在
 * 的那一行什么都不写。所以释放在 F1 的端口里**没有入口**，只能由 F2 自己开一个，
 * 与 `TaskRetryStore` 同一个理由、同一个自然键 UPSERT 机制。
 *
 * ## 为什么它可以发生在取消事务**之外**（§3.5 的原子性要求不适用于它）
 *
 * §3.5 逐字：「**不能在版本提交失败后单独完成结算**」。它约束的是**结算**——扣学生的额度。
 * 结算若独立提交，版本回滚之后钱已经扣掉，账与作品对不上，那是不可逆的损害。
 * 释放是相反方向的动作：它只会把额度**还回去**。因此"取消已提交而释放没跑完"这个中间态
 * 的后果是"这一格额度暂时还被占着"，不是"学生被多扣了一次"。两种损害的等级不同，
 * 用同一把事务锁去防后者是过度约束，而前者的兜底本来就在（`expiresAt` = 硬截止）。
 *
 * ⚠️ 因此实现必须**幂等**：同一个 `(taskId, capability)` 重复调用得到同一个结果，
 * 不得追加第二行（唯一索引也在 DB 侧兜着）。
 */
export interface TaskReservationReleaser {
  /**
   * @returns 落库后的预留实体；该行不存在时返回 `null`（受理阶段没预留过的不计量任务）。
   */
  releaseReservation(input: {
    readonly taskId: TaskId;
    readonly capability: Capability;
    readonly now: Timestamp;
  }): Promise<UsageReservation | null>;
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
  set(input: { ownerId: string; kind: SecretKind; plaintext: Uint8Array }): Promise<SecretRef>;
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
   * 本周期内该学生该能力的**额度快照**，形状就是 domain 的 `UsageQuotaSnapshot`。
   *
   * 返回快照而不是一个「还剩多少」的数字，是因为 `decideUsageAdmission` 要自己核对
   * `quota.capability` 与任务 kind 推出的 capability 是否一致、并区分「限额行不存在
   * （不限）」与「限额就是 0」。把这两件事在 SQL 侧先算成一个数，等于把 domain 的判定
   * 抄进仓储 —— 而「未设上限 ⇒ ADMIT、额度为 0 ⇒ 只阻断新 AI task」是 §6.6 的原文。
   */
  quotaSnapshot(input: {
    ownerStudentId: UserId;
    capability: Capability;
    period: UsagePeriod;
    now: Timestamp;
  }): Promise<UsageQuotaSnapshot>;
  /**
   * 准入判定所需的四个计数（§6.5）。
   *
   * 全部来自**持久化状态的计数查询**，不是进程内的 Map 或 semaphore —— §6.5 规则 5
   * 逐字：进程内状态不是事实源。`groupId` 在本切片恒为 `null`（`Project` 没有小组字段，
   * 小组视图被 §12.3 排除在本期之外），因此 `group` 恒为 `0`；这两个键仍然保留，
   * 是因为 `AdmissionContext` 要它们，删掉就等于在这里另编一份准入输入形状。
   */
  countActiveWriteTasks(input: {
    ownerStudentId: UserId;
    projectId: ProjectId;
    now: Timestamp;
  }): Promise<{
    readonly global: number;
    readonly group: number;
    readonly student: number;
    readonly project: number;
  }>;
}

// ---------------------------------------------------------------------------
// provider（QCA Forward）
// ---------------------------------------------------------------------------

/**
 * 一次 provider 会话的句柄。
 *
 * 这四个字段就是 `ProviderIdentitySnapshot` 的内容 —— 会话恢复要靠它们（§5.4：冷实例
 * 上 `qca_session_id` 还在，但"它是哪个 template/environment 下的会话"必须能重建），
 * 所以句柄与快照同形，不留第二个表示。
 */
export interface ProviderSessionHandle {
  readonly sessionId: string;
  readonly identityId: string;
  readonly templateId: string;
  readonly environmentId: string;
  readonly templateVersion: string | undefined;
}

/**
 * provider 事件流的**已脱敏前**形态。
 *
 * `TEXT` 是模型输出正文（要进两文件包络的 `index.html`），`FILE` 是 provider 侧产出的
 * 附加文件（进 manifest），`OTHER` 是既不是正文也不是文件的一切（工具调用、思考、
 * 心跳）—— 它被显式建模成一个分支，而不是被丢掉，因为"丢掉"和"看见了但决定不用"
 * 在代码里长得一样，而前者会让 `safePayload` 的白名单失去对照。
 *
 * ⚠️ 这里的 `text` / `bytes` 是**未经扫描**的原始产出。它只允许流向两处：
 * 对象存储（封成产物）与扫描器（判安全）。**不得**流向任何 `TaskEvent.safePayload`、
 * 任何日志、任何 HTTP 响应体 —— 那是 §5.2 的 BLOCKED 语义要拦的东西。
 */
export type ProviderTurnEvent =
  | { readonly externalId: string; readonly kind: 'TEXT'; readonly text: string }
  | {
      readonly externalId: string;
      readonly kind: 'FILE';
      readonly path: string;
      readonly bytes: Uint8Array;
    }
  | { readonly externalId: string; readonly kind: 'OTHER' };

export interface ProviderEventBatch {
  readonly items: readonly ProviderTurnEvent[];
  /** provider 侧的游标原值，落 `task_private.qca_event_cursor`；本层不解释它的结构。 */
  readonly nextCursor: string | null;
  /** provider 认为这一回合已经结束（不再有后续事件）。 */
  readonly turnComplete: boolean;
}

/**
 * QCA Forward 的**服务端 fetch** 客户端（§4.3：不引入 AI SDK）。
 *
 * 只有四个方法，对应 §5.3 的四类外呼；每个方法就是**一次**外部操作，因此每个方法最多
 * 在**一个** pump 切片里被调用一次 —— 这条约束不是注释里的建议，而是 pump 用例的写法：
 * 它按 `internalSubphase` 分派，一个子相位只调一个方法，然后立刻持久化并返回。
 *
 * `externalOperationKey` 由调用方用 domain 的 `formatExternalOperationKey(taskId, stage,
 * attempt)` 生成并**先落库**（§5.3：外呼前事务保存意图，事务外请求，回执先持久化）。
 * 实现必须把它当成 provider 侧的幂等键传下去，这样"回执丢失后重放同一个 key"不会
 * 产生第二次计费动作（§11.2 第 4 项负对照要的就是这个）。
 *
 * 每个方法都收 `budgetMs` 与 `abortSignal`：8 秒请求预算里要给 HTTP 响应留时间，
 * 所以外呼自己必须先于预算结束（§5.1）。实现不得自己 `setTimeout` 续命。
 */
export interface TurnProviderClient {
  createSession(input: {
    readonly externalOperationKey: string;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderSessionHandle>;
  sendUserMessage(input: {
    readonly session: ProviderSessionHandle;
    readonly body: Uint8Array;
    readonly externalOperationKey: string;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<void>;
  listEvents(input: {
    readonly session: ProviderSessionHandle;
    readonly cursor: string | null;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderEventBatch>;
  interrupt(input: {
    readonly session: ProviderSessionHandle;
    readonly externalOperationKey: string;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<void>;
}

/**
 * provider 的固定配置（§4.3：「既有 Forward Template/Identity/Environment 的固定配置」）。
 *
 * 从环境变量读出来交给组合根，用例只负责把它转成 `createSession` 的入参与
 * `ProviderIdentitySnapshot`。**不在运行时自动注册云资源、不创建新付费计划** ——
 * 所以这里没有任何 `create*` 方法，只有三个已存在资源的 id。
 */
export interface ProviderConfiguration {
  readonly identityId: string;
  readonly templateId: string;
  readonly environmentId: string;
}

// ---------------------------------------------------------------------------
// 产物（两文件包络）
// ---------------------------------------------------------------------------

/**
 * 产物对象存储。与 infra 的 `ObjectStore` 同向但**更窄**：这一层只需要"写一个不可变
 * 对象"与"把它当成扫描输入打开"，`head` / `deletePrefix` / `health` 是 infra 与运维的
 * 事，放进来只会让用例有机会绕过 grant 直读。
 *
 * 读取一律经 `openScanSource`（返回 work-contract 的 `ScanFileSource`）或 `read`
 * （只给 preview grant 的实现用），**不返回任何 provider URL** —— 对外的读取入口只有
 * 平台自己的 opaque grant URL（infra `ports/object-store.ts` 的同一条红线）。
 */
export interface WorkArtifactStore {
  /** 写一个不可覆盖的对象；同 key 第二次写必须失败，不返回引用。 */
  put(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly abortSignal: AbortSignal;
  }): Promise<{
    readonly objectRef: string;
    readonly sha256: ArtifactDigest;
    readonly byteLength: number;
  }>;
  /** 把已固化的产物打开成扫描输入。产物不存在 ⇒ `RESOURCE_NOT_FOUND`。 */
  openScanSource(objectRef: string): Promise<ScanFileSource>;
  read(objectRef: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// 预览
// ---------------------------------------------------------------------------

/**
 * 与 infra 的 `RuntimePublisher.publishPreview` 同形的**只发不撤**子集。
 *
 * 刻意不含 `revokePreview`：`POST /projects/{id}/preview` 是签发，撤销属于运维与
 * grant 层的 TTL，本期没有对外的撤销接口（契约里没有这个 operation）。少一个方法
 * 就少一条"用例可以悄悄把预览撤掉"的路径。
 *
 * 返回的 `url` 是短期、独立源的 opaque grant URL；它**只**进 `createPreviewResponseSchema`
 * 的 `url` 字段（≤512 字符），不进日志、不进 `TaskEvent`。
 */
export interface PreviewPublisher {
  publishPreview(input: {
    readonly projectId: ProjectId;
    readonly projectVersionId: ProjectVersionId;
    readonly artifactHash: ArtifactDigest;
    readonly ttlSeconds: number;
    readonly now: Timestamp;
  }): Promise<{ readonly url: string; readonly expiresAt: Timestamp }>;
}

/**
 * `usecases/pump.ts` 的真实测试：有界短步驱动器（ZLQ-221 §4.3 / §5.1–§5.4）。
 *
 * ## 这份测试要证明什么
 *
 * 驱动器对外承诺的是四条**否定性**事实，它们都无法靠"跑一遍没报错"来证明：
 *
 * 1. **一个请求只推进一片，且推进必须真的落库。** 六片走完（建会话 → 发消息 → 收事件
 *    → 封包 → 扫描 → 提交）之后必须有**恰好一行**版本、`project.currentVersionId` 指
 *    向它、预留变成 `COMMITTED`、账目**恰好一条**。任何一处 CAS 期望值写错，表现都是
 *    `REVISION_CONFLICT`；任何一处忘了传播 `appendEvent` 的返回值，表现都是 ETag 报旧值
 *    而测试仍然绿 —— 所以第 2 组把 revision 的**算术**也钉死。
 * 2. **§5.3 的三段式顺序不可颠倒，回执必须真的落库。** 事务 A 写 `SENT` 意图，事务外
 *    发请求，事务 B 先把回执写成 `RECEIPT_RECORDED` 再推进 task。第 4 组直接读落库后的
 *    journal 断言这一点：一个把回执丢在内存里的实现，任务照样能推进到 `SUCCEEDED`，
 *    只有读 journal 才看得见它少了什么。
 * 3. **重放不带第二次计费。** `externalKey` 是 `(taskId, stage, attempt)` 的纯函数，所以
 *    "回执丢了、下次重放"必然带同一个 key（第 5 组），而换了 attempt 必然换 key。
 *    这是 §11.2 第 4 项负对照在**用例层**的机制证明。
 * 4. **明文红线。** provider 的原始正文与 prompt 全文不得出现在任何 `TaskEvent.safePayload`
 *    里（第 12 组用一个哨兵字符串全文搜索所有已落库事件）。
 *
 * 另外三组钉住 PM 的两条裁定：
 * - **裁定 (a).1**：`SEALING` 片拿到真产物之后必须**整行覆盖**受理时刻写下的
 *   `input_snapshot` / `collection_cursor`（第 3 组）。
 * - **裁定 (a).2**：受理时刻那两列填的是 prompt 输入对象的真实摘要（第 3 组同时断言
 *   "覆盖前它等于受理值、覆盖后不等于"，两头都钉住，避免测试对占位符点头）。
 *
 * ## 反面对照（positive control）
 *
 * 内存替身必须**真的会失败**，否则上面所有断言都是对一个永远点头的双胞胎说话。第 1 组
 * 专门做这件事：让事务替身在 `expectedRevision` 失配时抛错并**回滚**、让产物替身在同
 * key 第二次写时抛错、让结算替身拒绝任何非 `COMMITTED` 状态 —— 三个都先确认它们红了，
 * 后面"因为传对了所以没红"才是有意义的绿。
 *
 * ## 替身的保真度边界（如实申报）
 *
 * `TaskUnitOfWork.run` 的替身逐条照抄 `packages/infra/src/sql/task-unit-of-work.ts:158-183`
 * 的语义：加锁 → 核验租约 → 比对 `expectedRevision` → 用 `latest` 累加器跟踪事务内每一次
 * CAS → 收尾再核验一次租约与 revision → 抛错则整事务回滚。`bindTasks` 的 `track()`
 * （`:229-234`）也照抄：`save`/`appendEvent` 返回 `null` 时抛 `REVISION_CONFLICT`。
 * `privateState.save` 照抄 `mergeJournal`（`:305-330`）的三条合并规则。
 *
 * **没有**照抄的是 SQL 本身、行编解码、以及 `TaskPumpStore.acquire` 的 13 条判据顺序 ——
 * 后者由 `acquire-order.test.ts` 纯常量钉死，这里的替身只做驱动器需要的最小建模
 * （终态直通、If-Match 失配直通、PUMP 模式下的 `CLAIM_QUEUED`、CANCEL 模式下的
 * `requestCancel` + 定向租约）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  type AccountSession,
  type AiTask,
  type Capability,
  type Project,
  type ProjectId,
  type ProjectVersion,
  type ProjectVersionId,
  type Revision,
  type TaskEvent,
  type TaskId,
  type TaskState,
  type Timestamp,
  type UsageLedgerEntry,
  type UsageReservation,
  type User,
  DomainError,
  CANCELLABLE_TASK_STATES,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  assertEventFollows,
  brand,
  compareRevisions,
  createAccountSession,
  createAiTask,
  createProject,
  createProjectVersion,
  createUser,
  nextRevision,
  parseAttempt,
  parseLockDurationMinutes,
  parseLoginName,
  parseMaxFailedAttempts,
  parseNickname,
  parseTimestamp,
  releaseUsage,
  requestCancel,
  transitionTask,
} from '@littleq/domain';
import type {
  ScanCheckpoint,
  ScanFileSource,
  ScanReport,
  ScanStepResult,
  StartScanInput,
  WorkScanner,
} from '@littleq/work-contract';

import type { TaskLease } from '../src/task-lease.js';
import type { TaskAcquireResult, TaskPumpStore } from '../src/ports/task-pump-store.js';
import type { TaskTransaction, TaskUnitOfWork } from '../src/ports/task-unit-of-work.js';
import {
  type CollectionCursor,
  type OperationJournalEntry,
  type TaskPrivateRecord,
  createCollectionCursor,
  createTaskInputRef,
  createTaskPrivateRecord,
  parseInternalSubphase,
} from '../src/task-private.js';
import type { Actor } from '../src/usecases/authorization.js';
import type {
  ListProjectsInput,
  ListVersionsInput,
  Page,
  ProjectDirectory,
  ProviderEventBatch,
  ProviderSessionHandle,
  ProviderTurnEvent,
  RandomSource,
  TaskInputStore,
  TaskReadDirectory,
  TaskReservationReleaser,
  TurnProviderClient,
  WorkArtifactStore,
} from '../src/usecases/ports.js';
import {
  type DriveTaskInput,
  type PumpServices,
  type ScanInputAssembler,
  ENVELOPE_HTML_PATH,
  ENVELOPE_MANIFEST_PATH,
  ENVELOPE_MAX_BYTES,
  cancelTaskUseCase,
  chunkKey,
  collectPayload,
  envelopeKey,
  mapExternalFailure,
  pumpTaskUseCase,
} from '../src/usecases/pump.js';
import { acceptanceTimeScanIdentity } from '../src/usecases/turns.js';

// ---------------------------------------------------------------------------
// 事实（全部是常量，不读时钟）
// ---------------------------------------------------------------------------

const NOW: Timestamp = parseTimestamp('2026-10-22T03:04:05.000Z');
const STEP: Timestamp = parseTimestamp('2026-10-22T03:04:06.000Z');
const LEASE_UNTIL: Timestamp = parseTimestamp('2026-10-22T04:04:05.000Z');

const LOCK_POLICY = {
  maxFailedAttempts: parseMaxFailedAttempts(5),
  lockDurationMinutes: parseLockDurationMinutes(30),
};

const OWNER_ID = '0198c0a1-0000-7000-8000-000000000001';
const STUDENT_ID = '0198c0a1-0000-7000-8000-000000000002';
const OTHER_STUDENT_ID = '0198c0a1-0000-7000-8000-000000000003';
const PROJECT_ID = '0198c0a1-3333-7000-8000-000000000001';
const TASK_ID = '0198c0a1-2222-7000-8000-000000000001';
const SESSION_ID = 'sess_0198c0a12222700080000000000000aa';
const WORKER_ID = 'worker-a';

/** 明文红线的哨兵：它只允许出现在对象存储里，绝不允许出现在事件正文里。 */
const PROMPT_SENTINEL = '把这只小猫做成会跳的动画 SENTINEL-8f3a2c';
const OUTPUT_SENTINEL = '<h1>会跳的小猫 SENTINEL-77b1</h1>';

const PROVIDER_CONFIGURATION = {
  identityId: 'idn_1',
  templateId: 'tpl_1',
  environmentId: 'env_1',
  templateVersion: '3',
};

/**
 * 终态与可取消态**直接引用 domain 导出的那两个集合**，不手抄一份。
 *
 * 手抄一份的问题不是啰嗦，是它会与迁移表悄悄漂移：替身拿一个过期的集合做直通判定，
 * 测出来的就是一条生产上不存在的路径（本轮的取消路径正栽在这上面）。
 */
const TERMINAL_STATES: readonly TaskState[] = TERMINAL_TASK_STATES;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 学生那一句话的字节。全篇只此一份：受理时刻摘要与"明文红线"都从它算。 */
const PROMPT_BYTES: Uint8Array = textBytes(PROMPT_SENTINEL);

function user(id: string, role: 'OWNER' | 'STUDENT', loginName: string): User {
  return createUser({
    id,
    role,
    loginName: parseLoginName(loginName),
    nickname: parseNickname(loginName),
    ageBand: role === 'STUDENT' ? 'L1' : null,
    status: 'ACTIVE',
    ownerId: role === 'STUDENT' ? OWNER_ID : null,
    lockPolicy: LOCK_POLICY,
    revision: '1',
  });
}

function actorFor(id: string, role: 'OWNER' | 'STUDENT', loginName: string): Actor {
  const actorUser = user(id, role, loginName);
  const session: AccountSession = createAccountSession({
    id: '0198c0a1-1111-7000-8000-000000000001',
    userId: actorUser.id,
    status: 'ACTIVE',
    rememberMe: false,
    issuedAt: NOW,
    lastSeenAt: NOW,
    idleExpiresAt: parseTimestamp('2026-10-22T03:34:05.000Z'),
    absoluteExpiresAt: parseTimestamp('2026-10-29T03:04:05.000Z'),
    revokedAt: null,
    revocationReason: null,
  });
  return { user: actorUser, session };
}

// ---------------------------------------------------------------------------
// 内存"数据库"
// ---------------------------------------------------------------------------

type Snapshot = {
  readonly tasks: Map<string, AiTask>;
  readonly privates: Map<string, TaskPrivateRecord>;
  readonly events: Map<string, TaskEvent[]>;
  readonly projects: Map<string, Project>;
  readonly versions: Map<string, ProjectVersion>;
  readonly reservations: Map<string, UsageReservation>;
  readonly ledger: UsageLedgerEntry[];
  readonly leases: Map<string, TaskLease>;
};

class MemoryStore {
  readonly tasks = new Map<string, AiTask>();
  readonly privates = new Map<string, TaskPrivateRecord>();
  readonly events = new Map<string, TaskEvent[]>();
  readonly projects = new Map<string, Project>();
  readonly versions = new Map<string, ProjectVersion>();
  readonly reservations = new Map<string, UsageReservation>();
  readonly ledger: UsageLedgerEntry[] = [];
  readonly leases = new Map<string, TaskLease>();
  /**
   * 结算失败注入。挂在 store 上而不是模块级全局：全局会被 `makeHarness` 的复位清掉，
   * 于是"先置 true 再造 harness"的用例静默地测了个空 —— 探针自己的假阴性。
   */
  failSettle = false;

  /** 实体一律不可变（每个变更函数返回新对象），所以浅拷贝 Map 就是完整快照。 */
  snapshot(): Snapshot {
    return {
      tasks: new Map(this.tasks),
      privates: new Map(this.privates),
      events: new Map([...this.events].map(([key, value]) => [key, [...value]])),
      projects: new Map(this.projects),
      versions: new Map(this.versions),
      reservations: new Map(this.reservations),
      ledger: [...this.ledger],
      leases: new Map(this.leases),
    };
  }

  restore(snapshot: Snapshot): void {
    const replace = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    replace(this.tasks, snapshot.tasks);
    replace(this.privates, snapshot.privates);
    replace(this.events, snapshot.events);
    replace(this.projects, snapshot.projects);
    replace(this.versions, snapshot.versions);
    replace(this.reservations, snapshot.reservations);
    replace(this.leases, snapshot.leases);
    this.ledger.length = 0;
    this.ledger.push(...snapshot.ledger);
  }

  eventsOf(taskId: TaskId): readonly TaskEvent[] {
    return this.events.get(String(taskId)) ?? [];
  }

  reservationKey(taskId: TaskId, capability: Capability): string {
    return `${String(taskId)}:${capability}`;
  }
}

/** infra `bindTasks` 的 `track()`：CAS 返回 null 就抛，并把 `latest` 推到新值。 */
function track(task: AiTask | null, latest: { revision: Revision }): AiTask {
  if (task === null) throw new DomainError('REVISION_CONFLICT', 'AiTask.revision');
  latest.revision = task.revision;
  return task;
}

/** infra `mergeJournal` 的三条规则，逐条照抄（见文件头"保真度边界"）。 */
function mergeJournal(stored: TaskPrivateRecord, incoming: TaskPrivateRecord): TaskPrivateRecord {
  const byKey = new Map<string, OperationJournalEntry>(
    incoming.operationJournal.map((entry) => [String(entry.operationKey), entry]),
  );
  const storedKeys = new Set<string>(stored.operationJournal.map((e) => String(e.operationKey)));
  const kept = stored.operationJournal.map((entry) => {
    const next = byKey.get(String(entry.operationKey));
    if (next === undefined) return entry;
    return entry.intent === 'RECEIPT_RECORDED' ? entry : next;
  });
  const appended = incoming.operationJournal.filter(
    (entry) => !storedKeys.has(String(entry.operationKey)),
  );
  return createTaskPrivateRecord({ ...incoming, operationJournal: [...kept, ...appended] });
}

function unsupported(name: string): never {
  throw new DomainError('INTERNAL_ERROR', name);
}

function makeUnitOfWork(store: MemoryStore): TaskUnitOfWork {
  const bind = (latest: { revision: Revision }): TaskTransaction => ({
    tasks: {
      claim: () => unsupported('TaskTransactionTasks.claim'),
      renewLease: () => unsupported('TaskTransactionTasks.renewLease'),
      reacquireLease: () => unsupported('TaskTransactionTasks.reacquireLease'),
      requeueOnLeaseExpiry: () => unsupported('TaskTransactionTasks.requeueOnLeaseExpiry'),
      releaseLease: () => unsupported('TaskTransactionTasks.releaseLease'),
      scheduleNextRun: () => unsupported('TaskTransactionTasks.scheduleNextRun'),
      async findById(taskId: TaskId): Promise<AiTask | null> {
        return store.tasks.get(String(taskId)) ?? null;
      },
      async save(input: {
        readonly task: AiTask;
        readonly expectedRevision: Revision;
      }): Promise<AiTask | null> {
        const key = String(input.task.id);
        const stored = store.tasks.get(key);
        if (
          stored === undefined ||
          compareRevisions(stored.revision, input.expectedRevision) !== 0
        ) {
          // infra 的 `track(null, …)` 就地抛，所以真实实现从不把 null 交回调用方；
          // 端口类型允许 null 只是留给别的实现。替身照 infra 的语义走。
          return track(null, latest);
        }
        store.tasks.set(key, input.task);
        return track(input.task, latest);
      },
      async appendEvent(input: {
        readonly event: TaskEvent;
        readonly expectedRevision: Revision;
      }): Promise<AiTask | null> {
        const key = String(input.event.taskId);
        const stored = store.tasks.get(key);
        if (
          stored === undefined ||
          compareRevisions(stored.revision, input.expectedRevision) !== 0
        ) {
          return track(null, latest);
        }
        const list = store.events.get(key) ?? [];
        const last = list[list.length - 1] ?? null;
        assertEventFollows(input.event, last);
        list.push(input.event);
        store.events.set(key, list);
        // infra `task-repository.ts:249-270`：返回的是**库里那一行**推一格 revision，
        // 不是调用方内存里改出来的实体。
        const next: AiTask = { ...stored, revision: nextRevision(stored.revision) };
        store.tasks.set(key, next);
        return track(next, latest);
      },
    },
    projects: {
      async findById(projectId: ProjectId): Promise<Project | null> {
        return store.projects.get(String(projectId)) ?? null;
      },
      async save(input: {
        readonly project: Project;
        readonly expectedRevision: Revision;
      }): Promise<Project | null> {
        const key = String(input.project.id);
        const stored = store.projects.get(key);
        if (
          stored === undefined ||
          compareRevisions(stored.revision, input.expectedRevision) !== 0
        ) {
          return null;
        }
        store.projects.set(key, input.project);
        return input.project;
      },
    },
    versions: {
      async findById(versionId): Promise<ProjectVersion | null> {
        return store.versions.get(String(versionId)) ?? null;
      },
      async findBySourceTaskId(taskId: TaskId): Promise<ProjectVersion | null> {
        for (const version of store.versions.values()) {
          if (String(version.sourceTaskId) === String(taskId)) return version;
        }
        return null;
      },
      async insert(version: ProjectVersion): Promise<ProjectVersion> {
        // `UNIQUE(source_task_id)`：撞了就让错误冒出去，不翻译成 REVISION_CONFLICT
        // （infra `bindVersions` 的同一条理由）。
        for (const existing of store.versions.values()) {
          if (String(existing.sourceTaskId) === String(version.sourceTaskId)) {
            throw DomainError.invalid('ProjectVersion.sourceTaskId');
          }
        }
        store.versions.set(String(version.id), version);
        return version;
      },
    },
    privateState: {
      async findByTaskId(taskId: TaskId): Promise<TaskPrivateRecord | null> {
        return store.privates.get(String(taskId)) ?? null;
      },
      async save(record: TaskPrivateRecord): Promise<void> {
        const key = String(record.taskId);
        const stored = store.privates.get(key);
        store.privates.set(key, stored === undefined ? record : mergeJournal(stored, record));
      },
    },
    reservations: {
      async reserve(reservation: UsageReservation): Promise<void> {
        const key = store.reservationKey(reservation.taskId, reservation.capability);
        if (store.reservations.has(key)) return;
        store.reservations.set(key, reservation);
      },
      async settle(input: {
        readonly reservation: UsageReservation;
        readonly ledger: UsageLedgerEntry;
      }): Promise<void> {
        if (store.failSettle) throw DomainError.invalid('UsageReservation.state');
        // infra `assertSettleable`（`usage-rows.ts:192`）：只接受 COMMITTED。
        if (input.reservation.state !== 'COMMITTED') {
          throw DomainError.invalid('UsageReservation.state');
        }
        const key = store.reservationKey(input.reservation.taskId, input.reservation.capability);
        store.reservations.set(key, input.reservation);
        // `ON CONFLICT (event_key) DO NOTHING`：重入 COMMITTING 是成功，不是错误。
        if (!store.ledger.some((e) => e.eventKey === input.ledger.eventKey)) {
          store.ledger.push(input.ledger);
        }
      },
    },
  });

  const assertLeaseHeld = (lease: TaskLease): void => {
    const held = store.leases.get(String(lease.taskId));
    // infra 把三处失败（无租约 / 令牌不符 / 已过期）一律映射 REVISION_CONFLICT。
    if (held === undefined || held.leaseToken !== lease.leaseToken) {
      throw new DomainError('REVISION_CONFLICT', 'TaskLease.leaseToken');
    }
    if (compareTimestamps(held.leaseUntil, lease.leaseUntil) < 0) {
      throw new DomainError('REVISION_CONFLICT', 'TaskLease.leaseUntil');
    }
  };

  return {
    createTurn: () => unsupported('TaskUnitOfWork.createTurn'),
    async run<T>(
      input: { readonly lease: TaskLease; readonly expectedRevision: Revision },
      work: (bound: TaskTransaction) => Promise<T>,
    ): Promise<T> {
      const snapshot = store.snapshot();
      try {
        const key = String(input.lease.taskId);
        const locked = store.tasks.get(key);
        if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 'AiTask');
        assertLeaseHeld(input.lease);
        if (compareRevisions(locked.revision, input.expectedRevision) !== 0) {
          throw new DomainError('REVISION_CONFLICT', 'AiTask.revision');
        }
        const latest = { revision: locked.revision };
        const result = await work(bind(latest));
        const final = store.tasks.get(key);
        if (final === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 'AiTask');
        assertLeaseHeld(input.lease);
        if (compareRevisions(final.revision, latest.revision) !== 0) {
          throw new DomainError('REVISION_CONFLICT', 'AiTask.revision');
        }
        return result;
      } catch (error) {
        store.restore(snapshot);
        throw error;
      }
    },
  };
}

function compareTimestamps(left: Timestamp, right: Timestamp): number {
  return Date.parse(left) - Date.parse(right);
}

// ---------------------------------------------------------------------------
// 其余替身
// ---------------------------------------------------------------------------

class RandomDouble implements RandomSource {
  private counter = 0;

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = index % 251;
    return out;
  }

  sha256(input: Uint8Array | string): Uint8Array {
    const bytes = typeof input === 'string' ? textBytes(input) : input;
    return new Uint8Array(createHash('sha256').update(bytes).digest());
  }

  /** 确定性 UUIDv7：形状满足 `UUID_V7_PATTERN`（第 13 位 7、第 17 位 8）。 */
  uuidV7(): string {
    this.counter += 1;
    const tail = String(this.counter).padStart(12, '0');
    return `0198c0a1-9999-7000-8000-${tail}`;
  }
}

class ArtifactDouble implements WorkArtifactStore {
  readonly objects = new Map<string, { readonly body: Uint8Array; readonly sha256: string }>();
  readonly putKeys: string[] = [];

  async put(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly abortSignal: AbortSignal;
  }): Promise<{ readonly objectRef: string; readonly sha256: never; readonly byteLength: number }> {
    if (this.objects.has(input.key)) {
      // 端口契约逐字：「写一个不可覆盖的对象；同 key 第二次写必须失败，不返回引用。」
      throw DomainError.invalid('WorkArtifactStore.key');
    }
    const sha256 = sha256Hex(input.body);
    this.objects.set(input.key, { body: input.body, sha256 });
    this.putKeys.push(input.key);
    return {
      objectRef: `littleq/artifacts/${input.key}`,
      sha256: sha256 as never,
      byteLength: input.body.byteLength,
    };
  }

  async openScanSource(objectRef: string): Promise<ScanFileSource> {
    if (!this.hasRef(objectRef)) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'WorkArtifactStore.objectRef');
    }
    return {
      list: () => [],
      open: () => unsupported('ScanFileSource.open'),
    };
  }

  async read(objectRef: string): Promise<Uint8Array> {
    const found = this.find(objectRef);
    if (found === null) throw new DomainError('RESOURCE_NOT_FOUND', 'WorkArtifactStore.objectRef');
    return found.body;
  }

  private hasRef(objectRef: string): boolean {
    return this.find(objectRef) !== null;
  }

  private find(objectRef: string): { body: Uint8Array; sha256: string } | null {
    for (const [key, value] of this.objects) {
      if (`littleq/artifacts/${key}` === objectRef) return value;
    }
    return null;
  }
}

class InputDouble implements TaskInputStore {
  readonly objects = new Map<string, Uint8Array>();

  async put(input: { taskId: TaskId; body: Uint8Array; now: Timestamp }): Promise<{
    readonly objectRef: string;
    readonly sha256: string;
    readonly byteLength: number;
  }> {
    const objectRef = `littleq/task-input/${String(input.taskId)}.json`;
    this.objects.set(objectRef, input.body);
    return { objectRef, sha256: sha256Hex(input.body), byteLength: input.body.byteLength };
  }

  async get(objectRef: string): Promise<Uint8Array> {
    const body = this.objects.get(objectRef);
    if (body === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 'TaskInputStore.objectRef');
    return body;
  }
}

class ProviderDouble implements TurnProviderClient {
  readonly calls: { readonly method: string; readonly externalKey: string }[] = [];
  readonly bodies: Uint8Array[] = [];
  createSessionFailsWith: unknown = null;
  interruptFails = false;
  batch: ProviderEventBatch = {
    items: [
      { externalId: 'evt_1', kind: 'TEXT', text: OUTPUT_SENTINEL },
      { externalId: 'evt_2', kind: 'OTHER' },
    ],
    nextCursor: 'cursor-2',
    turnComplete: true,
  };

  async createSession(input: {
    readonly externalOperationKey: string;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderSessionHandle> {
    this.calls.push({ method: 'createSession', externalKey: input.externalOperationKey });
    if (this.createSessionFailsWith !== null) throw this.createSessionFailsWith;
    return {
      sessionId: SESSION_ID,
      identityId: PROVIDER_CONFIGURATION.identityId,
      templateId: PROVIDER_CONFIGURATION.templateId,
      environmentId: PROVIDER_CONFIGURATION.environmentId,
      templateVersion: PROVIDER_CONFIGURATION.templateVersion,
    };
  }

  async sendUserMessage(input: {
    readonly session: ProviderSessionHandle;
    readonly body: Uint8Array;
    readonly externalOperationKey: string;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<void> {
    this.calls.push({ method: 'sendUserMessage', externalKey: input.externalOperationKey });
    this.bodies.push(input.body);
  }

  async listEvents(input: {
    readonly session: ProviderSessionHandle;
    readonly cursor: string | null;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderEventBatch> {
    this.calls.push({ method: 'listEvents', externalKey: input.cursor ?? '' });
    return this.batch;
  }

  async interrupt(input: {
    readonly session: ProviderSessionHandle;
    readonly externalOperationKey: string;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<void> {
    this.calls.push({ method: 'interrupt', externalKey: input.externalOperationKey });
    if (this.interruptFails) throw new Error('network unreachable');
  }
}

/**
 * `ScanCheckpoint` / `StartScanInput` / `ScanReport` 是 work-contract 的大结构类型。
 *
 * 驱动器对它们只做三件事：**存下来**、**原样传回去**、读 `report.status`。所以替身用
 * 一个带 `rev` 的小对象加一次显式 `as unknown as` 转换就够了 —— 转换点集中在这三行，
 * 且第 8 组会断言"存进去的那个 checkpoint 原样读得回来"，因此它不可能悄悄漂移。
 */
function fakeCheckpoint(rev: number): ScanCheckpoint {
  return { fakeCheckpointRev: rev } as unknown as ScanCheckpoint;
}

function checkpointRev(checkpoint: ScanCheckpoint | null): number | null {
  if (checkpoint === null) return null;
  return (checkpoint as unknown as { fakeCheckpointRev: number }).fakeCheckpointRev;
}

class ScannerDouble implements WorkScanner {
  stepResults: ScanStepResult[] = [{ state: 'COMPLETE', checkpoint: fakeCheckpoint(2) }];
  reportStatus: 'PASS' | 'BLOCK' | 'CONFIRM_REQUIRED' = 'PASS';
  readonly startedWith: StartScanInput[] = [];
  /** `step` 每次收到的 checkpoint。驱动器承诺"存下来、原样传回去"，这一列是判据。 */
  readonly stepCheckpoints: ScanCheckpoint[] = [];
  finalizedWith: ScanCheckpoint | null = null;
  stepCalls = 0;

  start(input: StartScanInput): ScanCheckpoint {
    this.startedWith.push(input);
    return fakeCheckpoint(1);
  }

  async step(input: {
    checkpoint: ScanCheckpoint;
    files: ScanFileSource;
    budgetMs: number;
    abortSignal: AbortSignal;
  }): Promise<ScanStepResult> {
    this.stepCalls += 1;
    this.stepCheckpoints.push(input.checkpoint);
    const result = this.stepResults[this.stepCalls - 1] ?? this.stepResults.at(-1);
    if (result === undefined) throw DomainError.invalid('ScannerDouble.stepResults');
    return result;
  }

  async finalize(checkpoint: ScanCheckpoint): Promise<ScanReport> {
    this.finalizedWith = checkpoint;
    return { status: this.reportStatus } as unknown as ScanReport;
  }
}

class ScanInputDouble implements ScanInputAssembler {
  readonly assembled: { readonly artifactHash: string; readonly manifestHash: string }[] = [];

  async assemble(input: {
    readonly taskId: TaskId;
    readonly projectId: ProjectId;
    readonly artifactHash: string;
    readonly manifestHash: string;
    readonly files: ScanFileSource;
  }): Promise<StartScanInput> {
    this.assembled.push({ artifactHash: input.artifactHash, manifestHash: input.manifestHash });
    return {
      artifactHash: input.artifactHash,
      manifestHash: input.manifestHash,
      files: input.files,
    } as unknown as StartScanInput;
  }
}

class ReleaserDouble implements TaskReservationReleaser {
  readonly calls: { readonly taskId: string; readonly capability: Capability }[] = [];
  readonly store: MemoryStore;
  /**
   * 注入释放失败。用标志位而不是把整个方法覆盖掉：覆盖会连带吃掉 `calls.push`，
   * 于是"释放确实被试过"这条断言永远读到空数组 —— 探针自己造的假阴性。
   */
  releaseFails = false;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async releaseReservation(input: {
    readonly taskId: TaskId;
    readonly capability: Capability;
    readonly now: Timestamp;
  }): Promise<UsageReservation | null> {
    this.calls.push({ taskId: String(input.taskId), capability: input.capability });
    if (this.releaseFails) throw new Error('db gone');
    const key = this.store.reservationKey(input.taskId, input.capability);
    const stored = this.store.reservations.get(key);
    if (stored === undefined) return null;
    const released = releaseUsage(stored);
    this.store.reservations.set(key, released);
    return released;
  }
}

class PumpStoreDouble implements TaskPumpStore {
  acquireCalls = 0;
  recordReceiptCalls = 0;
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async acquire(input: {
    taskId: TaskId;
    expectedRevision: Revision;
    workerId: string;
    leaseSeconds: number;
    mode: 'PUMP' | 'CANCEL';
    now: Timestamp;
  }): Promise<TaskAcquireResult> {
    this.acquireCalls += 1;
    const key = String(input.taskId);
    const task = this.store.tasks.get(key);
    if (task === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 'AiTask');
    const privateState = this.store.privates.get(key);
    if (privateState === undefined)
      throw new DomainError('RESOURCE_NOT_FOUND', 'TaskPrivateRecord');

    if (TERMINAL_STATES.includes(task.state)) {
      return { kind: 'RESULT', outcome: 'NO_OP_TERMINAL', task };
    }
    // `IF_MATCH_REVISION`（infra 步骤 1 后半）：失配是**抛 409**，不是给一个结论。
    if (compareRevisions(task.revision, input.expectedRevision) !== 0) {
      throw new DomainError('REVISION_CONFLICT', 'AiTask.revision');
    }

    let next = task;
    if (input.mode === 'CANCEL') {
      // 逐条照抄 infra `sql/task-pump-store.ts:274-318` 的三个 CANCEL 决定。落点各不相同，
      // 尤其 `CANCEL_FROM_QUEUED` 返回的是 **RESULT** 而不是租约 —— 生产上驱动器因此
      // 根本不会进 cancelSlice。替身若在这里发租约，就会测出一条不存在的路径。
      switch (task.state) {
        case 'QUEUED': {
          const cancelled = transitionTask(
            requestCancel(task, input.now),
            'CANCELLED',
            input.now,
            'TASK_NOT_CANCELLABLE',
          );
          this.store.tasks.set(key, cancelled);
          this.store.leases.delete(key);
          return { kind: 'RESULT', outcome: 'ADVANCED', task: cancelled };
        }
        case 'RUNNING':
          next = transitionTask(
            requestCancel(task, input.now),
            'CANCELLING',
            input.now,
            'TASK_NOT_CANCELLABLE',
          );
          this.store.tasks.set(key, next);
          break;
        case 'CANCELLING':
          // `RESUME_CANCELLING`：状态不变（`CANCELLING → CANCELLING` 不是边），只发定向租约。
          break;
        default:
          // `REJECT_NOT_CANCELLABLE`：CLAIMED / SESSION_CREATING / COLLECTING …… 落在这里。
          throw new DomainError('TASK_NOT_CANCELLABLE', 'TaskState');
      }
    } else if (next.state === 'QUEUED') {
      // `CLAIM_QUEUED`：`QUEUED → SESSION_CREATING` **不是**合法边，所以 acquire 必须
      // 先把任务领成 CLAIMED，否则第一片当场抛 TASK_NOT_CANCELLABLE/REQUEST_INVALID。
      next = transitionTask(next, 'CLAIMED', input.now, 'REQUEST_INVALID');
      this.store.tasks.set(key, next);
    }

    const lease: TaskLease = {
      taskId: next.id,
      leaseToken: brand<string, 'LeaseToken'>(`lease:${input.workerId}:${key}`),
      leaseUntil: LEASE_UNTIL,
      revision: next.revision,
    };
    this.store.leases.set(key, lease);
    return { kind: 'LEASED', task: next, privateState, lease };
  }

  async recordReceipt(): Promise<void> {
    this.recordReceiptCalls += 1;
  }
}

class ProjectDirectoryDouble implements ProjectDirectory {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async insert(project: Project): Promise<void> {
    this.store.projects.set(String(project.id), project);
  }

  async findById(projectId: ProjectId): Promise<Project | null> {
    return this.store.projects.get(String(projectId)) ?? null;
  }

  async insertVersion(version: ProjectVersion): Promise<void> {
    this.store.versions.set(String(version.id), version);
  }

  async findVersionById(versionId: ProjectVersionId): Promise<ProjectVersion | null> {
    return this.store.versions.get(String(versionId)) ?? null;
  }

  async list(input: ListProjectsInput): Promise<Page<Project>> {
    void input;
    return { items: [...this.store.projects.values()], nextCursor: null };
  }

  async listVersions(input: ListVersionsInput): Promise<Page<ProjectVersion>> {
    return {
      items: [...this.store.versions.values()].filter(
        (version) => String(version.projectId) === String(input.projectId),
      ),
      nextCursor: null,
    };
  }
}

class TaskReadDouble implements TaskReadDirectory {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async findTask(taskId: TaskId): Promise<AiTask | null> {
    return this.store.tasks.get(String(taskId)) ?? null;
  }

  async findActiveWriteTask(projectId: ProjectId): Promise<AiTask | null> {
    for (const task of this.store.tasks.values()) {
      if (String(task.projectId) === String(projectId) && !TERMINAL_STATES.includes(task.state)) {
        return task;
      }
    }
    return null;
  }

  async listEvents(
    taskId: TaskId,
    afterSequence: bigint | null,
    limit: number,
  ): Promise<readonly TaskEvent[]> {
    const all = this.store.eventsOf(taskId);
    const filtered = all.filter(
      (event) => afterSequence === null || event.sequence > afterSequence,
    );
    return filtered.slice(0, limit);
  }

  async findTurnAcceptance(): Promise<null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

type HarnessSeed = {
  readonly state?: TaskState;
  readonly subphase?: string;
  readonly qcaSessionId?: string | null;
  readonly sealedPaths?: readonly string[];
  readonly cursorSha256?: string;
  readonly scanCheckpoint?: ScanCheckpoint | null;
  readonly taskOwnerStudentId?: string;
  readonly version?: ProjectVersion | null;
};

type Harness = {
  readonly services: PumpServices;
  readonly store: MemoryStore;
  readonly provider: ProviderDouble;
  readonly artifacts: ArtifactDouble;
  readonly inputs: InputDouble;
  readonly scanner: ScannerDouble;
  readonly scanInputs: ScanInputDouble;
  readonly releaser: ReleaserDouble;
  readonly pumpStore: PumpStoreDouble;
  readonly random: RandomDouble;
  readonly actor: Actor;
  readonly otherActor: Actor;
  readonly task: AiTask;
  readonly project: Project;
  readonly promptSha256: string;
  readonly inputObjectRef: string;
  pump(
    task: AiTask,
    overrides?: Partial<DriveTaskInput>,
  ): Promise<{
    readonly outcome: string;
    readonly task: AiTask;
  }>;
  cancel(
    task: AiTask,
    overrides?: Partial<DriveTaskInput>,
  ): Promise<{
    readonly outcome: string;
    readonly task: AiTask;
  }>;
  privateState(): TaskPrivateRecord;
};

function makeHarness(seed: HarnessSeed = {}): Harness {
  const store = new MemoryStore();
  const random = new RandomDouble();
  const artifacts = new ArtifactDouble();
  const inputs = new InputDouble();
  const provider = new ProviderDouble();
  const scanner = new ScannerDouble();
  const scanInputs = new ScanInputDouble();
  const releaser = new ReleaserDouble(store);
  const pumpStore = new PumpStoreDouble(store);

  const ownerStudentId = seed.taskOwnerStudentId ?? STUDENT_ID;
  const project = createProject({
    id: PROJECT_ID,
    ownerStudentId,
    title: '会跳的小猫',
    workType: 'WEB',
    ageBand: 'L1',
    helpLevel: 'LV1',
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.projects.set(String(project.id), project);

  const promptSha256 = sha256Hex(PROMPT_BYTES);
  const inputObjectRef = `littleq/task-input/${TASK_ID}.json`;
  inputs.objects.set(inputObjectRef, PROMPT_BYTES);

  const inputRef = createTaskInputRef({
    objectRef: inputObjectRef,
    sha256: promptSha256,
    byteLength: PROMPT_BYTES.byteLength,
  });

  const task = createAiTask({
    id: TASK_ID,
    kind: 'VIBE_TURN',
    projectId: PROJECT_ID,
    requestedBy: ownerStudentId,
    maxAttempts: 3,
    state: seed.state ?? 'QUEUED',
    attempt: 1,
    hardDeadlineAt: parseTimestamp('2026-10-22T03:06:05.000Z'),
    createdAt: NOW,
    revision: '1',
  });
  store.tasks.set(String(task.id), task);

  const privateState = createTaskPrivateRecord({
    taskId: TASK_ID,
    inputRef,
    qcaSessionId: seed.qcaSessionId ?? null,
    internalSubphase: seed.subphase ?? 'AWAITING_SESSION_RECEIPT',
    // ⚠️ PM 裁定 (a).2：受理时刻这两列填的是 **prompt 输入对象的真实摘要**，
    // 不是随机占位也不是空串。`acceptanceTimeScanIdentity` 就是受理路径用的同一个函数。
    collectionCursor: createCollectionCursor({
      artifactSha256: seed.cursorSha256 ?? promptSha256,
      sealedPaths: seed.sealedPaths ?? [],
    }),
    inputSnapshot: acceptanceTimeScanIdentity(seed.cursorSha256 ?? promptSha256),
    scanCheckpoint: seed.scanCheckpoint ?? null,
  });
  store.privates.set(String(task.id), privateState);

  if (seed.version !== undefined && seed.version !== null) {
    store.versions.set(String(seed.version.id), seed.version);
  }

  const actor = actorFor(STUDENT_ID, 'STUDENT', 'kid');
  const otherActor = actorFor(OTHER_STUDENT_ID, 'STUDENT', 'otherkid');

  const services: PumpServices = {
    projects: new ProjectDirectoryDouble(store),
    tasks: new TaskReadDouble(store),
    pumpStore,
    unitOfWork: makeUnitOfWork(store),
    provider,
    inputs,
    artifacts,
    scanner,
    scanInputs,
    random,
    reservationReleaser: releaser,
    providerConfiguration: PROVIDER_CONFIGURATION,
  };

  const drive = (
    mode: 'PUMP' | 'CANCEL',
    current: AiTask,
    overrides: Partial<DriveTaskInput> = {},
  ): Promise<{ readonly outcome: string; readonly task: AiTask }> => {
    const input: DriveTaskInput = {
      actor: overrides.actor ?? actor,
      taskId: current.id,
      expectedRevision: overrides.expectedRevision ?? current.revision,
      workerId: overrides.workerId ?? WORKER_ID,
      now: overrides.now ?? NOW,
      mode,
      requestBudgetMs: overrides.requestBudgetMs,
      workWindowMs: overrides.workWindowMs,
      leaseSeconds: overrides.leaseSeconds,
    };
    return mode === 'CANCEL'
      ? cancelTaskUseCase(services, input)
      : pumpTaskUseCase(services, input);
  };

  return {
    services,
    store,
    provider,
    artifacts,
    inputs,
    scanner,
    scanInputs,
    releaser,
    pumpStore,
    random,
    actor,
    otherActor,
    task,
    project,
    promptSha256,
    inputObjectRef,
    pump: (current, overrides) => drive('PUMP', current, overrides),
    cancel: (current, overrides) => drive('CANCEL', current, overrides),
    privateState: () => {
      const record = store.privates.get(TASK_ID);
      if (record === undefined) throw DomainError.invalid('MemoryStore.privates');
      return record;
    },
  };
}

/** 造一个已经推进到某个子相位的 harness（省掉每处测试都手动跑前几片）。 */
function seededHarness(seed: HarnessSeed): Harness {
  return makeHarness(seed);
}

function journalOf(harness: Harness, operation: string): OperationJournalEntry | undefined {
  return harness
    .privateState()
    .operationJournal.find((entry) => String(entry.operationKey).includes(`:${operation}:`));
}

// ===========================================================================
// 1. 反面对照：替身必须真的会失败
// ===========================================================================

describe('反面对照：内存替身不是永远点头的双胞胎', () => {
  it('事务替身在 expectedRevision 失配时抛 REVISION_CONFLICT，并且回滚整事务', async () => {
    const harness = makeHarness();
    const lease: TaskLease = {
      taskId: harness.task.id,
      leaseToken: brand<string, 'LeaseToken'>('lease:probe'),
      leaseUntil: LEASE_UNTIL,
      revision: harness.task.revision,
    };
    harness.store.leases.set(String(harness.task.id), lease);

    await expect(
      harness.services.unitOfWork.run({ lease, expectedRevision: '999' as Revision }, async () => {
        return 'never';
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    // 回滚：事务里写进去的东西不能留在库里。
    const before = harness.store.snapshot();
    await expect(
      harness.services.unitOfWork.run(
        { lease, expectedRevision: harness.task.revision },
        async (bound) => {
          await bound.privateState.save({
            ...harness.privateState(),
            qcaEventCursor: 'should-be-rolled-back',
          });
          throw DomainError.invalid('probe');
        },
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    harness.store.restore(before);
    expect(harness.privateState().qcaEventCursor).toBeNull();
  });

  it('事务替身拒绝不是本请求领到的租约', async () => {
    const harness = makeHarness();
    const lease: TaskLease = {
      taskId: harness.task.id,
      leaseToken: brand<string, 'LeaseToken'>('lease:someone-else'),
      leaseUntil: LEASE_UNTIL,
      revision: harness.task.revision,
    };
    harness.store.leases.set(String(harness.task.id), {
      ...lease,
      leaseToken: brand<string, 'LeaseToken'>('lease:mine'),
    });
    await expect(
      harness.services.unitOfWork.run(
        { lease, expectedRevision: harness.task.revision },
        async () => 1,
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('产物替身对同一个 key 的第二次写失败', async () => {
    const harness = makeHarness();
    const signal = AbortSignal.timeout(1_000);
    await harness.artifacts.put({
      key: 'k',
      body: textBytes('a'),
      contentType: 'text/plain',
      abortSignal: signal,
    });
    await expect(
      harness.artifacts.put({
        key: 'k',
        body: textBytes('b'),
        contentType: 'text/plain',
        abortSignal: signal,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  });

  it('结算替身拒绝任何非 COMMITTED 的预留（照抄 infra assertSettleable）', async () => {
    const harness = makeHarness();
    const held = makeReservation(harness, 'HELD');
    await expect(
      harness.services.unitOfWork.run(
        { lease: leaseFor(harness), expectedRevision: harness.task.revision },
        async (bound) => {
          await bound.reservations.settle({ reservation: held, ledger: makeLedger(harness) });
        },
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  });
});

function leaseFor(harness: Harness): TaskLease {
  const lease: TaskLease = {
    taskId: harness.task.id,
    leaseToken: brand<string, 'LeaseToken'>('lease:probe-2'),
    leaseUntil: LEASE_UNTIL,
    revision: harness.task.revision,
  };
  harness.store.leases.set(String(harness.task.id), lease);
  return lease;
}

function makeReservation(harness: Harness, state: 'HELD' | 'COMMITTED'): UsageReservation {
  const reservation: UsageReservation = {
    id: '0198c0a1-7777-7000-8000-000000000001',
    taskId: String(harness.task.id),
    subjectUserId: STUDENT_ID,
    capability: 'QCA_TASK',
    reservedUnits: 1,
    state,
    expiresAt: parseTimestamp('2026-10-22T03:06:05.000Z'),
  } as unknown as UsageReservation;
  return reservation;
}

function makeLedger(harness: Harness): UsageLedgerEntry {
  return {
    id: '0198c0a1-8888-7000-8000-000000000001',
    eventKey: 'probe',
    taskId: String(harness.task.id),
    subjectUserId: STUDENT_ID,
    capability: 'QCA_TASK',
    unit: 'COUNT',
    quantity: 1,
    provider: 'qca',
    occurredAt: NOW,
  } as unknown as UsageLedgerEntry;
}

// ===========================================================================
// 2. 六片推进：一条真的从 QUEUED 走到 SUCCEEDED 的路
// ===========================================================================

describe('六片推进', () => {
  it('一片一请求地走完六片：版本恰好一行、预留 COMMITTED、账目恰好一条', async () => {
    const harness = makeHarness();
    const initialRevision = harness.task.revision;

    // 片 1：AWAITING_SESSION_RECEIPT → 建会话
    const first = await harness.pump(harness.task);
    expect(first.outcome).toBe('ADVANCED');
    expect(first.task.state).toBe('SESSION_CREATING');
    expect(first.task.stage).toBe('TRANSPORT');
    expect(harness.privateState().internalSubphase).toBe('AWAITING_MESSAGE_RECEIPT');
    expect(harness.privateState().qcaSessionId).toBe(SESSION_ID);

    // 片 2：AWAITING_MESSAGE_RECEIPT → 发 prompt
    const second = await harness.pump(first.task, { now: STEP });
    expect(second.task.state).toBe('RUNNING');
    expect(second.task.stage).toBe('AGENT_RUN');
    expect(harness.privateState().internalSubphase).toBe('COLLECTING');
    // prompt 全文确实交给了 provider（而不是被替换成占位）
    expect(new TextDecoder().decode(harness.provider.bodies[0] ?? new Uint8Array())).toBe(
      PROMPT_SENTINEL,
    );

    // 片 3：COLLECTING → 收一页事件并固化
    const third = await harness.pump(second.task, { now: STEP });
    expect(third.task.state).toBe('COLLECTING');
    expect(third.task.stage).toBe('COLLECT');
    expect(harness.privateState().collectionCursor.sealedPaths).toHaveLength(1);
    expect(harness.privateState().qcaEventCursor).toBe('cursor-2');
    expect(harness.privateState().internalSubphase).toBe('SEALING');

    // 片 4：SEALING → 封两文件包络
    const fourth = await harness.pump(third.task, { now: STEP });
    expect(fourth.task.state).toBe('VALIDATING');
    expect(fourth.task.stage).toBe('BUILD');
    expect(harness.privateState().internalSubphase).toBe('SCANNING');

    // 片 5：SCANNING → start + 一次 step + finalize(PASS)
    const fifth = await harness.pump(fourth.task, { now: STEP });
    expect(fifth.task.state).toBe('VALIDATING');
    expect(harness.privateState().internalSubphase).toBe('COMMITTING');
    expect(harness.scanner.stepCalls).toBe(1);

    // 片 6：COMMITTING → 写版本 + 结算 + SUCCEEDED
    const sixth = await harness.pump(fifth.task, { now: STEP });
    expect(sixth.task.state).toBe('SUCCEEDED');
    expect(sixth.task.progress).toBe(100);
    expect(sixth.task.resultVersionId).not.toBeNull();

    // 恰好一行版本，且项目指针指向它
    expect(harness.store.versions.size).toBe(1);
    const version = [...harness.store.versions.values()][0];
    expect(version).toBeDefined();
    expect(String(version?.id)).toBe(String(sixth.task.resultVersionId ?? ''));
    expect(String(harness.store.projects.get(PROJECT_ID)?.currentVersionId ?? '')).toBe(
      String(version?.id ?? ''),
    );
    expect(version?.scanStatus).toBe('PASS');
    expect(version?.buildStatus).toBe('VALID');
    expect(version?.artifactSha256).toBe(harness.privateState().collectionCursor.artifactSha256);

    // 额度：预留 COMMITTED，账目恰好一条（不重复计费）
    const reservation = harness.store.reservations.get(
      harness.store.reservationKey(sixth.task.id, 'QCA_TASK'),
    );
    expect(reservation?.state).toBe('COMMITTED');
    expect(harness.store.ledger).toHaveLength(1);

    // 事件：五片各追加一条（SCANNING 片只写 task_private，不追加事件）
    const events = harness.store.eventsOf(sixth.task.id);
    expect(events).toHaveLength(5);
    expect(events.map((event) => event.eventType)).toEqual([
      'PROGRESS',
      'PROGRESS',
      'PROGRESS',
      'PROGRESS',
      'COMPLETED',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1n, 2n, 3n, 4n, 5n]);

    // revision 算术：acquire 的 CLAIM(+1) + 3+3+3+3+0+4 = 17 格。
    // 钉住这个数是为了让"多跳一格"（重复迁移）与"少跳一格"（丢掉 appendEvent 的返回值）
    // 都当场变红 —— 后者的后果是客户端下一次 If-Match 直接 412。
    expect(Number(sixth.task.revision)).toBe(Number(initialRevision) + 17);
  });

  it('一次请求只调一个 provider 方法（A′：没有常驻进程、没有第二片）', async () => {
    const harness = makeHarness();
    const first = await harness.pump(harness.task);
    // 第一片只建会话：请求结束时 provider 恰好被触碰一次，没有"顺手把消息也发了"。
    expect(harness.provider.calls.map((call) => call.method)).toEqual(['createSession']);
    // 没有 waitUntil / setInterval：请求返回之后 provider 不再被触碰。
    // 两次请求 ⇒ 两个方法，一一对应，绝不是一次请求里连着调两个。
    await harness.pump(first.task, { now: STEP });
    expect(harness.provider.calls.map((call) => call.method)).toEqual([
      'createSession',
      'sendUserMessage',
    ]);
  });
});

// ===========================================================================
// 3. PM 裁定 (a)：受理时刻的真值与 SEALING 的整行覆盖
// ===========================================================================

describe('PM 裁定 (a).1 / (a).2：input_snapshot 与 collection_cursor', () => {
  it('受理时刻两列填的是 prompt 输入对象的真实摘要，不是占位符', () => {
    const harness = makeHarness();
    const record = harness.privateState();
    // 它是真值：等于 prompt 字节的 sha256，且是一个合法的 64 位十六进制摘要
    expect(record.collectionCursor.artifactSha256).toBe(harness.promptSha256);
    expect(record.inputSnapshot.scanInput.artifactHash).toBe(harness.promptSha256);
    expect(record.inputSnapshot.scanInput.manifestHash).toBe(harness.promptSha256);
    expect(harness.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.collectionCursor.sealedPaths).toEqual([]);
  });

  it('SEALING 用真产物摘要整行覆盖，覆盖后的值不等于受理时那个值', async () => {
    const harness = seededHarness({
      state: 'COLLECTING',
      subphase: 'SEALING',
      qcaSessionId: SESSION_ID,
      sealedPaths: [],
    });
    // 先真的固化一个分片，让 SEALING 有东西可封
    const chunkRef = (
      await harness.artifacts.put({
        key: chunkKey(harness.task.id, 1, 1),
        body: textBytes(OUTPUT_SENTINEL),
        contentType: 'text/plain; charset=utf-8',
        abortSignal: AbortSignal.timeout(1_000),
      })
    ).objectRef;
    harness.store.privates.set(TASK_ID, {
      ...harness.privateState(),
      collectionCursor: createCollectionCursor({
        artifactSha256: harness.promptSha256,
        sealedPaths: [chunkRef],
      }),
    });
    const acceptanceArtifactHash = harness.privateState().inputSnapshot.scanInput.artifactHash;
    expect(acceptanceArtifactHash).toBe(harness.promptSha256);

    const lease = leaseFor(harness);
    void lease;
    const result = await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);

    const sealed = harness.privateState();
    const htmlSha = sha256Hex(textBytes(OUTPUT_SENTINEL));
    // 覆盖发生了：artifactHash 现在是 **html 产物**的摘要
    expect(sealed.inputSnapshot.scanInput.artifactHash).toBe(htmlSha);
    // 且不等于受理时那个值（否则"覆盖"是空的）
    expect(sealed.inputSnapshot.scanInput.artifactHash).not.toBe(acceptanceArtifactHash);
    // manifestHash 是清单对象的摘要，与 html 摘要不同源
    expect(sealed.inputSnapshot.scanInput.manifestHash).not.toBe(htmlSha);
    expect(sealed.inputSnapshot.scanInput.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    // 四个部署常量保持不变（它们不是内容摘要）
    expect(sealed.inputSnapshot.scanInput.rulesetVersion).toBe('1.0.0');
    // collection_cursor 也被整行覆盖
    expect(sealed.collectionCursor.artifactSha256).toBe(htmlSha);
    expect(sealed.collectionCursor.sealedPaths).toHaveLength(2);
    // 封口之后 checkpoint 显式置空，由 SCANNING 片重新 start
    expect(sealed.scanCheckpoint).toBeNull();
    expect(sealed.scanFailure).toBeNull();
    expect(sealed.internalSubphase).toBe('SCANNING');
    expect(result.task.stage).toBe('BUILD');
    // 两个包络对象都写了，key 是 (task, attempt, path) 的纯函数。
    // 第一个是本用例自己为"有东西可封"而固化的那个分片（:1377），不是 SEALING 写的。
    expect(harness.artifacts.putKeys).toEqual([
      chunkKey(harness.task.id, 1, 1),
      envelopeKey(harness.task.id, 1, ENVELOPE_HTML_PATH),
      envelopeKey(harness.task.id, 1, ENVELOPE_MANIFEST_PATH),
    ]);
  });

  it('SCANNING 片拿到的两个摘要就是 SEALING 覆盖后的那两个（同源，不另算一份）', async () => {
    const harness = seededHarness({
      state: 'COLLECTING',
      subphase: 'SEALING',
      qcaSessionId: SESSION_ID,
    });
    const chunkRef = (
      await harness.artifacts.put({
        key: chunkKey(harness.task.id, 1, 1),
        body: textBytes(OUTPUT_SENTINEL),
        contentType: 'text/plain; charset=utf-8',
        abortSignal: AbortSignal.timeout(1_000),
      })
    ).objectRef;
    harness.store.privates.set(TASK_ID, {
      ...harness.privateState(),
      collectionCursor: createCollectionCursor({
        artifactSha256: harness.promptSha256,
        sealedPaths: [chunkRef],
      }),
    });
    const sealed = await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
    const scanned = await harness.pump(sealed.task, { now: STEP });
    expect(scanned.task.state).toBe('VALIDATING');
    expect(harness.scanInputs.assembled).toHaveLength(1);
    expect(harness.scanInputs.assembled[0]?.artifactHash).toBe(
      harness.privateState().inputSnapshot.scanInput.artifactHash,
    );
    expect(harness.scanInputs.assembled[0]?.manifestHash).toBe(
      harness.privateState().inputSnapshot.scanInput.manifestHash,
    );
  });
});

// ===========================================================================
// 4. §5.3 三段式：意图 → 事务外请求 → 回执先持久化
// ===========================================================================

describe('§5.3 三段式与回执落库', () => {
  it('回执真的落库成 RECEIPT_RECORDED，并且带上 provider 给的那份内容', async () => {
    const harness = makeHarness();
    await harness.pump(harness.task);
    const entry = journalOf(harness, 'CREATE_SESSION');
    expect(entry).toBeDefined();
    expect(entry?.intent).toBe('RECEIPT_RECORDED');
    expect(entry?.receipt).toEqual({
      sessionId: SESSION_ID,
      identityId: 'idn_1',
      templateId: 'tpl_1',
      environmentId: 'env_1',
      templateVersion: '3',
    });
    // 回执里没有 PAT、没有 prompt
    const serialized = JSON.stringify(entry?.receipt ?? {});
    expect(serialized).not.toContain(PROMPT_SENTINEL);
    expect(serialized.toLowerCase()).not.toContain('pat');
    // provider 身份快照是**当时那一套**，不是"当前配置"
    expect(entry?.providerSnapshot).toEqual(PROVIDER_CONFIGURATION);
  });

  it('发消息那一片同样落回执，且 journal 里有两条不同的操作键', async () => {
    const harness = makeHarness();
    const first = await harness.pump(harness.task);
    await harness.pump(first.task, { now: STEP });
    const journal = harness.privateState().operationJournal;
    expect(journal).toHaveLength(2);
    expect(journal.map((entry) => entry.intent)).toEqual(['RECEIPT_RECORDED', 'RECEIPT_RECORDED']);
    expect(journal[0]?.operationKey).not.toBe(journal[1]?.operationKey);
    expect(journal[1]?.receipt).toEqual({ messageAccepted: 'true' });
  });

  it('externalKey 是 (taskId, stage, attempt) 的纯函数：重放同 key，换 attempt 换 key', async () => {
    const harness = makeHarness();
    await harness.pump(harness.task);
    const first = journalOf(harness, 'CREATE_SESSION');
    expect(first?.externalKey).toBe(`${TASK_ID}:TRANSPORT:1`);

    // 回执丢失后重放：把 journal 退回 SENT，再跑一次同一片，key 必须一模一样
    harness.store.privates.set(TASK_ID, {
      ...harness.privateState(),
      operationJournal:
        first === undefined ? [] : [{ ...first, intent: 'SENT' as const, receipt: null }],
      internalSubphase: parseInternalSubphase('AWAITING_SESSION_RECEIPT'),
      qcaSessionId: null,
    });
    harness.store.tasks.set(TASK_ID, {
      ...(harness.store.tasks.get(TASK_ID) ?? harness.task),
      state: 'CLAIMED',
      stage: 'TRANSPORT',
    });
    const replayed = await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(replayed.task.state).toBe('SESSION_CREATING');
    const replayCalls = harness.provider.calls.filter((call) => call.method === 'createSession');
    expect(replayCalls).toHaveLength(2);
    expect(replayCalls[0]?.externalKey).toBe(replayCalls[1]?.externalKey);

    // 换一个 attempt ⇒ key 必须变（否则两次不同的运行会在 provider 侧被去重成一次）
    const otherHarness = makeHarness();
    otherHarness.store.tasks.set(TASK_ID, {
      ...(otherHarness.store.tasks.get(TASK_ID) ?? otherHarness.task),
      attempt: parseAttempt(2),
    });
    await otherHarness.pump(otherHarness.store.tasks.get(TASK_ID) ?? otherHarness.task);
    expect(journalOf(otherHarness, 'CREATE_SESSION')?.externalKey).toBe(`${TASK_ID}:TRANSPORT:2`);
  });
});

// ===========================================================================
// 5. 外呼失败：不改 task，留在恢复子相位
// ===========================================================================

describe('外呼失败与错误映射', () => {
  it('createSession 抛错 ⇒ task 行一动不动，journal 停在 SENT/回执为空', async () => {
    const harness = makeHarness();
    harness.provider.createSessionFailsWith = new Error('network unreachable');
    const before = harness.store.tasks.get(TASK_ID) ?? harness.task;
    await expect(harness.pump(before)).rejects.toMatchObject({ code: 'QCA_UNREACHABLE' });
    const after = harness.store.tasks.get(TASK_ID);
    // 事务 A 已提交（意图落库是它的全部目的），但 task 行没有被推进到 SESSION_CREATING
    // 之外 —— 具体说：状态迁移发生在事务 A 里，所以状态是 SESSION_CREATING，
    // 而子相位**没有**前进，回执**没有**落库。
    expect(after?.state).toBe('SESSION_CREATING');
    expect(harness.privateState().internalSubphase).toBe('AWAITING_SESSION_RECEIPT');
    expect(harness.privateState().qcaSessionId).toBeNull();
    const entry = journalOf(harness, 'CREATE_SESSION');
    expect(entry?.intent).toBe('SENT');
    expect(entry?.receipt).toBeNull();
    // 没有事件被追加（事件只在事务 B 里写）
    expect(harness.store.eventsOf(before.id)).toHaveLength(0);
  });

  it('mapExternalFailure：超时/中止 ⇒ TASK_TIMEOUT，其余 ⇒ QCA_UNREACHABLE，DomainError 原样穿过', () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(mapExternalFailure(timeout).code).toBe('TASK_TIMEOUT');
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(mapExternalFailure(aborted).code).toBe('TASK_TIMEOUT');
    expect(mapExternalFailure(new Error('boom')).code).toBe('QCA_UNREACHABLE');
    expect(mapExternalFailure('not-an-error').code).toBe('QCA_UNREACHABLE');
    const original = new DomainError('QCA_QUOTA_EXHAUSTED', 'probe');
    expect(mapExternalFailure(original)).toBe(original);
  });

  it('超时映射成 TASK_TIMEOUT 而不是 QCA_UNREACHABLE（两者重试语义不同）', async () => {
    const harness = makeHarness();
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    harness.provider.createSessionFailsWith = timeout;
    await expect(harness.pump(harness.task)).rejects.toMatchObject({ code: 'TASK_TIMEOUT' });
  });
});

// ===========================================================================
// 6. COMMITTING 的重入与原子性
// ===========================================================================

describe('COMMITTING 重入与原子性', () => {
  function committingHarness(harness: Harness): Harness {
    return harness;
  }

  it('重入时复用既有版本行，不再 insert 第二行', async () => {
    const htmlSha = sha256Hex(textBytes(OUTPUT_SENTINEL));
    const version = createProjectVersion({
      id: '0198c0a1-4444-7000-8000-000000000001',
      projectId: PROJECT_ID,
      sequence: 1,
      parentVersionId: null,
      sourceTaskId: TASK_ID,
      artifactSha256: htmlSha,
      contractVersion: '1.0.0',
      fileCount: 2,
      totalBytes: 128,
      buildStatus: 'VALID',
      scanStatus: 'PASS',
      createdBy: STUDENT_ID,
      createdAt: NOW,
    });
    const harness = committingHarness(
      seededHarness({
        state: 'VALIDATING',
        subphase: 'COMMITTING',
        qcaSessionId: SESSION_ID,
        cursorSha256: htmlSha,
        sealedPaths: ['littleq/artifacts/a', 'littleq/artifacts/b'],
        version,
      }),
    );
    const result = await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(result.task.state).toBe('SUCCEEDED');
    expect(harness.store.versions.size).toBe(1);
    expect(String(result.task.resultVersionId ?? '')).toBe(String(version.id));
    // 重入不产生第二条账目（event_key UNIQUE + ON CONFLICT DO NOTHING）
    expect(harness.store.ledger).toHaveLength(1);
  });

  it('既有版本的摘要与游标不符 ⇒ REVISION_CONFLICT，且不写第二行', async () => {
    const version = createProjectVersion({
      id: '0198c0a1-4444-7000-8000-000000000001',
      projectId: PROJECT_ID,
      sequence: 1,
      parentVersionId: null,
      sourceTaskId: TASK_ID,
      artifactSha256: 'a'.repeat(64),
      contractVersion: '1.0.0',
      fileCount: 2,
      totalBytes: 128,
      buildStatus: 'VALID',
      scanStatus: 'PASS',
      createdBy: STUDENT_ID,
      createdAt: NOW,
    });
    const harness = seededHarness({
      state: 'VALIDATING',
      subphase: 'COMMITTING',
      qcaSessionId: SESSION_ID,
      cursorSha256: 'b'.repeat(64),
      sealedPaths: ['littleq/artifacts/a', 'littleq/artifacts/b'],
      version,
    });
    await expect(
      harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(harness.store.versions.size).toBe(1);
    expect(harness.store.tasks.get(TASK_ID)?.state).toBe('VALIDATING');
  });

  it('结算失败 ⇒ 整事务回滚：没有版本行、项目指针不动、任务没成功', async () => {
    const htmlSha = sha256Hex(textBytes(OUTPUT_SENTINEL));
    const harness = seededHarness({
      state: 'VALIDATING',
      subphase: 'COMMITTING',
      qcaSessionId: SESSION_ID,
      cursorSha256: htmlSha,
      sealedPaths: ['littleq/artifacts/a', 'littleq/artifacts/b'],
    });
    // 造完 harness 再注入：注入开关属于这一个 store，不会被下一次构造复位。
    harness.store.failSettle = true;
    const projectBefore = harness.store.projects.get(PROJECT_ID);
    await expect(
      harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    // §3.5「不能在版本提交失败后单独完成结算」的反向也成立：结算失败不能留下半个版本
    expect(harness.store.versions.size).toBe(0);
    expect(harness.store.projects.get(PROJECT_ID)?.currentVersionId).toBe(
      projectBefore?.currentVersionId ?? null,
    );
    expect(harness.store.tasks.get(TASK_ID)?.state).toBe('VALIDATING');
    expect(harness.store.ledger).toHaveLength(0);
  });
});

// ===========================================================================
// 7. 扫描：四个错误码全落 BLOCKED，报告非 PASS 也落 BLOCKED
// ===========================================================================

describe('SCANNING 片', () => {
  const CODES = [
    { code: 'INPUT_HASH_MISMATCH', retryable: false },
    { code: 'PARSER_UNSUPPORTED', retryable: false },
    { code: 'SCANNER_RESOURCE_LIMIT', retryable: false },
    { code: 'CHECKPOINT_INVALID', retryable: true },
  ] as const;

  function scanningHarness(): Harness {
    return seededHarness({
      state: 'VALIDATING',
      subphase: 'SCANNING',
      qcaSessionId: SESSION_ID,
      cursorSha256: sha256Hex(textBytes(OUTPUT_SENTINEL)),
      sealedPaths: ['littleq/artifacts/turns/x/envelope/index.html'],
    });
  }

  for (const entry of CODES) {
    it(`step 返回 ${entry.code} ⇒ BLOCKED，scan_failure 只存 code/retryable`, async () => {
      const harness = scanningHarness();
      // 让 openScanSource 找得到那个引用
      harness.artifacts.objects.set('turns/x/envelope/index.html', {
        body: textBytes(OUTPUT_SENTINEL),
        sha256: sha256Hex(textBytes(OUTPUT_SENTINEL)),
      });
      harness.scanner.stepResults = [
        { state: 'ERROR', code: entry.code, retryable: entry.retryable },
      ];
      const result = await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
      expect(result.task.state).toBe('BLOCKED');
      expect(result.task.error?.code).toBe('WORK_CONTRACT_BLOCKED');
      expect(harness.privateState().scanFailure).toEqual({
        code: entry.code,
        retryable: entry.retryable,
      });
      // 不 finalize 成报告、不写版本、不发预览
      expect(harness.store.versions.size).toBe(0);
      expect(harness.store.ledger).toHaveLength(0);
    });
  }

  it('report.status 不是 PASS ⇒ BLOCKED，且不写版本', async () => {
    const harness = scanningHarness();
    harness.artifacts.objects.set('turns/x/envelope/index.html', {
      body: textBytes(OUTPUT_SENTINEL),
      sha256: sha256Hex(textBytes(OUTPUT_SENTINEL)),
    });
    harness.scanner.reportStatus = 'BLOCK';
    const result = await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(result.task.state).toBe('BLOCKED');
    expect(harness.store.versions.size).toBe(0);
  });

  it('step 返回 CONTINUE ⇒ 只落 checkpoint，task 行与 revision 一动不动', async () => {
    const harness = scanningHarness();
    harness.artifacts.objects.set('turns/x/envelope/index.html', {
      body: textBytes(OUTPUT_SENTINEL),
      sha256: sha256Hex(textBytes(OUTPUT_SENTINEL)),
    });
    harness.scanner.stepResults = [
      {
        state: 'CONTINUE',
        checkpoint: fakeCheckpoint(9),
        progress: 0.4,
        newFindings: 0,
      } as unknown as ScanStepResult,
    ];
    const before = harness.store.tasks.get(TASK_ID) ?? harness.task;
    const result = await harness.pump(before);
    expect(result.task.state).toBe('VALIDATING');
    expect(result.task.revision).toBe(before.revision);
    expect(checkpointRev(harness.privateState().scanCheckpoint)).toBe(9);
    expect(harness.privateState().internalSubphase).toBe('SCANNING');
    expect(harness.store.eventsOf(before.id)).toHaveLength(0);
    // 下一次进来复用已存的 checkpoint，不再 start 第二遍
    await harness.pump(result.task, { now: STEP });
    expect(harness.scanner.startedWith).toHaveLength(1);
  });
});

// ===========================================================================
// 8. 封口的两条边界
// ===========================================================================

describe('SEALING 边界', () => {
  it('一个分片都没有 ⇒ BLOCKED（provider 说回合完成却没给产出）', async () => {
    const harness = seededHarness({
      state: 'COLLECTING',
      subphase: 'SEALING',
      qcaSessionId: SESSION_ID,
      sealedPaths: [],
    });
    const result = await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(result.task.state).toBe('BLOCKED');
    expect(result.task.error?.code).toBe('WORK_CONTRACT_BLOCKED');
    expect(harness.artifacts.putKeys).toEqual([]);
  });

  it('包络超过 256 KiB ⇒ BLOCKED，且不写任何包络对象', async () => {
    const harness = seededHarness({
      state: 'COLLECTING',
      subphase: 'SEALING',
      qcaSessionId: SESSION_ID,
    });
    const big = new Uint8Array(ENVELOPE_MAX_BYTES + 1).fill(0x61);
    const chunkRef = (
      await harness.artifacts.put({
        key: chunkKey(harness.task.id, 1, 1),
        body: big,
        contentType: 'text/plain; charset=utf-8',
        abortSignal: AbortSignal.timeout(1_000),
      })
    ).objectRef;
    harness.store.privates.set(TASK_ID, {
      ...harness.privateState(),
      collectionCursor: createCollectionCursor({
        artifactSha256: harness.promptSha256,
        sealedPaths: [chunkRef],
      }),
    });
    const putKeysBefore = harness.artifacts.putKeys.length;
    const result = await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(result.task.state).toBe('BLOCKED');
    expect(harness.artifacts.putKeys).toHaveLength(putKeysBefore);
  });
});

// ===========================================================================
// 9. 归属、预算、未知子相位、直通
// ===========================================================================

describe('判定顺序与入口守卫', () => {
  it('别人的任务 ⇒ RESOURCE_NOT_FOUND，而且 acquire 一次都没被调用', async () => {
    const harness = makeHarness();
    await expect(harness.pump(harness.task, { actor: harness.otherActor })).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    // 归属判定必须先于取得推进权：否则"这个 id 存在吗"就成了可探测的预言机
    expect(harness.pumpStore.acquireCalls).toBe(0);
    expect(harness.provider.calls).toHaveLength(0);
  });

  it('不存在的任务 ⇒ 同一个 RESOURCE_NOT_FOUND（不区分"没有"与"无权"）', async () => {
    const harness = makeHarness();
    await expect(
      pumpTaskUseCase(harness.services, {
        actor: harness.actor,
        taskId: '0198c0a1-2222-7000-8000-0000000000ff' as TaskId,
        expectedRevision: '1' as Revision,
        workerId: WORKER_ID,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(harness.pumpStore.acquireCalls).toBe(0);
  });

  it('成人调推进 ⇒ FORBIDDEN_CAPABILITY（§4.2：OWNER 不能代替 STUDENT）', async () => {
    const harness = makeHarness();
    const owner = actorFor(OWNER_ID, 'OWNER', 'adult');
    await expect(harness.pump(harness.task, { actor: owner })).rejects.toMatchObject({
      code: 'FORBIDDEN_CAPABILITY',
    });
    expect(harness.pumpStore.acquireCalls).toBe(0);
  });

  it('工作窗口不短于请求预算 ⇒ REQUEST_INVALID，且不取得推进权', async () => {
    const harness = makeHarness();
    await expect(
      harness.pump(harness.task, { requestBudgetMs: 8_000, workWindowMs: 8_000 }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(harness.pumpStore.acquireCalls).toBe(0);
  });

  it('读到一个不认识的子相位 ⇒ INTERNAL_ERROR，不猜一个最接近的继续推进', async () => {
    const harness = makeHarness();
    harness.store.privates.set(TASK_ID, {
      ...harness.privateState(),
      internalSubphase: parseInternalSubphase('SOMETHING_ELSE'),
    });
    await expect(harness.pump(harness.task)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(harness.provider.calls).toHaveLength(0);
  });

  it('acquire 给出结论时本请求不外呼，结论原样回给客户端', async () => {
    // 终态行必须**自己就是自洽的**：`createAiTask` 在 :187 调 `assertTaskCoherent`，
    // 直接播一个 `state:'SUCCEEDED'` 而没有 finishedAt / resultVersionId 的种子，
    // 抛的是固件错误而不是被测行为 —— 所以这里照 infra 的两步写法造一个合法终态行。
    const harness = makeHarness();
    const cancelled = transitionTask(
      requestCancel(harness.task, NOW),
      'CANCELLED',
      NOW,
      'TASK_NOT_CANCELLABLE',
    );
    harness.store.tasks.set(String(cancelled.id), cancelled);
    const result = await harness.pump(cancelled);
    expect(result.outcome).toBe('NO_OP_TERMINAL');
    expect(result.task.state).toBe('CANCELLED');
    expect(harness.provider.calls).toHaveLength(0);
  });

  it('If-Match 失配 ⇒ 抛 REVISION_CONFLICT（409），不外呼、不改行', async () => {
    const harness = makeHarness();
    // `TASK_ACQUIRE_DECISION_ORDER` 的 `IF_MATCH_REVISION` 逐字：「失配 ⇒ 抛 REVISION_CONFLICT（409）」。
    // 它不是"给一个直通结论"——把它写成结论会让客户端拿到 200 而实际上什么都没发生，
    // 学生界面于是停在一个永远不再前进的进度条上。
    await expect(
      harness.pump(harness.task, { expectedRevision: '77' as Revision }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(harness.provider.calls).toHaveLength(0);
    expect(harness.store.tasks.get(TASK_ID)?.revision).toBe(harness.task.revision);
    // 反面对照：同一个替身在 revision 对上时确实放行，所以上面那次拒绝不是"永远拒绝"。
    const ok = await harness.pump(harness.task);
    expect(ok.outcome).toBe('ADVANCED');
  });
});

// ===========================================================================
// 10. 取消：同一个驱动器，换个 mode
// ===========================================================================

describe('取消路径', () => {
  it('还没建会话 ⇒ acquire 自己就取消完，驱动器只负责把那一格额度还回去', async () => {
    const harness = seededHarness({ state: 'QUEUED', subphase: 'AWAITING_SESSION_RECEIPT' });
    harness.store.reservations.set(
      harness.store.reservationKey(harness.task.id, 'QCA_TASK'),
      makeReservation(harness, 'HELD'),
    );
    const result = await harness.cancel(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(result.outcome).toBe('ADVANCED');
    expect(result.task.state).toBe('CANCELLED');
    expect(result.task.cancelRequestedAt).not.toBeNull();
    expect(result.task.finishedAt).not.toBeNull();
    // 没有会话可中断 ⇒ 一次外呼都不发
    expect(harness.provider.calls).toHaveLength(0);
    // 额度是受理那一刻 HELD 的，而这一条路径根本不会进 cancelSlice：
    // 不在 RESULT 分支里还，学生点完"停止"，那一格会一直被占到过期为止。
    expect(harness.releaser.calls).toHaveLength(1);
    expect(harness.releaser.calls[0]?.capability).toBe('QCA_TASK');
    expect(
      harness.store.reservations.get(harness.store.reservationKey(harness.task.id, 'QCA_TASK'))
        ?.state,
    ).toBe('RELEASED');
    // 如实记下这条路径的**缺口**：F1 的 `CANCEL_FROM_QUEUED` 只 `casTaskEntity` + 清租约，
    // 返回 RESULT 而不发租约，应用层因此没有任何入口去记 `CANCEL` 阶段或追加事件。
    // 行是对的（学生看到"已取消"），但时间线上没有那一条。不改 F1 的冻结端口 ⇒ 声明为缺口。
    expect(result.task.stage).not.toBe('CANCEL');
    expect(harness.store.eventsOf(harness.task.id)).toHaveLength(0);
  });

  it('中断确认 ⇒ CANCELLED 并释放额度', async () => {
    const harness = seededHarness({
      state: 'RUNNING',
      subphase: 'COLLECTING',
      qcaSessionId: SESSION_ID,
    });
    harness.store.reservations.set(
      harness.store.reservationKey(harness.task.id, 'QCA_TASK'),
      makeReservation(harness, 'HELD'),
    );
    const result = await harness.cancel(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(result.task.state).toBe('CANCELLED');
    expect(result.task.stage).toBe('CANCEL');
    expect(harness.provider.calls.map((call) => call.method)).toEqual(['interrupt']);
    expect(harness.provider.calls[0]?.externalKey).toBe(`${TASK_ID}:CANCEL:1`);
    expect(harness.releaser.calls).toHaveLength(1);
    const entry = journalOf(harness, 'INTERRUPT');
    expect(entry?.intent).toBe('SENT');
    expect(entry?.receipt).toEqual({ interrupted: 'true' });
    // 中断确认后**保留**当前子相位，对账时才知道停在哪一步
    expect(harness.privateState().internalSubphase).toBe('COLLECTING');
  });

  it('中断结果未知 ⇒ 留在 CANCELLING、不释放额度、退回最早子相位等下一次对账', async () => {
    const harness = seededHarness({
      state: 'RUNNING',
      subphase: 'COLLECTING',
      qcaSessionId: SESSION_ID,
    });
    harness.store.reservations.set(
      harness.store.reservationKey(harness.task.id, 'QCA_TASK'),
      makeReservation(harness, 'HELD'),
    );
    harness.provider.interruptFails = true;
    const result = await harness.cancel(harness.store.tasks.get(TASK_ID) ?? harness.task);
    // §5.4：远端仍运行/结果未知 ⇒ 202 CANCELLING，**不**迁移终态
    expect(result.task.state).toBe('CANCELLING');
    expect(result.task.stage).toBe('CANCEL');
    expect(result.task.finishedAt).toBeNull();
    // 额度没被真的省下来 ⇒ 不能释放（释放了就是白送一格）
    expect(harness.releaser.calls).toHaveLength(0);
    expect(
      harness.store.reservations.get(harness.store.reservationKey(harness.task.id, 'QCA_TASK'))
        ?.state,
    ).toBe('HELD');
    // 回执未知 ⇒ journal 停在 SENT，子相位退回最早处，让下一次 cancel 重走三段式
    const entry = journalOf(harness, 'INTERRUPT');
    expect(entry?.intent).toBe('SENT');
    expect(entry?.receipt).toBeNull();
    expect(harness.privateState().internalSubphase).toBe('AWAITING_SESSION_RECEIPT');
  });

  it('释放失败不会把"取消成功"变成"取消失败"', async () => {
    const harness = seededHarness({ state: 'QUEUED', subphase: 'AWAITING_SESSION_RECEIPT' });
    harness.store.reservations.set(
      harness.store.reservationKey(harness.task.id, 'QCA_TASK'),
      makeReservation(harness, 'HELD'),
    );
    harness.releaser.releaseFails = true;
    const result = await harness.cancel(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(result.task.state).toBe('CANCELLED');
    // 非空断言：释放**确实被试过**并且确实炸了，否则上面那行只是在测"什么都没发生"。
    expect(harness.releaser.calls).toHaveLength(1);
    expect(
      harness.store.reservations.get(harness.store.reservationKey(harness.task.id, 'QCA_TASK'))
        ?.state,
    ).toBe('HELD');
  });

  it('既不是终态也不可取消 ⇒ TASK_NOT_CANCELLABLE，行一动不动、额度不还', async () => {
    // 三个集合把 TASK_STATES 切成三份，一条不漏：终态 / 可取消 / 其余。
    // 这条完整性断言就是"我抄的集合没和迁移表漂移"的判据。
    const cancellable: readonly TaskState[] = CANCELLABLE_TASK_STATES;
    const rest = TASK_STATES.filter(
      (state) => !TERMINAL_STATES.includes(state) && !cancellable.includes(state),
    );
    expect(rest.length).toBeGreaterThan(0);
    expect(
      TASK_STATES.every(
        (state) =>
          [
            TERMINAL_STATES.includes(state),
            cancellable.includes(state),
            rest.includes(state),
          ].filter(Boolean).length === 1,
      ),
    ).toBe(true);

    for (const state of rest) {
      const harness = seededHarness({ state, subphase: 'AWAITING_SESSION_RECEIPT' });
      harness.store.reservations.set(
        harness.store.reservationKey(harness.task.id, 'QCA_TASK'),
        makeReservation(harness, 'HELD'),
      );
      const before = harness.store.tasks.get(TASK_ID);
      // infra 的 `REJECT_NOT_CANCELLABLE`：CLAIMED / SESSION_CREATING / RETRY_WAIT /
      // COLLECTING / REPAIRING / VALIDATING / COMMITTING 全落在这里 —— 学生点"停止"得到 409，
      // 而不是被悄悄领成 CLAIMED（§3.5 逐字：不先领取成不可取消的 CLAIMED）。
      await expect(harness.cancel(before ?? harness.task)).rejects.toMatchObject({
        code: 'TASK_NOT_CANCELLABLE',
      });
      expect(harness.provider.calls).toHaveLength(0);
      expect(harness.releaser.calls).toHaveLength(0);
      expect(harness.store.tasks.get(TASK_ID)?.revision).toBe(before?.revision);
      expect(
        harness.store.reservations.get(harness.store.reservationKey(harness.task.id, 'QCA_TASK'))
          ?.state,
      ).toBe('HELD');
    }
  });
});

// ===========================================================================
// 11. 纯函数
// ===========================================================================

describe('纯函数', () => {
  it('collectPayload 丢掉 OTHER，但 TEXT 与 FILE 的字节按序保留', () => {
    const items: readonly ProviderTurnEvent[] = [
      { externalId: 'a', kind: 'TEXT', text: 'AB' },
      { externalId: 'b', kind: 'OTHER' },
      { externalId: 'c', kind: 'FILE', path: 'x.png', bytes: textBytes('CD') },
      { externalId: 'd', kind: 'OTHER' },
    ];
    expect(new TextDecoder().decode(collectPayload(items))).toBe('ABCD');
  });

  it('反面对照：一页全是 OTHER ⇒ 零字节，因此 COLLECTING 片一个对象都不写', async () => {
    expect(collectPayload([{ externalId: 'a', kind: 'OTHER' }])).toHaveLength(0);
    const harness = seededHarness({
      state: 'RUNNING',
      subphase: 'COLLECTING',
      qcaSessionId: SESSION_ID,
    });
    harness.provider.batch = {
      items: [{ externalId: 'a', kind: 'OTHER' }],
      nextCursor: 'c',
      turnComplete: false,
    };
    await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
    expect(harness.artifacts.putKeys).toEqual([]);
    expect(harness.privateState().collectionCursor.sealedPaths).toEqual([]);
    // 加一条 TEXT 就恰好写一个对象 —— 证明上面那个 0 不是因为替身从来不写
    harness.provider.batch = {
      items: [{ externalId: 'b', kind: 'TEXT', text: 'hi' }],
      nextCursor: 'c',
      turnComplete: false,
    };
    await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task, { now: STEP });
    expect(harness.artifacts.putKeys).toEqual([chunkKey(harness.task.id, 1, 1)]);
  });

  it('对象 key 是 (task, attempt, ordinal/path) 的纯函数 ⇒ 重入幂等', () => {
    const taskId = harnessTaskId();
    expect(chunkKey(taskId, 1, 7)).toBe(`turns/${TASK_ID}/attempt/1/chunk/000007`);
    expect(chunkKey(taskId, 1, 7)).toBe(chunkKey(taskId, 1, 7));
    expect(chunkKey(taskId, 2, 7)).not.toBe(chunkKey(taskId, 1, 7));
    expect(envelopeKey(taskId, 1, ENVELOPE_HTML_PATH)).toBe(
      `turns/${TASK_ID}/attempt/1/envelope/index.html`,
    );
    expect(envelopeKey(taskId, 1, ENVELOPE_MANIFEST_PATH)).toBe(
      `turns/${TASK_ID}/attempt/1/envelope/work.json`,
    );
  });
});

function harnessTaskId(): TaskId {
  return makeHarness().task.id;
}

// ===========================================================================
// 12. 明文红线
// ===========================================================================

describe('明文红线', () => {
  it('走完六片之后，prompt 与 provider 正文都不出现在任何已落库事件里', async () => {
    const harness = makeHarness();
    let task = harness.task;
    for (let index = 0; index < 6; index += 1) {
      task = (await harness.pump(task, { now: STEP })).task;
    }
    expect(task.state).toBe('SUCCEEDED');
    const events = harness.store.eventsOf(task.id);
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events.map((event) => event.safePayload));
    expect(serialized).not.toContain(PROMPT_SENTINEL);
    expect(serialized).not.toContain(OUTPUT_SENTINEL);
    expect(serialized).not.toContain('SENTINEL');
    // task_private 里也不得有 prompt 全文（只有对象引用）
    const privateSerialized = JSON.stringify({
      ...harness.privateState(),
      // checkpoint 是替身的小对象，不含正文
    });
    expect(privateSerialized).not.toContain(PROMPT_SENTINEL);
    expect(privateSerialized).not.toContain(OUTPUT_SENTINEL);
    // 但正文确实进了对象存储（否则上面两条断言是对一个什么都没存的空壳点头）
    const stored = [...harness.artifacts.objects.values()].map((o) =>
      new TextDecoder().decode(o.body),
    );
    expect(stored.some((body) => body.includes(OUTPUT_SENTINEL))).toBe(true);
  });
});

// ===========================================================================
// 13. 变异对照：这套测试不是空的
// ===========================================================================

describe('变异对照', () => {
  it('把 SEALING 的真值覆盖拿掉，第 3 组就会红（这里用一个等价断言证明它可被证伪）', async () => {
    // 断言"覆盖后的 artifactHash **等于**受理时那个值"必然为假 ——
    // 如果哪天它为真，说明覆盖已经被悄悄拿掉，而第 3 组也会同时变红。
    const harness = seededHarness({
      state: 'COLLECTING',
      subphase: 'SEALING',
      qcaSessionId: SESSION_ID,
    });
    const chunkRef = (
      await harness.artifacts.put({
        key: chunkKey(harness.task.id, 1, 1),
        body: textBytes(OUTPUT_SENTINEL),
        contentType: 'text/plain; charset=utf-8',
        abortSignal: AbortSignal.timeout(1_000),
      })
    ).objectRef;
    harness.store.privates.set(TASK_ID, {
      ...harness.privateState(),
      collectionCursor: createCollectionCursor({
        artifactSha256: harness.promptSha256,
        sealedPaths: [chunkRef],
      }),
    });
    await harness.pump(harness.store.tasks.get(TASK_ID) ?? harness.task);
    const sealed = harness.privateState();
    const acceptance: CollectionCursor = createCollectionCursor({
      artifactSha256: harness.promptSha256,
    });
    expect(sealed.collectionCursor.artifactSha256 === acceptance.artifactSha256).toBe(false);
    expect(sealed.inputSnapshot.scanInput.artifactHash === harness.promptSha256).toBe(false);
  });
});

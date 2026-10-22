/**
 * PM 裁定 (b) 的**安全红线**与账目不变量（ZLQ-221 §三 (b).1 / (b).2）。
 *
 * 裁定 (b).1 原文：「重新持有只在 `RELEASED` / `EXPIRED` 上合法，`COMMITTED` 必须被拒绝，
 * 且这一条拒绝必须有真实测试覆盖。**这是本裁定唯一的安全红线，不可协商。**」
 * 裁定 (b).2：账目仍然走 append-only 的 `usage_ledger`；「重新持有不丢账目」要用测试钉住。
 *
 * ## 为什么这道守卫只能落在实现侧，用例自己拦不住
 *
 * `retryTaskUseCase` 交给 `TaskRetryStore.beginRetryAttempt` 的是一个**新造的** `HELD`
 * `UsageReservation`（`createUsageReservation` + `random.uuidV7()`），它压根不知道库里
 * `(task_id, capability)` 那一行现在是什么状态 —— `UsageDirectory` 只有 `quotaSnapshot`
 * 与 `countActiveWriteTasks`，**没有读预留的方法**。所以红线的执行点只能是实现：先读出
 * 库里那一行，交给 `assertReholdable`，再按自然键 UPSERT。本文件因此测两件事：
 *
 * 1. `assertReholdable` 自身对四个状态的判定（含"红线"那一条），且状态集合**直接引用
 *    domain 导出的 `RESERVATION_STATES`**，不手抄；
 * 2. 用例把实现抛出的拒绝**原样传出**（不吞、不落新 attempt、不动 task 行、不动预留行、
 *    不动账目）；并且——用反面对照证明——用例**确实没有**自己的第二道守卫：一个不调
 *    `assertReholdable` 的实现能一路成功。这一条不是缺陷展览，而是把「红线在实现侧」
 *    钉成可执行的事实：谁将来写一个新实现忘了调它，第 6 条用例的形状就是他会得到的结果。
 *
 * ## 没有红线的后果（为什么"不可协商"）
 *
 * `COMMITTED` 表示那一格额度已经真的花掉并记进 `usage_ledger` 了。把它重新置为 `HELD`
 * 等于让学生用同一格额度跑第二次付费生成，而账目上只有一条 —— 白送一次调用，且对账时
 * 看不出来。domain 拦不住这件事：`TERMINAL_RESERVATION_STATES` 三个值全是终态，压根没有
 * `RELEASED → HELD` 这条边，"重新持有"只能用构造函数直接造实体，而构造函数不知道库里
 * 那一行的状态。绕过迁移函数的那一刻，domain 的护栏就没了。
 *
 * ## 反面对照纪律（与 `pump.test.ts` 同一条）
 *
 * 内存替身必须**真的会失败**。所以：拒绝那条配一条放行对照；CAS 失配那条配一条命中对照；
 * 「账目不丢」那条配一个会清空账本的注入开关，先证明断言能红，再证明它绿。恒绿的断言
 * 不是证据 —— 上一轮 F2 交付正是因为"看起来绿"而整条链其实是短路掉的。
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AccountSession,
  type AiTask,
  type Capability,
  type Project,
  type ProjectVersion,
  type Revision,
  type TaskEvent,
  type UsageLedgerEntry,
  type UsagePeriod,
  type UsageQuotaSnapshot,
  type UsageReservation,
  type User,
  RESERVATION_STATES,
  capabilityOfTaskKind,
  compareRevisions,
  createAccountSession,
  createAiTask,
  createProject,
  createUsageLedgerEntry,
  createUsageReservation,
  createUser,
  parseLoginName,
  parseMaxFailedAttempts,
  parseLockDurationMinutes,
  parseNickname,
  parseTaskId,
  parseTimestamp,
} from '@littleq/domain';

import type { Actor } from '../src/usecases/authorization.js';
import type {
  ListProjectsInput,
  ListVersionsInput,
  Page,
  ProjectDirectory,
  RandomSource,
  TaskReadDirectory,
  TaskRetryStore,
  TurnAcceptanceRecord,
  UsageDirectory,
} from '../src/usecases/ports.js';
import { assertReholdable, retryTaskUseCase } from '../src/usecases/tasks.js';

// ---------------------------------------------------------------------------
// 事实（全部是常量，不读时钟 —— 与 `usecases/` 全层同一条约束）
// ---------------------------------------------------------------------------

const NOW = parseTimestamp('2026-10-22T03:04:05.000Z');
const FINISHED = parseTimestamp('2026-10-22T03:05:05.000Z');
const RETRY_AT = parseTimestamp('2026-10-22T03:10:05.000Z');
const HARD_DEADLINE = '2026-10-22T04:04:05.000Z';

const LOCK_POLICY = {
  maxFailedAttempts: parseMaxFailedAttempts(5),
  lockDurationMinutes: parseLockDurationMinutes(30),
};

const OWNER_ID = '0198c0a1-0000-7000-8000-000000000001';
const STUDENT_ID = '0198c0a1-0000-7000-8000-000000000002';
const PROJECT_ID = '0198c0a1-3333-7000-8000-000000000001';
const TASK_ID = '0198c0a1-2222-7000-8000-000000000001';
const OTHER_TASK_ID = '0198c0a1-2222-7000-8000-000000000002';
const VERSION_ID = '0198c0a1-4444-7000-8000-000000000001';
/** 库里那一行预留的 id。它必须与用例新造的那个**不同**，否则"保住行身份"测不出来。 */
const STORED_RESERVATION_ID = '0198c0a1-6666-7000-8000-000000000001';
/** 首次受理时已经真的花掉、并记进账本的那一格。 */
const PRIOR_LEDGER_ID = '0198c0a1-7777-7000-8000-000000000001';

const CAPABILITY: Capability = capabilityOfTaskKind('VIBE_TURN') ?? 'QCA_TASK';

/** 自然键：与 `usage_reservations_task_capability_key UNIQUE (task_id, capability)` 同形。 */
function naturalKey(taskId: string, capability: string): string {
  return `${taskId}:${capability}`;
}

function studentActor(): Actor {
  const user: User = createUser({
    id: STUDENT_ID,
    role: 'STUDENT',
    loginName: parseLoginName('kid'),
    nickname: parseNickname('kid'),
    ageBand: 'L1',
    status: 'ACTIVE',
    ownerId: OWNER_ID,
    lockPolicy: LOCK_POLICY,
    revision: '1',
  });
  const session: AccountSession = createAccountSession({
    id: '0198c0a1-1111-7000-8000-000000000001',
    userId: user.id,
    status: 'ACTIVE',
    rememberMe: false,
    issuedAt: NOW,
    lastSeenAt: NOW,
    idleExpiresAt: parseTimestamp('2026-10-22T03:34:05.000Z'),
    absoluteExpiresAt: parseTimestamp('2026-10-29T03:04:05.000Z'),
    revokedAt: null,
    revocationReason: null,
  });
  return { user, session };
}

// ---------------------------------------------------------------------------
// 内存"数据库"
// ---------------------------------------------------------------------------

type UpsertTrace = {
  readonly key: string;
  /** `null` = 库里当时没有这一行（INSERT，而不是 UPSERT）。 */
  readonly fromState: string | null;
  readonly id: string;
};

class MemoryStore {
  readonly tasks = new Map<string, AiTask>();
  readonly projects = new Map<string, Project>();
  /** 自然键 ⇒ **一行**。与 infra 的 UNIQUE 约束同形：一个 task 的一个 capability 只有一行。 */
  readonly reservations = new Map<string, UsageReservation>();
  readonly ledger: UsageLedgerEntry[] = [];
  readonly upserts: UpsertTrace[] = [];
}

/**
 * 遵守红线的 `TaskRetryStore` 实现。形状照 `ports.ts` 的契约写：一个事务里 CAS 更新
 * task 行 + 按自然键重新持有预留，返回**落库后的** task，CAS 失配返回 `null`。
 */
class RetryStoreDouble implements TaskRetryStore {
  /**
   * 是否遵守裁定 (b).1。默认 `true`。
   *
   * 置 `false` 只给第 6 条反面对照用：它证明"拒绝"那条用例不是恒绿 —— 同一个替身、
   * 同一份库状态，只是少调一次 `assertReholdable`，结果就从抛错变成成功。
   */
  obeyReholdable = true;

  constructor(private readonly store: MemoryStore) {}

  async beginRetryAttempt(input: {
    readonly task: AiTask;
    readonly expectedRevision: Revision;
    readonly reservation: UsageReservation;
    readonly now: unknown;
  }): Promise<AiTask | null> {
    const existing = this.store.tasks.get(String(input.task.id));
    // CAS：`expectedRevision` 不匹配 ⇒ `null`，由用例映射 409 REVISION_CONFLICT。
    if (existing === undefined) return null;
    if (compareRevisions(existing.revision, input.expectedRevision) !== 0) return null;

    const key = naturalKey(String(input.task.id), input.reservation.capability);
    const stored = this.store.reservations.get(key) ?? null;
    // 🚨 裁定 (b).1 的执行点。必须在 UPSERT **之前**，否则脏写已经发生了。
    if (this.obeyReholdable && stored !== null) assertReholdable(stored);

    // 行身份（`id`）归实现所有：保住库里那个 id，只刷新状态与额度。
    const reheld = createUsageReservation({
      id: stored === null ? String(input.reservation.id) : String(stored.id),
      taskId: String(input.task.id),
      subjectUserId: String(input.reservation.subjectUserId),
      capability: input.reservation.capability,
      reservedUnits: input.reservation.reservedUnits,
      state: 'HELD',
      expiresAt: input.reservation.expiresAt,
    });
    this.store.upserts.push({ key, fromState: stored?.state ?? null, id: String(reheld.id) });
    this.store.reservations.set(key, reheld);
    this.store.tasks.set(String(input.task.id), input.task);
    return input.task;
  }
}

/**
 * 只实现 `retryTaskUseCase` 真的会碰的两个方法，其余一律**抛错**而不是返回 `null`。
 *
 * 返回 `null` 会让"用例走错了一条路径"表现为一个莫名的 `RESOURCE_NOT_FOUND`；抛错则
 * 直接指出是哪条不该被走的路被走了。
 */
class ProjectsDouble implements ProjectDirectory {
  constructor(private readonly store: MemoryStore) {}

  async findById(projectId: string): Promise<Project | null> {
    return this.store.projects.get(String(projectId)) ?? null;
  }

  async insert(): Promise<void> {
    throw new Error('retryTaskUseCase 不该写项目');
  }
  async insertVersion(): Promise<void> {
    throw new Error('retryTaskUseCase 不该写版本');
  }
  async findVersionById(): Promise<ProjectVersion | null> {
    throw new Error('retryTaskUseCase 不该读版本');
  }
  async list(_input: ListProjectsInput): Promise<Page<Project>> {
    throw new Error('retryTaskUseCase 不该列项目');
  }
  async listVersions(_input: ListVersionsInput): Promise<Page<ProjectVersion>> {
    throw new Error('retryTaskUseCase 不该列版本');
  }
}

class TasksDouble implements TaskReadDirectory {
  constructor(private readonly store: MemoryStore) {}

  async findTask(taskId: string): Promise<AiTask | null> {
    return this.store.tasks.get(String(taskId)) ?? null;
  }

  async findActiveWriteTask(): Promise<AiTask | null> {
    throw new Error('retryTaskUseCase 的准入判定走 usage.countActiveWriteTasks，不走这里');
  }
  async listEvents(): Promise<readonly TaskEvent[]> {
    throw new Error('retryTaskUseCase 不该读事件');
  }
  async findTurnAcceptance(): Promise<TurnAcceptanceRecord | null> {
    throw new Error('retryTaskUseCase 不该读幂等受理记录');
  }
}

class UsageDouble implements UsageDirectory {
  readonly quotaCalls: string[] = [];

  async quotaSnapshot(input: {
    ownerStudentId: string;
    capability: Capability;
    period: UsagePeriod;
    now: unknown;
  }): Promise<UsageQuotaSnapshot> {
    this.quotaCalls.push(input.capability);
    // `ABSENT` = 未设上限 ⇒ ADMIT。domain 不发明默认额度值，本测试也不。
    return {
      capability: input.capability,
      period: 'DAILY',
      committedInPeriod: 0,
      heldInPeriod: 0,
      limit: { kind: 'ABSENT' },
    };
  }

  async countActiveWriteTasks(): Promise<{
    readonly global: number;
    readonly group: number;
    readonly student: number;
    readonly project: number;
  }> {
    // 全 0 ⇒ `assertTaskAdmission` 给出 ADMIT（不是 QUEUE），于是 `nextRunAt` 为 null。
    return { global: 0, group: 0, student: 0, project: 0 };
  }
}

class RandomDouble implements RandomSource {
  private counter = 0;

  bytes(length: number): Uint8Array {
    return randomBytes(length);
  }
  sha256(input: Uint8Array | string): Uint8Array {
    return new Uint8Array(
      createHash('sha256')
        .update(typeof input === 'string' ? new TextEncoder().encode(input) : input)
        .digest(),
    );
  }
  uuidV7(): string {
    this.counter += 1;
    // 版本位 `7`、变体位 `8` 必须在原位，否则 `parseUsageReservationId` 当场拒掉。
    return `0198c0a1-9999-7000-8000-${String(this.counter).padStart(12, '0')}`;
  }
}

// ---------------------------------------------------------------------------
// 播种
// ---------------------------------------------------------------------------

type Seed = {
  /** 库里那一行预留的状态。`null` = 库里没有这一行。 */
  readonly storedState: string | null;
  /** task 的初始状态。默认 `FAILED`（可重试入口态之一）。 */
  readonly taskState?: 'FAILED' | 'TIMED_OUT' | 'SUCCEEDED';
  readonly obeyReholdable?: boolean;
  readonly seedLedger?: boolean;
};

function makeHarness(seed: Seed) {
  const store = new MemoryStore();

  const project = createProject({
    id: PROJECT_ID,
    ownerStudentId: STUDENT_ID,
    title: '会跳的小猫',
    workType: 'WEB',
    ageBand: 'L1',
    helpLevel: 'LV1',
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.projects.set(String(project.id), project);

  const taskState = seed.taskState ?? 'FAILED';
  const task = createAiTask({
    id: TASK_ID,
    kind: 'VIBE_TURN',
    projectId: PROJECT_ID,
    requestedBy: STUDENT_ID,
    maxAttempts: 3,
    state: taskState,
    attempt: 1,
    // `assertTaskCoherent` 要求终态自洽：FAILED 必有 error 与 finishedAt，
    // SUCCEEDED 必有 resultVersionId 与 finishedAt。种子不自洽 ⇒ 抛的是固件错误，
    // 不是被测行为（`pump.test.ts` 的守卫用例栽过一次）。
    error: taskState === 'FAILED' ? { code: 'INTERNAL_ERROR' } : null,
    resultVersionId: taskState === 'SUCCEEDED' ? VERSION_ID : null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: taskState === 'FAILED' || taskState === 'SUCCEEDED' ? FINISHED : null,
    revision: '4',
  });
  store.tasks.set(String(task.id), task);

  if (seed.storedState !== null) {
    store.reservations.set(
      naturalKey(TASK_ID, CAPABILITY),
      createUsageReservation({
        id: STORED_RESERVATION_ID,
        taskId: TASK_ID,
        subjectUserId: STUDENT_ID,
        capability: CAPABILITY,
        reservedUnits: 1,
        state: seed.storedState,
        expiresAt: HARD_DEADLINE,
      }),
    );
  }

  if (seed.seedLedger !== false) {
    // 账本里那一行是**另一个** task 的首次消耗：账本是按周期记账的 append-only 事实源，
    // 重新持有是一次预留行操作，两者不相干。用它做"账目不丢"的对照最干净 ——
    // 任何长度变化都只能是本条路径造成的。
    store.ledger.push(
      createUsageLedgerEntry({
        id: PRIOR_LEDGER_ID,
        eventKey: `commit:${OTHER_TASK_ID}:${CAPABILITY}:1`,
        taskId: OTHER_TASK_ID,
        subjectUserId: STUDENT_ID,
        capability: CAPABILITY,
        quantity: 1,
        provider: 'QCA',
        occurredAt: NOW,
      }),
    );
  }

  const retry = new RetryStoreDouble(store);
  retry.obeyReholdable = seed.obeyReholdable ?? true;

  const services = {
    projects: new ProjectsDouble(store),
    tasks: new TasksDouble(store),
    usage: new UsageDouble(),
    retry,
    random: new RandomDouble(),
  };

  return {
    store,
    retry,
    task,
    services,
    actor: studentActor(),
    retryOnce(expectedRevision: Revision = task.revision) {
      return retryTaskUseCase(services, {
        actor: studentActor(),
        taskId: parseTaskId(TASK_ID),
        expectedRevision,
        now: RETRY_AT,
      });
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function storedReservationOf(harness: Harness): UsageReservation | undefined {
  return harness.store.reservations.get(naturalKey(TASK_ID, CAPABILITY));
}

function ledgerFingerprint(harness: Harness): string {
  return JSON.stringify(
    harness.store.ledger.map((entry) => ({
      eventKey: entry.eventKey,
      quantity: entry.quantity,
      provider: entry.provider,
    })),
  );
}

// ---------------------------------------------------------------------------
// 1. `assertReholdable` 自身：四个状态逐一钉死
// ---------------------------------------------------------------------------

describe('裁定 (b).1：assertReholdable 的状态划分', () => {
  /** 合法重新持有的两个状态。裁定原文：「只在 `RELEASED` / `EXPIRED` 上合法」。 */
  const REHOLDABLE = ['RELEASED', 'EXPIRED'] as const;

  function reservationIn(state: string): UsageReservation {
    return createUsageReservation({
      id: STORED_RESERVATION_ID,
      taskId: TASK_ID,
      subjectUserId: STUDENT_ID,
      capability: CAPABILITY,
      reservedUnits: 1,
      state,
      expiresAt: HARD_DEADLINE,
    });
  }

  it('状态集合直接取 domain 的 RESERVATION_STATES，且划分是完备的（每个状态恰好落一边）', () => {
    // 不手抄一份四个状态：手抄的集合会与 domain 悄悄漂移，于是新增一个状态时
    // 这条测试**照样绿**，而生产上那个新状态没人判过。
    expect(RESERVATION_STATES).toHaveLength(4);
    const reholdable: readonly string[] = REHOLDABLE;
    const rejected = RESERVATION_STATES.filter((state) => !reholdable.includes(state));
    expect(rejected).toEqual(['HELD', 'COMMITTED']);
    // 完备性：每个状态恰好属于一边，没有既不属于这边也不属于那边的漏网状态。
    for (const state of RESERVATION_STATES) {
      expect(reholdable.includes(state) !== rejected.includes(state)).toBe(true);
    }
  });

  it('RELEASED / EXPIRED ⇒ 放行', () => {
    for (const state of REHOLDABLE) {
      expect(() => assertReholdable(reservationIn(state))).not.toThrow();
    }
  });

  it('🚨 COMMITTED ⇒ 拒绝（红线），错误码是 400 REQUEST_INVALID 而不是 409', () => {
    let thrown: unknown = null;
    try {
      assertReholdable(reservationIn('COMMITTED'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown).toMatchObject({
      code: 'REQUEST_INVALID',
      valueObject: 'UsageReservation.state',
    });
    // 409 的语义是"拿新的 ETag 再来一次"。可这里的失配与 revision 无关（revision 完全
    // 可能对得上），客户端照着 409 重试只会无限循环 —— 所以断言它**不是** REVISION_CONFLICT。
    expect((thrown as { code: string }).code).not.toBe('REVISION_CONFLICT');
  });

  it('HELD ⇒ 也拒绝：那会绕过 pump 的单飞锁，把别人正持有的预留抢回来', () => {
    expect(() => assertReholdable(reservationIn('HELD'))).toThrow(
      expect.objectContaining({ code: 'REQUEST_INVALID' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 用例把实现抛出的拒绝**原样传出**
// ---------------------------------------------------------------------------

describe('裁定 (b).1：retryTaskUseCase 原样传出实现的拒绝', () => {
  it('库里那一行是 COMMITTED ⇒ 抛错，且 task 行 / 预留行 / 账目一个字都没动', async () => {
    const harness = makeHarness({ storedState: 'COMMITTED' });
    const before = {
      task: harness.store.tasks.get(TASK_ID),
      reservation: storedReservationOf(harness),
      ledger: ledgerFingerprint(harness),
    };

    await expect(harness.retryOnce()).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
      valueObject: 'UsageReservation.state',
    });

    // 不落新 attempt：行还是原来那一行（同 revision、同 attempt、还在 FAILED）。
    const after = harness.store.tasks.get(TASK_ID);
    expect(after).toBe(before.task);
    expect(after?.attempt).toBe(1);
    expect(after?.state).toBe('FAILED');
    expect(after?.revision).toBe('4');
    // 没有发生任何 UPSERT —— 守卫在写之前。
    expect(harness.store.upserts).toHaveLength(0);
    // 预留行没被改回 HELD（这就是红线本身）。
    expect(storedReservationOf(harness)).toBe(before.reservation);
    expect(storedReservationOf(harness)?.state).toBe('COMMITTED');
    // 账目没被追加也没被抹掉。
    expect(ledgerFingerprint(harness)).toBe(before.ledger);
  });

  it('反面对照：同一个替身、同一份库状态，只是库里那一行换成 RELEASED ⇒ 放行', async () => {
    // 没有这一条，上面那条"拒绝"可能是恒绿的（比如替身根本就没接上、或者用例在更早的
    // 判定里就抛了同一个错误码）。
    const harness = makeHarness({ storedState: 'RELEASED' });
    await expect(harness.retryOnce()).resolves.toMatchObject({ attempt: 2 });
    expect(harness.store.upserts).toHaveLength(1);
  });

  it('🚨 反面对照：一个**不调** assertReholdable 的实现能把 COMMITTED 重新置为 HELD', async () => {
    // 这条用例证明两件事实，缺一不可：
    // ① 用例自己**没有**第二道守卫 —— 红线只在实现侧，写新实现忘了调它就会白送一次付费生成；
    // ② 上面那条"拒绝"不是恒绿 —— 唯一变量就是 `obeyReholdable`，结果从抛错翻成成功。
    const harness = makeHarness({ storedState: 'COMMITTED', obeyReholdable: false });
    const ledgerBefore = ledgerFingerprint(harness);

    await expect(harness.retryOnce()).resolves.toMatchObject({ attempt: 2 });
    expect(storedReservationOf(harness)?.state).toBe('HELD');
    // 而账目上仍然只有原来那一条：第二次生成花掉了额度，账本却看不出来 ——
    // 这正是"不可协商"四个字指的那个后果。
    expect(ledgerFingerprint(harness)).toBe(ledgerBefore);
  });
});

// ---------------------------------------------------------------------------
// 3. 裁定 (b).2：重新持有**不碰账目**，且保住自然键那一行的身份
// ---------------------------------------------------------------------------

describe('裁定 (b).2：重新持有走 append-only 账本，预留行按自然键 UPSERT', () => {
  it('RELEASED ⇒ 重新持有成功：attempt+1、回到 QUEUED、行身份保住、仍然只有一行', async () => {
    const harness = makeHarness({ storedState: 'RELEASED' });
    const result = await harness.retryOnce();

    expect(result.taskId).toBe(harness.task.id);
    expect(result.attempt).toBe(2);
    // 响应 ETag 的来源是**落库后的** revision：`beginRetryAttempt` 返回的那一行。
    expect(result.revision).toBe(storedTaskRevision(harness));

    const stored = harness.store.tasks.get(TASK_ID);
    expect(stored?.state).toBe('QUEUED');
    expect(stored?.attempt).toBe(2);
    expect(stored?.error).toBeNull();
    expect(stored?.finishedAt).toBeNull();

    // 自然键 UPSERT，不是"再插一行"：库里仍然只有一行，且 id 是**库里那个**，
    // 不是用例新造的随机 id（`usage_reservations_task_capability_key` 只允许一行）。
    expect(harness.store.reservations.size).toBe(1);
    const reheld = storedReservationOf(harness);
    expect(reheld?.state).toBe('HELD');
    expect(String(reheld?.id)).toBe(STORED_RESERVATION_ID);
    expect(harness.store.upserts).toEqual([
      { key: naturalKey(TASK_ID, CAPABILITY), fromState: 'RELEASED', id: STORED_RESERVATION_ID },
    ]);
  });

  it('重新持有既不追加也不抹掉账本行', async () => {
    const harness = makeHarness({ storedState: 'EXPIRED' });
    const before = ledgerFingerprint(harness);
    await harness.retryOnce();
    expect(ledgerFingerprint(harness)).toBe(before);
    expect(harness.store.ledger).toHaveLength(1);
    expect(harness.store.ledger[0]?.eventKey).toBe(`commit:${OTHER_TASK_ID}:${CAPABILITY}:1`);
  });

  it('反面对照：账本断言真的会红（注入一个清空账本的实现）', async () => {
    // 上一条"账目不丢"若没有这一条，就无法区分"实现确实没碰账本"与"断言根本没在看账本"。
    const harness = makeHarness({ storedState: 'RELEASED' });
    const before = ledgerFingerprint(harness);
    const obeying = harness.retry.beginRetryAttempt.bind(harness.retry);
    harness.retry.beginRetryAttempt = async (input) => {
      const result = await obeying(input);
      harness.store.ledger.length = 0;
      return result;
    };

    await harness.retryOnce();
    expect(harness.store.ledger).toHaveLength(0);
    expect(ledgerFingerprint(harness)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. 判定次序与 CAS
// ---------------------------------------------------------------------------

describe('retryTaskUseCase 的判定次序与 CAS', () => {
  it('CAS 失配 ⇒ REVISION_CONFLICT，且不写任何一行', async () => {
    const harness = makeHarness({ storedState: 'RELEASED' });
    await expect(harness.retryOnce('77' as Revision)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(harness.store.upserts).toHaveLength(0);
    expect(storedReservationOf(harness)?.state).toBe('RELEASED');
    // 反面对照：同一个替身在 revision 对上时确实放行，所以上面那次拒绝不是"永远拒绝"。
    await expect(harness.retryOnce()).resolves.toMatchObject({ attempt: 2 });
  });

  it('不可重试的终态 ⇒ TASK_NOT_RETRYABLE，且**没有触碰**预留存储', async () => {
    // `tasks.ts` 的判定次序：②可重试性 在 ⑤落库 之前，且它只看 task 自身、不读外部状态。
    // 所以一个根本不可重试的任务不该引起任何一次预留读写 —— 顺序写反了这里会红。
    const harness = makeHarness({ storedState: 'COMMITTED', taskState: 'SUCCEEDED' });
    await expect(harness.retryOnce()).rejects.toMatchObject({ code: 'TASK_NOT_RETRYABLE' });
    expect(harness.store.upserts).toHaveLength(0);
    expect(storedReservationOf(harness)?.state).toBe('COMMITTED');
    expect(harness.store.tasks.get(TASK_ID)?.state).toBe('SUCCEEDED');
  });

  it('归属判定在最前：别人的项目 ⇒ RESOURCE_NOT_FOUND，连额度都不读', async () => {
    const harness = makeHarness({ storedState: 'RELEASED' });
    const stranger: Actor = {
      user: createUser({
        id: '0198c0a1-0000-7000-8000-000000000009',
        role: 'STUDENT',
        loginName: parseLoginName('otherkid'),
        nickname: parseNickname('otherkid'),
        ageBand: 'L1',
        status: 'ACTIVE',
        ownerId: OWNER_ID,
        lockPolicy: LOCK_POLICY,
        revision: '1',
      }),
      session: studentActor().session,
    };
    await expect(
      retryTaskUseCase(harness.services, {
        actor: stranger,
        taskId: parseTaskId(TASK_ID),
        expectedRevision: harness.task.revision,
        now: RETRY_AT,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(harness.services.usage.quotaCalls).toHaveLength(0);
    expect(harness.store.upserts).toHaveLength(0);
  });
});

function storedTaskRevision(harness: Harness): Revision {
  const stored = harness.store.tasks.get(TASK_ID);
  if (stored === undefined) throw new Error('task 行不见了');
  return stored.revision;
}

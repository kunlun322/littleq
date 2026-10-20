/**
 * 三个「非本单重点」端口的内存参考实现（ZLQ-203 §1，`five-port-contract` 的运行时靶子）。
 *
 * ## 为什么契约测试需要实现，光有 `interface` 不够
 * TypeScript 的 `interface` 编译后**不存在**。所以「五个端口都声明好了」这句话如果只靠扫
 * 源码断言方法名，就永远测不到端口注释里那些真正要紧的行为约定：CAS 不匹配返回 `null`
 * 而不是抛、`work` 抛错就一条都不留下、过期租约被接管后旧令牌必须失效。这三个类存在的
 * 唯一目的，就是让那些约定**可红可绿**。
 *
 * ## 诚实分层（ZLQ-194 §16）：三个都是替身
 * - `InMemoryDatabaseAdapter` **不解释 SQL**。真 SQL、真连接池、Neon 驱动接线属于 D5。
 * - `InMemoryTaskRepository` 的租约活在进程内的 `Map` 里，进程一死就全没了。真实现是
 *   `UPDATE … WHERE lease_until < now` 这类**单条原子语句**，也属于 D5 —— 本类能证明的是
 *   判据接对了、CAS 语义对了，证明不了两个进程之间的互斥。
 * - `InMemoryRuntimePublisher` 只发短期预览 grant。永久发布 / slug / 回滚不是「还没做」，
 *   是端口里**没有这三个方法**。
 */
import { randomBytes } from 'node:crypto';

import {
  type AiTask,
  type Revision,
  type RuntimeRef,
  type TaskEvent,
  type TaskId,
  type Timestamp,
  assertEventFollows,
  brand,
  canClaimTask,
  canReacquireLease,
  canRenewLease,
  canRequeueOnLeaseExpiry,
  compareRevisions,
  nextRevision,
  parseRuntimeRef,
  timestampSortKey,
  transitionTask,
} from '@littleq/domain';

import { infraError, type InfraErrorCode } from './errors.js';
import { type HealthResult, parseObjectRef, shiftTimestamp } from './types.js';
import {
  type DatabaseAdapter,
  type DatabaseTransaction,
  type MigrationReport,
} from './ports/database-adapter.js';
import {
  type TaskClaimInput,
  type TaskLease,
  type TaskRepository,
} from './ports/task-repository.js';
import {
  RUNTIME_PREVIEW_AUDIENCE,
  type RuntimePreview,
  type RuntimePublisher,
} from './ports/runtime-publisher.js';
import { MANIFEST_MAX_BYTES, manifestKey } from './object-store/artifact-sealer.js';
import { type IssueGrantInput, type IssuedGrant } from './grant/object-read-grant.js';

/** 一条迁移：一个标识 + 它要执行的语句。标识就是 `MigrationReport.applied` 里的元素。 */
export interface InMemoryMigration {
  readonly id: string;
  readonly statements: readonly string[];
}

export interface InMemoryDatabaseAdapterOptions {
  readonly migrations?: readonly InMemoryMigration[];
  /**
   * 真正「执行语句」的那一半。省略时 `query` 返回空结果集、`execute` 返回 **0 行** ——
   * 0 正是端口注释里那个 CAS 失败信号，一个不解释 SQL 的实现只能诚实地报「什么都没改到」。
   */
  readonly backend?: DatabaseTransaction;
}

export class InMemoryDatabaseAdapter implements DatabaseAdapter {
  readonly #migrations: readonly InMemoryMigration[];
  readonly #backend: DatabaseTransaction | null;
  readonly #applied = new Set<string>();
  readonly #committed: string[] = [];
  #openTransactions = 0;
  #closed = false;
  #healthDetail: InfraErrorCode | null = null;

  constructor(options: InMemoryDatabaseAdapterOptions = {}) {
    this.#migrations = options.migrations ?? [];
    this.#backend = options.backend ?? null;
  }

  /** 已**提交**事务里发出的语句，按提交顺序。回滚掉的语句不会出现在这里。 */
  get committedStatements(): readonly string[] {
    return [...this.#committed];
  }

  /** 还开着的事务数。`work` 抛错之后它必须回到 0，否则就是连接泄漏。 */
  get openTransactions(): number {
    return this.#openTransactions;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 让下一次 `health()` 报这个内部码 —— 用来断言 `detail` 里装不下 provider 的原文。 */
  failHealthWith(code: InfraErrorCode | null): void {
    this.#healthDetail = code;
  }

  async transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    if (this.#closed) throw infraError('PROVIDER_UNAVAILABLE');
    const buffered: string[] = [];
    const backend = this.#backend;
    const tx: DatabaseTransaction = {
      async query<TRow>(sql: string, params: readonly unknown[]): Promise<readonly TRow[]> {
        buffered.push(sql);
        return backend === null ? [] : backend.query<TRow>(sql, params);
      },
      async execute(sql: string, params: readonly unknown[]): Promise<number> {
        buffered.push(sql);
        return backend === null ? 0 : backend.execute(sql, params);
      },
    };

    this.#openTransactions += 1;
    try {
      const result = await work(tx);
      // 提交点只有一处，而且在 `work` 正常返回**之后**：抛错就永远走不到这一行。
      this.#committed.push(...buffered);
      return result;
    } finally {
      this.#openTransactions -= 1;
    }
  }

  async migrate(): Promise<MigrationReport> {
    if (this.#closed) throw infraError('PROVIDER_UNAVAILABLE');
    const applied: string[] = [];
    // 迁移整体在一个事务里跑，而且 `#applied` 只在事务**提交之后**才更新：中途失败时
    // 「哪几条已经应用过」这件事本身也一起回滚，幂等才有意义。
    const pending = new Set<string>();
    await this.transaction(async (tx) => {
      for (const migration of this.#migrations) {
        if (this.#applied.has(migration.id) || pending.has(migration.id)) continue;
        for (const statement of migration.statements) await tx.execute(statement, []);
        pending.add(migration.id);
        applied.push(migration.id);
      }
    });
    for (const id of pending) this.#applied.add(id);
    return { applied, schemaVersion: this.#applied.size };
  }

  async health(): Promise<HealthResult> {
    const startedAt = Date.now();
    const status = this.#closed ? 'unavailable' : this.#healthDetail === null ? 'ok' : 'degraded';
    return {
      status,
      checkedAt: new Date(startedAt),
      latencyMs: Date.now() - startedAt,
      detail: this.#closed ? 'PROVIDER_UNAVAILABLE' : this.#healthDetail,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

interface LeaseRow {
  readonly workerId: string;
  readonly lease: TaskLease;
}

export class InMemoryTaskRepository implements TaskRepository {
  readonly #tasks = new Map<TaskId, AiTask>();
  readonly #leases = new Map<TaskId, LeaseRow>();
  readonly #events = new Map<TaskId, TaskEvent[]>();
  readonly #released: Array<{ readonly taskId: TaskId; readonly at: Timestamp }> = [];
  #leaseSerial = 0;
  #claims = 0;
  #reacquisitions = 0;
  #casMisses = 0;

  /** 写入一个任务。真实现里这一步是 `INSERT`；本类用它准备夹具。 */
  seed(task: AiTask): void {
    this.#tasks.set(task.id, task);
  }

  get claimedCount(): number {
    return this.#claims;
  }

  get reacquisitionCount(): number {
    return this.#reacquisitions;
  }

  /** CAS 不匹配的次数。它必须是**返回值 `null`**，一次都不该变成异常。 */
  get casMissCount(): number {
    return this.#casMisses;
  }

  get activeLeaseCount(): number {
    return this.#leases.size;
  }

  get releasedLeases(): ReadonlyArray<{ readonly taskId: TaskId; readonly at: Timestamp }> {
    return [...this.#released];
  }

  leaseWorkerOf(taskId: TaskId): string | null {
    return this.#leases.get(taskId)?.workerId ?? null;
  }

  eventsOf(taskId: TaskId): readonly TaskEvent[] {
    return [...(this.#events.get(taskId) ?? [])];
  }

  async claim(input: TaskClaimInput): Promise<readonly TaskLease[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) return [];
    const claimable = [...this.#tasks.values()]
      .filter((task) => canClaimTask(task.state, task.nextRunAt, input.now))
      .map((task) => ({ task, key: claimOrder(task) }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .slice(0, input.limit)
      .map((entry) => entry.task);

    const leases: TaskLease[] = [];
    for (const task of claimable) {
      // `canClaimTask` 内部已经问过迁移表，所以这里的 code 参数走不到。选
      // `REVISION_CONFLICT` 是因为「领不到」按定义就是一次输掉的竞争，对外正是 409。
      const claimed = transitionTask(task, 'CLAIMED', input.now, 'REVISION_CONFLICT');
      const lease = this.#newLease(claimed, input.now, input.leaseSeconds);
      this.#tasks.set(claimed.id, claimed);
      this.#leases.set(claimed.id, { workerId: input.workerId, lease });
      this.#claims += 1;
      leases.push(lease);
    }
    return leases;
  }

  async renewLease(input: {
    readonly lease: TaskLease;
    readonly now: Timestamp;
    readonly leaseSeconds: number;
  }): Promise<TaskLease | null> {
    const row = this.#leases.get(input.lease.taskId);
    const task = this.#tasks.get(input.lease.taskId);
    if (row === undefined || task === undefined) return null;
    // 令牌是唯一凭据：被接管过的租约令牌已经换了，旧 worker 在这里拿到 `null`，
    // 而不是把别人的租约又延长一段。
    if (row.lease.leaseToken !== input.lease.leaseToken) return null;
    if (!canRenewLease(task.state, row.lease.leaseUntil, input.now)) return null;
    const renewed: TaskLease = {
      ...row.lease,
      leaseUntil: leaseUntilOf(input.now, input.leaseSeconds),
    };
    this.#leases.set(input.lease.taskId, { workerId: row.workerId, lease: renewed });
    return renewed;
  }

  async reacquireLease(input: {
    readonly taskId: TaskId;
    readonly workerId: string;
    readonly now: Timestamp;
    readonly leaseSeconds: number;
  }): Promise<TaskLease | null> {
    const task = this.#tasks.get(input.taskId);
    if (task === undefined) return null;
    const previous = this.#leases.get(input.taskId);
    if (!canReacquireLease(task.state, previous?.lease.leaseUntil ?? null, input.now)) return null;
    // 状态**不变**，只换持有人：`RUNNING` 崩掉时 QCA Session 还活着，接管者要接着推进，
    // 从头再来一遍就是重复计费。
    const lease = this.#newLease(task, input.now, input.leaseSeconds);
    this.#leases.set(input.taskId, { workerId: input.workerId, lease });
    this.#reacquisitions += 1;
    return lease;
  }

  async requeueOnLeaseExpiry(input: {
    readonly taskId: TaskId;
    readonly now: Timestamp;
  }): Promise<boolean> {
    const task = this.#tasks.get(input.taskId);
    if (task === undefined) return false;
    const row = this.#leases.get(input.taskId);
    if (!canRequeueOnLeaseExpiry(task.state, row?.lease.leaseUntil ?? null, input.now)) {
      return false;
    }
    const requeued = transitionTask(task, 'QUEUED', input.now, 'REVISION_CONFLICT');
    this.#tasks.set(input.taskId, requeued);
    this.#leases.delete(input.taskId);
    return true;
  }

  async releaseLease(input: { readonly lease: TaskLease; readonly now: Timestamp }): Promise<void> {
    const row = this.#leases.get(input.lease.taskId);
    if (row === undefined || row.lease.leaseToken !== input.lease.leaseToken) return;
    this.#leases.delete(input.lease.taskId);
    this.#released.push({ taskId: input.lease.taskId, at: input.now });
  }

  async save(input: {
    readonly task: AiTask;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null> {
    // 任务不存在时 `expectedRevision` 就是调用方声称的初始版本 —— 插入也走 CAS，
    // 不给「忘了带版本号」留一条静默成功的路。
    const baseline = this.#tasks.get(input.task.id) ?? input.task;
    if (compareRevisions(baseline.revision, input.expectedRevision) !== 0) {
      this.#casMisses += 1;
      return null;
    }
    this.#tasks.set(input.task.id, input.task);
    const row = this.#leases.get(input.task.id);
    if (row !== undefined) {
      this.#leases.set(input.task.id, {
        workerId: row.workerId,
        lease: { ...row.lease, revision: input.task.revision },
      });
    }
    return input.task;
  }

  async appendEvent(input: {
    readonly event: TaskEvent;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null> {
    const current = this.#tasks.get(input.event.taskId);
    if (current === undefined) return null;
    if (compareRevisions(current.revision, input.expectedRevision) !== 0) {
      this.#casMisses += 1;
      return null;
    }
    const events = this.#events.get(input.event.taskId) ?? [];
    // 序列约束由 domain 判定，违规时抛的是 `DomainError`：那是业务规则失败，
    // 与「版本冲突」不是一回事，所以这里刻意不翻译它。
    assertEventFollows(input.event, events.at(-1) ?? null);
    events.push(input.event);
    this.#events.set(input.event.taskId, events);
    return this.#bump(current);
  }

  async scheduleNextRun(input: {
    readonly taskId: TaskId;
    readonly nextRunAt: Timestamp;
    readonly expectedRevision: Revision;
  }): Promise<AiTask | null> {
    const current = this.#tasks.get(input.taskId);
    if (current === undefined) return null;
    if (compareRevisions(current.revision, input.expectedRevision) !== 0) {
      this.#casMisses += 1;
      return null;
    }
    return this.#bump({ ...current, nextRunAt: input.nextRunAt });
  }

  async findById(taskId: TaskId): Promise<AiTask | null> {
    return this.#tasks.get(taskId) ?? null;
  }

  #bump(task: AiTask): AiTask {
    const next: AiTask = { ...task, revision: nextRevision(task.revision) };
    this.#tasks.set(next.id, next);
    const row = this.#leases.get(next.id);
    if (row !== undefined) {
      this.#leases.set(next.id, {
        workerId: row.workerId,
        lease: { ...row.lease, revision: next.revision },
      });
    }
    return next;
  }

  #newLease(task: AiTask, now: Timestamp, leaseSeconds: number): TaskLease {
    // 先验时长再吃序号：一次被拒的铸造不该在可观测的序号序列上留下空洞。
    const leaseUntil = leaseUntilOf(now, leaseSeconds);
    this.#leaseSerial += 1;
    const serial = this.#leaseSerial.toString(16).padStart(8, '0');
    return {
      taskId: task.id,
      // 令牌带随机后缀：它是所有权的唯一凭据，可猜的令牌等于没有令牌。
      leaseToken: brand<string, 'LeaseToken'>(`lease_${serial}_${randomBytes(8).toString('hex')}`),
      leaseUntil,
      revision: task.revision,
    };
  }
}

/**
 * 租约到期时刻。**下界是 1 秒**，这不是随手加的夹紧，而是租约语义的一部分：
 * `leaseSeconds` 为 0 或负数会铸出一份**当场就已过期**的租约，而 `canReacquireLease`
 * 只看「租约持有态 + 已过期」，于是另一个 worker 立刻就能接管 —— 同一时刻两个推进器
 * 驱动同一个任务，正是租约要消灭的那件事。`shiftTimestamp` 只保证算得出合法 ISO 串
 * （它拒绝的是 NaN / 非整数），它管不了符号，所以下界必须在这里补上。
 *
 * D5 的真实实现要带同一条守卫：调用侧 `lease_seconds >= 1`，或者在铸造语句里让它算不出
 * 一个 `lease_until <= now()` 的行。
 */
function leaseUntilOf(now: Timestamp, leaseSeconds: number): Timestamp {
  if (Number.isSafeInteger(leaseSeconds) && leaseSeconds < 1) {
    throw infraError('LEASE_TTL_OUT_OF_RANGE');
  }
  return shiftTimestamp(now, leaseSeconds, 'LEASE_TTL_OUT_OF_RANGE');
}

/** `(next_run_at, id)` 的确定性领取顺序；arch §6.1 的 `(next_run_at)` 索引就是它。 */
function claimOrder(task: AiTask): string {
  return `${timestampSortKey(task.nextRunAt ?? task.createdAt)} ${task.id}`;
}

/** `ObjectReadGrantService` 结构上就满足它；单独声明是为了让本类能被更小的替身驱动。 */
export interface PreviewGrantIssuer {
  issue(input: IssueGrantInput): Promise<IssuedGrant>;
  revoke(grantId: string, now: Timestamp): Promise<number>;
}

export interface InMemoryRuntimePublisherOptions {
  readonly grants: PreviewGrantIssuer;
  readonly now?: () => Date;
}

export class InMemoryRuntimePublisher implements RuntimePublisher {
  readonly #grants: PreviewGrantIssuer;
  readonly #now: () => Date;
  readonly #grantIdByRuntimeRef = new Map<RuntimeRef, string>();

  constructor(options: InMemoryRuntimePublisherOptions) {
    this.#grants = options.grants;
    this.#now = options.now ?? (() => new Date());
  }

  get activePreviewCount(): number {
    return this.#grantIdByRuntimeRef.size;
  }

  async publishPreview(input: {
    readonly projectId: RuntimePreview['projectId'];
    readonly projectVersionId: RuntimePreview['projectVersionId'];
    readonly artifactHash: RuntimePreview['artifactHash'];
    readonly ttlSeconds: number;
    readonly now: Timestamp;
  }): Promise<RuntimePreview> {
    // 预览入口指向**固化清单**：Runtime 先读清单，再按清单里的分片各自取字节。
    // TTL 的上界不在这里重复判一遍 —— grant 层已经把 300 秒钉死了，两处各判一次只会
    // 在两者不一致时产生一个说不清谁对的行为。
    const issued = await this.#grants.issue({
      objectRef: parseObjectRef(manifestKey(input.artifactHash)),
      artifactHash: input.artifactHash,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      maxBytes: MANIFEST_MAX_BYTES,
      ttlSeconds: input.ttlSeconds,
      now: input.now,
    });
    const runtimeRef = parseRuntimeRef(`preview/${input.projectVersionId}/${issued.grantId}`);
    this.#grantIdByRuntimeRef.set(runtimeRef, issued.grantId);
    return {
      runtimeRef,
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      artifactHash: input.artifactHash,
      issuedAt: input.now,
      expiresAt: issued.expiresAt,
      url: issued.url,
    };
  }

  async revokePreview(input: {
    readonly runtimeRef: RuntimeRef;
    readonly now: Timestamp;
  }): Promise<void> {
    const grantId = this.#grantIdByRuntimeRef.get(input.runtimeRef);
    // 撤销一个从没签发过的 ref 是调用方 bug：静默返回会让调用方以为预览已经断了。
    // 反过来，**重复**撤销同一个 ref 必须安静地成功 —— 映射刻意不在这里删掉。
    if (grantId === undefined) throw infraError('OBJECT_READ_GRANT_UNKNOWN');
    await this.#grants.revoke(grantId, input.now);
  }

  async health(): Promise<HealthResult> {
    // 本 publisher 自己没有 provider 连接可探（字节读取的健康在 `ObjectStore.health`），
    // 所以它只报「我还活着」，`latencyMs` 留 null 表示没有测量对象。
    return { status: 'ok', checkedAt: this.#now(), latencyMs: null, detail: null };
  }
}

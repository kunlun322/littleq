/**
 * `task-lease-cas` —— 端口 2 的行为不变量（ZLQ-194 §6.2、arch §6.1／附录 A §6.4）。
 *
 * ## 为什么这条能力值得单独一个文件
 * `five-port-contract` 证明的是**形状**：`TaskRepository` 声明了那九个方法。但端口注释里
 * 真正要紧的话全是行为约定 ——「原子领取：只可能拿到 `canClaimTask` 为真的任务，且拿到即
 * 已持有租约」「带 `expectedRevision` 的方法在不匹配时返回 `null`，**不抛**」「接管孤儿租约
 * 时状态不变，只换持有人」。一个把判据调对了、但把「先 SELECT 再 UPDATE」写成两步的实现，
 * 方法签名完全一样，`five-port-contract` 会绿。本文件就是让那几句话可红可绿。
 *
 * ## 判据在 domain，原子性在这里
 * 「能不能领」「能不能续租」「能不能接管」的判据是 `@littleq/domain` 的纯函数，本文件不
 * 复算它们（那是 domain 自己的测试的活儿）。本文件钉的是**持久化侧**的三件事：判据被
 * 真的问过了、问过之后的写入是原子的、以及 CAS 失败时的返回形状是 `null` 而不是异常。
 *
 * ## 诚实分层（ZLQ-194 §16）：替身证明到哪一步为止
 * `InMemoryTaskRepository` 活在**单进程的单个事件循环**里，`claim` 的第一个 `await` 出现在
 * 所有写入之后 —— 也就是说它根本没有让出点。所以：
 *   ✅ 领取的**筛选、排序、上界、状态迁移、租约铸造**都真的执行了，判据被真的问过了；
 *   ✅ 令牌不符 / 已过期 ⇒ `renewLease` 返回 `null`，绝不把别人的租约又延长一段；
 *   ✅ 接管换令牌**不换状态**（`RUNNING` 崩掉不退回 `QUEUED`，那会重复计费）；
 *   ✅ 租约过期回退**仅限 `CLAIMED`**；
 *   ✅ 三个 CAS 方法在不匹配时**返回 `null` 而不是抛**，且计数器证明它们真的走到了那一支；
 *   ✅ 事件序列违规抛的是 domain 的 `DomainError`，端口**刻意不翻译**它；
 *   ✅ 非法租约时长在铸造与续租两处都拒绝，且拒绝时**一条都没写进去**。
 * 本文件**不能**证明、明确留给 D5/D6 的：
 *   ❌ **跨进程互斥**。两个 worker 同时 `claim` 在单进程替身里必然只有一个赢 —— 这个结论
 *     来自 JavaScript 的单线程语义，不来自实现。真互斥只能由 D5 那**一条**原子语句给出
 *     （`UPDATE ai_tasks SET state='CLAIMED', lease_owner=$1, lease_until=$2
 *     WHERE id = (SELECT … WHERE state='QUEUED' AND next_run_at <= now() … FOR UPDATE SKIP
 *     LOCKED) RETURNING …`）。**本用例的「只有一个赢」不是那条语句的证明。**
 *   ❌ 真 PostgreSQL 的 `FOR UPDATE SKIP LOCKED` 语义、索引是否真的被用上（`(next_run_at)`）；
 *   ❌ 时钟来源：替身里 `now` 全是入参，真实现读的是数据库时钟还是应用时钟属于 D5。
 */
import {
  type AiTask,
  type TaskId,
  type TaskEvent,
  type Timestamp,
  brand,
  compareRevisions,
  createAiTask,
  createTaskEvent,
  DomainError,
  nextRevision,
  nextTaskEventSequence,
  transitionTask,
} from '@littleq/domain';
import { describe, expect, it } from 'vitest';

import {
  INFRA_ERROR_CODES,
  InMemoryTaskRepository,
  isInfraError,
  type InfraErrorCode,
  type LeaseToken,
  type TaskLease,
} from '../src/index.js';
import {
  at,
  atSeconds,
  EPOCH,
  makeTask,
  rejectedCode,
  revisionAt,
  uuidAt,
  type TaskFixture,
} from './support.js';

const CAPABILITY = 'task-lease-cas';

const LEASE_SECONDS = 60;
const WORKER_A = 'worker-a';
const WORKER_B = 'worker-b';

/** 令牌的形状：`lease_<8 位十六进制序号>_<16 位十六进制随机后缀>`。 */
const LEASE_TOKEN_PATTERN = /^lease_[0-9a-f]{8}_[0-9a-f]{16}$/;

function claimInput(workerId: string, now: Timestamp, limit = 1, leaseSeconds = LEASE_SECONDS) {
  return { workerId, now, leaseSeconds, limit };
}

function requireTask(found: AiTask | null): AiTask {
  if (found === null) throw new Error('夹具任务不见了，后面的断言全会假绿');
  return found;
}

function onlyLease(leases: readonly TaskLease[], what: string): TaskLease {
  const lease = leases[0];
  if (lease === undefined) throw new Error(`${what}没开出租约`);
  if (leases.length !== 1) throw new Error(`${what}开出了 ${leases.length} 份租约，期望 1 份`);
  return lease;
}

/** 一个已经过期的时刻：`isLeaseExpired` 用的是 `<=`，所以 `leaseUntil` 当刻即已过期。 */
function expiredAt(lease: TaskLease): Timestamp {
  return lease.leaseUntil;
}

/** 到期前一刻。与 `expiredAt` 成对使用，把 `<=` 这条边界钉死。 */
function beforeExpiry(leaseUntil: Timestamp): Timestamp {
  return at((Date.parse(leaseUntil) - Date.parse(EPOCH)) / 1000 - 1);
}

/**
 * 把已领取的任务推进到 `RUNNING`。
 *
 * 走 `CLAIMED → SESSION_CREATING → RUNNING`，因为迁移表里**没有** `CLAIMED → RUNNING`
 * 这条边 —— 直接跳会在 `assertTransition` 上抛，那看起来像替身坏了，其实是夹具自己抄近路。
 */
async function driveToRunning(repo: InMemoryTaskRepository, taskId: TaskId): Promise<AiTask> {
  let current = requireTask(await repo.findById(taskId));
  for (const state of ['SESSION_CREATING', 'RUNNING'] as const) {
    const next = transitionTask(current, state, at(1), 'REVISION_CONFLICT');
    const saved = await repo.save({ task: next, expectedRevision: current.revision });
    if (saved === null) throw new Error(`推进到 ${state} 时撞上了 CAS`);
    current = saved;
  }
  return current;
}

/** 终态任务。`CANCELLED` 是唯一一个不需要 `resultVersionId` 就能直接播种的终态。 */
function terminalTask(fixture: TaskFixture = {}): AiTask {
  return createAiTask({
    id: uuidAt(99),
    kind: 'VIBE_TURN',
    projectId: uuidAt(2),
    requestedBy: uuidAt(3),
    maxAttempts: 3,
    createdAt: EPOCH,
    state: 'CANCELLED',
    cancelRequestedAt: EPOCH,
    finishedAt: EPOCH,
    ...fixture,
  });
}

function event(taskId: TaskId, sequence: bigint, createdAt: Timestamp): TaskEvent {
  return createTaskEvent({
    taskId,
    sequence,
    eventType: 'PROGRESS',
    safePayload: { progress: Number(sequence) },
    createdAt,
  });
}

/** 取出被拒的那次调用抛出的**原始**错误（不翻译、不假定类型）。 */
async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  const settled = await Promise.allSettled([promise]);
  const outcome = settled[0];
  if (outcome === undefined) throw new Error('allSettled 没有给出结果');
  if (outcome.status === 'fulfilled') throw new Error('期望这次调用被拒绝，但它成功了');
  return outcome.reason;
}

describe(CAPABILITY, () => {
  it('task-lease-cas: 原子领取 —— 两个 worker 抢同一个任务，只有一个拿到租约', async () => {
    const repo = new InMemoryTaskRepository();
    const task = makeTask({ id: uuidAt(1) });
    repo.seed(task);

    const [first, second] = await Promise.all([
      repo.claim(claimInput(WORKER_A, at(0))),
      repo.claim(claimInput(WORKER_B, at(0))),
    ]);

    // ⚠️ 这里的「只有一个赢」**不是跨进程互斥的证明**：`claim` 在写入之前没有任何 `await`，
    // 单进程事件循环里这两次调用天然串行。真互斥是 D5 那条 `FOR UPDATE SKIP LOCKED` 的事。
    // 本用例真正钉的是下面这些**与并发无关**的事实。
    const outcomes = [first, second];
    const winner = outcomes.findIndex((leases) => leases.length === 1);
    const loser = outcomes.findIndex((leases) => leases.length === 0);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(loser).toBeGreaterThanOrEqual(0);
    expect(winner).not.toBe(loser);
    expect(repo.claimedCount).toBe(1);
    expect(repo.activeLeaseCount).toBe(1);
    expect(repo.leaseWorkerOf(task.id)).toBe(winner === 0 ? WORKER_A : WORKER_B);

    // 拿到即已持有租约，而且状态迁移与铸造租约是**同一次**写入的结果。
    const claimed = requireTask(await repo.findById(task.id));
    expect(claimed.state).toBe('CLAIMED');
    expect(claimed.startedAt).toBe(at(0));
    expect(compareRevisions(claimed.revision, nextRevision(task.revision))).toBe(0);

    const lease = onlyLease(outcomes[winner] ?? [], '赢家');
    expect(lease.taskId).toBe(task.id);
    expect(lease.leaseUntil).toBe(at(LEASE_SECONDS));
    expect(lease.revision).toBe(claimed.revision);

    // 反空转对照：不是「一个任务只能被领一次」这种废话，而是**真的还有别的任务时照样发得出去**。
    repo.seed(makeTask({ id: uuidAt(2) }));
    const again = await repo.claim(claimInput(WORKER_B, at(1)));
    expect(again.length).toBe(1);
    expect(repo.claimedCount).toBe(2);
  });

  it('task-lease-cas: 领取顺序是 (next_run_at ?? created_at, id)，且被刻意排成与 id 序相反', async () => {
    const repo = new InMemoryTaskRepository();
    // id 序是 late(3) < middle(6) < early(9)；时间序是 early(0) < middle(30) < late(60)。
    // 两个序**故意相反**：如果实现按插入顺序或按 id 发，这条用例会红。
    const early = makeTask({ id: uuidAt(9), createdAt: EPOCH });
    const middle = makeTask({ id: uuidAt(6), createdAt: atSeconds(30) });
    const late = makeTask({ id: uuidAt(3), createdAt: EPOCH, nextRunAt: atSeconds(60) });
    // 未来的 next_run_at ⇒ 此刻不可领。它的 id 最小，所以「按 id 发」的实现会先把它发出去。
    const future = makeTask({ id: uuidAt(1), createdAt: EPOCH, nextRunAt: atSeconds(300) });
    for (const task of [future, late, middle, early]) repo.seed(task);

    const first = await repo.claim(claimInput(WORKER_A, at(120), 3));
    expect(first.map((lease) => lease.taskId)).toEqual([early.id, middle.id, late.id]);
    expect(first.some((lease) => lease.taskId === future.id)).toBe(false);

    // 时间到了它就变得可领，而且此刻队列里只剩它。
    const second = await repo.claim(claimInput(WORKER_A, at(400), 5));
    expect(second.map((lease) => lease.taskId)).toEqual([future.id]);
  });

  it('task-lease-cas: limit 是上界；非法 limit 返回空数组而不是抛', async () => {
    const repo = new InMemoryTaskRepository();
    for (const index of [1, 2, 3]) repo.seed(makeTask({ id: uuidAt(index) }));

    for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const leases = await repo.claim(claimInput(WORKER_A, at(0), limit));
      expect(leases, `limit=${String(limit)}`).toEqual([]);
    }
    expect(repo.claimedCount).toBe(0);
    expect(repo.activeLeaseCount).toBe(0);

    // 上界真的是上界：领走 2 个之后还剩 1 个可领。
    const two = await repo.claim(claimInput(WORKER_A, at(0), 2));
    expect(two.length).toBe(2);
    const rest = await repo.claim(claimInput(WORKER_B, at(0), 10));
    expect(rest.length).toBe(1);
    expect(repo.claimedCount).toBe(3);
    expect(await repo.claim(claimInput(WORKER_B, at(0), 10))).toEqual([]);
  });

  it('task-lease-cas: 续租延长 leaseUntil；令牌不符、已过期、已交还都返回 null', async () => {
    const repo = new InMemoryTaskRepository();
    const task = makeTask({ id: uuidAt(1) });
    repo.seed(task);
    const lease = onlyLease(await repo.claim(claimInput(WORKER_A, at(0))), '首次领取');

    const renewed = await repo.renewLease({ lease, now: at(30), leaseSeconds: LEASE_SECONDS });
    if (renewed === null) throw new Error('首次续租没成功，后面的边界断言全会假绿');
    expect(renewed.leaseUntil).toBe(at(90));
    // 续租不换令牌、不换持有人、不动 revision —— 它只是把到期时间往后推。
    expect(renewed.leaseToken).toBe(lease.leaseToken);
    expect(renewed.revision).toBe(lease.revision);
    expect(repo.leaseWorkerOf(task.id)).toBe(WORKER_A);

    // 令牌是唯一凭据：拿一个形状合法但值不对的令牌来续，必须被拒。
    const forged = brand<string, 'LeaseToken'>('lease_deadbeef_0000000000000000');
    expect(
      await repo.renewLease({
        lease: { ...lease, leaseToken: forged },
        now: at(31),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).toBeNull();
    expect((await repo.findById(task.id))?.revision).toBe(lease.revision);

    // 边界：`isLeaseExpired` 用 `<=`，所以 `leaseUntil` **当刻**就算过期。这一秒归谁决定了
    // 「续租」和「抢占」哪个先赢，必须钉死。两条断言的**顺序**也是钉死的一部分：先验当刻被拒，
    // 再验前一刻通过 —— 反过来的话第一次成功续租就把到期时间推走了，第二条变成空转。
    // 而「当刻被拒」同时证明了上面那次伪造令牌的续租**没有**把存进去的到期时间偷偷延长。
    expect(
      await repo.renewLease({
        lease: renewed,
        now: expiredAt(renewed),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).toBeNull();
    expect(
      await repo.renewLease({
        lease: renewed,
        now: beforeExpiry(renewed.leaseUntil),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).not.toBeNull();

    // 未知任务、以及交还之后再续，都是 null（租约行已经没了）。
    expect(
      await repo.renewLease({
        lease: { ...lease, taskId: brand<string, 'TaskId'>(uuidAt(77)) },
        now: at(1),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).toBeNull();
    await repo.releaseLease({ lease, now: at(1) });
    expect(await repo.renewLease({ lease, now: at(1), leaseSeconds: LEASE_SECONDS })).toBeNull();
    expect(repo.activeLeaseCount).toBe(0);
  });

  it('task-lease-cas: 接管孤儿租约换令牌但**不换状态** —— 这是不重复计费的那条不变量', async () => {
    const repo = new InMemoryTaskRepository();
    const task = makeTask({ id: uuidAt(1) });
    repo.seed(task);
    const stale = onlyLease(await repo.claim(claimInput(WORKER_A, at(0))), '首次领取');
    const running = await driveToRunning(repo, task.id);
    expect(running.state).toBe('RUNNING');

    // 还没过期时接管不了：那是抢占，不是接管。
    expect(
      await repo.reacquireLease({
        taskId: task.id,
        workerId: WORKER_B,
        now: at(10),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).toBeNull();
    expect(repo.reacquisitionCount).toBe(0);
    expect(repo.leaseWorkerOf(task.id)).toBe(WORKER_A);

    const taken = await repo.reacquireLease({
      taskId: task.id,
      workerId: WORKER_B,
      now: expiredAt(stale),
      leaseSeconds: LEASE_SECONDS,
    });
    if (taken === null) throw new Error('过期租约没被接管，后面的断言全会假绿');
    expect(repo.reacquisitionCount).toBe(1);
    expect(repo.leaseWorkerOf(task.id)).toBe(WORKER_B);
    expect(taken.leaseToken).not.toBe(stale.leaseToken);

    // 状态**没变**，revision 也**没变**：接管只换 infra 侧的持有人，不推进聚合。
    // 推进器在 `RUNNING` 崩掉时 QCA Session 还活着，退回 `QUEUED` 重来一遍就是重复计费。
    const after = requireTask(await repo.findById(task.id));
    expect(after.state).toBe('RUNNING');
    expect(after.revision).toBe(running.revision);
    expect(repo.activeLeaseCount).toBe(1);

    // 端口注释里那句话在这里变成可观测的：旧 worker 以为自己还持有它，续租拿到 null，
    // 而**不是**把别人的租约又延长一段。
    expect(
      await repo.renewLease({ lease: stale, now: at(61), leaseSeconds: LEASE_SECONDS }),
    ).toBeNull();
    expect((await repo.findById(task.id))?.revision).toBe(running.revision);
    // 反空转对照：新持有人的续租是好使的，所以上面那个 null 不是「续租整体坏了」。
    expect(
      await repo.renewLease({ lease: taken, now: at(61), leaseSeconds: LEASE_SECONDS }),
    ).not.toBeNull();

    // 不可接管的三类：QUEUED（那是 claim 的活儿）、终态、未知任务。
    const queued = makeTask({ id: uuidAt(2) });
    repo.seed(queued);
    expect(
      await repo.reacquireLease({
        taskId: queued.id,
        workerId: WORKER_B,
        now: at(70),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).toBeNull();
    const done = terminalTask({ id: uuidAt(3) });
    repo.seed(done);
    expect(
      await repo.reacquireLease({
        taskId: done.id,
        workerId: WORKER_B,
        now: at(70),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).toBeNull();
    expect(
      await repo.reacquireLease({
        taskId: brand<string, 'TaskId'>(uuidAt(77)),
        workerId: WORKER_B,
        now: at(70),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).toBeNull();
    expect(repo.reacquisitionCount).toBe(1);
  });

  it('task-lease-cas: 租约过期回退**仅限 CLAIMED**；SESSION_CREATING 之后过期不回退', async () => {
    const repo = new InMemoryTaskRepository();
    const task = makeTask({ id: uuidAt(1) });
    repo.seed(task);
    const lease = onlyLease(await repo.claim(claimInput(WORKER_A, at(0))), '首次领取');

    // 没过期不回退。
    expect(
      await repo.requeueOnLeaseExpiry({ taskId: task.id, now: beforeExpiry(lease.leaseUntil) }),
    ).toBe(false);
    expect(requireTask(await repo.findById(task.id)).state).toBe('CLAIMED');

    // 过期了才回退，而且租约行一起摘掉。
    expect(await repo.requeueOnLeaseExpiry({ taskId: task.id, now: expiredAt(lease) })).toBe(true);
    const requeued = requireTask(await repo.findById(task.id));
    expect(requeued.state).toBe('QUEUED');
    expect(compareRevisions(requeued.revision, nextRevision(lease.revision))).toBe(0);
    expect(repo.activeLeaseCount).toBe(0);
    expect(repo.leaseWorkerOf(task.id)).toBeNull();
    // 回退之后旧令牌连「交还」都做不到（那是空操作），也续不了。
    await repo.releaseLease({ lease, now: at(61) });
    expect(repo.releasedLeases).toEqual([]);
    expect(await repo.renewLease({ lease, now: at(61), leaseSeconds: LEASE_SECONDS })).toBeNull();

    // 回退过后可被别的 worker 重新领走 —— 这条边存在的意义就是「还没有外部副作用，重来安全」。
    const reclaimed = await repo.claim(claimInput(WORKER_B, at(62)));
    expect(reclaimed.length).toBe(1);
    expect(repo.leaseWorkerOf(task.id)).toBe(WORKER_B);

    // `SESSION_CREATING` 及之后**没有**这条回退边：Session 可能已经建了，退回 QUEUED 会让
    // 下一个实例重新调用 provider，那是 §6.2 划出的三种重试语义之外非法的第四种。
    const driven = makeTask({ id: uuidAt(2) });
    repo.seed(driven);
    const creating = onlyLease(await repo.claim(claimInput(WORKER_A, at(100))), '第二个任务');
    const moved = transitionTask(
      requireTask(await repo.findById(driven.id)),
      'SESSION_CREATING',
      at(101),
      'REVISION_CONFLICT',
    );
    expect(await repo.save({ task: moved, expectedRevision: creating.revision })).not.toBeNull();
    expect(await repo.requeueOnLeaseExpiry({ taskId: driven.id, now: at(500) })).toBe(false);
    expect(requireTask(await repo.findById(driven.id)).state).toBe('SESSION_CREATING');
    // 它过期之后走的是接管，不是回退。
    expect(
      await repo.reacquireLease({
        taskId: driven.id,
        workerId: WORKER_B,
        now: at(500),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).not.toBeNull();

    // QUEUED（压根没有租约行）与未知任务都是 false。用一个从没被领过的任务来测前者：
    // 上面那个 `task.id` 此刻已经被 WORKER_B 重新领走、租约也早过了，拿它测会**真的**回退成功。
    const idle = makeTask({ id: uuidAt(4) });
    repo.seed(idle);
    expect(await repo.requeueOnLeaseExpiry({ taskId: idle.id, now: at(500) })).toBe(false);
    expect(requireTask(await repo.findById(idle.id)).state).toBe('QUEUED');
    expect(
      await repo.requeueOnLeaseExpiry({
        taskId: brand<string, 'TaskId'>(uuidAt(77)),
        now: at(500),
      }),
    ).toBe(false);
  });

  it('task-lease-cas: 三个 CAS 方法在版本不匹配时**返回 null 而不是抛**，插入路径同样受 CAS 守卫', async () => {
    const repo = new InMemoryTaskRepository();
    const task = makeTask({ id: uuidAt(1) });
    repo.seed(task);
    const lease = onlyLease(await repo.claim(claimInput(WORKER_A, at(0))), '首次领取');
    const current = requireTask(await repo.findById(task.id));
    const stale = revisionAt(0);

    // 「不抛」这件事必须被**真的**断言，而不是靠「没看见异常」：用 allSettled 检查每一次都是
    // fulfilled。一个把它们改成抛的实现，下面这三行会红。
    const bumped = transitionTask(current, 'SESSION_CREATING', at(1), 'REVISION_CONFLICT');
    const settled = await Promise.allSettled([
      repo.save({ task: bumped, expectedRevision: stale }),
      repo.appendEvent({
        event: event(task.id, nextTaskEventSequence(null), at(1)),
        expectedRevision: stale,
      }),
      repo.scheduleNextRun({ taskId: task.id, nextRunAt: at(900), expectedRevision: stale }),
    ]);
    expect(settled.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(
      settled.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : null)),
    ).toEqual([null, null, null]);
    expect(repo.casMissCount).toBe(3);

    // 一次都没写进去：状态、事件、next_run_at 全是原样。
    const untouched = requireTask(await repo.findById(task.id));
    expect(untouched.state).toBe('CLAIMED');
    expect(untouched.revision).toBe(current.revision);
    expect(untouched.nextRunAt).toBeNull();
    expect(repo.eventsOf(task.id)).toEqual([]);

    // 正确版本号才写得进去，而且租约行上的 revision 跟着任务走。
    const saved = await repo.save({ task: bumped, expectedRevision: current.revision });
    expect(saved).not.toBeNull();
    expect(saved?.revision).toBe(bumped.revision);
    expect(compareRevisions(bumped.revision, nextRevision(current.revision))).toBe(0);
    const renewed = await repo.renewLease({ lease, now: at(2), leaseSeconds: LEASE_SECONDS });
    expect(renewed?.revision).toBe(bumped.revision);

    // 插入也走 CAS：任务不存在时 `expectedRevision` 就是调用方声称的初始版本，
    // 「忘了带版本号」没有一条静默成功的路。
    const fresh = makeTask({ id: uuidAt(4) });
    expect(await repo.save({ task: fresh, expectedRevision: revisionAt(5) })).toBeNull();
    expect(await repo.findById(fresh.id)).toBeNull();
    expect(await repo.save({ task: fresh, expectedRevision: revisionAt(0) })).not.toBeNull();
    expect(requireTask(await repo.findById(fresh.id)).id).toBe(fresh.id);
    expect(repo.casMissCount).toBe(4);

    // 未知任务上的 appendEvent / scheduleNextRun 是 null（不是 DomainError，也不是异常）。
    const ghost = brand<string, 'TaskId'>(uuidAt(77));
    expect(
      await repo.appendEvent({ event: event(ghost, 1n, at(3)), expectedRevision: revisionAt(0) }),
    ).toBeNull();
    expect(
      await repo.scheduleNextRun({
        taskId: ghost,
        nextRunAt: at(900),
        expectedRevision: revisionAt(0),
      }),
    ).toBeNull();
    expect(repo.casMissCount).toBe(4);
  });

  it('task-lease-cas: 事件序列违规抛的是 domain 的 DomainError，端口刻意不翻译它', async () => {
    const repo = new InMemoryTaskRepository();
    const task = makeTask({ id: uuidAt(1) });
    repo.seed(task);
    const current = requireTask(await repo.findById(task.id));

    const first = event(task.id, nextTaskEventSequence(null), at(1));
    const appended = await repo.appendEvent({ event: first, expectedRevision: current.revision });
    if (appended === null) throw new Error('第一条事件没写进去，后面的断言全会假绿');
    expect(compareRevisions(appended.revision, nextRevision(current.revision))).toBe(0);
    expect(repo.eventsOf(task.id).map((item) => item.sequence)).toEqual([1n]);

    // 重复的 sequence：判据在 domain（`assertEventFollows`），所以抛出来的是 `DomainError`。
    // 端口**不翻译**它 —— 业务规则失败与「版本冲突」不是一回事，翻译掉就把两种 409 混成一种。
    const duplicate = event(task.id, first.sequence, at(2));
    const repeat = await rejectedError(
      repo.appendEvent({ event: duplicate, expectedRevision: appended.revision }),
    );
    expect(repeat).toBeInstanceOf(DomainError);
    expect(isInfraError(repeat)).toBe(false);
    expect((repeat as DomainError).code).toBe('REQUEST_INVALID');
    expect((repeat as DomainError).valueObject).toBe('TaskEvent.sequence');
    // 违规的那条**没有**被追加，revision 也没有被推进，而且这不算一次 CAS 失败。
    expect(repo.eventsOf(task.id).map((item) => item.sequence)).toEqual([1n]);
    expect(requireTask(await repo.findById(task.id)).revision).toBe(appended.revision);
    expect(repo.casMissCount).toBe(0);

    // `assertEventFollows` 的另一半判据（`TaskEvent.taskId` 不符）经这个端口**够不着**：
    // 事件表是按 `event.taskId` 取出来的，取出来的 `previous` 与写进来的 `event` 天然同 id。
    // 那一半是 domain 自己测试的活儿，这里不去伪造它。端口这一侧真正够得着的是「任务不存在」：
    // 它返回 `null`，**不是** `DomainError`，也不是异常。
    const ghost = brand<string, 'TaskId'>(uuidAt(77));
    expect(
      await repo.appendEvent({ event: event(ghost, 1n, at(3)), expectedRevision: revisionAt(0) }),
    ).toBeNull();
    expect(repo.casMissCount).toBe(0);

    // 反空转对照：严格递增的序列写得好好的，所以上面那个红不是「appendEvent 整体坏了」。
    const second = event(task.id, nextTaskEventSequence(first), at(4));
    expect(
      await repo.appendEvent({ event: second, expectedRevision: appended.revision }),
    ).not.toBeNull();
    expect(repo.eventsOf(task.id).map((item) => item.sequence)).toEqual([1n, 2n]);
    expect(repo.casMissCount).toBe(0);
  });

  it('task-lease-cas: 非法租约时长在铸造与续租两处都拒绝，且拒绝时一条都没写进去', async () => {
    // `LEASE_TTL_OUT_OF_RANGE` 是本单元自己的码，**不是** grant 层那个 `GRANT_TTL_OUT_OF_RANGE`：
    // 同一个「时间算不出来」在两层对外说的不是一句话，混用会让 400 的归因指错地方。
    expect(INFRA_ERROR_CODES).toContain('LEASE_TTL_OUT_OF_RANGE');
    expect(INFRA_ERROR_CODES).toContain('GRANT_TTL_OUT_OF_RANGE');

    // 下界是**正整数**，而不仅仅是「算得出合法 ISO 串」：`shiftTimestamp` 只拒绝 NaN 与非整数，
    // 它管不了符号，而 `leaseSeconds: 0` 会铸出一份**当场就已过期**的租约 —— 那一刻
    // `canReacquireLease` 立刻为真，别人马上就能接管，同一任务被两个推进器驱动。
    // ⚠️ 这条下界是本单在 `packages/infra` 侧加的决定（`reference-backends.ts` 的
    // `leaseUntilOf`），domain 的判据里没有它。已在交付评论里点名请架构师确认，
    // 并要求 D5 的真实实现带同一条守卫。
    const repo = new InMemoryTaskRepository();
    const task = makeTask({ id: uuidAt(1) });
    repo.seed(task);

    for (const leaseSeconds of [0, -1, 1.5, Number.NaN]) {
      const failure = await rejectedCode(repo.claim(claimInput(WORKER_A, at(0), 1, leaseSeconds)));
      expect(failure, `leaseSeconds=${String(leaseSeconds)}`).toBe<InfraErrorCode>(
        'LEASE_TTL_OUT_OF_RANGE',
      );
    }
    // 拒绝时**什么都没写**：任务还是 QUEUED、没有租约、领取计数没动，序号也没被吃掉，
    // 而且换个合法时长照样领得到。
    expect(requireTask(await repo.findById(task.id)).state).toBe('QUEUED');
    expect(repo.activeLeaseCount).toBe(0);
    expect(repo.claimedCount).toBe(0);

    const lease = onlyLease(await repo.claim(claimInput(WORKER_A, at(0))), '合法时长的领取');
    expect(lease.leaseUntil).toBe(at(LEASE_SECONDS));
    expect(lease.leaseToken.slice(6, 14)).toBe('00000001');
    for (const leaseSeconds of [0, -1, 1.5, Number.NaN]) {
      const failure = await rejectedCode(repo.renewLease({ lease, now: at(1), leaseSeconds }));
      expect(failure, `renew leaseSeconds=${String(leaseSeconds)}`).toBe<InfraErrorCode>(
        'LEASE_TTL_OUT_OF_RANGE',
      );
    }
    // 续租失败没有偷偷把存进去的到期时间改掉：`at(59)` 还续得动（说明存的仍是 `at(60)`），
    // 而**当刻** `at(60)` 就续不动了。直接断言局部对象的 `leaseUntil` 是空转的 —— 它不会变。
    expect(await repo.renewLease({ lease, now: at(59), leaseSeconds: 30 })).not.toBeNull();
    expect(
      await repo.reacquireLease({
        taskId: task.id,
        workerId: WORKER_B,
        now: at(1),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).toBeNull();
  });

  it('task-lease-cas: 交还租约 —— 令牌不符的 release 是空操作，重复 release 不重复记账', async () => {
    const repo = new InMemoryTaskRepository();
    const task = makeTask({ id: uuidAt(1) });
    repo.seed(task);
    const lease = onlyLease(await repo.claim(claimInput(WORKER_A, at(0))), '首次领取');

    // 令牌不符 ⇒ 什么都不做。一个把它当成无条件删除的实现会在这里红。
    await repo.releaseLease({
      lease: {
        ...lease,
        leaseToken: brand<string, 'LeaseToken'>('lease_00000000_ffffffffffffffff'),
      },
      now: at(5),
    });
    expect(repo.activeLeaseCount).toBe(1);
    expect(repo.releasedLeases).toEqual([]);
    expect(repo.leaseWorkerOf(task.id)).toBe(WORKER_A);

    await repo.releaseLease({ lease, now: at(7) });
    expect(repo.activeLeaseCount).toBe(0);
    expect(repo.releasedLeases).toEqual([{ taskId: task.id, at: at(7) }]);
    // 幂等：再交还一次不产生第二条记录（那是用量账本上的重复计数）。
    await repo.releaseLease({ lease, now: at(8) });
    expect(repo.releasedLeases).toHaveLength(1);

    // 交还**不迁移状态**：任务还是 CLAIMED，所以它不会被 `claim` 再领走（`canClaimTask` 只认
    // QUEUED），但可以被接管（租约行没了 ⇒ `isLeaseExpired(null, now)` 为真）。这条区分很重要：
    // 优雅退出的 worker 交还租约后，下一个实例是**接着推进**，不是从头再来。
    expect(requireTask(await repo.findById(task.id)).state).toBe('CLAIMED');
    expect(await repo.claim(claimInput(WORKER_B, at(9)))).toEqual([]);
    expect(
      await repo.reacquireLease({
        taskId: task.id,
        workerId: WORKER_B,
        now: at(9),
        leaseSeconds: LEASE_SECONDS,
      }),
    ).not.toBeNull();
    expect(repo.leaseWorkerOf(task.id)).toBe(WORKER_B);
  });

  it('task-lease-cas: scheduleNextRun 写入 next_run_at 并推进 revision，写完之后到点才可领', async () => {
    const repo = new InMemoryTaskRepository();
    // `RETRY_WAIT` 是 `next_run_at` 的唯一来处：它靠这个字段等待，没有推进器持有它。
    const task = makeTask({ id: uuidAt(1), state: 'RETRY_WAIT', nextRunAt: atSeconds(300) });
    repo.seed(task);

    expect(
      await repo.scheduleNextRun({
        taskId: task.id,
        nextRunAt: at(900),
        expectedRevision: revisionAt(7),
      }),
    ).toBeNull();
    expect(repo.casMissCount).toBe(1);
    expect(requireTask(await repo.findById(task.id)).nextRunAt).toBe(at(300));

    const scheduled = await repo.scheduleNextRun({
      taskId: task.id,
      nextRunAt: at(900),
      expectedRevision: task.revision,
    });
    if (scheduled === null) throw new Error('scheduleNextRun 没写进去，后面的闸门断言全会假绿');
    expect(scheduled.nextRunAt).toBe(at(900));
    expect(compareRevisions(scheduled.revision, nextRevision(task.revision))).toBe(0);

    // 回到 QUEUED 之后，`next_run_at` 就是它唯一的闸门：到点之前领不到，到点之后立刻领得到。
    const queued = transitionTask(
      requireTask(await repo.findById(task.id)),
      'QUEUED',
      at(301),
      'REVISION_CONFLICT',
    );
    expect(queued.nextRunAt).toBe(at(900));
    expect(await repo.save({ task: queued, expectedRevision: scheduled.revision })).not.toBeNull();
    expect(await repo.claim(claimInput(WORKER_A, at(899)))).toEqual([]);
    const lease = onlyLease(await repo.claim(claimInput(WORKER_A, at(900))), '到点后的领取');
    expect(lease.taskId).toBe(task.id);
  });

  it('task-lease-cas: 租约令牌不可猜 —— 带随机后缀，且不从任务／worker／时间派生', async () => {
    const repo = new InMemoryTaskRepository();
    const tokens: LeaseToken[] = [];
    for (const index of [1, 2, 3]) {
      const task = makeTask({ id: uuidAt(index) });
      repo.seed(task);
      tokens.push(
        onlyLease(await repo.claim(claimInput(WORKER_A, at(index))), `第 ${index} 个任务`)
          .leaseToken,
      );
    }
    for (const token of tokens) {
      // 这个字符类本身就是「不可猜」的一半：它装不下一个 UUID（需要 `-`），也装不下一个
      // worker id（需要 hex 之外的字母）。所以不去写 `not.toContain(uuid)` 这种断言 ——
      // 随机后缀里碰巧出现某个 hex 子串是有可能的，那种断言是一条迟早会自己红的定时炸弹。
      expect(token).toMatch(LEASE_TOKEN_PATTERN);
    }
    // 序号部分单调递增（可读、可排障），随机后缀部分**互不相同**（不可猜）。
    const serials = tokens.map((token) => token.slice(6, 14));
    const suffixes = tokens.map((token) => token.slice(15));
    expect([...serials].sort()).toEqual(serials);
    expect(new Set(serials).size).toBe(3);
    expect(new Set(suffixes).size).toBe(3);

    // 反空转对照：另一份**同样播种、同样驱动**的仓库铸出的令牌完全不同。
    // 一个把后缀写成常量（或从 taskId 派生）的实现，这一条会红，而上面那些形状断言全绿。
    const twin = new InMemoryTaskRepository();
    for (const index of [1, 2, 3]) twin.seed(makeTask({ id: uuidAt(index) }));
    const twinTokens: LeaseToken[] = [];
    for (const index of [1, 2, 3]) {
      twinTokens.push(
        onlyLease(await twin.claim(claimInput(WORKER_A, at(index))), `孪生第 ${index} 个`)
          .leaseToken,
      );
    }
    expect(twinTokens.map((token) => token.slice(6, 14))).toEqual(serials);
    expect(twinTokens.every((token) => !tokens.includes(token))).toBe(true);
    expect(new Set(twinTokens.map((token) => token.slice(15))).size).toBe(3);

    // 接管会换令牌（同一条不变量在接管用例里也被断言过，这里只补形状与「不等于旧令牌」）。
    const stale = tokens[0];
    if (stale === undefined) throw new Error('第一份租约没铸出来');
    const taken = await repo.reacquireLease({
      taskId: brand<string, 'TaskId'>(uuidAt(1)),
      workerId: WORKER_B,
      now: at(900),
      leaseSeconds: LEASE_SECONDS,
    });
    if (taken === null) throw new Error('过期租约没被接管，令牌断言会变成空转');
    expect(taken.leaseToken).toMatch(LEASE_TOKEN_PATTERN);
    expect(taken.leaseToken).not.toBe(stale);
    expect(tokens).not.toContain(taken.leaseToken);
  });
});

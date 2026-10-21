/**
 * §7.1(4)「`TaskPumpStore.acquire` 的排序判据」的自证。
 *
 * 这份测试钉的是**顺序**，不是实现：F1 只交付端口，`acquire` 的真身在
 * `packages/infra`（`PostgresTaskPumpStore`），它的行为由
 * `packages/infra/test/task-pump-store-transaction.test.ts` 在真 Postgres 上黑盒验证。
 * 两边共用同一份 `TASK_ACQUIRE_DECISION_ORDER` 常量，所以顺序不可能只在一处漂移。
 *
 * ## 为什么要有"反面对照"
 *
 * 本单最容易被写成一句 `expect(order).toEqual([...])` 就交差 —— 那种断言在顺序**本来就
 * 是这么写的**时候永远绿，证明不了任何事。真正需要证明的是：这个顺序**与 domain 既有的
 * `decideTaskPump` 在一处相反、在另一处相同**，而且两处都是有意为之（§3.5 步骤 1 的
 * 裁定 vs. 该函数头部写明的"409 永远走不到头"缺陷）。所以每一项顺序断言都配一条
 * **直接调用 `decideTaskPump` 的正/反对照**：先证明 domain 在同样事实上给出什么，
 * 再证明本端口的顺序与它一致或不一致。少了对照，"顺序正确"就只是把常量抄了两遍。
 */

import {
  CANCELLABLE_TASK_STATES,
  decideTaskPump,
  isTerminalState,
  parseRevision,
  parseTaskState,
  parseTimestamp,
  TASK_PUMP_OUTCOMES,
  TASK_TRANSITIONS,
  type TaskPumpFacts,
} from '@littleq/domain';
import { describe, expect, it } from 'vitest';
import {
  TASK_ACQUIRE_DECISION_MODES,
  TASK_ACQUIRE_DECISION_ORDER,
  TASK_PUMP_MODES,
  type TaskAcquireDecision,
  type TaskAcquireInput,
  type TaskAcquireResult,
  type TaskPumpStore,
} from '../src/index.js';

const NOW = parseTimestamp('2026-10-21T04:05:06.000Z');

function facts(overrides: Partial<TaskPumpFacts>): TaskPumpFacts {
  return {
    state: parseTaskState('RUNNING'),
    revision: parseRevision('7'),
    ifMatchRevision: parseRevision('7'),
    nextRunAt: null,
    drivenByAnother: false,
    now: NOW,
    ...overrides,
  };
}

const indexOf = (decision: TaskAcquireDecision): number =>
  TASK_ACQUIRE_DECISION_ORDER.indexOf(decision);

describe('TASK_ACQUIRE_DECISION_ORDER', () => {
  it('逐字钉住 13 项判据与其次序', () => {
    expect(TASK_ACQUIRE_DECISION_ORDER).toEqual([
      'LIVE_LEASE_COALESCE',
      'TERMINAL_NO_OP',
      'CANCELLING_NO_OP',
      'IF_MATCH_REVISION',
      'BACKOFF_WAITING',
      'RETRY_WAIT_DUE',
      'CLAIM_QUEUED',
      'QUEUED_NOT_DUE_WAITING',
      'REACQUIRE_LEASE',
      'CANCEL_FROM_QUEUED',
      'CANCEL_FROM_RUNNING',
      'RESUME_CANCELLING',
      'REJECT_NOT_CANCELLABLE',
    ]);
  });

  it('没有重复项（重复会让"短路顺序"失去意义）', () => {
    expect(new Set(TASK_ACQUIRE_DECISION_ORDER).size).toBe(TASK_ACQUIRE_DECISION_ORDER.length);
  });

  it('§3.5 步骤 1：活租约合并排在 If-Match 之前', () => {
    expect(indexOf('LIVE_LEASE_COALESCE')).toBeLessThan(indexOf('IF_MATCH_REVISION'));
  });

  it('反面对照：domain 的 decideTaskPump 在同样事实上给出的是 CONFLICT，不是 COALESCE', () => {
    // 这正是 §3.5 步骤 1 要推翻的那一条：别人正在推进 + 客户端 revision 已旧。
    const decision = decideTaskPump(
      facts({ drivenByAnother: true, ifMatchRevision: parseRevision('3') }),
    );
    expect(decision).toEqual({ kind: 'CONFLICT' });
    // 对照必须能翻红：若哪天 domain 改成 coalesce 优先，这条断言会失败，
    // 提醒"本端口存在的理由"已经消失，而不是继续静静地钉着一个空差异。
    expect(decision).not.toEqual({ kind: 'COALESCE' });
  });

  it('正面对照：无活租约时 domain 与本端口同样把 If-Match 失配判成 CONFLICT', () => {
    expect(decideTaskPump(facts({ ifMatchRevision: parseRevision('3') }))).toEqual({
      kind: 'CONFLICT',
    });
    expect(indexOf('IF_MATCH_REVISION')).toBeLessThan(indexOf('CLAIM_QUEUED'));
    expect(indexOf('IF_MATCH_REVISION')).toBeLessThan(indexOf('REACQUIRE_LEASE'));
  });

  it('终态排在 If-Match 之前（此处与 domain 一致，不跟着步骤 1 一起前移）', () => {
    expect(indexOf('TERMINAL_NO_OP')).toBeLessThan(indexOf('IF_MATCH_REVISION'));
  });

  it('正面对照：domain 对"终态 + 旧 revision"给出 NO_OP_TERMINAL 而非 409', () => {
    for (const state of TASK_TRANSITIONS.terminal) {
      expect(isTerminalState(TASK_TRANSITIONS, parseTaskState(state))).toBe(true);
      expect(
        decideTaskPump(
          facts({ state: parseTaskState(state), ifMatchRevision: parseRevision('3') }),
        ),
      ).toEqual({ kind: 'NO_OP', outcome: 'NO_OP_TERMINAL' });
    }
  });

  it('CANCELLING 排在 If-Match 之前，且 PUMP 模式下是 no-op', () => {
    expect(indexOf('CANCELLING_NO_OP')).toBeLessThan(indexOf('IF_MATCH_REVISION'));
    expect(
      decideTaskPump(
        facts({ state: parseTaskState('CANCELLING'), ifMatchRevision: parseRevision('3') }),
      ),
    ).toEqual({ kind: 'NO_OP', outcome: 'NO_OP_CANCELLING' });
  });

  it('退避与"到期写 QUEUED"分成相邻两项，且都在领取之前', () => {
    expect(indexOf('BACKOFF_WAITING')).toBeLessThan(indexOf('RETRY_WAIT_DUE'));
    expect(indexOf('RETRY_WAIT_DUE')).toBeLessThan(indexOf('CLAIM_QUEUED'));
    expect(
      decideTaskPump(
        facts({
          state: parseTaskState('RETRY_WAIT'),
          nextRunAt: parseTimestamp('2026-10-21T04:05:07.000Z'),
        }),
      ),
    ).toEqual({ kind: 'NO_OP', outcome: 'NO_OP_WAITING' });
  });

  it('QUEUED 但 nextRunAt 未到时 domain 会给出 ADVANCE —— 这正是必须补 QUEUED_NOT_DUE_WAITING 的原因', () => {
    // 判据完备性对照：decideTaskPump 的退避分支只认 RETRY_WAIT，
    // 所以一个"未到点的 QUEUED"会被判成 ADVANCE，而 canClaimTask 对它返回 false。
    // 没有 QUEUED_NOT_DUE_WAITING 这一项，acquire 就无处可去。
    expect(
      decideTaskPump(
        facts({
          state: parseTaskState('QUEUED'),
          nextRunAt: parseTimestamp('2026-10-21T04:05:07.000Z'),
        }),
      ),
    ).toEqual({ kind: 'ADVANCE' });
    expect(indexOf('QUEUED_NOT_DUE_WAITING')).toBeGreaterThan(indexOf('CLAIM_QUEUED'));
    expect(indexOf('QUEUED_NOT_DUE_WAITING')).toBeLessThan(indexOf('REACQUIRE_LEASE'));
  });

  it('接管过期租约排在所有 PUMP 领取项之后、CANCEL 项之前', () => {
    expect(indexOf('REACQUIRE_LEASE')).toBeLessThan(indexOf('CANCEL_FROM_QUEUED'));
    expect(indexOf('REACQUIRE_LEASE')).toBeGreaterThan(indexOf('CLAIM_QUEUED'));
  });
});

describe('TASK_ACQUIRE_DECISION_MODES', () => {
  it('与判据表一一对应，不多不少', () => {
    expect(Object.keys(TASK_ACQUIRE_DECISION_MODES).sort()).toEqual(
      [...TASK_ACQUIRE_DECISION_ORDER].sort(),
    );
  });

  it('合并判据只属于 PUMP：CANCEL 若先合并，取消请求会被静默丢掉', () => {
    expect(TASK_ACQUIRE_DECISION_MODES.LIVE_LEASE_COALESCE).toBe('PUMP');
    // cancelRequestedAt 从未落库 ⇒ 持有活租约的一方永远看不到取消意图。
    // §3.5 步骤 3 给 CANCEL 的裁定是"定向租约"（接管），不是合并。
    expect(TASK_ACQUIRE_DECISION_MODES.CANCEL_FROM_RUNNING).toBe('CANCEL');
    expect(TASK_ACQUIRE_DECISION_MODES.RESUME_CANCELLING).toBe('CANCEL');
  });

  it('终态与 If-Match 两种模式都要过', () => {
    expect(TASK_ACQUIRE_DECISION_MODES.TERMINAL_NO_OP).toBe('BOTH');
    expect(TASK_ACQUIRE_DECISION_MODES.IF_MATCH_REVISION).toBe('BOTH');
  });

  it('四项 CANCEL 专属判据恰好覆盖 domain 的可取消状态集', () => {
    const cancelOnly = TASK_ACQUIRE_DECISION_ORDER.filter(
      (decision) => TASK_ACQUIRE_DECISION_MODES[decision] === 'CANCEL',
    );
    expect(cancelOnly).toEqual([
      'CANCEL_FROM_QUEUED',
      'CANCEL_FROM_RUNNING',
      'RESUME_CANCELLING',
      'REJECT_NOT_CANCELLABLE',
    ]);
    // 前三项分别对应 domain 派生出的三个可取消状态；第四项是"其余一律拒绝"。
    expect(CANCELLABLE_TASK_STATES).toEqual(['QUEUED', 'RUNNING', 'CANCELLING']);
  });
});

describe('TASK_PUMP_MODES', () => {
  it('恰好两个模式，且 CANCEL 不是"先领取再取消"', () => {
    expect(TASK_PUMP_MODES).toEqual(['PUMP', 'CANCEL']);
    // §3.5 步骤 3 逐字：「不先领取成不可取消的 CLAIMED」。
    // CLAIMED 不在可取消状态集里，所以"先 claim 再 cancel"必然得到 TASK_NOT_CANCELLABLE。
    expect(CANCELLABLE_TASK_STATES).not.toContain('CLAIMED');
  });
});

describe('端口形状', () => {
  it('acquire 的入参不含 prompt、凭据或明文口令字段', () => {
    // ZLQ-153 §5：原 prompt / provider ID / 回执不进 Task DTO。
    // 这里钉的是**端口入参**的键集：装配端口只拿 id、revision、worker、时长、模式、时刻。
    const input: TaskAcquireInput = {
      taskId: '0198f2a4-6c7e-7a41-9c1b-2f6d0a4b8c11' as TaskAcquireInput['taskId'],
      expectedRevision: parseRevision('1'),
      workerId: 'worker-test',
      leaseSeconds: 30,
      mode: 'PUMP',
      now: NOW,
    };
    expect(Object.keys(input).sort()).toEqual([
      'expectedRevision',
      'leaseSeconds',
      'mode',
      'now',
      'taskId',
      'workerId',
    ]);
  });

  it('LEASED 结果带 task_private 完整记录与租约，RESULT 结果不带租约', () => {
    // 类型层面的断言：若哪天 RESULT 也长出 lease，这条会编译失败。
    const leased: Extract<TaskAcquireResult, { readonly kind: 'LEASED' }> = {
      kind: 'LEASED',
      task: {} as never,
      privateState: {} as never,
      lease: {} as never,
    };
    const result: Extract<TaskAcquireResult, { readonly kind: 'RESULT' }> = {
      kind: 'RESULT',
      outcome: 'NO_OP_TERMINAL',
      task: {} as never,
    };
    expect(Object.keys(leased).sort()).toEqual(['kind', 'lease', 'privateState', 'task']);
    expect(Object.keys(result).sort()).toEqual(['kind', 'outcome', 'task']);
    expect('lease' in result).toBe(false);
  });

  it('outcome 只可能是既有 5 个 TaskPumpOutcome，没有新增第 6 个', () => {
    expect(TASK_PUMP_OUTCOMES).toEqual([
      'ADVANCED',
      'COALESCED_IN_FLIGHT',
      'NO_OP_WAITING',
      'NO_OP_CANCELLING',
      'NO_OP_TERMINAL',
    ]);
    // 端口方法集恰好两个：acquire 与 recordReceipt（§3.5 尾段的失租约补证通道）。
    const methodNames = Object.keys({
      acquire: null,
      recordReceipt: null,
    } satisfies Record<keyof TaskPumpStore, null>).sort();
    expect(methodNames).toEqual(['acquire', 'recordReceipt']);
  });
});

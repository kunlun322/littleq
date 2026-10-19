import { describe, expect, it } from 'vitest';

import {
  PUMPABLE_TASK_STATES,
  TASK_PUMP_OUTCOMES,
  TASK_STATES,
  TASK_TRANSITIONS,
  decideTaskPump,
  formatRevision,
  isPumpableTaskState,
  isRetryBackoffActive,
  isTerminalState,
  nextRevision,
  parseTimestamp,
  taskPumpOutcomeOf,
  taskPumpRejectionOf,
  type TaskPumpFacts,
  type Timestamp,
} from '../src/index.js';
import { EPOCH, atSeconds, thrownCode } from './support.js';

/**
 * `:pump` 的推进判定（`policies/task-pump.ts`）。
 *
 * 这一组测试要钉住的是三件在实现里最容易悄悄退化的事：
 *
 * 1. **终态 no-op**：已到终态的任务再被 pump，必须是 200 的 `NO_OP_TERMINAL`，而且
 *    **先于** `If-Match` 比较。顺序反了就会回 409，而 409 的语义是「重新 GET 再试」——
 *    对一个永远不会再变的任务，那条路走不到头，前端会无限轮询。
 * 2. **并发单飞**：同一 revision 上已有人在推进时，第二个 pump 合并（`COALESCE`）而
 *    不是再起一个切片 —— 后者是重复计费，不是并发控制。
 * 3. **只有一个拒绝原因**：pump 只可能因 `REVISION_CONFLICT` 失败。错误码目录冻结在
 *    42 个，「不可 pump」的三种情形全是 200 no-op，本来就不需要新码。
 */

const NOW: Timestamp = parseTimestamp(EPOCH);

function at(seconds: number): Timestamp {
  return parseTimestamp(atSeconds(seconds));
}

/** 一个可推进、`If-Match` 对得上、无人持有租约的基准事实集。 */
function facts(overrides: Partial<TaskPumpFacts> = {}): TaskPumpFacts {
  return {
    state: 'RUNNING',
    revision: formatRevision(7),
    ifMatchRevision: formatRevision(7),
    nextRunAt: null,
    drivenByAnother: false,
    now: NOW,
    ...overrides,
  };
}

/** 迁移表认定的终态。派生集合，另有一条测试把它的字面量成员钉死。 */
const TERMINAL_STATES = TASK_STATES.filter((state) => isTerminalState(TASK_TRANSITIONS, state));

describe('pump-single-flight：终态 no-op', () => {
  it('pump-single-flight：终态清单是 5 个字面量，不是从判定函数反推出来的空集', () => {
    // 反空转对照：下面每条「终态 → NO_OP_TERMINAL」都遍历这个派生集合，若集合为空，
    // 那些断言会全部通过却什么都没测到。
    expect(TERMINAL_STATES).toEqual(['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'TIMED_OUT']);
  });

  it('pump-single-flight：每个终态再 pump 一次都是 NO_OP_TERMINAL，无副作用', () => {
    for (const state of TERMINAL_STATES) {
      const decision = decideTaskPump(facts({ state }));
      expect(decision, state).toEqual({ kind: 'NO_OP', outcome: 'NO_OP_TERMINAL' });
      expect(taskPumpOutcomeOf(decision), state).toBe('NO_OP_TERMINAL');
      expect(taskPumpRejectionOf(decision), state).toBeNull();
    }
  });

  it('pump-single-flight：终态判定先于 If-Match —— 陈旧 revision 不会把终态变成 409', () => {
    // 这是本组测试里最关键的一条。终态任务的客户端 revision 几乎必然是旧的（它来自
    // SSE 或上一次 GET），若先比 If-Match 就会回 CONFLICT，而 CONFLICT 要求客户端
    // 「重新 GET 再试」，对一个不会再变的任务那是一个死循环。
    for (const state of TERMINAL_STATES) {
      const decision = decideTaskPump(
        facts({ state, ifMatchRevision: formatRevision(1), revision: formatRevision(9) }),
      );
      expect(decision, state).toEqual({ kind: 'NO_OP', outcome: 'NO_OP_TERMINAL' });
      expect(taskPumpRejectionOf(decision), state).toBeNull();
    }
  });

  it('pump-single-flight：终态判定也先于租约 —— 已有人在推进的终态任务仍然是 TERMINAL', () => {
    for (const state of TERMINAL_STATES) {
      expect(decideTaskPump(facts({ state, drivenByAnother: true })), state).toEqual({
        kind: 'NO_OP',
        outcome: 'NO_OP_TERMINAL',
      });
    }
  });

  it('pump-single-flight：CANCELLING 不是终态，但同样不可 pump，报 NO_OP_CANCELLING', () => {
    expect(isTerminalState(TASK_TRANSITIONS, 'CANCELLING')).toBe(false);
    const decision = decideTaskPump(facts({ state: 'CANCELLING' }));
    expect(decision).toEqual({ kind: 'NO_OP', outcome: 'NO_OP_CANCELLING' });
    expect(taskPumpOutcomeOf(decision)).toBe('NO_OP_CANCELLING');
  });

  it('pump-single-flight：CANCELLING 也先于 If-Match，理由与终态相同', () => {
    expect(
      decideTaskPump(
        facts({
          state: 'CANCELLING',
          ifMatchRevision: formatRevision(1),
          revision: formatRevision(9),
        }),
      ),
    ).toEqual({ kind: 'NO_OP', outcome: 'NO_OP_CANCELLING' });
  });
});

describe('pump-single-flight：并发合并', () => {
  it('pump-single-flight：无人推进且 revision 对得上时判定 ADVANCE', () => {
    const decision = decideTaskPump(facts());
    expect(decision).toEqual({ kind: 'ADVANCE' });
    expect(taskPumpOutcomeOf(decision)).toBe('ADVANCED');
    expect(taskPumpRejectionOf(decision)).toBeNull();
  });

  it('pump-single-flight：别的执行者持有未过期租约时合并成 COALESCE，不起第二个切片', () => {
    const decision = decideTaskPump(facts({ drivenByAnother: true }));
    expect(decision).toEqual({ kind: 'COALESCE' });
    // 200 而不是 409：合并是「你发的这一次和别人发的那一次是同一次」，不是冲突。
    // 客户端因此可以把轮询频率调高而不必担心把服务端打成一串冲突。
    expect(taskPumpOutcomeOf(decision)).toBe('COALESCED_IN_FLIGHT');
    expect(taskPumpRejectionOf(decision)).toBeNull();
  });

  it('pump-single-flight：退避判定先于合并 —— 还没到重试时间时，回答等待比回答合并更有用', () => {
    expect(
      decideTaskPump(facts({ state: 'RETRY_WAIT', drivenByAnother: true, nextRunAt: at(600) })),
    ).toEqual({ kind: 'NO_OP', outcome: 'NO_OP_WAITING' });
  });

  it('pump-single-flight：判定是纯函数 —— 同一组事实重复判定给出同一结果，入参不被改写', () => {
    // 单飞不能靠进程内状态实现（附录 A §6.5 规则 5：进程内 semaphore 或 Map 不是
    // 事实源）。可判定的证据是：连续两次调用结果相同，且 facts 对象逐字段未变。
    const input = facts({ drivenByAnother: true });
    const before = JSON.stringify(input);
    const first = decideTaskPump(input);
    const second = decideTaskPump(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('pump-single-flight：每个可 pump 状态在基准事实下都判定 ADVANCE', () => {
    for (const state of PUMPABLE_TASK_STATES) {
      expect(decideTaskPump(facts({ state })), state).toEqual({ kind: 'ADVANCE' });
      expect(isPumpableTaskState(state), state).toBe(true);
    }
  });

  it('pump-single-flight：可 pump 状态是 9 个字面量（15 个状态减去 5 个终态再减去 CANCELLING）', () => {
    // 反空转对照：上一条遍历这个集合，集合若为空则那条断言什么都没测。
    expect(PUMPABLE_TASK_STATES).toEqual([
      'QUEUED',
      'CLAIMED',
      'SESSION_CREATING',
      'RUNNING',
      'COLLECTING',
      'REPAIRING',
      'VALIDATING',
      'COMMITTING',
      'RETRY_WAIT',
    ]);
    expect(TASK_STATES).toHaveLength(PUMPABLE_TASK_STATES.length + TERMINAL_STATES.length + 1);
    expect(isPumpableTaskState('CANCELLING')).toBe(false);
    for (const state of TERMINAL_STATES) expect(isPumpableTaskState(state), state).toBe(false);
  });
});

describe('pump-single-flight：If-Match 与退避', () => {
  it('pump-single-flight：If-Match 落后于当前 revision 时判定 CONFLICT，且只用 REVISION_CONFLICT', () => {
    const decision = decideTaskPump(
      facts({ ifMatchRevision: formatRevision(6), revision: formatRevision(7) }),
    );
    expect(decision).toEqual({ kind: 'CONFLICT' });
    // CONFLICT 以 409 结束，没有结果体，所以 outcome 为 null。
    expect(taskPumpOutcomeOf(decision)).toBeNull();
    expect(taskPumpRejectionOf(decision)).toBe('REVISION_CONFLICT');
  });

  it('pump-single-flight：If-Match 超前同样判定 CONFLICT —— 比较的是相等，不是先后', () => {
    expect(decideTaskPump(facts({ ifMatchRevision: nextRevision(formatRevision(7)) }))).toEqual({
      kind: 'CONFLICT',
    });
  });

  it('pump-single-flight：RETRY_WAIT 且退避未到时是 NO_OP_WAITING，退避已过则可以推进', () => {
    expect(decideTaskPump(facts({ state: 'RETRY_WAIT', nextRunAt: at(600) }))).toEqual({
      kind: 'NO_OP',
      outcome: 'NO_OP_WAITING',
    });
    expect(decideTaskPump(facts({ state: 'RETRY_WAIT', nextRunAt: at(-600) }))).toEqual({
      kind: 'ADVANCE',
    });
  });

  it('pump-single-flight：nextRunAt 为 null 视为不等待，缺失字段不解释成无限期阻塞', () => {
    expect(isRetryBackoffActive(null, NOW)).toBe(false);
    expect(decideTaskPump(facts({ state: 'RETRY_WAIT', nextRunAt: null }))).toEqual({
      kind: 'ADVANCE',
    });
  });

  it('pump-single-flight：退避边界与 isLeaseExpired 一致 —— now 恰好等于 nextRunAt 即视为已到', () => {
    expect(isRetryBackoffActive(at(600), at(600))).toBe(false);
    expect(isRetryBackoffActive(at(600), at(599))).toBe(true);
  });

  it('pump-single-flight：非 RETRY_WAIT 状态带着未到的 nextRunAt 也能推进（退避只属于重试等待）', () => {
    expect(decideTaskPump(facts({ state: 'RUNNING', nextRunAt: at(600) }))).toEqual({
      kind: 'ADVANCE',
    });
  });

  it('pump-single-flight：非法状态与非法 revision 一律 REQUEST_INVALID，不静默当成可推进', () => {
    expect(thrownCode(() => decideTaskPump(facts({ state: 'NOT_A_STATE' as never })))).toBe(
      'REQUEST_INVALID',
    );
    expect(thrownCode(() => decideTaskPump(facts({ ifMatchRevision: 'rev-7' as never })))).toBe(
      'REQUEST_INVALID',
    );
  });
});

describe('pump-single-flight：判定到 wire 的映射', () => {
  it('pump-single-flight：五种 outcome 各自都有一种判定能产生它，没有死枚举成员', () => {
    const produced = new Set([
      taskPumpOutcomeOf({ kind: 'ADVANCE' }),
      taskPumpOutcomeOf({ kind: 'COALESCE' }),
      taskPumpOutcomeOf({ kind: 'NO_OP', outcome: 'NO_OP_WAITING' }),
      taskPumpOutcomeOf({ kind: 'NO_OP', outcome: 'NO_OP_CANCELLING' }),
      taskPumpOutcomeOf({ kind: 'NO_OP', outcome: 'NO_OP_TERMINAL' }),
      taskPumpOutcomeOf({ kind: 'CONFLICT' }),
    ]);
    // CONFLICT 产生 null，所以集合里是 5 个 outcome + null。
    expect(produced.has(null)).toBe(true);
    expect([...produced].filter((item) => item !== null).sort()).toEqual(
      [...TASK_PUMP_OUTCOMES].sort(),
    );
  });

  it('pump-single-flight：只有 CONFLICT 会被拒绝，其余四种判定一律放行', () => {
    const decisions = [
      { kind: 'ADVANCE' },
      { kind: 'COALESCE' },
      { kind: 'NO_OP', outcome: 'NO_OP_WAITING' },
      { kind: 'NO_OP', outcome: 'NO_OP_CANCELLING' },
      { kind: 'NO_OP', outcome: 'NO_OP_TERMINAL' },
    ] as const;
    for (const decision of decisions) {
      expect(taskPumpRejectionOf(decision), decision.kind).toBeNull();
    }
    expect(taskPumpRejectionOf({ kind: 'CONFLICT' })).toBe('REVISION_CONFLICT');
  });

  it('pump-single-flight：三种 no-op 互不相同 —— 前端能据此分别停止轮询、等待与放弃', () => {
    const waiting = decideTaskPump(facts({ state: 'RETRY_WAIT', nextRunAt: at(600) }));
    const cancelling = decideTaskPump(facts({ state: 'CANCELLING' }));
    const terminal = decideTaskPump(facts({ state: 'SUCCEEDED' }));
    const outcomes = [
      taskPumpOutcomeOf(waiting),
      taskPumpOutcomeOf(cancelling),
      taskPumpOutcomeOf(terminal),
    ];
    expect(new Set(outcomes).size).toBe(3);
    expect(outcomes).toEqual(['NO_OP_WAITING', 'NO_OP_CANCELLING', 'NO_OP_TERMINAL']);
  });
});

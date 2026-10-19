import { describe, expect, it } from 'vitest';

import {
  ASSIGNMENT_INITIAL_STATUS,
  ASSIGNMENT_TRANSITIONS,
  CANCELLABLE_TASK_STATES,
  COURSE_INITIAL_STATUS,
  COURSE_TRANSITIONS,
  GROUP_INITIAL_STATUS,
  GROUP_TRANSITIONS,
  LEARNING_PROGRESS_INITIAL_STATE,
  LEARNING_PROGRESS_TRANSITIONS,
  PROJECT_INITIAL_STATUS,
  PROJECT_TRANSITIONS,
  PUBLICATION_INITIAL_STATUS,
  PUBLICATION_TRANSITIONS,
  RESERVATION_INITIAL_STATE,
  RESERVATION_TRANSITIONS,
  SUBMISSION_INITIAL_STATUS,
  SUBMISSION_TRANSITIONS,
  TASK_INITIAL_STATE,
  TASK_STATES,
  TASK_TRANSITIONS,
  TRANSITION_TABLES,
  USER_INITIAL_STATUS,
  USER_TRANSITIONS,
  WORK_INITIAL_STATUS,
  WORK_TRANSITIONS,
  assertCancellableTaskState,
  assertNotTerminal,
  assertTransition,
  canTransition,
  isCancellableTaskState,
  isTerminalState,
  outgoingStates,
  reachableStates,
  summarizeTransitionTable,
  transitionTable,
  type TransitionTable,
} from '../src/index.js';
import { thrownCode, thrownDomainError } from './support.js';

/**
 * 状态机层。
 *
 * 这里的断言分两类，两类的失效方式完全不同，因此分开写：
 *
 * 1. **结构不变量**（对全部表统一遍历）：终态无出边、无死胡同、无不可达状态、初态
 *    属于状态集。这类断言不写死任何张数或条数 —— 新增一张表或一条边时它自动覆盖，
 *    而写死数字的断言只会在新表接入时红一次然后被机械更新（附录 A G6 禁止把清单
 *    相关的中间值当验收常量）。
 * 2. **具体设计事实**：架构 §6.1 的 17 条 AiTask 边逐条在场、附录 A §6.2 补齐的
 *    三条差异逐条钉住、每个状态的终态归属。这些是**契约**，必须写死。
 */

/**
 * 遍历用的宽化视图。
 *
 * `TRANSITION_TABLES` 是异构元组（每张表的 `State` 参数不同），直接把它喂给
 * `outgoingStates<State>` 一类泛型函数会让 TypeScript 从联合类型里推不出一致的
 * `State`。宽化到 `TransitionTable<string>` 是安全的：`TransitionTable` 的每个字段
 * 都是 `readonly` 且只出现在协变位置。
 */
type AnyTable = TransitionTable<string>;

type AnyEntry = { readonly name: string; readonly table: AnyTable; readonly initial: string };

const TABLES: readonly AnyEntry[] = TRANSITION_TABLES;

/** 架构 §6.1 逐条列出的 AiTask 边（17 条，顺序即原文顺序）。 */
const ARCH_6_1_TASK_EDGES = [
  ['QUEUED', 'CLAIMED'],
  ['CLAIMED', 'SESSION_CREATING'],
  ['SESSION_CREATING', 'RUNNING'],
  ['RUNNING', 'COLLECTING'],
  ['COLLECTING', 'VALIDATING'],
  ['VALIDATING', 'COMMITTING'],
  ['COMMITTING', 'SUCCEEDED'],
  ['QUEUED', 'CANCELLED'],
  ['CLAIMED', 'QUEUED'],
  ['SESSION_CREATING', 'RETRY_WAIT'],
  ['RUNNING', 'RETRY_WAIT'],
  ['COLLECTING', 'FAILED'],
  ['VALIDATING', 'BLOCKED'],
  ['RETRY_WAIT', 'QUEUED'],
  ['RUNNING', 'CANCELLING'],
  ['CANCELLING', 'CANCELLED'],
  ['RUNNING', 'TIMED_OUT'],
] as const;

/** 附录 A §6.2 与本实现共同补齐的边（原文缺边，已在交付评论中声明）。 */
const SUPPLEMENTED_TASK_EDGES = [
  ['COLLECTING', 'REPAIRING'],
  ['REPAIRING', 'COLLECTING'],
  ['RETRY_WAIT', 'FAILED'],
] as const;

/** 表的全部边，规范化成升序字符串数组。派生集合，语义无序。 */
function edgeList<State extends string>(table: TransitionTable<State>): string[] {
  return table.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
}

function expectedEdges(edges: readonly (readonly [string, string])[]): string[] {
  return edges.map(([from, to]) => `${from}->${to}`).sort();
}

describe('状态机：全部表的共同结构不变量', () => {
  it('表名唯一，且与内部 name 字段一致', () => {
    const names = TABLES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of TABLES) {
      expect(entry.table.name).toBe(entry.name);
    }
  });

  it('按名字升序排列（遍历结果与宿主、与声明顺序都无关）', () => {
    const names = TABLES.map((entry) => entry.name);
    expect([...names].sort()).toEqual(names);
  });

  it.each(TABLES.map((entry) => [entry.name, entry] as const))(
    '%s：初态在状态集内，终态是状态集的子集，状态不重复',
    (_name, entry) => {
      expect(entry.table.states).toContain(entry.initial);
      for (const terminal of entry.table.terminal) {
        expect(entry.table.states).toContain(terminal);
      }
      // 状态集不得有重复：`transitionTable` 在加载期已经拦过一次，这里再断言一次，
      // 是为了让「有人绕过 transitionTable 直接手写对象字面量」也红。
      expect(new Set(entry.table.states).size).toBe(entry.table.states.length);
    },
  );

  it.each(TABLES.map((entry) => [entry.name, entry] as const))(
    '%s：终态没有出边，且不存在死胡同',
    (_name, entry) => {
      for (const terminal of entry.table.terminal) {
        expect(outgoingStates(entry.table, terminal)).toEqual([]);
      }
      // 死胡同 = 既无出边又不是终态。非空就意味着某个状态进去之后再也出不来，
      // 而它又没被声明为终态 —— 那是设计漏洞，不是数据。
      expect(summarizeTransitionTable(entry.table, entry.initial).deadEndStates).toEqual([]);
    },
  );

  it.each(TABLES.map((entry) => [entry.name, entry] as const))(
    '%s：从初态可达每一个状态',
    (_name, entry) => {
      expect(summarizeTransitionTable(entry.table, entry.initial).unreachableFromInitial).toEqual(
        [],
      );
      const reachable = new Set<string>([
        entry.initial,
        ...reachableStates(entry.table, entry.initial),
      ]);
      expect(reachable.size).toBe(entry.table.states.length);
    },
  );

  it.each(TABLES.map((entry) => [entry.name, entry] as const))(
    '%s：边不重复，且没有自环',
    (_name, entry) => {
      const keys = entry.table.edges.map((edge) => `${edge.from}\u0000${edge.to}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const edge of entry.table.edges) {
        expect(edge.from).not.toBe(edge.to);
      }
    },
  );

  it('派生集合一律排序返回（同一张表在任何宿主上逐字节相同）', () => {
    for (const entry of TABLES) {
      for (const state of entry.table.states) {
        const outgoing = outgoingStates(entry.table, state);
        expect([...outgoing].sort()).toEqual(outgoing);
        const reachable = reachableStates(entry.table, state);
        expect([...reachable].sort()).toEqual(reachable);
      }
    }
  });

  it('结构摘要的计数字段与表本身一致', () => {
    for (const entry of TABLES) {
      const summary = summarizeTransitionTable(entry.table, entry.initial);
      expect(summary.name).toBe(entry.name);
      expect(summary.stateCount).toBe(entry.table.states.length);
      expect(summary.edgeCount).toBe(entry.table.edges.length);
      expect(summary.terminalStates).toEqual([...entry.table.terminal].sort());
    }
  });
});

describe('状态机：assertTransition 携带业务错误码', () => {
  it('合法迁移不抛', () => {
    expect(() =>
      assertTransition(TASK_TRANSITIONS, 'QUEUED', 'CLAIMED', 'TASK_NOT_RETRYABLE'),
    ).not.toThrow();
  });

  it('非法迁移抛出调用方指定的码，valueObject 是表名', () => {
    // 没有通用的 STATE_TRANSITION_INVALID：§5.2 冻结的 42 个码里每个非法迁移都有
    // 业务名字，所以错误码是**必填参数**。用 Task 的取消码验证这条设计。
    const error = thrownDomainError(() =>
      assertTransition(TASK_TRANSITIONS, 'COMMITTING', 'CANCELLED', 'TASK_NOT_CANCELLABLE'),
    );
    expect(error.code).toBe('TASK_NOT_CANCELLABLE');
    expect(error.valueObject).toBe('TaskState');
  });

  it('assertNotTerminal 在终态上抛指定码，在非终态上不抛', () => {
    expect(
      thrownCode(() =>
        assertNotTerminal(PUBLICATION_TRANSITIONS, 'REVOKED', 'VERSION_NOT_PUBLISHABLE'),
      ),
    ).toBe('VERSION_NOT_PUBLISHABLE');
    expect(() =>
      assertNotTerminal(PUBLICATION_TRANSITIONS, 'LIVE', 'VERSION_NOT_PUBLISHABLE'),
    ).not.toThrow();
  });

  it('canTransition 对未知状态返回 false 而不是抛错', () => {
    expect(canTransition(TASK_TRANSITIONS, 'SUCCEEDED', 'QUEUED')).toBe(false);
    expect(canTransition(TASK_TRANSITIONS, 'QUEUED', 'QUEUED')).toBe(false);
  });
});

describe('transition-table-self-check：transitionTable 在加载期拒绝写错的表', () => {
  // 这六条是「表本身是 bug」的负向对照：它们必须抛**普通 Error**（我们代码写错了），
  // 而不是 DomainError（外部输入不合法）。混淆两者会让一个内部 bug 变成 400 返回给学生。
  const badTables: readonly (readonly [string, AnyTable])[] = [
    ['空状态集', { name: 'Empty', states: [], terminal: [], edges: [] }],
    ['重复状态', { name: 'Dup', states: ['A', 'A'], terminal: [], edges: [] }],
    ['未知终态', { name: 'BadTerminal', states: ['A'], terminal: ['B'], edges: [] }],
    [
      '未知边端点',
      { name: 'BadEdge', states: ['A'], terminal: [], edges: [{ from: 'A', to: 'Z' }] },
    ],
    ['自环', { name: 'Self', states: ['A'], terminal: [], edges: [{ from: 'A', to: 'A' }] }],
    [
      '终态有出边',
      { name: 'TerminalOut', states: ['A', 'B'], terminal: ['B'], edges: [{ from: 'B', to: 'A' }] },
    ],
    [
      '重复边',
      {
        name: 'DupEdge',
        states: ['A', 'B'],
        terminal: [],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'B' },
        ],
      },
    ],
  ];

  it.each(badTables.map(([label, table]) => [label, table] as const))(
    '%s 被拒绝',
    (_label, table) => {
      expect(() => transitionTable(table)).toThrow(Error);
    },
  );

  it('形状正确的表原样返回（同一个对象引用，不复制）', () => {
    const table: AnyTable = {
      name: 'Ok',
      states: ['A', 'B'],
      terminal: ['B'],
      edges: [{ from: 'A', to: 'B' }],
    };
    expect(transitionTable(table)).toBe(table);
  });
});

describe('AiTask 状态机：架构 §6.1 的 17 条边逐条在场', () => {
  it.each(ARCH_6_1_TASK_EDGES.map(([from, to]) => [`${from} -> ${to}`, from, to] as const))(
    '%s',
    (_label, from, to) => {
      expect(canTransition(TASK_TRANSITIONS, from, to)).toBe(true);
    },
  );

  it('除补齐的三条外没有别的边（边集恰为 17 + 3）', () => {
    expect(edgeList(TASK_TRANSITIONS)).toEqual(
      expectedEdges([...ARCH_6_1_TASK_EDGES, ...SUPPLEMENTED_TASK_EDGES]),
    );
  });

  it('附录 A §6.2 补齐的一次产物修复：COLLECTING → REPAIRING → COLLECTING', () => {
    expect(canTransition(TASK_TRANSITIONS, 'COLLECTING', 'REPAIRING')).toBe(true);
    expect(canTransition(TASK_TRANSITIONS, 'REPAIRING', 'COLLECTING')).toBe(true);
    // REPAIRING 不是终态，也不新增 Session：它只能回到 COLLECTING。
    expect(outgoingStates(TASK_TRANSITIONS, 'REPAIRING')).toEqual(['COLLECTING']);
  });

  it('补齐的两条失败边让预算耗尽后仍有合法终态', () => {
    // 保留 COLLECTING → FAILED：修复预算耗尽后第二次 collect 仍不完整时必须能落终态。
    expect(canTransition(TASK_TRANSITIONS, 'COLLECTING', 'FAILED')).toBe(true);
    // 新增 RETRY_WAIT → FAILED：§7.4 给自动重试设了上界，原图 RETRY_WAIT 只有 → QUEUED，
    // 预算耗尽后没有任何合法终态可去。
    expect(canTransition(TASK_TRANSITIONS, 'RETRY_WAIT', 'FAILED')).toBe(true);
    expect(outgoingStates(TASK_TRANSITIONS, 'RETRY_WAIT')).toEqual(['FAILED', 'QUEUED']);
  });

  it('COMMITTING 只有 → SUCCEEDED（架构 §6.1 的可重入承诺：只重试不失败）', () => {
    expect(outgoingStates(TASK_TRANSITIONS, 'COMMITTING')).toEqual(['SUCCEEDED']);
    expect(canTransition(TASK_TRANSITIONS, 'COMMITTING', 'FAILED')).toBe(false);
    expect(canTransition(TASK_TRANSITIONS, 'COMMITTING', 'TIMED_OUT')).toBe(false);
  });

  it('15 个状态、5 个终态，与值对象层枚举同源', () => {
    expect(TASK_TRANSITIONS.states).toEqual(TASK_STATES);
    expect(TASK_TRANSITIONS.terminal).toEqual([
      'SUCCEEDED',
      'FAILED',
      'BLOCKED',
      'CANCELLED',
      'TIMED_OUT',
    ]);
    for (const terminal of TASK_TRANSITIONS.terminal) {
      expect(isTerminalState(TASK_TRANSITIONS, terminal)).toBe(true);
    }
    expect(isTerminalState(TASK_TRANSITIONS, 'QUEUED')).toBe(false);
    expect(TASK_INITIAL_STATE).toBe('QUEUED');
  });

  it('从 QUEUED 可以走到每一个终态', () => {
    const reachable = reachableStates(TASK_TRANSITIONS, TASK_INITIAL_STATE);
    for (const terminal of TASK_TRANSITIONS.terminal) {
      expect(reachable).toContain(terminal);
    }
  });
});

describe('AiTask 状态机：可取消状态由迁移表派生', () => {
  it('是 QUEUED、RUNNING、CANCELLING（按 TASK_STATES 的声明顺序）', () => {
    expect(CANCELLABLE_TASK_STATES).toEqual(['QUEUED', 'RUNNING', 'CANCELLING']);
  });

  it('派生定义成立：存在通往 CANCELLING 或 CANCELLED 的边', () => {
    for (const state of TASK_STATES) {
      const expected =
        canTransition(TASK_TRANSITIONS, state, 'CANCELLING') ||
        canTransition(TASK_TRANSITIONS, state, 'CANCELLED');
      expect(isCancellableTaskState(state), state).toBe(expected);
    }
  });

  it('CANCELLING 仍在集合里：重复的取消请求是幂等 202，不是 409', () => {
    // 回 `TASK_NOT_CANCELLABLE`（文案 task.cancel.notAllowed）等于告诉学生「这个任务
    // 不能取消」，而它恰恰正在被取消。
    expect(isCancellableTaskState('CANCELLING')).toBe(true);
    expect(() => assertCancellableTaskState('CANCELLING')).not.toThrow();
  });

  it('CLAIMED / SESSION_CREATING 不接受取消（会留下没人回收的 QCA Session）', () => {
    for (const state of [
      'CLAIMED',
      'SESSION_CREATING',
      'COLLECTING',
      'REPAIRING',
      'VALIDATING',
      'COMMITTING',
    ] as const) {
      expect(isCancellableTaskState(state), state).toBe(false);
      expect(thrownCode(() => assertCancellableTaskState(state))).toBe('TASK_NOT_CANCELLABLE');
    }
  });

  it('终态当然也不可取消', () => {
    for (const terminal of TASK_TRANSITIONS.terminal) {
      expect(isCancellableTaskState(terminal)).toBe(false);
    }
  });

  it('可取消状态上断言不抛', () => {
    expect(() => assertCancellableTaskState('RUNNING')).not.toThrow();
    expect(() => assertCancellableTaskState('QUEUED')).not.toThrow();
  });
});

describe('Account 状态机：ACTIVE ↔ LOCKED，DELETED 不可逆', () => {
  it('边集', () => {
    expect(edgeList(USER_TRANSITIONS)).toEqual(
      expectedEdges([
        ['ACTIVE', 'LOCKED'],
        ['LOCKED', 'ACTIVE'],
        ['ACTIVE', 'DELETED'],
        ['LOCKED', 'DELETED'],
      ]),
    );
  });

  it('DELETED 是唯一终态，没有任何出边', () => {
    expect(USER_TRANSITIONS.terminal).toEqual(['DELETED']);
    expect(outgoingStates(USER_TRANSITIONS, 'DELETED')).toEqual([]);
    expect(canTransition(USER_TRANSITIONS, 'DELETED', 'ACTIVE')).toBe(false);
    expect(canTransition(USER_TRANSITIONS, 'DELETED', 'LOCKED')).toBe(false);
  });

  it('初态 ACTIVE', () => {
    expect(USER_INITIAL_STATUS).toBe('ACTIVE');
  });
});

describe('Group 状态机：归档可逆，因此没有终态', () => {
  it('ACTIVE ↔ ARCHIVED 双向', () => {
    expect(canTransition(GROUP_TRANSITIONS, 'ACTIVE', 'ARCHIVED')).toBe(true);
    expect(canTransition(GROUP_TRANSITIONS, 'ARCHIVED', 'ACTIVE')).toBe(true);
  });

  it('terminal 为空 —— 附录 A §6.2「允许 Owner ARCHIVED → ACTIVE」', () => {
    expect(GROUP_TRANSITIONS.terminal).toEqual([]);
    expect(isTerminalState(GROUP_TRANSITIONS, 'ARCHIVED')).toBe(false);
    expect(GROUP_INITIAL_STATUS).toBe('ACTIVE');
  });
});

describe('Project 状态机：删除与恢复都可逆，30 天窗口在实体侧', () => {
  it('DELETED 可以回到 ACTIVE 或 ARCHIVED（并集画进边里，具体目标由 deletedFromStatus 决定）', () => {
    expect(outgoingStates(PROJECT_TRANSITIONS, 'DELETED')).toEqual(['ACTIVE', 'ARCHIVED']);
  });

  it('没有终态', () => {
    expect(PROJECT_TRANSITIONS.terminal).toEqual([]);
    expect(PROJECT_INITIAL_STATUS).toBe('ACTIVE');
  });

  it('ACTIVE 与 ARCHIVED 都可以直接删除', () => {
    expect(canTransition(PROJECT_TRANSITIONS, 'ACTIVE', 'DELETED')).toBe(true);
    expect(canTransition(PROJECT_TRANSITIONS, 'ARCHIVED', 'DELETED')).toBe(true);
  });
});

describe('Work / Publication 状态机', () => {
  it('Work：ACTIVE ↔ DELETED，无终态（可见性与删除状态相互独立）', () => {
    expect(edgeList(WORK_TRANSITIONS)).toEqual(
      expectedEdges([
        ['ACTIVE', 'DELETED'],
        ['DELETED', 'ACTIVE'],
      ]),
    );
    expect(WORK_TRANSITIONS.terminal).toEqual([]);
    expect(WORK_INITIAL_STATUS).toBe('ACTIVE');
  });

  it('Publication：PREPARING → LIVE/BLOCKED，LIVE → REVOKED', () => {
    expect(edgeList(PUBLICATION_TRANSITIONS)).toEqual(
      expectedEdges([
        ['PREPARING', 'LIVE'],
        ['PREPARING', 'BLOCKED'],
        ['LIVE', 'REVOKED'],
      ]),
    );
    expect(PUBLICATION_INITIAL_STATUS).toBe('PREPARING');
  });

  it('Publication：BLOCKED 与 REVOKED 都是终态（发布记录不可覆盖）', () => {
    expect([...PUBLICATION_TRANSITIONS.terminal].sort()).toEqual(['BLOCKED', 'REVOKED']);
    // 不存在 LIVE → BLOCKED 的「原地改状态」路径：重新发布是一条新的 publication。
    expect(canTransition(PUBLICATION_TRANSITIONS, 'LIVE', 'BLOCKED')).toBe(false);
    expect(canTransition(PUBLICATION_TRANSITIONS, 'REVOKED', 'LIVE')).toBe(false);
  });
});

describe('UsageReservation 状态机：三个终态都不可回退', () => {
  it('HELD → COMMITTED/RELEASED/EXPIRED', () => {
    expect(outgoingStates(RESERVATION_TRANSITIONS, 'HELD')).toEqual([
      'COMMITTED',
      'EXPIRED',
      'RELEASED',
    ]);
    expect(RESERVATION_INITIAL_STATE).toBe('HELD');
  });

  it('结算后不得再次结算', () => {
    for (const terminal of ['COMMITTED', 'RELEASED', 'EXPIRED'] as const) {
      expect(isTerminalState(RESERVATION_TRANSITIONS, terminal)).toBe(true);
      expect(outgoingStates(RESERVATION_TRANSITIONS, terminal)).toEqual([]);
    }
    expect(canTransition(RESERVATION_TRANSITIONS, 'COMMITTED', 'RELEASED')).toBe(false);
    expect(canTransition(RESERVATION_TRANSITIONS, 'RELEASED', 'COMMITTED')).toBe(false);
  });
});

describe('教学状态机', () => {
  it('Course：DRAFT → PUBLISHED → ARCHIVED，归档只读', () => {
    expect(edgeList(COURSE_TRANSITIONS)).toEqual(
      expectedEdges([
        ['DRAFT', 'PUBLISHED'],
        ['PUBLISHED', 'ARCHIVED'],
      ]),
    );
    expect(COURSE_TRANSITIONS.terminal).toEqual(['ARCHIVED']);
    expect(COURSE_INITIAL_STATUS).toBe('DRAFT');
    expect(canTransition(COURSE_TRANSITIONS, 'PUBLISHED', 'DRAFT')).toBe(false);
    expect(canTransition(COURSE_TRANSITIONS, 'ARCHIVED', 'PUBLISHED')).toBe(false);
  });

  it('Assignment：DRAFT → PUBLISHED → CLOSED → ARCHIVED，单向', () => {
    expect(edgeList(ASSIGNMENT_TRANSITIONS)).toEqual(
      expectedEdges([
        ['DRAFT', 'PUBLISHED'],
        ['PUBLISHED', 'CLOSED'],
        ['CLOSED', 'ARCHIVED'],
      ]),
    );
    expect(ASSIGNMENT_TRANSITIONS.terminal).toEqual(['ARCHIVED']);
    expect(ASSIGNMENT_INITIAL_STATUS).toBe('DRAFT');
    expect(canTransition(ASSIGNMENT_TRANSITIONS, 'CLOSED', 'PUBLISHED')).toBe(false);
  });

  it('Submission：两个终态，重交是新记录而不是回到 SUBMITTED', () => {
    expect(edgeList(SUBMISSION_TRANSITIONS)).toEqual(
      expectedEdges([
        ['SUBMITTED', 'GRADED'],
        ['SUBMITTED', 'REVISION_REQUESTED'],
      ]),
    );
    expect([...SUBMISSION_TRANSITIONS.terminal].sort()).toEqual(['GRADED', 'REVISION_REQUESTED']);
    expect(SUBMISSION_INITIAL_STATUS).toBe('SUBMITTED');
    expect(canTransition(SUBMISSION_TRANSITIONS, 'REVISION_REQUESTED', 'SUBMITTED')).toBe(false);
  });

  it('LearningProgress：REVISION_REQUIRED 可以再交一次（否则它是死胡同）', () => {
    expect(canTransition(LEARNING_PROGRESS_TRANSITIONS, 'REVISION_REQUIRED', 'SUBMITTED')).toBe(
      true,
    );
    expect(LEARNING_PROGRESS_TRANSITIONS.terminal).toEqual(['GRADED']);
    expect(LEARNING_PROGRESS_INITIAL_STATE).toBe('NOT_STARTED');
    expect(
      summarizeTransitionTable(LEARNING_PROGRESS_TRANSITIONS, 'NOT_STARTED').deadEndStates,
    ).toEqual([]);
  });

  it('逾期是独立 flag，不是 LearningProgress 的成员', () => {
    expect(LEARNING_PROGRESS_TRANSITIONS.states).toEqual([
      'NOT_STARTED',
      'IN_PROGRESS',
      'SUBMITTED',
      'GRADED',
      'REVISION_REQUIRED',
    ]);
  });
});

describe('状态机不承载宿主状态', () => {
  it('表内容里没有绝对路径、时间戳或本机标识', () => {
    // 表是纯数据，会被契约层拿去生成快照（附录 A §3.5：OpenAPI 输出不得含生成时间、
    // 绝对路径、随机顺序或机器相关字段）。这里把整个表序列化后扫一遍。
    const serialized = serializeTables();
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('C:\\');
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialized).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    // 同一进程内两次序列化逐字节相同（无 Map/Set 迭代顺序泄漏）。
    expect(serialized).toBe(serializeTables());
  });
});

function serializeTables(): string {
  return JSON.stringify(
    TABLES.map((entry) => ({
      name: entry.name,
      initial: entry.initial,
      states: entry.table.states,
      terminal: entry.table.terminal,
      edges: entry.table.edges,
    })),
  );
}

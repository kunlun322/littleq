import { DomainError } from '../errors/domain-error.js';
import type { ErrorCode } from '../errors/catalog.js';

/**
 * 状态机通用机制。
 *
 * 设计要点：**没有通用的 `STATE_TRANSITION_INVALID` 错误码**。ZLQ-153 §5.2 冻结的
 * 42 个错误码里，每个非法迁移都对应一个业务上有名字的码（`TASK_NOT_CANCELLABLE`、
 * `GROUP_ARCHIVED`、`VERSION_NOT_PUBLISHABLE`……），因此 `assertTransition` 把错误码
 * 作为**必填参数**，由调用方声明「这个用例认为非法迁移意味着什么」。这样做的代价
 * 是调用方要多写一个参数，收益是错误 envelope 永远携带业务语义，前端不需要再维护
 * 一张「通用码 → 具体原因」的映射表。
 *
 * 表本身是纯数据：`states` 的顺序**就是** OpenAPI `enum` 的顺序，因此归一化不得
 * 重排它（附录 A §4.1）；而 `outgoingStates` / `reachableStates` 返回的是派生集合，
 * 语义无序，所以这里显式排序，保证同一张表在任何宿主上得到逐字节相同的输出。
 */

export type TransitionEdge<State extends string> = {
  readonly from: State;
  readonly to: State;
};

export type TransitionTable<State extends string> = {
  /** 表名，同时用作 `DomainError.valueObject`，让错误可回溯到具体状态机。 */
  readonly name: string;
  /** 全部状态，声明顺序即对外 `enum` 顺序。 */
  readonly states: readonly State[];
  /** 终态：没有出边，且不可回退（附录 A §6.2）。 */
  readonly terminal: readonly State[];
  readonly edges: readonly TransitionEdge<State>[];
};

/**
 * 构造并自检一张迁移表。
 *
 * 自检在**模块加载期**发生，抛的是普通 `Error`（这是我们代码里的 bug），不是
 * `DomainError`（那是外部输入不合法）。宁可在 import 时就炸，也不要让一张写错的
 * 表在运行期悄悄放行一条非法迁移。
 */
export function transitionTable<State extends string>(
  table: TransitionTable<State>,
): TransitionTable<State> {
  const { name, states, terminal, edges } = table;
  if (states.length === 0) throw new Error(`empty state list: ${name}`);
  const known = new Set<string>(states);
  if (known.size !== states.length) throw new Error(`duplicate state in ${name}`);
  for (const state of terminal) {
    if (!known.has(state)) throw new Error(`unknown terminal state in ${name}: ${state}`);
  }
  const terminalSet = new Set<string>(terminal);
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!known.has(edge.from)) throw new Error(`unknown edge source in ${name}: ${edge.from}`);
    if (!known.has(edge.to)) throw new Error(`unknown edge target in ${name}: ${edge.to}`);
    if (edge.from === edge.to) throw new Error(`self transition in ${name}: ${edge.from}`);
    if (terminalSet.has(edge.from)) {
      throw new Error(`terminal state has outgoing edge in ${name}: ${edge.from}`);
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) throw new Error(`duplicate edge in ${name}: ${edge.from} -> ${edge.to}`);
    seen.add(key);
  }
  return table;
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function edgeSet<State extends string>(table: TransitionTable<State>): ReadonlySet<string> {
  return new Set(table.edges.map((edge) => edgeKey(edge.from, edge.to)));
}

export function canTransition<State extends string>(
  table: TransitionTable<State>,
  from: State,
  to: State,
): boolean {
  return edgeSet(table).has(edgeKey(from, to));
}

/**
 * 断言迁移合法。`code` 必填 —— 见文件头关于「没有通用非法迁移码」的说明。
 */
export function assertTransition<State extends string>(
  table: TransitionTable<State>,
  from: State,
  to: State,
  code: ErrorCode,
): void {
  if (!canTransition(table, from, to)) throw new DomainError(code, table.name);
}

/**
 * 终态不可回退：任何以终态为起点的迁移都非法，且 `transitionTable` 已经保证表里
 * 不存在这样的边，所以这个断言实际拦的是「调用方拿着终态还想继续推进」。
 */
export function isTerminalState<State extends string>(
  table: TransitionTable<State>,
  state: State,
): boolean {
  return table.terminal.includes(state);
}

export function assertNotTerminal<State extends string>(
  table: TransitionTable<State>,
  state: State,
  code: ErrorCode,
): void {
  if (isTerminalState(table, state)) throw new DomainError(code, table.name);
}

/** 出边目标，升序排列（派生集合，语义无序）。 */
export function outgoingStates<State extends string>(
  table: TransitionTable<State>,
  from: State,
): readonly State[] {
  return table.edges
    .filter((edge) => edge.from === from)
    .map((edge) => edge.to)
    .sort();
}

/**
 * 从 `from` 出发可达的全部状态（不含 `from` 自身，除非存在回环）。
 *
 * 用显式排序的工作队列而不是 `Set` 的迭代顺序，保证遍历顺序与表的书写顺序无关。
 */
export function reachableStates<State extends string>(
  table: TransitionTable<State>,
  from: State,
): readonly State[] {
  const adjacency = new Map<State, State[]>();
  for (const edge of table.edges) {
    const bucket = adjacency.get(edge.from);
    if (bucket === undefined) adjacency.set(edge.from, [edge.to]);
    else bucket.push(edge.to);
  }
  const visited = new Set<State>();
  const queue: State[] = [...(adjacency.get(from) ?? [])].sort();
  while (queue.length > 0) {
    const current = queue.shift() as State;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of [...(adjacency.get(current) ?? [])].sort()) {
      if (!visited.has(next)) queue.push(next);
    }
    queue.sort();
  }
  return [...visited].sort();
}

/**
 * 表的结构摘要，供契约层做「错误码无孤儿/漏项」一类的交叉校验与测试断言。
 * 全部字段都是派生的确定性值，不含时间戳或宿主信息。
 */
export type TransitionTableSummary<State extends string> = {
  readonly name: string;
  readonly stateCount: number;
  readonly edgeCount: number;
  readonly terminalStates: readonly State[];
  /** 没有任何出边、也不在 `terminal` 里的状态 —— 一旦非空就是设计漏洞。 */
  readonly deadEndStates: readonly State[];
  /** 没有任何入边、也不是唯一初态的状态。 */
  readonly unreachableFromInitial: readonly State[];
};

export function summarizeTransitionTable<State extends string>(
  table: TransitionTable<State>,
  initial: State,
): TransitionTableSummary<State> {
  const hasOutgoing = new Set(table.edges.map((edge) => edge.from));
  const hasIncoming = new Set(table.edges.map((edge) => edge.to));
  const reachable = new Set<string>([initial, ...reachableStates(table, initial)]);
  return {
    name: table.name,
    stateCount: table.states.length,
    edgeCount: table.edges.length,
    terminalStates: [...table.terminal].sort(),
    deadEndStates: table.states
      .filter((state) => !hasOutgoing.has(state) && !isTerminalState(table, state))
      .sort(),
    unreachableFromInitial: table.states
      .filter((state) => !hasIncoming.has(state) && state !== initial && !reachable.has(state))
      .sort(),
  };
}

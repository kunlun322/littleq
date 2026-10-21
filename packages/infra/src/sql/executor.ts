import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';

/**
 * 一次**执行语境**：要么自己开一个短事务，要么复用调用方已经开着的那个。
 *
 * ## 为什么每个 SQL 组件都要这一层
 *
 * ZLQ-216 §3.4 的六个边界里有四个是"单个短事务"，而 §3.5 明确要求事务内的句柄
 * 「全部绑定**同一个** `DatabaseTransaction`/连接，事务外不可获得」。同一份读写逻辑于是
 * 有两种合法语境：
 *
 * - **独立**：`ObjectStore.putImmutable` 核实 digest index、`TaskRepository.findById`
 *   这类调用发生在任何业务事务之外，自己开自己关；
 * - **绑定**：`:pump` 的一个短步里，digest 核实、`collection_cursor` 推进、task CAS、
 *   事件追加必须一起提交或一起消失。
 *
 * 如果没有这一层，两条路只能各写一遍 SQL —— 而两份实现漂移的方向恰好是"绑定版少锁了
 * 一行"，那种漂移在单元测试里全绿，只在两个 worker 并发时出错。
 *
 * ## 为什么是函数而不是接口
 *
 * 一个只有单方法的接口在 TypeScript 里与函数类型同构，但 `implements` 会给读者一个
 * "这里有个对象、有状态"的错误暗示。执行语境**没有状态**：它只是"把 work 放进哪个事务"
 * 的一个决定，所以用函数类型表达。
 */
export type SqlExecutor = <T>(work: (tx: DatabaseTransaction) => Promise<T>) => Promise<T>;

/** 独立语境：每次调用自己开一个短事务。 */
export function executorOf(db: DatabaseAdapter): SqlExecutor {
  return (work) => db.transaction(work);
}

/** 绑定语境：复用调用方已经打开的事务，随它一起提交或回滚。 */
export function executorBound(tx: DatabaseTransaction): SqlExecutor {
  return (work) => work(tx);
}

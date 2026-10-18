/**
 * 状态机层出口。
 *
 * `transition` 是机制（表怎么校验、怎么判定），`machines` 是策略（每个聚合具体有
 * 哪些边）。分开是为了让「新增一个聚合的状态机」只需要写一张纯数据表，而不必再碰
 * 判定逻辑。
 */

export * from './transition.js';
export * from './machines.js';

/**
 * 策略层出口。
 *
 * 这一层与 `entities/` 的分工是：实体回答"这个聚合现在是什么、能不能变成那样"，
 * 策略回答"给定一组从持久化状态查出来的数字，该不该做这件事"。因此本层的每个入口
 * 都是**纯谓词或纯决策函数**：不持有任何集合、不读时钟、不读环境变量、不做 IO。
 *
 * 四张策略分别来自契约的不同小节，彼此不重叠：
 *
 * - `task-admission.js` —— §6.5，能不能再创建一个 AI task（ADMIT / QUEUE / REJECT）；
 * - `usage.js` —— §6.6，额度准入与结算（含"调用已发生即入账，即使任务失败"）；
 * - `retry-policy.js` —— §6.6 / arch §7.4，`(stage, code)` 显式重试表；
 * - `lease.js` —— §6.4，合法的领取 / 续租 / 接管条件（持久化与抢占在 infra）。
 *
 * 四者共同的硬约束是 §6.5 规则 5：进程内 semaphore 或 Map **不是**事实源。这一层里
 * 没有一个模块持有可变状态，所有计数与时间都由调用方传入 —— 于是"两个实例同时推进
 * 同一个任务"只能由数据库的条件唯一索引和 revision CAS 拦住，不会因为我们少写了一个
 * 内存锁而悄悄发生。
 */

export * from './task-admission.js';
export * from './usage.js';
export * from './retry-policy.js';
export * from './lease.js';

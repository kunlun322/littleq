/**
 * 值对象层出口。
 *
 * 分模块导出而不是把所有类型摊平在一个文件里，是为了让「哪个概念由哪份规格定义」
 * 在文件边界上就可读：`primitives` 对应 ZLQ-153 §4.2，`task` 对应 §6.1/§7.4，
 * `refs` 对应 §6.4 的 provider-neutral 边界，`safe-text` 对应 §7.5 的脱敏要求。
 *
 * 这里**不做任何平台相关的事**：不读时钟、不读环境变量、不碰 `Intl`、不查
 * `node_modules`。所有需要「现在几点」的函数都把它作为入参（见
 * `isWithinRestoreWindow` / `periodKey` / `isLockThresholdReached`），这样同一份
 * 输入在 macOS 与 ubuntu 上得到逐字节相同的输出 —— OpenAPI 快照的可复现性依赖
 * 这一点。
 */

export * from './brand.js';
export * from './enum.js';
export * from './identifiers.js';
export * from './primitives.js';
export * from './safe-text.js';
export * from './account.js';
export * from './group.js';
export * from './project.js';
export * from './work.js';
export * from './task.js';
export * from './usage.js';
export * from './teaching.js';
export * from './reward.js';
export * from './refs.js';

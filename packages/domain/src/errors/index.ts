/**
 * 错误层出口。
 *
 * 三个文件三种职责：`catalog` 是错误码的唯一事实源（42 个码、HTTP 状态、文案 key、
 * `retryable`、`sameRequestRetrySafety`），`domain-error` 是唯一会抛出的领域异常类型，
 * `task-registry` 声明异步错误在 `(taskKind, stage)` 上的归属。
 *
 * `retryable` 只能查 `catalog` 这张固定表，禁止由异常类继承推导（架构 §7.4）——
 * 这也是 `DomainError` 上那个 `readonly retryable` 字段的唯一来源。
 */

export * from './catalog.js';
export * from './domain-error.js';
export * from './task-registry.js';

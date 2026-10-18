import { errorDefinition, type ErrorCode } from './catalog.js';

/**
 * 领域不变量被破坏时抛出的唯一错误类型。
 *
 * 只承载错误码目录里的 `code` 与可选的**值对象名**：绝不携带被校验的原值、
 * provider body、header、stack 或学生输入全文（ZLQ-153 §7.5）。这是结构性保证，
 * 不靠调用方自觉 —— 类上没有可以塞原文的字段。
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly messageKey: string;
  readonly retryable: boolean;
  readonly valueObject: string | undefined;

  constructor(code: ErrorCode, valueObject?: string) {
    super(valueObject ? `${code}: ${valueObject}` : code);
    this.name = 'DomainError';
    this.code = code;
    this.messageKey = errorDefinition(code).messageKey;
    this.retryable = errorDefinition(code).retryable;
    this.valueObject = valueObject;
  }

  /** 值对象解析失败统一归为 `REQUEST_INVALID`（400）。 */
  static invalid(valueObject: string): DomainError {
    return new DomainError('REQUEST_INVALID', valueObject);
  }
}

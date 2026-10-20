/**
 * 基础设施层的内部错误码，以及它们到**冻结**错误码目录的映射。
 *
 * 为什么需要一层内部码：ZLQ-201 裁定要求 grant 机制能区分「过期」「并发超限」「token
 * 不匹配」这三种内部原因，而 `packages/domain` 的 42 个公开码里没有它们，且公开码目录
 * 被 `error-catalog-frozen` 逐行钉死（新增码是破坏性变更）。PM 的裁定是：这些码**留在
 * 进程内部**，对外一律映射到既有公开码（404 `RESOURCE_NOT_FOUND` / 429 `RATE_LIMITED`
 * 等）。本文件就是那层映射的唯一事实源。
 *
 * 结构性保证（照抄 `DomainError` 的做法，不靠调用方自觉）：`InfraError` 上**没有**任何
 * 可以塞原文的字段 —— 没有 provider body、没有 URL、没有 token、没有 stack 透传。
 * `message` 就是错误码本身。所以「原始签名 URL 不落日志」不依赖每个调用点记得脱敏。
 */
import { type ErrorCode, type SecretKind, isRetryable } from '@littleq/domain';

/**
 * 进程内部错误码。它们**不进**任何公开契约（OpenAPI / 错误码目录），只用于 infra 内部
 * 与 D5 的编排分支。
 */
export const INFRA_ERROR_CODES = [
  // ObjectStore
  'OBJECT_KEY_INVALID',
  'OBJECT_UPLOAD_TOO_LARGE',
  'OBJECT_UPLOAD_ABORTED',
  'OBJECT_DECLARED_BYTES_MISMATCH',
  'OBJECT_HASH_MISMATCH',
  'OBJECT_ALREADY_EXISTS',
  'OBJECT_NOT_FOUND',
  'OBJECT_RANGE_NOT_SATISFIABLE',
  'OBJECT_READ_BUDGET_EXCEEDED',
  'OBJECT_READ_ABORTED',
  'PROVIDER_UNAVAILABLE',
  // 产物分片固化
  'ARTIFACT_CHUNK_MISSING',
  'ARTIFACT_CHUNK_DUPLICATE',
  'ARTIFACT_CHUNK_ORDER_INVALID',
  'ARTIFACT_TOTAL_MISMATCH',
  'ARTIFACT_HASH_MISMATCH',
  'ARTIFACT_MANIFEST_INVALID',
  'ARTIFACT_ALREADY_SEALED',
  // grant 机制
  'GRANT_TTL_OUT_OF_RANGE',
  'GRANT_BUDGET_OUT_OF_RANGE',
  'GRANT_AUDIENCE_MISMATCH',
  'OBJECT_READ_GRANT_UNKNOWN',
  'OBJECT_READ_GRANT_EXPIRED',
  'OBJECT_READ_GRANT_REVOKED',
  'OBJECT_READ_CONCURRENCY_LIMIT',
  'SENSITIVE_URL_INVALID',
  // 任务租约（arch §6.1 的 lease 边；判据在 domain 的 policies/lease，秒数合法性在这里）
  'LEASE_TTL_OUT_OF_RANGE',
  // SecretStore
  'MASTER_KEY_UNAVAILABLE',
  'MASTER_KEY_VERSION_MISMATCH',
  'SECRET_CONTEXT_INVALID',
  'SECRET_PLAINTEXT_OUT_OF_RANGE',
  'SECRET_ALREADY_CONFIGURED',
  'SECRET_NOT_CONFIGURED',
  'SECRET_REVOKED',
  'SECRET_VERSION_CONFLICT',
  'SECRET_PURPOSE_MISMATCH',
  'SECRET_DECRYPT_FAILED',
] as const;

export type InfraErrorCode = (typeof INFRA_ERROR_CODES)[number];

/**
 * 内部码 → 冻结目录里的公开码。
 *
 * `Record<InfraErrorCode, ErrorCode>` 这个类型本身就是门禁：加一个内部码而忘了给它定
 * 公开映射，`pnpm typecheck` 会红，不会静默退化成 `undefined`。
 *
 * 三条与凭据有关的码映射到 `RESOURCE_NOT_FOUND` / `SECRET_*` 而不是各自单独一个公开码，
 * 是裁定一不变量 1 的要求：未授权访问对外必须是**统一的、不含对象细节的 404**，否则
 * 攻击者可以用错误码差异枚举「这个 token 是过期了还是根本不存在」。
 */
const PUBLIC_ERROR_CODE: Readonly<Record<InfraErrorCode, ErrorCode>> = {
  OBJECT_KEY_INVALID: 'REQUEST_INVALID',
  OBJECT_UPLOAD_TOO_LARGE: 'REQUEST_INVALID',
  OBJECT_UPLOAD_ABORTED: 'USER_CANCELLED',
  OBJECT_DECLARED_BYTES_MISMATCH: 'REQUEST_INVALID',
  OBJECT_HASH_MISMATCH: 'REQUEST_INVALID',
  OBJECT_ALREADY_EXISTS: 'REVISION_CONFLICT',
  OBJECT_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  OBJECT_RANGE_NOT_SATISFIABLE: 'REQUEST_INVALID',
  OBJECT_READ_BUDGET_EXCEEDED: 'RATE_LIMITED',
  OBJECT_READ_ABORTED: 'USER_CANCELLED',
  PROVIDER_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  ARTIFACT_CHUNK_MISSING: 'ARTIFACT_INCOMPLETE',
  ARTIFACT_CHUNK_DUPLICATE: 'ARTIFACT_INCOMPLETE',
  ARTIFACT_CHUNK_ORDER_INVALID: 'ARTIFACT_INCOMPLETE',
  ARTIFACT_TOTAL_MISMATCH: 'ARTIFACT_INCOMPLETE',
  ARTIFACT_HASH_MISMATCH: 'ARTIFACT_INCOMPLETE',
  ARTIFACT_MANIFEST_INVALID: 'ARTIFACT_INCOMPLETE',
  ARTIFACT_ALREADY_SEALED: 'REVISION_CONFLICT',
  GRANT_TTL_OUT_OF_RANGE: 'REQUEST_INVALID',
  GRANT_BUDGET_OUT_OF_RANGE: 'REQUEST_INVALID',
  GRANT_AUDIENCE_MISMATCH: 'RESOURCE_NOT_FOUND',
  OBJECT_READ_GRANT_UNKNOWN: 'RESOURCE_NOT_FOUND',
  OBJECT_READ_GRANT_EXPIRED: 'RESOURCE_NOT_FOUND',
  OBJECT_READ_GRANT_REVOKED: 'RESOURCE_NOT_FOUND',
  OBJECT_READ_CONCURRENCY_LIMIT: 'RATE_LIMITED',
  SENSITIVE_URL_INVALID: 'INTERNAL_ERROR',
  LEASE_TTL_OUT_OF_RANGE: 'REQUEST_INVALID',
  MASTER_KEY_UNAVAILABLE: 'INTERNAL_ERROR',
  MASTER_KEY_VERSION_MISMATCH: 'INTERNAL_ERROR',
  SECRET_CONTEXT_INVALID: 'REQUEST_INVALID',
  SECRET_PLAINTEXT_OUT_OF_RANGE: 'REQUEST_INVALID',
  SECRET_ALREADY_CONFIGURED: 'REVISION_CONFLICT',
  SECRET_NOT_CONFIGURED: 'RESOURCE_NOT_FOUND',
  SECRET_REVOKED: 'RESOURCE_NOT_FOUND',
  SECRET_VERSION_CONFLICT: 'REVISION_CONFLICT',
  SECRET_PURPOSE_MISMATCH: 'REQUEST_INVALID',
  SECRET_DECRYPT_FAILED: 'INTERNAL_ERROR',
};

/**
 * 凭据类内部码的公开形态取决于**是哪一种凭据**：冻结目录里已经有
 * `QCA_CREDENTIAL_NOT_CONFIGURED` 与 `BAILIAN_CREDENTIAL_NOT_CONFIGURED` 两个 422，
 * 用它们比笼统的 404 更贴合 D1 已冻结的 `GET /settings/secrets/{kind}` 语义。
 */
const KIND_AWARE_ERROR_CODES: ReadonlySet<InfraErrorCode> = new Set<InfraErrorCode>([
  'SECRET_NOT_CONFIGURED',
  'SECRET_REVOKED',
]);

export interface InfraErrorContext {
  /** 仅凭据类错误码需要；其它码给了也被忽略。 */
  readonly secretKind?: SecretKind;
}

/** 内部码 → 公开码。凭据类码在给出 `secretKind` 时映射到该凭据自己的 422。 */
export function publicErrorCodeOf(
  code: InfraErrorCode,
  context: InfraErrorContext = {},
): ErrorCode {
  if (KIND_AWARE_ERROR_CODES.has(code)) {
    if (context.secretKind === 'QCA_PAT') return 'QCA_CREDENTIAL_NOT_CONFIGURED';
    if (context.secretKind === 'BAILIAN_API_KEY') return 'BAILIAN_CREDENTIAL_NOT_CONFIGURED';
  }
  return PUBLIC_ERROR_CODE[code];
}

/**
 * infra 抛出的唯一错误类型。
 *
 * `retryable` 默认由公开码推导（`isRetryable`），只有「同一请求重试也不会变好」的内部码
 * 才显式覆盖 —— 例如 grant 过期：重试同一个 token 永远失败，必须让主站重新签发。
 */
export class InfraError extends Error {
  readonly code: InfraErrorCode;
  readonly publicCode: ErrorCode;
  readonly retryable: boolean;
  readonly secretKind: SecretKind | undefined;

  constructor(
    code: InfraErrorCode,
    options: InfraErrorContext & { readonly retryable?: boolean } = {},
  ) {
    super(code);
    this.name = 'InfraError';
    this.code = code;
    this.secretKind = options.secretKind;
    this.publicCode = publicErrorCodeOf(code, options);
    this.retryable = options.retryable ?? isRetryable(this.publicCode);
  }
}

/** grant 过期后重试同一个 token 不可能成功，必须重新签发 —— 覆盖公开码的默认推导。 */
const NON_RETRYABLE_CODES: ReadonlySet<InfraErrorCode> = new Set<InfraErrorCode>([
  'OBJECT_READ_GRANT_EXPIRED',
  'OBJECT_READ_GRANT_REVOKED',
  'OBJECT_READ_GRANT_UNKNOWN',
  'GRANT_AUDIENCE_MISMATCH',
]);

export function infraError(code: InfraErrorCode, context: InfraErrorContext = {}): InfraError {
  const retryable = NON_RETRYABLE_CODES.has(code) ? false : undefined;
  return new InfraError(code, { ...context, retryable });
}

export function isInfraError(value: unknown): value is InfraError {
  return value instanceof InfraError;
}

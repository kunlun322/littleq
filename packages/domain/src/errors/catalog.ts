/**
 * v1 领域错误码目录 —— 全仓库唯一的错误码事实源。
 *
 * 纯 TS 数据（`as const satisfies`），不引入 Zod：Zod 属于传输契约层
 * （`packages/api-contract`），领域层只依赖 TypeScript 标准类型（ZLQ-153 §5.4(4)）。
 *
 * 字段语义：
 * - `retryable`：条件不变时服务端或客户端是否可自动重试。
 * - `sameRequestRetrySafety`：`SAFE` 重放不新增副作用；`UNSAFE` 禁止盲目重放；
 *   `REQUIRES_IDEMPOTENCY_KEY` 只有 operation 同时声明并校验同一幂等键时才安全。
 *   它不等于「重试一定成功」。
 *
 * `retryable` 只能查这张固定表，禁止由异常类继承推导（ZLQ-153 §7.4）。
 */

export type SameRequestRetrySafety = 'SAFE' | 'UNSAFE' | 'REQUIRES_IDEMPOTENCY_KEY';

export type DomainErrorDefinition = {
  readonly code: string;
  readonly httpStatus: number;
  readonly messageKey: string;
  readonly retryable: boolean;
  readonly sameRequestRetrySafety: SameRequestRetrySafety;
};

export const DOMAIN_ERROR_CATALOG = [
  {
    code: 'REQUEST_INVALID',
    httpStatus: 400,
    messageKey: 'request.invalid',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'IDEMPOTENCY_KEY_REQUIRED',
    httpStatus: 400,
    messageKey: 'request.idempotencyKey.required',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'AUTHENTICATION_REQUIRED',
    httpStatus: 401,
    messageKey: 'auth.required',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'AUTHENTICATION_FAILED',
    httpStatus: 401,
    messageKey: 'auth.failed',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'ACCOUNT_LOCKED',
    httpStatus: 423,
    messageKey: 'auth.account.locked',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'CSRF_REJECTED',
    httpStatus: 403,
    messageKey: 'auth.csrfRejected',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'FORBIDDEN_CAPABILITY',
    httpStatus: 403,
    messageKey: 'auth.capability.forbidden',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'RESOURCE_NOT_FOUND',
    httpStatus: 404,
    messageKey: 'resource.notFound',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'LOGIN_NAME_CONFLICT',
    httpStatus: 409,
    messageKey: 'account.loginName.conflict',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'GROUP_ARCHIVED',
    httpStatus: 409,
    messageKey: 'group.archived',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'GROUP_MEMBER_LIMIT_REACHED',
    httpStatus: 409,
    messageKey: 'group.memberLimit.reached',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'REVISION_CONFLICT',
    httpStatus: 409,
    messageKey: 'resource.revisionConflict',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'IDEMPOTENCY_KEY_REUSED',
    httpStatus: 409,
    messageKey: 'request.idempotencyKey.reused',
    retryable: false,
    sameRequestRetrySafety: 'UNSAFE',
  },
  {
    code: 'ACTIVE_WRITE_TASK_EXISTS',
    httpStatus: 409,
    messageKey: 'task.activeWrite.exists',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'TASK_NOT_CANCELLABLE',
    httpStatus: 409,
    messageKey: 'task.cancel.notAllowed',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'TASK_NOT_RETRYABLE',
    httpStatus: 409,
    messageKey: 'task.retry.notAllowed',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'VERSION_NOT_RESTORABLE',
    httpStatus: 409,
    messageKey: 'version.restore.notAllowed',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'VERSION_NOT_PREVIEWABLE',
    httpStatus: 422,
    messageKey: 'version.preview.notAvailable',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'VERSION_NOT_PUBLISHABLE',
    httpStatus: 422,
    messageKey: 'version.publish.notAllowed',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'PUBLICATION_IN_PROGRESS',
    httpStatus: 409,
    messageKey: 'publication.inProgress',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'SECRET_KIND_UNSUPPORTED',
    httpStatus: 400,
    messageKey: 'secret.kind.unsupported',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'SECRET_IMMUTABLE_REDEPLOY_REQUIRED',
    httpStatus: 409,
    messageKey: 'secret.immutable.redeployRequired',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'USAGE_LIMIT_EXCEEDED',
    httpStatus: 429,
    messageKey: 'usage.limit.exceeded',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'RATE_LIMITED',
    httpStatus: 429,
    messageKey: 'request.rateLimited',
    retryable: true,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'QCA_CREDENTIAL_NOT_CONFIGURED',
    httpStatus: 422,
    messageKey: 'agent.credential.missing',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'QCA_CREDENTIAL_INVALID',
    httpStatus: 422,
    messageKey: 'agent.credential.invalid',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'QCA_QUOTA_EXHAUSTED',
    httpStatus: 429,
    messageKey: 'agent.energy.empty',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'QCA_UNREACHABLE',
    httpStatus: 503,
    messageKey: 'agent.connection.unavailable',
    retryable: true,
    sameRequestRetrySafety: 'REQUIRES_IDEMPOTENCY_KEY',
  },
  {
    code: 'BAILIAN_CREDENTIAL_NOT_CONFIGURED',
    httpStatus: 422,
    messageKey: 'media.credential.missing',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'BAILIAN_CREDENTIAL_INVALID',
    httpStatus: 422,
    messageKey: 'media.credential.invalid',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'BAILIAN_QUOTA_EXHAUSTED',
    httpStatus: 429,
    messageKey: 'media.energy.empty',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'BAILIAN_UNREACHABLE',
    httpStatus: 503,
    messageKey: 'media.connection.unavailable',
    retryable: true,
    sameRequestRetrySafety: 'REQUIRES_IDEMPOTENCY_KEY',
  },
  {
    code: 'AGENT_FAILED',
    httpStatus: 502,
    messageKey: 'agent.run.failed',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'ARTIFACT_MISSING',
    httpStatus: 502,
    messageKey: 'artifact.missing',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'ARTIFACT_INCOMPLETE',
    httpStatus: 502,
    messageKey: 'artifact.incomplete',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'BUILD_FAILED',
    httpStatus: 422,
    messageKey: 'work.build.failed',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'WORK_CONTRACT_BLOCKED',
    httpStatus: 422,
    messageKey: 'work.contract.blocked',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'CONTENT_REJECTED',
    httpStatus: 422,
    messageKey: 'content.rejected',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'TASK_TIMEOUT',
    httpStatus: 504,
    messageKey: 'task.timeout',
    retryable: false,
    sameRequestRetrySafety: 'REQUIRES_IDEMPOTENCY_KEY',
  },
  {
    code: 'USER_CANCELLED',
    httpStatus: 409,
    messageKey: 'task.cancelled',
    retryable: false,
    sameRequestRetrySafety: 'SAFE',
  },
  {
    code: 'DEPENDENCY_UNAVAILABLE',
    httpStatus: 503,
    messageKey: 'system.dependency.unavailable',
    retryable: true,
    sameRequestRetrySafety: 'REQUIRES_IDEMPOTENCY_KEY',
  },
  {
    code: 'INTERNAL_ERROR',
    httpStatus: 500,
    messageKey: 'system.unavailable',
    retryable: false,
    sameRequestRetrySafety: 'UNSAFE',
  },
] as const satisfies readonly DomainErrorDefinition[];

export type ErrorCode = (typeof DOMAIN_ERROR_CATALOG)[number]['code'];

/**
 * 统一错误 envelope 的字段。异步任务失败仍由 `GET /tasks/{id}` 以 HTTP 200 返回
 * task representation，其内部 `error.code/messageKey` 取自同一目录；`httpStatus`
 * 只用于同步命令失败与 envelope。
 */
export const ERROR_ENVELOPE_FIELDS = ['code', 'messageKey', 'retryable', 'traceId'] as const;

export type ErrorEnvelopeField = (typeof ERROR_ENVELOPE_FIELDS)[number];

/** 查表得到的定义：`code` 已收窄为 `ErrorCode`，调用方无需再断言。 */
export type ResolvedErrorDefinition = Omit<DomainErrorDefinition, 'code'> & {
  readonly code: ErrorCode;
};

export type SafeError = {
  readonly code: ErrorCode;
  readonly messageKey: string;
  readonly retryable: boolean;
};

const CATALOG_BY_CODE: ReadonlyMap<ErrorCode, ResolvedErrorDefinition> = new Map(
  DOMAIN_ERROR_CATALOG.map((definition) => [definition.code, definition]),
);

export function isErrorCode(value: string): value is ErrorCode {
  return CATALOG_BY_CODE.has(value as ErrorCode);
}

export function errorDefinition(code: ErrorCode): ResolvedErrorDefinition {
  const definition = CATALOG_BY_CODE.get(code);
  if (!definition) throw new Error(`unknown error code: ${code}`);
  return definition;
}

export function httpStatusOf(code: ErrorCode): number {
  return errorDefinition(code).httpStatus;
}

/**
 * 同一请求重放是否安全。`REQUIRES_IDEMPOTENCY_KEY` 不等于「重试一定成功」：
 * 只有 operation 同时声明并校验同一幂等键时才安全。
 */
export function sameRequestRetrySafetyOf(code: ErrorCode): SameRequestRetrySafety {
  return errorDefinition(code).sameRequestRetrySafety;
}

export function isRetryable(code: ErrorCode): boolean {
  return errorDefinition(code).retryable;
}

/**
 * `INTERNAL_ERROR` 与 `DEPENDENCY_UNAVAILABLE` 不隐式挂载：任何 operation 或
 * 异步阶段要用它们都必须显式声明。
 */
export const NEVER_IMPLICITLY_MOUNTED_ERROR_CODES = [
  'INTERNAL_ERROR',
  'DEPENDENCY_UNAVAILABLE',
] as const;

/** 429 语义要求响应携带 Retry-After。 */
export const RATE_LIMIT_ERROR_CODES: readonly ErrorCode[] = DOMAIN_ERROR_CATALOG.filter(
  (definition) => definition.httpStatus === 429,
).map((definition) => definition.code);

/** 面向 task representation 与 SSE 的安全错误投影：只暴露 code/messageKey/retryable。 */
export function toSafeError(code: ErrorCode): SafeError {
  const definition = errorDefinition(code);
  return {
    code: definition.code,
    messageKey: definition.messageKey,
    retryable: definition.retryable,
  };
}

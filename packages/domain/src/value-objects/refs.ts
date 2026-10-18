import { DomainError } from '../errors/domain-error.js';
import { brand, type Branded } from './brand.js';
import { assertNotSensitiveText } from './safe-text.js';
import { SHA256_PATTERN, parseTimestamp, type Timestamp } from './primitives.js';
import {
  parseCredits,
  parseDurationMs,
  parseUsageQuantity,
  type Capability,
  type Credits,
  type DurationMs,
  type UsageProvider,
  type UsageQuantity,
  type UsageUnit,
} from './usage.js';
import { parseTaskId, type TaskId } from './identifiers.js';
import { isTaskStage, type TaskStage } from './task.js';

/**
 * provider-neutral 的不透明引用（ZLQ-153 §6.4「只能作为 provider-neutral opaque
 * value 进入 domain」）。
 *
 * 这一层的共同约束是：**只表示不可变资源引用，不含供应商 URL**。所以每个 ref 的
 * 解析都先过 `assertNotSensitiveText` —— 签名 URL、bearer token、`password=` 这类
 * 形状在这里就被拒掉，而不是等到写日志时再靠 redactor 补救。redactor 处理的是
 * 任意来源的字符串；一旦签名 URL 已经被存成 `ArtifactRef`，后面任何一层都无法再
 * 证明它是干净的。
 *
 * 对 adapter 的约束（由此产生，需要在实现驱动时遵守）：ref 是一个**逻辑键**，不是
 * URL、不带查询串、不含 `name=value` 形式的凭证赋值。若后端确实需要这些字符，
 * 由 adapter 自己编码后再交给 domain。
 */

export type OpaqueRef<Name extends string> = {
  readonly name: Name;
  readonly minLength: number;
  readonly maxLength: number;
  readonly is: (value: string) => boolean;
  readonly parse: (value: string) => Branded<string, Name>;
};

function opaqueRef<Name extends string>(name: Name, maxLength: number): OpaqueRef<Name> {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error(`invalid max length for ${name}: ${maxLength}`);
  }
  const is = (value: string): boolean =>
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    assertNotSensitiveTextSafe(value);
  return {
    name,
    minLength: 1,
    maxLength,
    is,
    parse: (value: string): Branded<string, Name> => {
      if (!is(value)) throw DomainError.invalid(name);
      return brand<string, Name>(value);
    },
  };
}

/** `assertNotSensitiveText` 抛异常，这里需要一个布尔形态给 `is()` 用。 */
function assertNotSensitiveTextSafe(value: string): boolean {
  try {
    assertNotSensitiveText(value, 'OpaqueRef');
    return true;
  } catch {
    return false;
  }
}

/** `project_versions.manifest_object_key`：对象清单的逻辑键，不存 provider URL。 */
export const ARTIFACT_REF_MAX_LENGTH = 512;
export type ArtifactRef = Branded<string, 'ArtifactRef'>;
const artifactRefObject = opaqueRef('ArtifactRef', ARTIFACT_REF_MAX_LENGTH);
export const isArtifactRef = artifactRefObject.is;
export const parseArtifactRef = artifactRefObject.parse;

/** `publications.runtime_path`：Runtime 侧的只读路径；deny-list 与 CSP 在 infra。 */
export const RUNTIME_REF_MAX_LENGTH = 512;
export type RuntimeRef = Branded<string, 'RuntimeRef'>;
const runtimeRefObject = opaqueRef('RuntimeRef', RUNTIME_REF_MAX_LENGTH);
export const isRuntimeRef = runtimeRefObject.is;
export const parseRuntimeRef = runtimeRefObject.parse;

/** `lessons.content_object_key`：课程内容的逻辑键。 */
export const CONTENT_REF_MAX_LENGTH = 512;
export type ContentRef = Branded<string, 'ContentRef'>;
const contentRefObject = opaqueRef('ContentRef', CONTENT_REF_MAX_LENGTH);
export const isContentRef = contentRefObject.is;
export const parseContentRef = contentRefObject.parse;

/**
 * `qca_contexts.context_summary_object_key`：整行 QCA 上下文是 application/infra
 * 的 integration record，只有这一个不透明键允许进入 use case（§6.3）。
 */
export const GENERATION_CONTEXT_REF_MAX_LENGTH = 512;
export type GenerationContextRef = Branded<string, 'GenerationContextRef'>;
const generationContextRefObject = opaqueRef(
  'GenerationContextRef',
  GENERATION_CONTEXT_REF_MAX_LENGTH,
);
export const isGenerationContextRef = generationContextRefObject.is;
export const parseGenerationContextRef = generationContextRefObject.parse;

/** `SecretStore.write()` 返回的句柄：指向密文所在位置，**不是**密文，更不是明文。 */
export const SECRET_REF_MAX_LENGTH = 256;
export type SecretRef = Branded<string, 'SecretRef'>;
const secretRefObject = opaqueRef('SecretRef', SECRET_REF_MAX_LENGTH);
export const isSecretRef = secretRefObject.is;
export const parseSecretRef = secretRefObject.parse;

/**
 * 业务可配置的密钥种类。
 *
 * 只有这两种会出现在 API 上（§5.5 `getSecretMetadata` / `putSecret`）；
 * `LITTLEQ_MASTER_KEY` 是部署期主密钥，只存在于 Production Secret，永远不是
 * 一个业务 kind。未知 kind 报 `SECRET_KIND_UNSUPPORTED` 而不是通用的
 * `REQUEST_INVALID`：调用方需要区分「参数写错了」与「这类密钥本系统不支持」。
 */
export const SECRET_KINDS = ['QCA_PAT', 'BAILIAN_API_KEY'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

const SECRET_KIND_SET: ReadonlySet<string> = new Set(SECRET_KINDS);

export function isSecretKind(value: string): value is SecretKind {
  return SECRET_KIND_SET.has(value);
}

export function parseSecretKind(value: string): SecretKind {
  if (!isSecretKind(value)) throw new DomainError('SECRET_KIND_UNSUPPORTED', 'SecretKind');
  return value;
}

/**
 * `GET /settings/secrets/{kind}` 的读模型：只回答「配了没有、什么时候轮换的」，
 * 结构上不存在 value 字段（§5.5「永不含 value」）。
 */
export type SecretMetadata = {
  readonly kind: SecretKind;
  readonly configured: boolean;
  readonly lastRotatedAt: Timestamp | null;
};

export function createSecretMetadata(input: {
  readonly kind: string;
  readonly configured: unknown;
  readonly lastRotatedAt?: string | null;
}): SecretMetadata {
  const kind = parseSecretKind(input.kind);
  if (typeof input.configured !== 'boolean') throw DomainError.invalid('SecretMetadata.configured');
  const lastRotatedAt = input.lastRotatedAt ?? null;
  return {
    kind,
    configured: input.configured,
    lastRotatedAt: lastRotatedAt === null ? null : parseTimestamp(lastRotatedAt),
  };
}

/**
 * 发给 Forward API 的幂等键（`ai_tasks.external_operation_key`）。
 *
 * domain 只定义生成规则 `taskId:stage:attempt`，不理解 QCA SDK：同一个 task 的
 * 同一次 attempt 在同一个 stage 上重放，provider 侧看到的是同一个键，因此不会
 * 因为进程崩溃后的重试而产生第二个 Session。这与 HTTP 幂等键、task 的新 attempt
 * 是三种不同语义（§6.2）。
 */
export type ExternalOperationKey = Branded<string, 'ExternalOperationKey'>;

/** §6.1 的值对象清单里写作 `OperationKey`，是同一个东西。 */
export type OperationKey = ExternalOperationKey;

export const EXTERNAL_OPERATION_KEY_SEPARATOR = ':';

/** 十进制、无前导零；`attempt` 从 1 起，0 只可能来自伪造的键。 */
const ATTEMPT_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export function formatExternalOperationKey(
  taskId: TaskId,
  stage: TaskStage,
  attempt: number,
): ExternalOperationKey {
  if (!isTaskStage(stage)) throw DomainError.invalid('TaskStage');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw DomainError.invalid('Attempt');
  return brand<string, 'ExternalOperationKey'>(
    `${taskId}${EXTERNAL_OPERATION_KEY_SEPARATOR}${stage}${EXTERNAL_OPERATION_KEY_SEPARATOR}${attempt}`,
  );
}

export type ExternalOperationKeyParts = {
  readonly taskId: TaskId;
  readonly stage: TaskStage;
  readonly attempt: number;
};

/**
 * 解析并校验形状。要求**恰好三段**：taskId 是 UUID（不含 `:`），stage 是枚举，
 * attempt 是十进制整数。多一段或少一段都说明这个键不是本系统生成的，直接拒绝。
 */
export function parseExternalOperationKey(value: string): ExternalOperationKeyParts & {
  readonly key: ExternalOperationKey;
} {
  if (typeof value !== 'string') throw DomainError.invalid('ExternalOperationKey');
  const parts = value.split(EXTERNAL_OPERATION_KEY_SEPARATOR);
  if (parts.length !== 3) throw DomainError.invalid('ExternalOperationKey');
  const [rawTaskId, rawStage, rawAttempt] = parts as [string, string, string];
  assertNotSensitiveText(value, 'ExternalOperationKey');
  const taskId = parseTaskId(rawTaskId);
  if (!isTaskStage(rawStage)) throw DomainError.invalid('TaskStage');
  if (!ATTEMPT_PATTERN.test(rawAttempt)) throw DomainError.invalid('Attempt');
  const attempt = Number(rawAttempt);
  if (attempt < 1) throw DomainError.invalid('Attempt');
  const key = formatExternalOperationKey(taskId, rawStage, attempt);
  if (key !== value) throw DomainError.invalid('ExternalOperationKey');
  return { key, taskId, stage: rawStage, attempt };
}

/**
 * provider 上报的用量，规范化后的形态。
 *
 * domain 接受的是已经归一化的 units / credits，**不接原始 provider response**：
 * 解析 provider body 属于 infra（§6.4）。`providerReportedCredits` 可空 —— 供应
 * 商没回报时留空，由 `estimatedCredits` 兜底，两者都保留是为了对账时能看出差异，
 * 而不是让其中一个悄悄覆盖另一个。
 */
export const MODEL_ID_MAX_LENGTH = 128;
export type ModelId = Branded<string, 'ModelId'>;
const modelIdObject = opaqueRef('ModelId', MODEL_ID_MAX_LENGTH);
export const isModelId = modelIdObject.is;
export const parseModelId = modelIdObject.parse;

/** `ai_tasks.provider_request_id`：可排障的非敏感标识，不是凭证。 */
export const PROVIDER_REQUEST_ID_MAX_LENGTH = 128;
export type ProviderRequestId = Branded<string, 'ProviderRequestId'>;
const providerRequestIdObject = opaqueRef('ProviderRequestId', PROVIDER_REQUEST_ID_MAX_LENGTH);
export const isProviderRequestId = providerRequestIdObject.is;
export const parseProviderRequestId = providerRequestIdObject.parse;

/**
 * `ai_tasks.error_digest`：原始错误体的 SHA-256。
 *
 * 用摘要而不是原文，是为了「能排障」与「不落敏感内容」同时成立：同一条 provider
 * 错误永远得到同一个 64 位十六进制串，可以据此聚类与比对，但反推不出原文。固定
 * 长度的十六进制形状也在结构上排除了任何散文、URL 或凭证。
 */
export type ErrorDigest = Branded<string, 'ErrorDigest'>;

export function isErrorDigest(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function parseErrorDigest(value: string): ErrorDigest {
  if (!isErrorDigest(value)) throw DomainError.invalid('ErrorDigest');
  return brand<string, 'ErrorDigest'>(value);
}

export type ProviderUsage = {
  readonly provider: UsageProvider;
  readonly capability: Capability;
  readonly unit: UsageUnit;
  readonly quantity: UsageQuantity;
  readonly estimatedCredits: Credits;
  readonly providerReportedCredits: Credits | null;
  readonly durationMs: DurationMs | null;
  readonly modelId: ModelId | null;
};

export function createProviderUsage(input: {
  readonly provider: UsageProvider;
  readonly capability: Capability;
  readonly unit: UsageUnit;
  readonly quantity: number;
  readonly estimatedCredits: number;
  readonly providerReportedCredits?: number | null;
  readonly durationMs?: number | null;
  readonly modelId?: string | null;
}): ProviderUsage {
  const reported = input.providerReportedCredits ?? null;
  const durationMs = input.durationMs ?? null;
  const modelId = input.modelId ?? null;
  return {
    provider: input.provider,
    capability: input.capability,
    unit: input.unit,
    quantity: parseUsageQuantity(input.quantity),
    estimatedCredits: parseCredits(input.estimatedCredits),
    providerReportedCredits: reported === null ? null : parseCredits(reported),
    durationMs: durationMs === null ? null : parseDurationMs(durationMs),
    modelId: modelId === null ? null : parseModelId(modelId),
  };
}

/**
 * `unit` 必须与 `capability` 一致，否则同一笔消耗在账本上会出现两种量纲，
 * 结算差额（§6.6）就没法算了。
 */
export function assertProviderUsageCoherent(usage: ProviderUsage, expectedUnit: UsageUnit): void {
  if (usage.unit !== expectedUnit) throw DomainError.invalid('ProviderUsage.unit');
}

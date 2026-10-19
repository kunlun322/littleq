import { DomainError } from '../errors/domain-error.js';
import { brand, type Branded } from './brand.js';
import { stringEnum } from './enum.js';
import { assertNotSensitiveText } from './safe-text.js';
import {
  SHA256_PATTERN,
  integerValueObject,
  parseTimestamp,
  type Timestamp,
} from './primitives.js';
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
 * 密钥来源：**部署期注入** vs **用户自带**。
 *
 * 这个区分是 `SECRET_IMMUTABLE_REDEPLOY_REQUIRED` 能够继续留在冻结目录里的原因。
 * 该码的文案是「密钥不可变，需重新部署才能更换」，而用户 2026-10-19T16:34:30Z 的
 * BYO 裁决要求凭证在运行期可写 —— 两者字面上矛盾。矛盾的解法不是改目录（改错误码
 * 目录是破坏性变更，`catalog-code-*` 五个变异全部 exit 1），而是承认**存在两类密钥**：
 *
 * - `DEPLOYMENT`：平台在部署期注入（Production Secret / 环境变量）。API 写不动它，
 *   对它的 PUT / rotate / revoke 一律 `SECRET_IMMUTABLE_REDEPLOY_REQUIRED` —— 文案
 *   逐字准确，因为它确实要重新部署才能换。
 * - `USER`：归属者按 BYO 裁决自己填的凭证。走 `PUT /settings/secrets/{kind}` 与
 *   `:rotate` / `:revoke`，全程只用既有错误码。
 *
 * `source` **不上线**：`SecretMetadata` 的键集合被 `api-contract/test/schemas.test.ts`
 * 钉死为 `['kind','configured','lastRotatedAt']`，而且把来源暴露给前端等于告诉探测者
 * 「这个部署的 QCA_PAT 是平台注入的」。代价是前端无法预先禁用按钮、只能吃一次 409；
 * 若要改成可预判，需要架构师裁决是否给 `SecretMetadata` 加字段（那是 `response-added`
 * 之外的形状变更，不在本单权限内）。
 */
export const SECRET_SOURCES = ['DEPLOYMENT', 'USER'] as const;
export type SecretSource = (typeof SECRET_SOURCES)[number];
const secretSourceEnum = stringEnum<SecretSource>('SecretSource', SECRET_SOURCES);
export const isSecretSource = secretSourceEnum.is;
export const parseSecretSource = secretSourceEnum.parse;

/**
 * 只有 `USER` 来源可以被 API 改写。三个写接口共用这一条断言，因此「部署期密钥不可
 * 通过 API 变更」是一个事实源，而不是三处各写一遍的 if。
 */
export function assertSecretWritable(source: SecretSource): void {
  if (source !== 'USER') {
    throw new DomainError('SECRET_IMMUTABLE_REDEPLOY_REQUIRED', 'SecretSource');
  }
}

/**
 * 已安装过多少代密钥。**单调递增，撤销后不归零**：它是「这个种类历史上被换过几次」
 * 的计数，归零会让「撤销后重新填入」与「从未配置过」在数据上无法区分。
 * `0` 表示从未写入过任何值。
 */
export type SecretGeneration = ReturnType<typeof secretGenerationValue.parse>;
const secretGenerationValue = integerValueObject('SecretGeneration', 0, 1_000_000);

export function parseSecretGeneration(value: number): SecretGeneration {
  return secretGenerationValue.parse(value);
}

export function nextSecretGeneration(current: SecretGeneration): SecretGeneration {
  return parseSecretGeneration(current + 1);
}

/**
 * 密钥的**领域侧**记录：比 wire 上的 `SecretMetadata` 多出 `source` / `currentRef` /
 * `generation` / `revokedAt` 四项。
 *
 * 多出来的四项没有一项是明文：`currentRef` 是 `SecretStore.write()` 返回的句柄
 * （指向密文位置），`generation` 是计数，`revokedAt` 是时刻，`source` 是二值枚举。
 * 「结构上不存在明文字段」这条约束在 `SecretMetadata` 与 `SecretRecord` 上同样成立。
 *
 * 不变量（`createSecretRecord` 逐条强制）：
 *
 * 1. `configured === (currentRef !== null)` —— 「配了没有」只有一个事实源。
 * 2. `(generation === 0) === (lastRotatedAt === null)` —— 有过写入就必然有轮换时刻
 *    （首次写入即视为一次轮换，`SecretMetadata.lastRotatedAt` 的文档已经这么说）。
 * 3. `configured` ⟹ `generation >= 1`，是 1 与 2 的推论，显式写出来是为了让
 *    「configured 但 generation 为 0」这种状态在构造期就炸掉。
 * 4. `revokedAt !== null` ⟹ `!configured` —— 撤销时刻只在「当前不可用」期间有意义；
 *    撤销后重新 PUT 会清空它，历史由 `audit_logs` 的 `SECRET_REVOKE` 行保存。
 */
export type SecretRecord = {
  readonly kind: SecretKind;
  readonly source: SecretSource;
  readonly configured: boolean;
  readonly currentRef: SecretRef | null;
  readonly generation: SecretGeneration;
  readonly lastRotatedAt: Timestamp | null;
  readonly revokedAt: Timestamp | null;
};

export function createSecretRecord(input: {
  readonly kind: string;
  readonly source: string;
  readonly configured: boolean;
  readonly currentRef: string | null;
  readonly generation: number;
  readonly lastRotatedAt?: string | null;
  readonly revokedAt?: string | null;
}): SecretRecord {
  const kind = parseSecretKind(input.kind);
  const source = parseSecretSource(input.source);
  const generation = parseSecretGeneration(input.generation);
  const currentRef = input.currentRef === null ? null : parseSecretRef(input.currentRef);
  const lastRotatedAt = input.lastRotatedAt ?? null;
  const revokedAt = input.revokedAt ?? null;

  if (input.configured !== (currentRef !== null)) {
    throw DomainError.invalid('SecretRecord.configured');
  }
  if ((generation === 0) !== (lastRotatedAt === null)) {
    throw DomainError.invalid('SecretRecord.lastRotatedAt');
  }
  if (input.configured && generation < 1) {
    throw DomainError.invalid('SecretRecord.generation');
  }
  if (revokedAt !== null && input.configured) {
    throw DomainError.invalid('SecretRecord.revokedAt');
  }

  return {
    kind,
    source,
    configured: input.configured,
    currentRef,
    generation,
    lastRotatedAt: lastRotatedAt === null ? null : parseTimestamp(lastRotatedAt),
    revokedAt: revokedAt === null ? null : parseTimestamp(revokedAt),
  };
}

/**
 * 从未配置过的种类的规范表示。
 *
 * 有了它，三个写操作就都是**全函数**（`previous` 允许为 `null`），调用方不必在
 * use case 里为「第一次填」和「换一次」写两条分支 —— 而两条分支正是
 * 「首次写入忘了算作一次轮换」这类 bug 的温床。
 */
export function unconfiguredSecretRecord(kind: SecretKind, source: SecretSource): SecretRecord {
  return {
    kind,
    source,
    configured: false,
    currentRef: null,
    generation: parseSecretGeneration(0),
    lastRotatedAt: null,
    revokedAt: null,
  };
}

/**
 * `PUT /settings/secrets/{kind}`：写入（首次或覆盖）。
 *
 * 结果一律是 `USER` 来源 —— API 能写出来的只可能是用户自带的凭证，部署期密钥
 * 在 `assertSecretWritable` 那一行就被拒了。
 */
export function applySecretPut(
  previous: SecretRecord | null,
  input: { readonly kind: string; readonly secretRef: string; readonly now: string },
): SecretRecord {
  const kind = parseSecretKind(input.kind);
  if (previous !== null) assertSecretWritable(previous.source);
  const now = parseTimestamp(input.now);
  const generation =
    previous === null ? parseSecretGeneration(1) : nextSecretGeneration(previous.generation);
  return {
    kind,
    source: 'USER',
    configured: true,
    currentRef: parseSecretRef(input.secretRef),
    generation,
    lastRotatedAt: now,
    revokedAt: null,
  };
}

/**
 * `POST /settings/secrets/{kind}:rotate`：换一个新值，并让上一代立即失效。
 *
 * 与 `PUT` 的唯一语义差别是**要求已经配置过**：轮换一个从未设置过的密钥是范畴错误
 * （没有「上一代」可失效），报 `REQUEST_INVALID` 而不是悄悄当成首次写入 —— 后者会
 * 让 UI 上的「轮换」按钮在空状态下也能点，而它本不该出现。
 *
 * 「上一代立即失效」在这里表现为 `currentRef` 被替换、`generation` 前进：domain 不
 * 持有密文，所以它能做的、也是唯一需要做的，是让旧句柄从这条记录上消失。密文本身的
 * 销毁是 `SecretStore` 的实现细节（§6.4 的 adapter 职责）。
 */
export function rotateSecretRecord(
  previous: SecretRecord | null,
  input: { readonly secretRef: string; readonly now: string },
): SecretRecord {
  if (previous !== null) assertSecretWritable(previous.source);
  if (previous === null || !previous.configured) {
    throw DomainError.invalid('SecretRecord.configured');
  }
  return {
    ...previous,
    currentRef: parseSecretRef(input.secretRef),
    generation: nextSecretGeneration(previous.generation),
    lastRotatedAt: parseTimestamp(input.now),
  };
}

/**
 * `POST /settings/secrets/{kind}:revoke`：停用当前值。
 *
 * **幂等**：已经不可用的记录原样返回。撤销是「让它不可用」，对一个已经不可用的东西
 * 再撤销一次没有任何可观察区别，报 409 只会让重试逻辑必须区分「我撤过了」与「撤销
 * 失败」—— 而这两者对调用方来说是同一件事。
 *
 * `lastRotatedAt` 与 `generation` 都**保留**：撤销不抹掉历史，`GET` 仍然能回答
 * 「这个凭证最后一次是什么时候换的」，只是 `configured` 变成 false。抹掉它会让
 * 一次撤销顺带销毁一条审计事实。
 */
export function revokeSecretRecord(
  previous: SecretRecord | null,
  input: { readonly kind: string; readonly now: string },
): SecretRecord {
  const kind = parseSecretKind(input.kind);
  const record = previous ?? unconfiguredSecretRecord(kind, 'USER');
  assertSecretWritable(record.source);
  if (!record.configured) return record;
  return {
    ...record,
    configured: false,
    currentRef: null,
    revokedAt: parseTimestamp(input.now),
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

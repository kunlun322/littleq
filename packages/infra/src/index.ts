/**
 * `@littleq/infra` — 基础设施层。
 *
 * ZLQ-159 落地时本文件只有环境变量加载校验；ZLQ-203（D2）在此落地 §6.2 的五个基础设施
 * 端口与 grant 机制，`skeletonOnly` 随之翻为 `false`：
 * `DatabaseAdapter` / `TaskRepository` / `ObjectStore` / `SecretStore` / `RuntimePublisher`
 * 的端口契约在 `ports/*`，Vercel Blob（private）驱动在 `drivers/*`，可注入的内存替身在
 * `reference-backends.ts` 与各 `memory*.ts`。
 *
 * 边界（ZLQ-153 §1.3 / §5）——由 `config/dependency-graph.json` 强制：
 *
 * - infra 不包含业务分支；所有 SDK 类型停在本层，不外泄到 domain。
 * - `domain-and-application-no-drivers`（§5.4(4)）禁止 domain / application 导入 `drivers/*`，
 *   即本层的驱动目录只能由组合根（apps/*）在装配时触达。
 *
 * ## grant 机制**不是**第六个端口
 * `ObjectReadGrantService` 是应用语义，它**消费** `ObjectStore` 而不是与它并列（ZLQ-201
 * 裁定一 §2）。所以它在 `grant/` 而不在 `ports/`，也不进 `five-port-contract` 的五端口计数
 * —— 那个测试会对着 `ports/` 目录的实际条目数断言「恰好五个」。
 */
import { unitManifest as domainManifest } from '@littleq/domain';

export { EnvValidationError, defineEnv, loadEnvFile } from './env.js';
export type { DefineEnvOptions, EnvIssue, EnvSource } from './env.js';

export {
  INFRA_ERROR_CODES,
  InfraError,
  infraError,
  isInfraError,
  publicErrorCodeOf,
} from './errors.js';
export type { InfraErrorCode, InfraErrorContext } from './errors.js';

export {
  HEALTH_STATUSES,
  OBJECT_REF_MAX_LENGTH,
  SensitiveUrl,
  byteRangeLength,
  isHealthStatus,
  isObjectRef,
  markSensitiveUrl,
  parseByteRange,
  parseObjectRef,
  parseStoredDigest,
  parseStoredTimestamp,
  shiftTimestamp,
} from './types.js';
export type {
  ByteRange,
  HealthResult,
  HealthStatus,
  ObjectRef,
  StoredObjectMetadata,
  StoredObjectStream,
} from './types.js';

export type {
  DatabaseAdapter,
  DatabaseTransaction,
  MigrationReport,
} from './ports/database-adapter.js';
export type {
  LeaseToken,
  TaskClaimInput,
  TaskLease,
  TaskRepository,
} from './ports/task-repository.js';
export { ARTIFACT_MAX_BYTES, OBJECT_STORE_INVARIANTS } from './ports/object-store.js';
export type { GetPrivateInput, ObjectStore, PutImmutableInput } from './ports/object-store.js';
export {
  MASTER_KEY_ENV_VAR,
  SECRET_PURPOSES,
  isSecretPurpose,
  toPublicSecretMetadata,
} from './ports/secret-store.js';
export type {
  InternalSecretMetadata,
  SecretPurpose,
  SecretRevokeInput,
  SecretRotateInput,
  SecretSetInput,
  SecretStore,
} from './ports/secret-store.js';
export { RUNTIME_PREVIEW_AUDIENCE } from './ports/runtime-publisher.js';
export type { RuntimePreview, RuntimePublisher } from './ports/runtime-publisher.js';

export {
  DEFAULT_GRANT_TTL_SECONDS,
  GRANT_TOKEN_BYTES,
  GRANT_TOKEN_QUERY_PARAMETER,
  MAX_CONCURRENT_READS,
  MAX_GRANT_TTL_SECONDS,
  MIN_GRANT_TTL_SECONDS,
  ObjectReadGrantService,
  hashGrantToken,
  isGrantExpired,
} from './grant/object-read-grant.js';
export type {
  GrantLease,
  GrantRecordStore,
  IssueGrantInput,
  IssuedGrant,
  ObjectReadGrantServiceOptions,
  ObjectReadGrantUrlConfig,
  OpenGrantInput,
  StoredGrant,
} from './grant/object-read-grant.js';
export { ByteLedger, pipeThroughLedger } from './grant/byte-ledger.js';
export { InMemoryGrantRecordStore } from './grant/memory-records.js';

export {
  ArtifactSealer,
  ARTIFACTS_PREFIX,
  CHUNK_CONTENT_TYPE,
  DEFAULT_CHUNK_MAX_BYTES,
  MANIFEST_CONTENT_TYPE,
  MANIFEST_MAX_BYTES,
  chunkKey,
  chunkPrefix,
  joinChunks,
  manifestKey,
  parseManifest,
} from './object-store/artifact-sealer.js';
export type {
  ArtifactChunk,
  ArtifactManifest,
  SealArtifactInput,
} from './object-store/artifact-sealer.js';
export {
  collectStream,
  concatBytes,
  createBudgetTransform,
  idleAbortSignal,
  sha256Hex,
  streamFromBytes,
  throwIfAborted,
} from './object-store/budget.js';
export type { BudgetErrorCode, BudgetTransform, ByteAccounting } from './object-store/budget.js';
export { InMemoryObjectStore } from './object-store/memory.js';
export type { InMemoryObjectStoreOptions } from './object-store/memory.js';

export {
  MASTER_KEY_BYTES,
  NONCE_BYTES,
  SECRET_PLAINTEXT_MAX_BYTES,
  SECRET_PLAINTEXT_MIN_BYTES,
  SecretCipher,
  TAG_BYTES,
  additionalData,
  constantTimeEqual,
  loadMasterKey,
  parseMasterKey,
} from './secret-store/cipher.js';
export type { CipherContext, EncryptedSecret } from './secret-store/cipher.js';
export {
  EncryptedSecretStore,
  assertStoredSecretShape,
  newSecretRef,
  purposeOf,
} from './secret-store/store.js';
export type {
  EncryptedSecretStoreOptions,
  SecretRecordStore,
  StoredSecret,
} from './secret-store/store.js';
export { InMemorySecretRecordStore } from './secret-store/memory-records.js';

export {
  BLOB_LIST_PAGE_SIZE,
  PRIVATE_BLOB_ACCESS,
  VercelBlobObjectStore,
  mapBlobError,
} from './drivers/vercel-blob.js';
export type {
  BlobDigestIndex,
  BlobGetOptions,
  BlobGetResult,
  BlobHeadResult,
  BlobListResult,
  BlobPutOptions,
  BlobPutResult,
  BlobSdkSurface,
  VercelBlobObjectStoreOptions,
} from './drivers/vercel-blob.js';

export {
  InMemoryDatabaseAdapter,
  InMemoryRuntimePublisher,
  InMemoryTaskRepository,
} from './reference-backends.js';
export type {
  InMemoryDatabaseAdapterOptions,
  InMemoryMigration,
  InMemoryRuntimePublisherOptions,
  PreviewGrantIssuer,
} from './reference-backends.js';

export {
  DENY_LISTED_FIELD_NAME_PARTS,
  LOG_LEVELS,
  REDACTED,
  createRedactingLogger,
  fingerprint,
  redactRecord,
  redactText,
  redactUrlText,
} from './log/redaction.js';
export type { InfraLogger, LogFields, LogRecord, LogLevel, LogSink } from './log/redaction.js';

export const UNIT_ID = '@littleq/infra';

export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'infra';
  readonly spec: string;
  readonly skeletonOnly: boolean;
  /** 本单元装配时所依赖的下层单元，供组合根启动自检。 */
  readonly dependsOn: readonly string[];
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'infra',
  spec: 'ZLQ-153 §1.3 packages/infra',
  skeletonOnly: false,
  dependsOn: [domainManifest.unitId],
};

/**
 * 就绪声明的形状（ZLQ-194 §9.2 规则 3）。
 *
 * 与 `@littleq/domain` / `@littleq/api-contract` 的同名类型各自声明、互不 import，理由与那两个
 * 包里的注释逐字相同：不为一个纯治理元数据接口去背一条跨单元依赖边。
 */
export type UnitReadiness = {
  readonly status: 'skeleton' | 'implemented';
  /** 本单元对外承诺的能力名。稳定标识符，不是文件名、不是测试数量（§9.2 规则 6）。 */
  readonly capabilities: readonly string[];
  /** 能力名 → 本单元 test 目录下的验收测试路径。每条能力都必须有映射。 */
  readonly acceptanceTests: Readonly<Record<string, string>>;
};

/**
 * 十条能力覆盖 §6.2 的五个端口、§14 的六项未实证点，以及裁定一 §2–§6 的 grant 不变量。
 *
 * `five-port-contract` 是 `tools/unit-readiness-contract.json` 给本单元点名的 `requiredProofs`，
 * 缺了它门禁 3 直接红。其余九条是把「端口注释里承诺的行为」变成可红可绿的断言：TypeScript
 * 的 `implements` 只能证明**方法名对得上**，证明不了「回滚之后什么都没提交」「第 9 路被拒」。
 */
export const unitReadiness: UnitReadiness = {
  status: 'implemented',
  capabilities: [
    'five-port-contract',
    'database-transaction-atomicity',
    'task-lease-cas',
    'object-store-private-access',
    'object-store-size-boundary',
    'object-read-grant-concurrency',
    'object-read-grant-expiry',
    'artifact-chunked-sealing',
    'secret-store-encrypted-lifecycle',
    'sensitive-url-log-redaction',
  ],
  acceptanceTests: {
    'five-port-contract': 'test/five-port-contract.test.ts',
    'database-transaction-atomicity': 'test/database-transaction-atomicity.test.ts',
    'task-lease-cas': 'test/task-lease-cas.test.ts',
    'object-store-private-access': 'test/object-store-private-access.test.ts',
    'object-store-size-boundary': 'test/object-store-size-boundary.test.ts',
    'object-read-grant-concurrency': 'test/object-read-grant-concurrency.test.ts',
    'object-read-grant-expiry': 'test/object-read-grant-expiry.test.ts',
    'artifact-chunked-sealing': 'test/artifact-chunked-sealing.test.ts',
    'secret-store-encrypted-lifecycle': 'test/secret-store-encrypted-lifecycle.test.ts',
    'sensitive-url-log-redaction': 'test/sensitive-url-log-redaction.test.ts',
  },
};

/**
 * 端口 4／5：`SecretStore` —— 成人自带凭据的加密存取（ZLQ-194 §6.2、ZLQ-201 裁定一 §7）。
 *
 * ## 为什么是「运行期可写」
 * 用户已于 2026-10-19T16:34:30Z 把 D5 定为**方案 B**（成人 BYO：首次登录自填 QCA PAT 与百炼
 * key）。所以 §6.2 那句「若 D5 选 BYO，再实现 `app-encrypted` 运行期写入」的条件已经成立，
 * `set` / `rotate` / `revoke` 三个写操作是本端口的必备面，不是可选项。
 *
 * ## 与冻结契约的对齐（D1 已落库，本单不改 `contracts/**`）
 * 三个写操作在 OpenAPI 快照里的成功语义都是 **204，只写不回显**：
 * `PUT /settings/secrets/{kind}`（`putSecret`）、`POST /settings/secrets/{kind}:rotate`
 * （`rotateSecret`）、`POST /settings/secrets/{kind}:revoke`（`revokeSecret`）。
 * 端口层的对应事实是：`revoke` 返回 `void`；`set` / `rotate` 只返回一个**不可逆的** `SecretRef`
 * （既不是明文，也不是密文）；`metadata` 里没有 plaintext / ciphertext / nonce / tag 任何一项。
 * wire 上没有 `expectedVersion` 字段，所以 CAS 的期望版本由 `apps/api`（D5）在**同一个请求
 * 内**从当前元数据读出来再传进来；三个写操作都已经声明了 409，正对应本层的
 * `SECRET_VERSION_CONFLICT` / `SECRET_ALREADY_CONFIGURED` → `REVISION_CONFLICT`。
 *
 * ## 加密形状
 * AES-256-GCM，每条记录一个**随机 96-bit nonce**，AAD 绑定 `ownerId + kind + version`，
 * 数据库只存密文 / nonce / tag / keyVersion，根密钥只从环境变量 `LITTLEQ_MASTER_KEY` 读取
 * （本文件只出现变量**名**；值绝不落盘、不进日志、不进测试快照）。
 */
import {
  type SecretKind,
  type SecretMetadata,
  type SecretRef,
  type Timestamp,
  createSecretMetadata,
} from '@littleq/domain';

/** 根密钥的**环境变量名**。值不出现在仓库里的任何位置。 */
export const MASTER_KEY_ENV_VAR = 'LITTLEQ_MASTER_KEY';

export const SECRET_PURPOSES = ['qca-call', 'bailian-call'] as const;

export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

export function isSecretPurpose(value: string): value is SecretPurpose {
  return (SECRET_PURPOSES as readonly string[]).includes(value);
}

/**
 * 端口内部的元数据：比 wire 上的 `SecretMetadata` 多出 `version` / `revokedAt`。
 *
 * 这两项**不上线** —— 冻结契约里的 `SecretMetadata` 是 `{kind, configured, lastRotatedAt}`
 * 且 `additionalProperties: false`，加字段属于破坏性变更。跨 HTTP 边界前必须过
 * `toPublicSecretMetadata` 投影一次，测试会断言投影结果里没有多余键。
 */
export interface InternalSecretMetadata {
  readonly configured: boolean;
  /** 与 domain 的 `SecretGeneration` 同值；CAS 的 `expectedVersion` 比的就是它。 */
  readonly version: number | undefined;
  readonly rotatedAt: Timestamp | undefined;
  readonly revokedAt: Timestamp | undefined;
}

export interface SecretSetInput {
  readonly ownerId: string;
  readonly kind: SecretKind;
  readonly plaintext: Uint8Array;
}

export interface SecretRotateInput extends SecretSetInput {
  /** 读到的当前版本；不匹配 ⇒ `SECRET_VERSION_CONFLICT`（对外 409）。 */
  readonly expectedVersion: number;
}

export interface SecretRevokeInput {
  readonly ownerId: string;
  readonly kind: SecretKind;
  readonly expectedVersion: number;
}

export interface SecretStore {
  /**
   * 首次写入。未配置时创建；同值重试幂等成功；已配置且值不同 ⇒ `SECRET_ALREADY_CONFIGURED`
   * （调用方该走 `rotate`，而不是让 `set` 悄悄覆盖掉一个正在被使用的凭据）。
   */
  set(input: SecretSetInput): Promise<SecretRef>;

  /** 轮换：版本 CAS + `generation` 前进；旧版本立即不可读。 */
  rotate(input: SecretRotateInput): Promise<SecretRef>;

  /** 撤销：版本 CAS；幂等（已经未配置的记录再撤一次不算失败，也不改版本）。 */
  revoke(input: SecretRevokeInput): Promise<void>;

  /**
   * 取明文，只给**当次调用**用。`purpose` 与 `kind` 不匹配 ⇒ `SECRET_PURPOSE_MISMATCH`：
   * 把 QCA PAT 当百炼 key 发出去是一次跨 provider 的凭据泄漏，必须在端口层就挡掉。
   */
  read(ref: SecretRef, purpose: SecretPurpose): Promise<Uint8Array>;

  /** 元数据；结构上没有任何可以装明文/密文的字段。 */
  metadata(ownerId: string, kind: SecretKind): Promise<InternalSecretMetadata>;
}

/**
 * 内部元数据 → 冻结契约的 `SecretMetadata`。
 *
 * 做成一个显式函数而不是让 `InternalSecretMetadata` 直接「结构兼容」，是因为后者会在
 * 多字段的方向上退化：`SecretMetadata` 的键集合被 `packages/api-contract` 的 schema 测试
 * 钉死为 `['kind','configured','lastRotatedAt']`，任何多出来的键跨 HTTP 边界就是破坏性变更。
 * 这里只挑三项、并把内部的 `version` / `revokedAt` 丢掉，测试会断言投影结果的键集合。
 */
export function toPublicSecretMetadata(
  kind: SecretKind,
  internal: InternalSecretMetadata,
): SecretMetadata {
  return createSecretMetadata({
    kind,
    configured: internal.configured,
    lastRotatedAt: internal.rotatedAt ?? null,
  });
}

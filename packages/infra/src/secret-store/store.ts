/**
 * `SecretStore` 的加密实现（ZLQ-194 §6.2 / §6.4、ZLQ-201 裁定一 §7）。
 *
 * ## 分工：状态机归 domain，密文归 infra
 * `configured` / `generation` / `lastRotatedAt` / `revokedAt` 之间的全部不变量都由
 * `packages/domain` 的 `applySecretPut` / `rotateSecretRecord` / `revokeSecretRecord` 强制，
 * 本文件一行都不重抄。infra 只负责三件 domain 不持有的事：加密、密文的存放与销毁、以及
 * **并发写的版本 CAS**。这样「撤销后重新填入」与「从未配置过」在数据上不会混为一谈 ——
 * 那条区分是 domain 的 `generation` 单调递增给的，重抄一遍就会抄错。
 *
 * ## CAS 比的是 `generation`
 * `expectedVersion` 就是调用方读到的 `generation`。选它而不是选一个自增行版本，是因为
 * `generation` 撤销后**不归零**（domain 的显式不变量），于是「读到 3、写的时候别人已经
 * 撤销」这种情况一定会被发现，而一个会被撤销重置的版本号则会漏掉它。
 *
 * ## 旧代立即不可读
 * 轮换与撤销都会把旧的 `SecretRef` 从索引里摘掉，且密文随 `save` 被 `null` 覆盖。所以
 * 「拿旧 ref 再读一次」得到的是与「这个 ref 从未存在过」**完全相同**的 404 —— 不给探测者
 * 任何可区分的信号（裁定一不变量 1）。
 */
import { randomBytes } from 'node:crypto';

import {
  type SecretKind,
  type SecretRecord,
  type SecretRef,
  type Timestamp,
  applySecretPut,
  nextSecretGeneration,
  parseSecretRef,
  revokeSecretRecord,
  rotateSecretRecord,
  unconfiguredSecretRecord,
} from '@littleq/domain';

import { infraError } from '../errors.js';
import {
  type InternalSecretMetadata,
  type SecretPurpose,
  type SecretRevokeInput,
  type SecretRotateInput,
  type SecretSetInput,
  type SecretStore,
} from '../ports/secret-store.js';
import {
  type EncryptedSecret,
  SecretCipher,
  assertPlaintextLength,
  constantTimeEqual,
} from './cipher.js';

/** 一条凭据记录在存储里的全部形态：领域事实 + 密文。**没有明文，也没有根密钥。** */
export interface StoredSecret {
  readonly record: SecretRecord;
  /** `record.configured === false` 时必须为 `null`：撤销即销毁密文（§6.4 adapter 职责）。 */
  readonly secret: EncryptedSecret | null;
}

/**
 * 持久化端口。D5 用 Postgres adapter 实现它；本单同时给一个内存实现供测试。
 *
 * `save` 的 CAS 语义是**返回值**而不是异常：冲突返回 `null`，让调用方决定映射成哪个错误码
 * （`SECRET_VERSION_CONFLICT` → 409）。这与 `TaskRepository` 的 `expectedRevision` 约定一致。
 */
export interface SecretRecordStore {
  load(ownerId: string, kind: SecretKind): Promise<StoredSecret | null>;
  /** `expectedVersion` 是调用方读到的 `generation`（从未写入过则为 0）；不匹配返回 `null`。 */
  save(
    ownerId: string,
    stored: StoredSecret,
    expectedVersion: number,
  ): Promise<StoredSecret | null>;
  /** 只解析**当前**那一代的 ref；被轮换/撤销掉的 ref 返回 `null`。 */
  findByRef(
    ref: SecretRef,
  ): Promise<{ readonly ownerId: string; readonly stored: StoredSecret } | null>;
}

/** `SecretRef` 的形状：`sec_` + 32 位十六进制。 */
const SECRET_REF_PREFIX = 'sec_';
const SECRET_REF_RANDOM_BYTES = 16;

/**
 * 生成一个不透明句柄。
 *
 * 刻意**不含** `.`、`:`、`=`、`?`、`&`：domain 的 `parseSecretRef` 会跑一遍敏感文本形状
 * 检查，三段式点分（JWT 形状）与 `token=` 这类查询参数都会被拒。句柄本身不是秘密（它只是
 * 密文的位置），但它必须能安全地出现在审计日志里，所以形状上先排除掉一切像凭据的东西。
 */
export function newSecretRef(): SecretRef {
  return parseSecretRef(
    `${SECRET_REF_PREFIX}${randomBytes(SECRET_REF_RANDOM_BYTES).toString('hex')}`,
  );
}

/**
 * 取出「已配置」记录的当前句柄。
 *
 * domain 的不变量保证 `configured === (currentRef !== null)`，所以这里只可能是
 * 「调用方在没配置的记录上要句柄」这一种编程错误。用 `INTERNAL_ERROR` 而不是静默返回
 * `null`：一个 204 的写操作如果真的没有句柄可返回，那已经是存储层坏掉了，不该被吞掉。
 */
function requireCurrentRef(record: SecretRecord): SecretRef {
  if (record.currentRef === null) throw infraError('SECRET_DECRYPT_FAILED');
  return record.currentRef;
}

export interface EncryptedSecretStoreOptions {
  readonly cipher: SecretCipher;
  readonly records: SecretRecordStore;
  readonly now: () => Timestamp;
}

export class EncryptedSecretStore implements SecretStore {
  readonly #cipher: SecretCipher;
  readonly #records: SecretRecordStore;
  readonly #now: () => Timestamp;

  constructor(options: EncryptedSecretStoreOptions) {
    this.#cipher = options.cipher;
    this.#records = options.records;
    this.#now = options.now;
  }

  async set(input: SecretSetInput): Promise<SecretRef> {
    assertPlaintextLength(input.plaintext.byteLength);
    const current = await this.#records.load(input.ownerId, input.kind);
    const expectedVersion = current?.record.generation ?? 0;

    if (current !== null && current.record.configured) {
      // 已配置：同值重试幂等成功，异值必须走 rotate。这里**必须**解密一次才能判断，
      // 而解密只在端口内部发生，明文不出这个方法。
      const existing = this.#decrypt(current, input.ownerId);
      if (constantTimeEqual(existing, input.plaintext)) {
        return requireCurrentRef(current.record);
      }
      throw infraError('SECRET_ALREADY_CONFIGURED', { secretKind: input.kind });
    }

    const version = expectedVersion + 1;
    const encrypted = this.#cipher.encrypt(input.plaintext, {
      ownerId: input.ownerId,
      kind: input.kind,
      version,
    });
    const secretRef = newSecretRef();
    const record = applySecretPut(current?.record ?? null, {
      kind: input.kind,
      secretRef,
      now: this.#now(),
    });
    await this.#commit(input.ownerId, { record, secret: encrypted }, expectedVersion);
    return requireCurrentRef(record);
  }

  async rotate(input: SecretRotateInput): Promise<SecretRef> {
    assertPlaintextLength(input.plaintext.byteLength);
    const current = await this.#records.load(input.ownerId, input.kind);
    const expectedVersion = current?.record.generation ?? 0;
    if (input.expectedVersion !== expectedVersion) {
      throw infraError('SECRET_VERSION_CONFLICT', { secretKind: input.kind });
    }
    if (current === null || !current.record.configured) {
      throw infraError('SECRET_NOT_CONFIGURED', { secretKind: input.kind });
    }

    const version = nextSecretGeneration(current.record.generation);
    const encrypted = this.#cipher.encrypt(input.plaintext, {
      ownerId: input.ownerId,
      kind: input.kind,
      version,
    });
    const secretRef = newSecretRef();
    const record = rotateSecretRecord(current.record, { secretRef, now: this.#now() });
    await this.#commit(input.ownerId, { record, secret: encrypted }, expectedVersion);
    return requireCurrentRef(record);
  }

  async revoke(input: SecretRevokeInput): Promise<void> {
    const current = await this.#records.load(input.ownerId, input.kind);
    const expectedVersion = current?.record.generation ?? 0;
    if (input.expectedVersion !== expectedVersion) {
      throw infraError('SECRET_VERSION_CONFLICT', { secretKind: input.kind });
    }
    const record = revokeSecretRecord(current?.record ?? null, {
      kind: input.kind,
      now: this.#now(),
    });
    // domain 对「已经不可用」的记录原样返回同一个对象：此时不写库，撤销是幂等的，
    // 也不会因为多写一次而让并发撤销里的一方吃到假的 409。
    if (current !== null && current.record === record) return;
    await this.#commit(input.ownerId, { record, secret: null }, expectedVersion);
  }

  async read(ref: SecretRef, purpose: SecretPurpose): Promise<Uint8Array> {
    const found = await this.#records.findByRef(ref);
    if (found === null) throw infraError('SECRET_NOT_CONFIGURED');
    const { ownerId, stored } = found;
    if (purposeOf(stored.record.kind) !== purpose) {
      throw infraError('SECRET_PURPOSE_MISMATCH', { secretKind: stored.record.kind });
    }
    return this.#decrypt(stored, ownerId);
  }

  async metadata(ownerId: string, kind: SecretKind): Promise<InternalSecretMetadata> {
    const current = await this.#records.load(ownerId, kind);
    if (current === null) {
      return { configured: false, version: undefined, rotatedAt: undefined, revokedAt: undefined };
    }
    return {
      configured: current.record.configured,
      version: current.record.generation,
      rotatedAt: current.record.lastRotatedAt ?? undefined,
      revokedAt: current.record.revokedAt ?? undefined,
    };
  }

  /** `configured` 却拿不到密文，是存储自身的不变量被破坏，按解密失败处理（对外 500，不回显）。 */
  #decrypt(stored: StoredSecret, ownerId: string): Uint8Array {
    const { record, secret } = stored;
    if (!record.configured) {
      const code = record.revokedAt === null ? 'SECRET_NOT_CONFIGURED' : 'SECRET_REVOKED';
      throw infraError(code, { secretKind: record.kind });
    }
    if (secret === null) throw infraError('SECRET_DECRYPT_FAILED');
    return this.#cipher.decrypt(secret, {
      ownerId,
      kind: record.kind,
      version: record.generation,
    });
  }

  async #commit(ownerId: string, stored: StoredSecret, expectedVersion: number): Promise<void> {
    assertStoredSecretShape(stored);
    const saved = await this.#records.save(ownerId, stored, expectedVersion);
    if (saved === null) {
      throw infraError('SECRET_VERSION_CONFLICT', { secretKind: stored.record.kind });
    }
  }
}

/** `configured === (secret !== null)`：与 domain 的 `configured === (currentRef !== null)` 对齐。 */
export function assertStoredSecretShape(stored: StoredSecret): void {
  if (stored.record.configured !== (stored.secret !== null)) {
    throw infraError('SECRET_DECRYPT_FAILED');
  }
}

const PURPOSE_BY_KIND: Readonly<Record<SecretKind, SecretPurpose>> = {
  QCA_PAT: 'qca-call',
  BAILIAN_API_KEY: 'bailian-call',
};

export function purposeOf(kind: SecretKind): SecretPurpose {
  return PURPOSE_BY_KIND[kind];
}

/**
 * 从未配置过的规范记录，给内存实现与测试用。
 *
 * 转发 domain 的 `unconfiguredSecretRecord` 而不是自己造一个字面量：domain 那一份是
 * 四个不变量的事实源，这里再写一遍只会写出第二套（而且迟早不一致）。
 */
export function unconfiguredStoredSecret(kind: SecretKind): StoredSecret {
  return { record: unconfiguredSecretRecord(kind, 'USER'), secret: null };
}

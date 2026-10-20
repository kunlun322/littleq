/**
 * 凭据的加密原语（ZLQ-194 §6.2 / §6.4、ZLQ-201 裁定一 §7）。
 *
 * ## 三条不能靠自觉的规矩，都写成了结构
 *
 * 1. **nonce 不可传入**。GCM 在同一把密钥下重用 nonce 是灾难性的（可以伪造认证标签、
 *    甚至恢复明文），而「每条记录随机 96-bit nonce」这句话如果只写在文档里，第一个为了
 *    让测试可重复而传固定 nonce 的调用点就会把它废掉。所以 `encrypt` 根本不接受 nonce
 *    参数，随机数在函数内部生成。测试要可重复，靠的是断言**密文形状与可解密性**，不是
 *    断言一段固定密文。
 * 2. **AAD 绑定 `ownerId + kind + version`**，并且是**长度前缀**的规范编码。少了长度前缀，
 *    `("ab","QCA_PAT",1)` 与 `("a","bQCA_PAT",1)` 这类拼接就能撞出同一段 AAD，于是把
 *    A 用户的密文挪到 B 用户名下也能通过认证 —— 绑定就白绑了。
 * 3. **解密失败只有一个码**。`SECRET_DECRYPT_FAILED` 不区分「标签不对」「AAD 不对」
 *    「密文被截断」，因为区分它们等于给攻击者一个 oracle。
 *
 * ## 根密钥
 * 只从环境变量 `LITTLEQ_MASTER_KEY` 读取（本文件只出现变量**名**）。值绝不落盘、不进日志、
 * 不进测试快照；测试里的密钥是对一个非凭据字符串取 sha256 得到的，形状合法但不是秘密。
 *
 * 编码要求（部署侧必须遵守，D5/ZLQ-157 生成时用 `openssl rand -hex 32`）：
 * **64 位十六进制**，或**解码后正好 32 字节的 base64**。其它一律拒绝，且**不做 trim** ——
 * 多一个换行就让部署在启动阶段大声失败，好过悄悄用一把和写入时不同的密钥去解密。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import type { SecretKind } from '@littleq/domain';

import { infraError } from '../errors.js';
import type { EnvSource } from '../env.js';
import { MASTER_KEY_ENV_VAR } from '../ports/secret-store.js';

/** AES-256 的密钥长度。 */
export const MASTER_KEY_BYTES = 32;
/** GCM 推荐的 96-bit nonce：这个长度下不需要额外做 GHASH，且是唯一被 NIST SP 800-38D 直接定义的。 */
export const NONCE_BYTES = 12;
/** GCM 认证标签长度（128-bit，完整长度）。 */
export const TAG_BYTES = 16;

/**
 * 明文字节上下界。上界取冻结契约 `SecretValue.maxLength` 的 8192，让端口层与 wire 层
 * 在同一个数字上失败，而不是 wire 放行 8192、端口再拒一次造成两套语义。
 */
export const SECRET_PLAINTEXT_MIN_BYTES = 1;
export const SECRET_PLAINTEXT_MAX_BYTES = 8192;

const MASTER_KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const AAD_DOMAIN_SEPARATOR = 'littleq.secret.aad.v1';

/** 存进数据库的全部字段：密文 / nonce / tag / keyVersion，**没有明文，也没有根密钥**。 */
export interface EncryptedSecret {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
  readonly keyVersion: number;
}

/** AAD 绑定的三件事：这条密文属于谁、是哪一类凭据、是第几代。 */
export interface CipherContext {
  readonly ownerId: string;
  readonly kind: SecretKind;
  readonly version: number;
}

/**
 * 规范化的 AAD。
 *
 * 长度前缀 + 换行分隔，`ownerId` 里就算含换行也无法把后面的字段「挤位」。`version` 用
 * 十进制无前导零，避免 `1` 与 `01` 生成两段不同的 AAD 却指向同一代。
 */
export function additionalData(context: CipherContext): Uint8Array {
  assertContext(context);
  const parts = [
    AAD_DOMAIN_SEPARATOR,
    `${context.ownerId.length}:${context.ownerId}`,
    `${context.kind.length}:${context.kind}`,
    `v:${context.version}`,
  ];
  return new TextEncoder().encode(parts.join('\n'));
}

function assertContext(context: CipherContext): void {
  if (typeof context.ownerId !== 'string' || context.ownerId.length === 0) {
    throw infraError('SECRET_CONTEXT_INVALID');
  }
  if (typeof context.kind !== 'string' || context.kind.length === 0) {
    throw infraError('SECRET_CONTEXT_INVALID');
  }
  if (!Number.isSafeInteger(context.version) || context.version < 1) {
    throw infraError('SECRET_CONTEXT_INVALID');
  }
}

/**
 * 解析根密钥原文。全零密钥被显式拒绝：它是「占位值」的典型形状，接受它等于允许一个
 * 部署在毫无保护的情况下声称自己配好了主密钥。
 */
export function parseMasterKey(raw: string): Uint8Array {
  let key: Uint8Array;
  if (MASTER_KEY_HEX_PATTERN.test(raw)) {
    key = new Uint8Array(MASTER_KEY_BYTES);
    for (let index = 0; index < MASTER_KEY_BYTES; index += 1) {
      key[index] = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);
    }
  } else {
    const decoded = Buffer.from(raw, 'base64');
    // `Buffer.from(..., 'base64')` 对非法输入是**宽容**的（悄悄丢弃非法字符），所以必须
    // 反向校验：重新编码后要与原文一致，才能确认这不是一段被截断或掺了字符的 base64。
    if (decoded.byteLength !== MASTER_KEY_BYTES || decoded.toString('base64') !== raw) {
      throw infraError('MASTER_KEY_UNAVAILABLE');
    }
    key = new Uint8Array(decoded);
  }
  if (key.every((byte) => byte === 0)) throw infraError('MASTER_KEY_UNAVAILABLE');
  return key;
}

/**
 * 从环境里取根密钥。
 *
 * `env` 必须显式传入（不在这里读 `process.env`）：隐藏的全局读取会让测试之间互相污染，
 * 也会让「这个进程到底用没用生产密钥」变成一件需要翻代码才能回答的事。
 */
export function loadMasterKey(env: EnvSource, keyVersion = 1): SecretCipher {
  const raw = env[MASTER_KEY_ENV_VAR];
  if (raw === undefined || raw === '') throw infraError('MASTER_KEY_UNAVAILABLE');
  return new SecretCipher(parseMasterKey(raw), keyVersion);
}

export class SecretCipher {
  readonly #key: Uint8Array;
  readonly keyVersion: number;

  constructor(key: Uint8Array, keyVersion = 1) {
    if (key.byteLength !== MASTER_KEY_BYTES) throw infraError('MASTER_KEY_UNAVAILABLE');
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      throw infraError('MASTER_KEY_UNAVAILABLE');
    }
    this.#key = key;
    this.keyVersion = keyVersion;
  }

  encrypt(plaintext: Uint8Array, context: CipherContext): EncryptedSecret {
    assertPlaintextLength(plaintext.byteLength);
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(additionalData(context));
    const ciphertext = new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final()]));
    return {
      ciphertext,
      nonce,
      tag: new Uint8Array(cipher.getAuthTag()),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(secret: EncryptedSecret, context: CipherContext): Uint8Array {
    assertCipherShape(secret);
    if (secret.keyVersion !== this.keyVersion) throw infraError('MASTER_KEY_VERSION_MISMATCH');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, secret.nonce);
    try {
      decipher.setAAD(additionalData(context));
      decipher.setAuthTag(secret.tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext)),
        decipher.final(),
      ]);
      return new Uint8Array(plaintext);
    } catch {
      throw infraError('SECRET_DECRYPT_FAILED');
    }
  }

  /** 密钥指纹：sha256 的前 12 位。**唯一**允许出现在日志里的密钥相关信息。 */
  keyFingerprint(): string {
    return createHash('sha256').update(this.#key).digest('hex').slice(0, 12);
  }
}

export function assertPlaintextLength(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < SECRET_PLAINTEXT_MIN_BYTES ||
    byteLength > SECRET_PLAINTEXT_MAX_BYTES
  ) {
    throw infraError('SECRET_PLAINTEXT_OUT_OF_RANGE');
  }
}

function assertCipherShape(secret: EncryptedSecret): void {
  if (secret.nonce.byteLength !== NONCE_BYTES || secret.tag.byteLength !== TAG_BYTES) {
    throw infraError('SECRET_DECRYPT_FAILED');
  }
  if (secret.ciphertext.byteLength === 0) throw infraError('SECRET_DECRYPT_FAILED');
}

/**
 * 常量时间比较密文形状之外的东西用得上（例如 grant token 的散列比对）。
 *
 * 放在这里而不是各调用点自己写 `===`：`===` 对字符串是短路的，比较耗时会随前缀匹配长度
 * 变化，这正是一个远程时序侧信道。长度不同时 `timingSafeEqual` 会抛，所以先比长度。
 */
export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const left = typeof a === 'string' ? new TextEncoder().encode(a) : a;
  const right = typeof b === 'string' ? new TextEncoder().encode(b) : b;
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/**
 * `RandomSource` 与 `PasswordHasher` 的 Node 实现（ZLQ-221 §4.3）。
 *
 * ## 为什么这两个东西住在组合根
 *
 * `packages/application` 把它们声明成端口（`usecases/ports.ts`），自己**不读时钟、不做
 * IO**；`packages/infra` 的 `password/scrypt.ts` 写了同一份实现，但它的 barrel
 * （`packages/infra/src/index.ts`）**没有**把 `hashPassword` / `verifyPassword` 放出来，
 * 也没有开放 `./password/*` 子路径导出。PM 裁定 ③ 因此落在「在 `apps/api` 内重述」这一
 * 支：组合根是唯一同时看得见端口声明与 `node:crypto` 的单元。
 *
 * ⚠️ **已申报的重复风险**：scrypt 的成本参数（N/r/p、salt 长度、输出长度、maxmem）在这里
 * 与 `packages/infra/src/password/scrypt.ts` 各写了一份。两边必须逐字相同，否则受控初始化
 * 命令写进 `password_credentials` 的行无法被本文件的 `verify` 认出。收敛到单一事实源需要
 * 改 infra 的 barrel 或加子路径导出，那是架构裁定，不在本单文件面内。
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { newUuidV7 } from '@littleq/infra';
import type { PasswordCredentialRecord, PasswordHasher, RandomSource } from '@littleq/application';

/** §1.3 基线：salt 16 随机 byte。与 `packages/infra` 的 `PASSWORD_SALT_BYTES` 同值。 */
export const PASSWORD_SALT_BYTES = 16;
/** §1.3 基线：输出 64 byte。与 `packages/infra` 的 `PASSWORD_HASH_BYTES` 同值。 */
export const PASSWORD_HASH_BYTES = 64;
/** §1.3 基线：N=32768，必须是 2 的幂。 */
export const SCRYPT_N = 32_768;
/** §1.3 基线：r=8。 */
export const SCRYPT_R = 8;
/** §1.3 基线：p=1。 */
export const SCRYPT_P = 1;
/**
 * §1.3 基线：maxmem 64MiB。**是下限不是余量** —— scrypt 的内存代价是 `128 * N * r`
 * = 32MiB，而 Node 的默认 `maxmem` 也是 32MiB 且要求严格大于，默认值下这组基线跑不起来
 * （`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`）。
 */
export const SCRYPT_MAXMEM_BYTES = 64 * 1024 * 1024;

/** 会话令牌与幂等键的字节长度。256 bit 的熵，十六进制后 64 字符。 */
export const SESSION_TOKEN_BYTES = 32;

export function nodeRandomSource(): RandomSource {
  return {
    bytes(length: number): Uint8Array {
      return new Uint8Array(randomBytes(length));
    },
    sha256(input: Uint8Array | string): Uint8Array {
      const hash = createHash('sha256');
      hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input));
      return new Uint8Array(hash.digest());
    },
    uuidV7(): string {
      return newUuidV7();
    },
  };
}

/** 生成一枚新的会话令牌明文。落库的只有它的 SHA-256（`account_sessions.token_hash`）。 */
export function newSessionToken(random: RandomSource): string {
  return Buffer.from(random.bytes(SESSION_TOKEN_BYTES)).toString('hex');
}

function scryptAsync(
  plaintext: string,
  salt: Uint8Array,
  params: { readonly n: number; readonly r: number; readonly p: number; readonly keylen: number },
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      plaintext,
      Buffer.from(salt),
      params.keylen,
      { N: params.n, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM_BYTES },
      (error, derived) => {
        if (error !== null) reject(error);
        else resolve(new Uint8Array(derived));
      },
    );
  });
}

/**
 * 校验按**随行参数**重算，不使用全局常量：提高成本参数时不需要重算既有哈希。
 *
 * `timingSafeEqual` 在长度不等时**抛异常**而不是返回 `false`，所以先比长度 —— 一条畸形的
 * 库行不该变成一个未捕获异常，而该是一次干脆的「校验不通过」。
 */
export function scryptPasswordHasher(): PasswordHasher {
  return {
    async verify(plaintext: string, credential: PasswordCredentialRecord): Promise<boolean> {
      if (credential.hashBytes !== credential.passwordHash.byteLength) return false;
      const derived = await scryptAsync(plaintext, credential.salt, {
        n: credential.scryptN,
        r: credential.scryptR,
        p: credential.scryptP,
        keylen: credential.hashBytes,
      });
      if (derived.byteLength !== credential.passwordHash.byteLength) return false;
      return timingSafeEqual(Buffer.from(derived), Buffer.from(credential.passwordHash));
    },
  };
}

/**
 * 给受控初始化与测试夹具用的口令哈希。
 *
 * ⚠️ 生产部署的口令**不经过这里**：`packages/infra/src/init/bootstrap-accounts.ts` 的交互
 * 式隐藏输入才是唯一入口。本函数只服务「测试要一个真账号」这一件事，且**从不打印返回值里
 * 的明文**。
 */
export async function hashPasswordWith(
  random: RandomSource,
  plaintext: string,
): Promise<PasswordCredentialRecord> {
  const salt = random.bytes(PASSWORD_SALT_BYTES);
  const passwordHash = await scryptAsync(plaintext, salt, {
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: PASSWORD_HASH_BYTES,
  });
  return {
    salt,
    passwordHash,
    scryptN: SCRYPT_N,
    scryptR: SCRYPT_R,
    scryptP: SCRYPT_P,
    hashBytes: PASSWORD_HASH_BYTES,
  };
}

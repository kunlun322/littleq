/**
 * 口令哈希原语（ZLQ-216 §1.3）。
 *
 * §1.3 逐字基线：**Node 异步 scrypt**，salt 16 随机 byte、N=32768 / r=8 / p=1、输出
 * 64 byte、maxmem 64MiB；**参数随记录保存**，校验用 `timingSafeEqual`，不引入密码库、
 * 不引入额外账号协议。本文件只做这一件事，不含任何账号/会话业务分支。
 *
 * ## 四个数字不是风格选择
 *
 * - `maxmem = 64MiB` 是**下限而非余量**。scrypt 的内存代价是 `128 * N * r` byte，基线
 *   参数正好等于 32MiB，而 Node 的默认 `maxmem` 也是 32MiB 且要求严格大于 —— 实测在
 *   默认值下这组基线**根本跑不起来**，直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS: memory
 *   limit exceeded`。§1.3 写下 64MiB 是为了让基线能执行，不是为了宽松。
 * - **异步而非 `scryptSync`**。一次基线派生在现代 CPU 上是几十到上百毫秒；同步版本会把
 *   整个事件循环钉住那么久，在 Serverless 上等同于一次自造的拒绝服务。
 * - `N = 32768` 必须是 2 的幂（scrypt 的定义要求），`CHECK (scrypt_n > 1)` 只是 DDL 侧
 *   的粗筛，"是不是 2 的幂"由本文件在**读回记录时**再判一次。
 * - 输出 64 byte 与 `PASSWORD_HASH_BYTES` 同源，写进 `hash_bytes` 列只是为了让读回时能
 *   自证形状，不是允许调用方改它。
 *
 * ## 三条结构性保证（照抄 `secret-store/cipher.ts` 的做法：不靠调用方自觉）
 *
 * 1. **salt 不可传入**。`hashPassword` 没有 salt 参数，随机数在函数内部生成。若允许传入，
 *    第一个"为了让测试可重复"而固定 salt 的调用点就会让整张表的口令共享一个 salt，
 *    彩虹表与批量破解的代价立刻降到单条的水平。测试要可重复，靠断言**形状、可校验性与
 *    同口令不同 salt 得到不同哈希**，不是断言一段固定哈希。
 * 2. **校验用记录里保存的参数**，而不是当前基线常量。这是"参数随记录保存"的全部意义：
 *    将来抬高 N 时，老记录仍然可校验，用户下一次改口令才升级到新参数。若校验硬编码当前
 *    基线，一次参数调整就会让全体存量用户瞬间无法登录。
 * 3. **`InfraError` 上没有可塞原文的字段**（见 `../errors.ts` 文件头），所以"口令不进日志"
 *    不依赖每个调用点记得脱敏。本文件自己也**从不**把明文、salt、哈希写进任何 message。
 *
 * ## 本模块**不提供**什么
 *
 * - **不提供"用户不存在时也跑一次假派生"的时序平衡。** 本模块无从知道调用方有没有查到
 *   用户，而这正是登录接口最容易泄露"这个登录名存在吗"的地方。平衡只能在 §1.3 的登录
 *   用例（F2）里做。
 * - **不提供失败计数与锁定。** `AccountLockPolicy` 的阈值判定是 domain 的纯比较
 *   （`isLockThresholdReached`），计数的原子更新是 `users` 行的写路径，都不属于哈希原语。
 * - **不做口令强度/字典校验。** §1.3 只给了长度边界，而边界已经在 domain
 *   （`isAcceptablePasswordLength`）里；在此另立一套规则会造出两个互相矛盾的口令策略。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { isAcceptablePasswordLength } from '@littleq/domain';

import { infraError } from '../errors.js';

/** §1.3：salt 16 随机 byte。 */
export const PASSWORD_SALT_BYTES = 16;
/** §1.3：输出 64 byte。 */
export const PASSWORD_HASH_BYTES = 64;
/** §1.3：N=32768。必须是 2 的幂。 */
export const SCRYPT_N = 32_768;
/** §1.3：r=8。 */
export const SCRYPT_R = 8;
/** §1.3：p=1。 */
export const SCRYPT_P = 1;
/** §1.3：maxmem 64MiB。**是下限不是余量**，理由见文件头。 */
export const SCRYPT_MAXMEM_BYTES = 64 * 1024 * 1024;

/**
 * 读回记录时允许的参数上界。
 *
 * 写路径只会写基线值，所以上界存在的唯一理由是**读路径**：`password_credentials` 的行
 * 是数据库里的数据，而数据库是信任边界（能改库的人不必能改代码）。没有上界时，一行被
 * 改成 `scrypt_n = 2^30` 的记录会让登录请求去申请天文数字的内存，把"校验一个口令"变成
 * 一次打挂进程的机会。上界与 `SCRYPT_MAXMEM_BYTES` 同源：任何我们不允许 Node 分配的
 * 内存量，也不允许从记录里读出来。
 */
const SCRYPT_N_MAX = 2 ** 20;
const SCRYPT_R_MAX = 32;
const SCRYPT_P_MAX = 16;
/** `hash_bytes` 的上界。scrypt 的输出长度受限，且 4096 byte 已经远超任何合理用途。 */
const HASH_BYTES_MAX = 4096;

/**
 * 落库的口令校验材料 —— 与 `password_credentials` 的列一一对应（少一个 `user_id`，那是
 * 行主键，由调用方持有）。
 *
 * **没有明文字段。** 类型本身就是"只保存校验材料，不存原口令"（§3.2）的看守：想在这里
 * 塞一个 `password` 字段，得先改这个类型，而那是一次显眼得多的改动。
 */
export interface PasswordCredentialRecord {
  readonly salt: Uint8Array;
  readonly passwordHash: Uint8Array;
  readonly scryptN: number;
  readonly scryptR: number;
  readonly scryptP: number;
  readonly hashBytes: number;
}

/** §1.3 基线参数。写路径唯一使用的组合，也是 `password_credentials` 初始参数的来源。 */
export function baselineScryptParams(): {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly hashBytes: number;
} {
  return { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, hashBytes: PASSWORD_HASH_BYTES };
}

/**
 * Node 的 `scrypt` 有多个重载，`promisify` 挑中的那一个在不同 `@types/node` 版本上并不
 * 一致（有的推成 `Promise<Buffer>`，有的推成 `Promise<unknown>`）。手写这一个 promise
 * 包装，类型就固定在本文件里，不随依赖版本漂移。
 *
 * 失败（含参数非法）走 reject，**不吞**：参数非法意味着记录被改坏或基线写错，两者都必须
 * 大声失败而不是退化成"校验不通过"—— 后者会让一次配置事故表现为全体用户口令错误。
 */
function deriveKey(
  password: Uint8Array,
  salt: Uint8Array,
  keyLength: number,
  params: { readonly n: number; readonly r: number; readonly p: number },
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: params.n, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM_BYTES },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(new Uint8Array(derivedKey));
      },
    );
  });
}

function assertIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isPowerOfTwo(value: number): boolean {
  return value > 1 && (value & (value - 1)) === 0;
}

/**
 * 校验一条**读回来的**记录形状。
 *
 * 三处不一致都归 `STORED_ROW_INCONSISTENT`：类型不对、参数越界、以及
 * `passwordHash.length !== hashBytes`。最后这一条是整段校验里最要紧的 ——
 * `timingSafeEqual` 在长度不等时会**抛异常**而不是返回 `false`，一次长度错乱于是从
 * "校验不通过"变成"登录接口 500"，而 500 是可被外部触发的。
 *
 * 另外拒绝**非基线**的参数组合（N 不是 2 的幂、内存超过 maxmem）：Node 自己也会拒，
 * 但那是一个 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` 的原始异常，会带着参数值冒到调用栈上；
 * 在这里先拦一次，错误码就是本层自己的。
 */
function assertCredentialRecordShape(record: PasswordCredentialRecord): void {
  if (!(record.salt instanceof Uint8Array) || record.salt.length === 0) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  if (!(record.passwordHash instanceof Uint8Array) || record.passwordHash.length === 0) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  if (!assertIntegerInRange(record.scryptN, 2, SCRYPT_N_MAX)) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  if (!isPowerOfTwo(record.scryptN)) throw infraError('STORED_ROW_INCONSISTENT');
  if (!assertIntegerInRange(record.scryptR, 1, SCRYPT_R_MAX)) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  if (!assertIntegerInRange(record.scryptP, 1, SCRYPT_P_MAX)) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  if (!assertIntegerInRange(record.hashBytes, 1, HASH_BYTES_MAX)) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  if (record.hashBytes !== record.passwordHash.length) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
  if (128 * record.scryptN * record.scryptR > SCRYPT_MAXMEM_BYTES) {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
}

/**
 * 口令长度必须在 domain 的 `PASSWORD_MIN_LENGTH..PASSWORD_MAX_LENGTH`（8..128）之内。
 *
 * 这条判定**不是常数时间**，而且它只看长度。这是有意的：长度边界是公开契约里写明的
 * （`POST /auth/login` 的 schema 会拒绝同样的输入），所以它不构成额外泄露；而在派生之前
 * 拒绝超长输入，恰好避免了"用一次昂贵的 scrypt 去回应一个必然无效的请求"。
 */
function assertPasswordLength(plaintext: string): void {
  if (!isAcceptablePasswordLength(plaintext)) throw infraError('PASSWORD_OUT_OF_RANGE');
}

/**
 * 生成一条新的口令校验材料。
 *
 * salt 在函数内部随机生成、**不可传入**（理由见文件头结构性保证 1）。返回的记录可以直接
 * 写进 `password_credentials`：参数四元组与哈希、salt 一起保存，校验时按记录里的参数派生。
 */
export async function hashPassword(plaintext: string): Promise<PasswordCredentialRecord> {
  assertPasswordLength(plaintext);
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const passwordHash = await deriveKey(
    Buffer.from(plaintext, 'utf8'),
    new Uint8Array(salt),
    PASSWORD_HASH_BYTES,
    { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
  );
  return {
    salt: new Uint8Array(salt),
    passwordHash,
    scryptN: SCRYPT_N,
    scryptR: SCRYPT_R,
    scryptP: SCRYPT_P,
    hashBytes: PASSWORD_HASH_BYTES,
  };
}

/**
 * 校验口令。**只有"是/否"，没有任何细节**：不区分"记录形状坏了"以外的失败原因，因为
 * 区分它们等于给攻击者一个 oracle（与 `SECRET_DECRYPT_FAILED` 只有一个码同理）。
 *
 * 派生用**记录里保存的参数**，比较用 `timingSafeEqual`。长度已由
 * `assertCredentialRecordShape` 保证与 `hashBytes` 一致，所以 `timingSafeEqual` 不会抛。
 */
export async function verifyPassword(
  plaintext: string,
  record: PasswordCredentialRecord,
): Promise<boolean> {
  assertPasswordLength(plaintext);
  assertCredentialRecordShape(record);
  const derived = await deriveKey(
    new Uint8Array(Buffer.from(plaintext, 'utf8')),
    record.salt,
    record.hashBytes,
    { n: record.scryptN, r: record.scryptR, p: record.scryptP },
  );
  if (derived.length !== record.passwordHash.length) return false;
  return timingSafeEqual(derived, record.passwordHash);
}

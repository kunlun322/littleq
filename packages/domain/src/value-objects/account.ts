import { integerValueObject } from './primitives.js';
import { stringEnum } from './enum.js';

/**
 * Account 聚合的值对象（ZLQ-153 §4.3 / 附录 A §6.1）。
 *
 * `PasswordDigest` 与登录计数原子更新属于 adapter，这里只有身份、角色、年龄段
 * 与账号状态。口令**明文**不建模为值对象：领域层需要知道的只有长度边界，
 * 造一个可传递的明文类型只会增加它被写进日志的机会。
 */

export const ROLES = ['OWNER', 'STUDENT'] as const;
export type Role = (typeof ROLES)[number];
const roleEnum = stringEnum<Role>('Role', ROLES);
export const isRole = roleEnum.is;
export const parseRole = roleEnum.parse;

export const ACCOUNT_STATUSES = ['ACTIVE', 'LOCKED', 'DELETED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
const accountStatusEnum = stringEnum<AccountStatus>('AccountStatus', ACCOUNT_STATUSES);
export const isAccountStatus = accountStatusEnum.is;
export const parseAccountStatus = accountStatusEnum.parse;

/**
 * 内容分级年龄段。Owner 没有 ageBand（它是学生内容分级的输入，不是账号属性），
 * Student 必有 —— 这条不变量在 `entities/account.ts` 的工厂里强制。
 */
export const AGE_BANDS = ['L1', 'L2', 'L3'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
const ageBandEnum = stringEnum<AgeBand>('AgeBand', AGE_BANDS);
export const isAgeBand = ageBandEnum.is;
export const parseAgeBand = ageBandEnum.parse;

/** 口令长度边界。`POST /auth/login` 与批量开号的 `initialPassword` 共用。 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * 只判定长度，不返回也不保存明文。调用方（api-contract 的 Zod schema、
 * application 的登录用例）用这两个常量自行约束；领域层不提供「持有口令」的类型。
 */
export function isAcceptablePasswordLength(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH
  );
}

/**
 * 登录名与昵称的值对象本体在 `./primitives.js`（跨聚合复用），
 * 这里只保留 Account 特有的边界与策略。
 */

/**
 * 登录锁定策略。
 *
 * 阈值与锁定时长**不在 domain 硬编码默认值**：与 `memberLimit` 同理（附录 A §6.3
 * 「memberLimit 来自 GroupSettings，不在 domain 硬编码默认数值」），产品数值由配置
 * 注入，domain 只保证它是正整数并且能被一致地比较。
 */
export type AccountLockPolicy = {
  readonly maxFailedAttempts: MaxFailedAttempts;
  readonly lockDurationMinutes: LockDurationMinutes;
};

export type MaxFailedAttempts = ReturnType<typeof maxFailedAttemptsValue.parse>;
export type LockDurationMinutes = ReturnType<typeof lockDurationMinutesValue.parse>;

const maxFailedAttemptsValue = integerValueObject('MaxFailedAttempts', 1, 1000);
/** 7 天 = 10080 分钟；上限只用于拒绝荒谬值，不是产品默认值。 */
const lockDurationMinutesValue = integerValueObject('LockDurationMinutes', 1, 10_080);

export function parseMaxFailedAttempts(value: number): MaxFailedAttempts {
  return maxFailedAttemptsValue.parse(value);
}

export function parseLockDurationMinutes(value: number): LockDurationMinutes {
  return lockDurationMinutesValue.parse(value);
}

/**
 * 失败计数是否已触发锁定。纯比较，不做时钟读取：`now` 由调用方传入，
 * 因此这条规则在任何宿主上都给出同一结果（附录 A G6）。
 */
export function isLockThresholdReached(
  failedLoginCount: number,
  policy: AccountLockPolicy,
): boolean {
  if (!Number.isSafeInteger(failedLoginCount) || failedLoginCount < 0) {
    throw new Error(`invalid failedLoginCount: ${String(failedLoginCount)}`);
  }
  return failedLoginCount >= policy.maxFailedAttempts;
}

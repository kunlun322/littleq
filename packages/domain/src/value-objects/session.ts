import { DomainError } from '../errors/domain-error.js';
import { stringEnum } from './enum.js';
import {
  parseAccountSessionId,
  parseUserId,
  type AccountSessionId,
  type UserId,
} from './identifiers.js';
import {
  compareTimestamps,
  integerValueObject,
  parseTimestamp,
  type Timestamp,
} from './primitives.js';

/**
 * AccountSession 聚合的值对象。
 *
 * ## 为什么这个模型以前不存在
 *
 * 传输面早就冻结了：`SESSION_COOKIE_NAME = 'littleq_session'`、`apiKey/cookie` 安全方案、
 * 带 `rememberMe` 的 `loginRequestSchema`、`POST /auth/login` 的 `Set-Cookie`、
 * `POST /auth/logout` 的 204。缺的是 cookie 背后那一行的**语义**：签发、空闲 TTL、
 * 绝对 TTL、`rememberMe` 的差异化时长、以及注销 / 改密 / 管理员强制下线时的失效。
 * 没有它，附录 §3.2 步骤 9（「刷新后从 DB 恢复任务、版本和预览，**不创建第二次 QCA
 * 调用**」）就没有一个可以问「这个 cookie 现在代表谁、还有效吗」的地方。
 *
 * ## 刻意不做的事
 *
 * - **cookie 值本身不在这里**。与 `PasswordDigest` 同理（见 `account.ts` 文件头）：
 *   令牌如何生成、如何哈希、如何写进 `Set-Cookie` 的 `Secure` / `HttpOnly` / `SameSite`
 *   属性，都是 adapter 的职责。domain 只认 `AccountSessionId` 这个身份，不持有令牌
 *   明文，也不持有任何可以反推出令牌的东西 —— 于是「令牌泄漏」在这个包里没有可泄漏
 *   的对象。
 * - **两个枚举都不上线**。按 `api-contract/src/schemas/common.ts` 的枚举房规，给一个
 *   没有接口引用的枚举注册 wire schema 只会在 `components.schemas` 里留下无人引用的
 *   成员。会话生命周期完全发生在服务端：读接口用 `AUTHENTICATION_REQUIRED`（401）
 *   回答「没有有效会话」，不需要把 `EXPIRED` 与 `REVOKED` 的区别暴露给客户端 ——
 *   暴露了反而给了探测者一个「这个 cookie 曾经有效」的判定器。
 * - **TTL 不硬编码产品默认值**。与 `AccountLockPolicy`、`memberLimit` 同一条规矩
 *   （附录 A §6.3）：数值由配置注入，domain 只保证它是正整数、并且四个数之间自洽。
 */

export const ACCOUNT_SESSION_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type AccountSessionStatus = (typeof ACCOUNT_SESSION_STATUSES)[number];
const accountSessionStatusEnum = stringEnum<AccountSessionStatus>(
  'AccountSessionStatus',
  ACCOUNT_SESSION_STATUSES,
);
export const isAccountSessionStatus = accountSessionStatusEnum.is;
export const parseAccountSessionStatus = accountSessionStatusEnum.parse;

/**
 * 失效原因。顺序按「谁会触发」排：本人主动 → 本人改密 → 管理员 → 账号状态连带。
 *
 * `EXPIRED` **不是**一个原因：超时是时间到了，不是谁做了决定，所以它落在 `status`
 * 上而 `revocationReason` 保持 `null`。这条区分是有用的 —— 运维要回答「今天有多少
 * 会话是被强制下线的」时，把超时算进去会让答案完全失去意义。
 */
export const ACCOUNT_SESSION_REVOCATION_REASONS = [
  'LOGOUT',
  'PASSWORD_CHANGED',
  'ADMIN_FORCED',
  'ACCOUNT_LOCKED',
  'ACCOUNT_DELETED',
] as const;
export type AccountSessionRevocationReason = (typeof ACCOUNT_SESSION_REVOCATION_REASONS)[number];
const accountSessionRevocationReasonEnum = stringEnum<AccountSessionRevocationReason>(
  'AccountSessionRevocationReason',
  ACCOUNT_SESSION_REVOCATION_REASONS,
);
export const isAccountSessionRevocationReason = accountSessionRevocationReasonEnum.is;
export const parseAccountSessionRevocationReason = accountSessionRevocationReasonEnum.parse;

/**
 * 会话 TTL 策略：四个分钟数。
 *
 * `rememberMe` 的两个值必须**不短于**对应的默认值 —— 登录页那个勾选框承诺的是「更久」，
 * 一个更短的 remember-me 是任何 UI 都无法表达的静默降级。同理绝对 TTL 必须不短于空闲
 * TTL，否则空闲规则永远轮不到生效，成为一段死代码。四条比较都在 `parseSessionTtlPolicy`
 * 里，因此**不存在**一个能被构造出来的自相矛盾的策略对象。
 *
 * 上限只用于拒绝荒谬值（7 天 / 365 天），不是产品默认值，理由与
 * `lockDurationMinutesValue` 逐字相同。
 */
export type SessionIdleMinutes = ReturnType<typeof sessionIdleMinutesValue.parse>;
export type SessionAbsoluteMinutes = ReturnType<typeof sessionAbsoluteMinutesValue.parse>;

const sessionIdleMinutesValue = integerValueObject('SessionIdleMinutes', 1, 10_080);
const sessionAbsoluteMinutesValue = integerValueObject('SessionAbsoluteMinutes', 1, 525_600);

export type SessionTtlPolicy = {
  readonly idleMinutes: SessionIdleMinutes;
  readonly absoluteMinutes: SessionAbsoluteMinutes;
  readonly rememberMeIdleMinutes: SessionIdleMinutes;
  readonly rememberMeAbsoluteMinutes: SessionAbsoluteMinutes;
};

export function parseSessionIdleMinutes(value: number): SessionIdleMinutes {
  return sessionIdleMinutesValue.parse(value);
}

export function parseSessionAbsoluteMinutes(value: number): SessionAbsoluteMinutes {
  return sessionAbsoluteMinutesValue.parse(value);
}

export function parseSessionTtlPolicy(input: {
  readonly idleMinutes: number;
  readonly absoluteMinutes: number;
  readonly rememberMeIdleMinutes: number;
  readonly rememberMeAbsoluteMinutes: number;
}): SessionTtlPolicy {
  const idleMinutes = parseSessionIdleMinutes(input.idleMinutes);
  const absoluteMinutes = parseSessionAbsoluteMinutes(input.absoluteMinutes);
  const rememberMeIdleMinutes = parseSessionIdleMinutes(input.rememberMeIdleMinutes);
  const rememberMeAbsoluteMinutes = parseSessionAbsoluteMinutes(input.rememberMeAbsoluteMinutes);
  // 配置写错是我们的 bug（或部署期误配），不是外部输入不合法，所以抛普通 `Error`
  // —— 与 `integerValueObject` / `textValueObject` 拒绝非法边界时同一类。
  if (absoluteMinutes < idleMinutes) {
    throw new Error(
      `SessionTtlPolicy.absoluteMinutes (${absoluteMinutes}) must be >= idleMinutes (${idleMinutes})`,
    );
  }
  if (rememberMeIdleMinutes < idleMinutes) {
    throw new Error(
      `SessionTtlPolicy.rememberMeIdleMinutes (${rememberMeIdleMinutes}) must be >= idleMinutes (${idleMinutes})`,
    );
  }
  if (rememberMeAbsoluteMinutes < absoluteMinutes) {
    throw new Error(
      `SessionTtlPolicy.rememberMeAbsoluteMinutes (${rememberMeAbsoluteMinutes}) must be >= absoluteMinutes (${absoluteMinutes})`,
    );
  }
  if (rememberMeAbsoluteMinutes < rememberMeIdleMinutes) {
    throw new Error(
      `SessionTtlPolicy.rememberMeAbsoluteMinutes (${rememberMeAbsoluteMinutes}) must be >= rememberMeIdleMinutes (${rememberMeIdleMinutes})`,
    );
  }
  return { idleMinutes, absoluteMinutes, rememberMeIdleMinutes, rememberMeAbsoluteMinutes };
}

/** 按 `rememberMe` 选出这一条会话实际适用的两个 TTL。 */
export function sessionTtlFor(
  policy: SessionTtlPolicy,
  rememberMe: boolean,
): { readonly idleMinutes: SessionIdleMinutes; readonly absoluteMinutes: SessionAbsoluteMinutes } {
  return rememberMe
    ? {
        idleMinutes: policy.rememberMeIdleMinutes,
        absoluteMinutes: policy.rememberMeAbsoluteMinutes,
      }
    : { idleMinutes: policy.idleMinutes, absoluteMinutes: policy.absoluteMinutes };
}

/**
 * 一条服务端会话。
 *
 * 两个截止时间都**存下来**而不是每次从 `issuedAt` / `lastSeenAt` 重算：空闲截止会随着
 * 活动前移，重算需要知道当时的策略值，而策略是可配置的 —— 改了配置再重算，等于把新
 * 时长追溯应用到旧会话上。存下来之后，改配置只影响之后签发的会话，这是唯一可解释的
 * 行为。
 */
export type AccountSession = {
  readonly id: AccountSessionId;
  readonly userId: UserId;
  readonly status: AccountSessionStatus;
  readonly rememberMe: boolean;
  readonly issuedAt: Timestamp;
  /** 最近一次通过这条会话完成鉴权的时刻；滑动空闲窗口的锚点。 */
  readonly lastSeenAt: Timestamp;
  readonly idleExpiresAt: Timestamp;
  readonly absoluteExpiresAt: Timestamp;
  readonly revokedAt: Timestamp | null;
  readonly revocationReason: AccountSessionRevocationReason | null;
};

export function createAccountSession(input: {
  readonly id: string;
  readonly userId: string;
  readonly status?: string;
  readonly rememberMe: unknown;
  readonly issuedAt: string;
  readonly lastSeenAt?: string | null;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt?: string | null;
  readonly revocationReason?: string | null;
}): AccountSession {
  const id = parseAccountSessionId(input.id);
  const userId = parseUserId(input.userId);
  const status = parseAccountSessionStatus(input.status ?? 'ACTIVE');
  if (typeof input.rememberMe !== 'boolean') {
    throw DomainError.invalid('AccountSession.rememberMe');
  }
  const issuedAt = parseTimestamp(input.issuedAt);
  const lastSeenAt = parseTimestamp(input.lastSeenAt ?? input.issuedAt);
  const idleExpiresAt = parseTimestamp(input.idleExpiresAt);
  const absoluteExpiresAt = parseTimestamp(input.absoluteExpiresAt);
  const revokedAt =
    input.revokedAt === undefined || input.revokedAt === null
      ? null
      : parseTimestamp(input.revokedAt);
  const revocationReason =
    input.revocationReason === undefined || input.revocationReason === null
      ? null
      : parseAccountSessionRevocationReason(input.revocationReason);

  if (compareTimestamps(issuedAt, lastSeenAt) > 0) {
    throw DomainError.invalid('AccountSession.lastSeenAt');
  }
  if (compareTimestamps(lastSeenAt, idleExpiresAt) >= 0) {
    throw DomainError.invalid('AccountSession.idleExpiresAt');
  }
  if (compareTimestamps(issuedAt, absoluteExpiresAt) >= 0) {
    throw DomainError.invalid('AccountSession.absoluteExpiresAt');
  }
  // 与 `Publication` 的 `(status === 'REVOKED') === (revokedAt !== null)` 同一条不变量：
  // 状态与它的时间戳证据必须同时存在或同时不存在。少了它，「已撤销但没有撤销时刻」
  // 与「有撤销时刻但状态还是 ACTIVE」都能被构造出来，两者都会让审计对不上账。
  if ((status === 'REVOKED') !== (revokedAt !== null)) {
    throw DomainError.invalid('AccountSession.revokedAt');
  }
  if ((revocationReason !== null) !== (revokedAt !== null)) {
    throw DomainError.invalid('AccountSession.revocationReason');
  }
  if (revokedAt !== null && compareTimestamps(issuedAt, revokedAt) > 0) {
    throw DomainError.invalid('AccountSession.revokedAt');
  }

  return {
    id,
    userId,
    status,
    rememberMe: input.rememberMe,
    issuedAt,
    lastSeenAt,
    idleExpiresAt,
    absoluteExpiresAt,
    revokedAt,
    revocationReason,
  };
}

/**
 * 有效截止 = `min(空闲, 绝对)`。
 *
 * 取较小值意味着滑动空闲窗口**永远不会**把会话延到绝对截止之后，所以「记住我 30 天」
 * 与「绝对上限 7 天」同时配置时，7 天赢 —— 绝对上限存在的意义正是拦住这种延长。
 */
export function accountSessionDeadline(session: AccountSession): Timestamp {
  return compareTimestamps(session.idleExpiresAt, session.absoluteExpiresAt) <= 0
    ? session.idleExpiresAt
    : session.absoluteExpiresAt;
}

/**
 * 是否已经超时。边界与 `isLeaseExpired` 一致：`now` 恰好等于截止时刻即视为已过期
 * （`leaseUntil <= now`），因为「刚好到点」这一刻已经不该再放行。
 */
export function isAccountSessionTimeExpired(session: AccountSession, now: Timestamp): boolean {
  return compareTimestamps(now, accountSessionDeadline(session)) >= 0;
}

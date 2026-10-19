/**
 * 会话策略（附录 §3.2 步骤 9：「刷新后从 DB 恢复任务、版本和预览，**不创建第二次 QCA
 * 调用**」——恢复的前提是"刷新之后请求里带的还是同一条已签发的会话"）。
 *
 * 与 `lease.ts` 同一条边界：**纯决策**。这里不签 cookie、不读 cookie、不做 HTTP、不读
 * 环境变量。TTL 由调用方注入（`SessionTtlPolicy`），时间由调用方传入（`now`），持久化
 * 与 cookie 值的编解码在 infra（§6.4：凭证与传输细节必须留在 application/infra）。
 *
 * 三个动作必须分开，混在一起会造出真实缺陷：
 *
 * - **签发**（登录成功）——四个时间戳全部由策略算出，调用方一个都不许自己填；
 * - **触摸**（每次带会话的请求）——只滑动 `lastSeenAt` 与 `idleExpiresAt`，**不动**
 *   `absoluteExpiresAt`。绝对超时存在的唯一理由就是"再活跃也要过期"，滑动它等于取消；
 * - **撤销**（登出 / 改密码 / 管理员强制 / 锁定 / 删号）——状态迁移到终态 `REVOKED`，
 *   与时间无关，一旦撤销不再回来。
 *
 * `EXPIRED` 与 `REVOKED` 的区别是**证据**：前者由时间推导（`revokedAt` 为 null），后者
 * 由一次决定产生（`revokedAt` 与 `revocationReason` 必须同时非空）。把它们合成一个
 * 「会话失效」会让审计分不清"用户自己登出"与"我们判定这条 cookie 活得太久"。
 */

import { DomainError } from '../errors/domain-error.js';
import { ACCOUNT_SESSION_TRANSITIONS } from '../states/machines.js';
import { canTransition } from '../states/transition.js';
import { parseUserId, type UserId } from '../value-objects/identifiers.js';
import { plusMinutesUtc, parseTimestamp, type Timestamp } from '../value-objects/primitives.js';
import {
  createAccountSession,
  isAccountSessionTimeExpired,
  sessionTtlFor,
  type AccountSession,
  type AccountSessionRevocationReason,
  type AccountSessionStatus,
  type SessionTtlPolicy,
} from '../value-objects/session.js';

/**
 * 签发一条新会话。四个时间戳全部在这里算出：调用方只给 `now`。
 *
 * `rememberMe` 决定用哪一组 TTL（`sessionTtlFor`）。这是「记住我」与"默认会话"唯一的
 * 分化点 —— 分化只发生在**签发时**，之后触摸用的都是已经写死在这条会话上的那组值，
 * 所以中途改配置不会追溯影响已签发的会话。
 */
export function issueAccountSession(input: {
  readonly id: string;
  readonly userId: string;
  readonly rememberMe: boolean;
  readonly ttl: SessionTtlPolicy;
  readonly now: Timestamp;
}): AccountSession {
  const now = parseTimestamp(input.now);
  const ttl = sessionTtlFor(input.ttl, input.rememberMe);
  return createAccountSession({
    id: input.id,
    userId: input.userId,
    status: 'ACTIVE',
    rememberMe: input.rememberMe,
    issuedAt: now,
    lastSeenAt: now,
    idleExpiresAt: plusMinutesUtc(now, ttl.idleMinutes),
    absoluteExpiresAt: plusMinutesUtc(now, ttl.absoluteMinutes),
    revokedAt: null,
    revocationReason: null,
  });
}

/**
 * 触摸：一次带会话的请求被接受了，空闲窗口向前滑动。
 *
 * **绝对到期时刻不变**。滑动量取"这条会话自己的空闲窗口"与"到绝对截止还剩多少"的较小
 * 值 —— 后者保证 `idleExpiresAt` 永远不会越过 `absoluteExpiresAt`，否则一次长会话能把
 * 绝对超时顶到无穷远。空闲窗口从**已存的两个时间戳**反推，不再查一次 TTL 配置：配置
 * 改了也不该让一条老会话突然换一种寿命。
 *
 * 已经过期或已撤销的会话原样返回 —— 触摸不能让死人复活，可用性由
 * `accountSessionEffectiveStatus` 先判定。返回新对象而不是就地修改：`AccountSession`
 * 是不可变的，就地改会让"两个实例同时处理同一条会话"失去可观测的形状。
 */
export function touchAccountSession(session: AccountSession, now: Timestamp): AccountSession {
  const at = parseTimestamp(now);
  if (session.status !== 'ACTIVE') return session;
  if (isAccountSessionTimeExpired(session, at)) return session;

  const atMs = Date.parse(at);
  const remainingMs = Date.parse(parseTimestamp(session.absoluteExpiresAt)) - atMs;
  if (remainingMs <= 0) return session;

  const windowMs =
    Date.parse(parseTimestamp(session.idleExpiresAt)) -
    Date.parse(parseTimestamp(session.lastSeenAt));
  const slideMs = Math.min(windowMs, remainingMs);
  if (slideMs <= 0) return session;

  return createAccountSession({
    ...session,
    lastSeenAt: at,
    idleExpiresAt: new Date(atMs + slideMs).toISOString(),
  });
}

/**
 * 撤销：`ACTIVE → REVOKED`，并把「为什么」写成 `revocationReason`。
 *
 * 对已处于终态（`EXPIRED` / `REVOKED`）的会话再撤销一次是**无操作**，不是错误。两个
 * 真实调用方都需要这条性质：`POST /auth/logout` 必须可以重复调用而永远成功，改密码时
 * 要一次性撤销名下所有会话、其中必然混着早就过期的行 —— 让调用方先过滤一遍状态，等于
 * 把幂等性的责任推给每一个未来的调用点。
 *
 * 「哪些状态可以被撤销」不写死在这里，而是问迁移表：表里没有指向 `REVOKED` 的边就不动。
 * 将来若裁定 `EXPIRED → REVOKED` 合法（例如要在过期行上补记一次管理员强制），改表即可，
 * 策略自动跟随 —— 反之，在这里写 `status === 'ACTIVE'` 就会让表与策略各说一套。
 */
export function revokeAccountSession(input: {
  readonly session: AccountSession;
  readonly reason: AccountSessionRevocationReason;
  readonly now: Timestamp;
}): AccountSession {
  const { session, reason } = input;
  if (!canTransition(ACCOUNT_SESSION_TRANSITIONS, session.status, 'REVOKED')) return session;
  return createAccountSession({
    ...session,
    status: 'REVOKED',
    revokedAt: parseTimestamp(input.now),
    revocationReason: reason,
  });
}

/**
 * 过期落账：把"时间推导出来的失效"写成 `EXPIRED` 终态。
 *
 * 这是唯一一处 `ACTIVE → EXPIRED` 的入口，而且是**可选的**：
 * `accountSessionEffectiveStatus` 不需要它就已经能拒绝过期会话。它存在是为了让持久层
 * 能把终态写回数据库，好让审计与清理任务看到一条明确的记录，而不是让一行 `ACTIVE`
 * 永远躺在表里。已 `REVOKED` 的会话不会被改写成 `EXPIRED`（迁移表里没有这条边）——
 * 撤销的证据优先级高于时间推导。
 */
export function expireAccountSession(session: AccountSession, now: Timestamp): AccountSession {
  if (!canTransition(ACCOUNT_SESSION_TRANSITIONS, session.status, 'EXPIRED')) return session;
  if (!isAccountSessionTimeExpired(session, now)) return session;
  return createAccountSession({ ...session, status: 'EXPIRED' });
}

/**
 * 有效状态：**持久化状态 + 时间**共同决定。
 *
 * 读侧一律用这个，不要直接读 `session.status`。原因：过期是时间事实，不是写事实 ——
 * 没有哪个进程会在到期那一秒准时把行改成 `EXPIRED`，所以"表里写着 ACTIVE"根本不能
 * 证明"现在还能用"。反过来，已撤销的会话不会因为时钟回拨而复活。
 */
export function accountSessionEffectiveStatus(
  session: AccountSession,
  now: Timestamp,
): AccountSessionStatus {
  if (session.status === 'REVOKED') return 'REVOKED';
  if (isAccountSessionTimeExpired(session, now)) return 'EXPIRED';
  return 'ACTIVE';
}

/**
 * 断言这条会话现在可用，否则抛 `AUTHENTICATION_REQUIRED`。
 *
 * 用同一个码覆盖"过期"与"撤销"是**刻意的**：分成两种码等于给探测者一个「这条 cookie
 * 曾经有效过」的预言机（与 `value-objects/session.ts` 里两个枚举都不上 wire 是同一条
 * 理由）。要区分，去读审计与持久层，不要在响应里说。
 */
export function assertAccountSessionUsable(session: AccountSession, now: Timestamp): void {
  if (accountSessionEffectiveStatus(session, now) !== 'ACTIVE') {
    throw new DomainError('AUTHENTICATION_REQUIRED', 'AccountSession');
  }
}

/**
 * 解析出这次请求的身份 —— §3.2 步骤 9 需要的原语。
 *
 * 返回 `null` 与抛错分开：调用方（通常是 auth guard）拿到 `null` 之后自己决定是 401
 * 还是匿名放行（`GET /license` 就是匿名放行的那一类）。
 */
export function accountSessionIdentity(
  session: AccountSession | null,
  now: Timestamp,
): { readonly userId: UserId; readonly rememberMe: boolean } | null {
  if (session === null) return null;
  if (accountSessionEffectiveStatus(session, now) !== 'ACTIVE') return null;
  return { userId: parseUserId(session.userId), rememberMe: session.rememberMe };
}

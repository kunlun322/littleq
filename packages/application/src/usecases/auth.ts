/**
 * 会话用例：登录、登出、以及**每个受保护请求都要跑一遍**的会话解析。
 *
 * ## 登录为什么返回 204 而不是用户对象
 *
 * `operations.ts` 的 `login` 逐字写着「成功返回 204 与 Set-Cookie，**没有响应体**」。
 * 这不是省事：把 `User` 回给登录者，就会顺带把 `role`、`lockPolicy`、`status` 一起
 * 带出去，而 §5.3 要求**角色判断留在服务端**。客户端拿不到角色，就没法把「我是 OWNER」
 * 当成一个可以由前端决定的事实 —— 于是 §4.2 那条「登录 UI 的学生登录/成人配置只决定
 * 白名单内的下一个路径，**不是授权依据**」才有牙齿。
 *
 * ## 认证失败为什么统一成一个码
 *
 * 「登录名不存在」「没有口令凭据」「口令不对」一律映射 `AUTHENTICATION_FAILED`，
 * 而且**三种情况都花掉一次 scrypt**：不存在时用一个固定的哑凭据去算。少了这一步，
 * 响应时间就直接回答了「这个登录名存在吗」，那是一份免费的账号枚举预言机。
 * `ACCOUNT_LOCKED` 是唯一分出来的情况 —— 账号被锁这件事**已经**对调用方可见
 * （它本来就是要给锁定的账号一个明确解释），不构成新的泄漏。
 *
 * 本切片的 `users` 表**没有失败次数字段**，所以 `lockPolicy.maxFailedAttempts` 无法
 * 落地：`ACCOUNT_LOCKED` 只由 `status === 'LOCKED'` 触发（由 `bootstrapAccounts` 或
 * 管理动作写入）。这是如实的限制，不是被藏起来的分支 —— 交付评论里已声明。
 *
 * ## CSRF 令牌为什么是**派生**的而不是随机存的
 *
 * `csrfToken = SHA-256(sessionId || ':' || hex(tokenHash))`。双提交模式要求攻击者
 * 同时拿到 cookie 与能设置请求头的能力；派生式在此之上多给一条：令牌**绑定到具体会话**，
 * 从别的会话偷来的 CSRF 令牌在这里无效，而且服务端不需要为它多存一列（`account_sessions`
 * 的列集合是 §3.2 冻结的，加列不在本单文件面里）。验证是重算 + 常量时间比较。
 */
import {
  type AccountSession,
  type SessionTtlPolicy,
  type Timestamp,
  type User,
  DomainError,
  accountSessionIdentity,
  assertAccountSessionUsable,
  issueAccountSession,
  isLoginName,
  loginNameKey,
  parseLoginName,
  revokeAccountSession,
  touchAccountSession,
} from '@littleq/domain';

import type {
  AccountDirectory,
  PasswordCredentialRecord,
  PasswordHasher,
  RandomSource,
  SessionDirectory,
} from './ports.js';

/** 会话令牌的字节长度（256 bit）。hex 编码后 64 字符进 cookie。 */
export const SESSION_TOKEN_BYTES = 32;
/**
 * 登录名不存在时用来「白算一次 scrypt」的哑凭据。
 *
 * 参数与真实凭据的基线一致（N=32768/r=8/p=1/64 字节），盐与哈希是固定常量 ——
 * 它永远不可能匹配任何口令，存在的唯一目的是让耗时与真实分支同量级。
 */
const DECOY_CREDENTIAL: PasswordCredentialRecord = {
  salt: new Uint8Array(16),
  passwordHash: new Uint8Array(64),
  scryptN: 32_768,
  scryptR: 8,
  scryptP: 1,
  hashBytes: 64,
};

export interface AuthServices {
  readonly accounts: AccountDirectory;
  readonly sessions: SessionDirectory;
  readonly hasher: PasswordHasher;
  readonly random: RandomSource;
}

export interface LoginInput {
  readonly loginName: string;
  readonly password: string;
  readonly rememberMe: boolean;
  readonly ttl: SessionTtlPolicy;
  readonly now: Timestamp;
}

export interface IssuedSession {
  /** 会话令牌**明文**。只进 `Set-Cookie`，绝不落库、绝不进日志。 */
  readonly sessionToken: string;
  /** 派生的 CSRF 令牌，进非 HttpOnly 的伴随 cookie 与 `X-CSRF-Token` 头。 */
  readonly csrfToken: string;
  readonly rememberMe: boolean;
  readonly session: AccountSession;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** 会话令牌的存储摘要。落库的只有它。 */
export function sessionTokenHash(random: RandomSource, sessionToken: string): Uint8Array {
  return random.sha256(sessionToken);
}

/** 从会话 id 与令牌摘要派生 CSRF 令牌（64 位小写 hex）。 */
export function deriveCsrfToken(
  random: RandomSource,
  sessionId: string,
  tokenHash: Uint8Array,
): string {
  return toHex(random.sha256(`${sessionId}:${toHex(tokenHash)}`));
}

/** 常量时间比较两个等长 hex 串；长度不等直接 false（不泄漏长度以外的信息）。 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 登录：验口令 → 签发会话 → 返回令牌明文与 CSRF 令牌。
 *
 * 抛 `AUTHENTICATION_FAILED` / `ACCOUNT_LOCKED`，两者都由 HTTP 层映射成对应的
 * envelope；`ACCOUNT_LOCKED` 按错误目录是 423，`AUTHENTICATION_FAILED` 是 401。
 */
export async function login(
  services: AuthServices,
  input: LoginInput,
): Promise<IssuedSession> {
  const { accounts, sessions, hasher, random } = services;
  // 格式不合法的登录名也走同一条烧一次 scrypt 的路，否则「这个串像不像登录名」成了可探测的事实。
  const found = isLoginName(input.loginName)
    ? await accounts.findByLoginNameKey(loginNameKey(parseLoginName(input.loginName)))
    : null;
  // 「没有这个账号」与「口令不对」必须走同一条耗时路径。
  const credential = found?.credential ?? DECOY_CREDENTIAL;
  const passwordMatches = await hasher.verify(input.password, credential);

  if (found === null || found.credential === null || !passwordMatches) {
    throw new DomainError('AUTHENTICATION_FAILED', 'LoginRequest');
  }
  if (found.user.status === 'LOCKED') {
    throw new DomainError('ACCOUNT_LOCKED', 'Account');
  }
  if (found.user.status === 'DELETED') {
    // 已删除账号不区分于「口令不对」：否则删除动作本身成了可探测的事实。
    throw new DomainError('AUTHENTICATION_FAILED', 'LoginRequest');
  }

  const sessionToken = toHex(random.bytes(SESSION_TOKEN_BYTES));
  const tokenHash = sessionTokenHash(random, sessionToken);
  const session = issueAccountSession({
    id: random.uuidV7(),
    userId: found.user.id,
    rememberMe: input.rememberMe,
    ttl: input.ttl,
    now: input.now,
  });
  await sessions.insert({ session, tokenHash });
  return {
    sessionToken,
    csrfToken: deriveCsrfToken(random, session.id, tokenHash),
    rememberMe: session.rememberMe,
    session,
  };
}

export interface AuthenticatedRequest {
  readonly user: User;
  readonly session: AccountSession;
  /** 本次请求解析出的 CSRF 令牌；写接口用它与 `X-CSRF-Token` 头比对。 */
  readonly csrfToken: string;
  readonly sessionToken: string;
}

export interface AuthenticateInput {
  /** cookie 里的会话令牌明文；缺省时传 `null`。 */
  readonly sessionToken: string | null;
  readonly now: Timestamp;
}

/**
 * 解析当前请求的身份。
 *
 * 失败一律返回 `null`（HTTP 层映射 `AUTHENTICATION_REQUIRED`），**不区分**令牌不存在、
 * 已过期、已撤销 —— api-contract 的注释里写得很清楚：把 `EXPIRED` 与 `REVOKED` 分开
 * 回显等于给探测者一个「这条 cookie 曾经有效过」的预言机。
 *
 * 副作用：会话仍然可用时滑动过期（`touchAccountSession`），且**只在期限真的变了的时候**
 * 才写库 —— 每个读请求都写一次 `account_sessions` 会把只读接口变成写接口。
 */
export async function authenticate(
  services: AuthServices,
  input: AuthenticateInput,
): Promise<AuthenticatedRequest | null> {
  if (input.sessionToken === null) return null;
  const { accounts, sessions, random } = services;
  const tokenHash = sessionTokenHash(random, input.sessionToken);
  const stored = await sessions.findByTokenHash(tokenHash);
  if (stored === null) return null;

  try {
    assertAccountSessionUsable(stored.session, input.now);
  } catch {
    return null;
  }
  const user = await accounts.findById(stored.session.userId);
  if (user === null || user.status !== 'ACTIVE') return null;

  const touched = touchAccountSession(stored.session, input.now);
  if (touched.idleExpiresAt !== stored.session.idleExpiresAt) {
    await sessions.save(touched);
  }
  return {
    user,
    session: touched,
    csrfToken: deriveCsrfToken(random, touched.id, tokenHash),
    sessionToken: input.sessionToken,
  };
}

/**
 * 校验 `X-CSRF-Token`。不匹配抛 `CSRF_REJECTED`（403），**不是** `REQUEST_INVALID`：
 * api-contract 明确规定这个头由 `CsrfHeader` security scheme 声明，格式不对也归
 * `CSRF_REJECTED`，否则「令牌缺失」与「请求体字段非法」在日志里会长成同一个样子。
 */
export function assertCsrfValid(authenticated: AuthenticatedRequest, headerValue: string | null): void {
  if (headerValue === null || !safeEqualHex(headerValue, authenticated.csrfToken)) {
    throw new DomainError('CSRF_REJECTED', 'X-CSRF-Token');
  }
}

/**
 * 登出：撤销会话，返回撤销后的会话供 HTTP 层清 cookie。
 *
 * 令牌不存在或已撤销时**同样返回成功** —— 登出必须幂等，否则「清 cookie」这一步
 * 在会话已经过期时会失败，用户被卡在客户端有 cookie、服务端没会话的状态里。
 */
export async function logout(
  services: AuthServices,
  input: { readonly sessionToken: string | null; readonly now: Timestamp },
): Promise<void> {
  if (input.sessionToken === null) return;
  const { sessions, random } = services;
  const tokenHash = sessionTokenHash(random, input.sessionToken);
  const stored = await sessions.findByTokenHash(tokenHash);
  if (stored === null) return;
  const identity = accountSessionIdentity(stored.session, input.now);
  if (identity === null && stored.session.status === 'REVOKED') return;
  const revoked = revokeAccountSession({
    session: stored.session,
    reason: 'LOGOUT',
    now: input.now,
  });
  if (revoked.status !== stored.session.status || revoked.revokedAt !== stored.session.revokedAt) {
    await sessions.save(revoked);
  }
}

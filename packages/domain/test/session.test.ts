import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_SESSION_REVOCATION_REASONS,
  ACCOUNT_SESSION_STATUSES,
  ACCOUNT_SESSION_TRANSITIONS,
  DomainError,
  accountSessionDeadline,
  accountSessionEffectiveStatus,
  accountSessionIdentity,
  assertAccountSessionUsable,
  createAccountSession,
  expireAccountSession,
  isAccountSessionTimeExpired,
  issueAccountSession,
  outgoingStates,
  parseSessionTtlPolicy,
  parseTimestamp,
  revokeAccountSession,
  sessionTtlFor,
  touchAccountSession,
  type AccountSession,
  type SessionTtlPolicy,
  type Timestamp,
} from '../src/index.js';
import { EPOCH, atSeconds, thrownCode, thrownDomainError, uuidAt } from './support.js';

/**
 * 账号会话：签发、空闲 TTL、绝对 TTL、`rememberMe` 差异化时长、失效与撤销。
 *
 * 传输面早就冻结了（`littleq_session` cookie、`CookieAuth` 安全方案、带 `rememberMe`
 * 的登录请求体），这一组测试钉住的是 cookie 背后那一行的**语义** —— 附录 §3.2 步骤 9
 * 「刷新后从 DB 恢复任务、版本和预览，**不创建第二次 QCA 调用**」要求先能回答
 * 「这条 cookie 现在代表谁、还有效吗」。
 *
 * 三条最容易被后来的实现悄悄破坏的性质：
 *
 * 1. **绝对超时不能被滑动顶远**：触摸只移动 `idleExpiresAt`，且移动量被"到绝对截止还剩
 *    多少"夹住。少了这个夹子，一条持续活跃的会话就永远不会到期，「记住我 30 天」与
 *    「绝对上限 7 天」同时配置时后者变成死代码。
 * 2. **过期与撤销是两种不同的证据**：过期由时间推导（`revokedAt` 为 null），撤销由一次
 *    决定产生（`revokedAt` 与 `revocationReason` 必须同时非空）。合并成一个「会话失效」
 *    会让审计分不清"用户自己登出"与"我们判定这条 cookie 活得太久"。
 * 3. **对外只有一个码**：过期与撤销都映射 `AUTHENTICATION_REQUIRED`。分成两个码等于给
 *    探测者一个「这条 cookie 曾经有效过」的预言机。
 */

const NOW: Timestamp = parseTimestamp(EPOCH);

function atMinutes(minutes: number): Timestamp {
  return parseTimestamp(atSeconds(minutes * 60));
}

type TtlInput = Parameters<typeof parseSessionTtlPolicy>[0];

/** 30 分钟空闲 / 2 小时绝对；记住我 7 天空闲 / 30 天绝对。数值是测试夹具，不是产品默认值。 */
function ttlInput(overrides: Partial<TtlInput> = {}): TtlInput {
  return {
    idleMinutes: 30,
    absoluteMinutes: 120,
    rememberMeIdleMinutes: 10_080,
    rememberMeAbsoluteMinutes: 43_200,
    ...overrides,
  };
}

const TTL: SessionTtlPolicy = parseSessionTtlPolicy(ttlInput());

function issue(
  rememberMe = false,
  now: Timestamp = NOW,
  ttl: SessionTtlPolicy = TTL,
): AccountSession {
  return issueAccountSession({
    id: uuidAt(1),
    userId: uuidAt(2),
    rememberMe,
    ttl,
    now,
  });
}

/** 一条已撤销的会话，供读侧测试复用。 */
function revoked(minutes: number, reason: (typeof ACCOUNT_SESSION_REVOCATION_REASONS)[number]) {
  return revokeAccountSession({ session: issue(), reason, now: atMinutes(minutes) });
}

const SESSION_KEYS = [
  'id',
  'userId',
  'status',
  'rememberMe',
  'issuedAt',
  'lastSeenAt',
  'idleExpiresAt',
  'absoluteExpiresAt',
  'revokedAt',
  'revocationReason',
];

/** 与 `api-contract` 的 `LEAKY_FIELD_NAMES` 同一意图，此处独立字面量：不跨单元 import。 */
const LEAKY_KEY_PATTERN = /(credential|apikey|password)|token$|signature|secret/i;

describe('session-ttl-and-revocation：签发', () => {
  it('session-ttl-and-revocation：四个时间戳全部由策略算出，调用方一个都不填', () => {
    const session = issue();
    expect(session.status).toBe('ACTIVE');
    expect(session.issuedAt).toBe(NOW);
    expect(session.lastSeenAt).toBe(NOW);
    expect(session.idleExpiresAt).toBe(atMinutes(30));
    expect(session.absoluteExpiresAt).toBe(atMinutes(120));
    expect(session.revokedAt).toBeNull();
    expect(session.revocationReason).toBeNull();
    expect(session.rememberMe).toBe(false);
    expect(session.userId).toBe(uuidAt(2));
  });

  it('session-ttl-and-revocation：rememberMe 是唯一分化点，用的是更长的那一组 TTL', () => {
    const remembered = issue(true);
    expect(remembered.idleExpiresAt).toBe(atMinutes(10_080));
    expect(remembered.absoluteExpiresAt).toBe(atMinutes(43_200));
    expect(sessionTtlFor(TTL, true)).toEqual({ idleMinutes: 10_080, absoluteMinutes: 43_200 });
    expect(sessionTtlFor(TTL, false)).toEqual({ idleMinutes: 30, absoluteMinutes: 120 });
  });

  it('session-ttl-and-revocation：记录里没有任何令牌或凭据字段 —— 令牌不进入 domain', () => {
    // 结构性证据：不是「文档里没写 token」，而是键集合里根本没有这样的键。
    const session = issue(true);
    expect(Object.keys(session).sort()).toEqual([...SESSION_KEYS].sort());
    for (const key of Object.keys(session)) {
      expect(LEAKY_KEY_PATTERN.test(key), key).toBe(false);
    }
  });

  it('session-ttl-and-revocation：自相矛盾的 TTL 策略构造不出来 —— 四条比较各自抛普通 Error', () => {
    // 四条比较对应四个「配错了就说不通」的组合：绝对短于空闲、记住我短于不记住我
    // （空闲与绝对各一条）、记住我的绝对短于记住我的空闲。少了它们，`rememberMe`
    // 那个勾选框就能被配成一次静默降级，而没有任何接口能表达这种降级。
    //
    // 抛的是普通 `Error` 而不是 `DomainError`：这是我们的配置错误（或部署期误配），
    // 不是外部输入不合法，所以它没有一个能返回给客户端的错误码。
    const cases: readonly (readonly [string, Partial<TtlInput>])[] = [
      ['绝对短于空闲', { absoluteMinutes: 10 }],
      ['记住我的空闲短于不记住我的空闲', { rememberMeIdleMinutes: 10 }],
      ['记住我的绝对短于不记住我的绝对', { rememberMeAbsoluteMinutes: 60 }],
      [
        '记住我的绝对短于记住我的空闲',
        { rememberMeIdleMinutes: 10_080, rememberMeAbsoluteMinutes: 600 },
      ],
    ];
    for (const [label, overrides] of cases) {
      let thrown: unknown = null;
      try {
        parseSessionTtlPolicy(ttlInput(overrides));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(Error);
      expect(thrown, label).not.toBeInstanceOf(DomainError);
    }
  });

  it('session-ttl-and-revocation：越界的 TTL 数值由有界整数值对象拒绝，走 REQUEST_INVALID', () => {
    // 与上一条区分开：范围守卫复用 `integerValueObject`，因此抛的是 `DomainError`。
    // 这不是不一致 —— 「荒谬值」（0 分钟、超过一年）与「自相矛盾的组合」是两类错误。
    expect(thrownCode(() => parseSessionTtlPolicy(ttlInput({ idleMinutes: 0 })))).toBe(
      'REQUEST_INVALID',
    );
    expect(
      thrownCode(() => parseSessionTtlPolicy(ttlInput({ rememberMeAbsoluteMinutes: 525_601 }))),
    ).toBe('REQUEST_INVALID');
    expect(
      thrownDomainError(() => parseSessionTtlPolicy(ttlInput({ idleMinutes: 0 }))).valueObject,
    ).toBe('SessionIdleMinutes');
    expect(
      thrownDomainError(() =>
        parseSessionTtlPolicy(ttlInput({ rememberMeAbsoluteMinutes: 525_601 })),
      ).valueObject,
    ).toBe('SessionAbsoluteMinutes');
  });

  it('session-ttl-and-revocation：合法策略能构造出来，且四个数都保持传入值', () => {
    // 四条比较都是 `>=`，所以「四个数完全相等」是合法边界，不是退化情形。
    expect(
      parseSessionTtlPolicy(
        ttlInput({
          absoluteMinutes: 30,
          rememberMeIdleMinutes: 30,
          rememberMeAbsoluteMinutes: 30,
        }),
      ),
    ).toEqual({
      idleMinutes: 30,
      absoluteMinutes: 30,
      rememberMeIdleMinutes: 30,
      rememberMeAbsoluteMinutes: 30,
    });
  });
});

describe('session-ttl-and-revocation：空闲滑动与绝对上限', () => {
  it('session-ttl-and-revocation：有效截止是 min(空闲, 绝对) —— 绝对上限 7 天赢过记住我 30 天', () => {
    // 直接构造一条空闲窗口越过绝对截止的会话：滑动窗口永远不该把它延到绝对截止之后，
    // 而绝对上限存在的意义正是拦住这种延长。
    const session = createAccountSession({
      id: uuidAt(3),
      userId: uuidAt(2),
      rememberMe: true,
      issuedAt: NOW,
      lastSeenAt: NOW,
      idleExpiresAt: atMinutes(43_200),
      absoluteExpiresAt: atMinutes(10_080),
    });
    expect(accountSessionDeadline(session)).toBe(atMinutes(10_080));
    expect(isAccountSessionTimeExpired(session, atMinutes(10_079))).toBe(false);
    expect(isAccountSessionTimeExpired(session, atMinutes(10_080))).toBe(true);
  });

  it('session-ttl-and-revocation：触摸滑动 lastSeenAt 与 idleExpiresAt，绝对截止一动不动', () => {
    const session = issue();
    const touched = touchAccountSession(session, atMinutes(10));
    expect(touched.lastSeenAt).toBe(atMinutes(10));
    expect(touched.idleExpiresAt).toBe(atMinutes(40));
    expect(touched.absoluteExpiresAt).toBe(session.absoluteExpiresAt);
    expect(touched.issuedAt).toBe(session.issuedAt);
    // 不可变更新：返回新对象，原对象逐字段未变。
    expect(touched).not.toBe(session);
    expect(session.lastSeenAt).toBe(NOW);
    expect(session.idleExpiresAt).toBe(atMinutes(30));
  });

  it('session-ttl-and-revocation：滑动量被剩余绝对时间夹住，idleExpiresAt 永不越过 absoluteExpiresAt', () => {
    // 空闲 90 分钟 / 绝对 120 分钟。第 60 分钟触摸：窗口还剩 90 分钟，但绝对截止只剩
    // 60 分钟 ⇒ 只滑 60 分钟。少了这个夹子，滑动会把空闲截止顶到第 150 分钟，
    // 「绝对上限 2 小时」当场变成死代码。
    //
    // 注意夹子只在「空闲 TTL 与绝对 TTL 数量级接近」时才会咬住：默认夹具是 30/120，
    // 会话早在第 30 分钟就因空闲超时死掉了，根本走不到绝对截止。所以这里换一组策略。
    const policy = parseSessionTtlPolicy(ttlInput({ idleMinutes: 90, rememberMeIdleMinutes: 90 }));
    const touched = touchAccountSession(issue(false, NOW, policy), atMinutes(60));
    expect(touched.lastSeenAt).toBe(atMinutes(60));
    expect(touched.idleExpiresAt).toBe(atMinutes(120));
    expect(touched.idleExpiresAt).toBe(touched.absoluteExpiresAt);
    // 再触摸一次也顶不动：窗口 60 分钟，剩余只有 30 分钟。
    const again = touchAccountSession(touched, atMinutes(90));
    expect(again.idleExpiresAt).toBe(atMinutes(120));
    expect(accountSessionDeadline(again)).toBe(atMinutes(120));
  });

  it('session-ttl-and-revocation：持续活跃 200 分钟的会话仍然在绝对截止那一刻失效', () => {
    // 这是「绝对超时」唯一有意义的场景：一个从不停手的用户。逐分钟触摸，
    // 断言有效截止在任何一刻都没有超过签发时写下的绝对截止。
    let session = issue();
    const absolute = session.absoluteExpiresAt;
    for (let minute = 1; minute <= 200; minute += 1) {
      session = touchAccountSession(session, atMinutes(minute));
      const deadline = accountSessionDeadline(session);
      expect(deadline <= absolute, `minute ${minute}`).toBe(true);
      if (minute < 120)
        expect(accountSessionEffectiveStatus(session, atMinutes(minute))).toBe('ACTIVE');
    }
    expect(accountSessionEffectiveStatus(session, atMinutes(120))).toBe('EXPIRED');
    expect(accountSessionEffectiveStatus(session, atMinutes(200))).toBe('EXPIRED');
  });

  it('session-ttl-and-revocation：空闲窗口从记录里的两个时间戳反推，改配置不会追溯改变老会话的寿命', () => {
    const short = parseSessionTtlPolicy(
      ttlInput({ rememberMeIdleMinutes: 30, rememberMeAbsoluteMinutes: 120 }),
    );
    const long = parseSessionTtlPolicy(ttlInput({ idleMinutes: 90, rememberMeIdleMinutes: 90 }));
    // 两条会话在同一时刻被触摸，各自的滑动量来自自己签发时写下的窗口。
    expect(touchAccountSession(issue(false, NOW, short), atMinutes(10)).idleExpiresAt).toBe(
      atMinutes(40),
    );
    expect(touchAccountSession(issue(false, NOW, long), atMinutes(10)).idleExpiresAt).toBe(
      atMinutes(100),
    );
  });

  it('session-ttl-and-revocation：已过期或已撤销的会话触摸后原样返回 —— 触摸不能让死人复活', () => {
    const expired = issue();
    expect(touchAccountSession(expired, atMinutes(500))).toBe(expired);
    const dead = revoked(5, 'LOGOUT');
    expect(touchAccountSession(dead, atMinutes(10))).toBe(dead);
  });

  it('session-ttl-and-revocation：触摸不能把 lastSeenAt 拉到 issuedAt 之前', () => {
    // 时钟回拨或调用方传错时间时，构造期不变量会拦下来，而不是留下一条自相矛盾的记录。
    expect(thrownCode(() => touchAccountSession(issue(), atMinutes(-1)))).toBe('REQUEST_INVALID');
  });
});

describe('session-ttl-and-revocation：过期与有效状态', () => {
  it('session-ttl-and-revocation：过期边界与 isLeaseExpired 一致 —— now 恰好等于截止即视为已过期', () => {
    const session = issue();
    expect(isAccountSessionTimeExpired(session, atMinutes(29))).toBe(false);
    expect(isAccountSessionTimeExpired(session, atMinutes(30))).toBe(true);
    expect(isAccountSessionTimeExpired(session, atMinutes(31))).toBe(true);
  });

  it('session-ttl-and-revocation：空闲先到与绝对先到是两种不同的失效路径', () => {
    // 默认会话：30 分钟空闲先到，之后再没有活动就在 30 分钟处失效。
    const idleFirst = issue();
    expect(accountSessionDeadline(idleFirst)).toBe(idleFirst.idleExpiresAt);
    expect(accountSessionEffectiveStatus(idleFirst, atMinutes(31))).toBe('EXPIRED');
    // 记住我会话：7 天空闲远早于 30 天绝对，所以也是空闲先到 —— 但把绝对上限压到
    // 空闲之下时（上一条测试构造的那种），绝对先到。
    const remembered = issue(true);
    expect(accountSessionDeadline(remembered)).toBe(remembered.idleExpiresAt);
    expect(accountSessionEffectiveStatus(remembered, atMinutes(10_081))).toBe('EXPIRED');
    expect(accountSessionEffectiveStatus(remembered, atMinutes(10_079))).toBe('ACTIVE');
  });

  it('session-ttl-and-revocation：expireAccountSession 只在 ACTIVE 且已超时时落账', () => {
    const live = issue();
    expect(expireAccountSession(live, atMinutes(10))).toBe(live);
    const expired = expireAccountSession(live, atMinutes(500));
    expect(expired.status).toBe('EXPIRED');
    // 过期是时间推导，不产生撤销证据。
    expect(expired.revokedAt).toBeNull();
    expect(expired.revocationReason).toBeNull();
    // 幂等：对已落账的终态再调用一次原样返回。
    expect(expireAccountSession(expired, atMinutes(600))).toBe(expired);
  });

  it('session-ttl-and-revocation：已撤销的会话不会被改写成 EXPIRED —— 撤销证据优先于时间推导', () => {
    const dead = revoked(5, 'PASSWORD_CHANGED');
    expect(expireAccountSession(dead, atMinutes(500))).toBe(dead);
    expect(dead.status).toBe('REVOKED');
  });

  it('session-ttl-and-revocation：有效状态里 REVOKED 压过时间，读侧不得直接读 session.status', () => {
    const dead = revoked(5, 'ADMIN_FORCED');
    // 撤销发生在截止之前：此刻时间还没到，但状态是 REVOKED。
    expect(accountSessionEffectiveStatus(dead, atMinutes(10))).toBe('REVOKED');
    // 时间到了之后仍然是 REVOKED，不会退化成 EXPIRED。
    expect(accountSessionEffectiveStatus(dead, atMinutes(500))).toBe('REVOKED');
    expect(accountSessionEffectiveStatus(issue(), atMinutes(10))).toBe('ACTIVE');
    expect(accountSessionEffectiveStatus(issue(), atMinutes(500))).toBe('EXPIRED');
  });

  it('session-ttl-and-revocation：表里写着 ACTIVE 不能证明现在还能用 —— 过期不落账也照样被拒', () => {
    // 没有哪个进程会在到期那一秒准时把行改成 EXPIRED，所以读侧必须把时间一起算进去。
    const stale = issue();
    expect(stale.status).toBe('ACTIVE');
    expect(accountSessionEffectiveStatus(stale, atMinutes(500))).toBe('EXPIRED');
    expect(thrownCode(() => assertAccountSessionUsable(stale, atMinutes(500)))).toBe(
      'AUTHENTICATION_REQUIRED',
    );
  });
});

describe('session-ttl-and-revocation：撤销', () => {
  it('session-ttl-and-revocation：五种撤销原因都能落地，revokedAt 与 revocationReason 同时出现', () => {
    expect(ACCOUNT_SESSION_REVOCATION_REASONS).toEqual([
      'LOGOUT',
      'PASSWORD_CHANGED',
      'ADMIN_FORCED',
      'ACCOUNT_LOCKED',
      'ACCOUNT_DELETED',
    ]);
    for (const reason of ACCOUNT_SESSION_REVOCATION_REASONS) {
      const session = revoked(5, reason);
      expect(session.status, reason).toBe('REVOKED');
      expect(session.revokedAt, reason).toBe(atMinutes(5));
      expect(session.revocationReason, reason).toBe(reason);
      // 撤销不动时间戳证据以外的任何字段。
      expect(session.issuedAt, reason).toBe(NOW);
      expect(session.idleExpiresAt, reason).toBe(atMinutes(30));
      expect(session.absoluteExpiresAt, reason).toBe(atMinutes(120));
    }
  });

  it('session-ttl-and-revocation：撤销是终态 —— 再撤销一次原样返回，原因不被后来的一次覆盖', () => {
    const first = revoked(5, 'LOGOUT');
    const second = revokeAccountSession({
      session: first,
      reason: 'ADMIN_FORCED',
      now: atMinutes(50),
    });
    expect(second).toBe(first);
    expect(second.revocationReason).toBe('LOGOUT');
    expect(second.revokedAt).toBe(atMinutes(5));
  });

  it('session-ttl-and-revocation：迁移表里两个终态都没有出边，ACTIVE 只有两条去路', () => {
    expect(ACCOUNT_SESSION_TRANSITIONS.terminal).toEqual(['EXPIRED', 'REVOKED']);
    expect(ACCOUNT_SESSION_STATUSES).toEqual(['ACTIVE', 'EXPIRED', 'REVOKED']);
    expect(outgoingStates(ACCOUNT_SESSION_TRANSITIONS, 'ACTIVE')).toEqual(['EXPIRED', 'REVOKED']);
    expect(outgoingStates(ACCOUNT_SESSION_TRANSITIONS, 'EXPIRED')).toEqual([]);
    expect(outgoingStates(ACCOUNT_SESSION_TRANSITIONS, 'REVOKED')).toEqual([]);
  });

  it('session-ttl-and-revocation：过期与撤销都映射同一个 AUTHENTICATION_REQUIRED，不给探测者预言机', () => {
    // 分成两个码等于告诉对方「这条 cookie 曾经有效过」。要区分去读审计与持久层。
    const expiredCode = thrownCode(() => assertAccountSessionUsable(issue(), atMinutes(500)));
    const revokedCode = thrownCode(() =>
      assertAccountSessionUsable(revoked(5, 'LOGOUT'), atMinutes(10)),
    );
    expect(expiredCode).toBe('AUTHENTICATION_REQUIRED');
    expect(revokedCode).toBe('AUTHENTICATION_REQUIRED');
    // 抛出的 DomainError 只带值对象名，不带任何会话标识。
    const error = thrownDomainError(() => assertAccountSessionUsable(issue(), atMinutes(500)));
    expect(error.valueObject).toBe('AccountSession');
    expect(error.message).not.toContain(uuidAt(1));
    expect(() => assertAccountSessionUsable(issue(), atMinutes(10))).not.toThrow();
  });

  it('session-ttl-and-revocation：身份解析对 null / 过期 / 撤销一律返回 null，对有效会话返回 userId 与 rememberMe', () => {
    // 返回 null 与抛错分开：调用方（auth guard）自己决定是 401 还是匿名放行
    // （`GET /license` 就是必须匿名放行的那一类）。
    expect(accountSessionIdentity(null, NOW)).toBeNull();
    expect(accountSessionIdentity(issue(), atMinutes(500))).toBeNull();
    expect(accountSessionIdentity(revoked(5, 'ACCOUNT_LOCKED'), atMinutes(10))).toBeNull();
    expect(accountSessionIdentity(issue(), atMinutes(10))).toEqual({
      userId: uuidAt(2),
      rememberMe: false,
    });
    expect(accountSessionIdentity(issue(true), atMinutes(10))).toEqual({
      userId: uuidAt(2),
      rememberMe: true,
    });
    // 触摸之后身份不变：§3.2 步骤 9 的「刷新后恢复」依赖这一点 —— 恢复的前提是
    // 刷新之后请求里带的还是同一条已签发的会话，而不是又签一条新的。
    const touched = touchAccountSession(issue(), atMinutes(10));
    expect(accountSessionIdentity(touched, atMinutes(11))).toEqual({
      userId: uuidAt(2),
      rememberMe: false,
    });
  });
});

describe('session-ttl-and-revocation：构造期不变量', () => {
  function build(overrides: Partial<Parameters<typeof createAccountSession>[0]> = {}) {
    return createAccountSession({
      id: uuidAt(4),
      userId: uuidAt(2),
      rememberMe: false,
      issuedAt: NOW,
      lastSeenAt: NOW,
      idleExpiresAt: atMinutes(30),
      absoluteExpiresAt: atMinutes(120),
      ...overrides,
    });
  }

  it('session-ttl-and-revocation：状态与它的时间戳证据必须同时存在或同时不存在', () => {
    // 少了这条，「已撤销但没有撤销时刻」与「有撤销时刻但状态还是 ACTIVE」都能被构造
    // 出来，两者都会让审计对不上账。两个方向都要拦。
    expect(thrownCode(() => build({ status: 'REVOKED' }))).toBe('REQUEST_INVALID');
    expect(thrownCode(() => build({ revokedAt: atMinutes(5) }))).toBe('REQUEST_INVALID');
    expect(thrownCode(() => build({ revocationReason: 'LOGOUT' }))).toBe('REQUEST_INVALID');
    // 缺原因也算缺证据：`REVOKED` 而没有 `revocationReason` 一样构造不出来 ——
    // 运维要回答「今天有多少会话是被强制下线的」，靠的就是这个字段。
    expect(thrownCode(() => build({ status: 'REVOKED', revokedAt: atMinutes(5) }))).toBe(
      'REQUEST_INVALID',
    );
    // 正对照：三件齐全是合法的。上面四条拦的是缺件，不是撤销本身。
    const legal = build({
      status: 'REVOKED',
      revokedAt: atMinutes(5),
      revocationReason: 'LOGOUT',
    });
    expect(legal.status).toBe('REVOKED');
    expect(legal.revokedAt).toBe(atMinutes(5));
    expect(legal.revocationReason).toBe('LOGOUT');
  });

  it('session-ttl-and-revocation：撤销原因只在有撤销时刻时允许存在', () => {
    expect(
      thrownCode(() =>
        build({ status: 'EXPIRED', revokedAt: atMinutes(5), revocationReason: 'LOGOUT' }),
      ),
    ).toBe('REQUEST_INVALID');
    // 过期是时间推导，不产生任何撤销证据。
    expect(build({ status: 'EXPIRED' }).revokedAt).toBeNull();
    expect(build({ status: 'EXPIRED' }).revocationReason).toBeNull();
  });

  it('session-ttl-and-revocation：时间顺序各自独立校验', () => {
    // lastSeenAt 不能早于 issuedAt。
    expect(thrownCode(() => build({ lastSeenAt: atMinutes(-1) }))).toBe('REQUEST_INVALID');
    // 空闲截止必须严格晚于 lastSeenAt：相等意味着签发即过期，那样的会话毫无意义。
    expect(thrownCode(() => build({ idleExpiresAt: NOW }))).toBe('REQUEST_INVALID');
    // 绝对截止必须严格晚于 issuedAt。
    expect(thrownCode(() => build({ absoluteExpiresAt: NOW }))).toBe('REQUEST_INVALID');
    // 撤销不能早于签发。
    expect(
      thrownCode(() =>
        build({ status: 'REVOKED', revokedAt: atMinutes(-1), revocationReason: 'LOGOUT' }),
      ),
    ).toBe('REQUEST_INVALID');
    // 正对照：合法的时间顺序构造得出来，证明上面四条不是把一切都判成非法。
    expect(build().status).toBe('ACTIVE');
  });

  it('session-ttl-and-revocation：rememberMe 必须是布尔，未知状态一律 REQUEST_INVALID', () => {
    expect(thrownCode(() => build({ rememberMe: 'yes' }))).toBe('REQUEST_INVALID');
    expect(thrownCode(() => build({ status: 'SUSPENDED' }))).toBe('REQUEST_INVALID');
    expect(thrownCode(() => build({ id: 'not-a-uuid' }))).toBe('REQUEST_INVALID');
  });
});

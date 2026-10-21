/**
 * 平台不透明 grant URL 的客户端侧契约。
 *
 * 「不透明」的意思是：运行时**不解析、不重签、不改写**这个 URL，也不从里面读出对象身份以外
 * 的任何语义 —— 它是主站（`apps/api` = D5）签发的、指向单个对象的一次性只读凭据。运行时能
 * 且只能做三件事：
 *
 * 1. **源钉死**：只接受配置里那一个平台源。URL 里承载凭据，所以「允许去哪儿取」必须是部署期
 *    写死的一个源，而不是从 URL 自己推出来的。
 * 2. **拒绝内嵌 userinfo**：`https://user:pass@host/...` 会让「凭据在查询串里」这条脱敏规则失效。
 * 3. **有效期上限**：主站签发的 grant 有效期上限是 300 秒（`GRANT_MAX_VALIDITY_MS`）。运行时无法
 *    从一个不透明 URL 里读出到期时间，因此它执行的是**自己这一侧的使用窗口**：同一对象首次使用
 *    起算，超过上限就拒绝再用 —— 即便平台签了一个更长的 grant，运行时也不会拿着它继续取字节。
 *
 * 对象身份 = `origin + pathname`，**刻意不含查询串**。于是「为同一个对象换一个新 token」不会
 * 重置使用窗口，也不会重置字节预算（见 `byte-budget.ts` 与 `grant-fetch.ts`）。
 */

import { RuntimeGrantError, redactGrantUrl } from './errors.js';

/** 主站签发的 grant 有效期上限：300 秒。 */
export const GRANT_MAX_VALIDITY_MS = 300_000;

export interface PinnedGrantUrl {
  readonly href: string;
  readonly origin: string;
  readonly pathname: string;
  /** 对象身份：`origin + pathname`，不含查询串与片段。 */
  readonly objectKey: string;
  /** 脱敏形状，用于日志与错误消息。 */
  readonly redacted: string;
}

/**
 * 校验并钉住一个 grant URL。任何不合格都以 `RUNTIME_GRANT_URL_REJECTED` 拒绝，
 * 且错误消息里只出现脱敏形状。
 */
export function pinGrantUrl(rawUrl: string, allowedOrigin: string): PinnedGrantUrl {
  const redacted = redactGrantUrl(rawUrl);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RuntimeGrantError(
      'RUNTIME_GRANT_URL_REJECTED',
      redacted,
      `grant URL 不是合法的绝对 URL：${redacted}`,
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new RuntimeGrantError(
      'RUNTIME_GRANT_URL_REJECTED',
      redacted,
      `grant URL 不得内嵌 userinfo 凭据：${redacted}`,
    );
  }

  let allowed: URL;
  try {
    allowed = new URL(allowedOrigin);
  } catch {
    throw new RuntimeGrantError(
      'RUNTIME_GRANT_URL_REJECTED',
      redacted,
      '运行时配置的 allowedOrigin 不是合法的绝对 URL —— 这是部署配置错误，不是请求错误',
    );
  }

  if (parsed.origin !== allowed.origin) {
    throw new RuntimeGrantError(
      'RUNTIME_GRANT_URL_REJECTED',
      redacted,
      `grant URL 的源 ${parsed.origin} 不是本运行时钉住的平台源 ${allowed.origin}：${redacted}`,
    );
  }

  return {
    href: parsed.href,
    origin: parsed.origin,
    pathname: parsed.pathname,
    objectKey: `${parsed.origin}${parsed.pathname}`,
    redacted,
  };
}

export interface GrantValidityWindow {
  readonly maxValidityMs: number;
  /** 在窗口内则返回本次调用时刻并把首次使用记下来；越窗则抛错。 */
  assertUsable(pin: PinnedGrantUrl): number;
  firstUseAt(objectKey: string): number | null;
}

/**
 * grant 使用窗口。`now` 可注入，于是「超过 300 秒」是一条确定性断言，不是 sleep 出来的概率。
 */
export function createGrantValidityWindow(options: {
  now?: () => number;
  maxValidityMs?: number;
}): GrantValidityWindow {
  const now = options.now ?? Date.now;
  const maxValidityMs = options.maxValidityMs ?? GRANT_MAX_VALIDITY_MS;
  const firstUse = new Map<string, number>();

  return {
    maxValidityMs,
    assertUsable(pin) {
      const at = now();
      const previous = firstUse.get(pin.objectKey);
      if (previous === undefined) {
        firstUse.set(pin.objectKey, at);
        return at;
      }
      if (at - previous > maxValidityMs) {
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_OUTSIDE_VALIDITY_WINDOW',
          pin.redacted,
          `对象 ${pin.pathname} 的 grant 已在 ${at - previous}ms 前首次使用，超过上限 ${maxValidityMs}ms；` +
            '运行时拒绝继续使用它取字节（需要新的 grant 由主站重新签发）',
        );
      }
      return at;
    },
    firstUseAt(objectKey) {
      return firstUse.get(objectKey) ?? null;
    },
  };
}

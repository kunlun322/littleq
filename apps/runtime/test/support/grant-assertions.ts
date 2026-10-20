import { expect } from 'vitest';

import {
  createGrantByteFetcher,
  type GrantByteFetcher,
  type GrantByteFetcherOptions,
  type RuntimeGrantErrorCode,
} from '../../src/index.js';
import { SUBSTITUTE_GRANT_TOKEN, type SubstituteOrigin } from './substitute-origin.js';

/**
 * 四个 grant-fetch 测试文件共用的断言助手。
 *
 * 放在 support 里而不是各自复制一份，是因为「怎样才算失败」这件事必须只有一种写法：
 * 如果每个文件各自 `try/catch`，其中一个写成「catch 到任何东西都算过」，那条用例就悄悄
 * 变成了真空绿，而四个文件长得像，评审时看不出来。
 *
 * 同理，凭据泄漏检查被做成只接受 `expectGrantError` 的返回值：调用方没有机会「忘记传堆栈」
 * 而让这条安全断言退化成只查消息。
 */

export interface ObservedGrantError {
  readonly message: string;
  readonly redactedUrl: string;
  readonly upstreamStatus: number | null;
  readonly stack: string | undefined;
}

/** 断言这段异步确实以指定的 `RuntimeGrantErrorCode` 失败，并把错误形状交回来继续断言。 */
export async function expectGrantError(
  run: () => Promise<unknown>,
  code: RuntimeGrantErrorCode,
): Promise<ObservedGrantError> {
  const caught = await run().then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught, `期望以 ${code} 失败，实际却成功了`).not.toBeNull();
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error & {
    code?: string;
    redactedUrl?: string;
    upstreamStatus?: number | null;
  };
  expect(error.code, `失败码不是 ${code}：${error.message ?? ''}`).toBe(code);
  return {
    message: error.message,
    redactedUrl: error.redactedUrl ?? '',
    upstreamStatus: error.upstreamStatus ?? null,
    stack: error.stack,
  };
}

/**
 * 失败路径上最容易被漏掉的一条安全断言：grant URL 的查询串就是一次性凭据，
 * 它不得出现在错误消息、脱敏 URL 或堆栈里。
 */
export function expectNoGrantCredentialLeak(
  error: ObservedGrantError,
  secret: string = SUBSTITUTE_GRANT_TOKEN,
): void {
  expect(error.message).not.toContain(secret);
  expect(error.redactedUrl).not.toContain(secret);
  expect(error.redactedUrl).toContain('<REDACTED>');
  expect(error.stack ?? '').not.toContain(secret);
}

export type FetcherOverrides = Partial<Omit<GrantByteFetcherOptions, 'allowedOrigin'>>;

export function createTestFetcher(
  substitute: SubstituteOrigin,
  overrides: FetcherOverrides = {},
): GrantByteFetcher {
  return createGrantByteFetcher({
    allowedOrigin: substitute.origin,
    maxBytesPerObject: 1024,
    timeoutMs: 5000,
    ...overrides,
  });
}

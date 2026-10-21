/**
 * 「输入 grant URL → 服务端取字节」的客户端契约（ZLQ-194 §5.2 / §8.3，D4 的核心交付）。
 *
 * ## 这个契约负责什么
 *
 * 主站（`apps/api` = D5）为单个作品对象签发一个**不透明**的、有效期上限 300 秒的只读 grant URL。
 * 运行时拿它去**服务端**取字节，浏览器从头到尾看不到这个 URL，也看不到对象存储供应商的任何
 * 地址或 token。本文件是这条链路的运行时一侧，四项能力各自可判红/绿：
 *
 * 1. **timeout / abort** —— 超时与调用方中止是两条不同的路径，都必须在有限时间内确定性地失败，
 *    并且失败时不留下半截字节、不给账本记上一笔「已交付」。
 * 2. **Range 转发** —— 客户端的 `Range` 逐字转发；无论上游认不认，交付出去的都必须是合法的
 *    206/200 语义（上游不认就由运行时自己切片并回填 `Content-Range`）。
 * 3. **大小预算** —— 超限必须拒绝，且**不能靠把一次请求拆成多段 Range 绕过**：账本按对象记，
 *    换 token 不重置，多段 Range 直接拒收。
 * 4. **流式 SHA-256** —— 边收边算；最终产物哈希不一致必须拒绝，**绝不把不一致的字节交出去**。
 *
 * ## 这个契约不负责什么（诚实分层）
 *
 * 真实私有 Blob 的未授权/过期拒绝、撤销的即时生效、同一 grant 第 9 条并发路径的拒绝、
 * 跨 Range 的**权威**累计预算、真实日志里没有供应商 URL/token、以及「主站签发 → 运行外交付」
 * 端到端的产物哈希一致性 —— 全部属 D5/D6 的验收。本文件的测试对接的是
 * `apps/runtime/test/support/substitute-origin.ts` 这个**本地需要鉴权的替身源**，
 * 它证明的是客户端契约的形状，不是真实链路。
 *
 * ## 零依赖
 *
 * 只用 `node:crypto` 与全局 `fetch`。`apps/runtime` 的依赖面是空的，本文件不得改变这一点。
 */

import { createHash } from 'node:crypto';

import {
  createByteBudgetLedger,
  snapshotByteBudget,
  type ByteBudgetLedger,
  type ByteBudgetSnapshot,
} from './byte-budget.js';
import { RuntimeGrantError, normalizeHexDigest } from './errors.js';
import {
  GRANT_MAX_VALIDITY_MS,
  createGrantValidityWindow,
  pinGrantUrl,
  type PinnedGrantUrl,
} from './grant-url.js';
import {
  assertNoMainSiteCredentialHeaders,
  buildUpstreamHeaders,
  sanitizeInboundRequestHeaders,
  type RawHeaders,
} from './origin.js';
import {
  formatContentRange,
  parseByteRangeSpec,
  parseContentRange,
  resolveByteRange,
  type ByteRangeSpec,
} from './range.js';
import { sanitizeContentType } from './security-headers.js';

/** 增量哈希的最小结构面：能被注入，于是「边收边算」这件事本身是可断言的。 */
export interface IncrementalSha256 {
  update(chunk: Uint8Array): unknown;
  digest(encoding: 'hex'): string;
}

export type Sha256Factory = () => IncrementalSha256;

const defaultSha256Factory: Sha256Factory = () => createHash('sha256');

/** 运行时自己切片时，按这个块大小对切片重算摘要（与流式那份同一套增量接口）。 */
const REHASH_CHUNK_BYTES = 64 * 1024;

export interface GrantByteFetcherOptions {
  /** 唯一被允许的平台 grant 源。URL 自带凭据，所以「能去哪儿取」必须是部署期钉死的一个源。 */
  readonly allowedOrigin: string;
  readonly maxBytesPerObject: number;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sha256Factory?: Sha256Factory;
  readonly maxValidityMs?: number;
}

export interface GrantByteRequest {
  readonly grantUrl: string;
  /** 浏览器带来的原始请求头。运行时只会用其中白名单内的部分（见 `origin.ts`）。 */
  readonly inboundHeaders?: RawHeaders;
  /** 平台产物清单里的最终哈希；给了就必须一致，否则整批字节被丢弃。 */
  readonly expectedSha256?: string | null;
  readonly signal?: AbortSignal;
  /**
   * 只有**校验通过后**才会被调用一次，参数就是交付出去的字节。
   * D6 往浏览器 Response 里写的时候用它；它的存在让「不一致的字节绝不外流」可断言。
   */
  readonly onVerifiedBytes?: (bytes: Uint8Array) => void;
}

export interface GrantByteResult {
  readonly status: 200 | 206;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  /** 运行时自己算出来的摘要，覆盖的正是 `bytes`。 */
  readonly sha256: string;
  readonly contentRange: string | null;
  readonly rangeHonoredBy: 'upstream' | 'runtime' | 'none';
  /** 上游自称的 Content-Type，原样返回仅供诊断，不得直接写进响应头。 */
  readonly upstreamContentType: string | null;
  /** 必须写进响应头的那一个：已净化的 `type/subtype`。 */
  readonly contentType: string;
  readonly objectKey: string;
  readonly consumedBytes: number;
  readonly remainingBytes: number;
  readonly elapsedMs: number;
}

export interface GrantByteFetcher {
  readonly allowedOrigin: string;
  readonly maxBytesPerObject: number;
  readonly timeoutMs: number;
  readonly maxValidityMs: number;
  fetchBytes(request: GrantByteRequest): Promise<GrantByteResult>;
  /** 某个 grant URL 指向的对象当前的预算快照。键是对象身份，不是 token。 */
  budgetOf(grantUrl: string): ByteBudgetSnapshot;
  firstUseAt(grantUrl: string): number | null;
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function hashIncrementally(factory: Sha256Factory, bytes: Uint8Array): string {
  const hasher = factory();
  for (let offset = 0; offset < bytes.byteLength; offset += REHASH_CHUNK_BYTES) {
    hasher.update(bytes.subarray(offset, offset + REHASH_CHUNK_BYTES));
  }
  return hasher.digest('hex');
}

/**
 * 只报异常的 `name`，绝不报 `message`。
 *
 * undici 的 `fetch failed` 会把真实原因挂在 `cause` 上，而那里面**可能带完整 URL** ——
 * grant URL 的查询串正是一次性凭据。所以这条诊断信息刻意贫乏。
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return typeof cause === 'string' ? 'error' : 'unknown';
}

export function createGrantByteFetcher(options: GrantByteFetcherOptions): GrantByteFetcher {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sha256Factory = options.sha256Factory ?? defaultSha256Factory;
  const maxValidityMs = options.maxValidityMs ?? GRANT_MAX_VALIDITY_MS;
  const validity = createGrantValidityWindow({ now, maxValidityMs });
  const ledgers = new Map<string, ByteBudgetLedger>();

  function ledgerFor(objectKey: string): ByteBudgetLedger {
    const existing = ledgers.get(objectKey);
    if (existing !== undefined) return existing;
    const created = createByteBudgetLedger(objectKey, options.maxBytesPerObject);
    ledgers.set(objectKey, created);
    return created;
  }

  async function discardBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  async function fetchBytes(request: GrantByteRequest): Promise<GrantByteResult> {
    const pin: PinnedGrantUrl = pinGrantUrl(request.grantUrl, options.allowedOrigin);
    const startedAt = validity.assertUsable(pin);
    const ledger = ledgerFor(pin.objectKey);

    const inbound = sanitizeInboundRequestHeaders(request.inboundHeaders ?? {});
    // 白名单已经排除了凭据面。这一条是**第二把独立的锁**：它保证「哪天有人放宽白名单」
    // 不会顺手把主站 Cookie 送到平台源去。
    assertNoMainSiteCredentialHeaders(inbound, `向 ${pin.redacted} 取字节`);
    const upstreamHeaders = buildUpstreamHeaders(inbound);

    const rangeHeader = upstreamHeaders['range'] ?? null;
    let spec: ByteRangeSpec | null = null;
    if (rangeHeader !== null) {
      spec = parseByteRangeSpec(rangeHeader);
      if (spec === null) {
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_RANGE_NOT_SATISFIABLE',
          pin.redacted,
          `拒绝 Range 头「${rangeHeader}」：只接受单段 bytes 区间。多段区间把一次取回拆成多个字节段，` +
            '正是绕过大小预算的形状。',
        );
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    // 计时器覆盖**整次取字节**（含读响应体），不只是拿到响应头为止。
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        clearTimeout(timer);
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_ABORTED',
          pin.redacted,
          '调用方在发起取字节之前就已中止，未向平台源发出任何请求',
        );
      }
      request.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const classifyAbort = (): RuntimeGrantError =>
      timedOut
        ? new RuntimeGrantError(
            'RUNTIME_GRANT_TIMEOUT',
            pin.redacted,
            `grant 取字节在 ${options.timeoutMs}ms 内未完成，已中止：${pin.redacted}`,
          )
        : new RuntimeGrantError(
            'RUNTIME_GRANT_ABORTED',
            pin.redacted,
            `调用方中止了 grant 取字节：${pin.redacted}`,
          );

    try {
      let response: Response;
      try {
        response = await fetchImpl(pin.href, {
          method: 'GET',
          headers: upstreamHeaders,
          signal: controller.signal,
          // 不跟随跳转：grant URL 自带凭据，跟着 3xx 走等于把凭据送去一个没被钉住的源。
          redirect: 'manual',
          cache: 'no-store',
        });
      } catch (cause) {
        if (controller.signal.aborted) throw classifyAbort();
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_UPSTREAM_UNREACHABLE',
          pin.redacted,
          `平台 grant 源不可达：${pin.redacted}（${describeCause(cause)}）`,
        );
      }

      const status = response.status;
      if (status >= 300 && status < 400) {
        await discardBody(response);
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_URL_REJECTED',
          pin.redacted,
          `grant URL 返回重定向（HTTP ${status}）：运行时只从被钉住的那一个源取字节，不跟随跳转`,
          status,
        );
      }
      if (status === 401 || status === 403 || status === 404 || status === 410) {
        await discardBody(response);
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_UPSTREAM_REJECTED',
          pin.redacted,
          `平台拒绝了这次 grant 取字节（HTTP ${status}）：grant 可能已过期、已撤销或不属于本对象`,
          status,
        );
      }
      if (status === 416) {
        await discardBody(response);
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_RANGE_NOT_SATISFIABLE',
          pin.redacted,
          `上游判定 Range「${rangeHeader ?? ''}」不可满足（HTTP 416）`,
          status,
        );
      }
      if (status !== 200 && status !== 206) {
        await discardBody(response);
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_UNEXPECTED_STATUS',
          pin.redacted,
          `grant 取字节得到非预期状态 ${status}：只接受 200 与 206`,
          status,
        );
      }
      if (status === 206 && spec === null) {
        await discardBody(response);
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_UNEXPECTED_STATUS',
          pin.redacted,
          '没有发出 Range 却收到 206：上游响应形状与请求不一致，拒绝交付',
          status,
        );
      }

      // 预检：Content-Length 已知且已经超预算，就一个字节都不下载。
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > 0 && !ledger.fits(declaredLength)) {
        await discardBody(response);
        throw new RuntimeGrantError(
          'RUNTIME_GRANT_BUDGET_EXCEEDED',
          pin.redacted,
          `对象 ${pin.pathname} 声明 ${declaredLength} 字节，超出剩余预算 ${ledger.remainingBytes()} 字节` +
            `（上限 ${ledger.maxBytes}）；未下载响应体`,
          status,
        );
      }

      const hasher = sha256Factory();
      const chunks: Uint8Array[] = [];
      let received = 0;
      const reader = response.body?.getReader() ?? null;
      while (reader !== null) {
        let step: { done?: boolean; value?: unknown };
        try {
          step = await reader.read();
        } catch (cause) {
          await reader.cancel().catch(() => undefined);
          if (controller.signal.aborted) throw classifyAbort();
          throw new RuntimeGrantError(
            'RUNTIME_GRANT_UPSTREAM_UNREACHABLE',
            pin.redacted,
            `读取响应体时连接中断（${describeCause(cause)}）：${pin.redacted}`,
            status,
          );
        }
        if (step.done === true) break;
        const chunk = asBytes(step.value);
        if (chunk === null) {
          await reader.cancel().catch(() => undefined);
          throw new RuntimeGrantError(
            'RUNTIME_GRANT_UPSTREAM_UNREACHABLE',
            pin.redacted,
            '响应体分块不是字节视图，拒绝交付无法核算的字节',
            status,
          );
        }
        if (chunk.byteLength === 0) continue;
        received += chunk.byteLength;
        const consumed = ledger.charge(chunk.byteLength);
        if (consumed > ledger.maxBytes) {
          // 已在流式读取中截断：不读完、不交付，且**不回滚账本**（字节确实过了网络）。
          await reader.cancel().catch(() => undefined);
          throw new RuntimeGrantError(
            'RUNTIME_GRANT_BUDGET_EXCEEDED',
            pin.redacted,
            `对象 ${pin.pathname} 累计 ${consumed} 字节超出上限 ${ledger.maxBytes}；已在流式读取中截断，` +
              '未把任何字节交给调用方',
            status,
          );
        }
        hasher.update(chunk);
        chunks.push(chunk);
      }

      const full = concatChunks(chunks, received);
      let bytes = full;
      let deliveredStatus: 200 | 206 = 200;
      let contentRange: string | null = null;
      let rangeHonoredBy: GrantByteResult['rangeHonoredBy'] = 'none';

      if (spec !== null && status === 206) {
        const parsed = parseContentRange(response.headers.get('content-range'));
        const resolved = parsed?.total === null ? null : resolveByteRange(spec, parsed?.total ?? 0);
        if (
          parsed === null ||
          parsed.total === null ||
          parsed.start < 0 ||
          resolved === null ||
          resolved.start !== parsed.start ||
          resolved.end !== parsed.end ||
          full.byteLength !== parsed.end - parsed.start + 1
        ) {
          throw new RuntimeGrantError(
            'RUNTIME_GRANT_RANGE_MISMATCH',
            pin.redacted,
            `上游 206 的 Content-Range「${response.headers.get('content-range') ?? '<缺失>'}」` +
              `与请求的「${rangeHeader ?? ''}」不一致（实收 ${full.byteLength} 字节）：` +
              '拒绝把对不上的字节当作请求的那一段交付',
            status,
          );
        }
        deliveredStatus = 206;
        contentRange = formatContentRange(parsed.start, parsed.end, parsed.total);
        rangeHonoredBy = 'upstream';
      } else if (spec !== null) {
        // 上游忽略了 Range，回了 200 全量。合法的回填方式有且只有两种：由运行时自己切片并
        // 合成 Content-Range（这里选它），或者把全量原样交给客户端（那会让客户端拿到 200 却
        // 以为拿到了它要的那一段）。预算按**实际下载**的全量计，不按切片计 —— 字节确实到了。
        const resolved = resolveByteRange(spec, full.byteLength);
        if (resolved === null) {
          throw new RuntimeGrantError(
            'RUNTIME_GRANT_RANGE_NOT_SATISFIABLE',
            pin.redacted,
            `Range「${rangeHeader ?? ''}」对 ${full.byteLength} 字节的对象不可满足`,
            status,
          );
        }
        bytes = full.subarray(resolved.start, resolved.end + 1);
        deliveredStatus = 206;
        contentRange = formatContentRange(resolved.start, resolved.end, full.byteLength);
        rangeHonoredBy = 'runtime';
      }

      // 摘要必须覆盖**交付出去的那一份字节**。运行时自己切了片时，流式那份哈希覆盖的是上游
      // 全量，所以要按同一套增量接口对切片重算 —— 绝不把全量的摘要贴在切片的字节上。
      const sha256 =
        bytes === full ? hasher.digest('hex') : hashIncrementally(sha256Factory, bytes);

      const declaredDigest = response.headers.get('x-artifact-sha256');
      if (declaredDigest !== null) {
        const normalizedDeclared = normalizeHexDigest(declaredDigest);
        if (normalizedDeclared !== sha256) {
          throw new RuntimeGrantError(
            'RUNTIME_GRANT_HASH_MISMATCH',
            pin.redacted,
            `上游自称摘要 ${declaredDigest.length} 个字符，与实收 ${sha256} 不一致：` +
              '按实收字节为准并拒绝交付',
            status,
          );
        }
      }

      if (request.expectedSha256 !== undefined && request.expectedSha256 !== null) {
        const expected = normalizeHexDigest(request.expectedSha256);
        if (expected === null) {
          throw new RuntimeGrantError(
            'RUNTIME_GRANT_HASH_MISMATCH',
            pin.redacted,
            'expectedSha256 不是十六进制摘要，无法校验，拒绝交付未经验证的字节',
            status,
          );
        }
        if (expected !== sha256) {
          throw new RuntimeGrantError(
            'RUNTIME_GRANT_HASH_MISMATCH',
            pin.redacted,
            `产物哈希不一致：期望 ${expected}，实得 ${sha256}。已收到的 ${received} 字节全部丢弃，` +
              '未交给调用方。',
            status,
          );
        }
      }

      request.onVerifiedBytes?.(bytes);

      return {
        status: deliveredStatus,
        bytes,
        byteLength: bytes.byteLength,
        sha256,
        contentRange,
        rangeHonoredBy,
        upstreamContentType: response.headers.get('content-type'),
        contentType: sanitizeContentType(response.headers.get('content-type')),
        objectKey: pin.objectKey,
        consumedBytes: ledger.consumedBytes(),
        remainingBytes: ledger.remainingBytes(),
        elapsedMs: now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  return {
    allowedOrigin: options.allowedOrigin,
    maxBytesPerObject: options.maxBytesPerObject,
    timeoutMs: options.timeoutMs,
    maxValidityMs,
    fetchBytes,
    budgetOf(grantUrl) {
      const pin = pinGrantUrl(grantUrl, options.allowedOrigin);
      const ledger = ledgers.get(pin.objectKey);
      return ledger !== undefined
        ? snapshotByteBudget(ledger)
        : {
            objectKey: pin.objectKey,
            maxBytes: options.maxBytesPerObject,
            consumedBytes: 0,
            remainingBytes: options.maxBytesPerObject,
          };
    },
    firstUseAt(grantUrl) {
      return validity.firstUseAt(pinGrantUrl(grantUrl, options.allowedOrigin).objectKey);
    },
  };
}

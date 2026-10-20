import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { formatContentRange, parseByteRangeSpec, resolveByteRange } from '../../src/range.js';

/**
 * 本地 authenticated substitute：一个受控的、需要携带 grant token 才放行的替代源。
 *
 * 它**不是**主站真实的私有 Blob 授权端点，只是让 D4 的四项客户端契约
 * （超时/中止、Range 转发、大小预算、流式 SHA-256）在本地可复现地跑出红绿。
 * 真实私有 Blob 的未授权/过期拒绝、即时吊销、同 grant 第 9 路并发拒绝等，
 * 属于 D5/D6 的验收范围，替身通过不代表真实链路通过。
 */

export interface SubstituteObjectRecord {
  method: string;
  url: string;
  range: string | null;
  authorization: string | null;
  cookie: string | null;
  headerNames: string[];
  receivedAtMs: number;
}

export interface SubstituteObject {
  path: string;
  body: Uint8Array;
  contentType: string;
  /** 为真时该对象要求携带 `Authorization: <token>` 才放行。 */
  requiresToken?: boolean;
  /** 为真时忽略 Range，始终整体返回 200（模拟不支持 Range 的上游）。 */
  ignoreRange?: boolean;
  /** 为真时对任何请求都返回 403（模拟已吊销/已过期的 grant）。 */
  alwaysForbidden?: boolean;
  /** 响应头里声明的产物摘要；故意写错即可复现摘要不一致。 */
  declaredSha256?: string;
  /** 分块下发：每块字节数。缺省为一次性写入。 */
  chunkSize?: number;
  /** 分块下发：每块之间的延迟毫秒数。 */
  chunkDelayMs?: number;
  /** 收到请求后先挂起这么久再响应，用于确定性地触发客户端超时。 */
  hangMs?: number;
  /** 直接以这个状态码响应，不做任何 Range 处理。 */
  status?: number;
  /** 为真时以 302 重定向到 `redirectLocation`（验证取字节不跟随重定向）。 */
  redirectTo?: string;
  /**
   * 不写 `Content-Length`，改走分块传输编码。用来验证客户端不把声明长度当承诺：
   * 预检无从下手时，流式读取仍然必须按实际到达的字节核算并截断。
   */
  omitContentLength?: boolean;
  /**
   * 用一个假的 `Content-Range` 覆盖真实值（只在 206 上生效）。上游「嘴上说给了 10-19、
   * 实际给的是别的字节」是必须被拒绝的形状 —— 不覆盖就造不出这个反例。
   */
  contentRangeOverride?: string;
  /**
   * 写完第 `gateAfterChunks` 块之后，等 `gate()` 兑现才继续写（与 `chunkSize` 同时给才生效）。
   *
   * 这是一个**握手**，不是一次观测：把「客户端是不是边收边算」变成传输能否推进的前提。
   * 攒齐再算的实现在处理途中不会回调，于是这个 promise 永不兑现、客户端超时判红 ——
   * 反例自己会失败，而不是靠一个可能碰巧为真的时间窗。
   */
  gateAfterChunks?: number;
  gate?: () => Promise<void>;
}

export interface SubstituteOriginOptions {
  /** 合法 grant token；请求必须带 `Authorization: <token>` 才放行。 */
  token: string;
  objects: SubstituteObject[];
}

export interface SubstituteOrigin {
  origin: string;
  /** 构造一条带 token 的 grant URL（query 里放 token，模拟平台签发的一次性 URL）。 */
  grantUrl(path: string, extraQuery?: Record<string, string>): string;
  /** 构造一条 token 错误的 grant URL（模拟未授权）。 */
  badTokenGrantUrl(path: string): string;
  requests: SubstituteObjectRecord[];
  close(): Promise<void>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 启动替身源。端口由内核分配（0），因此每次运行的绝对地址不同：
 * 断言只针对 `origin` 变量本身，不写死端口。
 */
export async function startSubstituteOrigin(
  options: SubstituteOriginOptions,
): Promise<SubstituteOrigin> {
  const records: SubstituteObjectRecord[] = [];
  const byPath = new Map(options.objects.map((object) => [object.path, object]));

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '/';
    const pathOnly = url.split('?')[0] ?? '/';
    const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const record: SubstituteObjectRecord = {
      method: request.method ?? 'GET',
      url,
      range: typeof request.headers.range === 'string' ? request.headers.range : null,
      authorization:
        typeof request.headers.authorization === 'string' ? request.headers.authorization : null,
      cookie: typeof request.headers.cookie === 'string' ? request.headers.cookie : null,
      headerNames: Object.keys(request.headers).sort(),
      receivedAtMs: Date.now(),
    };
    records.push(record);

    // 客户端超时/中止会先把连接拆掉，此时服务端再写就是「写一个已销毁的响应」。
    // 替身不关心这种情况，但**不能让它变成未捕获异常**：那会让一条本该判红的用例
    // 以进程崩溃的形式失败，读日志的人分不清是契约错了还是替身炸了。
    response.on('error', () => undefined);

    const object = byPath.get(pathOnly);
    if (!object) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('no such object');
      return;
    }

    // query 里的 token 与 Authorization 头任一命中即视为已授权；两者都不对则 401。
    const headerToken = (record.authorization ?? '').replace(/^Bearer\s+/i, '');
    const authorized = headerToken === options.token || query.get('token') === options.token;
    if (object.requiresToken !== false && !authorized) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('unauthorized');
      return;
    }
    if (object.alwaysForbidden) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('forbidden');
      return;
    }
    if (object.redirectTo) {
      response.writeHead(302, { location: object.redirectTo });
      response.end();
      return;
    }
    if (object.status !== undefined) {
      response.writeHead(object.status, { 'content-type': object.contentType });
      response.end();
      return;
    }

    const respond = (): void => {
      if (response.destroyed || response.writableEnded) return;
      const totalBytes = object.body.byteLength;
      const gate =
        object.gateAfterChunks === undefined || object.gate === undefined
          ? undefined
          : { afterChunks: object.gateAfterChunks, wait: object.gate };
      const spec =
        object.ignoreRange || record.range === null ? null : parseByteRangeSpec(record.range);
      const resolved = spec === null ? null : resolveByteRange(spec, totalBytes);

      if (spec !== null && resolved === null) {
        response.writeHead(416, {
          'content-range': `bytes */${totalBytes}`,
          'content-type': 'text/plain; charset=utf-8',
        });
        response.end('range not satisfiable');
        return;
      }

      if (resolved) {
        const slice = object.body.subarray(resolved.start, resolved.end + 1);
        response.writeHead(206, {
          'content-type': object.contentType,
          ...(object.omitContentLength ? {} : { 'content-length': String(slice.byteLength) }),
          'content-range':
            object.contentRangeOverride ??
            formatContentRange(resolved.start, resolved.end, totalBytes),
          ...(object.declaredSha256 ? { 'x-artifact-sha256': object.declaredSha256 } : {}),
        });
        writeBody(response, slice, object.chunkSize, object.chunkDelayMs, gate).catch(() => {
          response.destroy();
        });
        return;
      }

      response.writeHead(200, {
        'content-type': object.contentType,
        ...(object.omitContentLength ? {} : { 'content-length': String(totalBytes) }),
        ...(object.declaredSha256 ? { 'x-artifact-sha256': object.declaredSha256 } : {}),
      });
      writeBody(response, object.body, object.chunkSize, object.chunkDelayMs, gate).catch(() => {
        response.destroy();
      });
    };

    if (object.hangMs && object.hangMs > 0) {
      void sleep(object.hangMs).then(respond);
    } else {
      respond();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const grantUrl = (path: string, extraQuery?: Record<string, string>): string => {
    const query = new URLSearchParams({ token: options.token, ...extraQuery });
    return `${origin}${path}?${query.toString()}`;
  };

  return {
    origin,
    grantUrl,
    badTokenGrantUrl: (path: string) => `${origin}${path}?token=not-the-grant-token`,
    requests: records,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function writeBody(
  response: ServerResponse,
  body: Uint8Array,
  chunkSize: number | undefined,
  chunkDelayMs: number | undefined,
  gate?: { afterChunks: number; wait: () => Promise<void> },
): Promise<void> {
  if (!chunkSize || chunkSize <= 0) {
    response.end(Buffer.from(body));
    return;
  }
  let written = 0;
  for (let offset = 0; offset < body.byteLength; offset += chunkSize) {
    if (response.destroyed || response.writableEnded) return;
    const slice = body.subarray(offset, Math.min(offset + chunkSize, body.byteLength));
    const ok = response.write(Buffer.from(slice));
    written += 1;
    if (gate !== undefined && written === gate.afterChunks) {
      await gate.wait();
    }
    if (response.destroyed || response.writableEnded) return;
    if (chunkDelayMs && chunkDelayMs > 0) {
      await sleep(chunkDelayMs);
    }
    if (!ok) {
      // 客户端已经拆掉连接时 `drain` 永远不会来，所以也要在 `close` 上醒过来，
      // 否则这个 promise 会一直挂着，把 vitest 的收尾拖成超时。
      await new Promise<void>((resolve) => {
        response.once('drain', resolve);
        response.once('close', resolve);
      });
    }
  }
  if (response.destroyed || response.writableEnded) return;
  response.end();
}

export { sha256Hex };

/** 每个替身实例默认的一次性 grant token 值。替身自己的凭据，与任何真实系统无关。 */
export const SUBSTITUTE_GRANT_TOKEN = 'substitute-grant-token';

/**
 * 起一个替身源、跑完、保证关掉。四个 grant-fetch 测试文件共用它，
 * 于是「忘记 close 导致端口/句柄泄漏让 vitest 挂住」这件事只有一处可能发生。
 */
export async function withSubstituteOrigin<T>(
  objects: SubstituteObject[],
  run: (substitute: SubstituteOrigin) => Promise<T>,
  token: string = SUBSTITUTE_GRANT_TOKEN,
): Promise<T> {
  const substitute = await startSubstituteOrigin({ token, objects });
  try {
    return await run(substitute);
  } finally {
    await substitute.close();
  }
}

/** 造一段确定的、可复现的字节（不是随机数：断言要能写死期望摘要）。 */
export function deterministicBytes(length: number, seed = 0x41): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = (seed + index * 7) % 251;
  }
  return out;
}

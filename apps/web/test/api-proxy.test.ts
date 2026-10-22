// `apps/web/src/api-proxy.ts` 的测试 —— 也就是 ZLQ-232 §3.3 那道**补偿控制**的执法层。
//
// apps/web 从静态导出翻成服务构建之后，就真的有了一个服务端进程；设计 §8 D6 原来那句
// 「没有服务端进程，也就没有可以持有凭证的地方」随之失效。补偿控制就是这个进程**只**做
// 一件事：把同源 `/api/v1/*` 转发到配置里的**单一**目标。这份测试钉的是那三条性质，
// 而不是「代理能转发」这种空断言：
//
//   1. 目标只来自配置 —— 请求里的 host / scheme / 端口**根本不参与**目标拼接；
//   2. 失败关闭 —— 每一种失败都是明确的非 2xx，绝不回落到「看起来像成功」；
//   3. 零凭证 —— 头按通用规则转发，本进程既不读凭证的值，也不添加自己的凭据。
//
// ## 上游是测试自己起的临时 node:http 服务
//
// 127.0.0.1 + 内核分配的动态端口，跑完就关。**不**连任何真实部署：真实服务会让
// 「目标被用户改掉了」和「真实服务恰好也这么答」两种情况无法区分，而前者正是这里要判的。
// 需要判「上游连不上」时用一个没人监听的端口，需要判「上游抛错」时用注入的 `fetchImpl`。
//
// ## 为什么这里全是常驻的阴性对照，而不是一次性变异
//
// 每一条安全性质都配一个**会红**的对照（例如「请求 URL 指向 evil.example 时，收到请求的
// 必须仍是配置里的那个上游」）。一次性变异只能证明「今天有人看过」，常驻对照能证明
// 「以后有人改坏也会被抓」。空壳代理也能让「转发成功」这类断言变绿，所以绿本身不是证据。
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALLOWED_METHODS,
  API_ORIGIN_ENV,
  FORWARDED_PREFIX,
  PROXY_ERROR_CODES,
  buildTargetPath,
  failureResponse,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  proxyRequest,
  resolveTarget,
} from '../src/api-proxy.js';
import type { ProxyTarget } from '../src/api-proxy.js';
import { SERVER_URL } from '../src/api-wire.js';

/** 上游收到的每一次请求，按到达顺序。断言「谁被调用了」全靠它。 */
type Received = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
};

const received: Received[] = [];

/** 上游响应里的标记头：证明回到浏览器的那份响应**确实**出自这个临时服务。 */
const UPSTREAM_MARKER = 'x-lq-probe-upstream';
const UPSTREAM_MARKER_VALUE = 'test-upstream';

let upstream: Server;
let origin: string;

beforeAll(async () => {
  upstream = createServer((request, response) => {
    received.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
    });
    const url = request.url ?? '';
    if (url.startsWith('/api/v1/probe/redirect')) {
      response.writeHead(302, { location: '/api/v1/probe/landed' });
      response.end();
      return;
    }
    if (url.startsWith('/api/v1/probe/notfound')) {
      response.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
        [UPSTREAM_MARKER]: UPSTREAM_MARKER_VALUE,
      });
      response.end(JSON.stringify({ code: 'PROJECT_NOT_FOUND', messageKey: 'project.notFound' }));
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      [UPSTREAM_MARKER]: UPSTREAM_MARKER_VALUE,
      // 会话下发必须原样回到浏览器：它是登录能成立的前提，
      // 而本进程只把它当**不透明**的头转发，不解析、不改写、不加自己的。
      'set-cookie': 'littleq_probe=1; Path=/; HttpOnly; SameSite=Lax',
    });
    response.end(JSON.stringify({ upstream: UPSTREAM_MARKER_VALUE, url }));
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  if (address === null || typeof address === 'string') {
    throw new Error('临时上游没有拿到地址');
  }
  origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve());
  });
});

/** 每次断言前清空，让「谁被调用了」的计数是这一条测试自己的。 */
function resetUpstream(): void {
  received.length = 0;
}

function env(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return { [API_ORIGIN_ENV]: origin, ...overrides };
}

/** 不用 `Buffer#buffer`：它的 `byteOffset` 未必是 0，切一份干净的出来更直白。 */
function bodyOf(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(copy).set(encoded);
  return copy;
}

type Recorded = { url: string; init: RequestInit };

/** 记录 URL 后仍走真 fetch：既能判「目标是谁」，又能真的打通临时上游。 */
function recordingFetch(records: Recorded[]): typeof fetch {
  return async (input, init) => {
    records.push({ url: String(input), init: init ?? {} });
    return fetch(input, init);
  };
}

/** 上游抛错（DNS / 拒连 / 超时的等价物）。 */
const rejectingFetch: typeof fetch = async () => {
  throw new Error('上游拒连（测试注入）');
};

async function send(
  segments: readonly string[],
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
    envOverrides?: Record<string, string>;
    fetchImpl?: typeof fetch;
    url?: string;
  } = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  return proxyRequest({
    method,
    // 这个 URL **只**用来取 search。它是不是 evil.example 恰恰是下面要判的事。
    url: options.url ?? `http://web.test/api/${segments.join('/')}`,
    headers: new Headers(options.headers ?? {}),
    body: options.body === undefined || options.body === null ? null : bodyOf(options.body),
    segments,
    env: env(options.envOverrides),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

async function readCode(response: Response): Promise<string> {
  return (JSON.parse(await response.text()) as { code?: string }).code ?? '';
}

describe('阳性对照：这套测试真的能看见流量', () => {
  it('配置正确时，请求打到临时上游，响应带着上游的标记头回来', async () => {
    resetUpstream();
    const response = await send(['v1', 'probe', 'ok']);
    expect(response.status).toBe(200);
    expect(response.headers.get(UPSTREAM_MARKER)).toBe(UPSTREAM_MARKER_VALUE);
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/api/v1/probe/ok');
    const body = JSON.parse(await response.text()) as { upstream: string };
    expect(body.upstream).toBe(UPSTREAM_MARKER_VALUE);
  });

  it('临时上游的端口是内核分配的，不是写死的 3000', async () => {
    // 写死端口的测试会与任何恰好占用该端口的进程互相污染，
    // 而「代理连到了别人」正是本文件最该排除的假绿来源。
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(origin.endsWith(':3000')).toBe(false);
  });

  it('注入的 fetchImpl 真的被用到（否则「目标是谁」的断言是空的）', async () => {
    resetUpstream();
    const records: Recorded[] = [];
    await send(['v1', 'probe', 'spy'], { fetchImpl: recordingFetch(records) });
    expect(records).toHaveLength(1);
    expect(records[0]?.url).toBe(`${origin}/api/v1/probe/spy`);
  });
});

describe('性质 1：目标只来自配置，请求里的地址一概不参与', () => {
  it('请求 URL 指向别处时，收到请求的仍然是配置里的那个上游', async () => {
    resetUpstream();
    const records: Recorded[] = [];
    const response = await send(['v1', 'probe', 'host'], {
      url: 'https://evil.example/api/v1/probe/host',
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
      fetchImpl: recordingFetch(records),
    });
    expect(response.status).toBe(200);
    expect(records).toHaveLength(1);
    expect(records[0]?.url.startsWith(`${origin}/`), `目标被请求改成了 ${records[0]?.url}`).toBe(
      true,
    );
    expect(records[0]?.url).not.toContain('evil.example');
    expect(received).toHaveLength(1);
  });

  it('带端口的请求 URL 也改不了目标（端口来自配置，不来自请求）', async () => {
    resetUpstream();
    const records: Recorded[] = [];
    await send(['v1', 'probe', 'port'], {
      url: 'http://127.0.0.1:1/api/v1/probe/port',
      fetchImpl: recordingFetch(records),
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.url.startsWith(`${origin}/`)).toBe(true);
  });

  it('目标自带路径前缀时，前缀被保留且拼接处不出现双斜杠', async () => {
    const target = resolveTarget({ [API_ORIGIN_ENV]: 'http://api.test:8080/base/' });
    expect('code' in target).toBe(false);
    expect((target as ProxyTarget).origin).toBe('http://api.test:8080');
    expect((target as ProxyTarget).basePath).toBe('/base');
    expect(buildTargetPath(target as ProxyTarget, ['v1', 'projects'])).toBe(
      '/base/api/v1/projects',
    );
  });

  it('FORWARDED_PREFIX 与浏览器侧的 SERVER_URL 是同一个前缀 —— 两份重述互相钉住', () => {
    expect(FORWARDED_PREFIX).toBe(`${SERVER_URL}/`);
    expect(FORWARDED_PREFIX).toBe('/api/v1/');
  });
});

describe('性质 2：失败关闭 —— 每一种失败都是明确的非 2xx', () => {
  const UNCONFIGURED: readonly string[] = ['', '   ', '\t\n'];
  const INVALID: readonly string[] = [
    'not-a-url',
    '/api/v1',
    '//api.test',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://api.test',
    'http://api.test/?a=1',
    'http://api.test/#frag',
  ];

  for (const raw of UNCONFIGURED) {
    it(`变量为空白（${JSON.stringify(raw)}）⇒ 503 ${PROXY_ERROR_CODES.originUnconfigured}`, async () => {
      resetUpstream();
      const response = await send(['v1', 'probe', 'x'], {
        envOverrides: { [API_ORIGIN_ENV]: raw },
      });
      expect(response.status).toBe(503);
      expect(await readCode(response)).toBe(PROXY_ERROR_CODES.originUnconfigured);
      expect(received, '失败时不该有任何请求打到上游').toHaveLength(0);
    });
  }

  it('变量缺席 ⇒ 503，且上游一次都没被调用', async () => {
    resetUpstream();
    const response = await proxyRequest({
      method: 'GET',
      url: 'http://web.test/api/v1/probe/x',
      headers: new Headers(),
      body: null,
      segments: ['v1', 'probe', 'x'],
      env: {},
    });
    expect(response.status).toBe(503);
    expect(await readCode(response)).toBe(PROXY_ERROR_CODES.originUnconfigured);
    expect(received).toHaveLength(0);
  });

  for (const raw of INVALID) {
    it(`变量不是合法 http(s) origin（${raw}）⇒ 503 ${PROXY_ERROR_CODES.originInvalid}`, async () => {
      resetUpstream();
      const response = await send(['v1', 'probe', 'x'], {
        envOverrides: { [API_ORIGIN_ENV]: raw },
      });
      expect(response.status).toBe(503);
      expect(await readCode(response)).toBe(PROXY_ERROR_CODES.originInvalid);
      expect(received).toHaveLength(0);
    });
  }

  it('上游连不上 ⇒ 502，绝不返回假数据、绝不回落本地处理', async () => {
    const dead = 'http://127.0.0.1:1';
    const response = await send(['v1', 'probe', 'x'], {
      envOverrides: { [API_ORIGIN_ENV]: dead },
    });
    expect(response.status).toBe(502);
    expect(await readCode(response)).toBe(PROXY_ERROR_CODES.upstreamUnreachable);
  });

  it('上游 fetch 抛错 ⇒ 502（DNS / 超时 / 拒连的等价物）', async () => {
    const response = await send(['v1', 'probe', 'x'], { fetchImpl: rejectingFetch });
    expect(response.status).toBe(502);
    expect(await readCode(response)).toBe(PROXY_ERROR_CODES.upstreamUnreachable);
  });

  it('失败响应永远不是 2xx，而且形状不可能被误读成成功载荷', async () => {
    // 上一轮交付的教训是「空壳也能全绿」：一个静默兜底的代理比一个报错的代理危险。
    // 所以这里判的不只是状态码，还有**体**：失败体只有一个 code 键，
    // 不含任何成功载荷会出现的键，客户端不可能把它当成项目或预览地址渲染出来。
    const failures = [
      await send(['v1', 'x'], { envOverrides: { [API_ORIGIN_ENV]: '' } }),
      await send(['v1', 'x'], { envOverrides: { [API_ORIGIN_ENV]: 'nope' } }),
      await send(['v2', 'x']),
      await send(['v1', '..']),
      await send(['v1', 'x'], { method: 'OPTIONS' }),
      await send(['v1', 'x'], { fetchImpl: rejectingFetch }),
    ];
    for (const response of failures) {
      expect(response.status, `失败却给了 ${response.status}`).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(600);
      const payload = JSON.parse(await response.text()) as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(['code']);
      expect(Object.values(PROXY_ERROR_CODES)).toContain(payload['code']);
      for (const successKey of ['project', 'currentVersion', 'activeTask', 'task', 'url']) {
        expect(payload, `失败体里出现了 ${successKey}`).not.toHaveProperty(successKey);
      }
    }
  });

  it('错误码只有那五个，本进程没有凭空发明契约里的键', () => {
    expect(Object.values(PROXY_ERROR_CODES).sort()).toEqual(
      [
        'WEB_API_METHOD_REJECTED',
        'WEB_API_ORIGIN_INVALID',
        'WEB_API_ORIGIN_UNCONFIGURED',
        'WEB_API_PATH_REJECTED',
        'WEB_API_UPSTREAM_UNREACHABLE',
      ].sort(),
    );
    for (const code of Object.values(PROXY_ERROR_CODES)) {
      expect(code.startsWith('WEB_API_'), `${code} 不像本层的码`).toBe(true);
    }
  });

  it('失败响应带 JSON content-type，failureResponse 本身也是非 2xx', () => {
    for (const status of [404, 405, 502, 503]) {
      const response = failureResponse({ status, code: PROXY_ERROR_CODES.pathRejected });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    }
  });
});

describe('路径校验：前缀收窄与逐段拒绝', () => {
  const REJECTED: readonly (readonly string[])[] = [
    [],
    ['v2', 'projects'],
    ['projects'],
    ['v1', ''],
    ['v1', '.'],
    ['v1', '..'],
    ['v1', 'projects', '..'],
    ['v1', '..', 'projects'],
    ['v1', 'a/b'],
    ['v1', 'a\\b'],
    ['v1', 'a b'],
    ['v1', 'a\rb'],
    ['v1', 'a\nb'],
    ['v1', 'a\u0000b'],
    ['v1', 'a\u007fb'],
    ['v1', 'https://evil.example'],
    ['v1', '/../secret'],
  ];

  for (const segments of REJECTED) {
    it(`拒绝 ${JSON.stringify(segments)} ⇒ 404 ${PROXY_ERROR_CODES.pathRejected}`, async () => {
      resetUpstream();
      const response = await send(segments);
      expect(response.status).toBe(404);
      expect(await readCode(response)).toBe(PROXY_ERROR_CODES.pathRejected);
      expect(received, '被拒的路径不该打到上游').toHaveLength(0);
    });
  }

  it('buildTargetPath 对同样的段返回失败对象，而不是抛异常', () => {
    const target = resolveTarget(env());
    expect('code' in target).toBe(false);
    for (const segments of REJECTED) {
      const path = buildTargetPath(target as ProxyTarget, segments);
      expect(typeof path, `${JSON.stringify(segments)} 竟然通过了`).not.toBe('string');
      expect((path as { code: string }).code).toBe(PROXY_ERROR_CODES.pathRejected);
    }
  });

  it('合法段会被重新编码：原本的 %2F 不会在上游被第二次解码成分隔符', async () => {
    resetUpstream();
    const records: Recorded[] = [];
    await send(['v1', 'a%2Fb'], { fetchImpl: recordingFetch(records) });
    expect(records).toHaveLength(1);
    // `%2F` ⇒ `%252F`。双重编码是**安全**的那一侧：上游解一次得到字面 `a%2Fb`。
    expect(records[0]?.url).toBe(`${origin}/api/v1/a%252Fb`);
    expect(records[0]?.url).not.toContain('/api/v1/a/b');
  });

  it('两种「段里带 %2F」的解码结果都逃不出 basePath —— 一种被拒，一种被双重编码', () => {
    // 浏览器请求 `/api/v1/%2F..%2F` 时，段到底是**已解码**还是**未解码**取决于框架，
    // 两条路都必须安全，所以两条都钉：
    //   ① 已解码 ⇒ 段里出现真的 `/` ⇒ 直接拒（上面 REJECTED 里的 `a/b` 就是这个形状）；
    //   ② 未解码 ⇒ 段是字面 `%2F..%2F` ⇒ 通过校验，但重新编码成 `%252F..%252F`，
    //      上游解一次得到**字面**的 `%2F..%2F`，一个字符也不会变成路径分隔符。
    const resolved = resolveTarget(env());
    if ('code' in resolved) throw new Error('测试环境的目标解析失败了');
    expect(typeof buildTargetPath(resolved, ['v1', '/../'])).not.toBe('string');
    expect(buildTargetPath(resolved, ['v1', '%2F..%2F'])).toBe('/api/v1/%252F..%252F');
  });

  it('冒号一律开启动词半段：`a:b` 因此是合法的动词形态，而不是「标识里带个冒号」', () => {
    // 实测事实：段里**第一个**冒号之后的部分就是动词，所以「标识半段含冒号」这个形态
    // 根本表达不出来 —— `a:b` 只能读成「标识 a + 动词 b」。这不是漏洞：动词半段被
    // `^[a-z][a-z0-9]*$` 限死（不含 `/` `.` `:` 空白与控制字符），所以它既不能引入新的
    // 路径段，也不能出现第二个冒号。真正要防的是「第二个冒号」，下面那条钉它。
    const target = resolveTarget(env());
    if ('code' in target) throw new Error('测试环境的目标解析失败了');
    expect(buildTargetPath(target, ['v1', 'a:b'])).toBe('/api/v1/a:b');
    expect(typeof buildTargetPath(target, ['v1', 'a:b:c'])).not.toBe('string');
    // 含空白的段直接拒，不是编成 %20 放过去。
    expect(typeof buildTargetPath(target, ['v1', 'a b'])).not.toBe('string');
  });

  it('search 原样透传；fragment 到不了上游；裸 CR/LF 被拒', async () => {
    resetUpstream();
    const ok = await send(['v1', 'projects'], { url: `${origin}/api/v1/projects?page=2` });
    expect(ok.status).toBe(200);
    expect(received[0]?.url).toBe('/api/v1/projects?page=2');

    // 实测事实：`new URL(...)` 已经把 `#frag` 拆进 `.hash`，所以 `.search` 里**永远不会**
    // 出现 `#` —— `sanitizeSearch` 的那条 `#` 检查因此是纵深防御（防的是直接调用者），
    // 走 `proxyRequest` 这条路触发不到。真正要钉的性质是：**fragment 不会跟着转发到上游**。
    resetUpstream();
    const withFragment = await send(['v1', 'projects'], {
      url: 'http://web.test/api/v1/projects?a=1#frag',
    });
    expect(withFragment.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.url, 'fragment 泄漏到了上游').toBe('/api/v1/projects?a=1');
    expect(received[0]?.url).not.toContain('frag');

    // `%0d%0a` 在 `.search` 里仍是**编码态**，不含裸 CR/LF，所以原样透传；
    // 这条钉的是「透传不会把它解码成请求头注入」。裸 CR/LF 那一侧由 REJECTED 段覆盖。
    resetUpstream();
    const encoded = await send(['v1', 'projects'], {
      url: 'http://web.test/api/v1/projects?a=1%0d%0aInjected:1',
    });
    expect(encoded.status).toBe(200);
    expect(received[0]?.url).toBe('/api/v1/projects?a=1%0d%0aInjected:1');
  });

  it('sanitizeSearch 的裸 CR/LF 与 fragment 防线：段里带 CRLF 的请求在路径层就被拒', async () => {
    // 段里的 CR/LF 走的是 `buildTargetPath` 的控制字符检查，不是 `sanitizeSearch`。
    // 两层各管一半，所以两层都要有会红的用例，否则「挡 CRLF 注入」只是注释里的说法。
    resetUpstream();
    const response = await send(['v1', 'projects\r\nInjected: 1']);
    expect(response.status).toBe(404);
    expect(await readCode(response)).toBe(PROXY_ERROR_CODES.pathRejected);
    expect(received).toHaveLength(0);
  });
});

describe('AIP-136 自定义动词：冒号是动作分隔符，不是普通字符', () => {
  const target = (): ProxyTarget => {
    const resolved = resolveTarget(env());
    if ('code' in resolved) throw new Error('测试环境的目标解析失败了');
    return resolved;
  };

  it('`tasks/<id>:pump` 的冒号原样保留，上游路由才匹配得上', () => {
    expect(buildTargetPath(target(), ['v1', 'tasks', 'abc:pump'])).toBe('/api/v1/tasks/abc:pump');
    expect(buildTargetPath(target(), ['v1', 'tasks', 'abc:pump7'])).toBe('/api/v1/tasks/abc:pump7');
  });

  it('端到端：四步闭环里的 pump 请求真的以字面冒号到达上游', async () => {
    resetUpstream();
    const response = await send(['v1', 'tasks', 'abc:pump'], { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('POST');
    expect(received[0]?.url).toBe('/api/v1/tasks/abc:pump');
    expect(received[0]?.url).not.toContain('%3A');
  });

  const REJECTED_VERBS: readonly string[] = [
    '..:pump',
    'abc:pump:again',
    'abc:PUMP',
    'abc:',
    ':pump',
    'abc:../x',
    'abc:pump/x',
    'abc: pump',
    'abc:pump\u0000',
    'abc:9pump',
  ];

  for (const segment of REJECTED_VERBS) {
    it(`拒绝动词半段 ${JSON.stringify(segment)}`, () => {
      const path = buildTargetPath(target(), ['v1', 'tasks', segment]);
      expect(typeof path, `${segment} 竟然通过了`).not.toBe('string');
    });
  }

  it('解码后长得像 scheme 的写法过不了：动词半段里的 `/` 与 `.` 直接拒', () => {
    // `https:/evil.example` 的标识半段 `https` 能过校验，
    // 但动词半段 `//evil.example` 含 `/`，所以整段被拒。
    expect(typeof buildTargetPath(target(), ['v1', 'https:/evil.example'])).not.toBe('string');
    expect(typeof buildTargetPath(target(), ['v1', 'https://evil.example'])).not.toBe('string');
  });
});

describe('方法：405 在解析目标之前短路', () => {
  const REJECTED_METHODS = ['OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND'] as const;

  for (const method of REJECTED_METHODS) {
    it(`${method} ⇒ 405，且上游与目标解析都没被碰到`, async () => {
      resetUpstream();
      const records: Recorded[] = [];
      const response = await send(['v1', 'probe', 'x'], {
        method,
        fetchImpl: recordingFetch(records),
      });
      expect(response.status).toBe(405);
      expect(await readCode(response)).toBe(PROXY_ERROR_CODES.methodRejected);
      expect(records).toHaveLength(0);
      expect(received).toHaveLength(0);
    });
  }

  it('405 优先于 503：方法不对时连目标都不必解析（405 比 503 更可操作）', async () => {
    const response = await send(['v1', 'probe', 'x'], {
      method: 'OPTIONS',
      envOverrides: { [API_ORIGIN_ENV]: '' },
    });
    expect(response.status).toBe(405);
    expect(await readCode(response)).toBe(PROXY_ERROR_CODES.methodRejected);
  });

  it('允许的方法恰好是六个，CORS 预检不在其中', () => {
    expect([...ALLOWED_METHODS]).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
    expect(ALLOWED_METHODS as readonly string[]).not.toContain('OPTIONS');
  });

  it('小写方法被规范化后照常转发', async () => {
    resetUpstream();
    const response = await send(['v1', 'probe', 'lower'], { method: 'post', body: '{}' });
    expect(response.status).toBe(200);
    expect(received[0]?.method).toBe('POST');
  });
});

describe('性质 3：零凭证 —— 头按通用规则转发', () => {
  it('逐跳头、host、content-length、accept-encoding 都被摘掉，其余原样过去', async () => {
    resetUpstream();
    await send(['v1', 'probe', 'headers'], {
      method: 'POST',
      body: '{"a":1}',
      headers: {
        'content-type': 'application/json',
        'x-probe-opaque': 'pass-through',
        'accept-encoding': 'br;q=1.0, x-probe-browser-value',
        accept: 'application/json',
        'accept-language': 'zh-CN',
        'if-match': '"rev-3"',
        'idempotency-key': '01890b1a-2f01-7abc-8def-0123456789ab',
      },
    });
    expect(received).toHaveLength(1);
    const headers = received[0]?.headers ?? {};
    expect(headers['x-probe-opaque']).toBe('pass-through');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['if-match']).toBe('"rev-3"');
    expect(headers['idempotency-key']).toBe('01890b1a-2f01-7abc-8def-0123456789ab');
    // 浏览器给的 accept-encoding 必须摘掉：undici 会**自己**解压上游响应，
    // 若把浏览器的值透传上去而上游照它压缩，响应头又被原样转回浏览器，
    // 浏览器就会去解一份已经是明文的字节 —— 表现为整站响应损坏，且只在真实网络下复现。
    // ⚠️ 实测：上游看到的 `accept-encoding` **不为空**，那是 undici 自己加的 `gzip, deflate`。
    // 所以这里判的是「浏览器那个值没过去」，而不是「这个头不存在」——
    // 后者是一个在当前实现下**永远为假**的断言，写成那样只会得到一条假红或者被人删掉。
    // undici 自己加压缩头是安全的，前提正是响应侧摘掉了 content-encoding（下面那条钉它）。
    const acceptEncoding = String(headers['accept-encoding'] ?? '');
    expect(acceptEncoding, '浏览器的 accept-encoding 被透传了').not.toContain(
      'x-probe-browser-value',
    );
    // host 必须是上游自己的，否则虚拟主机与路由都会判错。
    expect(headers['host'], `host 被透传成了 ${String(headers['host'])}`).not.toBe('web.test');
  });

  it('forwardableRequestHeaders 摘掉全部逐跳头与 proxy-* 家族', () => {
    const source = new Headers();
    for (const name of [
      'connection',
      'keep-alive',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'proxy-authorization',
      'proxy-custom',
      'host',
      'content-length',
      'accept-encoding',
    ]) {
      source.append(name, 'x');
    }
    source.append('x-probe-keep', 'yes');
    const out = forwardableRequestHeaders(source);
    for (const name of [
      'connection',
      'keep-alive',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'proxy-authorization',
      'proxy-custom',
      'host',
      'content-length',
      'accept-encoding',
    ]) {
      expect(out.get(name), `${name} 竟然被转发了`).toBeNull();
    }
    expect(out.get('x-probe-keep')).toBe('yes');
  });

  it('响应头也按通用规则回去：摘掉长度与编码，保留会话下发', () => {
    const source = new Headers();
    source.append('content-length', '123');
    source.append('content-encoding', 'gzip');
    source.append('connection', 'close');
    source.append('set-cookie', 'littleq_probe=1; Path=/; HttpOnly');
    source.append('cache-control', 'no-store');
    const out = forwardableResponseHeaders(source);
    // body 已被 undici 解成明文、长度也变了，原样转回就是撒谎。
    expect(out.get('content-length')).toBeNull();
    expect(out.get('content-encoding')).toBeNull();
    expect(out.get('connection')).toBeNull();
    expect(out.get('set-cookie')).toContain('littleq_probe=1');
    expect(out.get('cache-control')).toBe('no-store');
  });

  it('端到端：上游的标记头与会话下发原样回到浏览器，且没有被加上本进程的凭据', async () => {
    resetUpstream();
    const response = await send(['v1', 'probe', 'response-headers']);
    expect(response.headers.get(UPSTREAM_MARKER)).toBe(UPSTREAM_MARKER_VALUE);
    expect(response.headers.get('set-cookie')).toContain('littleq_probe=1');
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('源文件里不出现任何具体凭证头的名字 —— 白名单会变成需要随契约演进的负担', () => {
    // 「转发全部、只摘掉逐跳头」既正确又无需维护；逐个列出允许的头则相反。
    // 这条判的是**实现方式**没有偷偷退化成枚举凭证头。
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'api-proxy.ts'), 'utf8');
    for (const carrier of ['Authorization', 'Bearer ', 'apiKey', 'API_KEY']) {
      expect(source, `api-proxy.ts 里出现了 ${carrier}`).not.toContain(carrier);
    }
    // 阳性对照：同一份文件里确实有头名的枚举（逐跳头），
    // 所以上面那几条 0 命中不是因为整个文件被读成了空串。
    expect(source).toContain("'accept-encoding'");
    expect(source).toContain('transfer-encoding');
  });
});

describe('重定向与状态码：不洗掉上游的真实回答', () => {
  it('上游的 3xx 原样回到浏览器，且只被调用一次（不跟随）', async () => {
    resetUpstream();
    const records: Recorded[] = [];
    const response = await send(['v1', 'probe', 'redirect'], {
      fetchImpl: recordingFetch(records),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/api/v1/probe/landed');
    expect(records, '跟随重定向会把「目标配错了」洗成一个 200').toHaveLength(1);
    expect(received).toHaveLength(1);
  });

  it('上游的 4xx 原样透传，连错误体一起，不被改写成本层的失败形状', async () => {
    resetUpstream();
    const response = await send(['v1', 'probe', 'notfound']);
    expect(response.status).toBe(404);
    expect(response.headers.get(UPSTREAM_MARKER)).toBe(UPSTREAM_MARKER_VALUE);
    const payload = JSON.parse(await response.text()) as Record<string, unknown>;
    // 契约的错误信封必须活着到达浏览器：若被本层换成 WEB_API_* 的码，
    // 客户端就查不到 messageKey 对应的文案，也就分不清「代理坏了」和「项目不存在」。
    expect(payload['code']).toBe('PROJECT_NOT_FOUND');
    expect(payload['messageKey']).toBe('project.notFound');
    expect(received).toHaveLength(1);
  });

  it('GET/HEAD 不带请求体，POST 带', async () => {
    resetUpstream();
    await send(['v1', 'probe', 'no-body']);
    await send(['v1', 'probe', 'with-body'], { method: 'POST', body: '{"hello":"world"}' });
    expect(received).toHaveLength(2);
    expect(received[0]?.method).toBe('GET');
    expect(received[1]?.method).toBe('POST');
  });
});

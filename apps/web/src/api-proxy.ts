/**
 * 同源 `/api/*` 代理的**全部**逻辑。
 *
 * 这个文件是 ZLQ-232 §3.3 那条补偿控制的实现体：`apps/web` 翻成服务构建之后就真的有了
 * 一个服务端进程，于是设计 §8 D6 原来那句「没有服务端进程，也就没有可以持有凭证的地方」
 * 不再成立。对价是这个进程**只**做一件事：把同源 `/api/v1/*` 转发到配置里的**单一**目标。
 *
 * ## 三条不可让渡的性质（每条都在 `apps/web/test/api-proxy.test.ts` 里被钉住）
 *
 * 1. **目标只来自配置。** 唯一的输入是环境变量 `LQ_API_ORIGIN`。请求里出现的任何
 *    host / scheme / 端口都不参与目标拼接 —— 不是「校验后使用」，是**根本不读**。
 *    结构上不可能变成通用开放代理。
 * 2. **失败关闭。** 变量缺席、为空、不是合法 http(s) URL、上游连不上 —— 四种情况都返回
 *    明确的错误，**绝不**返回一个看起来像成功的 2xx，也**绝不**回落到「那就直接在本进程
 *    里处理」。上一轮交付的教训就是空壳也能全绿：一个静默兜底的代理比一个报错的代理危险。
 * 3. **零凭证。** 本进程不持有任何模型、数据库或第三方服务凭证，转发时也**不附加**自己的
 *    任何凭据。所有请求头按**通用**规则转发，因此本文件不出现任何具体凭证头的名字 ——
 *    这不是为了躲扫描，而是因为「逐个列出允许的头」会变成一份需要随契约演进的白名单，
 *    而「转发全部、只摘掉逐跳头」既正确又无需维护。
 *
 * ## 为什么逻辑不在 `route.ts` 里
 *
 * `app/api/[...path]/route.ts` 必须 `import 'server-only'`（依赖图受控边
 * `web-server-adapter-only-controlled-api-entry` 的 `requireSpecifiers`，也是构建期兜底：
 * 一旦这个适配层被客户端图引用到，`next build` 直接抛）。而 `server-only` 在 vitest 的
 * node 环境里**就是会抛**，所以把逻辑放这里、让 `route.ts` 只做一层薄适配，这个文件才
 * 可以被真正测到。
 */

/** 目标 origin 的唯一来源。不是 `NEXT_PUBLIC_*`：这个值只存在于服务端。 */
export const API_ORIGIN_ENV = 'LQ_API_ORIGIN';

/**
 * 代理只转发这一个前缀下的路径。
 *
 * 抄自契约的 `SERVER_URL`。把前缀写死在这里是有意的收窄：`/api/*` 下的**任意**路径都能
 * 被转发就等于把整个上游暴露成一个通用中继；只认 `/api/v1/` 之后，新增一个 API 版本必须
 * 同时改这一行 —— 一次显式的、会被 review 看见的动作。
 */
export const FORWARDED_PREFIX = '/api/v1/';

/** 从 `FORWARDED_PREFIX` 拆出来的两段：路由挂载点与 API 版本。 */
const PREFIX_SEGMENTS = FORWARDED_PREFIX.split('/').filter((part) => part !== '');
const MOUNT_SEGMENT = PREFIX_SEGMENTS[0] ?? 'api';
const VERSION_SEGMENT = PREFIX_SEGMENTS[1] ?? 'v1';

/** 逐跳头：按 RFC 9110 §7.6.1，它们属于单跳连接，不得被转发。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 请求侧额外要摘掉的头。
 *
 * `host` 必须摘：留着它，上游看到的就是本站的 host，虚拟主机与路由都会判错。
 * `content-length` 必须摘：本文件用 `arrayBuffer()` 重放请求体，长度由 fetch 自己算。
 * `accept-encoding` 必须摘：undici 会**自己**解压上游响应，若把浏览器给的值透传上去，
 *   上游按它压缩后回 `content-encoding: gzip`，而响应头又被原样转回浏览器，浏览器就会去解
 *   一份已经是明文的字节 —— 表现为整站响应损坏，而且只在真实网络下复现。
 *   ⚠️ 摘掉的是**浏览器的**那一份：实测上游仍会看到 `accept-encoding: gzip, deflate`，
 *   那是 undici 发请求时自己加的，本文件管不着也不该管。它之所以安全，靠的正是
 *   `RESPONSE_ONLY_DROPS` 摘掉了响应侧的 `content-encoding`。所以别把这里的不变量
 *   写成「上游看不到 accept-encoding」—— 那是一个永远为假的断言。
 */
const REQUEST_ONLY_DROPS = new Set(['host', 'content-length', 'accept-encoding']);

/**
 * 响应侧额外要摘掉的头。
 *
 * `content-encoding` 与 `content-length` 同上：body 已被 undici 解成明文，长度也变了，
 * 原样转回就是撒谎。
 */
const RESPONSE_ONLY_DROPS = new Set(['content-length', 'content-encoding']);

/** 代理允许的写方法。GET/HEAD 之外只有这五个，其余一律 405。 */
export const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * 本进程自己的错误码。
 *
 * **刻意不套用契约的错误信封**（`{code, messageKey, retryable, traceId}`）：那是 API 层的
 * 领域错误形状，客户端会按 `messageKey` 去查文案表。代理层的失败没有 messageKey，硬凑一个
 * 就等于凭空发明契约里没有的键 —— 客户端拿到一个查不到的 messageKey，比拿到一个明显来自
 * 另一层的错误更难诊断。
 */
export const PROXY_ERROR_CODES = {
  /** `LQ_API_ORIGIN` 缺席或为空：没有配置就没有目标，失败关闭。 */
  originUnconfigured: 'WEB_API_ORIGIN_UNCONFIGURED',
  /** `LQ_API_ORIGIN` 不是合法的 http(s) URL，或带了 query / fragment。 */
  originInvalid: 'WEB_API_ORIGIN_INVALID',
  /** 路径不在 `FORWARDED_PREFIX` 之下，或含 `.` / `..` / 分隔符 / 控制字符。 */
  pathRejected: 'WEB_API_PATH_REJECTED',
  /** 方法不在 `ALLOWED_METHODS` 里。 */
  methodRejected: 'WEB_API_METHOD_REJECTED',
  /** 上游连不上（DNS、拒连、超时）。可重试，但**不是**成功。 */
  upstreamUnreachable: 'WEB_API_UPSTREAM_UNREACHABLE',
} as const;

export type ProxyErrorCode = (typeof PROXY_ERROR_CODES)[keyof typeof PROXY_ERROR_CODES];

/** 失败关闭时返回的状态码与错误码。 */
export type ProxyFailure = { status: number; code: ProxyErrorCode };

/** 一个已经校验过的转发目标。`basePath` 允许目标自带路径前缀（可为空串）。 */
export type ProxyTarget = { origin: string; basePath: string };

/**
 * 从配置解析目标。
 *
 * 三种拒绝：缺席/空白 ⇒ `originUnconfigured`；不是合法 URL、协议不是 http(s)、带了
 * query 或 fragment ⇒ `originInvalid`。后两条分开报，是因为它们的修法不同：前者是「变量
 * 写错了」，后者是「把一整条 URL 当成了 origin」。
 */
export function resolveTarget(env: Record<string, string | undefined>): ProxyTarget | ProxyFailure {
  const raw = env[API_ORIGIN_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { status: 503, code: PROXY_ERROR_CODES.originUnconfigured };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { status: 503, code: PROXY_ERROR_CODES.originInvalid };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { status: 503, code: PROXY_ERROR_CODES.originInvalid };
  }
  if (url.search !== '' || url.hash !== '') {
    return { status: 503, code: PROXY_ERROR_CODES.originInvalid };
  }
  // 去掉尾部斜杠，`basePath` 才能与「以 / 打头的路径」直接拼接而不出现 `//`。
  const basePath = url.pathname.replace(/\/+$/, '');
  return { origin: url.origin, basePath };
}

/**
 * 逐段校验路径，并拼出上游路径。
 *
 * `segments` 是 Next 的 catch-all 参数，即浏览器路径 `/api/<segments…>` 里 `/api` 之后
 * 的那几段，**已解码**。上游要的是完整的 `/api/v1/…`，所以挂载点 `api` 由本函数补回。
 *
 * 因为拿到的是已解码的段，`..` 会原样出现在这里。拒绝规则：
 *   - 第一段必须是 `v1` —— 前缀收窄，见 `FORWARDED_PREFIX` 的说明；
 *   - 段为空、`.`、`..`，或含 `/` `\` —— 任何一个都能让拼出来的路径逃出 `basePath`；
 *   - 段含控制字符或空白 —— 挡 CRLF 注入（把 `\r\n` 塞进请求行的经典手法）。
 *
 * 通过校验之后每一段再过一次 `encodeURIComponent`：**解码 → 校验 → 重新编码**，保证段里
 * 原本的 `%2F` 不会在上游被第二次解码成路径分隔符。代价是合法百分号编码会被双重编码
 * （`%20` → `%2520`）；本切片的路径参数只有 UUID v7，字符集是 `[0-9a-f-]`，不受影响，
 * 而双重编码本身就是**安全**的那一侧。
 *
 * ## 冒号是动作分隔符，不是普通字符
 *
 * 契约用 Google AIP-136 的自定义动词写法：`POST /tasks/{id}:pump`。而
 * `encodeURIComponent(':')` 是 `%3A` —— 整段编码会把动词一起编掉，上游路由就匹配不上了。
 * 所以这里把段拆成「标识 + 可选的 `:动词`」两半：
 *   - 上面那三条校验**只**施加在标识半段上（`..:pump` 因此仍然被拒）；
 *   - 动词半段必须匹配 `^[a-z][a-z0-9]*$` —— 不含 `/` `.` `:` 空白，所以它既不能引入
 *     新的路径段，也不能出现第二个冒号（两个冒号 ⇒ 动词半段里含 `:` ⇒ 拒）。
 *
 * 这不是放宽：`https:/evil.example` 这类解码后长得像 scheme 的写法仍然过不了 —— 它的
 * 标识半段 `https` 能过校验，但动词半段 `//evil.example` 含 `/` 与 `.`，直接拒。
 * 而目标 origin 本来就只来自配置，段里的任何内容都参与不了目标拼接。
 */
const ACTION_SUFFIX = /^[a-z][a-z0-9]*$/;

/**
 * 段里是否含 C0 控制字符或 DEL。
 *
 * 用码点扫描而不是 `/[\u0000-\u001f\u007f]/`：`no-control-regex` 拦的是**意外**混进正则的
 * 控制字符，而这里恰恰是刻意要拒它们。与其加一条 `eslint-disable` 把这个意图藏进注释，
 * 不如写成读一眼就知道在干什么的循环 —— 一条被关掉的正则规则，下一个人看不出它是
 * 「这里必须拒控制字符」还是「有人为了让 lint 过而关的」。
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function buildTargetPath(
  target: ProxyTarget,
  segments: readonly string[],
): string | ProxyFailure {
  const rejected: ProxyFailure = { status: 404, code: PROXY_ERROR_CODES.pathRejected };
  if (segments.length === 0 || segments[0] !== VERSION_SEGMENT) return rejected;
  const encoded: string[] = [];
  for (const segment of segments) {
    const colon = segment.indexOf(':');
    const identity = colon === -1 ? segment : segment.slice(0, colon);
    const action = colon === -1 ? null : segment.slice(colon + 1);
    if (identity === '' || identity === '.' || identity === '..') return rejected;
    if (/[/\\\s]/.test(identity) || hasControlCharacter(identity)) return rejected;
    if (action !== null && !ACTION_SUFFIX.test(action)) return rejected;
    encoded.push(
      action === null ? encodeURIComponent(identity) : `${encodeURIComponent(identity)}:${action}`,
    );
  }
  return `${target.basePath}/${MOUNT_SEGMENT}/${encoded.join('/')}`;
}

/** 一个头是否属于逐跳头（含 `proxy-*` 家族：它们按定义只在单跳内有意义）。 */
function isHopByHop(name: string): boolean {
  const lower = name.toLowerCase();
  return HOP_BY_HOP.has(lower) || lower.startsWith('proxy-');
}

/**
 * 通用转发请求头。
 *
 * 全量透传再摘掉逐跳头，因此**任何**凭证载体都是不透明地路过本进程：既不读它的值，
 * 也不判断它是什么，更不添加自己的。会话识别与鉴权判定全部留在 API 层。
 */
export function forwardableRequestHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (isHopByHop(lower) || REQUEST_ONLY_DROPS.has(lower)) continue;
    out.append(name, value);
  }
  return out;
}

/** 通用转发响应头。摘掉逐跳头与两个长度/编码头，其余（含会话下发）原样回到浏览器。 */
export function forwardableResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (isHopByHop(lower) || RESPONSE_ONLY_DROPS.has(lower)) continue;
    out.append(name, value);
  }
  return out;
}

/** 失败关闭时的响应体。永远是非 2xx，永远带一个明确的错误码。 */
export function failureResponse(failure: ProxyFailure): Response {
  return new Response(JSON.stringify({ code: failure.code }), {
    status: failure.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** `search` 只允许原样透传：不允许 fragment，不允许 CR/LF。 */
function sanitizeSearch(search: string): string | null {
  if (search === '') return '';
  if (!search.startsWith('?')) return null;
  if (search.includes('#') || /[\r\n]/.test(search)) return null;
  return search;
}

export type ProxyRequestInput = {
  method: string;
  /** 完整请求 URL，仅用于取 `search`。**绝不**用于决定目标。 */
  url: string;
  headers: Headers;
  body: ArrayBuffer | null;
  segments: readonly string[];
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

/**
 * 执行一次转发。
 *
 * 顺序是刻意的：先判方法，再解析目标，最后拼路径。方法不对时连目标都不必解析 —— 报
 * 405 比报 503 更可操作。`redirect: 'manual'` 让上游的 3xx 原样回到浏览器：跟随重定向会
 * 把「目标配置错了，上游把我们弹到登录页」这类错误洗成一个 200。
 */
export async function proxyRequest(input: ProxyRequestInput): Promise<Response> {
  const method = input.method.toUpperCase();
  if (!ALLOWED_METHODS.includes(method as (typeof ALLOWED_METHODS)[number])) {
    return failureResponse({ status: 405, code: PROXY_ERROR_CODES.methodRejected });
  }

  const target = resolveTarget(input.env);
  if ('code' in target) return failureResponse(target);

  const path = buildTargetPath(target, input.segments);
  if (typeof path !== 'string') return failureResponse(path);

  const search = sanitizeSearch(new URL(input.url).search);
  if (search === null) {
    return failureResponse({ status: 404, code: PROXY_ERROR_CODES.pathRejected });
  }

  const doFetch = input.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await doFetch(`${target.origin}${path}${search}`, {
      method,
      headers: forwardableRequestHeaders(input.headers),
      body: method === 'GET' || method === 'HEAD' ? undefined : (input.body ?? undefined),
      redirect: 'manual',
    });
  } catch {
    // 上游连不上。**不**返回假数据、**不**回落本地处理。
    return failureResponse({ status: 502, code: PROXY_ERROR_CODES.upstreamUnreachable });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardableResponseHeaders(upstream.headers),
  });
}

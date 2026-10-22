/**
 * 浏览器侧调用同源 `/api/*` 的唯一入口。
 *
 * ## 三条约束
 *
 * 1. **一律同源。** 这里的每个 `path` 都以 `/api/v1` 打头，从不拼绝对 URL。`vercel.json`
 *    的 CSP 是 `connect-src 'self'`，而 §3.3 明令「不加 API 域名，不放宽 CORS，禁止浏览器
 *    直连 API」—— 所以直连在**浏览器层就会被 CSP 挡掉**，这条约束有两层执法。
 * 2. **不读任何 Cookie。** CSRF 令牌由服务端组件读出来当 prop 传进来（见
 *    `app/create/page.tsx`）；会话 Cookie 是 HttpOnly 的，浏览器侧代码根本读不到它的值，
 *    也不需要读。`apps/web/test/index.test.ts` 里「凭证载体零命中」那条断言把浏览器侧
 *    读 Cookie 的那个 DOM API 一起扫，本文件必须让它保持绿 —— 而那条断言扫的是**原文**，
 *    所以这里连它的名字都不能写出来，只能用中文描述。
 * 3. **不把任何 2xx 都当成功。** 每条调用都带一个 `expectedStatus`，状态码不符按失败处理。
 *    这是反空壳交付的关键一环：一个「只要没抛就算成功」的客户端，在后端根本不存在时
 *    也能报绿。
 *
 * ## 为什么不用 zod 校验响应
 *
 * `apps/web` 的 manifest 里没有 zod，而 ZLQ-232 验收第 4 项要求「新增第三方生产依赖 0」
 * 并用 manifest 与 lockfile 的 blob 逐字节比对来证明。加一个依赖就会改这两份 blob，于是
 * 这里改用手写的窄类型守卫：只取本切片真正用到的字段，取不到就报 `WEB_LAYER_BAD_PAYLOAD`。
 */

import { CSRF_HEADER_NAME, IDEMPOTENCY_HEADER_NAME, IF_MATCH_HEADER_NAME } from './csrf';
import { CONTRACT_ERROR_EXPLANATIONS, LAYER_ERROR_EXPLANATIONS } from './site-content';

/** 本层自己的失败码。**刻意不套用**契约的错误信封形状，理由见 `src/api-proxy.ts`。 */
export const LAYER_CODES = {
  /**
   * `fetch` 自己抛了：网断、DNS 失败、CSP 拦下、请求被 abort。
   * ⚠️ **不含**同源代理的 502/503 —— 那是代理**正常返回的一个响应**，会走下面
   * `unexpectedStatus` 那条分支，并由 `toFailure` 把代理自己的 `WEB_API_*` 码原样带出来
   * （代理的响应体就是 `{code}`，见 `src/api-proxy.ts` 的 `failureResponse`）。
   * 这条区分是有用的：`WEB_LAYER_NETWORK_ERROR` 意味着请求根本没送到我们自己的服务端，
   * `WEB_API_UPSTREAM_UNREACHABLE` 意味着送到了、是服务端连不上上游。
   */
  network: 'WEB_LAYER_NETWORK_ERROR',
  /**
   * 通了，但状态码不是这条调用约定的那一个。
   * `status` 为 0 只有一种来路：`redirect: 'manual'` 下的 opaqueredirect（见 `toRoutePath`）。
   */
  unexpectedStatus: 'WEB_LAYER_UNEXPECTED_STATUS',
  /** 状态码对，但响应体不是约定的形状。 */
  badPayload: 'WEB_LAYER_BAD_PAYLOAD',
} as const;

export type ApiFailure = {
  status: number;
  code: string;
  messageKey: string | null;
  retryable: boolean;
  traceId: string | null;
};

export type ApiOutcome<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; failure: ApiFailure };

export type ApiCall = {
  method: 'GET' | 'POST';
  path: string;
  expectedStatus: number;
  /** JSON 请求体；GET 一律不传。 */
  body?: unknown;
  csrfToken?: string | null;
  idempotencyKey?: string;
  ifMatch?: string;
  signal?: AbortSignal;
};

/**
 * 从错误响应里取出契约的错误信封。
 *
 * 取不出就退回本层的码 —— **不猜**、不填一个看起来合理的 messageKey。API 层没给的东西，
 * 客户端凭空造一个会让 UI 显示一句服务端从没说过的话。
 */
function toFailure(status: number, raw: unknown, fallbackCode: string): ApiFailure {
  if (typeof raw === 'object' && raw !== null) {
    const envelope = raw as Record<string, unknown>;
    if (typeof envelope['code'] === 'string') {
      return {
        status,
        code: envelope['code'],
        messageKey: typeof envelope['messageKey'] === 'string' ? envelope['messageKey'] : null,
        retryable: envelope['retryable'] === true,
        traceId: typeof envelope['traceId'] === 'string' ? envelope['traceId'] : null,
      };
    }
  }
  return { status, code: fallbackCode, messageKey: null, retryable: false, traceId: null };
}

/** 204 没有响应体，`res.json()` 会抛；所以按状态码分两条路读。 */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * 把 API 路径补成**带尾斜杠**的形态。
 *
 * 为什么非补不可：`apps/web/next.config.ts` 里 `trailingSlash: true`（ZLQ-190 §7 要求
 * `/source-and-license/` 这种形态，且明令不许借这次切换摘掉它）。Next 对**所有**路由一视同仁，
 * 包括 `app/api/[...path]/route.ts` —— 于是 `POST /api/v1/auth/login` 会先吃一个
 * `308 → /api/v1/auth/login/`，代理处理器根本不会被执行到。
 *
 * 而本层的 `fetch` 是 `redirect: 'manual'`（下面有说明），浏览器对 manual 的回应是一个
 * **opaqueredirect**：status 0、头为空、body 为 null。表现就是四步闭环里每一次调用都失败在
 * `WEB_LAYER_UNEXPECTED_STATUS`「服务返回了意料之外的状态码」—— 一句真话，但既没指向真因，
 * 也让学生无从下手。**实测过的缺陷，不是推测**：e2e 点登录时页面上渲染出来的就是这句。
 *
 * 两条修法里选了这一条：
 *   - 改成 `redirect: 'follow'` 也能过，但那就把「一次重定向把错误洗成 200」的门打开了 ——
 *     上游真发了 3xx 时，客户端会追着跳到哪都不知道，失败与成功的边界重新变模糊。
 *   - 在**唯一**的出口处把路径补成 Next 认的规范形态，重定向根本不会发生，manual 的语义
 *     原样保留。选这条。
 *
 * 对上游契约**没有影响**：`src/api-proxy.ts` 的 `buildTargetPath` 是按已解码的路径段重新拼
 * 上游路径的，尾斜杠不产生额外的段，所以转发出去的仍然是 `/api/v1/auth/login`、
 * `/api/v1/tasks/{id}:pump`（AIP-136 的 `:verb` 后缀也不受牵连）。
 *
 * 查询串要单独处理：直接往整条字符串后面补 `/`，`?page=2` 会变成 `?page=2/`。
 */
export function toRoutePath(path: string): string {
  const queryAt = path.indexOf('?');
  const base = queryAt === -1 ? path : path.slice(0, queryAt);
  const query = queryAt === -1 ? '' : path.slice(queryAt);
  return base.endsWith('/') ? `${base}${query}` : `${base}/${query}`;
}

/**
 * 发一次调用。
 *
 * 任何失败都以 `{ok:false}` 返回而不是抛：四步闭环的 UI 需要把「哪一步、因为什么码」显示
 * 给学生看，抛出去的异常在 React 事件处理器里只会变成一条控制台错误。
 */
export async function callApi<T = null>(call: ApiCall): Promise<ApiOutcome<T>> {
  const headers: Record<string, string> = {};
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  if (call.csrfToken !== undefined && call.csrfToken !== null && call.csrfToken !== '') {
    headers[CSRF_HEADER_NAME] = call.csrfToken;
  }
  if (call.idempotencyKey !== undefined) headers[IDEMPOTENCY_HEADER_NAME] = call.idempotencyKey;
  if (call.ifMatch !== undefined) headers[IF_MATCH_HEADER_NAME] = call.ifMatch;

  let response: Response;
  try {
    response = await fetch(toRoutePath(call.path), {
      method: call.method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: call.signal,
      // 同源代理已经 `redirect: 'manual'`；这里也关掉跟随，避免一次重定向把错误洗成 200。
      redirect: 'manual',
    });
  } catch {
    return {
      ok: false,
      failure: {
        status: 0,
        code: LAYER_CODES.network,
        messageKey: null,
        retryable: true,
        traceId: null,
      },
    };
  }

  const payload = await readBody(response);
  if (response.status !== call.expectedStatus) {
    return {
      ok: false,
      failure: toFailure(response.status, payload, LAYER_CODES.unexpectedStatus),
    };
  }
  return { ok: true, status: response.status, value: payload as T };
}

// ---- 手写窄守卫：只校验本切片真正读到的字段 ------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** UI 会读到的项目字段。契约的 `Project` 有 13 个，这里只认这三个。 */
export type ProjectView = { id: string; revision: string; title: string };

/** UI 会读到的版本字段。⚠️ 契约的版本**没有回复正文**，见 `src/api-wire.ts` 的说明。 */
export type VersionView = {
  id: string;
  sequence: number;
  artifactSha256: string;
  fileCount: number;
  totalBytes: number;
  buildStatus: string;
  scanStatus: string;
  sourceTaskId: string | null;
  createdAt: string;
};

/**
 * UI 会读到的任务字段。
 *
 * `resultVersionId` 与 `error` 不能省：
 * - 契约里 provider 失败是以 **HTTP 200 + `task.error`** 返回的（§5.5），所以「200 就算成功」
 *   的客户端会把一次模型调用失败显示成一切正常。这里必须把 `error` 读出来。
 * - 第 4 步「看到真 AI 回复」的完成信号是任务产出了一个版本，而版本 id 只在
 *   `task.resultVersionId` 上（`projectVersion.sourceTaskId` 是它的反向）。
 */
export type TaskView = {
  id: string;
  state: string;
  revision: string;
  progress: number;
  stage: string | null;
  nextRunAt: string | null;
  resultVersionId: string | null;
  error: { code: string; messageKey: string; retryable: boolean } | null;
};

export type ProjectAggregate = {
  project: ProjectView;
  currentVersion: VersionView | null;
  activeTask: TaskView | null;
};

/** 项目读模型里 UI 会读的那几个字段。 */
export function asProject(value: unknown): ProjectView | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const revision = str(value['revision']);
  const title = str(value['title']);
  if (id === null || revision === null || title === null) return null;
  return { id, revision, title };
}

function asVersion(value: unknown): VersionView | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const artifactSha256 = str(value['artifactSha256']);
  const buildStatus = str(value['buildStatus']);
  const scanStatus = str(value['scanStatus']);
  const createdAt = str(value['createdAt']);
  const { sequence, fileCount, totalBytes } = value;
  if (
    id === null ||
    artifactSha256 === null ||
    buildStatus === null ||
    scanStatus === null ||
    createdAt === null ||
    typeof sequence !== 'number' ||
    typeof fileCount !== 'number' ||
    typeof totalBytes !== 'number'
  ) {
    return null;
  }
  return {
    id,
    sequence,
    artifactSha256,
    fileCount,
    totalBytes,
    buildStatus,
    scanStatus,
    sourceTaskId: str(value['sourceTaskId']),
    createdAt,
  };
}

function asTask(value: unknown): TaskView | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const state = str(value['state']);
  const revision = str(value['revision']);
  if (id === null || state === null || revision === null) return null;

  const rawError = value['error'];
  let error: TaskView['error'] = null;
  if (rawError !== null && rawError !== undefined) {
    // `error` 是 required + nullable：非 null 却读不出码，说明形状不对，整条响应都要拒。
    if (!isRecord(rawError)) return null;
    const code = str(rawError['code']);
    const messageKey = str(rawError['messageKey']);
    if (code === null || messageKey === null) return null;
    error = { code, messageKey, retryable: rawError['retryable'] === true };
  }

  return {
    id,
    state,
    revision,
    progress: typeof value['progress'] === 'number' ? value['progress'] : 0,
    stage: str(value['stage']),
    nextRunAt: str(value['nextRunAt']),
    resultVersionId: str(value['resultVersionId']),
    error,
  };
}

/**
 * `GET /projects/{id}` 的聚合响应。
 *
 * 两个可空字段按附录 A §6.4 是 **required + nullable**：键一定在，值可以是 null。所以这里
 * 用 `'currentVersion' in value` 判键在不在，而不用 `=== undefined` —— 少了键就是形状不对，
 * 必须报 `WEB_LAYER_BAD_PAYLOAD`，不能悄悄当成「没有版本」。
 */
export function asGetProjectResponse(value: unknown): ProjectAggregate | null {
  if (!isRecord(value)) return null;
  const project = asProject(value['project']);
  if (project === null) return null;
  if (!('currentVersion' in value) || !('activeTask' in value)) return null;

  const currentVersion =
    value['currentVersion'] === null ? null : asVersion(value['currentVersion']);
  if (value['currentVersion'] !== null && currentVersion === null) return null;

  const activeTask = value['activeTask'] === null ? null : asTask(value['activeTask']);
  if (value['activeTask'] !== null && activeTask === null) return null;

  return { project, currentVersion, activeTask };
}

/** `POST /projects/{id}/turns` 的 202 响应。 */
export function asTaskAccepted(value: unknown): { taskId: string; revision: string } | null {
  if (!isRecord(value)) return null;
  const taskId = str(value['taskId']);
  const revision = str(value['revision']);
  if (taskId === null || revision === null) return null;
  return { taskId, revision };
}

/**
 * `POST /tasks/{id}:pump` 的 200 响应。
 *
 * 契约刻意把**整个** Task 带回来（注释写明「客户端据此继续 pump，不必再 GET 一次」），所以
 * 这里也原样交出 `TaskView` 而不是只挑 `state` 一个字段 —— pump 循环的下一步需要
 * `revision`（`If-Match`）、`nextRunAt`（退避窗口）与 `resultVersionId`（完成信号）。
 */
export function asTaskPumpResult(
  value: unknown,
): { taskId: string; outcome: string; task: TaskView } | null {
  if (!isRecord(value)) return null;
  const taskId = str(value['taskId']);
  const outcome = str(value['outcome']);
  const task = asTask(value['task']);
  if (taskId === null || outcome === null || task === null) return null;
  return { taskId, outcome, task };
}

/** `POST /projects/{id}/preview` 的 200 响应。 */
export function asCreatePreviewResponse(
  value: unknown,
): { url: string; expiresAt: string; versionId: string } | null {
  if (!isRecord(value)) return null;
  const url = str(value['url']);
  const expiresAt = str(value['expiresAt']);
  const versionId = str(value['versionId']);
  if (url === null || expiresAt === null || versionId === null) return null;
  return { url, expiresAt, versionId };
}

// ---- 展示层：把机器码翻成人话 -------------------------------------------

const KNOWN_CODES: Readonly<Record<string, string>> = {
  ...LAYER_ERROR_EXPLANATIONS,
  ...CONTRACT_ERROR_EXPLANATIONS,
};

/**
 * 组一句给学生看的失败说明。
 *
 * 形状固定是 `${prefix}${code}）${人话}` —— **码永远在里面**。理由：人话表只覆盖我们认识的
 * 那些码，剩下的必须原样露出来，否则一个没预料到的后端错误会被显示成一句通用的
 * 「操作失败」，那就等于把真实的失败洗掉了。
 */
export function describeCode(code: string, prefix: string): string {
  const explanation = KNOWN_CODES[code];
  const head = `${prefix}${code}）`;
  return explanation === undefined ? head : `${head}${explanation}`;
}

/** 同 `describeCode`，输入是一次调用失败（本层码或后端信封码）。 */
export function describeFailure(failure: ApiFailure, prefix: string): string {
  return describeCode(failure.code, prefix);
}

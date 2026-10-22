/**
 * `/api/v1` 的 HTTP 适配层：传输、路由、封套。
 *
 * ## 为什么没有 HTTP 框架
 *
 * §0.2 逐字要求「新增第三方生产依赖必须为 **0**」，所以这里只有 `node:http`。Express /
 * Fastify / Hono / NestJS 一律不引入 —— 它们的价值（中间件、参数装饰器、自动校验）在这
 * 个面上都能用几十行换到，而代价是一条会进生产闭包、进 SBOM、进 license 门禁的新边。
 * 少一个依赖就少一份「谁允许它进来的」的问题。
 *
 * ## 路由表是从契约注册表编译出来的，不是手写的
 *
 * `ROUTES` 由 `operationRegistry` 过滤 + 编译得到：method、path 模板、security 级别
 * **全部取自契约**，本地只提供 `operationId → handler` 的映射。于是「路径写错一个字母」
 * 这类漂移在结构上不可能发生 —— 写错的 `operationId` 会在模块加载时被那句断言直接抛掉，
 * 而不会变成一个静默的 404。security 级别同样是**读**出来的（`security: []` ⇒ 匿名；
 * 含 `CsrfHeader` ⇒ 双提交），不是在这里再抄一遍「哪些是写接口」。
 *
 * ## 未实现的 operation 走 404，不发明新码
 *
 * `operationRegistry` 有 31 条，本切片只实现 13 条（其余属于 §0.3 明确推迟的面）。
 * 没实现的那些不注册进 `ROUTES`，于是落到统一的 404 `RESOURCE_NOT_FOUND`。这里**不**新造
 * 一个 `NOT_IMPLEMENTED`：错误码集合是 §5.4 冻结的 42 码，加一个就是给线上语义加一条
 * 契约里没有的分支，而 §8 明令不得改公开 API 的错误语义。
 *
 * ## 一条贯穿全文件的安全性质
 *
 * 认证与 CSRF 判定发生在**任何** handler 之前，且身份只来自服务端会话（`authenticate`
 * 读的是 cookie 里的令牌摘要 → `account_sessions` 行 → `users` 行）。没有任何 handler 的
 * 入参里出现「客户端声明的角色」—— `Actor` 的两个字段都由服务端查库得到，这是 §4.2
 * 「所有接口一律从服务端会话判角色」的结构化兑现，而不是一句注释。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CSRF_HEADER_NAME,
  JSON_MEDIA_TYPE,
  SESSION_COOKIE_NAME,
  SSE_MEDIA_TYPE,
  createProjectRequestSchema,
  createTurnRequestSchema,
  idPathSchema,
  idempotencyKeySchema,
  listProjectsQuerySchema,
  loginRequestSchema,
  operationRegistry,
  putSecretRequestSchema,
  taskEventIdSchema,
  type OperationContract,
} from '@littleq/api-contract';
import {
  type AccountDirectory,
  type Actor,
  type AuthenticatedRequest,
  type Page,
  type PasswordHasher,
  type ProjectDirectory,
  type RandomSource,
  type ScanInputAssembler,
  type SecretAdmin,
  type SessionDirectory,
  type TaskInputStore,
  type TaskPumpStore,
  type TaskReadDirectory,
  type TaskReservationReleaser,
  type TaskUnitOfWork,
  type TurnProviderClient,
  type UsageDirectory,
  type WorkArtifactStore,
  assertCsrfValid,
  authenticate,
  createProjectUseCase,
  createTurnUseCase,
  encodeSecretValue,
  getProjectView,
  getSecretMetadataUseCase,
  getTaskUseCase,
  listProjects,
  listTaskEventsUseCase,
  login,
  logout,
  pumpTaskUseCase,
  putSecretUseCase,
  taskIdFromParam,
} from '@littleq/application';
import {
  DomainError,
  errorDefinition,
  httpStatusOf,
  parseProjectId,
  type ErrorCode,
  type Project,
  type SessionTtlPolicy,
  type Timestamp,
} from '@littleq/domain';
import { isInfraError } from '@littleq/infra';
import type { WorkScanner } from '@littleq/work-contract';
import { parseCookie, stringifySetCookie } from 'cookie';

import {
  eTagOf,
  errorEnvelopeDto,
  getProjectResponseDto,
  liveHealthDto,
  parseRequest,
  projectDto,
  projectPageDto,
  readyHealthDto,
  revisionFromETag,
  secretMetadataDto,
  taskAcceptedDto,
  taskDto,
  taskEventDto,
  taskPumpResultDto,
} from './dto.js';

/** 所有路径都挂在这个前缀下（契约 `servers[0].url`）。 */
export const API_PREFIX = '/api/v1';

/**
 * 请求体上限。
 *
 * 契约里最大的入向正文是 `SecretValue`（≤8192 字符）与 `prompt`（≤8000 字符），64 KiB
 * 已经给足了 JSON 转义的膨胀空间。这条上限的作用是**在读完之前就能拒绝**：没有它的话，
 * 一个匿名调用方可以用一个永不结束的 chunked 请求把实例的内存吃光，而这发生在任何认证
 * 判定之前 —— 认证拦不住它，因为读 body 本来就发生在解析之前。
 */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * 一次 SSE 响应最多补发多少条事件。
 *
 * 有界而不是「一直发到客户端断开」：§0.2 逐字要求「没有 `waitUntil`、没有遗留的后台
 * promise」。发完这一段就 `end()`，客户端要后续的再带 `Last-Event-ID` 重连 —— 那个头
 * 存在的意义正是这个。
 */
const EVENT_STREAM_LIMIT = 200;

/** 伴随 cookie 的名字。会话 cookie 是 HttpOnly 的，这一个不是（客户端要读它填请求头）。 */
export const CSRF_COOKIE_NAME = 'littleq_csrf';

/** 见文件头：`security` 的三种形态。 */
type SecurityLevel = 'anonymous' | 'session' | 'session-csrf';

/**
 * 组合根交给 HTTP 层的**全部**依赖。
 *
 * 一个扁平的袋子而不是嵌套的 services 对象：application 的每个用例都只声明自己消费的
 * 那几个端口（`AuthServices` / `ProjectServices` / `TurnServices` / `PumpServices` /
 * `SecretServices`），而这个类型是它们的**结构超集**，于是同一个对象可以原样传给每一个
 * 用例，不需要在适配层再拼一次。多出来的键对结构类型是纯放宽。
 */
export interface ApiServices {
  readonly accounts: AccountDirectory;
  readonly sessions: SessionDirectory;
  readonly hasher: PasswordHasher;
  readonly random: RandomSource;
  readonly projects: ProjectDirectory;
  readonly tasks: TaskReadDirectory;
  readonly usage: UsageDirectory;
  readonly secrets: SecretAdmin;
  readonly inputs: TaskInputStore;
  readonly artifacts: WorkArtifactStore;
  readonly scanner: WorkScanner;
  readonly scanInputs: ScanInputAssembler;
  readonly unitOfWork: TaskUnitOfWork;
  readonly pumpStore: TaskPumpStore;
  readonly reservationReleaser: TaskReservationReleaser;
  readonly provider: TurnProviderClient;
  readonly providerConfiguration: {
    readonly identityId: string;
    readonly templateId: string;
    readonly environmentId: string;
    readonly templateVersion: string;
  };
  readonly sessionTtl: SessionTtlPolicy;
  /** pump 的租约持有者标识。进程内唯一即可（§6.5：租约是持久化事实，不是进程内集合）。 */
  readonly workerId: string;
  /** 是否给 cookie 打 `Secure`。本地 http 回环上是 false，生产 https 上是 true。 */
  readonly secureCookies: boolean;
  /** 「现在几点」的唯一来源；用例一律把它当入参（附录 A §6.3）。 */
  readonly now: () => Timestamp;
  /** `GET /health/ready` 的依赖探活。失败 ⇒ 503，且**不**把原始错误体带出去。 */
  readonly probeDependencies: () => Promise<void>;
}

interface RequestContext {
  readonly services: ApiServices;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly actor: Actor | null;
  readonly sessionToken: string | null;
  readonly now: Timestamp;
}

type RouteHandler = (context: RequestContext) => Promise<void>;

// ---------------------------------------------------------------------------
// 路径模板编译
// ---------------------------------------------------------------------------

interface CompiledSegment {
  readonly regex: RegExp;
  readonly names: readonly string[];
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把一个路径段编译成锚定正则。
 *
 * 按段编译而不是整条路径一把梭，是因为模板里存在 `{id}:pump` 这种「参数 + 字面后缀」的
 * 段（`:pump` / `:rotate` 是 Google AIP 风格的自定义方法）。整条路径的贪心捕获组会吃掉
 * `:pump`，于是 `taskId` 变成一个永远过不了 `uuidV7Schema` 的串。
 *
 * 捕获组用 `([^/]+)`：段内不含斜杠，因此不需要在匹配阶段再切一次。
 */
function compileSegment(segment: string): CompiledSegment {
  const names: string[] = [];
  let source = '';
  let index = 0;
  while (index < segment.length) {
    const open = segment.indexOf('{', index);
    if (open < 0) {
      source += escapeRegExp(segment.slice(index));
      break;
    }
    const close = segment.indexOf('}', open);
    if (close < 0) {
      source += escapeRegExp(segment.slice(index));
      break;
    }
    source += escapeRegExp(segment.slice(index, open));
    names.push(segment.slice(open + 1, close));
    source += '([^/]+)';
    index = close + 1;
  }
  return { regex: new RegExp(`^${source}$`), names };
}

function splitPath(pathname: string): readonly string[] {
  return pathname.split('/').slice(1);
}

interface CompiledRoute {
  readonly operationId: string;
  readonly method: string;
  readonly security: SecurityLevel;
  readonly segments: readonly CompiledSegment[];
}

/**
 * 从契约的 security 要求读出级别。
 *
 * 不查表、不按 method 猜：`operations.ts` 已经把「写 = 非 GET」这条规则落进每条 operation
 * 的 `security` 字段里了（`SESSION_WITH_CSRF_SECURITY` 同时含 `CookieAuth` 与 `CsrfHeader`），
 * 在这儿再抄一份「哪些方法要 CSRF」就有了第二个事实源。
 */
function securityLevelOf(operation: OperationContract): SecurityLevel {
  const [requirement] = operation.security;
  if (requirement === undefined) return 'anonymous';
  return 'CsrfHeader' in requirement ? 'session-csrf' : 'session';
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = chunk as Uint8Array;
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new DomainError('REQUEST_INVALID', 'RequestBody');
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new DomainError('REQUEST_INVALID', 'RequestBody');
  const text = Buffer.concat(chunks, total).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 不回显解析器报错：它的文本里含 offending 片段，而 `prompt` 与秘密明文都属于
    // §5 禁止出现在任何响应里的内容。
    throw new DomainError('REQUEST_INVALID', 'RequestBody');
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * 响应头集合。允许 `string[]` 只有一个理由：`Set-Cookie` 是 HTTP 里**唯一**可以重复出现
 * 而不合并的响应头，登录要同时下发会话 cookie 与 CSRF 伴随 cookie 两条。
 */
type ResponseHeaders = Readonly<Record<string, string | string[]>>;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: ResponseHeaders = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8`,
    'content-length': String(Buffer.byteLength(payload)),
    // 学生数据一律不缓存：中间层（含浏览器 back/forward cache）留下的一份副本，
    // 就是一份脱离访问控制的副本。
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendNoContent(res: ServerResponse, headers: ResponseHeaders = {}): void {
  res.writeHead(204, { 'cache-control': 'no-store', ...headers });
  res.end();
}

/**
 * `Idempotency-Key` 缺失 ⇒ 专属码，不是 `REQUEST_INVALID`。
 *
 * `operations.ts` 给 `createTurn` 显式挂了 `IDEMPOTENCY_KEY_REQUIRED`。如果这里直接用
 * `idempotencyHeaderSchema.parse({'Idempotency-Key': undefined})`，缺失会被判成通用的
 * 400，那个专属码就成了死码 —— 而它存在的理由是「忘了带头」与「带的头格式不对」在客户
 * 端是两种完全不同的修复动作。
 */
function requireIdempotencyKey(req: IncomingMessage): string {
  const raw = headerOf(req, 'Idempotency-Key');
  if (raw === undefined) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key');
  return parseRequest('IdempotencyKey', idempotencyKeySchema, raw);
}

function requireIfMatch(req: IncomingMessage): string {
  const raw = headerOf(req, 'If-Match');
  if (raw === undefined) throw new DomainError('REQUEST_INVALID', 'If-Match');
  return raw;
}

/**
 * 条件读：`If-None-Match` 与当前 ETag 相同 ⇒ 304（带 ETag，无 body）。
 *
 * 只在**完全相等**时才 304，不做弱比较、不解析逗号分隔的列表：契约的 `ifNoneMatchSchema`
 * 收的是单个强 ETag 或 `*`，而 `*` 的语义是「我有任意一份副本」—— 对一个 revision 寻址
 * 的资源，把它当成命中会让客户端永远拿不到第一次之后的内容。所以 `*` 走不命中分支。
 */
function notModified(req: IncomingMessage, eTag: string): boolean {
  return headerOf(req, 'If-None-Match') === eTag;
}

function sessionCookies(services: ApiServices, issued: IssuedTokens): string[] {
  const absoluteMinutes = issued.rememberMe
    ? services.sessionTtl.rememberMeAbsoluteMinutes
    : services.sessionTtl.absoluteMinutes;
  const maxAge = absoluteMinutes * 60;
  return [
    // 会话 cookie：HttpOnly。客户端**读不到**它，因此 XSS 拿不走会话令牌（§5.3）。
    stringifySetCookie({
      name: SESSION_COOKIE_NAME,
      value: issued.sessionToken,
      maxAge,
      path: '/',
      httpOnly: true,
      secure: services.secureCookies,
      sameSite: 'strict',
    }),
    // 伴随 cookie：**不是** HttpOnly —— 双提交模式要求客户端能读它并回填到
    // `X-CSRF-Token`。它不含任何授权信息（是从会话派生的校验值），所以可读不等于可用。
    stringifySetCookie({
      name: CSRF_COOKIE_NAME,
      value: issued.csrfToken,
      maxAge,
      path: '/',
      httpOnly: false,
      secure: services.secureCookies,
      sameSite: 'strict',
    }),
  ];
}

/** `login` 用例的返回值里，HTTP 层真正需要的那三个字段。 */
interface IssuedTokens {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly rememberMe: boolean;
}

function clearedCookies(services: ApiServices): string[] {
  return [SESSION_COOKIE_NAME, CSRF_COOKIE_NAME].map((name) =>
    stringifySetCookie({
      name,
      value: '',
      // `Max-Age=0` 是「立刻过期」；只给空值不够，浏览器会把它当成会话 cookie 留着。
      maxAge: 0,
      path: '/',
      httpOnly: name === SESSION_COOKIE_NAME,
      secure: services.secureCookies,
      sameSite: 'strict',
    }),
  );
}

function setCookieHeader(cookies: readonly string[]): Record<string, string[]> {
  return { 'set-cookie': [...cookies] };
}

const HANDLERS: Readonly<Record<string, RouteHandler>> = {
  getLiveHealth: async ({ res }) => {
    sendJson(res, 200, liveHealthDto());
  },

  getReadyHealth: async ({ res, services }) => {
    try {
      await services.probeDependencies();
    } catch {
      // 不回依赖的原始错误体：那会把内部拓扑（哪张库、哪个 provider）交给匿名调用方。
      throw new DomainError('DEPENDENCY_UNAVAILABLE');
    }
    sendJson(res, 200, readyHealthDto());
  },

  login: async ({ req, res, services, now }) => {
    const body = parseRequest('LoginRequest', loginRequestSchema, await readJsonBody(req));
    const issued = await login(services, {
      loginName: body.loginName,
      password: body.password,
      rememberMe: body.rememberMe ?? false,
      ttl: services.sessionTtl,
      now,
    });
    // 204，**没有响应体**：把 `User` 回给登录者就会顺带把 `role` 带出去，而 §5.3 要求
    // 角色判断留在服务端。客户端拿不到角色，就没法把「我是 OWNER」当成前端可决定的事实。
    sendNoContent(res, setCookieHeader(sessionCookies(services, issued)));
  },

  logout: async ({ res, services, sessionToken, now }) => {
    await logout(services, { sessionToken, now });
    sendNoContent(res, setCookieHeader(clearedCookies(services)));
  },

  listProjects: async ({ res, services, url, actor }) => {
    const query = parseRequest('ListProjectsQuery', listProjectsQuerySchema, {
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      // 契约里有这个查询参数，但 `listProjects` 用例**不接受**它：范围一律钉在认证后的
      // 学生身份上（§4.1「只读当前学生范围，不是 localStorage 列表」）。在这里解析它，
      // 是为了让一个非法值仍然得到 400 而不是被静默忽略 —— 忽略一个客户端发来的参数而
      // 不报错，会让客户端以为它生效了。
      ownerStudentId: url.searchParams.get('ownerStudentId') ?? undefined,
    });
    const page: Page<Project> = await listProjects(services, {
      actor: requireActorOf(actor),
      status: query.status ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    sendJson(res, 200, projectPageDto(page));
  },

  createProject: async ({ req, res, services, actor, now }) => {
    const body = parseRequest(
      'CreateProjectRequest',
      createProjectRequestSchema,
      await readJsonBody(req),
    );
    const project = await createProjectUseCase(services, {
      actor: requireActorOf(actor),
      title: body.title,
      // §4.1 逐字：线上 `workType` 值是 `WEB`。取值合法性由 domain 判定，这里不预筛。
      workType: body.workType,
      ageBand: body.ageBand,
      helpLevel: body.helpLevel,
      templateId: body.templateId ?? null,
      now,
    });
    sendJson(res, 201, projectDto(project), {
      etag: eTagOf(project.revision),
      location: `${API_PREFIX}/projects/${project.id}`,
    });
  },

  getProject: async ({ req, res, services, actor, params, now }) => {
    const path = parseRequest('IdPath', idPathSchema, params);
    const view = await getProjectView(services, {
      actor: requireActorOf(actor),
      projectId: parseProjectId(path.id),
      now,
    });
    const eTag = eTagOf(view.project.revision);
    if (notModified(req, eTag)) {
      res.writeHead(304, { etag: eTag, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, 200, getProjectResponseDto(view), { etag: eTag });
  },

  createTurn: async ({ req, res, services, actor, params, now }) => {
    const path = parseRequest('IdPath', idPathSchema, params);
    const idempotencyKey = requireIdempotencyKey(req);
    const body = parseRequest(
      'CreateTurnRequest',
      createTurnRequestSchema,
      await readJsonBody(req),
    );
    // `requestHash` 由 adapter 算（domain 的 `RequestHash` 注释逐字：「计算方式属于
    // adapter」）。规范化方式是「键按码位序排列的 JSON」：确定、无歧义、不含空白差异。
    // prompt 全文只作为 sha256 的**输入**，摘要不可逆，且 `requestHash` 不上线
    // （`taskSchema` 会把它 strip 掉）。
    const digestInput = JSON.stringify({
      baseRevision: body.baseRevision,
      baseVersionId: body.baseVersionId ?? null,
      idempotencyKey,
      projectId: path.id,
      prompt: body.prompt,
    });
    const result = await createTurnUseCase(services, {
      actor: requireActorOf(actor),
      projectId: path.id,
      prompt: body.prompt,
      baseRevision: body.baseRevision,
      idempotencyKey,
      requestHash: toHex(services.random.sha256(digestInput)),
      now,
    });
    // 202 只在**持久化尝试之后**发出：`createTurnUseCase` 在单事务里 INSERT
    // task/private/reservation 并 CAS project，DB 失败会抛出来，绝不可能先回 202。
    sendJson(res, 202, taskAcceptedDto(result), {
      location: `${API_PREFIX}/tasks/${result.taskId}`,
    });
  },

  getTask: async ({ req, res, services, actor, params }) => {
    const path = parseRequest('IdPath', idPathSchema, params);
    const task = await getTaskUseCase(services, {
      actor: requireActorOf(actor),
      taskId: taskIdFromParam(path.id),
    });
    const eTag = eTagOf(task.revision);
    if (notModified(req, eTag)) {
      res.writeHead(304, { etag: eTag, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, 200, taskDto(task), { etag: eTag });
  },

  streamTaskEvents: async ({ req, res, services, actor, params }) => {
    const path = parseRequest('IdPath', idPathSchema, params);
    const lastEventId = headerOf(req, 'Last-Event-ID');
    const afterSequence =
      lastEventId === undefined
        ? null
        : BigInt(parseRequest('LastEventID', taskEventIdSchema, lastEventId));
    const events = await listTaskEventsUseCase(services, {
      actor: requireActorOf(actor),
      taskId: taskIdFromParam(path.id),
      afterSequence,
      limit: EVENT_STREAM_LIMIT,
    });
    // 所有 DB 读取都发生在写响应头**之前**：认证失败、越权、taskId 非法都还能走统一的
    // JSON 错误封套。一旦写了 200 + `text/event-stream`，状态码就再也改不了了。
    res.writeHead(200, {
      'content-type': SSE_MEDIA_TYPE,
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    for (const event of events) {
      res.write(
        `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(taskEventDto(event))}\n\n`,
      );
    }
    res.end();
  },

  pumpTask: async ({ req, res, services, actor, params, now }) => {
    const path = parseRequest('IdPath', idPathSchema, params);
    const expectedRevision = revisionFromETag('If-Match', requireIfMatch(req));
    // 预算与窗口不传，取用例的常量（8 s / 6 s / 24 s 租约）：那是 §5.1 的裁定值，
    // 在这里再传一遍就有了第二个事实源。
    const result = await pumpTaskUseCase(services, {
      actor: requireActorOf(actor),
      taskId: taskIdFromParam(path.id),
      expectedRevision,
      workerId: services.workerId,
      now,
    });
    // 200 而不是 202：pump 是一次同步的有界推进，`outcome` 直接说明这一轮做了什么。
    sendJson(res, 200, taskPumpResultDto(result), { etag: eTagOf(result.task.revision) });
  },

  getSecretMetadata: async ({ res, services, actor, params }) => {
    // **不**在这里用 `secretKindPathSchema` 预解析 `{kind}`：那个 schema 是闭集枚举，
    // 先解析会让 `SECRET_KIND_UNSUPPORTED`（`operations.ts` 显式挂在本 operation 上的
    // 专属码）变成死码，而 `secretKindFromParam` 的注释逐字要求它保持可达。
    // 判定次序（先身份后载荷）由用例负责：学生带非法 kind 得到 403 而不是 400。
    const metadata = await getSecretMetadataUseCase(services, {
      actor: requireActorOf(actor),
      kind: params.kind ?? '',
    });
    sendJson(res, 200, secretMetadataDto(metadata));
  },

  putSecret: async ({ req, res, services, actor, params }) => {
    const body = parseRequest('PutSecretRequest', putSecretRequestSchema, await readJsonBody(req));
    await putSecretUseCase(services, {
      actor: requireActorOf(actor),
      kind: params.kind ?? '',
      plaintext: encodeSecretValue(body.value),
    });
    // 204，不回显：不回 value、不回 hash、不回 ref、也不回 `configured`。
    sendNoContent(res);
  },
};

/** `listProjects` 的 handler 拿不到 `RequestContext` 之外的东西，单独收一个 actor。 */
function requireActorOf(actor: Actor | null): Actor {
  if (actor === null) throw new DomainError('INTERNAL_ERROR', 'Actor');
  return actor;
}

const REGISTERED_OPERATION_IDS = new Set(
  operationRegistry.map((operation) => operation.operationId),
);
for (const operationId of Object.keys(HANDLERS)) {
  if (!REGISTERED_OPERATION_IDS.has(operationId)) {
    // 模块加载期就抛：一个拼错的 operationId 若被静默忽略，表现是「这条路由永远 404」，
    // 而那要等到有人真的去调它才会被发现。
    throw new Error(`apps/api: HANDLERS 里的 "${operationId}" 不在 operationRegistry 里`);
  }
}

const ROUTES: readonly CompiledRoute[] = operationRegistry
  .filter((operation) => HANDLERS[operation.operationId] !== undefined)
  .map((operation) => ({
    operationId: operation.operationId,
    method: operation.method,
    security: securityLevelOf(operation),
    segments: splitPath(operation.path).map(compileSegment),
  }));

function matchRoute(
  method: string,
  pathname: string,
): { readonly route: CompiledRoute; readonly params: Record<string, string> } | null {
  const actual = splitPath(pathname);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (route.segments.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < route.segments.length; index += 1) {
      const segment = route.segments[index];
      const value = actual[index];
      if (segment === undefined || value === undefined) {
        matched = false;
        break;
      }
      const groups = segment.regex.exec(value);
      if (groups === null) {
        matched = false;
        break;
      }
      segment.names.forEach((name, position) => {
        const captured = groups[position + 1];
        if (captured !== undefined) params[name] = captured;
      });
    }
    if (matched) return { route, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 封套
// ---------------------------------------------------------------------------

function envelopeOf(
  error: unknown,
  traceId: string,
): {
  readonly code: ErrorCode;
  readonly messageKey: string;
  readonly retryable: boolean;
  readonly traceId: string;
} {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      messageKey: error.messageKey,
      retryable: error.retryable,
      traceId,
    };
  }
  if (isInfraError(error)) {
    // infra 的错误已经在构造时算好了 `publicCode`（含 kind-aware 的那两个凭据码），
    // 这里不重算、也不覆盖它的 `retryable`。
    const definition = errorDefinition(error.publicCode);
    return {
      code: error.publicCode,
      messageKey: definition.messageKey,
      retryable: error.retryable,
      traceId,
    };
  }
  // 兜底：**不带**原始 message、不带 stack。一个未知异常里最可能含的就是刚读进来的
  // 那份入参（prompt 全文、秘密明文、连接串），把它回给客户端正是 §5 要拦的事。
  const definition = errorDefinition('INTERNAL_ERROR');
  return {
    code: 'INTERNAL_ERROR',
    messageKey: definition.messageKey,
    retryable: definition.retryable,
    traceId,
  };
}

function sendError(res: ServerResponse, traceId: string, error: unknown): void {
  if (res.headersSent) {
    // SSE 已经开始写了：状态码改不了，只能把流断掉，让客户端按 `Last-Event-ID` 重连。
    res.end();
    return;
  }
  const envelope = envelopeOf(error, traceId);
  const payload = JSON.stringify(errorEnvelopeDto(envelope));
  res.writeHead(httpStatusOf(envelope.code), {
    'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8`,
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// 请求入口
// ---------------------------------------------------------------------------

function sessionTokenOf(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  const value = parseCookie(header)[SESSION_COOKIE_NAME];
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * 造 `node:http` 的请求处理器。
 *
 * 返回一个纯函数而不是 `http.Server`，是为了让测试可以直接把它挂到任意端口上，也让
 * 「进程怎么起」这件事留在 `main.ts` 里 —— 装配与监听是两件事。
 */
export function createApiHandler(
  services: ApiServices,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void dispatch(services, req, res);
  };
}

async function dispatch(
  services: ApiServices,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const traceId = services.random.uuidV7();
  try {
    const now = services.now();
    const url = new URL(req.url ?? '/', 'http://littleq.internal');
    const method = (req.method ?? 'GET').toLowerCase();

    if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
      throw new DomainError('RESOURCE_NOT_FOUND', 'Path');
    }
    const matched = matchRoute(method, url.pathname.slice(API_PREFIX.length));
    if (matched === null) throw new DomainError('RESOURCE_NOT_FOUND', 'Path');
    const handler = HANDLERS[matched.route.operationId];
    if (handler === undefined) throw new DomainError('INTERNAL_ERROR', 'Route');

    let actor: Actor | null = null;
    let sessionToken: string | null = null;
    if (matched.route.security !== 'anonymous') {
      sessionToken = sessionTokenOf(req);
      const authenticated: AuthenticatedRequest | null = await authenticate(services, {
        sessionToken,
        now,
      });
      // 令牌不存在 / 已过期 / 已撤销一律同一个 401：分开回显等于给探测者一个
      // 「这条 cookie 曾经有效过」的预言机。
      if (authenticated === null) {
        sessionToken = null;
        throw new DomainError('AUTHENTICATION_REQUIRED');
      }
      if (matched.route.security === 'session-csrf') {
        assertCsrfValid(authenticated, headerOf(req, CSRF_HEADER_NAME) ?? null);
      }
      actor = { user: authenticated.user, session: authenticated.session };
      sessionToken = authenticated.sessionToken;
    }

    await handler({
      services,
      req,
      res,
      url,
      params: matched.params,
      actor,
      sessionToken,
      now,
    });
  } catch (error) {
    sendError(res, traceId, error);
  }
}

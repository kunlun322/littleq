/**
 * OpenAPI 3.1 生成器，以及它所依赖的错误码挂载规则。
 *
 * 派生方向是单向的：`operationRegistry` → 本文档（附录 A §3.1「禁止 OpenAPI → 类型的
 * 反向生成」）。因此这里没有任何「读回生成结果再修正」的逻辑，只有一次前向遍历。
 *
 * 本文件承担两件事，放在一起是因为第二件完全由第一件的产物决定：
 *
 * 1. **错误码挂载**（§5.4）—— 从 operation 已声明的事实推导共享码，与专属码合并、
 *    去重、排序，写进每个 operation 的 `x-littleq-error-codes`，并按 HTTP status
 *    分组生成错误响应。
 * 2. **文档装配** —— paths / requestBody / responses / security / tags / components。
 *
 * ## 确定性
 *
 * §4.4 要求「同一源码连续生成两次 byte-identical」。`createDocument` 本身不含时间与
 * 随机源，剩下的不确定性只可能来自遍历顺序，所以本文里每一处由 `Map`/`Set`/对象
 * 派生的输出都显式排序（状态码升序、码名字母序、header 名字字母序），不把顺序
 * 交给插入序或宿主。唯一的例外是 `exclusiveErrorCodes` 与 `success` 这两个
 * **数组**：它们的声明顺序有语义，§4.1 禁止重排。
 */
import {
  assertTaskErrorRegistryComplete,
  DOMAIN_ERROR_CATALOG,
  errorDefinition,
  httpStatusOf,
  isErrorCode,
  NEVER_IMPLICITLY_MOUNTED_ERROR_CODES,
  registeredAsyncErrorCodes,
  taskErrorRegistry,
  type ErrorCode,
  type SameRequestRetrySafety,
} from '@littleq/domain';
import {
  createDocument,
  type ZodOpenApiMediaTypeObject,
  type ZodOpenApiOperationObject,
  type ZodOpenApiParameters,
  type ZodOpenApiPathsObject,
  type ZodOpenApiRequestBodyObject,
  type ZodOpenApiResponseObject,
  type ZodOpenApiResponsesObject,
} from 'zod-openapi';

import { CONTRACT_TAGS, operationRegistry, SECURITY_SCHEMES } from './operations.js';
import {
  errorEnvelopeSchema,
  JSON_MEDIA_TYPE,
  responseHeaders,
  type OperationContract,
  type ResponseHeaderName,
  type SecurityRequirements,
  type SuccessResponse,
} from './schemas/common.js';

// ---------------------------------------------------------------------------
// 文档级常量
// ---------------------------------------------------------------------------

/** `contracts/{openapi,errors}/v1/` 两个目录与 `bootstrap.json.apiMajor` 共用的主版本号。 */
export const API_MAJOR = 1;

/** §3.1 裁定：OpenAPI `3.1.0`。写死而不是让库挑默认值，因为它是快照的一部分。 */
export const OPENAPI_SPEC_VERSION = '3.1.0';

/**
 * `info.version`。
 *
 * 它**不能**取 package.json 的 version（那是 `0.0.0`，与工作区里所有包一样是占位值，
 * 拿它当契约版本会让「契约变了但版本号没变」成为常态），更不能取时间戳或 git SHA
 * （§4.1 禁止时间戳与环境路径，git SHA 则会让每次提交都产生一份纯版本号的 diff，
 * 把真正的契约变化埋进去 —— 与 `config/license-registry-facts.json` 被排除出
 * prettier 的理由同源）。契约的版本语义只有主版本号是事实，所以固定为 `1.0.0`，
 * 破坏性变更时由 PM 裁定升 `2.0.0`，并在两个 `contracts` 目录下各新建一份 `v2`。
 */
export const CONTRACT_VERSION = '1.0.0';

/** `servers[0].url`。registry 里的 path 全部相对于它（§5.4 的路由表就是相对路径）。 */
export const SERVER_URL = '/api/v1';

/** 错误码扩展名。带命名空间前缀，避免与 OpenAPI 未来保留字冲突。 */
export const ERROR_CODES_EXTENSION = 'x-littleq-error-codes';

/**
 * 必须携带 `Retry-After` 的错误状态码。
 *
 * RFC 6585 §4 要求 429 用它告知重试等待；RFC 9110 §15.6.4 对 503 是 SHOULD。
 * §5.4 里落在 429 的有 `RATE_LIMITED` / `USAGE_LIMIT_EXCEEDED` / `QCA_QUOTA_EXHAUSTED`
 * / `BAILIAN_QUOTA_EXHAUSTED`，落在 503 的有 `QCA_UNREACHABLE` / `BAILIAN_UNREACHABLE`
 * / `DEPENDENCY_UNAVAILABLE` —— 全都是「过一会儿再来」的语义，所以按状态码挂，
 * 而不是逐个错误码列举（后者会在新增错误码时静默漏掉）。
 *
 * 注意这是**错误响应**上的 header。成功响应一个都不该带它：PM G5(1) 要求
 * `Retry-After` 出现在文档里，但把它挂到 200 上就是语义错误。
 */
const RETRY_AFTER_ERROR_STATUSES: readonly number[] = [429, 503];

/**
 * 生成结果的类型。
 *
 * 取 `ReturnType<typeof createDocument>` 而**不是** `oas31.OpenAPIObject`：这两个类型
 * 看着同名却结构不同 —— `createDocument` 返回的是库内部那份 chunk 类型，它的
 * `ParameterLocation` 多一个 `'querystring'` 成员，赋给 `oas31.OpenAPIObject` 会编译失败
 * （实测 TS2345：`Type '"querystring"' is not assignable to type 'ParameterLocation'`）。
 *
 * 用 `ReturnType` 而不是 `as` 绕过，是为了让类型跟着库版本走：升级 `zod-openapi` 时
 * 内部类型的变化会直接体现在这里，而不是被一次断言永久掩盖。
 */
export type OpenApiDocument = ReturnType<typeof createDocument>;

// ---------------------------------------------------------------------------
// 错误码挂载规则 —— §5.4 的逐字实现
// ---------------------------------------------------------------------------

/**
 * §5.4 用四条散文描述了「共享码」：所有 JSON operation 共享 `REQUEST_INVALID`；
 * 除 login/public/license/health 外的业务接口共享 `AUTHENTICATION_REQUIRED`；
 * 所有写接口共享 `CSRF_REJECTED`；对象型接口共享 `RESOURCE_NOT_FOUND`。
 *
 * 这四条在这里全部**从 operation 已声明的事实推导**，而不是在 31 条声明里各抄一遍：
 *
 * | 共享码 | 推导依据 | 为什么这个依据是对的 |
 * | --- | --- | --- |
 * | `REQUEST_INVALID` | 声明了 path/query/header/body 中任一项 | 没有输入就没有「输入不合法」 |
 * | `AUTHENTICATION_REQUIRED` | security 里出现 `CookieAuth` | login/public/license/health 的 security 是 `[]`，天然被排除 |
 * | `CSRF_REJECTED` | security 里出现 `CsrfHeader` | 「写接口」在本 API 里的定义就是需要 CSRF |
 * | `RESOURCE_NOT_FOUND` | path 含 `{id}` | `{id}` 是唯一表示领域对象的路径参数名；`{kind}`/`{slug}`/`{v}` 都不是 |
 *
 * 推导比手抄强的地方在于：改动 security 或路径时错误码集合自动跟随，不会出现
 * 「把接口改成公开却忘了摘掉 401」这种只在运行时才暴露的漂移。
 *
 * 两处刻意的例外，都不是推导规则不够用，而是规则本身覆盖不到：
 *
 * - `GET /public/works/{slug}` 的 `RESOURCE_NOT_FOUND` 按 §5.4 表格作为**专属码**声明。
 *   它的 404 来自 §5.3 的统一 404 规则，语义比「对象不存在」宽（同时覆盖
 *   PRIVATE / REVOKED / DELETED），而且参数名是 `{slug}`，靠 `{id}` 推导不出来。
 * - 「所有 JSON operation」里的 JSON 一词在推导中被丢掉了：`streamTaskEvents`（SSE）与
 *   `getUsageLedger` 的 CSV 分支同样有请求参数，同样会把非法输入判成 `REQUEST_INVALID`。
 *   §5.4 写 JSON 是为了把「无 body 的错误也走同一 envelope」这件事说清楚，不是为了
 *   把 SSE 排除在错误码体系外。
 *
 * `INTERNAL_ERROR` 与 `DEPENDENCY_UNAVAILABLE` 永不隐式挂载（§5.4），所以它们不在
 * 上表里；`getReadyHealth` 的 `DEPENDENCY_UNAVAILABLE` 是显式声明的专属码。
 * `assertErrorCodeCoverage` 把这条从文档约定变成了会抛错的断言。
 */

/** 推导共享码只需要这四项事实，因此这个接口不依赖 `OperationContract` 的全部字段。 */
export interface ErrorMountFacts {
  readonly path: string;
  readonly security: OperationContract['security'];
  /**
   * 与 `OperationContract` 一样是可选的：没有请求面（`logout` / `getLicense` / 两条
   * health）的 operation 直接省略这个字段，而不是显式写 `undefined`。写成必填会让
   * `sharedErrorCodes(operation)` 这种「把整条 operation 当事实传进来」的调用编译失败。
   */
  readonly request?: OperationContract['request'];
}

/** `{id}` 是本 API 里唯一表示领域对象的路径参数名（附录 A §5.4 的路由表可逐条核对）。 */
const OBJECT_ID_PARAMETER_PATTERN = /\{id\}/;

function hasRequestInput(request: OperationContract['request']): boolean {
  if (!request) return false;
  return Boolean(request.path ?? request.query ?? request.header ?? request.body);
}

function usesSecurityScheme(security: OperationContract['security'], scheme: string): boolean {
  return security.some((requirement) => Object.hasOwn(requirement, scheme));
}

/** 四条共享码。返回顺序无关，调用方一律去重排序。 */
export function sharedErrorCodes(facts: ErrorMountFacts): readonly ErrorCode[] {
  const codes: ErrorCode[] = [];
  if (hasRequestInput(facts.request)) codes.push('REQUEST_INVALID');
  if (usesSecurityScheme(facts.security, 'CookieAuth')) codes.push('AUTHENTICATION_REQUIRED');
  if (usesSecurityScheme(facts.security, 'CsrfHeader')) codes.push('CSRF_REJECTED');
  if (OBJECT_ID_PARAMETER_PATTERN.test(facts.path)) codes.push('RESOURCE_NOT_FOUND');
  return codes;
}

/**
 * 一个 operation 的完整错误码集合：共享码 ∪ 专属码，去重后按码名字母序排列。
 *
 * 排序是 §5.4 的明确要求（「去重排序后的完整集合」），也是快照确定性的前提 ——
 * 集合的遍历顺序不是契约的一部分，字母序才是。
 *
 * 字母序用 `<`/`>` 比较而不是 `localeCompare`：后者受宿主 locale 与 ICU 数据影响
 * （`NODE_ICU_DATA`、系统语言），同一份 registry 在不同机器上可能排出不同顺序。
 * 错误码全是 `[A-Z_]`，码点序与字母序一致，所以直接用码点比较（PM G6）。
 */
export function operationErrorCodes(operation: OperationContract): readonly ErrorCode[] {
  const merged = new Set<ErrorCode>([
    ...sharedErrorCodes(operation),
    ...operation.exclusiveErrorCodes,
  ]);
  return [...merged].sort(compareCodeNames);
}

function compareCodeNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 按 HTTP 状态码分组，组内同样按码名排序。状态码升序。 */
export function groupErrorCodesByStatus(
  codes: readonly ErrorCode[],
): readonly { readonly status: number; readonly codes: readonly ErrorCode[] }[] {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = httpStatusOf(code);
    const bucket = byStatus.get(status);
    if (bucket) bucket.push(code);
    else byStatus.set(status, [code]);
  }
  return [...byStatus.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([status, bucket]) => ({ status, codes: [...bucket].sort(compareCodeNames) }));
}

/**
 * 双向校验（§5.4）。任何一条不成立都直接抛错，让 `contract:check` 与单测同时变红：
 *
 * 1. operation 声明的每个码都必须在 domain 目录里（防「专属码写错字」变成静默漏项）；
 * 2. domain 目录里的每个码都必须至少被一个 operation 或一个 `(taskKind, stage)` 引用
 *    （防孤儿码）。这一条比 §5.4 的原文更严：原文只要求「非全局错误」被引用，
 *    而 v1 里四个共享码同样都被引用到了，所以直接要求全量覆盖，少一个例外分支；
 * 3. `INTERNAL_ERROR` / `DEPENDENCY_UNAVAILABLE` 不得出现在任何推导结果里；
 * 4. 异步 registry 自身的完整性交给 domain 的 `assertTaskErrorRegistryComplete()`，
 *    这里不复制它的判断（附录 A §4.2 C 的同一原则：不抄逻辑）。
 */
export function assertErrorCodeCoverage(operations: readonly OperationContract[]): void {
  assertTaskErrorRegistryComplete();

  const referenced = new Set<ErrorCode>();
  for (const operation of operations) {
    for (const code of operation.exclusiveErrorCodes) {
      if (!isErrorCode(code)) {
        throw new Error(`unknown error code in operation: ${operation.operationId}/${code}`);
      }
      referenced.add(code);
    }
    const shared = sharedErrorCodes(operation);
    const implicit = shared.filter((code) =>
      (NEVER_IMPLICITLY_MOUNTED_ERROR_CODES as readonly string[]).includes(code),
    );
    if (implicit.length > 0) {
      throw new Error(
        `${implicit.join(' / ')} must never be mounted implicitly: ${operation.operationId}`,
      );
    }
    for (const code of operationErrorCodes(operation)) referenced.add(code);
  }
  for (const code of registeredAsyncErrorCodes()) referenced.add(code);

  const orphaned = DOMAIN_ERROR_CATALOG.filter((entry) => !referenced.has(entry.code)).map(
    (entry) => entry.code,
  );
  if (orphaned.length > 0) {
    throw new Error(`error codes are declared but never referenced: ${orphaned.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// registry 自检
// ---------------------------------------------------------------------------

/** OpenAPI 路径模板：以 `/` 开头，花括号成对且非空，不含查询串。 */
const PATH_TEMPLATE_PATTERN = /^\/(?:[^{}?#]|\{[a-zA-Z][a-zA-Z0-9]*\})*$/;

/**
 * 生成之前先把 registry 自身校一遍。
 *
 * 这些不变量单看每一条都像「作者不会写错」的废话，但它们全部是**下游推导的前提**：
 * `operationId` 不唯一，`operationById` 会静默丢记录；`(method, path)` 不唯一，
 * `buildPaths` 的重复检查会抛，但抛在装配期而不是在校验期，诊断信息里没有原因；
 * security 里出现未声明的 scheme 名，OpenAPI 仍然合法，客户端却永远过不了鉴权 ——
 * 那是只在集成时才暴露的一类错误，代价最高。
 *
 * §5.5「Cookie + CSRF 必须位于同一对象，表示 AND」在这里是可执行断言，不是注释：
 * 写成 `[{CookieAuth:[]},{CsrfHeader:[]}]` 是 OR，含义变成「有会话**或**有 CSRF 头
 * 就放行」，而 CSRF 头是攻击者自己能提供的，等于把防护整体拆掉。两个对象都是合法
 * OpenAPI，文档生成器不会报错，所以必须由这条断言拦住。
 */
export function assertOperationRegistryWellFormed(operations: readonly OperationContract[]): void {
  const seenIds = new Set<string>();
  const seenRoutes = new Set<string>();

  for (const entry of operations) {
    if (entry.operationId.length === 0) {
      throw new Error('operationId must not be empty');
    }
    if (seenIds.has(entry.operationId)) {
      throw new Error(`duplicate operationId: ${entry.operationId}`);
    }
    seenIds.add(entry.operationId);

    if (!PATH_TEMPLATE_PATTERN.test(entry.path)) {
      throw new Error(`path is not a valid OpenAPI template: ${entry.operationId} ${entry.path}`);
    }
    const route = `${entry.method} ${entry.path}`;
    if (seenRoutes.has(route)) {
      throw new Error(`duplicate route: ${route} (${entry.operationId})`);
    }
    seenRoutes.add(route);

    if (entry.tags.length === 0) {
      throw new Error(`operation must declare at least one tag: ${entry.operationId}`);
    }
    for (const tag of entry.tags) {
      if (!CONTRACT_TAGS.some((declared) => declared.name === tag)) {
        throw new Error(`undeclared tag: ${entry.operationId}/${tag}`);
      }
    }

    for (const requirement of entry.security) {
      for (const scheme of Object.keys(requirement)) {
        if (!Object.hasOwn(SECURITY_SCHEMES, scheme)) {
          throw new Error(`undeclared security scheme: ${entry.operationId}/${scheme}`);
        }
      }
    }
    const requiresCsrf = entry.security.some((requirement) =>
      Object.hasOwn(requirement, 'CsrfHeader'),
    );
    if (requiresCsrf) {
      // §5.5：CSRF 必须与会话 cookie 位于**同一个** Security Requirement Object。
      const together = entry.security.some(
        (requirement) =>
          Object.hasOwn(requirement, 'CsrfHeader') && Object.hasOwn(requirement, 'CookieAuth'),
      );
      if (!together) {
        throw new Error(
          `CsrfHeader must share one Security Requirement Object with CookieAuth (AND, not OR): ` +
            `${entry.operationId}`,
        );
      }
    }

    if (entry.success.length === 0) {
      throw new Error(`operation must declare at least one success response: ${entry.operationId}`);
    }
    for (const success of entry.success) {
      assertSuccessResponseInvariant(entry.operationId, success);
    }

    for (const code of entry.exclusiveErrorCodes) {
      if (!isErrorCode(code)) {
        throw new Error(`unknown exclusive error code: ${entry.operationId}/${code}`);
      }
    }
  }
}

/**
 * `SuccessResponse` 的不变量：`mediaType === null` ⟺ `schema === null`。
 *
 * 半截的 content 条目（有 media type 没 schema）是非法 OpenAPI，而 `createDocument`
 * 会把它静默生成出来。抽成独立导出是为了让单测能直接对这条规则造红，不必先构造
 * 一份完整文档。
 */
export function assertSuccessResponseInvariant(
  operationId: string,
  success: SuccessResponse,
): void {
  if ((success.mediaType === null) !== (success.schema === null)) {
    throw new Error(
      `mediaType and schema must both be null or both present: ${operationId}/${success.status}`,
    );
  }
  responseKey(success.status, operationId);
}

// ---------------------------------------------------------------------------
// 泄漏字段自检
// ---------------------------------------------------------------------------

/**
 * 任何 schema 的**属性名**都不得命中这张表。
 *
 * 精确匹配（小写归一后）而不是子串匹配，是因为子串匹配会把规格明确要求的合法字段
 * 一起打死：`provider`（`UsageLedgerEntry.provider`，§5.5）、`prompt`（`createTurn`
 * 的请求体）、`password`（登录请求）、`initialPassword`（批量建档的单次响应，§5.5）、
 * `value`（`PUT /settings/secrets/{kind}` 的请求体）。要禁的不是这些词，而是「把内部
 * 实现或凭证搬到线上」的那一类名字，所以逐个列出。
 *
 * 两条窄的子串规则不会误伤，因为契约里没有任何合法属性以它们结尾/包含它们：
 * 以 `token` 结尾（`accessToken` / `refreshToken` / `sessionToken` / `csrfToken`），
 * 含 `signature`（签名 URL 的签名部分）。
 */
const LEAKY_FIELD_NAMES: ReadonlySet<string> = new Set([
  // 租约与调度内部（附录 A §6.1：Task 不返回 lease）
  'lease',
  'leaseowner',
  'leaseownerid',
  'leaseuntil',
  'leaseexpiresat',
  // provider 会话与幂等实现细节（§5.5：Task 不返回 QCA ID/cursor、operation key）
  'qcasessionid',
  'sessionid',
  'qcaeventcursor',
  'externaloperationkey',
  'operationkey',
  'idempotencykeyhash',
  'requesthash',
  'providerrequestid',
  'providerresponse',
  'providerpayload',
  'rawpayload',
  'rawerror',
  'rawusage',
  'errordigest',
  'stacktrace',
  'stack',
  // 凭证（§5.5：SecretMetadata 永不含 value；凭证只在请求方向流动）
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'authorization',
  'cookie',
  'clientsecret',
  'secretvalue',
  'secretplaintext',
  'apikey',
  'api_key',
  'passwordhash',
  'passwordsalt',
  'credential',
  'credentials',
  'connectionstring',
  'dsn',
  // 对象存储内部（§5.5：ProjectVersion 不返回 object key；预览 URL 是短期独立源地址）
  'objectkey',
  'storagekey',
  'bucket',
  'bucketname',
  'signedurl',
  'presignedurl',
  'uploadurl',
  // 修复计数是重试策略的内部状态，由 `attempt`/`maxAttempts` 对外表达
  'repaircount',
]);

const LEAKY_FIELD_SUFFIXES: readonly string[] = ['token'];
const LEAKY_FIELD_SUBSTRINGS: readonly string[] = ['signature'];

/** 供测试正向对照使用：给定一个属性名，判断它是否会被判为泄漏。 */
export function isLeakyFieldName(name: string): boolean {
  const normalized = name.toLowerCase();
  if (LEAKY_FIELD_NAMES.has(normalized)) return true;
  if (LEAKY_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return LEAKY_FIELD_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/**
 * 在**生成产物**上扫描泄漏字段名，而不是在 Zod 源码上扫。
 *
 * 选产物作为扫描对象有两个理由：其一，产物就是被提交进 `contracts/` 的那份字节，
 * 扫它等于直接给快照上锁 —— 源码扫描只能证明「我写的 schema 里没有」，产物扫描能
 * 证明「快照里没有」，后者才是 §7.3(10) 的措辞。其二，`.meta({ id })` 会把 schema
 * 收进 `components.schemas`，任何一处漏网的内部字段都会在那里再出现一次，扫产物
 * 一次覆盖两处。
 *
 * 只走 schema 的属性名（`properties` / `$defs` 的 key），不走 `headers` 的 key：
 * `Set-Cookie` 是一个合法的响应头名字，把它当属性名扫会误报。
 */
export function assertNoLeakyFieldNames(document: OpenApiDocument): void {
  const found: string[] = [];
  const visit = (node: unknown, trail: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${trail}/${index}`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === 'properties' || key === '$defs' || key === 'patternProperties') {
        const members = record[key];
        if (members !== null && typeof members === 'object') {
          for (const name of Object.keys(members)) {
            if (isLeakyFieldName(name)) found.push(`${trail}/${key}/${name}`);
            visit((members as Record<string, unknown>)[name], `${trail}/${key}/${name}`);
          }
          continue;
        }
      }
      visit(record[key], `${trail}/${key}`);
    }
  };
  visit(document, '');
  if (found.length > 0) {
    throw new Error(
      `leaky field names reached the wire contract: ${[...new Set(found)].sort(compareCodeNames).join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 错误目录快照
// ---------------------------------------------------------------------------

/** 错误目录快照里的一行：§4.2 判定破坏性变更所需的全部四项事实，加码名本身。 */
export interface ErrorCodeCatalogEntry {
  readonly code: string;
  readonly httpStatus: number;
  readonly messageKey: string;
  readonly retryable: boolean;
  readonly sameRequestRetrySafety: SameRequestRetrySafety;
}

export interface ErrorCatalogDocument {
  readonly apiMajor: number;
  readonly codes: readonly ErrorCodeCatalogEntry[];
  readonly taskErrorRegistry: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

/**
 * `contracts/errors/v1/error-catalog.json` 的内容。
 *
 * 为什么单独一份快照，而不是只留在 openapi.json 的 `x-littleq-error-codes` 里：
 * 后者只有码名，而 §4.2 要判定的破坏性变更是「改变既有错误码的 HTTP status、
 * messageKey、retryable、sameRequestRetrySafety」与「新增错误码」—— 四项事实都在
 * domain 目录里，不在 OpenAPI 文档里。把它们提交成快照，比较器才能给出
 * 「哪个码的哪一项变了」这种可裁定的诊断，而不是「某个 enum 多了个成员」。
 *
 * 快照里**不含** `neverImplicitlyMounted`：比较器不判定它，多一个字段只会多一份
 * 假漂移信号。它由 `assertErrorCodeCoverage` 在生成时强制，比写在快照里更硬。
 *
 * `codes` 按码名排序：它是一张按码查表的集合，顺序不承载语义（§4.1 允许对语义
 * 无序集合排序）。`taskErrorRegistry` 的**数组保持 domain 的声明顺序**不动 ——
 * 那是有语义的顺序（同一 stage 内多个码的声明次序），§4.1 明确禁止重排；
 * 只有对象 key 会被归一化器递归排序。
 */
export function errorCatalogDocument(apiMajor: number): ErrorCatalogDocument {
  const codes = DOMAIN_ERROR_CATALOG.map((entry) => {
    const resolved = errorDefinition(entry.code);
    return {
      code: resolved.code,
      httpStatus: resolved.httpStatus,
      messageKey: resolved.messageKey,
      retryable: resolved.retryable,
      sameRequestRetrySafety: resolved.sameRequestRetrySafety,
    };
  }).sort((left, right) => compareCodeNames(left.code, right.code));

  // key 显式排序：`Object.keys` 的顺序虽然由规范保证是插入序，但把确定性交给
  // 归一化器一层去兜底，等于让这份文档在没有归一化器的调用方（单测）里不确定。
  // 数组保持 domain 的声明顺序，不排序（§4.1）。
  const registry: Record<string, Record<string, readonly string[]>> = {};
  for (const kind of Object.keys(taskErrorRegistry).sort(compareCodeNames)) {
    const stages = taskErrorRegistry[kind as keyof typeof taskErrorRegistry];
    const perStage: Record<string, readonly string[]> = {};
    for (const stage of Object.keys(stages).sort(compareCodeNames)) {
      const stageCodes = stages[stage as keyof typeof stages];
      if (stageCodes) perStage[stage] = [...stageCodes];
    }
    registry[kind] = perStage;
  }

  return { apiMajor, codes, taskErrorRegistry: registry };
}

// ---------------------------------------------------------------------------
// 文档装配
// ---------------------------------------------------------------------------

/**
 * OpenAPI `responses` 的 key 必须是 `1xx`–`5xx` 的字符串。
 *
 * 这里不写死一张状态码白名单：状态码来自 registry 的 `success` 与 domain 错误目录，
 * 两处都会随契约演进。所以只做范围校验，越界即抛 —— 静默写出一个 `99` 或 `1000`
 * 的 key 会生成一份看起来正常、实际非法的文档。
 *
 * 起始数字排除 `1`：1xx 是协议级信息响应，本 API 一个都不用；把它挡在外面比让它
 * 在 `ZodOpenApiResponsesObject` 的 key 类型里合法更安全。
 */
type ResponseStatusCode = `${2 | 3 | 4 | 5}${string}`;

function responseKey(status: number, operationId: string): ResponseStatusCode {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error(`response status out of range for ${operationId}: ${status}`);
  }
  return String(status) as ResponseStatusCode;
}

/**
 * 把同一 status 的多条 `SuccessResponse` 合并成一个 Response Object。
 *
 * `success` 是数组正是为了这个：`getUsageLedger` 的 200 同时有 `application/json` 与
 * `text/csv; charset=utf-8` 两个 media type，OpenAPI 里它们是**同一个** 200 响应的两个
 * content 条目，不是两个响应。
 *
 * 合并规则（全部按 registry 声明顺序，不排序 —— `success` 是语义有序数组，§4.1）：
 * - `content`：逐 media type 累加；同一 status 下 media type 重复即抛（作者写错了）；
 * - `headers`：并集后按名字排序（`responseHeaders()` 内部排），因为集合顺序无语义；
 * - `description`：去重后用单个空格连接。去重是为了让「两条描述本来就相同」这种
 *   常见情形不产生重复文本；不排序是因为描述是散文，字母序会读不通。
 *
 * 顺带在这里检查 `SuccessResponse` 的不变量（`mediaType === null` ⟺ `schema === null`）：
 * 违反它会生成「声明了 media type 却没有 schema」的半截 content 条目，是非法 OpenAPI。
 */
function mergeSuccessResponses(
  entry: OperationContract,
): Map<ResponseStatusCode, ZodOpenApiResponseObject> {
  const merged = new Map<
    ResponseStatusCode,
    {
      descriptions: string[];
      headers: Set<ResponseHeaderName>;
      content: Record<string, ZodOpenApiMediaTypeObject>;
    }
  >();

  for (const success of entry.success) {
    // 不变量在 `assertOperationRegistryWellFormed` 里已经查过一遍；这里再查一次是因为
    // 生成入口不一定经过它（控制用例会直接构造 registry 子集），而漏掉就会产生非法
    // content 条目。两处调用同一个函数，不存在两份判断逻辑。
    assertSuccessResponseInvariant(entry.operationId, success);
    const key = responseKey(success.status, entry.operationId);
    let slot = merged.get(key);
    if (!slot) {
      slot = { descriptions: [], headers: new Set(), content: {} };
      merged.set(key, slot);
    }
    if (!slot.descriptions.includes(success.description)) {
      slot.descriptions.push(success.description);
    }
    for (const header of success.headers) slot.headers.add(header);
    if (success.mediaType !== null && success.schema !== null) {
      if (Object.hasOwn(slot.content, success.mediaType)) {
        throw new Error(
          `duplicate media type for the same status: ${entry.operationId}/${success.status}/${success.mediaType}`,
        );
      }
      slot.content[success.mediaType] = { schema: success.schema };
    }
  }

  const out = new Map<ResponseStatusCode, ZodOpenApiResponseObject>();
  for (const [key, slot] of merged) {
    const headers = responseHeaders([...slot.headers]);
    out.set(key, {
      description: slot.descriptions.join(' '),
      ...(Object.keys(slot.content).length > 0 ? { content: slot.content } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }
  return out;
}

/**
 * 由 operation 的错误码集合生成错误响应，每个 HTTP status 一条，body 是统一 envelope。
 *
 * `ErrorEnvelope.code` 是 `string` 而**不是**该 status 下的码枚举：收窄它会让
 * 「错误码的 status 变了」同时在两处产生 diff（响应的 status key 与 enum 成员），
 * 而 §4.2 的判定权威是 `error-catalog.json` 的四项事实。码名写进 `description`
 * 是给人看的，不是给比较器看的。
 *
 * 429 / 503 附带 `Retry-After`（见 `RETRY_AFTER_ERROR_STATUSES`）。
 */
function buildErrorResponses(
  entry: OperationContract,
  into: Map<ResponseStatusCode, ZodOpenApiResponseObject>,
): void {
  for (const group of groupErrorCodesByStatus(operationErrorCodes(entry))) {
    const key = responseKey(group.status, entry.operationId);
    if (into.has(key)) {
      // 一个 status 不能同时是成功响应和错误响应：那会让客户端无法从状态码判断结果。
      throw new Error(
        `error status collides with a success response: ${entry.operationId}/${group.status}`,
      );
    }
    const headers: ResponseHeaderName[] = RETRY_AFTER_ERROR_STATUSES.includes(group.status)
      ? ['Retry-After']
      : [];
    into.set(key, {
      description: `统一错误 envelope。可能的码：${group.codes.join(', ')}。`,
      content: { [JSON_MEDIA_TYPE]: { schema: errorEnvelopeSchema } },
      ...(headers.length > 0 ? { headers: responseHeaders(headers) } : {}),
    });
  }
}

function buildRequestParams(entry: OperationContract): ZodOpenApiParameters | undefined {
  const request = entry.request;
  if (!request) return undefined;
  const params: ZodOpenApiParameters = {};
  let hasParams = false;
  if (request.path) {
    params.path = request.path;
    hasParams = true;
  }
  if (request.query) {
    params.query = request.query;
    hasParams = true;
  }
  if (request.header) {
    params.header = request.header;
    hasParams = true;
  }
  return hasParams ? params : undefined;
}

/**
 * `X-CSRF-Token` 不在 `requestParams.header` 里，由 `CsrfHeader` security scheme 声明
 * （§5.5）。把它同时写成 header 参数会让同一个头在文档里出现两次，并且把「令牌格式
 * 不对」错误地归到请求体校验（`REQUEST_INVALID`）而不是 `CSRF_REJECTED`。
 */
function buildRequestBody(entry: OperationContract): ZodOpenApiRequestBodyObject | undefined {
  const body = entry.request?.body;
  if (!body) return undefined;
  return {
    // 缺省 true：`OperationRequest.body.required` 只在「字段全部可选」时才写 false。
    // 写错方向是破坏性的（§4.2「把 body 改为必填」），所以默认取更严的那一侧。
    required: body.required ?? true,
    description: body.description,
    content: { [JSON_MEDIA_TYPE]: { schema: body.schema } },
  };
}

/**
 * 把 registry 的 `SecurityRequirements` 转成 OpenAPI 的 Security Requirement Object 数组。
 *
 * 两件事必须做，都不是风格问题：
 * - **深拷贝**：registry 里的数组是 `readonly string[]`，而 OpenAPI 的类型是
 *   `string[]`；更要紧的是不能把 `SESSION_WITH_CSRF_SECURITY` 这样的模块级常量对象
 *   直接交出去，`createDocument` 拿到的是可变引用。
 * - **scheme 名排序**：同一对象内的 scheme 是 AND（§4.2），AND 与顺序无关，所以排序
 *   不改变语义，只把「文档里 `{CookieAuth, CsrfHeader}` 与 `{CsrfHeader, CookieAuth}`
 *   算不算同一件事」这个问题从比较器手里拿走。顶层**数组**的顺序不排 —— 那是 OR，
 *   分支的次序虽然也无语义，但它是数组，§4.1 禁止重排数组。
 */
function toSecurityRequirements(security: SecurityRequirements): Record<string, string[]>[] {
  return security.map((requirement) => {
    const out: Record<string, string[]> = {};
    for (const scheme of Object.keys(requirement).sort(compareCodeNames)) {
      out[scheme] = [...(requirement[scheme] ?? [])];
    }
    return out;
  });
}

function buildOperation(entry: OperationContract): ZodOpenApiOperationObject {
  const responses = mergeSuccessResponses(entry);
  buildErrorResponses(entry, responses);

  // key 按状态码升序重建：`responses` 是对象，归一化器最终会按字符串排序（三位数字符串
  // 的字符串序与数值序一致），这里先排一次，让「未经归一化的生成结果」本身就是确定的，
  // 不把确定性外包给下游脚本（PM G6）。
  const ordered: ZodOpenApiResponsesObject = {};
  for (const key of [...responses.keys()].sort(compareCodeNames)) {
    const value = responses.get(key);
    if (value) ordered[key] = value;
  }

  const requestParams = buildRequestParams(entry);
  const requestBody = buildRequestBody(entry);

  return {
    operationId: entry.operationId,
    summary: entry.summary,
    ...(entry.description ? { description: entry.description } : {}),
    tags: [...entry.tags],
    security: toSecurityRequirements(entry.security),
    ...(requestParams ? { requestParams } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: ordered,
    [ERROR_CODES_EXTENSION]: operationErrorCodes(entry),
  };
}

function buildPaths(): ZodOpenApiPathsObject {
  const paths: ZodOpenApiPathsObject = {};
  for (const entry of operationRegistry) {
    let item = paths[entry.path];
    if (!item) {
      item = {};
      paths[entry.path] = item;
    }
    const existing = item[entry.method];
    if (existing) {
      throw new Error(
        `duplicate operation for ${entry.method.toUpperCase()} ${entry.path}: ` +
          `${existing.operationId} / ${entry.operationId}`,
      );
    }
    item[entry.method] = buildOperation(entry);
  }
  return paths;
}

/**
 * 生成完整的 OpenAPI 3.1 文档。
 *
 * 调用即校验：`assertOperationRegistryWellFormed` → `assertErrorCodeCoverage` →
 * 装配 → `assertNoLeakyFieldNames`。任何孤儿码、写错的专属码、被隐式挂载的
 * `INTERNAL_ERROR`、拆成 OR 的 CSRF，或漏进产物的内部字段名，都会让生成失败，
 * 而不是产出一份「看起来对」的文档。`contract:check` 与单测都走这一个入口，
 * 所以两边红绿一致（§4.2 C 的同一原则：控制用例不得复制生产逻辑）。
 *
 * 文档级 `security` **不设**。§5.5 要求公开接口显式写 `security: []`，而空数组与
 * 「未声明」的区别正是「不继承顶层」；既然每条 operation 都自带 security，设一个顶层
 * 值只会制造一条永远不该被用到的继承路径。`test/openapi.test.ts` 断言生成产物里
 * 31 个 operation 全部带显式 `security` 数组。
 */
export function createOpenApiDocument(): OpenApiDocument {
  assertOperationRegistryWellFormed(operationRegistry);
  assertErrorCodeCoverage(operationRegistry);

  const document = createDocument({
    openapi: OPENAPI_SPEC_VERSION,
    info: {
      title: 'LittleQ API',
      version: CONTRACT_VERSION,
      description:
        'LittleQ 对外 HTTP 契约。事实源是 packages/api-contract 里的 Zod DTO 与 ' +
        'operationRegistry，本文档由它单向派生，不得反向生成类型。',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: SERVER_URL }],
    tags: CONTRACT_TAGS.map((tag) => ({ ...tag })),
    // 浅拷贝一层：`createDocument` 会把 security scheme 收进它自己的 component
    // registry，不能让它拿到模块级常量的可变引用。
    components: { securitySchemes: { ...SECURITY_SCHEMES } },
    paths: buildPaths(),
  });

  // 泄漏扫描放在最后：它检查的是**将要落盘的那份字节**，包括 `createDocument` 自己
  // 生成的 `components.schemas`。放在装配前扫源码是扫不到这一层的。
  assertNoLeakyFieldNames(document);
  return document;
}

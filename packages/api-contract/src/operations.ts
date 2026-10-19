/**
 * operation registry —— 31 条接口的**唯一事实源**。
 *
 * 这是一份数据声明，不含任何生成逻辑：OpenAPI 文档由 `openapi.ts` 从它单向派生，
 * apps/api 之后只能引用派生结果，不得再声明第二套 DTO 校验规则（附录 A §3.5）。
 * 因此这里写下的每一个字段都是契约本身，改它就是改契约 —— §4.2 的破坏性比较正是
 * 作用在由它生成的快照上。
 *
 * ## 三条贯穿全表的规则
 *
 * **1. 写接口 = 非 GET。** `security` 只有三种取值（`SESSION_SECURITY` /
 * `SESSION_WITH_CSRF_SECURITY` / `ANONYMOUS_SECURITY`），选择依据是 method：所有
 * `POST` / `PUT` / `PATCH` 一律带 CSRF。`createPreview` 是唯一容易犹豫的一条 ——
 * 它不改项目状态，但它会签发一个短期独立源 URL 并可能触发构建，属于有副作用的调用，
 * 因此按写接口处理。把「是否写」交给 method 判断而不是逐条主观认定，是为了让
 * `openapi.ts` 里「security 含 CsrfHeader ⇒ 挂 `CSRF_REJECTED`」这条推导规则永远成立。
 *
 * **2. 公开面显式 `security: []`。** 空数组不等于「未声明」：未声明会继承文档顶层的
 * security，而本文件不给文档设顶层 security，所以五个匿名接口必须逐条写 `[]`（§5.5）。
 * `test/operations.test.ts` 断言这五条恰好是 login / getPublicWork / getLicense /
 * 两条 health —— 与 §5.4「除 login/public/license/health 外」的措辞逐字对应。
 *
 * **3. 专属码只写 §5.4 表格右栏。** 共享码（`REQUEST_INVALID` /
 * `AUTHENTICATION_REQUIRED` / `CSRF_REJECTED` / `RESOURCE_NOT_FOUND`）由 `openapi.ts`
 * 从 method、security 与 path 推导，**不在这里重复声明**：抄一遍就有 31 次漂移机会，
 * 而推导只会跟着 security 与路径自动变化。
 */
import type { ZodOpenApiSecuritySchemeObject } from 'zod-openapi';

import {
  ANONYMOUS_SECURITY,
  conditionalReadHeaderSchema,
  CSRF_HEADER_NAME,
  CSV_MEDIA_TYPE,
  idempotencyHeaderSchema,
  idPathSchema,
  ifMatchHeaderSchema,
  JSON_MEDIA_TYPE,
  liveHealthSchema,
  licenseSchema,
  publishHeaderSchema,
  readyHealthSchema,
  SESSION_COOKIE_NAME,
  SESSION_SECURITY,
  SESSION_WITH_CSRF_SECURITY,
  SSE_MEDIA_TYPE,
  usageLimitConditionalHeaderSchema,
  type OperationContract,
  type ResponseHeaderName,
  type SuccessResponse,
  type WireSchema,
} from './schemas/common.js';
import { loginRequestSchema } from './schemas/auth.js';
import {
  batchCreateStudentsRequestSchema,
  batchCreateStudentsResponseSchema,
  createGroupRequestSchema,
  groupPageSchema,
  groupSchema,
  listGroupsQuerySchema,
} from './schemas/groups.js';
import {
  createPreviewRequestSchema,
  createPreviewResponseSchema,
  createProjectRequestSchema,
  createTurnRequestSchema,
  getProjectResponseSchema,
  listProjectsQuerySchema,
  listProjectVersionsQuerySchema,
  projectPageSchema,
  projectSchema,
  projectVersionPageSchema,
  publishProjectRequestSchema,
  publishProjectResponseSchema,
  restoreProjectVersionPathSchema,
  restoreProjectVersionRequestSchema,
  restoreProjectVersionResponseSchema,
} from './schemas/projects.js';
import {
  retryTaskRequestSchema,
  streamTaskEventsHeaderSchema,
  taskAcceptedSchema,
  taskEventSchema,
  taskPumpResultSchema,
  taskRetryAcceptedSchema,
  taskSchema,
} from './schemas/tasks.js';
import {
  publicWorkPathSchema,
  publicWorkSchema,
  updateWorkRequestSchema,
  workSchema,
} from './schemas/works.js';
import {
  putSecretRequestSchema,
  revokeSecretRequestSchema,
  rotateSecretRequestSchema,
  secretKindPathSchema,
  secretMetadataSchema,
} from './schemas/settings.js';
import {
  getUsageLedgerQuerySchema,
  getUsageLimitsQuerySchema,
  ledgerCsvSchema,
  putUsageLimitRequestSchema,
  usageLedgerPageSchema,
  usageLimitPageSchema,
  usageLimitSchema,
} from './schemas/usage.js';

/**
 * 文档级 security scheme。
 *
 * `CookieAuth` 写成 `apiKey` / `in: 'cookie'` 而**不是** `type: 'cookie'`：OpenAPI 3.1
 * 的 `SecuritySchemeType` 只有 `apiKey | http | mutualTLS | oauth2 | openIdConnect`，
 * 压根没有 `cookie` 这一种，而 `apiKey` 的 `name` 是必填字段。所以「Secure HttpOnly
 * 会话 cookie」在合法 OpenAPI 里的唯一表达就是 `{type:'apiKey', in:'cookie', name:<cookie 名>}`。
 *
 * 这意味着 cookie 名**必须**进入契约 —— 它现在是快照里的一个字节，改名会被 §4.2 判为
 * 破坏性变更（与「把幂等 header 改名」同源）。cookie 的**值**仍然是会话凭证本身，
 * §5 禁止它出现在契约、快照与 fixture 里，这一点不变；`Secure` / `HttpOnly` 是 cookie
 * 属性，OpenAPI 无处表达，因此写进 description 交给服务端实现负责。
 *
 * `CsrfHeader` 是双提交 token，`apiKey`/`in: header` 是 OpenAPI 表达「必须带这个头」的
 * 标准方式，与 `CookieAuth` 出现在同一个 Security Requirement Object 里即表示 AND
 * （§4.2 的精确语义）。头名从 `CSRF_HEADER_NAME` 取，§5.5 已把它钉成 `X-CSRF-Token`，
 * 因此这里不重复拼写。
 */
export const SECURITY_SCHEMES: Readonly<Record<string, ZodOpenApiSecuritySchemeObject>> = {
  CookieAuth: {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE_NAME,
    description: 'Secure HttpOnly 会话 cookie。契约声明 cookie 名，绝不声明 cookie 值。',
  },
  CsrfHeader: {
    type: 'apiKey',
    in: 'header',
    name: CSRF_HEADER_NAME,
    description:
      '双提交 CSRF token。与会话 cookie 位于同一 Security Requirement Object 时表示 AND。',
  },
};

/** 文档级 tag 清单。排序固定，`test/operations.test.ts` 断言每条 operation 的 tag 都在其中。 */
export const CONTRACT_TAGS: readonly { readonly name: string; readonly description: string }[] = [
  { name: 'auth', description: '会话登录与登出。' },
  { name: 'groups', description: '小组与学生账号。' },
  { name: 'projects', description: '项目、版本与生成回合。' },
  { name: 'tasks', description: '异步任务的读取、取消、重试与事件流。' },
  { name: 'works', description: '作品与可见性设置。' },
  { name: 'public', description: '匿名可访问的公开面。' },
  { name: 'settings', description: '平台设置：AI 凭证的秘密元数据。' },
  { name: 'usage', description: '用量额度与账本。' },
  { name: 'platform', description: 'license 与健康检查。' },
];

/** 204：无 body、无 media type。`SuccessResponse` 的不变量要求 `schema` 同时为 null。 */
function noContent(
  description: string,
  headers: readonly ResponseHeaderName[] = [],
): SuccessResponse {
  return { status: 204, description, mediaType: null, headers, schema: null };
}

/** 304：条件读取命中。RFC 9110 要求 304 带上 200 会给的 ETag，所以这里显式声明。 */
function notModified(description: string): SuccessResponse {
  return { status: 304, description, mediaType: null, headers: ['ETag'], schema: null };
}

/** JSON 成功响应，占了 31 条里的绝大多数，所以单独一个不带 media type 参数的糖。 */
function json(
  status: number,
  description: string,
  schema: WireSchema,
  headers: readonly ResponseHeaderName[] = [],
): SuccessResponse {
  return respond(status, description, JSON_MEDIA_TYPE, schema, headers);
}

/** 非 JSON 的成功响应（SSE、CSV）：media type 与 schema 都要显式给出。 */
function respond(
  status: number,
  description: string,
  mediaType: string,
  schema: WireSchema,
  headers: readonly ResponseHeaderName[] = [],
): SuccessResponse {
  return { status, description, mediaType, headers, schema };
}

function body(schema: WireSchema, description: string, required = true) {
  return { schema, description, required };
}

/**
 * 31 条 operation。数组顺序**就是 §5.4 接口表的顺序**。
 *
 * 顺序在这里有意义、在快照里没有：生成器把它写进 `paths`，而 `paths` 是对象，
 * 归一化器会按 §4.1 递归排序对象 key，所以快照里是按路径字母序。这不损失什么 ——
 * `operationId` 是唯一键，diff 定位靠它而不是靠行号。把 registry 固定成表格顺序
 * 是为了让**源码**读起来与规格文档一一对应，改一条时能立刻看到左右邻居是谁。
 *
 * 真正必须保持声明顺序的数组是 `exclusiveErrorCodes` 与 `success`：前者是
 * §5.4 表格右栏的逐项抄录，后者的顺序决定同一 status 下多个 media type 的
 * 描述拼接顺序（见 `openapi.ts` 的 `mergeSuccessResponses`）。
 */
export const operationRegistry: readonly OperationContract[] = [
  // ---- auth ---------------------------------------------------------------
  {
    operationId: 'login',
    method: 'post',
    path: '/auth/login',
    summary: '用登录名与口令建立会话。',
    description:
      '成功返回 204 与 Set-Cookie，**没有响应体**：把用户对象返回给登录者会顺带把角色、' +
      '锁定策略等只属于服务端判断的字段带出去（§5.3 要求角色判断留在服务端）。' +
      '匿名接口，因此不带 CSRF —— 此时还没有会话可保护。',
    tags: ['auth'],
    security: ANONYMOUS_SECURITY,
    request: { body: body(loginRequestSchema, '登录凭据。') },
    success: [noContent('登录成功，会话 cookie 已下发。', ['Set-Cookie'])],
    exclusiveErrorCodes: ['AUTHENTICATION_FAILED', 'ACCOUNT_LOCKED', 'RATE_LIMITED'],
  },
  {
    operationId: 'logout',
    method: 'post',
    path: '/auth/logout',
    summary: '结束当前会话。',
    description:
      '靠 cookie 识别会话，因此没有请求体，也没有 path/query 参数 —— 这也是它' +
      '**不挂 `REQUEST_INVALID`** 的原因：没有任何输入可以校验。清 cookie 通过 Set-Cookie 完成。',
    tags: ['auth'],
    security: SESSION_WITH_CSRF_SECURITY,
    success: [noContent('会话已结束，cookie 已清除。', ['Set-Cookie'])],
    exclusiveErrorCodes: [],
  },

  // ---- groups -------------------------------------------------------------
  {
    operationId: 'listGroups',
    method: 'get',
    path: '/groups',
    summary: '分页列出当前用户可见的小组。',
    description:
      'scope 由服务端按角色固定，不接受调用方传入 owner 参数：§5.3 要求查询**先带 scope**，' +
      '禁止「查出后再判断」。`membership` 不在列表读模型里，成员清单由 batchCreateStudents 与后续专门接口负责。',
    tags: ['groups'],
    security: SESSION_SECURITY,
    request: { query: listGroupsQuerySchema },
    success: [json(200, '小组分页。', groupPageSchema)],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'createGroup',
    method: 'post',
    path: '/groups',
    summary: '创建小组。',
    description:
      '`memberLimit` 没有默认值（附录 A §6.3：domain 不硬编码默认值），因此请求体必须显式给出。' +
      'Location 指向新建小组，ETag 是其初始 revision。',
    tags: ['groups'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: { body: body(createGroupRequestSchema, '小组名称、种类与容量设置。') },
    success: [json(201, '小组已创建。', groupSchema, ['ETag', 'Location'])],
    exclusiveErrorCodes: ['FORBIDDEN_CAPABILITY'],
  },
  {
    operationId: 'batchCreateStudents',
    method: 'post',
    path: '/groups/{id}/students:batch',
    summary: '在小组内批量创建学生账号。',
    description:
      '事务策略是**逐项结果**（§5.4）：`failed[]` 只承载逐项业务校验失败（例如登录名冲突），' +
      '而权限不足、小组已归档这类**请求级**错误仍然走统一 envelope，不出现在 `failed[]` 里。' +
      '`initialPassword` 只在这一次响应里出现，之后任何接口都不再返回它（§5.5）。' +
      '`failed[]` 刻意不回显 loginName / nickname —— 那是儿童 PII，`index` 足以定位到请求里的第几项。',
    tags: ['groups'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: idPathSchema,
      body: body(
        batchCreateStudentsRequestSchema,
        '1..100 个学生条目。上限是事务边界，不是性能调参。',
      ),
    },
    success: [json(201, '批量创建结果：成功项与逐项失败项。', batchCreateStudentsResponseSchema)],
    exclusiveErrorCodes: [
      'FORBIDDEN_CAPABILITY',
      'GROUP_ARCHIVED',
      'LOGIN_NAME_CONFLICT',
      'GROUP_MEMBER_LIMIT_REACHED',
    ],
  },

  // ---- projects -----------------------------------------------------------
  {
    operationId: 'listProjects',
    method: 'get',
    path: '/projects',
    summary: '分页列出项目。',
    description:
      'Student 调用时 `ownerStudentId` 由服务端固定为自己的 id，传入的值会被忽略；' +
      'Owner 才可以按学生过滤（§5.3 的 scope 规则）。',
    tags: ['projects'],
    security: SESSION_SECURITY,
    request: { query: listProjectsQuerySchema },
    success: [json(200, '项目分页。', projectPageSchema)],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'createProject',
    method: 'post',
    path: '/projects',
    summary: '创建项目。',
    description:
      '`templateId` 可为 null（不从模板创建）。这里用 `.nullable().optional()` 而不是只用 ' +
      '`.nullable()`：请求方向多接受「键缺席」是**放宽**接受集合，按 §4.2 属于非破坏性方向；' +
      '响应方向则一律 required + nullable（附录 A §6.4）。',
    tags: ['projects'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      body: body(createProjectRequestSchema, '项目标题、作品类型、年龄 band 与帮助等级。'),
    },
    success: [json(201, '项目已创建。', projectSchema, ['ETag', 'Location'])],
    exclusiveErrorCodes: ['FORBIDDEN_CAPABILITY'],
  },
  {
    operationId: 'getProject',
    method: 'get',
    path: '/projects/{id}',
    summary: '读取项目聚合视图。',
    description:
      '一次返回项目、当前版本与活动任务，避免编辑器首屏发三个请求。' +
      '`currentVersion` / `activeTask` 为 null 表示没有；按附录 A §6.4 它们是 required + nullable，' +
      '所以键一定在。支持 `If-None-Match` 条件读取，命中返回 304。',
    tags: ['projects'],
    security: SESSION_SECURITY,
    request: { path: idPathSchema, header: conditionalReadHeaderSchema },
    success: [
      json(200, '项目聚合视图。', getProjectResponseSchema, ['ETag']),
      notModified('ETag 命中，内容未变。'),
    ],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'createTurn',
    method: 'post',
    path: '/projects/{id}/turns',
    summary: '发起一个生成回合（异步）。',
    description:
      '幂等写：`Idempotency-Key` 必填（§5.5），重放同一个 key 返回同一个 taskId 与 ' +
      '`IDEMPOTENCY_KEY_REUSED`。响应只有 `taskId` 与新 revision，不回显整个 Task —— ' +
      '否则 POST 与 `GET /tasks/{id}` 的字段集合必须永远同步，那是两个接口之间的一条隐形耦合。' +
      '准入判定见附录 A §6.5：全局 10 / 小组 3 是**调度**上限（排队，不拒绝），' +
      '每个学生与每个项目各 1 个活动写任务才是**创建不变量**（409）。',
    tags: ['projects'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: idPathSchema,
      header: idempotencyHeaderSchema,
      body: body(createTurnRequestSchema, '用户输入与基线版本。'),
    },
    success: [json(202, '任务已受理。', taskAcceptedSchema, ['Location'])],
    exclusiveErrorCodes: [
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
      'ACTIVE_WRITE_TASK_EXISTS',
      'USAGE_LIMIT_EXCEEDED',
      'QCA_CREDENTIAL_NOT_CONFIGURED',
    ],
  },

  // ---- tasks --------------------------------------------------------------
  {
    operationId: 'getTask',
    method: 'get',
    path: '/tasks/{id}',
    summary: '读取任务表示。',
    description:
      '异步失败以 **HTTP 200** 返回，错误在 body 的 `error` 字段里（code / messageKey / retryable）；' +
      '客户端拿 code 查文案、拿 retryable 决定要不要自动重试。结构上不含 lease、QCA session id、' +
      'event cursor、operation key、provider request id 与 error digest（附录 A §6.4）。',
    tags: ['tasks'],
    security: SESSION_SECURITY,
    request: { path: idPathSchema, header: conditionalReadHeaderSchema },
    success: [json(200, '任务表示。', taskSchema, ['ETag']), notModified('ETag 命中，内容未变。')],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'streamTaskEvents',
    method: 'get',
    path: '/tasks/{id}/events',
    summary: 'SSE 订阅任务事件流。',
    description:
      'wire format 固定为 `id:<sequence>` / `event:<lowercase-name>` / `data:<TaskEvent JSON>`（§5.5）。' +
      '带 `Last-Event-ID` 重连时先补发 sequence 更大的事件，再进入实时推送；' +
      'B/C 类任务 20 秒主动结束流，由客户端重连。响应 schema 描述的是**每个 `data:` 载荷**，' +
      '不是整个响应体 —— `text/event-stream` 的整体形状是 SSE 协议，不是 JSON。',
    tags: ['tasks'],
    security: SESSION_SECURITY,
    request: { path: idPathSchema, header: streamTaskEventsHeaderSchema },
    success: [
      respond(200, 'SSE 事件流。schema 描述每个 data: 载荷。', SSE_MEDIA_TYPE, taskEventSchema),
    ],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'cancelTask',
    method: 'post',
    path: '/tasks/{id}:cancel',
    summary: '请求取消任务。',
    description:
      '条件写：`If-Match` 必填，不匹配映射 `REVISION_CONFLICT`。返回**完整的 Task**（不是 taskId），' +
      '因为取消是一次状态机迁移，客户端需要立刻看到新的 state / stage 与 revision 才能刷新 UI；' +
      '只有 `QUEUED` / `RUNNING` / `CANCELLING` 可取消，其余映射 `TASK_NOT_CANCELLABLE`。',
    tags: ['tasks'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: { path: idPathSchema, header: ifMatchHeaderSchema },
    success: [json(202, '取消已受理。', taskSchema, ['ETag'])],
    exclusiveErrorCodes: ['TASK_NOT_CANCELLABLE'],
  },
  {
    operationId: 'retryTask',
    method: 'post',
    path: '/tasks/{id}:retry',
    summary: '重试同一个任务（新 attempt）。',
    description:
      '重试是**同一个 task 的新 attempt**，不是新建 task，因此没有 Location。' +
      '只有 `FAILED` / `TIMED_OUT` 可重试；`retryable` 不得由异常继承推导，只能查固定的 ' +
      '`(stage, code)` 表（附录 A §6.6）。`reason` 是操作说明，不是重试**策略**：' +
      '请求体全部字段 optional，所以 `requestBody.required` 显式为 false。',
    tags: ['tasks'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: idPathSchema,
      header: ifMatchHeaderSchema,
      body: body(retryTaskRequestSchema, '可选的操作说明。', false),
    },
    success: [json(202, '重试已受理。', taskRetryAcceptedSchema, ['ETag'])],
    exclusiveErrorCodes: ['TASK_NOT_RETRYABLE', 'ACTIVE_WRITE_TASK_EXISTS', 'USAGE_LIMIT_EXCEEDED'],
  },
  {
    operationId: 'pumpTask',
    method: 'post',
    path: '/tasks/{id}:pump',
    summary: '推进一步任务（客户端单飞）。',
    description:
      '把任务向前推进**一个有界切片**，不是一整个回合：§12.2 要求完整回合可以由多次 pump ' +
      '拼成，且不存在任何一个等待完整 QCA 回合的 HTTP 请求。返回 **200**（不是 202）——' +
      'pump 在请求内同步做完它这一片，响应里的 `outcome` 与 `task` 就是当下的事实，' +
      '没有"稍后再告诉你"的悬空承诺。`outcome` 把"什么都没做"分成三种互不相同的原因' +
      '（`NO_OP_WAITING` 在等退避 / `NO_OP_CANCELLING` 正在被取消 / `NO_OP_TERMINAL` 已到终态），' +
      '三者都是 200 而**不是** 409：终态任务再 pump 一次不是冲突，把它报成冲突会让客户端' +
      '按"重新 GET 再试"的语义无限循环。单飞由 `If-Match` 的 revision CAS 与租约共同保证，' +
      '**不是**服务端进程内的 in-flight 集合（附录 A §6.5 规则 5：进程内 semaphore 或 Map ' +
      '不是事实源）—— 输家在赢家仍在推进时拿到 200 `COALESCED_IN_FLIGHT`，在赢家已提交后' +
      '拿到 409 `REVISION_CONFLICT`。切片内部发生的 provider 失败**不**从本接口同步返回：' +
      '它按 §5.5 记在任务上，经 `GET /tasks/{id}` 以 HTTP 200 + `task.error` 暴露，' +
      '否则同一个事实会有两条错误通道。无请求体：pump 是机械推进，不是带理由的操作者动作。',
    tags: ['tasks'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: { path: idPathSchema, header: ifMatchHeaderSchema },
    success: [json(200, '本次 pump 的结果与任务当前表示。', taskPumpResultSchema, ['ETag'])],
    exclusiveErrorCodes: ['REVISION_CONFLICT'],
  },

  // ---- versions -----------------------------------------------------------
  {
    operationId: 'listProjectVersions',
    method: 'get',
    path: '/projects/{id}/versions',
    summary: '分页列出项目版本。',
    description:
      '版本不可变（§6.6），因此列表只有追加，没有更新。`artifactSha256` 是内容摘要，' +
      '不是下载地址；对象清单与物理位置留在 infra，不出现在契约里。',
    tags: ['projects'],
    security: SESSION_SECURITY,
    request: { path: idPathSchema, query: listProjectVersionsQuerySchema },
    success: [json(200, '版本分页。', projectVersionPageSchema)],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'restoreProjectVersion',
    method: 'post',
    path: '/projects/{id}/versions/{v}:restore',
    summary: '把某个历史版本恢复为当前版本。',
    description:
      '路径参数 `{v}` 是**版本的 UUIDv7 id，不是 `sequence`**：`sequence` 只在项目内唯一，' +
      '而分支恢复之后同一个 sequence 会指向不同内容，用它做 URL 会让已分享/已收藏的地址悄悄换目标。' +
      '可恢复的判据是 `buildStatus === VALID && scanStatus !== BLOCK`（`CONFIRM_REQUIRED` **可以**恢复，' +
      '但**不能**发布）。请求体只有可选的 `reason`，因此 `required` 为 false。',
    tags: ['projects'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: restoreProjectVersionPathSchema,
      header: ifMatchHeaderSchema,
      body: body(restoreProjectVersionRequestSchema, '可选的操作说明。', false),
    },
    success: [
      json(201, '已恢复，返回新版本与项目的新 revision。', restoreProjectVersionResponseSchema, [
        'Location',
      ]),
    ],
    exclusiveErrorCodes: [
      'VERSION_NOT_RESTORABLE',
      'ACTIVE_WRITE_TASK_EXISTS',
      'REVISION_CONFLICT',
    ],
  },
  {
    operationId: 'createPreview',
    method: 'post',
    path: '/projects/{id}/preview',
    summary: '为某个版本签发短期预览地址。',
    description:
      '响应里的 `url` 是**短期独立源地址**。契约只声明它是「不超过 512 字符的串」，' +
      '**不含任何示例值** —— 一个样例签名 URL 就是一份可复用的凭证模板（§5）。' +
      '可预览的判据与可恢复相同。虽然是 POST，它不改项目状态，但仍按写接口带 CSRF（见文件注释规则 1）。',
    tags: ['projects'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: idPathSchema,
      body: body(createPreviewRequestSchema, '可选的版本 id；缺省为当前版本。', false),
    },
    success: [json(200, '预览地址与其有效期。', createPreviewResponseSchema)],
    exclusiveErrorCodes: ['VERSION_NOT_PREVIEWABLE'],
  },
  {
    operationId: 'publishProject',
    method: 'post',
    path: '/projects/{id}/publish',
    summary: '发布某个版本（异步）。',
    description:
      '同时是幂等写与条件写：`Idempotency-Key` 与 `If-Match` 都必填。可发布的判据比可恢复更严 ——' +
      ' `buildStatus === VALID && scanStatus === PASS`，`CONFIRM_REQUIRED` **不可**发布。' +
      '发布不覆盖旧 publication（附录 A §6.2：`LIVE → REVOKED`）。',
    tags: ['projects'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: idPathSchema,
      header: publishHeaderSchema,
      body: body(publishProjectRequestSchema, '要发布的版本与可见性设置。'),
    },
    success: [json(202, '发布任务已受理。', publishProjectResponseSchema, ['Location'])],
    exclusiveErrorCodes: [
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
      'VERSION_NOT_PUBLISHABLE',
      'PUBLICATION_IN_PROGRESS',
      'WORK_CONTRACT_BLOCKED',
      'CONTENT_REJECTED',
    ],
  },

  // ---- works --------------------------------------------------------------
  {
    operationId: 'getWork',
    method: 'get',
    path: '/works/{id}',
    summary: '读取作品（作者视角）。',
    description:
      '与 `getPublicWork` 的区别是视角：这条接口面向作者本人，返回的 `Work` 带 `status`；' +
      '公开面返回的 `PublicWork` 不带 `status`，因为把 `REVOKED` 暴露给匿名访问者本身就是信息泄漏。',
    tags: ['works'],
    security: SESSION_SECURITY,
    request: { path: idPathSchema, header: conditionalReadHeaderSchema },
    success: [
      json(200, '作品读模型。', workSchema, ['ETag']),
      notModified('ETag 命中，内容未变。'),
    ],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'updateWork',
    method: 'patch',
    path: '/works/{id}',
    summary: '修改作品的可见性或评论开关。',
    description:
      '请求体**至少一项**且**禁止额外字段**（`.strict()` ⇒ `additionalProperties: false`）。' +
      '可见性与删除状态是分离的（附录 A §6.2）：改可见性不会复活已删除的作品。',
    tags: ['works'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: idPathSchema,
      header: ifMatchHeaderSchema,
      body: body(updateWorkRequestSchema, 'visibility 与 commentsEnabled 至少一项。'),
    },
    success: [json(200, '修改后的作品与新的 ETag。', workSchema, ['ETag'])],
    exclusiveErrorCodes: ['REVISION_CONFLICT', 'FORBIDDEN_CAPABILITY'],
  },

  // ---- public -------------------------------------------------------------
  {
    operationId: 'getPublicWork',
    method: 'get',
    path: '/public/works/{slug}',
    summary: '匿名读取公开作品。',
    description:
      '§5.3：对不存在、PRIVATE、REVOKED、DELETED **一律**返回 404 与同一机器码。' +
      '因此 `RESOURCE_NOT_FOUND` 在这里是**专属码**而不是从路径推导 —— 路径参数是 `{slug}` 不是 `{id}`，' +
      '而这个 404 的语义是「不可公开服务」，比「对象不存在」更宽。SSR 壳可以显示儿童文案，' +
      '但不得泄露技术原因，所以响应里没有任何区分四种情况的字段。',
    tags: ['public'],
    security: ANONYMOUS_SECURITY,
    request: { path: publicWorkPathSchema },
    success: [json(200, '可公开服务的作品投影。', publicWorkSchema)],
    exclusiveErrorCodes: ['RESOURCE_NOT_FOUND'],
  },

  // ---- settings -----------------------------------------------------------
  {
    operationId: 'getSecretMetadata',
    method: 'get',
    path: '/settings/secrets/{kind}',
    summary: '读取某个 AI 凭证的配置状态。',
    description:
      '只返回 kind / configured / lastRotatedAt，**永不返回 value，也不返回 hash**（§5.5）。' +
      'hash 同样不返回：它能让离线爆破者验证猜测，而「是否已配置」这个布尔值已经满足 UI 的全部需要。',
    tags: ['settings'],
    security: SESSION_SECURITY,
    request: { path: secretKindPathSchema },
    success: [json(200, '秘密元数据。', secretMetadataSchema)],
    exclusiveErrorCodes: ['FORBIDDEN_CAPABILITY', 'SECRET_KIND_UNSUPPORTED'],
  },
  {
    operationId: 'putSecret',
    method: 'put',
    path: '/settings/secrets/{kind}',
    summary: '写入（配置或覆盖）某个 AI 凭证。',
    description:
      '成功返回 **204 无 body**：不回显、不返回 hash。这是「秘密值只有入向、没有出向」的结构性保证 ——' +
      ' 服务端没有第二条把明文送出去的路径（`:rotate` 与 `:revoke` 同样返回 204，整个 ' +
      '`/settings/secrets/*` 资源因此没有任何出向 body）。PUT 是**幂等**的写入：首次配置与' +
      '覆盖同一个值都走它，因此它不要求凭证已被配置过 —— 那是 `:rotate` 的前提条件。' +
      '部署注入的凭证（平台级，不是用户 BYO）在本接口映射 `SECRET_IMMUTABLE_REDEPLOY_REQUIRED`：' +
      '它的值由部署环境变量提供，改它只能重新部署。',
    tags: ['settings'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: secretKindPathSchema,
      body: body(putSecretRequestSchema, '秘密明文。契约层只约束长度与字符集，不做任何脱敏。'),
    },
    success: [noContent('已写入，不回显。')],
    exclusiveErrorCodes: [
      'FORBIDDEN_CAPABILITY',
      'SECRET_KIND_UNSUPPORTED',
      'SECRET_IMMUTABLE_REDEPLOY_REQUIRED',
    ],
  },
  {
    operationId: 'rotateSecret',
    method: 'post',
    path: '/settings/secrets/{kind}:rotate',
    summary: '轮换某个 AI 凭证（旧值立即失效）。',
    description:
      '与 PUT 的差别是**前提与语义**，不是载荷：`:rotate` 要求凭证已经配置过，它表达的是一次' +
      '显式的轮换动作 ——「让当前值失效并换上一个新的」。分开建模是为了让 `audit_logs` 能区分' +
      '一次首配与一次因为怀疑泄漏而做的轮换（domain 侧是 `SECRET_PUT` 与 `SECRET_ROTATE` 两个动作）。' +
      '对未配置的种类调用映射 `REQUEST_INVALID`：那不是"轮换"，客户端应当改调 PUT。' +
      '轮换后 `SecretMetadata.lastRotatedAt` 前进、`configured` 仍为 true，**永不返回新旧任何一个值**。' +
      '部署注入的凭证同样映射 `SECRET_IMMUTABLE_REDEPLOY_REQUIRED`。',
    tags: ['settings'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: secretKindPathSchema,
      body: body(rotateSecretRequestSchema, '新的秘密明文，可选的操作注记。'),
    },
    success: [noContent('已轮换，不回显。')],
    exclusiveErrorCodes: [
      'FORBIDDEN_CAPABILITY',
      'SECRET_KIND_UNSUPPORTED',
      'SECRET_IMMUTABLE_REDEPLOY_REQUIRED',
    ],
  },
  {
    operationId: 'revokeSecret',
    method: 'post',
    path: '/settings/secrets/{kind}:revoke',
    summary: '撤销某个 AI 凭证（停止使用，不删除历史）。',
    description:
      '把 `configured` 置为 false 并丢弃当前值，凭证从此不可用。这是 §7 选项 B（用户自带凭证）' +
      '必需的出口：没有它，一个填错的 PAT 只能被另一个值覆盖，用户无法**停用**它。' +
      '撤销是**幂等**的 —— 对已经未配置的种类再撤销一次同样返回 204，因为期望的效果已经成立，' +
      '把它报成错误会逼客户端先 GET 一次才能安全地撤销。`lastRotatedAt` 与内部代数**保留**：' +
      '"这个凭证上次被换掉是什么时候"在撤销之后仍然是一条为真的审计事实。' +
      '请求体只有一个可选注记，因此 `requestBody.required` 显式为 false。' +
      '部署注入的凭证映射 `SECRET_IMMUTABLE_REDEPLOY_REQUIRED`。',
    tags: ['settings'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      path: secretKindPathSchema,
      body: body(revokeSecretRequestSchema, '可选的操作注记。', false),
    },
    success: [noContent('已撤销，不回显。')],
    exclusiveErrorCodes: [
      'FORBIDDEN_CAPABILITY',
      'SECRET_KIND_UNSUPPORTED',
      'SECRET_IMMUTABLE_REDEPLOY_REQUIRED',
    ],
  },

  // ---- usage --------------------------------------------------------------
  {
    operationId: 'getUsageLimits',
    method: 'get',
    path: '/usage/limits',
    summary: '分页列出用量额度。',
    description:
      'Owner 视角；`subjectUserId` 缺省时由服务端按角色固定 scope。' +
      '`limitUnits = 0` 是合法值：额度为零只阻断新的 AI task，编辑、预览、发布已有版本、' +
      '批改与浏览都不受影响（附录 A §6.6）。',
    tags: ['usage'],
    security: SESSION_SECURITY,
    request: { query: getUsageLimitsQuerySchema },
    success: [json(200, '额度分页。', usageLimitPageSchema)],
    exclusiveErrorCodes: ['FORBIDDEN_CAPABILITY'],
  },
  {
    operationId: 'putUsageLimit',
    method: 'put',
    path: '/usage/limits',
    summary: '设置某个能力在某个周期的用量额度。',
    description:
      '整条设置的完整替换（所以是 PUT 不是 PATCH）：所有字段必填。' +
      '「仅当不存在时创建」由 `If-None-Match: *` 表达，不在 body 里加开关。' +
      '路径没有 `{id}`，因此不推导 `RESOURCE_NOT_FOUND`；并发冲突走 `REVISION_CONFLICT`。',
    tags: ['usage'],
    security: SESSION_WITH_CSRF_SECURITY,
    request: {
      header: usageLimitConditionalHeaderSchema,
      body: body(putUsageLimitRequestSchema, '额度设置。`timezone` 决定「每日」的边界。'),
    },
    success: [json(200, '写入后的额度。', usageLimitSchema, ['ETag'])],
    exclusiveErrorCodes: ['FORBIDDEN_CAPABILITY', 'REVISION_CONFLICT'],
  },
  {
    operationId: 'getUsageLedger',
    method: 'get',
    path: '/usage/ledger',
    summary: '分页导出用量账本（JSON 或 CSV）。',
    description:
      '同一条 operation 有两个 200 media type，由 `format` 选择（缺省 json）。' +
      'CSV 与 JSON 是**同一 allowlist 字段**，列名由 `LEDGER_CSV_COLUMNS` 从账本行 schema 派生，' +
      '所以加字段时两侧自动同步。分页区间与普通列表不同：1..500 默认 100（§5.5）。' +
      '账本追加写、不可变，因此没有 ETag，也没有条件读取。',
    tags: ['usage'],
    security: SESSION_SECURITY,
    request: { query: getUsageLedgerQuerySchema },
    success: [
      json(200, '账本分页（JSON）。', usageLedgerPageSchema),
      respond(
        200,
        '导出为 CSV（`format=csv`）：同一 allowlist 字段，响应体是一个 CSV 文本串。',
        CSV_MEDIA_TYPE,
        ledgerCsvSchema,
        ['Content-Disposition'],
      ),
    ],
    exclusiveErrorCodes: ['FORBIDDEN_CAPABILITY'],
  },

  // ---- platform -----------------------------------------------------------
  {
    operationId: 'getLicense',
    method: 'get',
    path: '/license',
    summary: '返回部署的版本、commit 与许可证。',
    description:
      '匿名接口（AGPL-3.0-only 的 §13 要求远程用户能取得源码，所以这条必须不需要登录）。' +
      '没有任何输入，也没有会话要求，因此它的错误码集合是**空的** —— ' +
      '`INTERNAL_ERROR` 与 `DEPENDENCY_UNAVAILABLE` 永不隐式挂载（§5.4）。' +
      '`commit` 只声明形状（40 位小写十六进制），快照里不出现任何真实 SHA。',
    tags: ['platform'],
    security: ANONYMOUS_SECURITY,
    success: [json(200, '部署信息与许可证。', licenseSchema)],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'getLiveHealth',
    method: 'get',
    path: '/health/live',
    summary: '存活探针。',
    description:
      '**不探测任何依赖**（§5.4）：进程能应答就是 ok。把数据库或 provider 探活放进 live 探针，' +
      '会让一次依赖抖动变成整个部署被重启。错误码集合同样为空。',
    tags: ['platform'],
    security: ANONYMOUS_SECURITY,
    success: [json(200, '进程存活。', liveHealthSchema)],
    exclusiveErrorCodes: [],
  },
  {
    operationId: 'getReadyHealth',
    method: 'get',
    path: '/health/ready',
    summary: '就绪探针。',
    description:
      '依赖不可用时返回 503 与统一错误 envelope，专属码 `DEPENDENCY_UNAVAILABLE`（它是本 registry 里' +
      '**唯一**显式声明这个码的地方 —— §5.4 规定它永不隐式挂载）。' +
      '不返回依赖的原始错误体，因此 200 分支只有 `status` 一个字段：多一个「哪个依赖挂了」' +
      '就是把内部拓扑暴露给匿名调用者。',
    tags: ['platform'],
    security: ANONYMOUS_SECURITY,
    success: [json(200, '依赖就绪。', readyHealthSchema)],
    exclusiveErrorCodes: ['DEPENDENCY_UNAVAILABLE'],
  },
];

/** 便于测试与生成器共用的只读索引。构造一次，避免 31 条记录被反复线性查找。 */
export const operationById: Readonly<Record<string, OperationContract>> = Object.fromEntries(
  operationRegistry.map((entry) => [entry.operationId, entry]),
);

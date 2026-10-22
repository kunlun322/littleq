/**
 * 本 UI 说的那套线上事实：路径、方法、状态码、枚举域与响应形状。
 *
 * ## 为什么要在这里重述一遍，而不是 import 契约包
 *
 * `config/dependency-graph.json` 的 `api-contract-no-platform-coupling` 规则**禁止**
 * `apps/web` 依赖契约包 —— 那条边一旦成立，浏览器产物就能顺着 zod schema 把服务端的
 * 校验规则、错误码表与安全判定一起打包进去。所以这里只抄**形状**，不抄实现。
 *
 * 代价是两份事实来源，因此本文件的每一个常量都写清它抄自哪里，并且
 * `apps/web/test/api-wire.test.ts` 会逐条比对：契约改了而这里没跟上，测试会红。
 * 这是把「重述」变成「有执法的重述」。
 *
 * ⚠️ 但那份比对**不是**靠 import 契约包做的 —— `inbound.default: deny` 对
 * `apps/web/test/**` 一样生效（实测：往那里加一行对 `@littleq/api-contract` 的 import，
 * `pnpm dep-graph` 立刻报 `api-contract-no-platform-coupling` 并退出 1）。所以测试是拿
 * `readFileSync` 把契约与 domain 的源文件**当文本**读出来，抽出 `export const` 的初始化式
 * 再逐个比，外加已提交的 OpenAPI 快照（`contracts/openapi/v1/openapi.json`）核路径、方法
 * 与状态码；正则也从文本里重建，于是契约自己的 ETag 形态规则会**真的**作用在本文件的
 * `toETag()` 输出上。这条路子比 import 弱一档（读的是源码文本，不是编译产物），但它不新增
 * 任何依赖边 —— 而依赖边正是那条规则要防的东西。
 *
 * ## 只抄四步闭环用到的那几条
 *
 * 契约里有 27 条操作；本切片只用到 login / createProject / getProject / createTurn /
 * pumpTask / createPreview 六条。抄全套等于替 F4（ZLQ-223）做它的活，也会让这里的
 * 漂移面变成 27 条而不是 6 条。
 */

/**
 * 浏览器侧一律走**同源**前缀。
 *
 * 抄自契约的 `SERVER_URL`。浏览器从不直连 API origin：`vercel.json` 的 CSP 是
 * `connect-src 'self'`，而 §3.3 明令「不加 API 域名，不放宽 CORS，禁止浏览器直连 API」。
 * 同源之所以成立，是因为 `app/api/[...path]/route.ts` 把这个前缀转发到配置中的单一目标。
 */
export const SERVER_URL = '/api/v1';

/**
 * `revision` 是**非负十进制字符串**，不是数字。
 *
 * 抄自契约的 `revisionSchema`（`.string().regex(...)`，注释写明「同时充当 ETag 的比较
 * 基准」）。这里刻意不给它一个 `number` 的便利形态：项目 revision 会随回合单调增长，
 * 而 `If-Match` 的比较必须是逐字的 —— 一旦在客户端把它 `Number()` 一次再 `String()`
 * 回去，前导零与超大值就会悄悄改变比较结果。
 */
export type Revision = string;

/** ETag 的线上形态：带引号的 `"rev-<revision>"`（抄自 `E_TAG_WIRE_PATTERN`）。 */
export function toETag(revision: Revision): string {
  return `"rev-${revision}"`;
}

/** 抄自 `packages/domain` 的 `AGE_BANDS`。三档，不多不少。 */
export const AGE_BANDS = ['L1', 'L2', 'L3'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/**
 * 抄自 `packages/domain` 的 `WORK_TYPES`，但本切片**只允许 `WEB`**。
 *
 * ZLQ-216 §8.1 的 `AGE_BANDS_LEAD` 写明「本次均从『开始创作』进入小网页创作，不提供
 * 独立的游戏、动画或绘本入口」。所以这里不导出四值的联合类型给 UI 用 —— 只导出一个
 * 常量，让「不能选别的」成为类型层面的事实，而不是一个被禁用的 `<option>`。
 */
export const ONLY_WORK_TYPE = 'WEB';

/** 抄自 `packages/domain` 的 `HELP_LEVELS`。 */
export const HELP_LEVELS = ['LV1', 'LV2', 'LV3'] as const;
export type HelpLevel = (typeof HELP_LEVELS)[number];

/** 抄自 `packages/domain` 的 `TASK_STATES`（15 个）。 */
export const TASK_STATES = [
  'QUEUED',
  'CLAIMED',
  'SESSION_CREATING',
  'RUNNING',
  'COLLECTING',
  'REPAIRING',
  'VALIDATING',
  'COMMITTING',
  'RETRY_WAIT',
  'CANCELLING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * 抄自 `packages/domain` 的 `TERMINAL_TASK_STATES`（5 个）。
 *
 * 工作台靠它决定「还要不要继续 pump」。这五个是**唯一**的停止条件；把 `RETRY_WAIT`
 * 误当终态会让回合在退避里被放弃，把 `CANCELLING` 误当终态会让取消动作看起来像失败。
 */
export const TERMINAL_TASK_STATES = [
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'TIMED_OUT',
] as const;

/** 抄自 `packages/domain` 的 `TASK_PUMP_OUTCOMES`（5 个）。 */
export const TASK_PUMP_OUTCOMES = [
  'ADVANCED',
  'COALESCED_IN_FLIGHT',
  'NO_OP_WAITING',
  'NO_OP_CANCELLING',
  'NO_OP_TERMINAL',
] as const;
export type TaskPumpOutcome = (typeof TASK_PUMP_OUTCOMES)[number];

/**
 * pump 之后**继续**推进的两种结果。
 *
 * `ADVANCED` 是「做完了一个有界切片并提交了新 revision」；`COALESCED_IN_FLIGHT` 是
 * 「单飞合并 —— 别人正在推进，你这一次什么也没做」。契约注释明确写着前端轮询与多标签页
 * 都会落到后者，所以它**不是**错误。把这两种之外的三个 `NO_OP_*` 也当成「继续」，
 * 就会在退避窗口里空转打服务端。
 */
export const PUMP_OUTCOMES_THAT_CONTINUE: readonly TaskPumpOutcome[] = [
  'ADVANCED',
  'COALESCED_IN_FLIGHT',
];

/** 错误信封（抄自 `errorEnvelopeSchema`）。四个键都在，`traceId` 可为 null。 */
export type ErrorEnvelope = {
  code: string;
  messageKey: string;
  retryable: boolean;
  traceId: string | null;
};

/** 项目读模型（抄自 `projectSchema` 的 13 个字段）。 */
export type Project = {
  id: string;
  ownerStudentId: string;
  title: string;
  workType: string;
  ageBand: AgeBand;
  helpLevel: HelpLevel;
  templateId: string | null;
  currentVersionId: string | null;
  status: string;
  lastOpenedAt: string | null;
  revision: Revision;
  createdAt: string;
  updatedAt: string;
};

/**
 * 项目的不可变版本（抄自 `projectVersionSchema`）。
 *
 * ⚠️ **这里没有任何「AI 回复正文」字段** —— 契约刻意不给：版本只有内容摘要
 * （`artifactSha256`）与规模（`fileCount` / `totalBytes`），作品本体留在 infra 的对象
 * 存储里，通过 `createPreview` 签发的短期独立源地址查看。所以工作台第 4 步「看到回复」
 * 呈现的是**这次生成的真实事实**（第几版、多少文件、构建与脱敏扫描结果）加上一个可打开
 * 的预览地址，而不是一个聊天气泡 —— 后者会把这个产品的形状画错。
 */
export type ProjectVersion = {
  id: string;
  projectId: string;
  sequence: number;
  parentVersionId: string | null;
  sourceTaskId: string | null;
  artifactSha256: string;
  contractVersion: number;
  fileCount: number;
  totalBytes: number;
  buildStatus: string;
  scanStatus: string;
  safeScanSummary: {
    blockedCount: number;
    warningCount: number;
    confirmRequiredCount: number;
    reportRef: string | null;
    scannedAt: string;
  } | null;
  createdBy: string;
  createdAt: string;
};

/** 任务读模型（抄自 `taskSchema`）。 */
export type Task = {
  id: string;
  kind: string;
  projectId: string;
  state: TaskState;
  stage: string | null;
  progress: number;
  attempt: number;
  maxAttempts: number;
  nextRunAt: string | null;
  cancelRequestedAt: string | null;
  softDeadlineAt: string | null;
  hardDeadlineAt: string | null;
  resultVersionId: string | null;
  error: ErrorEnvelope | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  revision: Revision;
};

/** `GET /projects/{id}` 的聚合响应（抄自 `getProjectResponseSchema`）。 */
export type GetProjectResponse = {
  project: Project;
  currentVersion: ProjectVersion | null;
  activeTask: Task | null;
};

/** `POST /projects/{id}/turns` 的 202 响应（抄自 `taskAcceptedSchema`）。 */
export type TaskAccepted = { taskId: string; revision: Revision };

/** `POST /tasks/{id}:pump` 的 200 响应（抄自 `taskPumpResultSchema`）。 */
export type TaskPumpResult = {
  taskId: string;
  outcome: TaskPumpOutcome;
  task: Task;
};

/** `POST /projects/{id}/preview` 的 200 响应（抄自 `createPreviewResponseSchema`）。 */
export type CreatePreviewResponse = {
  /** 短期、独立源地址。契约只声明它是 ≤512 字符的串，不给示例值、不声明签名方案。 */
  url: string;
  expiresAt: string;
  versionId: string;
};

/** 六条用到的路径。全部以 `SERVER_URL` 打头，浏览器侧一律同源。 */
export const PATHS = {
  login: `${SERVER_URL}/auth/login`,
  projects: `${SERVER_URL}/projects`,
  project: (id: string) => `${SERVER_URL}/projects/${encodeURIComponent(id)}`,
  turns: (id: string) => `${SERVER_URL}/projects/${encodeURIComponent(id)}/turns`,
  pump: (id: string) => `${SERVER_URL}/tasks/${encodeURIComponent(id)}:pump`,
  preview: (id: string) => `${SERVER_URL}/projects/${encodeURIComponent(id)}/preview`,
} as const;

/** 每条路径的成功状态码。写死在这里，是为了让 UI 不把「任何 2xx」都当成功。 */
export const EXPECTED_STATUS = {
  login: 204,
  createProject: 201,
  getProject: 200,
  createTurn: 202,
  pumpTask: 200,
  createPreview: 200,
} as const;

/**
 * 幂等键的线上形态（抄自 `IDEMPOTENCY_KEY_WIRE_PATTERN`：`^[A-Za-z0-9._:-]+$`，长 16–128）。
 *
 * `crypto.randomUUID()` 的 36 个字符全落在这个字符集里（连字符是允许的），长度也在区间内，
 * 所以直接用它 —— 不需要自己造一个随机源。
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

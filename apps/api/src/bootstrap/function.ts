/**
 * 形态 B 的 **Vercel 函数入口** —— 把 `bootstrap/vercel.ts` 那个装配根接到平台的请求循环上。
 *
 * 分工是刻意的：`vercel.ts` 负责「一个进程怎么装配出一个容器」，本文件只负责「一次 HTTP
 * 调用怎么拿到那个容器、拿不到时回什么」。装配顺序、驱动选择、自检预算、degraded 语义
 * 全部留在那边，这里一行都不重复 —— 重复一遍就有了第二个事实源。
 *
 * ## 为什么入口在这里，而平台函数文件只有一行
 *
 * Vercel 的 Node runtime 从**项目根**的 `api/` 目录发现函数（裁定一把本项目的
 * Root Directory 定成 `apps/api`，所以是 `apps/api/api/v1/[...path].js`，服务
 * `/api/v1/*`）。而 `apps/api/tsconfig.json` 是 `rootDir: "src"` + `include: ["src"]`
 * —— 把 `.ts` 直接放进 `api/` 就落在这两行之外，既不被 `tsc -b` 编译，也不被
 * `pnpm typecheck` 看见。所以真正的实现放在**这里**（受编译、受测试），`api/` 下那份
 * 只是一个 re-export，并被 `test/function-entry.test.ts` 逐字节钉住（带阳性对照）。
 *
 * ## ⚠️ 申报：Vercel 配置文件的位置偏离了设计 §1 line 51
 *
 * §1 那一行给的答案是生成 `deploy/b/main.vercel.json`（「项目根分别 `apps/web`、
 * `apps/runtime`；API 构建保留 `apps/api` handler 边界」）。本轮**没有**生成它，而是落了
 * `apps/api/vercel.json`。理由：
 *
 * 1. 用户裁定一（2026-10-23）把拓扑改成了「后端**单独**一个 Vercel 项目，同一个 GitHub
 *    仓库，Root Directory = `apps/api`；现有 `littleq` 项目继续只服务 `apps/web`」。
 *    Vercel 只从**项目自己的 Root Directory** 读 `vercel.json`，于是配置的正确位置就是
 *    `apps/api/vercel.json`。
 * 2. `deploy/b/main.vercel.json` 的前提是「一个项目、根在 `apps/web`、用 `builds` 把
 *    `apps/api` 的 handler 挂进去」。在新拓扑下那份文件没有归宿：没有任何 Vercel 项目
 *    的 Root Directory 是 `deploy/b`，`deploy/` 这个目录在仓库里也根本不存在。
 * 3. 仓库根**没有**、也仍然不会有第二份 Vercel 入口（`apps/web/next.config.ts:39-40`
 *    那条约束）；`apps/web/vercel.json` 本轮逐字节未动。
 *
 * ⇒ 这是**已申报的偏离**，不是设计本意。PM 在发布时裁定；若裁定回到 §1 line 51，
 *    要改的是本文件头这段、`apps/api/vercel.json` 的位置，以及 `api/` 那份 re-export 的
 *    相对路径，**不需要**动装配根。
 *
 * ## `apps/api/vercel.json` 逐键的理由（JSON 写不了注释，所以记在这里）
 *
 * - `"framework": null`：本项目不是 Next/Vite/…，只有 `api/` 下的 Node 函数。不写这一键，
 *   Vercel 会去猜框架；猜错的表现是构建命令与产物目录一起跑偏，而那种失败只在平台上复现。
 * - `"installCommand": "pnpm install --frozen-lockfile"`：与 `.github/workflows/ci.yml:108`
 *   逐字一致。锁文件与 `package.json` 不一致时**失败**，而不是重新解析出一套与 CI 不同的
 *   依赖树。
 * - `"buildCommand": "pnpm --filter @littleq/api... build"`：尾部三个点是 pnpm 的
 *   「本包 + 它的工作区依赖」。必须显式写：函数入口 re-export 的是 `dist/bootstrap/function.js`，
 *   而它 import 的 `@littleq/domain` 等一律解析到各包的 `dist/index.js`（各包 `exports` 的
 *   既有约定）⇒ **所有**被依赖的包都得先编译出来。默认的「跑 Root Directory 的 `build`
 *   脚本」只有 `tsc -b`，靠项目引用去连带编译；那条路能不能在一个以 `apps/api` 为 cwd 的
 *   构建容器里走通，本轮无法验证，所以不用它。
 * - `"outputDirectory": null`：**没有**静态产物，显式说清楚。留空让平台去推，推出来的
 *   默认值就是 Root Directory 本身 —— 那等于把 `apps/api/src/**` 当静态文件上传成公开可读，
 *   这是本键存在的全部理由。
 *
 * ⚠️ 不在 `vercel.json` 里、只能在**项目设置**里给的两样：Root Directory = `apps/api`，
 * 以及 Node.js 24.x（`apps/api/package.json` 的 `engines.node` 与仓库根同值，Vercel 会读它；
 * 若平台忽略，则必须在设置里手选）。7 个 Sensitive 变量按裁定一由用户在平台界面里录，
 * **绝不许打进聊天室**。`LQ_API_ORIGIN` 属于 `apps/web` 那个项目，不在本轮范围。
 *
 * ## ⚠️ 申报：本入口**不注入** provider 那条腿 ⇒ 线上 AI 路径是 degraded 的
 *
 * `vercel.ts` 文件头缺口 1 已经写明：§3.1 没有登记 `createTurnProviderClient` 要的
 * `baseUrl` / `identityId` / `templateId`，`.env.example` 规则 5 又禁止先造变量名。
 * 本入口**遵守**那条约束，所以什么都不注入 —— 于是容器按 D-2 装配一个失败关闭的
 * provider，AI 任务路径一律以 `INTERNAL_ERROR`（§5.4 已冻结的码）拒。
 *
 * 这不是"忘了接"，而是本轮范围之外的东西没有可接的接口。登录、存凭据、页面打到后端
 * 都不经过这条腿。**本轮不含 AI 真回话。**
 *
 * ## ⚠️ 申报：`sessionTtl` / `workerId` / `secureCookies` 的值是本文件的具名常量，不是裁定
 *
 * `vercel.ts` 文件头缺口 2 逐字：这三项「同样没有 §3.1 登记名，同样只能显式注入」，
 * 而且明确说了「从 `platformEnv` 推 `secureCookies` 看着很方便，但那是**发明一条配置
 * 规则**，与发明一个变量名是同一件事」。进程入口又必须有值才能装配。三条约束叠起来，
 * 剩下的唯一合法动作是：**在一处给出值、写明它是待裁的、并让测试钉住它没有被悄悄改动。**
 *
 * - {@link PROCESS_SESSION_TTL}：仓库里明确写着「产品数值刻意由配置注入、domain 不硬编码
 *   默认值」（`apps/api/test/turn-to-task-to-safe-event.test.ts:114`、
 *   `packages/domain/test/session.test.ts:56`）。所以这四个数字**没有**产品默认值可抄。
 *   这里取的是 `apps/api` 两处已有装配（`test/bootstrap-container.test.ts:105`、
 *   `test/turn-to-task-to-safe-event.test.ts:122`）**已经在用**的同一组值 —— 不是我另选的。
 *   ⚠️ 待架构师裁定：它是否该成为 §3.1 的登记项（登记 ⇒ 按 `.env.example` 规则 5 走，
 *   先登记再进 schema 再落占位）。
 * - {@link PROCESS_SECURE_COOKIES} = `true`：形态 B 按定义跑在 Vercel 的 TLS 之后，
 *   会话 Cookie 不带 `Secure` 是一次真实的降级。本地跑用的是 `container.listen()`
 *   那条路，调用方自己传 `false`，与本常量无关。
 * - `workerId`：由 {@link createFunctionHandler} 在**进程内生成一次**。它是任务租约的
 *   持有者标识（§3.5 `TaskRepository.claim({workerId,…})`，`http.ts:603` 把它交给
 *   `pumpTaskUseCase`）。一个 serverless 实例就是一个 worker，所以"每进程唯一"是语义
 *   正确的那一侧；写成固定字符串会让多个实例以同一身份抢租约，独占性当场失效。
 *
 * ## 🚨 红线：装配失败时值不落日志、不落响应体（§2.2）
 *
 * §2.2 逐字：「原始异常只在驱动边界转固定码，**禁止 body/SQL 参数/connection URL 落
 * 日志**」。装配失败发生在读环境变量的那一刻，异常里最可能含的正是连接串与主密钥。所以：
 *
 * - 响应体永远是 §5.4 那 42 码里已有的 `INTERNAL_ERROR` 信封（`{code, messageKey,
 *   retryable, traceId}`），与 `http.ts` 的兜底同一形状、同一理由 —— **不新增错误码**。
 * - 日志只打 `error.name`，以及**构造上不可能含值**的那两类错误的固定码：
 *   `BootstrapConfigError.code` 与 `InfraError.code` 都是封闭的字面量联合（判定与
 *   `bootstrap/migrate.ts:235-241` 同一条，只是那边打的是 `.message` —— 本文件连
 *   `message` 都不打，理由写在 {@link sendBootstrapFailure} 里）。
 *
 * ## 记忆化：冷启动只装配一次
 *
 * 本文件调 {@link getFormBContainer}（`vercel.ts` 的模块级记忆化出口），**绝不调**
 * `createFormBContainer`、也**绝不调** `resetFormBContainer`：前者会让每次请求都新建一个
 * 连接池，后者会把记忆擦掉，两者都直接违反 §2.1「缓存已初始化的 DI 容器」。记忆化本身
 * 由 `test/bootstrap-container.test.ts` 的「同一个进程里两次拿到的是同一个容器」与
 * 「装配失败**不**污染记忆」两条证明；本文件的义务是**不绕过它**，那由
 * `test/function-entry.test.ts` 的源码级守卫钉住（带阳性对照）。
 *
 * ## ⚠️ 未经真实平台验证
 *
 * 本轮没有创建 Vercel 项目、没有部署、没有发起任何计费动作（新项目由用户建，
 * `LQ_API_ORIGIN` 属于 `apps/web`、不在本轮范围）。因此下面两件事是**源码级**结论，
 * 不是线上实测：`@vercel/node` 会等 `res.end()` 再结束调用（本入口把 `container.handler`
 * 这个 `node:http` 监听器直接交出去，`dispatch` 是 fire-and-forget 的）；以及 nft 会顺着
 * 那行 re-export 把 `dist/**` 与工作区包的 `dist/**` 一并打进函数包。首次真实部署的结论
 * 以线上为准。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { JSON_MEDIA_TYPE } from '@littleq/api-contract';
import type { RandomSource } from '@littleq/application';
import { errorDefinition, httpStatusOf, parseSessionTtlPolicy } from '@littleq/domain';
import { isInfraError } from '@littleq/infra';
// ⚠️ 子路径导入，不是桶导入。桶里刻意只给**类型**（那个 barrel 的文件头写明原因：
// re-export `createWorkScanner` 会把 acorn / parse5 / postcss 拖进浏览器产物）。
// 本文件是**服务端**进程入口，正该走 `./scan` 这个 `node` 条件的子路径。
// 真实 Node 解析得到（实测 `Object.keys(await import('@littleq/work-contract/scan'))`
// 含 `createWorkScanner`）；vitest 解析不到，因为 `tools/esbuild-config.mjs` 的别名表
// 把 `@littleq/work-contract` 映射到 `src/index.ts` 这个**文件**，子路径拼不上 ——
// 所以 `vitest.config.ts` 单独补了一条子路径别名（只影响测试解析，不影响 bundle）。
import { createWorkScanner } from '@littleq/work-contract/scan';

import { errorEnvelopeDto } from '../server/dto.js';
import { nodeRandomSource } from '../server/random.js';

import { BootstrapConfigError, type EnvSource } from './config.js';
import { getFormBContainer, type FormBBootstrapInputs } from './vercel.js';

/**
 * 会话 TTL（申报见文件头）。四个数字**只此一处**，改它就是在改产品策略，
 * `test/function-entry.test.ts` 会让这个动作在 CI 上被看见。
 */
export const PROCESS_SESSION_TTL = parseSessionTtlPolicy({
  idleMinutes: 30,
  absoluteMinutes: 120,
  rememberMeIdleMinutes: 720,
  rememberMeAbsoluteMinutes: 4320,
});

/** 形态 B 跑在 TLS 之后 ⇒ 会话 Cookie 必须带 `Secure`（申报见文件头）。 */
export const PROCESS_SECURE_COOKIES = true;

/** 本文件唯一允许的日志出口；默认 stderr。测试注入一个数组来断言它没打出值。 */
export type FunctionHandlerLog = (line: string) => void;

export interface FunctionHandlerOptions {
  readonly env?: EnvSource;
  readonly random?: RandomSource;
  readonly log?: FunctionHandlerLog;
}

/**
 * 装配 `getFormBContainer` 要的输入。
 *
 * `provider` / `providerConfiguration` / `scanConfiguration` **一个都不给**：前两者没有
 * §3.1 登记名（文件头申报），后者留空即 `vercel.ts` 缺口 4 那个设计好的失败关闭 `null`。
 */
function buildProcessInputs(env: EnvSource, workerId: string): FormBBootstrapInputs {
  return {
    env,
    sessionTtl: PROCESS_SESSION_TTL,
    workerId,
    secureCookies: PROCESS_SECURE_COOKIES,
    scanner: createWorkScanner(),
  };
}

/**
 * 装配失败时的响应：§5.4 已冻结的 `INTERNAL_ERROR` 信封，与 `http.ts:724-732` 的兜底
 * 同形同码。`traceId` 由本进程生成，客户端拿它去对日志。
 */
function sendBootstrapFailure(
  res: ServerResponse,
  traceId: string,
  error: unknown,
  log: FunctionHandlerLog,
): void {
  const definition = errorDefinition('INTERNAL_ERROR');
  // 只打 name + **固定码**。这两类的码都是封闭的字面量联合，构造上不含调用方数据：
  // `BootstrapConfigError.code ∈ BootstrapConfigCode`、`InfraError.code ∈ InfraErrorCode`。
  // 连 `.message` 都不打 —— 它虽然按构造只含变量名/码本身，但"按构造"是 `config.ts` 与
  // `packages/infra/src/errors.ts` 的承诺，不是本文件能担保的事实（文件头「红线」）。
  //
  // ⚠️ 取 `InfraError.code` 而**不是** `publicCode`：后者是把内部码收敛进那 42 个公开码的
  // 结果，`MASTER_KEY_UNAVAILABLE` 在它那里一律变成 `INTERNAL_ERROR` —— 日志就只剩"出错了"。
  // 内部码是给运维看的那一半（拿它去 `.env.example` 对变量名），公开码是给客户端的那一半
  // （响应体永远是它，见下）。两者分工不同，不是二选一。
  const fixedCode =
    error instanceof BootstrapConfigError
      ? error.code
      : isInfraError(error)
        ? error.code
        : null;
  log(
    `apps/api 装配失败（HTTP 500 ${definition.messageKey}）：` +
      `${nameOf(error)}${fixedCode === null ? '' : ` ${fixedCode}`}`,
  );
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(
    errorEnvelopeDto({
      code: 'INTERNAL_ERROR',
      messageKey: definition.messageKey,
      retryable: definition.retryable,
      traceId,
    }),
  );
  res.writeHead(httpStatusOf('INTERNAL_ERROR'), {
    'content-type': `${JSON_MEDIA_TYPE}; charset=utf-8`,
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** `error.name` 拿不到时退到构造函数名；两者都不含调用方数据。 */
function nameOf(error: unknown): string {
  if (error instanceof Error && error.name !== '') return error.name;
  return typeof error === 'object' && error !== null ? 'Object' : typeof error;
}

/**
 * 造 Vercel 函数处理器。
 *
 * 参数化是为了让"日志里有没有漏值"这件事可测（`spyProcessOutput` 抓不到注入进来的
 * `log`，而这条红线恰恰要有阳性对照）。生产走下面那个 `export default`。
 */
export function createFunctionHandler(
  options: FunctionHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const env = options.env ?? process.env;
  const random = options.random ?? nodeRandomSource();
  const log = options.log ?? ((line: string) => console.error(line));
  // 进程内一次。它是租约持有者标识，每请求换一个会让独占性失效（文件头申报）。
  const workerId = random.uuidV7();
  return async (req, res) => {
    const traceId = random.uuidV7();
    try {
      const container = await getFormBContainer(buildProcessInputs(env, workerId));
      container.handler(req, res);
    } catch (error) {
      sendBootstrapFailure(res, traceId, error, log);
    }
  };
}

export default createFunctionHandler();

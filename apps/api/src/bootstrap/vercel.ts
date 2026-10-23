/**
 * 形态 B（Vercel 主站 API）的**进程入口与装配根** —— ZLQ-157 §2.1 组合根表里那一行：
 *
 * > | B 主站 API/cron | `apps/api/src/bootstrap/vercel.ts` | 缓存已初始化的 DI 容器；每次请求新事务，无长驻轮询 |
 *
 * 三个承诺各自怎么落地：
 *
 * - **「缓存已初始化的 DI 容器」** ⇒ {@link getFormBContainer}：模块级记忆化，一个进程只装配一次。
 *   Serverless 实例复用同一个 isolate，冷启动才重新装配；失败的记忆会被清掉，于是
 *   「配置修好后重试」不需要重启实例。
 * - **「每次请求新事务」** ⇒ 不由本文件实现，而是继承来的：`PostgresDatabaseAdapter.transaction`
 *   每次都 `source.connect()` 签出一条连接、`BEGIN`…`COMMIT`（`sql/postgres-adapter.ts:73`）。
 *   本文件的责任是**不给它套任何跨请求的事务或缓存**。
 * - **「无长驻轮询」** ⇒ 本文件里没有 `setInterval`，没有循环拉取，没有后台定时器续命。
 *   任务推进（pump / drain）在形态 B 是 Vercel Cron 触发的**独立** handler（§5.2、§5.5），
 *   不是这个进程里的一个循环。`test/bootstrap-container.test.ts` 用源码文本断言了这一点，
 *   并且带阳性对照（同一份文本里必须能找到 `createNeonClientSource`），
 *   免得「0 命中」是因为读错了文件。
 *
 * ## 装配顺序逐字来自 §2.1
 *
 * > 读取部署形态/可信平台标识 → Zod 校验基础配置 → 形态允许组合校验 → 创建
 * > DB/对象/secret/publisher → 自检 → 注册 application services → HTTP/worker 接入。
 *
 * 前三步在 `bootstrap/config.ts`（{@link resolveFormBConfig}），本文件从第四步开始，
 * 并且**按这个次序**：DB → 对象 → secret → 自检（{@link FormBContainer.probeNow}）
 * → application services（`composeApiServices`）→ HTTP（`createApiHandler`）。
 * 顺序不是风格问题：secret store 要 DB 先建好，`composeApiServices` 要前面全部建好。
 *
 * ⚠️ 但**自检失败不等于装配失败**，这一点也是 §2.1 逐字规定的：「首启诊断/领取服务
 * 不能被尚未完成的业务ready检查锁死…Runtime地址、SOURCE_CODE_URL或F1业务设置待补时，
 * 进程仍live并仅开放受领取票据保护的setup与诊断」。致命的只有「未知driver、生产/preview
 * 混绑、密钥格式错误」三类，它们在前三步与 `loadMasterKey` 里就已经抛出去了；
 * DB 连不上属于"待补"，装配继续，结果记在 {@link FormBContainer.bootSelfCheckOk}，
 * `ready` 每次请求重跑同一份探针（§2.1「setup写完后重新运行ready…不以重启补配置」）。
 * 完整引文与推理在 {@link createFormBContainer} 第 5 步那里。
 *
 * `publisher` 那一项**没有**落地，见下面「申报的缺口」第 3 条。
 *
 * ## 🚨 两条驱动不许搞反（§5.4）
 *
 * | 用途 | 工厂 | 连接串来源 | 传输 |
 * | --- | --- | --- | --- |
 * | **运行**（本文件） | `createNeonClientSource` | `DATABASE_URL`，或 `LITTLEQ_DATABASE_URL`（见 config.ts 的命名冲突申报） | Neon **pooled**，WebSocket `Pool` |
 * | **迁移**（`bootstrap/migrate.ts`） | `createPgClientSource` | `DATABASE_DIRECT_URL` | Neon **direct**，`pg` TCP |
 *
 * 为什么运行侧必须是 Neon 的 `Pool` 而不是 `neon()`：`sources.ts` 的文件头写明
 * 「§3.4 的六个边界里有四个是「短事务 + CAS」，HTTP driver 一次只能发一条语句、没有事务，
 * `createTurn` 的「锁 project → 查 Idempotency-Key → INSERT task/private/reservation →
 * CAS project」在它上面根本无法表达成原子操作」。本文件**不**自己写驱动、也**不**在两个
 * 工厂之间做「哪个能连上用哪个」的 fallback —— §2.1 逐字：「选中未发布驱动返回
 * `DRIVER_NOT_RELEASED`，不能 fallback 偷换驱动」。
 *
 * ⚠️ `@neondatabase/serverless@1.2.0` 的行为是**源码级核对**，不是真实连接的结果：
 * 本轮没有任何一次对 Neon 的真实连接（凭证在 Vercel 侧标了 Sensitive，读不回来；
 * 也不发起计费动作）。首次真实连接的结论以线上为准。
 *
 * ## 🚨 红线：值不落日志、不落错误消息
 *
 * §2.2 逐字：「原始异常只在驱动边界转固定码，**禁止 body/SQL 参数/connection URL 落日志**」。
 * 本文件里唯一持有连接串的是 {@link createFormBContainer} 的一个局部常量，它只被交给
 * `createNeonClientSource`，从不进 `Error.message`、从不 `console.*`。失败一律以
 * `BootstrapConfigError` 的固定码 + 变量名出去。
 *
 * ## ⚠️ 申报的缺口（都不是本文件能就地补的）
 *
 * 1. **provider 那条腿无法从环境变量装配 —— 缺它现在走 degraded，不抛。**
 *    §3.1 只登记了 `QCA_AGENT_ID` / `QCA_AGENT_VERSION` / `QCA_ENVIRONMENT_ID`，而且写明
 *    它们「F1完成后由运行期 QcaService幂等创建/选资源并持久化」—— 仓库里**没有**
 *    `QcaService`。`createTurnProviderClient` 要的 `baseUrl` / `identityId` / `templateId`
 *    一个都没登记。`.env.example` 规则 5 禁止反过来先造名字（「新变量必须先在 ZLQ-157 的
 *    清单里登记，再进 schema，再落一行占位」），所以这条腿只能由启动方显式注入。
 *
 *    缺注入时 {@link createFormBContainer} 装配 {@link createFailClosedProvider}：一个
 *    **真的** `TurnProviderClient`，四个方法一律抛 `DomainError('INTERNAL_ERROR')`。
 *    这与 `server/scan.ts` 的 `createScanInputAssembler({ configuration: null })` 是同一个
 *    形状（那边也是"对象照常给，方法失败关闭"），也满足 §8.1「AI未配置是功能degraded
 *    不是整体503」。**它不是占位 provider**：占位的定义是"假装能用"（返回一个编造的
 *    session、一段写死的回复），而这个恰恰相反 —— 它唯一能做的事就是失败，且失败用的是
 *    §5.4 已冻结的码，没有新增任何错误码。
 *
 *    ⚠️ 这是本文件对旧行为的一次**明示改动**：原先缺腿抛
 *    `PROVIDER_CONFIG_UNREGISTERED`，那个码已从 `config.ts` 的 `BootstrapConfigCode` 里
 *    删掉。理由是抛它会把 §2.1 逐字保护的东西一起锁死：「首启诊断/领取服务不能被尚未
 *    完成的业务ready检查锁死…进程仍live并仅开放受领取票据保护的setup与诊断」。
 *    `PUT /settings/secrets/{kind}` 就是那条 setup 路径 —— 装配抛了它，用户就存不进
 *    凭据，F4 自己的验收判据当场不成立。
 * 2. `sessionTtl` / `workerId` / `secureCookies` 同样没有 §3.1 登记名，同样只能显式注入。
 *    从 `platformEnv` 推 `secureCookies` 看着很方便，但那是**发明一条配置规则**，
 *    与发明一个变量名是同一件事。
 * 3. **`publisher` 未装配。** §2.1 的第四步点名了它，而 `apps/api` 现有的
 *    `createObjectStores()` 是**进程内**存储：形态 B 上跨调用不持久。infra 里有
 *    `drivers/vercel-blob.ts`，接它要给 `apps/api` 加 `@vercel/blob` 这个生产依赖，
 *    那会动 `tools/test/license-policy.test.mjs` 钉住的生产闭包表（治理事件，不是日常维护）。
 *    本文件如实接现有的进程内实现，并在这里申报，而不是悄悄换驱动。
 * 4. **`scanConfiguration` 默认 `null`**，这是 `scan.ts` 设计好的「未配置」值：
 *    `assemble` 会抛 `INTERNAL_ERROR`（§5.4 的 42 码冻结，不能新增），任务停在 `SCANNING`
 *    之前，**不会**出现「未扫描的产物被固化成新版本」。§8.1 也写明
 *    「AI未配置是功能degraded不是整体503」，所以它不影响 ready。
 * 5. **§8.1 的 2500ms 总预算落在这里，不在 `http.ts`。** `getReadyHealth` 只调
 *    `services.probeDependencies()` 并把一切失败收成 `DEPENDENCY_UNAVAILABLE`；
 *    预算与并行检查由本文件注入的那份 `probeDependencies` 实现（{@link READY_BUDGET_MS}）。
 *    改 `http.ts` 会动到已验收的传输层，没有必要。
 * 6. **§5.4 的「10秒取锁超时返回 `MIGRATION_LOCKED`」未实现。**
 *    `PostgresDatabaseAdapter.migrate()` 用的是阻塞式 `pg_advisory_xact_lock`。
 *    改它要动 `packages/infra`，不在本单文件面内。
 * 7. **扫描器（`WorkScanner`）不由本文件造，`scanner` 是必填注入项。**
 *    桶导出刻意只给类型（那个 barrel 的文件头写明原因：re-export `createWorkScanner`
 *    会把 acorn / parse5 / postcss 拖进浏览器产物），运行时值在 `./scan` 子路径上。
 *    ⚠️ 本轮**更正**了旧版这里的一条错判：子路径并非"从 `apps/api` 解析不到"。实测从
 *    `apps/api` 目录 `await import('@littleq/work-contract/scan')` 解析得到，导出含
 *    `createWorkScanner`；解析不到的只有 **vitest**，因为共享别名表把
 *    `@littleq/work-contract` 映射到 `src/index.ts` 这个**文件**，子路径拼不上
 *    ⇒ `vitest.config.ts` 单独补了一条子路径别名（只影响测试解析，不进 bundle）。
 *    装配根仍然不自己造扫描器：造它的那一行属于**进程入口**（`bootstrap/function.ts`），
 *    放在这里会让"装配"与"选运行时实现"混成一层。本文件**不编一个假扫描器**。
 * 8. **🚨 部署它的那个 Vercel 项目还不存在；本轮没有创建、没有部署、没有任何计费动作。**
 *    本轮交付的是让部署成为可能的三样东西，以及一份申报：
 *    - `bootstrap/function.ts`：真的函数处理器（读环境变量、注入四条腿、装配失败回
 *      §5.4 冻结的 `INTERNAL_ERROR` 信封），`export default` 一个 `(req, res)` 处理器。
 *    - `apps/api/api/v1/[...path].js`：平台函数文件，一行 re-export 到
 *      `dist/bootstrap/function.js` ⇒ 零配置发现即服务 `/api/v1/*`（与 `http.ts:118` 的
 *      `API_PREFIX`、`apps/web/src/api-proxy.ts:40` 的 `FORWARDED_PREFIX` 逐字对齐）。
 *    - `apps/api/vercel.json`：`framework: null` / 与 CI 逐字一致的 install /
 *      `pnpm --filter @littleq/api... build` / `outputDirectory: null`（**安全相关**：
 *      留空让平台去推，推出来的是 Root Directory 本身，等于把 `apps/api/src/**`
 *      上传成公开可读）。
 *
 *    ⚠️ 配置落 `apps/api/vercel.json` 是对 §1 line 51（生成 `deploy/b/main.vercel.json`）
 *    的**已申报偏离**，理由与"若裁回原位要改哪三处"都写在 `function.ts` 的文件头。
 *    它成立的前提是用户裁定一（2026-10-23）把拓扑改成了「后端**单独**一个 Vercel 项目、
 *    同一个 GitHub 仓库、Root Directory = `apps/api`；现有 `littleq` 项目继续只服务
 *    `apps/web`」—— Vercel 只从**项目自己的 Root Directory** 读 `vercel.json`。
 *    仓库根**没有**、也仍然不会有第二份 Vercel 入口（`apps/web/next.config.ts:39-40`
 *    那条约束；`apps/api/test/function-entry.test.ts` 用一次全仓遍历钉住"只有两份"）。
 *
 *    ⇒ 剩下的三件事只能由用户在**平台界面**里做，本文件够不着：建项目并设
 *    Root Directory = `apps/api`；选 Node.js 24.x（`apps/api/package.json` 的
 *    `engines.node` 与仓库根同值，平台若忽略这个区间就得手选）；录那 7 个 Sensitive
 *    变量（**绝不许打进聊天室**）。`LQ_API_ORIGIN` 属于 `apps/web` 那个项目，不在本轮范围。
 *    在那之前，本文件的可达性是「本地能起、迁移能跑通、函数处理器能真的接住 HTTP」，
 *    **不含**线上实测。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { PasswordHasher, RandomSource, TurnProviderClient } from '@littleq/application';
import {
  DomainError,
  parseTimestamp,
  type SessionTtlPolicy,
  type Timestamp,
} from '@littleq/domain';
import {
  EncryptedSecretStore,
  PostgresDatabaseAdapter,
  PostgresSecretRecordStore,
  PostgresTaskPumpStore,
  PostgresTaskUnitOfWork,
  createNeonClientSource,
  loadMasterKey,
  type DatabaseAdapter,
} from '@littleq/infra';
// ⚠️ 只取**类型**。`createWorkScanner` 这个值在 `@littleq/work-contract` 的桶里
// 是刻意不 re-export 的（那个 barrel 的文件头逐字写着原因：会把 acorn / parse5 /
// postcss 拖进浏览器产物）；它的运行时入口是 `./scan` 子路径。
//
// ⚠️ 本轮**更正**了这里旧版的一条错判：子路径不是"从 apps/api 解析不到"。实测从
// `apps/api` 目录 `await import('@littleq/work-contract/scan')` 解析得到，导出含
// `createWorkScanner` 与 `scanPackage`。解析不到的只有 vitest —— 共享别名表把
// `@littleq/work-contract` 映射到 `src/index.ts` 这个**文件**，子路径拼不上；
// `vitest.config.ts` 已单独补了一条子路径别名（只影响测试解析，不进 bundle）。
//
// ⇒ 于是本文件**能**造扫描器，但**刻意不造**：装配根的职责是"给定这些依赖，装出一个
// 容器"，而"选哪个扫描器实现、什么时候造"属于进程入口。真正造它的那一行在
// `bootstrap/function.ts`。本装配根**不编一个假的**：`scanner` 仍是必填注入项。
import type { WorkScanner } from '@littleq/work-contract';

import { createApiHandler } from '../server/http.js';
import { createObjectStores } from '../server/objects.js';
import { nodeRandomSource, scryptPasswordHasher } from '../server/random.js';
import {
  composeApiServices,
  type ApiServices,
  type ScanAssemblyConfiguration,
} from '../server/index.js';

import {
  runtimeConnectionOf,
  resolveFormBConfig,
  type EnvSource,
  type FormBConfig,
} from './config.js';

/**
 * §8.1 的 ready 预算，逐字来自那张表：
 * 「整体deadline **2500ms**，检查并行，禁止外部AI测试」，配置 100ms / DB 1500ms / 对象 1200ms。
 *
 * 预算的意义不是"快点失败"，而是**让 ready 有一个上界**：没有它，一台休眠中的 Neon
 * （§5.4「Neon闲置约5分钟可能休眠，唤醒数百毫秒」）会把 ready 拖到平台自己的超时上，
 * 而那时报出来的是平台的 504，不是「DB 没准备好」。
 */
export const READY_BUDGET_MS = {
  overall: 2500,
  config: 100,
  database: 1500,
  object: 1200,
} as const;

/**
 * provider 那条腿的注入形状（§3.1 未登记，见文件头缺口 1）。
 *
 * 两个字段都是**可选**的，这不是松弛，是唯一能让运行时守卫编译通过的写法：
 * 若声明成必填，`inputs.provider === undefined` 会被 TS 判成"两个类型没有交集"
 * （TS2367），守卫就成了死代码。类型上可选 = 承认「没有任何环境变量能产出它」这个
 * 已申报的事实；而守卫的**行为**是装一个失败关闭的 provider（{@link createFailClosedProvider}），
 * 不是抛 —— 抛会把 §2.1 保护的 setup / 领取入口一起锁死。
 */
export interface ProviderLeg {
  readonly provider?: TurnProviderClient;
  readonly providerConfiguration?: {
    readonly identityId: string;
    readonly templateId: string;
    readonly environmentId: string;
    readonly templateVersion: string;
  };
}

/**
 * 缺腿时喂给 `composeApiServices` 的 provider 身份：四个字段一律空串。
 *
 * 它**不是**一份编造的身份（编造才是红线），而是「没有身份」的如实表示。
 * `pump.ts` 的 `externalCallSlice` 会把这四个值原样写进 `task_private` 的
 * `providerSnapshot`，于是库里留下的是"这条任务是在没有 provider 配置的情况下被推进的"
 * —— 对账时这比一个看起来像真 id 的假值有用得多。
 */
const UNCONFIGURED_PROVIDER_CONFIGURATION = {
  identityId: '',
  templateId: '',
  environmentId: '',
  templateVersion: '',
} as const;

/**
 * **失败关闭**的 `TurnProviderClient`（文件头缺口 1）。
 *
 * 为什么是 `INTERNAL_ERROR` 而不是 `QCA_CREDENTIAL_NOT_CONFIGURED`：后者会说谎。
 * 那个码的语义是「学生没存 PAT」，而走到这里的处境恰恰相反 —— 学生**存了**
 * （`turns.ts:235` 那道门放行了才可能有任务），缺的是服务端自己的 provider 部署配置。
 * `INTERNAL_ERROR` = 500 / `system.unavailable` / 不可重试，语义正是「服务端自己没准备好」，
 * 与 `server/scan.ts` 未配扫描策略时选的是同一个码、同一条理由（§5.4 的 42 码冻结 ⇒
 * 只能复用，不能新增）。
 *
 * `mapExternalFailure`（`packages/application/src/usecases/pump.ts`）对 `DomainError`
 * 原样放行，所以这个码一路走到 HTTP 层，不会被改写成 `QCA_UNREACHABLE` 那种
 * 「网络问题、可重试」的形状 —— 重试一个没配好的部署不会有不同结果。
 */
function createFailClosedProvider(): TurnProviderClient {
  const unavailable = async (): Promise<never> => {
    throw new DomainError('INTERNAL_ERROR', 'TurnProviderClient');
  };
  return {
    createSession: unavailable,
    sendUserMessage: unavailable,
    listEvents: unavailable,
    interrupt: unavailable,
  };
}

export interface FormBBootstrapInputs extends ProviderLeg {
  /**
   * 显式来源；省略即读 `process.env`，并且 `defineEnv` 会先试着加载仓库根的 `.env`
   * （`packages/infra/src/env.ts:83-85`）—— 本地跑靠它，Vercel 上没有 `.env`
   * 文件，`loadEnvFile` 对缺失文件不报错，平台注入的变量本来就已经在 `process.env` 里。
   */
  readonly env?: EnvSource;
  readonly sessionTtl: SessionTtlPolicy;
  readonly workerId: string;
  readonly secureCookies: boolean;
  readonly random?: RandomSource;
  readonly hasher?: PasswordHasher;
  /**
   * **必填注入**，理由见上面 `@littleq/work-contract` 那条 import 的注释：
   * 装配根不选运行时实现，进程入口才选（`bootstrap/function.ts` 从 `./scan` 子路径造一个
   * 真的）。测试里怎么取到这个值有两种既有写法：走子路径（本轮给 `vitest.config.ts`
   * 补了别名之后可用，见 `apps/api/test/function-entry.test.ts`），或走相对源码路径
   * （`apps/api/test/turn-to-task-to-safe-event.test.ts:70` 与
   * `apps/api/test/bootstrap-container.test.ts` 的既有先例）。两者拿到的是同一份实现。
   */
  readonly scanner: WorkScanner;
  /** `null` = 未配置扫描策略 ⇒ `assemble` 失败关闭（见文件头缺口 4）。 */
  readonly scanConfiguration?: ScanAssemblyConfiguration | null;
  readonly now?: () => Timestamp;
}

export interface FormBContainer {
  readonly config: FormBConfig;
  readonly services: ApiServices;
  /**
   * `node:http` 请求处理器。Vercel 的 Node runtime 函数就是把它 `export default` 出去。
   * `createFormBContainer` **不会**自己开端口：§5.2 的形态 B 是函数，不是常驻进程，
   * 平台负责把请求喂给 handler。下面的 `listen` 只为本地跑通与测试存在，是显式选择，
   * 不是默认副作用。
   */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  readonly db: DatabaseAdapter;
  /**
   * 装配时那一次自检的结论（§2.1 第 5 步）。
   *
   * `false` **不**意味着这个容器不该存在：DB 未就绪时进程仍须 live，
   * 否则 §3.2 的首启领取入口会被自己锁死（引文见 {@link createFormBContainer}）。
   * 要问"现在到底行不行"，用 {@link probeNow} —— `ready` 每次请求都重跑它。
   */
  readonly bootSelfCheckOk: boolean;
  /**
   * provider 那条腿到底有没有被注入（文件头缺口 1）。
   *
   * `false` = 这个容器是 degraded 的：setup / 诊断 / 领取入口照常开放，AI 任务路径一律
   * 以 `INTERNAL_ERROR` 失败关闭。它与 {@link bootSelfCheckOk} 是**两件独立的事**，
   * 所以不合并成一个布尔：`bootSelfCheckOk` 只覆盖 §8.1 的三项硬检查（配置 / DB / 对象），
   * §8.1 逐字「禁止外部AI测试」「AI未配置是功能degraded不是整体503」⇒ provider 既不在
   * 硬检查里，也就**不许**影响 `ready`。合成一个值会让"DB 挂了"与"AI 没配"变成同一个
   * 信号，运维就分不清该修哪一个。
   */
  readonly providerLegConfigured: boolean;
  /** 立即跑一次 §8.1 的自检。装配时已经跑过一次；这个出口留给 `ready` 与运维。 */
  probeNow(): Promise<void>;
  /** 本地起一个常驻监听（生产不调用）。返回实际基址。 */
  listen(port: number): Promise<{ readonly baseUrl: string; close(): Promise<void> }>;
  /** 关连接池。`PostgresDatabaseAdapter.close()` 内部会 `source.end()`。 */
  close(): Promise<void>;
}

/** 给一个 promise 套上预算；超时即抛，**不**取消底层操作（`health()` 没有 signal 入口）。 */
async function withBudget<T>(work: Promise<T>, budgetMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * §8.1 的 ready 自检。
 *
 * 硬检查只有三项（配置 / DB / 对象），**并行**跑，外面再套一层总预算。
 * provider 与扫描策略**不在**硬检查里 —— §8.1 逐字：「禁止外部AI测试」、
 * 「AI未配置是功能degraded不是整体503」。所以这里绝不为了 ready 去打一次 QCA。
 */
function createReadyProbe(
  config: FormBConfig,
  db: DatabaseAdapter,
): () => Promise<void> {
  return async () => {
    await withBudget(
      Promise.all([
        (async () => {
          // 配置检查（100ms）：这些值在装配时已经判过，这里再判一次是因为 §8.1 把
          // 「配置」列成 ready 的一项独立硬检查 —— 一个进程活得比它的配置久是常态
          // （平台侧改了变量、实例还没换），ready 要能反映**当下**。
          if (config.deployment !== 'B') throw new Error('deployment-form');
          if (config.sourceCodeUrl === '') throw new Error('source-code-url');
        })(),
        withBudget(
          (async () => {
            const health = await db.health();
            // `health()` 的 `detail` 只能是内部错误码（infra 的同一条红线：驱动原文里
            // 常带连接目标）。这里连码都不往外带 —— `getReadyHealth` 会把一切失败
            // 收成 `DEPENDENCY_UNAVAILABLE`。
            if (health.status !== 'ok') throw new Error('database');
          })(),
          READY_BUDGET_MS.database,
          'database-budget',
        ),
        withBudget(
          (async () => {
            // 对象检查（1200ms）：本切片接的是**进程内**存储（文件头缺口 3），
            // 没有 I/O 可探。留着这一格是为了让「换成 Blob/R2 之后要探什么」有固定的位置，
            // 而不是等到那天再改 ready 的形状。
          })(),
          READY_BUDGET_MS.object,
          'object-budget',
        ),
      ]),
      READY_BUDGET_MS.overall,
      'ready-overall-budget',
    );
  };
}

/**
 * 装配形态 B 的容器。**读环境变量的是本函数，不是 `composeApiServices`** ——
 * 那条切分是 `server/index.ts` 文件头定下的（§「装配是纯函数，读环境变量的是启动方」），
 * 而且那个文件头逐字写着这个入口当时**不存在**：
 *
 * > ⚠️ **本包没有交付读环境变量的进程入口。**…进程入口要连带部署接线，属于 F4 的范围
 *
 * 本文件就是 F4 补上的那一段。
 *
 * **只有致命项才抛**（§2.1「未知driver、生产/preview混绑、密钥格式错误属于致命配置错误，
 * 拒绝业务装配并仅输出固定修复码」）：配置解析失败、主密钥缺失/非法。
 * 抛的时候不返回半成品 —— 一个装配到一半的容器比一个明确的启动失败危险得多。
 * 依赖"待补"（DB 连不上、扫描策略未配、**provider 腿缺注入**）**不抛**，
 * 理由见第 5 步的引文与文件头缺口 1。
 */
export async function createFormBContainer(
  inputs: FormBBootstrapInputs,
): Promise<FormBContainer> {
  const env: EnvSource = inputs.env ?? process.env;

  // —— §2.1 第 1–3 步：形态 / 平台标识 / Zod 校验 / 允许组合
  const config = resolveFormBConfig(env);

  // provider 腿缺注入 ⇒ degraded，**不抛**（文件头缺口 1）。
  // 与 DB / 扫描策略走的是同一条路：装配继续，事实记在容器上，业务端点各自失败关闭。
  // 两个字段一起判、一起换：`pump.ts` 会同时读 `services.provider` 与
  // `services.providerConfiguration`，只补一个会留下"有 client 没身份"的半装配状态。
  const providerLegConfigured =
    inputs.provider !== undefined && inputs.providerConfiguration !== undefined;
  const provider = inputs.provider ?? createFailClosedProvider();
  const providerConfiguration = inputs.providerConfiguration ?? UNCONFIGURED_PROVIDER_CONFIGURATION;

  // —— 第 4 步：DB / 对象 / secret（publisher 未装配，见文件头缺口 3）
  // 连接串只在下面这一个局部常量里存在过，直接交给驱动，不进任何消息。
  const runtime = runtimeConnectionOf(env, config);
  const source = await createNeonClientSource(
    // `maxConnections` 缺省时整个键都不出现（不是 `max: undefined` 之外的第三种形状），
    // 于是池大小真的由 SDK 决定 —— §3.1 说「B=2」而 `sources.ts` 说「默认值交给 SDK」，
    // 两边都不硬编码，冲突在交付说明里申报。
    config.poolMax === undefined
      ? { connectionString: runtime.connectionString }
      : { connectionString: runtime.connectionString, maxConnections: config.poolMax },
  );
  const adapter = new PostgresDatabaseAdapter({ source });
  const db: DatabaseAdapter = adapter;

  const objects = createObjectStores();
  const now = inputs.now ?? ((): Timestamp => parseTimestamp(new Date().toISOString()));
  const secrets = new EncryptedSecretStore({
    // 主密钥的值校验全在 `loadMasterKey` 里：缺失或非法即 `MASTER_KEY_UNAVAILABLE`。
    // 本文件不重复校验、不软化、更不「临时生成一个」—— 主密钥必须跨冷启动稳定、
    // 跨实例一致，否则已存密文解不开。
    cipher: loadMasterKey(env),
    records: PostgresSecretRecordStore.of(adapter),
    now,
  });

  // —— 第 5 步：自检。
  //
  // ⚠️ 自检**跑**，但它的结果不决定进程存不存在。§2.1 逐字：
  // 「首启诊断/领取服务不能被尚未完成的业务ready检查锁死：DB/对象/主密钥由init或
  //   installer先生成；Runtime地址、SOURCE_CODE_URL或F1业务设置待补时，**进程仍live**
  //   并仅开放受领取票据保护的setup与诊断，学生/API写入未开放。未知driver、生产/preview
  //   混绑、密钥格式错误属于**致命配置错误，拒绝业务装配并仅输出固定修复码**…
  //   setup写完后**重新运行ready**，全部硬项通过才开放业务，不以重启补配置。」
  //
  // 于是致命的只有两类，都在上面已经抛掉了：配置解析失败（`resolveFormBConfig`）
  // 与主密钥非法（`loadMasterKey` 的 `MASTER_KEY_UNAVAILABLE`，不许软化）。
  // DB 连不上**不是**致命项 —— 恰恰相反，把进程掐死就等于把 §3.2 的领取入口一起锁死，
  // 而领取入口正是"让 DB 之后能用起来"的那条路。所以这里记下结果继续装配，
  // `ready` 每次请求重跑同一份探针（"不以重启补配置"），业务端点在 DB 不可用时
  // 由既有传输层各自失败。
  const probeNow = createReadyProbe(config, db);
  const bootSelfCheckOk = await probeNow().then(
    () => true,
    () => false,
  );

  // —— 第 6 步：注册 application services
  const composed = composeApiServices({
    db,
    random: inputs.random ?? nodeRandomSource(),
    hasher: inputs.hasher ?? scryptPasswordHasher(),
    secrets,
    inputs: objects.inputs,
    artifacts: objects.artifacts,
    scanner: inputs.scanner,
    scanConfiguration: inputs.scanConfiguration ?? null,
    provider,
    providerConfiguration,
    sessionTtl: inputs.sessionTtl,
    workerId: inputs.workerId,
    secureCookies: inputs.secureCookies,
    now,
    unitOfWork: new PostgresTaskUnitOfWork(adapter),
    pumpStore: PostgresTaskPumpStore.of(adapter),
  });
  // `composeApiServices` 自己那份 `probeDependencies` 只探 DB；这里换成带 §8.1 预算的那份。
  // `ApiServices` 是普通对象类型，展开是安全的，且不需要动已验收的 `http.ts`。
  const services: ApiServices = { ...composed, probeDependencies: probeNow };

  // —— 第 7 步：HTTP 接入
  const handler = createApiHandler(services);

  return {
    config,
    services,
    handler,
    db,
    bootSelfCheckOk,
    providerLegConfigured,
    probeNow,
    async listen(port: number) {
      const server: Server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(port, resolve));
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      return {
        baseUrl: `http://127.0.0.1:${String(boundPort)}`,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          }),
      };
    },
    close: () => adapter.close(),
  };
}

let cached: Promise<FormBContainer> | undefined;

/**
 * 进程级的**同一个**容器（§2.1「缓存已初始化的 DI 容器」）。
 *
 * 记忆化的是 promise 而不是结果，于是并发的头几个请求不会各装配一次（那会各建一个连接池，
 * 在 Neon 上直接吃满连接配额）。装配失败时把记忆清掉：配置修好之后不需要重启实例，
 * 而一个被缓存住的失败会让进程永远起不来。
 *
 * ⚠️ 入参只在**第一次**生效。一个进程只有一个部署配置，这是形态 B 的前提；
 * 拿不同入参再调一次会拿到第一次那个容器。测试要用 {@link createFormBContainer}，
 * 或者先 {@link resetFormBContainer}。
 */
export function getFormBContainer(inputs: FormBBootstrapInputs): Promise<FormBContainer> {
  if (cached === undefined) {
    cached = createFormBContainer(inputs).catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
  }
  return cached;
}

/** 清掉进程级记忆（不关容器）。测试隔离用。 */
export function resetFormBContainer(): void {
  cached = undefined;
}

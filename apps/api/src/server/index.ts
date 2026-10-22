/**
 * `apps/api` 的**服务端组合根**：把 F1 的 infra 驱动与 F2 的 application 用例装配成
 * 一个 `node:http` 服务。
 *
 * ## 为什么这是 `./server` 子路径，不是根 barrel
 *
 * `package.json` 的 `exports` 有两个入口：`"."`（`dist/index.js`，只有单元清单与就绪声明）
 * 与 `"./server"`（本文件）。这样切的理由是**方向性**的：根 barrel 会被 `apps/web` 的
 * 服务端适配器 import，而 `config/dependency-graph.json` 那条
 * `web-server-adapter-only-controlled-api-entry` 规则允许的说明符正是
 * `@littleq/api/server`。把 HTTP 装配放进根 barrel，等于让"平台有哪些依赖、库怎么连"
 * 这套服务端事实顺着一条客户端也能 import 的路径流出去。
 *
 * ⚠️ **`server-only` 是刻意不 import 的**（交付评论里也申报了）：它在纯 Node 下会
 * **运行时抛错**（`node_modules/server-only/index.js` 的全部内容就是一句 `throw`，而
 * Node 命中的是 `default` 导出条件，不是 `react-server`），而且它**不带 `.d.ts`**，
 * import 它连 `tsc` 都过不了。那条 dep-graph 规则的 `requireSpecifiers: ["server-only"]`
 * 只作用于 `apps/web/app/api/` 下面那些 `route.ts` 适配器文件，不作用于本包。"根 barrel 不回流
 * 到客户端"这条要求由**结构**满足：`src/index.ts` 不 re-export `server/`。
 *
 * ## 装配是纯函数，读环境变量的是启动方
 *
 * `composeApiServices` 收的是**已经建好的**依赖，不读 `process.env`、不读时钟。于是
 * 验收测试可以把同一份装配接到测试库上，而"从环境变量到依赖"这一步留给**启动方**。
 * 这条切分与 domain / application 是同一条约束（附录 A §6.3）。
 *
 * ⚠️ **本包没有交付读环境变量的进程入口。** 可启动的表面就是本文件的
 * `composeApiServices(deps)` + `createApiServer(services)`，`listen` / `close` 由调用方
 * 负责（验收测试正是这么起真服务的）。进程入口要连带部署接线，属于 F4 的范围；而
 * `bootstrapAccounts` 是 TTY 门禁的、ZLQ-153 §1.3 的"首个口令"前提至今未满足，一个读
 * `process.env` 的入口在这一单里既跑不起来也测不了 —— 与其交一段没有证据的自述代码，
 * 不如把它留在启动方那一侧。
 */
import { createServer, type Server } from 'node:http';

import type {
  PasswordHasher,
  RandomSource,
  SecretAdmin,
  TaskInputStore,
  TaskReadDirectory,
  TurnProviderClient,
  WorkArtifactStore,
} from '@littleq/application';
import type { SessionTtlPolicy, Timestamp } from '@littleq/domain';
import type { DatabaseAdapter } from '@littleq/infra';
import type { WorkScanner } from '@littleq/work-contract';

import { API_PREFIX, createApiHandler, type ApiServices } from './http.js';
import { createScanInputAssembler, type ScanAssemblyConfiguration } from './scan.js';
import {
  PostgresAccountDirectory,
  PostgresProjectDirectory,
  PostgresSessionDirectory,
  PostgresTaskReadDirectory,
  PostgresTaskReservationReleaser,
  PostgresUsageDirectory,
} from './storage.js';

export { API_PREFIX, CSRF_COOKIE_NAME, type ApiServices } from './http.js';
export {
  createScanInputAssembler,
  type ScanAssemblyConfiguration,
  type ScanInputAssemblerOptions,
} from './scan.js';
export {
  createTurnProviderClient,
  EXTERNAL_OPERATION_KEY_HEADER,
  type ForwardEventPagePayload,
  type ForwardEventPayload,
  type ForwardSessionPayload,
  type TurnProviderClientOptions,
} from './provider.js';
export {
  createObjectStores,
  createTaskInputStore,
  createWorkArtifactStore,
  envelopePrefixOf,
  InProcessObjectStore,
  taskInputKey,
  type ObjectRefText,
} from './objects.js';
export {
  PostgresAccountDirectory,
  PostgresProjectDirectory,
  PostgresSessionDirectory,
  PostgresTaskReadDirectory,
  PostgresTaskReservationReleaser,
  PostgresUsageDirectory,
  seedAccounts,
  type SeedAccountInput,
} from './storage.js';
export {
  PASSWORD_HASH_BYTES,
  PASSWORD_SALT_BYTES,
  SCRYPT_MAXMEM_BYTES,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SESSION_TOKEN_BYTES,
  hashPasswordWith,
  newSessionToken,
  nodeRandomSource,
  scryptPasswordHasher,
} from './random.js';

/** 组合根需要的全部依赖。每一项都是**已经建好的**，本文件不读环境变量。 */
export interface ApiDependencies {
  readonly db: DatabaseAdapter;
  readonly random: RandomSource;
  readonly hasher: PasswordHasher;
  /** BYO 凭据。`EncryptedSecretStore` 满足 application 那份逐字重述的 `SecretAdmin`。 */
  readonly secrets: SecretAdmin;
  readonly inputs: TaskInputStore;
  readonly artifacts: WorkArtifactStore;
  readonly scanner: WorkScanner;
  /** `null` = 部署没有提供扫描策略 ⇒ SCANNING 装配失败（见 `scan.ts` 文件头）。 */
  readonly scanConfiguration: ScanAssemblyConfiguration | null;
  readonly provider: TurnProviderClient;
  readonly providerConfiguration: {
    readonly identityId: string;
    readonly templateId: string;
    readonly environmentId: string;
    readonly templateVersion: string;
  };
  readonly sessionTtl: SessionTtlPolicy;
  /** 推进器身份。多实例部署时每个实例一个，租约按它归属。 */
  readonly workerId: string;
  /** `Secure` 属性。本地 http 必须为 `false`，否则浏览器直接丢掉 cookie。 */
  readonly secureCookies: boolean;
  readonly now: () => Timestamp;
}

/**
 * 装配 `ApiServices`。
 *
 * 六个 Postgres 目录都在这里 new 出来，而不是让调用方传：它们的构造器只收一个
 * `DatabaseAdapter`，没有任何可配置项，把构造暴露给调用方只是多一处能配错的地方。
 * `TaskUnitOfWork` / `TaskPumpStore` 同理（`new PostgresTaskUnitOfWork(db)` /
 * `PostgresTaskPumpStore.of(db)`），但它们是 **F1 的**类，由**调用方**建好后传进来 ——
 * 组合根不该替 F1 决定用哪个实现，测试也要能换成替身。
 */
export function composeApiServices(
  deps: ApiDependencies & {
    readonly unitOfWork: ApiServices['unitOfWork'];
    readonly pumpStore: ApiServices['pumpStore'];
    readonly tasks?: TaskReadDirectory;
  },
): ApiServices {
  return {
    accounts: new PostgresAccountDirectory(deps.db),
    sessions: new PostgresSessionDirectory(deps.db),
    hasher: deps.hasher,
    random: deps.random,
    projects: new PostgresProjectDirectory(deps.db),
    tasks: deps.tasks ?? new PostgresTaskReadDirectory(deps.db),
    usage: new PostgresUsageDirectory(deps.db),
    secrets: deps.secrets,
    inputs: deps.inputs,
    artifacts: deps.artifacts,
    scanner: deps.scanner,
    scanInputs: createScanInputAssembler({ configuration: deps.scanConfiguration }),
    unitOfWork: deps.unitOfWork,
    pumpStore: deps.pumpStore,
    reservationReleaser: new PostgresTaskReservationReleaser(deps.db),
    provider: deps.provider,
    providerConfiguration: deps.providerConfiguration,
    sessionTtl: deps.sessionTtl,
    workerId: deps.workerId,
    secureCookies: deps.secureCookies,
    now: deps.now,
    probeDependencies: async () => {
      // `health()` 的 `detail` 只能是内部错误码（infra 的同一条红线：provider 原文里
      // 常带签名 URL）。这里连错误码都不往外传，`getReadyHealth` 只回
      // `DEPENDENCY_UNAVAILABLE`。
      const health = await deps.db.health();
      if (health.status !== 'ok') throw new Error(`database ${health.status}`);
    },
  };
}

/** 建一个 `node:http` 服务。调用方负责 `listen` 与 `close`。 */
export function createApiServer(services: ApiServices): Server {
  return createServer(createApiHandler(services));
}

/** 路径拼接。启动方与测试共用，避免两处各写一遍前缀。 */
export function apiPath(route: string): string {
  return `${API_PREFIX}${route.startsWith('/') ? route : `/${route}`}`;
}

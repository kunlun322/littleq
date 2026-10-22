/**
 * `@littleq/api` — 主站 API 组合根。
 *
 * 骨架由 ZLQ-159 落地；HTTP 传输层、鉴权装配、任务编排与驱动装配由 ZLQ-221（F2→B1）
 * 在 `src/server/**` 实现。可启动的组合根是 `@littleq/api/server` 的
 * `composeApiServices(deps)` + `createApiServer(services)`：调用方建好依赖、负责
 * `listen` 与 `close`。**本单没有交付读环境变量的进程入口** —— 那要连带部署接线，
 * 属于 F4（CI/部署）的范围，而且 `bootstrapAccounts` 是 TTY 门禁的、ZLQ-153 §1.3
 * 的"首个口令"前提至今未满足，一个读 `process.env` 的入口在这一单里既跑不起来也
 * 测不了，只会变成一段无证据的自述代码。
 *
 * 边界（ZLQ-153 §1.3 / §5.4）：
 *
 * - 驱动选择只发生在组合根（本文件所在层），domain 只见端口不见实现。
 * - 不等待完整 Agent 回合，不在内存维护任务真相。
 *
 * ⚠️ **本 barrel 故意不 re-export `./server`。** `@littleq/api` 的根入口会被 `apps/web`
 * 之类的客户端侧代码解析到，而 `src/server/**` 里全是 `node:http`、Postgres 适配器与
 * 会话令牌处理 —— 让它顺着 barrel 流回浏览器，等于把服务端的组合根变成客户端可 import
 * 的模块图，打包器再"顺便"把凭据处理代码带进产物。服务端入口走 `@littleq/api/server`
 * 这个独立子路径（见 `package.json` 的 `exports`），两条路径不共用一个 barrel。
 *
 * 这里的 `composedOf` 不是装饰：它让"跨包 workspace 引用 + TS 项目引用 + 构建顺序"
 * 在骨架期就被真实编译与测试覆盖，任何一处解析失败都会在 CI 上立刻暴露。
 */
import { unitManifest as domainManifest } from '@littleq/domain';
import { unitManifest as infraManifest } from '@littleq/infra';
import { unitManifest as contractManifest } from '@littleq/work-contract';

export const UNIT_ID = '@littleq/api';

export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'app';
  readonly spec: string;
  readonly skeletonOnly: boolean;
  readonly composedOf: readonly string[];
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'app',
  spec: 'ZLQ-153 §1.3 apps/api',
  skeletonOnly: false,
  composedOf: [domainManifest.unitId, infraManifest.unitId, contractManifest.unitId],
};

export type UnitReadiness = {
  readonly status: 'skeleton' | 'implemented';
  /** 本单元对外承诺的能力名。稳定标识符，不是文件名、不是测试数量（ZLQ-194 §9.2 规则 6）。 */
  readonly capabilities: readonly string[];
  /** 能力名 → 本单元 test 目录下的验收测试路径。每条能力都必须有映射。 */
  readonly acceptanceTests: Readonly<Record<string, string>>;
};

/**
 * 能力名逐字取自 `tools/unit-readiness-contract.json` 给本单元点名的 `requiredProofs`
 * （出处 ZLQ-194 §9.2 规则 4：「API：turn → task → safe event」），少一个门禁 4 直接红。
 *
 * 那条验收测试不是自述：它起一个真的 `node:http` 服务、发真的 HTTP 请求、落在真的
 * Postgres 上，断言读的是**库里的行**（`account_sessions.token_hash`、`ai_tasks`、
 * `task_events`、`owner_secrets`），而不是响应体里的自我描述。
 */
export const unitReadiness: UnitReadiness = {
  status: 'implemented',
  capabilities: ['turn-to-task-to-safe-event'],
  acceptanceTests: {
    'turn-to-task-to-safe-event': 'test/turn-to-task-to-safe-event.test.ts',
  },
};

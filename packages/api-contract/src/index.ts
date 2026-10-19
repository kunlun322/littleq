/**
 * `@littleq/api-contract` — API 传输契约层。
 *
 * 本包是 LittleQ 对外 HTTP 契约的**唯一事实源**（附录 A §3.1 裁定）：Zod DTO 与框架
 * 无关的 `operationRegistry` 在这里声明，OpenAPI 3.1 文档与错误目录由它们单向派生。
 * 反方向（OpenAPI → 类型）被规格明确禁止，所以这里没有任何读回生成结果再修正的逻辑。
 *
 * ## 目录结构（附录 A §3.2 逐字规定）
 *
 * - `schemas/common.ts` —— 线上词汇表：ID / 修订号 / 时间戳 / 游标 / ETag / 幂等键等
 *   原子 schema，枚举与数值约束，分页封装，统一错误 envelope，请求头组合，以及
 *   `OperationContract` 这类**描述契约本身的类型**。
 * - `schemas/{auth,groups,projects,tasks,works,settings,usage}.ts` —— 按业务面切分的
 *   请求/响应 DTO，一一对应 §5.4 接口表的分组。
 * - `operations.ts` —— 31 条 operation 的注册表，顺序即 §5.4 表格顺序。
 * - `openapi.ts` —— 错误码挂载规则（§5.4）、错误目录快照、OpenAPI 文档装配与生成期断言。
 *
 * 依赖是有向无环的：`schemas/*` ← `operations.ts` ← `openapi.ts` ← 本文件。
 * `schemas/common.ts` 因此同时承载类型与 schema —— 把 `OperationContract` 放进
 * `operations.ts` 会让 `openapi.ts` 与 `operations.ts` 互相 import。
 *
 * ## 边界
 *
 * 由 `config/dependency-graph.json` 的 `api-contract-no-platform-coupling` 规则声明，
 * 经 `tools/check-dependency-graph.mjs`（CI 权威判定）与 `eslint.config.mjs`（编辑器
 * 即时反馈）双重强制，且是**双向**的：
 *
 * - 出向：不得导入 NestJS / Fastify / 数据库 / 云 SDK / `packages/infra` /
 *   `packages/design-system` / 任何 `apps/*` / `drivers/*`。本包只有两个运行时依赖：
 *   `zod`（冻结 4.6.7）与 `zod-openapi`（6.0.2），外加工作区内的 `@littleq/domain`。
 * - 入向：`allowFrom` 只有 `apps/api` 与将来的 `packages/application`，其余单元
 *   默认拒绝。契约层不该被 web / runtime / worker 直接消费 —— 它们要的是类型化的
 *   客户端，那是后续行的产物，不是本包。
 *
 * 附录 A §3.5 的另一条不由工具强制：`apps/api` 后续只能引用本包的 schema，不得再
 * 声明第二套 DTO 校验规则。Nest decorator 只负责路由装配。
 *
 * ## 平台无关性（PM G6）
 *
 * 生成路径上的每一处顺序都显式决定，不交给宿主：对象 key 一律码位序排序（不用
 * `localeCompare`，它受 `NODE_ICU_DATA` 与系统语言影响），`Map`/`Set` 派生的数组在
 * 交给下游前就排好，语义有序的数组（`exclusiveErrorCodes`、`success`、enum 成员）
 * 一律保持声明顺序不动（§4.1 禁止重排数组）。本包不读时钟、不读环境变量、不做 IO、
 * 不读 git、不扫 `node_modules`。这样 `contracts/openapi/v1/openapi.json` 才可能在
 * 任何机器上逐字节复现（§4.4）。
 */

export * from './schemas/common.js';
export * from './schemas/auth.js';
export * from './schemas/groups.js';
export * from './schemas/projects.js';
export * from './schemas/tasks.js';
export * from './schemas/works.js';
export * from './schemas/settings.js';
export * from './schemas/usage.js';
export * from './operations.js';
export * from './openapi.js';

/** 单元标识，与 `package.json` 的 `name` 一致。 */
export const UNIT_ID = '@littleq/api-contract';

/**
 * 单元自述。字段与 `@littleq/domain` 的同名接口一致，但类型各自声明：本包不得为了
 * 复用这个接口而去 import domain 的 `UnitManifest`，那会让「契约层依赖领域层」这条
 * 边多背一个纯元数据用途的理由。
 */
export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'contract';
  readonly spec: string;
  readonly skeletonOnly: boolean;
  /** 本单元装配时所依赖的下层单元，供组合根启动自检。 */
  readonly dependsOn: readonly string[];
}

/**
 * `skeletonOnly: false` —— 本包自创建起就是实现，不是骨架（附录 A §6.8）。
 * 仍是骨架的单元各自维持 `true`，由它们自己的测试钉住；翻牌必须与实现落在同一次
 * 提交里，`packages/work-contract` 因此在本行之后依然是 `true`。
 */
export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'contract',
  spec: 'ZLQ-153 §1.3 packages/api-contract / 附录 A §3.1-§3.5',
  skeletonOnly: false,
  dependsOn: ['@littleq/domain'],
};

/**
 * 就绪声明的形状（ZLQ-194 §9.2 规则 3）。
 *
 * 与 `@littleq/domain` 的同名类型各自声明、互不 import —— 见上面 `UnitManifest` 的注释：
 * 契约层依赖领域层这条边不该为一个纯治理元数据接口再多背一个理由。
 */
export type UnitReadiness = {
  readonly status: 'skeleton' | 'implemented';
  /** 本单元对外承诺的能力名。稳定标识符，不是文件名、不是测试数量（§9.2 规则 6）。 */
  readonly capabilities: readonly string[];
  /** 能力名 → 本单元 test 目录下的验收测试路径。每条能力都必须有映射。 */
  readonly acceptanceTests: Readonly<Record<string, string>>;
};

/**
 * 就绪声明：本单元已实现，而且**自证**已实现。
 *
 * `skeletonOnly: false` 单独存在时只是一个布尔值，翻它不需要证据，所以「已实现」这句话
 * 可以是一句谎（ZLQ-194 §9.2 要治的正是这个）。下面每一条能力名都会被
 * `tools/check-unit-readiness.mjs` 的门 3 拿去核对：映射到的测试文件必须真实存在、必须有
 * 至少一条活着的用例、并且文件里必须出现这个能力名本身。
 *
 * 三条能力对应本包作为「唯一事实源」最容易被悄悄破坏的三个性质：
 *
 * - `operation-registry-spec-parity` —— 注册表与附录 §5.4 接口表逐字对应。本单新增的
 *   `pumpTask` / `rotateSecret` / `revokeSecret` 三条正是靠它落在表里，而不是靠谁记得。
 * - `openapi-snapshot-determinism` —— 同一份源码连续生成两次逐字节相同。`contract:check`
 *   之所以能当门禁用，前提就是这一条；它一旦不成立，快照对比退化成人肉审阅。
 * - `secret-never-echoed` —— 秘密值在结构上不存在于任何响应形状里。§7 选项 B 要求 BYO
 *   凭证可写入、可轮换、可撤销，但**永不回显**；这条能力钉的是「不是文档里没写 value，
 *   而是 schema 的键集合里根本没有 value」。
 */
export const unitReadiness: UnitReadiness = {
  status: 'implemented',
  capabilities: [
    'operation-registry-spec-parity',
    'openapi-snapshot-determinism',
    'secret-never-echoed',
  ],
  acceptanceTests: {
    'operation-registry-spec-parity': 'test/operations.test.ts',
    'openapi-snapshot-determinism': 'test/openapi.test.ts',
    'secret-never-echoed': 'test/schemas.test.ts',
  },
};

/**
 * `@littleq/application` —— 应用层的**端口**出口（ZLQ-216 §3.5 / §10.2 F1）。
 *
 * ## 这个包为什么现在存在
 *
 * §2.1 的技术选型把用例层定在 `packages/application`，并注明「纯 domain 不引入平台
 * SDK」。在 F1 之前它还不存在：装配端口无处可放 —— 放 domain 会把持久化概念漏进业务
 * 事实源，放 infra 则 F2 的用例必须反向依赖驱动包。
 *
 * ## ports 归 F1，use-cases 归 F2
 *
 * §10.2 逐字：「application 内部由 **F1 拥有 ports、F2 拥有 use-cases**。」所以
 * `ports/` 目录下是 F1 交出来的两个装配端口（`TaskPumpStore` /
 * `TaskUnitOfWork`）、`task_private` 的完整记录形态、以及租约句柄；`usecases/`
 * 目录下是 F2 的业务编排 —— 登录、创建项目、创建 turn、`:pump` 短步驱动。
 * F2 **不改 `ports/` 里任何形状**：新用例需要的存储端口写在
 * `usecases/ports.ts`（所有权跟着用例走），端口形状不够用时按 §3 停下问 PM。
 *
 * ## 边界
 *
 * - `domain-and-application-no-drivers`（`config/dependency-graph.json` 规则 2）在本包
 *   落地前就已按路径预先生效，现在它约束的是真代码：`src/**` 里不得出现
 *   `drivers/` 形状的导入。
 * - `package.json` 的 `dependencies` 只有两个 workspace 包，**零第三方生产依赖**
 *   （§9.3：「预计新增第三方生产依赖：0」）。
 * - 不导入 `@littleq/infra`。这不是洁癖，是 `tsc -b` 的硬约束：infra 要 `implements`
 *   这里的端口，反向 import 会让项目引用成环。因此 `TaskLease` / `TaskRepository`
 *   在本包**重述**，双向可赋值断言看守漂移（见 `task-lease.ts` 文件头）。
 * - 不读时钟、不读环境变量、不做 IO。「现在几点」一律是入参。
 *
 * ## 为什么没有 `unitManifest` / `unitReadiness`
 *
 * `UnitManifest.layer` 的取值集合是 domain 冻结的
 * `'domain' | 'contract' | 'design-system' | 'infra' | 'app'`，其中 `'app'` 指
 * `apps/*` 组合根，没有一项对应"应用层端口包"。给它加一个取值等于改 domain 的公开
 * 类型，不在 §3 的文件预算内。就绪声明同理：`tools/unit-readiness-contract.json`
 * 是 §8 明令不动的文件，而未被该契约点名的单元不会被门 6 检查 —— 与其写一份没有
 * 门禁看守的自述，不如不写。两处偏离都在交付说明里列明。
 */

export const UNIT_ID = '@littleq/application';

export * from './task-lease.js';
export * from './task-private.js';
export * from './ports/task-pump-store.js';
export * from './ports/task-unit-of-work.js';

// F2 拥有的用例层（§10.2）。`usecases/ports.ts` 里的 `SECRET_PURPOSES` /
// `SecretPurpose` / `InternalSecretMetadata` 与 infra 的同名导出**逐字同形**，
// 重述的理由与 `task-lease.ts` 一致：本包不导入 infra，否则 `tsc -b` 的项目引用成环。
export * from './usecases/ports.js';
export * from './usecases/authorization.js';
export * from './usecases/auth.js';
export * from './usecases/projects.js';
export * from './usecases/secrets.js';
export * from './usecases/turns.js';
export * from './usecases/tasks.js';

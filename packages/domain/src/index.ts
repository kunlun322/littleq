/**
 * `@littleq/domain` — 领域层。
 *
 * 本包是 LittleQ 的**唯一业务事实源**：实体、值对象、状态机、错误目录与策略都在这里，
 * 而且只有这里。它不知道 HTTP、不知道 SQL、不知道 QCA 或 Bailian 长什么样。
 *
 * ## 目录结构
 *
 * - `value-objects/` —— 不可变、构造即校验的原子值（ID、枚举、时间、游标、摘要、
 *   不透明引用）。每个值对象自带 `is*` / `parse*`，`parse*` 失败抛 `DomainError`。
 * - `states/` —— 通用迁移表机制（`transitionTable` 在模块加载期自检）与 12 张具体状态机。
 * - `errors/` —— 42 个领域错误码的冻结目录、`DomainError`、以及 `(taskKind, stage)`
 *   异步错误登记表。
 * - `entities/` —— 9 个聚合（Account / Group / Project / Work / Task / Usage /
 *   Teaching / Reward / Audit）。构造期校验 + 不可变更新：每个 `create*` 返回前跑完
 *   全部不变量，每个变更函数返回**新对象**并推进 `revision`。
 * - `policies/` —— 纯决策函数：任务准入、用量准入与结算、`(stage, code)` 重试表、租约条件、
 *   `:pump` 的单飞推进判定、账号会话的签发 / 触摸 / 撤销。
 *
 * ## 边界
 *
 * 由 `config/dependency-graph.json` 声明，经 `tools/check-dependency-graph.mjs`
 * （CI 权威判定）与 `eslint.config.mjs`（编辑器即时反馈）双重强制：
 *
 * - `domain-no-platform-sdk`：只依赖 TypeScript 标准类型，不得引入 NestJS / Vercel /
 *   PostgreSQL / D1 等平台 SDK；所有 SDK 类型停在 infra 层。
 * - `domain-and-application-no-drivers`（ZLQ-153 §5.4(4)）：禁止导入 `drivers/*`。
 * - `domain-no-workspace-deps`：不得依赖本仓库任何其它单元（依赖方向单向向下）。
 *
 * 第四条边界不由工具强制，而由 `package.json` **没有 `dependencies` 字段**这一事实强制：
 * 本包零运行时依赖，因此不存在"顺手引一个库"的物理路径。
 *
 * ## 平台无关性
 *
 * 本包不读时钟、不读环境变量、不做 IO，也不使用 `Intl` / locale 相关的比较
 * （排序一律走码位）。所有"现在几点"都是入参。这不是洁癖：`@littleq/api-contract`
 * 的 OpenAPI 快照要能逐字节复现，前提就是这里的每一个派生集合在任何宿主上顺序一致。
 */

export * from './value-objects/index.js';
export * from './states/index.js';
export * from './errors/index.js';
export * from './entities/index.js';
export * from './policies/index.js';

/** 单元标识，与 `package.json` 的 `name` 一致。 */
export const UNIT_ID = '@littleq/domain';

/** 分层标识，用于组合根在启动时自检装配来源。 */
export type Layer = 'domain' | 'contract' | 'design-system' | 'infra' | 'app';

/** 单元自述。组合根据此确认各层装配来源与实现状态。 */
export interface UnitManifest {
  readonly unitId: string;
  readonly layer: Layer;
  /** 规格出处，便于审查时回溯到设计文档条款。 */
  readonly spec: string;
  /** 骨架期为 true；业务实现落地后由对应任务改为 false。 */
  readonly skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'domain',
  spec: 'ZLQ-153 §1.3 packages/domain',
  skeletonOnly: false,
};

/**
 * 就绪声明的形状（ZLQ-194 §9.2 规则 3）。
 *
 * 与 `@littleq/api-contract` 的同名类型各自声明、互不 import，理由与那个包里
 * `UnitManifest` 的注释逐字相同：不为一个纯治理元数据接口去背一条跨单元依赖边。
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
 * 只有上面那个 `skeletonOnly: false` 是不够的 —— 它是一个布尔值，翻动它不需要提交任何
 * 证据，所以「已实现」这句话本身可以是一句谎（ZLQ-194 §9.2 要治的正是这个）。下面每一条
 * 能力名都会被 `tools/check-unit-readiness.mjs` 的门 3 拿去核对：映射到的测试文件必须真实
 * 存在、必须有至少一条活着的用例、并且文件里必须出现这个能力名本身。最后一条是防「把能力
 * 指向一个无关的既有测试来充数」。
 *
 * 能力名刻意取成契约概念（`pump-single-flight` 而不是 `task-pump.test.ts`）：文件名会随
 * 重构改动而能力不该跟着改；反过来，谁把测试文件改了名而忘了改映射，门 3 立刻红。
 *
 * 五条里有两条（`error-catalog-frozen`、`transition-table-self-check`）证明的不是本单元
 * 新增的功能，而是新增功能必须**服从**的既有约束：`:pump`、Secret 的 `:rotate` 与
 * `:revoke`、账号会话的失效判定，全部只能用目录里现有的 42 个错误码表达（新增一个码在
 * `contract:control` 里是破坏性变更），也全部只能靠迁移表来回答「这是不是终态」。把这两条
 * 写进声明，等于让本单赖以前提的两个约束从此有门禁看守，而不是只写在注释里。
 */
export const unitReadiness: UnitReadiness = {
  status: 'implemented',
  capabilities: [
    'pump-single-flight',
    'secret-rotate-revoke',
    'session-ttl-and-revocation',
    'error-catalog-frozen',
    'transition-table-self-check',
  ],
  acceptanceTests: {
    'pump-single-flight': 'test/task-pump.test.ts',
    'secret-rotate-revoke': 'test/secret-lifecycle.test.ts',
    'session-ttl-and-revocation': 'test/session.test.ts',
    'error-catalog-frozen': 'test/errors.test.ts',
    'transition-table-self-check': 'test/states.test.ts',
  },
};

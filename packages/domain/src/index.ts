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
 * - `states/` —— 通用迁移表机制（`transitionTable` 在模块加载期自检）与 11 张具体状态机。
 * - `errors/` —— 42 个领域错误码的冻结目录、`DomainError`、以及 `(taskKind, stage)`
 *   异步错误登记表。
 * - `entities/` —— 9 个聚合（Account / Group / Project / Work / Task / Usage /
 *   Teaching / Reward / Audit）。构造期校验 + 不可变更新：每个 `create*` 返回前跑完
 *   全部不变量，每个变更函数返回**新对象**并推进 `revision`。
 * - `policies/` —— 纯决策函数：任务准入、用量准入与结算、`(stage, code)` 重试表、租约条件。
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

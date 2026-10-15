/**
 * `@littleq/domain` — 领域层骨架。
 *
 * 本文件由 ZLQ-159（仓库与质量基座）落地，**只含骨架，不含任何业务逻辑**：
 * 领域实体、值对象、领域服务与不变量由 ZLQ-160 在此目录内实现。
 *
 * 边界（ZLQ-153 §1.3 / §3.1 / §5.4）——由 `config/dependency-graph.json` 声明，
 * 经 `tools/check-dependency-graph.mjs`（CI 权威判定）与 `eslint.config.mjs`
 * （编辑器即时反馈）双重强制：
 *
 * - `domain-no-platform-sdk`：只依赖 TypeScript 标准类型，不得引入 NestJS / Vercel /
 *   PostgreSQL / D1 等平台 SDK；所有 SDK 类型停在 infra 层。
 * - `domain-and-application-no-drivers`（§5.4(4)）：禁止导入 `drivers/*`。
 * - `domain-no-workspace-deps`：不得依赖本仓库任何其它单元（依赖方向单向向下）。
 */

/** 单元标识，与 `package.json` 的 `name` 一致。 */
export const UNIT_ID = '@littleq/domain';

/** 分层标识，用于组合根在启动时自检装配来源。 */
export type Layer = 'domain' | 'contract' | 'design-system' | 'infra' | 'app';

/** 单元自述。骨架期用于验证 workspace 解析、项目引用与构建产物可用。 */
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
  skeletonOnly: true,
};

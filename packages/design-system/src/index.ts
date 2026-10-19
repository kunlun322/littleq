/**
 * `@littleq/design-system` — 设计系统。
 *
 * ZLQ-159 落地骨架，ZLQ-190 §5.2 落地首个视觉基线：设计令牌（`./tokens.css`）与
 * 分龄展示元数据（`./age-bands.js`）。仍然**不含任何业务逻辑**。
 *
 * 边界（ZLQ-153 §1.3）——由 `config/dependency-graph.json` 强制：
 *
 * - `design-system-no-business-coupling`：不得依赖领域模型、基础设施、契约层或任何应用单元。
 *
 * 消费方约定（ZLQ-190 §5.2）：品牌色、间距与分龄档位变量**只允许**出自本包的
 * `@littleq/design-system/tokens.css`；应用侧（如 `apps/web/app/globals.css`）不得另立一套，
 * 否则「跨端一致」就只是一句声明。
 *
 * 本包运行在浏览器侧，故 tsconfig 继承根 `tsconfig.web.json`（DOM lib、无 Node 类型）。
 */

export { AGE_BANDS, findAgeBand } from './age-bands.js';
export type { AgeBand, AgeBandId, DensityTier } from './age-bands.js';

export const UNIT_ID = '@littleq/design-system';

export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'design-system';
  readonly spec: string;
  /**
   * 规格值，不是测量值：本包已不再是空骨架（ZLQ-190 §5.2 起持有令牌与分龄元数据）。
   * 与 `packages/api-contract` 同一处理方式 —— 翻牌必须与实现落在同一次提交里。
   */
  readonly skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'design-system',
  spec: 'ZLQ-153 §1.3 packages/design-system',
  skeletonOnly: false,
};

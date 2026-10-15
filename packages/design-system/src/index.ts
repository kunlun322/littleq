/**
 * `@littleq/design-system` — 设计系统骨架。
 *
 * 本文件由 ZLQ-159（仓库与质量基座）落地，**只含骨架，不含任何业务逻辑**：
 * 设计令牌、跨端组件与可访问性基线由后续任务在此实现。
 *
 * 边界（ZLQ-153 §1.3）——由 `config/dependency-graph.json` 强制：
 *
 * - `design-system-no-business-coupling`：不得依赖领域模型、基础设施、契约层或任何应用单元。
 *
 * 本包运行在浏览器侧，故 tsconfig 继承根 `tsconfig.web.json`（DOM lib、无 Node 类型）。
 */

export const UNIT_ID = '@littleq/design-system';

export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'design-system';
  readonly spec: string;
  readonly skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'design-system',
  spec: 'ZLQ-153 §1.3 packages/design-system',
  skeletonOnly: true,
};

/**
 * `@littleq/work-contract` — 作品契约层骨架。
 *
 * 本包目前**只含骨架，不含任何业务逻辑**：真实 `work.json` 字段、资源清单、素材许可
 * 记录与校验规则由作品契约与扫描器核心阶段实现，届时 `unitManifest.skeletonOnly`
 * 与它的测试在同一次提交里翻为 `false`。
 *
 * 边界（ZLQ-153 §1.3）——由 `config/dependency-graph.json` 强制：
 *
 * - `work-contract-no-platform-coupling`：纯 schema/校验层，不依赖平台 SDK、
 *   `@littleq/infra`、`@littleq/design-system` 与任何应用单元。
 * - 契约层不信任 Agent 自述：所有跨进程数据必须经此校验后才进入主站。
 */
import { z } from 'zod';

export const UNIT_ID = '@littleq/work-contract';

export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'contract';
  readonly spec: string;
  readonly skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'contract',
  spec: 'ZLQ-153 §1.3 packages/work-contract',
  skeletonOnly: true,
};

/**
 * 契约版本占位 schema。存在的意义是证明 zod（§2.1 冻结版本 4.6.7）在 workspace、
 * 项目引用、esbuild bundle 与许可证扫描四条链路上都能被正确解析，不代表任何业务约定。
 */
export const contractVersionSchema = z.object({
  contractVersion: z.literal(0),
});

export type ContractVersion = z.infer<typeof contractVersionSchema>;

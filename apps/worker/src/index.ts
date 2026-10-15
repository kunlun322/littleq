/**
 * `@littleq/worker` — 异步任务 Worker 组合根骨架。
 *
 * 本文件由 ZLQ-159（仓库与质量基座）落地，**只含骨架，不含任何业务逻辑**：
 * Agent 回合驱动、任务状态机与重试策略由 ZLQ-160 / ZLQ-161 在此实现。
 *
 * 边界（ZLQ-153 §1.3）：不拥有独立状态，重启后以数据库恢复；驱动选择只发生在组合根。
 */
import { unitManifest as domainManifest } from '@littleq/domain';
import { unitManifest as infraManifest } from '@littleq/infra';
import { unitManifest as contractManifest } from '@littleq/work-contract';

export const UNIT_ID = '@littleq/worker';

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
  spec: 'ZLQ-153 §1.3 apps/worker',
  skeletonOnly: true,
  composedOf: [domainManifest.unitId, infraManifest.unitId, contractManifest.unitId],
};

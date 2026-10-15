/**
 * `@littleq/api` — 主站 API 组合根骨架。
 *
 * 本文件由 ZLQ-159（仓库与质量基座）落地，**只含骨架，不含任何业务逻辑**：
 * HTTP 适配、鉴权、任务编排与驱动装配由 ZLQ-160 / ZLQ-161 在此实现。
 *
 * 边界（ZLQ-153 §1.3 / §5.4）：
 *
 * - 驱动选择只发生在组合根（本文件所在层），domain 只见端口不见实现。
 * - 不等待完整 Agent 回合，不在内存维护任务真相。
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
  skeletonOnly: true,
  composedOf: [domainManifest.unitId, infraManifest.unitId, contractManifest.unitId],
};

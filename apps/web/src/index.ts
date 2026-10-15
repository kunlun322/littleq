/**
 * `@littleq/web` — 主站 Web 骨架，同时是"最终 web bundle"的 esbuild 入口。
 *
 * 本文件由 ZLQ-159（仓库与质量基座）落地，**只含骨架，不含任何业务逻辑**：
 * SSR 页面、作品展示、OG 元数据与 iframe/CSP 策略由后续任务在此实现。
 *
 * 边界（ZLQ-153 §1.3）——由 `config/dependency-graph.json` 强制：
 *
 * - `web-no-ai-credentials`：前端不得持有任何模型供应商 SDK 或凭证。
 * - 不执行 Agent、不直接提供作品 JS（作品由 apps/runtime 隔离托管）。
 *
 * 之所以把它同时作为 bundle 入口：ZLQ-153 §10.3 要求许可证扫描覆盖"最终 web bundle"，
 * 于是 `tools/build-bundles.mjs` 从这里打出 `artifacts/bundles/web.js`，
 * 再由 `tools/license/bundle-scan.mjs` 依据 esbuild metafile 精确列出被打进产物的第三方包。
 */
import { unitManifest as designSystemManifest } from '@littleq/design-system';
import { contractVersionSchema, unitManifest as contractManifest } from '@littleq/work-contract';

export const UNIT_ID = '@littleq/web';

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
  spec: 'ZLQ-153 §1.3 apps/web',
  skeletonOnly: true,
  composedOf: [designSystemManifest.unitId, contractManifest.unitId],
};

/** 骨架期的产物自检：确认契约层已随 bundle 一同打入且可执行。 */
export function isContractLoadable(): boolean {
  return contractVersionSchema.safeParse({ contractVersion: 0 }).success;
}

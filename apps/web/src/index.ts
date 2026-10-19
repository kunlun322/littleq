/**
 * `@littleq/web` — 主站 Web 的单元自述，同时是"最终 web bundle"的 esbuild 入口。
 *
 * 本文件由 ZLQ-159（仓库与质量基座）落地。ZLQ-190 起 `apps/web` 不再只是骨架：
 * Next.js 16 App Router 的静态站点位于同包的 `app/` 目录（首页、`/source-and-license/`），
 * 文案与构建期身份信息分别在 `src/site-content.ts` 与 `src/build-info.ts`。
 *
 * **本文件刻意不与 `app/` 或 `src/build-info.ts` 相互引用**：
 *
 * - 它是 `tools/build-bundles.mjs` 的 esbuild 入口，产出 `artifacts/bundles/web.js`，
 *   再由 `tools/license/bundle-scan.mjs` 依据 metafile 精确列出被打进产物的第三方包。
 *   把 Node 内建模块（`build-info.ts` 用 `node:child_process`）拉进来会让这份
 *   `platform: 'browser'` 的产物变成一份无法在浏览器执行的东西，e2e 会直接失败。
 * - 也正因为如此，这份 bundle 扫描**不覆盖** Next 的产物 chunk。Next 侧的第三方声明由
 *   `/legal/THIRD_PARTY_LICENSES.txt` 与 `/licenses.txt` 公开承载（ZLQ-190 §7），
 *   由 e2e 断言，不冒充本 bundle 的扫描结果。
 *
 * 边界（ZLQ-153 §1.3）——由 `config/dependency-graph.json` 强制：
 *
 * - `web-no-ai-credentials`：前端不得持有任何模型供应商 SDK 或凭证。
 * - 不执行 Agent、不直接提供作品 JS（作品由 apps/runtime 隔离托管）。
 */
import { unitManifest as designSystemManifest } from '@littleq/design-system';
import { contractVersionSchema, unitManifest as contractManifest } from '@littleq/work-contract';

export const UNIT_ID = '@littleq/web';

export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'app';
  readonly spec: string;
  /**
   * 规格值，不是测量值：ZLQ-190 起本单元持有真实可部署的静态站点，不再是空骨架。
   * 与 `packages/api-contract`、`packages/design-system` 同一处理方式。
   */
  readonly skeletonOnly: boolean;
  readonly composedOf: readonly string[];
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'app',
  spec: 'ZLQ-153 §1.3 apps/web',
  skeletonOnly: false,
  composedOf: [designSystemManifest.unitId, contractManifest.unitId],
};

/** 产物自检：确认契约层已随 bundle 一同打入且可执行。 */
export function isContractLoadable(): boolean {
  return contractVersionSchema.safeParse({ contractVersion: 0 }).success;
}

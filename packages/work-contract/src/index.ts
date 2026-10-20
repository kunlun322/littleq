/**
 * `@littleq/work-contract` — 作品契约与扫描器核心（ZLQ-153 §1.3 / §8.3，ZLQ-156 §1、§2、§6）。
 *
 * 本包已经从骨架变成真实实现：`work.json` 的字段与校验规则在 `src/scan/metadata.ts`，
 * B1–B13 的 AST/数据流判定在 `src/scan/rules/`，分片续跑的扫描驱动在 `src/scan/index.ts`，
 * §8.6 两个指标的判读在 `src/scan/verdict.ts`。`unitManifest.skeletonOnly` 与
 * `unitReadiness`、以及让 `skeletonOnly: false` 成立的那条测试，在同一次提交里一起翻。
 *
 * 边界（ZLQ-153 §1.3）——由 `config/dependency-graph.json` 强制：
 *
 * - `work-contract-no-platform-coupling`：纯 schema/校验层，不依赖平台 SDK、
 *   `@littleq/infra`、`@littleq/design-system` 与任何应用单元。
 * - 契约层不信任 Agent 自述：所有跨进程数据必须经此校验后才进入主站。
 *
 * ## 这个 barrel 只re-export 类型，不 re-export 运行时
 *
 * 这是**刻意的**，不是漏写。扫描器的运行时入口在 `src/scan/index.ts`（`createWorkScanner` /
 * `scanPackage`），但它依赖 acorn / parse5 / postcss，而 postcss 是 CJS —— esbuild 无法摇掉它。
 * 唯一的 bundle 目标是 `apps/web`，它从这里只取 `contractVersionSchema` 与 `unitManifest`；
 * 一旦 barrel 再 re-export 扫描器的**值**，三个解析器就会被拖进浏览器产物，
 * `bundles` / `license:bundle` / `license:third-party:check` 三道门会一起红。
 * `export type { … }` 会被 TS（`verbatimModuleSyntax`）与 esbuild 双双擦除，产物字节不变。
 *
 * **代价（已知缺口，需 D0 级别的 `package.json` 修订才能补）**：`package.json` 的 `exports`
 * 只有 `"."`，没有子路径，所以包外**拿不到扫描器的运行时**，只能拿到下面这些类型。
 * 本单的文件边界是 `packages/work-contract/{src,test}/**`，`package.json` 在边界外，
 * 我无权改它 —— 缺口如实上报，不自行扩权。仓库内的测试用相对路径
 * （`../src/scan/index.js`）直达运行时，不受此限。
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
  skeletonOnly: false,
};

/**
 * 就绪声明的形状。**必须在本文件里就地声明，不能从 `tools/` import**：
 * `tools/check-unit-readiness.mjs` 是静态解析各单元自己的 `src/index.ts` 的
 * （它的注释写明「不要求单元 import 任何 tools/ 里的类型」），而且契约层 import `tools/`
 * 会同时踩到目录边界与依赖图边界。
 */
export type UnitReadiness = {
  readonly status: 'skeleton' | 'implemented';
  /** 本单元对外承诺的能力名。稳定标识符，不是文件名、不是测试数量（ZLQ-194 §9.2 规则 6）。 */
  readonly capabilities: readonly string[];
  /** 能力名 → 本单元 test 目录下的验收测试路径。每条能力都必须有映射。 */
  readonly acceptanceTests: Readonly<Record<string, string>>;
};

/**
 * 两条能力名逐字取自 `tools/unit-readiness-contract.json` 里本单元的 `requiredProofs`
 * （出处 ZLQ-194 §9.2 规则 4：「work-contract：至少一个安全包通过、每类阻断负例失败」）。
 * 它们同时是 ZLQ-156 §2 的两个**包级**黑盒证明；D3b 的语料实测是另一件事，不在本单。
 */
export const unitReadiness: UnitReadiness = {
  status: 'implemented',
  capabilities: ['safe-package-passes', 'every-block-category-negative-fails'],
  acceptanceTests: {
    'safe-package-passes': 'test/safe-package-passes.test.ts',
    'every-block-category-negative-fails': 'test/every-block-category-negative-fails.test.ts',
  },
};

/**
 * 契约版本占位 schema。存在的意义是证明 zod（§2.1 冻结版本 4.6.7）在 workspace、
 * 项目引用、esbuild bundle 与许可证扫描四条链路上都能被正确解析，不代表任何业务约定。
 *
 * 真实的作品契约 schema 是 `src/scan/metadata.ts` 的 `workMetadataSchema`（ZLQ-156 §1.2–§1.4）。
 * 这个占位 schema 被 `apps/api` / `apps/worker` / `apps/web` 引用，改动它属于契约变更，
 * 不在本单范围内 —— 所以它保持原样。
 */
export const contractVersionSchema = z.object({
  contractVersion: z.literal(0),
});

export type ContractVersion = z.infer<typeof contractVersionSchema>;

// ---------------------------------------------------------------------------
// 扫描器契约词汇表（**只有类型**，理由见文件头）
// ---------------------------------------------------------------------------

/** ZLQ-156 §6.1 输入形式 / §6.2 输出与脱敏 / §6.3 checkpoint —— 逐字冻结的对外契约。 */
export type {
  AdultApprovedCapability,
  Confidence,
  Disposition,
  FileRange,
  FileRef,
  FileRole,
  Finding,
  FindingLocation,
  RepairAction,
  RuleId,
  ScanCheckpoint,
  ScanCursor,
  ScanErrorCode,
  ScanFileSource,
  ScanPhase,
  ScanPolicySnapshot,
  ScanProgress,
  ScanReport,
  ScanStepResult,
  ScanSummaryEntry,
  SourceRange,
  StartScanInput,
  ValidatedWorkMetadata,
  WorkScanner,
} from './scan/types.js';

/** ZLQ-156 §1.2–§1.5 的 `work.json` 结构，以及包路径/媒体类型的准入判据。 */
export type {
  ArtifactEntry,
  MediaTypeIssue,
  MetadataValidation,
  PathIssue,
  WorkAsset,
  WorkCover,
  WorkFile,
  WorkMetadata,
} from './scan/metadata.js';

/** ZLQ-153 §8.6 两个指标的判读结论（不可谈判项 1、2 落地的地方）。 */
export type {
  CorpusInput,
  CorpusVerdict,
  FalseBlockRateState,
  PrecisionState,
  RuleAnnotation,
  RuleVerdict,
  Shortfall,
  ShortfallKind,
} from './scan/verdict.js';

/** 入口的选项与结果形状。运行时函数本身见文件头说明的缺口。 */
export type {
  IncompleteScanReason,
  ScanPackageOptions,
  ScanRunResult,
  WorkScannerOptions,
} from './scan/index.js';

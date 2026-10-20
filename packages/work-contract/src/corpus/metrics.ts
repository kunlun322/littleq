/**
 * 实测指标层（ZLQ-156 §2.6 + §8.6）。
 *
 * ## 这个模块**不重新实现判据**
 *
 * §8.6 的两个门禁（`false_block_rate ≤2%`、`precision_r ≥98%`）以及三条不可谈判项
 * 的可执行形式已经在 `src/scan/verdict.ts`（D3a 交付）里：`evaluateRule` / `evaluateCorpus`。
 * 本模块的职责是**把实测行折叠成 `CorpusInput` 然后调用它** ——
 * 若在 D3b 里再写一遍 precision 公式，两处就会各自漂移，而「哪个是权威」将无从判断。
 * 唯一由本模块自己算的量，是 `verdict.ts` **结构上算不了**的那些（见下）。
 *
 * ## `verdict.ts` 算不了什么 —— 以及为什么这不是它的缺陷
 *
 * `CorpusInput` 只有三个数字：`safeSamples` / `safeHardBlocked` / 每规则的
 * `(annotatedSamples, hardHits, trueHardBlocks)`。**这里面没有召回项**：
 * 一个「预期硬拦却一次都没报」的假阴性，既不减少 `hardHits`（分母），
 * 也不减少 `trueHardBlocks`（分子，因为它压根没进硬拦集合），
 * 更不影响 `safeHardBlocked`（它不是安全样例）。
 * 于是 `evaluateCorpus` 对假阴性**完全不可见** —— 一份漏检 100% 的语料可以拿到
 * `precision = null` + `ZERO_HARD_HITS`，或者在别的规则上凑出满分的 precision。
 *
 * 但 §2.6 明确要求「**全部预期硬拦样例 100% 检出预期规则**，防止为降低 FPR 整体关闭规则」，
 * §2.4 又要求「返回的实际命中集合必须包含人工要求规则」。
 * 这两条是**召回**判据，只能由本模块实现（`recallGate` / `declaredRuleCoverage`）。
 * 这不是绕过 D3a，而是补上 D3a 的输入形状没有覆盖的那一半 ——
 * 而且本语料**真的踩到了它**：B5 的 `action=""` 家族 10 件全部零命中，
 * `evaluateCorpus` 一声不响，`recallGate` 直接判失败。
 *
 * ## 度量口径的三个决定（都可被复核，都写进报告）
 *
 * 1. **precision 的单位是 (作品, 规则) 去重**（§2.6 原文）。所以计数在
 *    「这件作品有没有报这条规则」这一层，不在 finding 层 ——
 *    同一件作品里 B1 报 3 个 finding 只算 1 次 hardHit。
 * 2. **边界样例不进任何 B 规则指标**（§2.2「压缩炸弹/路径异常是解包门禁集，
 *    不纳入 B 规则 precision 的 TP」）。它们单独成表，且**不从分母里悄悄消失**：
 *    `execution.unaccounted` 必须为 0，`boundary` 的 6 件照样要有实测结果。
 * 3. **总 FPR 计入字段/构建校验的错误拒绝**（§2.6「字段/构建校验也可能伤害学生」），
 *    所以 `ok === false` 的安全样例算误拦；同时单列只由 B 规则硬拦造成的
 *    `bRuleFalseBlockRate`，用于追溯上游定义。传给 `evaluateCorpus` 的是**总**口径。
 */

import { FROZEN_DISPOSITION_CEILING } from '../scan/finding.js';
import { RULES } from '../scan/rules/index.js';
import type { Confidence, Disposition, RuleId } from '../scan/types.js';
import { RULE_IDS } from '../scan/types.js';
import type { CorpusInput, CorpusVerdict, RuleAnnotation } from '../scan/verdict.js';
import { TARGET_FALSE_BLOCK_RATE, TARGET_PRECISION, evaluateCorpus } from '../scan/verdict.js';
import type { AgeBand, WorkType } from '../scan/metadata.js';
import type { AnnotationLabel, CorpusCaseSpec, CorpusKind, Split } from './generator.js';
import type { CaseStatus } from './violations.js';
// `DESIGN_SAFE_TOTAL` 从 manifest 借，不在本模块再声明一次：600 这个数字同时是
// manifest 的配额差表、技术标签折算和下面 `targets` 的分母，两处各写一份必然有一天对不上。
import { DESIGN_SAFE_TOTAL, expectedByRuleOf, highestLabel } from './manifest.js';
import type { TechTag } from './templates.js';
import { TECH_TAGS } from './templates.js';

/** §2.2 的留出安全集设计量。 */
export const DESIGN_SAFE_HOLDOUT = 120;
/** §2.6 的设计口径绝对上限（不是判据本身，判据是 2%）。 */
export const DESIGN_FALSE_BLOCK_CEILING = 12;
export const DESIGN_HOLDOUT_FALSE_BLOCK_CEILING = 2;
/** §2.6 的安全样例确认率目标。 */
export const TARGET_SAFE_CONFIRM_RATE = 0.05;
/** §2.4 的设计违规总量（13 × 60）。 */
export const DESIGN_VIOLATION_TOTAL = 780;
export const DESIGN_VIOLATIONS_PER_RULE = 60;

// ---------------------------------------------------------------------------
// 实测行
// ---------------------------------------------------------------------------

/** 单件样例的扫描结果。**不含任何源片段**（§2.6「不附源片段」）。 */
export type CaseOutcome = {
  /** 扫描是否成功产出报告。false = 超时/解析失败/预算耗尽。 */
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly status: CaseStatus | null;
  /** 报了哪些规则（去重，按 `RULE_IDS` 顺序）。 */
  readonly rules: readonly RuleId[];
  /** 其中处置为 BLOCK 的规则。 */
  readonly blockedRules: readonly RuleId[];
  /** 其中处置为 CONFIRM_REQUIRED 的规则。 */
  readonly confirmedRules: readonly RuleId[];
  /** 恢复出的 subType 串（`ruleId:subType`），用于 X/91 覆盖率。 */
  readonly subTypes: readonly string[];
  readonly findingCount: number;
  readonly durationMs: number;
};

export type MeasuredCase = {
  /** **`buildCase` 返回的那一份**（tags 已 enrich）。 */
  readonly spec: CorpusCaseSpec;
  readonly shard: number;
  readonly packageHash: string;
  readonly outcome: CaseOutcome;
};

// ---------------------------------------------------------------------------
// 执行完整性（§2.6「不从分母移除」）
// ---------------------------------------------------------------------------

export type ExecutionCompleteness = {
  readonly planned: number;
  readonly reported: number;
  /** `ok === false` 的件数。>0 ⇒ 门禁失败（超时/解析失败/缓存损坏都落这里）。 */
  readonly failed: number;
  readonly failedCaseIds: readonly string[];
  /** 计划里没跑到的 caseId。由 `manifest.ts` 的 `planCompleteness` 负责，这里只记件数。 */
  readonly missing: number;
  /** `planned - reported`。必须为 0。 */
  readonly unaccounted: number;
  readonly elapsedMs: number;
  readonly maxCaseMs: number;
  readonly maxCaseId: string | null;
  readonly meanCaseMs: number;
};

// ---------------------------------------------------------------------------
// 每规则测量
// ---------------------------------------------------------------------------

export type RuleMeasurement = {
  readonly ruleId: RuleId;
  readonly frozenCeiling: Disposition;
  /** §2.4 的设计量：该规则主标注的样例数。 */
  readonly designPrimarySamples: number;
  /** 实测：`spec.ruleId === r` 的件数。 */
  readonly primarySamples: number;
  /** 主标注里期望 HARD_BLOCK 的件数。 */
  readonly expectedHardBlock: number;
  /** 主标注里期望 CONFIRM_REQUIRED 的件数。 */
  readonly expectedConfirm: number;
  /** (作品,规则) 去重后的硬拦命中数 = precision 分母。 */
  readonly hardHits: number;
  /** 其中 `expectedByRule[r] === 'HARD_BLOCK'` 的件数 = TP。 */
  readonly trueHardBlocks: number;
  /** `hardHits - trueHardBlocks` = FP。 */
  readonly falseHardBlocks: number;
  /** 期望 HARD_BLOCK 却没报 r 的件数 = FN。 */
  readonly missedHardBlocks: number;
  readonly missedCaseIds: readonly string[];
  /** 期望 HARD_BLOCK 报了 r、但处置被降成 CONFIRM_REQUIRED 的件数（诊断，不计入 FP）。 */
  readonly dispositionDowngrades: number;
  /** 召回 = (expectedHardBlock - missedHardBlocks) / expectedHardBlock。分母 0 ⇒ null。 */
  readonly recall: number | null;
  readonly annotatedSamples: number;
};

// ---------------------------------------------------------------------------
// 召回门禁（§2.6「全部预期硬拦样例 100% 检出预期规则」）
// ---------------------------------------------------------------------------

export type RecallGate = {
  readonly targetRecall: 1;
  readonly expectedHardBlockPairs: number;
  readonly detectedPairs: number;
  readonly missedPairs: number;
  readonly pass: boolean;
  readonly perRule: readonly { ruleId: RuleId; expected: number; missed: number }[];
  readonly missedCaseIds: readonly string[];
};

/** §2.4「返回的实际命中集合必须包含人工要求规则」的逐件核对。 */
export type DeclaredRuleCoverage = {
  readonly violationCases: number;
  readonly fullyCovered: number;
  readonly incomplete: number;
  readonly pass: boolean;
  readonly problems: readonly { caseId: string; missing: readonly RuleId[] }[];
};

// ---------------------------------------------------------------------------
// 12 格分龄/类型（§2.6）
// ---------------------------------------------------------------------------

export type CellMeasurement = {
  readonly ageBand: AgeBand;
  readonly workType: WorkType;
  readonly safeTotal: number;
  readonly safeHardBlocked: number;
  readonly safeFalseBlockRate: number | null;
  readonly safeConfirm: number;
  readonly safeConfirmRate: number | null;
  readonly violationTotal: number;
  readonly total: number;
};

// ---------------------------------------------------------------------------
// subType 覆盖率
// ---------------------------------------------------------------------------

export type SubTypeCoverage = {
  /** 注册表声明的 (ruleId, subType) 槽位总数。 */
  readonly declaredTotal: number;
  /** 实测出现过的槽位数。 */
  readonly measuredTotal: number;
  readonly ratio: number;
  /** 未测到的槽位，逐条列出 —— §2.4 的「至少 6 种实现族」是靠这个表核对的。 */
  readonly unmeasured: readonly { ruleId: RuleId; subType: string }[];
  readonly perRule: readonly {
    ruleId: RuleId;
    declared: number;
    measured: number;
    unmeasured: readonly string[];
  }[];
};

// ---------------------------------------------------------------------------
// 技术标签覆盖（§2.2）
// ---------------------------------------------------------------------------

export type TechTagQuota = {
  readonly quotaLabel: string;
  readonly tags: readonly TechTag[];
  /** §2.2 的设计下限（对 600 件安全集）。null = 规格只要求「覆盖」，不给数。 */
  readonly designMinimum: number | null;
};

/** §2.2 的计数配额。设计量是对 **600** 件安全集说的；实测只有 240 ⇒ 按比例折算一列。 */
export const TECH_TAG_COUNT_QUOTAS: readonly TechTagQuota[] = [
  { quotaLabel: 'DOM/事件', tags: ['dom-events'], designMinimum: 120 },
  { quotaLabel: 'Canvas', tags: ['canvas2d'], designMinimum: 120 },
  { quotaLabel: 'WebGL', tags: ['webgl'], designMinimum: 36 },
  { quotaLabel: 'Web Audio/本地媒体', tags: ['web-audio'], designMinimum: 72 },
  { quotaLabel: 'Storage', tags: ['storage'], designMinimum: 120 },
  { quotaLabel: 'SVG', tags: ['svg'], designMinimum: 48 },
  { quotaLabel: '中文', tags: ['zh-copy', 'zh-en-mixed'], designMinimum: 360 },
  { quotaLabel: '中英混合', tags: ['zh-en-mixed'], designMinimum: 120 },
];

/**
 * §2.2 的「覆盖」清单：只要求 ≥1 件，不给计数下限。
 * 「不依赖 rewrite」对应 `hash-route` + `history-state` 两个标签。
 */
export const TECH_TAG_COVERAGE_REQUIRED: readonly TechTagQuota[] = [
  { quotaLabel: 'hash 路由', tags: ['hash-route'], designMinimum: null },
  { quotaLabel: 'history 状态', tags: ['history-state'], designMinimum: null },
  { quotaLabel: '不依赖 rewrite', tags: ['hash-route', 'history-state'], designMinimum: null },
  { quotaLabel: '模板字符串', tags: ['template-string'], designMinimum: null },
  { quotaLabel: '多文件依赖', tags: ['multi-file'], designMinimum: null },
  { quotaLabel: '内联 CSP hash', tags: ['inline-csp-hash'], designMinimum: null },
  { quotaLabel: '合法 data', tags: ['legal-data-url'], designMinimum: null },
  { quotaLabel: '合法 blob', tags: ['legal-blob-url'], designMinimum: null },
  { quotaLabel: '键盘', tags: ['keyboard'], designMinimum: null },
  { quotaLabel: '触屏', tags: ['touch'], designMinimum: null },
  { quotaLabel: '许可注释', tags: ['license-note'], designMinimum: null },
  {
    quotaLabel: '可读源 + minified 产物',
    tags: ['readable-source-plus-minified'],
    designMinimum: null,
  },
];

export type TechTagMeasurement = {
  readonly quotaLabel: string;
  readonly tags: readonly string[];
  readonly designMinimum: number | null;
  /** 设计下限按实测安全集规模折算后的值（`designMinimum × safeTotal / 600`）。 */
  readonly scaledMinimum: number | null;
  readonly measured: number;
  readonly pass: boolean | null;
};

// ---------------------------------------------------------------------------
// 配额差
// ---------------------------------------------------------------------------

export type QuotaDelta = {
  readonly dimension: string;
  readonly design: number;
  readonly measured: number;
  readonly delta: number;
  readonly note: string;
};

// ---------------------------------------------------------------------------
// shard 实测
// ---------------------------------------------------------------------------

export type ShardMeasurement = {
  readonly shard: number;
  readonly cases: number;
  readonly families: number;
  readonly elapsedMs: number;
  readonly maxCaseMs: number;
  readonly meanCaseMs: number;
};

/**
 * CI 预算判定。§2.6 给的是「热 CI ≤3min、冷 ≤5min」，
 * 但那是**在 CI 机器上**的墙钟时间；本单跑在开发机上，
 * 所以这里判定的是「本地实测的单片墙钟」并**显式声明它不是 CI 实测**。
 */
export type ShardBudget = {
  readonly shardCount: number;
  readonly hotTargetMs: number;
  readonly coldTargetMs: number;
  readonly slowestShardMs: number;
  readonly slowestShard: number;
  readonly totalMs: number;
  readonly serialMs: number;
  /** 本地口径下最慢一片是否在热预算内。CI 口径需要真实 runner 数据，见 `measuredOn`。 */
  readonly localSlowestWithinHotTarget: boolean;
  readonly measuredOn: 'local-dev-machine';
  readonly caveat: string;
};

// ---------------------------------------------------------------------------
// Wilson 区间（§2.6「可附 Wilson 置信区间作为观察，不改变 ≤2% 判据」）
// ---------------------------------------------------------------------------

export type WilsonInterval = {
  readonly successes: number;
  readonly trials: number;
  readonly point: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly z: number;
};

/**
 * Wilson score interval。**只作观察**：§2.6 明说「不改变 ≤2% 判据」。
 * 放在报告里的理由是诚实而不是辩护 —— 240 件上 0 次误拦的点估计是 0%，
 * 但 95% 区间上界约 1.5%，也就是说这份语料**证明不了**线上误拦率低于 2%，
 * 它只证明了「在这 240 件上没有观察到误拦」。把区间写出来，
 * 读者才不会把 0% 当成总体结论（§2.6「FPR 数字是基准测量，不是线上总体误报率证明」）。
 */
export function wilsonInterval(successes: number, trials: number, z = 1.96): WilsonInterval {
  if (!Number.isInteger(trials) || trials <= 0) {
    return { successes, trials, point: null, lower: null, upper: null, z };
  }
  const point = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (point + (z * z) / (2 * trials)) / denominator;
  const half =
    (z * Math.sqrt((point * (1 - point)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return {
    successes,
    trials,
    point,
    lower: Math.max(0, centre - half),
    upper: Math.min(1, centre + half),
    z,
  };
}

// ---------------------------------------------------------------------------
// 主测量
// ---------------------------------------------------------------------------

export type CorpusMeasurementOptions = {
  readonly corpusVersion: string;
  readonly scannerVersion: string;
  readonly rulesetVersion: string;
  readonly rulesetFingerprintHash: string;
  readonly annotationMode: string;
  readonly shardCount: number;
  /** 计划件数。不给就用 `cases.length`（此时 `missing` 只能是 0，报告里要说明）。 */
  readonly plannedCaseCount?: number;
  readonly plannedCaseIds?: readonly string[];
};

export type CorpusMeasurement = {
  readonly versions: {
    readonly corpusVersion: string;
    readonly scannerVersion: string;
    readonly rulesetVersion: string;
    readonly rulesetFingerprintHash: string;
    readonly annotationMode: string;
  };
  /** 判据常量。写进报告是为了让「达标」这句话有可核对的分母，而不是一个形容词。 */
  readonly targets: {
    readonly falseBlockRate: number;
    readonly precision: number;
    readonly safeConfirmRate: number;
    readonly recall: number;
    readonly designSafeTotal: number;
    readonly designViolationTotal: number;
  };
  readonly execution: ExecutionCompleteness;
  readonly composition: {
    readonly total: number;
    readonly safe: number;
    readonly violation: number;
    readonly boundary: number;
    readonly dev: number;
    readonly holdout: number;
    readonly families: number;
    readonly safeFamilies: number;
    readonly violationFamilies: number;
    readonly boundaryFamilies: number;
    readonly safeDev: number;
    readonly safeHoldout: number;
    readonly violationDev: number;
    readonly violationHoldout: number;
  };
  /** §8.6 的判读，**由 `evaluateCorpus` 给出**，不是本模块重算的。 */
  readonly verdict: CorpusVerdict;
  readonly rules: readonly RuleMeasurement[];
  readonly recallGate: RecallGate;
  readonly declaredRuleCoverage: DeclaredRuleCoverage;
  readonly b12: {
    readonly hardBlocks: number;
    readonly primarySamples: number;
    readonly confirmedAsExpected: number;
    readonly notConfirmedCaseIds: readonly string[];
    readonly pass: boolean;
  };
  readonly lowConfidenceConfirm: {
    readonly targetRules: readonly RuleId[];
    readonly expectedConfirmSamples: number;
    readonly confirmedAsExpected: number;
    readonly notConfirmedCaseIds: readonly string[];
    readonly pass: boolean;
  };
  readonly safeConfirmRate: {
    readonly safeTotal: number;
    readonly confirmed: number;
    readonly rate: number | null;
    readonly target: number;
    readonly pass: boolean | null;
  };
  readonly falseBlockRate: {
    readonly total: {
      readonly safeSamples: number;
      readonly safeHardBlocked: number;
      readonly rate: number | null;
      readonly target: number;
      readonly pass: boolean | null;
      readonly designCeiling: number;
      readonly scaledCeiling: number;
      readonly wilson: WilsonInterval;
    };
    readonly holdout: {
      readonly safeSamples: number;
      readonly safeHardBlocked: number;
      readonly rate: number | null;
      readonly target: number;
      readonly pass: boolean | null;
      readonly designCeiling: number;
      readonly scaledCeiling: number;
    };
    /** 只由 B 规则硬拦造成的误拦（不含字段/构建校验拒绝）。 */
    readonly bRuleOnly: {
      readonly safeSamples: number;
      readonly safeHardBlocked: number;
      readonly rate: number | null;
    };
    readonly blockedSafeCaseIds: readonly string[];
    readonly rejectedSafeCaseIds: readonly string[];
  };
  readonly cells: readonly CellMeasurement[];
  readonly subTypeCoverage: SubTypeCoverage;
  readonly techTags: {
    readonly safeTotal: number;
    readonly countQuotas: readonly TechTagMeasurement[];
    readonly coverageRequired: readonly TechTagMeasurement[];
    readonly perTag: readonly { tag: string; count: number }[];
    readonly untaggedSafeCases: number;
  };
  readonly quotaDeltas: readonly QuotaDelta[];
  readonly shards: readonly ShardMeasurement[];
  readonly shardBudget: ShardBudget;
  readonly splits: {
    readonly familyLeakage: readonly string[];
    readonly leakFree: boolean;
  };
  /** 本模块自己加的门禁（`verdict.shortfalls` 之外的部分）。 */
  readonly extraGates: readonly { name: string; pass: boolean; detail: string }[];
  readonly overall: {
    readonly pass: boolean;
    readonly failures: readonly string[];
  };
};

function scaleCeiling(designCeiling: number, measuredTotal: number): number {
  return (designCeiling / DESIGN_SAFE_TOTAL) * measuredTotal;
}

/**
 * 把实测行折叠成完整测量。**纯函数**（除了读入参），不读时钟、不读环境。
 */
export function measureCorpus(
  cases: readonly MeasuredCase[],
  options: CorpusMeasurementOptions,
): CorpusMeasurement {
  // ---- 期望标签表 --------------------------------------------------------
  // 逐 (作品, 规则) 的期望标签由 `manifest.ts` 的 `expectedByRuleOf` 给出 —— 单一来源，
  // 免得指标层和 manifest 层各推一套而对不上。这里先算好缓存，下面要查 13×1026 次。
  const labelsOf = new Map<string, Readonly<Record<RuleId, AnnotationLabel>>>();
  for (const row of cases) labelsOf.set(row.spec.caseId, expectedByRuleOf(row.spec));
  const labelOf = (row: MeasuredCase, ruleId: RuleId): AnnotationLabel =>
    labelsOf.get(row.spec.caseId)?.[ruleId] ?? 'NOT_APPLICABLE';

  // ---- 执行完整性 --------------------------------------------------------
  const planned = options.plannedCaseCount ?? cases.length;
  const failedRows = cases.filter((row) => !row.outcome.ok);
  let elapsedMs = 0;
  let maxCaseMs = -1;
  let maxCaseId: string | null = null;
  for (const row of cases) {
    elapsedMs += row.outcome.durationMs;
    if (row.outcome.durationMs > maxCaseMs) {
      maxCaseMs = row.outcome.durationMs;
      maxCaseId = row.spec.caseId;
    }
  }
  const plannedIds = new Set(options.plannedCaseIds ?? cases.map((row) => row.spec.caseId));
  let missing = 0;
  const reportedIds = new Set<string>();
  for (const row of cases) reportedIds.add(row.spec.caseId);
  for (const id of plannedIds) if (!reportedIds.has(id)) missing += 1;

  const execution: ExecutionCompleteness = {
    planned,
    reported: cases.length,
    failed: failedRows.length,
    failedCaseIds: failedRows.map((row) => row.spec.caseId),
    missing,
    unaccounted: planned - cases.length,
    elapsedMs,
    maxCaseMs: maxCaseMs < 0 ? 0 : maxCaseMs,
    maxCaseId,
    meanCaseMs: cases.length === 0 ? 0 : elapsedMs / cases.length,
  };

  // ---- 组成 --------------------------------------------------------------
  const inScope = cases.filter((row) => row.spec.kind !== 'boundary');
  const safeRows = inScope.filter((row) => row.spec.kind === 'safe');
  const violationRows = inScope.filter((row) => row.spec.kind === 'violation');
  const boundaryRows = cases.filter((row) => row.spec.kind === 'boundary');
  const families = new Set(cases.map((row) => row.spec.familyId));
  const familyKind = new Map<string, CorpusKind>();
  for (const row of cases) familyKind.set(row.spec.familyId, row.spec.kind);

  const composition = {
    total: cases.length,
    safe: safeRows.length,
    violation: violationRows.length,
    boundary: boundaryRows.length,
    dev: cases.filter((row) => row.spec.split === 'dev').length,
    holdout: cases.filter((row) => row.spec.split === 'holdout').length,
    families: families.size,
    safeFamilies: [...familyKind.values()].filter((kind) => kind === 'safe').length,
    violationFamilies: [...familyKind.values()].filter((kind) => kind === 'violation').length,
    boundaryFamilies: [...familyKind.values()].filter((kind) => kind === 'boundary').length,
    safeDev: safeRows.filter((row) => row.spec.split === 'dev').length,
    safeHoldout: safeRows.filter((row) => row.spec.split === 'holdout').length,
    violationDev: violationRows.filter((row) => row.spec.split === 'dev').length,
    violationHoldout: violationRows.filter((row) => row.spec.split === 'holdout').length,
  };

  // ---- 切分不泄漏（§2.2）-------------------------------------------------
  const splitOfFamily = new Map<string, Split>();
  const familyLeakage: string[] = [];
  for (const row of cases) {
    const seen = splitOfFamily.get(row.spec.familyId);
    if (seen === undefined) splitOfFamily.set(row.spec.familyId, row.spec.split);
    else if (seen !== row.spec.split) familyLeakage.push(row.spec.familyId);
  }

  // ---- 误拦（§2.6）-------------------------------------------------------
  const blockedSafe = safeRows.filter((row) => row.outcome.ok && row.outcome.status === 'BLOCK');
  const rejectedSafe = safeRows.filter((row) => !row.outcome.ok);
  const totalSafeHardBlocked = blockedSafe.length + rejectedSafe.length;
  const bRuleSafeHardBlocked = safeRows.filter(
    (row) => row.outcome.ok && row.outcome.blockedRules.length > 0,
  ).length;
  const holdoutSafe = safeRows.filter((row) => row.spec.split === 'holdout');
  const holdoutSafeBlocked = holdoutSafe.filter(
    (row) => !row.outcome.ok || row.outcome.status === 'BLOCK',
  );

  const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d);
  const scaledCeilingAll = scaleCeiling(DESIGN_FALSE_BLOCK_CEILING, safeRows.length);
  const scaledCeilingHoldout = scaleCeiling(DESIGN_HOLDOUT_FALSE_BLOCK_CEILING, holdoutSafe.length);

  const falseBlockRate = {
    total: {
      safeSamples: safeRows.length,
      safeHardBlocked: totalSafeHardBlocked,
      rate: rate(totalSafeHardBlocked, safeRows.length),
      target: TARGET_FALSE_BLOCK_RATE,
      pass:
        safeRows.length === 0
          ? null
          : totalSafeHardBlocked / safeRows.length <= TARGET_FALSE_BLOCK_RATE,
      designCeiling: DESIGN_FALSE_BLOCK_CEILING,
      scaledCeiling: scaledCeilingAll,
      wilson: wilsonInterval(totalSafeHardBlocked, safeRows.length),
    },
    holdout: {
      safeSamples: holdoutSafe.length,
      safeHardBlocked: holdoutSafeBlocked.length,
      rate: rate(holdoutSafeBlocked.length, holdoutSafe.length),
      target: TARGET_FALSE_BLOCK_RATE,
      pass:
        holdoutSafe.length === 0
          ? null
          : holdoutSafeBlocked.length / holdoutSafe.length <= TARGET_FALSE_BLOCK_RATE,
      designCeiling: DESIGN_HOLDOUT_FALSE_BLOCK_CEILING,
      scaledCeiling: scaledCeilingHoldout,
    },
    bRuleOnly: {
      safeSamples: safeRows.length,
      safeHardBlocked: bRuleSafeHardBlocked,
      rate: rate(bRuleSafeHardBlocked, safeRows.length),
    },
    blockedSafeCaseIds: blockedSafe.map((row) => row.spec.caseId),
    rejectedSafeCaseIds: rejectedSafe.map((row) => row.spec.caseId),
  };

  // ---- 每规则 ------------------------------------------------------------
  const rules: RuleMeasurement[] = RULE_IDS.map((ruleId) => {
    const primary = inScope.filter((row) => row.spec.ruleId === ruleId);
    const expectedHardRows = inScope.filter((row) => labelOf(row, ruleId) === 'HARD_BLOCK');
    const hardHitRows = inScope.filter((row) => row.outcome.blockedRules.includes(ruleId));
    const trueRows = hardHitRows.filter((row) => labelOf(row, ruleId) === 'HARD_BLOCK');
    const missedRows = expectedHardRows.filter((row) => !row.outcome.rules.includes(ruleId));
    const downgrades = expectedHardRows.filter(
      (row) => row.outcome.rules.includes(ruleId) && !row.outcome.blockedRules.includes(ruleId),
    );
    const expectedHardBlock = expectedHardRows.length;
    return {
      ruleId,
      frozenCeiling: FROZEN_DISPOSITION_CEILING[ruleId],
      designPrimarySamples: DESIGN_VIOLATIONS_PER_RULE,
      primarySamples: primary.length,
      expectedHardBlock,
      expectedConfirm: primary.filter(
        (row) => row.spec.expectation.expectedDisposition === 'CONFIRM_REQUIRED',
      ).length,
      hardHits: hardHitRows.length,
      trueHardBlocks: trueRows.length,
      falseHardBlocks: hardHitRows.length - trueRows.length,
      missedHardBlocks: missedRows.length,
      missedCaseIds: missedRows.map((row) => row.spec.caseId),
      dispositionDowngrades: downgrades.length,
      recall: rate(expectedHardBlock - missedRows.length, expectedHardBlock),
      annotatedSamples: inScope.filter((row) => labelOf(row, ruleId) !== 'NOT_APPLICABLE').length,
    };
  });

  // ---- 召回门禁 ----------------------------------------------------------
  const expectedHardBlockPairs = rules.reduce((sum, r) => sum + r.expectedHardBlock, 0);
  const missedPairs = rules.reduce((sum, r) => sum + r.missedHardBlocks, 0);
  const missedCaseIds = [...new Set(rules.flatMap((r) => r.missedCaseIds))].sort();
  const recallGate: RecallGate = {
    targetRecall: 1,
    expectedHardBlockPairs,
    detectedPairs: expectedHardBlockPairs - missedPairs,
    missedPairs,
    pass: missedPairs === 0,
    perRule: rules
      .filter((r) => r.expectedHardBlock > 0)
      .map((r) => ({
        ruleId: r.ruleId,
        expected: r.expectedHardBlock,
        missed: r.missedHardBlocks,
      })),
    missedCaseIds,
  };

  const declaredProblems = violationRows
    .map((row) => ({
      caseId: row.spec.caseId,
      missing: row.spec.expectation.expectedRules.filter(
        (ruleId) => !row.outcome.rules.includes(ruleId),
      ),
    }))
    .filter((entry) => entry.missing.length > 0);
  const declaredRuleCoverage: DeclaredRuleCoverage = {
    violationCases: violationRows.length,
    fullyCovered: violationRows.length - declaredProblems.length,
    incomplete: declaredProblems.length,
    pass: declaredProblems.length === 0,
    problems: declaredProblems,
  };

  // ---- B12（不可谈判项 ②）------------------------------------------------
  const b12Rows = inScope.filter((row) => row.spec.ruleId === 'B12');
  const b12Hard = inScope.filter((row) => row.outcome.blockedRules.includes('B12'));
  const b12NotConfirmed = b12Rows.filter((row) => row.outcome.status !== 'CONFIRM_REQUIRED');
  const b12 = {
    hardBlocks: b12Hard.length,
    primarySamples: b12Rows.length,
    confirmedAsExpected: b12Rows.length - b12NotConfirmed.length,
    notConfirmedCaseIds: b12NotConfirmed.map((row) => row.spec.caseId),
    pass: b12Hard.length === 0 && b12NotConfirmed.length === 0,
  };

  // ---- B8/B13 低置信集（§2.6「100% 按确认处理」）--------------------------
  const lowConfidenceRules: readonly RuleId[] = ['B8', 'B13'];
  const lowRows = inScope.filter(
    (row) =>
      row.spec.ruleId !== null &&
      lowConfidenceRules.includes(row.spec.ruleId) &&
      row.spec.expectation.expectedDisposition === 'CONFIRM_REQUIRED',
  );
  const lowNotConfirmed = lowRows.filter((row) => row.outcome.status !== 'CONFIRM_REQUIRED');
  const lowConfidenceConfirm = {
    targetRules: lowConfidenceRules,
    expectedConfirmSamples: lowRows.length,
    confirmedAsExpected: lowRows.length - lowNotConfirmed.length,
    notConfirmedCaseIds: lowNotConfirmed.map((row) => row.spec.caseId),
    pass: lowNotConfirmed.length === 0,
  };

  // ---- 安全样例确认率（§2.6 ≤5%）-----------------------------------------
  const safeConfirmed = safeRows.filter((row) => row.outcome.status === 'CONFIRM_REQUIRED');
  const safeConfirmRate = {
    safeTotal: safeRows.length,
    confirmed: safeConfirmed.length,
    rate: rate(safeConfirmed.length, safeRows.length),
    target: TARGET_SAFE_CONFIRM_RATE,
    pass:
      safeRows.length === 0
        ? null
        : safeConfirmed.length / safeRows.length <= TARGET_SAFE_CONFIRM_RATE,
  };

  // ---- 12 格 -------------------------------------------------------------
  const cellKeys = new Map<string, CellMeasurement>();
  for (const row of cases) {
    const cell = row.spec.cell;
    if (cell === null) continue;
    const key = `${cell.ageBand}|${cell.workType}`;
    let entry = cellKeys.get(key);
    if (entry === undefined) {
      entry = {
        ageBand: cell.ageBand,
        workType: cell.workType,
        safeTotal: 0,
        safeHardBlocked: 0,
        safeFalseBlockRate: null,
        safeConfirm: 0,
        safeConfirmRate: null,
        violationTotal: 0,
        total: 0,
      };
      cellKeys.set(key, entry);
    }
    const next: CellMeasurement = {
      ...entry,
      total: entry.total + 1,
      safeTotal: entry.safeTotal + (row.spec.kind === 'safe' ? 1 : 0),
      safeHardBlocked:
        entry.safeHardBlocked +
        (row.spec.kind === 'safe' && (!row.outcome.ok || row.outcome.status === 'BLOCK') ? 1 : 0),
      safeConfirm:
        entry.safeConfirm +
        (row.spec.kind === 'safe' && row.outcome.status === 'CONFIRM_REQUIRED' ? 1 : 0),
      violationTotal: entry.violationTotal + (row.spec.kind === 'violation' ? 1 : 0),
    };
    cellKeys.set(key, next);
  }
  const cells: CellMeasurement[] = [...cellKeys.values()]
    .map((entry) => ({
      ...entry,
      safeFalseBlockRate: rate(entry.safeHardBlocked, entry.safeTotal),
      safeConfirmRate: rate(entry.safeConfirm, entry.safeTotal),
    }))
    .sort((a, b) =>
      a.ageBand === b.ageBand
        ? a.workType.localeCompare(b.workType)
        : a.ageBand.localeCompare(b.ageBand),
    );

  // ---- subType 覆盖率 ----------------------------------------------------
  const observed = new Set<string>();
  for (const row of cases) for (const sub of row.outcome.subTypes) observed.add(sub);
  const perRuleSub: {
    ruleId: RuleId;
    declared: number;
    measured: number;
    unmeasured: string[];
  }[] = [];
  const unmeasured: { ruleId: RuleId; subType: string }[] = [];
  let declaredTotal = 0;
  for (const rule of RULES) {
    const declared = rule.subTypes.length;
    declaredTotal += declared;
    const missingSubs: string[] = [];
    let measured = 0;
    for (const subType of rule.subTypes) {
      const key = `${rule.id}:${subType}`;
      if (observed.has(key)) measured += 1;
      else {
        missingSubs.push(subType);
        unmeasured.push({ ruleId: rule.id, subType });
      }
    }
    perRuleSub.push({ ruleId: rule.id, declared, measured, unmeasured: missingSubs });
  }
  const subTypeCoverage: SubTypeCoverage = {
    declaredTotal,
    measuredTotal: declaredTotal - unmeasured.length,
    ratio: declaredTotal === 0 ? 0 : (declaredTotal - unmeasured.length) / declaredTotal,
    unmeasured,
    perRule: perRuleSub,
  };

  // ---- 技术标签 ----------------------------------------------------------
  // 口径是**样例数**，不是标签出现次数，所以要先把每件样例的标签去重成集合：
  // 「中文」这一行是 `zh-copy ∪ zh-en-mixed` 的交叉档，按标签求和会把同时带两个
  // 标签的样例数两遍；`zh-en-mixed` 又同时出现在「中文」与「中英混合」两行里，
  // 求和后两行相加甚至能超过安全集总量 —— 那种数字看着像超额达标，其实没有口径。
  const safeTagSets = safeRows.map(
    (row) => new Set(row.spec.tags.filter((tag) => (TECH_TAGS as readonly string[]).includes(tag))),
  );
  const tagCounts = new Map<string, number>();
  for (const tag of TECH_TAGS) tagCounts.set(tag, 0);
  let untaggedSafeCases = 0;
  for (const tags of safeTagSets) {
    if (tags.size === 0) untaggedSafeCases += 1;
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const measureQuota = (quota: TechTagQuota): TechTagMeasurement => {
    const measured = safeTagSets.filter((tags) => quota.tags.some((tag) => tags.has(tag))).length;
    // 设计的配额分母是 §2.2 的 600 件安全样例；本单只产出 240 件（§2.1 的第二档），
    // 所以按实测规模等比折算，**并同时报出未折算的原值**，免得「折算后达标」被读成
    // 「设计配额已满足」—— 折算只是让缺口可比，不是把缺口抹掉（不可谈判项 3）。
    const scaledMinimum =
      quota.designMinimum === null
        ? null
        : (quota.designMinimum * safeRows.length) / DESIGN_SAFE_TOTAL;
    return {
      quotaLabel: quota.quotaLabel,
      tags: [...quota.tags],
      designMinimum: quota.designMinimum,
      scaledMinimum,
      measured,
      pass: scaledMinimum === null ? measured >= 1 : measured >= scaledMinimum,
    };
  };

  // ---- 配额差 ------------------------------------------------------------
  // §2.4 的分层设计说的是**样例件数**（每条规则 60 件，其中 B8/B13 各 50 硬拦 + 10 确认，
  // B12 60 件全确认），所以对账也按件数来。这两个数只数违规样例的主标注处置，
  // 与 `expectations.disposition` 同源，两处必须相等 —— 聚合 runner 会各算一遍。
  const designHardBlockCases = violationRows.filter(
    (row) => row.spec.expectation.expectedDisposition === 'BLOCK',
  ).length;
  const designConfirmCases = violationRows.filter(
    (row) => row.spec.expectation.expectedDisposition === 'CONFIRM_REQUIRED',
  ).length;
  const quotaDeltas: QuotaDelta[] = [
    {
      dimension: '§2.1 安全集总量',
      design: DESIGN_SAFE_TOTAL,
      measured: safeRows.length,
      delta: safeRows.length - DESIGN_SAFE_TOTAL,
      note: '设计 600 = 240 人工 + 240 模板生成 + 120 公共示例移植；本单只产出模板生成档',
    },
    {
      dimension: '§2.1 来源档：团队人工制作教学示例',
      design: 240,
      measured: 0,
      delta: -240,
      note: '未产出（人工制作不能由自动化开发跑产出；用生成器冒充即造假）',
    },
    {
      dimension: '§2.1 来源档：本地确定性模板生成与人工变体',
      design: 240,
      measured: safeRows.length,
      delta: safeRows.length - 240,
      note: '本单产出的唯一档；固定 seeds，可复算',
    },
    {
      dimension: '§2.1 来源档：可控许可明确的公共示例移植',
      design: 120,
      measured: 0,
      delta: -120,
      note: '未产出（逐条许可核实是人工动作；未核实先落盘 = 未经授权的供应链动作）',
    },
    {
      dimension: '§2.2 每格安全样例（12 格 × 50）',
      design: 50,
      measured: cells.length === 0 ? 0 : Math.min(...cells.map((cell) => cell.safeTotal)),
      delta: (cells.length === 0 ? 0 : Math.min(...cells.map((cell) => cell.safeTotal))) - 50,
      note: '实测每格 20 件；dev/holdout 设计 40/10，实测按家族切分（见 `composition`）',
    },
    {
      dimension: '§2.2 留出安全集',
      design: DESIGN_SAFE_HOLDOUT,
      measured: composition.safeHoldout,
      delta: composition.safeHoldout - DESIGN_SAFE_HOLDOUT,
      note: '按家族切分，不是按件随机切；同一家族不跨侧（`splits.familyLeakage` 为空即证明）',
    },
    {
      dimension: '§2.4 违规集总量（13 × 60）',
      design: DESIGN_VIOLATION_TOTAL,
      measured: violationRows.length,
      delta: violationRows.length - DESIGN_VIOLATION_TOTAL,
      note: '单点变异，逐规则 60 件',
    },
    {
      // 单位必须与设计的 700 一致 —— 都是**样例件数**。
      // 不能拿 `rules[].expectedHardBlock` 的和来比：那是 (作品,规则) 去重**对**数
      // （一件违规样例可以同时被要求硬拦另一条规则，见 `expectedOtherRules`），
      // 实测 774 对 vs 设计 700 件，差值 +74 是单位错配的产物，读起来像「多拦了 74 件」。
      // 对数本身不是错的，它是 precision/recall 的分母，已经单独出现在
      // `recallGate.expectedHardBlockPairs`；这里只放件数。
      dimension: '§2.4 期望 HARD_BLOCK 样例件数（设计 700 = 780 − B12 60 − B8 10 − B13 10）',
      design: 700,
      measured: designHardBlockCases,
      delta: designHardBlockCases - 700,
      note:
        '少的 36 件与下一行「期望 CONFIRM_REQUIRED 多 36 件」是同一批样例，不是丢失：' +
        'B2 online-probe 10、B7 storage-key-unprefixed 10、B7 storage-database-probe 10、' +
        'B9 mining-term 3、B9 tracking-term 3。这些变体轮换到的词表条目在冻结词表里就是 ' +
        'LOW 档，判定面只给 CONFIRM_REQUIRED；标成 HARD_BLOCK 等于替扫描器承诺它没承诺的事。' +
        '逐规则对账见 `expectations.designDeltaPerRule`，缺口声明见 `hard-block-design-vs-lexicon-tier`。',
    },
    {
      dimension: '§2.4 期望 CONFIRM_REQUIRED 样例件数（设计 80 = B12 60 + B8 10 + B13 10）',
      design: 80,
      measured: designConfirmCases,
      delta: designConfirmCases - 80,
      note:
        '实测偏多的 36 件逐规则列在 `expectations.designDeltaPerRule`；' +
        '每一处都由冻结词表的 tier 决定，不是随手声明的标签',
    },
    {
      dimension: '§2.2 边界样例（above 侧）',
      design: 5,
      measured: 0,
      delta: -5,
      note:
        '总量/压缩量/单文件/文件数/深度 的「高于上限」侧未产出：路径深度越界在 schema 层就被拒' +
        '（测不到 B1 的 path-too-deep 分支），体积/文件数越界需要在 16 shard 里真分配十几兆字节',
    },
  ];

  // ---- shard 实测 --------------------------------------------------------
  const shardRows = new Map<number, MeasuredCase[]>();
  for (const row of cases) {
    const bucket = shardRows.get(row.shard);
    if (bucket === undefined) shardRows.set(row.shard, [row]);
    else bucket.push(row);
  }
  const shards: ShardMeasurement[] = [...shardRows.entries()]
    .map(([shard, rows]) => {
      const elapsed = rows.reduce((sum, r) => sum + r.outcome.durationMs, 0);
      const max = rows.reduce((m, r) => Math.max(m, r.outcome.durationMs), 0);
      return {
        shard,
        cases: rows.length,
        families: new Set(rows.map((r) => r.spec.familyId)).size,
        elapsedMs: elapsed,
        maxCaseMs: max,
        meanCaseMs: rows.length === 0 ? 0 : elapsed / rows.length,
      };
    })
    .sort((a, b) => a.shard - b.shard);
  const slowest = shards.reduce<ShardMeasurement | null>(
    (best, entry) => (best === null || entry.elapsedMs > best.elapsedMs ? entry : best),
    null,
  );
  const shardBudget: ShardBudget = {
    shardCount: options.shardCount,
    hotTargetMs: 180_000,
    coldTargetMs: 300_000,
    slowestShardMs: slowest?.elapsedMs ?? 0,
    slowestShard: slowest?.shard ?? -1,
    totalMs: elapsedMs,
    serialMs: elapsedMs,
    localSlowestWithinHotTarget: (slowest?.elapsedMs ?? 0) <= 180_000,
    measuredOn: 'local-dev-machine',
    caveat:
      '本地开发机顺序执行的墙钟时间，**不是** CI runner 上的实测。§2.6 的热 ≤3min / 冷 ≤5min ' +
      '判据必须在真实 runner 上回填；本地数字只能证明「量级上不像会超」，不能证明达标。',
  };

  // ---- 交给 verdict.ts 判读（§8.6）--------------------------------------
  const corpusInput: CorpusInput = {
    safeSamples: safeRows.length,
    safeHardBlocked: totalSafeHardBlocked,
    rules: rules.map(
      (r): RuleAnnotation => ({
        ruleId: r.ruleId,
        annotatedSamples: r.annotatedSamples,
        hardHits: r.hardHits,
        trueHardBlocks: r.trueHardBlocks,
      }),
    ),
  };
  const verdict = evaluateCorpus(corpusInput);

  // ---- 本模块自己的门禁 --------------------------------------------------
  const extraGates = [
    {
      name: 'execution-complete',
      pass: execution.unaccounted === 0 && execution.missing === 0 && execution.failed === 0,
      detail:
        `planned ${execution.planned} / reported ${execution.reported} / failed ${execution.failed}` +
        ` / missing ${execution.missing} / unaccounted ${execution.unaccounted}` +
        '（§2.6：超时、解析失败、缺 shard、缓存损坏、跳过样例直接令 CI 失败，不从分母移除）',
    },
    {
      name: 'recall-all-expected-hard-blocks',
      pass: recallGate.pass,
      detail:
        `期望硬拦 (作品,规则) 对 ${recallGate.expectedHardBlockPairs}，检出 ${recallGate.detectedPairs}，` +
        `漏检 ${recallGate.missedPairs}（§2.6 要求 100%；` +
        'verdict.ts 的 CorpusInput 没有召回项，这条只能在这里判）',
    },
    {
      name: 'declared-rule-coverage',
      pass: declaredRuleCoverage.pass,
      detail:
        `${declaredRuleCoverage.fullyCovered}/${declaredRuleCoverage.violationCases} 件违规样例的实测命中集合` +
        '包含全部人工要求规则（§2.4：不能靠只报 B1 就算 B11 覆盖成功）',
    },
    {
      name: 'b12-never-hard-blocks',
      pass: b12.pass,
      detail:
        `B12 硬拦 ${b12.hardBlocks} 次（不可谈判项 ②：任何硬阻断 = 直接失败）；` +
        `B12 确认集 ${b12.confirmedAsExpected}/${b12.primarySamples} 按确认处理（§2.6 要求 100%）`,
    },
    {
      name: 'low-confidence-confirm',
      pass: lowConfidenceConfirm.pass,
      detail:
        `B8/B13 低置信集 ${lowConfidenceConfirm.confirmedAsExpected}/${lowConfidenceConfirm.expectedConfirmSamples}` +
        ' 按确认处理（§2.6 要求 100%）',
    },
    {
      name: 'safe-confirm-rate',
      pass: safeConfirmRate.pass === true,
      detail:
        `安全样例确认率 ${formatPercent(safeConfirmRate.rate)}（目标 ≤5%）；` +
        '§2.6：不以「不硬拦」掩饰让全部学生走成人确认',
    },
    {
      name: 'holdout-false-block-rate',
      pass: falseBlockRate.holdout.pass === true,
      detail:
        `留出安全集误拦 ${falseBlockRate.holdout.safeHardBlocked}/${falseBlockRate.holdout.safeSamples}` +
        ` = ${formatPercent(falseBlockRate.holdout.rate)}（设计口径 ≤2/120，折算 ≤${falseBlockRate.holdout.scaledCeiling.toFixed(2)} 件）`,
    },
    {
      name: 'split-family-leak-free',
      pass: familyLeakage.length === 0,
      detail:
        familyLeakage.length === 0
          ? `${composition.families} 个家族无一跨 dev/holdout（§2.2：同一家族与它的变体只能位于一侧）`
          : `跨切分家族 ${familyLeakage.length} 个：${familyLeakage.slice(0, 5).join(', ')}`,
    },
  ];

  const failures: string[] = [];
  for (const gate of extraGates) if (!gate.pass) failures.push(`${gate.name}: ${gate.detail}`);
  for (const shortfall of verdict.shortfalls) {
    failures.push(
      `${shortfall.kind}${shortfall.ruleId === null ? '' : `(${shortfall.ruleId})`}: ${shortfall.detail}`,
    );
  }

  return {
    versions: {
      corpusVersion: options.corpusVersion,
      scannerVersion: options.scannerVersion,
      rulesetVersion: options.rulesetVersion,
      rulesetFingerprintHash: options.rulesetFingerprintHash,
      annotationMode: options.annotationMode,
    },
    targets: {
      falseBlockRate: TARGET_FALSE_BLOCK_RATE,
      precision: TARGET_PRECISION,
      safeConfirmRate: TARGET_SAFE_CONFIRM_RATE,
      recall: recallGate.targetRecall,
      designSafeTotal: DESIGN_SAFE_TOTAL,
      designViolationTotal: DESIGN_VIOLATION_TOTAL,
    },
    execution,
    composition,
    verdict,
    rules,
    recallGate,
    declaredRuleCoverage,
    b12,
    lowConfidenceConfirm,
    safeConfirmRate,
    falseBlockRate,
    cells,
    subTypeCoverage,
    techTags: {
      safeTotal: safeRows.length,
      countQuotas: TECH_TAG_COUNT_QUOTAS.map(measureQuota),
      coverageRequired: TECH_TAG_COVERAGE_REQUIRED.map(measureQuota),
      perTag: TECH_TAGS.map((tag) => ({ tag, count: tagCounts.get(tag) ?? 0 })),
      untaggedSafeCases,
    },
    quotaDeltas,
    shards,
    shardBudget,
    splits: {
      familyLeakage: [...new Set(familyLeakage)].sort(),
      leakFree: familyLeakage.length === 0,
    },
    extraGates,
    overall: { pass: failures.length === 0 && verdict.meetsTargets, failures },
  };
}

/** 百分比格式化。null（不可测）必须渲染成 `n/a`，**不能**渲染成 `0.00%`。 */
export function formatPercent(value: number | null, digits = 2): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

/** 边界样例的单列口径（§2.2：解包门禁集，不进 B 规则 precision）。 */
export function boundarySummary(cases: readonly MeasuredCase[]): {
  readonly total: number;
  readonly expectedPass: number;
  readonly actualPass: number;
  readonly notPassCaseIds: readonly string[];
} {
  const rows = cases.filter((row) => row.spec.kind === 'boundary');
  const expectedPass = rows.filter((row) => row.spec.expectation.expectedStatus === 'PASS');
  const notPass = expectedPass.filter((row) => row.outcome.status !== 'PASS');
  return {
    total: rows.length,
    expectedPass: expectedPass.length,
    actualPass: expectedPass.length - notPass.length,
    notPassCaseIds: notPass.map((row) => row.spec.caseId),
  };
}

/**
 * 期望处置分布（§2.4 的置信分层）。**由期望得出，不由实测得出** ——
 * 这张表是用来和设计配额对账的，用实测填就成了「实测和自己对账」。
 */
export function expectationDistribution(cases: readonly MeasuredCase[]): {
  readonly disposition: Readonly<Record<Disposition, number>>;
  readonly confidence: Readonly<Record<Confidence, number>>;
  readonly overallLabel: Readonly<Record<AnnotationLabel, number>>;
  readonly perRule: readonly {
    ruleId: RuleId;
    hardBlock: number;
    confirm: number;
  }[];
} {
  const disposition = { BLOCK: 0, CONFIRM_REQUIRED: 0 } as Record<Disposition, number>;
  const confidence = { HIGH: 0, LOW: 0 } as Record<Confidence, number>;
  const overallLabel = {
    NOT_APPLICABLE: 0,
    SAFE: 0,
    CONFIRM_REQUIRED: 0,
    HARD_BLOCK: 0,
  } as Record<AnnotationLabel, number>;
  const perRule = new Map<RuleId, { hardBlock: number; confirm: number }>();
  for (const ruleId of RULE_IDS) perRule.set(ruleId, { hardBlock: 0, confirm: 0 });

  for (const row of cases) {
    if (row.spec.kind === 'violation') {
      const d = row.spec.expectation.expectedDisposition;
      const c = row.spec.expectation.expectedConfidence;
      if (d !== null) disposition[d] += 1;
      if (c !== null) confidence[c] += 1;
      const primary = row.spec.ruleId;
      if (primary !== null) {
        const entry = perRule.get(primary);
        if (entry !== undefined) {
          if (d === 'BLOCK') entry.hardBlock += 1;
          else if (d === 'CONFIRM_REQUIRED') entry.confirm += 1;
        }
      }
    }
    const expected = expectedByRuleOf(row.spec);
    overallLabel[highestLabel(RULE_IDS.map((ruleId) => expected[ruleId]))] += 1;
  }

  return {
    disposition,
    confidence,
    overallLabel,
    perRule: RULE_IDS.map((ruleId) => ({
      ruleId,
      hardBlock: perRule.get(ruleId)?.hardBlock ?? 0,
      confirm: perRule.get(ruleId)?.confirm ?? 0,
    })),
  };
}

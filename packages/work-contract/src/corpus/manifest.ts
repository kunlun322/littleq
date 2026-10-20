/**
 * case manifest（ZLQ-156 §2.3）与计划清单（§2.6 的聚合前置条件）。
 *
 * ## 两件不同的东西，刻意分成两个类型
 *
 * §2.3 的 **case manifest** 是「这件样例的人工期望是什么」，14 个字段一字不改地照抄规格；
 * §2.6 的 **计划清单** 是「这次跑批准了哪些 caseId、分到哪个 shard、用哪三个版本号」。
 * 后者必须**小**：聚合作业要核对它的 hash，而核对一个含 1026 份完整标注的大文件
 * 等于把「计划一致」和「标注一致」搅在一起。所以计划清单只带
 * `(caseId, familyId, split, shard, kind, ruleId)` 六元组 + 三版本号 + `planHash`。
 *
 * ## `expectedByRule` 怎么来 —— 以及为什么这不是「把扫描结果抄成期望」
 *
 * §2.3.1 要求「先隐藏扫描器输出，防锚定效应」。这条要求的可执行形式是：
 * **期望值的每一个来源都必须是扫描之前的东西**。本模块只用三个来源，
 * 它们正是 `CorpusCaseSpec.provenance` 的三个取值：
 *
 * - `ruleset-table`：规则集表里写死的处置（§8.3 的表）；
 * - `rule-reading`：读规则源码得出的性质（例如「B1 的 10 个 emit 点全是 BLOCK」）；
 * - `template`：模板自身的性质（安全基座只用 §2.2 白名单写法）。
 *
 * 实测过程中确实发现了分歧（B5 对 `action=""` 零命中），处理方式是**保留原期望、
 * 把分歧作为扫描器缺陷上报**，而不是把期望改成 PASS。所以「期望 ⊇ 实测」这个判据
 * 始终是双向可失败的 —— 若期望一律由实测反推，`missingRules` 就恒为空，
 * 整个门禁会变成一个永真的断言（ZLQ-194 §16 点名的形状）。
 *
 * ## 未命中的规则标 `NOT_APPLICABLE` 而不是 `SAFE`
 *
 * 违规样例是**单点变异**（§2.1）：安全基座上只注入一条规则的载荷。
 * 因此「主规则之外的 12 条」的诚实标签是 NOT_APPLICABLE（该规则的主体在本作品中不存在），
 * 而不是 SAFE（该规则看过了、判它合规）—— 后者是一个我没有逐条核实过的断言。
 *
 * 但 §2.3.4 明确警告「不能拿大量 NOT_APPLICABLE 稀释」一致率。所以本模块
 * **不是**把 NOT_APPLICABLE 藏起来，而是把它变成报告里的一个显式数字：
 * `LabelDistribution` 给出四个标签各自的计数与占比，`agreement.ts` 再按类别分别报一致率
 * （含 HARD_BLOCK 的正类一致率与 Cohen's κ）。稀释是靠**分类别报告**防的，
 * 不是靠少用一个标签防的。
 *
 * 安全样例则相反，13 条**全部**标 SAFE：§2.3.6 要求安全集包含「明显合法但容易误判」的例子，
 * 而 §2.2 的白名单写法（`url(#gradient)`、合法 data/blob、hash 路由、许可注释……）
 * 恰恰意味着这些规则的**主体在场且合规** —— 那是 SAFE 的定义，不是 NOT_APPLICABLE 的。
 */

import { FROZEN_DISPOSITION_CEILING } from '../scan/finding.js';
import { canonicalJsonHash } from '../scan/hash.js';
import type { AgeBand, WorkType } from '../scan/metadata.js';
import type { Disposition, RuleId } from '../scan/types.js';
import { RULE_IDS } from '../scan/types.js';
import type { AnnotationLabel, CorpusCaseSpec, CorpusKind, Split } from './generator.js';
import type { BuiltCorpusPackage } from './package.js';
import type { AnnotationMode, VersionTriple } from './versions.js';
import { ANNOTATION_MODE, ADMISSION_AGREEMENT_TARGET, ADMISSION_KAPPA_TARGET } from './versions.js';

// ---------------------------------------------------------------------------
// 来源档（§2.1）
// ---------------------------------------------------------------------------

export const SOURCE_KINDS = [
  'LOCAL_DETERMINISTIC_TEMPLATE',
  'TEAM_HANDMADE',
  'PORTED_PUBLIC_EXAMPLE',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** 本单实际产出的档。§2.1 表格第二行：「本地确定性模板生成与人工变体 / 240 / 固定 seeds」。 */
export const PRODUCED_SOURCE_KIND: SourceKind = 'LOCAL_DETERMINISTIC_TEMPLATE';

/**
 * 产出档的许可声明。样例内容是为 LittleQ 原创合成的（代码/图形/声音全部由生成器产出，
 * 人物与文本均虚构），随仓库许可发布；不含任何第三方移植片段，因此没有上游 commit 可记。
 */
export const PRODUCED_SOURCE_LICENSE =
  'littleq-corpus-original; AGPL-3.0-or-later (repo LICENSE); no third-party code';

/**
 * **未产出的两档**。这不是「稍后补」的备注，而是交付时必须点名的缺口：
 * §2.1 的 600 件安全集由三档构成，本单只产出了第二档。
 * 把它们写成数据而不是写成一段话，是为了让「配额差多少」可被机器核对（`metrics.ts` 会读它）。
 */
export type UnproducedSourceTier = {
  readonly sourceKind: SourceKind;
  /** §2.1 表格里的设计数量。 */
  readonly designCount: number;
  /** §2.1 表格里的单元配额口径。 */
  readonly designUnitQuota: string;
  /** 本单实际产出数量。恒为 0。 */
  readonly producedCount: 0;
  /** 为什么一次自动化开发跑产不出来。 */
  readonly whyUnproduced: string;
  /** 补齐它需要的人类角色。 */
  readonly humanRoles: readonly string[];
  /** 补齐它的工作量估计（人日）。 */
  readonly effortEstimatePersonDays: string;
  /** 补齐前必须过的许可/隐私核查清单。 */
  readonly licenseChecklist: readonly string[];
};

export const UNPRODUCED_SOURCE_TIERS: readonly UnproducedSourceTier[] = [
  {
    sourceKind: 'TEAM_HANDMADE',
    designCount: 240,
    designUnitQuota: '各档各类型 20 个（3 年龄档 × 4 作品类型 × 20）',
    producedCount: 0,
    whyUnproduced:
      '§2.1 要求「团队人工制作教学示例」且「文本人物均虚构，原创代码/图形/声音」。' +
      '人工制作按定义不能由一次自动化开发跑产出；用生成器批量产 240 件再标成 TEAM_HANDMADE，' +
      '就是把生成样例冒充人工样例（ZLQ-210 明令禁止，ZLQ-194 §16 的假数据形状）。',
    humanRoles: [
      '教学设计者（按 L1/L2/L3 的表达水平写玩法与文案）',
      '前端工程师（原创 Canvas/SVG/Web Audio 代码）',
      '美术（原创图形素材，或明确使用 CC0 素材并记录来源）',
      'corpus curator（§2.3.1：核实来源许可、无 PII/真实凭证、人工可玩，写 case manifest）',
    ],
    effortEstimatePersonDays: '240 件 × 0.5–1 人日 ≈ 120–240 人日（含 curator 核验与可玩性验收）',
    licenseChecklist: [
      '每个素材可追溯到原创作者或 CC0/公共领域来源，并记录出处',
      '文本与人物全部虚构；无真实姓名、学校、联系方式、定位',
      '无真实凭证、PAT、令牌、内部主机名、云元数据地址',
      '人工可玩性验收（打开即能操作，不是空壳页面）',
      '不含任何真实学生内容（§2.1：不接收真实学生内容作为公共 repo/CI fixture）',
    ],
  },
  {
    sourceKind: 'PORTED_PUBLIC_EXAMPLE',
    designCount: 120,
    designUnitQuota: '各单元 10 个（12 单元 × 10）',
    producedCount: 0,
    whyUnproduced:
      '§2.1 要求「MIT/0BSD/CC0 等许可核实，离线固化、记录上游 commit/许可」。' +
      '把未经核实许可的第三方代码拉进仓库属于**未经授权的供应链动作**，' +
      '且 §2.5 明令「CI 禁远程下载 fixture」——一次开发跑里既无法完成逐条许可核实，' +
      '也不应在未核实前先落盘。',
    humanRoles: [
      '维护者（挑选上游示例、逐条核实许可证与版权头）',
      '法务或许可负责人（确认 MIT/0BSD/CC0 兼容性，处理署名要求）',
      'corpus curator（离线固化、记录上游 commit 与许可、剥离 PII/遥测）',
    ],
    effortEstimatePersonDays: '120 件 × 0.25–0.5 人日 ≈ 30–60 人日（许可核实是主要成本）',
    licenseChecklist: [
      '上游许可证为 MIT / 0BSD / CC0 之一，且已核实版权头与 LICENSE 文件一致',
      '记录上游仓库 URL 与**精确 commit sha**（不是分支名）',
      '离线固化：包内不保留任何远程引用，CI 不需要联网即可构建',
      '剥离一切 PII、凭证、遥测、分析脚本（§2.1：有任何一项就不用）',
      '署名要求已满足（THIRD_PARTY_LICENSES 或包内 NOTICE）',
      '移植后仍人工可玩，且不是「同一个 zip 复制 N 份」（§2.1 明令禁止）',
    ],
  },
];

/** 设计口径的来源档合计（240+240+120 = 600，§2.2 的安全集总量）。 */
export const DESIGN_SAFE_TOTAL = 600;

// ---------------------------------------------------------------------------
// 标注条目（§2.3.2）
// ---------------------------------------------------------------------------

/** §2.3.2「作品整体分类按最高处置等级」⇒ 这个序就是「最高」的定义。 */
export const ANNOTATION_LABELS: readonly AnnotationLabel[] = [
  'NOT_APPLICABLE',
  'SAFE',
  'CONFIRM_REQUIRED',
  'HARD_BLOCK',
];

const LABEL_RANK: Readonly<Record<AnnotationLabel, number>> = {
  NOT_APPLICABLE: 0,
  SAFE: 1,
  CONFIRM_REQUIRED: 2,
  HARD_BLOCK: 3,
};

export function labelRank(label: AnnotationLabel): number {
  return LABEL_RANK[label];
}

export function highestLabel(labels: readonly AnnotationLabel[]): AnnotationLabel {
  let best: AnnotationLabel = 'NOT_APPLICABLE';
  for (const label of labels) if (labelRank(label) > labelRank(best)) best = label;
  return best;
}

/**
 * 单条（规则 × 标注者）标注。
 *
 * §2.3.2 要求标注者「指出文件/位置/理由」，所以 `file` / `locationKey` / `reasonRef` 不是可选项。
 * `reasonRef` 是**引用**而不是理由正文：理由正文在 `violations.ts` 的 `rationale` 与
 * 规则集表里，manifest 只带指针，避免同一段话在 1026 份条目里复制 1026 遍。
 */
export type AnnotationEntry = {
  readonly ruleId: RuleId;
  readonly label: AnnotationLabel;
  /** §2.3「标注者用内部 alias，不放个人联系方式」。 */
  readonly annotatorAlias: string;
  /**
   * §2.3.5「标注者看不到对方标签」。本语料只有一名标注者 ⇒ 没有「对方」可屏蔽，
   * 所以这里恒为 `false`，**不得**写成 `true`：把它写成 true 等于宣称满足了双盲，
   * 而 §2.3.4 的准入恰恰因此不成立（见 `ADMISSION_*` 的说明）。
   */
  readonly blindToPeers: false;
  /**
   * §2.3.1「先隐藏扫描器输出，防锚定效应」。`true` 的依据是 `provenance`：
   * 期望值的三个来源（规则集表 / 规则源码 / 模板性质）全部先于扫描存在。
   */
  readonly blindToScannerOutput: boolean;
  /** 标注指向的文件；无特定文件（整体判定）时为 null。 */
  readonly file: string | null;
  /** 位置键；与 `Finding.location` 同形，便于和实测对齐。null = 整件作品级。 */
  readonly locationKey: string | null;
  /** 理由指针。 */
  readonly reasonRef: string;
};

/** 唯一的标注者 alias。§2.3.2 要求两名；只有一名 ⇒ §2.3.4 准入结构性不成立。 */
export const IMPLEMENTER_ALIAS = 'A1-implementer';

// ---------------------------------------------------------------------------
// case manifest（§2.3，14 字段）
// ---------------------------------------------------------------------------

/**
 * §2.3 原文：「case manifest 字段：`caseId, corpusVersion, familyId, split, ageBand,
 * workType, sourceKind, sourceLicense, packageHash, tags, expectedByRule, expectedOverall,
 * annotations, adjudicationRef`」—— 14 个，一个不加一个不减。
 *
 * 加字段的诱惑是真实的（shard、kind、ruleId、耗时都想塞进来），但那样「manifest 符合规格」
 * 就无法核对了。需要额外维度的地方走**计划清单**（shard/kind）与**分片报告**（耗时/实测）。
 */
export type CaseManifestEntry = {
  readonly caseId: string;
  readonly corpusVersion: string;
  readonly familyId: string;
  readonly split: Split;
  /** 边界样例不属于任何年龄档/类型格（它是解包门禁集），故可空。 */
  readonly ageBand: AgeBand | null;
  readonly workType: WorkType | null;
  readonly sourceKind: SourceKind;
  readonly sourceLicense: string;
  /** = `BuiltCorpusPackage.artifactHash`。§2.5「样例包 immutable」的凭据。 */
  readonly packageHash: string;
  readonly tags: readonly string[];
  /** 逐规则期望，13 条全给（缺一条就是没标完）。 */
  readonly expectedByRule: Readonly<Record<RuleId, AnnotationLabel>>;
  readonly expectedOverall: AnnotationLabel;
  readonly annotations: readonly AnnotationEntry[];
  /**
   * 裁决引用。恒为 null —— 但**理由不是「标注者一致」**：
   * 只有一名标注者时根本不存在分歧，因此没有东西可裁决。
   * §2.3.3「未裁决样例不得进入 release corpus」⇒ 本语料只能是 `0.1.0-rc.1`，
   * 不得 release 为 `1.0.0`（§2.5 要求 1.0.0 必须双标 + 可运行验证）。
   */
  readonly adjudicationRef: string | null;
};

/** 主规则的期望标签：由**冻结处置**得出，不由实测得出。 */
function labelOfDisposition(disposition: Disposition | null): AnnotationLabel {
  if (disposition === 'BLOCK') return 'HARD_BLOCK';
  if (disposition === 'CONFIRM_REQUIRED') return 'CONFIRM_REQUIRED';
  return 'NOT_APPLICABLE';
}

/**
 * 推导 `expectedByRule`。见文件头「未命中的规则标 NOT_APPLICABLE」一节的理由。
 */
export function expectedByRuleOf(spec: CorpusCaseSpec): Readonly<Record<RuleId, AnnotationLabel>> {
  const out = {} as Record<RuleId, AnnotationLabel>;
  for (const ruleId of RULE_IDS) out[ruleId] = 'NOT_APPLICABLE';

  if (spec.kind === 'safe' || spec.kind === 'boundary') {
    // 安全/边界样例：13 条全部 SAFE（主体在场且合规，见文件头）。
    for (const ruleId of RULE_IDS) out[ruleId] = 'SAFE';
    return out;
  }

  if (spec.ruleId !== null)
    out[spec.ruleId] = labelOfDisposition(spec.expectation.expectedDisposition);
  for (const other of spec.expectation.expectedOtherRules) {
    // 共现规则按规则粒度声明，标签取该规则的**冻结处置上限**：
    // B12 的上限是 CONFIRM_REQUIRED，所以即使被声明为共现也不可能标成 HARD_BLOCK
    // （不可谈判项 ②：B12 上任何硬阻断 = 直接失败）。
    out[other] = labelOfDisposition(FROZEN_DISPOSITION_CEILING[other]);
  }
  return out;
}

export type CaseManifestOptions = {
  readonly corpusVersion: string;
  readonly sourceKind?: SourceKind;
  readonly sourceLicense?: string;
  readonly annotatorAlias?: string;
};

/**
 * 建一条 case manifest。`spec` 必须是 **`buildCase` 返回的那一份**（tags 已 enrich），
 * 不是 `allCaseSpecs()` 里的那份（那里 tags 只有覆盖层名，见 `generator.ts:139` 的注释）。
 *
 * ## `file` / `locationKey` 恒为 null —— 这是本单的一个**已声明缺口**
 *
 * §2.3.2 要求标注者「指出文件/位置/理由」。本单能满足「理由」（`reasonRef`），
 * 但**给不出逐件的文件/位置**：单点变异是把载荷注入安全基座的某个槽位
 * （`slotId ∈ head|body|script|style`，见 `templates.ts:55`），槽位由家族与覆盖层决定，
 * 而注入后的文件路径**没有**被 `CorpusCaseSpec` 记录下来。
 * 在这一层凭猜测填一个 `'index.html'` 是造假位置 —— 多文件基座（`multi-file` 覆盖层）
 * 的载荷可能落在 `script.js` 或 `style.css` 里，填错的位置比不填更坏：
 * 它会让「标注指向的位置」和「实测 finding 的位置」对不上，
 * 从而把 FP/FN 的归因分析引到错的文件上去。
 *
 * 所以：`file`/`locationKey` 记 null 表示**作品级判定**，位置信息的粒度是
 * **家族级**，由 `reasonRef` 指向的 `violations.ts#<familyId>` 承担
 * （那里逐家族写明了载荷形态与注入位置）。这条限制进交付报告的缺口表，
 * 补齐它需要把注入后的路径写回 `CorpusCaseSpec`（`generator.ts` 的改动），
 * 属于下一版（minor）的范围。
 */
export function caseManifestEntry(
  spec: CorpusCaseSpec,
  built: BuiltCorpusPackage,
  options: CaseManifestOptions,
): CaseManifestEntry {
  const expectedByRule = expectedByRuleOf(spec);
  const alias = options.annotatorAlias ?? IMPLEMENTER_ALIAS;

  const annotations: AnnotationEntry[] = RULE_IDS.map((ruleId) => ({
    ruleId,
    label: expectedByRule[ruleId],
    annotatorAlias: alias,
    blindToPeers: false,
    blindToScannerOutput: true,
    file: null,
    locationKey: null,
    reasonRef:
      ruleId === spec.ruleId
        ? `corpus/violations.ts#${spec.familyId}`
        : spec.expectation.expectedOtherRules.includes(ruleId)
          ? `corpus/violations.ts#${spec.familyId}#expectedOtherRules`
          : spec.kind === 'safe' || spec.kind === 'boundary'
            ? 'corpus/templates.ts#safe-base'
            : 'corpus/manifest.ts#single-point-mutation',
  }));

  return {
    caseId: spec.caseId,
    corpusVersion: options.corpusVersion,
    familyId: spec.familyId,
    split: spec.split,
    ageBand: spec.cell?.ageBand ?? null,
    workType: spec.cell?.workType ?? null,
    sourceKind: options.sourceKind ?? PRODUCED_SOURCE_KIND,
    sourceLicense: options.sourceLicense ?? PRODUCED_SOURCE_LICENSE,
    packageHash: built.artifactHash,
    tags: spec.tags,
    expectedByRule,
    expectedOverall: highestLabel(annotations.map((entry) => entry.label)),
    annotations,
    adjudicationRef: null,
  };
}

// ---------------------------------------------------------------------------
// 四个标签的分布（防「NOT_APPLICABLE 稀释」的显式数字）
// ---------------------------------------------------------------------------

export type LabelDistribution = {
  readonly total: number;
  readonly counts: Readonly<Record<AnnotationLabel, number>>;
  /** 占比，0..1。 */
  readonly ratios: Readonly<Record<AnnotationLabel, number>>;
  /** NOT_APPLICABLE 占比。§2.3.4 关心的那个稀释量。 */
  readonly notApplicableRatio: number;
};

export function labelDistributionOf(entries: readonly CaseManifestEntry[]): LabelDistribution {
  const counts = { NOT_APPLICABLE: 0, SAFE: 0, CONFIRM_REQUIRED: 0, HARD_BLOCK: 0 } as Record<
    AnnotationLabel,
    number
  >;
  let total = 0;
  for (const entry of entries) {
    for (const ruleId of RULE_IDS) {
      counts[entry.expectedByRule[ruleId]] += 1;
      total += 1;
    }
  }
  const ratios = {
    NOT_APPLICABLE: 0,
    SAFE: 0,
    CONFIRM_REQUIRED: 0,
    HARD_BLOCK: 0,
  } as Record<AnnotationLabel, number>;
  for (const label of ANNOTATION_LABELS) ratios[label] = total === 0 ? 0 : counts[label] / total;
  return { total, counts, ratios, notApplicableRatio: ratios.NOT_APPLICABLE };
}

// ---------------------------------------------------------------------------
// 计划清单（§2.6）
// ---------------------------------------------------------------------------

export type PlanCaseRow = {
  readonly caseId: string;
  readonly familyId: string;
  readonly split: Split;
  readonly shard: number;
  readonly kind: CorpusKind;
  readonly ruleId: RuleId | null;
};

export type CorpusPlanManifest = {
  readonly schema: 'littleq-corpus-plan-v1';
  readonly corpusVersion: string;
  readonly scannerVersion: string;
  readonly rulesetVersion: string;
  readonly rulesetFingerprintHash: string;
  readonly annotationMode: AnnotationMode;
  /** §2.3.4 的准入是否达成。单人非盲 ⇒ 结构性 false。 */
  readonly admissionMet: false;
  readonly admissionTargets: {
    readonly rawAgreement: number;
    readonly cohenKappaOnHardBlock: number;
  };
  readonly reportStatus: 'provisional';
  readonly shardCount: number;
  readonly shardPlanHash: string;
  readonly caseCount: number;
  readonly cases: readonly PlanCaseRow[];
  /** 本清单自身（不含 `planHash`）的哈希。聚合作业核对它。 */
  readonly planHash: string;
};

export function planManifest(
  cases: readonly PlanCaseRow[],
  versions: VersionTriple,
  shardCount: number,
  shardPlanHash: string,
): CorpusPlanManifest {
  const sorted = [...cases].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const seen = new Set<string>();
  for (const row of sorted) {
    if (seen.has(row.caseId)) throw new Error(`planManifest: caseId 重复 ${row.caseId}`);
    seen.add(row.caseId);
  }
  const body = {
    schema: 'littleq-corpus-plan-v1' as const,
    corpusVersion: versions.corpusVersion,
    scannerVersion: versions.scannerVersion,
    rulesetVersion: versions.rulesetVersion,
    rulesetFingerprintHash: versions.rulesetFingerprintHash,
    annotationMode: ANNOTATION_MODE,
    admissionMet: false as const,
    admissionTargets: {
      rawAgreement: ADMISSION_AGREEMENT_TARGET,
      cohenKappaOnHardBlock: ADMISSION_KAPPA_TARGET,
    },
    reportStatus: 'provisional' as const,
    shardCount,
    shardPlanHash,
    caseCount: sorted.length,
    cases: sorted,
  };
  return { ...body, planHash: canonicalJsonHash(body) };
}

// ---------------------------------------------------------------------------
// 聚合前置检查（§2.6）
// ---------------------------------------------------------------------------

export type PlanCompletenessProblem = {
  readonly code: 'MISSING_CASE' | 'UNPLANNED_CASE' | 'DUPLICATE_REPORT';
  readonly caseId: string;
};

export class PlanIncompleteError extends Error {
  readonly code = 'PLAN_INCOMPLETE' as const;
  constructor(readonly problems: readonly PlanCompletenessProblem[]) {
    const head = problems
      .slice(0, 8)
      .map((p) => `${p.code}:${p.caseId}`)
      .join(', ');
    super(
      `计划清单核对失败：${problems.length} 项（${head}${problems.length > 8 ? ', …' : ''}）。` +
        '§2.6：超时、解析失败、缺 shard、缓存损坏、跳过样例直接令 CI 失败，不从分母移除。',
    );
    this.name = 'PlanIncompleteError';
  }
}

/**
 * 聚合作业的前置条件。**纯函数**：返回问题清单；`assertPlanComplete` 才抛。
 *
 * 三类问题各对应 §2.6 的一句话：
 * - `MISSING_CASE`：「所有计划样例必须产出结果」——超时/解析失败/缺 shard/跳过都会落到这里；
 * - `UNPLANNED_CASE`：跑了计划外的东西（缓存串了别的语料版本）；
 * - `DUPLICATE_REPORT`：同一 caseId 报了两次（shard 重叠或聚合脚本重入）。
 */
export function planCompleteness(
  plan: CorpusPlanManifest,
  reportedCaseIds: readonly string[],
): readonly PlanCompletenessProblem[] {
  const problems: PlanCompletenessProblem[] = [];
  const reported = new Set<string>();
  for (const caseId of reportedCaseIds) {
    if (reported.has(caseId)) problems.push({ code: 'DUPLICATE_REPORT', caseId });
    reported.add(caseId);
  }
  for (const row of plan.cases) {
    if (!reported.has(row.caseId)) problems.push({ code: 'MISSING_CASE', caseId: row.caseId });
  }
  const planned = new Set(plan.cases.map((row) => row.caseId));
  for (const caseId of reported) {
    if (!planned.has(caseId)) problems.push({ code: 'UNPLANNED_CASE', caseId });
  }
  return problems.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.code.localeCompare(b.code));
}

export function assertPlanComplete(
  plan: CorpusPlanManifest,
  reportedCaseIds: readonly string[],
): void {
  const problems = planCompleteness(plan, reportedCaseIds);
  if (problems.length > 0) throw new PlanIncompleteError(problems);
}

/** 版本一致性核对。§2.6「聚合作业检查…版本一致」。 */
export function versionMismatch(
  plan: CorpusPlanManifest,
  reported: { corpusVersion: string; scannerVersion: string; rulesetVersion: string },
): readonly string[] {
  const problems: string[] = [];
  if (plan.corpusVersion !== reported.corpusVersion) {
    problems.push(
      `corpusVersion 不一致：计划 ${plan.corpusVersion} vs 报告 ${reported.corpusVersion}`,
    );
  }
  if (plan.scannerVersion !== reported.scannerVersion) {
    problems.push(
      `scannerVersion 不一致：计划 ${plan.scannerVersion} vs 报告 ${reported.scannerVersion}`,
    );
  }
  if (plan.rulesetVersion !== reported.rulesetVersion) {
    problems.push(
      `rulesetVersion 不一致：计划 ${plan.rulesetVersion} vs 报告 ${reported.rulesetVersion}`,
    );
  }
  return problems;
}

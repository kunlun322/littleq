/**
 * 标注一致性计算（ZLQ-156 §2.3.4）。
 *
 * ## 这个模块在本单里**不会被喂进真实数据** —— 那正是重点
 *
 * §2.3.2 要求两名标注者独立逐规则标注，§2.3.4 要求「总体原始一致率 ≥95%；
 * 针对 HARD_BLOCK 的 Cohen's κ ≥0.80」。本单只有一名标注者（实现者本人），
 * 所以真实的一致率**不可测** —— 不是「测出来不达标」，是「没有第二个向量可配对」。
 *
 * 面对这个事实有两种写法，只有一种是对的：
 *
 * - ✗ 写一个恒返回 `{status:'NOT_MET'}` 的桩。它「诚实」，但它是空心的：
 *   等第二名标注者到位时，没人能保证这个模块算得对 —— 它从未被真数据走过。
 *   κ 的公式写错一个下标，桩照样绿。
 * - ✓ 写一个**真的**一致率/κ/正类一致率计算器，用合成配对向量在 vitest 里
 *   对着手算已知的 κ 值验它（含 κ=1、κ=0、κ<0、pe=1 退化四种边界），
 *   然后把「单人 ⇒ 不可测」做成**结构性的**判定：`annotatorCount < 2` 直接
 *   `UNMEASURABLE`，不给调用方留下「传 null 就当一致」的缝。
 *
 * 本模块走第二条。因此它同时是：①本单交付的一致性工装；②下一版（补齐第二名标注者后）
 * 直接可用的计算层。§2.3.4 还要求「κ 因低发生率失真时同时报告正类一致率与类别分布」，
 * 所以 `perClass.positiveAgreement` 与 `distributionA/B` 不是可选项，是判据的一部分。
 */

import type { AnnotationLabel } from './generator.js';
import { ANNOTATION_LABELS } from './manifest.js';
import { ADMISSION_AGREEMENT_TARGET, ADMISSION_KAPPA_TARGET } from './versions.js';

/**
 * 一对标注。`key` 是 (caseId, ruleId) 的稳定串 —— §2.3.2 是「逐规则」标注，
 * 所以配对的单位是**规则级**，不是作品级。作品级一致率会被 13 倍的分母稀释，
 * 而 §2.3.4 明确禁止用大分母掩盖类别不平衡。
 */
export type PairedAnnotation = {
  readonly key: string;
  readonly a: AnnotationLabel;
  readonly b: AnnotationLabel;
};

export type ClassAgreement = {
  readonly label: AnnotationLabel;
  /** 两人都标了该类的条目数。 */
  readonly bothCount: number;
  /** 只有 A 标了该类。 */
  readonly onlyA: number;
  /** 只有 B 标了该类。 */
  readonly onlyB: number;
  /**
   * 正类特定一致率（Cicchetti）：`2·both / (2·both + onlyA + onlyB)`。
   * 分母为 0（两人都从未用过该类）时为 null —— **不是 1**：
   * 从未使用的类别没有一致率可言，报 1 会凭空抬高整体印象。
   */
  readonly positiveAgreement: number | null;
  /** A 使用该类的比例。 */
  readonly prevalenceA: number;
  /** B 使用该类的比例。 */
  readonly prevalenceB: number;
};

export type AgreementReport = {
  readonly itemCount: number;
  readonly annotatorCount: 2;
  /** 观察一致率 `po`。 */
  readonly rawAgreement: number;
  /** 机会一致率 `pe = Σ_c p_a(c)·p_b(c)`。 */
  readonly expectedAgreement: number;
  /**
   * Cohen's κ = `(po - pe) / (1 - pe)`。`pe === 1` 时数学上无定义（0/0）⇒ null。
   * 负值是合法结果（一致性低于机会水平），不得截断成 0。
   */
  readonly cohenKappa: number | null;
  /** `pe === 1`：两人对每个条目都用了同一个单一类别。§2.3.4 说的「低发生率失真」极端形态。 */
  readonly kappaDegenerate: boolean;
  readonly perClass: Readonly<Record<AnnotationLabel, ClassAgreement>>;
  readonly distributionA: Readonly<Record<AnnotationLabel, number>>;
  readonly distributionB: Readonly<Record<AnnotationLabel, number>>;
  /** NOT_APPLICABLE 占比（两人平均）。§2.3.4「不能拿大量 NOT_APPLICABLE 稀释」的那个量。 */
  readonly notApplicableRatio: number;
  /** HARD_BLOCK 的正类一致率。§2.3.4 单点出来的那一类。 */
  readonly hardBlockPositiveAgreement: number | null;
  /** CONFIRM_REQUIRED 的一致率，§2.3.4 要求「另报告」。 */
  readonly confirmRequiredAgreement: number | null;
};

function zeroCounts(): Record<AnnotationLabel, number> {
  const out = {} as Record<AnnotationLabel, number>;
  for (const label of ANNOTATION_LABELS) out[label] = 0;
  return out;
}

/**
 * 计算一致率报告。**纯函数**，不读任何外部状态。
 *
 * 抛错而不是静默处理的情形：`key` 重复（说明配对构造错了，会让分母虚高、一致率虚高）。
 */
export function agreementOf(pairs: readonly PairedAnnotation[]): AgreementReport {
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (seen.has(pair.key)) throw new Error(`agreementOf: 配对键重复 ${pair.key}`);
    seen.add(pair.key);
  }

  const n = pairs.length;
  const distributionA = zeroCounts();
  const distributionB = zeroCounts();
  const both = zeroCounts();
  const onlyA = zeroCounts();
  const onlyB = zeroCounts();
  let agreeing = 0;

  for (const pair of pairs) {
    distributionA[pair.a] += 1;
    distributionB[pair.b] += 1;
    if (pair.a === pair.b) {
      agreeing += 1;
      both[pair.a] += 1;
    } else {
      // 「谁对谁错」在这里没有意义：A 标 HARD_BLOCK、B 标 CONFIRM_REQUIRED 时，
      // 这一条同时是 HARD_BLOCK 的 onlyA 与 CONFIRM_REQUIRED 的 onlyB。
      // 正类一致率的标准定义就是这么算的，不要试图只记一边，也不要按标签等级排序后
      // 只重的那个 —— 那会让「谁更严」变成一致率的一部分，而一致率只该度量「是否相同」。
      onlyA[pair.a] += 1;
      onlyB[pair.b] += 1;
    }
  }

  const rawAgreement = n === 0 ? 0 : agreeing / n;
  let expectedAgreement = 0;
  for (const label of ANNOTATION_LABELS) {
    expectedAgreement += n === 0 ? 0 : (distributionA[label] / n) * (distributionB[label] / n);
  }
  const degenerate = n > 0 && expectedAgreement >= 1 - Number.EPSILON;
  const cohenKappa = degenerate
    ? null
    : (rawAgreement - expectedAgreement) / (1 - expectedAgreement);

  const perClass = {} as Record<AnnotationLabel, ClassAgreement>;
  for (const label of ANNOTATION_LABELS) {
    const b = both[label];
    const a = onlyA[label];
    const o = onlyB[label];
    const denominator = 2 * b + a + o;
    perClass[label] = {
      label,
      bothCount: b,
      onlyA: a,
      onlyB: o,
      positiveAgreement: denominator === 0 ? null : (2 * b) / denominator,
      prevalenceA: n === 0 ? 0 : distributionA[label] / n,
      prevalenceB: n === 0 ? 0 : distributionB[label] / n,
    };
  }

  return {
    itemCount: n,
    annotatorCount: 2,
    rawAgreement,
    expectedAgreement,
    cohenKappa,
    kappaDegenerate: degenerate,
    perClass,
    distributionA,
    distributionB,
    notApplicableRatio:
      n === 0 ? 0 : (perClass.NOT_APPLICABLE.prevalenceA + perClass.NOT_APPLICABLE.prevalenceB) / 2,
    hardBlockPositiveAgreement: perClass.HARD_BLOCK.positiveAgreement,
    confirmRequiredAgreement: perClass.CONFIRM_REQUIRED.positiveAgreement,
  };
}

// ---------------------------------------------------------------------------
// 准入判定（§2.3.4）
// ---------------------------------------------------------------------------

export type AdmissionStatus = 'MET' | 'NOT_MET' | 'UNMEASURABLE';

export type AdmissionVerdict = {
  readonly status: AdmissionStatus;
  readonly annotatorCount: number;
  readonly requiredAnnotatorCount: 2;
  readonly rawAgreementTarget: number;
  readonly kappaTarget: number;
  /** 不可测时为 null。**不得**用 0 或 1 代替 —— 两者都会被误读成测量结果。 */
  readonly rawAgreement: number | null;
  readonly cohenKappa: number | null;
  readonly hardBlockPositiveAgreement: number | null;
  readonly confirmRequiredAgreement: number | null;
  readonly reasons: readonly string[];
};

/**
 * 准入判定。`report` 为 null 表示没有第二向量。
 *
 * `annotatorCount < 2` 走 `UNMEASURABLE` 而不是 `NOT_MET`：
 * 「未达标」意味着测了、不够；「不可测」意味着连测的前提都不存在。
 * 混为一谈会让下一版补了第二名标注者之后，看不出指标到底是「从不可测变成达标」
 * 还是「从不达标改进到达标」—— 这两件事的验收意义完全不同。
 *
 * ## 这里**刻意没有** `admissionMet` / `releasableAsStable` 字段
 *
 * 早先的版本在本返回类型上钉了两个字面量 `false`，理由是「让不小心宣称准入达成变成类型错误」。
 * 放错了地方：本函数是**通用计算器**，钉死 false 就等于它永远报不出 MET ——
 * 那正是本文件开头 ✗ 掉的那种空心桩（「它诚实，但 κ 公式写错一个下标，桩照样绿」）。
 * 「本语料的准入恒未达成」是**语料级**事实，它钉在该钉的地方：
 * `versions.ts` 的 `VersionTriple.admissionMet: false` 与 `manifest.ts` 的
 * `CorpusPlanManifest.admissionMet: false` —— 两者都是字面量 false 类型，
 * 而且正是真正落进 `plan-manifest.jsonl` / 16 份分片头 / `report.jsonl` 的那一个字段。
 * `test/corpus-agreement.test.ts` 因此可以断言「合成双标数据 ⇒ status MET」，
 * 用来证明计算器不是桩；同时断言语料级 triple 恒为 false。
 */
export function admissionOf(
  report: AgreementReport | null,
  annotatorCount: number,
): AdmissionVerdict {
  const base = {
    annotatorCount,
    requiredAnnotatorCount: 2 as const,
    rawAgreementTarget: ADMISSION_AGREEMENT_TARGET,
    kappaTarget: ADMISSION_KAPPA_TARGET,
  };

  if (annotatorCount < 2 || report === null) {
    return {
      ...base,
      status: 'UNMEASURABLE',
      rawAgreement: null,
      cohenKappa: null,
      hardBlockPositiveAgreement: null,
      confirmRequiredAgreement: null,
      reasons: [
        `只有 ${annotatorCount} 名标注者（§2.3.2 要求两名，且至少一名懂 Web 安全、一名懂教学表达）`,
        "没有第二个标注向量可配对 ⇒ 原始一致率与 Cohen's κ 均不可测",
        '§2.3.4 的准入（≥95% 原始一致率、HARD_BLOCK 上 κ ≥0.80）结构性不成立',
        '§2.3.3「未裁决样例不得进入 release corpus」+ §2.5「1.0.0 必须双标」⇒ 本语料只能是 0.1.0-rc.1',
      ],
    };
  }

  const reasons: string[] = [];
  const raw = report.rawAgreement;
  const kappa = report.cohenKappa;
  if (raw < ADMISSION_AGREEMENT_TARGET) {
    reasons.push(
      `总体原始一致率 ${(raw * 100).toFixed(2)}% < 目标 ${(ADMISSION_AGREEMENT_TARGET * 100).toFixed(2)}%`,
    );
  }
  if (kappa === null) {
    reasons.push(
      "Cohen's κ 无定义（机会一致率 pe=1，即两人对每个条目都用了同一个单一类别）" +
        '⇒ HARD_BLOCK 上的 κ ≥0.80 无法判定；按 §2.3.4 改看正类一致率与类别分布',
    );
  } else if (kappa < ADMISSION_KAPPA_TARGET) {
    reasons.push(
      `HARD_BLOCK 上的 Cohen's κ ${kappa.toFixed(4)} < 目标 ${ADMISSION_KAPPA_TARGET.toFixed(2)}`,
    );
  }
  if (report.notApplicableRatio > 0.5) {
    reasons.push(
      `NOT_APPLICABLE 占比 ${(report.notApplicableRatio * 100).toFixed(2)}% > 50%：` +
        '§2.3.4 禁止用大量 NOT_APPLICABLE 稀释一致率，总体一致率不得单独作为准入依据',
    );
  }

  return {
    ...base,
    status: reasons.length === 0 ? 'MET' : 'NOT_MET',
    rawAgreement: raw,
    cohenKappa: kappa,
    hardBlockPositiveAgreement: report.hardBlockPositiveAgreement,
    confirmRequiredAgreement: report.confirmRequiredAgreement,
    reasons,
  };
}

/**
 * 把两份**规则级**标注表配成 `PairedAnnotation[]`。
 *
 * 键集合必须完全相同（同一批 (caseId, ruleId)），否则抛错 ——
 * 少配一对就少一个分母，而那会让一致率悄悄变好看。
 */
export function pairAnnotations(
  a: ReadonlyMap<string, AnnotationLabel>,
  b: ReadonlyMap<string, AnnotationLabel>,
): readonly PairedAnnotation[] {
  const pairs: PairedAnnotation[] = [];
  const missing: string[] = [];
  for (const [key, labelA] of a) {
    const labelB = b.get(key);
    if (labelB === undefined) missing.push(key);
    else pairs.push({ key, a: labelA, b: labelB });
  }
  for (const key of b.keys()) if (!a.has(key)) missing.push(key);
  if (missing.length > 0) {
    throw new Error(
      `pairAnnotations: ${missing.length} 个键只在一侧出现（${missing.slice(0, 5).join(', ')}…）`,
    );
  }
  return pairs.sort((x, y) => x.key.localeCompare(y.key));
}

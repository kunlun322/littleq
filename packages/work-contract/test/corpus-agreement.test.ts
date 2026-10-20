/**
 * 一致性计算器的**真数据**验证（ZLQ-156 §2.3.4）。
 *
 * ## 为什么这个文件喂的是合成配对向量，而本语料喂不出真数据
 *
 * §2.3.2 要两名标注者独立逐规则标注，§2.3.4 要「总体原始一致率 ≥95%；针对 HARD_BLOCK 的
 * Cohen's κ ≥0.80」。本单只有一名标注者（实现者本人）⇒ **没有第二个向量可配对**，
 * 一致率不是「测出来不达标」，是「不可测」。这件事由 `admissionOf` 的
 * `annotatorCount < 2 ⇒ UNMEASURABLE` 分支结构性地钉住，见下面倒数第三组断言。
 *
 * 但「不可测」不等于「计算器可以是桩」。`agreement.ts` 的文件头把两种写法摆在一起，
 * ✗ 掉的是恒返回 NOT_MET 的空心桩，理由是「κ 的公式写错一个下标，桩照样绿」。
 * 所以本文件用**手算已知答案**的配对向量走真计算器：κ=1、κ=0、κ<0、pe=1 退化四种边界，
 * 加一个 κ 达标但原始一致率不达标的混合例、一个真 MET 例、一个 NOT_APPLICABLE 稀释例。
 * 等第二名标注者到位时，被验过的正是同一个函数。
 *
 * ## 每个期望值都是手算的，写在断言旁边
 *
 * κ = (po − pe) / (1 − pe)，pe = Σ_c p_a(c)·p_b(c)。
 * 正类特定一致率（Cicchetti）= 2·(两人都标该类) / [2·(两人都标) + A 独标 + B 独标]，
 * 分母 0 ⇒ **null 而不是 1**。
 * 下面每一组都把边际分布与 pe 逐项列出，为的是让「算错一个下标」在读代码时就能被看出来，
 * 而不是只有跑挂了才知道。
 */

import { describe, expect, it } from 'vitest';

import {
  admissionOf,
  agreementOf,
  pairAnnotations,
  type PairedAnnotation,
} from '../src/corpus/agreement.js';
import { type AnnotationLabel } from '../src/corpus/generator.js';
import { ANNOTATION_LABELS, highestLabel, labelRank } from '../src/corpus/manifest.js';
import { corpusPolicy } from '../src/corpus/package.js';
import {
  ADMISSION_AGREEMENT_TARGET,
  ADMISSION_KAPPA_TARGET,
  ANNOTATION_MODE,
  CORPUS_VERSION,
  corpusRulesetVersion,
  versionTriple,
} from '../src/corpus/versions.js';

/** 一个配对向量：`[A 标的, B 标的]`。 */
type Vector = readonly [AnnotationLabel, AnnotationLabel];

function pairsOf(vectors: readonly Vector[]): readonly PairedAnnotation[] {
  return vectors.map(([a, b], index) => ({
    key: `case-${String(index).padStart(3, '0')}|B1`,
    a,
    b,
  }));
}

function repeat(vector: Vector, times: number): Vector[] {
  // `Vector` 是 readonly 元组，同一个引用可以重复填进数组：下游只读不写。
  return Array.from({ length: times }, () => vector);
}

const HARD_BLOCK: AnnotationLabel = 'HARD_BLOCK';
const SAFE: AnnotationLabel = 'SAFE';
const CONFIRM_REQUIRED: AnnotationLabel = 'CONFIRM_REQUIRED';
const NOT_APPLICABLE: AnnotationLabel = 'NOT_APPLICABLE';

describe('§2.3.4 一致性：κ 的四种边界', () => {
  it('κ=1：完全一致且边际非退化 ⇒ 恰好 1（不是 NaN，不是 null）', () => {
    // A: HB 2 / SAFE 2；B: HB 2 / SAFE 2 ⇒ po=4/4=1，pe=0.25+0.25=0.5
    // κ = (1 − 0.5) / (1 − 0.5) = 1
    const report = agreementOf(
      pairsOf([...repeat([HARD_BLOCK, HARD_BLOCK], 2), ...repeat([SAFE, SAFE], 2)]),
    );
    expect(report.itemCount).toBe(4);
    expect(report.annotatorCount).toBe(2);
    expect(report.rawAgreement).toBe(1);
    expect(report.expectedAgreement).toBeCloseTo(0.5, 12);
    expect(report.kappaDegenerate).toBe(false);
    expect(report.cohenKappa).toBeCloseTo(1, 12);
    expect(report.hardBlockPositiveAgreement).toBeCloseTo(1, 12);
    expect(admissionOf(report, 2).status).toBe('MET');
  });

  it('κ=0：一致率恰好等于机会水平 ⇒ 0，且准入给出两条理由', () => {
    // A=[HB,HB,CONF,CONF] B=[HB,CONF,HB,CONF] ⇒ po=2/4=0.5
    // A: HB 2 / CONF 2；B: HB 2 / CONF 2 ⇒ pe=0.25+0.25=0.5 ⇒ κ=(0.5−0.5)/0.5=0
    const report = agreementOf(
      pairsOf([
        [HARD_BLOCK, HARD_BLOCK],
        [HARD_BLOCK, CONFIRM_REQUIRED],
        [CONFIRM_REQUIRED, HARD_BLOCK],
        [CONFIRM_REQUIRED, CONFIRM_REQUIRED],
      ]),
    );
    expect(report.rawAgreement).toBeCloseTo(0.5, 12);
    expect(report.expectedAgreement).toBeCloseTo(0.5, 12);
    expect(report.cohenKappa).toBeCloseTo(0, 12);
    expect(report.kappaDegenerate).toBe(false);

    const verdict = admissionOf(report, 2);
    expect(verdict.status).toBe('NOT_MET');
    // 原始一致率 0.50 < 0.95，κ 0 < 0.80 ⇒ 两条独立理由，不是一条合并的
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toContain('总体原始一致率 50.00%');
    expect(verdict.reasons[1]).toContain("Cohen's κ 0.0000");
  });

  it('κ<0：一致性低于机会水平 ⇒ 负值，不截断成 0', () => {
    // A=[HB,HB,CONF,CONF] B=[CONF,CONF,HB,HB] ⇒ po=0
    // 两侧边际相同（各 2/2）⇒ pe=0.5 ⇒ κ=(0−0.5)/0.5 = −1
    const report = agreementOf(
      pairsOf([
        [HARD_BLOCK, CONFIRM_REQUIRED],
        [HARD_BLOCK, CONFIRM_REQUIRED],
        [CONFIRM_REQUIRED, HARD_BLOCK],
        [CONFIRM_REQUIRED, HARD_BLOCK],
      ]),
    );
    expect(report.rawAgreement).toBe(0);
    expect(report.cohenKappa).toBeCloseTo(-1, 12);
    // 负 κ 是合法测量结果。截断成 0 会让「比瞎猜还差」与「等于瞎猜」不可区分。
    expect(report.cohenKappa).toBeLessThan(0);
    expect(admissionOf(report, 2).status).toBe('NOT_MET');
  });

  it('pe=1 退化：两人对每一件都用了同一个单一类别 ⇒ κ 无定义为 null，不是 0 也不是 1', () => {
    // 全部 (HB,HB) ⇒ po=1，A: HB 4；B: HB 4 ⇒ pe=(4/4)·(4/4)=1 ⇒ κ=0/0 无定义
    const report = agreementOf(pairsOf(repeat([HARD_BLOCK, HARD_BLOCK], 4)));
    expect(report.rawAgreement).toBe(1);
    expect(report.expectedAgreement).toBeCloseTo(1, 12);
    expect(report.kappaDegenerate).toBe(true);
    expect(report.cohenKappa).toBeNull();

    // §2.3.4：κ 因低发生率失真时**同时报告正类一致率与类别分布** —— 这两样必须还在。
    expect(report.hardBlockPositiveAgreement).toBeCloseTo(1, 12);
    expect(report.distributionA.HARD_BLOCK).toBe(4);
    expect(report.distributionB.HARD_BLOCK).toBe(4);

    const verdict = admissionOf(report, 2);
    expect(verdict.status).toBe('NOT_MET');
    expect(verdict.cohenKappa).toBeNull();
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain("Cohen's κ 无定义");
  });

  it('从未被任何一方使用的类别：正类一致率是 null，不是 1', () => {
    const report = agreementOf(pairsOf(repeat([HARD_BLOCK, HARD_BLOCK], 3)));
    for (const label of [SAFE, CONFIRM_REQUIRED, NOT_APPLICABLE]) {
      const entry = report.perClass[label];
      expect(entry.bothCount).toBe(0);
      // 报 1 会凭空抬高整体印象：没有观测就没有一致率可言。
      expect(entry.positiveAgreement).toBeNull();
      expect(entry.prevalenceA).toBe(0);
      expect(entry.prevalenceB).toBe(0);
    }
    expect(report.perClass.HARD_BLOCK.positiveAgreement).toBeCloseTo(1, 12);
    expect(report.notApplicableRatio).toBe(0);
  });
});

describe('§2.3.4 一致性：手算 n=20 的完整报告', () => {
  // 9×(HB,HB) + 1×(HB,SAFE) + 6×(SAFE,SAFE) + 1×(SAFE,CONF) + 3×(CONF,CONF) = 20 件
  // 一致 9+6+3 = 18 ⇒ po = 18/20 = 0.90
  // A 边际：HB 10 / SAFE 7 / CONF 3 / NA 0
  // B 边际：HB  9 / SAFE 7 / CONF 4 / NA 0
  // pe = (10/20)(9/20) + (7/20)(7/20) + (3/20)(4/20) = 0.225 + 0.1225 + 0.03 = 0.3775
  // κ  = (0.90 − 0.3775) / (1 − 0.3775) = 0.5225 / 0.6225 = 209/249 ≈ 0.83936
  const vectors: Vector[] = [
    ...repeat([HARD_BLOCK, HARD_BLOCK], 9),
    [HARD_BLOCK, SAFE],
    ...repeat([SAFE, SAFE], 6),
    [SAFE, CONFIRM_REQUIRED],
    ...repeat([CONFIRM_REQUIRED, CONFIRM_REQUIRED], 3),
  ];
  const report = agreementOf(pairsOf(vectors));

  it('po / pe / κ 与手算逐项相符', () => {
    expect(report.itemCount).toBe(20);
    expect(report.rawAgreement).toBeCloseTo(0.9, 12);
    expect(report.expectedAgreement).toBeCloseTo(0.3775, 12);
    expect(report.cohenKappa).toBeCloseTo(209 / 249, 12);
    expect(report.kappaDegenerate).toBe(false);
  });

  it('类别分布等于两侧边际计数', () => {
    expect(report.distributionA).toEqual({
      NOT_APPLICABLE: 0,
      SAFE: 7,
      CONFIRM_REQUIRED: 3,
      HARD_BLOCK: 10,
    });
    expect(report.distributionB).toEqual({
      NOT_APPLICABLE: 0,
      SAFE: 7,
      CONFIRM_REQUIRED: 4,
      HARD_BLOCK: 9,
    });
    // 边际之和必须等于件数，否则分布表本身算错了
    expect(ANNOTATION_LABELS.reduce((sum, label) => sum + report.distributionA[label], 0)).toBe(20);
    expect(ANNOTATION_LABELS.reduce((sum, label) => sum + report.distributionB[label], 0)).toBe(20);
  });

  it('逐类正类一致率与手算相符（2·both / (2·both + 仅A + 仅B)）', () => {
    // HB：both 9，仅 A 标 HB 1 件（那件 (HB,SAFE)），仅 B 标 HB 0 件 ⇒ 18/19
    expect(report.perClass.HARD_BLOCK.bothCount).toBe(9);
    expect(report.perClass.HARD_BLOCK.positiveAgreement).toBeCloseTo(18 / 19, 12);
    expect(report.hardBlockPositiveAgreement).toBeCloseTo(18 / 19, 12);
    // SAFE：both 6，(HB,SAFE) 让 B 独占 1，(SAFE,CONF) 让 A 独占 1 ⇒ 12/14 = 6/7
    expect(report.perClass.SAFE.positiveAgreement).toBeCloseTo(6 / 7, 12);
    // CONF：both 3，(SAFE,CONF) 让 B 独占 1 ⇒ 6/7
    expect(report.perClass.CONFIRM_REQUIRED.positiveAgreement).toBeCloseTo(6 / 7, 12);
    expect(report.confirmRequiredAgreement).toBeCloseTo(6 / 7, 12);
    expect(report.perClass.NOT_APPLICABLE.positiveAgreement).toBeNull();
  });

  it('κ 达标但原始一致率不达标 ⇒ NOT_MET，且只有那一条理由', () => {
    const verdict = admissionOf(report, 2);
    expect(verdict.status).toBe('NOT_MET');
    expect(verdict.rawAgreement).toBeCloseTo(0.9, 12);
    expect(verdict.cohenKappa).toBeCloseTo(209 / 249, 12);
    expect(verdict.hardBlockPositiveAgreement).toBeCloseTo(18 / 19, 12);
    expect(verdict.confirmRequiredAgreement).toBeCloseTo(6 / 7, 12);
    expect(verdict.rawAgreementTarget).toBe(ADMISSION_AGREEMENT_TARGET);
    expect(verdict.kappaTarget).toBe(ADMISSION_KAPPA_TARGET);
    // κ=0.839 ≥ 0.80 通过，0.90 < 0.95 不通过 ⇒ 恰好一条理由。
    // 两条判据必须**分别**判：合并成「一致性不足」会看不出到底缺哪一半。
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain('总体原始一致率 90.00%');
  });
});

describe('§2.3.4 一致性：准入达成的正例', () => {
  it('n=40、po=0.95、κ=0.9 ⇒ status MET（证明计算器不是恒 NOT_MET 的桩）', () => {
    // 19×(HB,HB) + 1×(HB,SAFE) + 19×(SAFE,SAFE) + 1×(SAFE,HB) = 40 件
    // 一致 19+19 = 38 ⇒ po = 38/40 = 0.95（恰好等于目标，判据是 `<` 不是 `<=`）
    // 两侧边际都是 HB 20 / SAFE 20 ⇒ pe = 0.25+0.25 = 0.5 ⇒ κ = 0.45/0.5 = 0.9
    const report = agreementOf(
      pairsOf([
        ...repeat([HARD_BLOCK, HARD_BLOCK], 19),
        [HARD_BLOCK, SAFE],
        ...repeat([SAFE, SAFE], 19),
        [SAFE, HARD_BLOCK],
      ]),
    );
    expect(report.rawAgreement).toBeCloseTo(0.95, 12);
    expect(report.cohenKappa).toBeCloseTo(0.9, 12);
    const verdict = admissionOf(report, 2);
    expect(verdict.status).toBe('MET');
    expect(verdict.reasons).toHaveLength(0);
    expect(verdict.annotatorCount).toBe(2);
    expect(verdict.requiredAnnotatorCount).toBe(2);
  });

  it('NOT_APPLICABLE 稀释：一致率与 κ 都满分也照样 NOT_MET', () => {
    // 30×(NA,NA) + 5×(HB,HB) + 5×(SAFE,SAFE) = 40 件，全一致 ⇒ po=1
    // pe = 0.75² + 0.125² + 0.125² = 0.5625 + 0.015625 + 0.015625 = 0.59375 ⇒ κ = 1
    // NA 占比 = (0.75 + 0.75)/2 = 0.75 > 0.5
    const report = agreementOf(
      pairsOf([
        ...repeat([NOT_APPLICABLE, NOT_APPLICABLE], 30),
        ...repeat([HARD_BLOCK, HARD_BLOCK], 5),
        ...repeat([SAFE, SAFE], 5),
      ]),
    );
    expect(report.rawAgreement).toBe(1);
    expect(report.cohenKappa).toBeCloseTo(1, 12);
    expect(report.notApplicableRatio).toBeCloseTo(0.75, 12);

    const verdict = admissionOf(report, 2);
    expect(verdict.status).toBe('NOT_MET');
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain('NOT_APPLICABLE 占比 75.00%');
    // §2.3.4 的原话：不能拿大量 NOT_APPLICABLE 稀释。
    // 没有这条，一个「两件都标 NA」的语料能刷出 κ=1 的完美假象。
    expect(verdict.reasons[0]).toContain('不得单独作为准入依据');
  });
});

describe('§2.3.2 结构性不可测：一名标注者 ⇒ UNMEASURABLE', () => {
  // 这份报告本身是**达标**的（2×(HB,HB) + 2×(SAFE,SAFE) ⇒ po=1，pe=0.5，κ=1，NA 占比 0）。
  // 故意选达标的：只有当同一份报告在 annotatorCount=2 时判 MET、在 1 时判 UNMEASURABLE，
  // 才能证明拦下它的是「没有第二个向量」这道前提闸，而不是指标本身不够。
  // 若这里用一份 pe=1 的退化报告，UNMEASURABLE 与 NOT_MET 就分不清是谁在起作用。
  const realReport = agreementOf(
    pairsOf([...repeat([HARD_BLOCK, HARD_BLOCK], 2), ...repeat([SAFE, SAFE], 2)]),
  );

  it('annotatorCount=1 且无第二向量 ⇒ 四项指标全是 null，不是 0 也不是 1', () => {
    const verdict = admissionOf(null, 1);
    expect(verdict.status).toBe('UNMEASURABLE');
    expect(verdict.annotatorCount).toBe(1);
    expect(verdict.requiredAnnotatorCount).toBe(2);
    expect(verdict.rawAgreement).toBeNull();
    expect(verdict.cohenKappa).toBeNull();
    expect(verdict.hardBlockPositiveAgreement).toBeNull();
    expect(verdict.confirmRequiredAgreement).toBeNull();
    expect(verdict.reasons).toHaveLength(4);
    expect(verdict.reasons.join('\n')).toContain(CORPUS_VERSION);
  });

  it('annotatorCount=0 同样 UNMEASURABLE，且目标值仍照实报出', () => {
    const verdict = admissionOf(null, 0);
    expect(verdict.status).toBe('UNMEASURABLE');
    expect(verdict.rawAgreementTarget).toBe(ADMISSION_AGREEMENT_TARGET);
    expect(verdict.kappaTarget).toBe(ADMISSION_KAPPA_TARGET);
  });

  it('递一份达标的真报告也不给测：annotatorCount 是判定的第一道闸', () => {
    // 「不可测」与「未达标」必须可区分：前者是连测的前提都不存在，后者是测了不够。
    // 混为一谈，下一版补了第二名标注者之后就看不出指标是从「不可测」还是从「不达标」改进来的。
    expect(admissionOf(realReport, 1).status).toBe('UNMEASURABLE');
    expect(admissionOf(realReport, 1).rawAgreement).toBeNull();
    expect(admissionOf(realReport, 2).status).toBe('MET');
  });
});

describe('配对构造的两处硬失败', () => {
  it('agreementOf 对重复配对键抛错：重复会让分母虚高、一致率虚高', () => {
    const duplicate: PairedAnnotation = { key: 'case-000|B1', a: HARD_BLOCK, b: HARD_BLOCK };
    expect(() => agreementOf([duplicate, duplicate])).toThrow(/配对键重复 case-000\|B1/);
  });

  it('空配对集不抛错，但所有比率是 0 / null，不会伪造出一致率', () => {
    const report = agreementOf([]);
    expect(report.itemCount).toBe(0);
    expect(report.rawAgreement).toBe(0);
    expect(report.expectedAgreement).toBe(0);
    expect(report.cohenKappa).toBeCloseTo(0, 12);
    expect(report.kappaDegenerate).toBe(false);
    expect(report.notApplicableRatio).toBe(0);
    for (const label of ANNOTATION_LABELS) {
      expect(report.perClass[label].positiveAgreement).toBeNull();
    }
  });

  it('pairAnnotations 键集不同即抛错：少配一对就少一个分母', () => {
    const a = new Map<string, AnnotationLabel>([
      ['k1', HARD_BLOCK],
      ['k2', SAFE],
    ]);
    const b = new Map<string, AnnotationLabel>([['k1', HARD_BLOCK]]);
    expect(() => pairAnnotations(a, b)).toThrow(/1 个键只在一侧出现/);
    expect(() => pairAnnotations(b, a)).toThrow(/1 个键只在一侧出现/);
  });

  it('pairAnnotations 的输出顺序由键决定，与 Map 的插入顺序无关', () => {
    const a = new Map<string, AnnotationLabel>([
      ['k9', SAFE],
      ['k1', HARD_BLOCK],
    ]);
    const b = new Map<string, AnnotationLabel>([
      ['k1', SAFE],
      ['k9', HARD_BLOCK],
    ]);
    const forward = pairAnnotations(a, b);
    const backward = pairAnnotations(new Map([...a].reverse()), new Map([...b].reverse()));
    expect(forward.map((pair) => pair.key)).toEqual(['k1', 'k9']);
    expect(backward).toEqual(forward);
    // 顺序确定 ⇒ 报告里的逐类计数与 hash 可复现，不看运行时枚举顺序的脸色
    expect(agreementOf(forward)).toEqual(agreementOf(backward));
  });
});

describe('语料级准入钉死（§2.5：1.0.0 必须双标后才 release）', () => {
  it('版本三元组上的 admissionMet / reportStatus / annotationMode 是字面量常量', () => {
    const triple = versionTriple(corpusPolicy(), 'scanner-unit-test-v1');
    expect(triple.admissionMet).toBe(false);
    expect(triple.reportStatus).toBe('provisional');
    expect(triple.annotationMode).toBe('implementer-pass');
    expect(triple.annotationMode).toBe(ANNOTATION_MODE);
    expect(triple.corpusVersion).toBe(CORPUS_VERSION);
  });

  it('corpusVersion 是 0.x 的 rc，不是 1.0.0', () => {
    // §2.5：`corpus 1.0.0` 必须达到配额、双标、可运行验证后才 release。
    // 三个前提里「双标」结构性不成立 ⇒ 版本号只能是 0.x/rc，这不是风格选择。
    expect(CORPUS_VERSION).toMatch(/^0\.\d+\.\d+-rc\.\d+$/);
    expect(CORPUS_VERSION).not.toBe('1.0.0');
  });

  it('rulesetVersion 由 policy 内容派生：同输入同版本，配置词库一变版本就变', () => {
    const policy = corpusPolicy();
    const base = corpusRulesetVersion(policy);
    expect(base).toMatch(/^ruleset-corpus-[0-9a-f]{16}$/);
    // 确定性：同一份 policy 两次算出同一个版本，否则 pin 下来的报告没有可复现性。
    expect(corpusRulesetVersion(corpusPolicy())).toBe(base);
    // §2.6「配置词库变化必须改变 ruleset hash，不能继续使用旧 PASS」。
    // 用 knownTrackingDomains 而不是 allowWasm：后两者在 v1 被冻结成字面量 false
    // （types.ts:58-60），类型层面就不允许改，而追踪域名表正是可配置的那一类。
    const domains = [...policy.knownTrackingDomains];
    const withExtraDomain = corpusRulesetVersion(
      corpusPolicy({ knownTrackingDomains: [...domains, 'example.test'] }),
    );
    expect(withExtraDomain).not.toBe(base);
    // 顺序不参与：policyFingerprint 对这两个表取排序副本，
    // 所以「只是换了个顺序」不算配置变化 —— 否则 CI 会因为无关的排序抖动全线重跑。
    const reordered = corpusRulesetVersion(
      corpusPolicy({ knownTrackingDomains: domains.slice().reverse() }),
    );
    expect(reordered).toBe(base);
  });

  it('标注标签表就是 §2.3.2 的四档，且数组顺序与处置等级序一致', () => {
    expect(ANNOTATION_LABELS).toEqual(['NOT_APPLICABLE', 'SAFE', 'CONFIRM_REQUIRED', 'HARD_BLOCK']);
    // §2.3.2「作品整体分类按最高处置等级」⇒ 「最高」由 labelRank 定义。
    // 数组顺序必须与 rank 同向：报告里的类别分布、准入门禁的 NA 稀释判据都按这个序读表。
    const ranks = ANNOTATION_LABELS.map((label) => labelRank(label));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(new Set(ranks).size).toBe(ANNOTATION_LABELS.length);
    expect(highestLabel(['SAFE', 'HARD_BLOCK', 'NOT_APPLICABLE'])).toBe('HARD_BLOCK');
    expect(highestLabel(['SAFE', 'CONFIRM_REQUIRED'])).toBe('CONFIRM_REQUIRED');
    // 空集回落到 NOT_APPLICABLE：不给「没有标注」伪造一个安全结论。
    expect(highestLabel([])).toBe('NOT_APPLICABLE');
  });
});

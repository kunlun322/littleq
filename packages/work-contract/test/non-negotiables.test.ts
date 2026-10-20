/**
 * ZLQ-201 PASS §6 的三条不可谈判项，逐条钉成测试（ZLQ-206 §4）。
 *
 * 这三条不是「实现时注意一下」的风格要求，而是**判据本身**。所以每一条都从两个方向测：
 *
 * - **正向**：先给一件真的达标的输入，证明断言不是因为「永远返回 false / 永远抛错」而绿。
 *   §5「零命中的门没有正对照就等于没测」在这里同样适用 —— 一条只会红的断言和一条只会绿的
 *   断言一样没有信息量。
 * - **反向**：把达标条件破坏掉，断言必须变红。§8 的变异对照 1、2 打的就是这两处。
 *
 * ## 三条不可谈判项各自钉在哪
 *
 * 1. **TP=0 不算通过，且不得报告 precision=100%。**
 *    钉在 `verdict.ts` 的判读接口上：`hardHits === 0` ⇒ `precision === null`（**不是 1**）、
 *    `precisionState === 'ZERO_HARD_HITS'`、`meetsPrecisionTarget === false`，
 *    且整份语料产出 `zero-hard-hits` 缺口、`meetsTargets === false`。
 *    变异对照 2 把 `verdict.ts` 里那唯一一处除法的 `null` 分支改成 `1` ⇒ 本文件必须红。
 *
 * 2. **B12 上任何硬阻断 = 直接失败。**
 *    钉在**三个互相独立的平面**上，因为其中任何一个都可能被单独改掉：
 *    ① 注册表自检（`registryViolations()` 为空，含「B12 的 maxDisposition 必须是
 *    CONFIRM_REQUIRED」与「规则不得自我扩权」两条）；② 冻结处置上限的字面量本身；
 *    ③ **运行时**：拿冻结上限造一个 `FindingFactory`，喂它一条 B12 的 BLOCK 草稿必须抛
 *    `DispositionCeilingError` —— 而不是被静默降级成 CONFIRM_REQUIRED（降级会让成人复核
 *    队列里多出一条本不该存在的项，同时把「B12 硬拦了」这件事藏起来）。
 *    外加一件真作品的端到端：B12 的文案命中只能落成 CONFIRM_REQUIRED。
 *    变异对照 1 把 B12 的 `disposition` 改成 `BLOCK` ⇒ ①③ 与端到端至少一条必须红。
 *    **若都不红，说明「B12 永不硬拦」根本没有被实现，只是被写在注释里。**
 *
 * 3. **设计里的量不得替代实测语料。**
 *    钉在「空语料不得读成达标」上：`safeSamples === 0` ⇒ 误拦率是 `null` 而不是 `0`、
 *    状态是 `NO_SAMPLES`、`meetsTargets === false`；13 条规则少提交一条 ⇒ 抛
 *    `CorpusInputError`（漏测的规则不能被当成达标）；计数形状非法 ⇒ 抛。
 *    D3a 交付的是接口，**本文件不声称任何 FPR / precision 数字已达标**（§12.9）。
 *
 * ⚠️ 这里的语料数字全部是**手工构造的判读输入**，用来验证判读逻辑本身；
 * 它们不是 ZLQ-156 §2.1 那 600+780 件实测语料，也不得被当成它的替代品。
 */

import { describe, expect, it } from 'vitest';

import {
  DispositionCeilingError,
  FROZEN_DISPOSITION_CEILING,
  FindingFactory,
} from '../src/scan/finding.js';
import type { FindingDraft } from '../src/scan/finding.js';
import { RULE_BY_ID, registryViolations } from '../src/scan/rules/index.js';
import type { Disposition, RuleId } from '../src/scan/types.js';
import { RULE_IDS } from '../src/scan/types.js';
import {
  CorpusInputError,
  TARGET_FALSE_BLOCK_RATE,
  TARGET_PRECISION,
  evaluateCorpus,
  evaluateRule,
  primaryShortfall,
} from '../src/scan/verdict.js';
import type { CorpusInput, RuleAnnotation, ShortfallKind } from '../src/scan/verdict.js';
import {
  SAFE_INDEX_HTML,
  attributeSubType,
  buildPackage,
  findingsOf,
  scanToReport,
  subTypeRegistry,
} from './support.js';

/** 上限为 BLOCK 的 12 条（§8.3 的拦截类别）。从冻结表派生，不抄一遍 id。 */
const BLOCK_RULES = RULE_IDS.filter((ruleId) => FROZEN_DISPOSITION_CEILING[ruleId] === 'BLOCK');

/** 上限为 CONFIRM_REQUIRED 的规则。断言它恰好是 B12 一条，多一条都意味着上限表被改宽了。 */
const CONFIRM_ONLY_RULES = RULE_IDS.filter(
  (ruleId) => FROZEN_DISPOSITION_CEILING[ruleId] === 'CONFIRM_REQUIRED',
);

type Counts = Pick<RuleAnnotation, 'annotatedSamples' | 'hardHits' | 'trueHardBlocks'>;

/**
 * 造一份覆盖全部 13 条规则的标注集。`perRule` 覆盖个别规则 ——
 * 语料级断言必须建立在**完整覆盖**上，否则测的是「抛异常」而不是「判读结论」。
 */
function annotations(base: Counts, perRule: Partial<Record<RuleId, Partial<Counts>>> = {}) {
  return RULE_IDS.map((ruleId) => ({
    ruleId,
    ...base,
    ...perRule[ruleId],
  }));
}

function corpus(safeSamples: number, safeHardBlocked: number, rules: readonly RuleAnnotation[]) {
  const input: CorpusInput = { safeSamples, safeHardBlocked, rules };
  return evaluateCorpus(input);
}

function kinds(shortfalls: readonly { kind: ShortfallKind }[]): ShortfallKind[] {
  return shortfalls.map((shortfall) => shortfall.kind);
}

/** 12 条拦截规则都「测出来了且达标」的那一组计数。 */
const MEASURED_AND_PASSING: Counts = { annotatedSamples: 100, hardHits: 50, trueHardBlocks: 50 };

/**
 * 一份**真的达标**的判读输入。它是本文件所有「必须 false」断言的正对照：
 * 没有它，一个把所有输入都判成不达标的实现同样能跑绿。
 *
 * B12 的那条覆盖不是可选项：`MEASURED_AND_PASSING` 给**每条**规则都配了 50 次硬阻断，
 * 而 B12 的达标条件是「硬阻断数为 0」—— 忘记覆盖它，正对照自己就会带上
 * `b12-hard-block`，于是「只有一处不达标」这类断言全被它污染。
 */
function passingAnnotations(perRule: Partial<Record<RuleId, Partial<Counts>>> = {}) {
  return annotations(MEASURED_AND_PASSING, {
    B12: { annotatedSamples: 100, hardHits: 0, trueHardBlocks: 0 },
    ...perRule,
  });
}

describe('non-negotiables：不可谈判项 1 —— TP=0 不算通过，且不得报告 precision=100%', () => {
  it('正对照：一条真的测出命中的规则，precision 是数字且达标', () => {
    const verdict = evaluateRule({
      ruleId: 'B2',
      annotatedSamples: 100,
      hardHits: 50,
      trueHardBlocks: 49,
    });
    expect(verdict.precisionState).toBe('MEASURED');
    expect(verdict.precision).toBe(0.98);
    expect(verdict.precisionTargetApplies, 'B2 的冻结上限是 BLOCK').toBe(true);
    expect(verdict.meetsPrecisionTarget, '0.98 ≥ §8.6 的 98% 要求').toBe(true);
    expect(verdict.falseHardBlocks).toBe(1);
  });

  it('正对照的另一侧：precision 低于目标 ⇒ 不达标，且缺口是 precision-below-target', () => {
    const verdict = corpus(
      600,
      0,
      passingAnnotations({ B2: { annotatedSamples: 100, hardHits: 50, trueHardBlocks: 40 } }),
    );
    const b2 = verdict.rules.find((rule) => rule.ruleId === 'B2');
    expect(b2?.precision).toBe(0.8);
    expect(b2?.meetsPrecisionTarget).toBe(false);
    expect(kinds(verdict.shortfalls), '只有 B2 一处不达标').toEqual(['precision-below-target']);
    expect(verdict.meetsTargets).toBe(false);
  });

  it('TP=0 时 precision 是 null，不是 1，不是 0', () => {
    const verdict = evaluateRule({
      ruleId: 'B1',
      annotatedSamples: 100,
      hardHits: 0,
      trueHardBlocks: 0,
    });
    // 变异对照 2 就打在这一行：把 `hardHits > 0 ? … : null` 的 null 改成 1，本断言立刻红。
    expect(verdict.precision, '0/0 是未定义，不能写成 1.0').toBeNull();
    expect(verdict.precision, '也不能顺手写成 0').not.toBe(0);
    expect(verdict.precisionState, '「测了但一次没命中」与「没测」是两个状态').toBe(
      'ZERO_HARD_HITS',
    );
    expect(verdict.falseHardBlocks).toBe(0);
  });

  it('TP=0 不算通过：meetsPrecisionTarget 必须是 false', () => {
    const verdict = evaluateRule({
      ruleId: 'B1',
      annotatedSamples: 600,
      hardHits: 0,
      trueHardBlocks: 0,
    });
    expect(verdict.precisionTargetApplies).toBe(true);
    expect(verdict.meetsPrecisionTarget, '不可谈判项 1：TP=0 不算通过').toBe(false);
  });

  it('整份语料都是 TP=0 ⇒ 12 条 zero-hard-hits 缺口，meetsTargets 为 false', () => {
    // 误拦率这一侧是**达标**的（600 个安全样例、0 次误拦），所以 `meetsTargets` 为 false
    // 只能来自规则侧 —— 这正是「TP=0 不算通过」要证明的事：干净的误拦率救不了没命中的规则。
    const verdict = corpus(
      600,
      0,
      annotations({ annotatedSamples: 100, hardHits: 0, trueHardBlocks: 0 }),
    );
    expect(verdict.falseBlockRate).toBe(0);
    expect(verdict.meetsFalseBlockRateTarget, '误拦率这一侧确实达标').toBe(true);

    for (const rule of verdict.rules) {
      expect(rule.precision, `${rule.ruleId} 没有命中就没有 precision`).toBeNull();
      if (rule.precisionTargetApplies) {
        expect(rule.precisionState, rule.ruleId).toBe('ZERO_HARD_HITS');
        expect(rule.meetsPrecisionTarget, `${rule.ruleId} TP=0 不算通过`).toBe(false);
      }
    }

    expect(kinds(verdict.shortfalls), '12 条上限为 BLOCK 的规则各一条，B12 不适用').toEqual(
      BLOCK_RULES.map(() => 'zero-hard-hits'),
    );
    expect(
      verdict.shortfalls.map((s) => s.ruleId),
      '缺口按在册顺序，不按字母序',
    ).toEqual([...BLOCK_RULES]);
    expect(primaryShortfall(verdict)?.kind).toBe('zero-hard-hits');
    expect(verdict.meetsTargets).toBe(false);
  });

  it('NO_SAMPLES 与 ZERO_HARD_HITS 是两个可区分的状态', () => {
    // 合成一个 null 会让调优的人分不清「语料覆盖有洞」与「规则可能根本没在工作」。
    const noSamples = evaluateRule({
      ruleId: 'B1',
      annotatedSamples: 0,
      hardHits: 0,
      trueHardBlocks: 0,
    });
    const zeroHits = evaluateRule({
      ruleId: 'B1',
      annotatedSamples: 10,
      hardHits: 0,
      trueHardBlocks: 0,
    });
    expect(noSamples.precisionState).toBe('NO_SAMPLES');
    expect(zeroHits.precisionState).toBe('ZERO_HARD_HITS');
    expect(noSamples.precisionState).not.toBe(zeroHits.precisionState);
    expect([noSamples.precision, zeroHits.precision], '两者的 precision 都是 null').toEqual([
      null,
      null,
    ]);
  });

  it('冻结阈值就是 §8.6 原文的两个数', () => {
    expect(TARGET_FALSE_BLOCK_RATE, '§8.6「>2% 禁止合并」').toBe(0.02);
    expect(TARGET_PRECISION, '§8.6「每条硬拦规则要求 precision ≥98%」').toBe(0.98);
  });
});

describe('non-negotiables：不可谈判项 2 —— B12 上任何硬阻断 = 直接失败', () => {
  it('① 注册表自检：上限为 CONFIRM_REQUIRED 的规则恰好是 B12 一条，且注册表没有违规', () => {
    expect([...CONFIRM_ONLY_RULES], '冻结上限表里只有 B12 是确认档').toEqual(['B12']);
    expect([...BLOCK_RULES].length, '其余 12 条是拦截档').toBe(12);
    // `registryViolations()` 里含两条与 B12 直接相关的检查：CONFIRM_ONLY 规则的
    // `maxDisposition` 必须是 CONFIRM_REQUIRED，且任何规则的 `maxDisposition` 不得超过冻结上限。
    expect(registryViolations(), '规则注册表自检').toEqual([]);
    const b12 = RULE_BY_ID.get('B12');
    expect(b12, 'B12 必须注册在 RULES 里').toBeDefined();
    expect(b12?.maxDisposition).toBe('CONFIRM_REQUIRED');
  });

  it('② 冻结上限的字面量：B12 是 CONFIRM_REQUIRED', () => {
    // 判据不能由被判的对象提供：这里查的是 `finding.ts` 的冻结表，不是 B12 自己声明的上限。
    expect(FROZEN_DISPOSITION_CEILING.B12).toBe('CONFIRM_REQUIRED');
  });

  it('③ 运行时：喂给 FindingFactory 一条 B12 的 BLOCK 草稿必须抛，而不是被降级', () => {
    const factory = new FindingFactory({
      scannerVersion: 'scanner-test-v1',
      rulesetVersion: 'ruleset-test-v1',
      fileHashes: { 'index.html': 'a'.repeat(64) },
      ceiling: FROZEN_DISPOSITION_CEILING,
    });
    const draft: FindingDraft = {
      ruleId: 'B12',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: 'index.html',
      location: null,
      repairAction: 'CORRECT_CLAIM',
      subType: 'cloud-save',
    };

    let caught: unknown = null;
    try {
      factory.emit(draft);
    } catch (error) {
      caught = error;
    }
    expect(caught, 'B12 的硬阻断必须被拒绝').toBeInstanceOf(DispositionCeilingError);
    const ceilingError = caught as DispositionCeilingError;
    expect(ceilingError.code).toBe('DISPOSITION_CEILING_EXCEEDED');
    expect(ceilingError.ruleId).toBe('B12');
    expect(ceilingError.attempted).toBe('BLOCK');
    expect(ceilingError.ceiling).toBe('CONFIRM_REQUIRED');
    expect(factory.findings, '被拒绝的草稿不得留下任何 finding').toHaveLength(0);
  });

  it('③ 的正对照：同一个工厂放行 B12 的 CONFIRM_REQUIRED 与 B13 的 BLOCK', () => {
    // 没有这两条，上面那个「必须抛」可以被一个「对一切都抛」的工厂满足。
    const factory = new FindingFactory({
      scannerVersion: 'scanner-test-v1',
      rulesetVersion: 'ruleset-test-v1',
      fileHashes: { 'index.html': 'a'.repeat(64) },
      ceiling: FROZEN_DISPOSITION_CEILING,
    });
    const confirm = factory.emit({
      ruleId: 'B12',
      disposition: 'CONFIRM_REQUIRED',
      confidence: 'LOW',
      path: 'index.html',
      location: null,
      repairAction: 'CORRECT_CLAIM',
      subType: 'cloud-save',
    });
    expect(confirm, 'B12 的确认项是合法产出').not.toBeNull();
    expect(confirm?.disposition).toBe('CONFIRM_REQUIRED');

    const block = factory.emit({
      ruleId: 'B13',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: 'index.html',
      location: null,
      repairAction: 'CHANGE_CONTENT',
      subType: 'gambling-money',
    });
    expect(block, 'B13 的上限是 BLOCK，硬拦合法').not.toBeNull();
    expect(block?.disposition).toBe('BLOCK');
    expect(factory.findings).toHaveLength(2);
  });

  it('端到端：一件声称云存档的作品，B12 只产出 CONFIRM_REQUIRED，一次硬阻断都没有', async () => {
    const claimHtml = SAFE_INDEX_HTML.replace(
      '    <p>用左右方向键接住掉下来的星星。</p>',
      '    <p>本作品支持云存档，换台设备也还在。</p>',
    );
    // 正对照：先证明替换真的发生了。否则下面断言的是那件安全作品，
    // 「零个 BLOCK」会因为「零个 finding」而空洞地成立。
    expect(claimHtml, 'B12 的文案必须真的进了入口页').not.toBe(SAFE_INDEX_HTML);

    const built = buildPackage({ overrides: [{ path: 'index.html', content: claimHtml }] });
    const report = await scanToReport(built);
    const hits = findingsOf(report, 'B12');

    expect(hits.length, 'B12 必须真的命中，否则这条断言没有信息量').toBeGreaterThan(0);
    const declared = subTypeRegistry().get('B12') ?? [];
    const attributed = hits.map((f) => attributeSubType(f, built, declared) ?? '(归因失败)');
    expect(attributed, '命中的子类型').toContain('cloud-save');

    for (const finding of hits) {
      expect(
        finding.disposition,
        `B12 的 ${finding.findingId} 只能是确认项（§8.3「只标记确认，不硬拦」）`,
      ).toBe('CONFIRM_REQUIRED');
    }
    expect(
      hits.filter((f) => f.disposition === 'BLOCK').length,
      '不可谈判项 2：B12 上任何硬阻断 = 直接失败',
    ).toBe(0);
    expect(report.status, '整包状态由最高处置决定，B12 顶不到 BLOCK').toBe('CONFIRM_REQUIRED');
    expect(report.counts.confirm, '报告级确认计数').toBeGreaterThan(0);
  });

  it('判读层：一份其它各项都达标的语料里出现 3 次 B12 硬阻断 ⇒ b12-hard-block 是首要缺口', () => {
    const verdict = corpus(
      600,
      0,
      passingAnnotations({ B12: { annotatedSamples: 100, hardHits: 3, trueHardBlocks: 0 } }),
    );
    // 只有这一条缺口：B12 不适用 precision 要求，所以它的硬阻断**不得**被记成
    // 「precision 不达标」—— 那会把「直接失败」淡化为「指标不够好」。
    expect(kinds(verdict.shortfalls), 'B12 的硬阻断只能记成 b12-hard-block').toEqual([
      'b12-hard-block',
    ]);
    expect(primaryShortfall(verdict)?.ruleId).toBe('B12');
    expect(verdict.meetsTargets).toBe(false);
    const b12 = verdict.rules.find((rule) => rule.ruleId === 'B12');
    expect(b12?.precisionTargetApplies, 'B12 不适用 §8.6 的 precision 要求').toBe(false);
    expect(b12?.meetsPrecisionTarget, 'B12 的达标条件换成「硬阻断数为 0」').toBe(false);
  });

  it('判读层的正对照：B12 零硬阻断时，同一份语料没有任何 b12 缺口', () => {
    const verdict = corpus(600, 0, passingAnnotations());
    expect(kinds(verdict.shortfalls)).toEqual([]);
    const b12 = verdict.rules.find((rule) => rule.ruleId === 'B12');
    expect(b12?.meetsPrecisionTarget).toBe(true);
  });
});

describe('non-negotiables：不可谈判项 3 —— 设计里的量不得替代实测语料', () => {
  it('正对照：一份真的测出来且达标的语料，meetsTargets 为 true、缺口为空', () => {
    const verdict = corpus(600, 0, passingAnnotations());
    expect(verdict.falseBlockRate).toBe(0);
    expect(verdict.falseBlockRateState).toBe('MEASURED');
    expect(verdict.meetsFalseBlockRateTarget).toBe(true);
    expect(verdict.rules.every((rule) => rule.precisionState !== 'NO_SAMPLES')).toBe(true);
    expect(kinds(verdict.shortfalls)).toEqual([]);
    expect(primaryShortfall(verdict)).toBeNull();
    expect(verdict.meetsTargets, '这条正对照是上面所有「必须 false」的信息量来源').toBe(true);
  });

  it('空语料：safeSamples=0 ⇒ 误拦率是 null 而不是 0，且不可测', () => {
    const verdict = corpus(
      0,
      0,
      annotations({ annotatedSamples: 0, hardHits: 0, trueHardBlocks: 0 }),
    );
    // 0/0 写成 0 会让「一个样本都没测」读成「零误拦」。
    expect(verdict.falseBlockRate, '误拦率不可测时必须是 null').toBeNull();
    expect(verdict.falseBlockRate).not.toBe(0);
    expect(verdict.falseBlockRateState).toBe('NO_SAMPLES');
    expect(verdict.meetsFalseBlockRateTarget).toBe(false);
    expect(verdict.rules.every((rule) => rule.precision === null)).toBe(true);
    expect(verdict.meetsTargets, 'D3a 没有任何实测语料，这里必须读成不达标').toBe(false);
    expect(kinds(verdict.shortfalls)).toContain('false-block-rate-unmeasurable');
    expect(kinds(verdict.shortfalls), '13 条规则一条样本都没有').toContain('no-samples');
  });

  it('空语料的缺口里没有任何一条声称达标，且 no-samples 覆盖全部 13 条', () => {
    const verdict = corpus(
      0,
      0,
      annotations({ annotatedSamples: 0, hardHits: 0, trueHardBlocks: 0 }),
    );
    const noSamples = verdict.shortfalls.filter((s) => s.kind === 'no-samples');
    expect(
      noSamples.map((s) => s.ruleId),
      '漏测的规则必须逐条点名',
    ).toEqual([...RULE_IDS]);
    expect(kinds(verdict.shortfalls)).not.toContain('precision-below-target');
  });

  it('误拦率超阈：2.00% 恰好达标，超过就禁止合并', () => {
    // §8.6 原文是「>2% 禁止合并」，所以边界值本身是允许的。这条把边界钉死，
    // 免得日后有人把 `<=` 改成 `<` 而无人察觉。
    const atTarget = corpus(600, 12, passingAnnotations());
    expect(atTarget.falseBlockRate).toBe(0.02);
    expect(atTarget.meetsFalseBlockRateTarget, '12/600 = 2.00%，恰好在上限上').toBe(true);

    const overTarget = corpus(600, 13, passingAnnotations());
    expect(overTarget.meetsFalseBlockRateTarget).toBe(false);
    expect(kinds(overTarget.shortfalls)).toContain('false-block-rate-above-target');
    expect(overTarget.meetsTargets).toBe(false);
  });

  it('少提交一条规则的标注 ⇒ 抛 CorpusInputError（漏测的规则不能被当成达标）', () => {
    const partial = annotations(MEASURED_AND_PASSING).slice(0, RULE_IDS.length - 1);
    expect(partial.length, '确实少了一条').toBe(RULE_IDS.length - 1);
    const omitted = RULE_IDS[RULE_IDS.length - 1] ?? '(取不到)';

    let caught: unknown = null;
    try {
      corpus(600, 0, partial);
    } catch (error) {
      caught = error;
    }
    expect(caught, `少提交 ${omitted} 必须抛`).toBeInstanceOf(CorpusInputError);
    const inputError = caught as CorpusInputError;
    expect(inputError.code).toBe('CORPUS_INPUT_INVALID');
    expect(inputError.message, '异常必须点名漏了哪一条').toContain(omitted);
  });

  it('重复提交、未在册 id、计数形状非法 ⇒ 全部抛 CorpusInputError', () => {
    const full = annotations(MEASURED_AND_PASSING);
    const duplicated: RuleAnnotation[] = [
      ...full,
      { ruleId: 'B1', annotatedSamples: 100, hardHits: 50, trueHardBlocks: 50 },
    ];
    expect(() => corpus(600, 0, duplicated), 'B1 提交了两次').toThrowError(CorpusInputError);

    // `RuleId` 是闭合联合类型，未在册的 id 只能绕过类型系统构造 —— 这正是被测的那条运行时校验。
    const unknown: RuleAnnotation[] = [
      ...full,
      {
        ruleId: 'B14' as unknown as RuleId,
        annotatedSamples: 1,
        hardHits: 0,
        trueHardBlocks: 0,
      },
    ];
    expect(() => corpus(600, 0, unknown), 'B14 不在册').toThrowError(CorpusInputError);

    expect(
      () => corpus(600, 0, annotations(MEASURED_AND_PASSING, { B1: { hardHits: -1 } })),
      '负数计数',
    ).toThrowError(CorpusInputError);
    expect(
      () => corpus(600, 0, annotations(MEASURED_AND_PASSING, { B1: { annotatedSamples: 1.5 } })),
      '非整数计数',
    ).toThrowError(CorpusInputError);
    expect(
      () =>
        corpus(
          600,
          0,
          annotations(MEASURED_AND_PASSING, { B1: { hardHits: 2, trueHardBlocks: 3 } }),
        ),
      '真阳性数不得超过硬阻断数',
    ).toThrowError(CorpusInputError);
    expect(
      () => corpus(10, 11, annotations(MEASURED_AND_PASSING)),
      '误拦数不得超过安全样例数',
    ).toThrowError(CorpusInputError);
  });

  it('判读结果的规则顺序与传入顺序无关（可复现）', () => {
    const forward = corpus(600, 0, annotations(MEASURED_AND_PASSING));
    const reversed = corpus(600, 0, [...annotations(MEASURED_AND_PASSING)].reverse());
    expect(forward.rules.map((rule) => rule.ruleId)).toEqual([...RULE_IDS]);
    expect(
      reversed.rules.map((rule) => rule.ruleId),
      '倒着传也按在册顺序输出',
    ).toEqual([...RULE_IDS]);
  });
});

describe('non-negotiables：三条一起看 —— 处置类型与拦截类别的边界', () => {
  it('处置只有两档，BLOCK 与 CONFIRM_REQUIRED，没有第三档可以躲', () => {
    // 一条 B12 的硬阻断如果还能落成别的处置（例如新加一档 `WARN`），
    // 上面所有断言都会被绕开。这条把处置集合钉在 §6.2 的两档上。
    const dispositions = new Set<Disposition>(['BLOCK', 'CONFIRM_REQUIRED']);
    expect(dispositions.size).toBe(2);
    for (const ruleId of RULE_IDS) {
      const ceiling = FROZEN_DISPOSITION_CEILING[ruleId];
      expect(dispositions.has(ceiling), `${ruleId} 的冻结上限必须在两档之内`).toBe(true);
    }
  });
});

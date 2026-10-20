/**
 * 语料实测判读（ZLQ-153 §8.6 的两个指标 + ZLQ-201 PASS §6 的不可谈判项 1、2）。
 *
 * **本模块不产生任何指标数字，它只判读别人量出来的数字。** D3a 交付的是判定接口，
 * D3b 才有 1380 个已标注样本（ZLQ-156 §2.1）。所以这里最重要的不是算得对，
 * 而是**算不出来的时候不许假装算出来了**：
 *
 * 1. **不可谈判项 1：TP=0 不算通过，且不得报告 precision=100%。**
 *    一条硬拦规则在整个语料上一次都没硬拦过，它的 precision 是 `0/0` —— 未定义，不是 1.0。
 *    所以 `hardHits === 0` 时 `precision` 必须是 `null`，`precisionState` 必须是
 *    `ZERO_HARD_HITS`，而 `meetsPrecisionTarget` 必须是 **false**。
 *    这三件事在源码里没有别的分支可以绕过：`precision` 只在 `hardHits > 0` 的那一行被赋成数字，
 *    而那一行是模块里**唯一**出现除法的地方。把 `null` 改成 `1` 会让本模块的测试立刻变红。
 *
 * 2. **不可谈判项 2：B12 上任何硬阻断 = 直接失败。**
 *    B12 的处置上限是 `CONFIRM_REQUIRED`（`finding.ts` 的冻结表），所以对它而言
 *    「达标」的含义**不是** precision ≥98%，而是**硬阻断数为 0**。
 *    写成 `precisionTargetApplies === false` 的规则要求 `hardHits === 0`，
 *    就把这条不可谈判项从「规则自觉」变成了「判读结论」—— 一个 B12 硬阻断会同时
 *    产出 `b12-hard-block` 这个最高优先级的缺口，并把整份语料判为不达标。
 *
 * 3. **不可谈判项 3：设计里的量不得替代实测语料。**
 *    `meetsTargets` 要求**每一条**规则都处于 `MEASURED` 状态、且安全样本数 > 0。
 *    任何 `ZERO_HARD_HITS` / `NO_SAMPLES` / 不可测的误拦率都会让它为 false。
 *    「全部 18 道门绿」在这里换不来一个 `meetsTargets: true`。
 *
 * 为什么上限查的是 `FROZEN_DISPOSITION_CEILING` 而不是规则自己的 `maxDisposition`：
 * 与 `finding.ts` 同一个理由 —— 判据不能由被判的对象提供，否则把 B12 改成 BLOCK
 * 会连「B12 不需要 precision」这个豁免一起改掉，缺口就消失了。
 */

import { FROZEN_DISPOSITION_CEILING } from './finding.js';
import type { RuleId } from './types.js';
import { RULE_IDS } from './types.js';

/** §8.6 原文：`false_block_rate = 安全样例硬拦数 / 安全样例数，>2% 禁止合并`。 */
export const TARGET_FALSE_BLOCK_RATE = 0.02;

/** §8.6 原文：`每条硬拦规则要求 precision ≥98%`。 */
export const TARGET_PRECISION = 0.98;

/**
 * 一条规则的 precision 处于什么状态。
 *
 * 三个值而不是两个，是因为「没测」和「测了但一次没命中」是两件完全不同的事：
 * 前者是语料覆盖缺口（D3b 要补样本），后者是规则可能根本没在工作（要查规则本身）。
 * 把它们合成一个 `null` 会让调优的人朝错误的方向走。
 */
export type PrecisionState = 'MEASURED' | 'ZERO_HARD_HITS' | 'NO_SAMPLES';

export type FalseBlockRateState = 'MEASURED' | 'NO_SAMPLES';

/** 单条规则的语料输入。数字由 D3b 的标注流水线给出，本模块只校验形状、不猜测含义。 */
export type RuleAnnotation = {
  readonly ruleId: RuleId;
  /**
   * 标注员对该规则给出过判定的样本数。§2.3 的四个标签
   * （SAFE / HARD_BLOCK / CONFIRM_REQUIRED / NOT_APPLICABLE）**都算**标注过 ——
   * NOT_APPLICABLE 是有效结论（这个作品里没有这条规则能判的东西），不是缺失。
   */
  readonly annotatedSamples: number;
  /** 扫描器对该规则实际产出的**硬阻断**（BLOCK）数。CONFIRM_REQUIRED 不计入 precision 分母。 */
  readonly hardHits: number;
  /** 上述硬阻断中被标注确认为真阳性的数量。必须 ≤ `hardHits`。 */
  readonly trueHardBlocks: number;
};

export type RuleVerdict = {
  readonly ruleId: RuleId;
  readonly annotatedSamples: number;
  readonly hardHits: number;
  readonly trueHardBlocks: number;
  /** 派生量：`hardHits - trueHardBlocks`。误拦就是硬拦里的假阳性。 */
  readonly falseHardBlocks: number;
  /**
   * `hardHits > 0` 时是 `trueHardBlocks / hardHits`；否则是 **`null`**。
   * 不可谈判项 1：这里永远不会因为「没命中」而变成 1.0。
   */
  readonly precision: number | null;
  readonly precisionState: PrecisionState;
  /**
   * 这条规则是否**适用** §8.6 的 precision ≥98% 要求。
   * 由冻结处置上限派生：上限是 BLOCK 的规则才可能产出硬阻断，才谈得上 precision。
   * B12 的上限是 CONFIRM_REQUIRED ⇒ 这里是 false，它的达标条件换成 `hardHits === 0`。
   */
  readonly precisionTargetApplies: boolean;
  readonly meetsPrecisionTarget: boolean;
};

export type ShortfallKind =
  /** 不可谈判项 2。最高优先级：B12 出现任何硬阻断，整份语料直接判不达标。 */
  | 'b12-hard-block'
  /** 不可谈判项 1。硬拦规则一次没命中 ⇒ precision 不可测 ⇒ 不算通过。 */
  | 'zero-hard-hits'
  /** 这条规则一个标注样本都没拿到，语料覆盖有洞。 */
  | 'no-samples'
  | 'precision-below-target'
  /** §8.6：误拦率 >2% 禁止合并。 */
  | 'false-block-rate-above-target'
  /** 安全样本数为 0 ⇒ 误拦率是 0/0，不可测。 */
  | 'false-block-rate-unmeasurable';

export type Shortfall = {
  readonly kind: ShortfallKind;
  /** 语料级缺口（误拦率）没有单一责任规则，此时为 null。 */
  readonly ruleId: RuleId | null;
  /** 人读的一句话。不含学生内容、不含源码片段 —— 只含计数。 */
  readonly detail: string;
};

export type CorpusInput = {
  /** 已人工标注的**安全**样例总数（§8.6「至少 500 个」，§2.1 首版目标 600 个）。 */
  readonly safeSamples: number;
  /** 上述安全样例中被扫描器**硬阻断**的数量，即误拦数。 */
  readonly safeHardBlocked: number;
  /** 必须恰好覆盖 `RULE_IDS` 全部 13 条，各一次。缺一条或多一条都是调用方的错，直接抛。 */
  readonly rules: readonly RuleAnnotation[];
};

export type CorpusVerdict = {
  readonly safeSamples: number;
  readonly safeHardBlocked: number;
  /** `safeSamples > 0` 时是 `safeHardBlocked / safeSamples`；否则 **`null`**（不是 0）。 */
  readonly falseBlockRate: number | null;
  readonly falseBlockRateState: FalseBlockRateState;
  readonly meetsFalseBlockRateTarget: boolean;
  /** 顺序与 `RULE_IDS` 一致，与调用方传入顺序无关 —— 判读结果必须可复现。 */
  readonly rules: readonly RuleVerdict[];
  /** 按 `SHORTFALL_SEVERITY` 升序（最严重的在前）。空数组 = 没有任何缺口。 */
  readonly shortfalls: readonly Shortfall[];
  /**
   * 只有当误拦率**可测且达标**、且 13 条规则**全部** `MEASURED` 且达标时才为 true。
   * 任何一项不可测都是 false（不可谈判项 1、3）。
   */
  readonly meetsTargets: boolean;
};

/** 缺口的严重度序。`b12-hard-block` 排第一：它是「直接失败」，不是「指标不够好」。 */
const SHORTFALL_SEVERITY: Readonly<Record<ShortfallKind, number>> = {
  'b12-hard-block': 0,
  'false-block-rate-above-target': 1,
  'precision-below-target': 2,
  'zero-hard-hits': 3,
  'false-block-rate-unmeasurable': 4,
  'no-samples': 5,
};

/** 语料判读失败。计数形状不合法是标注流水线的缺陷，静默 clamp 会把它藏进指标里。 */
export class CorpusInputError extends Error {
  readonly code = 'CORPUS_INPUT_INVALID' as const;
  constructor(readonly reason: string) {
    super(`语料判读输入不合法：${reason}`);
    this.name = 'CorpusInputError';
  }
}

function requireCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new CorpusInputError(`${label} 必须是非负整数，实收 ${String(value)}`);
  }
}

/**
 * 判读一条规则。导出是为了让 D3b 能逐规则出表，也为了让本模块的测试直接打在判定点上
 * （§8 的变异对照 2 就是把 `precision` 的 `null` 分支改成 `1`）。
 */
export function evaluateRule(annotation: RuleAnnotation): RuleVerdict {
  const { ruleId, annotatedSamples, hardHits, trueHardBlocks } = annotation;
  requireCount(annotatedSamples, `${ruleId}.annotatedSamples`);
  requireCount(hardHits, `${ruleId}.hardHits`);
  requireCount(trueHardBlocks, `${ruleId}.trueHardBlocks`);
  if (trueHardBlocks > hardHits) {
    throw new CorpusInputError(
      `${ruleId}.trueHardBlocks(${trueHardBlocks}) 不能大于 hardHits(${hardHits})`,
    );
  }

  const falseHardBlocks = hardHits - trueHardBlocks;
  const precisionTargetApplies = FROZEN_DISPOSITION_CEILING[ruleId] === 'BLOCK';

  // 全模块唯一的除法。`hardHits === 0` 走 else，precision 是 null —— 不是 1，不是 0。
  const precision = hardHits > 0 ? trueHardBlocks / hardHits : null;

  const precisionState: PrecisionState =
    annotatedSamples === 0 ? 'NO_SAMPLES' : hardHits === 0 ? 'ZERO_HARD_HITS' : 'MEASURED';

  const meetsPrecisionTarget = precisionTargetApplies
    ? // 适用 precision 要求：必须**测出来了**（MEASURED）且 ≥98%。
      // ZERO_HARD_HITS / NO_SAMPLES 都是 false —— 不可谈判项 1「TP=0 不算通过」。
      precisionState === 'MEASURED' && precision !== null && precision >= TARGET_PRECISION
    : // 不适用（B12）：达标 == 一次硬阻断都没有。不可谈判项 2。
      hardHits === 0;

  return {
    ruleId,
    annotatedSamples,
    hardHits,
    trueHardBlocks,
    falseHardBlocks,
    precision,
    precisionState,
    precisionTargetApplies,
    meetsPrecisionTarget,
  };
}

/**
 * 判读整份语料。
 *
 * `rules` 必须恰好覆盖 13 条：少一条就意味着那条规则**从未被测过**，
 * 而一份漏了规则的判读如果还能得出 `meetsTargets: true`，就是 §11 说的假 PASS。
 * 这是调用方（D3b 的语料流水线）的结构错误，抛异常而不是记成缺口。
 */
export function evaluateCorpus(input: CorpusInput): CorpusVerdict {
  requireCount(input.safeSamples, 'safeSamples');
  requireCount(input.safeHardBlocked, 'safeHardBlocked');
  if (input.safeHardBlocked > input.safeSamples) {
    throw new CorpusInputError(
      `safeHardBlocked(${input.safeHardBlocked}) 不能大于 safeSamples(${input.safeSamples})`,
    );
  }

  const byId = new Map<RuleId, RuleAnnotation>();
  for (const annotation of input.rules) {
    if (!RULE_IDS.includes(annotation.ruleId)) {
      throw new CorpusInputError(`未在册的规则 id：${String(annotation.ruleId)}`);
    }
    if (byId.has(annotation.ruleId)) {
      throw new CorpusInputError(`规则 ${annotation.ruleId} 的标注重复提交了两次`);
    }
    byId.set(annotation.ruleId, annotation);
  }
  for (const ruleId of RULE_IDS) {
    if (!byId.has(ruleId)) {
      throw new CorpusInputError(`缺少规则 ${ruleId} 的标注；漏测的规则不能被当成达标`);
    }
  }

  const rules: RuleVerdict[] = RULE_IDS.map((ruleId) => {
    const annotation = byId.get(ruleId);
    // 上一段刚刚逐条校验过覆盖完整，这里取不到值就是本函数自己的缺陷。
    if (annotation === undefined) throw new CorpusInputError(`内部错误：${ruleId} 标注丢失`);
    return evaluateRule(annotation);
  });

  const falseBlockRate = input.safeSamples > 0 ? input.safeHardBlocked / input.safeSamples : null;
  const falseBlockRateState: FalseBlockRateState =
    input.safeSamples > 0 ? 'MEASURED' : 'NO_SAMPLES';
  const meetsFalseBlockRateTarget =
    falseBlockRateState === 'MEASURED' &&
    falseBlockRate !== null &&
    falseBlockRate <= TARGET_FALSE_BLOCK_RATE;

  const shortfalls: Shortfall[] = [];

  if (!meetsFalseBlockRateTarget) {
    if (falseBlockRateState === 'MEASURED' && falseBlockRate !== null) {
      shortfalls.push({
        kind: 'false-block-rate-above-target',
        ruleId: null,
        detail: `误拦率 ${formatRate(falseBlockRate)} 超过 §8.6 的 2% 上限（${input.safeHardBlocked}/${input.safeSamples}）`,
      });
    } else {
      shortfalls.push({
        kind: 'false-block-rate-unmeasurable',
        ruleId: null,
        detail: '安全样例数为 0，误拦率不可测（不可谈判项 3：设计里的量不得替代实测语料）',
      });
    }
  }

  for (const verdict of rules) {
    // B12 的硬阻断永远排在最前面报，哪怕同一条规则还有别的缺口 —— 它是「直接失败」。
    if (!verdict.precisionTargetApplies && verdict.hardHits > 0) {
      shortfalls.push({
        kind: 'b12-hard-block',
        ruleId: verdict.ruleId,
        detail: `${verdict.ruleId} 产出了 ${verdict.hardHits} 次硬阻断；它的冻结处置上限是 CONFIRM_REQUIRED（§8.3「只标记确认，不硬拦」）`,
      });
    }
    if (verdict.precisionState === 'NO_SAMPLES') {
      shortfalls.push({
        kind: 'no-samples',
        ruleId: verdict.ruleId,
        detail: `${verdict.ruleId} 没有任何标注样本，语料覆盖有洞`,
      });
    } else if (verdict.precisionTargetApplies && verdict.precisionState === 'ZERO_HARD_HITS') {
      shortfalls.push({
        kind: 'zero-hard-hits',
        ruleId: verdict.ruleId,
        detail: `${verdict.ruleId} 在 ${verdict.annotatedSamples} 个标注样本上硬阻断数为 0，precision 不可测（不可谈判项 1：TP=0 不算通过）`,
      });
    }
    if (
      verdict.precisionState === 'MEASURED' &&
      verdict.precisionTargetApplies &&
      verdict.precision !== null &&
      verdict.precision < TARGET_PRECISION
    ) {
      shortfalls.push({
        kind: 'precision-below-target',
        ruleId: verdict.ruleId,
        detail: `${verdict.ruleId} 的 precision ${formatRate(verdict.precision)} 低于 §8.6 的 98% 要求（${verdict.trueHardBlocks}/${verdict.hardHits}）`,
      });
    }
  }

  shortfalls.sort((left, right) => {
    const bySeverity = SHORTFALL_SEVERITY[left.kind] - SHORTFALL_SEVERITY[right.kind];
    if (bySeverity !== 0) return bySeverity;
    // 同级按规则在册顺序，不按字母序：B2 要排在 B10 前面，报告才读得下去。
    const leftIndex = left.ruleId === null ? -1 : RULE_IDS.indexOf(left.ruleId);
    const rightIndex = right.ruleId === null ? -1 : RULE_IDS.indexOf(right.ruleId);
    return leftIndex - rightIndex;
  });

  const meetsTargets =
    meetsFalseBlockRateTarget && rules.every((verdict) => verdict.meetsPrecisionTarget);

  return {
    safeSamples: input.safeSamples,
    safeHardBlocked: input.safeHardBlocked,
    falseBlockRate,
    falseBlockRateState,
    meetsFalseBlockRateTarget,
    rules,
    shortfalls,
    meetsTargets,
  };
}

/** 最严重的那条缺口；`null` 表示没有缺口。给 CI 的一行结论用。 */
export function primaryShortfall(verdict: CorpusVerdict): Shortfall | null {
  return verdict.shortfalls[0] ?? null;
}

/**
 * 百分比格式化。固定两位小数，`0.02` → `2.00%`。
 * 刻意不用 `toPrecision` / 不做四舍五入之外的修饰 —— 报告里的数字必须能被复算。
 */
function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

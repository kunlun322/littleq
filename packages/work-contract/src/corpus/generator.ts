/**
 * 语料生成器（ZLQ-156 §2.1–§2.4）：把「安全基座 × 覆盖层」与「违规家族 × 单点变异」
 * 展开成一份**确定的、可复算的**样例清单，并为每一件样例建出可扫描的整包。
 *
 * ## 确定性来自哪里
 *
 * 每一件样例的随机流都是 `createRandom(CORPUS_VERSION, caseId, salt)`。
 * 于是「同样的 corpusVersion + 同样的 caseId」⇒ 同样的字节 ⇒ 同样的 sha256。
 * 这条性质是**整份报告可复现的前提**：如果生成里混进一次 `Math.random()` 或 `Date.now()`，
 * 那么报告里的 packageHash 下次就跑不出来了，「实测」两个字就落空了。
 * 所以本模块**不读时钟、不读环境、不读全局随机**；`createdAt` / `workId` 都由 caseId 派生。
 *
 * ## dev / holdout 的切分为什么按 familyId 而不是按 caseId
 *
 * §2.2：holdout 集用来防止「照着测试样例调规则」。如果按 caseId 随机切，
 * 同一个模板家族会同时出现在 dev 与 holdout 两侧 —— 规则只要在 dev 侧学会了这个家族，
 * holdout 侧就自动跟着过，holdout 就白留了。所以切分单位是**家族**：
 * 一个家族整体落在 dev 或整体落在 holdout，两侧不共享任何 familyId。
 * `manifest.ts` 会把「同一 familyId 跨切分」直接判成违规，这条纪律是可执行的。
 *
 * ## 期望值不得来自实测
 *
 * 见 `violations.ts` 文件头纪律 1。`expectationOf` 只从家族声明里**抄**，
 * 不看任何扫描结果；安全样例的期望是「PASS 且零 finding」，同样来自模板的性质而不是跑出来的。
 */

import { applyOverlay, OVERLAY_IDS, type OverlayId } from './overlays.js';
import {
  buildCorpusPackage,
  corpusPng,
  corpusPolicy,
  type BuiltCorpusPackage,
  type CorpusFile,
} from './package.js';
import { createRandom, stableBucket, type Random } from './random.js';
import {
  CORPUS_CELLS,
  HOLDOUT_FAMILIES_PER_CELL,
  SAFE_STRUCTURE_IDS,
  STRUCTURES_PER_CELL,
  VARIANTS_PER_FAMILY,
  fillSlot,
  renderSafeBase,
  safeCaseId,
  type SafeBase,
  type SlotId,
  type TechTag,
} from './templates.js';
import {
  VIOLATION_FAMILIES,
  type CaseStatus,
  type ViolationFamily,
  type ViolationPayload,
} from './violations.js';
import { ANNOTATION_MODE, CORPUS_VERSION, type AnnotationMode } from './versions.js';
import { PACKAGE_LIMITS } from '../scan/budget.js';
import type { AgeBand, Capability, WorkType } from '../scan/metadata.js';
import type { Confidence, Disposition, RuleId } from '../scan/types.js';

/** §2.3 的四个标注标签。 */
export type AnnotationLabel = 'SAFE' | 'HARD_BLOCK' | 'CONFIRM_REQUIRED' | 'NOT_APPLICABLE';

export type CorpusKind = 'safe' | 'violation' | 'boundary';

/** dev / holdout 切分。 */
export type Split = 'dev' | 'holdout';

export type CorpusCell = {
  readonly ageBand: AgeBand;
  readonly workType: WorkType;
};

/**
 * 单件样例的期望。
 *
 * `expectedSubTypes` 用**集合**语义：判据是「实测 ⊇ 期望」，多出来的算污染。
 * 用「相等」会把同一规则内的合法多命中（`a.download='x'` + `a.click()`）误判成缺陷。
 */
export type CaseExpectation = {
  readonly label: AnnotationLabel;
  readonly expectedStatus: CaseStatus;
  /** 期望命中的规则。安全样例为空数组。 */
  readonly expectedRules: readonly RuleId[];
  /** 主规则的期望子类型集合。 */
  readonly expectedSubTypes: readonly string[];
  /**
   * 主规则内**可接受但不要求**的额外子类型（见 `ViolationFamily.toleratedSubTypes`）。
   * 出现在实测里不算污染，不出现也不算缺陷。安全样例为空数组。
   */
  readonly toleratedSubTypes: readonly string[];
  readonly expectedDisposition: Disposition | null;
  readonly expectedConfidence: Confidence | null;
  /** 按定义必然共现的其它规则（见 violations.ts 的 `expectedOtherRules`）。 */
  readonly expectedOtherRules: readonly RuleId[];
};

/**
 * 安全样例与边界样例共用的期望：PASS、零 finding。
 *
 * 出处是**模板的性质**（`provenance: 'template'`），不是扫描结果：安全基座只使用
 * §2.2 白名单里的写法，边界样例则刻意停在冻结上限的「≤」这一侧。
 */
const PASS_EXPECTATION: CaseExpectation = {
  label: 'SAFE',
  expectedStatus: 'PASS',
  expectedRules: [],
  expectedSubTypes: [],
  toleratedSubTypes: [],
  expectedDisposition: null,
  expectedConfidence: null,
  expectedOtherRules: [],
};

/**
 * 「命中即硬阻断」的规则。**读规则**得出的常量（见 `defaultStatusOf` 的注释）：
 * 这几条规则的每个 emit 点都写死 `disposition: 'BLOCK'`，所以它们一命中，
 * 整件样例的状态必然是 BLOCK，与主规则自己的处置无关。
 *
 * - B1：`b01-external-resource.ts` 全部 10 个 emit 点都是 BLOCK/HIGH。
 * - B11：`b11-ai.ts:90-120` 的 `subTypeOf` 两支都走同一个 BLOCK/HIGH 常量。
 *
 * 刻意不含其余 11 条：它们都有 CONFIRM_REQUIRED 支路，用规则粒度推状态会算错。
 * B13 最典型 —— 高危词表（`entry.tier === 'HIGH'`）⇒ BLOCK，低危支路 ⇒ CONFIRM_REQUIRED，
 * 所以它的状态必须由 `expectationOf` 逐变体声明，不能靠这张表。
 */
const ALWAYS_BLOCK_RULES: readonly RuleId[] = ['B1', 'B11'];

export type CorpusCaseSpec = {
  readonly caseId: string;
  readonly kind: CorpusKind;
  readonly ruleId: RuleId | null;
  readonly familyId: string;
  readonly cell: CorpusCell | null;
  readonly split: Split;
  readonly variant: number;
  /** 安全样例：该格内的结构家族序号（0..4）。违规/边界样例恒为 0，家族由 familyId 表达。 */
  readonly familyOrdinal: number;
  readonly overlay: OverlayId;
  readonly tags: readonly string[];
  /** 期望值的出处。`template` = 由模板性质得出（安全/边界样例）。 */
  readonly provenance: 'ruleset-table' | 'rule-reading' | 'template';
  readonly annotationMode: AnnotationMode;
  readonly expectation: CaseExpectation;
  /** 违规样例命中的词表条目 id（B13/B12/B9/B11/B8）。安全样例为 null。不含任何样例正文。 */
  readonly carrierEntryId: string | null;
  readonly rationale: string;
};

export type GeneratedCase = {
  readonly spec: CorpusCaseSpec;
  readonly built: BuiltCorpusPackage;
  readonly base: SafeBase;
};

// ---------------------------------------------------------------------------
// 切分
// ---------------------------------------------------------------------------

/**
 * 违规家族里落在 holdout 的**家族个数**：6 个家族取 2 个 ⇒ 每规则 40 dev / 20 holdout，
 * 对上 §2.4 的「约 40/20」。取最后两个而不是随机两个，是为了让切分不依赖哈希分布，
 * 一眼就能核对。
 */
export const VIOLATION_HOLDOUT_FAMILIES = 2;

/** 安全样例：每格 5 个结构家族，取 `HOLDOUT_FAMILIES_PER_CELL` 个进 holdout。 */
export function safeSplitOf(familyId: string): Split {
  const bucket = parseInt(stableBucket(familyId).slice(0, 4), 16);
  // STRUCTURES_PER_CELL 个桶里前 HOLDOUT_FAMILIES_PER_CELL 个是 holdout。
  return bucket % STRUCTURES_PER_CELL < HOLDOUT_FAMILIES_PER_CELL ? 'holdout' : 'dev';
}

/**
 * 违规家族的切分**不按哈希**，而按家族在该规则内的序号（取末 2 个）。
 * 理由：6 个家族用 `bucket % 6 < 2` 分桶，落点由 familyId 的哈希决定，
 * 报告里就得解释「为什么 B3 的 holdout 是这 3 个而不是那 2 个」—— 而按序号取末两个，
 * 任何人都能在表上一眼核对，且 40/20 的配比是**保证**的而不是概率的。
 */
export function violationSplitByOrdinal(ordinal: number, familyCount: number): Split {
  return ordinal >= familyCount - VIOLATION_HOLDOUT_FAMILIES ? 'holdout' : 'dev';
}

// ---------------------------------------------------------------------------
// 样例清单
// ---------------------------------------------------------------------------

function safeSpecs(): CorpusCaseSpec[] {
  const specs: CorpusCaseSpec[] = [];
  for (const cell of CORPUS_CELLS) {
    for (let familyIndex = 0; familyIndex < STRUCTURES_PER_CELL; familyIndex += 1) {
      const familyId = `safe-${cell.ageBand}-${cell.workType}-${SAFE_STRUCTURE_IDS[familyIndex] ?? 'x'}`;
      const split = safeSplitOf(familyId);
      for (let variant = 0; variant < VARIANTS_PER_FAMILY; variant += 1) {
        const caseId = safeCaseId(cell.ageBand, cell.workType, familyIndex, variant);
        const overlay: OverlayId = OVERLAY_IDS[variant % OVERLAY_IDS.length] ?? 'none';
        specs.push({
          caseId,
          kind: 'safe',
          ruleId: null,
          familyId,
          cell,
          split,
          variant,
          familyOrdinal: familyIndex,
          overlay,
          // 具体 tags 由 renderSafeBase + applyOverlay 给出；这里先放覆盖层的名字，
          // buildSafeCase 会用真实 tags 覆盖（见 enrichTags）。
          tags: [overlay],
          provenance: 'template',
          annotationMode: ANNOTATION_MODE,
          expectation: PASS_EXPECTATION,
          carrierEntryId: null,
          rationale:
            '安全基座 + 覆盖层：结构家族保证「合法写法」被覆盖，覆盖层保证 §2.2 点名的四种易误判形状' +
            '（许可注释、合法 data/blob、可读源+minified、内联 CSP hash）各占 1/4。期望是 PASS 且零 finding。',
        });
      }
    }
  }
  return specs;
}

function violationSpecs(): CorpusCaseSpec[] {
  const specs: CorpusCaseSpec[] = [];
  const byRule = new Map<RuleId, ViolationFamily[]>();
  for (const family of VIOLATION_FAMILIES) {
    const list = byRule.get(family.ruleId) ?? [];
    list.push(family);
    byRule.set(family.ruleId, list);
  }

  for (const [ruleId, families] of byRule) {
    families.forEach((family, ordinal) => {
      const split = violationSplitByOrdinal(ordinal, families.length);
      for (let variant = 0; variant < family.caseCount; variant += 1) {
        const caseId = `${family.familyId}-v${variant}`;
        const expectation = expectationFor(family, ruleId, variant);
        specs.push({
          caseId,
          kind: 'violation',
          ruleId,
          familyId: family.familyId,
          // 违规样例挂在「该格的第一格」上轮转，让 12 格都被违规样例覆盖到，
          // 而不是全部长在同一份模板上（否则 precision 只反映了一种结构）。
          cell: cellForCase(caseId),
          split,
          variant,
          familyOrdinal: 0,
          overlay: 'none',
          tags: [`rule:${ruleId}`, `disposition:${expectation.expectedDisposition}`],
          provenance: family.provenance,
          annotationMode: ANNOTATION_MODE,
          expectation,
          // B13 的子类型随变体轮转，这里把**这一件**具体命中哪条词表记下来，
          // 报告因此能说「10 条高危类目各被测了几次」，而不只是「B13 命中 50 次」。
          carrierEntryId: carrierEntryIdOf(family, variant),
          rationale: family.rationale,
        });
      }
    });
  }
  return specs;
}

/**
 * 把家族声明**细化成这一件样例的期望**。
 *
 * 三个来源，优先级从低到高：
 * 1. 家族级字段（`disposition` / `confidence` / `expectedSubTypes` / `expectedOtherRules`）；
 * 2. `expectationOf(variant)` —— 词表轮转家族用它把「命中哪条词表」翻成子类型与置信度；
 * 3. `expectedStatus` —— 样例级状态，默认由 2 的 disposition 推出。
 *
 * 三者都**看不到载荷、也看不到扫描结果**：`expectationOf` 的入参只有 `variant`，
 * `expectedStatus` 是个常量。所以「期望值不来自实测」在结构上成立，
 * `provenance` 那两个取值才是可核对的声明而不是自我表扬。
 *
 * 状态为什么可能与 disposition 不同：一件样例的状态是「所有命中里最重的那个」
 * （`src/scan/index.ts:578`）。B8 的弱线索字段自己是 CONFIRM_REQUIRED，
 * 但同一次注入若又让 B1 命中 `external-url`（B1 的每个子类型都是 BLOCK/HIGH，
 * 见 `b01-external-resource.ts` 的全部 emit 点），整件样例就是 BLOCK。
 * 这时 finding 级期望**不变**，只有样例级状态被顶上去 —— 两者分开声明，
 * 才不会为了对上状态而去改 finding 级期望。
 */
function expectationFor(family: ViolationFamily, ruleId: RuleId, variant: number): CaseExpectation {
  const resolved = family.expectationOf?.(variant) ?? {};
  const expectedOtherRules = [...(resolved.otherRules ?? family.expectedOtherRules)];
  const expectedRules: RuleId[] = [ruleId, ...expectedOtherRules];
  const disposition = resolved.disposition ?? family.disposition;
  const confidence = resolved.confidence ?? family.confidence;
  const expectedStatus =
    resolved.status ?? family.expectedStatus ?? defaultStatusOf(expectedRules, disposition);
  return {
    label: expectedStatus === 'BLOCK' ? 'HARD_BLOCK' : 'CONFIRM_REQUIRED',
    expectedStatus,
    expectedRules,
    expectedSubTypes: [...(resolved.subTypes ?? family.expectedSubTypes)],
    toleratedSubTypes: [...(family.toleratedSubTypes ?? [])],
    expectedDisposition: disposition,
    expectedConfidence: confidence,
    expectedOtherRules,
  };
}

/**
 * 样例级状态的默认推导：主规则的处置，或被共现规则里「必然硬阻断」的那些顶上去。
 *
 * `ALWAYS_BLOCK_RULES` 是**读规则**得出的常量，不是跑出来的：这几条规则的每个 emit 点
 * 都写死 `disposition: 'BLOCK'`，所以只要它命中，整件样例就是 BLOCK。
 * 列在这里而不是查 `FROZEN_DISPOSITION_CEILING`，是因为上限只是上界 ——
 * B9 的上限是 BLOCK，但它的 `mining` 低危支路是 CONFIRM_REQUIRED，
 * 用上限推会把「B9 共现」错算成「必然 BLOCK」。
 */
function defaultStatusOf(expectedRules: readonly RuleId[], disposition: Disposition): CaseStatus {
  if (disposition === 'BLOCK') return 'BLOCK';
  return expectedRules.some((rule) => ALWAYS_BLOCK_RULES.includes(rule))
    ? 'BLOCK'
    : 'CONFIRM_REQUIRED';
}

/**
 * 边界样例（§2.2：总量/单文件/文件数/深度 的「恰好在上限」与「低于上限」两侧）。
 *
 * **只造 at / below 两侧，不造 above。** above 侧这份语料**没有产出**，理由不是省事，
 * 而是它在结构上不可造或造出来没意义：
 * - 路径深度越界（9 段）：`workMetadataSchema` 在 B1 运行**之前**就以
 *   「canonical relative package path」拒收，扫描器根本走不到 B1 的 `path-too-deep` 分支。
 *   硬塞一个只会测到 schema 拒绝，测不到规则 —— 这不是缺陷，是纵深防御的第一层。
 * - 文件数 / 总体积越界：需要真的分配十几兆字节，在 CI 的 16 shard 里是纯浪费；
 *   这两条上限由 `PACKAGE_LIMITS` 常量直接判定、与语料结构无关，D3a 的单元测试已经钉住。
 * 三条都在报告的未覆盖表里如实列出，不冒充实测。
 */
function boundarySpecs(): CorpusCaseSpec[] {
  const specs: CorpusCaseSpec[] = [];
  const shapes: readonly {
    readonly name: string;
    readonly position: 'at-limit' | 'below-limit';
  }[] = [
    { name: 'file-count', position: 'at-limit' },
    { name: 'file-count', position: 'below-limit' },
    { name: 'path-depth', position: 'at-limit' },
    { name: 'path-depth', position: 'below-limit' },
    { name: 'path-codepoints', position: 'at-limit' },
    { name: 'path-codepoints', position: 'below-limit' },
  ];
  shapes.forEach((shape, index) => {
    const familyId = `boundary-${shape.name}-${shape.position}`;
    specs.push({
      caseId: `${familyId}-v0`,
      kind: 'boundary',
      ruleId: null,
      familyId,
      cell: CORPUS_CELLS[index % CORPUS_CELLS.length] ?? null,
      split: shape.position === 'at-limit' ? 'holdout' : 'dev',
      variant: 0,
      familyOrdinal: 0,
      overlay: 'none',
      tags: ['boundary-at-or-below-limit', shape.position],
      provenance: 'template',
      annotationMode: ANNOTATION_MODE,
      expectation: PASS_EXPECTATION,
      carrierEntryId: null,
      rationale: `${shape.name} 处在${shape.position === 'at-limit' ? '恰好等于' : '低于'}冻结上限（PACKAGE_LIMITS）时仍须判安全：上限是「≤」不是「<」，差一个就误拦。`,
    });
  });
  return specs;
}

/** 12 格轮转：让违规样例分散到全部年龄×类型组合上。 */
function cellForCase(caseId: string): CorpusCell | null {
  const bucket = parseInt(stableBucket(caseId).slice(0, 4), 16);
  return CORPUS_CELLS[bucket % CORPUS_CELLS.length] ?? null;
}

function carrierEntryIdOf(family: ViolationFamily, variant: number): string | null {
  // 有逐变体期望的家族（B13 按 tier 表轮转）一律以解析结果为准，
  // 不在这里重算一遍轮转下标 —— 两处算，就会有一处先过期。
  const resolved = family.expectationOf?.(variant).subTypes?.[0];
  if (resolved !== undefined) return resolved;
  // 其余家族期望集合只有一个元素（或同规则内的两个子类型），取首个作为「这一件的词表条目」。
  return family.expectedSubTypes[0] ?? null;
}

/** 全部样例清单。顺序确定：安全 → 违规（按 RULE_IDS）→ 边界。 */
export function allCaseSpecs(): readonly CorpusCaseSpec[] {
  const specs = [...safeSpecs(), ...violationSpecs(), ...boundarySpecs()];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.caseId)) throw new Error(`caseId 重复：${spec.caseId}`);
    seen.add(spec.caseId);
  }
  return specs;
}

// ---------------------------------------------------------------------------
// 建包
// ---------------------------------------------------------------------------

/** 固定的 `createdAt`：生成器不读时钟。 */
export const CORPUS_CREATED_AT = '2026-10-20T00:00:00Z';

/**
 * workId 由 caseId 派生（每个样例一份独立的存储前缀，§8.4）。
 *
 * 形状必须是 UUIDv7：`work.json` 的 schema（`src/scan/metadata.ts` 的 `UUID_V7_PATTERN`）
 * 拒收任何别的写法，而语料样例走的正是真实作品的同一条校验路径 —— 这是有意的，
 * 语料不能靠放宽 schema 才建得起来。
 *
 * 因此这里把 caseId 折成一条**合法的** UUIDv7，而不是折成一个好读的短 id：
 * 时间戳段固定取 `CORPUS_CREATED_AT` 的毫秒数（48 bit = 12 hex，生成器不读时钟），
 * 随机段由 `createRandom(CORPUS_VERSION, caseId, 'work-id')` 的确定性流填充，
 * version nibble 与 RFC 4122 variant 位按规范写死。同一 caseId 在任何机器上得到同一 UUID。
 */
export function workIdOf(caseId: string): string {
  const random = createRandom(CORPUS_VERSION, caseId, 'work-id');
  const hex = (digits: number): string => {
    let out = '';
    while (out.length < digits) out += random.int(0x10000).toString(16).padStart(4, '0');
    return out.slice(0, digits);
  };
  const timeHex = Date.parse(CORPUS_CREATED_AT).toString(16).padStart(12, '0').slice(-12);
  // variant 高位必须是 `10` ⇒ 首个 hex 落在 8|9|a|b。
  const variant = ((parseInt(hex(1), 16) & 0x3) | 0x8).toString(16);
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

function baseFor(spec: CorpusCaseSpec): SafeBase {
  const cell = spec.cell ?? CORPUS_CELLS[0];
  if (cell === undefined) throw new Error('语料格表为空');
  // 违规样例用 caseId 的稳定分桶挑结构家族，让 5 种结构都被违规样例覆盖到；
  // variant 继续驱动**载荷内部**的变化（轮转词表条目）。
  const familyIndex =
    spec.kind === 'safe'
      ? spec.familyOrdinal % STRUCTURES_PER_CELL
      : parseInt(stableBucket(spec.caseId).slice(4, 8), 16) % STRUCTURES_PER_CELL;
  const renderVariant = spec.kind === 'safe' ? spec.variant % VARIANTS_PER_FAMILY : spec.variant;
  return renderSafeBase(CORPUS_VERSION, cell.ageBand, cell.workType, familyIndex, renderVariant);
}

function buildSafe(
  spec: CorpusCaseSpec,
  base: SafeBase,
  scannerVersion: string,
  rulesetVersion: string,
): GeneratedCase {
  const overlaid = applyOverlay(base, spec.variant);
  const built = buildCorpusPackage(workIdOf(spec.caseId), CORPUS_CREATED_AT, {
    files: overlaid.files,
    title: base.title,
    description: base.description,
    workType: base.workType,
    ageBand: base.ageBand,
    capabilities: base.capabilities as readonly Capability[],
    sourceEntryPaths: overlaid.sourceEntryPaths,
    policy: corpusPolicy(),
    scannerVersion,
    rulesetVersion,
  });
  return {
    spec: { ...spec, tags: enrichTags(spec.tags, overlaid.tags, base.tags) },
    built,
    base,
  };
}

function enrichTags(
  specTags: readonly string[],
  overlayTags: readonly TechTag[],
  baseTags: readonly TechTag[],
): readonly string[] {
  const tags = new Set<string>([...specTags, ...overlayTags, ...baseTags]);
  return [...tags].sort();
}

function buildViolation(
  spec: CorpusCaseSpec,
  base: SafeBase,
  scannerVersion: string,
  rulesetVersion: string,
): GeneratedCase {
  const family = VIOLATION_FAMILIES.find((candidate) => candidate.familyId === spec.familyId);
  if (family === undefined) throw new Error(`找不到违规家族：${spec.familyId}`);
  const random: Random = createRandom(CORPUS_VERSION, spec.caseId, 'violation');
  const payload: ViolationPayload = family.payload(base, random, spec.variant);

  // 覆盖层刻意设为 none：违规样例必须与它的**安全对照**只差注入的那一处。
  // 套上覆盖层会同时改动文件头、CSS 末尾、新增文件，「单点变异」就不成立了。
  const files: CorpusFile[] = [...fillSlot(base, payload.slotId as SlotId, payload.text)];
  for (const extra of payload.extraFiles ?? []) files.push(extra);

  const capabilities = payload.capabilities ?? base.capabilities;

  const built = buildCorpusPackage(workIdOf(spec.caseId), CORPUS_CREATED_AT, {
    files,
    title: base.title,
    description: base.description,
    workType: base.workType,
    ageBand: base.ageBand,
    capabilities: capabilities as readonly Capability[],
    sourceEntryPaths: payload.sourceEntryPaths ?? base.sourceEntryPaths,
    policy: corpusPolicy(),
    scannerVersion,
    rulesetVersion,
  });
  return { spec: { ...spec, tags: enrichTags(spec.tags, [], base.tags) }, built, base };
}

/** 边界样例：在安全基座上加/换文件，把某个 PACKAGE_LIMITS 维度推到 at 或 below。 */
function buildBoundary(
  spec: CorpusCaseSpec,
  base: SafeBase,
  scannerVersion: string,
  rulesetVersion: string,
): GeneratedCase {
  const atLimit = spec.tags.includes('at-limit');
  let files: CorpusFile[] = [...base.files];

  if (spec.familyId.startsWith('boundary-file-count')) {
    // PACKAGE_LIMITS.maxFileCount 含 work.json，所以非 manifest 文件数是 maxFileCount - 1。
    const target = atLimit ? PACKAGE_LIMITS.maxFileCount - 1 : PACKAGE_LIMITS.maxFileCount - 2;
    const existing = new Set(base.files.map((file) => file.path));
    const pads: CorpusFile[] = [];
    let ordinal = 0;
    while (base.files.length + pads.length < target) {
      const path = `assets/pad-${String(ordinal).padStart(3, '0')}.png`;
      ordinal += 1;
      if (existing.has(path)) continue;
      pads.push({ path, content: padPng(ordinal) });
    }
    files = [...files, ...pads];
  }

  if (spec.familyId.startsWith('boundary-path-depth')) {
    // pathDepth 数的是段数；at-limit 就是正好 maxPathDepth 段。
    const segments = atLimit ? PACKAGE_LIMITS.maxPathDepth : PACKAGE_LIMITS.maxPathDepth - 1;
    const dir = Array.from({ length: Math.max(1, segments - 1) }, (_, i) => `d${i}`).join('/');
    const path = `${dir}/deep.png`;
    files = [...files, { path, content: padPng(7) }];
    files = files.map((file) =>
      file.path === 'index.html' && typeof file.content === 'string'
        ? {
            ...file,
            content: file.content.replace(
              '</body>',
              `  <img src="${path}" alt="深层素材" width="4" height="4" />\n  </body>`,
            ),
          }
        : file,
    );
  }

  if (spec.familyId.startsWith('boundary-path-codepoints')) {
    // 单段名字拉长到接近 maxPathCodePoints；深度保持 2 段，避免与深度边界混在一起。
    const budget = atLimit
      ? PACKAGE_LIMITS.maxPathCodePoints
      : PACKAGE_LIMITS.maxPathCodePoints - 1;
    const prefix = 'assets/';
    const nameLength = Math.max(1, budget - prefix.length - 4);
    const path = `${prefix}${'n'.repeat(nameLength)}.png`;
    files = [...files, { path, content: padPng(9) }];
    files = files.map((file) =>
      file.path === 'index.html' && typeof file.content === 'string'
        ? {
            ...file,
            content: file.content.replace(
              '</body>',
              `  <img src="${path}" alt="长名素材" width="4" height="4" />\n  </body>`,
            ),
          }
        : file,
    );
  }

  const built = buildCorpusPackage(workIdOf(spec.caseId), CORPUS_CREATED_AT, {
    files,
    title: base.title,
    description: base.description,
    workType: base.workType,
    ageBand: base.ageBand,
    capabilities: base.capabilities as readonly Capability[],
    sourceEntryPaths: base.sourceEntryPaths,
    policy: corpusPolicy(),
    scannerVersion,
    rulesetVersion,
  });
  return { spec: { ...spec, tags: enrichTags(spec.tags, [], base.tags) }, built, base };
}

/** 1×1 的合法 PNG。用 corpusPng 同一套字节，确保 sniff 不与声明的 mediaType 矛盾。 */
function padPng(seed: number): Uint8Array {
  return corpusPng(1, 1, seed);
}

/** 建出单件样例。kind 决定走哪条路，三路都从同一个安全基座出发。 */
export function buildCase(
  spec: CorpusCaseSpec,
  scannerVersion: string,
  rulesetVersion: string,
): GeneratedCase {
  const base = baseFor(spec);
  switch (spec.kind) {
    case 'safe':
      return buildSafe(spec, base, scannerVersion, rulesetVersion);
    case 'violation':
      return buildViolation(spec, base, scannerVersion, rulesetVersion);
    case 'boundary':
      return buildBoundary(spec, base, scannerVersion, rulesetVersion);
    default:
      throw new Error(`不认识的样例类型：${String(spec.kind)}`);
  }
}

/**
 * 落盘产物的完整性与不可洗白性（ZLQ-156 §2.3 / §2.5 / §2.6；本单 §13.4 / §13.8 / §13.9）。
 *
 * ## 这个文件挡的是什么
 *
 * 另两个语料测试测的是**算法**（一致性指标、B5 复现）。这一个测的是**落盘产物**：
 * `corpus/**.jsonl` 一旦提交就成了一份可以被手改的数据 —— 改一行 shard 报告里的
 * `outcome.status`，就能把一条假阴性变成假通过，而 18 道门一道都不会响，因为门看的是
 * 代码，不是语料。所以这里把「产物必须能由当前代码重新算出来」变成可执行的断言。
 *
 * ## 三个方向，各挡一种造假
 *
 * 1. **产物 vs 代码**（§2.6「聚合作业检查…计划清单 hash 一致后才算指标」）：重算
 *    `scannerVersion` / `rulesetVersion` / `planHash` 与全量期望行，与钉住的值逐字节比对。
 *    手改产物 ⇒ 红；改代码却不重跑流水线 ⇒ 也红。
 * 2. **产物 vs 产物**：同一件样例的 `packageHash` 在 `plan.jsonl`、`case-manifest.jsonl`、
 *    shard 报告三处必须逐字节相同；版本三元组在 16 个 shard 头、计划头、报告头必须一致。
 *    少一片、串一版、重复一件都在这里暴露。
 * 3. **产物的形状**（§2.6「不附源片段」+ §2.1 的载体纪律）：键集合用**白名单**而不是黑名单。
 *    将来谁往 shard 行里加一个 `content` 字段，这个文件立刻红 —— 不必等到有害载体字符串
 *    真的泄漏进公开仓库才发现。
 *
 * ## 为什么不 import `scripts/lib.mjs`
 *
 * runner 从 `../dist/**` 加载判定面，而 `dist/` 是 gitignored 的：全新克隆里不存在。
 * 测试必须能在「新检出 + `vitest run`」下直接跑，所以这里从 `../src/**` 直接导入，
 * runner 里那几个纯函数（源文件遍历、期望行折叠）在本地重写一份。
 *
 * 重写的代价是两处可能漂移，而漂移本身被下面「重算 scannerVersion」那条断言覆盖：
 * 遍历规则一变，算出的版本就变，钉住的值立刻对不上。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ADMISSION_BLOCKING_GAP_IDS, DECLARED_GAP_IDS, DECLARED_GAPS } from '../src/corpus/gaps.js';
import {
  allCaseSpecs,
  buildCase,
  type AnnotationLabel,
  type CorpusCaseSpec,
  type CorpusKind,
  type Split,
} from '../src/corpus/generator.js';
import {
  DESIGN_SAFE_TOTAL,
  expectedByRuleOf,
  highestLabel,
  IMPLEMENTER_ALIAS,
  planCompleteness,
  planManifest,
  PRODUCED_SOURCE_KIND,
  PRODUCED_SOURCE_LICENSE,
  versionMismatch,
  caseManifestEntry,
  type CaseManifestEntry,
  type CorpusPlanManifest,
} from '../src/corpus/manifest.js';
import { DESIGN_VIOLATION_TOTAL } from '../src/corpus/metrics.js';
import { corpusPolicy } from '../src/corpus/package.js';
import { SHARD_COUNT, shardOfSpecs } from '../src/corpus/shards.js';
import { assertSubTypeChannelLive, recoverSubType } from '../src/corpus/subtypes.js';
import {
  ANNOTATION_MODE,
  CORPUS_VERSION,
  corpusRulesetVersion,
  corpusScannerVersion,
  rulesetFingerprint,
  versionTriple,
  type ScannerSourceFile,
} from '../src/corpus/versions.js';
import { sha256Hex } from '../src/scan/hash.js';
import { scanPackage } from '../src/scan/index.js';
import { RULE_BY_ID } from '../src/scan/rules/index.js';
import { RULE_IDS, type Finding, type RuleId } from '../src/scan/types.js';

// ---------------------------------------------------------------------------
// 路径与 JSONL 读取
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CORPUS_DIR = join(PACKAGE_ROOT, 'corpus');
const SHARD_DIR = join(CORPUS_DIR, 'shards');
const SCAN_SRC_DIR = join(PACKAGE_ROOT, 'src', 'scan');
const PLAN_RUNNER_PATH = join(PACKAGE_ROOT, 'scripts', 'corpus-plan.mjs');

/**
 * 读 JSONL。与 runner 里那份同规则，包括「必须以换行结尾」：
 * 少了这一条，一次被截断的写入（磁盘满、进程被杀）会静默丢掉最后一件样例，
 * 而 §2.6 要求「跳过样例直接令 CI 失败，不从分母移除」。
 */
function readJsonl(path: string): readonly Record<string, unknown>[] {
  const text = readFileSync(path, 'utf8');
  if (text === '') throw new Error(`JSONL 是空的：${path}`);
  const lines = text.split('\n');
  if (lines.at(-1) !== '') {
    throw new Error(`JSONL 必须以换行结尾（否则最后一行可能是被截断的写入）：${path}`);
  }
  return lines.slice(0, -1).map((line, index) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${path} 第 ${String(index + 1)} 行不是合法 JSON：${String(error)}`);
    }
  });
}

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 产物行的形状（白名单断言就建在这些键名上）
// ---------------------------------------------------------------------------

type PlanRow = {
  readonly caseId: string;
  readonly familyId: string;
  readonly split: Split;
  readonly shard: number;
  readonly kind: CorpusKind;
  readonly ruleId: RuleId | null;
  readonly packageHash: string;
};

type ShardHeaderRow = {
  readonly kind: 'shard-header';
  readonly shard: number;
  readonly shardCount: number;
  readonly planHash: string;
  readonly shardPlanHash: string;
  readonly corpusVersion: string;
  readonly scannerVersion: string;
  readonly rulesetVersion: string;
  readonly rulesetFingerprintHash: string;
  readonly annotationMode: string;
  readonly admissionMet: boolean;
  readonly reportStatus: string;
  readonly caseCount: number;
  readonly failedCases: number;
};

type ExpectedRow = {
  readonly label: AnnotationLabel;
  readonly status: string;
  readonly rules: readonly string[];
  readonly otherRules: readonly string[];
  readonly disposition: string | null;
  readonly confidence: string | null;
  readonly subTypes: readonly string[];
  readonly toleratedSubTypes: readonly string[];
};

type OutcomeRow = {
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly status: string | null;
  readonly rules: readonly string[];
  readonly blockedRules: readonly string[];
  readonly confirmedRules: readonly string[];
  readonly subTypes: readonly string[];
  readonly findingCount: number;
  readonly durationMs: number;
};

type ShardCaseRow = {
  readonly kind: 'case';
  readonly caseId: string;
  readonly shard: number;
  readonly packageHash: string;
  readonly inputHash: string | null;
  readonly corpusVersion: string;
  readonly scannerVersion: string;
  readonly rulesetVersion: string;
  readonly annotationMode: string;
  readonly expected: ExpectedRow;
  readonly outcome: OutcomeRow;
  readonly buildMs: number;
};

type VerdictRuleRow = {
  readonly ruleId: RuleId;
  readonly annotatedSamples: number;
  readonly hardHits: number;
  readonly trueHardBlocks: number;
  readonly falseHardBlocks: number;
  readonly precision: number | null;
  readonly precisionState: string;
  readonly precisionTargetApplies: boolean;
  readonly meetsPrecisionTarget: boolean;
};

type QuotaDeltaRow = {
  readonly dimension: string;
  readonly design: number;
  readonly measured: number;
  readonly delta: number;
  readonly note: string;
};

// ---------------------------------------------------------------------------
// 加载产物（模块级一次，全部断言共用同一份解析结果）
// ---------------------------------------------------------------------------

const PLAN_MANIFEST_ROWS = readJsonl(join(CORPUS_DIR, 'plan-manifest.jsonl'));
const PLAN_ROWS = readJsonl(join(CORPUS_DIR, 'plan.jsonl')) as unknown as readonly PlanRow[];
const CASE_MANIFEST_ROWS = readJsonl(
  join(CORPUS_DIR, 'case-manifest.jsonl'),
) as unknown as readonly CaseManifestEntry[];
const REPORT_ROWS = readJsonl(join(CORPUS_DIR, 'report.jsonl'));
const REPORT_SUMMARY_ROWS = readJsonl(join(CORPUS_DIR, 'report-summary.jsonl'));

const PLAN_HEADER = PLAN_MANIFEST_ROWS[0];
if (PLAN_HEADER === undefined) throw new Error('plan-manifest.jsonl 没有头行');

function reportSection(name: string): Row {
  const row = REPORT_ROWS.find((candidate) => candidate['section'] === name);
  if (row === undefined) throw new Error(`报告里没有这一节：${name}`);
  return row;
}

const REPORT_HEADER = reportSection('header');

type LoadedShard = {
  readonly file: string;
  readonly shard: number;
  readonly header: ShardHeaderRow;
  readonly cases: readonly ShardCaseRow[];
};

function shardFileName(shard: number): string {
  return `shard-${String(shard).padStart(2, '0')}.jsonl`;
}

function loadShards(): readonly LoadedShard[] {
  const files = readdirSync(SHARD_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  return files.map((file) => {
    const rows = readJsonl(join(SHARD_DIR, file));
    const [first, ...rest] = rows;
    if (first === undefined) throw new Error(`shard 报告是空的：${file}`);
    const header = first as unknown as ShardHeaderRow;
    // 头行自称的编号必须就是文件名里的编号：否则「shard 3 的报告」可能装着 shard 7 的结果，
    // 而下面所有按编号做的核对都会 quietly 对到错的那一片上。
    if (shardFileName(header.shard) !== file) {
      throw new Error(`shard 头行编号与文件名不符：${file} 自称 ${String(header.shard)}`);
    }
    return { file, shard: header.shard, header, cases: rest as unknown as readonly ShardCaseRow[] };
  });
}

const SHARDS = loadShards();
const SHARD_CASE_ROWS: readonly ShardCaseRow[] = SHARDS.flatMap((shard) => shard.cases);
const CASE_ROW_BY_ID = new Map(SHARD_CASE_ROWS.map((row) => [row.caseId, row]));
const PLAN_ROW_BY_ID = new Map(PLAN_ROWS.map((row) => [row.caseId, row]));
const MANIFEST_ROW_BY_ID = new Map(CASE_MANIFEST_ROWS.map((row) => [row.caseId, row]));

// ---------------------------------------------------------------------------
// 从当前代码重算（与 runner 里同形的纯函数，本地重写一份）
// ---------------------------------------------------------------------------

const SPECS = allCaseSpecs();
const SPEC_BY_CASE_ID = new Map(SPECS.map((spec) => [spec.caseId, spec]));

function walkTypeScript(root: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkTypeScript(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 扫描器源文件清单。只收 `src/scan/**`，不收 `src/corpus/**`（边界理由见 lib.mjs）。 */
function scannerSourceManifest(): readonly ScannerSourceFile[] {
  return walkTypeScript(SCAN_SRC_DIR).map((full) => ({
    path: relative(PACKAGE_ROOT, full).split(sep).join('/'),
    sha256: sha256Hex(readFileSync(full)),
  }));
}

const SCANNER_MANIFEST = scannerSourceManifest();
const POLICY = corpusPolicy();
const RECOMPUTED_SCANNER_VERSION = corpusScannerVersion(SCANNER_MANIFEST);
const RECOMPUTED_VERSIONS = versionTriple(POLICY, RECOMPUTED_SCANNER_VERSION);
const ASSIGNMENT = shardOfSpecs(SPECS, SHARD_COUNT);

function recomputedPlan(): CorpusPlanManifest {
  const rows = SPECS.map((spec) => {
    const shard = ASSIGNMENT.shardOfCaseId.get(spec.caseId);
    if (shard === undefined) throw new Error(`家族未分配：${spec.familyId}`);
    return {
      caseId: spec.caseId,
      familyId: spec.familyId,
      split: spec.split,
      shard,
      kind: spec.kind,
      ruleId: spec.ruleId,
    };
  });
  return planManifest(rows, RECOMPUTED_VERSIONS, SHARD_COUNT, ASSIGNMENT.assignment.planHash);
}

const RECOMPUTED_PLAN = recomputedPlan();

/** 期望行。只由 `spec` 得出，不看任何实测结果（与 `lib.mjs#expectedRowOf` 同形）。 */
function expectedRowOf(spec: CorpusCaseSpec): ExpectedRow {
  const expectation = spec.expectation;
  return {
    label: expectation.label,
    status: expectation.expectedStatus,
    rules: [...expectation.expectedRules],
    otherRules: [...expectation.expectedOtherRules],
    disposition: expectation.expectedDisposition,
    confidence: expectation.expectedConfidence,
    subTypes: [...expectation.expectedSubTypes],
    toleratedSubTypes: [...expectation.toleratedSubTypes],
  };
}

/** 实测命中的规则，按 `RULE_IDS` 的固定顺序去重（与 `lib.mjs#orderedRules` 同形）。 */
function orderedRules(findings: readonly Finding[]): readonly RuleId[] {
  const present = new Set(findings.map((finding) => finding.ruleId));
  return RULE_IDS.filter((ruleId) => present.has(ruleId));
}

/** 报告里 28 个节的固定顺序。 */
const REPORT_SECTIONS = [
  'header',
  'targets',
  'execution',
  'composition',
  'verdict',
  'rules',
  'recallGate',
  'declaredRuleCoverage',
  'b12',
  'lowConfidenceConfirm',
  'safeConfirmRate',
  'falseBlockRate',
  'cells',
  'subTypeCoverage',
  'techTags',
  'quotaDeltas',
  'shards',
  'shardBudget',
  'splits',
  'boundary',
  'expectations',
  'attribution',
  'defects',
  'resourceLimits',
  'secondLevelBudget',
  'extraGates',
  'overall',
  'gaps',
] as const;

const SHARD_HEADER_KEYS = [
  'kind',
  'shard',
  'shardCount',
  'planHash',
  'shardPlanHash',
  'corpusVersion',
  'scannerVersion',
  'rulesetVersion',
  'rulesetFingerprintHash',
  'annotationMode',
  'admissionMet',
  'reportStatus',
  'caseCount',
  'concurrency',
  'wallMs',
  'maxCaseMs',
  'maxCaseId',
  'failedCases',
  'rssPeakBytes',
  'rssStartBytes',
  'rssCaveat',
  'node',
  'platform',
] as const;

const SHARD_CASE_KEYS = [
  'kind',
  'caseId',
  'shard',
  'packageHash',
  'inputHash',
  'corpusVersion',
  'scannerVersion',
  'rulesetVersion',
  'annotationMode',
  'expected',
  'outcome',
  'buildMs',
  'attribution',
] as const;

const PLAN_MANIFEST_KEYS = [
  'schema',
  'corpusVersion',
  'scannerVersion',
  'rulesetVersion',
  'rulesetFingerprintHash',
  'annotationMode',
  'admissionMet',
  'admissionTargets',
  'reportStatus',
  'shardCount',
  'shardPlanHash',
  'caseCount',
  'planHash',
  'scannerSourceFileCount',
] as const;

/**
 * 一律禁止出现在任何产物里的键名。
 *
 * §2.6「每个 shard 输出离线 JSON 报告…不附源片段」+ §2.1 的载体纪律（有害字符串不落盘）。
 * 用**精确键名**匹配，所以 `sourceKind` / `subTypes` 这类同前缀的正当字段不受影响。
 */
const FORBIDDEN_PAYLOAD_KEYS = [
  'content',
  'text',
  'snippet',
  'source',
  'payload',
  'html',
  'body',
  'code',
  'excerpt',
  'fragment',
  'raw',
  'markup',
  'bytes',
] as const;

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
}

/** 递归收集一棵值里出现过的全部键名。 */
function keysOf(value: unknown): ReadonlySet<string> {
  const into = new Set<string>();
  collectKeys(value, into);
  return into;
}

// ---------------------------------------------------------------------------
// 抽样真扫描：覆盖 13 条规则各一件 + 一件安全 + 一件边界
// ---------------------------------------------------------------------------

type SmokeCase = {
  readonly spec: CorpusCaseSpec;
  readonly built: ReturnType<typeof buildCase>['built'];
};

/**
 * 确定性抽样：每条规则取 `allCaseSpecs()` 里出现的第一件，再加第一件安全与第一件边界。
 *
 * 刻意**不**挑「已知会通过」的样例 —— §2.5 明令「留出集禁止为单个样例 caseId/hash 写绕过
 * 逻辑」，同一条纪律也适用于抽样：一旦开始手挑，抽到的就只是能证明自己想证明的东西。
 * 这里比的是「钉住的实测行能不能被重新跑出来」，不是「实测是否等于期望」，
 * 所以即便抽中 B5 那 10 件假阴性里的一件，断言依然成立（钉住的也是 PASS）。
 */
function pickSmokeSpecs(): readonly CorpusCaseSpec[] {
  const picked: CorpusCaseSpec[] = [];
  const seenRules = new Set<RuleId>();
  for (const spec of SPECS) {
    if (spec.ruleId !== null && !seenRules.has(spec.ruleId)) {
      seenRules.add(spec.ruleId);
      picked.push(spec);
    }
  }
  const firstSafe = SPECS.find((spec) => spec.kind === 'safe');
  const firstBoundary = SPECS.find((spec) => spec.kind === 'boundary');
  if (firstSafe === undefined || firstBoundary === undefined) {
    throw new Error('抽样失败：语料里没有安全样例或没有边界样例');
  }
  return [...picked, firstSafe, firstBoundary];
}

const SMOKE: readonly SmokeCase[] = pickSmokeSpecs().map((spec) => {
  const generated = buildCase(spec, RECOMPUTED_SCANNER_VERSION, RECOMPUTED_VERSIONS.rulesetVersion);
  return { spec: generated.spec, built: generated.built };
});

// ===========================================================================

describe('§2.6 产物 vs 代码：钉住的版本与计划必须能由当前代码重算出来', () => {
  it('scannerVersion 由 src/scan/** 的 40 个源文件哈希重算得出，四处钉值逐字节相同', () => {
    // 先证明清单本身是可信的：只有 src/scan 下的 .ts，无重复，路径用正斜杠。
    // 少了这三条，「40 个文件」可以靠漏收一个目录凑出来，而漏收正好让版本对源码改动不敏感。
    expect(SCANNER_MANIFEST).toHaveLength(40);
    expect(SCANNER_MANIFEST.every((file) => file.path.startsWith('src/scan/'))).toBe(true);
    expect(SCANNER_MANIFEST.every((file) => file.path.endsWith('.ts'))).toBe(true);
    expect(SCANNER_MANIFEST.every((file) => !file.path.includes('\\'))).toBe(true);
    expect(new Set(SCANNER_MANIFEST.map((file) => file.path)).size).toBe(40);
    expect(new Set(SCANNER_MANIFEST.map((file) => file.sha256)).size).toBe(40);

    const pinned = PLAN_HEADER['scannerVersion'];
    expect(RECOMPUTED_SCANNER_VERSION).toBe(pinned);
    expect(RECOMPUTED_SCANNER_VERSION).toMatch(/^scanner-corpus-[0-9a-f]{16}$/);
    expect(REPORT_HEADER['scannerVersion']).toBe(pinned);
    expect(REPORT_HEADER['scannerSourceFileCount']).toBe(40);
    expect(PLAN_HEADER['scannerSourceFileCount']).toBe(40);
    // 16 个 shard 头 + 1026 行样例，全部带同一个 scannerVersion。
    expect(new Set(SHARDS.map((shard) => shard.header.scannerVersion))).toEqual(new Set([pinned]));
    expect(new Set(SHARD_CASE_ROWS.map((row) => row.scannerVersion))).toEqual(new Set([pinned]));
  });

  it('rulesetVersion 由 policy 内容重算得出，且它就是指纹哈希的前 16 位', () => {
    const pinned = PLAN_HEADER['rulesetVersion'];
    expect(corpusRulesetVersion(POLICY)).toBe(pinned);
    expect(RECOMPUTED_VERSIONS.rulesetVersion).toBe(pinned);
    expect(pinned).toMatch(/^ruleset-corpus-[0-9a-f]{16}$/);

    const fingerprintHash = PLAN_HEADER['rulesetFingerprintHash'];
    expect(fingerprintHash).toBe(RECOMPUTED_VERSIONS.rulesetFingerprintHash);
    expect(String(fingerprintHash)).toHaveLength(64);
    // 版本号必须**是**指纹的派生物，而不是与它并列的另一个数字：
    // 否则改词表只改到其中一个，报告就会自称「版本没变但指纹变了」。
    expect(String(pinned)).toBe(`ruleset-corpus-${String(fingerprintHash).slice(0, 16)}`);

    expect(REPORT_HEADER['rulesetVersion']).toBe(pinned);
    expect(REPORT_HEADER['rulesetFingerprintHash']).toBe(fingerprintHash);
    expect(new Set(SHARDS.map((shard) => shard.header.rulesetVersion))).toEqual(new Set([pinned]));
    expect(new Set(SHARDS.map((shard) => shard.header.rulesetFingerprintHash))).toEqual(
      new Set([fingerprintHash]),
    );
    expect(new Set(SHARD_CASE_ROWS.map((row) => row.rulesetVersion))).toEqual(new Set([pinned]));
  });

  it('planHash / shardPlanHash 由全量 1026 行计划重算得出，与钉住的值相同', () => {
    expect(SPECS).toHaveLength(1026);
    expect(PLAN_ROWS).toHaveLength(1026);
    expect(CASE_MANIFEST_ROWS).toHaveLength(1026);
    expect(SHARD_CASE_ROWS).toHaveLength(1026);
    expect(RECOMPUTED_PLAN.caseCount).toBe(1026);
    expect(PLAN_HEADER['caseCount']).toBe(1026);
    expect(REPORT_HEADER['caseCount']).toBe(1026);

    expect(RECOMPUTED_PLAN.planHash).toBe(PLAN_HEADER['planHash']);
    expect(RECOMPUTED_PLAN.planHash).toHaveLength(64);
    expect(ASSIGNMENT.assignment.planHash).toBe(RECOMPUTED_PLAN.shardPlanHash);
    expect(ASSIGNMENT.assignment.planHash).toBe(PLAN_HEADER['shardPlanHash']);
    // 16 个 shard 头都带着同一个 planHash：这就是 §2.6「聚合作业检查…计划清单 hash 一致」
    // 能在**每片各自离线跑完**之后仍然成立的原因。
    expect(new Set(SHARDS.map((shard) => shard.header.planHash))).toEqual(
      new Set([RECOMPUTED_PLAN.planHash]),
    );
    expect(new Set(SHARDS.map((shard) => shard.header.shardPlanHash))).toEqual(
      new Set([RECOMPUTED_PLAN.shardPlanHash]),
    );
    expect(REPORT_HEADER['planHash']).toBe(RECOMPUTED_PLAN.planHash);
    expect(REPORT_HEADER['shardPlanHash']).toBe(RECOMPUTED_PLAN.shardPlanHash);
  });

  it('计划头行的键集合是白名单：一个不多一个不少', () => {
    // 加键的诱惑是真实的（想把实测数字也塞进计划头），但计划一旦带上实测，
    // 「计划 vs 执行」就退化成同一段代码的两次调用 —— §2.6 那条检查随之失效。
    expect(Object.keys(PLAN_HEADER).sort()).toEqual([...PLAN_MANIFEST_KEYS].sort());
    expect(PLAN_HEADER['schema']).toBe('littleq-corpus-plan-v1');
  });

  it('逐件计划行与重算结果逐字段相同（familyId / split / shard / kind / ruleId）', () => {
    const recomputedById = new Map(RECOMPUTED_PLAN.cases.map((row) => [row.caseId, row]));
    const drift: string[] = [];
    for (const pinned of PLAN_ROWS) {
      const current = recomputedById.get(pinned.caseId);
      if (current === undefined) {
        drift.push(`${pinned.caseId}: 计划里有、当前代码里没有`);
        continue;
      }
      for (const key of ['familyId', 'split', 'shard', 'kind', 'ruleId'] as const) {
        if (pinned[key] !== current[key]) drift.push(`${pinned.caseId}.${key}`);
      }
    }
    for (const caseId of recomputedById.keys()) {
      if (!PLAN_ROW_BY_ID.has(caseId)) drift.push(`${caseId}: 当前代码里有、计划里没有`);
    }
    expect(drift).toEqual([]);
  });
});

describe('§2.6 产物 vs 产物：16 shard 的完整性与三方一致性', () => {
  it('16 个 shard 文件齐全，编号 0..15 无缺无重，文件名与头行互相印证', () => {
    expect(SHARD_COUNT).toBe(16);
    expect(SHARDS).toHaveLength(SHARD_COUNT);
    expect(SHARDS.map((shard) => shard.file)).toEqual(
      Array.from({ length: SHARD_COUNT }, (_, index) => shardFileName(index)),
    );
    expect(SHARDS.map((shard) => shard.shard)).toEqual(
      Array.from({ length: SHARD_COUNT }, (_, index) => index),
    );
    for (const shard of SHARDS) {
      expect(shard.header.kind).toBe('shard-header');
      expect(shard.header.shardCount).toBe(SHARD_COUNT);
      expect(shard.cases.every((row) => row.kind === 'case')).toBe(true);
    }
  });

  it('shard 行覆盖计划里的每一个 caseId：无缺失、无计划外、无重复', () => {
    // 这一条就是 §2.6「超时、解析失败、缺 shard、缓存损坏、跳过样例直接令 CI 失败，
    // 不从分母移除」的可执行形式：分母永远是计划里的 1026，不是「跑成功的那些」。
    const problems = planCompleteness(
      RECOMPUTED_PLAN,
      SHARD_CASE_ROWS.map((row) => row.caseId),
    );
    expect(problems).toEqual([]);
    // 阳性对照：这道门真的会响。抽掉一行就必然报 MISSING_CASE，
    // 抽掉的那行换成计划外的 id 就必然报 UNPLANNED_CASE。
    const withoutLast = SHARD_CASE_ROWS.slice(0, -1).map((row) => row.caseId);
    const last = SHARD_CASE_ROWS.at(-1);
    if (last === undefined) throw new Error('shard 报告里一件样例都没有');
    expect(planCompleteness(RECOMPUTED_PLAN, withoutLast)).toEqual([
      { code: 'MISSING_CASE', caseId: last.caseId },
    ]);
    // planCompleteness 的输出按 caseId 再按 code 排序，所以 'not-in-the-plan'（n）
    // 排在最后一件样例（v 开头）前面 —— 顺序本身也是钉住的契约。
    expect(planCompleteness(RECOMPUTED_PLAN, [...withoutLast, 'not-in-the-plan'])).toEqual([
      { code: 'UNPLANNED_CASE', caseId: 'not-in-the-plan' },
      { code: 'MISSING_CASE', caseId: last.caseId },
    ]);
  });

  it('每行的 shard 既等于所在文件的编号，也等于计划的分配', () => {
    const mismatch: string[] = [];
    for (const shard of SHARDS) {
      for (const row of shard.cases) {
        if (row.shard !== shard.shard) mismatch.push(`${row.caseId}: 行内 ${String(row.shard)}`);
        const planned = PLAN_ROW_BY_ID.get(row.caseId);
        if (planned === undefined) {
          mismatch.push(`${row.caseId}: 计划里没有`);
        } else if (planned.shard !== shard.shard) {
          mismatch.push(`${row.caseId}: 计划分到 ${String(planned.shard)}`);
        }
      }
    }
    expect(mismatch).toEqual([]);
    // 分片是**按家族**分的（§2.6「按 family hash 固定分配 16 shards」）：
    // 同一家族的样例必须全在同一片里，否则 dev/holdout 的隔离与片间负载都无从谈起。
    const shardOfFamily = new Map<string, Set<number>>();
    for (const row of SHARD_CASE_ROWS) {
      const family = PLAN_ROW_BY_ID.get(row.caseId)?.familyId ?? row.caseId;
      const seen = shardOfFamily.get(family) ?? new Set<number>();
      seen.add(row.shard);
      shardOfFamily.set(family, seen);
    }
    expect([...shardOfFamily.values()].every((shards) => shards.size === 1)).toBe(true);
  });

  it('每片的 caseCount 与实际行数相符，failedCases 全为 0', () => {
    for (const shard of SHARDS) {
      expect(shard.header.caseCount).toBe(shard.cases.length);
      expect(shard.header.failedCases).toBe(0);
      expect(shard.cases.every((row) => row.outcome.ok)).toBe(true);
      expect(shard.cases.every((row) => row.outcome.errorCode === null)).toBe(true);
    }
    const total = SHARDS.reduce((sum, shard) => sum + shard.header.caseCount, 0);
    expect(total).toBe(1026);
    const execution = reportSection('execution');
    expect(execution['planned']).toBe(1026);
    expect(execution['reported']).toBe(1026);
    expect(execution['failed']).toBe(0);
    expect(execution['missing']).toBe(0);
    expect(execution['unaccounted']).toBe(0);
  });

  it('packageHash 三方一致：plan.jsonl ↔ case-manifest.jsonl ↔ shard 报告', () => {
    // §2.5「样例包 immutable」的凭据就是这个哈希。三处各写一遍是为了让
    // 「改了一处」必然暴露：只核对两处的话，第三处可以悄悄指向另一个包。
    const mismatch: string[] = [];
    for (const planRow of PLAN_ROWS) {
      const manifestRow = MANIFEST_ROW_BY_ID.get(planRow.caseId);
      const caseRow = CASE_ROW_BY_ID.get(planRow.caseId);
      if (manifestRow === undefined || caseRow === undefined) {
        mismatch.push(`${planRow.caseId}: 三方里缺一方`);
        continue;
      }
      if (manifestRow.packageHash !== planRow.packageHash) {
        mismatch.push(`${planRow.caseId}: case-manifest 与 plan 不符`);
      }
      if (caseRow.packageHash !== planRow.packageHash) {
        mismatch.push(`${planRow.caseId}: shard 报告与 plan 不符`);
      }
      if (!/^[0-9a-f]{64}$/.test(planRow.packageHash)) {
        mismatch.push(`${planRow.caseId}: packageHash 不是 64 位十六进制`);
      }
    }
    expect(mismatch).toEqual([]);
    // 1026 件样例必须是 1026 个不同的包。若有两件同哈希，说明生成器在重复吐同一份字节
    // —— 那正是本单明令禁止的「把一个包复制 N 份凑数」。
    expect(new Set(PLAN_ROWS.map((row) => row.packageHash)).size).toBe(1026);
  });

  it('版本三元组在计划头、报告头与每一片头行里完全一致（versionMismatch 返回空）', () => {
    for (const shard of SHARDS) {
      expect(versionMismatch(RECOMPUTED_PLAN, shard.header)).toEqual([]);
    }
    expect(
      versionMismatch(RECOMPUTED_PLAN, {
        corpusVersion: String(REPORT_HEADER['corpusVersion']),
        scannerVersion: String(REPORT_HEADER['scannerVersion']),
        rulesetVersion: String(REPORT_HEADER['rulesetVersion']),
      }),
    ).toEqual([]);
    for (const row of SHARD_CASE_ROWS) {
      expect(row.corpusVersion).toBe(CORPUS_VERSION);
    }
    // 阳性对照：versionMismatch 不是恒返回空的摆设。
    expect(
      versionMismatch(RECOMPUTED_PLAN, {
        corpusVersion: '9.9.9',
        scannerVersion: String(PLAN_HEADER['scannerVersion']),
        rulesetVersion: String(PLAN_HEADER['rulesetVersion']),
      }),
    ).toHaveLength(1);
  });

  it('report.jsonl 的 28 个节按固定顺序出现，section 名无重复；摘要表 55 行', () => {
    expect(REPORT_ROWS.map((row) => row['section'])).toEqual([...REPORT_SECTIONS]);
    expect(new Set(REPORT_ROWS.map((row) => row['section'])).size).toBe(REPORT_SECTIONS.length);
    expect(REPORT_SUMMARY_ROWS).toHaveLength(55);
    for (const row of REPORT_SUMMARY_ROWS) {
      expect(Object.keys(row).sort()).toEqual(['metric', 'pass', 'spec', 'target', 'value']);
    }
    // 摘要表的每一行都必须指回 §2 的某一条：没有出处的指标就是自造的判据。
    expect(REPORT_SUMMARY_ROWS.every((row) => String(row['spec']).includes('§'))).toBe(true);
  });
});

describe('期望值不许反向漂移（ZLQ-194 §16：不得把期望改成实测的样子）', () => {
  it('全部 1026 行的 expected 与「从 spec 重算的期望」逐字段相同', () => {
    // 这是整个文件最重要的一条断言。
    // 把 `expected.status` 从 BLOCK 改成 PASS，就能让召回门与覆盖率门同时变绿，
    // 而 18 道门一道都不会响 —— 因为改的是数据不是代码。
    // 期望的**唯一来源**是 spec，所以逐件重算再比对；改报告不改 spec 会对不上，
    // 改 spec 则 planHash 与 packageHash 都会变（上面两组断言接着响）。
    const drift: string[] = [];
    for (const row of SHARD_CASE_ROWS) {
      const spec = SPEC_BY_CASE_ID.get(row.caseId);
      if (spec === undefined) {
        drift.push(`${row.caseId}: 样例表里没有`);
        continue;
      }
      const recomputed = expectedRowOf(spec);
      for (const key of Object.keys(recomputed) as (keyof ExpectedRow)[]) {
        const pinnedValue: unknown = row.expected[key];
        const currentValue: unknown = recomputed[key];
        const same = Array.isArray(currentValue)
          ? JSON.stringify(pinnedValue) === JSON.stringify(currentValue)
          : pinnedValue === currentValue;
        if (!same) drift.push(`${row.caseId}.expected.${key}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('case-manifest 的 13 条逐规则标注由冻结处置推出，与重算一致', () => {
    const drift: string[] = [];
    for (const entry of CASE_MANIFEST_ROWS) {
      const spec = SPEC_BY_CASE_ID.get(entry.caseId);
      if (spec === undefined) {
        drift.push(`${entry.caseId}: 样例表里没有`);
        continue;
      }
      const recomputed = expectedByRuleOf(spec);
      for (const ruleId of RULE_IDS) {
        if (entry.expectedByRule[ruleId] !== recomputed[ruleId]) {
          drift.push(`${entry.caseId}.expectedByRule.${ruleId}`);
        }
      }
      // §2.3.2「作品整体分类按最高处置等级」—— 整体标签必须是 13 条里的最高档，
      // 不能是手填的一个「看起来对」的值。
      if (entry.expectedOverall !== highestLabel(RULE_IDS.map((id) => recomputed[id]))) {
        drift.push(`${entry.caseId}.expectedOverall`);
      }
      if (entry.annotations.length !== RULE_IDS.length) {
        drift.push(`${entry.caseId}.annotations 不是 13 条`);
      }
      // §2.3.5 要求标注者互相看不到标签。本语料只有一名标注者 ⇒ 没有「对方」可屏蔽，
      // 所以这一位恒为 false。把它改成 true 等于宣称满足了双盲（§6.1 张力 ③ 明令禁止）。
      if (entry.annotations.some((annotation) => annotation.blindToPeers !== false)) {
        drift.push(`${entry.caseId}.blindToPeers 不是 false`);
      }
      // §2.3.1「先隐藏扫描器输出，防锚定」：期望的三个来源全部先于扫描存在。
      if (entry.annotations.some((annotation) => annotation.blindToScannerOutput !== true)) {
        drift.push(`${entry.caseId}.blindToScannerOutput 不是 true`);
      }
      if (entry.annotations.some((a) => a.annotatorAlias !== IMPLEMENTER_ALIAS)) {
        drift.push(`${entry.caseId}.annotatorAlias`);
      }
      // §2.3「标注者用内部 alias，不放个人联系方式」⇒ 裁决引用为 null，
      // 且理由不是「两人一致」，而是「只有一人，不存在分歧可裁决」。
      if (entry.adjudicationRef !== null) drift.push(`${entry.caseId}.adjudicationRef 不是 null`);
      if (entry.corpusVersion !== CORPUS_VERSION) drift.push(`${entry.caseId}.corpusVersion`);
      if (entry.sourceKind !== PRODUCED_SOURCE_KIND) drift.push(`${entry.caseId}.sourceKind`);
      if (entry.sourceLicense !== PRODUCED_SOURCE_LICENSE) {
        drift.push(`${entry.caseId}.sourceLicense`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('抽样 15 件重建后，整条 case-manifest 条目（含 enrich 过的 tags）逐字段相同', () => {
    for (const smoke of SMOKE) {
      const pinned = MANIFEST_ROW_BY_ID.get(smoke.spec.caseId);
      if (pinned === undefined) throw new Error(`case-manifest 里没有 ${smoke.spec.caseId}`);
      const recomputed = caseManifestEntry(smoke.spec, smoke.built, {
        corpusVersion: CORPUS_VERSION,
        sourceKind: PRODUCED_SOURCE_KIND,
        sourceLicense: PRODUCED_SOURCE_LICENSE,
      });
      // tags 只有在**建包之后**才是完整的（生成器会 enrich），所以这一条必须走 buildCase。
      expect(recomputed).toEqual(pinned);
      expect(recomputed.packageHash).toBe(smoke.built.artifactHash);
    }
  });

  it('dev/holdout 按家族切分：报告里 familyLeakage 为空、leakFree 为 true', () => {
    const splitOfFamily = new Map<string, Set<Split>>();
    for (const spec of SPECS) {
      const seen = splitOfFamily.get(spec.familyId) ?? new Set<Split>();
      seen.add(spec.split);
      splitOfFamily.set(spec.familyId, seen);
    }
    const leaking = [...splitOfFamily.entries()]
      .filter(([, splits]) => splits.size > 1)
      .map(([familyId]) => familyId);
    expect(leaking).toEqual([]);
    expect(splitOfFamily.size).toBe(144);

    const splits = reportSection('splits');
    expect(splits['leakFree']).toBe(true);
    expect(splits['familyLeakage']).toEqual([]);
  });
});

describe('三条不可谈判项（ZLQ-201 PASS §6）在产物里的可核对形式', () => {
  it('①：没有任何规则在 TP=0 时报出 precision=1；B12 是 ZERO_HARD_HITS 且不适用精度目标', () => {
    const verdict = reportSection('verdict');
    const rules = verdict['rules'] as readonly VerdictRuleRow[];
    expect(rules).toHaveLength(13);
    expect(rules.map((row) => row.ruleId)).toEqual([...RULE_IDS]);

    for (const row of rules) {
      // 「不得报告 precision=100%」在数据里的形状就是这一条：
      // TP=0 时 precision 必须是 null，而不是 1、不是 0、不是「不适用所以算满分」。
      if (row.trueHardBlocks === 0) {
        expect(row.precision).toBeNull();
        expect(row.precisionState).toBe('ZERO_HARD_HITS');
        expect(row.precisionTargetApplies).toBe(false);
      } else {
        expect(row.precisionState).toBe('MEASURED');
        expect(row.precisionTargetApplies).toBe(true);
        expect(row.precision).not.toBeNull();
        // precision = TP / (TP + FP)，且必须落在 [0,1]。
        const precision = row.precision as number;
        expect(precision).toBe(row.trueHardBlocks / (row.trueHardBlocks + row.falseHardBlocks));
        expect(row.hardHits).toBe(row.trueHardBlocks + row.falseHardBlocks);
      }
    }

    const b12 = rules.find((row) => row.ruleId === 'B12');
    if (b12 === undefined) throw new Error('verdict 里没有 B12');
    expect(b12.hardHits).toBe(0);
    expect(b12.trueHardBlocks).toBe(0);
    expect(b12.precision).toBeNull();
    expect(b12.precisionState).toBe('ZERO_HARD_HITS');
    expect(b12.precisionTargetApplies).toBe(false);
    // 「不适用」被判成达标，而不是被判成 100%：这两者在报告里必须能区分开。
    expect(b12.meetsPrecisionTarget).toBe(true);

    // 其余 12 条都是 MEASURED，TP>0 —— 也就是「TP=0 不算通过」没有被绕过：
    // 没有一条硬规则是靠「零命中所以零误报」混过去的。
    const measured = rules.filter((row) => row.precisionState === 'MEASURED');
    expect(measured).toHaveLength(12);
    expect(measured.every((row) => row.trueHardBlocks > 0)).toBe(true);
  });

  it('②：B12 零硬拦 —— 从 1026 行原始实测里数，不只看报告的结论', () => {
    const b12 = reportSection('b12');
    expect(b12['hardBlocks']).toBe(0);
    expect(b12['primarySamples']).toBe(60);
    expect(b12['confirmedAsExpected']).toBe(60);
    expect(b12['notConfirmedCaseIds']).toEqual([]);
    expect(b12['pass']).toBe(true);

    // 报告的结论是从这些行数出来的；直接数一遍原始行，结论才有独立的凭据。
    let hardBlocked = 0;
    let confirmed = 0;
    for (const row of SHARD_CASE_ROWS) {
      if (row.outcome.blockedRules.includes('B12')) hardBlocked += 1;
      if (row.outcome.confirmedRules.includes('B12')) confirmed += 1;
    }
    expect(hardBlocked).toBe(0);
    expect(confirmed).toBe(60);
    // B12 的冻结处置上限就是 CONFIRM_REQUIRED，所以「零硬拦」不是这批语料的运气，
    // 而是判定面的结构性质。
    expect(CASE_MANIFEST_ROWS.every((entry) => entry.expectedByRule['B12'] !== 'HARD_BLOCK')).toBe(
      true,
    );
  });

  it('③：设计量没有被当成实测量 —— 配额差表仍在，两档未产出的来源仍是 0', () => {
    const quotaDeltas = reportSection('quotaDeltas')['quotaDeltas'] as readonly QuotaDeltaRow[];
    expect(quotaDeltas).toHaveLength(10);
    for (const row of quotaDeltas) {
      // 每一行都必须同时给出设计量与实测量，且差值自洽。
      // 只给设计量的那一列就是「用设计数量代替实际 corpus」。
      expect(row.delta).toBe(row.measured - row.design);
      expect(row.note).not.toBe('');
    }
    const byDimension = new Map(quotaDeltas.map((row) => [row.dimension, row]));
    const safeTotal = [...byDimension.values()].find((row) => row.dimension.includes('安全集总量'));
    if (safeTotal === undefined) throw new Error('配额差表里没有安全集总量那一行');
    expect(safeTotal.design).toBe(DESIGN_SAFE_TOTAL);
    expect(safeTotal.measured).toBe(240);

    const handmade = [...byDimension.values()].find((row) =>
      row.dimension.includes('团队人工制作'),
    );
    const ported = [...byDimension.values()].find((row) => row.dimension.includes('公共示例移植'));
    if (handmade === undefined || ported === undefined) {
      throw new Error('配额差表里缺了未产出的两档');
    }
    expect(handmade.design).toBe(240);
    expect(handmade.measured).toBe(0);
    expect(ported.design).toBe(120);
    expect(ported.measured).toBe(0);

    const violation = [...byDimension.values()].find((row) => row.dimension.includes('违规'));
    if (violation === undefined) throw new Error('配额差表里没有违规总量那一行');
    expect(violation.design).toBe(DESIGN_VIOLATION_TOTAL);
    expect(violation.measured).toBe(780);

    const composition = reportSection('composition');
    expect(composition['safe']).toBe(240);
    expect(composition['violation']).toBe(780);
    expect(composition['boundary']).toBe(6);
    expect(composition['total']).toBe(1026);
  });
});

describe('§2.6 报告里没有源片段：键集合白名单 + 载体不落盘', () => {
  it('shard 报告两类行的键集合是固定白名单', () => {
    const headerKeySets = new Set(
      SHARDS.map((shard) =>
        Object.keys(shard.header as unknown as Row)
          .sort()
          .join(','),
      ),
    );
    const caseKeySets = new Set(
      SHARD_CASE_ROWS.map((row) =>
        Object.keys(row as unknown as Row)
          .sort()
          .join(','),
      ),
    );
    // 16 个头行彼此同形、1026 行样例彼此同形：不允许「某一片多带了一个字段」。
    expect(headerKeySets.size).toBe(1);
    expect(caseKeySets.size).toBe(1);
    expect([...headerKeySets][0]).toBe([...SHARD_HEADER_KEYS].sort().join(','));
    expect([...caseKeySets][0]).toBe([...SHARD_CASE_KEYS].sort().join(','));
  });

  it('任何产物里都不出现 content/text/snippet/source/payload 这类键', () => {
    const seen = new Set<string>();
    const merge = (value: unknown): void => {
      for (const key of keysOf(value)) seen.add(key);
    };
    for (const row of REPORT_ROWS) merge(row);
    for (const row of REPORT_SUMMARY_ROWS) merge(row);
    for (const row of PLAN_ROWS) merge(row);
    for (const row of PLAN_MANIFEST_ROWS) merge(row);
    for (const row of CASE_MANIFEST_ROWS) merge(row);
    for (const shard of SHARDS) {
      merge(shard.header);
      for (const row of shard.cases) merge(row);
    }
    // 阳性对照：递归确实走遍了整棵树（287 个不同键名，含嵌套的 expected/outcome/attribution）。
    // 少了这一条，一个只读顶层键的实现也会「通过」。
    expect(seen.size).toBeGreaterThan(200);
    expect(seen.has('expected')).toBe(true);
    expect(seen.has('outcome')).toBe(true);
    expect(seen.has('consistency')).toBe(true);
    const hits = FORBIDDEN_PAYLOAD_KEYS.filter((key) => seen.has(key));
    expect(hits).toEqual([]);
  });

  it('样例载荷一个字节都没落进产物（含阳性对照：真泄漏必然被抓到）', () => {
    const haystack = [
      readFileSync(join(CORPUS_DIR, 'plan.jsonl'), 'utf8'),
      readFileSync(join(CORPUS_DIR, 'plan-manifest.jsonl'), 'utf8'),
      readFileSync(join(CORPUS_DIR, 'case-manifest.jsonl'), 'utf8'),
      readFileSync(join(CORPUS_DIR, 'report.jsonl'), 'utf8'),
      readFileSync(join(CORPUS_DIR, 'report-summary.jsonl'), 'utf8'),
      ...SHARDS.map((shard) => readFileSync(join(SHARD_DIR, shard.file), 'utf8')),
    ].join('\n');

    // 对照一：草堆不是空的，而且确实装着产物的内容。
    expect(haystack.length).toBeGreaterThan(1_000_000);
    expect(haystack).toContain(SMOKE[0]?.spec.caseId ?? '');

    // 候选行来自**真实建包**的文本文件，不是编出来的样例字符串。
    const decoder = new TextDecoder();
    const candidates: { readonly where: string; readonly line: string }[] = [];
    for (const smoke of SMOKE) {
      for (const file of smoke.built.files) {
        const text = decoder.decode(file.bytes);
        const lines = text.split('\n');
        for (const [index, raw] of lines.entries()) {
          const line = raw.trim();
          // 过滤掉空行、纯标点、以及任何短到会在正常 JSON 里偶然出现的东西。
          if (line.length < 12) continue;
          if (!/[\p{L}]/u.test(line)) continue;
          candidates.push({
            where: `${smoke.spec.caseId}/${file.path}:${String(index + 1)}`,
            line,
          });
        }
      }
    }
    // 对照二：候选集非空，而且覆盖了违规样例（B9/B11/B13 的载体就在里面）。
    expect(candidates.length).toBeGreaterThan(50);
    expect(new Set(candidates.map((item) => item.where.split('/')[0] ?? '')).size).toBe(
      SMOKE.length,
    );

    // 对照三：同一套搜索机制**能**找到真泄漏。把一条候选行拼到草堆末尾再搜，必须命中。
    const probe = candidates[0];
    if (probe === undefined) throw new Error('没有候选载荷行');
    expect(`${haystack}\n${probe.line}`).toContain(probe.line);

    // 正式断言。失败消息里只放 caseId/路径/行号，**绝不放载荷正文** ——
    // §2.1 的载体纪律要求有害字符串既不落盘也不打印，一次断言失败不能成为它的出口。
    const leaked = candidates.filter((item) => haystack.includes(item.line));
    expect(leaked.map((item) => item.where)).toEqual([]);
  });
});

describe('§2.3.1 先标后测：计划 runner 不碰判定面', () => {
  it('corpus-plan.mjs 不调用扫描入口，且 import 图里只有 ./lib.mjs', () => {
    const source = readFileSync(PLAN_RUNNER_PATH, 'utf8');
    // §2.3.1 要求「策展人先写 case manifest，并隐藏扫描器输出以防锚定」。
    // 把它做成可执行的性质而不是承诺。
    //
    // 这里断言的是**调用点与 import 图**，不是裸词零命中。裸词版本是错的，
    // 而且我是先写错了才发现：这份 runner 的文档注释里就写着「本文件从头到尾不
    // import scanPackage」，一条 `not.toContain('scanPackage')` 会被这句解释自己的
    // 注释绊红 —— 门读到的成了注释，不是代码。
    expect(source.match(/\bscanPackage\s*\(/g) ?? []).toEqual([]);
    expect(source.match(/\bscanOne\s*\(/g) ?? []).toEqual([]);
    expect(source.match(/\bmeasureCorpus\s*\(/g) ?? []).toEqual([]);
    expect(source.match(/\bfrom\s+'[^']*\/scan\/[^']*'/g) ?? []).toEqual([]);
    // 更强的形状：这份 runner 的依赖只有同目录的 lib.mjs 一个模块，
    // 而且它连 lib.mjs 里的扫描入口都没取（`scanOne` 由 corpus-scan-shard.mjs 取）。
    // 判定面（src/scan/**）不在直接 import 图里，锚定就无从发生。
    const importBlocks = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)];
    expect(importBlocks).toHaveLength(1);
    expect(importBlocks[0]?.[2]).toBe('./lib.mjs');
    const imported = (importBlocks[0]?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    // 12 个名字全数钉住：多取一个（尤其是扫描入口）就红，少取一个说明这份源码已经
    // 不是产出 plan/case-manifest 的那个 runner 了。
    expect([...imported].sort()).toEqual([
      'CASE_MANIFEST_PATH',
      'CORPUS_VERSION',
      'PLAN_MANIFEST_PATH',
      'PLAN_PATH',
      'PRODUCED_SOURCE_KIND',
      'PRODUCED_SOURCE_LICENSE',
      'assertAttributionChannel',
      'buildCase',
      'caseManifestEntry',
      'planManifestOf',
      'resolveContext',
      'writeJsonl',
    ]);
    expect(imported).not.toContain('scanOne');
    expect(imported).not.toContain('measureCorpus');

    // 阳性对照：这份源码确实是 runner 本体，三个标注/计划函数是真调用点，
    // 不是只在注释里被提到；否则上面四条「零命中」会因为读到一个空文件而全绿。
    expect(source.match(/\bcaseManifestEntry\s*\(/g) ?? []).toHaveLength(1);
    expect(source.match(/\bexpectedByRuleOf\s*\(/g) ?? []).toHaveLength(1);
    expect(source.match(/\bplanManifestOf\s*\(/g) ?? []).toHaveLength(1);
    expect(source.length).toBeGreaterThan(1000);
  });
});

describe('§2.5 / §2.6 判定缓存 key 的失效（内存内证明，不写盘）', () => {
  it('扫描器源码变一个字节 ⇒ scannerVersion 变；只是重新排序 ⇒ 不变', () => {
    const base = corpusScannerVersion(SCANNER_MANIFEST);
    const target = SCANNER_MANIFEST[0];
    if (target === undefined) throw new Error('扫描器源文件清单是空的');

    // 改一个字节：把该文件 sha256 的最后一位换掉，模拟源码被改动。
    const flipped = target.sha256.slice(0, 63) + (target.sha256.endsWith('0') ? '1' : '0');
    const mutated = SCANNER_MANIFEST.map((file) =>
      file.path === target.path ? { path: file.path, sha256: flipped } : file,
    );
    expect(corpusScannerVersion(mutated)).not.toBe(base);

    // 少一个文件也必须变：漏收一个目录不能让版本对那个目录的改动不敏感。
    expect(corpusScannerVersion(SCANNER_MANIFEST.slice(1))).not.toBe(base);

    // 顺序不参与：`corpusScannerVersion` 内部按路径字节序排序，
    // 所以「清单顺序抖了一下」不算扫描器变了 —— 否则每次遍历顺序不同就要重跑全量。
    expect(corpusScannerVersion([...SCANNER_MANIFEST].reverse())).toBe(base);

    // 阳性对照：base 就是钉住的那个值，所以上面三条比的确实是产物在用的版本。
    expect(base).toBe(PLAN_HEADER['scannerVersion']);
  });

  it('policy 变 ⇒ rulesetVersion 变；只换列表顺序 ⇒ 不变', () => {
    const base = corpusRulesetVersion(POLICY);
    expect(base).toBe(PLAN_HEADER['rulesetVersion']);
    // §2.6「配置词库变化必须改变 ruleset hash，不能继续使用旧 PASS」。
    // 用 knownTrackingDomains 而不是 allowWasm：后两者在 v1 被冻结成字面量 false
    // （scan/types.ts:58-60），类型层面就不允许改。
    const withExtraDomain = corpusRulesetVersion(
      corpusPolicy({ knownTrackingDomains: [...POLICY.knownTrackingDomains, 'example.test'] }),
    );
    expect(withExtraDomain).not.toBe(base);
    const withExtraDenyHash = corpusRulesetVersion(
      corpusPolicy({ denyListedImageHashes: ['a'.repeat(64)] }),
    );
    expect(withExtraDenyHash).not.toBe(base);
    const withOtherPrefix = corpusRulesetVersion(
      corpusPolicy({ storageKeyPrefix: 'littleq:other:' }),
    );
    expect(withOtherPrefix).not.toBe(base);
    // 顺序不参与（指纹对这两个表取排序副本）：换顺序不算配置变化。
    const reordered = corpusRulesetVersion(
      corpusPolicy({ knownTrackingDomains: POLICY.knownTrackingDomains.slice().reverse() }),
    );
    expect(reordered).toBe(base);
  });

  it('ruleset 指纹覆盖 51 张词库表与 5 个可读性阈值，少一张都算指纹退化', () => {
    // §2.6「配置词库变化必须改变 ruleset hash，不能继续使用旧 PASS」的**覆盖侧**证明。
    // 词库表内容本身是 ESM 只读导出，测试里改不动它，所以这里钉住的是
    // 「指纹的输入清单有多长」：把 `LEXICON_TABLE_NAMES` 里的表删掉一张，
    // 那张表以后怎么改都不会再动 hash —— 而这条断言会立刻红。
    const fingerprint = rulesetFingerprint(POLICY);
    expect(fingerprint.lexiconTableCount).toBe(51);
    expect(fingerprint.lexiconRevision).toBe(POLICY.lexiconRevision);
    // hash 必须正好是指纹前 16 位（否则「版本」和「指纹」就是两套东西，可以各自漂）。
    expect(fingerprint.hash).toHaveLength(64);
    expect(corpusRulesetVersion(POLICY)).toBe(`ruleset-corpus-${fingerprint.hash.slice(0, 16)}`);
    // 可读性阈值也在指纹里：混淆判据放宽了，旧 PASS 不能继续用。
    expect(Object.keys(fingerprint.readabilityThresholds).sort()).toEqual([
      'entropyMinCodeBytes',
      'highEntropyBitsPerByte',
      'minIdentifiersForRatio',
      'minifiedAverageLineLength',
      'unreadableIdentifierRatio',
    ]);
    // 阳性对照：钉住的 rulesetFingerprintHash 就是这一份指纹的 hash，
    // 所以上面比的确实是产物在用的那一个，不是一个平行算出来的值。
    expect(PLAN_HEADER['rulesetFingerprintHash']).toBe(fingerprint.hash);
  });

  it('样例字节变 ⇒ artifactHash 变；三个版本 + artifactHash 共同构成缓存 key', () => {
    const smoke = SMOKE[0];
    if (smoke === undefined) throw new Error('抽样是空的');
    const baseHash = smoke.built.artifactHash;
    expect(baseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(PLAN_ROW_BY_ID.get(smoke.spec.caseId)?.packageHash).toBe(baseHash);

    // 换一件样例 ⇒ 换一个 artifactHash（1026 件互不相同已在上面那条断言里核过）。
    const other = SMOKE[1];
    if (other === undefined) throw new Error('抽样不足两件');
    expect(other.built.artifactHash).not.toBe(baseHash);

    // §2.6「最终判定缓存必须包含 scannerVersion/rulesetVersion/artifactHash」。
    // 语料流水线里没有常驻的判定缓存（扫描器只有运行内的 memo），所以这条的可核对形式是：
    // **三个输入中任何一个变化，都会让缓存 key 变化**。逐个证明。
    const keyOf = (scanner: string, ruleset: string, artifact: string): string =>
      [scanner, ruleset, artifact].join('|');
    const pinnedKey = keyOf(
      String(PLAN_HEADER['scannerVersion']),
      String(PLAN_HEADER['rulesetVersion']),
      baseHash,
    );
    expect(
      keyOf(
        corpusScannerVersion(
          SCANNER_MANIFEST.map((file, index) =>
            index === 0 ? { path: file.path, sha256: 'b'.repeat(64) } : file,
          ),
        ),
        String(PLAN_HEADER['rulesetVersion']),
        baseHash,
      ),
    ).not.toBe(pinnedKey);
    expect(
      keyOf(
        String(PLAN_HEADER['scannerVersion']),
        corpusRulesetVersion(corpusPolicy({ lexiconRevision: 'lexicon-mutated' })),
        baseHash,
      ),
    ).not.toBe(pinnedKey);
    expect(
      keyOf(
        String(PLAN_HEADER['scannerVersion']),
        String(PLAN_HEADER['rulesetVersion']),
        other.built.artifactHash,
      ),
    ).not.toBe(pinnedKey);
  });
});

describe('§2.6 抽样真扫描：钉住的实测行必须能被重新跑出来', () => {
  it('15 件抽样（13 条规则各一 + 安全 + 边界）重跑后与钉住行逐字段相同', async () => {
    // 阳性对照先过：子类型反解通道当前是通的。
    // 通道断了的话，下面的 subTypes 比对会变成一片 null，看着像「语料没覆盖到」，
    // 其实是工装故障 —— 两者的处置完全不同。
    assertSubTypeChannelLive(RECOMPUTED_SCANNER_VERSION, RECOMPUTED_VERSIONS.rulesetVersion);

    expect(SMOKE).toHaveLength(15);
    const scannedRules = new Set<RuleId>();
    for (const smoke of SMOKE) {
      const pinned = CASE_ROW_BY_ID.get(smoke.spec.caseId);
      if (pinned === undefined) throw new Error(`shard 报告里没有 ${smoke.spec.caseId}`);

      // 建包必须仍然产出钉住的那个包（§2.5 immutable）。
      expect(smoke.built.artifactHash).toBe(pinned.packageHash);

      const result = await scanPackage(smoke.built.input);
      expect(result.ok).toBe(pinned.outcome.ok);
      if (!result.ok) {
        expect(result.code).toBe(pinned.outcome.errorCode);
        continue;
      }
      const findings = result.report.findings;
      expect(result.report.status).toBe(pinned.outcome.status);
      expect(orderedRules(findings)).toEqual([...pinned.outcome.rules]);
      expect(orderedRules(findings.filter((finding) => finding.disposition === 'BLOCK'))).toEqual([
        ...pinned.outcome.blockedRules,
      ]);
      expect(
        orderedRules(findings.filter((finding) => finding.disposition === 'CONFIRM_REQUIRED')),
      ).toEqual([...pinned.outcome.confirmedRules]);
      expect(findings).toHaveLength(pinned.outcome.findingCount);
      expect(result.report.inputHash).toBe(pinned.inputHash);
      expect(result.report.complete).toBe(true);

      // 子类型反解（coverage 那一趟：候选 = 规则注册表声明的全部子类型）。
      const recovered: string[] = [];
      for (const finding of findings) {
        const rule = RULE_BY_ID.get(finding.ruleId);
        const candidates = rule === undefined ? [] : rule.subTypes;
        const outcome = recoverSubType(
          finding,
          smoke.built.hashes,
          RECOMPUTED_SCANNER_VERSION,
          RECOMPUTED_VERSIONS.rulesetVersion,
          candidates,
        );
        if (outcome.ok) recovered.push(`${finding.ruleId}:${outcome.subType}`);
      }
      expect([...new Set(recovered)].sort()).toEqual([...pinned.outcome.subTypes]);
      for (const ruleId of pinned.outcome.blockedRules) {
        scannedRules.add(ruleId as RuleId);
      }
    }
    // §2.4「返回的实际命中集合必须包含人工要求规则，不能靠只报 B1 就算 B11 覆盖成功」：
    // 15 件抽样里，每一件违规样例的主规则都必须真的出现在实测命中里（B12 除外 ——
    // 它的冻结上限是 CONFIRM_REQUIRED，本来就进不了 blockedRules）。
    const violating = SMOKE.filter((smoke) => smoke.spec.ruleId !== null);
    expect(violating).toHaveLength(13);
    for (const smoke of violating) {
      const ruleId = smoke.spec.ruleId;
      if (ruleId === null) continue;
      const pinned = CASE_ROW_BY_ID.get(smoke.spec.caseId);
      if (pinned === undefined) throw new Error(`shard 报告里没有 ${smoke.spec.caseId}`);
      if (ruleId === 'B12') {
        expect(pinned.outcome.confirmedRules).toContain('B12');
        expect(pinned.outcome.blockedRules).not.toContain('B12');
      } else if (pinned.outcome.status === 'BLOCK') {
        expect(pinned.outcome.blockedRules).toContain(ruleId);
        expect(scannedRules.has(ruleId)).toBe(true);
      }
    }
  }, 60_000);
});

describe('§2.5 语料版本、准入声明与缺口表', () => {
  it('corpusVersion 是 0.x 的 rc 而不是 1.0.0，且四处钉值一致', () => {
    expect(CORPUS_VERSION).toMatch(/^0\.\d+\.\d+-rc\.\d+$/);
    expect(CORPUS_VERSION).not.toBe('1.0.0');
    expect(PLAN_HEADER['corpusVersion']).toBe(CORPUS_VERSION);
    expect(REPORT_HEADER['corpusVersion']).toBe(CORPUS_VERSION);
    expect(RECOMPUTED_VERSIONS.corpusVersion).toBe(CORPUS_VERSION);
    expect(new Set(CASE_MANIFEST_ROWS.map((row) => row.corpusVersion))).toEqual(
      new Set([CORPUS_VERSION]),
    );
  });

  it('annotationMode / reportStatus / admissionMet 在每一份产物里都是同一组常量', () => {
    // §6.1 张力 ③：单人非盲标注 ⇒ 准入结构性不成立，报告通篇 provisional。
    // 这三个值不是风格选择，所以它们在类型上就是字面量（manifest.ts / versions.ts）。
    expect(ANNOTATION_MODE).toBe('implementer-pass');
    for (const row of [PLAN_HEADER, REPORT_HEADER]) {
      expect(row['annotationMode']).toBe(ANNOTATION_MODE);
      expect(row['reportStatus']).toBe('provisional');
      expect(row['admissionMet']).toBe(false);
    }
    for (const shard of SHARDS) {
      expect(shard.header.annotationMode).toBe(ANNOTATION_MODE);
      expect(shard.header.reportStatus).toBe('provisional');
      expect(shard.header.admissionMet).toBe(false);
    }
    expect(new Set(SHARD_CASE_ROWS.map((row) => row.annotationMode))).toEqual(
      new Set([ANNOTATION_MODE]),
    );
    const gaps = reportSection('gaps');
    expect(gaps['admissionMet']).toBe(false);
    expect(gaps['reportStatus']).toBe('provisional');
    // §2.3.4 的准入判据（≥95% 原始一致率 + HARD_BLOCK 上 κ ≥0.80）被如实钉在计划头里，
    // 而不是被删掉 —— 删掉就等于宣称它不适用。
    expect(PLAN_HEADER['admissionTargets']).toEqual({
      rawAgreement: 0.95,
      cohenKappaOnHardBlock: 0.8,
    });
  });

  it('报告声明的缺口集合覆盖代码里的声明，3 条阻断准入的都在', () => {
    const gaps = reportSection('gaps');
    const ids = gaps['ids'] as readonly string[];
    const entries = gaps['gaps'] as readonly { readonly id: string }[];
    expect(ids).toHaveLength(DECLARED_GAPS.length);
    expect(entries).toHaveLength(DECLARED_GAPS.length);
    expect(ids).toEqual([...DECLARED_GAP_IDS]);
    expect(entries.map((entry) => entry.id)).toEqual([...DECLARED_GAP_IDS]);
    expect(gaps['count']).toBe(DECLARED_GAPS.length);

    const blocking = gaps['blockingAdmission'] as readonly string[];
    expect(blocking).toEqual([...ADMISSION_BLOCKING_GAP_IDS]);
    expect(blocking).toHaveLength(3);
    // 阻断准入的三条必须真的出现在缺口表里，而不是只在常量数组里挂着。
    for (const id of ADMISSION_BLOCKING_GAP_IDS) expect(ids).toContain(id);
    // 每一条缺口都必须写明「谁去补」，否则它就只是一句免责声明。
    for (const gap of DECLARED_GAPS) {
      expect(gap.fillBy).not.toBe('');
      expect(gap.statement).not.toBe('');
      expect(gap.spec).toContain('§');
    }
    // 语料暴露出的那个扫描器真缺陷必须是被声明的，不是被吸收的。
    expect(ids).toContain('scanner-defect-b5-form-action');
    // 缺口散文里引用的数字必须与指纹的实测值同源：这条是自查出来的缺陷留下的守卫
    // —— `exif-constants-not-in-fingerprint` 曾把「51 张词库表」写成 53，
    // 而同一份交付里的 `lexiconTableCount` 断言钉的是 51，两处对不上却都是绿的。
    const exifGap = DECLARED_GAPS.find((gap) => gap.id === 'exif-constants-not-in-fingerprint');
    expect(exifGap).toBeDefined();
    expect(exifGap?.statement).toContain(
      `${rulesetFingerprint(POLICY).lexiconTableCount} 张词库表`,
    );
  });

  it('报告的总判定是「不达标」，且失败项点名的正是 B5 的假阴性', () => {
    // 这一条不是希望它绿，而是**要求它红**：语料确实没达标（B5 漏检 10 件），
    // 所以 `overall.pass` 必须是 false。若哪天它变成 true 而 B5 没被修，
    // 说明有人把门调松了 —— 那正是 ZLQ-194 §16 点名的形状。
    const overall = reportSection('overall');
    expect(overall['pass']).toBe(false);
    const failures = overall['failures'] as readonly string[];
    expect(failures).toHaveLength(2);
    expect(failures.join('\n')).toContain('recall-all-expected-hard-blocks');
    expect(failures.join('\n')).toContain('declared-rule-coverage');

    const extraGates = reportSection('extraGates')['gates'] as readonly {
      readonly name: string;
      readonly pass: boolean;
      readonly detail: string;
    }[];
    expect(extraGates).toHaveLength(8);
    for (const gate of extraGates) {
      expect(Object.keys(gate).sort()).toEqual(['detail', 'name', 'pass']);
      // 每道门都必须写清它到底量了什么，否则红绿都没有可核对的依据。
      expect(gate.detail).not.toBe('');
    }
    const gateById = new Map(extraGates.map((gate) => [gate.name, gate.pass]));
    expect(gateById.get('recall-all-expected-hard-blocks')).toBe(false);
    expect(gateById.get('declared-rule-coverage')).toBe(false);
    // 其余六道全绿 —— 尤其 B12 那两道，它们是不可谈判项 ②。
    for (const id of [
      'execution-complete',
      'b12-never-hard-blocks',
      'low-confidence-confirm',
      'safe-confirm-rate',
      'holdout-false-block-rate',
      'split-family-leak-free',
    ]) {
      expect(gateById.get(id)).toBe(true);
    }

    const recallGate = reportSection('recallGate');
    expect(recallGate['missedPairs']).toBe(10);
    expect(recallGate['detectedPairs']).toBe(764);
    expect(recallGate['expectedHardBlockPairs']).toBe(774);
    const missed = recallGate['missedCaseIds'] as readonly string[];
    expect(missed).toHaveLength(10);
    expect(missed.every((caseId) => caseId.startsWith('viol-b5-form-empty-action-v'))).toBe(true);

    const defects = reportSection('defects')['items'] as readonly {
      readonly gapId: string;
      readonly ruleId: string;
      readonly measuredAffectedCount: number;
      readonly reproducible: boolean;
      readonly controlHeld: boolean;
    }[];
    expect(defects).toHaveLength(1);
    expect(defects[0]?.gapId).toBe('scanner-defect-b5-form-action');
    expect(defects[0]?.ruleId).toBe('B5');
    expect(defects[0]?.measuredAffectedCount).toBe(10);
    // 「可复现」与「对照成立」必须同时为真：只有复现没有对照，
    // 就无法区分「B5 漏检」与「扫描器根本没跑起来」。
    expect(defects[0]?.reproducible).toBe(true);
    expect(defects[0]?.controlHeld).toBe(true);
  });
});

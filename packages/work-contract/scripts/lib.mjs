/**
 * 语料流水线的共享底座（ZLQ-210；判据出处 ZLQ-156 §2.5 / §2.6 / §7.2）。
 *
 * ## 为什么 runner 是 `.mjs` 且从 `../dist/` 导入
 *
 * 两个约束叠在一起，没有第三种选择：
 * 1. `packages/work-contract/package.json` 的 `exports` 只有 `"."`，没有子路径；
 * 2. plain node 不能加载 `.ts`。
 *
 * 所以命令行 runner 只能 `import('../dist/corpus/*.js')`，前置条件是先编译。
 * vitest 里的测试不受此限（它直接吃 `../src/**`），所以**同一套逻辑在测试里走 src、
 * 在 runner 里走 dist**：这不是两份实现，是同一份 TS 的两种加载方式。
 * `dist/` 缺席时下面那段 guard 会给出可执行的修复命令，而不是让 node 抛一个
 * `ERR_MODULE_NOT_FOUND` 让人去猜。
 *
 * ## 为什么 hash 用被测包自己的实现
 *
 * `scannerVersion` 是 `src/scan/**` 全部源文件 sha256 的清单哈希（`versions.ts`）。
 * 这里用 `dist/scan/hash.js` 的 `sha256Hex` 而不是 `node:crypto`，与 `rulesetFingerprint`
 * 同一条纪律：语料的哈希必须和被测对象同一套实现，否则「hash 算错了」会同时移动
 * 期望值和实测值，两边一起错就永远对不上账。
 * （`test/support.ts` 的 `expectedFindingId` 反过来刻意用 `node:crypto`，因为那里要的是
 * **交叉验证**；这里要的是**同源复现**，两处的选择都出自同一个问题：错了能不能被发现。）
 *
 * ## 不打印任何样例正文
 *
 * §2.1 的载体纪律 + §2.6「shard 报告不附源片段」。本文件产出的每一行 JSONL 只含
 * caseId / hash / 期望 / 实测规则与子类型名 / 耗时 / 版本。子类型名来自规则注册表
 * （`RULE_BY_ID`），是判定面的公开标识符，不是载荷文本。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
export const DIST_ROOT = join(PACKAGE_ROOT, 'dist');
export const CORPUS_DIR = join(PACKAGE_ROOT, 'corpus');
export const SHARD_DIR = join(CORPUS_DIR, 'shards');

export const PLAN_PATH = join(CORPUS_DIR, 'plan.jsonl');
export const PLAN_MANIFEST_PATH = join(CORPUS_DIR, 'plan-manifest.jsonl');
export const CASE_MANIFEST_PATH = join(CORPUS_DIR, 'case-manifest.jsonl');
export const REPORT_PATH = join(CORPUS_DIR, 'report.jsonl');
export const REPORT_SUMMARY_PATH = join(CORPUS_DIR, 'report-summary.jsonl');

if (!existsSync(join(DIST_ROOT, 'corpus', 'generator.js'))) {
  throw new Error(
    '语料 runner 需要已编译的 dist/：先执行 `pnpm --filter @littleq/work-contract build`\n' +
      `（或在仓库根跑 \`pnpm build\`），再执行 scripts/*.mjs。\n` +
      `找不到的文件：${join(DIST_ROOT, 'corpus', 'generator.js')}`,
  );
}

const hashModule = await import('../dist/scan/hash.js');
const scanModule = await import('../dist/scan/index.js');
const rulesModule = await import('../dist/scan/rules/index.js');
const typesModule = await import('../dist/scan/types.js');
const findingModule = await import('../dist/scan/finding.js');
const budgetModule = await import('../dist/scan/budget.js');
const defectsModule = await import('../dist/corpus/defects.js');
const gapsModule = await import('../dist/corpus/gaps.js');
const generatorModule = await import('../dist/corpus/generator.js');
const manifestModule = await import('../dist/corpus/manifest.js');
const metricsModule = await import('../dist/corpus/metrics.js');
const packageModule = await import('../dist/corpus/package.js');
const shardsModule = await import('../dist/corpus/shards.js');
const subtypesModule = await import('../dist/corpus/subtypes.js');
const versionsModule = await import('../dist/corpus/versions.js');

export const { sha256Hex } = hashModule;
export const { scanPackage } = scanModule;
export const { RULES, RULE_BY_ID } = rulesModule;
export const { RULE_IDS } = typesModule;
export const { FROZEN_DISPOSITION_CEILING } = findingModule;
export const { budgetProvenance, DEFAULT_BUDGET_LIMITS, SCANNER_RESOURCE_LIMIT } = budgetModule;
export const {
  b5FormActionRepro,
  B5_FORM_ACTION_GAP_ID,
  B5_FORM_ACTION_RULE_ID,
  B5_FORM_ACTION_VARIANTS,
} = defectsModule;
export const { DECLARED_GAPS, DECLARED_GAP_IDS, ADMISSION_BLOCKING_GAP_IDS } = gapsModule;
export const { allCaseSpecs, buildCase, workIdOf, CORPUS_CREATED_AT } = generatorModule;
export const {
  caseManifestEntry,
  planManifest,
  planCompleteness,
  assertPlanComplete,
  versionMismatch,
  expectedByRuleOf,
  DESIGN_SAFE_TOTAL,
  PRODUCED_SOURCE_KIND,
  PRODUCED_SOURCE_LICENSE,
} = manifestModule;
export const {
  measureCorpus,
  wilsonInterval,
  boundarySummary,
  expectationDistribution,
  formatPercent,
  TECH_TAG_COUNT_QUOTAS,
  TECH_TAG_COVERAGE_REQUIRED,
} = metricsModule;
export const { corpusPolicy } = packageModule;
export const { shardOfSpecs, SHARD_COUNT } = shardsModule;
export const { recoverSubType, assertSubTypeChannelLive } = subtypesModule;
export const { corpusScannerVersion, versionTriple, CORPUS_VERSION } = versionsModule;

// ---------------------------------------------------------------------------
// scannerVersion 的输入：`src/scan/**` 的源文件清单
// ---------------------------------------------------------------------------

function walkTypeScript(root) {
  const out = [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkTypeScript(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * 扫描器源文件清单。只收 `src/scan/**`，不收 `src/corpus/**`。
 *
 * 边界理由：语料代码变了不该让 `scannerVersion` 变（否则每写一条样例就作废一次
 * 全量报告，「版本」退化成时间戳）；反过来，`src/scan/**` 里任何一个字节变化都必须
 * 让它变（§2.5「scanner 有独立内容哈希」+ §2.6「判定缓存必须包含 scannerVersion」）。
 * 路径用正斜杠：Windows 上 `relative()` 给反斜杠，会让同一棵树算出两个版本。
 */
export function scannerSourceManifest() {
  const root = join(PACKAGE_ROOT, 'src', 'scan');
  return walkTypeScript(root).map((full) => ({
    path: relative(PACKAGE_ROOT, full).split(sep).join('/'),
    sha256: sha256Hex(readFileSync(full)),
  }));
}

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

/**
 * 一次流水线运行需要的全部东西。**同一进程内只解析一次**：
 * `allCaseSpecs()` 与 `shardOfSpecs()` 都是纯函数，重复调用只会得到同一份结果，
 * 而三个 runner（plan / shard / aggregate）必须解析出**完全相同**的上下文，
 * 否则 §2.6 的「聚合作业检查…计划清单 hash 一致」就没有意义。
 */
export function resolveContext() {
  const policy = corpusPolicy();
  const scannerManifest = scannerSourceManifest();
  const scannerVersion = corpusScannerVersion(scannerManifest);
  const versions = versionTriple(policy, scannerVersion);
  const specs = allCaseSpecs();
  const { assignment, shardOfCaseId } = shardOfSpecs(specs, SHARD_COUNT);
  const specByCaseId = new Map(specs.map((spec) => [spec.caseId, spec]));
  return {
    policy,
    scannerManifest,
    scannerVersion,
    versions,
    specs,
    specByCaseId,
    assignment,
    shardOfCaseId,
    rulesetVersion: versions.rulesetVersion,
  };
}

/** 计划清单的逐件行。字段就是 `PlanCaseRow`，一个不多一个不少。 */
export function planRowsOf(ctx) {
  return ctx.specs.map((spec) => ({
    caseId: spec.caseId,
    familyId: spec.familyId,
    split: spec.split,
    shard: ctx.shardOfCaseId.get(spec.caseId),
    kind: spec.kind,
    ruleId: spec.ruleId,
  }));
}

export function planManifestOf(ctx) {
  return planManifest(planRowsOf(ctx), ctx.versions, SHARD_COUNT, ctx.assignment.planHash);
}

/**
 * 钉住的计划 vs 当前代码重算出来的计划。**分片 runner 与聚合 runner 共用这一份核对**：
 * 两处各写一遍，迟早会写成两个宽严不同的版本，于是「shard 说一致、aggregate 说不一致」。
 *
 * ## 为什么不许就地重算盖过去
 *
 * §2.6 的原话是「聚合作业检查 caseId 无缺失/重复、版本一致、计划清单 hash 一致后才算指标」。
 * 如果漂移了就直接用重算结果继续跑，那这条检查等于没有：计划与执行会变成同一段代码的
 * 两次调用，缺一个 shard、少一件样例、换一次规则集都不会被发现（正是「判定缓存失效」
 * 要挡的形状）。所以这里**抛错**，让人去决定是「代码变了要重跑 plan」还是「计划被改过」。
 *
 * ## 逐件行也核对一遍，尽管 `planHash` 已经覆盖了 `cases`
 *
 * 冗余是有目的的：`planHash` 只能告诉你「不一致」，逐件比对能告诉你「哪一件的 shard 挪了」。
 * 1026 行的成本在毫秒级，换一条可执行的错误信息，值。
 * （`packageHash` 不在 `PlanCaseRow` 里，因此**不在** `planHash` 覆盖范围内 ——
 * 它由各 runner 逐件对重建产物的 `artifactHash` 核对，见 `scanOne` 与聚合 runner。）
 */
export function verifyPinnedPlan(ctx) {
  const recomputed = planManifestOf(ctx);
  let header;
  let rows;
  try {
    header = readJsonl(PLAN_MANIFEST_PATH)[0];
    rows = readJsonl(PLAN_PATH);
  } catch (error) {
    throw new Error(
      `读不到钉住的计划（${String(error)}）。\n` +
        '先跑 `node scripts/corpus-plan.mjs`，再跑分片与聚合。',
    );
  }
  if (header === undefined) {
    throw new Error(`${PLAN_MANIFEST_PATH} 是空的：没有计划头行。先跑 scripts/corpus-plan.mjs。`);
  }

  const drift = [];
  if (header.planHash !== recomputed.planHash) {
    drift.push(`planHash：计划 ${header.planHash} vs 当前 ${recomputed.planHash}`);
  }
  for (const key of [
    'schema',
    'corpusVersion',
    'scannerVersion',
    'rulesetVersion',
    'rulesetFingerprintHash',
    'shardPlanHash',
    'annotationMode',
    'reportStatus',
    'admissionMet',
    'shardCount',
    'caseCount',
  ]) {
    if (header[key] !== recomputed[key]) {
      drift.push(`${key}：计划 ${String(header[key])} vs 当前 ${String(recomputed[key])}`);
    }
  }

  const recomputedByCaseId = new Map(recomputed.cases.map((row) => [row.caseId, row]));
  const rowDrift = [];
  for (const pinned of rows) {
    const current = recomputedByCaseId.get(pinned.caseId);
    if (current === undefined) {
      rowDrift.push(`${pinned.caseId}：计划里有、当前代码里没有`);
      continue;
    }
    for (const key of ['familyId', 'split', 'shard', 'kind', 'ruleId']) {
      if (pinned[key] !== current[key]) {
        rowDrift.push(
          `${pinned.caseId}.${key}：计划 ${String(pinned[key])} vs 当前 ${String(current[key])}`,
        );
      }
    }
  }
  for (const caseId of recomputedByCaseId.keys()) {
    if (!rows.some((row) => row.caseId === caseId)) {
      rowDrift.push(`${caseId}：当前代码里有、计划里没有`);
    }
  }

  if (drift.length > 0 || rowDrift.length > 0) {
    const head = [...drift, ...rowDrift].slice(0, 8);
    const total = drift.length + rowDrift.length;
    throw new Error(
      `钉住的计划与当前代码不一致（${total} 项）：\n  ${head.join('\n  ')}${total > 8 ? '\n  …' : ''}\n` +
        '两种可能：① 代码变了（样例、分片、词库、扫描器源码之一）⇒ 重跑 scripts/corpus-plan.mjs ' +
        '与全部分片，再聚合；② 计划文件被手改过 ⇒ 还原它。\n' +
        '两种情况都不能靠「就地重算」蒙过去 —— 那正好是 §2.6 要挡的事。',
    );
  }
  return { header, rows, plan: recomputed };
}

// ---------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------

/**
 * 写 JSONL。**刻意不用 `.json`**：仓库根的 `prettier --check .` 只走它能推断 parser 的文件，
 * `.json` 会被格式化（短对象被折叠成一行），于是 `JSON.stringify(x, null, 2)` 钉出来的
 * 字节永远过不了 `format:check`；`.jsonl` 没有 parser，prettier 直接跳过，
 * 钉住的字节就是可复现的字节。这条是实测过的，不是猜的。
 */
export function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, rows.length === 0 ? '' : `${text}\n`, 'utf8');
  return { path, lines: rows.length, bytes: Buffer.byteLength(readFileSync(path)) };
}

export function readJsonl(path) {
  const text = readFileSync(path, 'utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) !== '') {
    throw new Error(`JSONL 必须以换行结尾（否则最后一行可能是被截断的写入）：${path}`);
  }
  return lines.slice(0, -1).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path} 第 ${index + 1} 行不是合法 JSON：${String(error)}`);
    }
  });
}

export function shardReportPath(shard) {
  return join(SHARD_DIR, `shard-${String(shard).padStart(2, '0')}.jsonl`);
}

// ---------------------------------------------------------------------------
// 单件样例：建包 → 扫描 → 归因
// ---------------------------------------------------------------------------

/** 实测命中的规则，按 `RULE_IDS` 的固定顺序去重 —— 报告里的数组顺序必须可复现。 */
export function orderedRules(findings) {
  const present = new Set(findings.map((finding) => finding.ruleId));
  return RULE_IDS.filter((ruleId) => present.has(ruleId));
}

/**
 * 子类型归因的两趟。
 *
 * `Finding` 的输出面**没有** `subType`（§6.2：子类型只进 HMAC），所以只能反解，
 * 而反解必须有候选集。两趟用两个不同的候选集，回答两个不同的问题：
 *
 * - **coverage**：候选 = 该规则注册表声明的全部子类型。回答「哪些声明过的槽位被走到过」
 *   ⇒ §2.4 的 X/91 覆盖率。候选集来自被测代码自己的注册表，不是我编的。
 * - **consistency**：候选 = 该样例声明的 `expectedSubTypes ∪ toleratedSubTypes`。
 *   回答「实测命中的是不是我要求的那一个」⇒ 污染检测。
 *
 * 两趟都不能省：只有 coverage 会漏掉「命中了同规则的另一个子类型」（覆盖率达标但归因错位），
 * 只有 consistency 会漏掉「声明过的槽位压根没被走到」（91 个槽位只测到 40 个）。
 */
function attribute(findings, generated, ctx, spec) {
  const hashes = generated.built.hashes;
  const coverage = [];
  const unresolved = [];
  for (const finding of findings) {
    const rule = RULE_BY_ID.get(finding.ruleId);
    const candidates = rule === undefined ? [] : rule.subTypes;
    const recovered = recoverSubType(
      finding,
      hashes,
      ctx.scannerVersion,
      ctx.rulesetVersion,
      candidates,
    );
    if (recovered.ok) coverage.push(`${finding.ruleId}:${recovered.subType}`);
    else unresolved.push({ ruleId: finding.ruleId, reason: recovered.reason });
  }

  const expected = [...spec.expectation.expectedSubTypes];
  const tolerated = [...spec.expectation.toleratedSubTypes];
  const observedExpected = new Set();
  const observedTolerated = new Set();
  const unexpected = [];
  let primaryUnresolved = 0;
  if (spec.ruleId !== null) {
    const candidates = [...new Set([...expected, ...tolerated])];
    for (const finding of findings.filter((item) => item.ruleId === spec.ruleId)) {
      const recovered = recoverSubType(
        finding,
        hashes,
        ctx.scannerVersion,
        ctx.rulesetVersion,
        candidates,
      );
      if (!recovered.ok) {
        primaryUnresolved += 1;
        continue;
      }
      if (expected.includes(recovered.subType)) observedExpected.add(recovered.subType);
      else if (tolerated.includes(recovered.subType)) observedTolerated.add(recovered.subType);
      // 与下面安全样例那一支同形（`ruleId:subType`），这样 `unexpected` 一张表就能读，
      // 不必先知道这一行是不是主规则样例。
      else unexpected.push(`${spec.ruleId}:${recovered.subType}`);
    }
  } else if (findings.length > 0) {
    // 安全/边界样例的期望集是空的，所以**任何**命中都是意外命中。
    // 不记下来就等于让 FP 只以「多了一条规则」的粒度出现，丢掉了「是哪个子类型误触」
    // 这个归因信息 —— 而那正是修 FP 时唯一有用的信息。
    for (const entry of coverage) unexpected.push(entry);
  }
  const missingExpected = expected.filter((subType) => !observedExpected.has(subType));
  return {
    coverage: [...new Set(coverage)].sort(),
    unresolved,
    consistency: {
      expected,
      tolerated,
      observedExpected: [...observedExpected].sort(),
      observedTolerated: [...observedTolerated].sort(),
      unexpected: [...new Set(unexpected)].sort(),
      missingExpected,
      primaryUnresolved,
      ok: unexpected.length === 0 && primaryUnresolved === 0 && missingExpected.length === 0,
    },
  };
}

/**
 * 一件样例的**期望行**。只由 `spec` 得出，**不看任何实测结果**。
 *
 * 抽成函数的理由不是复用，是**可核对**：分片 runner 用它写报告，聚合 runner 用它
 * 从 `spec` 重算一遍再与报告里的 `expected` 逐字段比对。于是「把期望改成实测的样子」
 * （ZLQ-194 §16 点名禁止的那种自我洗白）在聚合阶段必然被抓到 ——
 * 因为期望的**来源**只有 spec，改报告不改 spec 会对不上，改 spec 则 `planHash`
 * 与 `packageHash` 都会变。
 */
export function expectedRowOf(spec) {
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

/**
 * 建包 + 扫描一件样例，返回分片报告的一行。
 *
 * 计时分成 `buildMs` 与 `scanMs`：§2.6 要的是扫描耗时（进 shard 预算），
 * 而建包耗时属于生成器，混在一起会让「最慢的一件」到底是慢在判定还是慢在造字节
 * 变成猜谜。`outcome.durationMs` 取 `scanMs`。
 *
 * 内存只有 `process.memoryUsage().rss` 这一个粗口径可取 —— 单进程顺序执行下它包含
 * 生成器、扫描器和 node 自身，**不是**「这一件样例的峰值占用」。报告里如实这么写。
 */
export async function scanOne(spec, ctx, options = {}) {
  const buildStart = process.hrtime.bigint();
  const generated = buildCase(spec, ctx.scannerVersion, ctx.rulesetVersion);
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;

  const scanStart = process.hrtime.bigint();
  const result = await scanPackage(generated.built.input, {
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
  const scanMs = Number(process.hrtime.bigint() - scanStart) / 1e6;

  const attribution = result.ok
    ? attribute(result.report.findings, generated, ctx, generated.spec)
    : { coverage: [], unresolved: [], consistency: null };

  const outcome = result.ok
    ? {
        ok: true,
        errorCode: null,
        status: result.report.status,
        rules: orderedRules(result.report.findings),
        blockedRules: orderedRules(
          result.report.findings.filter((finding) => finding.disposition === 'BLOCK'),
        ),
        confirmedRules: orderedRules(
          result.report.findings.filter((finding) => finding.disposition === 'CONFIRM_REQUIRED'),
        ),
        subTypes: attribution.coverage,
        findingCount: result.report.findings.length,
        durationMs: scanMs,
      }
    : {
        ok: false,
        errorCode: result.code,
        status: null,
        rules: [],
        blockedRules: [],
        confirmedRules: [],
        subTypes: [],
        findingCount: 0,
        durationMs: scanMs,
      };

  return {
    caseId: generated.spec.caseId,
    shard: ctx.shardOfCaseId.get(generated.spec.caseId),
    packageHash: generated.built.artifactHash,
    inputHash: result.ok ? result.report.inputHash : null,
    corpusVersion: ctx.versions.corpusVersion,
    scannerVersion: ctx.scannerVersion,
    rulesetVersion: ctx.rulesetVersion,
    annotationMode: ctx.versions.annotationMode,
    expected: expectedRowOf(generated.spec),
    outcome,
    buildMs: Math.round(buildMs * 1000) / 1000,
    rssBytes: process.memoryUsage().rss,
    attribution: result.ok
      ? { unresolved: attribution.unresolved, consistency: attribution.consistency }
      : null,
  };
}

/**
 * 阳性对照。**必须在跑全量之前过一次**（`subtypes.ts` 的文件头要求）。
 *
 * 少了它，一次上游 `FINDING_KEY_PREFIX` 改动会让全部 finding 的子类型反解返回 null，
 * 而 null 在覆盖率表里长得像「这个槽位没被测到」，不像「测量通道断了」——
 * 前者是语料缺口，后者是工装故障，两者的处置完全不同。
 */
export function assertAttributionChannel(ctx) {
  assertSubTypeChannelLive(ctx.scannerVersion, ctx.rulesetVersion);
}

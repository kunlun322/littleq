/**
 * 聚合作业（ZLQ-210；判据出处 ZLQ-156 §2.5 / §2.6 / §7.2 / §7.3）。
 *
 * ## 用法
 *
 * ```
 * node packages/work-contract/scripts/corpus-plan.mjs        # 1. 出计划（不扫）
 * node packages/work-contract/scripts/corpus-scan-shard.mjs --all   # 2. 16 片各自出离线报告
 * node packages/work-contract/scripts/corpus-aggregate.mjs   # 3. 核对 + 折叠成一份报告
 * ```
 *
 * 前置：`pnpm --filter @littleq/work-contract build`。
 *
 * ## 聚合**不重跑扫描**
 *
 * §2.6 的原话是「聚合作业检查 caseId 无缺失/重复、版本一致、计划清单 hash 一致后才算指标」。
 * 所以本作业读的是 16 份**已经写下来的**分片报告，不是自己再扫一遍：
 * 再扫一遍的话，「缺一片」永远发现不了 —— 缺的那片会被就地补算出来，
 * 而 §2.6 要求缺 shard 直接令 CI 失败、**不从分母移除**。
 *
 * 它**确实**重建每个样例包，但只为了核对 `packageHash`（§2.5「样例包 immutable」）。
 * 重建是纯函数（同 seed ⇒ 同字节），所以这一步不引入不确定性；
 * 它引入的是「生成器被改过」的可检测性。
 *
 * ## 期望由 spec 重算，与报告里的 `expected` 逐字段比对
 *
 * 这是 ZLQ-194 §16 那条禁令（不许「把期望改成实测的样子」）的**可执行形式**。
 * 期望的唯一来源是 `spec`；改了报告不改 spec ⇒ 这里对不上；
 * 改了 spec ⇒ `planHash` 与 `packageHash` 一起变，`verifyPinnedPlan` 先拦下。
 *
 * ## 报告不落源片段、不落时间戳
 *
 * §2.6「不附源片段」：每节只有计数、hash、规则名、子类型名。
 * 不写 `generatedAt`：报告要能被 `git diff` 逐字节比较，一个时钟读数会让
 * 「两次运行结果一样吗」这个问题永远无法回答（分片报告里已经有计时，那是不确定性来源，
 * 但它同时是 §2.6 明令要的数据；聚合报告不额外再添一个）。
 *
 * ## 退出码
 *
 * 门禁不达标 ⇒ **退出码 1**（§2.6「全部 shard 合并结果才可绿」）。
 * 报告在退出之前**已经写出**：一份不达标的报告正是要交的东西（§7.3
 * 「Stage1 第一版交报告；未通过不能派生『FPR 已 ≤2%』结论」）。
 * 当前语料确实不达标（B5 的假阴性，见 `defects` 一节），所以这个 runner 现在是红的 ——
 * 那不是工装坏了，是它在工作。
 */

import { existsSync } from 'node:fs';
import {
  ADMISSION_BLOCKING_GAP_IDS,
  B5_FORM_ACTION_GAP_ID,
  B5_FORM_ACTION_RULE_ID,
  CASE_MANIFEST_PATH,
  CORPUS_VERSION,
  DECLARED_GAPS,
  DECLARED_GAP_IDS,
  DEFAULT_BUDGET_LIMITS,
  REPORT_PATH,
  REPORT_SUMMARY_PATH,
  SCANNER_RESOURCE_LIMIT,
  SHARD_COUNT,
  assertAttributionChannel,
  assertPlanComplete,
  b5FormActionRepro,
  boundarySummary,
  budgetProvenance,
  buildCase,
  expectedRowOf,
  expectationDistribution,
  formatPercent,
  measureCorpus,
  orderedRules,
  readJsonl,
  resolveContext,
  scanPackage,
  shardReportPath,
  verifyPinnedPlan,
  versionMismatch,
  writeJsonl,
} from './lib.mjs';

const ctx = resolveContext();
assertAttributionChannel(ctx);
const { header: pinnedHeader, rows: pinnedPlan, plan } = verifyPinnedPlan(ctx);

// ---------------------------------------------------------------------------
// 1. 收齐 16 份分片报告（缺一片直接失败）
// ---------------------------------------------------------------------------

const missingShards = [];
const shardHeaders = [];
const caseRows = [];
for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
  const path = shardReportPath(shard);
  if (!existsSync(path)) {
    missingShards.push(shard);
    continue;
  }
  const rows = readJsonl(path);
  const header = rows[0];
  if (header === undefined || header.kind !== 'shard-header') {
    throw new Error(`${path} 的第一行不是 shard-header`);
  }
  if (header.shard !== shard) {
    throw new Error(`${path} 的 header 自称 shard ${String(header.shard)}，与文件名不符`);
  }
  const mismatch = versionMismatch(plan, header);
  if (mismatch.length > 0) {
    throw new Error(
      `shard ${String(shard).padStart(2, '0')} 的版本与计划不一致：${mismatch.join('; ')}\n` +
        '§2.6：聚合作业必须核对版本一致后才算指标。重跑分片，别就地改报告。',
    );
  }
  if (header.planHash !== plan.planHash) {
    throw new Error(
      `shard ${String(shard).padStart(2, '0')} 的 planHash ${String(header.planHash)} ` +
        `≠ 计划 ${plan.planHash}`,
    );
  }
  const cases = rows.slice(1);
  if (cases.length !== header.caseCount) {
    throw new Error(
      `shard ${String(shard).padStart(2, '0')} 的 header 说 ${String(header.caseCount)} 件，` +
        `文件里只有 ${String(cases.length)} 件（写入被截断？）`,
    );
  }
  for (const row of cases) {
    if (row.kind !== 'case') throw new Error(`${path} 里有一行 kind=${String(row.kind)}`);
    if (row.shard !== shard) {
      throw new Error(`${path} 里的 ${row.caseId} 自称属于 shard ${String(row.shard)}`);
    }
  }
  shardHeaders.push(header);
  caseRows.push(...cases);
}
if (missingShards.length > 0) {
  throw new Error(
    `缺分片报告：${missingShards.map((shard) => String(shard).padStart(2, '0')).join(', ')}\n` +
      '§2.6：缺 shard 直接令 CI 失败，不从分母移除。先跑 scripts/corpus-scan-shard.mjs --all。',
  );
}

// caseId 无缺失 / 无重复 / 无计划外
assertPlanComplete(
  plan,
  caseRows.map((row) => row.caseId),
);

// ---------------------------------------------------------------------------
// 2. 逐件核对：packageHash（三处同源）+ 期望可由 spec 重算
// ---------------------------------------------------------------------------

const pinnedHashByCaseId = new Map(pinnedPlan.map((row) => [row.caseId, row.packageHash]));
const manifestRows = readJsonl(CASE_MANIFEST_PATH);
const manifestHashByCaseId = new Map(manifestRows.map((row) => [row.caseId, row.packageHash]));
if (manifestRows.length !== plan.caseCount) {
  throw new Error(
    `案例清单有 ${String(manifestRows.length)} 行，计划有 ${String(plan.caseCount)} 件。` +
      '重跑 scripts/corpus-plan.mjs。',
  );
}

const problems = [];
const measured = [];
for (const row of caseRows) {
  const spec = ctx.specByCaseId.get(row.caseId);
  if (spec === undefined) throw new Error(`报告里的 caseId 不在样例表中：${row.caseId}`);
  const generated = buildCase(spec, ctx.scannerVersion, ctx.rulesetVersion);

  // 三个地方各存了一份 packageHash：计划、案例清单（§2.3 的 14 字段之一）、分片报告。
  // 三份必须与「现在重建出来的」逐字节相同 —— 少比一份就少一种能被发现的改法。
  const rebuilt = generated.built.artifactHash;
  if (rebuilt !== row.packageHash) {
    problems.push(`${row.caseId}：报告 ${row.packageHash} ≠ 重建 ${rebuilt}`);
  }
  if (pinnedHashByCaseId.get(row.caseId) !== row.packageHash) {
    problems.push(`${row.caseId}：计划里的 packageHash 与报告不符`);
  }
  if (manifestHashByCaseId.get(row.caseId) !== row.packageHash) {
    problems.push(`${row.caseId}：案例清单里的 packageHash 与报告不符`);
  }
  if (row.corpusVersion !== CORPUS_VERSION) {
    problems.push(`${row.caseId}：corpusVersion ${String(row.corpusVersion)} ≠ ${CORPUS_VERSION}`);
  }
  if (row.scannerVersion !== ctx.scannerVersion || row.rulesetVersion !== ctx.rulesetVersion) {
    problems.push(`${row.caseId}：行内版本三元组与当前代码不一致`);
  }
  if (row.outcome.ok && typeof row.inputHash !== 'string') {
    problems.push(`${row.caseId}：扫描成功却没有 inputHash`);
  }

  // 期望重算（反自我洗白，理由见文件头）
  const recomputedExpected = expectedRowOf(generated.spec);
  for (const key of Object.keys(recomputedExpected)) {
    const a = JSON.stringify(recomputedExpected[key]);
    const b = JSON.stringify(row.expected?.[key]);
    if (a !== b) {
      problems.push(`${row.caseId}.expected.${key}：spec 重算 ${a} vs 报告 ${b}`);
    }
  }

  measured.push({
    spec: generated.spec,
    shard: row.shard,
    packageHash: row.packageHash,
    outcome: row.outcome,
  });
}
if (problems.length > 0) {
  throw new Error(
    `逐件核对失败（${String(problems.length)} 项）：\n  ${problems.slice(0, 10).join('\n  ')}` +
      `${problems.length > 10 ? '\n  …' : ''}\n` +
      '§2.5 要求样例包 immutable、报告可复现。不许就地改报告让它对上。',
  );
}

// ---------------------------------------------------------------------------
// 3. 折叠成指标
// ---------------------------------------------------------------------------

const measurement = measureCorpus(measured, {
  corpusVersion: pinnedHeader.corpusVersion,
  scannerVersion: pinnedHeader.scannerVersion,
  rulesetVersion: pinnedHeader.rulesetVersion,
  rulesetFingerprintHash: pinnedHeader.rulesetFingerprintHash,
  annotationMode: pinnedHeader.annotationMode,
  shardCount: SHARD_COUNT,
  plannedCaseCount: plan.caseCount,
  plannedCaseIds: plan.cases.map((row) => row.caseId),
});
const boundary = boundarySummary(measured);
const expectations = expectationDistribution(measured);

// ---- 归因汇总：子类型反解的失败与不一致，逐件列出 ---------------------------
// 这张表是「载体归因」不vacuous 的证据：如果反解通道断了，`unresolved` 会爆量；
// 如果语料污染了（一件样例命中了它没声明的子类型），`unexpected` 会爆量。
const unresolvedRows = [];
const inconsistentRows = [];
for (const row of caseRows) {
  if (row.attribution === null) continue;
  if (row.attribution.unresolved.length > 0) {
    unresolvedRows.push({ caseId: row.caseId, unresolved: row.attribution.unresolved });
  }
  const consistency = row.attribution.consistency;
  if (consistency !== null && !consistency.ok) {
    inconsistentRows.push({
      caseId: row.caseId,
      // 主规则取自 spec（不是取自报告的 `expected.rules`）：这一列的用途是让人顺着
      // caseId 找到「本该命中哪个子类型」，来源必须是标注侧而不是实测侧。
      ruleId: ctx.specByCaseId.get(row.caseId)?.ruleId ?? null,
      unexpected: consistency.unexpected,
      missingExpected: consistency.missingExpected,
      primaryUnresolved: consistency.primaryUnresolved,
    });
  }
}

// ---- §2.4 的置信分层：设计量 vs 实测量，逐规则对账 -------------------------
// §2.4 只给了三处 CONFIRM_REQUIRED 的设计量：B12 的 60 件全部确认，
// B8/B13 各 10 件低置信确认（其余 50 件高置信硬拦），别的规则 0。
// 实测的期望 LOW 比这多，多出来的必须**逐规则点名到家族**，否则
// 「116 vs 80」只是一个看不出来源的差值。
const DESIGN_CONFIRM = { B8: 10, B12: 60, B13: 10 };
const DESIGN_HARD_BLOCK = { B8: 50, B12: 0, B13: 50 };
const confirmDelta = [];
for (const row of expectations.perRule) {
  const design = DESIGN_CONFIRM[row.ruleId] ?? 0;
  const families = new Map();
  for (const item of measured) {
    if (item.spec.kind !== 'violation' || item.spec.ruleId !== row.ruleId) continue;
    if (item.spec.expectation.expectedConfidence !== 'LOW') continue;
    const key = item.spec.familyId;
    families.set(key, (families.get(key) ?? 0) + 1);
  }
  confirmDelta.push({
    ruleId: row.ruleId,
    designHardBlock: DESIGN_HARD_BLOCK[row.ruleId] ?? 60,
    designConfirm: design,
    measuredHardBlock: row.hardBlock,
    measuredConfirm: row.confirm,
    deltaConfirm: row.confirm - design,
    lowConfidenceFamilies: [...families.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([familyId, count]) => ({ familyId, count })),
  });
}

// ---- 缺陷复现：四个包只差 `<form>` 开标签 ---------------------------------
const reproVariants = [];
for (const entry of b5FormActionRepro(ctx.scannerVersion, ctx.rulesetVersion)) {
  const result = await scanPackage(entry.built.input, {});
  reproVariants.push({
    label: entry.variant.label,
    openTag: entry.variant.openTag,
    note: entry.variant.note,
    packageHash: entry.built.artifactHash,
    documentedDisposition: entry.variant.documentedDisposition,
    scanOk: result.ok,
    errorCode: result.ok ? null : result.code,
    measuredStatus: result.ok ? result.report.status : null,
    rules: result.ok ? orderedRules(result.report.findings) : [],
    blockedRules: result.ok
      ? orderedRules(result.report.findings.filter((finding) => finding.disposition === 'BLOCK'))
      : [],
    findingCount: result.ok ? result.report.findings.length : 0,
    agreesWithDocumentation: result.ok && result.report.status === 'BLOCK',
  });
}
const b5Measurement = measurement.rules.find((row) => row.ruleId === B5_FORM_ACTION_RULE_ID);
const defectReproduced = reproVariants.some((row) => !row.agreesWithDocumentation);
const controlHeld = reproVariants[0]?.agreesWithDocumentation === true;

// ---- 预算与错误码：只报可观测的 -------------------------------------------
const errorCodes = {};
for (const row of caseRows) {
  if (row.outcome.ok) continue;
  const code = String(row.outcome.errorCode);
  errorCodes[code] = (errorCodes[code] ?? 0) + 1;
}
const resourceLimitHits = errorCodes[SCANNER_RESOURCE_LIMIT] ?? 0;

// ---------------------------------------------------------------------------
// 4. 分节写报告
// ---------------------------------------------------------------------------

const sections = [
  {
    section: 'header',
    schema: 'littleq-corpus-report-v1',
    corpusVersion: pinnedHeader.corpusVersion,
    scannerVersion: pinnedHeader.scannerVersion,
    rulesetVersion: pinnedHeader.rulesetVersion,
    rulesetFingerprintHash: pinnedHeader.rulesetFingerprintHash,
    annotationMode: pinnedHeader.annotationMode,
    admissionMet: pinnedHeader.admissionMet,
    admissionTargets: pinnedHeader.admissionTargets,
    reportStatus: pinnedHeader.reportStatus,
    shardCount: SHARD_COUNT,
    planHash: plan.planHash,
    shardPlanHash: plan.shardPlanHash,
    caseCount: caseRows.length,
    scannerSourceFileCount: pinnedHeader.scannerSourceFileCount,
    // 三个版本号都由内容算出（`versions.ts`），所以这一行就是 §2.5「pin 版本/hash」的落点。
    // 不写 generatedAt：见文件头「报告不落时间戳」。
    reproducibility:
      '确定性部分（caseId/familyId/split/shard/packageHash/期望/实测规则与子类型）逐字节可复现；' +
      '计时与 RSS 不可复现，口径见各节的 caveat。',
  },
  { section: 'targets', ...measurement.targets },
  { section: 'execution', ...measurement.execution },
  { section: 'composition', ...measurement.composition },
  { section: 'verdict', ...measurement.verdict },
  { section: 'rules', rules: measurement.rules },
  { section: 'recallGate', ...measurement.recallGate },
  { section: 'declaredRuleCoverage', ...measurement.declaredRuleCoverage },
  { section: 'b12', ...measurement.b12 },
  { section: 'lowConfidenceConfirm', ...measurement.lowConfidenceConfirm },
  { section: 'safeConfirmRate', ...measurement.safeConfirmRate },
  { section: 'falseBlockRate', ...measurement.falseBlockRate },
  { section: 'cells', cells: measurement.cells },
  { section: 'subTypeCoverage', ...measurement.subTypeCoverage },
  { section: 'techTags', ...measurement.techTags },
  { section: 'quotaDeltas', quotaDeltas: measurement.quotaDeltas },
  { section: 'shards', shards: measurement.shards, shardHeaders },
  { section: 'shardBudget', ...measurement.shardBudget },
  { section: 'splits', ...measurement.splits },
  { section: 'boundary', ...boundary },
  { section: 'expectations', ...expectations, designDeltaPerRule: confirmDelta },
  {
    section: 'attribution',
    // 反解通道的阳性对照在 runner 启动时已经跑过（`assertAttributionChannel`）。
    // 这里给的是**全量之后**的账：0 未反解 + 0 不一致，才说明 X/91 那个覆盖率不是
    // 在一条断掉的通道上数出来的。
    channelAsserted: true,
    unresolvedCaseCount: unresolvedRows.length,
    unresolved: unresolvedRows,
    inconsistentCaseCount: inconsistentRows.length,
    inconsistent: inconsistentRows,
  },
  {
    section: 'defects',
    // §7.3 + 工单：语料暴露出扫描器真缺陷 ⇒ 停下点名并附最小复现，不顺手改判定逻辑。
    items: [
      {
        gapId: B5_FORM_ACTION_GAP_ID,
        ruleId: B5_FORM_ACTION_RULE_ID,
        title: 'B5 对「`action` 存在但不逃出包外」的 `<form>` 零命中（假阴性）',
        documentedDisposition: 'BLOCK',
        measuredAffectedCaseIds: b5Measurement === undefined ? [] : b5Measurement.missedCaseIds,
        measuredAffectedCount: b5Measurement === undefined ? 0 : b5Measurement.missedCaseIds.length,
        measuredRecall: b5Measurement === undefined ? null : b5Measurement.recall,
        gateImpact:
          '§2.6「全部预期硬拦样例 100% 检出预期规则」不达标；' +
          'recallGate.pass=false，overall.pass=false。',
        reproducible: defectReproduced,
        controlHeld,
        repro: {
          note: '四个包只差 <form> 开标签，其余文件/元数据/封面/createdAt/workId 派生规则全同。',
          variants: reproVariants,
        },
        notFixedBecause:
          '工单明令「不重写扫描器判定算法…不要顺手改判定逻辑」；' +
          '也**不许**反过来把期望改成 PASS（ZLQ-194 §16）。',
        fillBy:
          '一次独立的扫描器返工单：让 action 存在但不逃出包外的 <form> 走 form-element 分支。',
      },
    ],
  },
  {
    section: 'resourceLimits',
    caseCount: caseRows.length,
    failedCases: measurement.execution.failed,
    errorCodes,
    resourceLimitHits,
    limits: DEFAULT_BUDGET_LIMITS,
    provenance: budgetProvenance,
    changedByThisTicket: [],
    note:
      '本单没有改任何预算常量。`decompressedBytes`/`readBytes`/`fileCount` 的 provenance 是 ' +
      '`contract`（ZLQ-153 §8.1 冻结值），改它等于改判定；其余五个是 `implementation`，' +
      '按 ZLQ-156 §6.3 应由 parser 压测制定 —— 见 `secondLevelBudget` 一节。',
  },
  {
    section: 'secondLevelBudget',
    // 这一节写的是「测不到」这件事本身，不是用量数字。理由见 gaps.ts 的同名条目：
    // Budget.counters 只在一次 scanPackage 调用内部活着，ScanReport 上没有计数字段。
    observableThroughScanPackage: false,
    reason:
      '`Budget.counters`（含 `secondLevelDecodes` / `secondLevelDecodeBytes`）是扫描运行的内部状态，' +
      '`ScanReport` 上没有任何计数字段，因此从公开扫描面不可观测。' +
      '让它可观测需要在 `ScanReport` 上加字段，那是 D3a 判定面的一次契约扩展，本单不动。',
    secondLevelDecodes: {
      limit: DEFAULT_BUDGET_LIMITS.secondLevelDecodes,
      provenance: budgetProvenance.secondLevelDecodes,
      measuredUsage: null,
    },
    secondLevelDecodeBytes: {
      limit: DEFAULT_BUDGET_LIMITS.secondLevelDecodeBytes,
      provenance: budgetProvenance.secondLevelDecodeBytes,
      measuredUsage: null,
    },
    resourceLimitHits,
    interpretation:
      `${String(resourceLimitHits)} 件触发 ${SCANNER_RESOURCE_LIMIT}。` +
      '0 只证明「这批语料没触到任何预算上限」，**不**证明「余量有多少」—— ' +
      '语料里没有压缩炸弹与 4 MiB 级样例（见 gaps 的 `boundary-set-partial`）。',
    gapId: 'second-level-budget-not-replaced',
  },
  {
    section: 'extraGates',
    gates: measurement.extraGates,
  },
  {
    section: 'overall',
    ...measurement.overall,
    // 不可谈判项的三条逐条落账，避免「overall.pass=false」变成一个看不出严重性的布尔。
    nonNegotiable: [
      {
        id: 'tp-zero-is-not-a-pass',
        statement: 'TP=0 不算通过，且不得报告 precision=100%',
        observed: measurement.verdict.rules.map((row) => ({
          ruleId: row.ruleId,
          hardHits: row.hardHits,
          trueHardBlocks: row.trueHardBlocks,
          precision: row.precision,
          precisionState: row.precisionState,
        })),
        violatedBy: measurement.verdict.rules.filter(
          (row) => row.precision === 1 && row.trueHardBlocks === 0,
        ).length,
      },
      {
        id: 'b12-hard-block-is-failure',
        statement: 'B12 上任何硬阻断 = 直接失败',
        observed: { hardBlocks: measurement.b12.hardBlocks, pass: measurement.b12.pass },
      },
      {
        id: 'design-quantities-are-not-a-measured-corpus',
        statement: '设计里的量不得替代实测语料',
        observed: {
          measuredCases: caseRows.length,
          designSafeTotal: measurement.targets.designSafeTotal,
          designViolationTotal: measurement.targets.designViolationTotal,
          quotaDeltas: measurement.quotaDeltas.length,
        },
      },
    ],
  },
  {
    section: 'gaps',
    // §7.3 的落点：未通过的部分逐条声明，并且**在数据里**，不是在散文里 ——
    // 完整性测试会核对报告的这一节包含 `DECLARED_GAP_IDS` 的每一个 id，
    // 少一条就红。这样「声明缺口」这件事本身不可被悄悄省略。
    admissionMet: pinnedHeader.admissionMet,
    reportStatus: pinnedHeader.reportStatus,
    count: DECLARED_GAPS.length,
    blockingAdmission: ADMISSION_BLOCKING_GAP_IDS,
    ids: DECLARED_GAP_IDS,
    gaps: DECLARED_GAPS,
  },
];

// ---------------------------------------------------------------------------
// 5. 扁平摘要（给 CI 与人各一行）
// ---------------------------------------------------------------------------

const SUMMARY_SPEC = 'ZLQ-156 §2.6 / §8.6';
const summary = [];
function addSummary(metric, value, target, pass, spec = SUMMARY_SPEC) {
  summary.push({ metric, value, target, pass, spec });
}

addSummary(
  'false_block_rate.total',
  formatPercent(measurement.falseBlockRate.total.rate),
  `≤${formatPercent(measurement.falseBlockRate.total.target)}`,
  measurement.falseBlockRate.total.pass,
);
addSummary(
  'false_block_rate.holdout',
  formatPercent(measurement.falseBlockRate.holdout.rate),
  `≤${formatPercent(measurement.falseBlockRate.holdout.target)}（设计上限 ${String(measurement.falseBlockRate.holdout.designCeiling)}/120 折算 ${measurement.falseBlockRate.holdout.scaledCeiling.toFixed(2)} 件）`,
  measurement.falseBlockRate.holdout.pass,
);
addSummary(
  'false_block_rate.b_rule_only',
  formatPercent(measurement.falseBlockRate.bRuleOnly.rate),
  '单列，不设判据',
  null,
);
addSummary(
  'safe_confirm_rate',
  formatPercent(measurement.safeConfirmRate.rate),
  `≤${formatPercent(measurement.safeConfirmRate.target)}`,
  measurement.safeConfirmRate.pass,
);
addSummary(
  'recall.all_expected_hard_blocks',
  `${String(measurement.recallGate.detectedPairs)}/${String(measurement.recallGate.expectedHardBlockPairs)}`,
  '100%',
  measurement.recallGate.pass,
);
addSummary(
  'declared_rule_coverage',
  `${String(measurement.declaredRuleCoverage.fullyCovered)}/${String(measurement.declaredRuleCoverage.violationCases)}`,
  '100%（§2.4「实际命中集合必须包含人工要求规则」）',
  measurement.declaredRuleCoverage.pass,
);
addSummary(
  'b12.hard_blocks',
  String(measurement.b12.hardBlocks),
  '0（不可谈判项 2）',
  measurement.b12.pass,
);
addSummary(
  'low_confidence_confirm',
  `${String(measurement.lowConfidenceConfirm.confirmedAsExpected)}/${String(measurement.lowConfidenceConfirm.expectedConfirmSamples)}`,
  '100%（B12 确认集 + B8/B13 低置信集）',
  measurement.lowConfidenceConfirm.pass,
);
for (const row of measurement.verdict.rules) {
  addSummary(
    `precision.${row.ruleId}`,
    row.precision === null ? 'n/a' : formatPercent(row.precision),
    row.precisionTargetApplies ? `≥${formatPercent(0.98)}` : '不适用（冻结上限 CONFIRM_REQUIRED）',
    row.meetsPrecisionTarget,
    `${SUMMARY_SPEC}；hardHits ${String(row.hardHits)} / TP ${String(row.trueHardBlocks)} / FP ${String(row.falseHardBlocks)} / ${row.precisionState}`,
  );
}
for (const row of measurement.rules) {
  addSummary(
    `recall.${row.ruleId}`,
    row.recall === null ? 'n/a' : formatPercent(row.recall),
    row.expectedHardBlock > 0 ? '100%' : '不适用（该规则无预期硬拦）',
    row.expectedHardBlock > 0 ? row.missedHardBlocks === 0 : null,
    `${SUMMARY_SPEC}；FN ${String(row.missedHardBlocks)}`,
  );
}
addSummary(
  'execution.unaccounted',
  String(measurement.execution.unaccounted),
  '0（§2.6「不从分母移除」）',
  measurement.execution.unaccounted === 0,
);
addSummary(
  'execution.failed_cases',
  String(measurement.execution.failed),
  '0（超时/解析失败/预算耗尽都算失败）',
  measurement.execution.failed === 0,
);
addSummary(
  'subtype_coverage',
  `${String(measurement.subTypeCoverage.measuredTotal)}/${String(measurement.subTypeCoverage.declaredTotal)}`,
  '规格未给下限；未测槽位逐条列出',
  null,
  'ZLQ-156 §2.4',
);
addSummary(
  'split.family_leakage',
  String(measurement.splits.familyLeakage.length),
  '0（dev/holdout 按家族切分）',
  measurement.splits.leakFree,
  'ZLQ-156 §2.2 / §2.5',
);
addSummary(
  'shard.slowest_local_ms',
  measurement.shardBudget.slowestShardMs.toFixed(0),
  `热 ≤${String(measurement.shardBudget.hotTargetMs)} / 冷 ≤${String(measurement.shardBudget.coldTargetMs)}（**CI 口径未实测**）`,
  measurement.shardBudget.localSlowestWithinHotTarget,
  'ZLQ-156 §2.6',
);
addSummary(
  'corpus.total_cases',
  String(measurement.composition.total),
  '设计 600 安全 + 780 违规（§2.1 首版目标）',
  null,
  'ZLQ-156 §2.1 / §2.2',
);
addSummary(
  'corpus.safe_cases',
  String(measurement.composition.safe),
  `设计 ${String(measurement.targets.designSafeTotal)}`,
  null,
  'ZLQ-156 §2.2',
);
addSummary(
  'corpus.violation_cases',
  String(measurement.composition.violation),
  `设计 ${String(measurement.targets.designViolationTotal)}`,
  measurement.composition.violation === measurement.targets.designViolationTotal,
  'ZLQ-156 §2.4',
);
addSummary(
  'boundary.not_pass',
  String(boundary.notPassCaseIds.length),
  '0（边界样例预期 PASS；高于冻结值的不进安全集）',
  boundary.notPassCaseIds.length === 0,
  'ZLQ-156 §2.2',
);
for (const gate of measurement.extraGates) {
  addSummary(
    `gate.${gate.name}`,
    gate.pass ? 'pass' : 'fail',
    gate.detail,
    gate.pass,
    SUMMARY_SPEC,
  );
}
addSummary(
  'annotation.admission_met',
  String(pinnedHeader.admissionMet),
  `一致率 ≥${formatPercent(pinnedHeader.admissionTargets.rawAgreement, 0)} 且 κ ≥${String(pinnedHeader.admissionTargets.cohenKappaOnHardBlock)}（双人盲标）`,
  false,
  'ZLQ-156 §2.3.4 / §2.3.5；单人非盲 ⇒ 结构性不达标',
);
addSummary(
  'defects.b5_form_action_reproduced',
  String(defectReproduced),
  '复现成立 ⇒ 必须点名，不许改判定、不许改期望',
  null,
  'ZLQ-156 §7.3；工单「返工须停下点名并附最小复现」',
);
addSummary(
  'gaps.declared',
  String(DECLARED_GAPS.length),
  `其中 ${String(ADMISSION_BLOCKING_GAP_IDS.length)} 条阻断 1.0.0 准入`,
  null,
  'ZLQ-156 §2.5 / §7.3',
);
addSummary(
  'overall.pass',
  String(measurement.overall.pass),
  '全部门禁 + §8.6 判读都达标',
  measurement.overall.pass,
  SUMMARY_SPEC,
);

// ---------------------------------------------------------------------------
// 6. 落盘 + 打印
// ---------------------------------------------------------------------------

const writtenReport = writeJsonl(REPORT_PATH, sections);
const writtenSummary = writeJsonl(REPORT_SUMMARY_PATH, summary);

const pct = (value) => formatPercent(value);
process.stdout.write(
  `语料报告  corpus ${pinnedHeader.corpusVersion} / scanner ${pinnedHeader.scannerVersion}` +
    ` / ruleset ${pinnedHeader.rulesetVersion}\n` +
    `          planHash ${plan.planHash}\n` +
    `          标注模式 ${pinnedHeader.annotationMode}（单人非盲）  准入达成 ` +
    `${String(pinnedHeader.admissionMet)}  报告状态 ${pinnedHeader.reportStatus}\n\n`,
);
process.stdout.write(
  `件数      ${String(measurement.composition.total)}（安全 ${String(measurement.composition.safe)}` +
    ` / 违规 ${String(measurement.composition.violation)} / 边界 ${String(measurement.composition.boundary)}）` +
    `  dev ${String(measurement.composition.dev)} / holdout ${String(measurement.composition.holdout)}` +
    `  家族 ${String(measurement.composition.families)}\n`,
);
process.stdout.write(
  `执行      计划 ${String(measurement.execution.planned)} / 报告 ${String(measurement.execution.reported)}` +
    ` / 失败 ${String(measurement.execution.failed)} / 缺 ${String(measurement.execution.missing)}` +
    ` / 未交代 ${String(measurement.execution.unaccounted)}\n`,
);
process.stdout.write(
  `误拦率    总 ${String(measurement.falseBlockRate.total.safeHardBlocked)}/` +
    `${String(measurement.falseBlockRate.total.safeSamples)} = ` +
    `${pct(measurement.falseBlockRate.total.rate)}` +
    `（判据 ≤${pct(measurement.falseBlockRate.total.target)}，Wilson 95% 上界 ` +
    `${pct(measurement.falseBlockRate.total.wilson.upper)}）` +
    `  holdout ${String(measurement.falseBlockRate.holdout.safeHardBlocked)}/` +
    `${String(measurement.falseBlockRate.holdout.safeSamples)} = ` +
    `${pct(measurement.falseBlockRate.holdout.rate)}\n`,
);
process.stdout.write(
  `召回      ${String(measurement.recallGate.detectedPairs)}/` +
    `${String(measurement.recallGate.expectedHardBlockPairs)} 预期硬拦对检出` +
    `（漏 ${String(measurement.recallGate.missedPairs)}）  ` +
    `声明规则覆盖 ${String(measurement.declaredRuleCoverage.fullyCovered)}/` +
    `${String(measurement.declaredRuleCoverage.violationCases)}\n`,
);
process.stdout.write(
  `安全确认率 ${pct(measurement.safeConfirmRate.rate)}（目标 ≤${pct(measurement.safeConfirmRate.target)}）` +
    `  B12 硬拦 ${String(measurement.b12.hardBlocks)}` +
    `  低置信确认 ${String(measurement.lowConfidenceConfirm.confirmedAsExpected)}/` +
    `${String(measurement.lowConfidenceConfirm.expectedConfirmSamples)}\n`,
);
process.stdout.write(
  `子类型覆盖 ${String(measurement.subTypeCoverage.measuredTotal)}/` +
    `${String(measurement.subTypeCoverage.declaredTotal)}` +
    `  归因未反解 ${String(unresolvedRows.length)} 件 / 不一致 ${String(inconsistentRows.length)} 件\n`,
);
process.stdout.write(
  `分片      ${String(SHARD_COUNT)} 片，最慢 shard ${String(measurement.shardBudget.slowestShard)} ` +
    `${measurement.shardBudget.slowestShardMs.toFixed(0)} ms（本地口径，**不是** CI 实测）\n`,
);
process.stdout.write(
  `precision ${measurement.verdict.rules
    .map(
      (row) => `${row.ruleId} ${row.precision === null ? row.precisionState : pct(row.precision)}`,
    )
    .join('  ')}\n`,
);

if (measurement.overall.failures.length > 0) {
  process.stdout.write(`\n不达标 ${String(measurement.overall.failures.length)} 项：\n`);
  for (const failure of measurement.overall.failures) {
    process.stdout.write(`  ✗ ${failure}\n`);
  }
}
if (measurement.verdict.shortfalls.length > 0) {
  process.stdout.write(`\n§8.6 判读缺口 ${String(measurement.verdict.shortfalls.length)} 项：\n`);
  for (const shortfall of measurement.verdict.shortfalls) {
    process.stdout.write(
      `  ✗ ${shortfall.kind}${shortfall.ruleId === null ? '' : ` (${shortfall.ruleId})`}：${shortfall.detail}\n`,
    );
  }
}
if (defectReproduced) {
  process.stdout.write(
    `\n已复现的扫描器分歧（**不修**，点名返工）：\n` +
      reproVariants
        .map(
          (row) =>
            `  ${row.agreesWithDocumentation ? '·' : '✗'} ${row.label.padEnd(24)} ` +
            `${String(row.measuredStatus).padEnd(16)} 命中 ${row.rules.join(',') || '（无）'}`,
        )
        .join('\n') +
      `\n  对照组 ${String(controlHeld ? '成立' : '**不成立** —— 复现本身没接通，先查这个')}\n`,
  );
}
process.stdout.write(
  `\n声明缺口 ${String(DECLARED_GAPS.length)} 条（其中 ${String(ADMISSION_BLOCKING_GAP_IDS.length)} 条阻断 1.0.0 准入）：` +
    `${DECLARED_GAP_IDS.join(', ')}\n`,
);
process.stdout.write(
  `\n→ ${writtenReport.path} (${String(writtenReport.lines)} 节, ${String(writtenReport.bytes)} B)\n` +
    `→ ${writtenSummary.path} (${String(writtenSummary.lines)} 行, ${String(writtenSummary.bytes)} B)\n`,
);
process.stdout.write(
  `\n总判定：${measurement.overall.pass ? 'PASS' : 'FAIL'}` +
    `（报告状态 ${pinnedHeader.reportStatus}，标注模式 ${pinnedHeader.annotationMode}，` +
    `**不得**声称 §2.3.4 的一致率/κ 准入已达成）\n`,
);

process.exitCode = measurement.overall.pass ? 0 : 1;

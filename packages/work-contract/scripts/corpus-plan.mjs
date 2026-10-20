/**
 * 计划 + 标注清单生成器（ZLQ-156 §2.3.1 / §2.5 / §2.6）。
 *
 * ## 这个 runner **不扫描**，而且必须不扫描
 *
 * §2.3.1 的要求是「策展人先写 case manifest，并**隐藏扫描器输出**以防锚定」。
 * 把它做成一条可执行的性质，而不是一句承诺：本文件从头到尾不 import `scanPackage`、
 * 不调用 `buildCase` 之外的任何判定面。标注（`expectedByRule`）全部来自
 * `manifest.ts#expectedByRuleOf(spec)`，也就是**规则注册表 + 冻结处置上限 + 样例声明**，
 * 与实测无关。
 *
 * 这条性质由 `test/corpus-integrity.test.ts` 钉住，所以「先标后测」不靠自觉。那道守卫读的是
 * 这份源码的**调用点与 import 图**：三个判定面入口（`scanPackage` / `scanOne` /
 * `measureCorpus`）的调用点数为零、`…/scan/…` 形式的 import 说明符数为零、import 说明符
 * 只有 `./lib.mjs` 一个且其 12 个具名逐一钉住。
 *
 * **它刻意不断言裸词零命中**：裸词版本会被上面这段解释自己的注释绊红（本文件确实在注释里
 * 提到了这三个名字），门读到的就成了注释而非代码。写调用点计数时也别把名字紧跟左括号写进
 * 注释里 —— 那同样会被计数正则命中。
 *
 * ## 产出
 *
 * - `corpus/plan.jsonl`：逐件计划行（caseId / familyId / split / shard / kind / ruleId / packageHash）。
 *   `packageHash` 不在 `PlanCaseRow` 的字段里 —— 它来自建包，而 `planManifest` 只接受
 *   `PlanCaseRow`。所以这里写的是**两份**：`plan-manifest.jsonl`（进 `planHash` 的那一份，
 *   字段严格等于规格）与 `plan.jsonl`（聚合与分片实际读的索引，多带 `packageHash`）。
 *   分开写而不是往 `PlanCaseRow` 里塞字段，理由见 `manifest.ts:225` 的注释：
 *   「manifest 符合规格」这件事只有在字段一个不多时才可核对。
 * - `corpus/case-manifest.jsonl`：§2.3 的 14 个字段 × 全量样例。
 */

import {
  CASE_MANIFEST_PATH,
  PLAN_MANIFEST_PATH,
  PLAN_PATH,
  assertAttributionChannel,
  buildCase,
  caseManifestEntry,
  CORPUS_VERSION,
  planManifestOf,
  PRODUCED_SOURCE_KIND,
  PRODUCED_SOURCE_LICENSE,
  resolveContext,
  writeJsonl,
} from './lib.mjs';

const ctx = resolveContext();
// 阳性对照先跑：反解通道断了的话，后面 1026 件会产出一片「归因不到」的假缺口。
assertAttributionChannel(ctx);

const plan = planManifestOf(ctx);

// 建包只为拿 `artifactHash` 与 enrich 过的 tags。**不扫描。**
const startedAt = process.hrtime.bigint();
const caseRows = [];
const planRows = [];
const planRowByCaseId = new Map(plan.cases.map((row) => [row.caseId, row]));
for (const spec of ctx.specs) {
  const generated = buildCase(spec, ctx.scannerVersion, ctx.rulesetVersion);
  const entry = caseManifestEntry(generated.spec, generated.built, {
    corpusVersion: CORPUS_VERSION,
    sourceKind: PRODUCED_SOURCE_KIND,
    sourceLicense: PRODUCED_SOURCE_LICENSE,
  });
  caseRows.push(entry);
  const planned = planRowByCaseId.get(entry.caseId);
  if (planned === undefined) throw new Error(`计划清单里没有这件样例：${entry.caseId}`);
  planRows.push({ ...planned, packageHash: entry.packageHash });
}
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

const planManifestRow = {
  schema: plan.schema,
  corpusVersion: plan.corpusVersion,
  scannerVersion: plan.scannerVersion,
  rulesetVersion: plan.rulesetVersion,
  rulesetFingerprintHash: plan.rulesetFingerprintHash,
  annotationMode: plan.annotationMode,
  admissionMet: plan.admissionMet,
  admissionTargets: plan.admissionTargets,
  reportStatus: plan.reportStatus,
  shardCount: plan.shardCount,
  shardPlanHash: plan.shardPlanHash,
  caseCount: plan.caseCount,
  planHash: plan.planHash,
  scannerSourceFileCount: ctx.scannerManifest.length,
};

const written = [
  writeJsonl(PLAN_MANIFEST_PATH, [planManifestRow]),
  writeJsonl(PLAN_PATH, planRows),
  writeJsonl(CASE_MANIFEST_PATH, caseRows),
];

const balance = ctx.assignment.balance;
process.stdout.write(
  [
    `corpusVersion   ${plan.corpusVersion}`,
    `scannerVersion  ${plan.scannerVersion}（${ctx.scannerManifest.length} 个 src/scan/**.ts）`,
    `rulesetVersion  ${plan.rulesetVersion}`,
    `rulesetFingerprint ${plan.rulesetFingerprintHash}`,
    `annotationMode  ${plan.annotationMode}   admissionMet ${String(plan.admissionMet)}   reportStatus ${plan.reportStatus}`,
    `caseCount       ${String(plan.caseCount)}`,
    `shardPlanHash   ${plan.shardPlanHash}`,
    `planHash        ${plan.planHash}`,
    `shard 均衡      min ${String(balance.caseMin)} / max ${String(balance.caseMax)} / mean ${balance.caseMean.toFixed(2)}` +
      ` / spread ${String(balance.caseSpread)} / imbalance ${balance.caseImbalanceRatio.toFixed(4)}` +
      ` / families ${String(balance.familyMin)}..${String(balance.familyMax)}`,
    `建包耗时        ${elapsedMs.toFixed(0)} ms（${(elapsedMs / plan.caseCount).toFixed(2)} ms/件，不含扫描）`,
    ...written.map(
      (item) => `写出            ${item.path}  ${String(item.lines)} 行  ${String(item.bytes)} B`,
    ),
    '',
  ].join('\n'),
);

/**
 * 单个 shard 的离线扫描作业（ZLQ-156 §2.6「每个 shard 输出离线 JSON 报告」）。
 *
 * ## 用法
 *
 * ```
 * node packages/work-contract/scripts/corpus-scan-shard.mjs --shard 0
 * node packages/work-contract/scripts/corpus-scan-shard.mjs --all
 * ```
 *
 * 前置：`pnpm --filter @littleq/work-contract build`，以及 `corpus-plan.mjs` 已经写出计划。
 *
 * ## 三条不可让的性质
 *
 * 1. **计划是输入，不是产出。** 本作业从 `corpus/plan.jsonl` 读它要跑哪些 caseId，
 *    而不是自己重算一遍再跑。重算的话，「分片计划」与「分片执行」就变成同一份代码的
 *    两次调用，漏一片永远看不出来。§2.6 的「缺 shard ⇒ CI 失败」只有在计划与执行
 *    是两份独立数据时才成立。
 * 2. **`packageHash` 逐件核对。** 计划里钉住的 `packageHash` 与本次建包算出的必须逐字节相同，
 *    否则说明生成器不确定性或计划已过期 —— 两种情况都不能继续（§2.5「样例包 immutable」）。
 * 3. **顺序执行，并发度 1，且这是声明过的。** §2.6 说「每 shard 顺序有界并发」；
 *    并发度 1 是它的下界，满足要求。不并发的理由是实测单件约 1.5 ms，
 *    一整片 60~70 件也就 0.1 s 量级 —— 在这个尺度上引入并发只会让
 *    「最慢一件」的计时和 rss 读数变成噪声，换不到任何墙钟收益。
 *
 * ## 报告里没有源片段
 *
 * §2.6 明令「不附源片段」。每行只有 caseId / packageHash / 期望 / 实测规则与子类型名 /
 * 耗时 / 版本。子类型名出自规则注册表，是判定面的公开标识符；载荷文本一个字节都不写。
 */

import {
  SHARD_COUNT,
  assertAttributionChannel,
  resolveContext,
  scanOne,
  shardReportPath,
  verifyPinnedPlan,
  writeJsonl,
} from './lib.mjs';

function parseArgs(argv) {
  let shard = null;
  let all = false;
  let budgetMs;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--shard') {
      const raw = argv[(index += 1)];
      shard = Number.parseInt(String(raw), 10);
      if (!Number.isInteger(shard) || shard < 0 || shard >= SHARD_COUNT) {
        throw new Error(`--shard 必须是 0..${SHARD_COUNT - 1} 的整数，收到 ${String(raw)}`);
      }
    } else if (flag === '--all') {
      all = true;
    } else if (flag === '--budget-ms') {
      budgetMs = Number.parseInt(String(argv[(index += 1)]), 10);
    } else {
      throw new Error(`不认识的参数：${String(flag)}（可用：--shard N / --all / --budget-ms N）`);
    }
  }
  if (all === (shard !== null)) {
    throw new Error('必须且只能给一个：--shard N 或 --all');
  }
  return {
    shards: all ? Array.from({ length: SHARD_COUNT }, (_, index) => index) : [shard],
    budgetMs,
  };
}

const { shards, budgetMs } = parseArgs(process.argv.slice(2));
const ctx = resolveContext();
assertAttributionChannel(ctx);

// ---- 计划核对：钉住的 planHash 必须与当前代码重算的一致 ----------------------
// 与聚合 runner 共用 `verifyPinnedPlan`（理由见 lib.mjs 里那份文档）：两处各写一遍，
// 迟早会写成宽严不同的两个版本。
const { rows: pinnedPlan, plan: recomputed } = verifyPinnedPlan(ctx);
const pinnedHashByCaseId = new Map(pinnedPlan.map((row) => [row.caseId, row.packageHash]));
process.stdout.write(
  `计划核对通过  planHash ${recomputed.planHash}\n` +
    `              scanner ${recomputed.scannerVersion} / ruleset ${recomputed.rulesetVersion}\n`,
);

const rowsOfShard = new Map(shards.map((shard) => [shard, []]));
for (const row of pinnedPlan) {
  const bucket = rowsOfShard.get(row.shard);
  if (bucket !== undefined) bucket.push(row);
}

const summary = [];
for (const shard of shards) {
  const rows = rowsOfShard.get(shard) ?? [];
  const wallStart = process.hrtime.bigint();
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const caseRows = [];
  let maxCaseMs = 0;
  let maxCaseId = null;
  let failed = 0;
  for (const planned of rows) {
    const spec = ctx.specByCaseId.get(planned.caseId);
    if (spec === undefined) throw new Error(`计划里的 caseId 不在样例表中：${planned.caseId}`);
    const row = await scanOne(spec, ctx, budgetMs === undefined ? {} : { budgetMs });
    if (row.packageHash !== pinnedHashByCaseId.get(row.caseId)) {
      throw new Error(
        `样例包 hash 与计划不符：${row.caseId}\n` +
          `  计划 ${String(pinnedHashByCaseId.get(row.caseId))}\n` +
          `  本次 ${row.packageHash}\n` +
          '§2.5 要求样例包 immutable。生成器不确定或计划过期，两者都不能继续。',
      );
    }
    if (!row.outcome.ok) failed += 1;
    if (row.outcome.durationMs > maxCaseMs) {
      maxCaseMs = row.outcome.durationMs;
      maxCaseId = row.caseId;
    }
    // `rssBytes` 只用来算这一片的峰值，**不逐件写进报告**：它是「这件跑完之后进程的 RSS」，
    // 既不是这件样例的峰值占用，也随 GC 时机漂动。逐件写出去会得到一列看着像数据、
    // 其实只能证明「进程还活着」的数字。峰值留在 header 里，并在那里如实标注口径。
    const { rssBytes, ...report } = row;
    rssPeak = Math.max(rssPeak, rssBytes);
    caseRows.push({ kind: 'case', ...report });
  }
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

  const header = {
    kind: 'shard-header',
    shard,
    shardCount: SHARD_COUNT,
    planHash: recomputed.planHash,
    shardPlanHash: recomputed.shardPlanHash,
    corpusVersion: recomputed.corpusVersion,
    scannerVersion: recomputed.scannerVersion,
    rulesetVersion: recomputed.rulesetVersion,
    rulesetFingerprintHash: recomputed.rulesetFingerprintHash,
    annotationMode: recomputed.annotationMode,
    admissionMet: recomputed.admissionMet,
    reportStatus: recomputed.reportStatus,
    caseCount: caseRows.length,
    concurrency: 1,
    wallMs: Math.round(wallMs * 1000) / 1000,
    maxCaseMs: Math.round(maxCaseMs * 1000) / 1000,
    maxCaseId,
    failedCases: failed,
    rssPeakBytes: rssPeak,
    rssStartBytes: rssStart,
    // 口径必须写在数据旁边，否则读者会把「进程 RSS 峰值」当成「单件样例峰值占用」。
    rssCaveat:
      '每件跑完后采样一次的**进程** RSS 最大值，含 node、生成器与扫描器本身；' +
      '不是单件样例的峰值占用，也不是 CI runner 上的读数。',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  const written = writeJsonl(shardReportPath(shard), [header, ...caseRows]);
  summary.push({ shard, ...header, bytes: written.bytes });
  process.stdout.write(
    `shard ${String(shard).padStart(2, '0')}  ${String(caseRows.length).padStart(3)} 件` +
      `  wall ${header.wallMs.toFixed(0)} ms  max ${header.maxCaseMs.toFixed(1)} ms` +
      ` (${String(maxCaseId)})  失败 ${String(failed)}  rss峰值 ${(rssPeak / 1048576).toFixed(1)} MiB` +
      `  → ${written.path} (${String(written.bytes)} B)\n`,
  );
}

const totalWall = summary.reduce((sum, row) => sum + row.wallMs, 0);
process.stdout.write(
  `\n共 ${String(summary.length)} 片 / ${String(summary.reduce((sum, row) => sum + row.caseCount, 0))} 件` +
    `  合计 wall ${totalWall.toFixed(0)} ms  最慢一片 shard ` +
    `${String(summary.reduce((best, row) => (row.wallMs > best.wallMs ? row : best), summary[0]).shard)}` +
    ` ${Math.max(...summary.map((row) => row.wallMs)).toFixed(0)} ms\n`,
);
process.stdout.write(
  '计时口径：本地开发机顺序执行的墙钟，**不是** CI runner 实测；' +
    '§2.6 的热 ≤3min / 冷 ≤5min 必须在真实 runner 上回填。\n',
);

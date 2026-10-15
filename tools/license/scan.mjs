#!/usr/bin/env node
// 源码依赖许可证门禁（ZLQ-153 §10.3 第一处扫描目标）。
//
// 退出码约定 —— 这是「既不静默通过，也不一律判死」的落点：
//   0  全部落在六项白名单，或待裁定项已在 config/license-policy.json 登记
//   1  命中禁止项（无许可声明 / UNLICENSED / SSPL / BUSL / GPL-2.0-only …）或许可证无法解析
//   2  出现 reviewRequired（GPL/LGPL/MPL 等）但未登记裁定条目 —— 需架构师处理，不是硬违规
//      --strict 下，已登记但 status=pending-architect 的条目也返回 2，供裁定完成后回归检查
//      已 approved 但**批准前提失效**的条目同样返回 2：distributed:false 的裁定一旦覆盖到
//      生产依赖（或分发产物，那半在 bundle-scan.mjs），就等于没有裁定，必须重新走一遍
//      lockfile 里存在未进入审计闭包的孤立条目同样返回 2（有依赖没被审计到）
//
// 判定与 runner 平台无关：被 os/cpu/libc 约束的平台变体一律从提交进仓库的
// config/license-registry-facts.json 解析（integrity 与 lockfile 交叉校验），不看本机装了什么。
// 缺快照条目、integrity 对不上、或快照与已安装 manifest 说法矛盾，都归入「无法解析」→ 退出码 1。
// 这条性质由 tools/test/license-platform-independence.test.mjs 锁住。
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  collect,
  ADJUDICATION_PENDING,
  VERDICT_ALLOWED,
  VERDICT_FORBIDDEN,
  VERDICT_REVIEW,
  VERDICT_UNKNOWN,
} from '../lib/collect.mjs';

function parseArgs(argv) {
  const args = {
    strict: false,
    json: false,
    repoRoot: process.cwd(),
    out: null,
    lockfile: 'pnpm-lock.yaml',
    policy: 'config/license-policy.json',
    installedRoot: null,
    installedLayout: 'pnpm',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--strict') args.strict = true;
    else if (token === '--json') args.json = true;
    else if (token === '--repo-root') args.repoRoot = resolve(argv[(i += 1)]);
    else if (token === '--lockfile') args.lockfile = argv[(i += 1)];
    else if (token === '--policy') args.policy = argv[(i += 1)];
    else if (token === '--installed-root') args.installedRoot = resolve(argv[(i += 1)]);
    else if (token === '--installed-layout') args.installedLayout = argv[(i += 1)];
    else if (token === '--out') args.out = resolve(argv[(i += 1)]);
    else throw new Error(`未知参数：${token}`);
  }
  return args;
}

function describe(entry) {
  const parts = [`${entry.name}@${entry.version}`, entry.expression ?? '<无许可证声明>'];
  parts.push(`来源=${entry.licenseSource}`);
  parts.push(entry.kind === 'prod' ? '生产依赖' : 'dev 依赖');
  if (entry.origin === 'package-manager') parts.push('pnpm 自锁文档');
  if (entry.inferredFrom) parts.push(`同族推断自 ${entry.inferredFrom}`);
  if (entry.adjudication) parts.push(`裁定条目=${entry.adjudication.id}(${entry.adjudication.status})`);
  if (entry.adjudication?.outOfScope) parts.push(`批准已失效：${entry.adjudication.outOfScope}`);
  if (entry.note) parts.push(entry.note);
  parts.push(entry.link);
  return parts.join(' | ');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = collect({
    repoRoot: args.repoRoot,
    lockfileFile: args.lockfile,
    policyFile: args.policy,
    installedRoot: args.installedRoot,
    installedLayout: args.installedLayout,
  });
  const { entries, summary } = result;

  const forbidden = entries.filter((item) => item.verdict === VERDICT_FORBIDDEN);
  const unknown = entries.filter((item) => item.verdict === VERDICT_UNKNOWN);
  const review = entries.filter((item) => item.verdict === VERDICT_REVIEW);
  const unregistered = review.filter((item) => !item.adjudication);
  const pending = review.filter((item) => item.adjudication?.status === ADJUDICATION_PENDING);
  const rejected = review.filter((item) => item.adjudication?.status === 'rejected');
  // 已 approved 但批准前提（distributed:false）已不成立：裁定条目还在，却不能再当放行依据。
  // 与「未登记」同档处理 —— 两者都意味着这条 reviewRequired 许可此刻没有有效裁定。
  const staleApproval = review.filter((item) => item.adjudication?.outOfScope);

  const report = {
    generatedAt: new Date().toISOString(),
    spec: result.policy.spec,
    scanTarget: 'source-packages',
    lockfile: 'pnpm-lock.yaml',
    // lockfile 里存在但从任何 importer 都走不到的条目：既不该出现在闭包里，
    // 出现了就说明依赖图解析漏了边。留在报告里让它可核对，而不是静默丢弃。
    orphanedEntries: result.orphaned,
    summary: {
      ...summary,
      unregisteredReviewRequired: unregistered.map((item) => `${item.name}@${item.version}`),
      pendingAdjudication: pending.map((item) => `${item.name}@${item.version}`),
      forbidden: forbidden.map((item) => `${item.name}@${item.version}`),
      unknown: unknown.map((item) => `${item.name}@${item.version}`),
    },
    policy: {
      allowed: result.policy.allowed,
      reviewRequiredCount: result.policy.reviewRequired?.exact?.length ?? 0,
      forbiddenExactCount: result.policy.forbidden?.exact?.length ?? 0,
      adjudications: (result.policy.adjudications?.entries ?? []).map((item) => ({
        id: item.id,
        status: item.status,
        license: item.license,
        // distributed:false 是批准的**前提**而不是备注：门禁按它判断批准是否还适用，
        // 所以它必须出现在报告里，否则读报告的人看不出批准是有条件的。
        distributed: item.distributed ?? null,
      })),
    },
    skippedTargets: [
      {
        target: 'docker-image',
        blockedBy: result.policy.scanTargets?.dockerImage?.blockedBy ?? null,
        todo: result.policy.scanTargets?.dockerImage?.todo ?? null,
      },
    ],
    entries,
  };

  const outFile = args.out ?? join(args.repoRoot, 'artifacts', 'license-report.json');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const hardFail = forbidden.length + unknown.length + rejected.length > 0;
  // lockfile 里有、闭包走不到的条目 = 有依赖没被审计到。这不是许可证违规（不该判 1），
  // 但也不能只在报告里静静躺着：按「需人工确认」处理，与未登记待裁定同一档。
  // staleApproval 同档：批准的前提没了，等于这条 reviewRequired 此刻无人裁定。
  const softFail =
    unregistered.length > 0 ||
    staleApproval.length > 0 ||
    result.orphaned.length > 0 ||
    (args.strict && pending.length > 0);
  const exitCode = hardFail ? 1 : softFail ? 2 : 0;

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } else {
    const line = (text = '') => process.stdout.write(`${text}\n`);
    line('== 源码依赖许可证扫描 ==');
    line(`闭包总量：${summary.total}（项目 lockfile ${summary.byOrigin.project} + pnpm 自锁 ${summary.byOrigin['package-manager']}）`);
    line(`生产依赖 ${summary.prod} / dev 依赖 ${summary.dev}`);
    line(
      `解析来源：已安装 manifest ${summary.bySource['installed-manifest'] ?? 0}，` +
        `注册表事实快照 ${summary.bySource['registry-facts'] ?? 0}，` +
        `同族平台推断 ${summary.bySource['platform-sibling-inferred'] ?? 0}，` +
        `审计策略条目 ${summary.bySource['audited-policy-entry'] ?? 0}`,
    );
    line(`判定：通过 ${summary.byVerdict[VERDICT_ALLOWED]}，待裁定 ${summary.byVerdict[VERDICT_REVIEW]}，禁止 ${summary.byVerdict[VERDICT_FORBIDDEN]}，无法解析 ${summary.byVerdict[VERDICT_UNKNOWN]}`);
    line('许可证分布：');
    for (const [license, count] of Object.entries(summary.byLicense)) line(`  ${license}: ${count}`);
    line(`报告：${outFile}`);

    if (forbidden.length > 0) {
      line('');
      line(`!! 禁止项 ${forbidden.length} 条（必须移除依赖，无豁免通道）：`);
      for (const item of forbidden) line(`  - ${describe(item)}`);
    }
    if (unknown.length > 0) {
      line('');
      line(`!! 无法解析许可证 ${unknown.length} 条（未知即不合规）：`);
      for (const item of unknown) line(`  - ${describe(item)}`);
    }
    if (unregistered.length > 0) {
      line('');
      line(`!! 待裁定但未登记 ${unregistered.length} 条 —— 需在 config/license-policy.json 的 adjudications.entries 增加条目并请架构师评审：`);
      for (const item of unregistered) line(`  - ${describe(item)}`);
    }
    if (staleApproval.length > 0) {
      line('');
      line(`!! 批准前提已失效 ${staleApproval.length} 条 —— 裁定条目仍写着 approved，但它批准时声明的 distributed:false 已不成立，必须重新裁定：`);
      for (const item of staleApproval) line(`  - ${describe(item)}`);
      line('   处理：要么把依赖退回 devDependencies / 从产物里去掉，要么请架构师按「会分发」重新裁定并更新条目。');
    }
    if (result.orphaned.length > 0) {
      line('');
      line(`!! lockfile 里有 ${result.orphaned.length} 条从任何 importer 都走不到的包（未进入审计闭包）：`);
      for (const key of result.orphaned) line(`  - ${key}`);
      line('   处理：确认 tools/lib/lockfile.mjs 的闭包遍历是否漏了新的依赖字段；确认无漏后再考虑登记。');
    }
    if (pending.length > 0) {
      line('');
      line(`>> 等待架构师裁定 ${pending.length} 条（已登记 status=pending-architect，不判死但必须留痕）：`);
      for (const item of pending) line(`  - ${describe(item)}`);
    }
    if (review.length > 0 && args.strict) {
      line('');
      line(
        `--strict：${review.length} 条 reviewRequired 没有有效批准` +
          `（未登记 ${unregistered.length}、批准已失效 ${staleApproval.length}、等待裁定 ${pending.length}）。`,
      );
    }
    line('');
    line(`>> Docker 镜像扫描未接通（blocked by ${report.skippedTargets[0].blockedBy}）：${report.skippedTargets[0].todo}`);
  }

  // 待裁定清单落到文件 + CI step summary，保证「不静默」这件事有三处留痕。
  // 三档标签不能压成两档：STALE 与 MISSING 的处置动作不同（一个是重裁已有条目，
  // 一个是新建条目），混标会让读到清单的人去改错地方。
  const label = (item) => {
    if (!item.adjudication) return 'MISSING';
    if (item.adjudication.outOfScope) return 'STALE  ';
    return 'pending';
  };
  const needsHuman = [...unregistered, ...staleApproval, ...pending];
  if (needsHuman.length > 0) {
    const listFile = join(dirname(outFile), 'license-adjudication-required.txt');
    const body = [
      '# 需架构师裁定的第三方许可证（由 tools/license/scan.mjs 生成）',
      ...needsHuman.map((item) => `${label(item)} ${describe(item)}`),
      '',
    ].join('\n');
    writeFileSync(listFile, body, 'utf8');
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [
          '## 许可证：需架构师裁定',
          '',
          '| 包 | 许可证 | 状态 | 链接 |',
          '| --- | --- | --- | --- |',
          ...needsHuman.map((item) => {
            const status = !item.adjudication
              ? '**未登记**'
              : item.adjudication.outOfScope
                ? `**批准已失效**（${item.adjudication.outOfScope}）`
                : item.adjudication.status;
            return `| \`${item.name}@${item.version}\` | ${item.expression} | ${status} | ${item.link} |`;
          }),
          '',
        ].join('\n'),
        'utf8',
      );
    }
  }

  process.exit(exitCode);
}

main();

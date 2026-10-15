#!/usr/bin/env node
// 许可证门禁的控制用例（反假阴性）。
//
// 门禁最危险的失效方式不是报错，而是「永远返回 0」。所以这里用三份夹具把
// tools/license/scan.mjs 的三档退出码全部走一遍，并且不只断言退出码，还断言
// 判定明细：夹具包名、许可表达式、解析来源、prod/dev 归类、待裁定登记状态。
// 只断言退出码的话，一个把所有依赖都判成 allowed 的坏实现同样能通过「ok」用例。
//
// 三份夹具都用仓库线上那份 config/license-policy.json（以相对路径传给 --policy），
// 不用夹具自带的副本 —— 否则「夹具带一份能抓住夹具的策略」是自证，证明不了门禁有效。
//
// 退出码：0 全部用例符合预期；1 任一用例不符（含子进程崩溃）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = dirname(resolve(import.meta.filename));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCAN = join(HERE, 'scan.mjs');
const FIXTURES = join(HERE, '..', '__fixtures__', 'license-control');
const POLICY = join(REPO_ROOT, 'config', 'license-policy.json');

function runScan(fixture, extraArgs = []) {
  const root = join(FIXTURES, fixture);
  const workdir = mkdtempSync(join(tmpdir(), `lq-license-control-${fixture}-`));
  const out = join(workdir, 'license-report.json');
  const summaryFile = join(workdir, 'step-summary.md');
  const args = [
    SCAN,
    '--repo-root', root,
    '--lockfile', 'pnpm-lock.yaml',
    // 关键：用线上真策略。夹具目录到策略文件是向上的相对路径，join(repoRoot, rel) 可解析。
    '--policy', relative(root, POLICY),
    '--installed-root', join(root, 'installed'),
    '--installed-layout', 'flat',
    '--out', out,
    '--json',
    ...extraArgs,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
  });
  let report = null;
  if (existsSync(out)) {
    try {
      report = JSON.parse(readFileSync(out, 'utf8'));
    } catch (error) {
      report = { parseError: error.message };
    }
  }
  const stepSummary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '';
  const listed = existsSync(join(workdir, 'license-adjudication-required.txt'));
  rmSync(workdir, { recursive: true, force: true });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    report,
    stepSummary,
    listed,
  };
}

class Checker {
  constructor() {
    this.failures = [];
    this.assertions = 0;
    this.caseName = '<none>';
  }

  useCase(name) {
    this.caseName = name;
    return this;
  }

  check(label, actual, expected) {
    this.assertions += 1;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) this.failures.push(`[${this.caseName}] ${label}：期望 ${e}，实际 ${a}`);
    return this;
  }

  checkTrue(label, value) {
    return this.check(label, Boolean(value), true);
  }

  entry(report, name, version) {
    return (report?.entries ?? []).find((item) => item.name === name && item.version === version) ?? null;
  }
}

function caseOk(c) {
  const run = runScan('ok');
  const { report } = run;
  c.useCase('license-ok（全白名单）');
  c.check('退出码', run.exitCode, 0);
  c.checkTrue('报告已写出', report && !report.parseError);
  if (!report) return c;

  c.check('闭包总量', report.summary.total, 7);
  c.check('生产依赖', report.summary.prod, 1);
  c.check('开发依赖', report.summary.dev, 6);
  c.check('孤立条目', report.orphanedEntries, []);
  c.check('判定 allowed', report.summary.byVerdict.allowed, 7);
  c.check('判定 review-required', report.summary.byVerdict['review-required'], 0);
  c.check('判定 forbidden', report.summary.byVerdict.forbidden, 0);
  c.check('判定 unknown', report.summary.byVerdict.unknown, 0);
  c.check('未登记待裁定', report.summary.unregisteredReviewRequired, []);
  c.check('待裁定', report.summary.pendingAdjudication, []);

  // workspace link 必须被跳过，否则自有包会被当成第三方依赖审计。
  c.check('link: 依赖未进闭包', c.entry(report, '@lqfixture/workspace-sibling', '0.0.0'), null);
  c.checkTrue('link: 目标未被任何版本收进闭包', !(report.entries ?? []).some((item) => item.name === '@lqfixture/workspace-sibling'));

  // npm alias：importer 里的依赖名是 aliashost，闭包里应当只有别名目标 aliasts。
  c.checkTrue('alias 宿主未进闭包', !(report.entries ?? []).some((item) => item.name === 'aliashost'));
  c.check('alias 目标许可证', c.entry(report, 'aliasts', '6.0.2')?.expression, 'Apache-2.0');

  // peer 后缀 snapshot 必须被遍历到，否则传递依赖会整体漏审。
  c.check('peer 后缀 snapshot 的传递依赖', c.entry(report, 'zod', '4.6.7')?.kind, 'prod');

  // 同族平台二进制：本机没装 fakebuild-linux-x64，许可从已装兄弟推断，
  // 且必须是兄弟的 BSD-2-Clause 而不是父包 fakebuild 的 MIT —— 用来证明推断取的是同族平台变体。
  const linux = c.entry(report, 'fakebuild-linux-x64', '1.0.0');
  c.check('平台变体推断结果', linux?.expression, 'BSD-2-Clause');
  c.check('平台变体解析来源', linux?.licenseSource, 'platform-sibling-inferred');
  c.check('平台变体推断出处', linux?.inferredFrom, 'fakebuild-darwin-arm64@1.0.0');
  c.check('父包仍按已安装 manifest 判定', c.entry(report, 'fakebuild', '1.0.0')?.expression, 'MIT');
  c.check('解析来源分布', report.summary.bySource, { 'installed-manifest': 6, 'platform-sibling-inferred': 1 });
  return c;
}

function caseReview(c) {
  const run = runScan('review');
  const { report } = run;
  c.useCase('license-review（GPL/LGPL/MPL 待裁定）');
  c.check('退出码', run.exitCode, 2);
  c.checkTrue('报告已写出', report && !report.parseError);
  if (!report) return c;

  c.check('闭包总量', report.summary.total, 4);
  c.check('孤立条目', report.orphanedEntries, []);
  c.check('判定 allowed', report.summary.byVerdict.allowed, 1);
  c.check('判定 review-required', report.summary.byVerdict['review-required'], 3);
  c.check('判定 forbidden', report.summary.byVerdict.forbidden, 0);
  c.check('判定 unknown', report.summary.byVerdict.unknown, 0);
  c.check('未登记待裁定', report.summary.unregisteredReviewRequired, ['copyleftfixture@2.0.0', 'lgplfixture@1.1.0']);
  c.check('已登记待裁定', report.summary.pendingAdjudication, ['minimatch@10.2.6']);

  // 「不静默通过」的三处留痕：stdout、待裁定清单文件、CI step summary。
  c.checkTrue('stdout 点名未登记项', run.stdout.includes('copyleftfixture@2.0.0'));
  c.checkTrue('待裁定清单文件已写出', run.listed);
  c.checkTrue('step summary 含待裁定表', run.stepSummary.includes('minimatch@10.2.6'));

  c.check('MPL-2.0 归入待裁定而非禁止', c.entry(report, 'copyleftfixture', '2.0.0')?.verdict, 'review-required');
  c.check('LGPL-2.1-or-later 归入待裁定', c.entry(report, 'lgplfixture', '1.1.0')?.verdict, 'review-required');
  c.check('已登记项带裁定条目', c.entry(report, 'minimatch', '10.2.6')?.adjudication?.status, 'pending-architect');
  c.check('对照项仍为 allowed', c.entry(report, 'zod', '4.6.7')?.verdict, 'allowed');

  // --strict：已登记但仍是 pending-architect 时也要红，供架构师裁定完成后做回归检查。
  const strict = runScan('review', ['--strict']);
  c.useCase('license-review --strict（已登记 pending 也判红）');
  c.check('退出码', strict.exitCode, 2);
  return c;
}

function caseViolation(c) {
  const run = runScan('violation');
  const { report } = run;
  c.useCase('license-violation（禁止项 + 无法解析）');
  c.check('退出码', run.exitCode, 1);
  c.checkTrue('报告已写出', report && !report.parseError);
  if (!report) return c;

  c.check('闭包总量', report.summary.total, 10);
  c.check('孤立条目', report.orphanedEntries, []);
  c.check('判定 allowed', report.summary.byVerdict.allowed, 4);
  c.check('判定 review-required', report.summary.byVerdict['review-required'], 0);
  c.check('判定 forbidden', report.summary.byVerdict.forbidden, 4);
  c.check('判定 unknown', report.summary.byVerdict.unknown, 2);
  c.check('禁止项清单', report.summary.forbidden, [
    'nolicensefield@1.0.0',
    'proprietaryfixture@1.0.0',
    'ssplfixture@1.0.0',
    'unlicensedfixture@1.0.0',
  ]);
  c.check('无法解析清单', report.summary.unknown, ['absentfixture@1.0.0', 'conflictfamily-win32-x64@3.0.0']);

  // 六种失败形态逐条点名，避免「有一个禁止项所以退出码是 1」这种粗粒度通过。
  c.check('UNLICENSED', c.entry(report, 'unlicensedfixture', '1.0.0')?.expression, 'UNLICENSED');
  c.check('无 license 字段 → NOASSERTION', c.entry(report, 'nolicensefield', '1.0.0')?.expression, 'NOASSERTION');
  c.check('无 license 字段的说明', c.entry(report, 'nolicensefield', '1.0.0')?.note, 'package.json 未声明 license/licenses 字段');
  c.check('SSPL-1.0', c.entry(report, 'ssplfixture', '1.0.0')?.verdict, 'forbidden');
  c.check('自由文本许可命中禁止子串', c.entry(report, 'proprietaryfixture', '1.0.0')?.verdict, 'forbidden');
  c.check('解析不到 → unknown', c.entry(report, 'absentfixture', '1.0.0')?.licenseSource, 'unresolved');

  // 同族兄弟许可互相矛盾时不得裁决：这条证明「推断」没有退化成「猜测」。
  const conflict = c.entry(report, 'conflictfamily-win32-x64', '3.0.0');
  c.check('兄弟矛盾 → 无表达式', conflict?.expression, null);
  c.check('兄弟矛盾 → unknown', conflict?.verdict, 'unknown');
  c.check('兄弟自身仍合规', c.entry(report, 'conflictfamily-linux-x64', '3.0.0')?.verdict, 'allowed');

  c.checkTrue('stdout 点名禁止项', run.stdout.includes('unlicensedfixture@1.0.0'));
  return c;
}

function caseOkStrict(c) {
  const run = runScan('ok', ['--strict']);
  c.useCase('license-ok --strict');
  c.check('退出码', run.exitCode, 0);
  return c;
}

// 用例名固定在这里，不取 c.caseName：一个用例内部会切换子场景（如 --strict 复跑），
// 取「最后一次 useCase 的名字」会让汇总表贴错标签。
const CASES = [
  { label: 'license-ok（全白名单 → 期望退出码 0）', fn: caseOk },
  { label: 'license-review（待裁定 → 期望退出码 2，--strict 同为 2）', fn: caseReview },
  { label: 'license-violation（禁止/未知 → 期望退出码 1）', fn: caseViolation },
  { label: 'license-ok --strict（无待裁定 → 期望退出码 0）', fn: caseOkStrict },
];

function main() {
  const asJson = process.argv.slice(2).includes('--json');
  const c = new Checker();
  const perCase = [];
  for (const { label, fn } of CASES) {
    const before = c.failures.length;
    fn(c);
    perCase.push({ case: label, failures: c.failures.length - before });
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ assertions: c.assertions, failures: c.failures, perCase }, null, 2)}\n`);
  } else {
    process.stdout.write('== 许可证门禁控制用例 ==\n');
    process.stdout.write(`策略：${relative(REPO_ROOT, POLICY)}（线上真策略，非夹具副本）\n`);
    for (const item of perCase) {
      process.stdout.write(`  ${item.failures === 0 ? 'OK  ' : 'FAIL'} ${item.case}\n`);
    }
    process.stdout.write(`断言 ${c.assertions} 条，失败 ${c.failures.length} 条\n`);
    for (const failure of c.failures) process.stdout.write(`!! ${failure}\n`);
    if (c.failures.length === 0) {
      process.stdout.write('结论：三档退出码（0 / 2 / 1）与判定明细均符合预期，门禁不是「永远返回 0」。\n');
    }
  }
  process.exit(c.failures.length === 0 ? 0 : 1);
}

const invokedDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirect) main();

export { Checker, runScan };

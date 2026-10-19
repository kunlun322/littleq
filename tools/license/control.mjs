#!/usr/bin/env node
// 许可证门禁的控制用例（反假阴性）。
//
// 门禁最危险的失效方式不是报错，而是「永远返回 0」。所以这里用四份夹具把
// tools/license/scan.mjs 的三档退出码全部走一遍，并且不只断言退出码，还断言
// 判定明细：夹具包名、许可表达式、解析来源、prod/dev 归类、裁定条目的状态与前提。
// 只断言退出码的话，一个把所有依赖都判成 allowed 的坏实现同样能通过「ok」用例。
//
// 四份夹具都用仓库线上那份 config/license-policy.json（以相对路径传给 --policy），
// 不用夹具自带的副本 —— 否则「夹具带一份能抓住夹具的策略」是自证，证明不了门禁有效。
//
// 唯一的例外是**派生策略**：需要覆盖「裁定状态不是 approved」的分支时（线上策略里
// 已经没有 pending-architect 条目了），由 derivePolicy() 从线上策略复制一份、只改
// adjudications.entries 里的 status/distributed 两个字段，其余字节逐字节保持不变，
// 并把「其余字节没被动过」本身作为一条断言。这样夹具通过与否仍由门禁决定，
// 而不是由一份为通过而写的策略决定 —— 尤其是档位（allowed/reviewRequired/forbidden/spdx）
// 一旦被派生策略改动，整个控制用例就退化成自证。
//
// 另外两条（caseSliceAdjudication / caseSharpOverride）不用夹具，直接跑真实闭包：
// 它们对照的对象是 ZLQ-190 §6.3 落在线上配置里的那两件事 —— caniuse-lite 的精确裁定
// 与 pnpm-workspace.yaml 里摘掉 sharp 的 override。夹具能证明规则有效，证明不了
// 「线上这条配置删掉之后门禁会红」，而后者才是 §6.1 点名要的可染红控制。
//
// 退出码：0 全部用例符合预期；1 任一用例不符（含子进程崩溃）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = dirname(resolve(import.meta.filename));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCAN = join(HERE, 'scan.mjs');
const FIXTURES = join(HERE, '..', '__fixtures__', 'license-control');
const POLICY = join(REPO_ROOT, 'config', 'license-policy.json');

// 派生策略只许改这两个字段。白名单之外一律抛错：打错字段名会让派生策略与线上策略
// 一模一样，于是「对照那一半」什么也证明不了，而测试照样能绿。
const DERIVABLE_FIELDS = new Set(['status', 'distributed']);

function readRealPolicy() {
  return JSON.parse(readFileSync(POLICY, 'utf8'));
}

// 派生策略的自检基准：把 adjudications.entries 整块摘掉之后剩下的字节。
// 两种派生（改字段 / 移除整条）都用它证明「档位与其他配置一个字节没动」。
function stripAdjudicationEntries(doc) {
  const { adjudications, ...rest } = doc;
  const { entries, ...adjudicationRest } = adjudications;
  return { ...rest, adjudications: adjudicationRest };
}

// 从线上策略派生一份只改了某条裁定的副本。
// 返回 onlyEntriesChanged（除裁定条目外字节一致）与 changed（这次改动确实生效），
// 两条都由调用方断言 —— 前者防自证，后者防「改了个本来就是那个值的字段」这种空对照。
function derivePolicy(id, set) {
  const real = readRealPolicy();
  const derived = structuredClone(real);
  const entry = (derived.adjudications?.entries ?? []).find((item) => item.id === id);
  if (!entry) throw new Error(`派生策略失败：线上策略里没有 id=${id} 的裁定条目`);
  for (const [field, value] of Object.entries(set)) {
    if (!DERIVABLE_FIELDS.has(field)) {
      throw new Error(
        `派生策略失败：${field} 不在可派生字段白名单（${[...DERIVABLE_FIELDS].join(' / ')}）内`,
      );
    }
    entry[field] = value;
  }
  const realEntry = real.adjudications.entries.find((item) => item.id === id);
  return {
    label: `${id} ← ${Object.entries(set)
      .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
      .join(', ')}`,
    policy: derived,
    onlyEntriesChanged:
      JSON.stringify(stripAdjudicationEntries(real)) ===
      JSON.stringify(stripAdjudicationEntries(derived)),
    changed: JSON.stringify(entry) !== JSON.stringify(realEntry),
  };
}

// 「删除裁定」需要的是**移除整条 entry**，不是改字段：ZLQ-190 §6.3 要求框架升级后必须
// 重新裁定，其失效形态就是这条裁定对当前闭包完全不存在（精确版本失配 = 匹配不上）。
// 移除同样只动 adjudications.entries，档位与其他配置仍逐字节不变（由 onlyEntriesChanged 断言）。
function derivePolicyWithout(id) {
  const real = readRealPolicy();
  const derived = structuredClone(real);
  const entries = derived.adjudications?.entries ?? [];
  const index = entries.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`派生策略失败：线上策略里没有 id=${id} 的裁定条目`);
  entries.splice(index, 1);
  return {
    label: `${id} ← 整条移除`,
    policy: derived,
    onlyEntriesChanged:
      JSON.stringify(stripAdjudicationEntries(real)) ===
      JSON.stringify(stripAdjudicationEntries(derived)),
    changed: !(derived.adjudications?.entries ?? []).some((item) => item.id === id),
  };
}

// options.derived 传入时，派生策略写进临时目录并以绝对路径传给 --policy
// （collect.mjs 用 resolve(repoRoot, policyFile) 解析，绝对路径不会被夹具目录前缀污染）。
function runScan(fixture, options = {}) {
  const { extraArgs = [], derived = null } = options;
  const root = join(FIXTURES, fixture);
  const workdir = mkdtempSync(join(tmpdir(), `lq-license-control-${fixture}-`));
  const out = join(workdir, 'license-report.json');
  const summaryFile = join(workdir, 'step-summary.md');
  // 关键：默认用线上真策略。夹具目录到策略文件是向上的相对路径，join(repoRoot, rel) 可解析。
  let policyArg = relative(root, POLICY);
  if (derived) {
    policyArg = join(workdir, 'derived-license-policy.json');
    writeFileSync(policyArg, `${JSON.stringify(derived.policy, null, 2)}\n`, 'utf8');
  }
  const listFile = join(workdir, 'license-adjudication-required.txt');
  const args = [
    SCAN,
    '--repo-root', root,
    '--lockfile', 'pnpm-lock.yaml',
    '--policy', policyArg,
    '--installed-root', join(root, 'installed'),
    '--installed-layout', 'flat',
    '--out', out,
    // 刻意**不传** --json：报告从 --out 的文件里读，stdout 留给人读的那一档。
    // 传了 --json 的话 stdout 只剩 summary JSON，「stdout 点名某某」这类断言会被
    // JSON 里的包名字段满足，于是证明不了「!! 待裁定但未登记」那几行真的打印出来了
    // —— 而「三处留痕」的第一处正是它。
    ...extraArgs,
  ];
  return invokeAndCollect({ args, workdir, out, summaryFile, listFile });
}

// 跑一次 scan.mjs 并收集它的四件产物：退出码、人读 stdout、报告 JSON、step summary、
// 待裁定清单。runScan（夹具）与 runRealScan（真实闭包）共用它，两条路径的收集逻辑
// 因此不可能漂移 —— 否则「夹具那半绿、线上那半红」可能只是收集方式不同。
function invokeAndCollect({ args, workdir, out, summaryFile, listFile }) {
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
  const listBody = existsSync(listFile) ? readFileSync(listFile, 'utf8') : '';
  rmSync(workdir, { recursive: true, force: true });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    report,
    stepSummary,
    listed: listBody !== '',
    listBody,
  };
}

// 真实仓库闭包上的扫描。刻意**不传** --installed-root / --installed-layout / --lockfile：
// 用 scan.mjs 的默认值（node_modules + pnpm 布局 + pnpm-lock.yaml），也就是 `pnpm license:scan`
// 的那一次调用。这里要对照的是**线上配置**（裁定条目、workspace override），
// 换成夹具的 flat 布局就等于换掉了被对照的对象。
function runRealScan(options = {}) {
  const { extraArgs = [], derived = null } = options;
  const workdir = mkdtempSync(join(tmpdir(), 'lq-license-control-real-'));
  const out = join(workdir, 'license-report.json');
  const summaryFile = join(workdir, 'step-summary.md');
  const listFile = join(workdir, 'license-adjudication-required.txt');
  let policyArg = POLICY;
  if (derived) {
    policyArg = join(workdir, 'derived-license-policy.json');
    writeFileSync(policyArg, `${JSON.stringify(derived.policy, null, 2)}\n`, 'utf8');
  }
  return invokeAndCollect({
    args: [SCAN, '--repo-root', REPO_ROOT, '--policy', policyArg, '--out', out, ...extraArgs],
    workdir,
    out,
    summaryFile,
    listFile,
  });
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

  // 派生策略的两条自检：没动档位（防自证）、确实改了目标字段（防空对照）。
  checkDerived(derived) {
    this.checkTrue(`派生策略只改了 adjudications.entries（${derived.label}）`, derived.onlyEntriesChanged);
    this.checkTrue(`派生策略确实改动了目标条目（${derived.label}）`, derived.changed);
    return this;
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
  c.check('批准前提失效', report.summary.approvalsOutOfScope, []);

  // workspace link 必须被跳过，否则自有包会被当成第三方依赖审计。
  c.check('link: 依赖未进闭包', c.entry(report, '@lqfixture/workspace-sibling', '0.0.0'), null);
  c.checkTrue(
    'link: 目标未被任何版本收进闭包',
    !(report.entries ?? []).some((item) => item.name === '@lqfixture/workspace-sibling'),
  );

  // npm alias：importer 里的依赖名是 aliashost，闭包里应当只有别名目标 aliasts。
  c.checkTrue('alias 宿主未进闭包', !(report.entries ?? []).some((item) => item.name === 'aliashost'));
  c.check('alias 目标许可证', c.entry(report, 'aliasts', '6.0.2')?.expression, 'Apache-2.0');

  // peer 后缀 snapshot 必须被遍历到，否则传递依赖会整体漏审。
  c.check('peer 后缀 snapshot 的传递依赖', c.entry(report, 'zod', '4.6.7')?.kind, 'prod');

  // 平台变体：本机没装 fakebuild-linux-x64，许可从夹具那份注册表事实快照解析。
  // 这是 ZLQ-162 缺陷 2 的修法在退出码层面的证据 —— 修复前它靠已装的 darwin 兄弟同族推断，
  // 到 Linux runner 上 darwin 兄弟也没装，推断链断掉就变成 unknown、退出码 1。
  const linux = c.entry(report, 'fakebuild-linux-x64', '1.0.0');
  c.check('未安装的平台变体解析结果', linux?.expression, 'BSD-2-Clause');
  c.check('未安装的平台变体解析来源', linux?.licenseSource, 'registry-facts');
  c.check('未安装的平台变体不是同族猜出来的', linux?.inferredFrom, null);
  c.checkTrue('未安装的平台变体带证据链接', Boolean(linux?.homepage ?? linux?.repository));
  // 本机装得到的变体同样走快照：resolver 对**所有** os/cpu/libc 约束的条目一律不看本机，
  // 否则「装到了就采信本机、没装到才查快照」会让判定重新随 runner 平台漂移。
  const darwin = c.entry(report, 'fakebuild-darwin-arm64', '1.0.0');
  c.check('已安装的平台变体解析来源', darwin?.licenseSource, 'registry-facts');
  c.check('已安装的平台变体解析结果', darwin?.expression, 'BSD-2-Clause');
  // 反向断言：快照不是给所有包发证的后门。没有平台约束的包照样读真实 package.json，
  // 于是 violation/ 里「已装但未声明 license」那一禁止项仍然查得出来。
  c.check('父包（无平台约束）仍按已安装 manifest 判定', c.entry(report, 'fakebuild', '1.0.0')?.licenseSource, 'installed-manifest');
  c.check('父包许可证', c.entry(report, 'fakebuild', '1.0.0')?.expression, 'MIT');
  c.check('解析来源分布', report.summary.bySource, { 'installed-manifest': 5, 'registry-facts': 2 });
  return c;
}

function caseReview(c) {
  const run = runScan('review');
  const { report } = run;
  c.useCase('license-review（未登记 reviewRequired）');
  c.check('退出码', run.exitCode, 2);
  c.checkTrue('报告已写出', report && !report.parseError);
  if (!report) return c;

  c.check('闭包总量', report.summary.total, 4);
  c.check('孤立条目', report.orphanedEntries, []);
  c.check('判定 allowed', report.summary.byVerdict.allowed, 2);
  c.check('判定 review-required', report.summary.byVerdict['review-required'], 2);
  c.check('判定 forbidden', report.summary.byVerdict.forbidden, 0);
  c.check('判定 unknown', report.summary.byVerdict.unknown, 0);
  c.check('未登记待裁定', report.summary.unregisteredReviewRequired, [
    'copyleftfixture@2.0.0',
    'lgplfixture@1.1.0',
  ]);
  c.check('已登记待裁定', report.summary.pendingAdjudication, []);
  c.check('批准前提失效', report.summary.approvalsOutOfScope, []);

  // 「不静默通过」的三处留痕：stdout、待裁定清单文件、CI step summary。
  c.checkTrue('stdout 点名未登记项', run.stdout.includes('copyleftfixture@2.0.0'));
  c.checkTrue('待裁定清单文件已写出', run.listed);
  c.checkTrue('step summary 含未登记项', run.stepSummary.includes('copyleftfixture@2.0.0'));
  c.checkTrue('清单文件标 MISSING', run.listBody.includes('MISSING'));
  // 已批准的项不得混进待裁定清单：混进去会让人去重裁一条已经裁过的条目。
  c.checkTrue('step summary 不含已批准项', !run.stepSummary.includes('minimatch@10.2.6'));
  c.checkTrue('清单文件不含已批准项', !run.listBody.includes('minimatch@10.2.6'));

  c.check('MPL-2.0 归入待裁定而非禁止', c.entry(report, 'copyleftfixture', '2.0.0')?.verdict, 'review-required');
  c.check('LGPL-2.1-or-later 归入待裁定', c.entry(report, 'lgplfixture', '1.1.0')?.verdict, 'review-required');
  // ZLQ-162 之后 minimatch 是 approved + distributed:false，本夹具把它放在 devDependencies，
  // 前提成立 → 批准生效，判定从 review-required 抬到 allowed。
  const minimatch = c.entry(report, 'minimatch', '10.2.6');
  c.check('已批准的 dev 依赖被放行', minimatch?.verdict, 'allowed');
  c.check('裁定状态', minimatch?.adjudication?.status, 'approved');
  c.check('批准前提写进报告', minimatch?.adjudication?.distributed, false);
  c.check('批准前提未失效', minimatch?.adjudication?.outOfScope, null);
  c.check('对照项仍为 allowed', c.entry(report, 'zod', '4.6.7')?.verdict, 'allowed');

  // --strict：未登记项本来就让退出码是 2，所以这里的 2 不是 --strict 的功劳。
  // --strict 真正的判别力由 caseApprovalScope 的「同一份夹具 0 → 2」证明。
  const strict = runScan('review', { extraArgs: ['--strict'] });
  c.useCase('license-review --strict');
  c.check('退出码', strict.exitCode, 2);
  return c;
}

// 批准前提（distributed:false）失效：已 approved 的条目覆盖到生产依赖时，批准不得沿用。
// 这条规则由 tools/lib/collect.mjs 的 approvalOutOfScope() 实现，是代码不是注释。
function caseApprovalScope(c) {
  const run = runScan('scope');
  const { report } = run;
  c.useCase('license-scope（approved 但成了生产依赖 → 批准前提失效）');
  c.check('退出码', run.exitCode, 2);
  c.checkTrue('报告已写出', report && !report.parseError);
  if (!report) return c;

  c.check('闭包总量', report.summary.total, 2);
  c.check('生产依赖', report.summary.prod, 2);
  c.check('判定 allowed', report.summary.byVerdict.allowed, 1);
  c.check('判定 review-required', report.summary.byVerdict['review-required'], 1);
  c.check('判定 forbidden', report.summary.byVerdict.forbidden, 0);
  c.check('判定 unknown', report.summary.byVerdict.unknown, 0);
  // 三档标签不能压成两档：它既不是「未登记」也不是「等待裁定」，而是「批准已失效」。
  c.check('未登记待裁定', report.summary.unregisteredReviewRequired, []);
  c.check('已登记待裁定', report.summary.pendingAdjudication, []);
  c.check('批准前提失效清单', report.summary.approvalsOutOfScope, [
    {
      package: 'minimatch@10.2.6',
      adjudication: 'minimatch-blueoak-1.0.0',
      reason:
        '裁定 minimatch-blueoak-1.0.0 的前提是 distributed:false（不随产物分发），但它现在是生产依赖',
    },
  ]);

  const minimatch = c.entry(report, 'minimatch', '10.2.6');
  c.check('批准未被沿用，判定退回 review-required', minimatch?.verdict, 'review-required');
  c.check('裁定条目仍是 approved（失效不等于被改掉）', minimatch?.adjudication?.status, 'approved');
  c.check('生产依赖身份', minimatch?.kind, 'prod');
  c.checkTrue('失效原因点名前提', String(minimatch?.adjudication?.outOfScope).includes('distributed:false'));
  c.check('对照项仍为 allowed', c.entry(report, 'zod', '4.6.7')?.verdict, 'allowed');

  // 三处留痕都要能看出「这条要重裁」，而且要与 MISSING / pending 区分开。
  c.checkTrue('stdout 点名批准已失效', run.stdout.includes('批准前提已失效'));
  c.checkTrue('stdout 点名包', run.stdout.includes('minimatch@10.2.6'));
  c.checkTrue('待裁定清单文件已写出', run.listed);
  c.checkTrue('清单文件标 STALE', run.listBody.includes('STALE'));
  c.checkTrue('清单文件未误标 MISSING', !run.listBody.includes('MISSING'));
  c.checkTrue('step summary 标批准已失效', run.stepSummary.includes('**批准已失效**'));

  // 对照的一半：同一条裁定改成 distributed:true（其余字节不动），批准前提就成立了，
  // 同一份夹具必须回到 0。这一红一绿合起来才证明规则判的是 distributed 这个前提，
  // 而不是「凡是生产依赖里的 reviewRequired 一律判红」—— 后者同样会让上面变红，
  // 却抓不住真正的失效场景（批准跟着依赖搬进产物）。
  const distributed = derivePolicy('minimatch-blueoak-1.0.0', { distributed: true });
  c.checkDerived(distributed);
  const green = runScan('scope', { derived: distributed });
  c.useCase('license-scope + 派生策略 distributed:true（前提成立 → 批准生效）');
  c.check('退出码', green.exitCode, 0);
  c.check('判定 allowed', green.report?.summary.byVerdict.allowed, 2);
  c.check('判定 review-required', green.report?.summary.byVerdict['review-required'], 0);
  c.check('批准前提失效', green.report?.summary.approvalsOutOfScope, []);
  c.check('已批准的生产依赖被放行', c.entry(green.report, 'minimatch', '10.2.6')?.verdict, 'allowed');
  c.checkTrue('无待裁定清单', !green.listed);

  // pending-architect 的判别力：非 strict 下留痕但放行，--strict 下判红。
  // 这份对照必须落在「退出码会真的从 0 变 2」的夹具上，否则证明不了 --strict 有作用。
  const pending = derivePolicy('minimatch-blueoak-1.0.0', { distributed: true, status: 'pending-architect' });
  c.checkDerived(pending);
  const loose = runScan('scope', { derived: pending });
  c.useCase('license-scope + 派生策略 pending-architect（留痕但不判死）');
  c.check('退出码', loose.exitCode, 0);
  c.check('判定仍为 review-required（pending 不放行）', c.entry(loose.report, 'minimatch', '10.2.6')?.verdict, 'review-required');
  c.check('已登记待裁定', loose.report?.summary.pendingAdjudication, ['minimatch@10.2.6']);
  c.check('批准前提失效', loose.report?.summary.approvalsOutOfScope, []);
  c.checkTrue('待裁定清单文件已写出', loose.listed);
  c.checkTrue('清单文件标 pending', loose.listBody.includes('pending'));
  c.checkTrue('step summary 含待裁定表', loose.stepSummary.includes('minimatch@10.2.6'));
  c.checkTrue('stdout 点名等待裁定', loose.stdout.includes('等待架构师裁定'));

  const strict = runScan('scope', { derived: pending, extraArgs: ['--strict'] });
  c.useCase('license-scope + 派生策略 pending-architect --strict（同一份夹具 0 → 2）');
  c.check('退出码', strict.exitCode, 2);
  c.checkTrue('--strict 说明理由', strict.stdout.includes('--strict'));
  return c;
}

// 裁定状态机的另外两档：pending 不放行（已在 caseApprovalScope 覆盖判别力，这里覆盖字段），
// rejected 直接判死。没有 rejected 这一条，「approved 就放行」与「登记了就放行」两种
// 坏实现在本控制用例下都能通过。
function caseAdjudicationStatuses(c) {
  const pending = derivePolicy('minimatch-blueoak-1.0.0', { status: 'pending-architect' });
  c.checkDerived(pending);
  const run = runScan('review', { derived: pending });
  const { report } = run;
  c.useCase('license-review + 派生策略 pending-architect');
  c.check('退出码', run.exitCode, 2);
  const minimatch = c.entry(report, 'minimatch', '10.2.6');
  c.check('pending 不抬判定', minimatch?.verdict, 'review-required');
  c.check('裁定状态', minimatch?.adjudication?.status, 'pending-architect');
  c.check('已登记待裁定', report?.summary.pendingAdjudication, ['minimatch@10.2.6']);
  c.check('批准前提失效', report?.summary.approvalsOutOfScope, []);
  c.checkTrue('清单文件标 pending', run.listBody.includes('pending'));

  const rejected = derivePolicy('minimatch-blueoak-1.0.0', { status: 'rejected' });
  c.checkDerived(rejected);
  const dead = runScan('review', { derived: rejected });
  c.useCase('license-review + 派生策略 rejected（裁定驳回 → 判死）');
  c.check('退出码', dead.exitCode, 1);
  c.check('判定 forbidden', dead.report?.summary.byVerdict.forbidden, 1);
  c.check('被驳回项', dead.report?.summary.forbidden, ['minimatch@10.2.6']);
  c.check('被驳回项判定', c.entry(dead.report, 'minimatch', '10.2.6')?.verdict, 'forbidden');
  c.checkTrue('stdout 点名禁止项', dead.stdout.includes('minimatch@10.2.6'));
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
  // 这份夹具刻意不带注册表事实快照，走的是同族推断分支（快照分支由 ok/ 覆盖）。
  const conflict = c.entry(report, 'conflictfamily-win32-x64', '3.0.0');
  c.check('兄弟矛盾 → 无表达式', conflict?.expression, null);
  c.check('兄弟矛盾 → unknown', conflict?.verdict, 'unknown');
  c.check('兄弟自身仍合规', c.entry(report, 'conflictfamily-linux-x64', '3.0.0')?.verdict, 'allowed');
  c.check('兄弟推断的来源', c.entry(report, 'conflictfamily-linux-x64', '3.0.0')?.licenseSource, 'installed-manifest');

  c.checkTrue('stdout 点名禁止项', run.stdout.includes('unlicensedfixture@1.0.0'));
  return c;
}

function caseOkStrict(c) {
  const run = runScan('ok', { extraArgs: ['--strict'] });
  c.useCase('license-ok --strict');
  c.check('退出码', run.exitCode, 0);
  return c;
}

// ── §6.1：线上配置本身的两条可染红对照 ────────────────────────────────────────────
// 前面六个用例证明的是**规则实现**有效（夹具闭包 + 线上策略）。下面两条证明的是
// ZLQ-190 §6.3 那两件**线上配置**承重：新增的 caniuse-lite 精确裁定，与
// pnpm-workspace.yaml 里摘掉 sharp 的精确 override。删掉任一件，门禁必须红，
// 而且红在能指认原因的地方 —— 「删了裁定也照样绿」正是 §6.1 要这条控制去堵的洞。
//
// 这两条跑在真实闭包上（不是夹具）：承重的对象是线上配置与真实 lockfile，
// 换成夹具就等于换掉了被对照的东西。
//
// 「控制断言按声明表推导，不抄实测总数」：下面没有任何一处写死闭包总量、包版本或
// 许可证档位。包名与精确版本取自线上策略的 match 字段，next 版本取自本次扫描的
// 实际解析结果，LGPL 家族取自策略的 reviewRequired.exact。

// 声明表：本切片承重的裁定**对象**，只写不随依赖升级变化的事实 —— 包名、许可类、
// §6.3 登记的批准前提、生产依赖身份。刻意**不写** version 与裁定条目 id：
// 两者都是观测量。把 `1.0.30001816` 抄进来会让「框架升级后必须重新裁定」失去对照 ——
// 升级之后先红在一个过期常量上，而不是红在「旧裁定失配」这个真正的原因上；
// 把 id 抄进来更糟：条目一旦不在策略里，这里会**抛异常**，控制用例退化成
// 「崩溃 → 退出码 1」，看起来像门禁变红了，实际上什么也没证明。
// 所以 version 与 id 一律从**本次真实扫描的报告**里反查，反查不到就是一条 FAIL 断言。
const SLICE_ADJUDICATIONS = [
  { name: 'caniuse-lite', license: 'CC-BY-4.0', distributed: true, kind: 'prod' },
];

function caseSliceAdjudication(c) {
  const policy = readRealPolicy();
  const run = runRealScan();
  c.useCase('license-scan（真实闭包 + 线上裁定 → 期望退出码 0）');
  c.check('退出码', run.exitCode, 0);
  c.checkTrue('报告已写出', run.report && !run.report.parseError);
  if (!run.report) return c;

  for (const declared of SLICE_ADJUDICATIONS) {
    // 报告的字段是 `entries`；不用 Checker.entry() 是因为那个助手要求调用方**先知道版本**，
    // 而这里版本必须由扫描结果给出，否则「声明表里的版本」与「闭包里的版本」哪个过期就无从分辨。
    const matches = (run.report.entries ?? []).filter((item) => item.name === declared.name);
    const found = matches.length === 1 ? matches[0] : null;
    const label = found ? `${found.name}@${found.version}` : `${declared.name}@<未唯一定位>`;
    const id = found?.adjudication?.id ?? null;

    c.useCase(`裁定承重：${label}${id ? `（${id}）` : ''}`);
    // 先证明对照非空：包不在闭包里的话，下面每一条都会因为「没有 reviewRequired」而假绿。
    // 断「恰好一个版本」而不是「至少一个」：裁定是精确版本的，闭包里若同时存在两个
    // caniuse-lite，未被裁定的那个本来就该把门禁顶红，这里含糊过去就等于放行。
    c.check(`${declared.name} 在真实闭包里的版本数`, matches.length, 1);
    c.checkTrue(`${declared.name} 已被唯一定位`, found !== null);
    if (!found) continue;

    // 「这个包靠一条精确裁定过关」是本案的正命题。id 为 null 说明裁定已经不在册，
    // 此时上面那条 `退出码 = 0` 已经先红了 —— 这里再红一次，把原因写在断言里，
    // 而不是让整份控制用例抛异常收场。
    c.checkTrue('有裁定条目在册（不是靠放宽档位通过的）', id !== null);
    c.check('被裁定抬到 allowed', found.verdict, 'allowed');
    c.check('许可表达式与声明的许可类一致', found.expression, declared.license);
    c.check('裁定状态', found.adjudication?.status, 'approved');
    c.check('批准前提写进报告', found.adjudication?.distributed, declared.distributed);
    c.check('批准前提未失效', found.adjudication?.outOfScope, null);
    // distributed:true 是 §6.3 的保守口径。它让 approvalOutOfScope() 对这条恒不触发，
    // 于是「它只在构建期被读、数据没进产物」不会变成放行的隐含前提 —— 署名许可的
    // 放行理由必须是「归属已公开」，不是「反正没分发」。
    c.check('生产依赖身份（所以 distributed:true 是承重的）', found.kind, declared.kind);

    if (id !== null) {
      const matched = (policy.adjudications?.entries ?? []).find((item) => item.id === id);
      c.checkTrue(`策略里能按报告给出的 id 找回这条裁定（${id}）`, matched !== null);
      // §6.3 的批准是**精确版本**的。这两条就是「精确」二字的对照：
      // 报告反查出来的 id 必须只认这个名字、这个版本，不能是 `names:['*']` 之类的宽口。
      c.check('裁定只认这个包名', matched?.match?.names, [declared.name]);
      c.check('裁定只认这个精确版本', matched?.match?.versions, [found.version]);
      c.check('裁定登记的许可类与声明一致', matched?.license, declared.license);
    }

    // 裁定不得顺手放宽档位：许可类仍留在 reviewRequired，不进六项白名单。
    // 少了这两条，「把 CC-BY-4.0 加进 allowed」也能让上面全绿，而那是 §6.3 明确禁止的解法。
    c.checkTrue(
      `档位未放宽：${declared.license} 仍在 reviewRequired.exact`,
      policy.reviewRequired.exact.includes(declared.license),
    );
    c.checkTrue(
      `档位未放宽：${declared.license} 不在 allowed 白名单`,
      !policy.allowed.includes(declared.license),
    );

    if (id === null) continue;

    // 红的一半 A：整条裁定消失（= 框架升级后精确版本失配的最坏形态）→ 必须退回待裁定。
    const removed = derivePolicyWithout(id);
    c.checkDerived(removed);
    const soft = runRealScan({ derived: removed });
    c.useCase(`删除裁定 ${id} → 门禁必须红（待裁定，不是判死）`);
    c.check('退出码', soft.exitCode, 2);
    c.check('逐条退回未登记待裁定', soft.report?.summary.unregisteredReviewRequired, [label]);
    c.check(
      '报告里不再列出这条裁定',
      (soft.report?.policy.adjudications ?? []).some((item) => item.id === id),
      false,
    );
    c.check('批准前提失效清单仍为空（这是「没人裁定」，不是「批准过期」）', soft.report?.summary.approvalsOutOfScope, []);
    c.checkTrue('stdout 点名', soft.stdout.includes(label));
    c.checkTrue('待裁定清单文件已写出', soft.listed);
    c.checkTrue('清单文件标 MISSING', soft.listBody.includes('MISSING'));
    c.checkTrue('step summary 点名', soft.stepSummary.includes(label));

    // 红的一半 B：裁定被驳回 → 必须从 2 变 1。少了这一条，「删掉裁定」与「驳回裁定」
    // 在门禁看来就没区别，而它们的人工处理动作完全不同（重裁 vs 换依赖）。
    const rejected = derivePolicy(id, { status: 'rejected' });
    c.checkDerived(rejected);
    const dead = runRealScan({ derived: rejected });
    c.useCase(`裁定 ${id} 改为 rejected → 退出码必须从 2 变 1`);
    c.check('退出码', dead.exitCode, 1);
    c.check('判死清单', dead.report?.summary.forbidden, [label]);
    c.checkTrue('stdout 点名禁止项', dead.stdout.includes(label));
  }
  return c;
}

// sharp 家族的匹配规则（声明表）。三条各自独立：pnpm 的 override 只摘掉了入口包，
// 真正要挡住的是它拖进来的那一串平台二进制。
const SHARP_FAMILY = [
  { test: (name) => name === 'sharp', why: 'sharp 本体：自身 Apache-2.0，但它是 libvips 家族的入口' },
  { test: (name) => name.startsWith('@img/'), why: '@img/sharp-* 与 @img/sharp-libvips-*：libvips 预编译平台二进制（LGPL 家族）' },
  { test: (name) => name.includes('libvips'), why: 'libvips 本体（LGPL 家族）' },
];

function sharpFamilyHits(names) {
  return names
    .map((name) => ({ name, why: SHARP_FAMILY.find((rule) => rule.test(name))?.why ?? null }))
    .filter((item) => item.why !== null);
}

// libvips 家族在 SPDX 上的全部写法。这是声明表，断言则由策略的 reviewRequired.exact 推导：
// 「这个家族一旦回来会红」不是靠嘴说，而是靠它命中的档位。
const LIBVIPS_LICENSES = [
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-2.1',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'LGPL-3.0',
];

function caseSharpOverride(c) {
  // 反空对照：家族匹配器必须**能**命中东西，否则「闭包里没有 sharp」是 0 进 0 出的空断言，
  // 把三条规则全删掉它照样通过。探针里 'sharp-axe' 是反向判别项：写成 /sharp/ 就会误命中。
  const PROBE = [
    'sharp',
    '@img/sharp-linux-x64',
    '@img/sharp-libvips-linux-x64',
    'libvips',
    'sharp-axe',
    'zod',
    'next',
  ];
  c.useCase('sharp 家族匹配器的反空对照');
  c.check(
    '匹配器命中该命中的、放过该放过的',
    sharpFamilyHits(PROBE).map((item) => item.name),
    ['sharp', '@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64', 'libvips'],
  );

  const run = runRealScan();
  const entries = run.report?.entries ?? [];
  c.useCase('sharp override 承重（真实闭包里必须一个家族成员都没有）');
  c.check('退出码', run.exitCode, 0);
  c.check('真实闭包里没有 sharp/libvips 家族', sharpFamilyHits(entries.map((item) => item.name)), []);

  // override 必须精确到**当前解析出来的** next 版本：版本从本次报告里读，不写死。
  // next 升级而 override 键没跟上 → 这条对照红，而 pnpm 会因为键失配静默不生效。
  const next = entries.find((item) => item.name === 'next');
  c.checkTrue('闭包里读得到 next 的解析版本', Boolean(next?.version));
  const expectedOverride = `'next@${next?.version}>sharp': '-'`;
  const workspaceYaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const overrideLine = workspaceYaml
    .split('\n')
    .find((line) => line.includes(expectedOverride));
  c.useCase(`override 在册且精确：${expectedOverride}`);
  c.checkTrue('pnpm-workspace.yaml 里有这条 override', overrideLine !== undefined);
  c.checkTrue(
    'override 不是被注释掉的',
    overrideLine !== undefined && !overrideLine.trimStart().startsWith('#'),
  );
  // pnpm 12 只 WARN 不报错地忽略 package.json 的 `pnpm` 字段：override 挪过去等于删掉它。
  const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  c.check(
    'override 没被挪到 pnpm 12 不读的 package.json#pnpm 字段',
    rootManifest.pnpm?.overrides ?? null,
    null,
  );

  // 「家族回来了会红」的另一半前提：档位没被放宽，而且没有任何裁定条目静默放行它。
  // §6.3 要求的是「通过精确 override 移除，而不是静默批准」。
  const policy = readRealPolicy();
  c.useCase('sharp 家族没有被静默批准');
  c.check(
    'libvips 的 LGPL 全档仍在 reviewRequired.exact',
    LIBVIPS_LICENSES.filter((id) => policy.reviewRequired.exact.includes(id)),
    LIBVIPS_LICENSES,
  );
  const adjudicatedNames = (policy.adjudications?.entries ?? []).flatMap((entry) => [
    ...(entry.match?.names ?? []),
    ...(entry.match?.prefixes ?? []),
  ]);
  c.check('家族未出现在任何裁定条目里', sharpFamilyHits(adjudicatedNames), []);
  // 「LGPL 进了闭包 → review-required → 退出码 2」这半条不由本用例重复证明：caseReview 的
  // lgplfixture@1.1.0 已经在同一份线上策略下把它判红了。本用例证明的是另一半 ——
  // 这个家族此刻不在闭包里，而让它不在的那条 override 精确、在册、没被挪走。
  return c;
}

// 用例名固定在这里，不取 c.caseName：一个用例内部会切换子场景（派生策略、--strict 复跑），
// 取「最后一次 useCase 的名字」会让汇总表贴错标签。
const CASES = [
  { label: 'license-ok（全白名单 + 平台变体走快照 → 期望退出码 0）', fn: caseOk },
  { label: 'license-review（未登记 reviewRequired → 期望退出码 2，已批准 dev 依赖放行）', fn: caseReview },
  {
    label: 'license-scope（approved 成了生产依赖 → 期望 2；派生 distributed:true → 0；派生 pending → 0，--strict → 2）',
    fn: caseApprovalScope,
  },
  { label: 'license-review + 派生策略（pending → 2；rejected → 1）', fn: caseAdjudicationStatuses },
  { label: 'license-violation（禁止/未知 → 期望退出码 1）', fn: caseViolation },
  { label: 'license-ok --strict（无待裁定 → 期望退出码 0）', fn: caseOkStrict },
  {
    label:
      '线上裁定承重（真实闭包 → 0；整条删除 → 2 并点名；改为 rejected → 1；档位未被放宽）',
    fn: caseSliceAdjudication,
  },
  {
    label: 'sharp override 承重（匹配器反空对照；真实闭包无家族成员；override 精确在册；家族未被静默批准）',
    fn: caseSharpOverride,
  },
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
    process.stdout.write(
      '派生策略：只改 adjudications.entries 的 status/distributed（或整条移除），其余字节与线上策略一致（已断言）\n',
    );
    process.stdout.write('线上配置对照：真实闭包（node_modules + pnpm 布局 + pnpm-lock.yaml），非夹具\n');
    for (const item of perCase) {
      process.stdout.write(`  ${item.failures === 0 ? 'OK  ' : 'FAIL'} ${item.case}\n`);
    }
    process.stdout.write(`断言 ${c.assertions} 条，失败 ${c.failures.length} 条\n`);
    for (const failure of c.failures) process.stdout.write(`!! ${failure}\n`);
    if (c.failures.length === 0) {
      process.stdout.write(
        '结论：三档退出码（0 / 2 / 1）与判定明细均符合预期，门禁不是「永远返回 0」；' +
          '批准前提失效与裁定状态机（pending / rejected）各有判别性对照；' +
          'ZLQ-190 §6.3 的两件线上配置（caniuse-lite 精确裁定、sharp override）各自可染红。\n',
      );
    }
  }
  process.exit(c.failures.length === 0 ? 0 : 1);
}

const invokedDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirect) main();

export { Checker, derivePolicy, derivePolicyWithout, runRealScan, runScan };

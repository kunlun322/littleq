// Docker 镜像许可证扫描（ZLQ-153 §10.3 的第三个扫描目标）。
//
// 现状：**未接通**。镜像形态由 ZLQ-157（形态 A：Docker Compose 编排）交付，本仓库现在
// 没有任何 Dockerfile，也就没有镜像可扫。config/license-policy.json 里
// scanTargets.dockerImage.enabled=false 是这一事实的登记，不是可以悄悄跳过的开关。
//
// 但「留个 TODO 注释」等于没做，所以本脚本把能做的两半拆开：
//
//   提取半（--image）：调用 cdxgen/trivy 从镜像产出 CycloneDX SBOM。工具不在 PATH 上就
//     以退出码 4 失败并点名缺失的工具与阻塞任务，绝不假装扫过。
//   判定半（--from）：拿到任意 CycloneDX JSON（镜像 SBOM、或测试夹具）后，逐组件套用与
//     scan.mjs 完全相同的策略与退出码契约。这半是完整实现且有夹具覆盖的，ZLQ-157 接通
//     提取半之后无需再改判定逻辑。
//
// 退出码：0 全部合规或已登记；1 命中禁止/未知；2 命中 reviewRequired 但未登记裁定；
//         3 policy 声明 enabled=false 却传了 --require-enabled；4 提取工具不可用。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateExpression } from '../lib/spdx.mjs';
import { ADJUDICATION_APPROVED, ADJUDICATION_REJECTED, findAdjudication, npmLink } from '../lib/collect.mjs';
import { VERDICT_ALLOWED, VERDICT_FORBIDDEN, VERDICT_REVIEW, VERDICT_UNKNOWN } from '../lib/spdx.mjs';

const EXTRACTORS = [
  { tool: 'cdxgen', args: (image, out) => ['-o', out, '--type', 'oci', image] },
  { tool: 'trivy', args: (image, out) => ['image', '--format', 'cyclonedx', '--output', out, image] },
];

function parseArgs(argv) {
  const args = {
    repoRoot: process.cwd(),
    policy: 'config/license-policy.json',
    image: null,
    from: null,
    out: 'artifacts/image-license-report.json',
    requireEnabled: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--image') args.image = argv[++i];
    else if (flag === '--from') args.from = argv[++i];
    else if (flag === '--policy') args.policy = argv[++i];
    else if (flag === '--repo-root') args.repoRoot = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--require-enabled') args.requireEnabled = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`未知参数：${flag}`);
  }
  args.repoRoot = resolve(args.repoRoot);
  return args;
}

const HELP = `用法：node tools/license/image-scan.mjs [选项]

  --image <ref>        扫描镜像（需要 cdxgen 或 trivy 在 PATH 上）
  --from <file>        跳过提取，直接判定一份 CycloneDX JSON（测试/离线）
  --policy <file>      许可策略（默认 config/license-policy.json）
  --repo-root <dir>    仓库根目录（默认当前目录）
  --out <file>         报告输出（默认 artifacts/image-license-report.json）
  --require-enabled    policy 声明未启用时直接失败（退出码 3），供 ZLQ-157 接通后使用
  --json               以 JSON 打印结果

退出码：0 合规 / 1 禁止或未知 / 2 待裁定未登记 / 3 未启用却被要求启用 / 4 提取工具缺失
`;

// 镜像 SBOM 的许可证字段常见三种形态：{license:{id}}、{license:{name}}、{expression}。
// 免费文本（name）也要过一遍禁止子串，否则「SEE LICENSE IN …」这类会被当成未知而放行。
function componentExpressions(component) {
  const out = [];
  // CycloneDX 的 licenses 是一个「二选一」：要么是数组，要么是 {expression} 对象。
  // 对象形态不可迭代，直接 for-of 会抛 TypeError —— 那正是 cdxgen 对
  // `(MIT OR Apache-2.0)` 这类复合表达式的输出形态，扫到第一个就整份报告崩掉。
  const licenses = component.licenses;
  if (licenses && !Array.isArray(licenses)) {
    if (licenses.expression) out.push(licenses.expression);
  }
  for (const item of Array.isArray(licenses) ? licenses : []) {
    const license = item.license;
    if (!license) continue;
    if (license.id) out.push(license.id);
    if (license.name) out.push(license.name);
  }
  const evidenceLicenses = component.evidence?.licenseData?.licenses;
  if (evidenceLicenses && !Array.isArray(evidenceLicenses)) {
    if (evidenceLicenses.expression) out.push(evidenceLicenses.expression);
  }
  for (const item of Array.isArray(evidenceLicenses) ? evidenceLicenses : []) {
    if (item?.license?.id) out.push(item.license.id);
    if (item?.license?.name) out.push(item.license.name);
  }
  return out;
}

function evaluateComponents(bom, policy) {
  const components = bom.components ?? [];
  // 自有工作区包以 AGPL-3.0-only 发布，而 AGPL-3.0-only 恰好在 reviewRequired 名单里
  // （第三方拿 AGPL 确实要送裁定）。cdxgen/trivy 产出的镜像 SBOM 会把应用自身也列为组件，
  // 不豁免的话本仓库自己的四个包会被判成「待裁定未登记」，把门禁顶在退出码 2 上。
  // 与 tools/lib/license-resolve.mjs 的 ownPackages 分支保持同一条规则。
  const ownNames = new Set(policy.ownPackages?.names ?? []);
  const rows = components.map((component) => {
    const expressions = componentExpressions(component);
    if (ownNames.has(component.name)) {
      return {
        name: component.name,
        version: component.version,
        purl: component.purl ?? null,
        expressions,
        ids: [],
        verdict: VERDICT_ALLOWED,
        own: true,
        adjudication: null,
        link: null,
      };
    }
    const evaluations = expressions.map((expression) => evaluateExpression(expression, policy));
    const rank = { [VERDICT_ALLOWED]: 0, [VERDICT_REVIEW]: 1, [VERDICT_UNKNOWN]: 2, [VERDICT_FORBIDDEN]: 3 };
    const worst = evaluations.reduce(
      (acc, item) => (rank[item.verdict] > rank[acc.verdict] ? item : acc),
      { verdict: expressions.length ? VERDICT_ALLOWED : VERDICT_UNKNOWN, ids: [], exceptions: [], unknownExceptions: [] },
    );
    const entry = { name: component.name, version: component.version };
    const adjudication = findAdjudication(entry, policy);
    let verdict = worst.verdict;
    if (adjudication?.status === ADJUDICATION_APPROVED && verdict === VERDICT_REVIEW) verdict = VERDICT_ALLOWED;
    if (adjudication?.status === ADJUDICATION_REJECTED) verdict = VERDICT_FORBIDDEN;

    return {
      ...entry,
      purl: component.purl ?? null,
      expressions,
      ids: [...new Set(evaluations.flatMap((item) => item.ids))],
      verdict,
      own: false,
      adjudication: adjudication ? { id: adjudication.id, status: adjudication.status } : null,
      link: npmLink(component.name, component.version),
    };
  });

  const needsAdjudication = rows.filter(
    (row) => row.verdict === VERDICT_REVIEW && row.adjudication?.status !== ADJUDICATION_APPROVED,
  );
  return {
    rows,
    summary: {
      total: rows.length,
      own: rows.filter((r) => r.own).length,
      thirdParty: rows.filter((r) => !r.own).length,
      byVerdict: {
        allowed: rows.filter((r) => r.verdict === VERDICT_ALLOWED).length,
        'review-required': rows.filter((r) => r.verdict === VERDICT_REVIEW).length,
        forbidden: rows.filter((r) => r.verdict === VERDICT_FORBIDDEN).length,
        unknown: rows.filter((r) => r.verdict === VERDICT_UNKNOWN).length,
      },
      unregistered: needsAdjudication.filter((r) => !r.adjudication).map((r) => `${r.name}@${r.version}`),
      needsAdjudication: needsAdjudication.map((r) => `${r.name}@${r.version}`),
    },
  };
}

function extract(image, outFile) {
  for (const extractor of EXTRACTORS) {
    const probe = spawnSync(extractor.tool, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (probe.error || probe.status !== 0) continue;
    const run = spawnSync(extractor.tool, extractor.args(image, outFile), {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (run.status !== 0) {
      throw Object.assign(new Error(`${extractor.tool} 提取镜像 SBOM 失败：${(run.stderr || run.stdout || '').trim()}`), {
        code: 4,
      });
    }
    return { tool: extractor.tool, bom: JSON.parse(readFileSync(outFile, 'utf8')) };
  }
  const names = EXTRACTORS.map((item) => item.tool).join(' / ');
  throw Object.assign(
    new Error(
      `PATH 上找不到 ${names}，无法从镜像提取 SBOM。` +
        `镜像扫描由 ZLQ-157（形态 A：Docker 编排）接通：先产出镜像，再在 CI 的 image 作业里安装 ${names} 之一，` +
        `并把 config/license-policy.json 的 scanTargets.dockerImage.enabled 改为 true。`,
    ),
    { code: 4 },
  );
}

function writeStepSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  writeFileSync(file, `${lines.join('\n')}\n`, { flag: 'a' });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  // resolve 而不是 join：--policy 允许传绝对路径（测试夹具就是这么用的），
  // 而 join(repoRoot, '/abs/path') 会把两段拼成 <repoRoot>/abs/path 然后 ENOENT。
  const policyPath = resolve(args.repoRoot, args.policy);
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const target = policy.scanTargets?.dockerImage ?? {};
  const disabled = target.enabled === false;

  // --from 是显式的「验证判定逻辑」入口：即使镜像作业仍登记为未启用，也照跑。
  // 没有它，下面那句「可用 --from 验证」就是一句做不到的承诺；有了它，ZLQ-157 接通镜像
  // 之前就能拿一份现成的 CycloneDX（例如 artifacts/sbom.cdx.json）把判定链路试一遍。
  if (disabled && !args.from) {
    const lines = [
      '== 镜像许可证扫描：未启用（已登记的延后项，不是静默跳过）==',
      `阻塞于：${target.blockedBy ?? '<未登记>'}`,
      `待办：${target.todo ?? '<未登记>'}`,
      `登记位置：${args.policy} → scanTargets.dockerImage`,
      '本仓库当前没有 Dockerfile，也没有镜像可扫。判定逻辑已实现：',
      '  node tools/license/image-scan.mjs --from artifacts/sbom.cdx.json',
      '可在不启用镜像作业的前提下验证它（此时输出会显式标注「策略仍为未启用」）。',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    writeStepSummary(['### 镜像许可证扫描', '', `**未启用** — 阻塞于 ${target.blockedBy ?? '?'}`, '', target.todo ?? '']);
    if (args.requireEnabled) {
      process.stderr.write('!! 传入了 --require-enabled，但策略仍声明 dockerImage.enabled=false：请先接通 ZLQ-157 再要求启用。\n');
      return 3;
    }
    return 0;
  }

  if (!args.image && !args.from) {
    process.stderr.write('!! 需要 --image <ref> 或 --from <cyclonedx.json>\n');
    return 1;
  }

  const outFile = resolve(args.repoRoot, args.out);
  mkdirSync(dirname(outFile), { recursive: true });
  let bom;
  let extractor = 'from-file';
  if (args.from) {
    bom = JSON.parse(readFileSync(resolve(args.repoRoot, args.from), 'utf8'));
  } else {
    const sbomPath = join(dirname(outFile), 'image-sbom.cdx.json');
    const extracted = extract(args.image, sbomPath);
    bom = extracted.bom;
    extractor = extracted.tool;
  }

  const { rows, summary } = evaluateComponents(bom, policy);
  writeFileSync(outFile, `${JSON.stringify({ image: args.image, extractor, policy: args.policy, summary, rows }, null, 2)}\n`, 'utf8');

  const exitCode = summary.byVerdict.forbidden + summary.byVerdict.unknown > 0
    ? 1
    : summary.unregistered.length > 0
      ? 2
      : 0;

  const lines = [
    `== 镜像许可证扫描：${args.image ?? relative(args.repoRoot, resolve(args.repoRoot, args.from))} ==`,
    `提取方式：${extractor}；组件 ${summary.total} 个（自有 ${summary.own} + 第三方 ${summary.thirdParty}）`,
    `裁定：允许 ${summary.byVerdict.allowed}，待架构师 ${summary.byVerdict['review-required']}，禁止 ${summary.byVerdict.forbidden}，未知 ${summary.byVerdict.unknown}`,
    `报告：${relative(args.repoRoot, outFile)}`,
  ];
  if (disabled) {
    // 跑通不等于接通：策略里镜像作业仍是 enabled=false，输出必须把这件事说清楚，
    // 否则一次 --from 验证会被误读成「镜像扫描已上线」。
    lines.unshift(
      `>> 注意：${args.policy} 里 scanTargets.dockerImage.enabled 仍是 false（阻塞于 ${target.blockedBy ?? '?'}）。` +
        '本次是显式 --from 验证，不代表镜像作业已接通。',
    );
  }
  if (summary.unregistered.length) {
    lines.push(`!! ${summary.unregistered.length} 项命中 reviewRequired 但未在 adjudications 登记：${summary.unregistered.join(', ')}`);
    lines.push('   处理：在 config/license-policy.json 的 adjudications.entries 增加登记并提请架构师裁定，不得直接放宽 allowed。');
  }
  for (const row of rows.filter((item) => item.verdict === VERDICT_FORBIDDEN || item.verdict === VERDICT_UNKNOWN)) {
    lines.push(`!! ${row.name}@${row.version} → ${row.verdict}（${row.expressions.join(' | ') || '无许可证声明'}）${row.link}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  writeStepSummary(['### 镜像许可证扫描', '', '```', ...lines, '```']);
  return exitCode;
}

const invokedDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirect) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`!! 镜像许可证扫描失败：${error.message}\n`);
    process.exitCode = error.code === 4 ? 4 : 1;
  }
}

export { componentExpressions, evaluateComponents, EXTRACTORS };

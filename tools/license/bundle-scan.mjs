#!/usr/bin/env node
// 最终 web bundle 的许可证门禁（ZLQ-153 §10.2 / §10.3 的第二处扫描目标）。
//
// 源码依赖扫描（scan.mjs）证明「我们引入了什么」，本扫描证明「真正被打包进产物的是什么」——
// 两者不等价：tree-shaking 会剔除大量依赖，而一个未被 lockfile 审计过的包一旦进入 bundle，
// 就是随产品分发的未审计代码。因此本扫描做四件事：
//   1. 从 esbuild metafile 还原 bundle 内每个第三方包，逐个套用同一份许可策略；
//   2. 交叉校验：bundle 里的包必须都在 lockfile 闭包内，否则失败（防止绕过审计的产物）；
//   3. 生成 <bundle>.licenses.txt —— §10.2 要求的 /licenses.txt 的构建期来源；
//   4. 校验 legalComments:'inline' 确实生效：输入里的每个 /*! ... */ 法务注释都必须原样出现在
//      压缩后的产物中（配置本身也被机器校验，见 *.options.json）。
//
// 退出码与 scan.mjs 一致：0 通过；1 硬性失败；2 出现未登记的 reviewRequired。
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collect, ADJUDICATION_PENDING, VERDICT_FORBIDDEN, VERDICT_REVIEW, VERDICT_UNKNOWN } from '../lib/collect.mjs';
import { evaluateExpression } from '../lib/spdx.mjs';
import { LICENSE_FILE_PATTERN, manifestToExpression } from '../lib/license-resolve.mjs';

const LEGAL_COMMENT_PATTERN = /\/\*![\s\S]*?\*\//g;

function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), bundlesDir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--repo-root') args.repoRoot = resolve(argv[(i += 1)]);
    else if (token === '--bundles-dir') args.bundlesDir = resolve(argv[(i += 1)]);
    else if (token === '--json') args.json = true;
    else throw new Error(`未知参数：${token}`);
  }
  args.bundlesDir ??= join(args.repoRoot, 'artifacts', 'bundles');
  return args;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// metafile 的 input 路径形如 node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/util.js。
// 取最后一个 /node_modules/ 之后的前 1~2 段即为包目录。
function packageDirOf(repoRoot, inputPath) {
  const marker = '/node_modules/';
  const normalized = inputPath.startsWith('node_modules/') ? `/${inputPath}` : inputPath;
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const prefix = normalized.slice(0, index + marker.length);
  const rest = normalized.slice(index + marker.length).split('/');
  const segments = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  if (segments.length === 0 || segments.some((segment) => !segment)) return null;
  return join(repoRoot, prefix, ...segments);
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function scanBundle({ name, repoRoot, bundlesDir, closure, policy }) {
  const metafile = join(bundlesDir, `${name}.meta.json`);
  const outfile = join(bundlesDir, `${name}.js`);
  const optionsFile = join(bundlesDir, `${name}.options.json`);
  for (const required of [metafile, outfile]) {
    if (!existsSync(required)) throw new Error(`缺少 ${required}，请先运行 pnpm bundles`);
  }

  const meta = readJson(metafile);
  const options = existsSync(optionsFile) ? readJson(optionsFile) : null;
  const output = readFileSync(outfile, 'utf8');

  // 1. 还原 bundle 内的第三方包
  const packages = new Map();
  const ownInputs = [];
  for (const inputPath of Object.keys(meta.inputs ?? {})) {
    const dir = packageDirOf(repoRoot, inputPath);
    if (!dir) {
      ownInputs.push(inputPath);
      continue;
    }
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) {
      ownInputs.push(inputPath);
      continue;
    }
    const manifest = readJson(manifestPath);
    const key = `${manifest.name}@${manifest.version}`;
    if (!packages.has(key)) {
      let licenseFile = null;
      for (const candidate of readdirSync(dir).sort()) {
        if (LICENSE_FILE_PATTERN.test(candidate)) {
          licenseFile = join(dir, candidate);
          break;
        }
      }
      packages.set(key, {
        name: manifest.name,
        version: manifest.version,
        expression: manifestToExpression(manifest),
        hasLicenseDeclaration: manifest.license !== undefined || manifest.licenses !== undefined,
        homepage: manifest.homepage ?? null,
        repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? null,
        licenseFile,
        inputCount: 0,
      });
    }
    packages.get(key).inputCount += 1;
  }

  // 2. 判定 + 与 lockfile 闭包交叉校验
  const evaluated = [];
  const untracked = [];
  for (const pkg of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const expression = pkg.expression ?? (pkg.hasLicenseDeclaration === false ? 'NOASSERTION' : null);
    const evaluation = expression
      ? evaluateExpression(expression, policy)
      : { verdict: VERDICT_UNKNOWN, ids: [], exceptions: [], unknownExceptions: [] };
    const inClosure = closure.some((item) => item.name === pkg.name && item.version === pkg.version);
    if (!inClosure) untracked.push(`${pkg.name}@${pkg.version}`);
    const adjudication = closure.find(
      (item) => item.name === pkg.name && item.version === pkg.version && item.adjudication,
    )?.adjudication;
    evaluated.push({ ...pkg, expression, verdict: evaluation.verdict, ids: evaluation.ids, inClosure, adjudication });
  }

  // 3. legalComments 生效校验
  const configProblems = [];
  if (!options) configProblems.push(`缺少 ${name}.options.json，无法确认打包配置（须由 pnpm bundles 生成）`);
  else {
    if (options.legalComments !== 'inline') configProblems.push(`legalComments=${options.legalComments}，必须为 inline`);
    if (options.minify !== true) configProblems.push(`minify=${options.minify}，产物必须压缩（否则本项断言不构成证明）`);
    if (options.bundle !== true) configProblems.push('bundle=false，未真正打包');
  }

  const inputLegalComments = [];
  for (const inputPath of Object.keys(meta.inputs ?? {})) {
    const absolute = join(repoRoot, inputPath);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8');
    LEGAL_COMMENT_PATTERN.lastIndex = 0;
    let match;
    while ((match = LEGAL_COMMENT_PATTERN.exec(source)) !== null) {
      inputLegalComments.push({ file: inputPath, text: match[0] });
    }
  }
  const normalizedOutput = normalize(output);
  const stripped = inputLegalComments.filter((item) => !normalizedOutput.includes(normalize(item.text)));

  return {
    name,
    outfile,
    bytes: Buffer.byteLength(output, 'utf8'),
    options,
    inputCount: Object.keys(meta.inputs ?? {}).length,
    ownInputCount: ownInputs.length,
    packages: evaluated,
    untracked,
    configProblems,
    legalComments: {
      foundInInputs: inputLegalComments.length,
      preserved: inputLegalComments.length - stripped.length,
      stripped,
      bannerPresent: Boolean(options?.bannerPresent) && output.includes('SPDX-License-Identifier: AGPL-3.0-only'),
    },
  };
}

// §10.2 的 /licenses.txt 构建期来源：每个被打包的第三方包一节，全文取自包内 LICENSE 文件。
function renderLicensesTxt(bundle) {
  const lines = [];
  lines.push(`LittleQ — "${bundle.name}" bundle third-party licenses`);
  lines.push('');
  lines.push('本产物以 AGPL-3.0-only 分发（Copyright (C) 2026 LittleQ contributors）。');
  lines.push(`下列 ${bundle.packages.length} 个第三方包被静态打包进本产物，按 ZLQ-153 §10.2 随产物提供其许可证声明。`);
  lines.push('由 tools/license/bundle-scan.mjs 生成，请勿手工编辑。');
  lines.push('');
  lines.push('='.repeat(78));
  lines.push('');
  for (const pkg of bundle.packages) {
    lines.push(`Package: ${pkg.name}`);
    lines.push(`Version: ${pkg.version}`);
    lines.push(`License: ${pkg.expression ?? '<未声明>'}`);
    if (pkg.homepage) lines.push(`Homepage: ${pkg.homepage}`);
    if (pkg.repository) lines.push(`Repository: ${pkg.repository}`);
    lines.push(`npm: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`);
    lines.push('');
    if (pkg.licenseFile) {
      lines.push(readFileSync(pkg.licenseFile, 'utf8').replace(/\s+$/, ''));
    } else {
      lines.push(`(包内未附带许可证全文，见上方 SPDX/npm 链接：https://spdx.org/licenses/${(pkg.ids[0] ?? 'NOASSERTION')}.html)`);
    }
    lines.push('');
    lines.push('-'.repeat(78));
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.bundlesDir)) {
    process.stderr.write(`!! 找不到 bundle 目录 ${args.bundlesDir}，请先运行 pnpm bundles\n`);
    process.exit(1);
  }
  const names = readdirSync(args.bundlesDir)
    .filter((file) => file.endsWith('.meta.json'))
    .map((file) => file.replace(/\.meta\.json$/, ''))
    .sort();
  if (names.length === 0) {
    process.stderr.write(`!! ${args.bundlesDir} 内没有 *.meta.json，请先运行 pnpm bundles\n`);
    process.exit(1);
  }

  const { entries: closure, policy, summary } = collect({ repoRoot: args.repoRoot });
  const bundles = names.map((name) => scanBundle({ name, repoRoot: args.repoRoot, bundlesDir: args.bundlesDir, closure, policy }));

  const line = (text = '') => process.stdout.write(`${text}\n`);
  const failures = [];
  const reviewUnregistered = [];
  const reviewPending = [];

  for (const bundle of bundles) {
    const licensesFile = join(args.bundlesDir, `${bundle.name}.licenses.txt`);
    writeFileSync(licensesFile, `${renderLicensesTxt(bundle)}\n`, 'utf8');
    const reportFile = join(args.bundlesDir, `${bundle.name}.license-report.json`);
    writeFileSync(
      reportFile,
      `${JSON.stringify({ ...bundle, packages: bundle.packages.map(({ licenseFile, ...rest }) => rest) }, null, 2)}\n`,
      'utf8',
    );

    if (!args.json) {
      line(`== bundle 许可证扫描：${bundle.name} ==`);
      line(`产物：${bundle.outfile.replace(`${args.repoRoot}/`, '')}（${bundle.bytes} 字节）`);
      line(
        `输入 ${bundle.inputCount} 个文件（自有 ${bundle.ownInputCount} + 第三方 ${bundle.inputCount - bundle.ownInputCount}），` +
          `打包进 ${bundle.packages.length} 个第三方包`,
      );
      line(`打包配置：legalComments=${bundle.options?.legalComments}，minify=${bundle.options?.minify}，format=${bundle.options?.format}`);
      line(
        `法务注释：输入中 ${bundle.legalComments.foundInInputs} 处，产物保留 ${bundle.legalComments.preserved} 处，` +
          `横幅 ${bundle.legalComments.bannerPresent ? '存在' : '缺失'}`,
      );
      line(`许可证清单：${licensesFile.replace(`${args.repoRoot}/`, '')}`);
      if (bundle.packages.length > 0) {
        line('被打包的第三方包：');
        for (const pkg of bundle.packages) {
          line(
            `  - ${pkg.name}@${pkg.version} | ${pkg.expression ?? '<未声明>'} | ${pkg.verdict} | ` +
              `${pkg.inputCount} 个输入文件 | lockfile 闭包内=${pkg.inClosure}`,
          );
        }
      }
      line('');
    }

    for (const problem of bundle.configProblems) failures.push(`[${bundle.name}] 配置：${problem}`);
    for (const item of bundle.untracked) failures.push(`[${bundle.name}] 产物含未经 lockfile 审计的包：${item}`);
    if (!bundle.legalComments.bannerPresent) failures.push(`[${bundle.name}] 产物缺少 AGPL-3.0-only 横幅声明`);
    for (const item of bundle.legalComments.stripped) {
      failures.push(`[${bundle.name}] 压缩吃掉了法务注释：${item.file}`);
    }
    for (const pkg of bundle.packages) {
      if (pkg.verdict === VERDICT_FORBIDDEN || pkg.verdict === VERDICT_UNKNOWN) {
        failures.push(`[${bundle.name}] ${pkg.verdict}：${pkg.name}@${pkg.version}（${pkg.expression ?? '<未声明>'}）`);
      } else if (pkg.verdict === VERDICT_REVIEW) {
        const entry = `${pkg.name}@${pkg.version}（${pkg.expression}）`;
        if (pkg.adjudication?.status === ADJUDICATION_PENDING) reviewPending.push(`[${bundle.name}] ${entry}`);
        else if (!pkg.adjudication) reviewUnregistered.push(`[${bundle.name}] ${entry}`);
      }
    }
  }

  const report = {
    scanTarget: 'web-bundle',
    generatedAt: new Date().toISOString(),
    sourceClosureTotal: summary.total,
    bundles: bundles.map((bundle) => ({
      name: bundle.name,
      bytes: bundle.bytes,
      options: bundle.options,
      inputCount: bundle.inputCount,
      ownInputCount: bundle.ownInputCount,
      packages: bundle.packages.map(({ licenseFile, ...rest }) => rest),
      untracked: bundle.untracked,
      configProblems: bundle.configProblems,
      legalComments: bundle.legalComments,
    })),
  };
  writeFileSync(join(args.bundlesDir, 'bundle-license-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (!args.json) {
    if (reviewPending.length > 0) {
      line(`>> bundle 内等待架构师裁定 ${reviewPending.length} 项（与源码扫描共用同一批裁定条目）：`);
      for (const item of reviewPending) line(`  - ${item}`);
      line('');
    }
  }

  const exitCode = failures.length > 0 || reviewUnregistered.length > 0 ? (failures.length > 0 ? 1 : 2) : 0;
  if (failures.length > 0 && !args.json) {
    line(`!! bundle 许可证门禁失败 ${failures.length} 项：`);
    for (const item of failures) line(`  - ${item}`);
  }
  if (reviewUnregistered.length > 0 && !args.json) {
    line(`!! bundle 内出现未登记的 reviewRequired ${reviewUnregistered.length} 项，需在 config/license-policy.json 登记并请架构师裁定：`);
    for (const item of reviewUnregistered) line(`  - ${item}`);
  }
  if (exitCode === 0 && !args.json) {
    line(`结果：${bundles.length} 个 bundle 通过（0 处硬性失败，${reviewPending.length} 项待裁定已留痕）。`);
  }
  process.exit(exitCode);
}

main();

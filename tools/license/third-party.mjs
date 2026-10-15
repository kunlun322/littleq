#!/usr/bin/env node
// 生成 THIRD_PARTY_LICENSES（ZLQ-153 §10.2 / §10.3）。
//
// 文档分两段，边界用显式标记隔开：
//   INVENTORY —— 完全由 pnpm-lock.yaml 推导，与运行平台无关，`--check` 只比对这一段，
//                因此 CI 可以在 linux 上校验 mac 生成的文件而不产生假失败。
//   TEXTS     —— 许可证全文从已安装包内的 LICENSE 文件收割，不手写、不转抄，避免转录错误。
//                本机没安装的平台变体（如 @esbuild/aix-ppc64）与其已安装同族共用同一份全文。
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collect } from '../lib/collect.mjs';
import { LICENSE_FILE_PATTERN } from '../lib/license-resolve.mjs';

const INVENTORY_BEGIN = '<!-- INVENTORY-BEGIN (由 pnpm-lock.yaml 推导，平台无关，CI 校验此段) -->';
const INVENTORY_END = '<!-- INVENTORY-END -->';
const TEXTS_BEGIN = '<!-- TEXTS-BEGIN (许可证全文从已安装包收割，随生成平台变化，CI 不比对) -->';

function parseArgs(argv) {
  const args = { check: false, repoRoot: process.cwd(), out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--check') args.check = true;
    else if (token === '--repo-root') args.repoRoot = resolve(argv[(i += 1)]);
    else if (token === '--out') args.out = resolve(argv[(i += 1)]);
    else throw new Error(`未知参数：${token}`);
  }
  return args;
}

function findLicenseFile(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const match = names
    .filter((name) => LICENSE_FILE_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b))[0];
  return match ? join(dir, match) : null;
}

function spdxUrl(id) {
  return `https://spdx.org/licenses/${id}.html`;
}

function buildInventory(result) {
  const { entries, summary } = result;
  const lines = [];
  lines.push('## 依赖清单');
  lines.push('');
  lines.push(
    `共 ${summary.total} 个第三方包（项目 lockfile ${summary.byOrigin.project} 个 + pnpm 自身 ${summary.byOrigin['package-manager']} 个）；` +
      `其中生产依赖 ${summary.prod} 个、仅构建/测试期依赖 ${summary.dev} 个。`,
  );
  lines.push(
    `许可证判定：白名单通过 ${summary.byVerdict.allowed}，待架构师裁定 ${summary.byVerdict['review-required']}，禁止 ${summary.byVerdict.forbidden}，无法解析 ${summary.byVerdict.unknown}。`,
  );
  lines.push('');
  lines.push('### 待架构师裁定');
  lines.push('');
  const review = entries.filter((item) => item.verdict === 'review-required');
  if (review.length === 0) {
    lines.push('无。');
  } else {
    lines.push('以下条目命中 `reviewRequired`（GPL/LGPL/MPL 等需人工裁定的许可族），已登记在 `config/license-policy.json`，');
    lines.push('在架构师给出结论前 `pnpm license:scan --strict` 会以退出码 2 持续提醒：');
    lines.push('');
    lines.push('| 包 | 许可证 | 引入路径 | 裁定条目 | 链接 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of review) {
      const adjudication = item.adjudication ? `${item.adjudication.id} (${item.adjudication.status})` : '**未登记**';
      lines.push(`| \`${item.name}@${item.version}\` | ${item.expression} | ${item.kind === 'prod' ? '生产依赖' : 'dev 依赖'} | ${adjudication} | ${item.link} |`);
    }
  }
  lines.push('');
  lines.push('### 全量清单');
  lines.push('');
  lines.push('| 包 | 版本 | 许可证 | 类型 | 来源 | 许可证依据 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const item of entries) {
    const origin = item.origin === 'package-manager' ? 'pnpm 自锁' : '项目';
    const basis =
      item.licenseSource === 'installed-manifest'
        ? 'package.json'
        : item.licenseSource === 'platform-sibling-inferred'
          ? `同族推断：${item.inferredFrom}`
          : item.licenseSource === 'audited-policy-entry'
            ? `审计条目：${item.policyId}`
            : item.licenseSource === 'own-package'
              ? '本仓库自有包'
              : '**无法解析**';
    lines.push(`| \`${item.name}\` | ${item.version} | ${item.expression ?? '<none>'} | ${item.kind} | ${origin} | ${basis} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildTexts(result) {
  const installed = result.installed;
  const { entries } = result;

  const byLicense = new Map();
  for (const item of entries) {
    if (!item.expression) continue;
    for (const id of item.ids.length > 0 ? item.ids : [item.expression]) {
      const list = byLicense.get(id);
      if (list) list.push(item);
      else byLicense.set(id, [item]);
    }
  }

  const lines = [];
  lines.push('## 许可证全文');
  lines.push('');
  lines.push(`全文从本仓库已安装包内的 LICENSE 文件收割，未做任何转抄。生成平台：\`${process.platform}-${process.arch}\`。`);
  lines.push('');

  for (const id of [...byLicense.keys()].sort((a, b) => a.localeCompare(b))) {
    const items = byLicense.get(id);
    // 按 lockfile 闭包的稳定顺序（已按 name/version 排序）挑第一个真正装了且带 LICENSE 文件的包，
    // 让同一平台上的重复生成结果字节一致。
    const provider = items
      .map((item) => installed.get(`${item.name}@${item.version}`))
      .find((candidate) => candidate && findLicenseFile(candidate.dir));
    const file = provider ? findLicenseFile(provider.dir) : null;

    lines.push(`### ${id}`);
    lines.push('');
    lines.push(`适用于 ${items.length} 个包：${items.map((item) => `\`${item.name}@${item.version}\``).join(', ')}`);
    lines.push('');
    lines.push(`SPDX: ${spdxUrl(id)}`);
    lines.push('');
    if (file) {
      lines.push(`全文来源：\`${provider.name}@${provider.version}\``);
      lines.push('');
      lines.push('```text');
      lines.push(readFileSync(file, 'utf8').replace(/\s+$/, ''));
      lines.push('```');
    } else {
      lines.push(
        `全文来源：本机未安装携带该许可证全文的包（该许可仅出现在未安装的平台变体上）。请以上方 SPDX 链接为准。`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function render(result) {
  const generatedAt = new Date().toISOString().slice(0, 10);
  return [
    '# 第三方许可证清单（THIRD_PARTY_LICENSES）',
    '',
    'LittleQ 以 **AGPL-3.0-only** 发布（见 `LICENSE`、`NOTICE`）。本文件列出构建本仓库所引入的全部第三方包及其许可证，',
    '由 `pnpm license:third-party` 从 `pnpm-lock.yaml` 生成，**不要手工编辑**。',
    '',
    `- 生成日期：${generatedAt}`,
    `- 生成命令：\`pnpm license:third-party\``,
    `- 校验命令：\`pnpm license:third-party -- --check\`（只比对依赖清单段，全文段随生成平台变化）`,
    `- 准入策略：\`config/license-policy.json\`（白名单六项；GPL/LGPL/MPL 一律升级人工裁定）`,
    `- 门禁：\`pnpm license:scan\`（源码依赖）、\`pnpm license:bundle\`（web bundle）、\`pnpm license:image\`（Docker 镜像，待 ZLQ-157）`,
    '',
    INVENTORY_BEGIN,
    '',
    buildInventory(result),
    INVENTORY_END,
    '',
    TEXTS_BEGIN,
    '',
    buildTexts(result),
  ].join('\n');
}

function extractInventory(document) {
  const start = document.indexOf(INVENTORY_BEGIN);
  const end = document.indexOf(INVENTORY_END);
  if (start === -1 || end === -1) return null;
  return document.slice(start + INVENTORY_BEGIN.length, end).trim();
}

function distinctLicenseIds(result) {
  const set = new Set();
  for (const item of result.entries) {
    if (!item.expression) continue;
    for (const id of item.ids.length > 0 ? item.ids : [item.expression]) set.add(id);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = collect({ repoRoot: args.repoRoot });
  const rendered = render(result);
  const outFile = args.out ?? join(args.repoRoot, 'THIRD_PARTY_LICENSES');

  if (!args.check) {
    writeFileSync(outFile, `${rendered}\n`, 'utf8');
    process.stdout.write(
      `已生成 ${outFile}（${Buffer.byteLength(rendered, 'utf8')} 字节，${result.summary.total} 个包，${distinctLicenseIds(result).length} 种许可证）\n`,
    );
    return;
  }

  if (!existsSync(outFile)) {
    process.stderr.write(`!! ${outFile} 不存在，请先运行 pnpm license:third-party\n`);
    process.exit(1);
  }
  const committed = readFileSync(outFile, 'utf8');
  const committedInventory = extractInventory(committed);
  const freshInventory = extractInventory(rendered);
  if (committedInventory === null) {
    process.stderr.write(`!! ${outFile} 缺少 ${INVENTORY_BEGIN} 标记，无法校验\n`);
    process.exit(1);
  }
  if (committedInventory !== freshInventory) {
    process.stderr.write(
      `!! THIRD_PARTY_LICENSES 的依赖清单段与 pnpm-lock.yaml 不一致，请重新运行 pnpm license:third-party 并提交\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`THIRD_PARTY_LICENSES 依赖清单段与 pnpm-lock.yaml 一致（${result.summary.total} 个包）\n`);
}

main();

#!/usr/bin/env node
// 生成 config/license-registry-facts.json —— 平台变体的许可事实快照（ZLQ-162 缺陷 2）。
//
// 为什么需要这份快照：lockfile 里被 os/cpu/libc 约束的可选依赖（fsevents、@esbuild/*、
// lightningcss-*、@rolldown/binding-*、@typescript/typescript-* …）只会在匹配的平台上落地。
// 于是「从已安装的 package.json 读 license」这条路对它们不成立：本机装了就读得到，
// 换一台 runner 就读不到，同一份 lockfile 在两个平台上给出两个判定 —— 而本仓库的口径是
// 「未知即不合规」，读不到就直接判红。ZLQ-160 首次推送就是这么红的（fsevents 在 Linux 上不存在）。
//
// 修法是把事实**从 runner 搬到仓库里**：向注册表取一次每个平台变体的元数据，把 license 与
// dist.integrity 一起提交。integrity 是关键 —— 它与 lockfile 的 resolution.integrity 是同一个
// 内容哈希，对得上就说明快照描述的就是 lockfile 钉住的那一个 tarball，其 license 字段也就是
// 同一个事实，不需要「推断」。解析时（tools/lib/license-resolve.mjs）一律以快照为准，
// 不看本机装了什么，所以 macOS / ubuntu / windows 的结论逐字相同。
//
// 这份文件是**生成物但要入库**：门禁必须在离线、干净的 CI 检出上就能跑，不能依赖网络。
// 因此 pnpm license:scan 只读它、从不写它，也从不联网；只有本脚本会联网。
//
// 用法：pnpm license:registry-facts [--repo-root DIR] [--out FILE] [--concurrency N]
// 退出码：0 成功；1 有取不到的条目（此时不写文件，避免产出一份残缺快照让门禁静默放宽）。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPlatformConstrained, manifestToExpression } from '../lib/license-resolve.mjs';
import { readLockfile, resolveClosure } from '../lib/lockfile.mjs';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), out: null, concurrency: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--repo-root') args.repoRoot = resolve(argv[(i += 1)]);
    else if (token === '--out') args.out = resolve(argv[(i += 1)]);
    else if (token === '--concurrency') args.concurrency = Number.parseInt(argv[(i += 1)], 10);
    else throw new Error(`未知参数：${token}`);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1)
    throw new Error(`--concurrency 必须是正整数，收到 ${args.concurrency}`);
  return args;
}

// 与 .npmrc 里固定的解析源保持一致：快照必须来自 lockfile 所用的那一个注册表，
// 否则 integrity 对不上（不同镜像的 tarball 内容一致，但地址与元数据形态可能不同）。
function registryFrom(repoRoot) {
  try {
    const line = readFileSync(resolve(repoRoot, '.npmrc'), 'utf8')
      .split('\n')
      .find((item) => /^\s*registry\s*=/.test(item));
    if (line) return line.split('=')[1].trim().replace(/\/$/, '') + '/';
  } catch {
    // 没有 .npmrc 就用默认源。
  }
  return DEFAULT_REGISTRY;
}

// 注册表路径里 scope 的斜杠要转义：@esbuild/darwin-arm64 → @esbuild%2fdarwin-arm64。
function packumentUrl(registry, name, version) {
  const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : name;
  return `${registry}${encoded}/${version}`;
}

async function fetchFact(url, { retries = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${lastError?.message ?? '取不到'}`);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function repositoryUrl(repository) {
  if (typeof repository === 'string') return repository;
  return repository?.url ?? null;
}

// 需要取快照的条目 = 审计闭包里的平台变体，且**没有**人工审计条目兜着。
// pnpm / @pnpm/exe.* 由 config/license-policy.json 的 platformBinaryFamilies 覆盖
// （带证据链接的人工审计，优先级高于机器抓取的快照），不必重复取一遍。
export function factTargets({ repoRoot, lockfileFile = 'pnpm-lock.yaml', policyFile = 'config/license-policy.json' }) {
  const policy = JSON.parse(readFileSync(resolve(repoRoot, policyFile), 'utf8'));
  const lockfile = readLockfile(resolve(repoRoot, lockfileFile));
  const { entries } = resolveClosure(lockfile);
  const families = policy.platformBinaryFamilies?.entries ?? [];
  const audited = (entry) =>
    families.some(
      (family) =>
        ((family.names ?? []).includes(entry.name) ||
          (family.prefixes ?? []).some((prefix) => entry.name.startsWith(prefix))) &&
        (!family.versions || family.versions.includes(entry.version)),
    );
  return entries.filter((entry) => isPlatformConstrained(entry) && !audited(entry));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = registryFrom(args.repoRoot);
  const targets = factTargets({ repoRoot: args.repoRoot });
  const outFile = args.out ?? resolve(args.repoRoot, 'config', 'license-registry-facts.json');

  process.stdout.write(
    `== 生成注册表许可事实快照 ==\n注册表：${registry}\n平台变体条目：${targets.length} 个，并发 ${args.concurrency}\n`,
  );

  const failures = [];
  const fetched = await mapWithConcurrency(targets, args.concurrency, async (entry) => {
    const url = packumentUrl(registry, entry.name, entry.version);
    let document;
    try {
      document = await fetchFact(url);
    } catch (error) {
      failures.push(`${entry.name}@${entry.version}: ${error.message}`);
      return null;
    }
    const hasLicenseDeclaration = document.license !== undefined || document.licenses !== undefined;
    return {
      key: `${entry.name}@${entry.version}`,
      record: {
        // 原样保留注册表的 license 字段（字符串或已废弃的 licenses 数组），
        // 判定统一走 manifestToExpression —— 与读已安装 manifest 用的是同一个函数，
        // 不引入第二套解析规则。
        ...(document.license !== undefined ? { license: document.license } : {}),
        ...(document.licenses !== undefined ? { licenses: document.licenses } : {}),
        hasLicenseDeclaration,
        integrity: document.dist?.integrity ?? null,
        os: document.os ?? null,
        cpu: document.cpu ?? null,
        libc: document.libc ?? null,
        homepage: document.homepage ?? null,
        repository: repositoryUrl(document.repository),
        fetchedFrom: url,
      },
    };
  });

  if (failures.length > 0) {
    process.stderr.write(`!! ${failures.length} 条取不到，未写出快照（残缺快照会让门禁静默放宽）：\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
  }

  const facts = {};
  for (const item of fetched.filter(Boolean).sort((a, b) => a.key.localeCompare(b.key))) {
    facts[item.key] = item.record;
  }

  const document = {
    spec: 'littleq/license-registry-facts@1',
    note:
      '平台变体（lockfile 声明了 os/cpu/libc 的可选依赖）的许可事实快照，由 ' +
      'tools/license/registry-facts.mjs 从注册表抓取生成，**不要手工编辑**。' +
      '必须入库：许可证门禁要在离线、干净的 CI 检出上可跑，不能依赖网络。' +
      'integrity 与 pnpm-lock.yaml 的 resolution.integrity 交叉校验，对不上即判 unknown。',
    generatedAt: new Date().toISOString().slice(0, 10),
    registry,
    generator: 'pnpm license:registry-facts',
    facts,
  };

  writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const expressions = new Map();
  for (const [key, record] of Object.entries(facts)) {
    const expression = manifestToExpression(record) ?? '<无声明>';
    expressions.set(expression, (expressions.get(expression) ?? 0) + 1);
    if (!record.integrity) process.stderr.write(`!! ${key} 的注册表元数据没有 dist.integrity\n`);
  }
  const missingIntegrity = Object.entries(facts).filter(([, record]) => !record.integrity).length;
  process.stdout.write(
    `已写出 ${outFile}\n条目 ${Object.keys(facts).length} 个；许可证分布 ${[...expressions]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, count]) => `${id}×${count}`)
      .join(', ')}\n缺 integrity 的条目 ${missingIntegrity} 个\n`,
  );
}

const invokedDirect =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirect) await main();

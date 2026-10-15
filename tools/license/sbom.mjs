// CycloneDX SBOM 生成器（ZLQ-153 §10.3 / §13.2 V11「传递依赖未审计」的机器可读证据）。
//
// 事实来源是 pnpm 12 自带的 `pnpm sbom`，不自己实现 CycloneDX 生成：官方工具对 purl、
// bom-ref、依赖图的构造更可靠。本脚本只做三件官方工具做不到的事：
//
//   1. 修 name 丢 scope：pnpm sbom 把 `@eslint/js` 的 name 写成 `js`、`@keyv/core` 写成
//      `core`，只有 purl 里保留了 `%40scope/name`。同名不同 scope 的包在组件表里无法区分，
//      这里从 purl 反解出真实包名回填。
//   2. 挂许可裁定：把 config/license-policy.json 的判定结果写进每个 component 的
//      properties（verdict / 依赖类型 / 许可证依据 / 待裁定登记项），让下游消费者不必
//      重跑扫描就知道哪个组件还压在架构师那里。
//   3. 补齐闭包缺口：pnpm sbom 只列本机已安装的包，平台专属二进制（esbuild 的 14 个
//      @esbuild/*、lightningcss 的各平台变体、pnpm 自锁文档里的 @pnpm/exe.*）会被漏掉，
//      于是 146 个组件对不上 225 个闭包条目。审计口径必须是闭包，缺的那些按
//      lq:origin=lockfile-closure-only 补进来。
//
// 判定不通过（forbidden/unknown）时本脚本只告警、不失败：通过与否由 tools/license/scan.mjs
// 单一负责，两个门禁同时判死会在规则演进时漂移。
//
// 包脚本名叫 `sbom:generate`，**不能**叫 `sbom`：pnpm 12 自带 `pnpm sbom` 子命令，
// 且内置命令优先于同名脚本，于是 `pnpm sbom` 会去跑内置命令并以
// 「缺少 --sbom-format」退出码 2 失败，本脚本一行都不会执行。
// tools/test/ci-workflow.test.mjs 里有一条对照锁住这件事。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { collect } from '../lib/collect.mjs';
import { ORIGIN_PACKAGE_MANAGER } from '../lib/lockfile.mjs';
import { SOURCE_POLICY } from '../lib/license-resolve.mjs';

const SPEC_VERSION = '1.6';
const PURL_PREFIX = 'pkg:npm/';

function parseArgs(argv) {
  const args = {
    out: 'artifacts/sbom.cdx.json',
    from: null,
    repoRoot: process.cwd(),
    lockfile: 'pnpm-lock.yaml',
    policy: 'config/license-policy.json',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--out') args.out = argv[++i];
    else if (flag === '--from') args.from = argv[++i];
    else if (flag === '--repo-root') args.repoRoot = argv[++i];
    else if (flag === '--lockfile') args.lockfile = argv[++i];
    else if (flag === '--policy') args.policy = argv[++i];
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`未知参数：${flag}`);
  }
  args.repoRoot = resolve(args.repoRoot);
  return args;
}

const HELP = `用法：node tools/license/sbom.mjs [选项]

生成 CycloneDX ${SPEC_VERSION} SBOM：以 pnpm sbom 为底，修正 scope 丢失的组件名、
挂上许可策略裁定、并补齐 pnpm 漏掉的平台专属二进制与包管理器自锁条目。

选项：
  --out <file>         输出路径（默认 artifacts/sbom.cdx.json）
  --from <file>        跳过调用 pnpm，直接以该 CycloneDX JSON 为底（离线/测试用）
  --repo-root <dir>    仓库根目录（默认当前目录）
  --lockfile <file>    lockfile 相对路径（默认 pnpm-lock.yaml）
  --policy <file>      许可策略相对路径（默认 config/license-policy.json）
  --json               以 JSON 打印结果摘要
`;

// pnpm sbom 的 purl 形如 pkg:npm/%40eslint/js@9.39.2；版本号是最后一段 @ 之后的部分。
export function nameVersionFromPurl(purl) {
  if (typeof purl !== 'string' || !purl.startsWith(PURL_PREFIX)) return null;
  const body = purl.slice(PURL_PREFIX.length);
  const at = body.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: decodeURIComponent(body.slice(0, at)), version: body.slice(at + 1) };
}

function purl(name, version) {
  return `${PURL_PREFIX}${encodeURIComponent(name).replace('%40', '@').replace('%2F', '/')}@${version}`;
}

function property(name, value) {
  return { name, value: String(value) };
}

function runPnpmSbom(repoRoot, outFile) {
  const result = spawnSync(
    'pnpm',
    ['sbom', '--sbom-format', 'cyclonedx', '--sbom-spec-version', SPEC_VERSION, '--sbom-type', 'application', '--out', outFile],
    { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (result.error) throw new Error(`调用 pnpm sbom 失败：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`pnpm sbom 退出码 ${result.status}：${(result.stderr || result.stdout || '').trim()}`);
  }
  // `--out` 支持 %s/%v 占位；不带占位时 pnpm 直接写目标文件，多包工作区可能写成 <name> 变体。
  if (existsSync(outFile)) return JSON.parse(readFileSync(outFile, 'utf8'));
  const candidates = [`${outFile}.json`, outFile.replace(/\.json$/, '') + '.json'];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
  }
  throw new Error(`pnpm sbom 报告成功但找不到输出文件：${outFile}`);
}

function closureComponent(entry) {
  const properties = [
    property('lq:origin', 'lockfile-closure-only'),
    property('lq:note', entry.origin === ORIGIN_PACKAGE_MANAGER
      ? 'pnpm 包管理器自锁文档条目，不随应用分发'
      : '平台专属二进制或本机未安装的变体；pnpm sbom 只列已安装组件'),
  ];
  const component = {
    type: 'library',
    name: entry.name,
    version: entry.version,
    purl: purl(entry.name, entry.version),
    'bom-ref': purl(entry.name, entry.version),
    scope: entry.kind === 'prod' ? 'required' : 'optional',
    properties,
  };
  if (entry.expression) {
    component.licenses = [{ license: { id: entry.expression } }];
  } else if (entry.note) {
    component.licenses = [{ license: { name: entry.note } }];
  }
  if (entry.homepage) {
    component.externalReferences = [{ type: 'website', url: entry.homepage }];
  }
  return component;
}

function annotate(component, entry, stats) {
  const properties = component.properties ?? [];
  properties.push(property('lq:verdict', entry.verdict));
  properties.push(property('lq:dependency-kind', entry.kind));
  properties.push(property('lq:lockfile-origin', entry.origin));
  properties.push(property('lq:license-source', entry.licenseSource));
  if (entry.expression) properties.push(property('lq:license-expression', entry.expression));
  if (entry.adjudication) {
    properties.push(property('lq:adjudication-id', entry.adjudication.id));
    properties.push(property('lq:adjudication-status', entry.adjudication.status));
  }
  if (entry.licenseSource === SOURCE_POLICY) properties.push(property('lq:license-policy-id', entry.policyId));
  component.properties = properties;

  if (!component.licenses?.length && entry.expression) {
    component.licenses = [{ license: { id: entry.expression } }];
    stats.licensesFilled += 1;
  }
  return component;
}

export function enrich(bom, result) {
  const stats = { renamed: 0, licensesFilled: 0, annotated: 0, appended: 0, own: 0, unmatched: [] };
  const byKey = new Map(result.entries.map((entry) => [`${entry.name}@${entry.version}`, entry]));
  const matched = new Set();
  const ownNames = new Set(result.policy.ownPackages?.names ?? []);

  bom.components ??= [];
  for (const component of bom.components) {
    const parsed = nameVersionFromPurl(component.purl);
    if (parsed && parsed.name !== component.name) {
      component.name = parsed.name;
      stats.renamed += 1;
    }
    // 自有工作区包不出现在第三方闭包里（策略按 ownPackages 排除），但它们是 SBOM 的合法组件：
    // 单独标注，既不进 unmatched 告警，也不被当成待裁定项。
    if (ownNames.has(component.name)) {
      component.properties = [
        ...(component.properties ?? []),
        property('lq:origin', 'own-workspace-package'),
        property('lq:license-expression', result.policy.ownPackages?.license ?? 'AGPL-3.0-only'),
        property('lq:note', '本仓库自有包，以 AGPL-3.0-only 发布，不进第三方许可门禁'),
      ];
      component.licenses ??= [{ license: { id: result.policy.ownPackages?.license ?? 'AGPL-3.0-only' } }];
      stats.own += 1;
      continue;
    }
    const key = `${component.name}@${component.version}`;
    const entry = byKey.get(key);
    if (!entry) {
      stats.unmatched.push(key);
      continue;
    }
    matched.add(key);
    annotate(component, entry, stats);
    stats.annotated += 1;
  }

  for (const [key, entry] of byKey) {
    if (matched.has(key)) continue;
    bom.components.push(closureComponent(entry));
    matched.add(key);
    stats.appended += 1;
  }

  const { summary } = result;
  bom.metadata ??= {};
  bom.metadata.properties = [
    property('lq:audit.spec', 'ZLQ-153 §10.3 / §13.2(V11)'),
    property('lq:audit.raised-in', 'ZLQ-159'),
    property('lq:audit.policy', 'config/license-policy.json'),
    property('lq:audit.lockfile-closure-total', summary.total),
    property('lq:audit.lockfile-closure-prod', summary.prod),
    property('lq:audit.lockfile-closure-dev', summary.dev),
    property('lq:audit.origin-project', summary.byOrigin.project),
    property('lq:audit.origin-package-manager', summary.byOrigin['package-manager']),
    property('lq:audit.verdict-allowed', summary.byVerdict.allowed),
    property('lq:audit.verdict-review-required', summary.byVerdict['review-required']),
    property('lq:audit.verdict-forbidden', summary.byVerdict.forbidden),
    property('lq:audit.verdict-unknown', summary.byVerdict.unknown),
    property('lq:audit.needs-adjudication', summary.needsAdjudication.join(', ') || '<none>'),
    property('lq:audit.orphaned-lockfile-entries', result.orphaned.length),
    property('lq:audit.sbom-components', bom.components.length),
    property('lq:audit.sbom-components-not-in-closure', stats.unmatched.length),
    property('lq:audit.note', '闭包总数=pnpm-lock.yaml 两份文档（项目 210 + 包管理器自锁 15）去重后的可达依赖；组件数少于闭包数说明有平台变体未安装，已按 lq:origin=lockfile-closure-only 补齐'),
  ];

  return stats;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const result = collect({
    repoRoot: args.repoRoot,
    lockfileFile: args.lockfile,
    policyFile: args.policy,
  });

  let bom;
  let tempFile = null;
  if (args.from) {
    bom = JSON.parse(readFileSync(resolve(args.repoRoot, args.from), 'utf8'));
  } else {
    tempFile = join(tmpdir(), `lq-sbom-${process.pid}.cdx.json`);
    bom = runPnpmSbom(args.repoRoot, tempFile);
  }

  const before = bom.components?.length ?? 0;
  const stats = enrich(bom, result);

  const outFile = resolve(args.repoRoot, args.out);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(bom, null, 2)}\n`, 'utf8');
  if (tempFile) rmSync(tempFile, { force: true });

  const { summary } = result;
  const bad = summary.byVerdict.forbidden + summary.byVerdict.unknown;

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      out: relative(args.repoRoot, outFile),
      specVersion: bom.specVersion,
      componentsBefore: before,
      componentsAfter: bom.components.length,
      ...stats,
      closure: summary,
      exitCode: 0,
    }, null, 2)}\n`);
    return 0;
  }

  const lines = [
    `SBOM：${relative(args.repoRoot, outFile)}（CycloneDX ${bom.specVersion}）`,
    `组件：${before} → ${bom.components.length}` +
      `（修正 scope 名 ${stats.renamed}，补许可证 ${stats.licensesFilled}，闭包补齐 ${stats.appended}，裁定标注 ${stats.annotated}，自有包 ${stats.own}）`,
    `闭包：${summary.total} 条（生产 ${summary.prod} / 开发 ${summary.dev}；项目文档 ${summary.byOrigin.project} + 包管理器自锁 ${summary.byOrigin['package-manager']}）`,
    `裁定：允许 ${summary.byVerdict.allowed}，待架构师 ${summary.byVerdict['review-required']}，禁止 ${summary.byVerdict.forbidden}，未知 ${summary.byVerdict.unknown}`,
    `孤立 lockfile 条目：${result.orphaned.length}`,
  ];
  if (stats.unmatched.length) {
    lines.push(`!! SBOM 里有 ${stats.unmatched.length} 个组件不在 lockfile 闭包内（版本漂移或 pnpm 展开差异）：${stats.unmatched.slice(0, 8).join(', ')}${stats.unmatched.length > 8 ? ' …' : ''}`);
  }
  if (summary.needsAdjudication.length) {
    lines.push(`>> 等待架构师裁定 ${summary.needsAdjudication.length} 项：${summary.needsAdjudication.join(', ')}`);
  }
  if (bad > 0) {
    lines.push(`!! 存在 ${bad} 条禁止/未知许可证；本脚本不判死，请运行 pnpm license:scan 查看门禁结论`);
  }
  lines.push('提示：通过与否由 tools/license/scan.mjs 单一负责，本脚本只产出证据。');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

const invokedDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirect) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`!! SBOM 生成失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// 静态依赖图门禁：把 ZLQ-153 §1.3 / §3.1 / §5.4(4) 的架构边界变成 CI 里可执行的约束。
//
// 规则唯一事实来源是 config/dependency-graph.json；eslint.config.mjs 从同一份 JSON 生成
// no-restricted-imports，因此编辑器里的即时反馈与 CI 判定不会漂移。
//
// 两条检查面：
//   manifest —— package.json 的 dependencies/devDependencies/peerDependencies/optionalDependencies
//   source   —— 单元目录内所有源码的 import / export-from / import() / require() 说明符
//
// 说明符解析用正则而非 TS AST：TypeScript 7（原生 Go 版）不提供 JS 编译器 API，
// 而为一个边界扫描额外拉起 TS 6 不划算。AST 级精度由 ESLint 侧的同源规则兜住，
// 本扫描器额外覆盖 ESLint 管不到的 manifest 与路径通配（**/drivers/**）。
//
// 退出码：0 无违规；1 有违规；2 控制用例期望值不符（--expect-failures）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'test-results',
  'playwright-report',
]);

// import 'x' / import a from 'x' / import * as a from 'x' / import { a } from 'x' / import type { a } from 'x'
const SPECIFIER_PATTERNS = [
  /\bimport\s+(?:type\s+)?[^'"();]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s*(?:type\s*)?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    policy: null,
    expectFailures: null,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') args.root = resolve(argv[(i += 1)]);
    else if (token === '--policy') args.policy = resolve(argv[(i += 1)]);
    else if (token === '--expect-failures') args.expectFailures = Number(argv[(i += 1)]);
    else if (token === '--json') args.json = true;
    else if (token === '--quiet') args.quiet = true;
    else throw new Error(`未知参数：${token}`);
  }
  // 策略默认取自调用方仓库（cwd），而不是 --root：控制用例必须用线上那份真策略去扫 fixture，
  // 否则「fixture 自带一份能抓到 fixture 的策略」就成了自证，证明不了门禁有效。
  args.policy ??= join(process.cwd(), 'config', 'dependency-graph.json');
  return args;
}

// 最小 glob 匹配：支持 ** / * / ?，够表达 apps/*、packages/*、**/drivers/**。
export function globToRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') pattern += '[^/]';
    else if ('.+^${}()|[]\\'.includes(char)) pattern += `\\${char}`;
    else pattern += char;
  }
  return new RegExp(`^${pattern}$`);
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function walkSourceFiles(dir, extensions, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (isDirectory(full)) walkSourceFiles(full, extensions, out);
    else if (extensions.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

// 单元发现：按 policy 里出现过的 from/appliesTo 顶层目录（apps、packages）实际列盘。
function discoverUnits(root) {
  const units = new Map(); // unitId (posix 相对路径) -> { dir, name }
  for (const group of ['apps', 'packages']) {
    const groupDir = join(root, group);
    if (!isDirectory(groupDir)) continue;
    for (const name of readdirSync(groupDir).sort()) {
      const dir = join(groupDir, name);
      if (!isDirectory(dir)) continue;
      const manifest = readJsonSafe(join(dir, 'package.json'));
      units.set(`${group}/${name}`, { dir, name: manifest?.name ?? null, manifest });
    }
  }
  return units;
}

function expandUnitPatterns(patterns, units) {
  const matchers = patterns.map((pattern) => globToRegExp(pattern));
  return [...units.keys()].filter((unitId) => matchers.some((matcher) => matcher.test(unitId)));
}

// @littleq/infra -> packages/infra：靠各单元 package.json 的 name 反查。
function buildNameIndex(units) {
  const index = new Map();
  for (const [unitId, unit] of units) if (unit.name) index.set(unit.name, unitId);
  return index;
}

// 把说明符归类，返回它命中的判定对象。
function packageNameOf(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

function classifySpecifier(specifier, fromFile, unitId, root, units, names) {
  if (specifier.startsWith('.')) {
    const absolute = resolve(dirname(fromFile), specifier);
    const path = toPosix(relative(root, absolute));
    const owner =
      [...units.keys()].find(
        (candidate) => candidate !== unitId && absolute.startsWith(units.get(candidate).dir + sep),
      ) ?? null;
    return { kind: 'relative', path, unit: owner, absolute };
  }
  if (specifier.startsWith('#') || specifier.startsWith('node:'))
    return { kind: 'builtin', path: specifier };
  const packageName = packageNameOf(specifier);
  if (names.has(packageName))
    return { kind: 'workspace', path: specifier, unit: names.get(packageName) };
  return { kind: 'package', path: specifier, packageName };
}

function matchesDenyPackage(deny, packageName) {
  if ((deny.packages ?? []).includes(packageName)) return `packages 精确匹配 ${packageName}`;
  const prefix = (deny.packagePrefixes ?? []).find((item) => packageName.startsWith(item));
  if (prefix) return `packagePrefixes 前缀匹配 ${prefix}*`;
  return null;
}

function matchesDenyUnit(deny, targetUnitId) {
  if (!targetUnitId) return null;
  const matcher = (deny.units ?? []).find((pattern) => globToRegExp(pattern).test(targetUnitId));
  return matcher ? `units 匹配 ${matcher} -> ${targetUnitId}` : null;
}

function matchesDenyPath(deny, normalizedPath) {
  const matcher = (deny.sourcePathGlobs ?? []).find((pattern) =>
    globToRegExp(pattern).test(normalizedPath),
  );
  return matcher ? `sourcePathGlobs 匹配 ${matcher} -> ${normalizedPath}` : null;
}

export function checkDependencyGraph({ root, policyFile }) {
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  const extensions = policy.sourceExtensions ?? ['.ts', '.tsx', '.mjs', '.js'];
  const manifestFields = policy.manifestFields ?? ['dependencies', 'devDependencies'];
  const units = discoverUnits(root);
  const names = buildNameIndex(units);

  const violations = [];
  const armedButAbsent = [];

  for (const rule of policy.rules ?? []) {
    const deny = rule.deny ?? {};
    const appliesTo = new Set(rule.appliesTo ?? ['source', 'manifest']);
    const targets = expandUnitPatterns(rule.from ?? [], units);
    // 规则引用的单元可能尚未落地（如 §5.4(4) 的 packages/application）：
    // 逐条模式单独判断，保持武装但不判失败，包一旦出现即被约束。
    for (const pattern of rule.from ?? []) {
      if (expandUnitPatterns([pattern], units).length > 0) continue;
      if (!armedButAbsent.some((item) => item.rule === rule.id && item.unit === pattern)) {
        armedButAbsent.push({ rule: rule.id, unit: pattern, spec: rule.spec });
      }
    }

    for (const unitId of targets) {
      const unit = units.get(unitId);

      if (appliesTo.has('manifest') && unit.manifest) {
        for (const field of manifestFields) {
          for (const dependency of Object.keys(unit.manifest[field] ?? {})) {
            const reason =
              matchesDenyPackage(deny, dependency) ??
              matchesDenyUnit(deny, names.get(packageNameOf(dependency)));
            if (reason) {
              violations.push({
                rule: rule.id,
                spec: rule.spec,
                surface: 'manifest',
                unit: unitId,
                file: toPosix(join(unitId, 'package.json')),
                line: null,
                specifier: dependency,
                field,
                reason,
              });
            }
          }
        }
      }

      if (!appliesTo.has('source') || !isDirectory(unit.dir)) continue;
      for (const file of walkSourceFiles(unit.dir, extensions)) {
        const source = readFileSync(file, 'utf8');
        for (const pattern of SPECIFIER_PATTERNS) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(source)) !== null) {
            const specifier = match[1];
            const classified = classifySpecifier(specifier, file, unitId, root, units, names);
            const hits = [];

            if (classified.kind === 'package' || classified.kind === 'workspace') {
              const packageName = classified.packageName ?? packageNameOf(specifier);
              const packageReason = matchesDenyPackage(deny, packageName);
              if (packageReason) hits.push(packageReason);
            }
            if (classified.kind === 'relative') {
              const pathReason = matchesDenyPath(deny, classified.path);
              if (pathReason) hits.push(pathReason);
            }
            if (classified.unit) {
              const unitReason = matchesDenyUnit(deny, classified.unit);
              if (unitReason) hits.push(unitReason);
            }

            for (const reason of new Set(hits)) {
              violations.push({
                rule: rule.id,
                spec: rule.spec,
                surface: 'source',
                unit: unitId,
                file: toPosix(relative(root, file)),
                line: lineOf(source, match.index),
                specifier,
                reason,
              });
            }
          }
        }
      }
    }
  }

  return {
    root: toPosix(root),
    policyVersion: policy.version,
    unitsChecked: [...units.keys()].sort(),
    ruleCount: (policy.rules ?? []).length,
    armedButAbsent,
    violations,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.policy)) {
    process.stderr.write(`!! 找不到边界策略文件：${args.policy}\n`);
    process.exit(1);
  }
  const result = checkDependencyGraph({ root: args.root, policyFile: args.policy });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!args.quiet) {
    const line = (text = '') => process.stdout.write(`${text}\n`);
    line('== 静态依赖图门禁 ==');
    line(
      `策略：${toPosix(relative(process.cwd(), args.policy))}（version ${result.policyVersion}，${result.ruleCount} 条规则）`,
    );
    line(`扫描单元：${result.unitsChecked.join(', ') || '<无>'}`);
    if (result.armedButAbsent.length > 0) {
      line('已武装但单元尚未落地（规则按路径预先生效，包一旦出现即被约束）：');
      for (const item of result.armedButAbsent)
        line(`  - ${item.rule}: ${item.unit}（${item.spec}）`);
    }
    if (result.violations.length === 0) {
      line('结果：0 处违规。');
    } else {
      line(`结果：${result.violations.length} 处违规。`);
      for (const item of result.violations) {
        const where = item.line ? `${item.file}:${item.line}` : item.file;
        line(`  - [${item.rule}] ${where} (${item.surface}) ${item.specifier} -> ${item.reason}`);
        line(`    ${item.spec}`);
      }
    }
  }

  if (args.expectFailures !== null) {
    if (result.violations.length !== args.expectFailures) {
      process.stderr.write(
        `!! 控制用例失效：期望 ${args.expectFailures} 处违规，实际 ${result.violations.length} 处。\n` +
          `   这说明门禁本身没能识别出故意植入的违规（假阴性），必须修复后再交付。\n`,
      );
      process.exit(2);
    }
    if (!args.quiet) {
      process.stdout.write(
        `控制用例通过：故意植入的 ${args.expectFailures} 处违规全部被识别（涉及规则 ${[...new Set(result.violations.map((item) => item.rule))].sort().join(', ')}）。\n`,
      );
    }
    process.exit(0);
  }

  process.exit(result.violations.length > 0 ? 1 : 0);
}

// 作为脚本执行时才跑 main；被 vitest 导入时只导出函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

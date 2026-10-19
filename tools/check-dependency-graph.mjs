#!/usr/bin/env node
// 静态依赖图门禁：把 ZLQ-153 §1.3 / §3.1 / §5.4(4) 的架构边界变成 CI 里可执行的约束。
//
// 规则唯一事实来源是 config/dependency-graph.json；eslint.config.mjs 从同一份 JSON 生成
// no-restricted-imports，因此编辑器里的即时反馈与 CI 判定不会漂移。
// 例外：eslint.config.mjs 目前只消费 rule.deny 与 rule.inbound，controlledEdge 形状只有
// 本脚本这一侧的权威判定。这个缺口已在 config/dependency-graph.json 的 description 里
// 写明并交给 D6（eslint.config.mjs 不在 ZLQ-195 §2 的允许改动清单里）。
//
// 两条检查面：
//   manifest —— package.json 的 dependencies/devDependencies/peerDependencies/optionalDependencies
//   source   —— 单元目录内所有源码的 import / export-from / import() / require() 说明符
//              扫描前先用 tools/lib/source-scan.mjs 抹平注释：否则「解释本文件为什么故意
//              少写一行」的那句话本身就会被当成那一行（详见该 lib 的头注释）。
//
// 两条**方向**：
//   deny    —— 出向禁止：某个单元不许碰哪些包/单元/路径（`rule.deny`）。
//   inbound —— 入向白名单：谁**可以**依赖某个单元（`rule.inbound`，`default: "deny"`）。
//              被拒绝方不写死成枚举，而是对文件系统动态发现的全部单元生效 —— 新建一个
//              app 就自动被约束，不需要任何人记得回来补规则。
//
// 加一种**形状**：
//   controlledEdge —— 受控边（ZLQ-194 §4.3 / §13 行 4）：A 只能通过 B 的受控入口、
//              且只能在服务端适配层文件里访问 B；Client Component 一律禁止。
//              它既不是 deny 也不是 inbound，见 checkControlledEdge 的说明。
//
// 说明符解析用正则而非 TS AST：TypeScript 7（原生 Go 版）不提供 JS 编译器 API，
// 而为一个边界扫描额外拉起 TS 6 不划算。AST 级精度由 ESLint 侧的同源规则兜住，
// 本扫描器额外覆盖 ESLint 管不到的 manifest 与路径通配（**/drivers/**）。
//
// 退出码：0 无违规；1 有违规；2 控制用例期望值不符（--expect-failures）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { isMainModule } from './lib/main-module.mjs';
import { stripComments } from './lib/source-scan.mjs';

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

// 遍历一个单元的所有源码说明符。出向禁止与入向白名单共用这一份遍历，
// 两侧因此不可能因为「扫描方式不同」而一个抓得到、一个抓不到。
function scanUnitSource({ unit, unitId, root, units, names, extensions, onSpecifier }) {
  if (!isDirectory(unit.dir)) return;
  for (const file of walkSourceFiles(unit.dir, extensions)) {
    // 注释先抹平：deny 侧扫的是说明符，注释里那句「不要 import 'pg'」不是导入。
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        onSpecifier({
          specifier: match[1],
          classified: classifySpecifier(match[1], file, unitId, root, units, names),
          file: toPosix(relative(root, file)),
          line: lineOf(source, match.index),
        });
      }
    }
  }
}

// 入向约束（`inbound.default = "deny"`）：谁**可以**依赖某个单元。
//
// 它必须是入向而不是把禁止方逐个写进出向规则：出向规则 enumerates「A 不许碰 B」，
// 每多一个单元就要多改一处策略，而漏改是静默的。入向规则反过来 —— 白名单只有
// `allowFrom` 里那几个名字，其余**由文件系统动态发现的全部单元**一律默认拒绝，
// 新建一个 app 就自动被约束，不需要任何人记得去补规则。
//
// 目标单元自身与 `allowFrom` 里的单元跳过；`default` 不是 `deny` 时整条入向不生效
// （显式声明语义，而不是把「没写 default」当成放行）。
function checkInbound({ rule, units, names, root, extensions, manifestFields, appliesTo }) {
  const inbound = rule.inbound;
  if (!inbound || inbound.default !== 'deny') return [];
  const target = inbound.targetUnit;
  if (!units.has(target)) return []; // 目标单元尚未落地，入向约束无从触发
  const targetName = units.get(target).name;
  const allowed = new Set(inbound.allowFrom ?? []);
  const found = [];

  for (const [unitId, unit] of units) {
    if (unitId === target || allowed.has(unitId)) continue;
    const reason = `inbound.default=deny，${unitId} 不在 allowFrom（${[...allowed].sort().join(', ')}）里 -> ${target}`;

    if (appliesTo.has('manifest') && unit.manifest && targetName) {
      for (const field of manifestFields) {
        for (const dependency of Object.keys(unit.manifest[field] ?? {})) {
          if (packageNameOf(dependency) !== targetName) continue;
          found.push({
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

    if (!appliesTo.has('source')) continue;
    scanUnitSource({
      unit,
      unitId,
      root,
      units,
      names,
      extensions,
      onSpecifier: ({ specifier, classified, file, line }) => {
        if (classified.unit !== target) return;
        found.push({
          rule: rule.id,
          spec: rule.spec,
          surface: 'source',
          unit: unitId,
          file,
          line,
          specifier,
          reason,
        });
      },
    });
  }
  return found;
}

// Next.js 的指令序言（directive prologue）：文件最前面、任何真正代码之前的一串裸字符串字面量。
// `'use client'` 只有出现在序言里才是指令；写在函数体里的同名字符串只是字符串。
//
// 逐行扫描而不是上 AST：本扫描器的说明符解析同样是正则级（TypeScript 7 原生版不提供 JS
// 编译器 API），AST 级精度由 ESLint 侧兜底。跳过空行与注释行之后，第一个不是
// 「裸字符串字面量 + 可选分号」的行即序言结束。
//
// 调用方传进来的源码已经抹平过注释，这里仍然自己跳注释行：这一条判的是 Client Component，
// 漏判的代价是把服务端模块打进浏览器 chunk，宁可重复一次也不依赖调用方记得先抹平。
//
// 匹配**任意** `use xxx` 而不是只匹配 `use client` / `use dom`：序言是一串裸字符串字面量，
// 只认那两个词的话，`'use strict';` 打头就会让扫描在此中断，紧随其后的 `'use client';`
// 被漏掉 —— 而那种文件确实是个 Client Component。是不是禁止的指令由调用方按
// `forbidDirectives` 过滤，本函数只负责如实报出序言里有什么。
const DIRECTIVE_LINE = /^(['"])\s*use\s+([A-Za-z-]+)\s*\1\s*;?$/;

export function directivePrologue(source) {
  const directives = [];
  let inBlockComment = false;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line === '' || line.startsWith('//') || line.startsWith('*')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    const match = DIRECTIVE_LINE.exec(line);
    if (!match) break;
    directives.push(`use ${match[2]}`);
  }
  return directives;
}

// 受控边（`rule.controlledEdge`）：把「A 只能通过 B 的受控入口、且只能在服务端适配层里
// 访问 B」变成可判定的四个条件。
//
// 为什么既不是 deny 也不是 inbound：
//   - 写成 `deny.units: ["apps/api"]` 会把设计里那条**合法**边（apps/web 的 server-only
//     Route Handler → apps/api 受控入口）一并禁掉，于是 D6 一落地就必须回来改 D0 的策略 ——
//     这正是 ZLQ-195 §7 弱出口 ① 说的「把门禁做成当前值的快照」的反面：门禁挡住了正确的实现。
//   - 写成 inbound 白名单又禁不掉 Client Component：白名单的单位是「哪个单元」，
//     而这里的判据是「哪个**文件**、带不带客户端指令、导入的是不是受控入口本身」。
// 所以显式建模一条边，默认拒绝，只有同时满足四个条件的说明符才放行。
//
// 四个条件按优先级短路，一处根因只报一条：文件已经是 Client Component 时，路径、说明符、
// `server-only` 全都失去意义（`server-only` 被客户端图引用到时构建期直接抛），
// 把四条一起报出来只会把唯一可操作的那条埋掉。
//   1 文件序言里不得有客户端指令（`use client` / `use dom`）
//   2 文件必须落在适配层白名单路径里
//   3 说明符必须是受控入口本身（不含子路径：受控入口是一个明确的窄面）
//   4 文件必须显式 import `server-only`
function checkControlledEdge({ rule, units, names, root, extensions, appliesTo }) {
  const edge = rule.controlledEdge;
  if (!edge || !appliesTo.has('source')) return [];
  const target = edge.targetUnit;
  if (!units.has(target)) return []; // 目标单元尚未落地，受控边无从触发
  const allowed = new Set(edge.allowedSpecifiers ?? []);
  const adapterMatchers = (edge.adapterFileGlobs ?? []).map(globToRegExp);
  const required = new Set(edge.requireSpecifiers ?? []);
  const forbidden = new Set(edge.forbidDirectives ?? []);
  const found = [];

  for (const unitId of expandUnitPatterns(rule.from ?? [], units)) {
    const unit = units.get(unitId);
    if (!isDirectory(unit.dir)) continue;

    for (const absolute of walkSourceFiles(unit.dir, extensions)) {
      const file = toPosix(relative(root, absolute));
      // 注释先抹平，再收说明符：条件 4 判的是「文件里有没有真的 import 'server-only'」，
      // 而解释「本文件故意少了这一行」的那句话本身就写着 `import 'server-only';`。
      // 不抹平，扫描器会把解释当成导入，这条永远抓不到 —— 四个条件里它最承重。
      const source = stripComments(readFileSync(absolute, 'utf8'));

      // 先收全整份文件的说明符再判定：条件 4 看的是「文件里有没有 import 'server-only'」，
      // 而它完全可能写在越界说明符的后面。逐说明符流式判定会漏掉这种写法。
      const specifiers = [];
      for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source)) !== null) {
          specifiers.push({
            specifier: match[1],
            line: lineOf(source, match.index),
            unit: classifySpecifier(match[1], absolute, unitId, root, units, names).unit ?? null,
          });
        }
      }
      const offending = specifiers.filter((item) => item.unit === target);
      if (offending.length === 0) continue;

      const directives = directivePrologue(source).filter((item) => forbidden.has(item));
      const isAdapter = adapterMatchers.some((matcher) => matcher.test(file));
      const hasServerOnly = specifiers.some((item) => required.has(item.specifier));

      for (const item of offending) {
        const reason =
          directives.length > 0
            ? `Client Component（序言里有 ${directives.map((d) => `'${d}'`).join(' / ')}）` +
              `禁止导入 ${target} 的任何说明符`
            : !isAdapter
              ? `只有 server-only 适配层（${(edge.adapterFileGlobs ?? []).join(' / ')}）` +
                `可以导入受控入口，本文件不在其中`
              : !allowed.has(item.specifier)
                ? `只允许导入受控入口 ${[...allowed].join(' / ')}，实际导入 ${item.specifier}`
                : !hasServerOnly
                  ? `适配层必须显式 import ${[...required].join(' / ')}（构建期兜底），本文件没有`
                  : null;
        if (!reason) continue;
        found.push({
          rule: rule.id,
          spec: rule.spec,
          surface: 'source',
          unit: unitId,
          file,
          line: item.line,
          specifier: item.specifier,
          reason,
        });
      }
    }
  }
  return found;
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
    // 规则引用的单元可能尚未落地（如 §5.4(4) 的 packages/application、受控边的 targetUnit）：
    // 逐条模式单独判断，保持武装但不判失败，包一旦出现即被约束。
    const armedPatterns = [
      ...(rule.from ?? []),
      ...(rule.controlledEdge?.targetUnit ? [rule.controlledEdge.targetUnit] : []),
    ];
    for (const pattern of armedPatterns) {
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

      if (!appliesTo.has('source')) continue;
      scanUnitSource({
        unit,
        unitId,
        root,
        units,
        names,
        extensions,
        onSpecifier: ({ specifier, classified, file, line }) => {
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
              file,
              line,
              specifier,
              reason,
            });
          }
        },
      });
    }

    violations.push(
      ...checkInbound({ rule, units, names, root, extensions, manifestFields, appliesTo }),
      ...checkControlledEdge({ rule, units, names, root, extensions, appliesTo }),
    );
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
// 判定必须走 realpath，见 lib/main-module.mjs：判假的后果是 main() 不跑、静默 exit 0。
if (isMainModule(import.meta.url, process.argv[1])) main();

#!/usr/bin/env node
// UnitReadiness 双重 tripwire 门禁：把 ZLQ-194 §9.2 的「治理反转」变成 CI 里可执行的约束。
//
// 它要治的病是：五个本该装后端的单元在 src/index.ts 里钉着 `skeletonOnly: true`，而它们各自的
// 钉版测试又精确断言这个 true —— 于是「17 道门禁全绿」认证的恰恰是「产品仍然是空的」，
// 谁真去实现反而变红。只把布尔值翻过来治不了这个病：实现之后继续留着 true 一样全绿。
//
// 所以本门禁不复述那个布尔值，而是检查**形状**：
//   1 readiness-flip-tripwire-present   每个单元必须有一条活的、断言就绪面的钉版测试（查它存在且没被跳过，
//                                       不查它断言的是 true 还是 false —— 期望值属于单元自己的测试，不属于 D0）
//   2 readiness-anti-lie-skeleton       status=skeleton 时，src/** 的文件、导出、依赖都必须在清单内，
//                                       且不得出现具名实现标记（route/driver/scanner/handler/…）
//   3 readiness-capabilities-non-empty  status=implemented 时 capabilities 非空，且每个能力都映射到
//                                       本单元 test/** 下一个真实存在、真的会被 vitest 收集、没被跳过、
//                                       且文件里出现该能力名的测试
//   4 readiness-blackbox-proofs         契约点名的黑盒证明能力必须全部出现在 capabilities 里
//   5 readiness-no-retirement-tokens    禁止 skipIf / describe.skip / .only / .todo 作为退役方式
//   6 readiness-no-regression           implemented → skeleton 是状态机禁止的转移（棘轮，不回退）
//
// 规则名、能力名与状态机来自 tools/unit-readiness-contract.json（§9.2 规则 6：契约只存这些，
// 不存「当前有 N 个文件 / N 个测试 / 耗时 X 秒」这类观测量）。
//
// 就绪状态从各单元**自己的** src/index.ts 静态解析，不要求单元 import 任何 tools/ 里的类型：
// 那样会凭空造出一条跨边界依赖，正好撞上本单同时新增的依赖图规则。解析顺序是
//   `export const unitReadiness = { … }` 优先；没有它才回落到 `unitManifest.skeletonOnly`。
// 于是 D2–D6 一旦写下真正的 unitReadiness 声明，第 3、4 道门自动开始生效，不需要回头改 D0。
//
// 退出码：0 无违规；1 有违规；2 控制用例期望值不符（--expect-failures）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { globToRegExp } from './check-dependency-graph.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { stripComments } from './lib/source-scan.mjs';

const DEFAULT_SKIP_DIRS = [
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'test-results',
  'playwright-report',
  'out',
];

const DEFAULT_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    contract: null,
    expectFailures: null,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') args.root = resolve(argv[(i += 1)]);
    else if (token === '--contract') args.contract = resolve(argv[(i += 1)]);
    else if (token === '--expect-failures') args.expectFailures = Number(argv[(i += 1)]);
    else if (token === '--json') args.json = true;
    else if (token === '--quiet') args.quiet = true;
    else throw new Error(`未知参数：${token}`);
  }
  // 契约默认取自调用方仓库（cwd）而不是 --root：与 check-dependency-graph.mjs 同理，
  // 否则夹具就能自带一份「专门抓得住自己」的契约，控制用例成了自证。
  args.contract ??= join(process.cwd(), 'tools', 'unit-readiness-contract.json');
  return args;
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

function walkSourceFiles(dir, extensions, skipDirs, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    if (skipDirs.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (isDirectory(full)) walkSourceFiles(full, extensions, skipDirs, out);
    else if (extensions.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

// 从 startIndex（必须指向开括号）返回配对闭括号的下一位；找不到返回 -1。
function matchBalanced(code, startIndex, open, close) {
  let depth = 0;
  for (let i = startIndex; i < code.length; i += 1) {
    if (code[i] === open) depth += 1;
    else if (code[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function extractStringLiterals(text) {
  const out = [];
  STRING_LITERAL.lastIndex = 0;
  let match;
  while ((match = STRING_LITERAL.exec(text)) !== null) out.push(match[2]);
  return out;
}

const KEY_VALUE_STRING =
  /(?:(['"`])((?:\\.|(?!\1)[^\\])*)\1|([A-Za-z_$][\w$]*))\s*:\s*(['"`])((?:\\.|(?!\4)[^\\])*)\4/g;

function extractStringRecord(text) {
  const out = {};
  KEY_VALUE_STRING.lastIndex = 0;
  let match;
  while ((match = KEY_VALUE_STRING.exec(text)) !== null) {
    const key = match[2] ?? match[3];
    if (key !== undefined) out[key] = match[5];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 就绪声明解析
// ---------------------------------------------------------------------------
const READINESS_DECLARATION = /export\s+const\s+unitReadiness\b[^=]*=\s*\{/;
const SKELETON_ONLY_VALUE = /\bskeletonOnly\s*:\s*(true|false)\b/;

export function parseReadiness(source, states) {
  const code = stripComments(source);
  const problems = [];

  const declaration = READINESS_DECLARATION.exec(code);
  if (declaration) {
    const open = declaration.index + declaration[0].length - 1;
    const end = matchBalanced(code, open, '{', '}');
    if (end < 0) {
      problems.push('unitReadiness 对象字面量花括号不配对，解析不出就绪声明');
      return { declared: true, status: null, capabilities: [], acceptanceTests: {}, problems };
    }
    const body = code.slice(open, end);

    const statusMatch = /\bstatus\s*:\s*(['"`])([^'"`]*)\1/.exec(body);
    const status = statusMatch ? statusMatch[2] : null;
    if (!statusMatch) problems.push('unitReadiness 缺少 status 字段，或 status 不是字符串字面量');
    else if (!states.includes(status))
      problems.push(`unitReadiness.status = '${status}' 不在状态机 ${states.join(' / ')} 里`);

    const capabilitiesMatch = /\bcapabilities\s*:\s*\[/.exec(body);
    let capabilities = [];
    if (!capabilitiesMatch) problems.push('unitReadiness 缺少 capabilities 数组字面量');
    else {
      const openBracket = body.indexOf('[', capabilitiesMatch.index);
      const closeBracket = matchBalanced(body, openBracket, '[', ']');
      if (closeBracket < 0) problems.push('capabilities 数组方括号不配对');
      else capabilities = extractStringLiterals(body.slice(openBracket, closeBracket));
    }

    const testsMatch = /\bacceptanceTests\s*:\s*\{/.exec(body);
    let acceptanceTests = {};
    if (!testsMatch) problems.push('unitReadiness 缺少 acceptanceTests 对象字面量');
    else {
      const openBrace = body.indexOf('{', testsMatch.index);
      const closeBrace = matchBalanced(body, openBrace, '{', '}');
      if (closeBrace < 0) problems.push('acceptanceTests 对象花括号不配对');
      else acceptanceTests = extractStringRecord(body.slice(openBrace, closeBrace));
    }

    return { declared: true, status, capabilities, acceptanceTests, problems };
  }

  const legacy = SKELETON_ONLY_VALUE.exec(code);
  if (!legacy) {
    return {
      declared: false,
      status: null,
      capabilities: [],
      acceptanceTests: {},
      problems: ['既没有 unitReadiness 声明，也没有 unitManifest.skeletonOnly 布尔值'],
    };
  }
  return {
    declared: false,
    status: legacy[1] === 'true' ? 'skeleton' : 'implemented',
    capabilities: [],
    acceptanceTests: {},
    problems: [],
    legacy: legacy[1] === 'true',
    legacyLine: lineOf(code, legacy.index),
  };
}

// ---------------------------------------------------------------------------
// 导出面收集（反撒谎门的「只允许清单中的导出」这一支）
// ---------------------------------------------------------------------------
const NAMED_EXPORT_PATTERNS = [
  /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:declare\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
];

const EXPORT_CLAUSE = /\bexport\s+(?:type\s*)?\{([^}]*)\}/g;

export function collectExports(source) {
  const code = stripComments(source);
  const names = new Set();
  const unbounded = [];

  for (const pattern of NAMED_EXPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) names.add(match[1]);
  }

  EXPORT_CLAUSE.lastIndex = 0;
  let clause;
  while ((clause = EXPORT_CLAUSE.exec(code)) !== null) {
    for (const part of clause[1].split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '');
      if (!trimmed) continue;
      const asMatch = /^(?:[A-Za-z_$][\w$]*|['"`][^'"`]+['"`])\s+as\s+(.+)$/.exec(trimmed);
      const name = (asMatch ? asMatch[1] : trimmed).trim().replace(/^type\s+/, '');
      if (name) names.add(name.replace(/^['"`]|['"`]$/g, ''));
    }
  }

  if (/\bexport\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\b/.test(code))
    unbounded.push('export * from（导出面无界，骨架期不允许）');
  if (/\bexport\s+default\b/.test(code))
    unbounded.push('export default（匿名导出面，骨架期不允许）');

  return { names: [...names].sort(), unbounded };
}

// ---------------------------------------------------------------------------
// 测试声明收集
// ---------------------------------------------------------------------------
const LIVE_TEST = /\b(?:it|test)(?:\.each)?\s*\(/g;
// 一条合并的正则，而不是「后缀式 + 前缀式」两条分别数再相加：`it.todo(` 同时匹配
// `it\s*\.\s*todo\s*\(` 与 `it\.todo\s*\(`，分两趟数会把同一处算成两次退役，
// 减下去 live 就成了 0，门 1 会跟着误判「tripwire 不存在」。
const DEAD_TEST =
  /\b(?:it|test)(?:\.each)?\s*\.\s*(?:skip|todo|skipIf|only)\s*\(|\b(?:it|test)\.(?:skip|todo|skipIf|only)(?:\.each)?\s*\(/g;

export function countTestDeclarations(source) {
  const code = stripComments(source);
  const count = (pattern) => {
    pattern.lastIndex = 0;
    let total = 0;
    while (pattern.exec(code) !== null) total += 1;
    return total;
  };
  // LIVE_TEST 的形状本身就把 `it.skip(` / `it.todo(` / `it.skipIf(` / `it.only(` 排除在外
  // （`it` 与 `(` 之间夹了修饰名），所以 live 不需要再减 dead —— 减了就是把不在 live 里的
  // 东西从 live 里扣掉。dead 单独报出来，供门 5 与证据使用。
  return { live: count(LIVE_TEST), dead: count(DEAD_TEST) };
}

// 只列 §9.2 规则 5 与 ZLQ-195 §7 弱出口 ② 点名的四个 token（skip / only / todo / skipIf）。
// 刻意不含 `it.fails`：规则 5 没有列它，而 D4 的「每个拦截类别的负例都必须失败」这类
// 黑盒证明有可能正当地用到期望失败的写法 —— 门禁不该比契约更严。
const RETIREMENT_CALL =
  /\b(?:describe|it|test|suite|bench)\s*\.\s*(?:skip|only|todo|skipIf)\b|\bskipIf\s*\(/g;

export function findRetirementTokens(source) {
  const code = stripComments(source);
  const hits = [];
  RETIREMENT_CALL.lastIndex = 0;
  let match;
  while ((match = RETIREMENT_CALL.exec(code)) !== null) {
    hits.push({ text: match[0].replace(/\s+/g, ''), line: lineOf(code, match.index) });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 具名实现标记
// ---------------------------------------------------------------------------
function normalizeIdentifier(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^@/, '');
}

export function markerHitsIn(name, markers) {
  const normalized = normalizeIdentifier(name);
  return markers.filter((marker) => normalized.includes(normalizeIdentifier(marker)));
}

function collectDependencyNames(manifest, fields) {
  const out = new Set();
  for (const field of fields) {
    for (const dependency of Object.keys(manifest?.[field] ?? {})) out.add(dependency);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// 主检查
// ---------------------------------------------------------------------------
export function checkUnitReadiness({ root, contractFile }) {
  const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
  const states = contract.stateMachine?.states ?? ['skeleton', 'implemented'];
  const skipDirs = new Set(contract.skipDirs ?? DEFAULT_SKIP_DIRS);
  const extensions = contract.sourceExtensions ?? DEFAULT_SOURCE_EXTENSIONS;
  const manifestFields = contract.manifestFields ?? [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  const surface = contract.readinessSurface ?? ['skeletonOnly', 'unitReadiness'];
  const markers = contract.implementationMarkers ?? [];
  const alwaysAllowedExports = new Set(contract.alwaysAllowedExports ?? []);
  const testFileGlobs = (contract.testFileGlobs ?? ['test/**/*.test.ts']).map(globToRegExp);
  const unitEntries = Object.entries(contract.units ?? {});

  const violations = [];
  const push = (gate, unit, file, line, subject, reason) =>
    violations.push({
      gate,
      spec: contract.gates?.find((g) => g.id === gate)?.spec ?? '',
      unit,
      file,
      line,
      subject,
      reason,
    });

  const unitsChecked = [];
  const contractedButAbsent = [];
  const pendingDeclaration = [];
  const resolved = new Map();

  for (const [unitId, unitContract] of unitEntries) {
    const unitDir = join(root, unitId);
    if (!isDirectory(unitDir)) {
      contractedButAbsent.push(unitId);
      continue;
    }
    unitsChecked.push(unitId);

    const srcDir = join(unitDir, 'src');
    const testDir = join(unitDir, 'test');
    const srcFiles = walkSourceFiles(srcDir, extensions, skipDirs);
    const testFiles = walkSourceFiles(testDir, extensions, skipDirs);
    const rel = (absolute) => toPosix(relative(root, absolute));

    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(join(unitDir, 'package.json'), 'utf8'));
    } catch {
      manifest = null;
    }

    // --- 就绪状态解析 -----------------------------------------------------
    const entryFile =
      srcFiles.find(
        (file) => basename(file) === 'index.ts' && file.endsWith(join('src', 'index.ts')),
      ) ??
      srcFiles[0] ??
      null;
    let readiness = {
      declared: false,
      status: null,
      capabilities: [],
      acceptanceTests: {},
      problems: [`找不到 ${unitId}/src 下的入口文件，无法解析就绪声明`],
    };
    let readinessFile = null;
    if (entryFile) {
      readinessFile = entryFile;
      readiness = parseReadiness(readFileSync(entryFile, 'utf8'), states);
    }

    // 声明可能不在 index.ts（例如单元把它拆到 readiness.ts）：全 src 扫一遍取第一个命中的。
    if (!readiness.declared) {
      for (const file of srcFiles) {
        if (file === entryFile) continue;
        const parsed = parseReadiness(readFileSync(file, 'utf8'), states);
        if (parsed.declared) {
          readiness = parsed;
          readinessFile = file;
          break;
        }
      }
    }

    for (const problem of readiness.problems)
      push(
        'readiness-declaration-unparseable',
        unitId,
        readinessFile ? rel(readinessFile) : `${unitId}/src`,
        null,
        'unitReadiness',
        problem,
      );

    const status = readiness.status;
    resolved.set(unitId, { status, declared: readiness.declared });

    // --- 门 6：implemented → skeleton 是状态机禁止的转移 ------------------
    //
    // 棘轮不靠契约里记一个「本单元曾经是 implemented」的布尔值 —— 那就是把门做成当前值的
    // 快照，而且五个单元每翻一次都要回来改 D0 的文件。这里改成从契约**结构**推导：
    // 契约给了骨架清单的单元才允许处在 skeleton；没给过的单元按此事实即已越过骨架期，
    // 解析回 skeleton 就是被禁止的转移。等 D2–D6 把五个单元翻成 implemented，它们的
    // 骨架清单自然失效（门 2 只在 status=skeleton 时约束），不需要任何 D0 改动；而此后
    // 谁想把它退回 skeleton，门 2 会要求先删掉全部实现文件、导出与依赖才可能过 ——
    // 那本身就是一次显式的、必须过评审的回退。
    const allowedTransitions = (contract.stateMachine?.transitions ?? []).map(
      (item) => `${item.from}->${item.to}`,
    );
    if (unitContract.skeleton === undefined && status === 'skeleton') {
      push(
        'readiness-no-regression',
        unitId,
        readinessFile ? rel(readinessFile) : unitId,
        readiness.legacyLine ?? null,
        'status',
        `契约没有为本单元登记骨架清单，即它已越过骨架期；状态机只允许 ${allowedTransitions.join(', ') || '（无）'}，` +
          '解析出 skeleton 属于被禁止的回退。',
      );
    }

    // --- 门 1：翻转 tripwire 必须存在且活着 ------------------------------
    const hasTripwire = testFiles.some((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (countTestDeclarations(code).live < 1) return false;
      return code
        .split('\n')
        .some(
          (line) =>
            surface.some((term) => line.includes(term)) &&
            /expect\s*\(|\.toBe\s*\(|\.toEqual\s*\(|\.toMatch\s*\(|\.toSatisfy\s*\(/.test(line),
        );
    });
    if (!hasTripwire) {
      push(
        'readiness-flip-tripwire-present',
        unitId,
        `${unitId}/test`,
        null,
        surface.join(' / '),
        `test/** 里找不到一条活着的、断言就绪面（${surface.join(' / ')}）的钉版测试。` +
          '没有它，改状态不会先红 —— 显式翻转门等于不存在。',
      );
    }

    // --- 门 5：禁止用 skip/only/todo/skipIf 退役 -------------------------
    for (const file of testFiles) {
      for (const hit of findRetirementTokens(readFileSync(file, 'utf8'))) {
        push(
          'readiness-no-retirement-tokens',
          unitId,
          rel(file),
          hit.line,
          hit.text,
          '禁止用 skip / only / todo / skipIf 让门禁静默通过（§9.2 规则 5）：' +
            '被跳过的用例不会变红，只会消失。',
        );
      }
    }

    // --- 门 2：反撒谎（只在 status=skeleton 时约束） ---------------------
    if (status === 'skeleton') {
      const allow = unitContract.skeleton ?? {};
      const allowedFiles = (allow.files ?? []).map(globToRegExp);
      const allowedExports = new Set([...(allow.exports ?? []), ...alwaysAllowedExports]);
      const allowedDependencies = new Set([
        ...(allow.dependencies ?? []),
        ...(allow.frozenDependencies ?? []),
      ]);

      for (const file of srcFiles) {
        const unitRelative = toPosix(relative(unitDir, file));
        if (!allowedFiles.some((matcher) => matcher.test(unitRelative))) {
          push(
            'readiness-anti-lie-skeleton',
            unitId,
            rel(file),
            null,
            unitRelative,
            `status=skeleton，但 ${unitRelative} 不在骨架文件清单（${(allow.files ?? []).join(', ') || '<空>'}）里`,
          );
        }
      }

      for (const file of srcFiles) {
        const { names, unbounded } = collectExports(readFileSync(file, 'utf8'));
        for (const note of unbounded)
          push(
            'readiness-anti-lie-skeleton',
            unitId,
            rel(file),
            null,
            note,
            `status=skeleton，${note}`,
          );
        for (const name of names) {
          if (allowedExports.has(name)) continue;
          const hits = markerHitsIn(name, markers);
          push(
            'readiness-anti-lie-skeleton',
            unitId,
            rel(file),
            null,
            name,
            hits.length > 0
              ? `status=skeleton，却导出了具名实现 ${name}（命中标记 ${hits.join(', ')}）`
              : `status=skeleton，导出 ${name} 不在骨架导出清单里`,
          );
        }
        for (const marker of markers) {
          if (markerHitsIn(basename(file), [marker]).length === 0) continue;
          push(
            'readiness-anti-lie-skeleton',
            unitId,
            rel(file),
            null,
            basename(file),
            `status=skeleton，文件名 ${basename(file)} 带具名实现标记 ${marker}`,
          );
        }
      }

      const dependencies = collectDependencyNames(manifest, manifestFields);
      for (const dependency of dependencies) {
        if (allowedDependencies.has(dependency)) continue;
        push(
          'readiness-anti-lie-skeleton',
          unitId,
          `${unitId}/package.json`,
          null,
          dependency,
          `status=skeleton，依赖 ${dependency} 不在骨架依赖清单里`,
        );
      }
    }

    // --- 门 3 + 门 4：implemented 的能力与黑盒证明 -----------------------
    const requiredProofs = unitContract.requiredProofs ?? [];
    if (status === 'implemented') {
      if (!readiness.declared && requiredProofs.length > 0) {
        push(
          'readiness-blackbox-proofs',
          unitId,
          readinessFile ? rel(readinessFile) : unitId,
          readiness.legacyLine ?? null,
          'unitReadiness',
          `本单元被契约点名需要黑盒证明（${requiredProofs.join(', ')}），` +
            '但只有 legacy 的 skeletonOnly:false，没有 unitReadiness 声明 —— 能力清单与验收测试映射都不存在。',
        );
      }

      if (readiness.declared) {
        if (readiness.capabilities.length === 0) {
          push(
            'readiness-capabilities-non-empty',
            unitId,
            rel(readinessFile),
            null,
            'capabilities',
            "status='implemented' 但 capabilities 为空 —— 这就是「翻个布尔值就宣称已实现」。",
          );
        }

        for (const proof of requiredProofs) {
          if (readiness.capabilities.includes(proof)) continue;
          push(
            'readiness-blackbox-proofs',
            unitId,
            rel(readinessFile),
            null,
            proof,
            `契约要求本单元声明黑盒证明能力 ${proof}，capabilities 里没有它。`,
          );
        }

        for (const capability of readiness.capabilities) {
          const target = readiness.acceptanceTests[capability];
          if (target === undefined) {
            push(
              'readiness-capabilities-non-empty',
              unitId,
              rel(readinessFile),
              null,
              capability,
              `能力 ${capability} 在 acceptanceTests 里没有映射 —— 无法证明它被任何测试覆盖。`,
            );
            continue;
          }

          const matches = testFiles.filter((file) =>
            globToRegExp(target).test(toPosix(relative(unitDir, file))),
          );
          if (matches.length === 0) {
            const globOk = testFileGlobs.some((matcher) => matcher.test(target));
            push(
              'readiness-capabilities-non-empty',
              unitId,
              rel(readinessFile),
              null,
              `${capability} -> ${target}`,
              `能力 ${capability} 映射到 ${target}，但 ${unitId}/${target} 不存在。` +
                (globOk
                  ? ''
                  : ` 且该路径不在 vitest 会收集的测试文件形状（${(contract.testFileGlobs ?? []).join(', ')}）里，即使存在也不会被执行。`),
            );
            continue;
          }

          for (const file of matches) {
            const source = readFileSync(file, 'utf8');
            const declarations = countTestDeclarations(source);
            if (declarations.live < 1) {
              push(
                'readiness-capabilities-non-empty',
                unitId,
                rel(file),
                null,
                capability,
                `能力 ${capability} 映射到 ${target}，但该文件里没有一条活着的测试用例（全部被跳过或根本没写）。`,
              );
            }
            if (!stripComments(source).includes(capability)) {
              push(
                'readiness-capabilities-non-empty',
                unitId,
                rel(file),
                null,
                capability,
                `能力 ${capability} 映射到 ${target}，但该文件里没有出现能力名 ${capability} —— ` +
                  '映射指向的可能是一个无关的既有测试。',
              );
            }
          }
        }
      } else {
        pendingDeclaration.push(unitId);
      }
    }
  }

  // 契约点名的冻结依赖必须真的在（冻结不是装饰：被摘掉就该红）。
  for (const entry of contract.dependencyFreeze?.entries ?? []) {
    for (const unitId of entry.consumedBy ?? []) {
      if (!unitsChecked.includes(unitId)) continue;
      let manifest = null;
      try {
        manifest = JSON.parse(readFileSync(join(root, unitId, 'package.json'), 'utf8'));
      } catch {
        manifest = null;
      }
      const declared = collectDependencyNames(manifest, manifestFields);
      if (declared.includes(entry.package)) continue;
      push(
        'readiness-dependency-freeze-intact',
        unitId,
        `${unitId}/package.json`,
        null,
        entry.package,
        `依赖冻结条目 ${entry.id} 要求 ${unitId} 声明 ${entry.package}，但 package.json 里没有它` +
          `（${entry.spec}）。冻结的意义就是让后续单不必回来改 D0 的文件；被摘掉必须红。`,
      );
    }
  }

  return {
    root: toPosix(root),
    contractVersion: contract.version,
    gateIds: (contract.gates ?? []).map((gate) => gate.id).sort(),
    unitsChecked: unitsChecked.sort(),
    contractedButAbsent: contractedButAbsent.sort(),
    pendingDeclaration: pendingDeclaration.sort(),
    resolvedStatus: [...resolved.entries()].sort().map(([unit, value]) => ({ unit, ...value })),
    violations,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.contract)) {
    process.stderr.write(`!! 找不到就绪契约文件：${args.contract}\n`);
    process.exit(1);
  }
  const result = checkUnitReadiness({ root: args.root, contractFile: args.contract });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!args.quiet) {
    const line = (text = '') => process.stdout.write(`${text}\n`);
    line('== UnitReadiness 双重 tripwire 门禁 ==');
    line(
      `契约：${toPosix(relative(process.cwd(), args.contract))}（version ${result.contractVersion}，${result.gateIds.length} 道门）`,
    );
    line(`扫描单元：${result.unitsChecked.join(', ') || '<无>'}`);
    if (result.contractedButAbsent.length > 0)
      line(`契约点名但目录不存在：${result.contractedButAbsent.join(', ')}`);
    if (result.pendingDeclaration.length > 0)
      line(
        `已实现但尚未采用 unitReadiness 声明（能力清单待补，声明一落地第 3/4 道门即自动生效）：${result.pendingDeclaration.join(', ')}`,
      );
    if (result.violations.length === 0) {
      line('结果：0 处违规。');
    } else {
      line(`结果：${result.violations.length} 处违规。`);
      for (const item of result.violations) {
        const where = item.line ? `${item.file}:${item.line}` : item.file;
        line(`  - [${item.gate}] ${where} ${item.subject} -> ${item.reason}`);
        if (item.spec) line(`    ${item.spec}`);
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
        `控制用例通过：故意植入的 ${args.expectFailures} 处违规全部被识别（涉及门 ${[...new Set(result.violations.map((item) => item.gate))].sort().join(', ')}）。\n`,
      );
    }
    process.exit(0);
  }

  process.exit(result.violations.length > 0 ? 1 : 0);
}

// 判定必须走 realpath，见 lib/main-module.mjs：判假的后果是 main() 不跑、静默 exit 0。
if (isMainModule(import.meta.url, process.argv[1])) main();

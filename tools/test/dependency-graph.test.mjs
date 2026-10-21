// 静态依赖图门禁的测试。
//
// 这里最重要的一条不是「真实仓库 0 违规」，而是「故意植入的违规必须被抓到」：
// 一个永远返回 0 的门禁在 CI 里同样是绿的。所以控制用例的断言是双向的 ——
// 数量必须精确等于 14（少一处 = 假阴性，多一处 = 规则误报），且每条被点名的规则都要出现。
//
// 计数 14 的来历见 tools/__fixtures__/dep-graph-violation/README.md 的表格：
// 1–8 是 ZLQ-153 的边界，9–13 由 ZLQ-195 §3.2 追加（受控边四个条件各一处 + runtime 那一半），
// 14 由 ZLQ-195 §3.4 的依赖冻结追加（冻结把 @neondatabase/serverless 带进仓库，
// 于是 @neondatabase/ 前缀补进了三条本来就带 @libsql/ 的规则，并留下命中证据；
// runtime 那一条补不了 —— 它被 apps/runtime 的自述锁死，属 D2–D5 禁区，见下面第 14 处用例）。
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkDependencyGraph,
  directivePrologue,
  globToRegExp,
} from '../check-dependency-graph.mjs';
import { isMainModule } from '../lib/main-module.mjs';
import { stripComments } from '../lib/source-scan.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const POLICY = join(REPO_ROOT, 'config', 'dependency-graph.json');
const FIXTURE = join(REPO_ROOT, 'tools', '__fixtures__', 'dep-graph-violation');
// 出向禁止单独成树：主夹具的违规计数被根 package.json 的 `--expect-failures 14` 锁死，
// 往里再塞一处出向违规就要跟着改那串锁步文案。见该树 README。
const OUTBOUND_FIXTURE = join(REPO_ROOT, 'tools', '__fixtures__', 'api-contract-outbound');
const CHECKER = join(REPO_ROOT, 'tools', 'check-dependency-graph.mjs');
const READINESS_CHECKER = join(REPO_ROOT, 'tools', 'check-unit-readiness.mjs');
const TOOLS_LIB = join(REPO_ROOT, 'tools', 'lib');

const CONTROLLED_EDGE = 'web-server-adapter-only-controlled-api-entry';

// 夹具里植入的 14 处违规，逐条写死期望值：规则 id + 表面 + 说明符 + 文件。
// 这份清单本身就是「边界规则确实覆盖到了 issue 点名的那些约束」的证据。
// `why` 不参与比对，只是让读到失败输出的人知道这一行在证明什么。
const EXPECTED = [
  {
    rule: 'domain-no-platform-sdk',
    surface: 'manifest',
    specifier: '@nestjs/common',
    file: 'packages/domain/package.json',
    why: '领域层不得依赖平台 SDK',
  },
  {
    rule: 'domain-no-platform-sdk',
    surface: 'manifest',
    specifier: 'pg',
    file: 'packages/domain/package.json',
    why: '领域层不得依赖数据库驱动',
  },
  // 表格第 14 处：ZLQ-195 §3.4 的依赖冻结把 @neondatabase/serverless 带进仓库之后，
  // `@neondatabase/` 前缀补进了三条本来就带 `@libsql/` 的规则 —— 只冻结不补前缀，
  // 领域层就能在门禁全绿的情况下直接 import 数据库驱动，那是我自己引入的治理回退。
  {
    rule: 'domain-no-platform-sdk',
    surface: 'manifest',
    specifier: '@neondatabase/serverless',
    file: 'packages/domain/package.json',
    why: 'ZLQ-195 §3.4：被冻结的 Neon 驱动与 pg、@libsql/ 同属一类，领域层同样不得依赖',
  },
  {
    rule: 'domain-and-application-no-drivers',
    surface: 'source',
    specifier: '../../domain/src/drivers/pg-driver',
    file: 'packages/application/src/index.ts',
    why: '§5.4(4)：application 也不许碰 drivers/*，且该包尚未落地时规则保持武装',
  },
  {
    rule: 'domain-and-application-no-drivers',
    surface: 'source',
    specifier: './drivers/pg-driver',
    file: 'packages/domain/src/index.ts',
    why: '§5.4(4)：domain 不许碰 drivers/*',
  },
  {
    rule: 'domain-no-workspace-deps',
    surface: 'source',
    specifier: '../../infra/src/db',
    file: 'packages/domain/src/index.ts',
    why: '领域层不反向依赖 infra',
  },
  {
    rule: 'runtime-no-main-site-secrets',
    surface: 'manifest',
    specifier: 'openai',
    file: 'apps/runtime/package.json',
    why: '作品运行时不持有 AI 凭证',
  },
  {
    rule: 'runtime-no-main-site-units',
    surface: 'source',
    specifier: '@littleq/infra',
    file: 'apps/runtime/src/index.ts',
    why: '作品运行时不触达主站基础设施',
  },
  {
    rule: 'runtime-no-main-site-units',
    surface: 'source',
    specifier: '@littleq/api',
    file: 'apps/runtime/src/index.ts',
    why: 'ZLQ-194 §13(4) 的「runtime 仍禁止」：由既有规则承担，不由受控边承担',
  },
  // 第 8 处（表格编号）走 `api-contract-no-platform-coupling` 的**入向** `inbound.default=deny`：
  // apps/runtime 不在 allowFrom（apps/api, packages/application）里，所以它不需要被任何
  // 规则点名就已经违规。这正是「不能把当前禁止方写死成枚举」的可判定证据。
  {
    rule: 'api-contract-no-platform-coupling',
    surface: 'source',
    specifier: '@littleq/api-contract',
    file: 'apps/runtime/src/index.ts',
    why: '入向白名单默认拒绝',
  },
  // 9–12：受控边的四个条件，每棵树只让一个条件失守。
  {
    rule: CONTROLLED_EDGE,
    surface: 'source',
    specifier: '@littleq/api/server',
    file: 'apps/web/app/api/v1/projects/route.ts',
    condition: 4,
    reasonIncludes: '必须显式 import server-only',
    why: '条件 4：适配层少了构建期兜底 import',
  },
  {
    rule: CONTROLLED_EDGE,
    surface: 'source',
    specifier: '@littleq/api',
    file: 'apps/web/app/api/v1/preview/route.ts',
    condition: 3,
    reasonIncludes: '只允许导入受控入口 @littleq/api/server，实际导入 @littleq/api',
    why: '条件 3：导入桶入口而不是受控入口',
  },
  {
    rule: CONTROLLED_EDGE,
    surface: 'source',
    specifier: '@littleq/api/server',
    file: 'apps/web/src/server/api-bridge.ts',
    condition: 2,
    reasonIncludes: '只有 server-only 适配层',
    why: '条件 2：从非适配层路径访问受控入口',
  },
  {
    rule: CONTROLLED_EDGE,
    surface: 'source',
    specifier: '@littleq/api/server',
    file: 'apps/web/src/components/project-list.tsx',
    condition: 1,
    reasonIncludes: "Client Component（序言里有 'use client'）",
    why: '条件 1：Client Component 导入 apps/api',
  },
];

const SENTINELS = [
  ['SENTINEL:web-controlled-edge-N1', 'apps/web/app/api/v1/projects/route.ts'],
  ['SENTINEL:web-controlled-edge-N2', 'apps/web/app/api/v1/preview/route.ts'],
  ['SENTINEL:web-controlled-edge-N3', 'apps/web/src/server/api-bridge.ts'],
  ['SENTINEL:web-controlled-edge-N4', 'apps/web/src/components/project-list.tsx'],
  ['SENTINEL:runtime-no-api', 'apps/runtime/src/index.ts'],
  ['SENTINEL:api-contract-inbound', 'apps/runtime/src/index.ts'],
];

function runChecker(extraArgs) {
  const result = spawnSync(process.execPath, [CHECKER, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

// 临时目录只在这些对照用例里存在：把夹具复制出去、改动哨兵行，再扫一遍。
// 用完即删，绝不改动仓库里的夹具本体（夹具的字节本身就是被测输入）。
const tempRoots = [];

function inTempRoot(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'littleq-dep-graph-control-'));
  tempRoots.push(root);
  mutate(root);
  return root;
}

function tempFixture(mutate) {
  return inTempRoot((dir) => {
    cpSync(FIXTURE, dir, { recursive: true });
    mutate(dir);
  });
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** 删掉文件里带 `marker` 的那一行，返回删掉了几行。 */
function dropSentinelLine(file, marker) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((line) => !line.includes(marker));
  writeFileSync(file, `${kept.join('\n')}`, 'utf8');
  return lines.length - kept.length;
}

/**
 * 在文件里把 `from` 子串换成 `to`，返回命中了几行。
 *
 * 必须**行内替换**而不是整行替换：整行换掉会把 `import ... from` 这个语句本身也带走，
 * 于是「违规消失」的原因成了「这里根本没有导入语句」，而不是「说明符换成合法的了」——
 * 那是一条空转对照，看着绿，什么都没证明。
 */
function replaceInLines(file, from, to) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits = lines.filter((line) => line.includes(from)).length;
  writeFileSync(file, lines.map((line) => line.split(from).join(to)).join('\n'), 'utf8');
  return hits;
}

/**
 * 把生产 checker 复制成一个「只有一个变量不同」的副本，返回副本路径。
 *
 * 副本要真能跑起来，就得把它 import 的 `tools/lib/` 一并带过去（原样复制，一个字节不改）；
 * 被替换的只有 `fromLine` 那一行。A/B 比出来的差集因此只可能来自那一个变量 ——
 * 改扫描正则、改副本的其它部分、改夹具，都会让这个归因失效。
 */
function mutatedCheckerCopy(dir, fromLine, toLine) {
  const source = readFileSync(CHECKER, 'utf8');
  expect(source).toContain(fromLine);
  const mutated = source.replace(fromLine, toLine);
  expect(mutated).not.toContain(fromLine);
  cpSync(TOOLS_LIB, join(dir, 'lib'), { recursive: true });
  const script = join(dir, 'mutated-checker.mjs');
  writeFileSync(script, mutated, 'utf8');
  return script;
}

/** 哨兵所在行号（1 起）。用它断言行号，比写死数字更经得起注释增删。 */
function sentinelLine(relPath, marker) {
  const lines = readFileSync(join(FIXTURE, ...relPath.split('/')), 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(marker));
  expect(index).toBeGreaterThanOrEqual(0);
  return index + 1;
}

function fixtureViolations(root = FIXTURE) {
  return checkDependencyGraph({ root, policyFile: POLICY }).violations;
}

const shape = ({ rule, surface, specifier, file }) => ({ rule, surface, specifier, file });
const sortKey = (item) => `${item.rule}|${item.surface}|${item.specifier}|${item.file}`;
const sorted = (items) => [...items].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

describe('真实仓库的边界门禁', () => {
  it('当前 10 个工作区单元 0 违规', () => {
    const result = checkDependencyGraph({ root: REPO_ROOT, policyFile: POLICY });
    expect(result.violations).toEqual([]);
    expect(result.unitsChecked).toEqual([
      'apps/api',
      'apps/runtime',
      'apps/web',
      'apps/worker',
      'packages/api-contract',
      // ZLQ-220（F1）落地：§3.5 的两个装配端口住在这个新单元里。这份清单钉的是**成员**
      // 而不是数量，所以新增一个工作区单元必然要在这里加一行 —— 它的用途是抓住"悄悄多出来
      // 的单元"，而按 ZLQ-216 §3.5 建包不是悄悄做的。
      'packages/application',
      'packages/design-system',
      'packages/domain',
      'packages/infra',
      'packages/work-contract',
    ]);
  });

  it('新规则已进入策略，且真实仓库里 apps/api 已落地（受控边不是空转）', () => {
    const result = checkDependencyGraph({ root: REPO_ROOT, policyFile: POLICY });
    expect(result.ruleCount).toBe(10);
    // 受控边的目标单元不存在时整条规则静默不生效（见 checkControlledEdge 的提前返回）。
    // 真实仓库里 apps/api 必须存在，否则这条规则在生产上等于没写。
    expect(result.unitsChecked).toContain('apps/api');
  });

  it('§5.4(4) 的 packages/application 已落地，规则从"预先武装"变成真的在管一个单元', () => {
    const result = checkDependencyGraph({ root: REPO_ROOT, policyFile: POLICY });
    // 这条用例曾经断言 armedButAbsent 里**有** packages/application：那时 §1.3 的目录骨架里
    // 还没有这个包，规则只能按路径预先武装，并在报告里显式列出「已武装但未落地」，好把
    // 「规则写错了路径」与「包还没建」两种情况区分开。ZLQ-220（F1）按 §3.5 建了这个包，
    // 于是清单空了 —— 规则现在约束的是一个真实存在的单元，不再是一条将来时。
    expect(result.armedButAbsent).toEqual([]);
    // 但空清单有两种成因，只有一种是好消息：另一种是规则被删了或路径被改错，那样
    // armedButAbsent 同样为空。所以下面两句才是判据 —— 单元必须在扫描面里，规则必须还在。
    expect(result.unitsChecked).toContain('packages/application');
    expect(result.ruleCount).toBe(10);

    // 阴性对照：夹具树里 packages/design-system **不存在**，同一个字段在那棵树上必须非空。
    // 少了这一句，上面的 `toEqual([])` 会退化成一条对任何仓库都为真的断言 —— 而"规则被删"
    // 恰好也让它为真，那就等于把守卫和它要抓的缺陷一起放过了。
    const fixture = checkDependencyGraph({ root: FIXTURE, policyFile: POLICY });
    expect(fixture.armedButAbsent).toEqual([
      {
        rule: 'design-system-no-business-coupling',
        unit: 'packages/design-system',
        spec: 'ZLQ-153 §1.3（packages/design-system 不耦合业务数据请求）',
      },
    ]);
  });

  it('命令行直跑真实仓库返回 0', () => {
    const run = runChecker(['--quiet']);
    expect(run.exitCode).toBe(0);
  });
});

describe('控制用例：故意植入的违规必须被识别（反假阴性）', () => {
  it('精确命中 14 处，逐条对得上规则、说明符与文件', () => {
    const actual = fixtureViolations().map(shape);
    expect(actual).toHaveLength(EXPECTED.length);
    // 顺序无关：按四个字段排序后逐一比对，避免「靠目录遍历顺序碰巧通过」。
    expect(sorted(actual)).toEqual(sorted(EXPECTED.map(shape)));
  });

  it('每处违规都带 spec 锚点与可定位的文件位置', () => {
    for (const violation of fixtureViolations()) {
      expect(violation.spec).toMatch(/ZLQ-1(?:53|94)/);
      expect(violation.file).toBeTruthy();
      // source 表面必须给出行号，否则 CI 报错无法定位；manifest 表面没有行号概念。
      if (violation.surface === 'source') expect(typeof violation.line).toBe('number');
    }
  });

  it('受控边的四处各自报出自己那一条条件的原因文本（不是笼统的「越界」）', () => {
    const violations = fixtureViolations().filter((item) => item.rule === CONTROLLED_EDGE);
    expect(violations).toHaveLength(4);
    for (const expected of EXPECTED.filter((item) => item.rule === CONTROLLED_EDGE)) {
      const actual = violations.find((item) => item.file === expected.file);
      expect(actual, expected.file).toBeDefined();
      expect(actual.reason).toContain(expected.reasonIncludes);
      expect(actual.spec).toContain('ZLQ-194 §4.3');
    }
  });

  it('五处新植入的违规行号等于哨兵所在行（行号不是猜的）', () => {
    const violations = fixtureViolations();
    for (const [marker, relPath] of SENTINELS) {
      const hits = violations.filter(
        (item) => item.file === relPath && item.line === sentinelLine(relPath, marker),
      );
      expect(hits.length, `${marker} @ ${relPath}`).toBe(1);
    }
  });

  it('--expect-failures 14 通过；13 或 15 都以退出码 2 失败（控制用例自身不是空断言）', () => {
    const fixtureArgs = ['--root', 'tools/__fixtures__/dep-graph-violation'];
    expect(runChecker([...fixtureArgs, '--expect-failures', '14', '--quiet']).exitCode).toBe(0);

    const tooFew = runChecker([...fixtureArgs, '--expect-failures', '13', '--quiet']);
    expect(tooFew.exitCode).toBe(2);
    expect(tooFew.stderr).toContain('控制用例失效');

    const tooMany = runChecker([...fixtureArgs, '--expect-failures', '15', '--quiet']);
    expect(tooMany.exitCode).toBe(2);
    expect(tooMany.stderr).toContain('控制用例失效');
  });

  it('不带 --expect-failures 时，有违规就以退出码 1 失败', () => {
    // 这条是「门禁真的会拦人」的直接证明：CI 里的 dep-graph 作业走的就是这个分支。
    expect(
      runChecker(['--root', 'tools/__fixtures__/dep-graph-violation', '--quiet']).exitCode,
    ).toBe(1);
  });

  it('控制用例用线上那份真策略，而不是夹具自带的策略副本', () => {
    // --policy 默认取 cwd（调用方仓库），不跟随 --root。若默认值跟着 --root 走，
    // 夹具就能带一份「专门抓得住自己」的策略，控制用例便成了自证。
    const run = runChecker([
      '--root',
      'tools/__fixtures__/dep-graph-violation',
      '--expect-failures',
      '14',
    ]);
    expect(run.stdout).toContain('策略：config/dependency-graph.json');
  });

  it('第 8 处违规带植入哨兵：删掉那一行，14 处计数立刻以退出码 2 变红', () => {
    const marker = 'SENTINEL:api-contract-inbound';
    const sentinelFile = join(FIXTURE, 'apps', 'runtime', 'src', 'index.ts');
    // 先证明哨兵真的在夹具里。没有这一步，「删掉后变绿」可能只是因为根本没删到东西。
    expect(readFileSync(sentinelFile, 'utf8')).toContain(marker);

    const root = tempFixture((dir) => {
      expect(dropSentinelLine(join(dir, 'apps', 'runtime', 'src', 'index.ts'), marker)).toBe(1);
    });

    // 生产 checker + 生产策略，只换 --root。13 处仍然命中（门禁没有整体失效），
    // 但 `--expect-failures 14` 必须红 —— 这就是「14 而不是 13」的正向对照。
    expect(fixtureViolations(root)).toHaveLength(13);
    expect(runChecker(['--root', root, '--expect-failures', '14', '--quiet']).exitCode).toBe(2);
    expect(runChecker(['--root', root, '--expect-failures', '13', '--quiet']).exitCode).toBe(0);
  });

  it('第 14 处（被冻结的 Neon 驱动）：摘掉那个键，14 处计数立刻以退出码 2 变红', () => {
    // 这一处是 ZLQ-195 §3.4 依赖冻结自己带出来的控制用例，形状与上一条相同，
    // 只有两点不同：它落在 manifest 而不是 source，而 JSON 不能带注释，
    // 所以没有 `SENTINEL:` 行尾标记可用 —— 定位靠键名，删除靠重写 JSON。
    const dependency = '@neondatabase/serverless';
    const relPath = ['packages', 'domain', 'package.json'];
    const manifestFile = join(FIXTURE, ...relPath);
    const before = JSON.parse(readFileSync(manifestFile, 'utf8'));
    // 反空转前置：这个键必须真的在夹具里，且它命中的规则必须真的武装了这个前缀。
    // 少了后半句，「删掉后计数掉 1」也可能只是碰巧被别的规则抓到（比如 `pg` 那条），
    // 证明不了 @neondatabase/ 前缀本身承重。
    expect(before.dependencies[dependency]).toBe('0.0.0-fixture');
    const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
    const armed = policy.rules.filter((rule) =>
      (rule.deny?.packagePrefixes ?? []).includes('@neondatabase/'),
    );
    expect(armed.map((rule) => rule.id)).toEqual([
      'domain-no-platform-sdk',
      'work-contract-no-platform-coupling',
      'api-contract-no-platform-coupling',
    ]);
    // runtime 那条**故意不在**这个列表里，理由与补法写在 config/dependency-graph.json
    // 的 runtime-no-main-site-secrets.description 里，并由下面那条缺口用例钉住。
    expect(
      policy.rules.find((rule) => rule.id === 'runtime-no-main-site-secrets').deny.packagePrefixes,
    ).not.toContain('@neondatabase/');

    const root = tempFixture((dir) => {
      const file = join(dir, ...relPath);
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      delete manifest.dependencies[dependency];
      // 只摘这一个键：同文件里的 @nestjs/common 与 pg 两处必须原样留着，
      // 否则计数掉 3，就分不清掉的那一处到底归因于谁。
      expect(Object.keys(manifest.dependencies)).toEqual(['@nestjs/common', 'pg']);
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    });

    expect(fixtureViolations(root)).toHaveLength(13);
    expect(fixtureViolations(root).filter((item) => item.specifier === dependency)).toEqual([]);
    // 同文件里的另两处仍在 —— 证明这一处不是靠「整个文件没被扫到」掉的。
    expect(
      fixtureViolations(root).filter((item) => item.file === 'packages/domain/package.json'),
    ).toHaveLength(2);
    expect(runChecker(['--root', root, '--expect-failures', '14', '--quiet']).exitCode).toBe(2);
    expect(runChecker(['--root', root, '--expect-failures', '13', '--quiet']).exitCode).toBe(0);
  });

  it('被冻结的 Neon 驱动在另外两条规则里也真的会命中；runtime 那处缺口被显式钉住', () => {
    // 前缀补进了三条规则，控制用例只种了 domain 那一处。这条把另外两处补成可判定的事实：
    // 复制到临时目录、往 work-contract / api-contract 各写一行依赖，计数必须恰好 +2，
    // 且每条都归因于 @neondatabase/serverless。
    // 没有它，「三条规则都武装了」这句话只有 JSON 文本作证据 —— 而 JSON 里有前缀
    // 不等于扫描器会为那个前缀报错（`from` 写错、`appliesTo` 漏掉 manifest 都会静默失效）。
    //
    // 下半条把 runtime 的**已知缺口**钉成事实：同一个依赖写进 apps/runtime，计数一动不动。
    // 那不是漏检，是 ZLQ-195 §2 的禁区逼出来的 —— apps/runtime/src/index.ts 的 runtimeIsolation
    // 自述与本规则被 apps/runtime/test/isolation.test.ts 双向锁死（还锁死了 runtime-* 规则
    // 恰好只有那两条），所以补前缀必须同时改那个源文件，而它属 D2–D5。钉住它的意义是：
    // 那对修订单落地时这条会红，改的人当场就知道要把 armed 的 3 条改回 4 条、
    // 把缺口那半的 15 改回 16，缺口既不会在某次重构里被悄悄填上，也不会被悄悄挖开。
    //
    // 缺口这一侧必须带正对照，否则「计数没变」也可能只是那个 manifest 根本没被扫到。
    // 所以同一份文件里再种一个 runtime **确实**禁的前缀（@libsql/）：它必须命中。
    const dependency = '@neondatabase/serverless';
    const armedTargets = [
      ['packages', 'work-contract', 'package.json'],
      ['packages', 'api-contract', 'package.json'],
    ];
    const plant = (dir, relPath, name) => {
      const file = join(dir, ...relPath);
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.dependencies = { ...manifest.dependencies, [name]: '0.0.0-fixture' };
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    };

    const armedRoot = tempFixture((dir) => {
      for (const relPath of armedTargets) plant(dir, relPath, dependency);
    });
    const armed = fixtureViolations(armedRoot);
    expect(armed).toHaveLength(16);
    expect(
      armed
        .filter((item) => item.specifier === dependency)
        .map((item) => [item.rule, item.file])
        .sort(),
    ).toEqual([
      ['api-contract-no-platform-coupling', 'packages/api-contract/package.json'],
      ['domain-no-platform-sdk', 'packages/domain/package.json'],
      ['work-contract-no-platform-coupling', 'packages/work-contract/package.json'],
    ]);

    const gapRoot = tempFixture((dir) => {
      const relPath = ['apps', 'runtime', 'package.json'];
      plant(dir, relPath, dependency);
      plant(dir, relPath, '@libsql/client');
    });
    const gap = fixtureViolations(gapRoot);
    // 14 + 1：多出来的那一处是 @libsql/client，不是 neon。
    expect(gap).toHaveLength(15);
    // 归因唯一性靠这两条一起成立：同一份 apps/runtime/package.json **确实被扫到了**
    // （@libsql 报出来了，夹具本来就种在这个文件里的 openai 也还在报），
    // 而同一份文件里的 neon 没报 —— 于是「neon 没触发」只能归因于 runtime 那条规则
    // 没武装这个前缀，不能归因于扫描器没看到这个文件。
    expect(
      gap
        .filter((item) => item.file === 'apps/runtime/package.json')
        .map(shape)
        .sort((a, b) => a.specifier.localeCompare(b.specifier)),
    ).toEqual([
      {
        rule: 'runtime-no-main-site-secrets',
        surface: 'manifest',
        specifier: '@libsql/client',
        file: 'apps/runtime/package.json',
      },
      // 基线 14 处里本来就有的那一处，留在期望值里当正对照（见上面的注释）。
      {
        rule: 'runtime-no-main-site-secrets',
        surface: 'manifest',
        specifier: 'openai',
        file: 'apps/runtime/package.json',
      },
    ]);
    // neon 在整棵树里仍然只有夹具本来就种的那一处（domain）—— 证明它不是被全局忽略了，
    // 只是在 runtime 这一侧没有规则接住它。
    expect(gap.filter((item) => item.specifier === dependency).map(shape)).toEqual([
      {
        rule: 'domain-no-platform-sdk',
        surface: 'manifest',
        specifier: dependency,
        file: 'packages/domain/package.json',
      },
    ]);
  });
});

describe('受控边（ZLQ-194 §4.3 / §13 行 4）：四个条件各自有判别力', () => {
  // 每处对照都只修一个条件，然后要求计数从 14 掉到 13：
  // 这证明那一处违规确实归因于那一个条件，而不是「文件里有点什么就报」。
  const webDir = ['apps', 'web'];

  it("条件 4：给 projects/route.ts 补上真的 import 'server-only' ⇒ 14 → 13", () => {
    const rel = 'apps/web/app/api/v1/projects/route.ts';
    // 反空转前置：夹具里那句话只存在于注释中。若哪天有人把注释改了，本条会先红，
    // 而不是让「条件 4 恒不触发」这个假阴性悄悄留在门禁里。
    const raw = readFileSync(join(FIXTURE, ...rel.split('/')), 'utf8');
    expect(raw.match(/import 'server-only'/g) ?? []).toHaveLength(2);
    expect(stripComments(raw)).not.toContain("import 'server-only'");

    const root = tempFixture((dir) => {
      const file = join(dir, ...rel.split('/'));
      writeFileSync(file, `import 'server-only';\n${readFileSync(file, 'utf8')}`, 'utf8');
    });
    expect(fixtureViolations(root)).toHaveLength(13);
    expect(fixtureViolations(root).filter((item) => item.file === rel)).toEqual([]);
  });

  it('正对照：turns/route.ts 四个条件全齐 ⇒ 0 违规（受控边不是恒红）', () => {
    const rel = 'apps/web/app/api/v1/turns/route.ts';
    expect(fixtureViolations().filter((item) => item.file === rel)).toEqual([]);
    // 这棵树的 `import 'server-only'` 必须是**真的**：抹平注释后仍然在。
    // 否则「正对照通过」只是因为它和 N1 一样被漏判，两棵树一起变成空转。
    const stripped = stripComments(readFileSync(join(FIXTURE, ...rel.split('/')), 'utf8'));
    expect(stripped.match(/import 'server-only'/g) ?? []).toHaveLength(1);
  });

  it('条件 3：把 preview/route.ts 的桶入口换成受控入口 ⇒ 14 → 13', () => {
    const rel = 'apps/web/app/api/v1/preview/route.ts';
    const root = tempFixture((dir) => {
      const file = join(dir, ...rel.split('/'));
      expect(replaceInLines(file, "from '@littleq/api';", "from '@littleq/api/server';")).toBe(1);
      // 反空转：导入语句必须还在。若这行被整行删掉，计数掉 1 就证明不了「说明符不对」
      // 这一条有判别力，只证明了「没有导入就没有违规」。
      const after = readFileSync(file, 'utf8');
      expect(after).toContain("import { apiBarrelFixture } from '@littleq/api/server';");
    });
    expect(fixtureViolations(root)).toHaveLength(13);
    expect(fixtureViolations(root).filter((item) => item.file === rel)).toEqual([]);
  });

  it('条件 2：把 api-bridge.ts 挪进适配层白名单 ⇒ 14 → 13', () => {
    const rel = 'apps/web/src/server/api-bridge.ts';
    const target = 'apps/web/app/api/v1/bridge/route.ts';
    const root = tempFixture((dir) => {
      mkdirSync(join(dir, 'apps', 'web', 'app', 'api', 'v1', 'bridge'), { recursive: true });
      // 只搬走这一棵树。apps/web/src/ 底下还有 project-list.tsx（条件 1 那处），
      // 顺手把整个 src/ 删掉会一次少两处，计数就证明不了「归因于路径」这一件事。
      renameSync(join(dir, ...rel.split('/')), join(dir, ...target.split('/')));
    });
    expect(fixtureViolations(root)).toHaveLength(13);
    expect(fixtureViolations(root).filter((item) => item.file === target)).toEqual([]);
  });

  it("条件 1 短路：摘掉 project-list.tsx 的 'use client' ⇒ 计数不变，但原因换成条件 2", () => {
    // 这条判的不是「会不会红」，而是**报出来的是哪一条**。摘掉指令后文件仍然越界
    // （路径不在适配层白名单里），所以计数仍是 14；但原因文本必须从 Client Component
    // 换成适配层路径 —— 这证明四个条件是按 1→4 短路的，一处根因只报一条，
    // 而不是把四条一起糊在输出里。
    const rel = 'apps/web/src/components/project-list.tsx';
    const root = tempFixture((dir) => {
      const file = join(dir, ...rel.split('/'));
      expect(dropSentinelLine(file, "'use client';")).toBe(1);
    });
    const after = fixtureViolations(root).filter((item) => item.file === rel);
    expect(after).toHaveLength(1);
    expect(after[0].reason).toContain('只有 server-only 适配层');
    expect(after[0].reason).not.toContain('Client Component');
  });

  it('apps/web/package.json 里声明 @littleq/api 与 server-only 不是违规（D6 必须能合法声明）', () => {
    // 受控边的 appliesTo 只有 source。若连 manifest 一起管，D6 就无法在
    // apps/web/package.json 里写 `"@littleq/api": "workspace:*"` —— 一条与真实工程
    // 无法共存的规则，最终只会被删掉。夹具里这两条声明就是这件事的正对照。
    const manifest = JSON.parse(readFileSync(join(FIXTURE, ...webDir, 'package.json'), 'utf8'));
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@littleq/api', 'server-only']);
    expect(fixtureViolations().filter((item) => item.file === 'apps/web/package.json')).toEqual([]);
  });

  it('apps/api 自身零违规：受控边的目标单元不是违规源', () => {
    expect(fixtureViolations().filter((item) => item.unit === 'apps/api')).toEqual([]);
  });
});

describe('注释剥离：扫描器读的不是原文', () => {
  it('stripComments 抹掉注释里的 import，保留字符串里的 import', () => {
    const source = [
      "// 本文件故意少了 `import 'server-only';`",
      "/* 块注释里也有一句 import 'server-only'; */",
      "import 'server-only';",
      'const note = "import \'server-only\';";',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped.match(/import 'server-only'/g) ?? []).toHaveLength(2);
    // 保长保行：行号是违规定位的一部分，抹平不能挪动它。
    expect(stripped).toHaveLength(source.length);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('抹平与不抹平的差集恰好是第 9 处那一条（A/B 归因）', () => {
    const dir = inTempRoot(() => {});
    const script = mutatedCheckerCopy(
      dir,
      "import { stripComments } from './lib/source-scan.mjs';",
      'const stripComments = (code) => code;',
    );
    const run = spawnSync(process.execPath, [script, '--root', FIXTURE, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    // 先钉住「main() 真的跑了」：入口判定若在符号链接路径上判假，这里会是 exit 0 +
    // 空 stdout + 空 stderr（见 tools/lib/main-module.mjs）。那样下面每条断言都会失败，
    // 而失败信息看起来像夹具出了问题 —— 排查方向直接错掉。
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toBe('');
    expect(run.status).toBe(1);

    const without = JSON.parse(run.stdout).violations.map(shape);
    const withMask = fixtureViolations().map(shape);

    expect(withMask).toHaveLength(14);
    expect(without).toHaveLength(13);
    const keys = (items) => new Set(items.map(sortKey));
    const maskedKeys = keys(withMask);
    const unmaskedKeys = keys(without);
    const added = withMask.filter((item) => !unmaskedKeys.has(sortKey(item)));
    const removed = without.filter((item) => !maskedKeys.has(sortKey(item)));
    // 抹平注释**只**多抓出一条，且正是条件 4 那一处；一条都没有因为抹平而漏掉。
    // 后半句才是重点：抹平是把文本删掉，删错了就会让既有的 8 处 ZLQ-153 边界静默失效。
    expect(added).toEqual([
      {
        rule: CONTROLLED_EDGE,
        surface: 'source',
        specifier: '@littleq/api/server',
        file: 'apps/web/app/api/v1/projects/route.ts',
      },
    ]);
    expect(removed).toEqual([]);

    // 另一侧的风险：抹平是删文本，删错了会让真实仓库里某处**该报的**越界不再报。
    // 所以同一个未抹平副本也要跑一遍真实仓库，两侧都必须是 0。
    const realRepo = spawnSync(process.execPath, [script, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(realRepo.stdout).not.toBe('');
    expect(realRepo.status).toBe(0);
    expect(JSON.parse(realRepo.stdout).violations).toEqual([]);
  });

  it('真实仓库的源文件里确实有注释可抹（否则上面那条 A/B 是空转）', () => {
    const infra = readFileSync(join(REPO_ROOT, 'packages', 'infra', 'src', 'index.ts'), 'utf8');
    // 这个文件的注释是块注释（`/** … */`）而不是行注释：前置检查要跟着文件的真实形态走，
    // 否则「有注释可抹」这句话自己就是假的，而它正是上面那条 A/B 不空转的唯一依据。
    expect(infra).toContain('/*');
    expect(stripComments(infra)).not.toBe(infra);
    // 保长保行：真实仓库的行号也要在抹平之后仍然对得上。
    expect(stripComments(infra)).toHaveLength(infra.length);
    expect(stripComments(infra).split('\n')).toHaveLength(infra.split('\n').length);
    expect(checkDependencyGraph({ root: REPO_ROOT, policyFile: POLICY }).violations).toEqual([]);
  });
});

describe('isMainModule：入口判定必须容忍符号链接', () => {
  // 判假的后果不是报错，是 main() 不跑、进程以 0 退出 —— 一道会假绿的门禁，
  // 在 CI 里同样是绿的，而且绿得毫无痕迹。macOS 的 os.tmpdir() 是 /tmp → /private/tmp，
  // Node 又把 import.meta.url 解析成 realpath，所以上面那条 A/B 曾经静默 exit 0。
  const url = pathToFileURL(CHECKER).href;

  it('经符号链接调用同一个脚本，main() 仍然执行（端到端）', () => {
    const dir = inTempRoot(() => {});
    const link = join(dir, 'checker-link.mjs');
    symlinkSync(CHECKER, link);
    // 反空转：老写法在这个用例上确实判假。少了这一句，下面的 true 可能只是恒真。
    expect(pathToFileURL(link).href).not.toBe(url);
    expect(isMainModule(url, link)).toBe(true);

    const run = spawnSync(process.execPath, [link, '--root', FIXTURE, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.stdout).not.toBe('');
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).violations).toHaveLength(14);
  });

  it('另一道门禁（unit-readiness）共用同一份判定，同样不会静默空转', () => {
    const dir = inTempRoot(() => {});
    const link = join(dir, 'readiness-link.mjs');
    symlinkSync(READINESS_CHECKER, link);
    const run = spawnSync(process.execPath, [link], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(run.stdout).not.toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('结果：0 处违规。');
  });

  it('被导入时（argv[1] 是别的脚本、不存在、或缺失）不当自己是入口', () => {
    expect(isMainModule(url, CHECKER)).toBe(true);
    expect(isMainModule(url, READINESS_CHECKER)).toBe(false);
    expect(isMainModule(url, join(REPO_ROOT, 'tools', 'does-not-exist.mjs'))).toBe(false);
    expect(isMainModule(url, undefined)).toBe(false);
    expect(isMainModule(url, '')).toBe(false);
  });
});

describe('directivePrologue：指令只有写在序言里才算指令', () => {
  const cases = [
    ["'use client';\nimport a from 'b';", ['use client']],
    ["// 注释\n\n'use client';\nimport a from 'b';", ['use client']],
    ["/* 块注释 */\n'use dom';\n'use client';", ['use dom', 'use client']],
    // 'use strict' 也是序言的一部分：只认 client/dom 的话会在这里中断，
    // 把紧随其后的 'use client' 漏掉 —— 而那种文件确实是个 Client Component。
    ["'use strict';\n'use client';\nimport a from 'b';", ['use strict', 'use client']],
    ["import a from 'b';\n'use client';", []],
    ["export function f() { return 'use client'; }", []],
    ['const s = "use client";', []],
    ['', []],
  ];

  it.each(cases)('序言解析：%s => %j', (source, expected) => {
    expect(directivePrologue(source)).toEqual(expected);
  });
});

describe('api-contract 出向禁止（隔离夹具，同一个生产 checker）', () => {
  // 入向与出向是同一条规则对象 `api-contract-no-platform-coupling` 的两半（附录 B G4：
  // 把计划中的第 9 条扩为双向约束，不新增第 10 条、不扩散修改既有规则）。主夹具锁的是
  // 入向计数，出向因此单独成树，由这里直接调用生产 checker 验证。
  const marker = 'SENTINEL:api-contract-outbound';
  const sentinelRelPath = join('packages', 'api-contract', 'src', 'index.ts');

  it('哨兵存在于夹具中', () => {
    expect(readFileSync(join(OUTBOUND_FIXTURE, sentinelRelPath), 'utf8')).toContain(marker);
  });

  it('原样扫描恰好 1 处违规，规则是 api-contract-no-platform-coupling', () => {
    const result = checkDependencyGraph({ root: OUTBOUND_FIXTURE, policyFile: POLICY });
    expect(result.violations.map(shape)).toEqual([
      {
        rule: 'api-contract-no-platform-coupling',
        surface: 'source',
        specifier: '@nestjs/common',
        file: 'packages/api-contract/src/index.ts',
      },
    ]);
    // CLI 侧同样以退出码 1 失败：证明这不是只在进程内 API 上成立。
    expect(
      runChecker(['--root', 'tools/__fixtures__/api-contract-outbound', '--quiet']).exitCode,
    ).toBe(1);
  });

  it('移除哨兵后由红转绿（那 1 处确实归因于哨兵，不是环境噪声）', () => {
    const root = inTempRoot((dir) => {
      cpSync(OUTBOUND_FIXTURE, dir, { recursive: true });
      expect(dropSentinelLine(join(dir, sentinelRelPath), marker)).toBe(1);
    });
    const result = checkDependencyGraph({ root, policyFile: POLICY });
    expect(result.violations).toEqual([]);
    expect(runChecker(['--root', root, '--quiet']).exitCode).toBe(0);
  });

  it('出向隔离夹具不进入 dep-graph:control 的 14 处计数', () => {
    // 两棵树都在 tools/__fixtures__/ 下，而扫描是按**显式路径** --root 传入的，互不可见。
    // 可判定的隔离证据：出向那处违规的 unit 是 packages/api-contract，而主夹具里同名单元
    // 刻意零依赖（见其 src/index.ts 的注释），所以主夹具的 14 处里必须一处都不落在该 unit 上。
    const violations = fixtureViolations();
    expect(violations).toHaveLength(14);
    expect(violations.filter((item) => item.unit === 'packages/api-contract')).toEqual([]);
    // 出向那处的说明符是 @nestjs/common；主夹具里同名的那处来自 packages/domain 的
    // manifest（unit 与表面都不同），两者不会互相顶替计数。
    expect(
      violations.filter((item) => item.specifier === '@nestjs/common').map((item) => item.unit),
    ).toEqual(['packages/domain']);
  });
});

describe('glob 匹配（单元路径与 drivers/** 都靠它）', () => {
  const cases = [
    ['packages/*', 'packages/domain', true],
    ['packages/*', 'packages/domain/src/index.ts', false],
    ['packages/**', 'packages/domain/src/index.ts', true],
    ['**/drivers/**', 'packages/domain/src/drivers/pg-driver', true],
    // 尾部 `/**` 展开成 `drivers/.*`，斜杠是必需的：光秃秃的目录名不匹配。
    // 这不是漏洞 —— import 说明符永远指向文件（或目录下的 index），不会是裸目录名；
    // eslint.config.mjs 另外把 `**/drivers/**` 同时注册成 `**/drivers/*` 覆盖直接子文件。
    ['**/drivers/**', 'packages/domain/src/drivers', false],
    ['**/drivers/**', 'packages/domain/src/drivers/', true],
    ['**/drivers/**', 'packages/domain/src/db/pg-driver', false],
    ['apps/?eb', 'apps/web', true],
    ['apps/?eb', 'apps/webs', false],
    // 受控边的适配层白名单靠它：`**/route.ts` 必须认得任意深度的路由文件，
    // 且不许放行 `route.tsx` 之外伪装成路由的文件名。
    ['apps/web/app/api/**/route.ts', 'apps/web/app/api/v1/projects/route.ts', true],
    ['apps/web/app/api/**/route.ts', 'apps/web/app/api/route.ts', true],
    ['apps/web/app/api/**/route.ts', 'apps/web/src/server/api-bridge.ts', false],
    ['apps/web/app/api/**/route.ts', 'apps/web/app/api/v1/projects/route.tsx', false],
    ['apps/web/app/api/**/route.tsx', 'apps/web/app/api/v1/projects/route.tsx', true],
    ['apps/web/app/api/**/route.ts', 'apps/web/app/api/v1/projects/route.test.ts', false],
  ];

  it.each(cases)('%s 对 %s => %s', (glob, value, expected) => {
    expect(globToRegExp(glob).test(value)).toBe(expected);
  });

  it('生成的正则是全匹配，不做前缀放行', () => {
    // 半匹配会让 `packages/domain-evil` 落到 `packages/domain` 的规则里，或反过来漏掉。
    expect(globToRegExp('packages/domain').test('packages/domain-evil')).toBe(false);
  });
});

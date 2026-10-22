// UnitReadiness 双重 tripwire 门禁（ZLQ-194 §9.2 / ZLQ-195 §3.1）的测试。
//
// 这里最重要的一条不是「真实仓库 0 违规」，而是**同一份契约、同一个门禁，只换被测树，
// 判红与判绿两种结论都必须拿得到**：一个永远返回 0 的门禁在 CI 里同样是绿的，而一个永远
// 返回非 0 的门禁会让 D2–D6 无从落地。所以每棵夹具树都锁死精确计数（少一处 = 假阴性，
// 多一处 = 规则误报），并且成对给出正对照树。
//
// 夹具树全部用**线上那份真契约**（tools/unit-readiness-contract.json）扫描：`--contract`
// 默认取 cwd 而不是 --root，与 check-dependency-graph.mjs 的 `--policy` 同理 —— 否则夹具
// 就能自带一份「专门抓得住自己」的契约，控制用例成了自证。唯一一处显式构造契约的是
// 门 8（依赖冻结）的对照：生产契约的冻结条目属于真实依赖，不能为了对照去改它。
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  checkUnitReadiness,
  collectExports,
  countTestDeclarations,
  findRetirementTokens,
  markerHitsIn,
  parseReadiness,
} from '../check-unit-readiness.mjs';
// 注释剥离是两道静态门禁共用的那一份（见 tools/lib/source-scan.mjs 的头注释）。
// 从这里导入而不是从门禁模块转手导出，是为了让「两处各写一遍然后漂移」这件事
// 在编译期就不可能：门禁模块自己没有 stripComments 可导。
import { stripComments } from '../lib/source-scan.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const GATE = join(REPO_ROOT, 'tools', 'check-unit-readiness.mjs');
const CONTRACT = join(REPO_ROOT, 'tools', 'unit-readiness-contract.json');
const FIXTURES = join(REPO_ROOT, 'tools', '__fixtures__', 'unit-readiness');

const UNITS = [
  'apps/api',
  'apps/runtime',
  'apps/web',
  'apps/worker',
  'packages/api-contract',
  'packages/design-system',
  'packages/domain',
  'packages/infra',
  'packages/work-contract',
];

// ZLQ-194 §9.2 点名的二个「本该装后端」的单元，在 ZLQ-195 结束时必须仍然全部是 skeleton。
// ZLQ-221（B1）把 `apps/api` 从这份名单里**毕业**了：它现在带 `unitReadiness` 声明、
// `skeletonOnly: false`，并且有契约点名的黑盒证明 `turn-to-task-to-safe-event`。
// `apps/worker` 不在那一单的范围里，保持 skeleton —— 它毕业时要走同一条路：翻
// `skeletonOnly`、补声明、补黑盒证明，三件事在同一个提交里。
const SKELETON_UNITS = ['apps/worker'];

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'));

function runGate(extraArgs) {
  const result = spawnSync(process.execPath, [GATE, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function scan(root) {
  return checkUnitReadiness({ root, contractFile: CONTRACT });
}

const gatesOf = (result) => [...new Set(result.violations.map((item) => item.gate))].sort();
const subjectsOf = (result, gate) =>
  result.violations.filter((item) => item.gate === gate).map((item) => item.subject);

// 临时目录只在这些对照用例里存在：把夹具复制出去、改一处、再扫一遍。
// 用完即删，绝不改动仓库里的夹具本体（夹具的字节本身就是被测输入）。
const tempRoots = [];

function inTempRoot(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'littleq-unit-readiness-'));
  tempRoots.push(root);
  mutate(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

// 每棵夹具树的精确计数。数字来自实测（`node tools/check-unit-readiness.mjs --root <树> --json`），
// 逐条归因见 tools/__fixtures__/unit-readiness/README.md。
const CASES = [
  // 门 2 反撒谎：status 仍是 skeleton，却长出 route handler / driver / scanner / 新依赖
  ['skeleton-with-named-implementation', 9, ['readiness-anti-lie-skeleton']],
  // 门 3 + 门 4：布尔值翻了但 capabilities 是空的
  [
    'implemented-with-empty-capabilities',
    2,
    ['readiness-blackbox-proofs', 'readiness-capabilities-non-empty'],
  ],
  // 门 3：capabilities 非空，但映射一个是空指针、一个指向无关既有测试
  ['implemented-with-broken-capability-mappings', 2, ['readiness-capabilities-non-empty']],
  // 门 4：契约点名的两项黑盒证明只声明了一项
  ['implemented-missing-required-proof', 1, ['readiness-blackbox-proofs']],
  // 门 5：四种退役写法各一处
  ['retired-with-skip-tokens', 4, ['readiness-no-retirement-tokens']],
  // 门 6：implemented 退回 skeleton（门 2 跟着判红 4 处，见夹具注释）
  ['regressed-from-implemented', 5, ['readiness-anti-lie-skeleton', 'readiness-no-regression']],
  // 门 7：status 不在状态机里 + 两个必填字面量缺席 + 一处花括号不配对
  ['declaration-unparseable', 4, ['readiness-declaration-unparseable']],
  // 门 1：用例活着，但没有一条断言就绪面
  ['missing-flip-tripwire', 1, ['readiness-flip-tripwire-present']],
  // 门 1 + 门 5：tripwire 那行形状合格，但被 it.skip 退役了
  [
    'tripwire-retired-by-skip',
    2,
    ['readiness-flip-tripwire-present', 'readiness-no-retirement-tokens'],
  ],
  // 正对照：合法骨架 + 就绪声明 ⇒ 0
  ['legal-skeleton-with-readiness-declaration', 0, []],
  // 正对照：合法 implemented，两项黑盒证明都映射到真实测试 ⇒ 0
  ['legal-implemented-with-proofs', 0, []],
];

describe('真实仓库的就绪门禁', () => {
  it('9 个单元 0 违规', () => {
    const result = scan(REPO_ROOT);
    expect(result.violations).toEqual([]);
    expect(result.unitsChecked).toEqual(UNITS);
    expect(result.contractedButAbsent).toEqual([]);
  });

  it('仍未毕业的后端单元保持 skeleton，其余单元一律 implemented（ZLQ-195 §3.1 的硬条件）', () => {
    const resolved = Object.fromEntries(scan(REPO_ROOT).resolvedStatus.map((r) => [r.unit, r]));
    for (const unit of SKELETON_UNITS) expect(resolved[unit].status, unit).toBe('skeleton');
    for (const unit of UNITS.filter((item) => !SKELETON_UNITS.includes(item)))
      expect(resolved[unit].status, unit).toBe('implemented');
  });

  it('两个已实现但还没采用 unitReadiness 声明的单元被显式列出，不是静默放过', () => {
    expect(scan(REPO_ROOT).pendingDeclaration).toEqual(['apps/web', 'packages/design-system']);
  });

  it('命令行直跑真实仓库返回 0', () => {
    expect(runGate(['--quiet']).exitCode).toBe(0);
  });

  it('门禁不依赖 e2e 的既有断言：把 e2e/ 整棵拿掉，结论不变', () => {
    // ZLQ-195 §4 陷阱 ③：空产品被 e2e/smoke.spec.ts 里四处 toEqual([]) 钉住，
    // 而 e2e/** 属于 D6。就绪门必须与它无关，否则 D6 一改 e2e 就会连带影响 D0 的门。
    // 可判定的独立性证据：只把 9 个单元目录复制进一棵没有 e2e/ 的临时树，结论仍是 0 违规。
    const skip = new Set([
      'node_modules',
      'dist',
      '.next',
      '.turbo',
      'coverage',
      'test-results',
      'playwright-report',
      'out',
    ]);
    const root = inTempRoot((dir) => {
      for (const unit of UNITS) {
        mkdirSync(join(dir, unit), { recursive: true });
        cpSync(join(REPO_ROOT, unit), join(dir, unit), {
          recursive: true,
          filter: (source) => !source.split(sep).some((part) => skip.has(part)),
        });
      }
    });
    expect(existsSync(join(root, 'e2e'))).toBe(false);
    expect(existsSync(join(root, 'playwright.config.ts'))).toBe(false);
    expect(scan(root).violations).toEqual([]);
    expect(scan(root).unitsChecked).toEqual(UNITS);
  });

  it('不要求任何单元 import tools/ 里的类型（跨边界依赖会撞上本单新增的依赖图规则）', () => {
    for (const unit of UNITS) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, unit, 'package.json'), 'utf8'));
      const declared = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      });
      expect(
        declared.filter((name) => name.startsWith('tools')),
        unit,
      ).toEqual([]);
      const sources = [
        ...walk(join(REPO_ROOT, unit, 'src')),
        ...walk(join(REPO_ROOT, unit, 'test')),
      ];
      for (const file of sources) {
        const specifiers = [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
          (match) => match[1],
        );
        expect(
          specifiers.filter((item) => /(^|\/)tools\//.test(item)),
          file,
        ).toEqual([]);
      }
    }
  });
});

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('控制用例：每棵夹具树的计数与门都锁死', () => {
  it.each(CASES)('%s', (name, total, gates) => {
    const result = scan(join(FIXTURES, name));
    expect(result.violations, name).toHaveLength(total);
    expect(gatesOf(result), name).toEqual(gates);
  });

  it('有违规的树以退出码 1 失败；--expect-failures 精确匹配才放行', () => {
    const rel = 'tools/__fixtures__/unit-readiness/skeleton-with-named-implementation';
    expect(runGate(['--root', rel, '--quiet']).exitCode).toBe(1);
    expect(runGate(['--root', rel, '--expect-failures', '9', '--quiet']).exitCode).toBe(0);

    const tooFew = runGate(['--root', rel, '--expect-failures', '8', '--quiet']);
    expect(tooFew.exitCode).toBe(2);
    expect(tooFew.stderr).toContain('控制用例失效');

    const tooMany = runGate(['--root', rel, '--expect-failures', '10', '--quiet']);
    expect(tooMany.exitCode).toBe(2);
    expect(tooMany.stderr).toContain('控制用例失效');
  });

  it('夹具树用的是线上契约，不是自带副本', () => {
    const run = runGate([
      '--root',
      'tools/__fixtures__/unit-readiness/skeleton-with-named-implementation',
      '--expect-failures',
      '9',
    ]);
    expect(run.stdout).toContain('契约：tools/unit-readiness-contract.json');
  });

  it('契约里声明的每一道门都至少被一棵树命中，没有装饰性的门', () => {
    const emitted = new Set();
    for (const [name] of CASES)
      for (const gate of gatesOf(scan(join(FIXTURES, name)))) emitted.add(gate);
    const declared = contract.gates.map((gate) => gate.id);
    // 反方向：门禁不会吐出一个契约没声明的 id（否则报告里的 spec 锚点是空的）。
    expect([...emitted].sort().filter((gate) => !declared.includes(gate))).toEqual([]);
    // 正向：唯一不由夹具树证明的是门 8（依赖冻结）—— 夹具树是真实仓库的局部副本，
    // 「真实依赖还在不在」这个事实不该由它承担。门 8 由下面那组对照证明：
    // 临时契约探针（两端合成）+ 真实 apps/api 摘掉 cookie（两端都是真的）。
    // 生产契约的冻结条目属于真实依赖，不能为了对照去改它。
    expect(declared.filter((gate) => !emitted.has(gate))).toEqual([
      'readiness-dependency-freeze-intact',
    ]);
  });
});

describe('反空转对照（a）：具名实现 + status 仍是 skeleton ⇒ 门 2 必须红', () => {
  const tree = () => scan(join(FIXTURES, 'skeleton-with-named-implementation'));

  it('route handler / driver / scanner 三类具名实现逐一被点名', () => {
    const subjects = subjectsOf(tree(), 'readiness-anti-lie-skeleton');
    expect(subjects).toContain('projectsRouteHandler');
    expect(subjects).toContain('NeonDriver');
    expect(subjects).toContain('scanner.ts');
    expect(subjects).toContain('neon-driver.ts');
    expect(subjects).toContain('src/drivers/neon-driver.ts');
    expect(subjects).toContain('src/scanner.ts');
    expect(subjects).toContain('@neondatabase/serverless');
  });

  it('具名实现那两处的报错写明了命中的标记，不是笼统的「不在清单里」', () => {
    const reasons = Object.fromEntries(
      tree()
        .violations.filter((item) => ['projectsRouteHandler', 'NeonDriver'].includes(item.subject))
        .map((item) => [item.subject, item.reason]),
    );
    expect(reasons.projectsRouteHandler).toContain('route');
    expect(reasons.projectsRouteHandler).toContain('handler');
    expect(reasons.NeonDriver).toContain('driver');
  });

  it('每处违规都带 spec 锚点与可定位的文件', () => {
    for (const violation of tree().violations) {
      expect(violation.spec).toMatch(/ZLQ-1(?:53|94|95)/);
      expect(violation.file).toBeTruthy();
      expect(violation.unit).toBe('apps/api');
    }
  });

  it('删掉一个植入文件，计数按归因下降，9 处立刻以退出码 2 变红', () => {
    const root = inTempRoot((dir) => {
      cpSync(join(FIXTURES, 'skeleton-with-named-implementation'), dir, { recursive: true });
      rmSync(join(dir, 'apps', 'api', 'src', 'scanner.ts'));
    });
    // scanner.ts 一处文件 = 3 处违规（路径不在清单、导出不在清单、文件名带标记）。
    expect(scan(root).violations).toHaveLength(6);
    expect(runGate(['--root', root, '--expect-failures', '9', '--quiet']).exitCode).toBe(2);
    expect(runGate(['--root', root, '--expect-failures', '6', '--quiet']).exitCode).toBe(0);
  });

  it('正对照：同样是 skeleton，形状合法就 0 违规（门 2 不是恒红）', () => {
    expect(scan(join(FIXTURES, 'legal-skeleton-with-readiness-declaration')).violations).toEqual(
      [],
    );
  });
});

describe('反空转对照（b）：implemented 但能力面是空的或假的 ⇒ 门 3/4 必须红', () => {
  it('b1 capabilities 清空：门 3 判红，且门 4 同时点名缺席的黑盒证明', () => {
    const result = scan(join(FIXTURES, 'implemented-with-empty-capabilities'));
    expect(subjectsOf(result, 'readiness-capabilities-non-empty')).toEqual(['capabilities']);
    expect(subjectsOf(result, 'readiness-blackbox-proofs')).toEqual(['turn-to-task-to-safe-event']);
    expect(
      result.violations.find((item) => item.gate === 'readiness-capabilities-non-empty').reason,
    ).toContain('翻个布尔值就宣称已实现');
  });

  it('b2 能力→测试映射缺失：映射到不存在的文件判红', () => {
    const result = scan(join(FIXTURES, 'implemented-with-broken-capability-mappings'));
    const missing = result.violations.find((item) =>
      item.subject.startsWith('turn-to-task-to-safe-event'),
    );
    expect(missing.reason).toContain('不存在');
  });

  it('b2 能力→测试映射缺失：映射到无关既有测试也判红', () => {
    const result = scan(join(FIXTURES, 'implemented-with-broken-capability-mappings'));
    const unrelated = result.violations.find((item) => item.subject === 'ghost-capability');
    expect(unrelated.file).toBe('apps/api/test/unrelated.test.ts');
    expect(unrelated.reason).toContain('没有出现能力名');
  });

  it('门 4：契约点名的黑盒证明少一项就判红，项名逐字来自契约', () => {
    const result = scan(join(FIXTURES, 'implemented-missing-required-proof'));
    expect(subjectsOf(result, 'readiness-blackbox-proofs')).toEqual([
      'every-block-category-negative-fails',
    ]);
    expect(contract.units['packages/work-contract'].requiredProofs).toEqual([
      'safe-package-passes',
      'every-block-category-negative-fails',
    ]);
  });

  it('正对照：两项证明都映射到真实、活着、含能力名的测试 ⇒ 0 违规（门 3/4 不是恒红）', () => {
    expect(scan(join(FIXTURES, 'legal-implemented-with-proofs')).violations).toEqual([]);
  });

  it('把正对照里的一个能力名从验收测试正文抹掉，门 3 立刻判红', () => {
    const root = inTempRoot((dir) => {
      cpSync(join(FIXTURES, 'legal-implemented-with-proofs'), dir, { recursive: true });
      const file = join(dir, 'packages', 'work-contract', 'test', 'safe-package.test.ts');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replaceAll('safe-package-passes', '（能力名已被抹掉）'),
        'utf8',
      );
    });
    const result = scan(root);
    expect(subjectsOf(result, 'readiness-capabilities-non-empty')).toEqual(['safe-package-passes']);
    expect(runGate(['--root', root, '--quiet']).exitCode).toBe(1);
  });
});

describe('门 1 / 门 5 / 门 6 / 门 7', () => {
  it('门 1：没有任何一条断言就绪面的活用例 ⇒ 判红', () => {
    const result = scan(join(FIXTURES, 'missing-flip-tripwire'));
    expect(gatesOf(result)).toEqual(['readiness-flip-tripwire-present']);
    expect(result.violations[0].reason).toContain('显式翻转门等于不存在');
  });

  it('门 1 查的是「活着」：那行断言形状合格但被 it.skip 退役，照样判红', () => {
    const result = scan(join(FIXTURES, 'tripwire-retired-by-skip'));
    expect(gatesOf(result)).toEqual([
      'readiness-flip-tripwire-present',
      'readiness-no-retirement-tokens',
    ]);
    expect(subjectsOf(result, 'readiness-no-retirement-tokens')).toEqual(['it.skip']);
  });

  it('门 5：四种退役写法各判红一处，且行号可定位', () => {
    const result = scan(join(FIXTURES, 'retired-with-skip-tokens'));
    const hits = result.violations.map((item) => ({ subject: item.subject, line: item.line }));
    expect(hits.map((item) => item.subject)).toEqual([
      'describe.skip',
      'it.only',
      'it.todo',
      'it.skipIf',
    ]);
    for (const hit of hits) expect(typeof hit.line).toBe('number');
    // 归因证据：这棵树的 tripwire 是活的，所以门 1 不在判红的门里。
    expect(gatesOf(result)).not.toContain('readiness-flip-tripwire-present');
  });

  it('门 6：implemented 退回 skeleton 是被禁止的转移', () => {
    const result = scan(join(FIXTURES, 'regressed-from-implemented'));
    const regression = result.violations.find((item) => item.gate === 'readiness-no-regression');
    expect(regression.unit).toBe('packages/domain');
    expect(regression.line).toBe(16);
    expect(regression.reason).toContain('skeleton->implemented');
    // 棘轮来自契约**结构**而不是记一个「曾经是 implemented」的布尔值：
    // 契约给了骨架清单的单元才允许处在 skeleton。
    expect(contract.units['packages/domain'].skeleton).toBeUndefined();
    expect(contract.units['apps/api'].skeleton).toBeDefined();
  });

  it('门 7：解析不出就绪声明必须判红，不能静默当作「没有声明」放过', () => {
    const result = scan(join(FIXTURES, 'declaration-unparseable'));
    const reasons = result.violations.map((item) => item.reason);
    expect(reasons.some((reason) => reason.includes('不在状态机'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('缺少 capabilities'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('缺少 acceptanceTests'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('花括号不配对'))).toBe(true);
  });
});

describe('门 8：依赖冻结条目被摘掉必须红（临时契约对照）', () => {
  // 生产契约的冻结条目是 D1–D6 真实要用的依赖，不能为了做对照去改它；
  // 这里显式构造一份只多一个探针条目的契约副本，两个方向都验。
  const PROBE = '@littleq/frozen-control-probe';

  function frozenContractFile(dir) {
    const frozen = structuredClone(contract);
    frozen.dependencyFreeze.entries = [
      ...frozen.dependencyFreeze.entries,
      {
        id: 'frozen-control-probe',
        package: PROBE,
        consumedBy: ['packages/work-contract'],
        spec: 'ZLQ-195 §3.4（控制用例专用探针条目）',
      },
    ];
    const file = join(dir, 'unit-readiness-contract.probe.json');
    writeFileSync(file, `${JSON.stringify(frozen, null, 2)}\n`, 'utf8');
    return file;
  }

  function copyLegalTree(dir) {
    const root = join(dir, 'tree');
    cpSync(join(FIXTURES, 'legal-implemented-with-proofs'), root, { recursive: true });
    return root;
  }

  it('条目缺席 ⇒ 判红；条目兑现 ⇒ 0 违规', () => {
    const dir = inTempRoot(() => {});
    const contractFile = frozenContractFile(dir);
    const root = copyLegalTree(dir);

    const absent = checkUnitReadiness({ root, contractFile });
    expect(absent.violations.map((item) => item.gate)).toEqual([
      'readiness-dependency-freeze-intact',
    ]);
    expect(absent.violations[0].subject).toBe(PROBE);
    expect(absent.violations[0].reason).toContain('被摘掉必须红');

    const manifestFile = join(root, 'packages', 'work-contract', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.dependencies[PROBE] = 'workspace:*';
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    expect(checkUnitReadiness({ root, contractFile }).violations).toEqual([]);
  });

  it('生产契约不含探针条目 ⇒ 同一棵树 0 违规（判红确实归因于冻结条目）', () => {
    const dir = inTempRoot(() => {});
    const root = copyLegalTree(dir);
    expect(contract.dependencyFreeze.entries.some((entry) => entry.package === PROBE)).toBe(false);
    expect(checkUnitReadiness({ root, contractFile: CONTRACT }).violations).toEqual([]);
  });

  it('生产契约的冻结条目自身合法：字段齐全，consumedBy 都是契约点名的单元', () => {
    for (const entry of contract.dependencyFreeze.entries) {
      expect(entry.id, JSON.stringify(entry)).toBeTruthy();
      expect(entry.package, JSON.stringify(entry)).toBeTruthy();
      expect(entry.spec, JSON.stringify(entry)).toBeTruthy();
      expect(entry.consumedBy.length).toBeGreaterThan(0);
      for (const unit of entry.consumedBy)
        expect(Object.keys(contract.units), unit).toContain(unit);
    }
  });

  it('真实仓库的 apps/api 摘掉一个被冻结的包 ⇒ 门 8 判红，且只判这一处', () => {
    // 上面那组探针对照证明的是「门 8 有判别力」，但它用的是合成树 + 合成契约。
    // 这一条把两样都换成真的：真契约、真单元、真依赖，只摘掉 cookie 一个键。
    // 少了它，「八条冻结条目在真实仓库里都兑现了」只剩 scan(REPO_ROOT) 的 0 违规作证据，
    // 而 0 违规同样可能来自门 8 整体哑火 —— 那正是 §7 弱出口 4 说的「只报全绿」。
    const root = inTempRoot((dir) => {
      cpSync(join(REPO_ROOT, 'apps', 'api'), join(dir, 'apps', 'api'), { recursive: true });
      const manifestFile = join(dir, 'apps', 'api', 'package.json');
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      // 反空转前置：这个键必须真的在，否则「摘掉后判红」证明不了任何事。
      expect(manifest.dependencies.cookie).toBeTruthy();
      delete manifest.dependencies.cookie;
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    });

    const result = checkUnitReadiness({ root, contractFile: CONTRACT });
    expect(result.violations.map((item) => [item.gate, item.subject])).toEqual([
      ['readiness-dependency-freeze-intact', 'cookie'],
    ]);
    // 归因到具体条目：报错里要能读出是哪条冻结条目在承重，否则修的人不知道该补什么。
    expect(result.violations[0].reason).toContain('session-cookie');
  });

  it('夹具树里的单元桩必须跟着冻结条目走（锁步有名字，不靠人记）', () => {
    // 冻结条目记的是**真实仓库**的事实，而夹具树只是它的局部副本：条目点名 apps/api，
    // 夹具里的 apps/api 桩就得同样声明这些包。否则每棵含该桩的树都会多判一处门 8，
    // 而那一处与树本身要测的门毫无关系 —— 上面 CASES 里锁死的计数会整体偏移，
    // 失败信息看起来却像门 2 / 门 3 坏了，排查方向直接错掉（同一类陷阱见
    // tools/test/dependency-graph.test.mjs 里 13 → 14 的锁步更新）。
    // 这条把「加冻结条目要同步改夹具」变成一个有名字、有指引的失败。
    const trees = readdirSync(FIXTURES).filter((name) =>
      statSync(join(FIXTURES, name)).isDirectory(),
    );
    const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const entry of contract.dependencyFreeze.entries) {
      for (const unit of entry.consumedBy) {
        for (const tree of trees) {
          const manifestFile = join(FIXTURES, tree, unit, 'package.json');
          if (!existsSync(manifestFile)) continue;
          const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
          const declared = fields.flatMap((field) => Object.keys(manifest[field] ?? {}));
          expect(
            declared,
            `${tree}/${unit}/package.json 缺少冻结条目 ${entry.id} 点名的 ${entry.package}`,
          ).toContain(entry.package);
        }
      }
    }
  });
});

describe('契约本身（ZLQ-194 §9.2 规则 6：只存规则名、能力名、状态机，不存观测量）', () => {
  function numericLeaves(value, path = '', out = []) {
    if (typeof value === 'number') out.push({ path, value });
    else if (Array.isArray(value))
      value.forEach((item, index) => numericLeaves(item, `${path}[${index}]`, out));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) numericLeaves(item, `${path}.${key}`, out);
    return out;
  }

  it('除 version 之外没有任何数字叶子：「N 个文件 / N 个测试 / X 秒」这类观测量进不了契约', () => {
    expect(numericLeaves(contract)).toEqual([{ path: '.version', value: contract.version }]);
  });

  it('每道门都带 id + spec + description，spec 锚到设计文档章节', () => {
    for (const gate of contract.gates) {
      expect(Object.keys(gate).sort()).toEqual(['description', 'id', 'spec']);
      expect(gate.spec).toMatch(/ZLQ-19[45]/);
    }
  });

  it('状态机只允许 skeleton -> implemented，禁止反向', () => {
    expect(contract.stateMachine.states).toEqual(['skeleton', 'implemented']);
    expect(contract.stateMachine.transitions).toEqual([{ from: 'skeleton', to: 'implemented' }]);
    expect(contract.stateMachine.forbiddenTransitions).toEqual([
      { from: 'implemented', to: 'skeleton' },
    ]);
  });

  it('契约点名的能力名与 §9.2 规则 4 的五项黑盒证明逐字一致', () => {
    const proofs = UNITS.flatMap((unit) => contract.units[unit].requiredProofs);
    expect([...proofs].sort()).toEqual(
      [
        'every-block-category-negative-fails',
        'five-port-contract',
        'lease-cas-reclaim',
        'safe-package-passes',
        'separate-origin-content',
        'security-headers',
        'turn-to-task-to-safe-event',
      ].sort(),
    );
  });
});

describe('解析原语（门禁的判据本身要有判别力，不能靠正则碰巧）', () => {
  it('stripComments 保长保行：行号与花括号配对都对得上原文', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages', 'infra', 'src', 'index.ts'), 'utf8');
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    // 字符串内容必须原样保留：门 3 要靠它在 it('...') 的标题里找能力名。
    expect(stripComments(`it('能力 safe-package-passes', () => {});`)).toContain(
      'safe-package-passes',
    );
  });

  it('注释里的说明文字不会被当成代码：真实仓库两处已知的近似误伤', () => {
    // packages/infra/src/index.ts 的头注释点名了五个端口与 drivers/*
    const infra = readFileSync(join(REPO_ROOT, 'packages', 'infra', 'src', 'index.ts'), 'utf8');
    expect(infra).toContain('DatabaseAdapter');
    expect(scan(REPO_ROOT).violations).toEqual([]);
    // tools/test/ci-workflow.test.mjs 里有一行「刻意不用 describe.skip / skipIf」
    const ciTest = readFileSync(join(REPO_ROOT, 'tools', 'test', 'ci-workflow.test.mjs'), 'utf8');
    expect(ciTest).toContain('describe.skip');
    expect(findRetirementTokens(ciTest)).toEqual([]);
  });

  it('模板串里的 ${} 插值不会把后面的正文吞掉', () => {
    const source = 'const a = `x ${ 1 + 2 } y`; // 尾注释\nexport const routeHandler = 1;\n';
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped).toContain('export const routeHandler');
    expect(stripped).not.toContain('尾注释');
    expect(collectExports(source).names).toEqual(['routeHandler']);
  });

  it('markerHitsIn：具名实现命中，治理面标识符不命中', () => {
    const markers = contract.implementationMarkers;
    expect(markerHitsIn('pg-driver', markers)).toEqual(['driver']);
    expect(markerHitsIn('ProjectsRouteHandler', markers).sort()).toEqual(['handler', 'route']);
    expect(markerHitsIn('neonAdapter', markers)).toEqual(['adapter']);
    expect(markerHitsIn('artifactScanner', markers)).toEqual(['scanner']);
    expect(markerHitsIn('taskRepository', markers)).toEqual(['repository']);
    for (const name of [
      'UNIT_ID',
      'UnitManifest',
      'unitManifest',
      'UnitReadiness',
      'unitReadiness',
      'RuntimeIsolation',
      'runtimeIsolation',
      'contractVersionSchema',
      'ContractVersion',
      'EnvValidationError',
      'defineEnv',
      'loadEnvFile',
      'DefineEnvOptions',
      'EnvIssue',
      'EnvSource',
      'composedOf',
      'dependsOn',
      'forbiddenPackagePrefixes',
    ])
      expect(markerHitsIn(name, markers), name).toEqual([]);
  });

  it('parseReadiness：声明优先于 legacy 布尔值，legacy 只认 true/false 字面量', () => {
    const states = contract.stateMachine.states;
    const declared = parseReadiness(
      `export const unitReadiness = {
         status: 'implemented',
         capabilities: ['a', 'b'],
         acceptanceTests: { a: 'test/a.test.ts', 'b': 'test/b.test.ts' },
       };`,
      states,
    );
    expect(declared).toMatchObject({
      declared: true,
      status: 'implemented',
      capabilities: ['a', 'b'],
      acceptanceTests: { a: 'test/a.test.ts', b: 'test/b.test.ts' },
      problems: [],
    });

    // 接口声明里的 `skeletonOnly: boolean` 不能被当成值（ZLQ-195 §4 陷阱 ②）。
    const interfaceOnly = parseReadiness(
      'export interface UnitManifest { skeletonOnly: boolean }\n',
      states,
    );
    expect(interfaceOnly.status).toBeNull();
    expect(interfaceOnly.problems).toHaveLength(1);

    const legacyTrue = parseReadiness(
      'export const unitManifest = { skeletonOnly: true };',
      states,
    );
    expect(legacyTrue).toMatchObject({ declared: false, status: 'skeleton', legacyLine: 1 });
    const legacyFalse = parseReadiness(
      'export const unitManifest = { skeletonOnly: false };',
      states,
    );
    expect(legacyFalse).toMatchObject({ declared: false, status: 'implemented', legacy: false });
  });

  it('collectExports：重导出、type 重导出、重命名都收得到，无界导出被单独标记', () => {
    const collected = collectExports(
      [
        'export const a = 1;',
        'export function b() {}',
        'export class C {}',
        'export interface D {}',
        'export type E = number;',
        "export { f, type g } from './f.js';",
        "export { local as renamed } from './local.js';",
        'export * from "./everything.js";',
        'export default 42;',
      ].join('\n'),
    );
    expect(collected.names).toEqual(['C', 'D', 'E', 'a', 'b', 'f', 'g', 'renamed']);
    expect(collected.unbounded).toHaveLength(2);
  });

  it('countTestDeclarations：被跳过的用例不算活的，且不会被重复扣减', () => {
    expect(countTestDeclarations(`it('a', () => {});\nit.todo('b');\n`)).toEqual({
      live: 1,
      dead: 1,
    });
    expect(countTestDeclarations(`it.skip('a', () => {});\nit.only('b', () => {});\n`)).toEqual({
      live: 0,
      dead: 2,
    });
    expect(
      countTestDeclarations(`describe('x', () => { it.each([1])('y %s', () => {}) });\n`),
    ).toEqual({ live: 1, dead: 0 });
  });

  it('findRetirementTokens 只认 §9.2 规则 5 点名的四个 token，不含 it.fails', () => {
    expect(
      findRetirementTokens(
        `describe.skip('a', () => {});\nit.only('b', () => {});\ntest.todo('c');\nit.skipIf(x)('d', () => {});\nit.fails('e', () => {});\n`,
      ).map((hit) => hit.text),
    ).toEqual(['describe.skip', 'it.only', 'test.todo', 'it.skipIf']);
  });
});

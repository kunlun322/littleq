// 静态依赖图门禁的测试。
//
// 这里最重要的一条不是「真实仓库 0 违规」，而是「故意植入的违规必须被抓到」：
// 一个永远返回 0 的门禁在 CI 里同样是绿的。所以控制用例的断言是双向的 ——
// 数量必须精确等于 8（少一处 = 假阴性，多一处 = 规则误报），且每条被点名的规则都要出现。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDependencyGraph, globToRegExp } from '../check-dependency-graph.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const POLICY = join(REPO_ROOT, 'config', 'dependency-graph.json');
const FIXTURE = join(REPO_ROOT, 'tools', '__fixtures__', 'dep-graph-violation');
// 出向禁止单独成树：主夹具的违规计数被根 package.json 的 `--expect-failures 8` 锁死，
// 往里再塞一处出向违规就会把那个数字变成 9。见该树 README。
const OUTBOUND_FIXTURE = join(REPO_ROOT, 'tools', '__fixtures__', 'api-contract-outbound');
const CHECKER = join(REPO_ROOT, 'tools', 'check-dependency-graph.mjs');

// 夹具里植入的 8 处违规，逐条写死期望值：规则 id + 表面（manifest/source）+ 说明符。
// 这份清单本身就是「边界规则确实覆盖到了 issue 点名的三类约束」的证据。
const EXPECTED = [
  { rule: 'domain-no-platform-sdk', surface: 'manifest', specifier: '@nestjs/common' },
  { rule: 'domain-no-platform-sdk', surface: 'manifest', specifier: 'pg' },
  {
    rule: 'domain-and-application-no-drivers',
    surface: 'source',
    specifier: '../../domain/src/drivers/pg-driver',
  },
  {
    rule: 'domain-and-application-no-drivers',
    surface: 'source',
    specifier: './drivers/pg-driver',
  },
  { rule: 'domain-no-workspace-deps', surface: 'source', specifier: '../../infra/src/db' },
  { rule: 'runtime-no-main-site-secrets', surface: 'manifest', specifier: 'openai' },
  { rule: 'runtime-no-main-site-units', surface: 'source', specifier: '@littleq/infra' },
  // 第 8 处走 `api-contract-no-platform-coupling` 的**入向** `inbound.default=deny`：
  // apps/runtime 不在 allowFrom（apps/api, packages/application）里，所以它不需要被任何
  // 规则点名就已经违规。这正是「不能把当前禁止方写死成枚举」的可判定证据。
  {
    rule: 'api-contract-no-platform-coupling',
    surface: 'source',
    specifier: '@littleq/api-contract',
  },
];

function runChecker(extraArgs) {
  const result = spawnSync(process.execPath, [CHECKER, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

// 临时目录只在这些对照用例里存在：把夹具复制出去、删掉哨兵行，再扫一遍。
// 用完即删，绝不改动仓库里的夹具本体（夹具的字节本身就是被测输入）。
const tempRoots = [];

function inTempRoot(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'littleq-dep-graph-control-'));
  tempRoots.push(root);
  mutate(root);
  return root;
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

describe('真实仓库的边界门禁', () => {
  it('当前 9 个工作区单元 0 违规', () => {
    const result = checkDependencyGraph({ root: REPO_ROOT, policyFile: POLICY });
    expect(result.violations).toEqual([]);
    expect(result.unitsChecked).toEqual([
      'apps/api',
      'apps/runtime',
      'apps/web',
      'apps/worker',
      'packages/api-contract',
      'packages/design-system',
      'packages/domain',
      'packages/infra',
      'packages/work-contract',
    ]);
  });

  it('§5.4(4) 的 packages/application 尚未落地，规则保持武装而不是被静默丢弃', () => {
    const result = checkDependencyGraph({ root: REPO_ROOT, policyFile: POLICY });
    // issue 的边界清单里有这一条，但 §1.3 的目录骨架里没有 packages/application。
    // 处理方式：按路径预先武装，包一出现即被约束；同时在报告里显式列出「已武装但未落地」，
    // 这样「规则写错了路径」与「包还没建」两种情况在输出里可以区分开。
    expect(result.armedButAbsent).toEqual([
      {
        rule: 'domain-and-application-no-drivers',
        unit: 'packages/application',
        spec: 'ZLQ-153 §5.4(4)',
      },
    ]);
  });

  it('命令行直跑真实仓库返回 0', () => {
    const run = runChecker(['--quiet']);
    expect(run.exitCode).toBe(0);
  });
});

describe('控制用例：故意植入的违规必须被识别（反假阴性）', () => {
  it('精确命中 8 处，逐条对得上规则与说明符', () => {
    const result = checkDependencyGraph({ root: FIXTURE, policyFile: POLICY });
    const actual = result.violations.map(({ rule, surface, specifier }) => ({
      rule,
      surface,
      specifier,
    }));
    expect(actual).toHaveLength(EXPECTED.length);
    // 顺序无关：按三个字段排序后逐一比对，避免「靠目录遍历顺序碰巧通过」。
    const sortKey = (item) => `${item.rule}|${item.surface}|${item.specifier}`;
    expect(actual.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      [...EXPECTED].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    );
  });

  it('每处违规都带 spec 锚点与可定位的文件位置', () => {
    const result = checkDependencyGraph({ root: FIXTURE, policyFile: POLICY });
    for (const violation of result.violations) {
      expect(violation.spec).toMatch(/ZLQ-153/);
      expect(violation.file).toBeTruthy();
      // source 表面必须给出行号，否则 CI 报错无法定位；manifest 表面没有行号概念。
      if (violation.surface === 'source') expect(typeof violation.line).toBe('number');
    }
  });

  it('--expect-failures 8 通过；7 或 9 都以退出码 2 失败（控制用例自身不是空断言）', () => {
    const fixtureArgs = ['--root', 'tools/__fixtures__/dep-graph-violation'];
    expect(runChecker([...fixtureArgs, '--expect-failures', '8', '--quiet']).exitCode).toBe(0);

    const tooFew = runChecker([...fixtureArgs, '--expect-failures', '7', '--quiet']);
    expect(tooFew.exitCode).toBe(2);
    expect(tooFew.stderr).toContain('控制用例失效');

    const tooMany = runChecker([...fixtureArgs, '--expect-failures', '9', '--quiet']);
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
      '8',
    ]);
    expect(run.stdout).toContain('策略：config/dependency-graph.json');
  });

  it('第 8 处违规带植入哨兵：删掉那一行，8 处计数立刻以退出码 2 变红', () => {
    const marker = 'SENTINEL:api-contract-inbound';
    const sentinelFile = join(FIXTURE, 'apps', 'runtime', 'src', 'index.ts');
    // 先证明哨兵真的在夹具里。没有这一步，「删掉后变绿」可能只是因为根本没删到东西。
    expect(readFileSync(sentinelFile, 'utf8')).toContain(marker);

    const root = inTempRoot((dir) => {
      cpSync(FIXTURE, dir, { recursive: true });
      const dropped = dropSentinelLine(join(dir, 'apps', 'runtime', 'src', 'index.ts'), marker);
      expect(dropped).toBe(1);
    });

    // 生产 checker + 生产策略，只换 --root。7 处仍然命中（门禁没有整体失效），
    // 但 `--expect-failures 8` 必须红 —— 这就是「8 而不是 7」的正向对照。
    expect(checkDependencyGraph({ root, policyFile: POLICY }).violations).toHaveLength(7);
    expect(runChecker(['--root', root, '--expect-failures', '8', '--quiet']).exitCode).toBe(2);
    expect(runChecker(['--root', root, '--expect-failures', '7', '--quiet']).exitCode).toBe(0);
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
    expect(
      result.violations.map(({ rule, surface, specifier }) => ({ rule, surface, specifier })),
    ).toEqual([
      {
        rule: 'api-contract-no-platform-coupling',
        surface: 'source',
        specifier: '@nestjs/common',
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

  it('出向隔离夹具不进入 dep-graph:control 的 8 处计数', () => {
    // 两棵树都在 tools/__fixtures__/ 下，而扫描是按**显式路径** --root 传入的，互不可见。
    // 可判定的隔离证据：出向那处违规的 unit 是 packages/api-contract，而主夹具里同名单元
    // 刻意零依赖（见其 src/index.ts 的注释），所以主夹具的 8 处里必须一处都不落在该 unit 上。
    const violations = checkDependencyGraph({ root: FIXTURE, policyFile: POLICY }).violations;
    expect(violations).toHaveLength(8);
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
  ];

  it.each(cases)('%s 对 %s => %s', (glob, value, expected) => {
    expect(globToRegExp(glob).test(value)).toBe(expected);
  });

  it('生成的正则是全匹配，不做前缀放行', () => {
    // 半匹配会让 `packages/domain-evil` 落到 `packages/domain` 的规则里，或反过来漏掉。
    expect(globToRegExp('packages/domain').test('packages/domain-evil')).toBe(false);
  });
});

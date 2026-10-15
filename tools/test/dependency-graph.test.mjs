// 静态依赖图门禁的测试。
//
// 这里最重要的一条不是「真实仓库 0 违规」，而是「故意植入的违规必须被抓到」：
// 一个永远返回 0 的门禁在 CI 里同样是绿的。所以控制用例的断言是双向的 ——
// 数量必须精确等于 7（少一处 = 假阴性，多一处 = 规则误报），且每条被点名的规则都要出现。
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDependencyGraph, globToRegExp } from '../check-dependency-graph.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const POLICY = join(REPO_ROOT, 'config', 'dependency-graph.json');
const FIXTURE = join(REPO_ROOT, 'tools', '__fixtures__', 'dep-graph-violation');
const CHECKER = join(REPO_ROOT, 'tools', 'check-dependency-graph.mjs');

// 夹具里植入的 7 处违规，逐条写死期望值：规则 id + 表面（manifest/source）+ 说明符。
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
];

function runChecker(extraArgs) {
  const result = spawnSync(process.execPath, [CHECKER, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('真实仓库的边界门禁', () => {
  it('当前 8 个工作区单元 0 违规', () => {
    const result = checkDependencyGraph({ root: REPO_ROOT, policyFile: POLICY });
    expect(result.violations).toEqual([]);
    expect(result.unitsChecked).toEqual([
      'apps/api',
      'apps/runtime',
      'apps/web',
      'apps/worker',
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
  it('精确命中 7 处，逐条对得上规则与说明符', () => {
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

  it('--expect-failures 7 通过；6 或 8 都以退出码 2 失败（控制用例自身不是空断言）', () => {
    const fixtureArgs = ['--root', 'tools/__fixtures__/dep-graph-violation'];
    expect(runChecker([...fixtureArgs, '--expect-failures', '7', '--quiet']).exitCode).toBe(0);

    const tooFew = runChecker([...fixtureArgs, '--expect-failures', '6', '--quiet']);
    expect(tooFew.exitCode).toBe(2);
    expect(tooFew.stderr).toContain('控制用例失效');

    const tooMany = runChecker([...fixtureArgs, '--expect-failures', '8', '--quiet']);
    expect(tooMany.exitCode).toBe(2);
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
      '7',
    ]);
    expect(run.stdout).toContain('策略：config/dependency-graph.json');
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

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { UNIT_ID as applicationUnitId } from '@littleq/application';
import { unitManifest as domainManifest } from '@littleq/domain';

import { UNIT_ID, unitManifest, unitReadiness } from '../src/index.js';

import { describe, expect, it } from 'vitest';

import { countOccurrences, stripComments } from './support.js';

const UNIT_DIR = fileURLToPath(new URL('..', import.meta.url));

function unitFile(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

describe('@littleq/infra 单元自述', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    const manifest = JSON.parse(readFileSync(unitFile('../package.json'), 'utf8')) as {
      readonly name: string;
    };
    expect(UNIT_ID).toBe('@littleq/infra');
    expect(manifest.name).toBe(UNIT_ID);
    expect(unitManifest.layer).toBe('infra');
  });

  it('跨包 workspace 引用可解析：infra 依赖 domain 与 application', () => {
    // 期望值取自**对方包自己的**常量，不是从 infra 的 src 回读 —— 后者会被实现自己带绿。
    // 链接真断了，本文件顶部的两个 import 就会在加载期抛，用例连跑都跑不起来。
    //
    // `@littleq/application` 是 F1（ZLQ-220）加进来的：§3.5 的两个装配端口归它，
    // infra 的 `PostgresTaskUnitOfWork` / `PostgresTaskPumpStore` 只是 `implements`。
    expect(unitManifest.dependsOn).toEqual([domainManifest.unitId, applicationUnitId]);
  });
});

/**
 * 翻转 tripwire（门禁 `readiness-flip-tripwire-present`）。
 *
 * 它存在的意义是**让「改状态」这件事先红一次**：把 `skeletonOnly` 改回 `true`、或把
 * `unitReadiness.status` 改回 `'skeleton'`，本文件立刻变红，而不是等到某个下游单元发现自己
 * 依赖了一个空壳。反方向同样成立 —— 这两条断言写的是**字面值**，不是「与 src 一致」，
 * 所以它们不可能被实现自己带绿。
 */
describe('@littleq/infra 就绪翻转（D2）', () => {
  it('skeletonOnly 已翻为 false，且 unitReadiness 与它同调', () => {
    expect(unitManifest.skeletonOnly).toBe(false);
    expect(unitReadiness.status).toBe('implemented');
  });

  it('契约点名的黑盒证明 five-port-contract 在能力清单里', () => {
    expect(unitReadiness.capabilities).toContain('five-port-contract');
    expect(unitReadiness.capabilities.length).toBeGreaterThan(1);
  });

  it('acceptanceTests 的键集合与 capabilities 完全一致（没有孤儿映射，也没有漏映射）', () => {
    const mapped = Object.keys(unitReadiness.acceptanceTests).sort();
    expect(mapped).toEqual([...unitReadiness.capabilities].sort());
  });

  it('每条能力都映射到一个真实存在、形状会被 vitest 收集、且正文出现能力名的测试文件', () => {
    for (const capability of unitReadiness.capabilities) {
      const target = unitReadiness.acceptanceTests[capability];
      expect(target, `${capability} 缺映射`).toBeDefined();
      if (target === undefined) continue;
      // 形状必须是 vitest 的 include 会收集的那种，否则「有映射」等于「有死文件」。
      expect(target.startsWith('test/'), target).toBe(true);
      expect(target.endsWith('.test.ts'), target).toBe(true);
      expect(existsSync(`${UNIT_DIR}/${target}`), `${capability} -> ${target} 不存在`).toBe(true);

      // 门禁 4 的本地复刻：能力名必须出现在**剥掉注释之后**的正文里。写在注释里不算 ——
      // 注释可以被随便改，断言不行。
      const source = readFileSync(`${UNIT_DIR}/${target}`, 'utf8');
      const code = stripComments(source);
      expect(
        countOccurrences(code, capability),
        `${capability} 未出现在 ${target} 正文`,
      ).toBeGreaterThan(0);

      // 「至少一条活着的用例」的本地复刻（对应 `countTestDeclarations(source).live >= 1`）。
      // 标题写 `'`、`"` 还是反引号都算 —— 只认单引号的探针会把一个好好用
      // `` it(`${CAPABILITY}: …`) `` 拼标题的文件误判成空文件，而那种误判长得跟真缺陷一模一样。
      // `\b` 是必需的：没有它，`submit(…)` 里的 `it(` 也会被数进去。这个形状本身就把
      // `it.skip(` 一类排除在外（`it` 与 `(` 之间夹了修饰名），所以数出来的就是活着的条数。
      const live = (code.match(/\b(?:it|test)\s*\(/g) ?? []).length;
      expect(live, `${target} 里没有活着的用例`).toBeGreaterThan(0);
    }
  });
});

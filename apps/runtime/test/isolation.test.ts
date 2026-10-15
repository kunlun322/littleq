import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runtimeIsolation } from '../src/index.js';

interface GraphRule {
  id: string;
  from: string[];
  appliesTo?: string[];
  deny?: {
    packages?: string[];
    packagePrefixes?: string[];
    units?: string[];
    sourcePathGlobs?: string[];
  };
}

interface GraphConfig {
  rules: GraphRule[];
}

const graphPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../config/dependency-graph.json',
);
const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as GraphConfig;

function runtimeRules(): GraphRule[] {
  return graph.rules.filter((rule) => rule.from.includes('apps/runtime'));
}

function union(field: 'packages' | 'packagePrefixes' | 'units'): string[] {
  return [...new Set(runtimeRules().flatMap((rule) => rule.deny?.[field] ?? []))].sort();
}

describe('apps/runtime 隔离边界：代码自述与门禁配置不得漂移', () => {
  it('配置中确实存在针对 apps/runtime 的规则（否则本测试是空转）', () => {
    expect(runtimeRules().length).toBeGreaterThan(0);
    expect(
      runtimeRules()
        .map((rule) => rule.id)
        .sort(),
    ).toEqual(['runtime-no-main-site-secrets', 'runtime-no-main-site-units']);
  });

  it('禁止的包前缀与配置一致（数据库 / 对象存储 / Cookie / 模型供应商 SDK）', () => {
    expect([...runtimeIsolation.forbiddenPackagePrefixes].sort()).toEqual(union('packagePrefixes'));
  });

  it('禁止的包名与配置一致', () => {
    expect([...runtimeIsolation.forbiddenPackages].sort()).toEqual(union('packages'));
  });

  it('禁止的主站单元与配置一致', () => {
    expect([...runtimeIsolation.forbiddenUnits].sort()).toEqual(union('units'));
  });

  it('每条 runtime 规则同时约束源码导入与 package.json 声明', () => {
    for (const rule of runtimeRules()) {
      expect(rule.appliesTo).toContain('source');
      expect(rule.appliesTo).toContain('manifest');
    }
  });
});

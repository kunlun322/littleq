import { describe, expect, it } from 'vitest';

import { UNIT_ID, runtimeIsolation, unitManifest, unitReadiness } from '../src/index.js';

const CAPABILITY_TARGET = /^test\/[a-z0-9-]+\.test\.ts$/;

describe('@littleq/runtime 单元标识与就绪面', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/runtime');
    expect(unitManifest.layer).toBe('app');
    expect(unitManifest.unitId).toBe(UNIT_ID);
  });

  // 下面两行是 tools/check-unit-readiness.mjs 门 1 要求的「翻转 tripwire」：一行里同时出现
  // 就绪面词与断言。谁把状态改回去，先在这里变红，而不是等到某道门静默放行。
  it('D4 之后本单元已越过骨架期', () => {
    expect(unitManifest.skeletonOnly).toBe(false);
    expect(unitReadiness.status).toBe('implemented');
  });

  it('每条能力都映射到一个真实存在的验收测试文件', () => {
    expect(unitReadiness.capabilities.length).toBeGreaterThan(0);
    for (const capability of unitReadiness.capabilities) {
      const target = unitReadiness.acceptanceTests[capability];
      expect(target, `能力 ${capability} 缺少验收测试映射`).toMatch(CAPABILITY_TARGET);
    }
    expect(Object.keys(unitReadiness.acceptanceTests).sort()).toEqual(
      [...unitReadiness.capabilities].sort(),
    );
  });

  it('隔离自述仍然点名主站单元与主站凭据面', () => {
    expect(runtimeIsolation.forbiddenUnits).toContain('packages/infra');
    expect(runtimeIsolation.forbiddenUnits).toContain('apps/api');
    expect(runtimeIsolation.forbiddenUnits).toContain('apps/web');
    expect(runtimeIsolation.forbiddenUnits).toContain('apps/worker');
  });
});

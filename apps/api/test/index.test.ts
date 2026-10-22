import { describe, expect, it } from 'vitest';

import { UNIT_ID, unitManifest, unitReadiness } from '../src/index.js';

describe('@littleq/api 组合根', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/api');
    expect(unitManifest.layer).toBe('app');
    // `skeletonOnly` 从 true 翻成 false 是本单（ZLQ-221 / B1）的就绪声明：它必须与
    // `test/turn-to-task-to-safe-event.test.ts` 在**同一个提交**里落地，否则门禁 1 会
    // 抓到"声称已实现却没有黑盒证明"的组合。这行断言就是那根绊线。
    expect(unitManifest.skeletonOnly).toBe(false);
  });

  it('组合根解析到三个下层单元的构建产物', () => {
    expect(unitManifest.composedOf).toEqual([
      '@littleq/domain',
      '@littleq/infra',
      '@littleq/work-contract',
    ]);
  });

  it('就绪声明点名契约要求的黑盒能力，并映射到一个真实存在的验收测试', () => {
    expect(unitReadiness.status).toBe('implemented');
    // 逐字对应 tools/unit-readiness-contract.json 里 units['apps/api'].requiredProofs。
    expect(unitReadiness.capabilities).toEqual(['turn-to-task-to-safe-event']);
    expect(unitReadiness.acceptanceTests['turn-to-task-to-safe-event']).toBe(
      'test/turn-to-task-to-safe-event.test.ts',
    );
  });
});

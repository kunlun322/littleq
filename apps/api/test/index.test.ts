import { describe, expect, it } from 'vitest';

import { UNIT_ID, unitManifest } from '../src/index.js';

describe('@littleq/api 骨架', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/api');
    expect(unitManifest.layer).toBe('app');
    expect(unitManifest.skeletonOnly).toBe(true);
  });

  it('组合根解析到三个下层单元的构建产物', () => {
    expect(unitManifest.composedOf).toEqual([
      '@littleq/domain',
      '@littleq/infra',
      '@littleq/work-contract',
    ]);
  });
});

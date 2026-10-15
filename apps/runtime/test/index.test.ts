import { describe, expect, it } from 'vitest';

import { UNIT_ID, runtimeIsolation, unitManifest } from '../src/index.js';

describe('@littleq/runtime 骨架', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/runtime');
    expect(unitManifest.layer).toBe('app');
    expect(unitManifest.skeletonOnly).toBe(true);
  });

  it('骨架期不依赖任何主站单元', () => {
    expect(runtimeIsolation.forbiddenUnits).toContain('packages/infra');
    expect(runtimeIsolation.forbiddenUnits).toContain('apps/api');
  });
});

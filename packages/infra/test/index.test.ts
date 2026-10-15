import { UNIT_ID, unitManifest } from '../src/index.js';

import { describe, expect, it } from 'vitest';

describe('@littleq/infra 骨架', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/infra');
    expect(unitManifest.layer).toBe('infra');
    expect(unitManifest.skeletonOnly).toBe(true);
  });

  it('跨包 workspace 引用可解析：infra 依赖 domain', () => {
    expect(unitManifest.dependsOn).toEqual(['@littleq/domain']);
  });
});

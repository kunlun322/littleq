import { describe, expect, it } from 'vitest';

import { UNIT_ID, unitManifest } from '../src/index.js';

describe('@littleq/domain 骨架', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/domain');
  });

  it('自述为领域层且仍处于骨架期', () => {
    expect(unitManifest.layer).toBe('domain');
    expect(unitManifest.skeletonOnly).toBe(true);
    expect(unitManifest.spec).toContain('§1.3');
  });
});

import { describe, expect, it } from 'vitest';

import { UNIT_ID, unitManifest } from '../src/index.js';

describe('@littleq/design-system 骨架', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/design-system');
    expect(unitManifest.layer).toBe('design-system');
    expect(unitManifest.skeletonOnly).toBe(true);
  });
});

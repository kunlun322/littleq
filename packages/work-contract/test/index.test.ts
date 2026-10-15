import { describe, expect, it } from 'vitest';

import { UNIT_ID, contractVersionSchema, unitManifest } from '../src/index.js';

describe('@littleq/work-contract 骨架', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/work-contract');
    expect(unitManifest.layer).toBe('contract');
    expect(unitManifest.skeletonOnly).toBe(true);
  });

  it('zod 在 workspace 中可解析：占位 schema 接受契约版本 0', () => {
    expect(contractVersionSchema.safeParse({ contractVersion: 0 }).success).toBe(true);
  });

  it('zod 在 workspace 中可解析：占位 schema 拒绝未知版本', () => {
    expect(contractVersionSchema.safeParse({ contractVersion: 1 }).success).toBe(false);
    expect(contractVersionSchema.safeParse({}).success).toBe(false);
  });
});

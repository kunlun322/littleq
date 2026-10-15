import { describe, expect, it } from 'vitest';

import { UNIT_ID, isContractLoadable, unitManifest } from '../src/index.js';

describe('@littleq/web 骨架', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/web');
    expect(unitManifest.layer).toBe('app');
    expect(unitManifest.skeletonOnly).toBe(true);
  });

  it('组合根解析到设计系统与契约层', () => {
    expect(unitManifest.composedOf).toEqual(['@littleq/design-system', '@littleq/work-contract']);
  });

  it('契约层代码可随 web 产物一同执行', () => {
    expect(isContractLoadable()).toBe(true);
  });
});

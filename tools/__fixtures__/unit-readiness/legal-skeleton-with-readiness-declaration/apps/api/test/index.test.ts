import { describe, expect, it } from 'vitest';

import { unitReadiness } from '../src/index.js';

describe('@littleq/api 就绪面钉版', () => {
  it('unitReadiness.status 冻结为 skeleton，翻成 implemented 必须先让本用例变红', () => {
    expect(unitReadiness.status).toBe('skeleton');
  });
});

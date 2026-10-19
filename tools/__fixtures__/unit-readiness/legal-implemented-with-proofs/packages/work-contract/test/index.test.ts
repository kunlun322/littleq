import { describe, expect, it } from 'vitest';

import { unitReadiness } from '../src/index.js';

describe('@littleq/work-contract 就绪面钉版', () => {
  it('unitReadiness.status 冻结为 implemented，改回 skeleton 必须先让本用例变红', () => {
    expect(unitReadiness.status).toBe('implemented');
  });
});

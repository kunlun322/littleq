import { describe, expect, it } from 'vitest';

import { unitReadiness } from '../src/index.js';

describe('@littleq/runtime 就绪面钉版', () => {
  it('unitReadiness.status 必须落在状态机里', () => {
    expect(unitReadiness.status).toBe('half-done');
  });
});

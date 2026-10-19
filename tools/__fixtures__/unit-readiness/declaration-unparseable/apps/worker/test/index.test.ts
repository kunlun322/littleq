import { describe, expect, it } from 'vitest';

import { unitReadiness } from '../src/index.js';

describe('@littleq/worker 就绪面钉版', () => {
  it('unitReadiness 声明必须能解析出来', () => {
    expect(unitReadiness.status).toBe('implemented');
  });
});

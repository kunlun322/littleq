import { describe, expect, it } from 'vitest';

import { unitReadiness } from '../src/index.js';

// 门 1 只查「tripwire 存在且活着」，不查它断言的是 true 还是 false ——
// 期望值属于单元自己的测试（ZLQ-194 §9.2 规则 1），D0 不代它决定。
describe('@littleq/api 就绪面钉版', () => {
  it('unitReadiness.status 冻结为 implemented，改回 skeleton 必须先让本用例变红', () => {
    expect(unitReadiness.status).toBe('implemented');
  });
});

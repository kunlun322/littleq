import { describe, expect, it } from 'vitest';

import { UNIT_ID } from '../src/index.js';

// 门 1 对照：用例是活的，但**没有任何一条断言就绪面**。
// 于是「改状态不会先红」—— 显式翻转门等于不存在，门 1 判红 1 处。
describe('@littleq/worker 单元标识', () => {
  it('UNIT_ID 是 @littleq/worker', () => {
    expect(UNIT_ID).toBe('@littleq/worker');
  });
});

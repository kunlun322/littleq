import { describe, expect, it } from 'vitest';

import { unitManifest } from '../src/index.js';

// 门 1 要的就是这条：活着、断言就绪面、没被跳过。
// 反撒谎门（门 2）判红与它无关 —— 本夹具故意让门 1 通过，好把违规归因到门 2。
describe('@littleq/api 就绪面钉版', () => {
  it('skeletonOnly 冻结为 true，翻转必须先让本用例变红', () => {
    expect(unitManifest.skeletonOnly).toBe(true);
  });
});

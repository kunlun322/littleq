import { describe, expect, it } from 'vitest';

import { unitManifest } from '../src/index.js';

// 门 1 **不**检查这里断言的是 true 还是 false：期望值属于单元自己的钉版测试
// （ZLQ-194 §9.2 规则 1），D0 只保证「这条 tripwire 存在且活着」。
// 判红的是门 6 —— 状态机不允许 implemented 退回 skeleton。
describe('@littleq/domain 就绪面钉版', () => {
  it('skeletonOnly 被改回了 true', () => {
    expect(unitManifest.skeletonOnly).toBe(true);
  });
});

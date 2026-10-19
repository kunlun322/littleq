import { describe, expect, it } from 'vitest';

import { unitManifest } from '../src/index.js';

// 门 1 需要的那条活着的 tripwire：有它在，门 5 的判红才只归因于下面的退役写法。
describe('@littleq/worker 就绪面钉版', () => {
  it('skeletonOnly 冻结为 true，翻转必须先让本用例变红', () => {
    expect(unitManifest.skeletonOnly).toBe(true);
  });
});

// 下面四种写法都是「把用例退役掉」：被跳过的用例不会变红，只会消失。
// ZLQ-194 §9.2 规则 5 / ZLQ-195 §7 弱出口 ② 点名禁止，门 5 逐条判红（共 4 处）。
describe.skip('被整组跳过的钉版测试', () => {
  it('永远不会执行', () => {
    expect(unitManifest.skeletonOnly).toBe(false);
  });
});

it.only('只跑这一条，其余静默不跑', () => {
  expect(true).toBe(true);
});

it.todo('留个坑以后补');

it.skipIf(true)('条件跳过', () => {
  expect(true).toBe(true);
});

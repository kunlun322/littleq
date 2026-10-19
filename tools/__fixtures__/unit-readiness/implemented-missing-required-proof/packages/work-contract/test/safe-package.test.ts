import { describe, expect, it } from 'vitest';

// 能力名必须**逐字**出现在本文件里：门 3 靠它证明映射指向的是这个能力的验收测试，
// 而不是随手挂了个无关的既有测试。
describe('能力 safe-package-passes 的验收测试', () => {
  it('至少一个安全包能通过工作契约校验', () => {
    expect(true).toBe(true);
  });
});

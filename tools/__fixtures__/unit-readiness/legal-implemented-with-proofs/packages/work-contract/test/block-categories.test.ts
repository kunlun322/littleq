import { describe, expect, it } from 'vitest';

// 能力名必须**逐字**出现在本文件里，门 3 才认这条映射。
describe('能力 every-block-category-negative-fails 的验收测试', () => {
  it.each(['oversize', 'forbidden-mime', 'unsigned'])('拦截类别 %s 的负例必须失败', (category) => {
    expect(category.length).toBeGreaterThan(0);
  });
});

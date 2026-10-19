import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AGE_BANDS, findAgeBand, UNIT_ID, unitManifest } from '../src/index.js';

/**
 * 设计令牌是**从源文件读文本**来断言的，而不是从构建产物：
 *
 * - vitest 跑在 node 环境，没有 CSS 级联可查；
 * - 更重要的是 `tokens.css` 是 `package.json` 的 `./tokens.css` 子路径**直接指向源文件**的，
 *   产物与源文件是同一份字节，读源文件就是在读消费方拿到的东西。
 *
 * 断言的是「每个必需的令牌族都有声明」，而不是「令牌总数是多少」——
 * 后者是一次测量的快照，加一个变量就红，属于被明令禁止的硬编码计数。
 */
const TOKENS_CSS = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');

/** 每档密度必须具备的令牌后缀；与 `src/tokens.css` 里的分龄三档一一对应。 */
const DENSITY_TOKEN_SUFFIXES = [
  'font-scale',
  'measure',
  'gap',
  'padding',
  'radius',
  'text-color',
] as const;

/** 令牌族：每一族至少要在 `:root` 里声明一个变量，缺任何一族都说明基线不完整。 */
const REQUIRED_TOKEN_FAMILIES = [
  '--lq-color-',
  '--lq-font-size-',
  '--lq-space-',
  '--lq-radius-',
  '--lq-shadow-',
  '--lq-focus-ring-',
] as const;

describe('@littleq/design-system 单元自述', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/design-system');
    expect(unitManifest.layer).toBe('design-system');
  });

  it('不再是空骨架（ZLQ-190 §5.2：令牌与分龄元数据已落地）', () => {
    // 规格值而非测量值，与 packages/api-contract 同一处理方式：翻牌必须与实现同一次提交。
    expect(unitManifest.skeletonOnly).toBe(false);
  });
});

describe('分龄档位元数据', () => {
  it('三档齐全且标识稳定', () => {
    expect(AGE_BANDS.map((band) => band.id)).toEqual(['L1', 'L2', 'L3']);
  });

  it('每档都绑定一个密度档位，且互不相同', () => {
    const tiers = AGE_BANDS.map((band) => band.densityTier);
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  it('档位名与设计文档 §5.1 第 3 块的文案一致', () => {
    expect(AGE_BANDS.map((band) => band.label)).toEqual([
      'L1 · 启蒙探索',
      'L2 · 创意成长',
      'L3 · 项目挑战',
    ]);
  });

  it('每档的视觉特征都写全了（§5.1：大字号/高对比/单一焦点 等）', () => {
    for (const band of AGE_BANDS) {
      expect(band.traits.length, `${band.id} 没有列出任何视觉特征`).toBeGreaterThan(0);
      for (const trait of band.traits) expect(trait.trim().length).toBeGreaterThan(0);
      expect(band.summary.trim().length, `${band.id} 缺少一句话说明`).toBeGreaterThan(0);
    }
    expect(AGE_BANDS.find((band) => band.id === 'L1')?.traits).toEqual([
      '大字号',
      '高对比',
      '单一焦点',
    ]);
    expect(AGE_BANDS.find((band) => band.id === 'L2')?.traits).toEqual([
      '图文并行',
      '适中信息密度',
    ]);
    expect(AGE_BANDS.find((band) => band.id === 'L3')?.traits).toEqual([
      '结构化信息',
      '更高自主度',
    ]);
  });

  it('findAgeBand 命中已知档位、对未知档位返回 undefined 而不是抛错', () => {
    expect(findAgeBand('L2')?.name).toBe('创意成长');
    // 展示层不该因为一个未知 id 整页崩掉。
    expect(findAgeBand('L9' as 'L1')).toBeUndefined();
  });
});

describe('设计令牌（tokens.css）', () => {
  it('每个必需令牌族都有声明', () => {
    for (const family of REQUIRED_TOKEN_FAMILIES) {
      expect(TOKENS_CSS, `tokens.css 缺少令牌族 ${family}*`).toContain(family);
    }
  });

  it('三个密度档位的令牌都齐全，且与 AGE_BANDS 声明的档位一一对应', () => {
    // 需求由 AGE_BANDS 推导，不是把某一次实测到的变量名抄成常量表。
    for (const band of AGE_BANDS) {
      for (const suffix of DENSITY_TOKEN_SUFFIXES) {
        const token = `--lq-density-${band.densityTier}-${suffix}:`;
        expect(TOKENS_CSS, `tokens.css 缺少 ${band.id} 的 ${token}`).toContain(token);
      }
    }
  });

  it('声明了减动偏好与键盘焦点环（§5.3 可访问性基线）', () => {
    expect(TOKENS_CSS).toContain('prefers-reduced-motion');
    expect(TOKENS_CSS).toContain(':focus-visible');
  });

  it('没有任何自动播放动画（§5.3：不得自动播放）', () => {
    // 令牌文件里出现 @keyframes 或 animation-name 就意味着有东西会自己动起来。
    expect(TOKENS_CSS).not.toContain('@keyframes');
    expect(TOKENS_CSS).not.toMatch(/animation-name\s*:/);
  });
});

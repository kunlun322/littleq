/**
 * 分龄体验档位 —— 纯展示元数据（ZLQ-190 §5.2）。
 *
 * 这里只有「三个档位各自叫什么、长什么样、怎么描述」，**没有任何分龄判断逻辑**：
 * 按年龄/学段推荐内容属于 `packages/domain`，设计系统若持有它就会踩
 * `design-system-no-business-coupling` 边界（`config/dependency-graph.json`）。
 *
 * `densityTier` 与 `tokens.css` 里的 `--lq-density-l{1,2,3}-*` 一一对应，
 * 消费方用它挑 CSS 变量，而不是自己另写一套密度规则。
 */

/** 分龄档位标识。与 PRD 的 L1/L2/L3 三档一致，是稳定的对外字面量。 */
export type AgeBandId = 'L1' | 'L2' | 'L3';

/** 信息密度档位 —— 决定字号、行宽、留白与对比强度，是 CSS 令牌的选择键。 */
export type DensityTier = 'l1' | 'l2' | 'l3';

export interface AgeBand {
  readonly id: AgeBandId;
  /** 卡片标题里的档位名，例如「启蒙探索」。 */
  readonly name: string;
  /** 卡片标题的完整形式，例如「L1 · 启蒙探索」。 */
  readonly label: string;
  readonly densityTier: DensityTier;
  /** 一句话说明这个档位给学生的体验是什么。 */
  readonly summary: string;
  /** 视觉与信息结构特征；顺序即展示顺序。 */
  readonly traits: readonly string[];
}

export const AGE_BANDS: readonly AgeBand[] = [
  {
    id: 'L1',
    name: '启蒙探索',
    label: 'L1 · 启蒙探索',
    densityTier: 'l1',
    summary: '面向初次接触编程的低龄学生，一次只呈现一个焦点。',
    traits: ['大字号', '高对比', '单一焦点'],
  },
  {
    id: 'L2',
    name: '创意成长',
    label: 'L2 · 创意成长',
    densityTier: 'l2',
    summary: '面向已能独立完成小作品的学生，图文并行地展开创作路径。',
    traits: ['图文并行', '适中信息密度'],
  },
  {
    id: 'L3',
    name: '项目挑战',
    label: 'L3 · 项目挑战',
    densityTier: 'l3',
    summary: '面向进入完整项目周期的学生，用结构化信息支撑更高自主度。',
    traits: ['结构化信息', '更高自主度'],
  },
];

/** 按档位标识查表。返回 `undefined` 而不是抛错：展示层不该因为一个未知 id 整页崩掉。 */
export function findAgeBand(id: AgeBandId): AgeBand | undefined {
  return AGE_BANDS.find((band) => band.id === id);
}

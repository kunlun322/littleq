/**
 * 主站文案的唯一出处（ZLQ-190 §5.1）。
 *
 * 为什么单独成模块而不是把字符串直接写在 `app/page.tsx` 里：
 *
 * 1. 单元测试跑在 node 环境，没有 DOM 可渲染；把文案抽成常量，`apps/web/test` 就能直接
 *    断言「诚实状态条」「本次已交付 / 尚未开放」这些**内容**，而不是退化成「组件能 import」。
 * 2. e2e 与单元测试引用同一份常量，两侧不可能各说各话。
 * 3. 后续里程碑改文案时，改这一处即可，页面结构不动。
 *
 * 本文件不 import 任何 Node 内建模块 —— 它会被打进客户端 bundle。
 */

export const SITE_NAME = 'Little Q';

export const LICENSE_ID = 'AGPL-3.0-only';

/** §5.1 第 5 块：全站唯一的主行动。不得出现「开始创作 / 登录 / 立即体验」这类假入口。 */
export const PRIMARY_ACTION_LABEL = '查看源码与许可证';

export const SOURCE_AND_LICENSE_PATH = '/source-and-license/';

export const HERO_TITLE = '和 Little Q 一起，把想法变成作品';

export const HERO_LEAD =
  '面向 K12 学生的 AI 编程与创作平台。当前站点是首个可部署切片：' +
  '只呈现品牌、分龄体验方向与开源信息，不包含任何产品功能。';

/** 品牌吉祥物的文字替代（§5.3：纯 CSS 造型必须有文本替代）。 */
export const MASCOT_ALT = '小黄鸭 Little Q 的几何造型插画';

/** §5.1 第 2 块：诚实状态条。措辞固定，不得弱化成「即将上线」。 */
export const STATUS_HEADING = 'M0 质量基线已交付，产品功能开发中';

export const STATUS_BODY = '当前可查看品牌、分龄体验方向与开源信息；创作、账号和 AI 功能尚未开放。';

/** §5.1 第 4 块：本次交付范围与明确的未开放项。 */
export const SCOPE_DELIVERED_HEADING = '本次已交付';

export const SCOPE_DELIVERED_ITEMS = ['可部署页面', '分龄视觉基线', '开源信息入口'] as const;

export const SCOPE_UNAVAILABLE_HEADING = '尚未开放';

export const SCOPE_UNAVAILABLE_ITEMS = [
  'Vibe Coding',
  '作品发布',
  '账号',
  '教师 / 家长',
  'AI 集成',
] as const;

/** 分龄区块的标题与说明（卡片内容来自 `@littleq/design-system` 的 AGE_BANDS）。 */
export const AGE_BANDS_HEADING = '三个分龄体验方向';

export const AGE_BANDS_LEAD =
  '同一套内容会按学段呈现不同的信息密度。下面是三个方向的视觉与结构差异，' +
  '当前仅作展示，尚不可点击进入任何功能。';

/** 页脚常驻项（§5.1 第 6 块 / §7 D5）。 */
export const FOOTER_SOURCE_LABEL = '源码与许可证';

/** §7 D5：法务静态文件。路径即部署后的 URL，不得指向浮动分支。 */
export const LEGAL_FILES = [
  { path: '/legal/AGPL-3.0.txt', label: 'AGPL-3.0 许可证全文' },
  { path: '/legal/NOTICE.txt', label: 'NOTICE（版权声明与网络条款提示）' },
  { path: '/legal/THIRD_PARTY_LICENSES.txt', label: '第三方组件许可证清单' },
  { path: '/licenses.txt', label: '构建产物归因清单' },
] as const;

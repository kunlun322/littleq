export const THEMES = {
  A: {
    name: '奶油绘本',
    description: '暖暖的纸张、柔软的圆角，像翻开一本自己的故事书。',
    detail: '温柔纸感 · 绘本标题 · 书封作品卡',
    image: '/themes/hero-book.png',
    colors: ['#FFD45B', '#FFF9E9', '#53402C', '#F2D2BD', '#DCE5D2'],
  },
  B: {
    name: '贴纸游乐场',
    description: '大胆的描边、彩色的贴纸，把每个想法变成好玩的冒险。',
    detail: '彩色拼贴 · 鲜明描边 · 趣味工具栏',
    image: '/themes/hero-play.png',
    colors: ['#FFCF32', '#FFF6CF', '#342C24', '#D7EAD8', '#E6DCF4'],
  },
  C: {
    name: '阳光创作室',
    description: '明亮的桌面、清爽的布局，让创作和学习都有自己的位置。',
    detail: '暖白底色 · 有序卡片 · 侧边导航',
    image: '/themes/hero-studio.png',
    colors: ['#F4BF24', '#FFF6D5', '#FAF9F4', '#30332B', '#7F8B59'],
  },
} as const;

export type Theme = keyof typeof THEMES;
export const THEME_COOKIE = 'littleq-theme';
export const DEFAULT_THEME: Theme = 'C';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && Object.hasOwn(THEMES, value);
}

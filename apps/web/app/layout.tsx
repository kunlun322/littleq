/**
 * 根布局（ZLQ-190 §5.3 / §7 D5）。
 *
 * 设计令牌必须在 `globals.css` 之前导入：后者只消费 `var(--lq-*)`，不重定义任何一个
 * （§5.2 明令禁止应用侧另立一套品牌色 / 间距 / 分龄变量）。
 *
 * header / main / footer 三段都放在这里，页面只提供 main 内部的 section 与那唯一的 h1。
 * 这样「DOM 顺序必须是 header → main → section → footer」和「页脚常驻」
 * 都是结构性保证，而不是每个页面各自记得。
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@littleq/design-system/tokens.css';

import { SiteFooter } from './_components/site-footer';
import { SiteHeader } from './_components/site-header';
import { SITE_NAME } from '../src/site-content';

import './globals.css';

export const metadata: Metadata = {
  title: `${SITE_NAME} — 面向 K12 学生的 AI 编程与创作平台`,
  description:
    'LittleQ：学生登录后用一句话创作可交互的小网页，作品持久保存并在隔离预览区查看。' +
    '游戏 / 动画 / 绘本专属创作、公开分享与教师 / 家长管理端尚未开放。',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="lq-tokens-root lq-shell">
        <SiteHeader />
        <main className="lq-main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';
import './themes.css';
import { cookies } from 'next/headers';
import { Header } from '@/components/Header';
import { ThemeProvider } from '@/components/ThemePicker';
import { DEFAULT_THEME, THEME_COOKIE, isTheme } from '@/lib/themes';
import { currentUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Little Q · 和小黄鸭一起把想法变成作品',
  description: '面向中小学生的 AI 编程与创作平台：说一句话，做出小游戏、小工具、小动画，一键发布分享。',
  icons: {
    icon: [{ url: '/favicon.png', sizes: '32x32', type: 'image/png' }, { url: '/littleq-icon.png', sizes: '256x256', type: 'image/png' }],
    apple: '/littleq-icon.png',
  },
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let user = null;
  try {
    user = await currentUser();
  } catch (e) {
    console.error('[layout] 读取登录状态失败', e);
  }
  const preference = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(preference) ? preference : DEFAULT_THEME;
  return (
    <html lang="zh-CN" data-theme={theme} suppressHydrationWarning>
      <body className={`band-${user?.age_band || 'L2'}`}>
        <ThemeProvider initialTheme={theme}>
          <Header user={user ? { nickname: user.nickname, avatar: user.avatar, role: user.role } : null} />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}

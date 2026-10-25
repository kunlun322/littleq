'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Duck } from './Duck';
import { ThemeButton } from './ThemePicker';
import { Avatar } from './Illustration';
import { Icon } from './Icon';

type U = { nickname: string; avatar: string; role: string } | null;

export function Header({ user }: { user: U }) {
  const path = usePathname();
  const router = useRouter();
  const links = [
    { href: '/projects', label: '我的作品', auth: true },
    { href: '/gallery', label: '作品广场' },
    { href: '/classes', label: user?.role === 'teacher' ? '我的班级' : '班级', auth: true },
  ];
  async function logout() {
    await fetch('/api/auth/me', { method: 'POST' });
    router.push('/');
    router.refresh();
  }
  return (
    <header className="header">
      <div className="container">
        <Link href="/" className="brand">
          <Duck size={36} />
          <span>Little Q</span>
        </Link>
        <nav className="nav" aria-label="主要导航">
          {links
            .filter((l) => !l.auth || user)
            .map((l) => (
              <Link key={l.href} href={l.href} className={path.startsWith(l.href) ? 'active' : ''}>
                {l.label}
              </Link>
            ))}
        </nav>
        <div className="header-actions">
        <ThemeButton />
        {user ? (
          <div className="me">
            <Link href="/me" className="me" style={{ color: 'inherit' }} aria-label={`${user.nickname}的个人资料`}>
              <Avatar value={user.avatar} size={32} />
              <span className="nick">{user.nickname}</span>
              {user.role === 'teacher' && <span className="badge blue">老师</span>}
            </Link>
            <button className="btn ghost sm" onClick={logout}>
              <Icon name="logout" size={18} /> 退出
            </button>
          </div>
        ) : (
          <Link href="/login" className="btn primary sm">
            登录 / 注册
          </Link>
        )}
        </div>
      </div>
    </header>
  );
}

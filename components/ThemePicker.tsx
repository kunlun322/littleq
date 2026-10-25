'use client';

import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { THEMES, THEME_COOKIE, type Theme } from '@/lib/themes';

type ThemeContextValue = { theme: Theme; select: (theme: Theme) => void; openPicker: () => void };
const ThemeContext = createContext<ThemeContextValue>(null!);

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ initialTheme, children }: { initialTheme: Theme; children: React.ReactNode }) {
  const [theme, setTheme] = useState(initialTheme);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const path = usePathname();
  const interior = path !== '/' && path !== '/login';

  function select(next: Theme) {
    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    setTheme(next);
  }

  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    element.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = overflow;
    };
  }, [open]);

  return (
    <ThemeContext.Provider value={{ theme, select, openPicker: () => setOpen(true) }}>
      <div className={`app-shell${interior ? ' app-interior' : ''}`}>
        {children}
      </div>
      <dialog ref={dialog} className="theme-dialog" aria-labelledby="theme-dialog-title" aria-describedby="theme-dialog-description" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const controls = e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:checked');
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }} onClick={(e) => {
        if (e.target === e.currentTarget) {
          const bounds = e.currentTarget.getBoundingClientRect();
          if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) setOpen(false);
        }
      }}>
        <div className="row between theme-dialog-heading">
          <div>
            <span className="eyebrow">平台界面风格 · 只换外观</span>
            <h2 id="theme-dialog-title">换一套界面风格</h2>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => setOpen(false)} aria-label="关闭界面风格选择">关闭</button>
        </div>
        <p id="theme-dialog-description" className="muted">三套界面风格任选其一，选中即生效。只改变平台的颜色和排版，你的作品、对话和班级都不会变。</p>
        <ThemeOptions />
        <div className="row between theme-dialog-footer">
          <p className="small muted" role="status">当前界面风格：{THEMES[theme].name} · 保存在当前浏览器</p>
          <button type="button" className="btn primary" onClick={() => setOpen(false)}>就用这套界面</button>
        </div>
      </dialog>
    </ThemeContext.Provider>
  );
}

function ThemeOptions({ compact = false }: { compact?: boolean }) {
  const { theme, select } = useContext(ThemeContext);
  const groupId = useId();
  return (
    <fieldset className={`theme-options${compact ? ' compact' : ''}`}>
      <legend className="sr-only">选择平台界面风格</legend>
      {(Object.entries(THEMES) as [Theme, typeof THEMES[Theme]][]).map(([id, design]) => (
        <label key={id} className={`theme-choice theme-choice-${id}`}>
          <input type="radio" name={groupId} value={id} checked={theme === id} onChange={() => select(id)} />
          <span className="theme-choice-image">
            <Image src={design.image} alt="" width={600} height={450} sizes="(max-width: 760px) 90vw, 330px" />
            <span className="theme-choice-code">{id}</span>
          </span>
          <span className="theme-choice-body">
            <span className="theme-choice-title"><strong>{design.name}</strong><span className="theme-choice-status">{theme === id ? '使用中' : '选择'}</span></span>
            <span className="theme-choice-description">{compact ? design.detail : design.description}</span>
            <span className="theme-swatches" aria-hidden="true">{design.colors.map(color => <i key={color} style={{ background: color }} />)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function ThemeButton() {
  const { theme, openPicker } = useContext(ThemeContext);
  return <button type="button" className="btn ghost sm theme-trigger" onClick={openPicker} aria-haspopup="dialog" title="切换平台界面风格"><span className="theme-trigger-dot" aria-hidden="true" />界面风格<span className="theme-trigger-name"> · {THEMES[theme].name}</span></button>;
}

export function HomeThemePicker() {
  return (
    <section className="home-themes" aria-labelledby="home-themes-title">
      <div className="row between">
        <div><span className="eyebrow">只换外观，不换内容</span><h2 id="home-themes-title">选择平台的界面风格</h2></div>
        <p className="small muted">三选一，点选即切换 · 作品和班级不受影响 · 导航栏「界面风格」随时可换</p>
      </div>
      <ThemeOptions compact />
    </section>
  );
}

export function ThemeHero() {
  const { theme } = useContext(ThemeContext);
  return <div className="theme-hero-art"><Image src={THEMES[theme].image} alt={`Little Q 小黄鸭插画（${THEMES[theme].name}界面风格）`} width={1200} height={900} sizes="(max-width: 760px) 90vw, 540px" loading="eager" /></div>;
}

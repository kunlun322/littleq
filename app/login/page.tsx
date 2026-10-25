'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Duck } from '@/components/Duck';
import { ThemeHero } from '@/components/ThemePicker';
import { AVATARS, AVATAR_IMAGES, BANDS } from '@/lib/constants';
import { Avatar, Illustration } from '@/components/Illustration';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({
    username: '',
    password: '',
    nickname: '',
    role: 'student',
    ageBand: 'L2',
    avatar: '🐥',
    joinCode: '',
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(f),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '没成功，再试一次吧');
      router.push((d.role || f.role) === 'teacher' ? '/classes' : '/projects');
      router.refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page auth-page">
      <div className="container auth-layout">
        <section className="auth-story">
          <span className="eyebrow">好奇心，就是最棒的起点</span>
          <h2>小小的想法，<br />也能长成了不起的作品。</h2>
          <p className="muted">和 Little Q 一起，用自己的方式创造、探索、分享。</p>
          <ThemeHero />
        </section>
        <div className="auth-form">
        <div className="center" style={{ marginBottom: 16 }}>
          <Duck size={96} className="duck-wiggle" />
          <h1 style={{ margin: '8px 0 0' }}>{mode === 'login' ? '欢迎回来！' : '加入 Little Q'}</h1>
        </div>
        <div className="card">
          <div className="tabs" style={{ marginBottom: 16 }}>
            <button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')} type="button">
              登录
            </button>
            <button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')} type="button">
              注册
            </button>
          </div>
          <form className="stack" onSubmit={submit}>
            {mode === 'register' && (
              <>
                <label>我是</label>
                <div className="choice">
                  {([
                    ['student', '学生'],
                    ['teacher', '老师 / 家长'],
                  ] as const).map(([k, l]) => (
                    <button type="button" key={k} className={f.role === k ? 'on' : ''} aria-pressed={f.role === k} onClick={() => set('role', k)}>
                      <span className="emo"><Illustration name={k} size={52} /></span>
                      {l}
                    </button>
                  ))}
                </div>
              </>
            )}
            <label>用户名</label>
            <input
              className="input"
              value={f.username}
              onChange={(e) => set('username', e.target.value.toLowerCase())}
              placeholder="字母、数字，3-24 位"
              autoComplete="username"
              required
            />
            <label>密码</label>
            <input
              className="input"
              type="password"
              value={f.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder="至少 4 位"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
            {mode === 'register' && (
              <>
                <label>昵称</label>
                <input
                  className="input"
                  value={f.nickname}
                  onChange={(e) => set('nickname', e.target.value)}
                  placeholder="大家怎么称呼你？"
                />
                <label>选个头像</label>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {AVATARS.map((a) => (
                    <button
                      type="button"
                      key={a}
                      className={`btn sm avatar-choice ${f.avatar === a ? 'primary' : 'ghost'}`}
                      aria-label={`选择${AVATAR_IMAGES[a].label}头像`}
                      aria-pressed={f.avatar === a}
                      onClick={() => set('avatar', a)}
                    >
                      <Avatar value={a} size={32} />
                    </button>
                  ))}
                </div>
                {f.role === 'student' && (
                  <>
                    <label>年级</label>
                    <div className="choice">
                      {Object.entries(BANDS).map(([k, b]) => (
                        <button type="button" key={k} className={f.ageBand === k ? 'on' : ''} onClick={() => set('ageBand', k)}>
                          <span className="emo"><Illustration name={b.icon} size={52} /></span>
                          {b.name}
                          <span className="small muted">{b.desc}</span>
                        </button>
                      ))}
                    </div>
                    <label>班级邀请码（可选）</label>
                    <input
                      className="input"
                      value={f.joinCode}
                      onChange={(e) => set('joinCode', e.target.value.toUpperCase())}
                      placeholder="老师给的 6 位码，没有就空着"
                    />
                  </>
                )}
              </>
            )}
            {err && <div className="notice err">{err}</div>}
            <button className="btn primary lg" disabled={busy}>
              {busy ? '稍等一下…' : mode === 'login' ? '登录' : '注册并开始'}
            </button>
          </form>
        </div>
        </div>
      </div>
    </main>
  );
}

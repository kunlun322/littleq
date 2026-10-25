'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AVATARS, AVATAR_IMAGES, BANDS } from '@/lib/constants';
import { Avatar, Illustration } from '@/components/Illustration';
import { api } from '@/lib/client';

export function MeForm(props: { nickname: string; avatar: string; ageBand: string; role: string }) {
  const router = useRouter();
  const [f, setF] = useState({ nickname: props.nickname, avatar: props.avatar, ageBand: props.ageBand });
  const [msg, setMsg] = useState('');
  async function save() {
    try {
      await api('/api/auth/me', 'PATCH', f);
      setMsg('保存好啦');
      router.refresh();
    } catch (e: any) {
      setMsg(e.message);
    }
  }
  return (
    <div className="card stack">
      <label>昵称</label>
      <input className="input" value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} maxLength={20} />
      <label>头像</label>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {AVATARS.map((a) => (
          <button key={a} className={`btn sm avatar-choice ${f.avatar === a ? 'primary' : 'ghost'}`} aria-label={`选择${AVATAR_IMAGES[a].label}头像`} aria-pressed={f.avatar === a} onClick={() => setF({ ...f, avatar: a })}>
            <Avatar value={a} size={32} />
          </button>
        ))}
      </div>
      {props.role === 'student' && (
        <>
          <label>年级（Little Q 会按这个调整说话方式）</label>
          <div className="choice">
            {Object.entries(BANDS).map(([k, b]) => (
              <button key={k} className={f.ageBand === k ? 'on' : ''} onClick={() => setF({ ...f, ageBand: k })}>
                <span className="emo"><Illustration name={b.icon} size={48} /></span>
                {b.name}
                <span className="small muted">{b.desc}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {msg && <div className="notice ok">{msg}</div>}
      <button className="btn primary" onClick={save}>
        保存
      </button>
    </div>
  );
}

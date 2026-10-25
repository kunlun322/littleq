'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { STARTERS, WORK_TYPES, type WorkType } from '@/lib/constants';
import { api } from '@/lib/client';
import { Illustration } from '@/components/Illustration';
import { Icon } from '@/components/Icon';

export function NewWork() {
  const router = useRouter();
  const [type, setType] = useState<WorkType>('GAME');
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function create(workType: WorkType, title: string, prompt: string) {
    setBusy(true);
    setErr('');
    try {
      const { id } = await api<{ id: string }>('/api/projects', 'POST', { workType, title });
      router.push(`/create/${id}${prompt ? `?prompt=${encodeURIComponent(prompt)}` : ''}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}><Illustration name="newwork" size={40} /> 做个新作品</h2>
      <div className="choice">
        {(Object.keys(WORK_TYPES) as WorkType[]).map((k) => (
          <button key={k} className={type === k ? 'on' : ''} onClick={() => setType(k)}>
            <span className="emo"><Illustration name={WORK_TYPES[k].icon} size={52} /></span>
            {WORK_TYPES[k].label}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="说说你想做什么，比如：一个会躲开鼠标的小鸭子"
          onKeyDown={(e) => e.key === 'Enter' && idea.trim() && create(type, idea.trim().slice(0, 20), idea.trim())}
        />
        <button className="btn primary" disabled={busy || !idea.trim()} onClick={() => create(type, idea.trim().slice(0, 20), idea.trim())}>
          开始做 <Icon name="arrow" size={18} />
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => create(type, `我的${WORK_TYPES[type].label}`, '')}>
          空白开始
        </button>
      </div>
      <div className="small muted">没想法？点一个灵感试试：</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {STARTERS.map((s) => (
          <button key={s.title} className="btn sm ghost" disabled={busy} onClick={() => create(s.type, s.title, s.prompt)}>
            <Illustration name={WORK_TYPES[s.type].icon} size={24} /> {s.title}
          </button>
        ))}
      </div>
      {err && <div className="notice err">{err}</div>}
    </div>
  );
}

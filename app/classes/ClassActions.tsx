'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import { BANDS } from '@/lib/constants';
import { WorkFrame } from '@/components/WorkFrame';
import { Avatar, Illustration } from '@/components/Illustration';
import { Icon } from '@/components/Icon';

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<any>, ok?: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      if (ok) setMsg({ ok: true, text: ok });
      router.refresh();
      return r;
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }
  const note = msg && (
    <div className={`notice ${msg.ok ? 'ok' : 'err'}`}>
      <span className="inline-identity"><Icon name={msg.ok ? 'check' : 'info'} />{msg.text}</span>
    </div>
  );
  return { busy, run, note, router };
}

export function CreateClass() {
  const [name, setName] = useState('');
  const { busy, run, note, router } = useAction();
  return (
    <div className="card stack">
      <div className="row" style={{ gap: 8 }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="班级名称，例如：三年级二班 编程社" />
        <button
          className="btn primary"
          disabled={busy || !name.trim()}
          onClick={() =>
            run(async () => {
              const d = await api<{ id: string }>('/api/classes', 'POST', { name });
              setName('');
              router.push(`/classes/${d.id}`);
            })
          }
        >
          建班级
        </button>
      </div>
      {note}
    </div>
  );
}

export function JoinClass() {
  const [code, setCode] = useState('');
  const { busy, run, note } = useAction();
  return (
    <div className="card stack">
      <div className="row" style={{ gap: 8 }}>
        <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="输入老师给的 6 位加入码" maxLength={6} />
        <button className="btn primary" disabled={busy || code.length < 6} onClick={() => run(() => api('/api/classes/join', 'POST', { joinCode: code }), '加入成功')}>
          加入班级
        </button>
      </div>
      {note}
    </div>
  );
}

export function SubmitWork({ assignmentId, projects, current }: { assignmentId: string; projects: { id: string; title: string }[]; current?: string | null }) {
  const [pid, setPid] = useState(current || projects[0]?.id || '');
  const { busy, run, note } = useAction();
  if (projects.length === 0) return <p className="muted small">先去“我的作品”做一个，再回来交作业吧～</p>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <select className="input" value={pid} onChange={(e) => setPid(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={busy || !pid} onClick={() => run(() => api(`/api/assignments/${assignmentId}/submit`, 'POST', { projectId: pid }), '交上去啦')}>
          {current ? '重新提交' : '提交作业'}
        </button>
      </div>
      {note}
    </div>
  );
}

export function BatchStudents({ classId }: { classId: string }) {
  const [names, setNames] = useState('');
  const [band, setBand] = useState('L2');
  const [created, setCreated] = useState<{ nickname: string; username: string; password: string }[]>([]);
  const { busy, run, note } = useAction();
  return (
    <div className="card stack">
      <h3 className="inline-identity" style={{ margin: 0 }}><Illustration name="student" size={32} />批量添加学生</h3>
      <textarea
        className="input"
        rows={4}
        value={names}
        onChange={(e) => setNames(e.target.value)}
        placeholder={'每行一个名字（或用逗号隔开）\n小明\n小红'}
      />
      <div className="choice">
        {Object.entries(BANDS).map(([k, b]) => (
          <button key={k} className={`inline-identity${band === k ? ' on' : ''}`} onClick={() => setBand(k)}>
            <Illustration name={b.icon} size={28} />{b.name}
          </button>
        ))}
      </div>
      <button
        className="btn primary"
        disabled={busy || !names.trim()}
        onClick={() =>
          run(async () => {
            const d = await api<{ created: typeof created }>(`/api/classes/${classId}/students`, 'POST', {
              names: names.split(/[\n,，、]/).map((s) => s.trim()).filter(Boolean),
              ageBand: band,
            });
            setCreated(d.created);
            setNames('');
          })
        }
      >
        生成账号
      </button>
      {note}
      {created.length > 0 && (
        <div className="notice ok">
          <b>账号已生成，请抄下来发给学生（只显示这一次）：</b>
          <div className="table-scroll" role="region" aria-label="新建学生账号" tabIndex={0}>
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>名字</th>
                <th>用户名</th>
                <th>密码</th>
              </tr>
            </thead>
            <tbody>
              {created.map((c) => (
                <tr key={c.username}>
                  <td>{c.nickname}</td>
                  <td>
                    <code>{c.username}</code>
                  </td>
                  <td>
                    <code>{c.password}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function RemoveStudent({ classId, userId, name }: { classId: string; userId: string; name: string }) {
  const { busy, run } = useAction();
  return (
    <button
      className="btn ghost sm"
      disabled={busy}
      onClick={() => confirm(`把 ${name} 移出班级？`) && run(() => api(`/api/classes/${classId}/students`, 'DELETE', { userId }))}
    >
      移出
    </button>
  );
}

export function NewAssignment({ classId }: { classId: string }) {
  const [f, setF] = useState({ title: '', description: '', dueAt: '' });
  const { busy, run, note } = useAction();
  return (
    <div className="card stack">
      <h3 className="inline-identity" style={{ margin: 0 }}><Illustration name="assignment" size={32} />布置作业</h3>
      <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="作业标题，例如：做一个会动的生日贺卡" />
      <textarea className="input" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="要求说明（可选）" />
      <div className="row" style={{ gap: 8 }}>
        <span className="small muted">截止日期</span>
        <input className="input" type="date" style={{ width: 'auto' }} value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} />
        <span className="spacer" />
        <button
          className="btn primary"
          disabled={busy || !f.title.trim()}
          onClick={() =>
            run(async () => {
              await api(`/api/classes/${classId}/assignments`, 'POST', f);
              setF({ title: '', description: '', dueAt: '' });
            }, '布置好啦')
          }
        >
          发布作业
        </button>
      </div>
      {note}
    </div>
  );
}

export function GradeBox({ sub }: { sub: { id: string; project_id: string; version_seq: number; stars: number | null; comment: string | null; status: string } }) {
  const [open, setOpen] = useState(false);
  const [stars, setStars] = useState(sub.stars || 5);
  const [comment, setComment] = useState(sub.comment || '');
  const { busy, run, note } = useAction();
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>
        {sub.status === 'graded' ? '查看 / 改评价' : '看作品 & 批改'}
      </button>
      {open && (
        <div className="modal-bg" onClick={() => setOpen(false)}>
          <div className="modal stack" style={{ maxWidth: 820, width: '95vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="player" style={{ height: 420 }}>
              <WorkFrame src={`/r/${sub.project_id}?v=${sub.version_seq}`} title="学生作品" agent={{ id: sub.project_id, version: sub.version_seq }} />
            </div>
            <div className="row" style={{ gap: 4 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className="btn ghost sm" style={{ fontSize: 24, opacity: n <= stars ? 1 : 0.25 }} aria-label={`${n} 只鸭评价`} aria-pressed={stars === n} onClick={() => setStars(n)}>
                  <Avatar value="🦆" size={28} />
                </button>
              ))}
            </div>
            <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="写一句鼓励或建议" />
            {note}
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setOpen(false)}>
                关闭
              </button>
              <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/api/submissions/${sub.id}/grade`, 'POST', { stars, comment, redo: true }), '已请学生再改改')}>
                请他再改改
              </button>
              <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/submissions/${sub.id}/grade`, 'POST', { stars, comment }), '评价已发送')}>
                给出评价
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

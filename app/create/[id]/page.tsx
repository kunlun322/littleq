'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { Duck } from '@/components/Duck';
import { Icon } from '@/components/Icon';
import { Illustration } from '@/components/Illustration';
import { VIS_LABEL, WORK_TYPES, withShim } from '@/lib/constants';
import { api } from '@/lib/client';
import { useAgentBridge } from '@/components/useAgentBridge';

type Msg = { id: string; role: 'user' | 'assistant'; content: string; version_seq?: number | null; pending?: boolean; error?: boolean };
type Ver = { seq: number; note: string; created_at: string };
type Proj = {
  id: string;
  title: string;
  work_type: keyof typeof WORK_TYPES;
  description: string;
  html: string;
  version_seq: number;
  slug: string | null;
  visibility: keyof typeof VIS_LABEL;
  published_at: string | null;
};

const QUICK = ['给我个惊喜', '让它动起来', '更好看一点', '加个声音', '我卡住了', '帮我检查一下'];

/** 流式回复里，代码块之前的文字给孩子看；代码只显示“写了多少行” */
function visible(raw: string) {
  const i = raw.indexOf('```');
  if (i < 0) return { text: raw, lines: 0, coding: false };
  const code = raw.slice(i);
  return { text: raw.slice(0, i).trim(), lines: code.split('\n').length - 1, coding: true };
}

export default function Workspace() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const [p, setP] = useState<Proj | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [vers, setVers] = useState<Ver[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'preview' | 'phone' | 'code'>('preview');
  const [mobilePanel, setMobilePanel] = useState<'chat' | 'canvas'>('chat');
  const [runErr, setRunErr] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [showPub, setShowPub] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const msgsEnd = useRef<HTMLDivElement>(null);
  const autoSent = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api<{ project: Proj; messages: Msg[]; versions: Ver[] }>(`/api/projects/${id}`, 'GET');
      setP(d.project);
      setMsgs(d.messages);
      setVers(d.versions);
      return d;
    } catch (e: any) {
      setLoadErr(e.message);
    }
  }, [id]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      setBusy(true);
      setInput('');
      setRunErr('');
      const tmp = 'tmp' + Date.now();
      setMsgs((m) => [...m, { id: tmp + 'u', role: 'user', content: message }, { id: tmp, role: 'assistant', content: '', pending: true }]);
      let raw = '';
      let ctrl: any = null;
      try {
        const r = await fetch(`/api/projects/${id}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        if (!r.ok || !r.body) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || 'Little Q 走神了，再说一次吧');
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += dec.decode(value, { stream: true });
          const z = raw.indexOf('\u0000');
          const shown = z >= 0 ? raw.slice(0, z) : raw;
          setMsgs((m) => m.map((x) => (x.id === tmp ? { ...x, content: shown } : x)));
        }
        const z = raw.indexOf('\u0000');
        if (z >= 0) ctrl = JSON.parse(raw.slice(z + 1));
        if (ctrl?.error) throw new Error('Little Q 刚才走神了，再说一次试试？');
      } catch (e: any) {
        setMsgs((m) => m.map((x) => (x.id === tmp ? { ...x, content: e.message, pending: false, error: true } : x)));
        setBusy(false);
        return;
      }
      await load();
      setBusy(false);
    },
    [busy, id, load],
  );

  useEffect(() => {
    load().then((d) => {
      const prompt = search.get('prompt');
      if (d && prompt && !autoSent.current && d.messages.length === 0) {
        autoSent.current = true;
        router.replace(`/create/${id}`);
        send(prompt);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    msgsEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, mobilePanel]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && e.data?.lqError) setRunErr(String(e.data.lqError));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // 智能体作品：预览里的 LittleQ.chat 接到 QCA
  useAgentBridge(frame, { id });

  async function rename() {
    if (!p) return;
    const t = prompt('给作品起个新名字：', p.title);
    if (!t?.trim()) return;
    await api(`/api/projects/${id}`, 'PATCH', { title: t.trim() });
    load();
  }

  async function remove() {
    if (!p) return;
    const warn = p.published_at ? '它已经发布了，删除后链接会打不开，也会从作品广场消失。\n' : '';
    if (!confirm(`确定删除《${p.title}》吗？\n${warn}作品、所有版本和对话都会被删掉，不能恢复。`)) return;
    await api(`/api/projects/${id}`, 'DELETE');
    router.replace('/projects');
    router.refresh();
  }

  async function rollback(seq: number) {
    if (!confirm(`回到第 ${seq} 版？（现在的版本也会保留，不怕丢）`)) return;
    await api(`/api/projects/${id}/rollback`, 'POST', { seq });
    setRunErr('');
    load();
  }

  if (loadErr)
    return (
      <main className="page container center">
        <Illustration name="sleep" size={100} />
        <h2>{loadErr}</h2>
        <Link href="/projects" className="btn primary">
          回到我的作品
        </Link>
      </main>
    );
  if (!p) return <main className="page container center muted">Little Q 正在打开作品…</main>;

  const t = WORK_TYPES[p.work_type];
  return (
    <main className="ws" data-mobile-panel={mobilePanel}>
      <div className="ws-mobile-switch" role="group" aria-label="创作面板">
        <button type="button" className={`btn ${mobilePanel === 'chat' ? 'primary' : 'ghost'}`} aria-pressed={mobilePanel === 'chat'} onClick={() => setMobilePanel('chat')}>和小黄鸭聊聊</button>
        <button type="button" className={`btn ${mobilePanel === 'canvas' ? 'primary' : 'ghost'}`} aria-pressed={mobilePanel === 'canvas'} onClick={() => setMobilePanel('canvas')}>看看作品</button>
      </div>
      <aside className="ws-tools" aria-label="快捷创作工具">
        <Duck size={40} />
        <button type="button" aria-label="作品预览" title="作品预览" onClick={() => { setView('preview'); setMobilePanel('canvas'); }}><Icon name="play" /></button>
        <button type="button" aria-label="手机预览" title="手机预览" onClick={() => { setView('phone'); setMobilePanel('canvas'); }}><Icon name="mobile" /></button>
        <button type="button" aria-label="查看代码" title="查看代码" onClick={() => { setView('code'); setMobilePanel('canvas'); }}><Icon name="code" /></button>
        <span className="spacer" />
        <Link href="/projects" aria-label="返回我的作品" title="返回我的作品"><Icon name="back" /></Link>
      </aside>
      <section className="ws-chat">
        <div className="ws-top">
          <Link href="/projects" className="btn ghost sm" aria-label="返回我的作品">
            <Icon name="back" />
          </Link>
          <span className="ws-title" title="点击改名" onClick={rename}>
            <Illustration name={t.icon} size={28} /> {p.title} <Icon name="edit" />
          </span>
          <button type="button" className="btn danger sm ws-delete" onClick={remove} title="删除这个作品">
            <Icon name="trash" /> 删除
          </button>
        </div>
        <div className="msgs">
          {msgs.length === 0 && (
            <div className="msg assistant">
              <span className="ava"><Duck size={32} /></span>
              <div className="bubble">
                你好呀！我是 Little Q。想做一个什么样的{t.label}？说给我听听吧～
              </div>
            </div>
          )}
          {msgs.map((m) => {
            const v = m.role === 'assistant' ? visible(m.content) : { text: m.content, lines: 0, coding: false };
            return (
              <div key={m.id} className={`msg ${m.role}`}>
                <span className="ava">{m.role === 'assistant' ? <Duck size={32} /> : <Icon name="user" label="你" size={28} />}</span>
                <div className="bubble">
                  {v.text && <div style={{ whiteSpace: 'pre-wrap' }}>{m.error && <><Icon name="info" /> </>}{v.text}</div>}
                  {m.pending && !v.text && !v.coding && <div className="working">Little Q 在想… <Icon name="thinking" /></div>}
                  {m.pending && v.coding && <div className="working"><Icon name="tools" /> Little Q 正在动手做… 已写 {v.lines} 行</div>}
                  {m.version_seq ? <span className="vtag"><Icon name="check" /> 第 {m.version_seq} 版</span> : null}
                </div>
              </div>
            );
          })}
          <div ref={msgsEnd} />
        </div>
        <div className="quick">
          {QUICK.map((q) => (
            <button key={q} disabled={busy} onClick={() => send(q)}>
              {q}
            </button>
          ))}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={busy ? 'Little Q 正在忙…' : '告诉 Little Q 你的想法，回车发送'}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <button className="btn primary" disabled={busy || !input.trim()}>
            <Icon name="send" /> 发送
          </button>
        </form>
      </section>

      <section className="ws-main">
        <div className="ws-bar">
          <div className="tabs">
            {(
              [
                ['preview', '预览', 'play'],
                ['phone', '手机', 'mobile'],
                ['code', '代码', 'code'],
              ] as const
            ).map(([k, l, icon]) => (
              <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>
                <Icon name={icon} /> {l}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            {p.html && (
              <button className="btn ghost sm" onClick={() => setReloadKey((k) => k + 1)} title="重新运行" aria-label="重新运行">
                <Icon name="refresh" />
              </button>
            )}
            {vers.length > 1 && (
              <select className="input" style={{ width: 'auto', padding: '6px 10px' }} value="" onChange={(e) => e.target.value && rollback(Number(e.target.value))}>
                <option value="">第 {p.version_seq} 版 · 历史</option>
                {vers
                  .filter((v) => v.seq !== p.version_seq)
                  .map((v) => (
                    <option key={v.seq} value={v.seq}>
                      回到第 {v.seq} 版：{v.note}
                    </option>
                  ))}
              </select>
            )}
            <button className="btn primary sm" disabled={!p.html} onClick={() => setShowPub(true)}>
              {p.published_at ? <><Icon name="share" /> 分享</> : <><Illustration name="publish" size={22} /> 发布</>}
            </button>
          </div>
        </div>
        {runErr && (
          <div className="errbar">
            <span><Icon name="bug" /> 作品运行时遇到一个小问题：{runErr}</span>
            <button className="btn sm primary" disabled={busy} onClick={() => send(`作品运行时报了这个问题，帮我修一下：${runErr}`)}>
              让 Little Q 修一下
            </button>
          </div>
        )}
        {!p.html ? (
          <div className="empty-stage">
            <Duck size={140} mood={busy ? 'think' : 'happy'} className={busy ? 'duck-wiggle' : 'duck-bob'} />
            <p className="muted">{busy ? 'Little Q 正在努力做，一般半分钟到两分钟就好～' : '作品会出现在这里'}</p>
          </div>
        ) : view === 'code' ? (
          <pre className="code">{p.html}</pre>
        ) : (
          <div className={`stage ${view === 'phone' ? 'phone' : ''}`}>
            <iframe
              key={`${p.version_seq}-${reloadKey}`}
              ref={frame}
              srcDoc={withShim(p.html)}
              sandbox="allow-scripts allow-modals allow-pointer-lock"
              title={p.title}
            />
          </div>
        )}
      </section>
      {showPub && <PublishModal p={p} onClose={() => setShowPub(false)} onDone={load} />}
    </main>
  );
}

function PublishModal({ p, onClose, onDone }: { p: Proj; onClose: () => void; onDone: () => void }) {
  const [vis, setVis] = useState<keyof typeof VIS_LABEL>(p.published_at ? p.visibility : 'public');
  const [title, setTitle] = useState(p.title);
  const [desc, setDesc] = useState(p.description || '');
  const [url, setUrl] = useState(p.published_at && p.slug ? `${location.origin}/w/${p.slug}` : '');
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (url) QRCode.toDataURL(url, { margin: 1, width: 200 }).then(setQr);
  }, [url]);

  async function publish() {
    setBusy(true);
    setErr('');
    try {
      const d = await api<{ path: string }>(`/api/projects/${p.id}/publish`, 'POST', { visibility: vis, title, description: desc });
      setUrl(location.origin + d.path);
      onDone();
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy(false);
  }
  async function unpublish() {
    if (!confirm('把作品收起来？链接会暂时打不开。')) return;
    await api(`/api/projects/${p.id}/publish`, 'DELETE');
    setUrl('');
    onDone();
    onClose();
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0 }}><Illustration name="publish" size={40} /> 发布作品</h2>
        <label>作品名</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} />
        <label>一句话介绍（可选）</label>
        <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="怎么玩？有什么好玩的？" />
        <label>谁能看</label>
        <div className="stack" style={{ gap: 6 }}>
          {(Object.keys(VIS_LABEL) as (keyof typeof VIS_LABEL)[]).map((k) => (
            <label key={k} className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="radio" checked={vis === k} onChange={() => setVis(k)} /> {VIS_LABEL[k]}
            </label>
          ))}
        </div>
        {err && <div className="notice err">{err}</div>}
        <button className="btn primary lg" disabled={busy} onClick={publish}>
          {busy ? '发布中…' : url ? '更新发布' : '一键发布'}
        </button>
        {url && (
          <div className="notice ok stack center">
            <div><Illustration name="party" size={32} /> 发布成功！把链接或二维码发给朋友吧</div>
            {qr && <img src={qr} alt="作品二维码" width={160} height={160} style={{ margin: '0 auto' }} />}
            <div className="row" style={{ gap: 8 }}>
              <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} />
              <button
                className="btn sm"
                onClick={() => {
                  navigator.clipboard?.writeText(url).then(() => setCopied(true));
                }}
              >
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
              <a href={url} target="_blank" className="btn ghost sm">
                打开看看
              </a>
              <button className="btn danger sm" onClick={unpublish}>
                收起作品
              </button>
            </div>
          </div>
        )}
        <button className="btn ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

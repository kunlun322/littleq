'use client';
import { useEffect, type RefObject } from 'react';

type Target = { id: string; bySlug?: boolean; version?: number | null };

function newChatId() {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * 把作品 iframe 里的 LittleQ.chat / LittleQ.reset 接到 /api/agent/{id}。
 * 作品运行在没有同源权限的沙箱里，只能通过 postMessage 找外层页面帮忙说话。
 * 每个 iframe 窗口（重新运行 = 新窗口）是一段新对话。
 */
export function useAgentBridge(frame: RefObject<HTMLIFrameElement | null>, target: Target) {
  const { id, bySlug, version } = target;
  useEffect(() => {
    const chats = new WeakMap<Window, string>();
    const inflight = new Set<AbortController>();
    const url = `/api/agent/${encodeURIComponent(id)}${bySlug ? '?s=1' : ''}`;

    const onMsg = async (e: MessageEvent) => {
      const w = frame.current?.contentWindow;
      if (!w || e.source !== w) return;
      const m = e.data?.lqAgent;
      if (!m || typeof m.id !== 'string') return;
      const reply = (r: Record<string, unknown>) => {
        try {
          w.postMessage({ lqAgentReply: { id: m.id, ...r } }, '*');
        } catch {}
      };
      let chat = chats.get(w);
      if (!chat) chats.set(w, (chat = newChatId()));
      const post = (body: Record<string, unknown>, signal?: AbortSignal) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat, v: version ?? undefined, ...body }),
          signal,
        });

      if (m.op === 'reset') {
        chats.set(w, newChatId());
        post({ reset: true }).catch(() => {});
        reply({ done: true, text: '' });
        return;
      }
      if (m.op !== 'chat') return;

      const ctrl = new AbortController();
      inflight.add(ctrl);
      let raw = '';
      let sent = 0;
      try {
        const r = await post({ text: String(m.text || '') }, ctrl.signal);
        if (!r.ok || !r.body) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || 'AI 角色暂时没有回应，再试一次吧');
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += dec.decode(value, { stream: true });
          const z = raw.indexOf('\u0000');
          const shown = z >= 0 ? raw.slice(0, z) : raw;
          if (shown.length > sent) {
            reply({ delta: shown.slice(sent) });
            sent = shown.length;
          }
        }
        const z = raw.indexOf('\u0000');
        const ctl = z >= 0 ? JSON.parse(raw.slice(z + 1) || '{}') : { error: '连接断开了，再试一次吧' };
        const text = z >= 0 ? raw.slice(0, z) : raw;
        reply(ctl.error ? { done: true, error: ctl.error } : { done: true, text });
      } catch (err: any) {
        if (!ctrl.signal.aborted) reply({ done: true, error: String(err?.message || err) });
      } finally {
        inflight.delete(ctrl);
      }
    };

    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      inflight.forEach((c) => c.abort());
    };
  }, [frame, id, bySlug, version]);
}

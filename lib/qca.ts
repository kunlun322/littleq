/**
 * QCA（Qoder Cloud Agents）Forward API 客户端 —— 只在服务端使用。
 *
 * LittleQ 自己管理在 QCA 上用到的资源，全部按需创建（先按名字找）、幂等，结果按 Key 分开记在 qca_refs 表里（规则见 docs/RULES.md）：
 *   Environment  littleq-runtime（或用 QCA_ENVIRONMENT_ID 指定已有的）
 *   Template     “创作伙伴”一个；每个“智能体作品”按人设内容各一个
 *   Identity     每个孩子一个（littleq:<userId>），访客共用 littleq:guest
 *   Session      创作：每个作品一个长期会话；智能体作品：每个观众一个会话
 *
 * 一轮对话 = 先打开 SSE 流，再发 user.message，读到本轮结束事件为止（流不重放历史）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { q, q1 } from './db';

export const QCA_BASE_URL = (process.env.QCA_BASE_URL || 'https://api.qoder.com/api/v1/forward').replace(/\/+$/, '');
/** 创作伙伴（写代码）用的模型 */
export const QCA_MODEL = process.env.QCA_MODEL || 'qmodel_38max';
/** 智能体作品（陪孩子聊天）用的模型，要快 */
export const QCA_AGENT_MODEL = process.env.QCA_AGENT_MODEL || 'qfmodel';

export function qcaKey() {
  return (process.env.QODER_API_KEY || process.env.QCA_API_KEY || '').trim();
}

/** 创作用哪个后端：显式 AI_PROVIDER 优先；否则配了 QCA 密钥就用 QCA */
export function aiProvider(): 'qca' | 'bailian' {
  const p = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (p === 'qca' || p === 'bailian') return p;
  return qcaKey() ? 'qca' : 'bailian';
}

export class QcaError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'QcaError';
    this.status = status;
  }
}

export function shortHash(...parts: string[]) {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\u0001');
  return h.digest('hex').slice(0, 8);
}

// ─── HTTP ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function headers(extra: Record<string, string> = {}) {
  const key = qcaKey();
  if (!key) throw new QcaError(500, 'QODER_API_KEY 没有配置');
  return { Authorization: `Bearer ${key}`, Accept: 'application/json', ...extra };
}

/**
 * 调用 Forward API。GET 和带 Idempotency-Key 的 POST 遇到网络错误/429/5xx 自动重试；
 * 重试时复用同一个 Idempotency-Key，保证不会重复创建。
 */
export async function call<T = any>(method: string, path: string, body?: unknown, opts: { idempotent?: boolean } = {}): Promise<T> {
  const h: Record<string, string> = headers();
  let payload: string | undefined;
  if (method !== 'GET') {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
    if (opts.idempotent) h['Idempotency-Key'] = `lq-${randomUUID()}`;
  }
  const retry = method === 'GET' || !!opts.idempotent;
  const attempts = retry ? 3 : 1;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(300 * 2 ** (i - 1) + Math.random() * 300);
    let res: Response;
    try {
      res = await fetch(QCA_BASE_URL + path, { method, headers: h, body: payload });
    } catch (e) {
      last = e;
      continue;
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data as T;
    const msg = data?.error?.message || data?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    const err = new QcaError(res.status, `QCA ${method} ${path.split('?')[0]} → ${res.status}: ${msg}`);
    if (retry && RETRYABLE.has(res.status) && i < attempts - 1) {
      last = err;
      continue;
    }
    throw err;
  }
  if (last instanceof QcaError) throw last;
  throw new QcaError(502, `QCA 连不上：${String((last as any)?.message || last)}`);
}

/** 翻页列出全部（最多 maxPages 页） */
async function listAll<T extends { id: string }>(path: string, query: Record<string, string> = {}, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let after = '';
  for (let i = 0; i < maxPages; i++) {
    const qs = new URLSearchParams({ limit: '100', ...query });
    if (after) qs.set('after_id', after);
    const page = await call<{ data?: T[]; has_more?: boolean; last_id?: string }>('GET', `${path}?${qs}`);
    const rows = page?.data || [];
    out.push(...rows);
    if (!page?.has_more || !rows.length) break;
    after = page.last_id || rows[rows.length - 1].id;
  }
  return out;
}

// ─── 资源记账：qca_refs 表 + 进程内缓存 + 同 key 只跑一次 ──────────────

const g = globalThis as unknown as { __lqQca?: { cache: Map<string, string>; inflight: Map<string, Promise<string>> } };
const memo = (g.__lqQca ??= { cache: new Map(), inflight: new Map() });

/** 资源 ID 只在创建它的 QCA 账号里有效：记账按 Key 指纹分开，换 Key 后自动重新找/建 */
function scoped(key: string) {
  return `${key}@${shortHash(QCA_BASE_URL, qcaKey())}`;
}

async function remember(baseKey: string, make: () => Promise<string>): Promise<string> {
  const key = scoped(baseKey);
  const hit = memo.cache.get(key);
  if (hit) return hit;
  const running = memo.inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const row = await q1<{ value: string }>(`select value from qca_refs where key = $1`, [key]);
    if (row) return row.value;
    const value = await make();
    await q(`insert into qca_refs(key, value) values ($1,$2) on conflict (key) do update set value = excluded.value`, [key, value]);
    return value;
  })()
    .then((v) => {
      memo.cache.set(key, v);
      return v;
    })
    .finally(() => memo.inflight.delete(key));
  memo.inflight.set(key, p);
  return p;
}

/** 远端资源失效（被手动删除/归档）时忘掉它，下次重新创建 */
export async function forget(key: string) {
  memo.cache.delete(key);
  await q(`delete from qca_refs where key = $1`, [key]);
}

// ─── Environment / Template / Identity ──────────────────────────────

const ENV_NAME = 'littleq-runtime';

export async function ensureEnvironment(): Promise<string> {
  const fixed = (process.env.QCA_ENVIRONMENT_ID || '').trim();
  if (fixed) return fixed;
  return remember(`env:${ENV_NAME}`, async () => {
    const all = await listAll<{ id: string; name?: string; archived_at?: string | null }>('/environments');
    const found = all.find((e) => e.name === ENV_NAME && !e.archived_at);
    if (found) return found.id;
    const env = await call<{ id: string }>(
      'POST',
      '/environments',
      { name: ENV_NAME, description: 'LittleQ 智能体运行环境（创作伙伴与孩子做的智能体作品共用；纯对话，不用工具）', config: { type: 'cloud' } },
      { idempotent: true },
    );
    return env.id;
  });
}

export type TemplateSpec = {
  /** 租户内唯一；内容变了要换名字（我们用内容哈希做后缀） */
  name: string;
  system: string;
  model: string;
  description?: string;
  metadata?: Record<string, string>;
};

/** 按 key 找或建一个 Template（先按名字找，QCA 不拒绝同名模板）。tools 为空：纯对话智能体，不起沙箱、响应快 */
export async function ensureTemplate(key: string, spec: TemplateSpec): Promise<string> {
  return remember(`tpl:${key}`, async () => {
    const findByName = async () =>
      (await listAll<{ id: string; name: string }>('/templates', { status: 'active' })).find((t) => t.name === spec.name)?.id;
    const existing = await findByName();
    if (existing) return existing;
    const environment_id = await ensureEnvironment();
    try {
      const t = await call<{ id: string }>(
        'POST',
        '/templates',
        {
          name: spec.name,
          description: spec.description || '',
          model: spec.model,
          environment_id,
          system: spec.system,
          tools: [],
          metadata: { created_by: 'littleq', ...(spec.metadata || {}) },
        },
        { idempotent: true },
      );
      return t.id;
    } catch (e) {
      if (!(e instanceof QcaError) || e.status !== 409) throw e;
      const found = await findByName();
      if (!found) throw e;
      return found;
    }
  });
}

export async function ensureIdentity(externalId: string, name: string): Promise<string> {
  return remember(`idn:${externalId}`, async () => {
    const find = async () => {
      const page = await call<{ data?: { id: string; external_id: string }[] }>(
        'GET',
        `/identities?${new URLSearchParams({ external_id: externalId, limit: '20' })}`,
      );
      return (page?.data || []).find((x) => x.external_id === externalId)?.id;
    };
    const existing = await find();
    if (existing) return existing;
    try {
      const idn = await call<{ id: string }>('POST', '/identities', {
        external_id: externalId,
        name: name.slice(0, 60) || externalId,
        enabled: true,
        metadata: { created_by: 'littleq' },
      });
      return idn.id;
    } catch (e) {
      if (e instanceof QcaError && e.status === 409) {
        const again = await find();
        if (again) return again;
      }
      throw e;
    }
  });
}

// ─── Session ────────────────────────────────────────────────────────

export async function createSession(identityId: string, templateId: string, title: string, metadata: Record<string, string> = {}) {
  const s = await call<{ id: string }>(
    'POST',
    '/sessions',
    { identity_id: identityId, template_id: templateId, title: title.slice(0, 100), metadata: { created_by: 'littleq', ...metadata } },
    { idempotent: true },
  );
  return s.id;
}

export async function archiveSession(sessionId: string) {
  await call('POST', `/sessions/${encodeURIComponent(sessionId)}/archive`).catch(() => undefined);
}

/** 会话已不可用（被删/归档/模板失效）——调用方应新建会话再试 */
export function isGone(e: unknown) {
  return e instanceof QcaError && [404, 409, 410].includes(e.status);
}

type FwdEvent = {
  id?: string;
  type: string;
  content?: unknown;
  delta?: { content?: { text?: string }; text?: string };
  stop_reason?: { type?: string } | null;
  error?: any;
  [k: string]: unknown;
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('');
}

const ERROR_TYPES = new Set(['session.error', 'session.status_error', 'session.status_terminated', 'session.cancelled', 'session.canceled']);

function isTerminal(e: FwdEvent) {
  if (ERROR_TYPES.has(e.type) || e.type === 'session.completed' || e.type === 'session.thread_status_idle') return true;
  if (e.type === 'session.status_idle') return e.stop_reason?.type !== 'requires_action';
  return false;
}

function parseFrame(frame: string): FwdEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * 在会话里跑一轮：发一句话，边生成边回调 onDelta，返回本轮完整回复。
 * - 先开流再发送（流只推实时事件，不重放历史）；
 * - 只在看到本轮 user.message 回显之后才收文字和结束事件，避免串到上一轮的尾巴。
 */
export async function runTurn(
  sessionId: string,
  text: string,
  opts: { onDelta?: (t: string) => void; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const { onDelta = () => {}, timeoutMs = 280_000, signal } = opts;
  const sid = encodeURIComponent(sessionId);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let sendErr: unknown = null;
  try {
    const res = await fetch(`${QCA_BASE_URL}/sessions/${sid}/events/stream?event_deltas[]=agent.message`, {
      headers: headers({ Accept: 'text/event-stream' }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      throw new QcaError(res.status, `QCA 事件流打不开 ${res.status}: ${t.slice(0, 200)}`);
    }

    let sentId: string | null = null;
    call<{ data?: { id?: string }[] }>(
      'POST',
      `/sessions/${sid}/events`,
      { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] },
      { idempotent: true },
    ).then(
      (r) => {
        sentId = r?.data?.[0]?.id || '*';
      },
      (e) => {
        sendErr = e;
        ctrl.abort();
      },
    );

    let armed = false;
    let firstEcho: string | null = null;
    let cur = ''; // 当前这条 agent.message 已经流出去的部分
    const finals: string[] = [];
    let streamed = '';

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finished = false;
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() ?? '';
      for (const f of frames) {
        const e = parseFrame(f);
        if (!e) continue;
        if (!armed && e.type === 'user.message') {
          // 正常情况下我们是这个会话唯一的发送方：回显的第一条就是本轮；拿到 id 后再精确比对
          if (sentId && sentId !== '*' ? e.id === sentId : !firstEcho) armed = true;
          firstEcho ??= e.id || '?';
          continue;
        }
        if (!armed) continue;
        if (e.type === 'event_delta') {
          const t = e.delta?.content?.text ?? e.delta?.text ?? '';
          if (t) {
            cur += t;
            streamed += t;
            onDelta(t);
          }
        } else if (e.type === 'agent.message') {
          const full = textOf(e.content);
          // 没收到增量（或只收到一部分）时，把缺的补发出去
          if (full.startsWith(cur) && full.length > cur.length) {
            const rest = full.slice(cur.length);
            streamed += rest;
            onDelta(rest);
          }
          if (full) finals.push(full);
          cur = '';
        } else if (isTerminal(e)) {
          if (ERROR_TYPES.has(e.type)) {
            const msg = e.error?.message || (typeof e.error === 'string' ? e.error : '') || e.type;
            throw new QcaError(502, `QCA 会话出错：${msg}`);
          }
          finished = true;
          break;
        }
      }
    }
    await reader.cancel().catch(() => undefined);
    if (sendErr) throw sendErr;
    const out = finals.length ? finals.join('\n\n') : streamed;
    if (!out.trim()) throw new QcaError(502, finished ? 'QCA 这一轮没有回复内容' : 'QCA 事件流提前断开了');
    return out;
  } catch (e) {
    if (sendErr) throw sendErr;
    if (timedOut) throw new QcaError(504, '想得太久了，换个说法再试试');
    if (signal?.aborted) throw new QcaError(499, '对话被中断了');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

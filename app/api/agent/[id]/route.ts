import { q, q1 } from '@/lib/db';
import { bad, currentUser } from '@/lib/auth';
import { canView } from '@/lib/projects';
import { extractAgentSpec } from '@/lib/agentSpec';
import { AGENT_LIMITS, workChatSession, workTemplate } from '@/lib/agents';
import { archiveSession, isGone, qcaKey, runTurn, shortHash } from '@/lib/qca';

export const dynamic = 'force-dynamic';
export const maxDuration = 150;

type Ctx = { params: Promise<{ id: string }> };

/**
 * 智能体作品里的 AI 角色说话（作品里调用 LittleQ.chat → 外层页面转发到这里）。
 *   POST /api/agent/{projectId}           { text, chat, v? }    当前版本 / 第 v 版
 *   POST /api/agent/{slug}?s=1            { text, chat }        公开链接
 *   POST ...                              { reset: true, chat } 结束这段对话
 * chat 是观众这一侧的对话编号（每次打开作品随机生成）；同一个人 + 同一作品 + 同一 chat = 一个 QCA 会话。
 * 返回纯文本流，末尾追加 \u0000{"done":true,"error":...}
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const bySlug = new URL(req.url).searchParams.get('s') === '1';
  const b = await req.json().catch(() => ({}));
  const chat = String(b.chat || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(chat)) return bad('对话编号不对');

  const p = await q1<any>(
    `select id, owner_id, title, visibility, published_at, html from projects where ${bySlug ? 'slug' : 'id'} = $1`,
    [id],
  );
  const user = await currentUser();
  if (!p || !(await canView(p, user))) return bad('没找到这个作品', 404);

  const rowId = `${shortHash(p.id, user?.id || 'guest', chat)}${shortHash(chat, p.id)}`;
  const row = await q1<{ id: string; template_id: string; forward_session_id: string; turns: number }>(
    `select id, template_id, forward_session_id, turns from agent_chats where id = $1`,
    [rowId],
  );

  if (b.reset) {
    if (row) {
      void archiveSession(row.forward_session_id);
      await q(`delete from agent_chats where id = $1`, [rowId]);
    }
    return Response.json({ ok: true });
  }

  if (!qcaKey()) return bad('平台还没有接通 AI 角色服务（缺少 QODER_API_KEY）', 503);
  const text = String(b.text || '').trim().slice(0, AGENT_LIMITS.textChars);
  if (!text) return bad('说点什么吧～');

  let html: string | null = p.html;
  if (b.v != null && b.v !== '') {
    const v = await q1<{ html: string }>(`select html from versions where project_id=$1 and seq=$2`, [p.id, Number(b.v)]);
    html = v?.html ?? null;
  }
  const spec = extractAgentSpec(html);
  if (!spec) return bad('这个作品里还没有 AI 角色', 400);

  if (row && row.turns >= AGENT_LIMITS.turnsPerChat) return bad('我们聊了好多啦，点“重新开始”换个新话题吧～', 429);
  const today = await q1<{ n: number }>(
    `select coalesce(sum(turns),0)::int as n from agent_chats where project_id = $1 and updated_at > now() - interval '1 day'`,
    [p.id],
  );
  if ((today?.n ?? 0) >= AGENT_LIMITS.turnsPerProjectPerDay) return bad('这个 AI 角色今天聊累了，明天再来吧～', 429);

  let tpl: string;
  let chatRow: { id: string; template_id: string; forward_session_id: string; turns: number };
  try {
    tpl = await workTemplate(p.id, spec);
    chatRow = await workChatSession(rowId, p.id, p.title, user, tpl, row);
  } catch (e: any) {
    console.error('[agent] setup', e?.message || e);
    return bad('AI 角色暂时叫不醒，等一下再试试', 502);
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const push = (s: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          open = false;
        }
      };
      let error: string | null = null;
      let emitted = false;
      const relay = (t: string) => {
        emitted = true;
        push(t);
      };
      try {
        try {
          await runTurn(chatRow.forward_session_id, text, { onDelta: relay, timeoutMs: 120_000, signal: req.signal });
        } catch (e) {
          if (!isGone(e) || emitted) throw e;
          // 会话在 QCA 那边没了：换一个新会话重来
          chatRow = await workChatSession(rowId, p.id, p.title, user, tpl, chatRow, true);
          await runTurn(chatRow.forward_session_id, text, { onDelta: relay, timeoutMs: 120_000, signal: req.signal });
        }
        await q(`update agent_chats set turns = turns + 1, updated_at = now() where id = $1`, [rowId]);
      } catch (e: any) {
        console.error('[agent]', e?.message || e);
        error = 'AI 角色刚才走神了，再说一次试试？';
      }
      push(`\u0000${JSON.stringify({ done: true, error })}`);
      if (open) {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
  });
}

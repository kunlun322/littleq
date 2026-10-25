import { q } from '@/lib/db';
import { bad, requireUser, rid } from '@/lib/auth';
import { ownProject } from '@/lib/projects';
import { splitReply, streamChat, systemPrompt, turnHints, type ChatMsg } from '@/lib/ai';
import { aiProvider } from '@/lib/qca';
import { creatorTurn, workTemplate } from '@/lib/agents';
import { extractAgentSpec } from '@/lib/agentSpec';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Vercel：允许长时间流式生成

type Ctx = { params: Promise<{ id: string }> };

/**
 * 孩子说一句话 → 流式返回 Little Q 的回复（纯文本流）。
 * 默认由 QCA 云端智能体完成（每个作品一个长期会话）；AI_PROVIDER=bailian 时直连百炼。
 * 生成结束后：有新代码就存一个新版本，并把对话写进数据库。
 * 流末尾追加一行控制信息：\n\u0000{"done":true,"version":N}
 */
export async function POST(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const p = await ownProject(id, u);
  if (!p) return bad('没找到这个作品', 404);
  const b = await req.json().catch(() => ({}));
  const message = String(b.message || '').trim().slice(0, 2000);
  if (!message) return bad('说点什么吧～');

  const history = await q<{ role: string; content: string }>(
    `select role, content from messages where project_id = $1 order by created_at desc limit 8`,
    [id],
  );
  history.reverse();
  await q(`insert into messages(id, project_id, role, content) values ($1,$2,'user',$3)`, [rid(), id, message]);

  const provider = aiProvider();
  const codeBlock = () => `当前作品的完整代码（第 ${p.version_seq} 版）：\n\`\`\`html\n${p.html}\n\`\`\``;

  /** QCA：会话本身记得之前的对话，只需告诉它本轮信息；代码没变就不重复发 */
  const qcaMessage = (fresh: boolean) => {
    const parts = ['【本轮信息】', turnHints(u.age_band, p.work_type), `作品名：《${p.title}》`];
    if (!p.html) parts.push('当前代码：还没有，这是第一次创作。');
    else if (!fresh && p.agent_seen_seq === p.version_seq) parts.push(`当前代码：就是你上一次看到的第 ${p.version_seq} 版，没有变化。`);
    else parts.push(codeBlock());
    if (fresh && history.length) {
      parts.push(
        '之前的对话（供参考）：\n' +
          history.map((m) => `${m.role === 'user' ? '孩子' : 'Little Q'}：${m.content.slice(0, 400)}`).join('\n'),
      );
    }
    parts.push(`\n孩子说：${message}`);
    return parts.join('\n');
  };

  const enc = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      // 孩子关掉页面也要把这一轮做完、存好版本，所以写流失败只是不再推送
      const push = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      let version: number | null = null;
      let error: string | null = null;
      try {
        let full: string;
        if (provider === 'qca') {
          full = (await creatorTurn(p, u, qcaMessage, push)).text;
        } else {
          const msgs: ChatMsg[] = [{ role: 'system', content: systemPrompt(u.age_band, p.work_type) }];
          for (const m of history) msgs.push({ role: m.role as 'user' | 'assistant', content: m.content });
          msgs.push({
            role: 'user',
            content: `作品名：《${p.title}》\n${p.html ? codeBlock() : '（还没有代码，这是第一次创作）'}\n\n孩子说：${message}`,
          });
          full = await streamChat(msgs, push);
        }
        const { text, html } = splitReply(full);
        if (html) {
          version = p.version_seq + 1;
          const note = message.slice(0, 60);
          await q(`insert into versions(project_id, seq, html, note) values ($1,$2,$3,$4)`, [id, version, html, note]);
          await q(`update projects set html=$2, version_seq=$3, updated_at=now() where id=$1`, [id, html, version]);
          // 作品里有 AI 角色：顺手把它在 QCA 上的 Template 建好，预览时第一句话就不用等
          const spec = extractAgentSpec(html);
          if (spec && provider === 'qca') await workTemplate(id, spec).catch((e) => console.error('[chat] work template', e?.message));
        }
        if (provider === 'qca') {
          // Little Q 记得自己刚写的代码；没出新代码就保持原样
          await q(`update projects set agent_seen_seq=$2 where id=$1`, [id, version ?? p.version_seq]);
        }
        await q(`insert into messages(id, project_id, role, content, version_seq) values ($1,$2,'assistant',$3,$4)`, [
          rid(),
          id,
          text || '（我改好啦，看看右边的作品吧！）',
          version,
        ]);
      } catch (e: any) {
        error = String(e?.message || e);
        console.error('[chat]', provider, error);
      }
      push(`\n\u0000${JSON.stringify({ done: true, version, error })}`);
      if (!closed) {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
  });
}

import { getDb } from '@/lib/db';
import { AI_BASE_URL, AI_MODEL, keyFingerprint } from '@/lib/ai';
import { QCA_AGENT_MODEL, QCA_BASE_URL, QCA_MODEL, aiProvider, ensureEnvironment, qcaKey } from '@/lib/qca';
import { creatorTemplate } from '@/lib/agents';

export const dynamic = 'force-dynamic';

/**
 * 5 分钟线上自检：匿名可访问。
 *  /api/health         数据库连通 + 配置指纹（只回显 sha256 前 8 位，不回显明文）
 *  /api/health?ai=1    额外确认 AI 可用（QCA：准备好环境和创作伙伴模板；百炼：真打一次）
 */
export async function GET(req: Request) {
  const out: any = {
    ok: true,
    app: 'littleq',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || process.env.GIT_COMMIT || 'local',
    runtime: process.env.VERCEL ? 'vercel' : 'node',
    node: process.version,
    time: new Date().toISOString(),
  };
  const t0 = Date.now();
  try {
    const db = await getDb();
    await db.query('select 1');
    const [{ n }] = await db.query('select count(*)::int as n from users');
    out.db = { ok: true, kind: db.kind, ms: Date.now() - t0, users: n, urlFingerprint: keyFingerprint(process.env.DATABASE_URL) };
  } catch (e: any) {
    out.ok = false;
    out.db = { ok: false, error: String(e?.message || e), urlFingerprint: keyFingerprint(process.env.DATABASE_URL) };
  }
  out.ai = { provider: aiProvider(), baseUrl: AI_BASE_URL, model: AI_MODEL, keyFingerprint: keyFingerprint(process.env.AI_API_KEY) };
  out.qca = {
    baseUrl: QCA_BASE_URL,
    creatorModel: QCA_MODEL,
    agentModel: QCA_AGENT_MODEL,
    keyFingerprint: keyFingerprint(qcaKey() || undefined),
  };
  if (new URL(req.url).searchParams.get('ai') && aiProvider() === 'qca') {
    // QCA：确认 PAT 可用，并把环境、创作伙伴模板准备好（幂等，不发起对话、不计费）
    const t1 = Date.now();
    try {
      out.qca.environmentId = await ensureEnvironment();
      out.qca.creatorTemplateId = await creatorTemplate();
      out.qca.ok = true;
      out.qca.ms = Date.now() - t1;
    } catch (e: any) {
      out.ok = false;
      out.qca.ok = false;
      out.qca.error = String(e?.message || e);
    }
  } else if (new URL(req.url).searchParams.get('ai')) {
    const t1 = Date.now();
    try {
      const r = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, enable_thinking: false, max_tokens: 20, messages: [{ role: 'user', content: '说“嘎”' }] }),
      });
      const j: any = await r.json().catch(() => ({}));
      out.ai.ok = r.ok;
      out.ai.status = r.status;
      out.ai.ms = Date.now() - t1;
      out.ai.reply = j?.choices?.[0]?.message?.content ?? j?.error?.message;
      if (!r.ok) out.ok = false;
    } catch (e: any) {
      out.ok = false;
      out.ai.ok = false;
      out.ai.error = String(e?.message || e);
    }
  }
  return Response.json(out, { status: out.ok ? 200 : 503 });
}

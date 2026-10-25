// 纯函数，前后端都能用：从作品 HTML 里读出“智能体作品”的角色设定
//   <script type="application/json" id="littleq-agent">{"name":..,"persona":..,"greeting":..}</script>

export type AgentSpec = { name: string; persona: string; greeting: string };

export function extractAgentSpec(html: string | null | undefined): AgentSpec | null {
  if (!html) return null;
  const m = html.match(/<script\b[^>]*\bid\s*=\s*["']littleq-agent["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1].trim());
    const persona = String(j?.persona ?? '').trim().slice(0, 2000);
    if (!persona) return null;
    return {
      name: String(j?.name ?? '').trim().slice(0, 20) || 'AI 小伙伴',
      persona,
      greeting: String(j?.greeting ?? '').trim().slice(0, 300),
    };
  } catch {
    return null;
  }
}

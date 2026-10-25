import { q1 } from '@/lib/db';
import { bad, checkPassword, startSession } from '@/lib/auth';

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const username = String(b.username || '').trim().toLowerCase();
  const u = await q1<{ id: string; pass_hash: string; role: string }>(
    `select id, pass_hash, role from users where username = $1`,
    [username],
  );
  if (!u || !checkPassword(String(b.password || ''), u.pass_hash)) return bad('用户名或密码不对，再试一次吧', 401);
  await startSession(u.id);
  return Response.json({ ok: true, role: u.role });
}

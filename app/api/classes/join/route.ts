import { q, q1 } from '@/lib/db';
import { bad, requireUser } from '@/lib/auth';

/** 学生用加入码进班 */
export async function POST(req: Request) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const b = await req.json().catch(() => ({}));
  const code = String(b.joinCode || '').trim().toUpperCase();
  const c = await q1<{ id: string; name: string; owner_id: string }>(`select id, name, owner_id from classes where join_code=$1`, [code]);
  if (!c) return bad('没找到这个班级加入码，再核对一下？', 404);
  if (c.owner_id === u.id) return bad('这是你自己建的班级哦');
  await q(`insert into class_members(class_id, user_id) values ($1,$2) on conflict do nothing`, [c.id, u.id]);
  return Response.json({ ok: true, id: c.id, name: c.name });
}

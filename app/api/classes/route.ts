import { q, q1 } from '@/lib/db';
import { bad, requireUser, rid } from '@/lib/auth';

function joinCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/** 老师建班 */
export async function POST(req: Request) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  if (u.role !== 'teacher') return bad('只有老师/家长可以建班级', 403);
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 30);
  if (!name) return bad('给班级起个名字吧');
  const id = rid();
  let code = joinCode();
  while (await q1(`select 1 from classes where join_code=$1`, [code])) code = joinCode();
  await q(`insert into classes(id, owner_id, name, join_code) values ($1,$2,$3,$4)`, [id, u.id, name, code]);
  return Response.json({ id, joinCode: code });
}

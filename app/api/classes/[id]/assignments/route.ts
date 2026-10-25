import { q, q1 } from '@/lib/db';
import { bad, requireUser, rid } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

/** 老师布置任务 */
export async function POST(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const c = await q1(`select 1 from classes where id=$1 and owner_id=$2`, [id, u.id]);
  if (!c) return bad('没找到这个班级', 404);
  const b = await req.json().catch(() => ({}));
  const title = String(b.title || '').trim().slice(0, 60);
  if (!title) return bad('任务要有个标题');
  const description = String(b.description || '').slice(0, 1000);
  const due = b.dueAt ? new Date(b.dueAt) : null;
  const aid = rid();
  await q(`insert into assignments(id, class_id, title, description, due_at) values ($1,$2,$3,$4,$5)`, [
    aid,
    id,
    title,
    description,
    due && !isNaN(+due) ? due.toISOString() : null,
  ]);
  return Response.json({ id: aid });
}

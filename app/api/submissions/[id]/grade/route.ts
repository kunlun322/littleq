import { q, q1 } from '@/lib/db';
import { bad, requireUser } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

/** 老师批改：1-5 只小鸭 + 评语；也可以退回“需要再改改” */
export async function POST(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const s = await q1(
    `select s.id from submissions s join assignments a on a.id=s.assignment_id join classes c on c.id=a.class_id
      where s.id=$1 and c.owner_id=$2`,
    [id, u.id],
  );
  if (!s) return bad('没找到这份作业', 404);
  const b = await req.json().catch(() => ({}));
  const stars = Math.max(1, Math.min(5, Number(b.stars) || 3));
  const status = b.redo ? 'redo' : 'graded';
  await q(`update submissions set stars=$2, comment=$3, status=$4, graded_at=now() where id=$1`, [
    id,
    stars,
    String(b.comment || '').slice(0, 300),
    status,
  ]);
  return Response.json({ ok: true });
}

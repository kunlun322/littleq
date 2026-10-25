import { q, q1 } from '@/lib/db';
import { bad, requireUser } from '@/lib/auth';

type Ctx = { params: Promise<{ slug: string }> };

/** 点赞 / 取消点赞（需要登录） */
export async function POST(_req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { slug } = await params;
  const p = await q1<{ id: string }>(`select id from projects where slug=$1 and published_at is not null`, [slug]);
  if (!p) return bad('作品收起来了', 404);
  const had = await q1(`select 1 from likes where project_id=$1 and user_id=$2`, [p.id, u.id]);
  if (had) await q(`delete from likes where project_id=$1 and user_id=$2`, [p.id, u.id]);
  else await q(`insert into likes(project_id, user_id) values ($1,$2) on conflict do nothing`, [p.id, u.id]);
  const [{ n }] = await q<{ n: number }>(
    `update projects set likes = (select count(*)::int from likes where project_id=$1) where id=$1 returning likes as n`,
    [p.id],
  );
  return Response.json({ liked: !had, likes: n });
}

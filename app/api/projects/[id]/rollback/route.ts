import { q, q1 } from '@/lib/db';
import { bad, requireUser } from '@/lib/auth';
import { ownProject } from '@/lib/projects';

type Ctx = { params: Promise<{ id: string }> };

/** 回到某个版本：复制成一个新版本，所以回退本身也能撤销 */
export async function POST(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const p = await ownProject(id, u);
  if (!p) return bad('没找到这个作品', 404);
  const { seq } = await req.json().catch(() => ({}));
  const v = await q1<{ html: string }>(`select html from versions where project_id=$1 and seq=$2`, [id, Number(seq)]);
  if (!v) return bad('没找到这个版本', 404);
  const next = p.version_seq + 1;
  await q(`insert into versions(project_id, seq, html, note) values ($1,$2,$3,$4)`, [id, next, v.html, `回到第 ${seq} 版`]);
  await q(`update projects set html=$2, version_seq=$3, updated_at=now() where id=$1`, [id, v.html, next]);
  await q(`insert into messages(id, project_id, role, content, version_seq) values (md5(random()::text), $1, 'assistant', $2, $3)`, [
    id,
    `好的，我们回到了第 ${seq} 版。改过的都还留着，随时可以再换回来～`,
    next,
  ]);
  return Response.json({ ok: true, version: next });
}

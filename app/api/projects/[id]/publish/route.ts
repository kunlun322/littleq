import { q, q1 } from '@/lib/db';
import { bad, requireUser, rid } from '@/lib/auth';
import { ownProject } from '@/lib/projects';

type Ctx = { params: Promise<{ id: string }> };

/** 一键发布 / 更新发布。链接 /w/{slug} 不会因为更新而变化。 */
export async function POST(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const p = await ownProject(id, u);
  if (!p) return bad('没找到这个作品', 404);
  if (!p.html) return bad('作品还是空的，先和 Little Q 做点东西吧');
  const b = await req.json().catch(() => ({}));
  const visibility = ['private', 'class', 'public'].includes(b.visibility) ? b.visibility : 'public';
  const title = String(b.title ?? p.title).trim().slice(0, 40) || p.title;
  const description = String(b.description ?? p.description).slice(0, 200);
  let slug = p.slug;
  if (!slug) {
    for (let i = 0; i < 5 && !slug; i++) {
      const s = rid(8);
      if (!(await q1(`select 1 from projects where slug=$1`, [s]))) slug = s;
    }
  }
  await q(
    `update projects set slug=$2, visibility=$3, title=$4, description=$5, published_at=now(), updated_at=now() where id=$1`,
    [id, slug, visibility, title, description],
  );
  return Response.json({ ok: true, slug, path: `/w/${slug}` });
}

/** 收起作品（取消发布） */
export async function DELETE(_req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  await q(`update projects set published_at=null where id=$1 and owner_id=$2`, [id, u.id]);
  return Response.json({ ok: true });
}

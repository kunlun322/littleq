import { q } from '@/lib/db';
import { bad, requireUser, rid } from '@/lib/auth';
import { WORK_TYPES } from '@/lib/projects';

export async function GET() {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const rows = await q(
    `select id, title, work_type, version_seq, slug, visibility, published_at, likes, updated_at
       from projects where owner_id = $1 order by updated_at desc`,
    [u.id],
  );
  return Response.json({ projects: rows });
}

export async function POST(req: Request) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const b = await req.json().catch(() => ({}));
  const type = b.workType in WORK_TYPES ? b.workType : 'GAME';
  const title = String(b.title || '').trim().slice(0, 40) || `我的${WORK_TYPES[type as keyof typeof WORK_TYPES].label}`;
  if (!title) return bad('给作品起个名字吧');
  const id = rid();
  await q(`insert into projects(id, owner_id, title, work_type) values ($1,$2,$3,$4)`, [id, u.id, title, type]);
  return Response.json({ id });
}

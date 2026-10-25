import { q } from '@/lib/db';
import { bad, requireUser } from '@/lib/auth';
import { ownProject } from '@/lib/projects';
import { archiveProjectAgents, collectProjectAgentRefs } from '@/lib/agents';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const p = await ownProject(id, u);
  if (!p) return bad('没找到这个作品', 404);
  const messages = await q(
    `select id, role, content, version_seq, created_at from messages where project_id = $1 order by created_at asc`,
    [id],
  );
  const versions = await q(
    `select seq, note, created_at from versions where project_id = $1 order by seq desc`,
    [id],
  );
  return Response.json({ project: p, messages, versions });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const p = await ownProject(id, u);
  if (!p) return bad('没找到这个作品', 404);
  const b = await req.json().catch(() => ({}));
  const title = b.title != null ? String(b.title).trim().slice(0, 40) || p.title : p.title;
  const description = b.description != null ? String(b.description).slice(0, 200) : p.description;
  await q(`update projects set title=$2, description=$3, updated_at=now() where id=$1`, [id, title, description]);
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const p = await ownProject(id, u);
  if (!p) return Response.json({ ok: true });
  const refs = await collectProjectAgentRefs(id, p.agent_session_id).catch(() => null);
  await q(`delete from projects where id = $1 and owner_id = $2`, [id, u.id]);
  if (refs) await archiveProjectAgents(refs).catch(() => undefined);
  return Response.json({ ok: true });
}

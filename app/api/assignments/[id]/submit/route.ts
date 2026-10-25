import { q, q1 } from '@/lib/db';
import { bad, requireUser, rid } from '@/lib/auth';
import { ownProject } from '@/lib/projects';

type Ctx = { params: Promise<{ id: string }> };

/** 学生交作业：锁定作品当前版本作为快照；可以重复提交覆盖 */
export async function POST(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const a = await q1(
    `select a.id from assignments a join class_members m on m.class_id = a.class_id where a.id=$1 and m.user_id=$2`,
    [id, u.id],
  );
  if (!a) return bad('没找到这个任务', 404);
  const { projectId } = await req.json().catch(() => ({}));
  const p = await ownProject(String(projectId || ''), u);
  if (!p) return bad('选一个你自己的作品交上去吧');
  if (!p.version_seq) return bad('这个作品还是空的哦');
  const row = await q1<{ id: string }>(
    `insert into submissions(id, assignment_id, student_id, project_id, version_seq) values ($1,$2,$3,$4,$5)
     on conflict (assignment_id, student_id) do update
       set project_id=excluded.project_id, version_seq=excluded.version_seq, status='submitted',
           submitted_at=now(), stars=null, comment=null, graded_at=null
     returning id`,
    [rid(), id, u.id, p.id, p.version_seq],
  );
  return Response.json({ ok: true, id: row?.id, version: p.version_seq });
}

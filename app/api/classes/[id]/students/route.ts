import { q, q1 } from '@/lib/db';
import { bad, hashPassword, requireUser, rid } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 老师批量开学生号：粘贴一列昵称，生成“用户名 + 初始密码”单。
 * 用户名 = 班级加入码小写 + 两位序号，重名自动顺延。
 */
export async function POST(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const c = await q1<{ id: string; join_code: string }>(`select id, join_code from classes where id=$1 and owner_id=$2`, [id, u.id]);
  if (!c) return bad('没找到这个班级', 404);
  const b = await req.json().catch(() => ({}));
  const names: string[] = String(b.names || '')
    .split(/[\n,，、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 60);
  if (!names.length) return bad('每行写一个学生昵称');
  const ageBand = ['L1', 'L2', 'L3'].includes(b.ageBand) ? b.ageBand : 'L2';
  const prefix = c.join_code.toLowerCase();
  const created: { nickname: string; username: string; password: string }[] = [];
  let n = 1;
  for (const nickname of names) {
    let username = '';
    while (!username) {
      const cand = `${prefix}${String(n).padStart(2, '0')}`;
      n++;
      if (!(await q1(`select 1 from users where username=$1`, [cand]))) username = cand;
    }
    const password = String(Math.floor(100000 + Math.random() * 900000));
    const uid = rid();
    await q(
      `insert into users(id, username, nickname, role, age_band, avatar, pass_hash, created_by) values ($1,$2,$3,'student',$4,'🐥',$5,$6)`,
      [uid, username, nickname.slice(0, 20), ageBand, hashPassword(password), u.id],
    );
    await q(`insert into class_members(class_id, user_id) values ($1,$2)`, [c.id, uid]);
    created.push({ nickname, username, password });
  }
  return Response.json({ created });
}

/** 老师把学生移出班级 */
export async function DELETE(req: Request, { params }: Ctx) {
  const u = await requireUser();
  if (u instanceof Response) return u;
  const { id } = await params;
  const { userId } = await req.json().catch(() => ({}));
  const c = await q1(`select 1 from classes where id=$1 and owner_id=$2`, [id, u.id]);
  if (!c) return bad('没找到这个班级', 404);
  await q(`delete from class_members where class_id=$1 and user_id=$2`, [id, userId]);
  return Response.json({ ok: true });
}

import { q, q1 } from '@/lib/db';
import { bad, hashPassword, rid, startSession } from '@/lib/auth';

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  const nickname = String(b.nickname || '').trim() || username;
  const role = b.role === 'teacher' ? 'teacher' : 'student';
  const ageBand = ['L1', 'L2', 'L3'].includes(b.ageBand) ? b.ageBand : 'L2';
  const avatar = String(b.avatar || (role === 'teacher' ? '🦆' : '🐥')).slice(0, 4);
  const joinCode = String(b.joinCode || '').trim().toUpperCase();

  if (!/^[a-z0-9_\-]{3,24}$/.test(username)) return bad('用户名用 3-24 位字母、数字或下划线哦');
  if (password.length < 4) return bad('密码至少 4 位');
  if (nickname.length > 20) return bad('昵称太长啦，20 个字以内');
  if (await q1(`select 1 from users where username = $1`, [username])) return bad('这个用户名已经有人用啦，换一个吧');

  let cls: any = null;
  if (joinCode) {
    cls = await q1(`select id from classes where join_code = $1`, [joinCode]);
    if (!cls) return bad('没找到这个班级加入码，再核对一下？');
  }
  const id = rid();
  await q(
    `insert into users(id, username, nickname, role, age_band, avatar, pass_hash) values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, username, nickname, role, ageBand, avatar, hashPassword(password)],
  );
  if (cls) await q(`insert into class_members(class_id, user_id) values ($1,$2) on conflict do nothing`, [cls.id, id]);
  await startSession(id);
  return Response.json({ ok: true, id, role });
}

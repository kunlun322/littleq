import { endSession, currentUser } from '@/lib/auth';
import { q } from '@/lib/db';

export async function POST() {
  await endSession();
  return Response.json({ ok: true });
}

/** 修改自己的昵称 / 头像 / 年龄段 */
export async function PATCH(req: Request) {
  const u = await currentUser();
  if (!u) return Response.json({ error: '先登录一下吧～' }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const nickname = b.nickname ? String(b.nickname).trim().slice(0, 20) : u.nickname;
  const avatar = b.avatar ? String(b.avatar).slice(0, 4) : u.avatar;
  const ageBand = ['L1', 'L2', 'L3'].includes(b.ageBand) ? b.ageBand : u.age_band;
  await q(`update users set nickname=$2, avatar=$3, age_band=$4 where id=$1`, [u.id, nickname, avatar, ageBand]);
  return Response.json({ ok: true });
}

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { q, q1 } from './db';

export const COOKIE = 'lq_session';

export type User = {
  id: string;
  username: string;
  nickname: string;
  role: 'student' | 'teacher';
  age_band: 'L1' | 'L2' | 'L3';
  avatar: string;
};

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
export function rid(len = 12) {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}

export function hashPassword(pw: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  return q1<User>(
    `select u.id, u.username, u.nickname, u.role, u.age_band, u.avatar
       from sessions s join users u on u.id = s.user_id where s.token = $1`,
    [token],
  );
}

export async function startSession(userId: string) {
  const token = rid(32);
  await q(`insert into sessions(token, user_id) values ($1, $2)`, [token, userId]);
  // 虚拟机直接跑 http 时 secure cookie 会丢，所以按实际协议决定
  const h = await headers();
  const proto = h.get('x-forwarded-proto') || (process.env.VERCEL ? 'https' : 'http');
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: proto === 'https',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await q(`delete from sessions where token = $1`, [token]);
  jar.delete(COOKIE);
}

/** API 路由里用：没登录直接返回 401 JSON */
export async function requireUser(): Promise<User | Response> {
  const u = await currentUser();
  if (!u) return Response.json({ error: '先登录一下吧～' }, { status: 401 });
  return u;
}

export function bad(msg: string, status = 400) {
  return Response.json({ error: msg }, { status });
}

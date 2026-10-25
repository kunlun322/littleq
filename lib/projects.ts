import { q, q1 } from './db';
import type { User } from './auth';

export type Project = {
  id: string;
  owner_id: string;
  title: string;
  work_type: 'GAME' | 'TOOL' | 'ANIMATION' | 'AGENT';
  description: string;
  html: string;
  version_seq: number;
  /** QCA 创作会话："<templateId>/<sessionId>" */
  agent_session_id: string | null;
  /** 创作会话里 Little Q 已经看过的代码版本 */
  agent_seen_seq: number | null;
  slug: string | null;
  visibility: 'private' | 'class' | 'public';
  published_at: string | null;
  likes: number;
  views: number;
  updated_at: string;
};

export { WORK_TYPES, VIS_LABEL, BANDS, AVATARS } from './constants';

/** 作品自己的主人才能改 */
export async function ownProject(id: string, user: User) {
  return q1<Project>(`select * from projects where id = $1 and owner_id = $2`, [id, user.id]);
}

/** 能不能看这个作品：主人 / 老师看自己班学生的 / 公开 / 班级可见且同班 */
export async function canView(p: { owner_id: string; visibility: string; published_at: any }, user: User | null) {
  if (user && user.id === p.owner_id) return true;
  if (user?.role === 'teacher') {
    const r = await q1(
      `select 1 from class_members m join classes c on c.id = m.class_id where m.user_id = $1 and c.owner_id = $2 limit 1`,
      [p.owner_id, user.id],
    );
    if (r) return true;
  }
  if (!p.published_at) return false;
  if (p.visibility === 'public') return true;
  if (p.visibility === 'class' && user) {
    const r = await q1(
      `select 1 from class_members a join class_members b on a.class_id = b.class_id
        where a.user_id = $1 and b.user_id = $2 limit 1`,
      [user.id, p.owner_id],
    );
    return !!r;
  }
  return false;
}

export function serializeDates<T>(rows: T[]): T[] {
  return JSON.parse(JSON.stringify(rows));
}

export async function listPublic(limit = 24) {
  return q<Project & { nickname: string; avatar: string }>(
    `select p.id, p.title, p.work_type, p.slug, p.likes, p.views, p.published_at, p.description,
            u.nickname, u.avatar
       from projects p join users u on u.id = p.owner_id
      where p.visibility = 'public' and p.published_at is not null
      order by p.published_at desc limit $1`,
    [limit],
  );
}

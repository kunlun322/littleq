import Link from 'next/link';
import { q1 } from '@/lib/db';
import { currentUser } from '@/lib/auth';
import { canView } from '@/lib/projects';
import { WORK_TYPES } from '@/lib/constants';
import { Avatar, Illustration } from '@/components/Illustration';
import { Icon } from '@/components/Icon';
import { LikeButton } from './LikeButton';
import { WorkFrame } from '@/components/WorkFrame';

type Ctx = { params: Promise<{ slug: string }> };

export default async function WorkPage({ params }: Ctx) {
  const { slug } = await params;
  const user = await currentUser();
  const p = await q1<any>(
    `select p.id, p.owner_id, p.title, p.description, p.work_type, p.likes, p.views, p.visibility, p.published_at,
            u.nickname, u.avatar
       from projects p join users u on u.id = p.owner_id where p.slug = $1`,
    [slug],
  );
  if (!p || !(await canView(p, user))) {
    return (
      <main className="page container center">
        <Illustration name="sleep" size={120} />
        <h2>这个作品收起来了，或者需要登录才能看</h2>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          {!user && (
            <Link href="/login" className="btn primary">
              登录
            </Link>
          )}
          <Link href="/gallery" className="btn ghost">
            去作品广场
          </Link>
        </div>
      </main>
    );
  }
  const liked = user ? !!(await q1(`select 1 from likes where project_id=$1 and user_id=$2`, [p.id, user.id])) : false;
  const t = WORK_TYPES[p.work_type as keyof typeof WORK_TYPES];
  return (
    <main className="page">
      <div className="container">
        <div className="row between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h1 style={{ margin: 0 }}>
              <Illustration name={t.icon} size={44} /> {p.title}
            </h1>
            <div className="muted">
              <span className="inline-identity"><Avatar value={p.avatar} size={26} /> {p.nickname} 的{t.label}</span> · <Icon name="eye" size={18} /> {p.views + 1}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <LikeButton slug={slug} liked={liked} likes={p.likes} canLike={!!user} />
            {user?.id === p.owner_id && (
              <Link href={`/create/${p.id}`} className="btn ghost">
                <Icon name="edit" /> 继续改
              </Link>
            )}
          </div>
        </div>
        {p.description && <p>{p.description}</p>}
        <div className="player">
          <WorkFrame src={`/r/${slug}?s=1`} title={p.title} agent={{ id: slug, bySlug: true }} />
        </div>
        <div className="center" style={{ marginTop: 24 }}>
          <p className="muted">也想做一个？</p>
          <Link href={user ? '/projects' : '/login'} className="btn primary lg">
            和 Little Q 一起做 <Icon name="spark" size={22} />
          </Link>
        </div>
      </div>
    </main>
  );
}

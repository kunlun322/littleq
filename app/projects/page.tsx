import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { q } from '@/lib/db';
import { serializeDates, type Project } from '@/lib/projects';
import { WorkCard } from '@/components/WorkCard';
import { Avatar, Illustration } from '@/components/Illustration';
import { Icon } from '@/components/Icon';
import { NewWork } from './NewWork';
import { DeleteWork } from './DeleteWork';

export default async function MyProjects() {
  const u = await currentUser();
  if (!u) redirect('/login');
  const list = serializeDates(
    await q<Project>(
      `select id, title, work_type, slug, likes, views, version_seq, published_at, updated_at
         from projects where owner_id = $1 order by updated_at desc`,
      [u.id],
    ),
  );
  return (
    <main className="page">
      <div className="container">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h1>
            <Avatar value={u.avatar} size={44} /> {u.nickname} 的作品
          </h1>
          {u.role === 'teacher' && <Link href="/classes">去我的班级 <Icon name="arrow" size={18} /></Link>}
        </div>
        <NewWork />
        <h2 style={{ marginTop: 32 }}>我做过的（{list.length}）</h2>
        {list.length === 0 ? (
          <div className="card center">
            <Illustration name="empty" size={100} />
            <p className="muted">还没有作品哦，从上面选一个灵感开始吧！</p>
          </div>
        ) : (
          <div className="grid grid-3">
            {list.map((p) => (
              <div key={p.id} style={{ position: 'relative' }}>
                <WorkCard w={{ ...p, slug: null }} href={`/create/${p.id}`} />
                <div style={{ position: 'absolute', top: 8, left: 8 }}>
                  {p.published_at ? <span className="badge green">已发布</span> : <span className="badge">草稿</span>}{' '}
                  {p.version_seq > 0 && <span className="badge blue">第 {p.version_seq} 版</span>}
                </div>
                <div style={{ position: 'absolute', top: 8, right: 8 }}>
                  <DeleteWork id={p.id} title={p.title} published={!!p.published_at} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

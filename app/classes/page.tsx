import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { q } from '@/lib/db';
import { serializeDates } from '@/lib/projects';
import { DuckRating, Illustration } from '@/components/Illustration';
import { CreateClass, JoinClass, SubmitWork } from './ClassActions';

export default async function ClassesPage() {
  const u = await currentUser();
  if (!u) redirect('/login');

  if (u.role === 'teacher') {
    const classes = await q<any>(
      `select c.id, c.name, c.join_code,
              (select count(*)::int from class_members m where m.class_id = c.id) as members,
              (select count(*)::int from assignments a where a.class_id = c.id) as assignments,
              (select count(*)::int from submissions s join assignments a on a.id = s.assignment_id
                 where a.class_id = c.id and s.status = 'submitted') as pending
         from classes c where c.owner_id = $1 order by c.created_at desc`,
      [u.id],
    );
    return (
      <main className="page">
        <div className="container">
          <h1 className="inline-identity"><Illustration name="class" />我的班级</h1>
          <CreateClass />
          <div className="grid grid-3" style={{ marginTop: 24 }}>
            {classes.map((c) => (
              <Link key={c.id} href={`/classes/${c.id}`} className="card hover">
                <h3 style={{ marginTop: 0 }}>{c.name}</h3>
                <div className="muted small">
                  加入码 <b style={{ fontSize: 18, letterSpacing: 2 }}>{c.join_code}</b>
                </div>
                <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <span className="badge blue inline-identity"><Illustration name="student" size={20} />{c.members} 名学生</span>
                  <span className="badge yellow inline-identity"><Illustration name="assignment" size={20} />{c.assignments} 个作业</span>
                  {c.pending > 0 && <span className="badge red">{c.pending} 份待批改</span>}
                </div>
              </Link>
            ))}
          </div>
          {classes.length === 0 && <p className="muted">还没有班级，先建一个吧。建好后可以批量生成学生账号，或者把加入码发给学生。</p>}
        </div>
      </main>
    );
  }

  // 学生视角
  const classes = await q<any>(
    `select c.id, c.name, t.nickname as teacher from class_members m
       join classes c on c.id = m.class_id join users t on t.id = c.owner_id
      where m.user_id = $1 order by m.joined_at desc`,
    [u.id],
  );
  const tasks = serializeDates(
    await q<any>(
      `select a.id, a.title, a.description, a.due_at, c.name as class_name,
              s.id as sub_id, s.status, s.stars, s.comment, s.project_id, p.title as project_title
         from assignments a join classes c on c.id = a.class_id
         join class_members m on m.class_id = c.id and m.user_id = $1
         left join submissions s on s.assignment_id = a.id and s.student_id = $1
         left join projects p on p.id = s.project_id
        order by a.created_at desc`,
      [u.id],
    ),
  );
  const myProjects = await q<{ id: string; title: string }>(
    `select id, title from projects where owner_id = $1 and version_seq > 0 order by updated_at desc`,
    [u.id],
  );
  return (
    <main className="page">
      <div className="container">
        <h1 className="inline-identity"><Illustration name="class" />我的班级</h1>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {classes.map((c) => (
            <span key={c.id} className="badge blue" style={{ fontSize: 15 }}>
              {c.name} · {c.teacher} 老师
            </span>
          ))}
        </div>
        <JoinClass />
        <h2 className="inline-identity" style={{ marginTop: 32 }}><Illustration name="assignment" size={32} />作业</h2>
        {tasks.length === 0 && <p className="muted">暂时没有作业～</p>}
        <div className="stack">
          {tasks.map((t) => (
            <div key={t.id} className="card">
              <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <h3 style={{ margin: 0 }}>{t.title}</h3>
                <span className="muted small">
                  {t.class_name}
                  {t.due_at && ` · 截止 ${new Date(t.due_at).toLocaleDateString('zh-CN')}`}
                </span>
              </div>
              {t.description && <p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p>}
              {t.status === 'graded' && (
                <div className="notice ok">
                  <span className="inline-identity">老师的评价：<DuckRating value={t.stars || 0} /></span> {t.comment}
                </div>
              )}
              {t.status === 'redo' && <div className="notice err">老师希望你再改改：{t.comment}</div>}
              {t.status === 'submitted' && <div className="notice">已交《{t.project_title}》，等老师看～</div>}
              {t.status !== 'graded' && <SubmitWork assignmentId={t.id} projects={myProjects} current={t.project_id} />}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

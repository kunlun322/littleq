import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { q, q1 } from '@/lib/db';
import { BANDS } from '@/lib/constants';
import { Avatar, DuckRating, Illustration } from '@/components/Illustration';
import { Icon } from '@/components/Icon';
import { BatchStudents, GradeBox, NewAssignment, RemoveStudent } from '../ClassActions';

type Ctx = { params: Promise<{ id: string }> };

export default async function ClassDetail({ params }: Ctx) {
  const u = await currentUser();
  if (!u) redirect('/login');
  if (u.role !== 'teacher') redirect('/classes');
  const { id } = await params;
  const c = await q1<any>(`select * from classes where id=$1 and owner_id=$2`, [id, u.id]);
  if (!c) notFound();

  const members = await q<any>(
    `select u.id, u.username, u.nickname, u.avatar, u.age_band,
            (select count(*)::int from projects p where p.owner_id = u.id) as works
       from class_members m join users u on u.id = m.user_id where m.class_id = $1 order by m.joined_at`,
    [id],
  );
  const assignments = await q<any>(`select * from assignments where class_id=$1 order by created_at desc`, [id]);
  const subs = await q<any>(
    `select s.*, u.nickname, u.avatar, p.title as project_title from submissions s
       join assignments a on a.id = s.assignment_id
       join users u on u.id = s.student_id
       join projects p on p.id = s.project_id
      where a.class_id = $1 order by s.submitted_at desc`,
    [id],
  );

  return (
    <main className="page">
      <div className="container">
        <Link href="/classes" className="muted inline-identity">
          <Icon name="back" />我的班级
        </Link>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h1 className="inline-identity"><Illustration name="class" />{c.name}</h1>
          <div className="card" style={{ padding: '8px 16px' }}>
            学生加入码：<b style={{ fontSize: 22, letterSpacing: 3 }}>{c.join_code}</b>
          </div>
        </div>

        <h2 className="inline-identity"><Illustration name="assignment" size={32} />作业（{assignments.length}）</h2>
        <NewAssignment classId={id} />
        <div className="stack" style={{ marginTop: 16 }}>
          {assignments.map((a) => {
            const list = subs.filter((s) => s.assignment_id === a.id);
            return (
              <div key={a.id} className="card">
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{a.title}</h3>
                  <span className="muted small">
                    已交 {list.length} / {members.length}
                    {a.due_at && ` · 截止 ${new Date(a.due_at).toLocaleDateString('zh-CN')}`}
                  </span>
                </div>
                {a.description && <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{a.description}</p>}
                {list.length > 0 && (
                  <div className="table-scroll" role="region" aria-label={`${a.title}的提交记录`} tabIndex={0}>
                  <table className="tbl">
                    <tbody>
                      {list.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <span className="inline-identity"><Avatar value={s.avatar} />{s.nickname}</span>
                          </td>
                          <td>
                            《{s.project_title}》<span className="muted small"> 第 {s.version_seq} 版</span>
                          </td>
                          <td>
                            {s.status === 'graded' ? (
                              <span className="badge green"><DuckRating value={s.stars || 0} /></span>
                            ) : s.status === 'redo' ? (
                              <span className="badge red">待重交</span>
                            ) : (
                              <span className="badge yellow">待批改</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <GradeBox sub={JSON.parse(JSON.stringify(s))} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <h2 className="inline-identity" style={{ marginTop: 32 }}><Illustration name="student" size={32} />学生（{members.length}）</h2>
        <div className="grid class-students-layout">
          <div className="card">
            {members.length === 0 ? (
              <p className="muted">还没有学生。右边批量生成账号，或者把加入码 {c.join_code} 发给学生自己注册。</p>
            ) : (
              <div className="table-scroll" role="region" aria-label="班级学生列表" tabIndex={0}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>学生</th>
                    <th>用户名</th>
                    <th>年级段</th>
                    <th>作品</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <span className="inline-identity"><Avatar value={m.avatar} />{m.nickname}</span>
                      </td>
                      <td>
                        <code>{m.username}</code>
                      </td>
                      <td>{BANDS[m.age_band as keyof typeof BANDS]?.name}</td>
                      <td>{m.works}</td>
                      <td style={{ textAlign: 'right' }}>
                        <RemoveStudent classId={id} userId={m.id} name={m.nickname} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
          <BatchStudents classId={id} />
        </div>
      </div>
    </main>
  );
}

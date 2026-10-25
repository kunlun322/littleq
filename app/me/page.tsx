import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { MeForm } from './MeForm';
import { Avatar } from '@/components/Illustration';

export default async function MePage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  return (
    <main className="page">
      <div className="container" style={{ maxWidth: 560 }}>
        <h1>
          <Avatar value={u.avatar} size={44} /> 我的资料
        </h1>
        <p className="muted">
          用户名：{u.username} · 身份：{u.role === 'teacher' ? '老师 / 家长' : '学生'}
        </p>
        <MeForm nickname={u.nickname} avatar={u.avatar} ageBand={u.age_band} role={u.role} />
      </div>
    </main>
  );
}

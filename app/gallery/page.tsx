import { listPublic, serializeDates } from '@/lib/projects';
import { WorkCard } from '@/components/WorkCard';
import { Illustration } from '@/components/Illustration';

export default async function Gallery() {
  const works = serializeDates(await listPublic(60));
  return (
    <main className="page">
      <div className="container">
        <h1><Illustration name="gallery" size={48} /> 作品广场</h1>
        <p className="muted">小朋友们用 Little Q 做的作品，点开就能玩。</p>
        {works.length === 0 ? (
          <div className="card center">
            <Illustration name="sleep" size={120} />
            <p className="muted">还没有公开的作品，来做第一个吧！</p>
          </div>
        ) : (
          <div className="grid grid-3">
            {works.map((w) => (
              <WorkCard key={w.id} w={w} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

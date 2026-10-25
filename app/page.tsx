import Link from 'next/link';
import { HomeThemePicker, ThemeHero } from '@/components/ThemePicker';
import { WorkCard } from '@/components/WorkCard';
import { Illustration } from '@/components/Illustration';
import { Icon } from '@/components/Icon';
import { currentUser } from '@/lib/auth';
import { BANDS, WORK_TYPES, listPublic, serializeDates } from '@/lib/projects';

export default async function Home() {
  let user = null;
  let works: Awaited<ReturnType<typeof listPublic>> = [];
  try {
    user = await currentUser();
    works = serializeDates(await listPublic(6));
  } catch (e) {
    console.error('[home]', e);
  }
  const go = user ? '/projects' : '/login';
  return (
    <main className="page home-page">
      <div className="container">
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">每个孩子，都是创作者</span>
            <h1>
              和 <span style={{ color: 'var(--secondary)' }}>Little Q</span> 一起，
              <br />
              把想法变成作品
            </h1>
            <p className="lead">
              说一句话，小黄鸭就帮你做出小游戏、小工具、小动画。
              <br />
              改一改、玩一玩，再一键发给好朋友！
            </p>
            <div className="row" style={{ gap: 12, marginTop: 24 }}>
              <Link href={go} className="btn primary lg">
                开始创作 <Icon name="spark" size={22} />
              </Link>
              <Link href="/gallery" className="btn ghost lg">
                看看大家做了什么
              </Link>
            </div>
          </div>
          <ThemeHero />
        </section>

        <HomeThemePicker />

        <section className="section creation-categories">
          <h2>可以做什么？</h2>
          <div className="grid grid-3">
            {(
              [
                ['GAME', '接住掉下来的星星、打地鼠、迷宫冒险……'],
                ['TOOL', '课程表、口算练习、单词卡、倒计时……'],
                ['ANIMATION', '会跳舞的小鸭子、下雪的夜晚、烟花秀……'],
                ['AGENT', '恐龙博士、英语小老师、故事精灵……会聊天的 AI 角色'],
              ] as const
            ).map(([k, d]) => (
              <div key={k} className="card type-card">
                <div className="emo"><Illustration name={WORK_TYPES[k].icon} size={80} /></div>
                <h3>{WORK_TYPES[k].label}</h3>
                <p className="muted">{d}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section creation-steps">
          <h2>三步做出你的作品</h2>
          <div className="grid grid-3">
            {[
              ['说出想法', '告诉 Little Q 你想做什么，越具体越好玩。'],
              ['一起改进', '“让它动起来”“加个声音”，一句话就能改。'],
              ['一键发布', '生成链接和二维码，爸爸妈妈手机上也能玩。'],
            ].map(([t, d], i) => (
              <div key={t} className="card">
                <div className="step-num">{i + 1}</div>
                <h3>{t}</h3>
                <p className="muted">{d}</p>
              </div>
            ))}
          </div>
        </section>

        {works.length > 0 && (
          <section className="section">
            <div className="row between">
              <h2>新鲜出炉的作品</h2>
              <Link href="/gallery">看全部 <Icon name="arrow" size={18} /></Link>
            </div>
            <div className="grid grid-3">
              {works.map((w) => (
                <WorkCard key={w.id} w={w} />
              ))}
            </div>
          </section>
        )}

        <section className="section">
          <h2>每个年龄都有合适的玩法</h2>
          <div className="grid grid-3">
            {Object.entries(BANDS).map(([k, b]) => (
              <div key={k} className="card">
                <Illustration name={b.icon} size={72} />
                <h3>
                  {b.name} <span className="badge yellow">{b.desc}</span>
                </h3>
                <p className="muted">
                  {k === 'L1' && '大按钮、少文字，Little Q 说话更简单。'}
                  {k === 'L2' && '会解释“我做了什么”，顺便学一点编程小知识。'}
                  {k === 'L3' && '可以看代码、问原理，挑战更复杂的作品。'}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
      <footer className="footer">Little Q · 小黄鸭陪你一起创造</footer>
    </main>
  );
}

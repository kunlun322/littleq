import Link from 'next/link';
import { WORK_TYPES } from '@/lib/constants';
import { Avatar, Illustration } from './Illustration';
import { Icon } from './Icon';

type W = {
  id: string;
  title: string;
  work_type: keyof typeof WORK_TYPES;
  slug: string | null;
  likes: number;
  views: number;
  nickname?: string;
  avatar?: string;
};

/** 作品卡片：缩略图直接用缩小的 iframe 跑作品本身，省掉截图服务 */
export function WorkCard({ w, href }: { w: W; href?: string }) {
  const t = WORK_TYPES[w.work_type] || WORK_TYPES.GAME;
  const link = href || (w.slug ? `/w/${w.slug}` : `/create/${w.id}`);
  const src = w.slug ? `/r/${w.slug}?s=1&thumb=1` : `/r/${w.id}`;
  return (
    <Link href={link} className="card hover work-card">
      <div className="work-thumb">
        <iframe src={src} sandbox="allow-scripts" loading="lazy" tabIndex={-1} title={w.title} />
      </div>
      <div className="work-body">
        <div className="work-title">
          <Illustration name={t.icon} size={28} /> {w.title}
        </div>
        <div className="row between small muted">
          <span className="inline-identity">{w.nickname ? <><Avatar value={w.avatar} size={22} /> {w.nickname}</> : t.label}</span>
          <span className="work-stats">
            <Icon name="heart" size={16} /> {w.likes} · <Icon name="eye" size={16} /> {w.views}
          </span>
        </div>
      </div>
    </Link>
  );
}

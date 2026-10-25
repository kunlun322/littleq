'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import { Icon } from '@/components/Icon';

export function LikeButton(props: { slug: string; liked: boolean; likes: number; canLike: boolean }) {
  const router = useRouter();
  const [s, setS] = useState({ liked: props.liked, likes: props.likes });
  async function toggle() {
    if (!props.canLike) return router.push('/login');
    const d = await api<{ liked: boolean; likes: number }>(`/api/works/${props.slug}/like`);
    setS(d);
  }
  return (
    <button className={`btn ${s.liked ? 'primary' : 'ghost'}`} onClick={toggle} aria-pressed={s.liked} aria-label={`${s.liked ? '取消喜欢' : '喜欢作品'}，${s.likes} 人喜欢`}>
      <Icon name="heart" active={s.liked} /> {s.likes}
    </button>
  );
}

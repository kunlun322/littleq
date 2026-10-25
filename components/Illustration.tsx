'use client';

import Image from 'next/image';
import { useTheme } from './ThemePicker';
import { AVATAR_IMAGES } from '@/lib/constants';

export type IllustrationName = 'game' | 'tool' | 'animation' | 'agent' | 'band-L1' | 'band-L2' | 'band-L3' | 'student' | 'teacher' | 'gallery' | 'class' | 'assignment' | 'publish' | 'party' | 'newwork' | 'sleep' | 'empty';

export function Illustration({ name, size = 40, alt = '', className = '' }: { name: IllustrationName; size?: number; alt?: string; className?: string }) {
  const { theme } = useTheme();
  return <Image src={`/icons/${theme}/${name}.webp`} alt={alt} width={size} height={size} unoptimized className={`illustration ${className}`} data-illustration={name} />;
}

export function Avatar({ value, size = 32, alt = '', className = '' }: { value?: string | null; size?: number; alt?: string; className?: string }) {
  const name = AVATAR_IMAGES[value || '']?.image || 'duck';
  return <Image src={`/icons/avatar/${name}.webp`} alt={alt} width={size} height={size} unoptimized className={`illustration avatar-image ${className}`} data-avatar={name} />;
}

export function DuckRating({ value }: { value: number }) {
  return <span className="duck-rating" role="img" aria-label={`${value} 只鸭评价`}>{Array.from({ length: value }, (_, i) => <Avatar key={i} value="🦆" size={22} />)}</span>;
}

import Image from 'next/image';

type Props = { size?: number; mood?: 'happy' | 'think' | 'sleep'; className?: string };

export function Duck({ size = 120, mood = 'happy', className }: Props) {
  return (
    <Image
      src="/littleq-logo.png"
      alt="Little Q 小黄鸭"
      width={size}
      height={size}
      loading="eager"
      className={className}
      data-mood={mood}
      style={{ objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

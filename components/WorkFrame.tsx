'use client';
import { useRef } from 'react';
import { useAgentBridge } from '@/components/useAgentBridge';

/** 作品播放器：iframe + 智能体作品的对话桥 */
export function WorkFrame({ src, title, agent }: { src: string; title: string; agent: { id: string; bySlug?: boolean; version?: number | null } }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useAgentBridge(frame, agent);
  return <iframe ref={frame} src={src} sandbox="allow-scripts allow-modals allow-pointer-lock" title={title} allow="autoplay" />;
}

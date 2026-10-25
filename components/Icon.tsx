import type { CSSProperties } from 'react';

const drawings = {
  home: ['M3 11 12 3l9 8M5 10v11h5v-7h4v7h5V10', 'M5 10 12 4l7 6v11h-5v-7h-4v7H5Z'],
  spark: ['m12 2 2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5L12 2M20 2v4m-2-2h4', 'm12 2 2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5Z'],
  folder: ['M3 7h7l2-3h9v16H3V7Zm0 0V4h6l3 3', 'M3 7h7l2-3h9v16H3Z'],
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  play: ['m9 6 10 6-10 6V6Z'],
  school: ['m2 8 10-5 10 5-10 5L2 8Zm4 3v7l6 3 6-3v-7M22 8v9', 'm2 8 10-5 10 5-10 5Z'],
  board: ['M3 4h18v13H3zM8 21l4-4 4 4M7 8h10M7 12h6', 'M3 4h18v13H3Z'],
  user: ['M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-3a8 8 0 0 1 16 0v3', 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-3a8 8 0 0 1 16 0v3Z'],
  arrow: ['M4 12h16m-6-6 6 6-6 6', ''],
  back: ['M20 12H4m6-6-6 6 6 6', ''],
  close: ['m6 6 12 12M6 18 18 6', ''],
  heart: ['M12 21 3.5 12.5a5.5 5.5 0 0 1 8.5-7 5.5 5.5 0 0 1 8.5 7L12 21Z'],
  star: ['m12 2 3 6.5 7 .8-5 5 1.3 7.2-6.3-3.4-6.3 3.4L7 14.3l-5-5 7-.8L12 2Z'],
  check: ['m5 12 4 4L19 6', ''],
  refresh: ['M21 11a9 9 0 1 0-3 8M21 3v8h-8', ''],
  code: ['m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18', ''],
  mobile: ['M7 2h10v20H7zM10 18h4', 'M7 2h10v20H7Z'],
  desktop: ['M2 3h20v14H2zM12 17v4m-5 0h10', 'M2 3h20v14H2Z'],
  share: ['M15 5a3 3 0 1 0 6 0 3 3 0 0 0-6 0Zm0 14a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM3 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Zm6-1 6-4m-6 6 6 4', 'M15 5a3 3 0 1 0 6 0 3 3 0 0 0-6 0Zm0 14a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM3 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 6v6l4 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],
  info: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6m0-10v1', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z'],
  plus: ['M12 4v16M4 12h16', ''],
  wand: ['m4 18 13-13 3 3L7 21l-3-3ZM5 3v5M2.5 5.5h5M16 1v3m-2-1h4M21 16v5m-2.5-2.5h5', 'm4 18 13-13 3 3L7 21Z'],
  sound: ['m3 9 5 0 5-5v16l-5-5H3V9Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14', 'm3 9 5 0 5-5v16l-5-5H3Z'],
  bug: ['M7 9h10v7a5 5 0 0 1-10 0V9Zm2-4a3 3 0 0 1 6 0v4M3 10h4m10 0h4M3 16h4m10 0h4M7 5 4 2m13 3 3-3', 'M7 9h10v7a5 5 0 0 1-10 0Z'],
  leaf: ['M20 3C8 1 3 8 5 15s13 8 15-12ZM5 20 16 8', 'M20 3C8 1 3 8 5 15s13 8 15-12Z'],
  logout: ['M10 3H3v18h7m4-15 6 6-6 6M8 12h12', ''],
  flag: ['M5 22V3m0 0c5-5 9 5 15 0v11c-6 5-10-5-15 0', 'M5 3c5-5 9 5 15 0v11c-6 5-10-5-15 0Z'],
  lock: ['M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4', 'M5 10h14v11H5Z'],
  message: ['M3 3h18v14H9l-6 4V3ZM7 8h10M7 12h7', 'M3 3h18v14H9l-6 4Z'],
  edit: ['m4 16 12-12 4 4L8 20l-5 1 1-5Zm9-9 4 4', 'm4 16 12-12 4 4L8 20l-5 1Z'],
  trash: ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7', 'M5 6l1 15h12l1-15Z'],
  send: ['m2 3 20 9-20 9 4-9-4-9Zm4 9h16', 'm2 3 20 9-20 9 4-9Z'],
  copy: ['M8 8h13v13H8zM16 8V3H3v13h5', 'M8 8h13v13H8Z'],
  link: ['m10 14 4-4m-6 2-2 2a4 4 0 0 0 6 6l3-3m-3-9 2-2a4 4 0 0 1 6 6l-3 3', ''],
  tools: ['m4 20 9-9m-3-7a6 6 0 0 0 7 7l5-5-5 1-3-3 1-5-5 5ZM3 19l2 2', ''],
  thinking: ['M21 11a9 9 0 1 0-9 10h4l4 2v-6M8 11h.01M12 11h.01M16 11h.01', 'M21 11a9 9 0 1 0-9 10h4l4 2v-6Z'],
} as const;

export type IconName = keyof typeof drawings;

export function Icon({ name, size = 20, label, active = false, className = '', style }: { name: IconName; size?: number; label?: string; active?: boolean; className?: string; style?: CSSProperties }) {
  const paths: readonly string[] = drawings[name];
  const fill = paths.length > 1 ? paths[1] : paths[0];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`ui-icon${active ? ' is-active' : ''} ${className}`} style={style} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} focusable="false" data-icon={name}>
      {fill && <path d={fill} className="icon-fill" stroke="none" />}
      <path d={paths[0]} className="icon-line" />
    </svg>
  );
}

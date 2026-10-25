'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';
import { Icon } from '@/components/Icon';

export function DeleteWork({ id, title, published }: { id: string; title: string; published: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn danger sm work-delete"
      disabled={busy}
      aria-label={`删除《${title}》`}
      onClick={async () => {
        const warn = published ? '它已经发布了，删除后链接会打不开，也会从作品广场消失。\n' : '';
        if (!confirm(`确定删除《${title}》吗？\n${warn}作品、所有版本和对话都会被删掉，不能恢复。`)) return;
        setBusy(true);
        try {
          await api(`/api/projects/${id}`, 'DELETE');
          router.refresh();
        } catch (e: any) {
          alert(e.message);
          setBusy(false);
        }
      }}
    >
      <Icon name="trash" size={18} /> {busy ? '删除中…' : '删除'}
    </button>
  );
}

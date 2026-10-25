'use client';

/** 前端调用 API 的小工具：统一 JSON 收发，失败抛出带中文提示的 Error */
export async function api<T = any>(url: string, method = 'POST', body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `出了点小状况（${r.status}），再试一次吧`);
  return d as T;
}

/**
 * 数据库适配层：一套 SQL，两种后端。
 *  - 设置了 DATABASE_URL => postgres.js 连接任意 PostgreSQL（Neon / RDS / 自建 / docker）
 *  - 未设置           => 内置 PGlite（嵌入式 Postgres，数据落盘到 PGLITE_DIR）
 * 首次查询时自动建表（幂等），不需要单独的迁移步骤。
 */
import { SCHEMA } from './schema';

type Row = Record<string, any>;
type Db = { kind: 'postgres' | 'pglite'; query: (text: string, params?: unknown[]) => Promise<Row[]> };

const g = globalThis as unknown as { __lqDb?: Promise<Db> };

function normalizeUrl(raw: string) {
  const fixed = raw.trim().replace(/&amp;/g, '&');
  try {
    const u = new URL(fixed);
    // postgres.js 不认识 channel_binding，会当成服务端参数发出去导致报错
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch {
    return fixed;
  }
}

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  let db: Db;
  if (url && url.trim()) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(normalizeUrl(url), {
      max: process.env.VERCEL ? 2 : 6,
      prepare: false, // 兼容 pgbouncer / Neon pooler
      idle_timeout: 20,
      connect_timeout: 20,
      onnotice: () => {},
    });
    db = { kind: 'postgres', query: async (t, p = []) => Array.from(await sql.unsafe(t, p as any[])) as Row[] };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const fs = await import('node:fs');
    const dir = process.env.PGLITE_DIR || './.data/pglite';
    fs.mkdirSync(dir, { recursive: true });
    const lite = new PGlite(dir);
    await lite.waitReady;
    db = { kind: 'pglite', query: async (t, p = []) => (await lite.query(t, p as any[])).rows as Row[] };
  }
  for (const stmt of SCHEMA) {
    try {
      await db.query(stmt);
    } catch (e: any) {
      // 并发冷启动时可能撞上"已存在"，忽略即可
      if (!['42P07', '23505', '42710', '42701'].includes(e?.code)) throw e;
    }
  }
  return db;
}

export function getDb(): Promise<Db> {
  if (!g.__lqDb) {
    g.__lqDb = connect().catch((e) => {
      g.__lqDb = undefined;
      throw e;
    });
  }
  return g.__lqDb;
}

export async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDb();
  return (await db.query(text, params)) as T[];
}

export async function q1<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

import { q, q1 } from '@/lib/db';
import { currentUser } from '@/lib/auth';
import { canView } from '@/lib/projects';
import { withShim } from '@/lib/constants';
import { cookies } from 'next/headers';
import { DEFAULT_THEME, isTheme, THEME_COOKIE, type Theme } from '@/lib/themes';

type Ctx = { params: Promise<{ id: string }> };

const notFound = (theme: Theme) => `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding:40px;background:#FFFAF0">
<img src="/icons/${theme}/sleep.webp" alt="休息中的小黄鸭" width="100" height="100"><h2>作品收起来了</h2><p>看看其他作品吧～</p></body>`;

/**
 * 作品原始 HTML（给 iframe 用）。
 *  /r/{projectId}           当前版本
 *  /r/{projectId}?v=3       第 3 版（老师看提交快照时用）
 *  /r/{slug}?s=1            按公开链接访问
 * 加 CSP sandbox，作品脚本跑在不透明源里，碰不到主站 cookie。
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const url = new URL(req.url);
  const bySlug = url.searchParams.get('s') === '1';
  const p = await q1<any>(
    `select id, owner_id, visibility, published_at, html from projects where ${bySlug ? 'slug' : 'id'} = $1`,
    [id],
  );
  const user = await currentUser();
  let html: string | null = null;
  if (p && (await canView(p, user))) {
    const v = url.searchParams.get('v');
    if (v) {
      const row = await q1<{ html: string }>(`select html from versions where project_id=$1 and seq=$2`, [p.id, Number(v)]);
      html = row?.html ?? null;
    } else html = p.html;
    if (bySlug && !url.searchParams.has('thumb')) await q(`update projects set views = views + 1 where id=$1`, [p.id]);
  }
  const preference = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(preference) ? preference : DEFAULT_THEME;
  return new Response(html ? withShim(html) : notFound(theme), {
    status: html ? 200 : 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': 'sandbox allow-scripts allow-modals allow-pointer-lock',
      'Cache-Control': 'no-store',
    },
  });
}

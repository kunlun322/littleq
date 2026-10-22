/**
 * 同源 `/api/*` 的**唯一**路由处理器。
 *
 * 这一层刻意薄到只有三件事：声明 `server-only`、把 Next 的请求对象拆成纯数据、交给
 * `src/api-proxy.ts`。所有判定（目标解析、路径校验、逐跳头、失败关闭）都在那个纯模块里，
 * 因为只有不 import `server-only` 的模块才能被 vitest 真正测到。
 *
 * ## 为什么是路由处理器，而不是 `next.config.ts` 里的 rewrite
 *
 * rewrite 也能把 `/api/*` 打到固定目标，而且更省事。选路由处理器是为了让「代理只认一个
 * 固定目标、且失败关闭」这件事写在**能被测试扫到、能被单测钉住**的代码里，而不是藏进一份
 * 只有构建期才生效的配置 —— 配置里的 rewrite 既不能报「上游连不上」，也不能拒绝
 * `..` 段。ZLQ-232 §3.3 两种都允许（「固定目标的 rewrite / route handler」），这里取后者。
 *
 * ## `import 'server-only'` 不是装饰
 *
 * 它是构建期兜底：一旦这个文件被任何客户端图引用到，`next build` 直接抛错。依赖图的受控边
 * 规则 `web-server-adapter-only-controlled-api-entry` 也把 `server-only` 列为适配层文件的
 * 必需说明符（`requireSpecifiers`），两处指向同一条约束。
 */
import 'server-only';

import type { NextRequest } from 'next/server';

import { proxyRequest } from '../../../src/api-proxy';

/** 这条路由必须跑在 Node 运行时：它要读服务端环境变量，而 Edge 运行时的环境变量是构建期固化的。 */
export const runtime = 'nodejs';

/**
 * 强制动态。
 *
 * 代理的结果依赖运行时的目标配置与请求本身，任何缓存都会让「失败关闭」变成一个可以被
 * 预渲染绕过的事实。
 */
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  // GET / HEAD 之外的方法才可能有请求体；用 arrayBuffer 重放，避免流式 body 需要 duplex 选项。
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
  return proxyRequest({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body,
    segments: path ?? [],
    env: process.env,
  });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

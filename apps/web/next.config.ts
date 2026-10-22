/**
 * Next.js 配置（ZLQ-190 §3.1 / §4 D2；ZLQ-232 按架构师 ZLQ-233 的 Q3 裁定翻成服务构建）。
 *
 * ## 这一版改了什么、以及为什么只改这一处
 *
 * **只移除了「静态导出」那一个键**（`output` 取 `export`；下面刻意不写出它的源码形态，
 * 因为 `apps/web/test/index.test.ts` 用行首锚定的正则断言「配置对象里没有这个键」，
 * 全文扫描会被本段说明绊住）。`trailingSlash` / `images.unoptimized` /
 * `transpilePackages` / `reactStrictMode` 四项逐字保留 —— Q3-补-2 明确禁止借这次切换
 * 顺手摘掉 `trailingSlash`（`/source-and-license/` 的尾斜杠形态与 `vercel.json` 的
 * 响应头规则、§7 的路由清单都对齐在它上面）或启用图片优化链路（`sharp` 整条被
 * `pnpm-workspace.yaml` 摘掉的前提就是本切片不跑图片优化；启用它会把 LGPL 的 libvips
 * 平台二进制家族拖回许可证闭包）。
 *
 * 移除之后 `/api/*`、rewrite、redirect、Server Action 在**能力上**重新可用了。
 * 本配置**刻意一项都不启用**：同源 `/api/*` 由 `app/api/[...path]/route.ts` 这一个
 * 路由处理器承担，而不是 `rewrites` —— 那样这处改动才能严格等于「删掉一行」，
 * 也让「代理只认一个固定目标」这件事写在能被测试扫到的代码里，而不是藏进配置。
 *
 * ## §8 D6 的那道安全边界换了实现方式（补偿控制，ZLQ-232 §3.3）
 *
 * 旧版把「静态导出」本身当作 §8 D6 的边界：「没有服务端进程，也就没有可以持有
 * 凭证的地方」。翻服务构建**打破了这句话** —— 现在确实有一个服务端进程。所以对价是：
 *
 * 1. `apps/web` 服务端**不持有任何模型、数据库或第三方服务凭证**。它唯一的外部调用是
 *    把 `/api/*` 转发到**配置中的单一** API origin（`LQ_API_ORIGIN`，缺省即同源不可用
 *    ⇒ 失败关闭），转发时不附加任何自己的凭据。
 * 2. **禁止用户控制目标地址**：代理路径不参与目标 origin 的拼接，请求里出现的任何
 *    host/scheme 都不被读取 ⇒ 结构上不可能变成通用开放代理。
 * 3. 鉴权、会话、以及全部敏感凭证只在 `apps/api`。`apps/web` 对 cookie 只做**不透明转发**：
 *    浏览器侧代码从不读取那一位会话 Cookie 的值（它是 HttpOnly，本文件也不写出它的名字 ——
 *    `apps/web/test/index.test.ts` 里「会话名零命中」那条断言连注释一起扫，原样保留）。
 *
 * 这三条不是注释里的愿望，是被 `apps/web/test/index.test.ts` 与 `e2e/smoke.spec.ts`
 * 逐条钉住的（依赖面扫描、凭证载体扫描、单一 origin 断言、浏览器请求全同源）。
 *
 * ## 仍然刻意不做的事
 *
 * 不配 rewrite / redirect / 自定义响应头（响应头在 `vercel.json`，仓库根不得再出现
 * 第二份 Vercel 入口）；不启用 Server Action；不配远端图片域名；
 * 不占用 F5.2 的作品运行时独立源与其严格 CSP。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@littleq/design-system'],
  reactStrictMode: true,
};

export default nextConfig;

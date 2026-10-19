/**
 * Next.js 配置（ZLQ-190 §3.1 / §4 D2）。
 *
 * 固定项逐条对应设计文档，不新增任何需要服务端运行时的能力：
 *
 * - `output: 'export'` —— 纯静态导出。这同时是一道安全边界（§8 D6）：没有服务端进程，
 *   也就没有可以持有凭证的地方；`/api/*`、rewrite、redirect、Server Action 全部不可用。
 * - `trailingSlash: true` —— 产出 `index.html` + `source-and-license/index.html`，
 *   让 `vercel.json` 的静态响应头与 §7 的路由清单（`/source-and-license/`）对得上。
 * - `images.unoptimized: true` —— 静态导出没有图片优化服务；这也是 `pnpm-workspace.yaml`
 *   里能把 `sharp` 整条摘掉的前提（sharp 自身 Apache-2.0，但它拖进来的 libvips 平台
 *   二进制家族是 LGPL，本切片根本不会执行图片优化链路）。
 * - `transpilePackages` —— 让 Next 从源码编译 workspace 包内的 TS，
 *   `@littleq/design-system` 的 `tokens.css` 与 `age-bands` 因此可以直接被消费。
 *   这是设计 §3.1「固定」清单之外的一项配置补充，已按 PM 裁定 3 在交付说明中声明。
 *
 * **刻意不做的事**（§3.1）：不配 rewrites / redirects / API 路由 / Server Action /
 * 远端图片域名；不占用 F5.2 的作品运行时独立源与严格 CSP。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@littleq/design-system'],
  reactStrictMode: true,
};

export default nextConfig;

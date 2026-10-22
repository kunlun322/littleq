import { defineConfig, devices } from '@playwright/test';

import {
  BUNDLE_ORIGIN,
  BUNDLE_PORT,
  DEAD_API_ORIGIN,
  SITE_ORIGIN,
  SITE_PORT,
} from './e2e/origins.js';

/**
 * Playwright 配置 —— ZLQ-232 起 e2e 加载的是**服务构建产物**，不再是静态导出的 `out`。
 *
 * 起两个服务，因为被测的是两份不同的产物：
 *
 *   4173  `next start`（cwd=apps/web） —— Next 的服务构建。`output: 'export'` 已按
 *          架构师 Q3-补 的裁定移除，`apps/web/out` 不复存在，所以这一份只能由 Next 自己起：
 *          e2e 要测的是**部署后的真实形态**（有服务端进程、路由处理器活着、同源代理在跑），
 *          用静态服务器兜一份 HTML 出来的话，`/api/*` 那一整层根本不会被执行到。
 *          `LQ_API_ORIGIN` 指向一个必然连不上的环回端口，见 `e2e/origins.ts` 里
 *          `DEAD_API_ORIGIN` 的说明：那让「上游连不上 ⇒ 502」与「路径不合法 ⇒ 404」
 *          成为两个可区分的实测结果，而不是同一句兜底。
 *   4174  root=仓库根，`--allow artifacts` —— esbuild 合规 bundle（`pnpm bundles` 的产物）。
 *          它的 AGPL 横幅断言按 §6.1 保留，但**不再冒充**站点产物；用绝对 URL 访问。
 *
 * `baseURL` 指向站点：spec 里的相对路径一律是站点路径，这与人访问部署时的写法一致；
 * 需要 bundle 的地方显式写 `BUNDLE_ORIGIN`，读代码的人一眼能看出这一条不是站点。
 *
 * 仍然只用仓库自带的东西，不引入额外依赖：新增依赖必须过许可门禁，
 * 而这件事不值得为它开一个口子。`next` 本来就在 `apps/web` 的依赖里。
 *
 * 端口与 origin 定义在 `e2e/origins.ts`，spec 与本文件引同一份常量。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  outputDir: './test-results',
  use: {
    baseURL: SITE_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // 走 `dist/bin/next` 而不是 `node_modules/.bin/next`：后者是 `#!/bin/sh` 的壳，
      // 在某些容器里多一层解释器只会多一种失败方式。与 `tools/check-web-export.mjs`
      // 的 `resolveNextCommand` 取同一条路径。
      command: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${SITE_PORT}`,
      cwd: 'apps/web',
      // 站点根路径就是就绪信号：Next 服务形态下没有 `/__health` 这种自建端点，
      // 而 `/` 返回 200 恰好同时证明「进程起来了」和「首页这条路由渲染得出来」。
      url: `${SITE_ORIGIN}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...process.env, LQ_API_ORIGIN: DEAD_API_ORIGIN },
    },
    {
      command: `node tools/static-server.mjs --port ${BUNDLE_PORT} --allow artifacts`,
      url: `${BUNDLE_ORIGIN}/__health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});

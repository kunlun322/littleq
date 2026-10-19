import { defineConfig, devices } from '@playwright/test';

import { BUNDLE_ORIGIN, BUNDLE_PORT, SITE_ORIGIN, SITE_PORT } from './e2e/origins.js';

/**
 * Playwright 配置 —— ZLQ-190 §6.2 之后 e2e 加载的是**真实部署产物**。
 *
 * 起两个 `tools/static-server.mjs` 实例，各服务一份产物，因为这两份产物的
 * 「根」不是同一个目录，而白名单是相对根的：
 *
 *   4173  root=apps/web/out，`--allow .`   —— Next 静态导出的站点。§7 要求页面上的
 *          链接是 `/source-and-license/`、`/legal/AGPL-3.0.txt` 这种**站点根相对**路径，
 *          所以根必须就是 `out`；把根设成仓库根再白名单 `apps/web/out` 会让 URL 变成
 *          `/apps/web/out/...`，与部署后的真实形状不符，e2e 就测不到部署形状了。
 *   4174  root=仓库根，`--allow artifacts` —— esbuild 合规 bundle（`pnpm bundles` 的产物）。
 *          它的 AGPL 横幅断言按 §6.1 保留，但**不再冒充**站点产物；用绝对 URL 访问。
 *
 * `baseURL` 指向站点：spec 里的相对路径一律是站点路径，这与人访问部署时的写法一致；
 * 需要 bundle 的地方显式写 `BUNDLE_ORIGIN`，读代码的人一眼能看出这一条不是站点。
 *
 * 仍然只用仓库自带的静态服务器，不引入额外依赖：新增依赖必须过许可门禁，
 * 而这件事不值得为它开一个口子。
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
      command: `node tools/static-server.mjs --port ${SITE_PORT} --root apps/web/out --allow .`,
      url: `${SITE_ORIGIN}/__health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/static-server.mjs --port ${BUNDLE_PORT} --allow artifacts`,
      url: `${BUNDLE_ORIGIN}/__health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});

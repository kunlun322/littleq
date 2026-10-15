import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置 —— M1 Stage 1-1 只保证「smoke 入口可运行」。
 *
 * 现在没有任何产品页面可测，因此 `e2e/smoke.spec.ts` 测的是工具链本身：
 * 构建产物能被真实浏览器加载执行、workspace 组合没有在打包中丢失、
 * AGPL 法务横幅活过了 minify。业务 e2e 随后续 Stage 在此扩展。
 *
 * webServer 用 `tools/static-server.mjs`（只监听 127.0.0.1、只服务 artifacts/），
 * 不引入额外的静态服务器依赖：新增依赖必须过许可门禁，而这件事不值得为它开一个口子。
 */
const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  outputDir: './test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tools/static-server.mjs --port ${PORT}`,
    url: `${BASE_URL}/__health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

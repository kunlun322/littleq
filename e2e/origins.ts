/**
 * e2e 用的两个本地服务地址 —— 单一事实来源。
 *
 * `playwright.config.ts` 用 PORT 拼启动命令，`smoke.spec.ts` 用 ORIGIN 拼绝对 URL，
 * 两边引同一份常量，改端口不会只改到一侧。
 *
 * 为什么要两个服务：站点产物（`apps/web/out`）与合规 bundle（`artifacts/bundles`）
 * 的「根」不是同一个目录，而静态服务器的白名单是相对根的。§7 要求页面链接是
 * `/source-and-license/` 这种站点根相对路径，所以站点服务的根必须就是 `out`。
 */
export const SITE_PORT = 4173;
export const BUNDLE_PORT = 4174;

export const SITE_ORIGIN = `http://127.0.0.1:${SITE_PORT}`;
export const BUNDLE_ORIGIN = `http://127.0.0.1:${BUNDLE_PORT}`;

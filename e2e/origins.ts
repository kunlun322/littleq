/**
 * e2e 用的本地服务地址 —— 单一事实来源。
 *
 * `playwright.config.ts` 用 PORT 拼启动命令，`smoke.spec.ts` 用 ORIGIN 拼绝对 URL，
 * 两边引同一份常量，改端口不会只改到一侧。
 *
 * 为什么要两个服务：站点与合规 bundle（`artifacts/bundles`）是两份不同的产物，
 * 各由自己的服务器承载，bundle 那份不再冒充站点产物，用绝对 URL 访问。
 * ZLQ-232 起站点这一份是 `next start` 起的**服务构建**，不再是静态导出的 `apps/web/out`
 * —— 那个目录已经不存在了（`output: 'export'` 已移除，合规门改成文件侧 + HTTP 侧的混合门）。
 */
export const SITE_PORT = 4173;
export const BUNDLE_PORT = 4174;

export const SITE_ORIGIN = `http://127.0.0.1:${SITE_PORT}`;
export const BUNDLE_ORIGIN = `http://127.0.0.1:${BUNDLE_PORT}`;

/**
 * 喂给站点服务的一个**必然连不上**的上游地址。
 *
 * 为什么不给一个真后端：本单的后端腿（`apps/api` 四条真端点）由 ZLQ-221 承接，
 * 两路都不在自己那棵树上持有对方，硬凑一个假后端就等于用替身冒充真服务 —— 那正是
 * 「空壳也能全绿」的老毛病。
 *
 * 为什么是 `127.0.0.1:1` 而不是一个不存在的域名或黑洞 IP：这一条要的是**真的发起一次
 * TCP 连接、真的被拒**。域名要靠 DNS（在离线的 CI 容器里是另一种失败，分不清是代理坏了
 * 还是网断了），黑洞 IP 要等到超时（把 e2e 拖成分钟级）。环回端口 1 立刻 ECONNREFUSED，
 * 于是 `502 WEB_API_UPSTREAM_UNREACHABLE` 是「代理照配置拨了号、对面没人接」的证据，
 * 而不是一句兜底文案。
 *
 * 它同时也让**判别力**成为可能：路径不合法给 404、上游连不上给 502 —— 两个码不同，
 * 才证明这层不是一律返回同一个失败。没有配置目标的话，两者都会先撞上 503，判别不出来。
 */
export const DEAD_API_ORIGIN = 'http://127.0.0.1:1';

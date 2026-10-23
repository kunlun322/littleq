/**
 * Vercel 函数入口（形态 B）。本项目 Root Directory = `apps/api`（用户裁定一，2026-10-23），
 * 于是 Vercel 的零配置函数发现把 `api/` 当函数根 ⇒ 本文件服务 `/api/v1/*`：
 * 正是 `apps/web` 的 `FORWARDED_PREFIX`（`apps/web/src/api-proxy.ts:40`）转发过来的前缀，
 * 也正是 `API_PREFIX`（`apps/api/src/server/http.ts:118`）要求 handler 看到的**完整**路径
 * —— 所以这里不剥前缀、不 rewrite，路径原样进去。
 *
 * ## 为什么这一层只有一行、而且是 `.js`
 *
 * 真正的实现在 `src/bootstrap/function.ts`：那边受 `tsc -b` 编译、受
 * `test/function-entry.test.ts` 覆盖。`apps/api/tsconfig.json` 是 `rootDir: "src"` +
 * `include: ["src"]`，`api/` 落在这两行之外 —— 放 `.ts` 进去就得到一份**没有任何编译器
 * 看过**的源码，写错标识符只在部署时才炸。写成 `.js` 并只留一行 re-export，
 * 这份文件的正确性就退化成"一行字符串对不对"，而那由测试逐字节钉住（带阳性对照）。
 *
 * re-export 指向 `dist/` 而不是 `src/`：仓库所有跨包解析都走各包 `exports` 里的
 * `./dist/index.js`（`@littleq/application` 等），指向 `dist` 与这条既有约定一致，
 * 也让 nft 追踪到的是一份已编译的 JS，而不是一棵需要平台再编译一遍的 TS。
 * ⇒ 因此 `apps/api/vercel.json` 的 `buildCommand` 必须先产出 `dist/`。
 *
 * ⚠️ 未经真实平台验证：本轮没有建项目、没有部署、没有发起任何计费动作。
 * 「`@vercel/node` 会等 `res.end()` 再结束调用」与「nft 会顺着这行 re-export 把
 * `dist/**` 与各工作区包的 `dist/**` 一并打进函数包」都是源码级结论，以首次线上部署为准。
 *
 * ⚠️ 本文件被 `apps/api/test/function-entry.test.ts` **逐字节**钉住。改它就要同时改那条
 * 断言 —— 那是有意的：它不在任何编译器的视野里，没有别的网。
 */
export { default } from '../../dist/bootstrap/function.js';

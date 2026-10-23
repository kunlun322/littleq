import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

import { createWorkspaceAlias } from './tools/esbuild-config.mjs';

/**
 * Vitest 配置 —— 单元测试同时覆盖工作区包（TS）与质量基座工具（.mjs）。
 *
 * `resolve.alias` 复用 `tools/esbuild-config.mjs` 里那份 workspace 别名表，
 * 与打 bundle 用的是同一份映射：测试跑的是源码，产物打的也是源码，
 * 两边不会因为一份手写别名表漂移而出现「测试绿、bundle 里解析到另一个东西」。
 *
 * 共享那份别名只支持桶导入（`@littleq/domain`），不支持子路径（`@littleq/domain/x`）——
 * M1 阶段各包都只导出 `src/index.ts` 一个入口，没有 subpath exports。下面**额外**补了
 * 一条子路径别名，理由写在它旁边。
 */
export default defineConfig({
  resolve: {
    alias: {
      // ⚠️ **顺序是有意义的**：Vite 的字符串别名做前缀匹配（`importee === key` 或
      // `importee.startsWith(key + '/')`），所以这条长的必须排在
      // `@littleq/work-contract` 那条短的**前面**，否则 `/scan` 会被短键截胡、
      // 拼成 `src/index.ts/scan`。
      //
      // ⚠️ 只补在**这里**，不补进 `tools/esbuild-config.mjs` 的共享别名表。
      // 那张表同时喂 vitest 与浏览器 bundle；`./scan` 子路径背后是 acorn / parse5 /
      // postcss 这一整套 Node 侧解析器，把它加进浏览器别名表等于邀请打包器把服务端
      // 依赖拖进站点产物（那个 barrel 的文件头正是为了拦这件事才只导出类型）。
      //
      // 为什么需要它：`createWorkspaceAlias` 把 `@littleq/work-contract` 映射到
      // `src/index.ts` 这个**文件**，子路径拼不上。真实 Node 没有这个问题（它读
      // package.json 的 `exports["./scan"].node`，实测解析得到并含 `createWorkScanner`），
      // 所以服务端进程入口 `apps/api/src/bootstrap/function.ts` 用的是子路径导入，
      // 测试解析要能跟上。
      '@littleq/work-contract/scan': join(
        import.meta.dirname,
        'packages/work-contract/src/scan/index.ts',
      ),
      ...createWorkspaceAlias(import.meta.dirname),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'tools/test/**/*.test.mjs',
    ],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

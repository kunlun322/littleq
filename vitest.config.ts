import { defineConfig } from 'vitest/config';

import { createWorkspaceAlias } from './tools/esbuild-config.mjs';

/**
 * Vitest 配置 —— 单元测试同时覆盖工作区包（TS）与质量基座工具（.mjs）。
 *
 * `resolve.alias` 复用 `tools/esbuild-config.mjs` 里那份 workspace 别名表，
 * 与打 bundle 用的是同一份映射：测试跑的是源码，产物打的也是源码，
 * 两边不会因为一份手写别名表漂移而出现「测试绿、bundle 里解析到另一个东西」。
 *
 * 别名只支持桶导入（`@littleq/domain`），不支持子路径（`@littleq/domain/x`）——
 * M1 阶段各包都只导出 `src/index.ts` 一个入口，没有 subpath exports。
 */
export default defineConfig({
  resolve: {
    alias: createWorkspaceAlias(import.meta.dirname),
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

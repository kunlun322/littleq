// esbuild 打包配置的唯一出处。
//
// 之所以单独成文件：ZLQ-153 §10.3 要求「构建产物保留 /*! @license */ 注释」，而这条要求
// 只有在**生产用的那份配置**上被断言才算数。tools/test/bundle-license.test.mjs 与
// tools/build-bundles.mjs 都从这里取配置，测试因此无法与生产配置漂移。
//
// legalComments 的三种取值里只有 'inline' 满足要求：
//   'eof'    把所有法务注释挪到文件末尾，注释与代码位置脱钩，且不保证 /*! 前缀原样保留
//   'linked'/'external' 抽出到 .txt 旁文件，产物本身不含声明
//   'inline' 原地保留，配合 minify 仍生效 —— 这正是本仓库要的
import { join } from 'node:path';

export const LEGAL_COMMENTS = 'inline';

// esbuild 的 alias 需要可解析路径，故按仓库根展开成绝对路径。
export function createWorkspaceAlias(repoRoot) {
  return {
    '@littleq/domain': join(repoRoot, 'packages/domain/src/index.ts'),
    '@littleq/infra': join(repoRoot, 'packages/infra/src/index.ts'),
    '@littleq/work-contract': join(repoRoot, 'packages/work-contract/src/index.ts'),
    '@littleq/design-system': join(repoRoot, 'packages/design-system/src/index.ts'),
  };
}

export function createBundleOptions({ entryPoint, outfile, alias, banner = null }) {
  return {
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    minify: true,
    legalComments: LEGAL_COMMENTS,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    sourcemap: false,
    // 直接指向源码而非 dist：让 bundle 不依赖构建顺序，也与后续 Next.js 从源码打包的行为一致。
    alias,
    logLevel: 'warning',
    ...(banner ? { banner: { js: banner } } : {}),
  };
}

// 横幅只陈述义务与出处，且必须与事实一致：这个 bundle 是 @littleq/web 的**合规入口**
// （单元自述 + 契约可加载性），不是部署到 Vercel 的那份站点产物 —— 后者是 `next build`
// 的 apps/web/out。所以横幅不说「本文件已挂载到 /licenses.txt」，只说明义务落在哪、
// 由谁负责。ZLQ-190 §6.1 明确要求：不得用这份 bundle 的扫描结果冒充 Next 产物的合规覆盖。
export const WEB_BUNDLE_BANNER = [
  '/*!',
  ' * LittleQ — 面向 K12 学生的 AI 编程与创作平台',
  ' * Copyright (C) 2026 LittleQ contributors',
  ' * SPDX-License-Identifier: AGPL-3.0-only',
  ' *',
  ' * 本文件是 @littleq/web 的合规入口 bundle，不是部署站点。',
  ' * ZLQ-153 §10.2 的第三方归因清单与它同时生成（<bundle>.licenses.txt），并由',
  ' * tools/prepare-web-legal.mjs 逐字节复制到站点产物的 /licenses.txt；',
  ' * AGPL-3.0 §13 的源码入口见站点页脚与 /source-and-license/ 页（ZLQ-190 §7）。',
  ' */',
].join('\n');

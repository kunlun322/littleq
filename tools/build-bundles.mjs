#!/usr/bin/env node
// 生成用于许可证扫描的 web bundle（ZLQ-153 §10.3 的第二处扫描目标）。
//
// 注意这不是生产构建。M1 阶段前端由 Next.js 16 承载（ZLQ-153 §2.1），生产打包配置属于后续任务；
// 这里产出的是一份「与生产同源配置」的最小 bundle，目的只有两个：
//   1. 让 §10.3 的 bundle 许可证扫描在 M1 就有真实产物可扫，而不是留空；
//   2. 让 legalComments:'inline' + minify:true 的组合被 tools/test/bundle-license.test.mjs 断言，
//      证明压缩不会吃掉 /*! @license */ 注释。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createBundleOptions, createWorkspaceAlias, WEB_BUNDLE_BANNER } from './esbuild-config.mjs';

const repoRoot = process.cwd();
const outDir = join(repoRoot, 'artifacts', 'bundles');

const targets = [
  {
    name: 'web',
    entryPoint: join(repoRoot, 'apps/web/src/index.ts'),
    outfile: join(outDir, 'web.js'),
    banner: WEB_BUNDLE_BANNER,
  },
];

mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const options = createBundleOptions({
    entryPoint: target.entryPoint,
    outfile: target.outfile,
    alias: createWorkspaceAlias(repoRoot),
    banner: target.banner,
  });
  const result = await build(options);
  const metafile = join(dirname(target.outfile), `${target.name}.meta.json`);
  writeFileSync(metafile, `${JSON.stringify(result.metafile, null, 2)}\n`, 'utf8');
  // 把「保留法务注释」这件事从注释里的承诺变成机器可校验的事实：
  // bundle-scan.mjs 会读这份记录，legalComments 不是 'inline' 或 minify 被关掉都会失败。
  const optionsFile = join(dirname(target.outfile), `${target.name}.options.json`);
  writeFileSync(
    optionsFile,
    `${JSON.stringify(
      {
        target: target.name,
        entryPoint: target.entryPoint.replace(`${repoRoot}/`, ''),
        outfile: target.outfile.replace(`${repoRoot}/`, ''),
        legalComments: options.legalComments,
        minify: options.minify,
        bundle: options.bundle,
        format: options.format,
        platform: options.platform,
        esTarget: options.target,
        sourcemap: options.sourcemap,
        bannerPresent: Boolean(options.banner),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const outputs = Object.entries(result.metafile.outputs);
  const bytes = outputs.reduce((total, [, value]) => total + value.bytes, 0);
  process.stdout.write(
    `bundle ${target.name}: ${resolve(target.outfile).replace(`${repoRoot}/`, '')} ` +
      `（${bytes} 字节，输入 ${Object.keys(result.metafile.inputs).length} 个文件，` +
      `legalComments=${options.legalComments}，minify=${options.minify}）\n`,
  );
  process.stdout.write(`metafile: ${metafile.replace(`${repoRoot}/`, '')}\n`);
}

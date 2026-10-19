#!/usr/bin/env node
/**
 * 把仓库根目录的法务文件与构建产物归因清单搬进 `apps/web/public/`（ZLQ-190 §7 D5）。
 *
 * 为什么需要这一步，而不是直接把文件签入 `apps/web/public/legal/`：
 *
 * 1. **单一出处。** `LICENSE` / `NOTICE` / `THIRD_PARTY_LICENSES` 的真身在仓库根，
 *    并且已经分别被 `license:third-party:check`（字节级比对）与 e2e（旧 bundle 的
 *    SPDX 横幅）盯着。再签入一份副本，就会出现两份都能被"更新"的法务文本 ——
 *    而 `THIRD_PARTY_LICENSES` 是生成物，签入副本必然随依赖变动而悄悄过期。
 * 2. **`/licenses.txt` 的真身是构建产物。** 它来自 `tools/license/bundle-scan.mjs`
 *    写出的 `artifacts/bundles/web.licenses.txt`，而 `artifacts/` 是被 gitignore 的。
 *    所以它**只能**在构建期搬运，不可能签入。
 * 3. **Vercel 的 Build Command 是一次全新克隆。** 它只会执行 `pnpm web:build`，
 *    因此这一步必须挂在那条链上、且对执行顺序不敏感（本脚本只读根目录与 artifacts，
 *    不依赖 `tsc -b` 是否已经跑过）。
 *
 * 搬运是**逐字节复制**，不做任何改写：改写会让「部署产物里公开的那份」与
 * 「仓库里被门禁盯着的那份」产生差异，而 AGPL-3.0 §13 要求的正是前者的准确性。
 *
 * 失败姿态：任何一个来源缺失就退出非 0。这里**绝不**用「缺了就跳过」的宽容写法 ——
 * 少一份法务文件的站点会正常构建、正常部署、门禁全绿，而义务其实已经破了。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const repoRoot = process.cwd();

/** 源 → 部署后的 URL 路径（即 `apps/web/public/` 下的相对位置）。 */
const LEGAL_COPIES = [
  { from: 'LICENSE', to: 'apps/web/public/legal/AGPL-3.0.txt' },
  { from: 'NOTICE', to: 'apps/web/public/legal/NOTICE.txt' },
  { from: 'THIRD_PARTY_LICENSES', to: 'apps/web/public/legal/THIRD_PARTY_LICENSES.txt' },
  { from: 'artifacts/bundles/web.licenses.txt', to: 'apps/web/public/licenses.txt' },
];

const missing = [];
const copied = [];

for (const entry of LEGAL_COPIES) {
  const source = join(repoRoot, entry.from);
  const target = join(repoRoot, entry.to);

  if (!existsSync(source) || !statSync(source).isFile()) {
    missing.push(entry.from);
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  copied.push({ from: entry.from, to: entry.to, bytes: statSync(target).size });
}

if (missing.length > 0) {
  process.stderr.write(
    `法务文件准备失败：以下来源缺失或不是普通文件 —— ${missing.join(', ')}\n` +
      `提示：${relative(repoRoot, join(repoRoot, 'artifacts/bundles/web.licenses.txt'))} ` +
      `由 \`pnpm license:bundle\` 生成，必须先于本脚本执行。\n`,
  );
  process.exit(1);
}

for (const item of copied) {
  process.stdout.write(`web legal: ${item.from} → ${item.to}（${item.bytes} 字节）\n`);
}

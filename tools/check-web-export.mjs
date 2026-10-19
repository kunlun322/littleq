#!/usr/bin/env node
/**
 * 静态导出产物的存在性与合规标记检查（ZLQ-190 §6.1 的 `build` 门禁）。
 *
 * 为什么必须有这一步：`build` 过去只跑 `tsc -b`，产物是 `apps/web/dist/index.js`。
 * 加了 Next 之后，**`tsc -b` 成功不再意味着站点被构建出来了** —— 类型检查通过而
 * `next build` 失败、或者 `output:'export'` 被改掉因而根本没有 `out/`，
 * 都能让旧门禁全绿。§6.1 的原话是「不得仅凭旧的 `dist/index.js` 通过」。
 *
 * 这里刻意**只**断言两类事实：
 *
 * - **文件存在且非空**：首页、法务页、以及 §7 D5 点名的四份法务文件在 `out/` 里真的存在。
 * - **结构性合规标记**：`data-design-system-unit`（证明视觉基线真的取自 workspace 包，
 *   §5.2）、`AGPL-3.0-only`（证明许可证声明进了**部署产物**而不只是仓库，验收标准 5）、
 *   `--lq-`（证明 `tokens.css` 真的被打进了产物 CSS）。
 *
 * 不断言的东西同样重要：**不断言页面元素个数、不断言测试条数、不断言产物字节数或文件数**。
 * 那些都是观测量，写进门禁就变成每次改版都要同步修改的假契约（既有裁定）。
 * 文案层面的断言（诚实状态条、三个分龄档位、假入口不得出现）交给 vitest 与 e2e，
 * 因为它们能直接引用 `apps/web/src/site-content.ts` 这唯一一份文案出处。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const outDir = join(repoRoot, 'apps/web/out');

const REQUIRED_FILES = [
  'index.html',
  'source-and-license/index.html',
  'legal/AGPL-3.0.txt',
  'legal/NOTICE.txt',
  'legal/THIRD_PARTY_LICENSES.txt',
  'licenses.txt',
];

/** 产物里必须出现的标记：文件 → 该文件内必须命中的字符串。 */
const REQUIRED_MARKERS = [
  {
    file: 'index.html',
    markers: ['data-design-system-unit="@littleq/design-system"', 'AGPL-3.0-only'],
  },
  { file: 'source-and-license/index.html', markers: ['AGPL-3.0-only'] },
];

const failures = [];

if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
  process.stderr.write(
    `未找到静态导出目录 apps/web/out。\n` +
      `说明 \`next build\` 没有产出静态站点（检查 next.config.ts 的 output 是否仍为 'export'）。\n`,
  );
  process.exit(1);
}

for (const relativePath of REQUIRED_FILES) {
  const absolute = join(outDir, relativePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    failures.push(`缺少文件：apps/web/out/${relativePath}`);
    continue;
  }
  if (statSync(absolute).size === 0) {
    failures.push(`文件为空：apps/web/out/${relativePath}`);
  }
}

for (const { file, markers } of REQUIRED_MARKERS) {
  const absolute = join(outDir, file);
  if (!existsSync(absolute)) continue;
  const content = readFileSync(absolute, 'utf8');
  for (const marker of markers) {
    if (!content.includes(marker)) {
      failures.push(`apps/web/out/${file} 缺少必需标记：${marker}`);
    }
  }
}

// 设计令牌必须真的进了产物 CSS，而不是只存在于 packages/design-system/src/tokens.css。
// 用「是否存在任何 --lq- 前缀变量」来判断，不钉死变量个数（那是观测量）。
const cssDir = join(outDir, '_next/static/chunks');
const cssFiles = existsSync(cssDir)
  ? readdirSync(cssDir).filter((name) => name.endsWith('.css'))
  : [];
if (cssFiles.length === 0) {
  failures.push('产物里没有 CSS：apps/web/out/_next/static/chunks/*.css 一个都没有');
} else if (!cssFiles.some((name) => readFileSync(join(cssDir, name), 'utf8').includes('--lq-'))) {
  failures.push('产物 CSS 里找不到任何 --lq-* 设计令牌，tokens.css 没有被打进站点');
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`✗ ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `web export: apps/web/out 通过（首页 / 法务页 / 四份法务文件齐备，` +
    `合规标记与设计令牌均命中）\n`,
);

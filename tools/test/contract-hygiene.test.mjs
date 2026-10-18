/**
 * 契约产物的**仓库治理**约束。
 *
 * 这里钉的不是契约内容（那是 `packages/api-contract/test/`），而是「契约产物在这间仓库里
 * 被怎么对待」两件事：
 *
 * 1. **PM G3(3)**：committed snapshot 与故意变异的契约 fixture 确实被 prettier 忽略。
 *    `contract:check` 是逐字节比较，一次 `pnpm format` 就足以让它报
 *    `CONTRACT_SNAPSHOT_DRIFT`，而且报出来的差异全是排版 —— 真正的契约变化会被埋掉。
 *    `.prettierignore` 里那两条注释解释了理由，这条测试保证理由不会在某次整理里失效。
 *
 * 2. **PM G8**：`pnpm-workspace.yaml` 覆盖到的每个 workspace package 都出现在根
 *    `tsconfig.json` 的 `references` 里。`pnpm typecheck` 是 `tsc -b`，一个没被引用的
 *    包**不会被类型检查**，却照样能被 `pnpm build` 之外的路径消费 —— 静默的类型盲区。
 *
 * 两条都带非空对照：第 1 条用一个**没被忽略**的路径证明 `getFileInfo` 不是永远返回
 * `ignored:true`；第 2 条断言 references 里的每个路径都真实存在，证明清单不是空的。
 *
 * ## 平台无关性（PM G6）
 *
 * 期望值全部来自仓库内的文件（`.prettierignore` / `pnpm-workspace.yaml` / `tsconfig.json`）
 * 或文件内字面量，不来自「对本机的一次扫描」。目录枚举用 `readdirSync` 后**立即按码位序
 * 排序**（`readdirSync` 的顺序由文件系统决定，APFS 与 ext4 不同），不用 `localeCompare`。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** 按码位序排序，避免依赖 `readdirSync` 的平台顺序或系统 locale（PM G6）。 */
function byCodePoint(values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 用仓库自己的 `.prettierignore` 问 prettier：这个路径会被忽略吗？
 *
 * 走 prettier 的公开 API 而不是自己解析 `.prettierignore`：`format:check` 用的就是这套
 * 匹配语义（含目录后缀 `/` 的递归、`**` 的展开），自己重写一份等于测了一个替身。
 */
async function prettierVerdict(relativePath) {
  const info = await prettier.getFileInfo(join(REPO_ROOT, relativePath), {
    ignorePath: join(REPO_ROOT, '.prettierignore'),
  });
  return { ignored: info.ignored, inferredParser: info.inferredParser };
}

describe('PM G3(3)：契约产物与契约 fixture 被 prettier 忽略', () => {
  const IGNORED_PATHS = [
    // committed snapshot（附录 A §4.1）：逐字节比较的对象，排版变化即 DRIFT。
    'contracts/openapi/v1/openapi.json',
    'contracts/errors/v1/error-catalog.json',
    // 首次落库记录（附录 A §4.2 B）：里面是两个 SHA-256，被重排同样会破坏比对。
    'contracts/openapi/v1/bootstrap.json',
    // 故意变异的基线 fixture（PM G3(2)）：字节本身就是被测输入，格式化等于删对照用例。
    // 这四类各取一个代表：head 工作树、git 基线 blob、bootstrap 合法首落、security 双向 fixture。
    'tools/__fixtures__/contracts/git/HEAD',
    'tools/__fixtures__/contracts/git/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/contracts/openapi/v1/openapi.json',
    'tools/__fixtures__/contracts/git/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/contracts/errors/v1/error-catalog.json',
    'tools/__fixtures__/contracts/bootstrap/head/contracts/openapi/v1/openapi.json',
    'tools/__fixtures__/contracts/security/or-branch-removed/head.json',
    'tools/__fixtures__/contracts/security/or-branch-removed/base.json',
  ];

  it.each(IGNORED_PATHS)('%s 被忽略，且推断不出解析器', async (relativePath) => {
    expect(await prettierVerdict(relativePath)).toEqual({
      ignored: true,
      inferredParser: null,
    });
  });

  it('对照：一个**没有**被忽略的路径确实报 ignored:false（否则上面全是空绿）', async () => {
    // 根 package.json 是手写文件，prettier 认得它，也格式化它。
    expect(await prettierVerdict('package.json')).toEqual({
      ignored: false,
      inferredParser: 'json-stringify',
    });
  });

  it('对照：被忽略的理由写在 .prettierignore 里，与许可事实快照同源', () => {
    const ignore = readFileSync(join(REPO_ROOT, '.prettierignore'), 'utf8');
    // G3(1) 要求引用**既有**理由，不要新造。理由的关键词是「纯排版的 diff」。
    expect(ignore).toContain('contracts/');
    expect(ignore.match(/纯排版的 diff/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('所有被断言忽略的路径都真实存在（否则 getFileInfo 可能只是在报「不存在」）', () => {
    const missing = IGNORED_PATHS.filter((relativePath) => {
      const absolute = join(REPO_ROOT, relativePath);
      return !existsSync(absolute) || !statSync(absolute).isFile();
    });
    expect(missing).toEqual([]);
  });
});

describe('PM G8：workspace package 与根 tsconfig.json 的 references 一一对应', () => {
  /**
   * 展开 `pnpm-workspace.yaml` 的 `packages:` glob。
   *
   * 只支持本仓库实际用到的形状（`<dir>/*`）：不是通用 YAML 解析器，遇到不认识的条目
   * **直接抛**，而不是静默跳过 —— 跳过一个 glob 会让「每个包都被引用」变成空断言。
   */
  function workspacePackageDirs() {
    const text = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.trimEnd() === 'packages:');
    if (start === -1) throw new Error('pnpm-workspace.yaml 里没有 packages: 段');
    const globs = [];
    for (const line of lines.slice(start + 1)) {
      const item = /^\s+-\s+'?([^']+?)'?\s*(?:#.*)?$/.exec(line);
      if (!item) {
        // 列表在第一个**顶格**行处结束（下一个顶层键，或一段顶格注释）。
        // 空行与缩进注释跳过；缩进的非列表行是意外形状，抛而不是静默忽略 ——
        // 忽略一个条目会让「每个包都被引用」退化成空断言。
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
        if (/^\S/.test(line)) break;
        throw new Error(`无法解析 pnpm-workspace.yaml 的 packages 条目：${JSON.stringify(line)}`);
      }
      const glob = item[1];
      if (typeof glob !== 'string') throw new Error(`workspace glob 解析出非字符串：${line}`);
      globs.push(glob);
    }
    if (globs.length === 0) throw new Error('pnpm-workspace.yaml 的 packages: 段是空的');

    const dirs = [];
    for (const glob of globs) {
      const star = glob.endsWith('/*');
      if (!star) throw new Error(`只支持 <dir>/* 形状的 workspace glob，实际是：${glob}`);
      const parent = glob.slice(0, -2);
      const parentDir = join(REPO_ROOT, parent);
      if (!existsSync(parentDir)) throw new Error(`workspace glob 的父目录不存在：${parent}`);
      for (const entry of byCodePoint(readdirSync(parentDir))) {
        const candidate = join(parentDir, entry);
        if (!statSync(candidate).isDirectory()) continue;
        if (!existsSync(join(candidate, 'package.json'))) continue;
        dirs.push(`${parent}/${entry}`);
      }
    }
    return byCodePoint(dirs);
  }

  function tsconfigReferencePaths() {
    const raw = readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8');
    // 根 tsconfig.json 是纯 JSON（无注释）：直接 parse。若将来加了注释，这里会红，
    // 那正是想要的信号 —— 而不是悄悄退化成「解析失败就当没有 references」。
    const parsed = JSON.parse(raw);
    const references = Array.isArray(parsed.references) ? parsed.references : [];
    const paths = references
      .map((reference) => reference.path)
      .filter((path) => typeof path === 'string')
      .map((path) => path.replace(/^\.\//, ''));
    return byCodePoint(paths);
  }

  it('每个 workspace package 都在根 tsconfig.json 的 references 里', () => {
    const referenced = new Set(tsconfigReferencePaths());
    // 不把 references 的数量写成常量（PM G8 明令禁止）：期望值来自 workspace 清单本身。
    const missing = workspacePackageDirs().filter((dir) => !referenced.has(dir));
    expect(missing).toEqual([]);
  });

  it('对照：references 里的每个路径都真实存在且带 package.json（否则上面是空绿）', () => {
    const paths = tsconfigReferencePaths();
    expect(paths.length).toBeGreaterThan(0);
    const broken = paths.filter(
      (path) =>
        !existsSync(join(REPO_ROOT, path, 'package.json')) ||
        !existsSync(join(REPO_ROOT, path, 'tsconfig.json')),
    );
    expect(broken).toEqual([]);
  });

  it('对照：references 与 workspace 清单**集合相等**（多出来的引用同样是漂移）', () => {
    expect(tsconfigReferencePaths()).toEqual(workspacePackageDirs());
  });
});

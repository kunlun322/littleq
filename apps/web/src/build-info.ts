/**
 * 构建期站点身份（ZLQ-190 §7 D5）。
 *
 * 只在**构建期**的 Server Component 里调用：`output: 'export'` 下页面在 `next build` 时
 * 于 Node 中预渲染，因此这里可以用 `git` 与环境变量，而产物里只剩下已经算好的字符串。
 * 客户端 bundle 不包含本模块（`src/index.ts` 与任何 `'use client'` 组件都不 import 它）。
 *
 * 取值顺序（§7：Vercel 用 `VERCEL_GIT_COMMIT_SHA`，本地构建回落到当前 Git HEAD）：
 *
 * 1. `VERCEL_GIT_COMMIT_SHA` —— Vercel 为 git 关联项目注入，指向**正在构建的那个提交**。
 *    大小写不敏感（先归一成小写再校验）。**一旦该变量非空就以它为准**：它存在但格式不对
 *    时直接抛错，不回落到第 2 步 —— 回落等于用一个没人批准的提交号顶替平台给的那个。
 * 2. `git rev-parse HEAD` —— 仅当第 1 步的变量**缺席或为空**时，本地构建走这条；
 * 3. 都拿不到就**抛错**，不写 `'unknown'`。
 *
 * 第 3 条是刻意的失败关闭：法务页必须展示真实提交号，一个占位字符串会让 e2e 与发布门禁
 * 在「源码入口其实没接通」的情况下照样变绿 —— 那正是 §7 要防的事。
 *
 * `NEXT_PUBLIC_LITTLEQ_SOURCE_URL` 是**非机密**的可选构建变量，供合规 fork 指向自己的
 * 仓库；官方部署不需要任何环境变量。它必须是 http(s) URL，否则抛错 —— 直接拼进
 * `<a href>` 的值不做校验就等于给 `javascript:` 留了口子。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SOURCE_URL = 'https://github.com/kunlun322/littleq';

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * 向上找仓库根。
 *
 * 不用「相对本文件固定层数」：本文件既可能以源码形态执行（Next / vitest），也可能以
 * `dist/src/build-info.js` 形态执行，两者的层数不一样。`pnpm-workspace.yaml` 只存在于根。
 */
export function findRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`从 ${startDir} 向上找不到 pnpm-workspace.yaml，无法定位仓库根`);
    }
    current = parent;
  }
}

export interface BuildInfo {
  /** 完整提交号（40 位）。法务页展示的就是它。 */
  readonly commitSha: string;
  readonly shortCommitSha: string;
  /** 构建版本号：`<根 package.json 的 version>+<短提交号>`。 */
  readonly version: string;
  /** 仓库地址。官方部署为 `DEFAULT_SOURCE_URL`。 */
  readonly sourceUrl: string;
  /** 指向**这次构建对应提交**的源码地址，不是浮动的 `main`。 */
  readonly commitUrl: string;
  /** 该提交下法务页文件的源码地址。 */
  readonly commitTreeUrl: string;
}

export function resolveCommitSha(env: NodeJS.ProcessEnv = process.env): string {
  const fromVercel = env['VERCEL_GIT_COMMIT_SHA']?.trim() ?? '';
  if (fromVercel !== '') {
    // 先归一再校验。大小写不是提交号的一部分，而 COMMIT_SHA_PATTERN 只认小写十六进制：
    // 拿原始值直接去匹配，一个大写的合法值会被当成「没设置」而回落到本机 git HEAD ——
    // 在 Vercel 上那会让法务页展示**另一个提交**的源码链接，正是 §7 要防的失效形态。
    const normalized = fromVercel.toLowerCase();
    if (!COMMIT_SHA_PATTERN.test(normalized)) {
      // 变量已设定却不可用时**不回落到 git**：回落等于用一个没人批准的提交号顶替
      // 平台给的那个，而失败关闭是本模块既有的口径（拿不到就抛错，不写 'unknown'）。
      throw new Error(
        `VERCEL_GIT_COMMIT_SHA 不是合法提交号：${fromVercel}。` +
          '该变量已设定，因此不回落到本机 git HEAD —— 回落会让法务页指向另一个提交。',
      );
    }
    return normalized;
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: findRepoRoot(dirname(fileURLToPath(import.meta.url))),
    }).trim();
    if (COMMIT_SHA_PATTERN.test(head)) return head.toLowerCase();
  } catch {
    // 落到下面的统一失败关闭分支。
  }
  throw new Error(
    '无法确定构建提交号：VERCEL_GIT_COMMIT_SHA 未设置且 git rev-parse HEAD 不可用。' +
      '法务页必须展示真实提交号，因此构建在此失败，而不是渲染一个占位字符串。',
  );
}

export function resolveSourceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['NEXT_PUBLIC_LITTLEQ_SOURCE_URL'];
  if (configured === undefined || configured.trim() === '') return DEFAULT_SOURCE_URL;
  let url: URL;
  try {
    url = new URL(configured.trim());
  } catch {
    throw new Error(`NEXT_PUBLIC_LITTLEQ_SOURCE_URL 不是合法 URL：${configured}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `NEXT_PUBLIC_LITTLEQ_SOURCE_URL 只允许 http(s)，收到 ${url.protocol}（该值会直接进 <a href>）`,
    );
  }
  // 去掉尾部斜杠，避免拼出 `//commit/…`。
  return url.toString().replace(/\/+$/, '');
}

export function readRepoVersion(repoRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

export function resolveBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const commitSha = resolveCommitSha(env);
  const sourceUrl = resolveSourceUrl(env);
  const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const shortCommitSha = commitSha.slice(0, 7);
  return {
    commitSha,
    shortCommitSha,
    version: `${readRepoVersion(repoRoot)}+${shortCommitSha}`,
    sourceUrl,
    commitUrl: `${sourceUrl}/commit/${commitSha}`,
    commitTreeUrl: `${sourceUrl}/tree/${commitSha}`,
  };
}

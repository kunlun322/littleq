/**
 * 构建期站点身份（ZLQ-190 §7 D5）。
 *
 * 只在**服务端**的 Server Component 里调用：ZLQ-232 起 `apps/web` 是服务构建，静态页在
 * `next build` 时于 Node 中预渲染、动态页在请求时于 Node 中渲染。客户端 bundle 不包含本
 * 模块（`src/index.ts` 与任何 `'use client'` 组件都不 import 它）。
 *
 * ⚠️ **这两条路径能拿到的事实不一样**，ZLQ-237 之前本文件把它们当成一样的：
 *
 * - 构建期（`○` 静态页预渲染）跑在**构建机**上，整棵仓库树都在，`git`、`pnpm-workspace.yaml`、
 *   根 `package.json` 都读得到；
 * - 请求期（`ƒ` 动态页，如 `/create`）跑在 **Vercel 函数产物**里，只有 node-file-trace 追出来的
 *   那些文件。仓库根**不在**产物里，`git` 也不在。
 *
 * 所以请求期唯一能依赖的两样东西是：**平台注入的环境变量**，与**构建期就被打包器内联成字面量
 * 的值**。版本号因此改成静态 import 根 manifest（下方 `inlinedRepoVersion`）—— 打包器在构建机
 * 上把它折成字符串字面量，请求期不再碰文件系统。提交号本来就来自环境变量，不受影响。
 *
 * 为什么不能用「`findRepoRoot` 失败时兜个常量」来修：`import.meta.url` 被 Turbopack 编译成
 * `a.F("apps/web/src/build-info.ts")`，即**相对运行时根**解析，在函数里就是 `/var/task/apps/web/src`。
 * 那条向上查找在函数产物里**必然**走到文件系统根再抛错；给它加兜底等于把一个请求期的文件系统
 * 依赖藏进 catch 里，而下面第 3 条的失败关闭正是本文件的设计核心，不能被绕开。
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

// 构建期内联（见文件头）。Turbopack 的 JSON 模块**只暴露 default**（具名 import 会在
// `next build` 时报 `The export version was not found … Did you mean to import default?`），
// 所以这里取默认导出再挑出 `version` 一个键。
import rootManifest from '../../../package.json' with { type: 'json' };

const inlinedRepoVersion = rootManifest.version;

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

/**
 * 从磁盘读根 manifest 的 `version`。
 *
 * ZLQ-237 之后**运行时不再走这条**（`resolveBuildInfo` 用构建期内联的那个值）：它只在
 * 构建机与测试里成立，而函数产物里没有仓库根。保留它是为了当**对账用的独立事实来源** ——
 * `apps/web/test/index.test.ts` 拿它和 `resolveBuildInfo()` 的输出逐字比，内联值与磁盘上的
 * 真值一旦漂移（比如改了 import 路径、指到别的 manifest）测试就红。
 */
export function readRepoVersion(repoRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

export function resolveBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const commitSha = resolveCommitSha(env);
  const sourceUrl = resolveSourceUrl(env);
  const shortCommitSha = commitSha.slice(0, 7);
  return {
    commitSha,
    shortCommitSha,
    // 版本号来自构建期内联的字面量，不是请求期的文件系统查找（见文件头与 readRepoVersion）。
    version: `${inlinedRepoVersion}+${shortCommitSha}`,
    sourceUrl,
    commitUrl: `${sourceUrl}/commit/${commitSha}`,
    commitTreeUrl: `${sourceUrl}/tree/${commitSha}`,
  };
}

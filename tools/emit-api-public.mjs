#!/usr/bin/env node
/**
 * 为 `apps/api` 生成部署产物里的构建身份文件 `apps/api/public/build-info.json`。
 *
 * ## 为什么这个文件存在（ZLQ-249 设计，形态 B2）
 *
 * 平台把 `apps/api` 这个项目按「静态站 + 函数」的形态构建：`apps/api/vercel.json` 的
 * `outputDirectory` 是 `null`，而 `packages/static-build/src/index.ts:448-453` 在该值为假值时
 * 用 `'public'` 兜底（源码注释原文 `// 'public' is the default for zero config`），于是构建
 * 跑完之后它去找 `<root>/public`；`:865-869` 的 `validateDistDir` 在「不存在 / 不是目录 /
 * 是空的」三种情况下抛 `STATIC_BUILD_NO_OUT_DIR`。ZLQ-247 那次发布就死在这一条上。
 *
 * 出路是让那个目录**真实存在且非空**，而不是去改 `outputDirectory` 的值：设成 `dist` /
 * `public` / `src` / `.` 都是明令禁止的（`ignore` 只在 `outputDirectory === '.'` 时才被赋值，
 * 设成 `src` 会把后端源码整个上传成公开可读）。`:895` 的
 * `glob('**', { cwd: distPath, ignore }, mountpoint)` 决定公开面**只有** `apps/api/public/**`，
 * 永远够不到 `src/**`。
 *
 * ## 为什么里面放的是版本信息而不是一个占位文件
 *
 * 它同时补上一个此前不存在的运维判据：线上跑的后端是从哪个提交构建出来的。ZLQ-247 失败时
 * 四条探测全是 404，而 404 分不清「压根没部署上」与「部署上了但接口坏了」。有了
 * `GET /build-info.json`（静态腿）配 `GET /api/v1/health/live`（函数腿），一次部署就能把
 * 这两件事彻底分开。
 *
 * ## 失败姿态
 *
 * 说不清自己是哪个版本，构建就该失败 —— ⛔ 绝不写出 `'unknown'` 之类的占位值：占位值会让
 * 「产物在、身份是假的」这种状态悄悄上线，而那正是本文件要消灭的失效形态。取值次序照抄
 * `apps/web/src/build-info.ts:87-117`：
 *
 * 1. `VERCEL_GIT_COMMIT_SHA` —— 平台为 git 关联项目注入，指向**正在构建的那个提交**。先归一
 *    成小写再校验；**一旦非空就以它为准**，格式不对直接抛，不回落到第 2 步（回落等于用一个
 *    没人批准的提交号顶替平台给的那个）。
 * 2. `git rev-parse HEAD` —— 仅当第 1 步缺席或为空白时，本地构建走这条。
 * 3. 都拿不到就抛错。
 *
 * ⚠️ 这约 15 行与 web 那份是**有意的重复，不是共享代码**：那边是 web 单元的 TypeScript，
 * `tools/*.mjs` import 不到；而平台构建后端时根本不构建 web（`pnpm --filter @littleq/api...
 * build` 只带五个 `packages/*`）。新建共享包要过依赖图、单元就绪、SBOM、许可四道门，代价
 * 远大于重复。行为一致性由 `tools/test/emit-api-public.test.mjs` 钉住。
 *
 * ## 定位仓库根：⛔ 不能用 `process.cwd()`
 *
 * 平台执行的是 `pnpm --filter @littleq/api... build`，本脚本被调用时 **cwd 是 `apps/api`**，
 * 不是仓库根（`tools/prepare-web-legal.mjs:27` 那句 `process.cwd()` 之所以成立，是因为它由
 * 仓库根的 `pnpm web:legal` 调用）。这里因此从**本文件自己的位置**向上找 `pnpm-workspace.yaml`
 * —— 与 `apps/web/src/build-info.ts:61-71` 的 `findRepoRoot` 同一个范式。vitest 下 cwd 又是
 * 仓库根 ⇒ 两条路径的 cwd 不一样，靠 cwd 的实现必然在其中一边坏掉。
 *
 * ⛔ 也绝不创建符号链接：`apps/api/test/function-entry.test.ts` 的三处遍历（`:225`、`:246`、
 * `:469`）用 `statSync`，会跟随软链，软链会让遍历行为不可预期。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 产物 schema 版本。字段集变化时递增，让读它的一方能拒绝看不懂的形状。 */
export const SCHEMA_VERSION = 1;

/** 相对仓库根的产物路径。`public/` 这一层是平台默认值决定的，不是我们选的。 */
export const OUTPUT_RELATIVE_PATH = 'apps/api/public/build-info.json';

/** 与 `apps/web/src/build-info.ts:53` 同一个断言：小写十六进制，7–64 位。 */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * 向上找仓库根。
 *
 * 不用「相对本文件固定层数」：那种写法把「本脚本住在 `tools/` 下」这条事实硬编码进路径，
 * 挪一次目录就静默指到别处。`pnpm-workspace.yaml` 只存在于根。
 */
export function findRepoRoot(startDir) {
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

/** 本脚本所在的仓库根。与 cwd 无关，见文件头「定位仓库根」一节。 */
export function repoRootOfThisScript() {
  return findRepoRoot(dirname(fileURLToPath(import.meta.url)));
}

export function readRepoVersion(repoRoot) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const version = manifest.version;
  // ⛔ 不学 `apps/web/src/build-info.ts:149` 的 `'0.0.0'` 兜底：根 manifest 的 version
  // 本来**就是** `0.0.0`，兜底值与真值逐字相同 ⇒ 一次「读不到 version」的失效会产出一个
  // 看起来完全正常的产物。读不到就抛。
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`仓库根 package.json 没有可用的 version（收到 ${JSON.stringify(version)}）`);
  }
  return version;
}

export function resolveCommitSha(env, repoRoot = repoRootOfThisScript()) {
  const fromVercel = env['VERCEL_GIT_COMMIT_SHA']?.trim() ?? '';
  if (fromVercel !== '') {
    // 先归一再校验：大小写不是提交号的一部分，而 COMMIT_SHA_PATTERN 只认小写十六进制。
    // 拿原始值直接匹配，一个大写的合法值会被当成「没设置」而回落到本机 git HEAD ——
    // 在平台上那会让产物声称自己是**另一个提交**。
    const normalized = fromVercel.toLowerCase();
    if (!COMMIT_SHA_PATTERN.test(normalized)) {
      throw new Error(
        `VERCEL_GIT_COMMIT_SHA 不是合法提交号：${fromVercel}。` +
          '该变量已设定，因此不回落到本机 git HEAD —— 回落会让产物声称自己是另一个提交。',
      );
    }
    return normalized;
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: repoRoot,
      // git 失败时那句 `fatal: not a git repository` 对构建日志没有信息量（下面那条抛错
      // 才说明问题），所以只留 stdout。
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (COMMIT_SHA_PATTERN.test(head)) return head.toLowerCase();
  } catch {
    // 落到下面的统一失败关闭分支。
  }
  throw new Error(
    '无法确定构建提交号：VERCEL_GIT_COMMIT_SHA 未设置且 git rev-parse HEAD 不可用。' +
      '构建身份必须是真的，因此构建在此失败，而不是写一个占位字符串。',
  );
}

/**
 * 组装产物内容。**键集是白名单式硬编码**，⛔ 不从 `env` 批量取键。
 *
 * 这个文件会被公开服务，任何一次「顺手多带一个字段」都是把内部事实发到公网。
 */
export function buildPayload({ env, repoRoot = repoRootOfThisScript() }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: readRepoVersion(repoRoot),
    commitSha: resolveCommitSha(env, repoRoot),
    // 取不到就是 JSON null：⛔ 不写 'unknown'、⛔ 不猜 'production'。
    vercelEnv: env['VERCEL_ENV'] ?? null,
  };
}

/**
 * 写出产物。`outFile` 只为测试可注入（与 `tools/check-web-export.mjs` 的 `runGate({repoRoot})`
 * 同一套路）；生产路径不传它，落在 `repoRoot` + `OUTPUT_RELATIVE_PATH`。
 */
export function emitBuildInfo({
  env = process.env,
  repoRoot = repoRootOfThisScript(),
  outFile,
} = {}) {
  const target = outFile === undefined ? join(repoRoot, OUTPUT_RELATIVE_PATH) : outFile;
  const payload = buildPayload({ env, repoRoot });
  // 目录必须在这里建：平台校验的正是「目录存在且非空」，少这一行就是 STATIC_BUILD_NO_OUT_DIR。
  mkdirSync(dirname(target), { recursive: true });
  // 2 空格缩进 + 末尾换行 = prettier 对 JSON 的排版（`.prettierrc.json` 的 tabWidth 2 与
  // endOfLine 'lf'）。生成物**不在** `.prettierignore` 里，而 prettier 不读 `.gitignore`
  // ⇒ 本地构建过一次之后再跑 `pnpm format:check` 会读到它。让它天生就是干净的，比去动
  // 第五个文件（`.prettierignore`）的改动面更小。
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(target, bytes, 'utf8');
  return { outFile: target, bytes, payload };
}

function main() {
  const repoRoot = repoRootOfThisScript();
  const { outFile, bytes, payload } = emitBuildInfo({ repoRoot });
  process.stdout.write(
    `api build-info: ${relative(repoRoot, outFile)}` +
      `（${Buffer.byteLength(bytes, 'utf8')} 字节，commit ${payload.commitSha.slice(0, 7)}，` +
      `env ${payload.vercelEnv ?? '未注入'}）\n`,
  );
}

/**
 * 本文件是否被**直接执行**（而不是被测试 import）。
 *
 * 两侧都要过 `realpathSync`：Node 解析模块 URL 时会展开符号链接，而 `process.argv[1]` 保留
 * 调用者给出的字面路径。不展开就比较，在路径穿过软链的环境里（macOS 的 `/tmp` 与 `/var`
 * 都指向 `/private/…`）两边不相等 ⇒ 脚本判定「我不是被直接执行的」⇒ **退出码 0 而什么都不写**。
 * 那是最坏的失效形态：构建全绿，`public/` 却没有生成，而本文件存在的唯一理由就是让它生成。
 */
function invokedDirectly() {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // argv[1] 不存在（例如 `node -e` / REPL）⇒ 不是直接执行。
    return false;
  }
}

if (invokedDirectly()) main();

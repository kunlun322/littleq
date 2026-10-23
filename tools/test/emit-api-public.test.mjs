// tools/emit-api-public.mjs 的测试与变异对照（ZLQ-249 设计 §四 改动 3，强制项）。
//
// ## 为什么这个文件是**强制**的，不是可选的
//
// 仓库根 `package.json` 的 `build` 是 `tsc -b tsconfig.json && pnpm web:build`，它**从不调用**
// `apps/api` 的 `scripts.build`（`apps/api/dist` 是 TypeScript 项目引用编出来的，不是那条 npm
// 脚本产出的）⇒ `verify` 的 18 段里没有任何一段会执行发射器。不补测试，发射器坏了只会在平台
// 上暴露 —— 那正是 ZLQ-247 那次事故的模式。
//
// 位置也**不需要**改仓库根 `package.json`：`vitest.config.ts:47` 的 `include` 已经有
// `'tools/test/**/*.test.mjs'` ⇒ 第 18 段 `test` 自动覆盖。同类先例是
// `tools/test/web-export-check.test.mjs`。
//
// ## 为什么全部跑在临时造的假仓库里
//
// 三处必须与真实工作树隔离：
//
// 1. **cwd 无关性**（设计里的「坑 1」）要证明的是「cwd ≠ 仓库根时仍写对路径」。假仓库让我们
//    能把 cwd 摆到 `<假根>/apps/api`，并断言产物落在 `<假根>/apps/api/public/` —— 而一个用
//    `process.cwd()` 的实现会把它写到 `<假根>/apps/api/apps/api/public/`，当场就红。
// 2. **失败关闭**要证明「git 也拿不到时抛错」。假仓库不是 git 仓库 ⇒ `git rev-parse HEAD`
//    必然失败，不需要去 mock 子进程。
// 3. vitest 是并行跑文件的，而 `apps/api/test/function-entry.test.ts` 有三处**遍历真实工作树**
//    的门禁。测试往真实 `apps/api/public/` 里写文件，等于让两件事产生时序耦合。
//
// ⚠️ 假仓库里那份 `tools/emit-api-public.mjs` 是从真实路径**逐字节复制**过去的，不是替身：
// 所以下面每一条断言测的都是要交付的那份源码，改坏它测试就红。
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';
import { afterAll, describe, expect, it } from 'vitest';

import {
  COMMIT_SHA_PATTERN,
  OUTPUT_RELATIVE_PATH,
  SCHEMA_VERSION,
  buildPayload,
  emitBuildInfo,
  findRepoRoot,
  readRepoVersion,
  resolveCommitSha,
} from '../emit-api-public.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(HERE);
const SCRIPT_RELATIVE = join('tools', 'emit-api-public.mjs');
const SCRIPT_PATH = join(REPO_ROOT, SCRIPT_RELATIVE);

/** 键集与顺序都钉住：`toEqual` 对数组是逐元素比较，多一键、少一键、换个顺序都红。 */
const KEY_SET = ['schemaVersion', 'version', 'commitSha', 'vercelEnv'];

/** 一个合法的 40 位小写十六进制提交号（形状合法，内容不是真实提交）。 */
const FAKE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const tempDirs = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 造一棵**不是 git 仓库**的假仓库根：`pnpm-workspace.yaml`（供 findRepoRoot 认根）、
 * 根 `package.json`（供 readRepoVersion）、以及逐字节复制过去的发射器本体。
 *
 * `version` 刻意取 `9.9.9` 而不是真仓库的 `0.0.0`：这样「读的是假仓库的 manifest」与
 * 「读到了别处的真 manifest」在断言里可分辨 —— 一个把仓库根算错的实现会写出 `0.0.0`。
 */
function makeFakeRepo({ version = '9.9.9', writeVersion = true } = {}) {
  const root = makeTempDir('lq-emit-api-');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf8');
  const manifest = { name: 'fake-root', private: true };
  if (writeVersion) manifest.version = version;
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  mkdirSync(join(root, 'tools'), { recursive: true });
  mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  copyFileSync(SCRIPT_PATH, join(root, SCRIPT_RELATIVE));
  return root;
}

/** 以 `cwd = <假根>/apps/api` 执行真实脚本，即平台执行 `pnpm --filter @littleq/api... build` 时的 cwd。 */
function runScript(fakeRoot, env) {
  return spawnSync(process.execPath, [join(fakeRoot, SCRIPT_RELATIVE)], {
    cwd: join(fakeRoot, 'apps', 'api'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
}

/** 真实仓库的 HEAD。用作「回落到 git 是可行的」这个阳性对照。 */
function realHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

describe('产物形状：白名单四键，值不掺假', () => {
  it('键集与顺序恰好是 schema 那四个', () => {
    const payload = buildPayload({
      env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA, VERCEL_ENV: 'production' },
      repoRoot: REPO_ROOT,
    });
    expect(Object.keys(payload)).toEqual(KEY_SET);
    // 阳性对照：上面那条 `toEqual` 不是恒真的 —— 它对「多一个键」与「换一个顺序」都敏感。
    // 少了这两条，一个恒返回 KEY_SET 的实现（比如直接吐一份写死的对象）也能糊过去。
    expect(Object.keys(payload)).not.toEqual([...KEY_SET, 'provider']);
    expect(Object.keys(payload)).not.toEqual([...KEY_SET].reverse());
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Number.isInteger(payload.schemaVersion)).toBe(true);
    expect(payload.version).toBe(readRepoVersion(REPO_ROOT));
    expect(payload.commitSha).toBe(FAKE_SHA);
    expect(payload.vercelEnv).toBe('production');
  });

  it('大写的合法提交号被归一成小写（大小写不是提交号的一部分）', () => {
    const payload = buildPayload({
      env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA.toUpperCase() },
      repoRoot: REPO_ROOT,
    });
    expect(payload.commitSha).toBe(FAKE_SHA);
    expect(COMMIT_SHA_PATTERN.test(payload.commitSha)).toBe(true);
  });

  it('VERCEL_ENV 缺席时 vercelEnv 是 JSON null，不是字符串占位', () => {
    const payload = buildPayload({ env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA }, repoRoot: REPO_ROOT });
    expect(payload.vercelEnv).toBeNull();
    const bytes = JSON.stringify(payload, null, 2);
    expect(bytes).toContain('"vercelEnv": null');
    expect(bytes.toLowerCase()).not.toContain('unknown');
  });

  it('产物里不出现 provider / 配置 / 环境变量的字样（它是公开可下载的）', () => {
    const fakeRoot = makeFakeRepo();
    const { outFile, bytes } = emitBuildInfo({
      repoRoot: fakeRoot,
      env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA, VERCEL_ENV: 'production' },
    });
    expect(existsSync(outFile)).toBe(true);
    for (const banned of [
      'provider',
      'providerConfiguration',
      'scanConfiguration',
      'LQ_API_ORIGIN',
    ]) {
      expect(bytes, `产物里出现了 ${banned}`).not.toContain(banned);
    }
    // 对照：发射器**确实**把四个键都写出来了，所以上面那四个 not.toContain 不是
    // 因为文件是空的才成立的。
    expect(Object.keys(JSON.parse(readFileSync(outFile, 'utf8')))).toEqual(KEY_SET);
  });

  it('version 取仓库根 manifest；manifest 里没有可用 version 时抛错，⛔ 不编占位值', () => {
    expect(readRepoVersion(REPO_ROOT)).toBe(
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version,
    );
    const noVersion = makeFakeRepo({ writeVersion: false });
    // 为什么不学 apps/web/src/build-info.ts:149 的 '0.0.0' 兜底：真仓库根 manifest 的 version
    // **就是** 0.0.0，兜底值与真值逐字相同 ⇒ 一次读不到的失效会产出一个看起来完全正常的产物。
    expect(() => readRepoVersion(noVersion)).toThrow(/没有可用的 version/);
    expect(() =>
      emitBuildInfo({ repoRoot: noVersion, env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA } }),
    ).toThrow(/没有可用的 version/);
  });
});

describe('commitSha 的失败关闭（次序照抄 apps/web/src/build-info.ts:87-117）', () => {
  // 畸形值清单。每一项都是「非空 ⇒ 以它为准 ⇒ 校验 ⇒ 抛」这条路上必须拦住的形状。
  const MALFORMED = [
    'not-a-sha',
    'zzzzzzz', // 7 位但没有一位是十六进制
    'abc12', // 合法字符但只有 5 位（下界是 7）
    '0123456789abcdef'.repeat(5), // 80 位，超上界 64
    "deadbeef'", // 带引号：注入形状
    'HEAD', // git 的符号名，不是提交号
  ];

  it('VERCEL_GIT_COMMIT_SHA 存在但畸形 ⇒ 抛错，且**不回落**到 git', () => {
    // 阳性对照（这条是整组的地基）：在**真实仓库**里 git 回落是**可行**的。
    // 所以下面每一次抛错都只可能是「按设计拒绝回落」，不可能是「git 本来也拿不到」。
    const head = realHead();
    expect(COMMIT_SHA_PATTERN.test(head)).toBe(true);
    expect(resolveCommitSha({}, REPO_ROOT)).toBe(head.toLowerCase());

    for (const bad of MALFORMED) {
      let message = '';
      try {
        resolveCommitSha({ VERCEL_GIT_COMMIT_SHA: bad }, REPO_ROOT);
      } catch (error) {
        message = error.message;
      }
      // 报的是「这个变量不合法」，不是「两个来源都缺」—— 两条抛错必须可分辨，
      // 否则一次回落会被后一条消息盖住。
      expect(message, `畸形值 ${JSON.stringify(bad)} 没有抛错`).toContain('VERCEL_GIT_COMMIT_SHA');
      expect(message).toContain('不回落到本机 git HEAD');
      expect(message.toLowerCase()).not.toContain('unknown');
    }
  });

  it('空白-only 的 VERCEL_GIT_COMMIT_SHA 视同缺席，回落到 git HEAD（与 web 那份同语义）', () => {
    expect(resolveCommitSha({ VERCEL_GIT_COMMIT_SHA: '   ' }, REPO_ROOT)).toBe(
      realHead().toLowerCase(),
    );
  });

  it('两个来源都缺 ⇒ 抛错，且**一个字节的产物都不留**', () => {
    const fakeRoot = makeFakeRepo(); // 不是 git 仓库 ⇒ 第 2 步必然失败
    let message = '';
    try {
      resolveCommitSha({}, fakeRoot);
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('无法确定构建提交号');
    // 「产出的不是 'unknown'」的最强形式：压根没有产出。占位值之所以危险，正是因为它
    // 会让一个身份是假的产物**存在**并通过所有只看存在性的检查。
    expect(message.toLowerCase()).not.toContain('unknown');
    const outFile = join(fakeRoot, OUTPUT_RELATIVE_PATH);
    expect(() => emitBuildInfo({ repoRoot: fakeRoot, env: {} })).toThrow(/无法确定构建提交号/);
    expect(existsSync(outFile)).toBe(false);
  });

  it('子进程里同样失败关闭：退出码非 0，stderr 点名两个来源，且没有写出文件', () => {
    const fakeRoot = makeFakeRepo();
    const result = runScript(fakeRoot, {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('无法确定构建提交号');
    expect(existsSync(join(fakeRoot, OUTPUT_RELATIVE_PATH))).toBe(false);
  });
});

describe('坑 1：cwd 不是仓库根（平台跑的是 pnpm --filter @littleq/api... build）', () => {
  it('从 <假根>/apps/api 作为 cwd 执行，产物仍落在 <假根>/apps/api/public/', () => {
    const fakeRoot = makeFakeRepo({ version: '9.9.9' });
    const result = runScript(fakeRoot, {
      VERCEL_GIT_COMMIT_SHA: FAKE_SHA,
      VERCEL_ENV: 'production',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const outFile = join(fakeRoot, OUTPUT_RELATIVE_PATH);
    expect(existsSync(outFile), `产物没有落在 ${OUTPUT_RELATIVE_PATH}`).toBe(true);
    const written = JSON.parse(readFileSync(outFile, 'utf8'));
    // 版本来自**假根**的 manifest：证明仓库根是从脚本自己的位置算出来的，
    // 不是从 cwd、也不是从某个真实路径硬编码来的。
    expect(written.version).toBe('9.9.9');
    expect(written.commitSha).toBe(FAKE_SHA);
    expect(written.vercelEnv).toBe('production');
    expect(written.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.stdout).toContain('api build-info:');

    // ⛔ 这条是「用 process.cwd() 实现」的变异探测器：那样会把仓库根当成 apps/api，
    // 于是产物落到 <假根>/apps/api/apps/api/public/。
    expect(existsSync(join(fakeRoot, 'apps', 'api', 'apps'))).toBe(false);
  });

  it('经符号链接路径直接执行同样会跑 main()（否则脚本会静默什么都不做）', () => {
    // 「是否被直接执行」若用 `process.argv[1]` 与 `fileURLToPath(import.meta.url)` 比字面量，
    // 在路径穿过软链时两边不等（Node 解析模块 URL 会展开软链，argv[1] 保留字面路径）
    // ⇒ 脚本判定自己是被 import 的 ⇒ **退出码 0 且不写任何文件**。构建全绿而 public/ 没生成，
    // 正是本文件要消灭的那个失效形态。
    //
    // 软链是这里**自己造**的，不靠平台：macOS 的 /tmp 与 /var 指向 /private/…，而 Linux 的
    // /tmp 通常是真目录 —— 靠 os.tmpdir() 是否穿过软链来武装这条臂，会在其中一个平台上空转。
    const fakeRoot = makeFakeRepo();
    const holder = makeTempDir('lq-emit-link-');
    const viaSymlink = join(holder, 'repo');
    symlinkSync(fakeRoot, viaSymlink, 'dir');
    // 对照：这条路径确实穿过软链，否则下面那条绿只证明「没有软链要穿」。
    expect(realpathSync(viaSymlink)).toBe(realpathSync(fakeRoot));
    expect(viaSymlink).not.toBe(realpathSync(viaSymlink));

    const result = spawnSync(process.execPath, [join(viaSymlink, SCRIPT_RELATIVE)], {
      cwd: join(viaSymlink, 'apps', 'api'),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', VERCEL_GIT_COMMIT_SHA: FAKE_SHA },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('api build-info:');
    // 产物落在软链**背后**的真目录里：脚本从自己模块的真身位置认根，与调用路径无关。
    expect(existsSync(join(fakeRoot, OUTPUT_RELATIVE_PATH))).toBe(true);
  });

  it('findRepoRoot 靠 pnpm-workspace.yaml 认根，不靠固定层数', () => {
    expect(findRepoRoot(join(REPO_ROOT, 'apps', 'api', 'src'))).toBe(REPO_ROOT);
    expect(findRepoRoot(join(REPO_ROOT, 'tools', 'test'))).toBe(REPO_ROOT);
    const fakeRoot = makeFakeRepo();
    expect(findRepoRoot(join(fakeRoot, 'apps', 'api'))).toBe(fakeRoot);
    // 认根的依据没了就抛，⛔ 不兜底成 cwd 或某个常量。
    const bare = makeTempDir('lq-emit-bare-');
    expect(() => findRepoRoot(bare)).toThrow(/pnpm-workspace\.yaml/);
  });
});

describe('公开面：目录里恰好只有那一个文件', () => {
  it('产出目录非空，且清单恰好为 [build-info.json]', () => {
    const fakeRoot = makeFakeRepo();
    emitBuildInfo({ repoRoot: fakeRoot, env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA } });
    const publicDir = dirname(join(fakeRoot, OUTPUT_RELATIVE_PATH));
    const listing = readdirSync(publicDir).sort();
    expect(listing).not.toEqual([]);
    expect(listing).toEqual(['build-info.json']);
    // 阳性对照：这条断言对「多一个文件」敏感。它同时是
    // apps/api/test/function-entry.test.ts:217-234 那条「全仓恰好两份 vercel.json」门禁的
    // 守卫 —— 那个遍历**不跳过** public/，只匹配 name === 'vercel.json'，所以这里一旦
    // 多出一名为 vercel.json 的文件，那条门禁就会红。
    writeFileSync(join(publicDir, 'vercel.json'), '{}\n', 'utf8');
    expect(readdirSync(publicDir).sort()).not.toEqual(['build-info.json']);
  });

  it('写入前必须建目录：目标目录不存在时也能写出（去掉 mkdirSync 这条就红）', () => {
    const fakeRoot = makeFakeRepo();
    const outFile = join(fakeRoot, OUTPUT_RELATIVE_PATH);
    // 对照：这条臂确实是武装的 —— 调用前 public/ 不存在。
    expect(existsSync(dirname(outFile))).toBe(false);
    emitBuildInfo({ repoRoot: fakeRoot, env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA } });
    expect(existsSync(outFile)).toBe(true);
    // 平台校验的是「存在且非空」（validateDistDir 的第三个抛错条件是空目录）。
    expect(readFileSync(outFile, 'utf8').length).toBeGreaterThan(0);
  });

  it('outFile 注入到多层不存在的路径时同样能写出（mkdirSync 的 recursive 是承重的）', () => {
    const fakeRoot = makeFakeRepo();
    const outFile = join(fakeRoot, 'apps', 'api', 'public', 'nested', 'build-info.json');
    expect(existsSync(dirname(outFile))).toBe(false);
    const result = emitBuildInfo({
      repoRoot: fakeRoot,
      env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA },
      outFile,
    });
    expect(result.outFile).toBe(outFile);
    expect(existsSync(outFile)).toBe(true);
  });
});

describe('与既有门禁的耦合（两处遍历都会读到这份新公开文件）', () => {
  it('产物不匹配 function-entry.test.ts:243 那条 LQ_API_ORIGIN 零命中门的读取形态', () => {
    // 与 :243 逐字同一个正则：它匹配的是**读取形态**（带引号的键名 / 属性访问），不是裸标识符。
    const READ_FORM = /['"[.]LQ_API_ORIGIN/;
    const fakeRoot = makeFakeRepo();
    const { outFile, bytes } = emitBuildInfo({
      repoRoot: fakeRoot,
      env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA, VERCEL_ENV: 'production' },
    });
    expect(READ_FORM.test(bytes)).toBe(false);
    expect(READ_FORM.test(readFileSync(outFile, 'utf8'))).toBe(false);
    // 四个阳性对照，与 :258-265 同源：证明这个正则真的抓得住东西，上面那两个 false 不是假绿。
    expect(READ_FORM.test(readFileSync(join(REPO_ROOT, 'apps/web/src/api-proxy.ts'), 'utf8'))).toBe(
      true,
    );
    expect(READ_FORM.test("process.env['LQ_API_ORIGIN']")).toBe(true);
    expect(READ_FORM.test('env.LQ_API_ORIGIN')).toBe(true);
    expect(READ_FORM.test('const key = "LQ_API_ORIGIN";')).toBe(true);
  });

  it('产物是 prettier 的不动点 ⇒ format:check 不会去改这份生成物', async () => {
    // 生成物**不在** .prettierignore 里，而 prettier 不读 .gitignore ⇒ 本地构建过一次之后
    // 再跑 `pnpm format:check` 会读到它。让它天生干净，比去动第五个文件改动面更小。
    const absolute = join(REPO_ROOT, OUTPUT_RELATIVE_PATH);
    const info = await prettier.getFileInfo(absolute, {
      ignorePath: join(REPO_ROOT, '.prettierignore'),
    });
    // 对照：getFileInfo 不是永远返回 ignored:true（与 tools/test/contract-hygiene.test.mjs 同一条对照）。
    expect(info.ignored).toBe(false);
    expect(info.inferredParser).toBe('json');

    const config = (await prettier.resolveConfig(absolute)) ?? {};
    const options = { ...config, parser: 'json' };
    const fakeRoot = makeFakeRepo();
    const { bytes } = emitBuildInfo({
      repoRoot: fakeRoot,
      env: { VERCEL_GIT_COMMIT_SHA: FAKE_SHA, VERCEL_ENV: 'production' },
    });
    expect(await prettier.format(bytes, options)).toBe(bytes);
    // 对照：prettier 在这套 options 下不是恒等函数，所以上面那条 `toBe(bytes)` 有鉴别力。
    const misIndented = '{\n"a": 1\n}\n';
    expect(await prettier.format(misIndented, options)).not.toBe(misIndented);
  });
});

describe('调用面：apps/api 的 build 脚本用 && 显式串联', () => {
  it('scripts.build 是 `tsc -b && node ../../tools/emit-api-public.mjs`，且没有 postbuild', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/api', 'package.json'), 'utf8'));
    expect(manifest.scripts.build).toBe(
      `tsc -b && node ../../${SCRIPT_RELATIVE.replaceAll('\\', '/')}`,
    );
    // ⛔ 不许换成 postbuild：pnpm 的 enable-pre-post-scripts 默认关闭，而本仓库没有任何地方
    // 打开它（.npmrc 只有 registry 与注释，pnpm-workspace.yaml 只有 packages 与 overrides）
    // ⇒ postbuild 会**静默不执行**，本地用 npm 试还可能「看起来是对的」。
    expect(manifest.scripts.postbuild).toBeUndefined();
    // 对照：tsc -b 仍在前面，所以 dist/ 先于发射器产出（:175-189 那条钉住依赖 dist 存在）。
    expect(manifest.scripts.build.startsWith('tsc -b')).toBe(true);
    expect(manifest.scripts.migrate).toBe('tsc -b && node dist/bootstrap/migrate.js');
  });
});

describe('.gitignore 的那条规则是**锚定**的', () => {
  /**
   * `git check-ignore -v` 的一行是 `<来源>:<行号>:<规则>\t<路径名>`。
   *
   * ⚠️ 规则自己可能含 `:`，所以只切前两个 `:`，剩下的原样拼回去当规则。
   * 退出码 0 = 被忽略，1 = 没被忽略（此时 stdout 为空）。
   */
  function checkIgnore(relativePath) {
    const result = spawnSync('git', ['check-ignore', '-v', relativePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const [meta, pathname = ''] = result.stdout.trim().split('\t');
    const [source = '', line = '', ...patternParts] = (meta ?? '').split(':');
    return {
      status: result.status,
      source,
      line,
      pattern: patternParts.join(':'),
      pathname,
    };
  }

  it('apps/api/public/ 被忽略，且生效的规则就是那条锚定写法', () => {
    const verdict = checkIgnore(OUTPUT_RELATIVE_PATH);
    expect(verdict.status).toBe(0);
    expect(verdict.pattern).toBe('apps/api/public/');
    expect(verdict.source).toBe('.gitignore');
    // 阳性对照：解析本身是对的 —— 否则上面两条可能只是在比两个空串。
    // 行号必须是个正整数，且回显的路径名就是问它的那个。
    expect(Number.parseInt(verdict.line, 10)).toBeGreaterThan(0);
    expect(verdict.pathname).toBe(OUTPUT_RELATIVE_PATH);
  });

  it('锚定的对照：别处同名的 public/ 不受这条规则影响', () => {
    // 这一条就是「必须锚定」的变异探测器。若把规则写成不带路径的 `public/`，
    // git 会在**任意层级**匹配，于是下面这条会返回 0（被忽略）⇒ 测试变红。
    expect(checkIgnore(join('notes', 'public', 'build-info.json')).status).toBe(1);
    expect(checkIgnore(join('apps', 'api', 'publicx', 'build-info.json')).status).toBe(1);
    // 既有的两条 web 规则各自由自己那条负责，没被新规则接管。
    expect(checkIgnore(join('apps', 'web', 'public', 'licenses.txt')).pattern).toBe(
      'apps/web/public/licenses.txt',
    );
  });
});

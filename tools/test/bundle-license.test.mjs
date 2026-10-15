// ZLQ-153 §10.2 / §10.3「构建产物必须保留 /*! @license */ 注释」的断言测试。
//
// 为什么不能直接拿真实 web bundle 断言：当前依赖集里没有任何一个包在发行产物中携带法务注释
// （zod 的 dist 一条 @license 都没有），于是「法务注释被保留了」是一条 0 进 0 出的空断言 ——
// 把 legalComments 改成 'none' 它照样通过。所以这里做三件事：
//   1. 用一个**确实带法务注释**的假包（tools/__fixtures__/bundle-license）把机制本身测出来；
//   2. 用同一份输入跑 legalComments:'none' 作为反事实对照，证明本测试有能力失败；
//   3. 断言对象取自 tools/esbuild-config.mjs —— 也就是 tools/build-bundles.mjs 用的那份配置，
//      测试因此无法与生产配置漂移。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createBundleOptions,
  createWorkspaceAlias,
  LEGAL_COMMENTS,
  WEB_BUNDLE_BANNER,
} from '../esbuild-config.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE_ENTRY = join(REPO_ROOT, 'tools', '__fixtures__', 'bundle-license', 'entry.ts');
const BUNDLES_DIR = join(REPO_ROOT, 'artifacts', 'bundles');
const BUNDLE_SCAN = join(REPO_ROOT, 'tools', 'license', 'bundle-scan.mjs');

const workdir = mkdtempSync(join(tmpdir(), 'lq-bundle-license-'));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

let buildIndex = 0;

async function buildFixture(overrides = {}) {
  const outfile = join(workdir, `fixture-${(buildIndex += 1)}.js`);
  await build({
    ...createBundleOptions({
      entryPoint: FIXTURE_ENTRY,
      outfile,
      alias: createWorkspaceAlias(REPO_ROOT),
    }),
    ...overrides,
    outfile,
  });
  return readFileSync(outfile, 'utf8');
}

describe('生产 bundle 配置显式声明保留法务注释', () => {
  it("LEGAL_COMMENTS 是 'inline'，且 createBundleOptions 同时开着 minify", () => {
    // 'eof' 会把注释挪到文件末尾且不保证 /*! 前缀原样；'linked'/'external' 抽到旁文件，
    // 产物本身不含声明。三者里只有 'inline' 满足 §10.2「产物内联保留」。
    expect(LEGAL_COMMENTS).toBe('inline');
    const options = createBundleOptions({
      entryPoint: FIXTURE_ENTRY,
      outfile: join(workdir, 'x.js'),
      alias: {},
    });
    expect(options.legalComments).toBe('inline');
    expect(options.minify).toBe(true);
    expect(options.bundle).toBe(true);
  });

  it('web bundle 的横幅自带 AGPL 声明与 /licenses.txt 义务说明', () => {
    expect(WEB_BUNDLE_BANNER.startsWith('/*!')).toBe(true);
    expect(WEB_BUNDLE_BANNER).toContain('SPDX-License-Identifier: AGPL-3.0-only');
    expect(WEB_BUNDLE_BANNER).toContain('/licenses.txt');
  });
});

describe('minify 之后法务注释确实活下来（正向）', () => {
  it('/*! @license */ 块逐字保留', async () => {
    const output = await buildFixture();
    expect(output.trimStart().startsWith('/*!')).toBe(true);
    expect(output).toContain('@license MIT');
    expect(output).toContain('SPDX-License-Identifier: MIT');
    expect(output).toContain('@preserve');
  });

  it('普通注释被剥离 —— 否则「注释全都保留了」也能让上面那条通过', async () => {
    const output = await buildFixture({ legalComments: 'inline' });
    expect(output).not.toContain('普通注释');
    expect(output).not.toContain('块注释同样应当被');
    // 代码本体必须还在：若 bundle 被 tree-shake 成空文件，「注释没了」也是假通过。
    expect(output).toContain('LQ_TEST_SENTINEL_FAKE');
    expect(output).toContain('LQ_TEST_SENTINEL_PLAIN');
  });

  it("反事实对照：legalComments:'none' 会把同一段法务注释吃掉", async () => {
    // 这条证明本测试有能力失败。少了它，「esbuild 无论如何都保留注释」也会全绿。
    const output = await buildFixture({ legalComments: 'none' });
    expect(output).not.toContain('@license MIT');
    expect(output).not.toContain('SPDX-License-Identifier: MIT');
    expect(output).toContain('LQ_TEST_SENTINEL_FAKE');
  });
});

describe('真实 web bundle 与旁挂清单', () => {
  it('tools/build-bundles.mjs 产出的 web.js 以法务注释开头，并把配置记录成可校验事实', () => {
    // 在测试里跑一次真实构建：artifacts/ 已被 gitignore，且 verify 流程本来就要跑这一步。
    // 不这么做的话，这条断言就依赖「有人先跑过 pnpm bundles」，`pnpm test` 单独执行时会假失败。
    const run = spawnSync(process.execPath, ['tools/build-bundles.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);

    const bundleFile = join(BUNDLES_DIR, 'web.js');
    expect(existsSync(bundleFile)).toBe(true);
    const bundle = readFileSync(bundleFile, 'utf8');
    expect(bundle.startsWith('/*!')).toBe(true);
    expect(bundle).toContain('SPDX-License-Identifier: AGPL-3.0-only');
    expect(bundle).toContain('LittleQ');

    // bundle-scan.mjs 读这份记录来判定「配置是否真的开着 inline」，所以它必须与实现一致。
    const options = JSON.parse(readFileSync(join(BUNDLES_DIR, 'web.options.json'), 'utf8'));
    expect(options.legalComments).toBe('inline');
    expect(options.minify).toBe(true);
    expect(options.bannerPresent).toBe(true);
    // 记录里不得出现本机绝对路径：运行时路径不是交付物，报告可能随 CI 产物公开。
    expect(JSON.stringify(options)).not.toContain(REPO_ROOT);
  });

  it('bundle 许可证扫描通过，并生成 §10.2 要挂到 /licenses.txt 的旁挂清单', () => {
    const run = spawnSync(process.execPath, ['tools/license/bundle-scan.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);

    const licensesTxt = join(BUNDLES_DIR, 'web.licenses.txt');
    expect(existsSync(licensesTxt)).toBe(true);
    const text = readFileSync(licensesTxt, 'utf8');
    // web bundle 目前只打进 zod 一个第三方包（其余都是自有工作区代码）。
    expect(text).toContain('zod');
    expect(text).toContain('MIT');
    expect(text).toContain('https://www.npmjs.com/package/zod/v/');
    expect(text).not.toContain(REPO_ROOT);
  });
});

// ZLQ-162 治理裁定 3 的**产物侧**闸门：批准以 distributed:false 为前提，被打包进 bundle 就等于
// 正在分发，前提当场失效（tools/lib/collect.mjs 的 approvalOutOfScope()）。
//
// 为什么用合成 metafile：真实 web bundle 今天只打进 zod，minimatch / lightningcss 都被
// tree-shaking 挡在产物外，于是这半条规则在真实产物上是 0 进 0 出的空断言 —— 把规则删掉照样全绿。
// 合成 metafile 只伪造「产物里有哪些输入文件」这一项；策略、lockfile 闭包、prod/dev 归类、
// 包清单与许可证表达式全部取自线上仓库与 node_modules 里真实安装的包，走的也是真实的
// bundle-scan.mjs CLI。而它恰恰是只有产物扫描能判的一半：源码扫描看得到 prod/dev，
// 看不到产物里到底装了什么。
//
// 对照组不可省：空 packages 同样退出 0，所以对照组必须断言 zod **确实被识别出来**，
// 否则「合成 metafile 格式没被认出来」也会伪装成通过。
const SYNTHETIC_OPTIONS = {
  legalComments: 'inline',
  minify: true,
  bundle: true,
  format: 'esm',
  bannerPresent: true,
};

function storeInput(name, relFile) {
  const storeDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  const entry = readdirSync(storeDir).find(
    (dir) =>
      dir.startsWith(`${name}@`) && existsSync(join(storeDir, dir, 'node_modules', name, relFile)),
  );
  if (!entry) throw new Error(`夹具失效：node_modules/.pnpm 下找不到含 ${relFile} 的 ${name}`);
  const root = join(storeDir, entry, 'node_modules', name);
  return {
    path: `node_modules/.pnpm/${entry}/node_modules/${name}/${relFile}`,
    manifest: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
  };
}

function runBundleScan(name, inputs) {
  const bundlesDir = join(workdir, `bundle-scan-${name}`);
  mkdirSync(bundlesDir, { recursive: true });
  const meta = {
    inputs: Object.fromEntries(inputs.map((item) => [item.path, { bytesInOutput: 1 }])),
    outputs: {},
  };
  writeFileSync(
    join(bundlesDir, `${name}.meta.json`),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(bundlesDir, `${name}.options.json`),
    `${JSON.stringify(SYNTHETIC_OPTIONS, null, 2)}\n`,
    'utf8',
  );
  // 正文只需带上 AGPL 横幅声明即可满足 bannerPresent；两个输入文件都没有 /*! 法务注释，
  // 因此 stripped 为空是真结果，不是「没检查」。
  writeFileSync(
    join(bundlesDir, `${name}.js`),
    `/*! LittleQ — SPDX-License-Identifier: AGPL-3.0-only */\n`,
    'utf8',
  );
  const run = spawnSync(
    process.execPath,
    [BUNDLE_SCAN, '--repo-root', REPO_ROOT, '--bundles-dir', bundlesDir],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const report = JSON.parse(readFileSync(join(bundlesDir, 'bundle-license-report.json'), 'utf8'));
  return {
    exitCode: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    bundle: report.bundles[0],
    licensesTxt: readFileSync(join(bundlesDir, `${name}.licenses.txt`), 'utf8'),
  };
}

describe('bundle 是分发产物：distributed:false 的批准在产物里前提失效', () => {
  it('对照组：只打进 zod（MIT）时退出 0，且 zod 确实被识别、配置校验确实通过', () => {
    const zod = storeInput('zod', 'index.js');
    const { exitCode, stderr, bundle } = runBundleScan('allowed', [zod]);
    expect(exitCode, stderr).toBe(0);
    // 下面四条是「非空断言」的护栏：合成 metafile 没被认出来的话，它们会先失败。
    expect(bundle.configProblems).toEqual([]);
    expect(bundle.untracked).toEqual([]);
    expect(bundle.legalComments.stripped).toEqual([]);
    expect(bundle.packages).toHaveLength(1);
    expect(bundle.packages[0]).toMatchObject({
      name: 'zod',
      version: zod.manifest.version,
      expression: 'MIT',
      verdict: 'allowed',
      inClosure: true,
    });
  });

  it('同一个 bundle 里换成 minimatch（BlueOak-1.0.0，线上批准 distributed:false）→ 退出 2 并点名', () => {
    const minimatch = storeInput('minimatch', 'dist/commonjs/index.js');
    const { exitCode, stdout, stderr, bundle, licensesTxt } = runBundleScan('distributed', [
      minimatch,
    ]);

    // 必须是 2（待裁定档）而不是 1：退出 1 意味着合成夹具本身出了硬性失败，证明不了这条规则。
    expect(exitCode, `${stdout}\n${stderr}`).toBe(2);
    expect(bundle.configProblems).toEqual([]);
    expect(bundle.untracked).toEqual([]);
    expect(bundle.packages).toHaveLength(1);
    expect(bundle.packages[0]).toMatchObject({
      name: 'minimatch',
      version: minimatch.manifest.version,
      expression: 'BlueOak-1.0.0',
      verdict: 'review-required',
      inClosure: true,
    });
    // 源码闭包视角的 outOfScope 是 null —— minimatch 是 devDependency，在源码扫描里前提成立。
    // 产物视角必须自己再判一次，这正是 bundle-scan 不能沿用 collect 结果的原因。
    expect(bundle.packages[0].adjudication).toEqual({
      id: 'minimatch-blueoak-1.0.0',
      status: 'approved',
      distributed: false,
      outOfScope: null,
    });

    expect(stdout).toContain('bundle 内出现无有效裁定的 reviewRequired');
    expect(stdout).toContain(`minimatch@${minimatch.manifest.version}`);
    expect(stdout).toContain('已被打包进分发产物');
    expect(stdout).toContain('必须重新裁定');
    // 旁挂清单照旧生成：判红不等于不产出证据，§10.2 的 /licenses.txt 来源不能断。
    expect(licensesTxt).toContain('Package: minimatch');
    expect(licensesTxt).toContain('BlueOak-1.0.0');
  });
});

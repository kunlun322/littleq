// 许可证判定必须与 runner 平台无关（ZLQ-162 缺陷 2）。
//
// 真实事故：`pnpm license:scan` 在本机（macOS）绿，在 ubuntu-latest 上以退出码 1 红。
// 原因是 fsevents 只在 darwin 上被安装 —— macOS 能从已安装 manifest 读到 MIT，
// Linux runner 上它根本不存在，于是掉进「解析不到 → 未知即不合规」。
// 同一份 lockfile、同一份策略，判定结果却因为「runner 上恰好装了什么」而不同。
//
// 修法不是给 fsevents 补一条 policy 条目（那只是把同一个坑留给下一个 darwin-only 依赖），
// 而是让**所有**被 os/cpu/libc 过滤的平台变体都从一份与平台无关的事实来源解析：
// lockfile 声明的平台约束（提交进仓库，处处相同）+ 注册表元数据快照（提交进仓库）。
//
// 因此这里锁的性质是：把「另一个平台的 runner 上会装成什么样」重建出来，
// 两侧对每一个闭包条目给出的 (表达式, 判定, 解析来源) 三元组必须逐一相同。
// 解析来源也要相同 —— 只比判定会漏掉 THIRD_PARTY_LICENSES 的「许可证依据」列：
// 那一列直接由 licenseSource 渲染，而它的 INVENTORY 段是 `--check` 要比对的，
// 平台之间不一致就会让 license-check.yml 的一致性检查在 CI 上红。
//
// ── ZLQ-163：对照工装自己曾经也是平台相关的 ────────────────────────────────────
// 上一版用「宿主真实安装树里恰好有哪些平台变体」推导要省略的条目：遍历宿主树，把
// lockfile 说它在 linux/x64/glibc 上装不上的那些跳过。这在 macOS 上有效（宿主树里有
// fsevents 等 5 个 darwin 变体可省），但在 ubuntu-latest 上宿主树**本来就没有**任何
// darwin 变体，于是「省略集」为空，模拟树退化成宿主树的原样副本 —— 本该认证「两侧是
// 不同的树」的那条对照，在它最需要生效的 runner 上失去了认证对象，只留下 2 条红断言。
//
// 根因是模拟树由宿主定义。修法是把两棵模拟树都改成由 **lockfile** 定义，宿主树只作为
// 「真实 manifest」的来源（非平台变体的判定确实要读它）：
//   ▸ 对每个被 os/cpu/libc 约束的闭包条目，按目标平台该不该装来**删掉**或**补上**；
//   ▸ 补上的那一份是按 config/license-registry-facts.json **合成的替身**（不是真 tarball），
//     字段与快照逐字一致 —— 快照正是扫描器解析平台变体时用的同一份事实来源，所以替身
//     不会与快照矛盾（resolveFromFacts 有一道一致性校验，矛盾即判 unresolved）；
//   ▸ 没有快照可依据的条目一律**不**合成，并要求它的解析来源必须是 audited-policy-entry
//     —— 那说明它由人工审计的 platformBinaryFamilies 背书，本来就不经过 node_modules。
//     「没法合成就悄悄跳过」会变成漏洞，所以这一步是断言，不是沉默。
//
// 于是无论宿主是 macOS 还是 ubuntu，「darwin 侧」与「linux 侧」都恰好差同一批平台变体，
// 对照在每个宿主上都非空洞；宿主自己那棵树作为第三侧一起比，保证结论仍然覆盖真实扫描
// （`pnpm license:scan` 跑的就是宿主侧）。三侧两两相比，任何一侧单独漂移都会红。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collect } from '../lib/collect.mjs';
import { indexInstalledPackages, loadRegistryFacts } from '../lib/license-resolve.mjs';
import { readLockfile, resolveClosure } from '../lib/lockfile.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const tempDirs = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// npm/pnpm 的 os/cpu/libc 语义：字段缺失即不限制；以 `!` 开头的是排除项。
function fieldAllows(list, value) {
  if (!list) return true;
  const allowed = Array.isArray(list) ? list : [list];
  if (allowed.some((item) => String(item).startsWith('!'))) return !allowed.includes(`!${value}`);
  return allowed.includes(value);
}

function installsOn(pkg, platform) {
  return (
    fieldAllows(pkg.os, platform.os) &&
    fieldAllows(pkg.cpu, platform.cpu) &&
    fieldAllows(pkg.libc, platform.libc)
  );
}

// ubuntu-latest 是 linux/x64/glibc。这三个维度就是 pnpm 过滤可选依赖时用的全部依据。
const LINUX_RUNNER = { os: 'linux', cpu: 'x64', libc: 'glibc' };
// 对照的另一极。选 darwin/arm64 是因为它既是开发机也是 macos-latest 的形态，而且
// issue 点名的 fsevents 恰好是 darwin-only —— 有它在，两侧的差异集合永远非空。
const DARWIN_RUNNER = { os: 'darwin', cpu: 'arm64', libc: null };
// process.arch 的取值（x64 / arm64 / ia32 / arm / ppc64 / s390x / riscv64 / loong64）
// 与 npm 的 cpu 字段同一套词汇，不需要映射。darwin/win32 没有 libc 维度。
//
// LQ_LICENSE_HOST_PLATFORM=linux/x64/glibc 是配套的第三个复现钩子：当
// LQ_LICENSE_HOST_INSTALL_ROOT 指向另一棵平台的树时，宿主三元组也得跟着换，否则
// 「宿主树是一份真实的平台过滤安装」这条前提会拿 darwin 去校一棵 linux 的树 ——
// 那是假警报，不是真缺陷。它也没法用来蒙混过关：三元组与安装树互相校验，
// 写错了就红在那条前提断言上（hostForeignConstrained 会把差异全列出来）。
// 不设它时取 process.platform / process.arch，与 CI 上的行为完全一致。
function hostPlatformTriple() {
  const override = process.env.LQ_LICENSE_HOST_PLATFORM;
  if (!override) {
    return {
      os: process.platform,
      cpu: process.arch,
      libc: process.platform === 'linux' ? 'glibc' : null,
    };
  }
  const [os, cpu, libc] = override.split('/');
  if (!os || !cpu) {
    throw new Error(
      `LQ_LICENSE_HOST_PLATFORM 要写成 <os>/<cpu>[/<libc>]（如 linux/x64/glibc），收到 "${override}"`,
    );
  }
  return { os, cpu, libc: libc && libc !== '-' ? libc : null };
}
const HOST_PLATFORM = hostPlatformTriple();

const lockfile = readLockfile(join(REPO_ROOT, 'pnpm-lock.yaml'));
const lockfileByBase = new Map([...lockfile.packages.values()].map((pkg) => [pkg.base, pkg]));
const { entries: closure } = resolveClosure(lockfile);
const constrainedClosure = closure.filter((pkg) => pkg.os || pkg.cpu || pkg.libc);

// 平台变体的许可事实快照。合成替身要照它写字段，「没有快照所以不合成」也要拿它当判据。
// 返回 null（而不是空 Map）意味着仓库里没有这份快照 —— 那正是 ZLQ-160 的世界，
// 此时本文件的对照无从构造，必须响亮失败。
const registryFacts = loadRegistryFacts(join(REPO_ROOT, 'config/license-registry-facts.json'));

// QA 复现钩子：把「宿主安装树」指向另一棵树，就能在 macOS 上重现 ubuntu-latest 的宿主条件
// （即安装树里不含任何 darwin-only 变体），反之亦然。默认值就是仓库真实的 node_modules，
// 因此不设这两个变量时本文件的行为与 CI 上完全一致。它只替换**基底**；两棵模拟树的增删
// 一律由 lockfile 的平台约束推导，所以无论基底指向哪里，对照都不会退化成同一棵树。
//   LQ_LICENSE_HOST_INSTALL_ROOT=<dir>   宿主安装树根目录
//   LQ_LICENSE_HOST_INSTALL_LAYOUT=flat  该树的布局（pnpm | flat），默认 pnpm
// 换了基底通常还得换宿主三元组，见上面 HOST_PLATFORM 处的 LQ_LICENSE_HOST_PLATFORM。
const HOST_INSTALL_ROOT =
  process.env.LQ_LICENSE_HOST_INSTALL_ROOT ?? join(REPO_ROOT, 'node_modules');
const HOST_INSTALL_LAYOUT = process.env.LQ_LICENSE_HOST_INSTALL_LAYOUT ?? 'pnpm';

const hostInstalled = indexInstalledPackages(HOST_INSTALL_ROOT, HOST_INSTALL_LAYOUT);

// 用 flat 布局重建「目标平台上安装完成后的样子」。flat 布局按 manifest 里的 name+version
// 建键，所以目录名可以任取（这里把 scope 的 `/` 换成 `+`）—— 不需要伪造 .pnpm 的目录结构。
//
// 与上一版的关键差别：省略集与新增集都由 lockfile 决定，不是由宿主树里恰好有什么决定。
// 宿主树只提供真实 manifest；目标平台该装而宿主没有的，用注册表事实快照合成一份替身。
function buildPlatformInstall(target, label) {
  const dir = scratch(`lq-license-${label}-`);
  const present = new Set();
  const omitted = []; // 宿主树里有、但目标平台装不上 → 不放进模拟树
  const synthesized = []; // 目标平台该装、宿主树里没有 → 按快照合成替身
  const unsynthesized = []; // 目标平台该装、宿主树里没有、且没有快照可依据 → 必须由策略背书
  for (const item of hostInstalled.values()) {
    const pkg = lockfileByBase.get(`${item.name}@${item.version}`);
    if (pkg && !installsOn(pkg, target)) {
      omitted.push(item.key);
      continue;
    }
    symlinkSync(item.dir, join(dir, `${item.name.replace('/', '+')}@${item.version}`));
    present.add(item.key);
  }
  for (const entry of constrainedClosure) {
    if (!installsOn(entry, target)) continue;
    const key = `${entry.name}@${entry.version}`;
    if (present.has(key)) continue;
    const fact = registryFacts?.get(key);
    if (!fact) {
      unsynthesized.push(key);
      continue;
    }
    const pkgDir = join(dir, `${entry.name.replace('/', '+')}@${entry.version}`);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      `${JSON.stringify(
        {
          name: entry.name,
          version: entry.version,
          // 逐字取自提交进仓库的注册表事实快照：替身代表的是「这个平台变体确实装上了」，
          // 而它的许可事实只有一个来源，就是快照本身。写成别的值会触发
          // resolveFromFacts 的一致性校验并判 unresolved —— 那是假警报，不是真缺陷。
          license: fact.license,
          homepage: fact.homepage ?? undefined,
          repository: fact.repository ?? undefined,
          os: entry.os ?? undefined,
          cpu: entry.cpu ?? undefined,
          libc: entry.libc ?? undefined,
          description:
            `SYNTHETIC stand-in for ${key}, generated by ` +
            `tools/test/license-platform-independence.test.mjs from ` +
            `config/license-registry-facts.json. Not the published tarball.`,
        },
        null,
        2,
      )}\n`,
    );
    present.add(key);
    synthesized.push(key);
  }
  return { dir, present, omitted, synthesized, unsynthesized };
}

const linuxLike = buildPlatformInstall(LINUX_RUNNER, 'linux-like');
const darwinLike = buildPlatformInstall(DARWIN_RUNNER, 'darwin-like');

// 三侧各算一次，lockfile 与策略都取仓库里那一份 —— 唯一变量就是「装了什么」。
// host 侧就是 `pnpm license:scan` 真实跑的那一次；另外两侧是按 lockfile 重建的另一个平台。
const onHost = collect({
  repoRoot: REPO_ROOT,
  installedRoot: HOST_INSTALL_ROOT,
  installedLayout: HOST_INSTALL_LAYOUT,
});
const onLinux = collect({
  repoRoot: REPO_ROOT,
  installedRoot: linuxLike.dir,
  installedLayout: 'flat',
});
const onDarwin = collect({
  repoRoot: REPO_ROOT,
  installedRoot: darwinLike.dir,
  installedLayout: 'flat',
});

// 抽掉事实快照的对照：collect 的 factsFile 指到一个不存在的文件，loadRegistryFacts 就返回
// null（不是空 Map），解析器退回「已安装 manifest → 同族兄弟推断 → 策略」那条逐级降级链。
// 这条链的第 2 级定义就是「本机恰好装了某个兄弟」，天然依赖平台 —— 所以它是 ZLQ-160 的
// 复现条件。用它可以证明上面那些「不出现同族推断」的断言不是因为没有平台变体而空过的。
const ABSENT_FACTS_FILE = 'config/license-registry-facts.absent.json';
const controlWithoutFacts = (build) =>
  collect({
    repoRoot: REPO_ROOT,
    installedRoot: build.dir,
    installedLayout: 'flat',
    factsFile: ABSENT_FACTS_FILE,
  });

const triple = (item) => [item.expression, item.verdict, item.licenseSource];
const keyOf = (item) => `${item.name}@${item.version}`;
const byKey = (result) => new Map(result.entries.map((item) => [keyOf(item), item]));

const SIDES = [
  ['host', onHost],
  ['linux-like', onLinux],
  ['darwin-like', onDarwin],
];
// 「linux 侧 vs darwin 侧」是负载最重的一对：它们的安装集在每个宿主上都真的不同。
const PLATFORM_PAIR = [
  ['linux-like', onLinux],
  ['darwin-like', onDarwin],
];

// 两棵模拟树的对称差：一侧有、另一侧没有的条目。P1 要求它在**每个宿主**上都非空。
const onlyInDarwin = [...darwinLike.present].filter((key) => !linuxLike.present.has(key)).sort();
const onlyInLinux = [...linuxLike.present].filter((key) => !darwinLike.present.has(key)).sort();

// 宿主树的「平台过滤保真度」：pnpm 按 os/cpu/libc 过滤可选依赖，所以一份真实安装里
// 不该出现本宿主装不上的变体，也不该缺本宿主该装的变体。这三条把「宿主树是一份真实
// 的平台过滤安装」变成断言，模拟树才有可信的基底。
const hostForeignConstrained = [...hostInstalled.values()]
  .filter((item) => {
    const pkg = lockfileByBase.get(item.key);
    return pkg && (pkg.os || pkg.cpu || pkg.libc) && !installsOn(pkg, HOST_PLATFORM);
  })
  .map((item) => item.key)
  .sort();
const hostNativeConstrained = [...hostInstalled.values()]
  .filter((item) => {
    const pkg = lockfileByBase.get(item.key);
    return pkg && (pkg.os || pkg.cpu || pkg.libc) && installsOn(pkg, HOST_PLATFORM);
  })
  .map((item) => item.key)
  .sort();
// 只要求「有快照的那些」在宿主树里：pnpm 自锁文档的 pnpm / @pnpm/exe.* 根本不经过
// node_modules，它们由人工审计的 platformBinaryFamilies 放行，不在快照覆盖范围内。
const missingNativeConstrained = constrainedClosure
  .filter(
    (entry) =>
      installsOn(entry, HOST_PLATFORM) &&
      registryFacts?.has(`${entry.name}@${entry.version}`) &&
      !hostInstalled.has(`${entry.name}@${entry.version}`),
  )
  .map(keyOf)
  .sort();

// 两平台之间「该装的那一侧不同」的平台变体。有快照就必须在对应那一侧出现 ——
// 这条断言正是让合成步骤不可省略的那一道：删掉合成，它在 macOS 与 ubuntu 上都会红。
const oneSidedConstrained = constrainedClosure
  .filter(
    (entry) =>
      registryFacts?.has(`${entry.name}@${entry.version}`) &&
      installsOn(entry, DARWIN_RUNNER) !== installsOn(entry, LINUX_RUNNER),
  )
  .map(keyOf);

describe('模拟本身是真的（不是把两侧跑成同一棵树）', () => {
  it('宿主安装树是一份真实的平台过滤安装', () => {
    expect(registryFacts, '仓库里没有 config/license-registry-facts.json，对照无从构造').not.toBe(
      null,
    );
    expect(hostInstalled.size).toBeGreaterThan(100);
    expect(
      hostForeignConstrained,
      `宿主树（${JSON.stringify(HOST_PLATFORM)}）里出现了本平台装不上的变体，它不是一份真实的平台过滤安装`,
    ).toEqual([]);
    expect(hostNativeConstrained.length, '宿主树里一个本平台变体都没有').toBeGreaterThan(0);
    expect(
      missingNativeConstrained,
      '本平台该装且有事实快照的变体没装上，宿主树不完整（试 pnpm install --frozen-lockfile）',
    ).toEqual([]);
  });

  it('issue 点名的 fsevents 恰好只在 darwin 侧', () => {
    const pkg = lockfileByBase.get('fsevents@2.3.3');
    expect(pkg?.os).toEqual(['darwin']);
    expect(installsOn(pkg, LINUX_RUNNER)).toBe(false);
    expect(installsOn(pkg, DARWIN_RUNNER)).toBe(true);
    // 方向由 lockfile 决定，与宿主是谁无关：ubuntu 上宿主树没有它，darwin 侧是合成的；
    // macOS 上宿主树有它，linux 侧把它省掉。两种情况下都恰好只在一侧。
    expect(darwinLike.present.has('fsevents@2.3.3')).toBe(true);
    expect(linuxLike.present.has('fsevents@2.3.3')).toBe(false);
  });

  it('两侧安装集双向不同，每处差异都由 lockfile 解释，且合成不可省略', () => {
    expect(constrainedClosure.length, '闭包里没有平台约束条目，这条测试没有对象').toBeGreaterThan(
      50,
    );
    // P1：一侧有、另一侧没有的集合非空 —— 而且两个方向都非空，所以它不可能靠
    // 「宿主恰好装了某个变体」成立。
    expect(onlyInDarwin, 'darwin 侧没有任何 linux 侧缺失的条目，两侧是同一棵树').not.toEqual([]);
    expect(onlyInLinux, 'linux 侧没有任何 darwin 侧缺失的条目，两侧是同一棵树').not.toEqual([]);
    // 差异必须可解释：每一个只在一侧出现的条目，都得是 lockfile 声明了「恰好在其中一个
    // 目标平台上装得上」的平台变体。出现别的就是模拟树被污染了。
    for (const key of [...onlyInDarwin, ...onlyInLinux]) {
      const pkg = lockfileByBase.get(key);
      expect(pkg, `${key} 只在一侧出现，却不在 lockfile 里`).toBeTruthy();
      expect(
        installsOn(pkg, DARWIN_RUNNER) !== installsOn(pkg, LINUX_RUNNER),
        `${key} 的平台约束在两个目标平台上相同，它出现在单侧无从解释`,
      ).toBe(true);
    }
    // 合成不可省略：该在的那一侧必须真的有它。上一版正是缺了这一步，才让 linux 侧在
    // ubuntu 上退化成宿主树的原样副本。
    for (const key of oneSidedConstrained) {
      const pkg = lockfileByBase.get(key);
      const side = installsOn(pkg, DARWIN_RUNNER) ? darwinLike : linuxLike;
      const label = installsOn(pkg, DARWIN_RUNNER) ? 'darwin' : 'linux';
      expect(side.present.has(key), `${key} 该在 ${label} 侧，那一侧却没有它`).toBe(true);
    }
    expect(oneSidedConstrained.length).toBeGreaterThan(0);
    // 没有快照可依据因而没有合成的条目，必须由人工审计的策略条目背书（即解析来源是
    // audited-policy-entry）。否则「合成不了就跳过」会静默地把一个平台变体从对照里抹掉。
    for (const key of [...linuxLike.unsynthesized, ...darwinLike.unsynthesized]) {
      expect(registryFacts?.has(key), `${key} 有快照却没被合成`).toBe(false);
      for (const [label, result] of SIDES) {
        expect(
          byKey(result).get(key)?.licenseSource,
          `${key} 没有被合成，${label} 侧就该由审计策略背书`,
        ).toBe('audited-policy-entry');
      }
    }
  });
});

describe('许可证判定与 runner 平台无关', () => {
  it('三侧闭包条目集合完全相同（闭包只由 lockfile 决定）', () => {
    const hostKeys = [...byKey(onHost).keys()];
    for (const [label, result] of SIDES) {
      expect(result.entries.length, `${label} 侧闭包条目数不同`).toBe(onHost.entries.length);
      expect([...byKey(result).keys()], `${label} 侧闭包条目集合不同`).toEqual(hostKeys);
    }
  });

  it('每一个条目的 (表达式, 判定, 解析来源) 三元组都相同', () => {
    const sides = SIDES.map(([label, result]) => [label, byKey(result)]);
    const diffs = [];
    for (const [key, item] of byKey(onHost)) {
      const expected = JSON.stringify(triple(item));
      for (const [label, index] of sides) {
        const other = index.get(key);
        if (!other) {
          diffs.push(`${key}: 在 ${label} 侧缺失`);
          continue;
        }
        const actual = JSON.stringify(triple(other));
        if (actual !== expected) diffs.push(`${key}: host=${expected} ${label}=${actual}`);
      }
    }
    expect(
      diffs,
      `判定结果依赖 runner 上恰好装了什么（共 ${diffs.length} 处不一致，前 20 处）：\n${diffs
        .slice(0, 20)
        .join('\n')}`,
    ).toEqual([]);

    // P2 点名的是平台约束条目：它们是「装没装」随平台变化的那一批，也是唯一可能漂移的
    // 一批。上面的全量比对已经覆盖它们，这里再按名字逐个钉一次，并要求解析来源既不靠
    // 同族推断、也不是解析不到 —— 这样一旦全量比对因为条目集合变化而失焦，这条仍在。
    const platformDiffs = [];
    for (const entry of constrainedClosure) {
      const key = keyOf(entry);
      const expected = JSON.stringify(triple(byKey(onHost).get(key)));
      for (const [label, result] of PLATFORM_PAIR) {
        const item = byKey(result).get(key);
        if (!item) {
          platformDiffs.push(`${key}: 在 ${label} 侧缺失`);
          continue;
        }
        if (JSON.stringify(triple(item)) !== expected) {
          platformDiffs.push(`${key}: host=${expected} ${label}=${JSON.stringify(triple(item))}`);
        }
        if (
          item.licenseSource === 'platform-sibling-inferred' ||
          item.licenseSource === 'unresolved'
        )
          platformDiffs.push(`${key}: ${label} 侧解析来源是 ${item.licenseSource}`);
      }
    }
    expect(
      platformDiffs,
      `被 os/cpu/libc 约束的 ${constrainedClosure.length} 个条目里，有 ${platformDiffs.length} 处随平台漂移（前 20 处）：\n${platformDiffs
        .slice(0, 20)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('汇总口径相同：判定分布与解析来源分布都逐字一致', () => {
    for (const [label, result] of SIDES) {
      expect(result.summary.byVerdict, `${label} 侧判定分布不同`).toEqual(onHost.summary.byVerdict);
      expect(result.summary.bySource, `${label} 侧解析来源分布不同`).toEqual(
        onHost.summary.bySource,
      );
      expect(result.summary.prod, `${label} 侧生产依赖数不同`).toBe(onHost.summary.prod);
    }
  });

  it('fsevents 在三侧的判定与解析来源都相同，且都不是「解析不到」', () => {
    const host = byKey(onHost).get('fsevents@2.3.3');
    expect(host, 'fsevents 不在闭包里').toBeTruthy();
    expect(host.licenseSource, '解析不到就是 fail-closed 失败，不是平台无关').not.toBe(
      'unresolved',
    );
    for (const [label, result] of SIDES) {
      const item = byKey(result).get('fsevents@2.3.3');
      expect(item, `fsevents 不在 ${label} 侧的闭包里`).toBeTruthy();
      expect(triple(item), `${label} 侧 fsevents 的三元组与宿主侧不同`).toEqual(triple(host));
    }
  });

  it('三侧都没有 unresolved，且都没有 forbidden/unknown（fail-closed 未被放宽）', () => {
    for (const [label, result] of SIDES) {
      const bad = result.entries.filter((item) => item.licenseSource === 'unresolved');
      expect(bad.map(keyOf), `${label} 侧出现解析不到的条目`).toEqual([]);
      expect(result.summary.byVerdict.forbidden, `${label} 侧出现禁止项`).toBe(0);
      expect(result.summary.byVerdict.unknown, `${label} 侧出现未知许可`).toBe(0);
    }
  });

  it('解析来源不出现「同族推断」——平台变体一律走与平台无关的事实来源', () => {
    // 同族推断的定义就是「本机装了某个兄弟」，天然依赖平台；它只应作为没有事实快照时
    // 的兜底（控制用例夹具走那条路径），不该出现在真实仓库的审计结论里。
    for (const [label, result] of SIDES) {
      const inferred = result.entries.filter(
        (item) => item.licenseSource === 'platform-sibling-inferred',
      );
      expect(inferred.map(keyOf), `${label} 侧仍在用同族推断`).toEqual([]);
    }
    // 正向白名单：平台变体的解析来源只有两种，都来自提交进仓库的文件。这条比「不出现
    // 同族推断」更强 —— 它同时排除了 installed-manifest，也就是 ZLQ-160 那个缺陷本身：
    // darwin 侧真的装着 fsevents（宿主真实安装或合成替身），若判定读的是它的 manifest，
    // 这里就会红。
    const allowedSources = ['registry-facts', 'audited-policy-entry'];
    for (const [label, result] of SIDES) {
      const index = byKey(result);
      const offenders = constrainedClosure
        .filter((entry) => !allowedSources.includes(index.get(keyOf(entry))?.licenseSource))
        .map((entry) => `${keyOf(entry)}=${index.get(keyOf(entry))?.licenseSource}`);
      expect(offenders, `${label} 侧有平台变体没走与平台无关的事实来源`).toEqual([]);
    }

    // 非空洞对照（P3）：把事实快照抽掉，同族推断立刻回来、两侧结论立刻分叉。
    // 这证明上面那些「不出现同族推断」「白名单」的断言不是因为压根没有平台变体而空过的。
    // 注意这条对照本身也是宿主无关的：无论宿主是 macOS 还是 ubuntu，两棵模拟树都差同一批
    // 平台变体，所以抽掉快照后总有一侧要靠兄弟推断、另一侧解析不到。
    const controls = [
      ['linux-like', controlWithoutFacts(linuxLike)],
      ['darwin-like', controlWithoutFacts(darwinLike)],
    ];
    for (const [label, result] of controls) {
      expect(
        result.entries.length,
        `${label} 侧抽掉快照后闭包条目数变了，对照跑的不是同一件事`,
      ).toBe(onHost.entries.length);
      const inferred = result.entries.filter(
        (item) => item.licenseSource === 'platform-sibling-inferred',
      );
      expect(
        inferred.length,
        `${label} 侧抽掉快照后仍然没有同族推断，上面那两条断言是空洞的`,
      ).toBeGreaterThan(0);
    }
    const [linuxControl, darwinControl] = controls.map(([, result]) => byKey(result));
    const controlDiffs = [...linuxControl]
      .filter(([key, item]) => {
        const other = darwinControl.get(key);
        return !other || JSON.stringify(triple(item)) !== JSON.stringify(triple(other));
      })
      .map(([key]) => key);
    expect(
      controlDiffs.length,
      '抽掉快照后两侧判定仍然逐条相同，说明这个快照根本不是平台无关性的依据',
    ).toBeGreaterThan(0);
  });
});

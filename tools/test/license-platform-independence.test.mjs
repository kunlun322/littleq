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
// 因此这里锁的性质是：把「Linux runner 上会装成什么样」在本机重建出来，
// 两侧对每一个闭包条目给出的 (表达式, 判定, 解析来源) 三元组必须逐一相同。
// 解析来源也要相同 —— 只比判定会漏掉 THIRD_PARTY_LICENSES 的「许可证依据」列：
// 那一列直接由 licenseSource 渲染，而它的 INVENTORY 段是 `--check` 要比对的，
// 平台之间不一致就会让 license-check.yml 的一致性检查在 CI 上红。
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collect } from '../lib/collect.mjs';
import { indexInstalledPackages } from '../lib/license-resolve.mjs';
import { readLockfile } from '../lib/lockfile.mjs';

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

// ubuntu-latest 是 linux/x64/glibc。这三个维度就是 pnpm 过滤可选依赖时用的全部依据。
const LINUX_RUNNER = { os: 'linux', cpu: 'x64', libc: 'glibc' };

function installsOnLinuxRunner(pkg) {
  return (
    fieldAllows(pkg.os, LINUX_RUNNER.os) &&
    fieldAllows(pkg.cpu, LINUX_RUNNER.cpu) &&
    fieldAllows(pkg.libc, LINUX_RUNNER.libc)
  );
}

const lockfile = readLockfile(join(REPO_ROOT, 'pnpm-lock.yaml'));
const lockfileByBase = new Map([...lockfile.packages.values()].map((pkg) => [pkg.base, pkg]));

// 用 flat 布局重建「Linux runner 上安装完成后的样子」：把本机已装的每个包软链进一个临时目录，
// 只跳过 lockfile 声明了 linux/x64/glibc 装不上的那些。flat 布局按 manifest 里的 name+version
// 建键，所以目录名可以任取（这里把 scope 的 `/` 换成 `+`）—— 不需要伪造 .pnpm 的目录结构。
//
// 注意这是一份**保守**的模拟：它只会少装、不会多装（本机没装的 linux 变体无从软链）。
// 少装恰好是要复现的条件本身：真实 Linux runner 上 darwin 变体同样一个都不存在。
function buildLinuxLikeInstall() {
  const real = indexInstalledPackages(join(REPO_ROOT, 'node_modules'), 'pnpm');
  const dir = scratch('lq-license-linux-like-');
  const omitted = [];
  for (const item of real.values()) {
    const pkg = lockfileByBase.get(`${item.name}@${item.version}`);
    if (pkg && !installsOnLinuxRunner(pkg)) {
      omitted.push(`${item.name}@${item.version}`);
      continue;
    }
    symlinkSync(item.dir, join(dir, `${item.name.replace('/', '+')}@${item.version}`));
  }
  return { dir, omitted, installedCount: real.size };
}

const simulated = buildLinuxLikeInstall();

// 两侧各算一次。macOS 侧就是本机真实安装；Linux 侧用上面重建的安装树，
// lockfile 与策略都取仓库里那一份 —— 唯一变量就是「装了什么」。
const onMac = collect({ repoRoot: REPO_ROOT });
const onLinux = collect({
  repoRoot: REPO_ROOT,
  installedRoot: simulated.dir,
  installedLayout: 'flat',
});

const triple = (item) => [item.expression, item.verdict, item.licenseSource];
const keyOf = (item) => `${item.name}@${item.version}`;
const byKey = (result) => new Map(result.entries.map((item) => [keyOf(item), item]));

describe('模拟本身是真的（不是把两侧跑成同一棵树）', () => {
  it('本机安装树非空，且 Linux 模拟确实少装了一批平台变体', () => {
    expect(simulated.installedCount).toBeGreaterThan(100);
    expect(simulated.omitted.length).toBeGreaterThan(0);
  });

  it('issue 点名的 fsevents 正是被省略的那一个', () => {
    expect(simulated.omitted).toContain('fsevents@2.3.3');
    const pkg = lockfileByBase.get('fsevents@2.3.3');
    expect(pkg?.os).toEqual(['darwin']);
    expect(installsOnLinuxRunner(pkg)).toBe(false);
  });

  it('lockfile 里被 os/cpu/libc 约束的条目确实存在，否则这条测试没有对象', () => {
    const constrained = [...lockfile.packages.values()].filter(
      (pkg) => pkg.os || pkg.cpu || pkg.libc,
    );
    expect(constrained.length).toBeGreaterThan(50);
  });
});

describe('许可证判定与 runner 平台无关', () => {
  it('两侧闭包条目集合完全相同（闭包只由 lockfile 决定）', () => {
    expect(onMac.entries.length).toBe(onLinux.entries.length);
    expect([...byKey(onMac).keys()]).toEqual([...byKey(onLinux).keys()]);
  });

  it('每一个条目的 (表达式, 判定, 解析来源) 三元组都相同', () => {
    const mac = byKey(onMac);
    const linux = byKey(onLinux);
    const diffs = [];
    for (const [key, item] of mac) {
      const other = linux.get(key);
      if (!other) continue;
      const a = triple(item);
      const b = triple(other);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push(`${key}: macOS=${JSON.stringify(a)} linux=${JSON.stringify(b)}`);
      }
    }
    expect(
      diffs,
      `判定结果依赖 runner 上恰好装了什么（共 ${diffs.length} 处不一致，前 20 处）：\n${diffs
        .slice(0, 20)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('汇总口径相同：判定分布与解析来源分布都逐字一致', () => {
    expect(onLinux.summary.byVerdict).toEqual(onMac.summary.byVerdict);
    expect(onLinux.summary.bySource).toEqual(onMac.summary.bySource);
    expect(onLinux.summary.prod).toBe(onMac.summary.prod);
  });

  it('fsevents 在两侧的判定与解析来源都相同，且都不是「解析不到」', () => {
    const mac = byKey(onMac).get('fsevents@2.3.3');
    const linux = byKey(onLinux).get('fsevents@2.3.3');
    expect(mac, 'fsevents 不在闭包里').toBeTruthy();
    expect(linux, 'fsevents 不在闭包里').toBeTruthy();
    expect(triple(linux)).toEqual(triple(mac));
    expect(mac.licenseSource, '解析不到就是 fail-closed 失败，不是平台无关').not.toBe('unresolved');
  });

  it('两侧都没有 unresolved，且都没有 forbidden/unknown（fail-closed 未被放宽）', () => {
    for (const [label, result] of [
      ['macOS', onMac],
      ['linux-like', onLinux],
    ]) {
      const bad = result.entries.filter((item) => item.licenseSource === 'unresolved');
      expect(bad.map(keyOf), `${label} 侧出现解析不到的条目`).toEqual([]);
      expect(result.summary.byVerdict.forbidden, `${label} 侧出现禁止项`).toBe(0);
      expect(result.summary.byVerdict.unknown, `${label} 侧出现未知许可`).toBe(0);
    }
  });

  it('解析来源不出现「同族推断」——平台变体一律走与平台无关的事实来源', () => {
    // 同族推断的定义就是「本机装了某个兄弟」，天然依赖平台；它只应作为没有事实快照时
    // 的兜底（控制用例夹具走那条路径），不该出现在真实仓库的审计结论里。
    for (const [label, result] of [
      ['macOS', onMac],
      ['linux-like', onLinux],
    ]) {
      const inferred = result.entries.filter(
        (item) => item.licenseSource === 'platform-sibling-inferred',
      );
      expect(inferred.map(keyOf), `${label} 侧仍在用同族推断`).toEqual([]);
    }
  });
});

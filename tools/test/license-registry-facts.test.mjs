// 注册表事实快照的单元测试（ZLQ-162 缺陷 2 的修法本体）。
//
// 平台无关性由 license-platform-independence.test.mjs 从「两侧判定必须逐条相同」这个
// 结果侧锁住；这里锁的是**机制侧**：快照被采纳之前要过的三道 fail-closed 检查。
// 少了这一层，「判定与平台无关」可以靠一个把一切都判成 allowed 的坏快照达成 ——
// 那正是 issue 里说的「一个永远返回 0 的门禁比没有门禁更危险」。
//
// 三道检查：
//   1. 快照里没这一条 → unresolved（不是「退回本机装了什么」）
//   2. 快照的 integrity 与 lockfile 钉住的 tarball 不一致 → unresolved（快照过期/被换包）
//   3. 本机恰好装了这个变体、但 manifest 与快照说法矛盾 → unresolved（不裁决矛盾）
// 外加两条边界：无平台约束的包一律不看快照（否则「已装但未声明 license」这一禁止项
// 就再也查不出来），以及审计过的 policy family 优先于快照（人工证据链接压过抓取结果）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SOURCE_INSTALLED,
  SOURCE_NONE,
  SOURCE_POLICY,
  SOURCE_REGISTRY_FACTS,
  createLicenseResolver,
  isPlatformConstrained,
  loadRegistryFacts,
} from '../lib/license-resolve.mjs';

const tempDirs = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const INTEGRITY =
  'sha512-LQ162UNITTESTNOTAREALINTEGRITY000000000000000000000000000000000000000000000000000000001';

// lockfile 条目：平台约束来自 packages.<key> 下的 os/cpu/libc 字段。
const linuxVariant = {
  name: 'fakebuild-linux-x64',
  version: '1.0.0',
  os: ['linux'],
  cpu: ['x64'],
  integrity: INTEGRITY,
};

const fact = (overrides = {}) => ({
  license: 'BSD-2-Clause',
  hasLicenseDeclaration: true,
  integrity: INTEGRITY,
  homepage: 'https://example.test/fakebuild',
  repository: 'https://example.test/fakebuild.git',
  ...overrides,
});

const factsWith = (key, value) => new Map([[key, value]]);
const installedWith = (key, value) => new Map([[key, value]]);

const NO_FAMILY_POLICY = {
  ownPackages: { names: [], license: 'AGPL-3.0-only' },
  platformBinaryFamilies: { entries: [] },
};

function resolve({
  entry = linuxVariant,
  facts = null,
  installed = new Map(),
  policy = NO_FAMILY_POLICY,
}) {
  return createLicenseResolver({ installed, policy, facts })(entry);
}

describe('isPlatformConstrained：什么算「平台变体」', () => {
  it('os / cpu / libc 任一存在即算', () => {
    expect(isPlatformConstrained({ name: 'a', version: '1', os: ['linux'] })).toBe(true);
    expect(isPlatformConstrained({ name: 'a', version: '1', cpu: ['x64'] })).toBe(true);
    expect(isPlatformConstrained({ name: 'a', version: '1', libc: ['glibc'] })).toBe(true);
  });

  it('三个字段都没有就不算 —— 这类包本机装得到，必须读真实 manifest', () => {
    expect(isPlatformConstrained({ name: 'a', version: '1' })).toBe(false);
    expect(isPlatformConstrained(null)).toBe(false);
  });
});

describe('快照命中：判定只由 (name, version) 决定', () => {
  it('本机没装这个变体也能解析出许可与证据链接', () => {
    const resolved = resolve({ facts: factsWith('fakebuild-linux-x64@1.0.0', fact()) });
    expect(resolved.expression).toBe('BSD-2-Clause');
    expect(resolved.source).toBe(SOURCE_REGISTRY_FACTS);
    expect(resolved.homepage).toBe('https://example.test/fakebuild');
    expect(resolved.repository).toBe('https://example.test/fakebuild.git');
    expect(resolved.hasLicenseDeclaration).toBe(true);
  });

  it('本机装了且说法一致时，来源仍是快照而不是 installed-manifest', () => {
    // 这条是平台无关性的核心：来源必须与「本机装没装」无关，
    // 否则 THIRD_PARTY_LICENSES 的「许可证依据」列会随 runner 变化，--check 在 CI 上就红。
    const installed = installedWith('fakebuild-linux-x64@1.0.0', {
      expression: 'BSD-2-Clause',
      hasLicenseDeclaration: true,
      homepage: null,
      repository: null,
    });
    const resolved = resolve({ facts: factsWith('fakebuild-linux-x64@1.0.0', fact()), installed });
    expect(resolved.source).toBe(SOURCE_REGISTRY_FACTS);
    expect(resolved.expression).toBe('BSD-2-Clause');
  });

  it('快照记录「registry 上就没有 license 声明」时不放行，交给上层判禁止项', () => {
    const resolved = resolve({
      facts: factsWith(
        'fakebuild-linux-x64@1.0.0',
        fact({ license: null, hasLicenseDeclaration: false }),
      ),
    });
    expect(resolved.expression).toBe(null);
    expect(resolved.hasLicenseDeclaration).toBe(false);
    expect(resolved.source).toBe(SOURCE_REGISTRY_FACTS);
  });
});

describe('三道 fail-closed 检查：不猜，一律退回「无法解析」', () => {
  it('快照里没有这一条 → unresolved，并指名该跑哪个命令补', () => {
    const resolved = resolve({ facts: new Map() });
    expect(resolved.expression).toBe(null);
    expect(resolved.source).toBe(SOURCE_NONE);
    expect(resolved.note).toContain('pnpm license:registry-facts');
  });

  it('integrity 与 lockfile 钉住的 tarball 不一致 → unresolved', () => {
    // 快照过期或被换包时，许可描述的是另一个 tarball，此时「有快照」比「没快照」更危险。
    const resolved = resolve({
      facts: factsWith('fakebuild-linux-x64@1.0.0', fact({ integrity: 'sha512-OTHER' })),
    });
    expect(resolved.expression).toBe(null);
    expect(resolved.source).toBe(SOURCE_NONE);
    expect(resolved.note).toContain('integrity');
  });

  it('已安装 manifest 与快照矛盾 → unresolved，不做裁决', () => {
    const installed = installedWith('fakebuild-linux-x64@1.0.0', {
      expression: 'MIT',
      hasLicenseDeclaration: true,
      homepage: null,
      repository: null,
    });
    const resolved = resolve({ facts: factsWith('fakebuild-linux-x64@1.0.0', fact()), installed });
    expect(resolved.expression).toBe(null);
    expect(resolved.source).toBe(SOURCE_NONE);
    expect(resolved.note).toContain('MIT');
    expect(resolved.note).toContain('BSD-2-Clause');
  });

  it('lockfile 没有 integrity 时跳过交叉校验，仍按快照判定', () => {
    // 不是所有 lockfile 条目都带 integrity（link:/本地 tarball 就没有）。
    // 这种条目没有可校验对象，跳过校验而不是判死 —— 判死会把无法安装的场景全部误报成违规。
    const resolved = resolve({
      entry: { ...linuxVariant, integrity: null },
      facts: factsWith('fakebuild-linux-x64@1.0.0', fact({ integrity: 'sha512-OTHER' })),
    });
    expect(resolved.source).toBe(SOURCE_REGISTRY_FACTS);
    expect(resolved.expression).toBe('BSD-2-Clause');
  });
});

describe('快照的适用边界', () => {
  it('无平台约束的条目完全不看快照，仍读已安装 manifest', () => {
    // 反向断言：快照若能给所有包发证，「已装但未声明 license」这一禁止项就永远查不出来
    // —— registry 上的元数据总有 license 字段，而真实的 node_modules 里可能没有。
    const installed = installedWith('plainpkg@1.0.0', {
      expression: 'MIT',
      hasLicenseDeclaration: true,
      homepage: null,
      repository: null,
    });
    const resolved = resolve({
      entry: { name: 'plainpkg', version: '1.0.0' },
      facts: factsWith('plainpkg@1.0.0', fact({ license: 'GPL-3.0-only' })),
      installed,
    });
    expect(resolved.source).toBe(SOURCE_INSTALLED);
    expect(resolved.expression).toBe('MIT');
  });

  it('审计过的 policy family 优先于快照', () => {
    // 人工条目带证据链接，是比抓取结果更强的依据；顺序反了会让一次 registry 抓取
    // 悄悄推翻已经评审过的裁定。
    const policy = {
      ownPackages: { names: [], license: 'AGPL-3.0-only' },
      platformBinaryFamilies: {
        entries: [
          {
            id: 'fakebuild-family',
            prefixes: ['fakebuild-'],
            license: 'Apache-2.0',
            evidence: ['https://example.test/fakebuild/LICENSE'],
          },
        ],
      },
    };
    const resolved = resolve({ policy, facts: factsWith('fakebuild-linux-x64@1.0.0', fact()) });
    expect(resolved.source).toBe(SOURCE_POLICY);
    expect(resolved.expression).toBe('Apache-2.0');
    expect(resolved.policyId).toBe('fakebuild-family');
  });

  it('facts 为 null（仓库里没有快照文件）时退回逐级降级链', () => {
    // 控制用例夹具依赖这个行为：夹具的 --repo-root 指向夹具目录，那里没有快照。
    // 真实仓库永远有快照，所以这条降级路径在生产上不被走到 —— 但删掉快照文件
    // 会让判定重新依赖平台，因此 license-policy.test.mjs 钉住了「约束条目的来源只能是
    // registry-facts 或 audited-policy-entry」，缺快照时会在那里变红。
    const installed = installedWith('fakebuild-linux-x64@1.0.0', {
      expression: 'BSD-2-Clause',
      hasLicenseDeclaration: true,
      homepage: null,
      repository: null,
    });
    const resolved = resolve({ facts: null, installed });
    expect(resolved.source).toBe(SOURCE_INSTALLED);
  });
});

describe('loadRegistryFacts：文件形态', () => {
  it('文件不存在 → null（与「有快照但缺条目」区分开）', () => {
    expect(loadRegistryFacts(join(scratch('lq-facts-missing-'), 'nope.json'))).toBe(null);
  });

  it('JSON 非法 → null，不抛异常', () => {
    const dir = scratch('lq-facts-broken-');
    const file = join(dir, 'facts.json');
    writeFileSync(file, '{ not json', 'utf8');
    expect(loadRegistryFacts(file)).toBe(null);
  });

  it('缺 facts 字段 → null', () => {
    const dir = scratch('lq-facts-empty-');
    const file = join(dir, 'facts.json');
    writeFileSync(
      file,
      `${JSON.stringify({ spec: 'littleq/license-registry-facts@1' }, null, 2)}\n`,
      'utf8',
    );
    expect(loadRegistryFacts(file)).toBe(null);
  });

  it('合法快照 → Map，键是 name@version', () => {
    const dir = scratch('lq-facts-ok-');
    const file = join(dir, 'facts.json');
    writeFileSync(
      file,
      `${JSON.stringify({ spec: 'littleq/license-registry-facts@1', facts: { 'fakebuild-linux-x64@1.0.0': fact() } }, null, 2)}\n`,
      'utf8',
    );
    const loaded = loadRegistryFacts(file);
    expect(loaded).toBeInstanceOf(Map);
    expect(loaded.size).toBe(1);
    expect(loaded.get('fakebuild-linux-x64@1.0.0').license).toBe('BSD-2-Clause');
  });
});

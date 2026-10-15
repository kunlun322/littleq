// 把 lockfile 里的每个包解析到一条许可表达式。
//
// 第一道分岔是「这个包是不是平台变体」——判据来自 lockfile 里声明的 os/cpu/libc，
// 这三个字段是提交进仓库的，因此在任何 runner 上都给出同一个答案。
//
// ▸ 平台变体（lockfile 声明了 os/cpu/libc），且仓库里有注册表事实快照时：
//     1. config/license-policy.json 的 platformBinaryFamilies —— 人工审计条目，带证据链接。
//        只用于 pnpm 自锁文档里的 pnpm / @pnpm/exe.*：它们根本不经过 node_modules。
//     2. config/license-registry-facts.json —— 从注册表抓取并**提交进仓库**的许可事实，
//        按 name@version 建键，并用 dist.integrity 与 lockfile 的 resolution.integrity 交叉校验：
//        integrity 相同即 tarball 相同，其 license 字段也就是同一个事实。
//     3. 两者都没有 → null，判 unknown 并让门禁失败（附「请重新生成快照」的可执行提示）。
//   这条路径**完全不看本机装了什么**，所以 macOS / ubuntu / windows 上结论逐字相同。
//   ZLQ-160 之前不是这样：fsevents 只在 darwin 安装，本机读到 MIT，Linux runner 上它不存在，
//   于是掉进「解析不到 → 未知即不合规」，同一份 lockfile 在两个平台上给出两个判定。
//
// ▸ 非平台变体，或没有事实快照时（控制用例夹具就是这种：它们自带 installed/ 目录、
//   不带事实快照），走原来的逐级降级链：
//     1. 已安装的 package.json —— node_modules/.pnpm/*/node_modules/<name>/package.json
//     2. 同族平台的已安装兄弟包 —— 本机装了某个兄弟变体时按它推断，并标出「推断」。
//     3. platformBinaryFamilies 审计条目。
//     4. 以上都拿不到 → licenseExpression = null，由扫描器判为 unknown 并让门禁失败。
//        这正是 issue 要求的「未知许可证直接判不合规」。
//   第 2 级的定义就是「本机恰好装了某个兄弟」，天然依赖平台；它只在没有事实快照时兜底，
//   真实仓库的审计结论不应再出现它（tools/test/license-platform-independence.test.mjs 锁这条）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)(\.|$)/i;

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// license 字段的三种历史写法都要认：字符串、已废弃的 licenses 数组、缺失。
function manifestToExpression(manifest) {
  if (!manifest) return null;
  if (typeof manifest.license === 'string' && manifest.license.trim())
    return manifest.license.trim();
  if (typeof manifest.license?.type === 'string' && manifest.license.type.trim())
    return manifest.license.type.trim();
  const list = Array.isArray(manifest.licenses)
    ? manifest.licenses
        .map((item) => (typeof item === 'string' ? item : item?.type))
        .filter(Boolean)
    : [];
  if (list.length > 0) return list.length === 1 ? list[0] : `(${list.join(' OR ')})`;
  // 显式区分「没写许可证」与「解析失败」：前者是 issue 点名的禁止项。
  return null;
}

// 建立 name@version -> { expression, dir, ... } 索引。
//   layout='pnpm'  真实仓库：<node_modules>/.pnpm/<entry>/node_modules/[<scope>/]<name>/package.json
//   layout='flat'  控制用例：<root>/<entry>/package.json
//                  fixture 用 flat 是刻意的：.gitignore 排除了任意层级的 node_modules/，
//                  而 git 无法重新包含「父目录已被排除」的文件，因此 fixture 里不出现 node_modules。
export function indexInstalledPackages(root, layout = 'pnpm') {
  const index = new Map();
  if (!isDirectory(root)) return index;

  const consider = (pkgDir) => {
    const manifest = readJsonSafe(join(pkgDir, 'package.json'));
    if (!manifest?.name || !manifest.version) return;
    const key = `${manifest.name}@${manifest.version}`;
    if (index.has(key)) return;
    index.set(key, {
      key,
      name: manifest.name,
      version: manifest.version,
      dir: pkgDir,
      expression: manifestToExpression(manifest),
      hasLicenseDeclaration: manifest.license !== undefined || manifest.licenses !== undefined,
      homepage: manifest.homepage ?? null,
      repository:
        typeof manifest.repository === 'string'
          ? manifest.repository
          : (manifest.repository?.url ?? null),
    });
  };

  if (layout === 'flat') {
    for (const entry of readdirSync(root).sort()) {
      const dir = join(root, entry);
      if (isDirectory(dir)) consider(dir);
    }
    return index;
  }

  const virtualStore = join(root, '.pnpm');
  if (!isDirectory(virtualStore)) return index;
  for (const entry of readdirSync(virtualStore)) {
    const inner = join(virtualStore, entry, 'node_modules');
    if (!isDirectory(inner)) continue;
    for (const name of readdirSync(inner)) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) {
        const scopeDir = join(inner, name);
        if (!isDirectory(scopeDir)) continue;
        for (const scoped of readdirSync(scopeDir)) consider(join(scopeDir, scoped));
      } else {
        consider(join(inner, name));
      }
    }
  }
  return index;
}

// 平台变体的「同族」候选：把名字尾部的平台标识 progressively 削掉，找同版本的已安装兄弟。
// 覆盖 @esbuild/<plat>、@rolldown/binding-<plat>、@typescript/typescript-<plat>、
// @pnpm/exe.<plat>、lightningcss-<plat>、unrs-resolver-<plat> 等常见形态。
export function familyPrefixes(name) {
  const prefixes = new Set();
  const segments = name.split('/');
  const last = segments[segments.length - 1];
  const scope = segments.length > 1 ? `${segments.slice(0, -1).join('/')}/` : '';

  for (const separator of ['-', '.']) {
    const parts = last.split(separator);
    for (let cut = parts.length - 1; cut >= 1; cut -= 1) {
      prefixes.add(`${scope}${parts.slice(0, cut).join(separator)}${separator}`);
    }
  }
  if (scope) prefixes.add(scope);
  return [...prefixes].sort((a, b) => b.length - a.length);
}

function findPlatformSibling(entry, installed) {
  const prefixes = familyPrefixes(entry.name);
  const siblings = [];
  for (const candidate of installed.values()) {
    if (candidate.version !== entry.version) continue;
    if (candidate.name === entry.name) continue;
    if (!prefixes.some((prefix) => candidate.name.startsWith(prefix))) continue;
    if (!candidate.expression) continue;
    siblings.push(candidate);
  }
  if (siblings.length === 0) return null;
  siblings.sort((a, b) => a.name.localeCompare(b.name));
  const expressions = new Set(siblings.map((item) => item.expression));
  // 同族兄弟给出互相矛盾的许可时不做裁决，交回 unknown 让人处理。
  if (expressions.size !== 1) return null;
  return {
    expression: siblings[0].expression,
    sibling: siblings[0].name,
    siblingCount: siblings.length,
  };
}

function findPolicyFamily(entry, policy) {
  const families = policy.platformBinaryFamilies?.entries ?? policy.platformBinaryFamilies ?? [];
  for (const family of Array.isArray(families) ? families : []) {
    const matched =
      (family.names ?? []).includes(entry.name) ||
      (family.prefixes ?? []).some((prefix) => entry.name.startsWith(prefix));
    if (!matched) continue;
    if (family.versions && !family.versions.includes(entry.version)) continue;
    return family;
  }
  return null;
}

export const SOURCE_INSTALLED = 'installed-manifest';
export const SOURCE_PLATFORM_SIBLING = 'platform-sibling-inferred';
export const SOURCE_POLICY = 'audited-policy-entry';
export const SOURCE_REGISTRY_FACTS = 'registry-facts';
export const SOURCE_NONE = 'unresolved';

// 「平台变体」= lockfile 为它声明了 os / cpu / libc 中的任何一个。
// 这类包 pnpm 只在匹配的平台上落地，所以「本机装没装」不构成事实，只构成偶然。
export function isPlatformConstrained(entry) {
  return Boolean(entry && (entry.os || entry.cpu || entry.libc));
}

// 注册表事实快照：{ [name@version]: { license, integrity, ... } } → Map。
// 文件不存在时返回 null（不是空 Map）——「没有快照」与「有快照但缺这一条」是两种情况：
// 前者退回逐级降级链（控制用例夹具依赖这个行为），后者必须 fail-closed。
export function loadRegistryFacts(file) {
  const document = readJsonSafe(file);
  if (!document || typeof document !== 'object' || !document.facts) return null;
  return new Map(Object.entries(document.facts));
}

function resolveFromFacts(entry, facts, installed) {
  const fact = facts.get(`${entry.name}@${entry.version}`);
  if (!fact) {
    return {
      expression: null,
      source: SOURCE_NONE,
      note:
        `lockfile 为它声明了平台约束（os/cpu/libc），但注册表事实快照里没有这一条。` +
        `请运行 pnpm license:registry-facts 重新生成 config/license-registry-facts.json 后提交`,
    };
  }
  // integrity 交叉校验：快照必须针对 lockfile 钉住的**那一个** tarball。
  // 对不上说明快照过期或被换过包，此时不猜，直接判 unknown。
  if (entry.integrity && fact.integrity && entry.integrity !== fact.integrity) {
    return {
      expression: null,
      source: SOURCE_NONE,
      note:
        `注册表事实的 integrity 与 lockfile 的 resolution.integrity 不一致（快照针对的是另一个 tarball）。` +
        `请运行 pnpm license:registry-facts 重新生成`,
    };
  }
  const expression = manifestToExpression(fact);
  const installedEntry = installed.get(`${entry.name}@${entry.version}`);
  // 本机恰好装了这个变体时，多一道一致性校验：已安装 manifest 与注册表快照说法不同
  // 就是矛盾，与「同族兄弟互相矛盾」同样处理 —— 不做裁决，交回 unknown。
  if (installedEntry?.expression && expression && installedEntry.expression !== expression) {
    return {
      expression: null,
      source: SOURCE_NONE,
      note: `已安装 manifest 声明 ${installedEntry.expression}，注册表事实快照声明 ${expression}，两者矛盾`,
    };
  }
  return {
    expression,
    source: SOURCE_REGISTRY_FACTS,
    hasLicenseDeclaration: fact.hasLicenseDeclaration !== false,
    homepage: fact.homepage ?? null,
    repository: fact.repository ?? null,
  };
}

export function createLicenseResolver({ installed, policy, facts = null }) {
  return function resolveLicense(entry) {
    const own = policy.ownPackages?.names ?? [];
    if (own.includes(entry.name)) {
      return { expression: policy.ownPackages?.license ?? 'AGPL-3.0-only', source: 'own-package' };
    }

    // 平台变体一律走与平台无关的事实来源，不看本机装了什么。
    if (facts && isPlatformConstrained(entry)) {
      const audited = findPolicyFamily(entry, policy);
      if (audited) {
        return {
          expression: audited.license,
          source: SOURCE_POLICY,
          policyId: audited.id,
          evidence: audited.evidence ?? [],
          homepage: audited.homepage ?? null,
        };
      }
      return resolveFromFacts(entry, facts, installed);
    }

    const installedEntry = installed.get(`${entry.name}@${entry.version}`);
    if (installedEntry?.expression) {
      return {
        expression: installedEntry.expression,
        source: SOURCE_INSTALLED,
        hasLicenseDeclaration: installedEntry.hasLicenseDeclaration,
        homepage: installedEntry.homepage,
        repository: installedEntry.repository,
      };
    }
    // 装了但没写 license 字段：这是 issue 明确列出的禁止项（无许可证声明），不能被后续降级洗白。
    if (installedEntry && installedEntry.hasLicenseDeclaration === false) {
      return {
        expression: null,
        source: SOURCE_INSTALLED,
        hasLicenseDeclaration: false,
        homepage: installedEntry.homepage,
        repository: installedEntry.repository,
        note: 'package.json 未声明 license/licenses 字段',
      };
    }

    const sibling = findPlatformSibling(entry, installed);
    if (sibling) {
      return {
        expression: sibling.expression,
        source: SOURCE_PLATFORM_SIBLING,
        inferredFrom: `${sibling.sibling}@${entry.version}`,
        siblingCount: sibling.siblingCount,
      };
    }

    const family = findPolicyFamily(entry, policy);
    if (family) {
      return {
        expression: family.license,
        source: SOURCE_POLICY,
        policyId: family.id,
        evidence: family.evidence ?? [],
        homepage: family.homepage ?? null,
      };
    }

    return { expression: null, source: SOURCE_NONE };
  };
}

export { LICENSE_FILE_PATTERN, manifestToExpression, readJsonSafe };

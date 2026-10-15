// 把 lockfile 里的每个包解析到一条许可表达式。
//
// 解析顺序（严格，逐级降级，最后一级是失败而不是猜测）：
//   1. 已安装的 package.json —— node_modules/.pnpm/*/node_modules/<name>/package.json
//   2. 同族平台的已安装兄弟包 —— 处理 lockfile 里那些本机没装的可选平台二进制
//      （@esbuild/aix-ppc64、@rolldown/binding-linux-x64-gnu、lightningcss-win32-x64-msvc …）。
//      这些包与已装的本机变体来自同一次发布，许可一致，但必须标出「推断」以免混入未审计内容。
//   3. config/license-policy.json 的 platformBinaryFamilies —— 只用于 pnpm 自锁文档里的
//      pnpm / @pnpm/exe.*，它们根本不经过 node_modules，只能凭带证据链接的审计条目放行。
//   4. 以上都拿不到 → licenseExpression = null，由扫描器判为 unknown 并让门禁失败。
//      这正是 issue 要求的「未知许可证直接判不合规」。
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
export const SOURCE_NONE = 'unresolved';

export function createLicenseResolver({ installed, policy }) {
  return function resolveLicense(entry) {
    const own = policy.ownPackages?.names ?? [];
    if (own.includes(entry.name)) {
      return { expression: policy.ownPackages?.license ?? 'AGPL-3.0-only', source: 'own-package' };
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

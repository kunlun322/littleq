// pnpm-lock.yaml 解析：许可与 SBOM 门禁的唯一事实来源。
//
// pnpm 12 的根 lockfile 是「双文档 YAML」：
//   doc 1 —— pnpm 自身的 lockfile（packageManagerDependencies: pnpm + @pnpm/exe.*），无 settings 字段
//   doc 2 —— 本项目的 lockfile（settings / importers / packages / snapshots）
// 只扫 doc 2 会漏掉包管理器本体这条供应链，因此两个文档都要进入审计闭包，
// 并用 origin 字段区分来源，便于报告里分开叙述。
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

export const ORIGIN_PROJECT = 'project';
export const ORIGIN_PACKAGE_MANAGER = 'package-manager';

// lockfile 里的 peer 后缀只有圆括号形式：name@1.2.3(peerA@1.0.0)(peerB@2.0.0)
export function stripPeerSuffix(value) {
  const index = value.indexOf('(');
  return index === -1 ? value : value.slice(0, index);
}

function splitPackageKey(key) {
  const base = stripPeerSuffix(key);
  const at = base.lastIndexOf('@');
  return { name: base.slice(0, at), version: base.slice(at + 1), base };
}

// importer/snapshot 里的依赖值可能是纯版本号（esbuild: 0.28.2），也可能是
// npm alias（typescript: '@typescript/typescript6@6.0.2'）。后者本身已经是 packages 的键。
function resolvePackageKey(depName, value, packages) {
  const base = stripPeerSuffix(value);
  return packages.has(base) ? base : `${depName}@${base}`;
}

function readDocument(doc, origin) {
  const object = doc.toJS();
  const packages = new Map();
  for (const [key, value] of Object.entries(object.packages ?? {})) {
    const { name, version, base } = splitPackageKey(key);
    packages.set(key, {
      key,
      base,
      name,
      version,
      origin,
      hasBin: value?.hasBin === true,
      cpu: value?.cpu ?? null,
      os: value?.os ?? null,
      integrity: value?.resolution?.integrity ?? null,
    });
  }
  return {
    origin,
    lockfileVersion: object.lockfileVersion,
    object,
    packages,
    snapshots: object.snapshots ?? {},
  };
}

export function readLockfile(file) {
  const raw = readFileSync(file, 'utf8');
  const documents = parseAllDocuments(raw).map((doc) => {
    const object = doc.toJS();
    // doc 2 才有 settings；以此区分项目 lockfile 与 pnpm 自锁文件。
    return readDocument(doc, object?.settings ? ORIGIN_PROJECT : ORIGIN_PACKAGE_MANAGER);
  });

  const packages = new Map();
  const snapshots = new Map();
  for (const doc of documents) {
    for (const [key, value] of doc.packages) packages.set(key, value);
    for (const [key, value] of Object.entries(doc.snapshots)) snapshots.set(key, value);
  }

  const project = documents.find((doc) => doc.origin === ORIGIN_PROJECT);
  if (!project) throw new Error(`${file}: 找不到项目 lockfile 文档（缺少 settings 字段）`);

  return {
    file,
    documents,
    packages,
    snapshots,
    importers: project.object.importers ?? {},
    project,
  };
}

// 依赖闭包：从 importers 出发沿 snapshots 的 dependencies / optionalDependencies 走一遍。
// lockfile v9 不再标注 `dev: true`，prod/dev 只能由 importer 的字段位置推出来。
// 一个包可能因不同 peer 解析出多个 snapshot，故按 base 键聚合后逐个遍历。
export function resolveClosure(lockfile) {
  const { importers, snapshots, packages } = lockfile;
  const snapshotsByBase = new Map();
  for (const key of snapshots.keys()) {
    const { base } = splitPackageKey(key);
    const list = snapshotsByBase.get(base);
    if (list) list.push(key);
    else snapshotsByBase.set(base, [key]);
  }

  const kind = new Map(); // package base key -> 'prod' | 'dev'

  const visit = (packageKey, nextKind) => {
    const current = kind.get(packageKey);
    if (current === nextKind) return;
    // prod 优先级高于 dev；已经按 prod 记过的子树无需再走一遍。
    if (current === 'prod') return;
    kind.set(packageKey, nextKind);

    for (const snapshotKey of snapshotsByBase.get(packageKey) ?? []) {
      const snapshot = snapshots.get(snapshotKey);
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const [depName, value] of Object.entries(snapshot?.[field] ?? {})) {
          if (typeof value !== 'string' || value.startsWith('link:')) continue;
          visit(resolvePackageKey(depName, value, packages), nextKind);
        }
      }
    }
  };

  for (const importer of Object.values(importers)) {
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      const nextKind = field === 'devDependencies' ? 'dev' : 'prod';
      for (const [depName, entry] of Object.entries(importer?.[field] ?? {})) {
        const version = entry?.version;
        if (typeof version !== 'string') continue;
        // workspace 链接指向仓库内的兄弟包，属于自有代码，不进第三方闭包。
        if (version.startsWith('link:')) continue;
        visit(resolvePackageKey(depName, version, packages), nextKind);
      }
    }
  }

  const entries = [];
  const orphaned = [];
  for (const [key, pkg] of packages) {
    if (kind.has(key)) entries.push({ ...pkg, kind: kind.get(key) });
    // packageManagerDependencies（pnpm 自锁文档）不经 importers 遍历，单独收进闭包。
    else if (pkg.origin === ORIGIN_PACKAGE_MANAGER) entries.push({ ...pkg, kind: 'dev' });
    else orphaned.push(key);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { entries, orphaned };
}

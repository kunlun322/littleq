// 许可事实收集：lockfile 闭包 × 许可证解析 × 策略判定，一次算清，供
// scan（门禁）/ third-party（THIRD_PARTY_LICENSES 生成）/ report（CI 摘要）共用。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readLockfile, resolveClosure } from './lockfile.mjs';
import {
  evaluateExpression,
  VERDICT_ALLOWED,
  VERDICT_FORBIDDEN,
  VERDICT_REVIEW,
  VERDICT_UNKNOWN,
} from './spdx.mjs';
import {
  createLicenseResolver,
  indexInstalledPackages,
  loadRegistryFacts,
  SOURCE_NONE,
} from './license-resolve.mjs';

export const ADJUDICATION_PENDING = 'pending-architect';
export const ADJUDICATION_APPROVED = 'approved';
export const ADJUDICATION_REJECTED = 'rejected';

// 「批准只在它写明的前提下有效」必须是代码，不能是注释 —— 注释不会在依赖图变化时变红。
//
// distributed:false 的批准（lightningcss MPL-2.0 ×12、minimatch BlueOak-1.0.0）之所以能放行，
// 唯一理由就是它们不随作品或镜像分发。这个前提不是永久成立的：把 devDependency 挪进
// dependencies、或让打包器把它拉进 bundle，都会让一份「不分发所以无所谓」的裁定
// 悄悄变成「我们正在分发一个未裁定的 copyleft 依赖」。
//
// 因此这里把前提本身当成门禁条件：前提一旦不成立，批准即失效，包退回 reviewRequired
// 且视同「未登记裁定」，由 scan/bundle-scan 以退出码 2 要求重新裁定。
// 返回 null 表示批准仍在适用范围内；返回字符串则是要打印给人的失效原因。
export function approvalOutOfScope(
  adjudication,
  { kind = null, inDistributionArtifact = false } = {},
) {
  if (!adjudication || adjudication.status !== ADJUDICATION_APPROVED) return null;
  if (adjudication.distributed !== false) return null;
  const label = `${adjudication.id ?? '<无 id>'}`;
  if (inDistributionArtifact) {
    return `裁定 ${label} 的前提是 distributed:false（不随产物分发），但它已被打包进分发产物`;
  }
  if (kind === 'prod') {
    return `裁定 ${label} 的前提是 distributed:false（不随产物分发），但它现在是生产依赖`;
  }
  return null;
}

export function npmLink(name, version) {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

function adjudicationEntries(policy) {
  const value = policy.adjudications?.entries ?? policy.adjudications ?? [];
  return Array.isArray(value) ? value : [];
}

function matches(entry, match) {
  if (!match) return false;
  if (match.names && !match.names.includes(entry.name)) return false;
  if (match.namePrefixes && !match.namePrefixes.some((prefix) => entry.name.startsWith(prefix)))
    return false;
  if (match.versions && !match.versions.includes(entry.version)) return false;
  return true;
}

export function findAdjudication(entry, policy) {
  return adjudicationEntries(policy).find((item) => matches(entry, item.match)) ?? null;
}

export function collect({
  repoRoot,
  lockfileFile = 'pnpm-lock.yaml',
  policyFile = 'config/license-policy.json',
  factsFile = 'config/license-registry-facts.json',
  installedRoot = null,
  installedLayout = 'pnpm',
}) {
  // resolve 而不是 join：这三个入参都可能是调用方传来的绝对路径（scan/sbom 直接把
  // --policy / --lockfile 透传下来），join(repoRoot, '/abs') 会拼成 <repoRoot>/abs 而 ENOENT。
  // 相对路径的行为不变——resolve 同样以 repoRoot 为基准，并且照样规范化 ../ 片段。
  const policy = JSON.parse(readFileSync(resolve(repoRoot, policyFile), 'utf8'));
  const lockfile = readLockfile(resolve(repoRoot, lockfileFile));
  const { entries, orphaned } = resolveClosure(lockfile);
  const installed = indexInstalledPackages(
    installedRoot ?? resolve(repoRoot, 'node_modules'),
    installedLayout,
  );
  // 注册表事实快照按 repoRoot 解析：控制用例夹具把 --repo-root 指向夹具目录，
  // 那里没有快照，于是 facts 为 null，解析器退回逐级降级链（夹具正是要测那条链）。
  const facts = loadRegistryFacts(resolve(repoRoot, factsFile));
  // 名字不能叫 resolve：那会在本函数里遮蔽 node:path 的 resolve，而上面三行正在用它，
  // 结果是 TDZ ReferenceError。许可证解析器一律叫 resolveLicense。
  const resolveLicense = createLicenseResolver({ installed, policy, facts });

  const resolved = entries.map((entry) => {
    const license = resolveLicense(entry);

    // 「装了却没写 license」是 issue 点名的禁止项：即使解析器给了 null，也要用 NOASSERTION
    // 把它表达出来，让报告里看得见原因，而不是笼统的 unknown。
    const expression =
      license.expression ?? (license.hasLicenseDeclaration === false ? 'NOASSERTION' : null);
    const evaluation = expression
      ? evaluateExpression(expression, policy)
      : { verdict: VERDICT_UNKNOWN, ids: [], exceptions: [], unknownExceptions: [] };

    const adjudication = findAdjudication(entry, policy);
    // 生产依赖身份在这里就能看出来，所以批准前提的第一半在本函数内直接判掉；
    // 另一半（是否真的进了分发产物）只有 bundle 扫描知道，由 bundle-scan.mjs 传入
    // inDistributionArtifact 再算一次。
    const outOfScope = approvalOutOfScope(adjudication, { kind: entry.kind });
    let verdict = evaluation.verdict;
    if (license.source === SOURCE_NONE) verdict = VERDICT_UNKNOWN;
    if (adjudication?.status === ADJUDICATION_APPROVED && verdict === VERDICT_REVIEW && !outOfScope)
      verdict = VERDICT_ALLOWED;
    if (adjudication?.status === ADJUDICATION_REJECTED) verdict = VERDICT_FORBIDDEN;

    return {
      ...entry,
      expression,
      ids: evaluation.ids,
      exceptions: evaluation.exceptions,
      unknownExceptions: evaluation.unknownExceptions,
      verdict,
      unresolved: license.source === SOURCE_NONE,
      licenseSource: license.source,
      inferredFrom: license.inferredFrom ?? null,
      homepage: license.homepage ?? null,
      repository: license.repository ?? null,
      evidence: license.evidence ?? null,
      policyId: license.policyId ?? null,
      note: license.note ?? null,
      adjudication: adjudication
        ? {
            id: adjudication.id,
            status: adjudication.status,
            distributed: adjudication.distributed ?? null,
            outOfScope,
          }
        : null,
      link: npmLink(entry.name, entry.version),
    };
  });

  const byVerdict = {
    [VERDICT_ALLOWED]: 0,
    [VERDICT_REVIEW]: 0,
    [VERDICT_FORBIDDEN]: 0,
    [VERDICT_UNKNOWN]: 0,
  };
  const byLicense = new Map();
  const bySource = new Map();
  for (const item of resolved) {
    byVerdict[item.verdict] += 1;
    const licenseKey = item.expression ?? '<none>';
    byLicense.set(licenseKey, (byLicense.get(licenseKey) ?? 0) + 1);
    bySource.set(item.licenseSource, (bySource.get(item.licenseSource) ?? 0) + 1);
  }

  return {
    policy,
    lockfile,
    installed,
    entries: resolved,
    orphaned,
    summary: {
      total: resolved.length,
      prod: resolved.filter((item) => item.kind === 'prod').length,
      dev: resolved.filter((item) => item.kind === 'dev').length,
      byOrigin: {
        project: resolved.filter((item) => item.origin === 'project').length,
        'package-manager': resolved.filter((item) => item.origin === 'package-manager').length,
      },
      byVerdict,
      byLicense: Object.fromEntries([...byLicense].sort((a, b) => a[0].localeCompare(b[0]))),
      bySource: Object.fromEntries([...bySource].sort((a, b) => a[0].localeCompare(b[0]))),
      needsAdjudication: resolved
        .filter((item) => item.verdict === VERDICT_REVIEW)
        .map((item) => `${item.name}@${item.version}`),
      // 批准前提已失效的条目单独列出：它们的裁定条目还在、status 还是 approved，
      // 但已经不能作为放行依据。混在 needsAdjudication 里会被读成「新依赖没登记」。
      // 只算 reviewRequired 的：许可本身在白名单内时批准根本没被用到，前提失效也不构成违规。
      approvalsOutOfScope: resolved
        .filter((item) => item.adjudication?.outOfScope && item.verdict === VERDICT_REVIEW)
        .map((item) => ({
          package: `${item.name}@${item.version}`,
          adjudication: item.adjudication.id,
          reason: item.adjudication.outOfScope,
        })),
    },
  };
}

export { VERDICT_ALLOWED, VERDICT_FORBIDDEN, VERDICT_REVIEW, VERDICT_UNKNOWN };

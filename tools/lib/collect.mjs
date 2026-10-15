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
import { createLicenseResolver, indexInstalledPackages, SOURCE_NONE } from './license-resolve.mjs';

export const ADJUDICATION_PENDING = 'pending-architect';
export const ADJUDICATION_APPROVED = 'approved';
export const ADJUDICATION_REJECTED = 'rejected';

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
  // 名字不能叫 resolve：那会在本函数里遮蔽 node:path 的 resolve，而上面三行正在用它，
  // 结果是 TDZ ReferenceError。许可证解析器一律叫 resolveLicense。
  const resolveLicense = createLicenseResolver({ installed, policy });

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
    let verdict = evaluation.verdict;
    if (license.source === SOURCE_NONE) verdict = VERDICT_UNKNOWN;
    if (adjudication?.status === ADJUDICATION_APPROVED && verdict === VERDICT_REVIEW)
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
      adjudication: adjudication ? { id: adjudication.id, status: adjudication.status } : null,
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
    },
  };
}

export { VERDICT_ALLOWED, VERDICT_FORBIDDEN, VERDICT_REVIEW, VERDICT_UNKNOWN };

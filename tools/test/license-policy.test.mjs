// 许可证门禁的判定核心测试。
//
// 覆盖三层：SPDX 表达式求值（纯函数）、策略文件本身的不变量（issue 点名的白名单/禁止项，
// 以及「GPL/LGPL/MPL 不得自行判定」）、以及真实 lockfile 闭包的审计结论。
//
// 闭包断言把「许可来源」钉成不变量而不是分布计数：ZLQ-162 之前这里刻意只钉与平台无关的量，
// 因为 pnpm 只安装匹配当前 os/cpu 的可选平台二进制，同一个包在 macOS 上解析来源是
// installed-manifest、到 ubuntu-latest 上就变成 platform-sibling-inferred —— 任何写死来源的
// 断言在两个平台上必有一个是假的。那正是 issue 里的第二个缺陷。
// 现在平台变体一律走提交进仓库的注册表事实快照，licenseSource 只由 (name, version) 决定，
// 于是可以把更强的性质钉死：被 os/cpu/libc 约束的条目**永不**依赖本机装了什么。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADJUDICATION_APPROVED, collect, findAdjudication, npmLink } from '../lib/collect.mjs';
import {
  familyPrefixes,
  isPlatformConstrained,
  manifestToExpression,
} from '../lib/license-resolve.mjs';
import { resolveClosure, stripPeerSuffix } from '../lib/lockfile.mjs';
import {
  classifyLicenseId,
  evaluateExpression,
  extractLicenseIds,
  VERDICT_ALLOWED,
  VERDICT_FORBIDDEN,
  VERDICT_REVIEW,
  VERDICT_UNKNOWN,
} from '../lib/spdx.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const POLICY_FILE = join(REPO_ROOT, 'config', 'license-policy.json');
const policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));

// issue 与 ZLQ-153 §10.3 给出的白名单，逐字对齐。
const REQUIRED_ALLOWED = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD'];

const verdictOf = (expression) => evaluateExpression(expression, policy).verdict;

describe('SPDX 表达式求值', () => {
  it.each(REQUIRED_ALLOWED)('%s 判为允许', (id) => {
    expect(verdictOf(id)).toBe(VERDICT_ALLOWED);
  });

  it('白名单之外一律不自动放行', () => {
    expect(verdictOf('MPL-2.0')).toBe(VERDICT_REVIEW);
    expect(verdictOf('GPL-3.0-only')).toBe(VERDICT_REVIEW);
    expect(verdictOf('LGPL-2.1-or-later')).toBe(VERDICT_REVIEW);
    expect(verdictOf('AGPL-3.0-only')).toBe(VERDICT_REVIEW);
    expect(verdictOf('BlueOak-1.0.0')).toBe(VERDICT_REVIEW);
    expect(verdictOf('WTFPL')).toBe(VERDICT_REVIEW);
  });

  it('issue 点名的禁止项判为禁止', () => {
    expect(verdictOf('UNLICENSED')).toBe(VERDICT_FORBIDDEN);
    expect(verdictOf('NOASSERTION')).toBe(VERDICT_FORBIDDEN);
    expect(verdictOf('SSPL-1.0')).toBe(VERDICT_FORBIDDEN);
    expect(verdictOf('BUSL-1.1')).toBe(VERDICT_FORBIDDEN);
    expect(verdictOf('GPL-2.0-only')).toBe(VERDICT_FORBIDDEN);
    // 自由文本形式的「商业-only / 见某文件」必须被 substring 规则拦住，
    // 否则它会掉进 unknown —— 而 unknown 只是「无法解析」，报告里看不出这是商业条款。
    expect(verdictOf('SEE LICENSE IN proprietary-terms.txt')).toBe(VERDICT_FORBIDDEN);
    expect(verdictOf('Commercial Only')).toBe(VERDICT_FORBIDDEN);
    expect(verdictOf('CC-BY-NC-4.0')).toBe(VERDICT_FORBIDDEN);
  });

  it('多词的自由文本禁止条款不会因为按空白切词而漏网', () => {
    // 回归锁：substring 规则过去只在切词后的单个 token 上生效，
    // 于是 "Commercial Only" 被切成 Commercial / Only，两个都匹配不上 "commercial only"，
    // 整条降为 unknown。修法是同时在整条表达式上跑一遍 substring 规则。
    for (const text of [
      'Commercial Only',
      'commercial-only',
      'Source Available',
      'Non Commercial',
      'Commons Clause',
      'Elastic License',
      'SEE LICENSE IN anything.txt',
      'Proprietary',
    ]) {
      expect(verdictOf(text), `${text} 应判为禁止`).toBe(VERDICT_FORBIDDEN);
    }
    // 反向：确实认不出的自由文本仍然是 unknown，不能被 substring 规则一把抓成禁止。
    expect(verdictOf('Some Weird Custom Terms')).toBe(VERDICT_UNKNOWN);
    // 合法 SPDX 表达式不会被整串匹配误伤。
    expect(verdictOf('(MIT OR Apache-2.0)')).toBe(VERDICT_ALLOWED);
    expect(verdictOf('Apache-2.0 WITH LLVM-exception')).toBe(VERDICT_ALLOWED);
  });

  it('认不出的许可 id 判为 unknown（未知即不合规，不放行）', () => {
    expect(verdictOf('SomeMadeUp-License-1.0')).toBe(VERDICT_UNKNOWN);
    expect(verdictOf('')).toBe(VERDICT_UNKNOWN);
    expect(verdictOf(null)).toBe(VERDICT_UNKNOWN);
  });

  it('复合表达式按最保守的一支合并', () => {
    expect(verdictOf('(MIT OR Apache-2.0)')).toBe(VERDICT_ALLOWED);
    // OR 里出现禁止项：双许可下对方仍可能选到禁止的那一支，不能因为有一支合规就放行。
    expect(verdictOf('(MIT OR SSPL-1.0)')).toBe(VERDICT_FORBIDDEN);
    // AND 里出现待裁定项：整体授权条件包含 copyleft，必须送裁定。
    expect(verdictOf('(MIT AND MPL-2.0)')).toBe(VERDICT_REVIEW);
    expect(verdictOf('(Apache-2.0 AND SomeMadeUp-1.0)')).toBe(VERDICT_UNKNOWN);
    // 禁止 > 未知 > 待裁定 > 允许。
    expect(verdictOf('(MPL-2.0 OR UNLICENSED)')).toBe(VERDICT_FORBIDDEN);
  });

  it('`+` 后缀按去掉后缀的 id 查表，但 id 本身原样保留', () => {
    // GPL-2.0+ 与 GPL-2.0-only 授权范围不同，报告里要能区分；判定上两者都禁止。
    expect(verdictOf('GPL-2.0+')).toBe(VERDICT_FORBIDDEN);
    expect(verdictOf('Apache-2.0+')).toBe(VERDICT_ALLOWED);
    expect(extractLicenseIds('Apache-2.0+').ids).toEqual(['Apache-2.0+']);
  });

  it('WITH 异常：白名单内不影响判定，白名单外整条降为 unknown', () => {
    expect(verdictOf('Apache-2.0 WITH LLVM-exception')).toBe(VERDICT_ALLOWED);
    expect(verdictOf('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(VERDICT_FORBIDDEN);
    const unknownException = evaluateExpression('Apache-2.0 WITH SomeCustomThing', policy);
    expect(unknownException.verdict).toBe(VERDICT_UNKNOWN);
    expect(unknownException.unknownExceptions).toEqual(['SomeCustomThing']);
  });

  it('extractLicenseIds 把操作符、括号与异常分清楚', () => {
    expect(extractLicenseIds('(MIT OR Apache-2.0) WITH LLVM-exception')).toEqual({
      ids: ['MIT', 'Apache-2.0'],
      exceptions: ['LLVM-exception'],
    });
  });

  it('classifyLicenseId 的优先级是 禁止 > 允许 > 待裁定 > unknown', () => {
    // GPL-2.0-only 同时在 forbidden.exact；若 allowed 抢先，就会被放行。
    expect(classifyLicenseId('GPL-2.0-only', policy)).toBe(VERDICT_FORBIDDEN);
    expect(classifyLicenseId('MIT', policy)).toBe(VERDICT_ALLOWED);
    expect(classifyLicenseId('MPL-2.0', policy)).toBe(VERDICT_REVIEW);
  });
});

describe('策略文件的不变量', () => {
  it('allowed 恰好是 issue 要求的六项，没有被顺手放宽', () => {
    expect([...policy.allowed].sort()).toEqual([...REQUIRED_ALLOWED].sort());
  });

  it('copyleft 族全部落在 reviewRequired，且没有一个混进 allowed', () => {
    const review = new Set(policy.reviewRequired.exact);
    for (const id of [
      'MPL-2.0',
      'GPL-3.0-only',
      'GPL-2.0-or-later',
      'LGPL-2.1-or-later',
      'AGPL-3.0-only',
    ]) {
      expect(review.has(id), `${id} 应在 reviewRequired`).toBe(true);
      expect(policy.allowed.includes(id), `${id} 不得出现在 allowed`).toBe(false);
    }
  });

  it('每条裁定登记都带 id/status/许可证/证据链接与提出任务号', () => {
    const entries = policy.adjudications.entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(policy.adjudications.statusValues).toContain(entry.status);
      expect(entry.license).toBeTruthy();
      expect(entry.links.length).toBeGreaterThan(0);
      expect(entry.links.every((link) => link.startsWith('https://'))).toBe(true);
      expect(entry.raisedIn).toBe('ZLQ-159');
      expect(entry.requestedReviewer).toBe('架构师');
      expect(entry.match).toBeTruthy();
    }
  });

  it('已批准的裁定必须可追责：谁裁的、在哪个任务里、按什么理由，并声明 distributed 前提', () => {
    // 批准是门禁的放行依据，所以它必须可追责。裁定人/任务号缺失的话，日后没人能判断
    // 这条批准还该不该成立；distributed 缺失的话 approvalOutOfScope() 会直接放过它
    // （判断是 `distributed !== false` 就返回 null），等于批准变成无条件有效。
    const approved = policy.adjudications.entries.filter(
      (entry) => entry.status === ADJUDICATION_APPROVED,
    );
    expect(approved.length).toBeGreaterThan(0);
    for (const entry of approved) {
      expect(entry.adjudicatedIn, `${entry.id} 缺裁定任务号`).toBeTruthy();
      expect(entry.adjudicatedBy, `${entry.id} 缺裁定人`).toBeTruthy();
      expect(entry.ruling, `${entry.id} 缺裁定理由`).toBeTruthy();
      expect(entry.ruling, `${entry.id} 的理由没写明前提由代码强制`).toContain('distributed:false');
      expect(typeof entry.distributed, `${entry.id} 未声明 distributed 前提`).toBe('boolean');
    }
    // 当前两条批准（ZLQ-162 治理裁定 3）都以「不随作品或镜像分发」为前提。
    // 钉住清单是为了让「新增一条批准」成为一次有意识的改动，而不是悄悄多出一行。
    expect(approved.map((entry) => entry.id).sort()).toEqual([
      'lightningcss-mpl-2.0',
      'minimatch-blueoak-1.0.0',
    ]);
    for (const entry of approved)
      expect(entry.distributed, `${entry.id} 的前提应当是不分发`).toBe(false);
  });

  it('批准没有顺手放宽许可档位：MPL-2.0 与 BlueOak-1.0.0 仍在 reviewRequired', () => {
    // 治理裁定 3 的口径是「这 13 项允许，但许可档位不动」—— 放行只针对已登记的
    // (name|namePrefix, version)。把档位加进白名单会让下一个未登记的 MPL 依赖自动通过，
    // 那才是真的放宽闸门。
    expect(policy.allowed).not.toContain('MPL-2.0');
    expect(policy.allowed).not.toContain('BlueOak-1.0.0');
    expect(policy.reviewRequired.exact).toContain('MPL-2.0');
    expect(policy.reviewRequired.exact).toContain('BlueOak-1.0.0');
    // 未登记的包拿不到任何裁定条目，因此仍会停在 review-required → scan.mjs 退出码 2。
    expect(findAdjudication({ name: 'some-unregistered-mpl-lib', version: '9.9.9' }, policy)).toBe(
      null,
    );
  });

  it('平台二进制家族的审计条目必须带证据，且只用于 pnpm 自锁文档', () => {
    for (const family of policy.platformBinaryFamilies.entries) {
      expect(family.evidence?.length, `${family.id} 缺证据链接`).toBeGreaterThan(0);
      expect(family.license).toBeTruthy();
      expect(family.auditedIn).toBeTruthy();
    }
  });

  it('三处扫描目标的状态与 ZLQ-153 §10.3 一致：前两项已接通，镜像留显式 TODO', () => {
    expect(policy.scanTargets.sourcePackages.enabled).toBe(true);
    expect(policy.scanTargets.webBundle.enabled).toBe(true);
    expect(policy.scanTargets.dockerImage.enabled).toBe(false);
    // 「留接口 + 显式 TODO」不能只是一句注释：阻塞任务号与待办步骤都要能被机器读到。
    expect(policy.scanTargets.dockerImage.blockedBy).toBe('ZLQ-157');
    expect(policy.scanTargets.dockerImage.todo).toContain('cdxgen');
    expect(policy.scanTargets.dockerImage.tool).toBe('tools/license/image-scan.mjs');
  });

  it('CONTRIBUTING.md 的三档清单与策略逐字一致：文档不得与门禁漂移', () => {
    // ZLQ-162 治理裁定 1 修的就是这个漂移。此前文档把 MPL-2.0、AGPL-3.0、GPL-3.0-or-later、
    // Zlib、Unlicense、CC0-1.0 写成「允许」，而门禁一直把它们判成待裁定 —— 文档不会自己报错，
    // 于是「贡献指南说的」和「CI 判的」成了两套口径，正是本任务书点名的那类缺陷。
    // 提取规则刻意很笨：只认「三档标题行 → 下一个 ** 或 # 行」之间的反引号内容。
    // 代价是文档那三块里不能给别的东西加反引号，这条约束写在 CONTRIBUTING.md 开头。
    const doc = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 依赖许可证准入规则'));
    expect(section.length, 'CONTRIBUTING.md 里找不到「依赖许可证准入规则」一节').toBeGreaterThan(0);

    const listed = (header) => {
      const start = section.indexOf(`**${header}**`);
      expect(start, `CONTRIBUTING.md 里找不到 **${header}** 这一档`).toBeGreaterThan(-1);
      const lines = section.slice(start).split('\n');
      const body = [];
      for (const [index, line] of lines.entries()) {
        if (index > 0 && (line.startsWith('**') || line.startsWith('#'))) break;
        body.push(line);
      }
      const ids = [...body.join('\n').matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
      expect(ids.length, `**${header}** 档下一个标识符都没列`).toBeGreaterThan(0);
      expect(new Set(ids).size, `**${header}** 档下有重复条目`).toBe(ids.length);
      return [...ids].sort();
    };

    expect(listed('允许'), 'CONTRIBUTING.md 的「允许」档与 policy.allowed 不一致').toEqual(
      [...policy.allowed].sort(),
    );
    expect(
      listed('需逐案评审'),
      'CONTRIBUTING.md 的「需逐案评审」档与 policy.reviewRequired.exact 不一致',
    ).toEqual([...policy.reviewRequired.exact].sort());
    expect(listed('禁止'), 'CONTRIBUTING.md 的「禁止」档与 policy.forbidden 不一致').toEqual(
      [...policy.forbidden.exact, ...policy.forbidden.substringCaseInsensitive].sort(),
    );
  });
});

describe('真实 lockfile 闭包的审计结论', () => {
  // 一次算清，后面各条断言共用。ZLQ-159 交付时的审计基线：
  // 闭包 225 个第三方包（项目 lockfile 210 + pnpm 自锁文档 15），生产依赖仅 zod 一个。
  const result = collect({ repoRoot: REPO_ROOT });

  it('闭包非空，且覆盖了 pnpm 自锁文档（包管理器本体也是供应链）', () => {
    expect(result.entries.length).toBeGreaterThan(200);
    expect(result.summary.byOrigin.project).toBeGreaterThan(200);
    expect(result.summary.byOrigin['package-manager']).toBe(15);
    expect(result.entries.some((item) => item.name === 'pnpm')).toBe(true);
  });

  it('生产依赖只有 zod —— 其余全部是构建期依赖', () => {
    const prod = result.entries.filter((item) => item.kind === 'prod');
    expect(prod.map((item) => `${item.name}@${item.version}`)).toEqual(['zod@4.6.7']);
    expect(result.summary.prod).toBe(1);
    expect(result.summary.dev).toBe(result.entries.length - 1);
  });

  it('0 禁止、0 未知、0 游离条目', () => {
    expect(result.summary.byVerdict[VERDICT_FORBIDDEN]).toBe(0);
    expect(result.summary.byVerdict[VERDICT_UNKNOWN]).toBe(0);
    // 游离条目 = lockfile 里有、但从任何 importer 都走不到 → 有依赖没被审计到。
    expect(result.orphaned).toEqual([]);
  });

  it('许可档位为 reviewRequired 的条目全部已批准，且批准前提（不分发的 dev 依赖）成立', () => {
    // ZLQ-162 治理裁定 3 把 13 项待裁定（lightningcss MPL-2.0 ×12、minimatch BlueOak-1.0.0）
    // 全部翻成 approved，于是 verdict === review-required 的条目数归零。断言若还盯着 verdict
    // 就会空转（循环体一次都不执行），所以改成盯**许可档位**：凡是许可本身落在
    // reviewRequired 的条目，都必须已登记、已批准、批准前提成立、且确实是 dev 依赖。
    const reviewTier = result.entries.filter((item) =>
      (item.ids ?? []).some(
        (id) => classifyLicenseId(id.replace(/\+$/, ''), policy) === VERDICT_REVIEW,
      ),
    );
    // 空集会让下面所有断言空转，先把「确实存在这一档」钉住。
    expect(reviewTier.length).toBeGreaterThan(0);
    for (const item of reviewTier) {
      const label = `${item.name}@${item.version}（${item.expression}）`;
      expect(item.adjudication, `${label} 未登记裁定条目`).not.toBeNull();
      expect(item.adjudication.status, `${label} 的裁定不是 approved`).toBe(ADJUDICATION_APPROVED);
      // distributed:false 是批准的**前提**而不是备注：approvalOutOfScope() 按它判断批准是否还适用。
      expect(item.adjudication.distributed, `${label} 的批准没写明前提`).toBe(false);
      expect(item.adjudication.outOfScope, `${label} 的批准前提已失效`).toBe(null);
      expect(item.kind, `${label} 是生产依赖，distributed:false 的批准不适用`).toBe('dev');
      expect(item.verdict, `${label} 已批准却未被放行`).toBe(VERDICT_ALLOWED);
      expect(item.link).toBe(npmLink(item.name, item.version));
    }
    // 报告里不该再有任何待裁定项。needsAdjudication 是「verdict 仍为 review-required」的清单，
    // approvalsOutOfScope 是「批准前提已失效」的清单 —— 两者都必须为空，门禁才是退出码 0。
    expect(result.summary.needsAdjudication).toEqual([]);
    expect(result.summary.approvalsOutOfScope).toEqual([]);
    expect(result.summary.byVerdict[VERDICT_REVIEW]).toBe(0);
  });

  it('判为允许的项，许可证一定落在六项白名单内', () => {
    for (const item of result.entries.filter((entry) => entry.verdict === VERDICT_ALLOWED)) {
      if (item.adjudication) continue; // 经架构师裁定 approved 的项视同允许，许可证可以不在白名单
      for (const id of item.ids) expect(REQUIRED_ALLOWED).toContain(id.replace(/\+$/, ''));
    }
  });

  it('每条许可结论都注明了解析来源，推断项还注明推断自谁', () => {
    const sources = new Set(Object.keys(result.summary.bySource));
    expect(sources.has('unresolved'), '出现 unresolved 说明有依赖没解析出许可证').toBe(false);
    for (const item of result.entries) {
      expect(item.licenseSource).toBeTruthy();
      expect(item.expression).toBeTruthy();
      if (item.licenseSource === 'platform-sibling-inferred') {
        expect(item.inferredFrom).toMatch(/@/);
      }
    }
  });

  it('被 os/cpu/libc 约束的条目一律不靠「本机装了什么」解析', () => {
    const constrained = result.entries.filter(isPlatformConstrained);
    // 空集会让下面三条断言全部空转，所以先把「确实存在平台变体」钉住。
    expect(constrained.length).toBeGreaterThan(50);
    for (const item of constrained) {
      expect(
        ['registry-facts', 'audited-policy-entry'],
        `${item.name}@${item.version} 的来源是 ${item.licenseSource}，` +
          '这意味着它的判定取决于 runner 上是否恰好装了这个平台变体',
      ).toContain(item.licenseSource);
      // 快照与本机已安装 manifest 说法矛盾时解析器返回 unresolved，上面那条已经排除；
      // 这里再钉一次事实来源确实带了可核对的出处，而不是一句「查过了」。
      if (item.licenseSource === 'registry-facts') {
        expect(item.evidence ?? item.homepage ?? item.repository).toBeTruthy();
      } else {
        expect(item.policyId).toBeTruthy();
      }
    }
  });

  it('无平台约束的条目仍从已安装 manifest 解析 —— 快照不是绕过安装检查的后门', () => {
    // 反向断言：如果注册表事实快照被用来给所有包发证，那「已装但未声明 license」这一
    // 禁止项就再也查不出来了（快照里根本不存在这种包，registry 上的元数据总有 license 字段）。
    // 只让平台变体走快照，才能让本机装得到的包继续被真实 manifest 检验。
    const unconstrained = result.entries.filter(
      (item) => !isPlatformConstrained(item) && item.licenseSource !== 'audited-policy-entry',
    );
    expect(unconstrained.length).toBeGreaterThan(100);
    for (const item of unconstrained) {
      expect(
        item.licenseSource,
        `${item.name}@${item.version} 没有平台约束，本机能装到它，就该读真实的 package.json`,
      ).toBe('installed-manifest');
    }
  });

  it('自有工作区包按 AGPL-3.0-only 处理，不混进第三方审计', () => {
    const own = result.entries.filter((item) => item.licenseSource === 'own-package');
    expect(own).toEqual([]); // workspace link: 依赖不进闭包，自有包只在 SBOM 里以 own-workspace-package 出现
    expect(result.entries.some((item) => item.name.startsWith('@littleq/'))).toBe(false);
  });

  it('闭包与 lockfile 文档解析一致：packages 总数 = 闭包 + 游离', () => {
    const { packages } = result.lockfile;
    const closure = resolveClosure(result.lockfile);
    expect(closure.entries.length + closure.orphaned.length).toBe(packages.size);
  });
});

describe('lockfile 与解析器的辅助函数', () => {
  it('stripPeerSuffix 只削圆括号后缀', () => {
    expect(stripPeerSuffix('zod@4.6.7')).toBe('zod@4.6.7');
    expect(stripPeerSuffix('@scope/pkg@1.0.0(peer@2.0.0)(other@3.0.0)')).toBe('@scope/pkg@1.0.0');
  });

  it('manifestToExpression 认字符串、已废弃的 licenses 数组与缺失三种写法', () => {
    expect(manifestToExpression({ license: 'MIT' })).toBe('MIT');
    expect(manifestToExpression({ license: { type: 'Apache-2.0' } })).toBe('Apache-2.0');
    expect(manifestToExpression({ licenses: [{ type: 'MIT' }] })).toBe('MIT');
    expect(manifestToExpression({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT OR Apache-2.0)',
    );
    // 缺失必须返回 null 而不是猜测：「没写许可证」是 issue 点名的禁止项。
    expect(manifestToExpression({})).toBeNull();
    expect(manifestToExpression(null)).toBeNull();
  });

  it('familyPrefixes 覆盖常见的平台变体命名，且长前缀优先', () => {
    expect(familyPrefixes('@esbuild/darwin-arm64')).toContain('@esbuild/');
    expect(familyPrefixes('lightningcss-win32-x64-msvc')).toContain('lightningcss-');
    expect(familyPrefixes('@pnpm/exe.linux-x64')).toContain('@pnpm/exe.');
    const prefixes = familyPrefixes('fakebuild-linux-x64');
    // 长前缀排在前：先用最具体的家族名去找兄弟，找不到再退到更宽的前缀。
    expect(prefixes).toEqual(['fakebuild-linux-', 'fakebuild-']);
    // 无分隔符的名字不产生任何前缀，避免把整个包名当成家族。
    expect(familyPrefixes('zod')).toEqual([]);
  });

  it('findAdjudication 按 names / namePrefixes / versions 精确匹配', () => {
    expect(findAdjudication({ name: 'minimatch', version: '10.2.6' }, policy)?.id).toBe(
      'minimatch-blueoak-1.0.0',
    );
    expect(findAdjudication({ name: 'minimatch', version: '9.0.0' }, policy)).toBeNull();
    expect(
      findAdjudication({ name: 'lightningcss-linux-x64-gnu', version: '1.33.0' }, policy)?.id,
    ).toBe('lightningcss-mpl-2.0');
    expect(findAdjudication({ name: 'zod', version: '4.6.7' }, policy)).toBeNull();
  });
});

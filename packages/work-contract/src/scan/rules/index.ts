/**
 * B1–B13 规则注册表。
 *
 * §3 要求「逐条实现，**不得合并**、不得降级为正则」。前一半在文件结构上已经可见
 * （十三条规则 = 十三个模块，各自声明自己的 `subTypes`），这里补上**可执行**的那一半：
 * `registryViolations()` 把「合并」变成能被测出来的东西 ——
 * id 集合必须恰好等于 `RULE_IDS`、顺序必须一致、子类型不得跨规则共用。
 * 少了任何一条，两条规则被合成一条就会静默通过。
 *
 * 这个函数是**纯**的（返回违规清单而不是抛异常）：注册表在模块加载时抛错会让整包不可用，
 * 而漂移是编码错误，该由测试在 CI 里抓住，不该由生产运行时替测试兜底。
 */

import { FROZEN_DISPOSITION_CEILING, dispositionRank } from '../finding.js';
import type { RuleId } from '../types.js';
import { RULE_IDS } from '../types.js';
import { b01ExternalResource } from './b01-external-resource.js';
import { b02NetworkRequest } from './b02-network-request.js';
import { b03TopNavigation } from './b03-top-navigation.js';
import { b04Download } from './b04-download.js';
import { b05CrossSiteForm } from './b05-cross-site-form.js';
import { b06ParentMessaging } from './b06-parent-messaging.js';
import { b07SensitiveApi } from './b07-sensitive-api.js';
import { b08PersonalInformation } from './b08-personal-information.js';
import { b09MiningTracking } from './b09-mining-tracking.js';
import { b10Obfuscation } from './b10-obfuscation.js';
import { b11Ai } from './b11-ai.js';
import { b12FalseCapability } from './b12-false-capability.js';
import { b13InappropriateContent } from './b13-inappropriate-content.js';
import type { Rule } from './types.js';

/** 顺序即 `RULE_IDS` 的顺序：判定顺序确定，同一份输入才可能给出同一份报告（§6.3）。 */
export const RULES: readonly Rule[] = [
  b01ExternalResource,
  b02NetworkRequest,
  b03TopNavigation,
  b04Download,
  b05CrossSiteForm,
  b06ParentMessaging,
  b07SensitiveApi,
  b08PersonalInformation,
  b09MiningTracking,
  b10Obfuscation,
  b11Ai,
  b12FalseCapability,
  b13InappropriateContent,
];

export const RULE_BY_ID: ReadonlyMap<RuleId, Rule> = new Map(RULES.map((rule) => [rule.id, rule]));

/**
 * 「B12 永不硬拦」的**第二**道结构保证（第一道是 `FindingFactory` 的处置上限会抛异常）。
 * 写在这里是因为它属于契约而不是实现细节：ZLQ-201 PASS §6 的不可谈判项 2 是规则集的属性。
 */
const CONFIRM_ONLY_RULE_IDS: readonly RuleId[] = ['B12'];

export class UndeclaredSubTypeError extends Error {
  readonly code = 'UNDECLARED_SUB_TYPE' as const;
  constructor(
    readonly ruleId: RuleId,
    readonly subType: string,
  ) {
    super(`rule ${ruleId} emitted undeclared subType ${JSON.stringify(subType)}`);
    this.name = 'UndeclaredSubTypeError';
  }
}

/** 发射前校验：子类型必须在该规则自己声明的清单里。fail-closed，不静默改写。 */
export function assertDeclaredSubType(ruleId: RuleId, subType: string): void {
  const rule = RULE_BY_ID.get(ruleId);
  if (rule === undefined) throw new UndeclaredSubTypeError(ruleId, subType);
  if (!(rule.subTypes as readonly string[]).includes(subType))
    throw new UndeclaredSubTypeError(ruleId, subType);
}

export function registryViolations(): string[] {
  const violations: string[] = [];

  const ids = RULES.map((rule) => rule.id);
  const seen = new Set<RuleId>();
  for (const id of ids) {
    if (seen.has(id)) violations.push(`规则 id 重复：${id}`);
    seen.add(id);
  }
  for (const id of RULE_IDS) if (!seen.has(id)) violations.push(`缺少规则：${id}`);
  for (const id of seen) if (!RULE_IDS.includes(id)) violations.push(`未在册的规则 id：${id}`);
  if (ids.join(',') !== RULE_IDS.join(','))
    violations.push(`规则顺序与 RULE_IDS 不一致：${ids.join(',')}`);

  const ownerOfSubType = new Map<string, RuleId>();
  for (const rule of RULES) {
    if (rule.subTypes.length === 0) violations.push(`${rule.id} 没有声明任何子类型`);
    const declared = new Set<string>();
    for (const subType of rule.subTypes) {
      if (declared.has(subType)) violations.push(`${rule.id} 子类型重复：${subType}`);
      declared.add(subType);
      const owner = ownerOfSubType.get(subType);
      if (owner !== undefined && owner !== rule.id) {
        violations.push(`子类型 ${subType} 被 ${owner} 与 ${rule.id} 共用（规则 ID 必须可解释）`);
      }
      ownerOfSubType.set(subType, rule.id);
    }

    if (CONFIRM_ONLY_RULE_IDS.includes(rule.id) && rule.maxDisposition !== 'CONFIRM_REQUIRED') {
      violations.push(`${rule.id} 的处置上限必须是 CONFIRM_REQUIRED（§8.3「只标记确认，不硬拦」）`);
    }

    // 第四条「B12 永不硬拦」的结构保证，也是 `finding.ts` 里 `FROZEN_DISPOSITION_CEILING`
    // 文档承诺的那道闸：规则**自己声明**的上限不得比冻结上限宽。
    // 它和上面那条 `CONFIRM_ONLY_RULE_IDS` 检查刻意分开写 —— 前者是「B12 必须是确认」这个
    // 具体契约，后者是「任何规则都不得自我扩权」这个通用不变量；只留一条的话，
    // 把 B8 的声明改成 BLOCK 就没人管了（`FindingFactory` 会在运行时拦住，但那是发射时才发现）。
    const frozen = FROZEN_DISPOSITION_CEILING[rule.id];
    if (dispositionRank(rule.maxDisposition) > dispositionRank(frozen)) {
      violations.push(
        `${rule.id} 自己声明的处置上限 ${rule.maxDisposition} 宽于冻结上限 ${frozen}（规则不得自我扩权）`,
      );
    }
  }

  return violations;
}

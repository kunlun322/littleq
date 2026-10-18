import { DomainError } from '../errors/domain-error.js';
import { integerValueObject, textValueObject } from './primitives.js';
import { stringEnum } from './enum.js';

/**
 * Reward 聚合的值对象（ZLQ-153 §4.7 / 附录 A §6.1、§6.3）。
 *
 * `rule_json` 与 `asset_key` 的物理形态属于 infra；进入 domain 前必须解析成
 * 这里的有类型 `AchievementRule` 与不可透明 `ArtifactRef`（附录 A §6.4）。
 */

/** `achievements.code`：稳定的机器码，儿童可见文案走 `title` 与 message key。 */
export const ACHIEVEMENT_CODE_MAX_LENGTH = 64;
const achievementCodeValue = textValueObject('AchievementCode', 2, ACHIEVEMENT_CODE_MAX_LENGTH);
export type AchievementCode = ReturnType<typeof achievementCodeValue.parse>;
export const isAchievementCode = achievementCodeValue.is;
export const parseAchievementCode = achievementCodeValue.parse;

export const ACHIEVEMENT_TITLE_MAX_LENGTH = 60;
const achievementTitleValue = textValueObject('AchievementTitle', 1, ACHIEVEMENT_TITLE_MAX_LENGTH);
export type AchievementTitle = ReturnType<typeof achievementTitleValue.parse>;
export const isAchievementTitle = achievementTitleValue.is;
export const parseAchievementTitle = achievementTitleValue.parse;

/**
 * `achievement_unlocks.source_event_key`：解锁来源事件的幂等键。
 * 与 `(user, achievement)` 联合唯一一起，保证同一次解锁不会被记两次。
 */
export const SOURCE_EVENT_KEY_MAX_LENGTH = 128;
const sourceEventKeyValue = textValueObject('SourceEventKey', 1, SOURCE_EVENT_KEY_MAX_LENGTH);
export type SourceEventKey = ReturnType<typeof sourceEventKeyValue.parse>;
export const isSourceEventKey = sourceEventKeyValue.is;
export const parseSourceEventKey = sourceEventKeyValue.parse;

export const ACHIEVEMENT_RULE_KINDS = [
  'POINTS_TOTAL',
  'GROWTH_LEVEL_REACHED',
  'WORK_PUBLISHED',
  'LIKE_RECEIVED',
  'STREAK_DAYS',
] as const;
export type AchievementRuleKind = (typeof ACHIEVEMENT_RULE_KINDS)[number];
const achievementRuleKindEnum = stringEnum<AchievementRuleKind>(
  'AchievementRuleKind',
  ACHIEVEMENT_RULE_KINDS,
);
export const isAchievementRuleKind = achievementRuleKindEnum.is;
export const parseAchievementRuleKind = achievementRuleKindEnum.parse;

export type AchievementThreshold = ReturnType<typeof achievementThresholdValue.parse>;

const achievementThresholdValue = integerValueObject(
  'AchievementThreshold',
  1,
  Number.MAX_SAFE_INTEGER,
);

export function parseAchievementThreshold(value: number): AchievementThreshold {
  return achievementThresholdValue.parse(value);
}

/**
 * 有类型的成就规则：封闭的 kind 集合 + 一个正整数阈值。
 *
 * 刻意保持狭窄 —— 规则引擎不是本行范围（附录 A §7.2 禁止扩展），
 * 但 `rule_json` 也不能以无类型 JSON 进入 domain（附录 A §6.4）。
 */
export type AchievementRule = {
  readonly kind: AchievementRuleKind;
  readonly threshold: AchievementThreshold;
};

export function createAchievementRule(input: {
  readonly kind: string;
  readonly threshold: number;
}): AchievementRule {
  return {
    kind: parseAchievementRuleKind(input.kind),
    threshold: parseAchievementThreshold(input.threshold),
  };
}

/**
 * 规则是否可触发。`enabled=false` 的成就不参与判定，但**保留**记录：
 * 关闭一枚徽章不该抹掉已经解锁它的学生的历史（附录 A §6.2）。
 */
export function isRuleTriggerable(rule: AchievementRule, enabled: boolean): boolean {
  if (typeof enabled !== 'boolean') throw DomainError.invalid('Achievement');
  return enabled && isAchievementRuleKind(rule.kind);
}

/**
 * 点赞每日上限（附录 A §6.3「点赞每日上限走 usage/rate policy」）。
 * 与 `memberLimit` 同理，**不在 domain 硬编码默认数值**，由策略配置注入。
 */
export type LikeDailyLimit = ReturnType<typeof likeDailyLimitValue.parse>;

const likeDailyLimitValue = integerValueObject('LikeDailyLimit', 1, Number.MAX_SAFE_INTEGER);

export function parseLikeDailyLimit(value: number): LikeDailyLimit {
  return likeDailyLimitValue.parse(value);
}

export function canLikeToday(todayLikeCount: number, limit: LikeDailyLimit): boolean {
  if (!Number.isSafeInteger(todayLikeCount) || todayLikeCount < 0) {
    throw new Error(`invalid todayLikeCount: ${String(todayLikeCount)}`);
  }
  return todayLikeCount < limit;
}

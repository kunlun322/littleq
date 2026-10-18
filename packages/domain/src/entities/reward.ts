/**
 * Reward 聚合（附录 A §6.1、§6.2、§6.3 `reward_profiles/achievements/unlocks/likes`）。
 *
 * domain 侧持有：growthLevel/points、typed achievement rule、`enabled`、
 * `sourceEventKey`、unlock 与 like 的幂等性。rule JSON 编解码、**asset object key**、
 * 日计数查询与唯一索引都在 infra（§6.3 右栏）—— 因此 `Achievement` 结构上没有
 * `assetKey` 字段，徽章图片的位置不是领域事实。
 *
 * 幂等是这两个聚合的核心：
 * - `AchievementUnlock` 以 `(user, achievement)` 唯一且**不可重复**（§6.2），
 *   并带 `sourceEventKey`，让同一次行为的重放不会产生第二次解锁；
 * - `Like` 以 `(user, work)` 唯一，取消是删除而不是反向计数，
 *   因此不存在"负数点赞"这种要靠约束才能维持的状态。
 */

import { DomainError } from '../errors/domain-error.js';
import {
  parseAchievementId,
  parseUserId,
  parseWorkId,
  sameKey,
  type AchievementId,
  type LikeKey,
  type UserId,
  type WorkId,
} from '../value-objects/identifiers.js';
import {
  parseGrowthLevel,
  parsePoints,
  parseTimestamp,
  type GrowthLevel,
  type Points,
  type Timestamp,
} from '../value-objects/primitives.js';
import {
  createAchievementRule,
  isRuleTriggerable,
  parseAchievementCode,
  parseAchievementTitle,
  parseSourceEventKey,
  type AchievementCode,
  type AchievementRule,
  type AchievementTitle,
  type SourceEventKey,
} from '../value-objects/reward.js';

/** `reward_profiles` 以 `user_id` 为主键，因此身份就是 key，没有独立 id。 */
export type RewardProfile = {
  readonly userId: UserId;
  readonly growthLevel: GrowthLevel;
  readonly points: Points;
  readonly updatedAt: Timestamp;
};

export function createRewardProfile(input: {
  readonly userId: string;
  readonly growthLevel?: number;
  readonly points?: number;
  readonly updatedAt: string;
}): RewardProfile {
  return {
    userId: parseUserId(input.userId),
    growthLevel:
      input.growthLevel === undefined ? parseGrowthLevel(0) : parseGrowthLevel(input.growthLevel),
    points: input.points === undefined ? parsePoints(0) : parsePoints(input.points),
    updatedAt: parseTimestamp(input.updatedAt),
  };
}

/**
 * 加分。`delta` 必须为正：扣分不是激励系统的一部分，
 * 需要"撤销一次奖励"时应当以一条独立的负向事件重算，而不是就地减 ——
 * 就地减会让 `points` 与解锁历史对不上。
 */
export function awardPoints(
  profile: RewardProfile,
  delta: number,
  updatedAt: Timestamp,
): RewardProfile {
  const awarded = parsePoints(delta);
  if (awarded < 1) throw DomainError.invalid('RewardProfile.points');
  return {
    ...profile,
    points: parsePoints(profile.points + awarded),
    updatedAt: parseTimestamp(updatedAt),
  };
}

export function promoteGrowthLevel(
  profile: RewardProfile,
  growthLevel: number,
  updatedAt: Timestamp,
): RewardProfile {
  const next = parseGrowthLevel(growthLevel);
  if (next <= profile.growthLevel) throw DomainError.invalid('RewardProfile.growthLevel');
  return { ...profile, growthLevel: next, updatedAt: parseTimestamp(updatedAt) };
}

export type Achievement = {
  readonly id: AchievementId;
  readonly code: AchievementCode;
  readonly title: AchievementTitle;
  readonly rule: AchievementRule;
  readonly enabled: boolean;
};

export function createAchievement(input: {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly rule: { readonly kind: string; readonly threshold: number };
  readonly enabled?: boolean;
}): Achievement {
  return {
    id: parseAchievementId(input.id),
    code: parseAchievementCode(input.code),
    title: parseAchievementTitle(input.title),
    rule: createAchievementRule(input.rule),
    enabled: input.enabled ?? true,
  };
}

/**
 * 开关成就。`enabled=false` 只停止**新的**触发，已有解锁保留（§6.2）：
 * 关掉一枚徽章不该抹掉已经拿到它的学生的历史。
 */
export function setAchievementEnabled(achievement: Achievement, enabled: boolean): Achievement {
  if (typeof enabled !== 'boolean') throw DomainError.invalid('Achievement.enabled');
  return { ...achievement, enabled };
}

export function canTriggerAchievement(achievement: Achievement): boolean {
  return isRuleTriggerable(achievement.rule, achievement.enabled);
}

/** 规则是否已被满足。计数由调用方给出（日计数查询在 infra，§6.3）。 */
export function isAchievementRuleMet(achievement: Achievement, observedCount: number): boolean {
  if (!Number.isSafeInteger(observedCount) || observedCount < 0) {
    throw new Error(`invalid observedCount: ${String(observedCount)}`);
  }
  return canTriggerAchievement(achievement) && observedCount >= achievement.rule.threshold;
}

export type AchievementUnlock = {
  readonly userId: UserId;
  readonly achievementId: AchievementId;
  readonly unlockedAt: Timestamp;
  /** 触发这次解锁的事件键；同一键的重放不得产生第二次解锁。 */
  readonly sourceEventKey: SourceEventKey;
};

export function createAchievementUnlock(input: {
  readonly userId: string;
  readonly achievementId: string;
  readonly unlockedAt: string;
  readonly sourceEventKey: string;
}): AchievementUnlock {
  return {
    userId: parseUserId(input.userId),
    achievementId: parseAchievementId(input.achievementId),
    unlockedAt: parseTimestamp(input.unlockedAt),
    sourceEventKey: parseSourceEventKey(input.sourceEventKey),
  };
}

/**
 * 解锁幂等判定（§6.2）。返回三种结果而不是布尔值，因为「同一学生同一成就」与
 * 「同一 sourceEventKey」是两种不同的重复：前者是不可重复解锁，后者是消息重放。
 * application 需要区分它们来决定是静默忽略还是记一条审计。
 */
export type UnlockDecision = 'UNLOCK' | 'ALREADY_UNLOCKED' | 'DUPLICATE_EVENT';

export function decideUnlock(
  unlock: AchievementUnlock,
  existing: readonly AchievementUnlock[],
): UnlockDecision {
  if (existing.some((entry) => entry.sourceEventKey === unlock.sourceEventKey))
    return 'DUPLICATE_EVENT';
  if (
    existing.some(
      (entry) =>
        sameKey({ userId: entry.userId }, { userId: unlock.userId }) &&
        sameKey({ achievementId: entry.achievementId }, { achievementId: unlock.achievementId }),
    )
  ) {
    return 'ALREADY_UNLOCKED';
  }
  return 'UNLOCK';
}

export type Like = {
  readonly userId: UserId;
  readonly workId: WorkId;
  readonly createdAt: Timestamp;
};

export function createLike(input: {
  readonly userId: string;
  readonly workId: string;
  readonly createdAt: string;
}): Like {
  return {
    userId: parseUserId(input.userId),
    workId: parseWorkId(input.workId),
    createdAt: parseTimestamp(input.createdAt),
  };
}

export function likeKeyOf(like: Like): LikeKey {
  return { userId: like.userId, workId: like.workId };
}

/** 自己不能给自己的作品点赞：`likes` 是学生互评的入口，自赞没有信息量。 */
export function assertCanLike(like: Like, workOwnerId: UserId): void {
  if (sameKey({ userId: like.userId }, { userId: workOwnerId })) {
    throw DomainError.invalid('Like.userId');
  }
}

/** 是否已点赞（`(user, work)` 唯一）。 */
export function isAlreadyLiked(like: Like, existing: readonly Like[]): boolean {
  return existing.some(
    (entry) =>
      sameKey({ userId: entry.userId }, { userId: like.userId }) &&
      sameKey({ workId: entry.workId }, { workId: like.workId }),
  );
}

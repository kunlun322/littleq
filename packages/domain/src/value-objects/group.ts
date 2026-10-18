import { integerValueObject, textValueObject } from './primitives.js';
import { stringEnum } from './enum.js';

/**
 * Group 聚合的值对象（ZLQ-153 §4.3 / 附录 A §6.1、§6.3）。
 *
 * `settings_json` 的物理编解码属于 infra；进入 domain 前必须已经解析成
 * 这里的 `GroupSettings` 有类型值对象（附录 A §6.4）。
 */

export const GROUP_KINDS = ['FAMILY', 'CLASS'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
const groupKindEnum = stringEnum<GroupKind>('GroupKind', GROUP_KINDS);
export const isGroupKind = groupKindEnum.is;
export const parseGroupKind = groupKindEnum.parse;

/**
 * `groups.status` 是附录 A §6.3 为满足冻结 PRD 归档语义补齐的**未来数据库契约
 * 字段**：本行只进入 domain / API contract，下一行 migration 必须显式落列。
 */
export const GROUP_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];
const groupStatusEnum = stringEnum<GroupStatus>('GroupStatus', GROUP_STATUSES);
export const isGroupStatus = groupStatusEnum.is;
export const parseGroupStatus = groupStatusEnum.parse;

export const MEMBER_ROLES = ['OWNER', 'STUDENT'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
const memberRoleEnum = stringEnum<MemberRole>('MemberRole', MEMBER_ROLES);
export const isMemberRole = memberRoleEnum.is;
export const parseMemberRole = memberRoleEnum.parse;

export const GROUP_NAME_MAX_LENGTH = 80;
const groupNameText = textValueObject('GroupName', 1, GROUP_NAME_MAX_LENGTH);
export type GroupName = ReturnType<typeof groupNameText.parse>;
export const isGroupName = groupNameText.is;
export const parseGroupName = groupNameText.parse;

export type MemberLimit = ReturnType<typeof memberLimitValue.parse>;

const memberLimitValue = integerValueObject('MemberLimit', 1, Number.MAX_SAFE_INTEGER);

export function parseMemberLimit(value: number): MemberLimit {
  return memberLimitValue.parse(value);
}

/**
 * 小组设置。`memberLimit` **没有默认值**：产品数值由 Owner 在建档时给出，
 * domain 不硬编码（附录 A §6.3）。
 */
export type GroupSettings = {
  readonly memberLimit: MemberLimit;
  readonly studentPeerViewEnabled: boolean;
};

export function createGroupSettings(input: {
  readonly memberLimit: number;
  readonly studentPeerViewEnabled: boolean;
}): GroupSettings {
  if (typeof input.studentPeerViewEnabled !== 'boolean') {
    throw new Error('GroupSettings.studentPeerViewEnabled must be a boolean');
  }
  return {
    memberLimit: parseMemberLimit(input.memberLimit),
    studentPeerViewEnabled: input.studentPeerViewEnabled,
  };
}

/**
 * 加入码满员判定。返回剩余名额而不是布尔值，调用方可以据此决定是否继续；
 * `remaining < 0` 不可能出现，因为计数与上限都是非负整数。
 */
export function remainingMemberSlots(memberCount: number, settings: GroupSettings): number {
  if (!Number.isSafeInteger(memberCount) || memberCount < 0) {
    throw new Error(`invalid memberCount: ${String(memberCount)}`);
  }
  return settings.memberLimit - memberCount;
}

export function canAddMember(memberCount: number, settings: GroupSettings): boolean {
  return remainingMemberSlots(memberCount, settings) > 0;
}

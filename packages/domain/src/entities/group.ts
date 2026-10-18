/**
 * Group 聚合（附录 A §6.1、§6.3 `groups/group_members`）。
 *
 * domain 侧字段严格来自 §6.3 左栏：id、name、kind、**status**、typed settings、
 * ownerId、membership。加入码 hash/有效期、唯一索引、settings JSON 编解码属于
 * application/infra，结构上不出现在这个类型里 —— 缺字段比多字段容易证明。
 *
 * 两条不变量在这里落：
 * 1. **归档后禁止成员/设置写**（§6.3「归档后禁止成员/设置写」）→ `GROUP_ARCHIVED`；
 * 2. **memberLimit 来自 GroupSettings，不在 domain 硬编码默认数值** —— 容量判定
 *    一律以 `settings.memberLimit` 为唯一来源，本文件不出现任何数字字面量。
 */

import { DomainError } from '../errors/domain-error.js';
import { GROUP_TRANSITIONS } from '../states/machines.js';
import { assertTransition } from '../states/transition.js';
import {
  parseGroupId,
  parseUserId,
  sameKey,
  type GroupId,
  type GroupMembershipKey,
  type UserId,
} from '../value-objects/identifiers.js';
import {
  isBefore,
  nextRevision,
  parseRevision,
  parseTimestamp,
  type Revision,
  type Timestamp,
} from '../value-objects/primitives.js';
import {
  createGroupSettings,
  parseGroupKind,
  parseGroupName,
  parseGroupStatus,
  parseMemberRole,
  remainingMemberSlots,
  type GroupKind,
  type GroupName,
  type GroupSettings,
  type GroupStatus,
  type MemberRole,
} from '../value-objects/group.js';

export type Group = {
  readonly id: GroupId;
  readonly name: GroupName;
  readonly kind: GroupKind;
  readonly status: GroupStatus;
  readonly settings: GroupSettings;
  readonly ownerId: UserId;
  readonly membership: readonly GroupMembership[];
  readonly revision: Revision;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
};

/**
 * 小组成员。`joinedAt` 保留是为了让 application 能按加入顺序分页，
 * domain 自身不依赖它做任何判定。
 */
export type GroupMembership = {
  readonly userId: UserId;
  readonly role: MemberRole;
  readonly joinedAt: Timestamp;
};

export function createGroup(input: {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly ownerId: string;
  readonly settings: { readonly memberLimit: number; readonly studentPeerViewEnabled: boolean };
  readonly status?: string;
  readonly membership?: readonly {
    readonly userId: string;
    readonly role: string;
    readonly joinedAt: string;
  }[];
  readonly revision?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): Group {
  const createdAt = parseTimestamp(input.createdAt);
  const updatedAt = parseTimestamp(input.updatedAt);
  if (isBefore(updatedAt, createdAt)) throw DomainError.invalid('Group.updatedAt');
  const membership = (input.membership ?? []).map((member) => createGroupMembership(member));
  const ownerId = parseUserId(input.ownerId);
  assertOwnerIsMember(ownerId, membership);
  return {
    id: parseGroupId(input.id),
    name: parseGroupName(input.name),
    kind: parseGroupKind(input.kind),
    status: input.status === undefined ? 'ACTIVE' : parseGroupStatus(input.status),
    settings: createGroupSettings(input.settings),
    ownerId,
    membership,
    revision: input.revision === undefined ? parseRevision('0') : parseRevision(input.revision),
    createdAt,
    updatedAt,
  };
}

function createGroupMembership(input: {
  readonly userId: string;
  readonly role: string;
  readonly joinedAt: string;
}): GroupMembership {
  return {
    userId: parseUserId(input.userId),
    role: parseMemberRole(input.role),
    joinedAt: parseTimestamp(input.joinedAt),
  };
}

/**
 * Owner 必须是成员，而且成员表里只能有一个 OWNER。
 *
 * `group_members` 的唯一索引由 infra 负责，但「Owner 是成员」是领域事实：
 * 一旦允许它不成立，归档只读与成员上限这些规则都会失去主语。
 */
function assertOwnerIsMember(ownerId: UserId, membership: readonly GroupMembership[]): void {
  const owners = membership.filter((member) => member.role === 'OWNER');
  if (owners.length !== 1) throw DomainError.invalid('GroupMembership');
  if (!sameKey({ userId: owners[0]!.userId }, { userId: ownerId })) {
    throw DomainError.invalid('Group.ownerId');
  }
}

/**
 * 归档只读（§6.2「归档后只读、作品保留；允许 Owner `ARCHIVED → ACTIVE`」）。
 *
 * 状态机本身是双向的，所以「能不能写」不能从 `GROUP_TRANSITIONS` 推出来，
 * 只能显式判定。这里抛 `GROUP_ARCHIVED`（409）而不是 `REQUEST_INVALID`：
 * 前者表达「资源处于冲突状态」，UI 可以据此翻成儿童可读文案。
 */
export function assertGroupWritable(group: Group): void {
  if (group.status === 'ARCHIVED') throw new DomainError('GROUP_ARCHIVED', 'Group');
}

export function isGroupArchived(group: Group): boolean {
  return group.status === 'ARCHIVED';
}

/** 剩余名额。返回数值而非布尔值，便于批量建档时逐项判定。 */
export function remainingSlots(group: Group): number {
  return remainingMemberSlots(group.membership.length, group.settings);
}

export function canAddMemberTo(group: Group): boolean {
  return remainingSlots(group) > 0;
}

/**
 * 满员判定。`GROUP_MEMBER_LIMIT_REACHED`（409）由这里唯一产生，
 * 保证 §5.4 中 `POST /groups/{id}/students:batch` 的错误集合与实现同源。
 */
export function assertCanAddMember(group: Group): void {
  if (!canAddMemberTo(group)) throw new DomainError('GROUP_MEMBER_LIMIT_REACHED', 'Group');
}

export function addMember(
  group: Group,
  input: { readonly userId: string; readonly role: string; readonly joinedAt: string },
): Group {
  assertGroupWritable(group);
  assertCanAddMember(group);
  const member = createGroupMembership(input);
  if (
    group.membership.some((existing) =>
      sameKey({ userId: existing.userId }, { userId: member.userId }),
    )
  ) {
    throw DomainError.invalid('GroupMembership');
  }
  return {
    ...group,
    membership: [...group.membership, member],
    revision: nextRevision(group.revision),
    updatedAt: member.joinedAt,
  };
}

/**
 * Owner 不可被移出：小组的存在前提是有且仅有一个 Owner，
 * 「换 Owner」是一次独立的转让用例，不能借删除成员的手顺带完成。
 */
export function removeMember(group: Group, userId: UserId, removedAt: Timestamp): Group {
  assertGroupWritable(group);
  if (sameKey({ userId: group.ownerId }, { userId })) throw DomainError.invalid('Group.ownerId');
  const membership = group.membership.filter(
    (member) => !sameKey({ userId: member.userId }, { userId }),
  );
  if (membership.length === group.membership.length) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'GroupMembership');
  }
  return {
    ...group,
    membership,
    revision: nextRevision(group.revision),
    updatedAt: parseTimestamp(removedAt),
  };
}

export function updateGroupSettings(
  group: Group,
  settings: { readonly memberLimit: number; readonly studentPeerViewEnabled: boolean },
  updatedAt: Timestamp,
): Group {
  assertGroupWritable(group);
  const next = createGroupSettings(settings);
  /**
   * 缩小上限不得把已有成员挤出小组：`memberLimit` 是容量承诺，
   * 让一批学生因为一次设置修改而变成「超额」是不可恢复的。
   */
  if (next.memberLimit < group.membership.length) {
    throw DomainError.invalid('GroupSettings.memberLimit');
  }
  return {
    ...group,
    settings: next,
    revision: nextRevision(group.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

export function renameGroup(group: Group, name: string, updatedAt: Timestamp): Group {
  assertGroupWritable(group);
  return {
    ...group,
    name: parseGroupName(name),
    revision: nextRevision(group.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

export function archiveGroup(group: Group, updatedAt: Timestamp): Group {
  return withGroupStatus(group, 'ARCHIVED', updatedAt);
}

export function reactivateGroup(group: Group, updatedAt: Timestamp): Group {
  return withGroupStatus(group, 'ACTIVE', updatedAt);
}

function withGroupStatus(group: Group, status: GroupStatus, updatedAt: Timestamp): Group {
  assertTransition(GROUP_TRANSITIONS, group.status, status, 'REQUEST_INVALID');
  return {
    ...group,
    status,
    revision: nextRevision(group.revision),
    updatedAt: parseTimestamp(updatedAt),
  };
}

export function membershipKeyOf(group: Group, userId: UserId): GroupMembershipKey {
  return { groupId: group.id, userId };
}

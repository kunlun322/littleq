import { DomainError } from '../errors/domain-error.js';
import { parseUserId, type OwnerId, type UserId } from '../value-objects/identifiers.js';
import {
  loginNameKey,
  nextRevision,
  parseRevision,
  type LoginName,
  type Nickname,
  type Revision,
} from '../value-objects/primitives.js';
import {
  parseAccountStatus,
  parseAgeBand,
  parseRole,
  type AccountLockPolicy,
  type AccountStatus,
  type AgeBand,
  type Role,
} from '../value-objects/account.js';
import { USER_TRANSITIONS } from '../states/machines.js';
import { assertTransition } from '../states/transition.js';

/**
 * `User` 聚合（附录 A §6.1 Account / §6.3 `users`）。
 *
 * domain 字段严格取自 §6.3 的左栏：id、role、loginName、nickname、ageBand、status、
 * ownerId、锁定策略、revision。右栏的三件事**不进 domain**：passwordHash 的算法执行、
 * 登录计数的原子更新、`deletedAt` 的持久化 —— 所以 `User` 上没有 `deletedAt` 字段，
 * 也没有 `passwordHash` / `failedLoginCount`。锁定阈值判定是纯比较
 * （`isLockThresholdReached(count, policy)`），计数由调用方从持久层取来。
 *
 * `passwordHash` 缺席是刻意的：§6.4 只允许 `PasswordDigest` 这种不透明摘要进入
 * domain，而摘要属于 `secret_records` / 认证适配层的读写面，不是账号聚合的业务字段。
 */
export type User = {
  readonly id: UserId;
  readonly role: Role;
  readonly loginName: LoginName;
  readonly nickname: Nickname;
  /** Student 必填；Owner 必为 `null`。 */
  readonly ageBand: AgeBand | null;
  readonly status: AccountStatus;
  /** Student 必填（归属的 Owner）；Owner 必为 `null`。 */
  readonly ownerId: OwnerId | null;
  readonly lockPolicy: AccountLockPolicy;
  readonly revision: Revision;
};

/**
 * 角色决定 `ageBand` / `ownerId` 的有无。
 *
 * 这条不变量是「学生必须挂在某个 Owner 名下」的唯一强制点：K12 场景下 Student 的
 * 可见范围、额度与密钥全部经由 ownerId 继承，缺了它后续每条查询都会退化成无 scope
 * 的全表扫描 —— 而 §5.3 明令「查询必须先带 scope，禁止查出后再判断」。
 */
function assertRoleCoherence(role: Role, ageBand: AgeBand | null, ownerId: OwnerId | null): void {
  if (role === 'STUDENT') {
    if (ageBand === null) throw DomainError.invalid('User.ageBand');
    if (ownerId === null) throw DomainError.invalid('User.ownerId');
    return;
  }
  if (ageBand !== null) throw DomainError.invalid('User.ageBand');
  if (ownerId !== null) throw DomainError.invalid('User.ownerId');
}

export function createUser(input: {
  readonly id: string;
  readonly role: string;
  readonly loginName: LoginName;
  readonly nickname: Nickname;
  readonly ageBand?: string | null;
  readonly status?: string;
  readonly ownerId?: string | null;
  readonly lockPolicy: AccountLockPolicy;
  readonly revision?: string;
}): User {
  const role = parseRole(input.role);
  const ageBand =
    input.ageBand === null || input.ageBand === undefined ? null : parseAgeBand(input.ageBand);
  const ownerId =
    input.ownerId === null || input.ownerId === undefined ? null : parseUserId(input.ownerId);
  assertRoleCoherence(role, ageBand, ownerId);
  return {
    id: parseUserId(input.id),
    role,
    loginName: input.loginName,
    nickname: input.nickname,
    ageBand,
    status:
      input.status === null || input.status === undefined
        ? 'ACTIVE'
        : parseAccountStatus(input.status),
    ownerId,
    lockPolicy: input.lockPolicy,
    revision:
      input.revision === null || input.revision === undefined
        ? parseRevision('0')
        : parseRevision(input.revision),
  };
}

/** 单安装内登录名唯一，判定键是 `lower(login_name)`（§4.3）。 */
export function userLoginNameKey(user: User): string {
  return loginNameKey(user.loginName);
}

/**
 * 已删除的账号在业务上等同「不存在」：§5.3 要求 404 与「对象不在 scope 内」用同一
 * 个机器码，所以这里抛 `RESOURCE_NOT_FOUND` 而不是一个专用的「已删除」码 ——
 * 专用码会泄露对象曾经存在。
 */
function assertNotDeleted(user: User): void {
  if (user.status === 'DELETED') throw new DomainError('RESOURCE_NOT_FOUND', 'User');
}

function withStatus(user: User, status: AccountStatus): User {
  assertTransition(USER_TRANSITIONS, user.status, status, 'REQUEST_INVALID');
  return { ...user, status, revision: nextRevision(user.revision) };
}

export function lockAccount(user: User): User {
  assertNotDeleted(user);
  return withStatus(user, 'LOCKED');
}

export function unlockAccount(user: User): User {
  assertNotDeleted(user);
  return withStatus(user, 'ACTIVE');
}

/** `DELETED` 不可逆；恢复「由明确管理用例另行裁定」（§6.2），本行不提供该函数。 */
export function deleteUser(user: User): User {
  assertNotDeleted(user);
  return withStatus(user, 'DELETED');
}

export function renameUser(user: User, nickname: Nickname): User {
  assertNotDeleted(user);
  return { ...user, nickname, revision: nextRevision(user.revision) };
}

/**
 * 年龄段调整。Owner 没有 ageBand，所以对 Owner 调用是契约错误 —— 用
 * `REQUEST_INVALID` 而不是静默忽略，避免前端把一次无效调用当成成功。
 */
export function changeAgeBand(user: User, ageBand: string): User {
  assertNotDeleted(user);
  if (user.role !== 'STUDENT') throw DomainError.invalid('User.ageBand');
  return { ...user, ageBand: parseAgeBand(ageBand), revision: nextRevision(user.revision) };
}

export function changeLockPolicy(user: User, lockPolicy: AccountLockPolicy): User {
  assertNotDeleted(user);
  return { ...user, lockPolicy, revision: nextRevision(user.revision) };
}

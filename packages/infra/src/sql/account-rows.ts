import {
  createUser,
  parseLockDurationMinutes,
  parseLoginName,
  parseMaxFailedAttempts,
  parseNickname,
  type AccountLockPolicy,
  type User,
} from '@littleq/domain';

import type { PasswordCredentialRecord } from '../password/scrypt.js';
import {
  assertColumnMatches,
  assertPersistableRevision,
  fromBigintColumn,
  fromBytea,
  fromJsonObject,
  fromJsonString,
  fromRevisionColumn,
  toBytea,
  toJsonb,
} from './rows.js';

/**
 * `users` / `password_credentials` 两张表的编解码 —— ZLQ-216 §1.3 + §3.2。
 *
 * ## 为什么这两张表没有仓储，只有编解码
 *
 * §3.5 点名的两个装配端口是 `TaskPumpStore` 与 `TaskUnitOfWork`，五个冻结端口里也没有
 * "账号仓储"。账号的读写面属于登录用例（§10.2 划给 F2），而 F2 要的是 `apps/api` 与
 * `packages/application` 的用例层，不是这里的 SQL。本文件存在的唯一理由是 §4 第 7 项
 * 「受控迁移/**初始化**工具」：初始化工具要在**一个事务里**写下成人账号、学生账号与两份
 * scrypt 校验材料，而那份 SQL 只能落在这里 —— 写进工具本身会让"schema 钉住"测试与初始化
 * 各持一份 DDL 假设。
 *
 * ## `password_credentials` 没有 `payload jsonb`
 *
 * 与其余各表不同，它**不是**业务实体：§3.2 逐字「只保存校验材料，不存原口令」。没有实体
 * 可存，于是 §3.1 的「payload 权威 + 派生列一致性检查」在这里退化成一件事 —— 六个列**就是**
 * 全部事实，读回时逐列过形状校验（`password/scrypt.ts` 的 `assertCredentialRecordShape`）。
 *
 * ## 一处已申报的规格缺口：`login_name` 的唯一性是**大小写敏感**的
 *
 * §3.2 写的是 `login_name text UNIQUE`，而 §4.3（`entities/account.ts` 的文件头与
 * `userLoginNameKey` 的存在理由）要求判定键是 `lower(login_name)`。两者不一致：只按 §3.2
 * 建表时，`Owner` 与 `owner` 可以共存，而登录查询用 `lower()` 匹配就会**一次命中两行**。
 *
 * 本单**不自授**补一条 `CREATE UNIQUE INDEX … ON users(lower(login_name))`：DDL 是逐字冻结
 * 的规格面，加索引是 schema 增项，按 §10.2 的收尾规则应停下列明请求裁定。当前不构成实际
 * 漏洞，因为唯一的写入方（初始化工具）在插入前会先按 `lower()` 查一次，而账号数量是个位数。
 * 缺口已写进 ZLQ-220 的交付评论。
 */

export const USER_COLUMNS = `id, role, login_name, owner_id, age_band, status, revision, payload`;

export type UserRow = {
  readonly id: string;
  readonly role: string;
  readonly login_name: string;
  readonly owner_id: string | null;
  readonly age_band: string | null;
  readonly status: string;
  readonly revision: unknown;
  readonly payload: unknown;
};

/**
 * 从 `payload jsonb` 重建 `User`。
 *
 * 三个字段**显式重新解析**而不是整块 `as Parameters<typeof createUser>[0]`：`loginName`、
 * `nickname` 与 `lockPolicy` 的两个整数在 domain 里都是 branded 值对象，而 JSON 里只有裸
 * 字符串与裸数字。整块断言过去会跳过 `parseLoginName` / `parseNickname` /
 * `parseMaxFailedAttempts`，于是"payload 权威"退化成"payload 里写什么就信什么" ——
 * 而 payload 是库里可被绕过仓储改动的一列。
 */
function userFromPayload(payload: Record<string, unknown>): User {
  const rawLockPolicy = fromJsonObject(payload['lockPolicy']);
  const lockPolicy: AccountLockPolicy = {
    maxFailedAttempts: parseMaxFailedAttempts(fromBigintColumn(rawLockPolicy['maxFailedAttempts'])),
    lockDurationMinutes: parseLockDurationMinutes(
      fromBigintColumn(rawLockPolicy['lockDurationMinutes']),
    ),
  };
  const ageBand = payload['ageBand'];
  const ownerId = payload['ownerId'];
  return createUser({
    id: fromJsonString(payload['id']),
    role: fromJsonString(payload['role']),
    loginName: parseLoginName(fromJsonString(payload['loginName'])),
    nickname: parseNickname(fromJsonString(payload['nickname'])),
    ageBand: ageBand === null ? null : fromJsonString(ageBand),
    status: fromJsonString(payload['status']),
    ownerId: ownerId === null ? null : fromJsonString(ownerId),
    lockPolicy,
    revision: fromJsonString(payload['revision']),
  });
}

export function userFromRow(row: UserRow): User {
  const user = userFromPayload(fromJsonObject(row.payload));
  assertColumnMatches(row.id, user.id);
  assertColumnMatches(row.role, user.role);
  assertColumnMatches(row.login_name, user.loginName);
  assertColumnMatches(row.owner_id, user.ownerId);
  assertColumnMatches(row.age_band, user.ageBand);
  assertColumnMatches(row.status, user.status);
  assertColumnMatches(fromRevisionColumn(row.revision), user.revision);
  return user;
}

export const USER_SELECT_BY_ID_SQL = `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`;

/**
 * 按 §4.3 的判定键查：`lower(login_name)`。
 *
 * 参数由调用方传**已经小写化**的键（domain 的 `loginNameKey(user.loginName)`），SQL 侧不再
 * 套一层 `lower($1)` —— 少一次隐式转换，也让"判定键是什么"这件事在代码里只有一处定义。
 * （`entities/account.ts` 的 `userLoginNameKey` 收的是整个 `User`，这里手上只有登录名，
 * 所以用 `value-objects/primitives.ts` 的 `loginNameKey`；两者是同一个 `toLowerCase()`。）
 */
export const USER_SELECT_BY_LOGIN_NAME_KEY_SQL = `
SELECT ${USER_COLUMNS} FROM users WHERE lower(login_name) = $1`;

/** 初始化工具的"已存在就拒绝"判定。数个数而不取行，避免把既有账号的任何字段读进内存。 */
export const USER_COUNT_SQL = `SELECT COUNT(*)::bigint AS total FROM users`;

export const USER_INSERT_SQL = `
INSERT INTO users(id, role, login_name, owner_id, age_band, status, revision, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`;

export function userInsertParams(user: User): readonly unknown[] {
  assertPersistableRevision(user.revision, 'User.revision');
  return [
    user.id,
    user.role,
    user.loginName,
    user.ownerId,
    user.ageBand,
    user.status,
    user.revision,
    toJsonb(user),
  ];
}

export const PASSWORD_CREDENTIAL_COLUMNS = `user_id, salt, password_hash, scrypt_n, scrypt_r,
  scrypt_p, hash_bytes`;

export type PasswordCredentialRow = {
  readonly user_id: string;
  readonly salt: unknown;
  readonly password_hash: unknown;
  readonly scrypt_n: unknown;
  readonly scrypt_r: unknown;
  readonly scrypt_p: unknown;
  readonly hash_bytes: unknown;
};

/**
 * 读回校验材料。**不做参数合法性判定** —— 那是 `verifyPassword` 的职责
 * （`assertCredentialRecordShape`），在那里做才能保证"写入形状"与"校验时接受的形状"是同一
 * 份代码。这里只负责 bytea → `Uint8Array`、integer → number 的列类型转换。
 */
export function credentialFromRow(row: PasswordCredentialRow): PasswordCredentialRecord {
  return {
    salt: fromBytea(row.salt),
    passwordHash: fromBytea(row.password_hash),
    scryptN: fromBigintColumn(row.scrypt_n),
    scryptR: fromBigintColumn(row.scrypt_r),
    scryptP: fromBigintColumn(row.scrypt_p),
    hashBytes: fromBigintColumn(row.hash_bytes),
  };
}

export const PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL = `
SELECT ${PASSWORD_CREDENTIAL_COLUMNS} FROM password_credentials WHERE user_id = $1`;

export const PASSWORD_CREDENTIAL_INSERT_SQL = `
INSERT INTO password_credentials(
  user_id, salt, password_hash, scrypt_n, scrypt_r, scrypt_p, hash_bytes
) VALUES ($1, $2::bytea, $3::bytea, $4, $5, $6, $7)`;

export function credentialInsertParams(
  userId: string,
  record: PasswordCredentialRecord,
): readonly unknown[] {
  return [
    userId,
    toBytea(record.salt),
    toBytea(record.passwordHash),
    record.scryptN,
    record.scryptR,
    record.scryptP,
    record.hashBytes,
  ];
}

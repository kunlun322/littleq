import { type SecretKind, type SecretRecord, type SecretRef, createSecretRecord } from '@littleq/domain';

import { infraError } from '../errors.js';
import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';
import type { EncryptedSecret } from '../secret-store/cipher.js';
import {
  type SecretRecordStore,
  type StoredSecret,
  assertStoredSecretShape,
} from '../secret-store/store.js';
import type { SqlExecutor } from './executor.js';
import { executorBound, executorOf } from './executor.js';
import {
  assertColumnMatches,
  fromBigintColumn,
  fromBooleanColumn,
  fromBytea,
  fromJsonObject,
  fromNullableTextColumn,
  fromTextColumn,
  toJsonb,
  toNullableBytea,
} from './rows.js';

/**
 * `SecretRecordStore` 的真实 Postgres 实现（ZLQ-216 §3.2 `owner_secrets`）。
 *
 * ## 内存替身证明不了、只有真数据库能证明的三件事
 *
 * 1. **跨进程的 generation CAS。** 替身把 CAS 做成「读当前值、不等就返回 `null`」，形状
 *    正确，但两个进程各自持有自己的 Map 时它什么都不拦。这里 CAS 落在
 *    `UPDATE … WHERE generation = $expected` 的**影响行数**上，由行锁串行化。
 * 2. **旧代 ref 结构性不可解析。** 替身靠 `save` 里手动 `this.#refs.delete(stale)` 摘索引
 *    —— 漏一行就是一个「轮换后旧 ref 仍能读出明文」的漏洞。这里不需要摘：`current_ref` 是
 *    一列，`UNIQUE`，轮换时被新值覆盖、撤销时被 `owner_secrets_ref_shape` 逼成 NULL。
 *    旧 ref 不再等于任何一行的 `current_ref`，于是 `findByRef` 得到的 0 行与「从未存在过」
 *    完全同形，探测者拿不到任何可区分信号（裁定一不变量 1）。
 * 3. **密文与配置态同生同灭。** `owner_secrets_cipher_shape` 是一条数据库级 CHECK：
 *    `configured=false` 时 `ciphertext/nonce/tag/key_version` 四列**必须**全 NULL。撤销即
 *    销毁这件事因此不依赖应用层记得把密文置空 —— 忘了写就插不进去。
 *
 * ## 明文与根密钥都不经过这一层
 * 本文件只见 `EncryptedSecret`。它不 import `SecretCipher`、不读 `LITTLEQ_MASTER_KEY`、
 * 也没有任何把列值转成字符串再打出来的路径：`STORED_ROW_INCONSISTENT` 一律不带列名与
 * 读到的值（见 `rows.ts` 文件头）。
 */

export const OWNER_SECRETS_COLUMNS = `
  owner_id, kind, generation, current_ref, configured, record,
  ciphertext, nonce, tag, key_version`;

export type OwnerSecretRow = {
  readonly owner_id: unknown;
  readonly kind: unknown;
  readonly generation: unknown;
  readonly current_ref: unknown;
  readonly configured: unknown;
  readonly record: unknown;
  readonly ciphertext: unknown;
  readonly nonce: unknown;
  readonly tag: unknown;
  readonly key_version: unknown;
};

/**
 * `record jsonb` → domain 的 `SecretRecord`。
 *
 * 走 `createSecretRecord` 而不是自己拼字面量：domain 那一份是四条不变量的事实源
 * （`configured === (currentRef !== null)`、`(generation === 0) === (lastRotatedAt === null)`
 * 等），这里重抄一遍只会抄出第二套。它抛的是 `DomainError`，而"库里的行不是我们写的形状"
 * 对调用方必须是 infra 的码 —— 与 `fromRevisionColumn` 同样的处理：吞掉原异常，换成
 * `STORED_ROW_INCONSISTENT`。原异常里带着 payload 的内容，不能让它冒出去。
 */
function recordFromPayload(payload: unknown): SecretRecord {
  try {
    // 这个 `as` 只把 `Record<string, unknown>` 收成构造器的入参形状，**不做任何验证**：
    // 验证全部由 `createSecretRecord` 自己跑（`parseSecretKind` / `parseSecretGeneration` /
    // 四条不变量），少一个键或类型不对都会抛，于是被下面的 `catch` 收成行损坏。
    return createSecretRecord(fromJsonObject(payload) as Parameters<typeof createSecretRecord>[0]);
  } catch {
    throw infraError('STORED_ROW_INCONSISTENT');
  }
}

/**
 * 密文四列 → `EncryptedSecret`，或 `null`。
 *
 * `key_version` 是**读回来的**，不是就地填成当前 cipher 的版本：`SecretCipher.decrypt` 的
 * 第一件事是 `secret.keyVersion !== this.keyVersion` ⇒ `MASTER_KEY_VERSION_MISMATCH`
 * （`cipher.ts:165`）。把它填成"现在这把"会让那条比较恒真、那个错误码永远不可达 ——
 * 等于放宽一条已交付的加密校验（ZLQ-220 §8 明令禁止）。§3.2 的列清单漏了这一列，本表已补
 * 并申报，理由写在 `migrations.ts` 的 `OWNER_SECRETS_DDL` 头上。
 *
 * `configured === false` 时四列必须是 NULL；CHECK 已经保证了，这里再判一次是因为**类型**
 * 上必须把 `unknown` 收成 `null`，而顺带把"CHECK 被人 `ALTER TABLE … NOT VALID` 绕过"
 * 这种行损坏也拦在读路径上。
 */
function secretFromRow(row: OwnerSecretRow, record: SecretRecord): EncryptedSecret | null {
  if (!record.configured) {
    if (
      row.ciphertext !== null ||
      row.nonce !== null ||
      row.tag !== null ||
      row.key_version !== null
    ) {
      throw infraError('STORED_ROW_INCONSISTENT');
    }
    return null;
  }
  return {
    ciphertext: fromBytea(row.ciphertext),
    nonce: fromBytea(row.nonce),
    tag: fromBytea(row.tag),
    keyVersion: fromBigintColumn(row.key_version),
  };
}

/**
 * §3.1 的一致性检查：三个派生列必须与 payload 重建出的 `SecretRecord` 逐字相同。
 *
 * 不是洁癖。`generation` 是 CAS 的 `WHERE` 依据、`current_ref` 是 `findByRef` 的查找键、
 * `configured` 决定读路径抛哪个码 —— 三者只要有一个与 payload 分叉，就会出现"用旧版本号
 * 去做 CAS 并成功覆盖掉一个已经推进过的记录"这种静默丢更新，而所有单元测试都是绿的。
 */
export function storedSecretFromRow(row: OwnerSecretRow): StoredSecret {
  const record = recordFromPayload(row.record);
  assertColumnMatches(fromBigintColumn(row.generation), record.generation);
  assertColumnMatches(fromBooleanColumn(row.configured), record.configured);
  assertColumnMatches(fromNullableTextColumn(row.current_ref), record.currentRef);
  assertColumnMatches(fromTextColumn(row.kind), record.kind);
  return { record, secret: secretFromRow(row, record) };
}

/**
 * 十个写参数，`UPDATE` 与 `INSERT` **共用同一份**（`UPDATE` 多一个尾随的 `$11` 期望版本）。
 *
 * 共用是为了让"写进去的"与"CAS 比较的"是同一套编码：两份参数列表迟早会在某一列上分叉
 * （典型是忘了给 `key_version` 传值），而分叉的表现是 CHECK 冲突或一列静默为 NULL。
 */
export function ownerSecretParams(
  ownerId: string,
  stored: StoredSecret,
): readonly unknown[] {
  const { record, secret } = stored;
  return [
    ownerId,
    record.kind,
    record.generation,
    record.currentRef,
    record.configured,
    toJsonb(record),
    toNullableBytea(secret?.ciphertext ?? null),
    toNullableBytea(secret?.nonce ?? null),
    toNullableBytea(secret?.tag ?? null),
    secret?.keyVersion ?? null,
  ];
}

export const OWNER_SECRETS_SELECT_SQL = `
SELECT ${OWNER_SECRETS_COLUMNS} FROM owner_secrets WHERE owner_id = $1 AND kind = $2`;

/** 只解析**当前**那一代：`current_ref` 上的 `UNIQUE` 让这一句至多命中一行。 */
export const OWNER_SECRETS_SELECT_BY_REF_SQL = `
SELECT ${OWNER_SECRETS_COLUMNS} FROM owner_secrets WHERE current_ref = $1`;

/**
 * generation CAS。`WHERE … AND generation = $11` 命中 ⇒ 影响行数 1；不命中 ⇒ 0。
 *
 * 刻意**不带** `RETURNING`：调用方要的是影响行数这个判据，拿返回行判 CAS 会把"改没改到"
 * 与"改成了什么"混成一件 —— 而"改成了什么"这里根本不需要问，写的就是调用方给的 `stored`。
 */
export const OWNER_SECRETS_CAS_UPDATE_SQL = `
UPDATE owner_secrets SET
  generation = $3,
  current_ref = $4,
  configured = $5,
  record = $6::jsonb,
  ciphertext = $7::bytea,
  nonce = $8::bytea,
  tag = $9::bytea,
  key_version = $10
WHERE owner_id = $1 AND kind = $2 AND generation = $11`;

/**
 * 行不存在时的首次写入。`ON CONFLICT (owner_id, kind) DO NOTHING` 是**并发首次写**的裁决者：
 * 两个事务同时看到"没有这一行"，一个插进去，另一个在这句上等到对方提交后被唯一索引挡下，
 * 得到 0 行 —— 那就是一次冲突，返回 `null`，与内存替身同形。
 *
 * 冲突目标写成 `(owner_id, kind)` 而不是省略：省略会让 `current_ref` 上的 `UNIQUE` 冲突也
 * 被静默吞掉，而那是另一回事（两个不同 owner 撞到同一个句柄），必须炸出来。
 */
export const OWNER_SECRETS_INSERT_IF_ABSENT_SQL = `
INSERT INTO owner_secrets(
  owner_id, kind, generation, current_ref, configured, record,
  ciphertext, nonce, tag, key_version
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bytea, $8::bytea, $9::bytea, $10)
ON CONFLICT (owner_id, kind) DO NOTHING`;

export class PostgresSecretRecordStore implements SecretRecordStore {
  readonly #execute: SqlExecutor;

  private constructor(execute: SqlExecutor) {
    this.#execute = execute;
  }

  /** 独立语境：`set` / `rotate` / `revoke` 各自是一次短事务。 */
  static of(db: DatabaseAdapter): PostgresSecretRecordStore {
    return new PostgresSecretRecordStore(executorOf(db));
  }

  /** 绑定语境：装配端口（§3.5）在同一个事务里同时操作 task 与 secret 时用这一条。 */
  static bound(tx: DatabaseTransaction): PostgresSecretRecordStore {
    return new PostgresSecretRecordStore(executorBound(tx));
  }

  async load(ownerId: string, kind: SecretKind): Promise<StoredSecret | null> {
    assertOwnerId(ownerId);
    return this.#execute(async (tx) => {
      const rows = await tx.query<OwnerSecretRow>(OWNER_SECRETS_SELECT_SQL, [ownerId, kind]);
      return rows.length === 0 ? null : storedSecretFromRow(rows[0]!);
    });
  }

  /**
   * `expectedVersion` 就是调用方读到的 `generation`；不匹配返回 `null`（**不抛**）。
   *
   * ## 为什么是「先 UPDATE，0 行再 INSERT」而不是「先 SELECT 判存在」
   *
   * 先查后写要两次往返，而且查到的答案在写之前就过期了 —— 那正是 §3.1 要 CAS 消灭的窗口。
   * 这里的两条语句在一个事务里，且**覆盖全部四种情形**：
   *
   * | 行的状态 | `expectedVersion` | UPDATE 行数 | 接着做什么 | 结果 |
   * | --- | --- | --- | --- | --- |
   * | 不存在 | 0 | 0 | INSERT | 1 行 ⇒ 成功 |
   * | 不存在 | ≠0 | 0 | 直接返回（首次写只可能是 0 代） | `null` |
   * | 存在，generation 相等 | — | 1 | — | 成功 |
   * | 存在，generation 不等 | 0 | 0 | INSERT 撞唯一索引 ⇒ 0 行 | `null` |
   * | 存在，generation 不等 | ≠0 | 0 | 直接返回 | `null` |
   *
   * 倒数第二行是这套写法唯一的巧处：`expectedVersion === 0` 而行已存在（且 generation 必
   * ≥ 1，因为 `configured ⟹ generation ≥ 1`，而一个 generation 为 0 的行会被 UPDATE 命中）
   * 时，INSERT 的 `DO NOTHING` 恰好把它变成 0 行 ⇒ `null`。不需要额外一次 SELECT。
   */
  async save(
    ownerId: string,
    stored: StoredSecret,
    expectedVersion: number,
  ): Promise<StoredSecret | null> {
    assertOwnerId(ownerId);
    assertStoredSecretShape(stored);
    const params = ownerSecretParams(ownerId, stored);
    return this.#execute(async (tx) => {
      const updated = await tx.execute(OWNER_SECRETS_CAS_UPDATE_SQL, [...params, expectedVersion]);
      if (updated === 1) return stored;
      if (expectedVersion !== 0) return null;
      const inserted = await tx.execute(OWNER_SECRETS_INSERT_IF_ABSENT_SQL, params);
      return inserted === 1 ? stored : null;
    });
  }

  async findByRef(
    ref: SecretRef,
  ): Promise<{ readonly ownerId: string; readonly stored: StoredSecret } | null> {
    return this.#execute(async (tx) => {
      const rows = await tx.query<OwnerSecretRow>(OWNER_SECRETS_SELECT_BY_REF_SQL, [ref]);
      if (rows.length === 0) return null;
      const row = rows[0]!;
      return { ownerId: fromTextColumn(row.owner_id), stored: storedSecretFromRow(row) };
    });
  }
}

/**
 * 与内存替身的 `recordKey` 同一条前置检查：空 `ownerId` 是调用方的编程错误，不是冲突。
 *
 * 放在这里而不是让 SQL 去发现，是因为一个空串会被 `uuid` 列拒成驱动的原文报错 ——
 * 那段文本里带着连接目标（§4.1 禁止外泄）。
 */
function assertOwnerId(ownerId: string): void {
  if (ownerId === '') throw infraError('SECRET_CONTEXT_INVALID');
}

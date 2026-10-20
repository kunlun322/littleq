/**
 * `SecretRecordStore` 的内存实现（本地替身）。
 *
 * ⚠️ 与 `InMemoryObjectStore` 同样只是替身：真实实现的 CAS 要落在一条带 `WHERE generation =
 * $expected` 的 SQL UPDATE 上（D5 的 Postgres adapter）。这里把 CAS 做成「读当前 generation、
 * 不等就返回 `null`」，形状与 SQL 版一致，于是并发冲突在替身上就能测成可红可绿 —— 但
 * **跨进程**的冲突只有真数据库能保证，替身证明不了，那部分留给 D5/D6。
 *
 * `saveCount` / `conflictCount` 是给测试用的计数器：断言「冲突路径确实走过了」，而不是只断言
 * 抛出了某个错误 —— 后者在一个永远不冲突的实现上也会绿。
 */
import type { SecretKind, SecretRef } from '@littleq/domain';

import { infraError } from '../errors.js';
import { type SecretRecordStore, type StoredSecret, assertStoredSecretShape } from './store.js';

function recordKey(ownerId: string, kind: SecretKind): string {
  if (ownerId === '') throw infraError('SECRET_CONTEXT_INVALID');
  return `${ownerId.length}:${ownerId}\n${kind}`;
}

interface RefIndexEntry {
  readonly ownerId: string;
  readonly stored: StoredSecret;
}

export class InMemorySecretRecordStore implements SecretRecordStore {
  readonly #records = new Map<string, StoredSecret>();
  readonly #refs = new Map<string, RefIndexEntry>();
  #saveCount = 0;
  #conflictCount = 0;

  get saveCount(): number {
    return this.#saveCount;
  }

  get conflictCount(): number {
    return this.#conflictCount;
  }

  async load(ownerId: string, kind: SecretKind): Promise<StoredSecret | null> {
    return this.#records.get(recordKey(ownerId, kind)) ?? null;
  }

  async save(
    ownerId: string,
    stored: StoredSecret,
    expectedVersion: number,
  ): Promise<StoredSecret | null> {
    assertStoredSecretShape(stored);
    const key = recordKey(ownerId, stored.record.kind);
    const current = this.#records.get(key);
    const actualVersion = current?.record.generation ?? 0;
    if (actualVersion !== expectedVersion) {
      this.#conflictCount += 1;
      return null;
    }
    // 旧句柄必须先从索引里摘掉：轮换之后拿旧 ref 再读一次，得到的必须与「从未存在过」
    // 完全相同，否则探测者能用 404 的差别推断出「这个凭据被换过」。
    const stale = current?.record.currentRef;
    if (stale !== undefined && stale !== null) this.#refs.delete(stale);

    this.#records.set(key, stored);
    if (stored.record.currentRef !== null) {
      this.#refs.set(stored.record.currentRef, { ownerId, stored });
    }
    this.#saveCount += 1;
    return stored;
  }

  async findByRef(ref: SecretRef): Promise<RefIndexEntry | null> {
    return this.#refs.get(ref) ?? null;
  }
}

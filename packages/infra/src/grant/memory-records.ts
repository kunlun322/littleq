/**
 * `GrantRecordStore` 的内存替身。
 *
 * ⚠️ **这是替身，不是真链路证明。** 它证明的是「grant 记录的读写形状与不变量」，不是
 * 「多进程下撤销与并发上限仍然成立」。真实的 grant 表在 D5：`tokenHash` 上的唯一索引、
 * `revokedAt` 的一次原子 UPDATE、以及把并发计数落到一条数据库约束上。本单不做也不声称做。
 *
 * 替身仍然提供了两个**可观测计数器**，让测试能证明路径真的走过了，而不是断言在一个
 * 永远成功的实现上：`revocationCount`（撤销确实写了库）与 `committedByteWrites`
 * （字节账确实回写了）。`storedRecords()` 则让「库里没有明文 token」这句话变成一次
 * 对整个持久化形状的字符串断言，而不是对某一个字段的断言。
 */
import type { Timestamp } from '@littleq/domain';

import { infraError } from '../errors.js';
import type { GrantRecordStore, StoredGrant } from './object-read-grant.js';

export class InMemoryGrantRecordStore implements GrantRecordStore {
  readonly #grants = new Map<string, StoredGrant>();
  readonly #grantIdByTokenHash = new Map<string, string>();
  #revocations = 0;
  #committedByteWrites = 0;

  get revocationCount(): number {
    return this.#revocations;
  }

  get committedByteWrites(): number {
    return this.#committedByteWrites;
  }

  /** 全部持久化记录。测试把它整体 `JSON.stringify`，用来断言裸 token 不在其中任何位置。 */
  storedRecords(): readonly StoredGrant[] {
    return [...this.#grants.values()];
  }

  async save(grant: StoredGrant): Promise<void> {
    this.#grants.set(grant.grantId, grant);
    this.#grantIdByTokenHash.set(grant.tokenHash, grant.grantId);
  }

  async findByTokenHash(tokenHash: string): Promise<StoredGrant | null> {
    const grantId = this.#grantIdByTokenHash.get(tokenHash);
    if (grantId === undefined) return null;
    return this.#grants.get(grantId) ?? null;
  }

  async findById(grantId: string): Promise<StoredGrant | null> {
    return this.#grants.get(grantId) ?? null;
  }

  /**
   * 幂等：已经撤销过的记录再撤一次，返回原样、不推进 `revocationCount`。
   *
   * 这不是为了「容错」，而是因为对外语义上重复撤销与首次撤销无法区分（都是无细节的 404），
   * 计数器若把第二次也算进去，测试就读不出「到底有没有真的写过一次库」。
   */
  async markRevoked(grantId: string, now: Timestamp): Promise<StoredGrant | null> {
    const current = this.#grants.get(grantId);
    if (current === undefined) return null;
    if (current.revokedAt !== null) return current;
    const revoked: StoredGrant = { ...current, revokedAt: now };
    this.#grants.set(grantId, revoked);
    this.#revocations += 1;
    return revoked;
  }

  async addCommittedBytes(grantId: string, delta: number): Promise<number> {
    const current = this.#grants.get(grantId);
    if (current === undefined) throw infraError('OBJECT_READ_GRANT_UNKNOWN');
    const committedBytes = current.committedBytes + delta;
    this.#grants.set(grantId, { ...current, committedBytes });
    this.#committedByteWrites += 1;
    return committedBytes;
  }
}

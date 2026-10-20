/**
 * `ObjectStore` 的内存参考实现（本地替身）。
 *
 * ⚠️ **这不是生产链路**，也**不得**被当成真链路的证明：真实 private Vercel Blob 的未授权/
 * 过期拒绝、真实日志无 provider URL、端到端 artifact-hash 一致性属于 D5/D6。它存在的唯一
 * 理由是 ZLQ-194 §14 的六项未实证点里，有五项是**端口自己的不变量**（不可覆盖、声明字节数、
 * 摘要、15MiB 硬上界、Range 预算），这些在内存实现上就能测成可红可绿，不必等生产凭据。
 *
 * 与真实 provider 刻意保持一致的地方：写入前**先跑完全部校验再落盘**，所以失败路径不留残留
 * （Blob 的 `put` 在服务端超限/中止时同样不产生对象）。
 */
import type { ArtifactDigest } from '@littleq/domain';

import { infraError } from '../errors.js';
import {
  type HealthResult,
  type ObjectRef,
  type StoredObjectMetadata,
  type StoredObjectStream,
  isObjectRef,
  parseByteRange,
  parseObjectRef,
  parseStoredDigest,
} from '../types.js';
import type { GetPrivateInput, ObjectStore, PutImmutableInput } from '../ports/object-store.js';
import {
  type BudgetTransform,
  collectStream,
  createBudgetTransform,
  streamFromBytes,
  throwIfAborted,
} from './budget.js';

interface StoredObject {
  readonly ref: ObjectRef;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: ArtifactDigest;
  readonly createdAt: Date;
  readonly etag: string;
}

export interface InMemoryObjectStoreOptions {
  /** 注入固定时钟，让「固化时间」可断言；省略即真实 `Date`。 */
  readonly now?: () => Date;
}

export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, StoredObject>();
  readonly #now: () => Date;
  #putAttempts = 0;
  #rejectedWrites = 0;

  constructor(options: InMemoryObjectStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /** 测试可观测面：写入尝试总数，以及其中被校验拒绝的次数（用来证明拒绝不是「悄悄成功」）。 */
  get putAttempts(): number {
    return this.#putAttempts;
  }

  get rejectedWrites(): number {
    return this.#rejectedWrites;
  }

  storedKeys(): readonly string[] {
    return [...this.#objects.keys()].sort();
  }

  async putImmutable(input: PutImmutableInput): Promise<ObjectRef> {
    this.#putAttempts += 1;
    throwIfAborted(input.abortSignal);
    if (!isObjectRef(input.key)) {
      this.#rejectedWrites += 1;
      throw infraError('OBJECT_KEY_INVALID');
    }
    if (
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 0 ||
      !Number.isSafeInteger(input.declaredBytes) ||
      input.declaredBytes < 0 ||
      input.declaredBytes > input.maxBytes
    ) {
      this.#rejectedWrites += 1;
      throw infraError('OBJECT_UPLOAD_TOO_LARGE');
    }
    if (this.#objects.has(input.key)) {
      this.#rejectedWrites += 1;
      throw infraError('OBJECT_ALREADY_EXISTS');
    }

    const budget: BudgetTransform = createBudgetTransform(
      input.maxBytes,
      'OBJECT_UPLOAD_TOO_LARGE',
    );
    let bytes: Uint8Array;
    try {
      bytes = await collectStream(input.body.pipeThrough(budget.transform), input.abortSignal);
    } catch (error) {
      this.#rejectedWrites += 1;
      throw error;
    }
    // 流已经干净读完，但预算管道可能因为「这一批会越界」而把流打断了：此时 `bytes` 只包含
    // 越界之前的部分，必须靠 `exceeded()` 判定，否则一个 16MiB 的上传会被当成 15MiB 收下。
    if (budget.accounting.exceeded() || budget.accounting.bytes() !== bytes.byteLength) {
      this.#rejectedWrites += 1;
      throw infraError('OBJECT_UPLOAD_TOO_LARGE');
    }
    if (bytes.byteLength !== input.declaredBytes) {
      this.#rejectedWrites += 1;
      throw infraError('OBJECT_DECLARED_BYTES_MISMATCH');
    }
    if (budget.accounting.digestHex() !== input.sha256) {
      this.#rejectedWrites += 1;
      throw infraError('OBJECT_HASH_MISMATCH');
    }

    const ref = parseObjectRef(input.key);
    this.#objects.set(input.key, {
      ref,
      bytes,
      contentType: input.contentType,
      sha256: parseStoredDigest(budget.accounting.digestHex(), 'OBJECT_HASH_MISMATCH'),
      createdAt: this.#now(),
      etag: `sha256-${budget.accounting.digestHex()}`,
    });
    return ref;
  }

  async getPrivate(input: GetPrivateInput): Promise<StoredObjectStream> {
    throwIfAborted(input.abortSignal, 'OBJECT_READ_ABORTED');
    const stored = this.#objects.get(input.ref);
    if (stored === undefined) throw infraError('OBJECT_NOT_FOUND');

    const total = stored.bytes.byteLength;
    if (input.range === undefined) {
      return this.#slice(stored, 0, total - 1, null, input.maxBytes);
    }
    const range = parseByteRange(input.range.start, input.range.endInclusive);
    if (range.start >= total) throw infraError('OBJECT_RANGE_NOT_SATISFIABLE');
    // 上界越界按对象末尾截断（与 HTTP Range 的语义一致），不是错误。
    const end = Math.min(range.endInclusive, total - 1);
    return this.#slice(
      stored,
      range.start,
      end,
      { start: range.start, endInclusive: end },
      input.maxBytes,
    );
  }

  #slice(
    stored: StoredObject,
    start: number,
    endInclusive: number,
    range: StoredObjectStream['range'],
    maxBytes: number,
  ): StoredObjectStream {
    const slice = stored.bytes.slice(start, endInclusive + 1);
    const budget = createBudgetTransform(maxBytes, 'OBJECT_READ_BUDGET_EXCEEDED');
    return {
      ref: stored.ref,
      byteLength: slice.byteLength,
      contentType: stored.contentType,
      sha256: range === null ? stored.sha256 : null,
      range,
      body: streamFromBytes(slice).pipeThrough(budget.transform),
      deliveredBytes: () => budget.accounting.bytes(),
    };
  }

  async head(ref: ObjectRef): Promise<StoredObjectMetadata | null> {
    const stored = this.#objects.get(ref);
    if (stored === undefined) return null;
    return {
      ref: stored.ref,
      byteLength: stored.bytes.byteLength,
      contentType: stored.contentType,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
      etag: stored.etag,
    };
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (prefix === '') return;
    for (const key of [...this.#objects.keys()]) {
      if (key.startsWith(prefix)) this.#objects.delete(key);
    }
  }

  async health(): Promise<HealthResult> {
    return { status: 'ok', checkedAt: this.#now(), latencyMs: 0, detail: null };
  }
}

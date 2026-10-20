/**
 * 平台侧的对象读取授权（ZLQ-201 裁定一 §2–§6、ZLQ-194 §14）。
 *
 * ## 它**不是**第六个 provider port
 * PM 的裁定逐字是：「它的机制随本单落在 `packages/infra`，由 D5 编排调用；它是应用语义，
 * 不是第六个 provider port」。所以这个文件不在 `src/ports/` 下，也不进 `five-port-contract`
 * 的五端口计数 —— 它**消费** `ObjectStore`，而不是与它并列。
 *
 * ## 对外只发平台自己的 opaque grant URL
 * 客户端拿到的是 `{origin}{basePath}?grant=<256-bit 随机 token>`，有效期上界 300 秒。
 * provider 的 Blob URL / presign URL **从不**离开 `ObjectStore`（`putImmutable` 返回的是
 * `ObjectRef`，其语法里没有 `:`，装不下一个 URL）。因此「对外交付物里没有 provider URL」
 * 不是纪律，是类型事实。
 *
 * ## token 只存散列
 * 库里只有 `sha256(token)`。`IssuedGrant` 上也**没有**任何字段装得下裸 token —— 唯一的出口
 * 是 `url: SensitiveUrl`，而它的 `toString()` / `toJSON()` 都是脱敏形式，取原文只有显式
 * `reveal()` 一条路。
 *
 * ## 两个诚实的边界（本单证明不了，D5/D6 才能证明）
 * 1. **并发上限与字节账本都是进程内的**。跨进程要 D5 把 `committedBytes` 落库（本类在
 *    `close` 时通过 `GrantRecordStore.addCommittedBytes` 交回增量，并在 `open` 时用它重新
 *    播种账本），把并发计数落到一条数据库唯一约束上。替身测的是**机制**，不是分布式正确性。
 * 2. **真实 private Blob 链路**的未授权/过期拒绝、真实日志无 provider URL、端到端
 *    artifact-hash 一致性，全部留给 D5/D6。本文件的测试跑在 `InMemoryObjectStore` 上。
 */
import { createHash, randomBytes } from 'node:crypto';

import { type ArtifactDigest, type Timestamp, brand, timestampSortKey } from '@littleq/domain';

import { type InfraError, infraError, type InfraErrorCode } from '../errors.js';
import {
  type ByteRange,
  type ObjectRef,
  type SensitiveUrl,
  type StoredObjectStream,
  byteRangeLength,
  markSensitiveUrl,
  parseByteRange,
  shiftTimestamp,
} from '../types.js';
import { ARTIFACT_MAX_BYTES, type ObjectStore } from '../ports/object-store.js';
import { RUNTIME_PREVIEW_AUDIENCE } from '../ports/runtime-publisher.js';
import {
  type InfraLogger,
  type LogSink,
  createRedactingLogger,
  fingerprint,
} from '../log/redaction.js';
import { ByteLedger, pipeThroughLedger } from './byte-ledger.js';

/**
 * 同一个 grant 的并发租约上限。
 *
 * 第 9 路必须被拒（`OBJECT_READ_CONCURRENCY_LIMIT`，对外 429）。这个数字是**裁定的**，不是
 * 调出来的：它同时是「一个学生刷新页面能占住多少条后端读取」的上界。
 */
export const MAX_CONCURRENT_READS = 8;

/** 默认有效期。裁定：默认 120 秒，可申请 1..300，超过 300 在 `issue` 就被拒。 */
export const DEFAULT_GRANT_TTL_SECONDS = 120;
export const MIN_GRANT_TTL_SECONDS = 1;
export const MAX_GRANT_TTL_SECONDS = 300;

/** 256-bit 随机 token，base64url 编码后 43 字符。 */
export const GRANT_TOKEN_BYTES = 32;
export const GRANT_TOKEN_QUERY_PARAMETER = 'grant';

/** 库里存的 grant。**没有明文 token**，只有它的 sha256。 */
export interface StoredGrant {
  readonly grantId: string;
  readonly tokenHash: string;
  readonly objectRef: ObjectRef;
  readonly artifactHash: ArtifactDigest;
  readonly audience: string;
  readonly maxBytes: number;
  readonly maxConcurrentReads: number;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly revokedAt: Timestamp | null;
  /** 已交付字节的持久化计数；进程重启后用它重新播种账本（见文件头的边界 1）。 */
  readonly committedBytes: number;
}

export interface GrantRecordStore {
  save(grant: StoredGrant): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<StoredGrant | null>;
  findById(grantId: string): Promise<StoredGrant | null>;
  /** 撤销必须**立即**生效：写库与打断在飞的租约在同一次调用里完成。 */
  markRevoked(grantId: string, now: Timestamp): Promise<StoredGrant | null>;
  /** 把一次租约交付的字节数累加进去，返回新的总量。 */
  addCommittedBytes(grantId: string, delta: number): Promise<number>;
}

export interface IssueGrantInput {
  readonly objectRef: ObjectRef;
  readonly artifactHash: ArtifactDigest;
  /** 省略即 `runtime-preview`；目前**只有**这一个合法值（裁定一 §3）。 */
  readonly audience?: string;
  /** 这个 grant 生命周期内可交付的字节总量上界（跨 Range 累计）。 */
  readonly maxBytes: number;
  readonly ttlSeconds?: number;
  readonly maxConcurrentReads?: number;
  readonly now: Timestamp;
}

export interface IssuedGrant {
  readonly grantId: string;
  /** 平台 opaque grant URL。`reveal()` 之外拿不到原文，日志里出现的一律是脱敏形式。 */
  readonly url: SensitiveUrl;
  readonly expiresAt: Timestamp;
  readonly maxBytes: number;
  readonly maxConcurrentReads: number;
}

export interface OpenGrantInput {
  /** 客户端呈上的裸 token（只在内存里存在，立刻被散列，绝不入库、绝不入日志）。 */
  readonly token: string;
  readonly audience: string;
  readonly range?: ByteRange;
  readonly now: Timestamp;
}

export interface GrantLease {
  readonly leaseId: string;
  readonly grantId: string;
  readonly objectRef: ObjectRef;
  readonly artifactHash: ArtifactDigest;
  readonly stream: StoredObjectStream;
}

/** grant URL 的形状由 D5 决定（那个内部 endpoint 不在冻结的公共契约里），所以必须注入。 */
export interface ObjectReadGrantUrlConfig {
  readonly origin: string;
  readonly basePath: string;
  readonly tokenQueryParameter?: string;
}

export interface ObjectReadGrantServiceOptions {
  readonly store: ObjectStore;
  readonly records: GrantRecordStore;
  readonly url: ObjectReadGrantUrlConfig;
  /**
   * 时钟，**可注入**。过期是这组不变量里的一条，而一条读系统时间的实现在测试里没法被
   * 变红 —— 尤其「读到一半跨过 `expiresAt` 也必须停下」这种只有推进时钟才看得见的行为。
   */
  readonly now?: () => Timestamp;
  /** 给一个 sink，服务自己包脱敏；测试挂 spy sink 就能断言真实写入路径里没有原文。 */
  readonly sink?: LogSink;
  readonly logger?: InfraLogger;
}

interface LeaseEntry {
  readonly lease: GrantLease;
  readonly controller: AbortController;
  /** 打断原因在打断那一刻才知道，所以是一个可写的格子而不是常量。 */
  readonly reason: { code: InfraErrorCode };
  delivered(): number;
  persisted: number;
}

export function hashGrantToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 到期是**闭区间右端即失效**：`now === expiresAt` 已经算过期，不留边界模糊。 */
export function isGrantExpired(now: Timestamp, expiresAt: Timestamp): boolean {
  return timestampSortKey(now) >= timestampSortKey(expiresAt);
}

export class ObjectReadGrantService {
  readonly #store: ObjectStore;
  readonly #records: GrantRecordStore;
  readonly #url: ObjectReadGrantUrlConfig;
  readonly #logger: InfraLogger;
  readonly #now: () => Timestamp;
  readonly #ledgers = new Map<string, ByteLedger>();
  readonly #leases = new Map<string, Map<string, LeaseEntry>>();
  #deniedReads = 0;

  constructor(options: ObjectReadGrantServiceOptions) {
    this.#store = options.store;
    this.#records = options.records;
    this.#url = options.url;
    this.#now = options.now ?? systemTimestamp;
    this.#logger =
      options.logger ?? createRedactingLogger(options.sink ?? { write: () => undefined });
  }

  /** 被拒的读取次数。测试用它证明「拒绝路径真的走过了」，而不是断言在一个永不拒绝的实现上。 */
  get deniedReads(): number {
    return this.#deniedReads;
  }

  async issue(input: IssueGrantInput): Promise<IssuedGrant> {
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < MIN_GRANT_TTL_SECONDS ||
      ttlSeconds > MAX_GRANT_TTL_SECONDS
    ) {
      throw this.#deny('GRANT_TTL_OUT_OF_RANGE', null, { requestedTtlSeconds: ttlSeconds });
    }
    const audience = input.audience ?? RUNTIME_PREVIEW_AUDIENCE;
    if (audience !== RUNTIME_PREVIEW_AUDIENCE) {
      throw this.#deny('GRANT_AUDIENCE_MISMATCH', null, { audience });
    }
    if (
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > ARTIFACT_MAX_BYTES
    ) {
      throw this.#deny('GRANT_BUDGET_OUT_OF_RANGE', null, { maxBytes: input.maxBytes });
    }
    const maxConcurrentReads = input.maxConcurrentReads ?? MAX_CONCURRENT_READS;
    if (maxConcurrentReads !== MAX_CONCURRENT_READS) {
      throw this.#deny('OBJECT_READ_CONCURRENCY_LIMIT', null, { maxConcurrentReads });
    }

    const token = randomBytes(GRANT_TOKEN_BYTES).toString('base64url');
    const grantId = `grant_${randomBytes(16).toString('hex')}`;
    const expiresAt = shiftTimestamp(input.now, ttlSeconds, 'GRANT_TTL_OUT_OF_RANGE');
    const grant: StoredGrant = {
      grantId,
      tokenHash: hashGrantToken(token),
      objectRef: input.objectRef,
      artifactHash: input.artifactHash,
      audience,
      maxBytes: input.maxBytes,
      maxConcurrentReads,
      issuedAt: input.now,
      expiresAt,
      revokedAt: null,
      committedBytes: 0,
    };
    await this.#records.save(grant);
    this.#ledgers.set(grantId, new ByteLedger(input.maxBytes));

    this.#logger.info('object-read-grant.issued', {
      grantId,
      // 只记指纹：裸 token 与 grant URL 都不允许进日志（§14 第 6 项）。
      authFingerprint: fingerprint(token),
      audience,
      objectRef: input.objectRef,
      artifactHash: input.artifactHash,
      expiresAt,
      maxBytes: input.maxBytes,
      maxConcurrentReads,
    });
    return {
      grantId,
      url: this.#grantUrl(token),
      expiresAt,
      maxBytes: input.maxBytes,
      maxConcurrentReads,
    };
  }

  async open(input: OpenGrantInput): Promise<GrantLease> {
    const tokenHash = hashGrantToken(input.token);
    const grant = await this.#records.findByTokenHash(tokenHash);
    if (grant === null) throw this.#deny('OBJECT_READ_GRANT_UNKNOWN', null, {});
    if (grant.revokedAt !== null) {
      throw this.#deny('OBJECT_READ_GRANT_REVOKED', grant.grantId, {});
    }
    if (isGrantExpired(input.now, grant.expiresAt)) {
      throw this.#deny('OBJECT_READ_GRANT_EXPIRED', grant.grantId, { expiresAt: grant.expiresAt });
    }
    if (input.audience !== grant.audience) {
      throw this.#deny('GRANT_AUDIENCE_MISMATCH', grant.grantId, { audience: input.audience });
    }

    const ledger = this.#ledgerFor(grant);
    if (ledger.remaining < 1) {
      throw this.#deny('OBJECT_READ_BUDGET_EXCEEDED', grant.grantId, {
        committedBytes: ledger.committed,
      });
    }
    const active = this.#leases.get(grant.grantId);
    if (active !== undefined && active.size >= grant.maxConcurrentReads) {
      throw this.#deny('OBJECT_READ_CONCURRENCY_LIMIT', grant.grantId, {
        activeLeases: active.size,
        maxConcurrentReads: grant.maxConcurrentReads,
      });
    }

    const range =
      input.range === undefined
        ? undefined
        : parseByteRange(input.range.start, input.range.endInclusive);
    if (range !== undefined && byteRangeLength(range) > ledger.remaining) {
      // 跨 Range 累计的关键一行：单次请求就算只要「剩下的一半」，也不能超过总预算的余额。
      throw this.#deny('OBJECT_READ_BUDGET_EXCEEDED', grant.grantId, {
        requestedBytes: byteRangeLength(range),
        remainingBytes: ledger.remaining,
      });
    }

    const controller = new AbortController();
    const reason: { code: InfraErrorCode } = { code: 'OBJECT_READ_GRANT_REVOKED' };
    let stream: StoredObjectStream;
    try {
      stream = await this.#store.getPrivate({
        ref: grant.objectRef,
        range,
        maxBytes: ledger.remaining,
        abortSignal: controller.signal,
      });
    } catch (error) {
      controller.abort();
      throw error;
    }

    const leaseId = `lease_${randomBytes(8).toString('hex')}`;
    let delivered = 0;
    const expiresAt = grant.expiresAt;
    const clock = this.#now;
    const body = pipeThroughLedger(
      stream.body,
      ledger,
      controller.signal,
      () => reason.code,
      (byteLength) => {
        delivered += byteLength;
      },
      // 过期不只挡 `open`：一条已经开出去的租约在读到一半时跨过 `expiresAt`，也必须停下。
      // 这一刻已经没有「请求里的 now」可用了（`open` 早就返回了），所以只能读注入的时钟。
      // 守卫交给 pull 驱动的账本管道去逐 chunk 复查，而不是自己再套一层 TransformStream：
      // 多套一层就多一条没人持有其 promise 的内部管道（见 `pipeThroughLedger` 的说明）。
      () => (isGrantExpired(clock(), expiresAt) ? 'OBJECT_READ_GRANT_EXPIRED' : null),
    );

    const lease: GrantLease = {
      leaseId,
      grantId: grant.grantId,
      objectRef: grant.objectRef,
      artifactHash: grant.artifactHash,
      stream: { ...stream, body, deliveredBytes: () => delivered },
    };
    const entry: LeaseEntry = {
      lease,
      controller,
      reason,
      delivered: () => delivered,
      persisted: 0,
    };
    const bucket = this.#leases.get(grant.grantId) ?? new Map<string, LeaseEntry>();
    bucket.set(leaseId, entry);
    this.#leases.set(grant.grantId, bucket);

    this.#logger.debug('object-read-grant.opened', {
      grantId: grant.grantId,
      leaseId,
      authFingerprint: fingerprint(input.token),
      range: range === undefined ? null : `${range.start}-${range.endInclusive}`,
      remainingBytes: ledger.remaining,
      activeLeases: bucket.size,
    });
    return lease;
  }

  /**
   * 归还租约。**幂等**：D5 的 `finally` 可能跑两次，第二次不该变成一次 500。
   *
   * 归还会打断底层读取（`controller.abort()`），否则一条没人再读的流会一直占着 provider
   * 的连接与一个并发名额。
   */
  async close(lease: GrantLease): Promise<void> {
    const bucket = this.#leases.get(lease.grantId);
    const entry = bucket?.get(lease.leaseId);
    if (bucket === undefined || entry === undefined) return;
    bucket.delete(lease.leaseId);
    if (bucket.size === 0) this.#leases.delete(lease.grantId);

    const delivered = entry.delivered();
    entry.reason.code = 'OBJECT_READ_ABORTED';
    entry.controller.abort();
    const delta = delivered - entry.persisted;
    entry.persisted = delivered;
    if (delta > 0) await this.#records.addCommittedBytes(lease.grantId, delta);
    this.#logger.debug('object-read-grant.closed', {
      grantId: lease.grantId,
      leaseId: lease.leaseId,
      deliveredBytes: delivered,
    });
  }

  /**
   * 撤销一个 grant：**立即**生效。
   *
   * 「立即」在这里是可测的：写库标记 `revokedAt` 之后，所有在飞租约的 `AbortController`
   * 在同一轮里被 `abort()`，它们的流当场以 `OBJECT_READ_GRANT_REVOKED` 结束，后续 `open`
   * 也一律被拒。返回被打断的租约数，测试用它证明「撤销时确实有活着的读取」。
   *
   * 落库顺序刻意是「先 abort，后补记账」：撤销不能等一次写库，而已经流出去的字节确实流出去了
   * —— 租约条目一删，`close()` 就再也找不到它，那段差额会永久丢失。所以这里自己把差额补上，
   * 并把 `persisted` 推到与 `close()` 同一个口径（随后到来的 `close()` 因此是纯 no-op）。
   */
  async revoke(grantId: string, now: Timestamp): Promise<number> {
    const grant = await this.#records.markRevoked(grantId, now);
    if (grant === null) throw this.#deny('OBJECT_READ_GRANT_UNKNOWN', null, { grantId });
    const bucket = this.#leases.get(grantId);
    const entries = bucket === undefined ? [] : [...bucket.values()];
    for (const entry of entries) {
      entry.reason.code = 'OBJECT_READ_GRANT_REVOKED';
      entry.controller.abort();
    }
    if (bucket !== undefined) this.#leases.delete(grantId);
    for (const entry of entries) {
      const delivered = entry.delivered();
      const delta = delivered - entry.persisted;
      entry.persisted = delivered;
      if (delta > 0) await this.#records.addCommittedBytes(grantId, delta);
    }
    this.#logger.info('object-read-grant.revoked', { grantId, abortedLeases: entries.length });
    return entries.length;
  }

  /** 当前进程内已经交付的字节总量（含尚未落库的部分）。 */
  committedBytes(grantId: string): number {
    return this.#ledgers.get(grantId)?.committed ?? 0;
  }

  activeLeaseCount(grantId: string): number {
    return this.#leases.get(grantId)?.size ?? 0;
  }

  #ledgerFor(grant: StoredGrant): ByteLedger {
    const existing = this.#ledgers.get(grant.grantId);
    if (existing !== undefined) return existing;
    // 进程重启后账本不在内存里：用库里持久化的计数重新播种，否则累计预算会被清零，
    // 「跨 Range 累计」就退化成了「每次重启重新计一次」。
    const ledger = new ByteLedger(grant.maxBytes, grant.committedBytes);
    this.#ledgers.set(grant.grantId, ledger);
    return ledger;
  }

  #grantUrl(token: string): SensitiveUrl {
    const parameter = this.#url.tokenQueryParameter ?? GRANT_TOKEN_QUERY_PARAMETER;
    const url = new URL(this.#url.basePath, this.#url.origin);
    url.searchParams.set(parameter, token);
    return markSensitiveUrl(url.toString());
  }

  #deny(code: InfraErrorCode, grantId: string | null, fields: Record<string, unknown>): InfraError {
    this.#deniedReads += 1;
    this.#logger.warn('object-read-grant.denied', { ...fields, grantId, reason: code });
    return infraError(code);
  }
}

/**
 * 默认时钟。`new Date().toISOString()` 恒为合法 RFC3339，所以这里刻意**不**走
 * `parseStoredTimestamp` 那条带错误码的路：给「读系统时间」编一个失败分支，只会让调用方
 * 多写一段永远走不到的 catch。需要确定性的地方（也就是全部测试）注入自己的钟。
 */
function systemTimestamp(): Timestamp {
  return brand<string, 'Timestamp'>(new Date().toISOString());
}

/**
 * 产物分片固化（ZLQ-194 §14「产物可分片固化」、ZLQ-201 裁定一）。
 *
 * ## 两条固定规则（不接受调用方自由拼 key）
 * 1. 分片 key 的形状固定为 `artifacts/{artifactHash}/chunks/{ordinal}-{chunkSha256}`。
 *    key 里带内容摘要 ⇒ 同一个 ordinal 换内容就是**另一个 key**，于是「悄悄覆盖一个已固化
 *    分片」在存储层根本表达不出来；`putImmutable` 的不可覆盖语义再兜一次。
 * 2. **清单最后写**。`artifacts/{hash}/manifest.json` 存在 ⇔ 这个产物已完整固化。中途失败
 *    时清单不在，前缀里只有孤儿分片，D5 可以整段重试；如果先写清单，一次失败就会留下一个
 *    「自称完整、实际缺片」的产物，而那正是 §14 要防的事故。
 *
 * ## 摘要在哪一层校验
 * 产物级 `artifactHash` 由本文件对**全部实际字节**重新计算并比对（`ARTIFACT_HASH_MISMATCH`），
 * 不是信任调用方给的数。分片级摘要同样由本文件计算后写进 key，`putImmutable` 再校一次。
 * 两层都算，是因为清单是给 D5/D6 的端到端一致性用的：只有 infra 自己算出来的摘要才配被
 * 写进一份对外声称「这些字节就是这个 hash」的文件。
 */
import { createHash } from 'node:crypto';

import type { ArtifactDigest, Timestamp } from '@littleq/domain';

import { infraError, isInfraError } from '../errors.js';
import type { ObjectRef } from '../types.js';
import { parseObjectRef, parseStoredDigest, parseStoredTimestamp } from '../types.js';
import { ARTIFACT_MAX_BYTES, type ObjectStore } from '../ports/object-store.js';
import {
  collectStream,
  concatBytes,
  idleAbortSignal,
  sha256Hex,
  streamFromBytes,
  throwIfAborted,
} from './budget.js';

export const ARTIFACTS_PREFIX = 'artifacts';
export const CHUNK_CONTENT_TYPE = 'application/octet-stream';
export const MANIFEST_CONTENT_TYPE = 'application/json';
/** 清单本身的上界。一个 15MiB 产物按 4MiB 切片最多 4 片，64KiB 远远够，越界即数据损坏。 */
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const DEFAULT_CHUNK_MAX_BYTES = 4 * 1024 * 1024;

/** 分片 key。ordinal 用十进制、不补零：补零会让「同一个分片两个 key」成为可能。 */
export function chunkKey(
  artifactHash: ArtifactDigest,
  ordinal: number,
  chunkSha256: ArtifactDigest,
): string {
  return `${ARTIFACTS_PREFIX}/${artifactHash}/chunks/${ordinal}-${chunkSha256}`;
}

export function chunkPrefix(artifactHash: ArtifactDigest): string {
  return `${ARTIFACTS_PREFIX}/${artifactHash}/chunks/`;
}

export function manifestKey(artifactHash: ArtifactDigest): string {
  return `${ARTIFACTS_PREFIX}/${artifactHash}/manifest.json`;
}

export interface ArtifactChunk {
  readonly ordinal: number;
  readonly ref: ObjectRef;
  readonly byteLength: number;
  readonly sha256: ArtifactDigest;
}

export interface ArtifactManifest {
  readonly artifactHash: ArtifactDigest;
  readonly totalBytes: number;
  readonly chunkCount: number;
  readonly chunks: readonly ArtifactChunk[];
  readonly sealedAt: Timestamp;
}

export interface SealArtifactInput {
  readonly artifactHash: ArtifactDigest;
  /** 调用方声称的总字节数；与分片实际字节之和不符 ⇒ `ARTIFACT_TOTAL_MISMATCH`。 */
  readonly totalBytes: number;
  /** 按 ordinal 递增给出的分片字节；空数组一律拒绝（没有分片就没有产物）。 */
  readonly chunks: readonly Uint8Array[];
  readonly chunkMaxBytes?: number;
  readonly abortSignal: AbortSignal;
  readonly now: Timestamp;
}

export interface ArtifactSealerOptions {
  readonly chunkMaxBytes?: number;
}

export class ArtifactSealer {
  readonly #store: ObjectStore;
  readonly #defaultChunkMaxBytes: number;

  constructor(store: ObjectStore, options: ArtifactSealerOptions = {}) {
    this.#store = store;
    this.#defaultChunkMaxBytes = options.chunkMaxBytes ?? DEFAULT_CHUNK_MAX_BYTES;
  }

  /**
   * 固化一个产物：逐片写入 → 重算产物级摘要 → 最后写清单。
   *
   * 任一步失败都会把**本次写入的分片**按前缀清掉，然后原样抛出；清单不在，所以外部看不到
   * 半个产物。已固化过（清单存在）⇒ `ARTIFACT_ALREADY_SEALED`，不会重复写分片。
   */
  async seal(input: SealArtifactInput): Promise<ArtifactManifest> {
    throwIfAborted(input.abortSignal);
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1) {
      throw infraError('ARTIFACT_TOTAL_MISMATCH');
    }
    if (input.totalBytes > ARTIFACT_MAX_BYTES) throw infraError('OBJECT_UPLOAD_TOO_LARGE');
    if (input.chunks.length === 0) throw infraError('ARTIFACT_CHUNK_MISSING');

    const chunkMaxBytes = input.chunkMaxBytes ?? this.#defaultChunkMaxBytes;
    if (
      !Number.isSafeInteger(chunkMaxBytes) ||
      chunkMaxBytes < 1 ||
      chunkMaxBytes > ARTIFACT_MAX_BYTES
    ) {
      throw infraError('GRANT_BUDGET_OUT_OF_RANGE');
    }

    const manifestRef = parseObjectRef(manifestKey(input.artifactHash));
    if ((await this.#store.head(manifestRef)) !== null) throw infraError('ARTIFACT_ALREADY_SEALED');

    const written: string[] = [];
    const sealed: ArtifactChunk[] = [];
    const productHash = createHash('sha256');
    let total = 0;
    try {
      for (const [ordinal, bytes] of input.chunks.entries()) {
        if (bytes.byteLength < 1) throw infraError('ARTIFACT_CHUNK_ORDER_INVALID');
        if (bytes.byteLength > chunkMaxBytes) throw infraError('OBJECT_UPLOAD_TOO_LARGE');
        const chunkSha256 = parseStoredDigest(sha256Hex(bytes), 'OBJECT_HASH_MISMATCH');
        const key = chunkKey(input.artifactHash, ordinal, chunkSha256);
        const ref = await this.#store.putImmutable({
          key,
          body: streamFromBytes(bytes),
          declaredBytes: bytes.byteLength,
          maxBytes: chunkMaxBytes,
          sha256: chunkSha256,
          contentType: CHUNK_CONTENT_TYPE,
          abortSignal: input.abortSignal,
        });
        written.push(key);
        sealed.push({ ordinal, ref, byteLength: bytes.byteLength, sha256: chunkSha256 });
        productHash.update(bytes);
        total += bytes.byteLength;
      }

      if (total !== input.totalBytes) throw infraError('ARTIFACT_TOTAL_MISMATCH');
      const actualDigest = productHash.digest('hex');
      if (actualDigest !== input.artifactHash) throw infraError('ARTIFACT_HASH_MISMATCH');

      const manifest: ArtifactManifest = {
        artifactHash: input.artifactHash,
        totalBytes: total,
        chunkCount: sealed.length,
        chunks: sealed,
        sealedAt: input.now,
      };
      const encoded = new TextEncoder().encode(JSON.stringify(manifest));
      if (encoded.byteLength > MANIFEST_MAX_BYTES) throw infraError('ARTIFACT_MANIFEST_INVALID');
      await this.#store.putImmutable({
        key: manifestKey(input.artifactHash),
        body: streamFromBytes(encoded),
        declaredBytes: encoded.byteLength,
        maxBytes: MANIFEST_MAX_BYTES,
        contentType: MANIFEST_CONTENT_TYPE,
        sha256: parseStoredDigest(sha256Hex(encoded), 'OBJECT_HASH_MISMATCH'),
        abortSignal: input.abortSignal,
      });
      return manifest;
    } catch (error) {
      // 清单还没写（或没写成），这些分片对外不可见，属于孤儿：按前缀清掉，让重试从零开始。
      if (written.length > 0) await this.#store.deletePrefix(chunkPrefix(input.artifactHash));
      throw error;
    }
  }

  /** 读回清单。不存在返回 `null` —— 「还没固化」是正常状态，不是错误。 */
  async loadManifest(artifactHash: ArtifactDigest): Promise<ArtifactManifest | null> {
    const ref = parseObjectRef(manifestKey(artifactHash));
    const abortSignal = idleAbortSignal();
    const stream = await this.#store
      .getPrivate({ ref, maxBytes: MANIFEST_MAX_BYTES, abortSignal })
      .catch((error: unknown) => {
        if (isInfraError(error) && error.code === 'OBJECT_NOT_FOUND') return null;
        throw error;
      });
    if (stream === null) return null;
    const raw = await collectStream(stream.body, abortSignal);
    return parseManifest(raw);
  }

  /**
   * 核对一个已固化的产物：清单在、每一片都在、片长之和等于清单声称的总长。
   *
   * 这是 §14「产物可分片固化」的**读取侧**证明 —— 固化当时对，不代表后来还在（provider 的
   * 生命周期策略、误删前缀都可能挖掉一片）。D5 在把 artifactHash 交给 Runtime 之前调它。
   */
  async verifySealed(artifactHash: ArtifactDigest): Promise<ArtifactManifest> {
    const manifest = await this.#loadOrThrow(artifactHash);
    let total = 0;
    for (const chunk of manifest.chunks) {
      const head = await this.#store.head(chunk.ref);
      if (head === null) throw infraError('ARTIFACT_CHUNK_MISSING');
      if (head.byteLength !== chunk.byteLength || head.sha256 !== chunk.sha256) {
        throw infraError('ARTIFACT_CHUNK_MISSING');
      }
      total += head.byteLength;
    }
    if (total !== manifest.totalBytes) throw infraError('ARTIFACT_TOTAL_MISMATCH');
    return manifest;
  }

  async #loadOrThrow(artifactHash: ArtifactDigest): Promise<ArtifactManifest> {
    const manifest = await this.loadManifest(artifactHash);
    if (manifest === null) throw infraError('ARTIFACT_CHUNK_MISSING');
    return manifest;
  }
}

/**
 * 解析并结构性校验清单。
 *
 * 任何解析失败都说明存储里的东西不是我们写的那份，属于 `ARTIFACT_MANIFEST_INVALID`，**不能**
 * 当成「没固化」重试：重试会往一个可能还有用的前缀里写新分片。「没固化」由 `loadManifest`
 * 把 `OBJECT_NOT_FOUND` 翻译成 `null` 来表达，两种情况必须可区分。
 */
export function parseManifest(raw: Uint8Array): ArtifactManifest | null {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw infraError('ARTIFACT_MANIFEST_INVALID');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw infraError('ARTIFACT_MANIFEST_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw infraError('ARTIFACT_MANIFEST_INVALID');
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.artifactHash !== 'string') throw infraError('ARTIFACT_MANIFEST_INVALID');
  if (typeof candidate.totalBytes !== 'number' || !Number.isSafeInteger(candidate.totalBytes)) {
    throw infraError('ARTIFACT_MANIFEST_INVALID');
  }
  if (typeof candidate.chunkCount !== 'number' || !Array.isArray(candidate.chunks)) {
    throw infraError('ARTIFACT_MANIFEST_INVALID');
  }
  if (typeof candidate.sealedAt !== 'string') throw infraError('ARTIFACT_MANIFEST_INVALID');
  const sealedAt = parseStoredTimestamp(candidate.sealedAt, 'ARTIFACT_MANIFEST_INVALID');

  const chunks: ArtifactChunk[] = [];
  for (const [index, entry] of candidate.chunks.entries()) {
    if (typeof entry !== 'object' || entry === null) throw infraError('ARTIFACT_MANIFEST_INVALID');
    const chunk = entry as Record<string, unknown>;
    if (chunk.ordinal !== index || typeof chunk.ref !== 'string') {
      throw infraError('ARTIFACT_MANIFEST_INVALID');
    }
    if (typeof chunk.byteLength !== 'number' || typeof chunk.sha256 !== 'string') {
      throw infraError('ARTIFACT_MANIFEST_INVALID');
    }
    chunks.push({
      ordinal: chunk.ordinal,
      ref: parseObjectRef(chunk.ref),
      byteLength: chunk.byteLength,
      sha256: parseStoredDigest(chunk.sha256, 'ARTIFACT_MANIFEST_INVALID'),
    });
  }
  if (chunks.length !== candidate.chunkCount) throw infraError('ARTIFACT_MANIFEST_INVALID');
  if (chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) !== candidate.totalBytes) {
    throw infraError('ARTIFACT_TOTAL_MISMATCH');
  }
  return {
    artifactHash: parseStoredDigest(candidate.artifactHash, 'ARTIFACT_MANIFEST_INVALID'),
    totalBytes: candidate.totalBytes,
    chunkCount: candidate.chunkCount,
    chunks,
    sealedAt,
  };
}

/** 把若干分片按序拼回整份字节，供端到端 hash 比对（D5/D6）与本地测试使用。 */
export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  return concatBytes(
    chunks,
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
}

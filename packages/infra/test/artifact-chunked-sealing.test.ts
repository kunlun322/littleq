/**
 * 能力 `artifact-chunked-sealing`：ZLQ-194 §14「产物可分片固化」。
 *
 * ## 两条规则各自怎么被证明
 * 1. **清单最后写** —— 不是靠读源码顺序，而是用一个记录写入顺序的 `ObjectStore` 装饰器，
 *    断言 `manifest.json` 是**最后一个** key；再补一刀：让清单那次写入失败，断言外部看不到
 *    半个产物（清单不在、孤儿分片被按前缀清掉）。
 * 2. **key 里带内容摘要** —— 同一个 ordinal 换内容就是另一个 key，于是「悄悄覆盖一个已固化
 *    分片」在存储层根本表达不出来。这里断言 key 的字面形状，并断言重复固化被
 *    `ARTIFACT_ALREADY_SEALED` 挡住而不是被静默覆盖。
 *
 * ## 端到端一致性在本文件里到哪一步为止
 * 「拼回全部字节 → sha256 == artifactHash」这一步在**内存替身**上做完了（见最后一个用例）。
 * 跨进程的那一半 —— 主站固化、Runtime 从真实 private Blob 取字节、两边摘要一致 —— 是 D5/D6
 * 的验收，本文件不声称覆盖。
 */
import { describe, expect, it } from 'vitest';

import { type ArtifactDigest, brand } from '@littleq/domain';

import { infraError } from '../src/errors.js';
import {
  ARTIFACTS_PREFIX,
  type ArtifactManifest,
  ArtifactSealer,
  CHUNK_CONTENT_TYPE,
  DEFAULT_CHUNK_MAX_BYTES,
  MANIFEST_CONTENT_TYPE,
  MANIFEST_MAX_BYTES,
  type SealArtifactInput,
  chunkKey,
  chunkPrefix,
  joinChunks,
  manifestKey,
  parseManifest,
} from '../src/object-store/artifact-sealer.js';
import { idleAbortSignal, sha256Hex } from '../src/object-store/budget.js';
import { InMemoryObjectStore } from '../src/object-store/memory.js';
import {
  ARTIFACT_MAX_BYTES,
  type GetPrivateInput,
  type ObjectStore,
  type PutImmutableInput,
} from '../src/ports/object-store.js';
import {
  type HealthResult,
  type ObjectRef,
  type StoredObjectMetadata,
  type StoredObjectStream,
  parseObjectRef,
} from '../src/types.js';

import { at, bytes, collect, sha256Of } from './support.js';

const HASH_A = brand<string, 'ArtifactDigest'>('a'.repeat(64));

/** 记录写入顺序、并可选择让第 N 次写入失败的 `ObjectStore` 装饰器。 */
class RecordingObjectStore implements ObjectStore {
  readonly #inner: InMemoryObjectStore;
  readonly #writes: string[] = [];
  #failOnWriteIndex: number | null = null;

  constructor(inner = new InMemoryObjectStore({ now: () => new Date(0) })) {
    this.#inner = inner;
  }

  get writes(): readonly string[] {
    return [...this.#writes];
  }

  get inner(): InMemoryObjectStore {
    return this.#inner;
  }

  /** 让第 `index` 次（0 起）写入以依赖不可用失败：模拟 provider 在最后一步掉链子。 */
  failOnWrite(index: number): void {
    this.#failOnWriteIndex = index;
  }

  async putImmutable(input: PutImmutableInput): Promise<ObjectRef> {
    const index = this.#writes.length;
    this.#writes.push(input.key);
    if (this.#failOnWriteIndex === index) throw infraError('PROVIDER_UNAVAILABLE');
    return this.#inner.putImmutable(input);
  }

  getPrivate(input: GetPrivateInput): Promise<StoredObjectStream> {
    return this.#inner.getPrivate(input);
  }

  head(ref: ObjectRef): Promise<StoredObjectMetadata | null> {
    return this.#inner.head(ref);
  }

  deletePrefix(prefix: string): Promise<void> {
    return this.#inner.deletePrefix(prefix);
  }

  health(): Promise<HealthResult> {
    return this.#inner.health();
  }
}

function payloadChunks(): Uint8Array[] {
  return [bytes(120, 1), bytes(96, 2), bytes(40, 3)];
}

function sealInput(
  chunks: readonly Uint8Array[],
  overrides: Partial<SealArtifactInput> = {},
): SealArtifactInput {
  const joined = joinChunks(chunks);
  return {
    artifactHash: brand<string, 'ArtifactDigest'>(sha256Hex(joined)),
    totalBytes: joined.byteLength,
    chunks,
    abortSignal: idleAbortSignal(),
    now: at(0),
    ...overrides,
  };
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function throwsCode(raw: Uint8Array): string | null {
  try {
    parseManifest(raw);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

describe('artifact-chunked-sealing', () => {
  it('key 形状与常量被逐字点名（ordinal 十进制不补零，key 里带分片摘要）', () => {
    expect(ARTIFACTS_PREFIX).toBe('artifacts');
    expect(CHUNK_CONTENT_TYPE).toBe('application/octet-stream');
    expect(MANIFEST_CONTENT_TYPE).toBe('application/json');
    expect(MANIFEST_MAX_BYTES).toBe(64 * 1024);
    expect(DEFAULT_CHUNK_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(ARTIFACT_MAX_BYTES).toBe(15 * 1024 * 1024);

    const chunkHash = brand<string, 'ArtifactDigest'>('b'.repeat(64));
    expect(chunkKey(HASH_A, 0, chunkHash)).toBe(
      `artifacts/${'a'.repeat(64)}/chunks/0-${'b'.repeat(64)}`,
    );
    // 不补零：`10` 就是 `10`，不会与 `010` 撞成两个 key 指向同一片。
    expect(chunkKey(HASH_A, 10, chunkHash)).toContain('/chunks/10-');
    expect(chunkPrefix(HASH_A)).toBe(`artifacts/${'a'.repeat(64)}/chunks/`);
    expect(manifestKey(HASH_A)).toBe(`artifacts/${'a'.repeat(64)}/manifest.json`);
    expect(parseObjectRef(chunkKey(HASH_A, 0, chunkHash))).toBe(chunkKey(HASH_A, 0, chunkHash));
  });

  it('清单最后写：分片全部落地之后才轮到 manifest.json', async () => {
    const store = new RecordingObjectStore();
    const sealer = new ArtifactSealer(store);
    const chunks = payloadChunks();
    const manifest = await sealer.seal(sealInput(chunks));

    expect(manifest.chunkCount).toBe(3);
    expect(manifest.totalBytes).toBe(256);
    expect(manifest.sealedAt).toBe(at(0));
    expect(manifest.chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);

    const writes = store.writes;
    expect(writes).toHaveLength(4);
    expect(writes[3]).toBe(manifestKey(manifest.artifactHash));
    expect(writes.slice(0, 3)).toEqual(manifest.chunks.map((chunk) => String(chunk.ref)));
    expect(
      writes.slice(0, 3).every((key) => key.startsWith(chunkPrefix(manifest.artifactHash))),
    ).toBe(true);
    // key 里带的是**这一片实际字节**的摘要，不是调用方声称的。
    const first = chunks[0];
    if (first === undefined) throw new Error('夹具里应该有第 1 片');
    expect(writes[0]).toBe(
      chunkKey(manifest.artifactHash, 0, brand<string, 'ArtifactDigest'>(sha256Hex(first))),
    );
  });

  it('清单那次写入失败时，外部看不到半个产物：清单不在、孤儿分片被清掉', async () => {
    const store = new RecordingObjectStore();
    const sealer = new ArtifactSealer(store);
    const input = sealInput(payloadChunks());
    store.failOnWrite(3);

    await expect(sealer.seal(input)).rejects.toThrow('PROVIDER_UNAVAILABLE');
    // 三个分片确实写过、清单那次也尝试过，但失败后按前缀清掉了：整个前缀一个 key 都不剩。
    expect(store.writes).toHaveLength(4);
    expect(store.inner.storedKeys()).toEqual([]);
    await expect(sealer.loadManifest(input.artifactHash)).resolves.toBeNull();
    await expect(sealer.verifySealed(input.artifactHash)).rejects.toThrow('ARTIFACT_CHUNK_MISSING');
  });

  it('摘要不符 ⇒ ARTIFACT_HASH_MISMATCH，且不留孤儿分片', async () => {
    const store = new RecordingObjectStore();
    const sealer = new ArtifactSealer(store);
    await expect(
      sealer.seal(sealInput(payloadChunks(), { artifactHash: sha256Of(bytes(256, 99)) })),
    ).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
    expect(store.inner.storedKeys()).toEqual([]);
    // 产物级摘要是 infra 自己对全部实际字节重算的，不是信任调用方给的数。
    expect(infraError('ARTIFACT_HASH_MISMATCH').publicCode).toBe('ARTIFACT_INCOMPLETE');
  });

  it('总字节数不符 ⇒ ARTIFACT_TOTAL_MISMATCH；超过产物上界 ⇒ OBJECT_UPLOAD_TOO_LARGE', async () => {
    const store = new RecordingObjectStore();
    const sealer = new ArtifactSealer(store);
    const input = sealInput(payloadChunks());
    for (const totalBytes of [255, 257, 0, -1, 1.5, Number.NaN]) {
      await expect(sealer.seal({ ...input, totalBytes })).rejects.toThrow(
        'ARTIFACT_TOTAL_MISMATCH',
      );
    }
    await expect(sealer.seal({ ...input, totalBytes: ARTIFACT_MAX_BYTES + 1 })).rejects.toThrow(
      'OBJECT_UPLOAD_TOO_LARGE',
    );
    expect(store.inner.storedKeys()).toEqual([]);
  });

  it('没有分片 / 空分片 / 超过分片上界 / 分片上界非法，各自有专属的失败码', async () => {
    const store = new RecordingObjectStore();
    const sealer = new ArtifactSealer(store);
    const input = sealInput(payloadChunks());

    await expect(sealer.seal({ ...input, chunks: [] })).rejects.toThrow('ARTIFACT_CHUNK_MISSING');
    await expect(sealer.seal(sealInput([bytes(8, 1), new Uint8Array(0)]))).rejects.toThrow(
      'ARTIFACT_CHUNK_ORDER_INVALID',
    );
    await expect(sealer.seal(sealInput([bytes(64, 1)], { chunkMaxBytes: 32 }))).rejects.toThrow(
      'OBJECT_UPLOAD_TOO_LARGE',
    );
    for (const chunkMaxBytes of [0, -1, 1.5, Number.NaN, ARTIFACT_MAX_BYTES + 1]) {
      await expect(sealer.seal({ ...input, chunkMaxBytes })).rejects.toThrow(
        'GRANT_BUDGET_OUT_OF_RANGE',
      );
    }
    expect(store.inner.storedKeys()).toEqual([]);
  });

  it('固化前已经 abort ⇒ OBJECT_UPLOAD_ABORTED，一个字节都不写', async () => {
    const store = new RecordingObjectStore();
    const sealer = new ArtifactSealer(store);
    const controller = new AbortController();
    controller.abort();
    await expect(
      sealer.seal(sealInput(payloadChunks(), { abortSignal: controller.signal })),
    ).rejects.toThrow('OBJECT_UPLOAD_ABORTED');
    expect(store.writes).toEqual([]);
  });

  it('重复固化被 ARTIFACT_ALREADY_SEALED 挡住，而不是静默覆盖', async () => {
    const store = new RecordingObjectStore();
    const sealer = new ArtifactSealer(store);
    const input = sealInput(payloadChunks());
    await sealer.seal(input);
    const writesAfterFirst = store.writes.length;

    await expect(sealer.seal(input)).rejects.toThrow('ARTIFACT_ALREADY_SEALED');
    // 第二次连一片都没重写：清单存在这一个事实就足以挡住整轮写入。
    expect(store.writes).toHaveLength(writesAfterFirst);
    expect(infraError('ARTIFACT_ALREADY_SEALED').publicCode).toBe('REVISION_CONFLICT');
  });

  it('读取侧核对：挖掉一片之后 verifySealed 立刻变红', async () => {
    const store = new InMemoryObjectStore({ now: () => new Date(0) });
    const sealer = new ArtifactSealer(store);
    const manifest = await sealer.seal(sealInput(payloadChunks()));

    const verified = await sealer.verifySealed(manifest.artifactHash);
    expect(verified.artifactHash).toBe(manifest.artifactHash);
    expect(verified.chunks).toHaveLength(3);

    // provider 的生命周期策略或一次误删前缀都可能挖掉一片；固化当时对不代表后来还在。
    const victim = manifest.chunks[1];
    if (victim === undefined) throw new Error('清单里应该有第 2 片');
    await store.deletePrefix(victim.ref);
    await expect(sealer.verifySealed(manifest.artifactHash)).rejects.toThrow(
      'ARTIFACT_CHUNK_MISSING',
    );
  });

  it('loadManifest 往返一致；未固化返回 null，与「清单坏了」可区分', async () => {
    const store = new InMemoryObjectStore({ now: () => new Date(0) });
    const sealer = new ArtifactSealer(store);
    const manifest = await sealer.seal(sealInput(payloadChunks()));

    expect(await sealer.loadManifest(manifest.artifactHash)).toEqual(manifest);
    await expect(sealer.loadManifest(HASH_A)).resolves.toBeNull();

    // 清单坏了不是「没固化」：重试会往一个可能还有用的前缀里写新分片，所以两种情况必须可区分。
    const brokenKey = manifestKey(brand<string, 'ArtifactDigest'>('d'.repeat(64)));
    const broken = encodeJson({ nope: true });
    await store.putImmutable({
      key: brokenKey,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(broken);
          controller.close();
        },
      }),
      declaredBytes: broken.byteLength,
      maxBytes: MANIFEST_MAX_BYTES,
      sha256: brand<string, 'ArtifactDigest'>(sha256Hex(broken)),
      contentType: MANIFEST_CONTENT_TYPE,
      abortSignal: idleAbortSignal(),
    });
    await expect(
      sealer.loadManifest(brand<string, 'ArtifactDigest'>('d'.repeat(64))),
    ).rejects.toThrow('ARTIFACT_MANIFEST_INVALID');
  });

  it('parseManifest 对每一种坏形状都拒绝，不猜一个能用的清单出来', () => {
    const good = {
      artifactHash: 'a'.repeat(64),
      totalBytes: 4,
      chunkCount: 1,
      chunks: [
        { ordinal: 0, ref: 'artifacts/x/chunks/0-abc', byteLength: 4, sha256: 'b'.repeat(64) },
      ],
      sealedAt: at(0),
    };
    // 正向对照先行：坏形状检测没有把好清单一起吃掉。
    expect(throwsCode(encodeJson(good))).toBeNull();
    expect(parseManifest(encodeJson(good))?.chunkCount).toBe(1);

    for (const bad of [
      encodeJson({ ...good, chunkCount: 2 }),
      encodeJson({ ...good, chunks: [] }),
      encodeJson({ ...good, chunks: [{ ...good.chunks[0], ordinal: 1 }] }),
      encodeJson({ ...good, artifactHash: 'nope' }),
      encodeJson({ ...good, sealedAt: 'not-a-timestamp' }),
      encodeJson({ ...good, totalBytes: 1.5 }),
      encodeJson({ ...good, chunks: 'nope' }),
      encodeJson([good]),
      encodeJson(null),
      encodeJson('x'),
      encodeJson({}),
    ]) {
      expect(throwsCode(bad)).toBe('ARTIFACT_MANIFEST_INVALID');
    }
    // 片长之和对不上声称的总长是**另一条**码：它说明清单自称的形状内部矛盾。
    expect(throwsCode(encodeJson({ ...good, totalBytes: 5 }))).toBe('ARTIFACT_TOTAL_MISMATCH');
    // 不是合法 UTF-8 / 不是 JSON 也算坏清单。
    expect(throwsCode(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe('ARTIFACT_MANIFEST_INVALID');
    expect(throwsCode(new TextEncoder().encode('not json'))).toBe('ARTIFACT_MANIFEST_INVALID');
  });

  it('joinChunks 按序拼接，空数组给出空结果', () => {
    const chunks = [bytes(3, 1), bytes(2, 2)];
    const joined = joinChunks(chunks);
    expect(joined.byteLength).toBe(5);
    expect(joined.slice(0, 3)).toEqual(chunks[0]);
    expect(joined.slice(3)).toEqual(chunks[1]);
    expect(joinChunks([]).byteLength).toBe(0);
  });

  it('固化 → 逐片读回 → 拼接 → sha256 等于 artifactHash（内存替身上的端到端一致性）', async () => {
    const store = new InMemoryObjectStore({ now: () => new Date(0) });
    const sealer = new ArtifactSealer(store, { chunkMaxBytes: 128 });
    const chunks = payloadChunks();
    const original = joinChunks(chunks);
    const manifest = await sealer.seal(sealInput(chunks));

    const loaded: ArtifactManifest | null = await sealer.loadManifest(manifest.artifactHash);
    if (loaded === null) throw new Error('清单应该读得回来');
    const readBack: Uint8Array[] = [];
    for (const chunk of loaded.chunks) {
      const stream = await store.getPrivate({
        ref: chunk.ref,
        maxBytes: MANIFEST_MAX_BYTES,
        abortSignal: idleAbortSignal(),
      });
      readBack.push(await collect(stream.body));
    }
    const rebuilt = joinChunks(readBack);
    expect(rebuilt.byteLength).toBe(original.byteLength);
    expect(sha256Of(rebuilt)).toBe(sha256Of(original));
    expect(String(sha256Of(rebuilt))).toBe(String(manifest.artifactHash));
    // 分片是按 ordinal 读回来的，顺序错一位摘要就会不同 —— 这条对照证明顺序真的被保住。
    const shuffled = joinChunks(
      [readBack[1], readBack[0], readBack[2]].filter(
        (chunk): chunk is Uint8Array => chunk !== undefined,
      ),
    );
    expect(sha256Of(shuffled)).not.toBe(sha256Of(original));
  });

  it('清单里的分片 ref 与摘要逐条可核（ArtifactDigest 类型不被绕过）', async () => {
    const sealer = new ArtifactSealer(new InMemoryObjectStore({ now: () => new Date(0) }));
    const chunks = payloadChunks();
    const manifest = await sealer.seal(sealInput(chunks));
    manifest.chunks.forEach((chunk, index) => {
      const source = chunks[index];
      if (source === undefined) throw new Error(`夹具里应该有第 ${index + 1} 片`);
      expect(chunk.byteLength).toBe(source.byteLength);
      expect(String(chunk.sha256)).toBe(sha256Hex(source));
      expect(String(chunk.ref)).toBe(
        chunkKey(manifest.artifactHash, index, chunk.sha256 as ArtifactDigest),
      );
    });
  });
});

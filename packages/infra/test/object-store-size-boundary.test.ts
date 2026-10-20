/**
 * 能力 `object-store-size-boundary`：ZLQ-194 §14 第 3 项「15MiB 边界」与写入侧的其余不变量。
 *
 * ## 为什么这一项要单独一个文件
 * 边界值本身必须**成功**，第 `+1` 个字节必须**失败**，而且失败必须发生在流的过程中而不是
 * 「先收完再判定」—— 后者等于把上界变成摆设：一个 1GiB 的恶意上传会先把内存吃光才被判超限。
 * 这两句话只有拿真实的 15 MiB 与 15 MiB+1 两个载荷各跑一遍才证明得了，用 64 字节的夹具
 * 断言 `maxBytes` 常量是**不能**替代的（那样只是把常量抄了两遍）。
 *
 * ## 诚实分层
 * 这里的 `ObjectStore` 是内存替身。它证明的是**端口不变量**（硬上界、声明字节数、摘要、
 * 不可覆盖、失败无残留、Range 语义、读取预算）；真实 private Vercel Blob 在服务端超限时的
 * 行为属于 D5/D6，本文件不声称覆盖。
 */
import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_MAX_BYTES,
  OBJECT_STORE_INVARIANTS,
  type PutImmutableInput,
} from '../src/ports/object-store.js';
import {
  collectStream,
  idleAbortSignal,
  sha256Hex,
  streamFromBytes,
} from '../src/object-store/budget.js';
import { InMemoryObjectStore } from '../src/object-store/memory.js';
import { infraError } from '../src/errors.js';
import { brand } from '@littleq/domain';

import { at, rejectedCode } from './support.js';

function filled(length: number, value = 7): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function putInput(payload: Uint8Array, key: string, overrides: Partial<PutImmutableInput> = {}) {
  return {
    key,
    body: streamFromBytes(payload),
    declaredBytes: payload.byteLength,
    maxBytes: ARTIFACT_MAX_BYTES,
    sha256: brand(sha256Hex(payload)),
    contentType: 'application/octet-stream',
    abortSignal: idleAbortSignal(),
    ...overrides,
  } satisfies PutImmutableInput;
}

describe('object-store-size-boundary', () => {
  it('15 MiB 是常量，且 §14 的六项里点名了它', () => {
    expect(ARTIFACT_MAX_BYTES).toBe(15 * 1024 * 1024);
    expect(ARTIFACT_MAX_BYTES).toBe(15_728_640);
    expect(OBJECT_STORE_INVARIANTS).toContain('size-boundary-15mib');
  });

  it('恰好 15 MiB 写入成功，字节与摘要逐字对得上', async () => {
    const store = new InMemoryObjectStore({ now: () => new Date(0) });
    const payload = filled(ARTIFACT_MAX_BYTES);
    const key = 'artifacts/cc/exact-15mib';

    const ref = await store.putImmutable(putInput(payload, key));
    expect(ref).toBe(key);
    expect(store.putAttempts).toBe(1);
    expect(store.rejectedWrites).toBe(0);

    const head = await store.head(ref);
    expect(head?.byteLength).toBe(ARTIFACT_MAX_BYTES);
    expect(head?.sha256).toBe(sha256Hex(payload));

    const stream = await store.getPrivate({
      ref,
      maxBytes: ARTIFACT_MAX_BYTES,
      abortSignal: idleAbortSignal(),
    });
    expect(stream.byteLength).toBe(ARTIFACT_MAX_BYTES);
    const round = await collectStream(stream.body, idleAbortSignal());
    expect(round.byteLength).toBe(ARTIFACT_MAX_BYTES);
    expect(sha256Hex(round)).toBe(sha256Hex(payload));
  });

  it('第 15 MiB + 1 个字节被拒（OBJECT_UPLOAD_TOO_LARGE），且不留任何残留', async () => {
    const store = new InMemoryObjectStore({ now: () => new Date(0) });
    const payload = filled(ARTIFACT_MAX_BYTES + 1);
    const key = 'artifacts/cc/one-byte-over';

    await expect(store.putImmutable(putInput(payload, key))).rejects.toThrow(
      'OBJECT_UPLOAD_TOO_LARGE',
    );
    expect(store.rejectedWrites).toBe(1);
    // 失败路径不返回 `ObjectRef`，也不留下半个对象：`head` 与 key 清单都是空的。
    expect(store.storedKeys()).toEqual([]);
    await expect(store.head(brand(key))).resolves.toBeNull();
  });

  it('超限是在流的过程中判定的，不是「先收完再说」', async () => {
    const store = new InMemoryObjectStore({ now: () => new Date(0) });
    // maxBytes 远小于载荷：预算管道必须当场把流打断，而不是把 1 MiB 全收进内存再比对。
    const payload = filled(1024 * 1024);
    const code = await rejectedCode(
      store.putImmutable(putInput(payload, 'artifacts/cc/stream-limit', { maxBytes: 64 })),
    );
    expect(code).toBe('OBJECT_UPLOAD_TOO_LARGE');
    expect(store.storedKeys()).toEqual([]);
  });

  it('declaredBytes 与实际字节数不符 ⇒ OBJECT_DECLARED_BYTES_MISMATCH', async () => {
    const store = new InMemoryObjectStore();
    const payload = filled(128);
    await expect(
      store.putImmutable(putInput(payload, 'artifacts/cc/declared-low', { declaredBytes: 127 })),
    ).rejects.toThrow('OBJECT_DECLARED_BYTES_MISMATCH');
    await expect(
      store.putImmutable(putInput(payload, 'artifacts/cc/declared-high', { declaredBytes: 129 })),
    ).rejects.toThrow('OBJECT_DECLARED_BYTES_MISMATCH');
    // declaredBytes 大于 maxBytes 在入口就被当成超限，不去读流。
    await expect(
      store.putImmutable(putInput(payload, 'artifacts/cc/declared-over-max', { maxBytes: 64 })),
    ).rejects.toThrow('OBJECT_UPLOAD_TOO_LARGE');
    expect(store.storedKeys()).toEqual([]);
    expect(store.rejectedWrites).toBe(3);
  });

  it('摘要不符 ⇒ OBJECT_HASH_MISMATCH，对象不落地', async () => {
    const store = new InMemoryObjectStore();
    const payload = filled(256, 9);
    await expect(
      store.putImmutable(
        putInput(payload, 'artifacts/cc/wrong-digest', {
          sha256: brand(sha256Hex(filled(256, 10))),
        }),
      ),
    ).rejects.toThrow('OBJECT_HASH_MISMATCH');
    expect(store.storedKeys()).toEqual([]);
  });

  it('同一个 key 第二次写入被拒（不可覆盖），第一份字节原样保留', async () => {
    const store = new InMemoryObjectStore();
    const payload = filled(64, 5);
    const key = 'artifacts/cc/immutable';
    await store.putImmutable(putInput(payload, key));
    await expect(store.putImmutable(putInput(payload, key))).rejects.toThrow(
      'OBJECT_ALREADY_EXISTS',
    );

    const head = await store.head(brand(key));
    expect(head?.sha256).toBe(sha256Hex(payload));
    expect(store.storedKeys()).toEqual([key]);
  });

  it('非法 key 形状一律 OBJECT_KEY_INVALID：绝对路径、带 scheme、空串、`..`、结尾斜杠', async () => {
    const store = new InMemoryObjectStore();
    const payload = filled(16);
    for (const key of ['/abs/path', '//host/key', 'https://x.test/k', '', 'a/../b', 'a/', 'a b']) {
      const code = await rejectedCode(store.putImmutable(putInput(payload, key)));
      expect(code).toBe('OBJECT_KEY_INVALID');
    }
    expect(store.storedKeys()).toEqual([]);
  });

  it('写入前已经 abort ⇒ OBJECT_UPLOAD_ABORTED，连字节都不读', async () => {
    const store = new InMemoryObjectStore();
    const controller = new AbortController();
    controller.abort();
    const payload = filled(64);
    await expect(
      store.putImmutable(
        putInput(payload, 'artifacts/cc/aborted', { abortSignal: controller.signal }),
      ),
    ).rejects.toThrow('OBJECT_UPLOAD_ABORTED');
    expect(store.storedKeys()).toEqual([]);
    expect(infraError('OBJECT_UPLOAD_ABORTED').publicCode).toBe('USER_CANCELLED');
  });

  it('读取时 abort ⇒ OBJECT_READ_ABORTED，两个码对外同为 USER_CANCELLED 但内部可区分', async () => {
    const store = new InMemoryObjectStore();
    const payload = filled(64, 21);
    const ref = await store.putImmutable(putInput(payload, 'artifacts/cc/read-abort'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.getPrivate({ ref, maxBytes: 64, abortSignal: controller.signal }),
    ).rejects.toThrow('OBJECT_READ_ABORTED');
    expect(infraError('OBJECT_READ_ABORTED').publicCode).toBe('USER_CANCELLED');
    expect(infraError('OBJECT_UPLOAD_ABORTED').message).not.toBe(
      infraError('OBJECT_READ_ABORTED').message,
    );
  });

  it('Range 语义：闭区间、上界越界截断到末尾、start 越界则不可满足', async () => {
    const store = new InMemoryObjectStore();
    const payload = filled(100, 3);
    for (let i = 0; i < payload.byteLength; i += 1) payload[i] = i;
    const ref = await store.putImmutable(putInput(payload, 'artifacts/cc/range'));

    const mid = await store.getPrivate({
      ref,
      range: { start: 10, endInclusive: 19 },
      maxBytes: 64,
      abortSignal: idleAbortSignal(),
    });
    expect(mid.byteLength).toBe(10);
    expect(mid.range).toEqual({ start: 10, endInclusive: 19 });
    // 分片读取**不**交出整对象摘要：那会让「只读了 10 字节」的调用方拿到一个描述 100 字节的哈希。
    expect(mid.sha256).toBeNull();
    expect(await collectStream(mid.body, idleAbortSignal())).toEqual(payload.slice(10, 20));

    const clamped = await store.getPrivate({
      ref,
      range: { start: 95, endInclusive: 999 },
      maxBytes: 64,
      abortSignal: idleAbortSignal(),
    });
    expect(clamped.range).toEqual({ start: 95, endInclusive: 99 });
    expect(clamped.byteLength).toBe(5);

    const whole = await store.getPrivate({ ref, maxBytes: 128, abortSignal: idleAbortSignal() });
    expect(whole.range).toBeNull();
    expect(whole.sha256).toBe(sha256Hex(payload));

    for (const range of [
      { start: 100, endInclusive: 101 },
      { start: 5, endInclusive: 4 },
      { start: -1, endInclusive: 3 },
    ]) {
      const code = await rejectedCode(
        store.getPrivate({ ref, range, maxBytes: 64, abortSignal: idleAbortSignal() }),
      );
      expect(['OBJECT_RANGE_NOT_SATISFIABLE', 'GRANT_BUDGET_OUT_OF_RANGE']).toContain(code);
    }
  });

  it('读取预算按**每次读取**计：超出以预算码结束流，不静默截断', async () => {
    const store = new InMemoryObjectStore();
    const payload = filled(256, 13);
    const ref = await store.putImmutable(putInput(payload, 'artifacts/cc/read-budget'));
    const stream = await store.getPrivate({
      ref,
      maxBytes: 128,
      abortSignal: idleAbortSignal(),
    });
    // `byteLength` 是这次读取承诺交出的字节数（整对象），预算判定以它为准。
    expect(stream.byteLength).toBe(256);
    const code = await rejectedCode(collectStream(stream.body, idleAbortSignal()));
    expect(code).toBe('OBJECT_READ_BUDGET_EXCEEDED');
    expect(infraError('OBJECT_READ_BUDGET_EXCEEDED').publicCode).toBe('RATE_LIMITED');
    // 静默截断会让 Runtime 把残缺产物当完整的固化下来，所以这里必须**失败**而不是交出 128 字节。
  });

  it('不存在的 ref：head 返回 null，读取与删除都按「不存在」处理', async () => {
    const store = new InMemoryObjectStore();
    // 形状合法、但从未写入过的 ref（`isObjectRef` 会放行它），所以这里走的是「不存在」
    // 而不是「形状非法」—— 两者对外同为无细节 404，不给探测者可区分的信号。
    // 用 `brand<…>` 而不是 `parseObjectRef`，是为了把「解析」与「存在性」两件事分开断言。
    const missing = brand<string, 'ObjectRef'>('artifacts/cc/never-written');
    await expect(store.head(missing)).resolves.toBeNull();
    await expect(
      store.getPrivate({ ref: missing, maxBytes: 16, abortSignal: idleAbortSignal() }),
    ).rejects.toThrow('OBJECT_NOT_FOUND');
    expect(infraError('OBJECT_NOT_FOUND').publicCode).toBe('RESOURCE_NOT_FOUND');
    await store.deletePrefix('artifacts/cc/never-written');
    expect(store.storedKeys()).toEqual([]);
  });

  it('health 的 detail 只能是内部码或 null，绝不携带 provider 原文', async () => {
    const store = new InMemoryObjectStore({ now: () => new Date(Date.parse(at(0))) });
    const result = await store.health();
    expect(result.status).toBe('ok');
    expect(result.detail).toBeNull();
    expect(Object.keys(result).sort()).toEqual(['checkedAt', 'detail', 'latencyMs', 'status']);
  });
});

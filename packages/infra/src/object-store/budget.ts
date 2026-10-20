/**
 * 字节预算与摘要的流式原语。
 *
 * 上传与下载都要回答同一个问题：「实际流过的字节数是不是等于声称的那个数、有没有超过上界、
 * 摘要对不对」。把这件事做成一个透传管道而不是两次遍历，是因为 §14 的 15MiB 边界要求
 * **第 `maxBytes+1` 个字节当场中止流**，而不是先收完再判定 —— 先收完就等于把上界变成了摆设，
 * 一个 1GiB 的恶意上传会先把内存吃光才被判超限。
 *
 * 超限一律以 `controller.error(...)` 结束流，**不做静默截断**：截断会让下游把一个残缺产物
 * 当成完整的固化下来，那比一次显式失败难查得多。
 */
import { createHash } from 'node:crypto';

import { infraError, type InfraErrorCode } from '../errors.js';

/** 超限的错误码：上传侧与读取侧不同，因为对外映射不同（400 vs 429）。 */
export type BudgetErrorCode = 'OBJECT_UPLOAD_TOO_LARGE' | 'OBJECT_READ_BUDGET_EXCEEDED';

export interface ByteAccounting {
  /** 到目前为止**通过**管道的字节数（超限那一批不计入）。 */
  bytes(): number;
  /** 是否已经因为超限把流打断了。 */
  exceeded(): boolean;
  /** 通过管道那部分字节的 sha256（小写十六进制）。 */
  digestHex(): string;
}

export interface BudgetTransform {
  readonly transform: TransformStream<Uint8Array, Uint8Array>;
  readonly accounting: ByteAccounting;
}

/**
 * 计数 + 摘要 + 硬上界的透传管道。
 *
 * 做成 `TransformStream` 而不是「一对 readable/writable」，是为了让调用方能写成
 * `collectStream(source.pipeThrough(t))`：背压、错误传播、取消都交给标准管道语义，
 * 不需要在业务代码里手工对齐两侧的 await 顺序（那正是这类代码最容易静默挂住的地方）。
 */
export function createBudgetTransform(
  maxBytes: number,
  code: BudgetErrorCode,
  onDelivered?: (byteLength: number) => void,
): BudgetTransform {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw infraError(code);
  let bytes = 0;
  let exceeded = false;
  const hash = createHash('sha256');
  // node 的 `Hash.digest()` 只能调一次，第二次抛 `Digest already called`。调用方很自然会
  // 把摘要读两遍（先比对、再存起来），所以在这里做记忆化，而不是把这条陷阱外推给每个调用点。
  let digest: string | null = null;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const size = chunk.byteLength;
      if (bytes + size > maxBytes) {
        exceeded = true;
        controller.error(infraError(code));
        return;
      }
      bytes += size;
      hash.update(chunk);
      controller.enqueue(chunk);
      if (onDelivered) onDelivered(size);
    },
  });
  return {
    transform,
    accounting: {
      bytes: () => bytes,
      exceeded: () => exceeded,
      digestHex: () => {
        if (digest === null) digest = hash.digest('hex');
        return digest;
      },
    },
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * 已中止的信号必须在读第一个字节之前就抛，否则「取消」对上游是不可见的。
 *
 * 错误码由调用方给：上传被取消是 `OBJECT_UPLOAD_ABORTED`，读取被取消是 `OBJECT_READ_ABORTED`。
 * 两者对外都映射成 `USER_CANCELLED`，但内部要能区分「哪一侧被取消了」，否则一次撤销在日志里
 * 看起来像一次上传失败。
 */
export function throwIfAborted(
  abortSignal: AbortSignal,
  code: InfraErrorCode = 'OBJECT_UPLOAD_ABORTED',
): void {
  if (abortSignal.aborted) throw infraError(code);
}

/**
 * 一个永不中止的信号，给内部读取（例如把固化清单读回来解析）用。
 *
 * 之所以不复用一个模块级常量：`AbortSignal` 一旦被 `AbortController` 持有就可被外部中止，
 * 共享实例会让「某处取消」莫名其妙地打断另一处的内部读取。每次新建一个控制器，代价是
 * 一个对象，换来的是取消语义不会被跨模块串味。
 */
export function idleAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  abortSignal: AbortSignal,
  abortCode: InfraErrorCode = 'OBJECT_UPLOAD_ABORTED',
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(abortSignal, abortCode);
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks, total);
}

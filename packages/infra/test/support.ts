/**
 * 测试夹具。与 `packages/domain/test/support.ts` 同形：**每个值都是硬字面量或由入参确定性
 * 推导**，没有一个来自宿主状态 —— 不读时钟、不读环境变量、不读 locale、不读文件系统。
 * 一条依赖宿主状态的用例在 CI 与本机会给出不同判定，而那种分歧不会报错，只会让门禁
 * 在某一台机器上悄悄失去意义。
 *
 * 两层各自声明、互不 import：不为一份夹具背一条跨单元依赖边（`config/dependency-graph.json`
 * 里 infra → domain 只有 `src` 的运行时依赖是受控边，测试夹具不该扩大它）。
 *
 * ## 关于根密钥
 * `TEST_MASTER_KEY_HEX` **不是一个凭据**，它由下面那句明写的非机密短语 sha256 派生，任何人
 * 都能重算，所以把它写进源码不泄露任何东西。真实根密钥只从环境变量 `LITTLEQ_MASTER_KEY`
 * 读取，它的**值**绝不落盘、绝不进日志、绝不进测试快照 —— 本文件里出现的只有那个变量名。
 */
import { createHash } from 'node:crypto';

import {
  type AiTask,
  type ArtifactDigest,
  type Revision,
  type Timestamp,
  brand,
  createAiTask,
  parseRevision,
} from '@littleq/domain';

import { type InfraErrorCode, isInfraError } from '../src/errors.js';
import { type LogRecord, type LogSink } from '../src/log/redaction.js';
import type { GetPrivateInput, ObjectStore } from '../src/ports/object-store.js';
import {
  type HealthResult,
  type ObjectRef,
  type StoredObjectMetadata,
  type StoredObjectStream,
  parseObjectRef,
} from '../src/types.js';

export const EPOCH = '2026-03-01T00:00:00.000Z';

/** EPOCH 之后 `seconds` 秒的 RFC3339 串（确定性算术，不读系统时钟）。 */
export function atSeconds(seconds: number): string {
  return new Date(Date.parse(EPOCH) + seconds * 1000).toISOString();
}

export function at(seconds: number): Timestamp {
  return brand<string, 'Timestamp'>(atSeconds(seconds));
}

export function uuidAt(index: number): string {
  // UUID v7 的形状由 domain 的 `UUID_V7_PATTERN` 钉死：第 3 组以 `7` 开头、第 4 组以 `[89ab]` 开头。
  return `0190f3a4-b5c6-7d7e-8f90-${index.toString(16).padStart(12, '0')}`;
}

export function revisionAt(value: number): Revision {
  return parseRevision(String(value));
}

/**
 * 一个合法的 `ArtifactDigest`。**刻意不用于**任何「摘要是否匹配」的断言 —— 那些断言必须用
 * `sha256Of` 真算一遍，否则测试就是在拿实现的输出验实现。
 */
export function digestAt(index: number): ArtifactDigest {
  return brand<string, 'ArtifactDigest'>(index.toString(16).padStart(64, '0'));
}

/**
 * 确定性字节。LCG 而不是 `randomBytes`：同一次调用在任何宿主上给出**逐字节相同**的结果，
 * 于是「Range 切片取到的是哪几字节」这类断言可以写死期望值。
 */
export function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}

/**
 * 内容摘要。**直接用 `node:crypto` 算**，不走 `src/object-store/budget.ts` 的 `sha256Hex`：
 * 用被测代码自己的摘要函数去验证被测代码，等于让实现给自己打分。
 */
export function sha256Of(value: Uint8Array): ArtifactDigest {
  return brand<string, 'ArtifactDigest'>(createHash('sha256').update(value).digest('hex'));
}

const TEST_MASTER_KEY_PHRASE = 'littleq-infra-test-master-key-not-a-credential';

/** 64 位小写十六进制，正好落在 `MASTER_KEY_HEX_PATTERN` 上；全零（会被拒绝）也不是它。 */
export const TEST_MASTER_KEY_HEX = createHash('sha256')
  .update(TEST_MASTER_KEY_PHRASE)
  .digest('hex');

export interface TaskFixture {
  readonly id?: string;
  readonly kind?: string;
  readonly projectId?: string;
  readonly requestedBy?: string;
  readonly state?: string;
  readonly stage?: string | null;
  readonly nextRunAt?: string | null;
  readonly createdAt?: string;
  readonly maxAttempts?: number;
  readonly revision?: string;
}

export function makeTask(fixture: TaskFixture = {}): AiTask {
  return createAiTask({
    id: uuidAt(1),
    kind: 'VIBE_TURN',
    projectId: uuidAt(2),
    requestedBy: uuidAt(3),
    maxAttempts: 3,
    createdAt: EPOCH,
    ...fixture,
  });
}

/** 把字节切成 `chunkSize` 一片的流。分片是为了让预算/账本的**边界**真的被跨过去。 */
export function streamFrom(value: Uint8Array, chunkSize = 64): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= value.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, value.byteLength);
      controller.enqueue(value.subarray(offset, end));
      offset = end;
    },
  });
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * 读完整条流，返回它**结束时携带的内部错误码**；正常读完返回 `null`。
 *
 * 流上的失败不是 `throw` 出来的（它在 `await` 之外），所以每个「越界即打断」的不变量都要
 * 靠这个帮手才断言得到。非 `InfraError` 一律原样抛出：那是测试自己的 bug，不该被吞成一个码。
 */
export async function readFailureCode(
  stream: ReadableStream<Uint8Array>,
): Promise<InfraErrorCode | null> {
  try {
    await collect(stream);
    return null;
  } catch (error) {
    if (!isInfraError(error)) throw error;
    return error.code;
  }
}

/** 断言一个 promise 被拒，并取出它的内部错误码。它成功 ⇒ 测试失败（不是返回 null）。 */
export async function rejectedCode(promise: Promise<unknown>): Promise<InfraErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (!isInfraError(error)) throw error;
    return error.code;
  }
  throw new Error('期望这次调用被拒绝，但它成功了');
}

/**
 * 挂在**真实**写入路径上的 sink。
 *
 * `serialized()` 是重点：日志最终是被序列化后落盘的，所以「provider URL 与 token 不出现在
 * 日志里」必须在序列化形态上断言，而不是在内存对象的某个字段上断言 —— 后者会被一个
 * 「字段名改了但值还在」的实现骗过去。
 */
export class SpySink implements LogSink {
  readonly #records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.#records.push(record);
  }

  get records(): readonly LogRecord[] {
    return [...this.#records];
  }

  get count(): number {
    return this.#records.length;
  }

  serialized(): string {
    return JSON.stringify(this.#records);
  }
}

/**
 * 剥离注释。**保留字符串与模板串的内容**（能力名通常就写在 `it('...')` 的标题里），
 * 只把行注释与块注释的内容丢掉。
 *
 * 为什么测试要自己剥一遍：`src/ports/runtime-publisher.ts` 的头注释里**逐字写着** `slug`
 * 这个词（它在解释「slug 分配现在不存在」）。不剥注释，「那三个名字的命中数为 0」这条
 * 断言就会红在一个纯说明性的句子上；而剥过头（把字符串也吃掉）又会让它绿在一个什么都没
 * 扫的字符串上 —— 所以每个用到它的用例都带一条正向对照。
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (char === '/' && next === '/') {
      while (i < source.length && (source[i] ?? '') !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !((source[i] ?? '') === '*' && (source[i + 1] ?? '') === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += char;
      i += 1;
      while (i < source.length && (source[i] ?? '') !== quote) {
        if ((source[i] ?? '') === '\\') {
          out += (source[i] ?? '') + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if ((source[i] ?? '') === '\n' && quote !== '`') break;
        out += source[i] ?? '';
        i += 1;
      }
      if (i < source.length) {
        out += source[i] ?? '';
        i += 1;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** 一个词在（已剥注释的）源码里的命中次数。用 `split` 而不是正则，避免转义问题。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

/**
 * 逐块交出字节的 `ObjectStore` 替身。
 *
 * `InMemoryObjectStore` 一次只吐一个 chunk，于是「读到一半被撤销 / 读到一半过期」这两种
 * 情形在它上面**根本构造不出来** —— 第一个 chunk 就是最后一个。这两个恰好是裁定要求可红
 * 可绿的不变量，所以需要一个能控制块大小的替身。它只实现 `getPrivate`，其余方法抛出来：
 * 一个替身悄悄把不该被调用的方法实现成 no-op，等于把「测试没走到那条路」伪装成「走到了」。
 */
export class ChunkedObjectStore implements ObjectStore {
  readonly #ref: ObjectRef;
  readonly #payload: Uint8Array;
  readonly #chunkSize: number;
  #reads = 0;

  constructor(key: string, payload: Uint8Array, chunkSize: number) {
    this.#ref = parseObjectRef(key);
    this.#payload = payload;
    this.#chunkSize = chunkSize;
  }

  /** `getPrivate` 被调用了几次；用来证明「拒绝发生在 open 阶段」而不是「读了一半才发现」。 */
  get readCount(): number {
    return this.#reads;
  }

  async putImmutable(): Promise<ObjectRef> {
    throw new Error('ChunkedObjectStore 不支持写入');
  }

  async getPrivate(input: GetPrivateInput): Promise<StoredObjectStream> {
    this.#reads += 1;
    if (input.ref !== this.#ref) throw new Error(`ChunkedObjectStore 只认 ${this.#ref}`);
    return {
      ref: this.#ref,
      byteLength: this.#payload.byteLength,
      contentType: 'application/octet-stream',
      sha256: sha256Of(this.#payload),
      range: null,
      body: streamFrom(this.#payload, this.#chunkSize),
      deliveredBytes: () => this.#payload.byteLength,
    };
  }

  async head(): Promise<StoredObjectMetadata | null> {
    throw new Error('ChunkedObjectStore 不支持 head');
  }

  async deletePrefix(): Promise<void> {
    throw new Error('ChunkedObjectStore 不支持 deletePrefix');
  }

  async health(): Promise<HealthResult> {
    throw new Error('ChunkedObjectStore 不支持 health');
  }
}

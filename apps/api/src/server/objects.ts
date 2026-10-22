/**
 * 进程内对象存储：`TaskInputStore` 与 `WorkArtifactStore` 的实现。
 *
 * ## 为什么不复用 infra 的 `InMemoryObjectStore`
 *
 * infra 那个替身实现的是 infra 自己的 `ObjectStore` 端口：`putImmutable` 收
 * `ReadableStream` + `declaredBytes` + `maxBytes` + 已算好的 `sha256`，返回 branded
 * `ObjectRef`。而 application 的这两个端口更窄、形状也不同（`put` 收 `Uint8Array`，
 * 摘要由**存储方**算，`openScanSource` 要交回 work-contract 的 `ScanFileSource`）。
 * 在两者之间写一层适配器，代价是把"谁算摘要"这个安全问题从存储方挪到调用方 ——
 * 而调用方算出的摘要正是 §5.2 `INPUT_HASH_MISMATCH` 要对照的那个值，让它自己算等于
 * 让被检查的一方提供检查基准。所以这里直接实现 application 的端口，摘要在写入点实测。
 *
 * ## 进程内，不是 Vercel Blob —— 这是**已申报的取舍**
 *
 * 本单的文件面是 `apps/api/**`，接 Vercel Blob 要动 `drivers/vercel-blob.ts` 与部署环境
 * 变量，两者都在面外。进程内 `Map` 的后果必须说清楚：
 *
 * - **冷实例丢产物。** 无状态横向扩容下，A 实例写的产物 B 实例读不到，`openScanSource`
 *   会 `RESOURCE_NOT_FOUND`。本切片是单实例、单进程验收，所以这条路走得通；上生产前
 *   必须换成 Blob，这是 F3/运维的事。
 * - **prompt 全文因此只在内存里。** 这反而**加强**了 §5「prompt 不进 task_private、
 *   不进日志」：它连库都没进。代价是重启即失，而 `task_private.input_ref` 里留着指向
 *   它的引用 —— 一个悬空引用。诚实的说法是"本切片的输入存储不持久"，不是"已实现"。
 *
 * ## 同 key 第二次写必须失败
 *
 * 端口注释逐字：「写一个不可覆盖的对象；同 key 第二次写必须失败，不返回引用」。
 * pump 的 key 由 `(taskId, attempt, ordinal)` 派生，正是为了让重入时同一个 ordinal
 * 不会被写第二次。静默覆盖会让"重放同一个 externalOperationKey 不产生第二次计费动作"
 * 这条负对照失去意义：覆盖看不出重放，失败才看得出。
 */
import { createHash } from 'node:crypto';

import { DomainError, parseArtifactDigest } from '@littleq/domain';
import type { TaskId } from '@littleq/domain';
import type { TaskInputStore, WorkArtifactStore } from '@littleq/application';
import type { FileRange, FileRef, ScanFileSource } from '@littleq/work-contract';

/**
 * 包络内两个文件的路径。与 `pump.ts` 的 `ENVELOPE_HTML_PATH` / `ENVELOPE_MANIFEST_PATH`
 * 同源 —— `@littleq/application` 的 barrel `export * from './usecases/pump.js'`，
 * 所以这里**直接引用常量**而不是抄一份字面量（抄一份就有了第二个事实源）。
 */
import { ENVELOPE_HTML_PATH, ENVELOPE_MANIFEST_PATH } from '@littleq/application';
import { infraError } from '@littleq/infra';

type StoredObject = {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly contentType: string;
};

/** `objectRef` 就是 key 本身。理由见 `InProcessObjectStore` 的 `put`。 */
export type ObjectRefText = string;

export class InProcessObjectStore {
  readonly #objects = new Map<string, StoredObject>();

  /** 已写入的对象数。测试用它证明"真的写了"，不是靠 `put` 没抛就算。 */
  get size(): number {
    return this.#objects.size;
  }

  /** 全部 key（升序）。测试用它证明产物清单，不靠日志。 */
  keys(): readonly string[] {
    return [...this.#objects.keys()].sort();
  }

  /**
   * 写一个不可覆盖的对象，返回 key（即 `objectRef`）、**实测** sha256 与字节数。
   *
   * `objectRef` 取 key 原值而不是另发一个不透明串：`openScanSource` 要从一个 chunk 的
   * 引用推出同一次尝试的包络引用，靠的就是 key 的确定性文法
   * （`turns/{taskId}/attempt/{attempt}/{chunk|envelope}/…`，见 `pump.ts` 的
   * `chunkKey` / `envelopeKey`）。另发一个随机 ref 就得再维护一张 ref → key 的映射，
   * 而那张映射本身也要持久化才有意义 —— 进程内存储里它是多余的间接层。
   *
   * ⚠️ 因此 `objectRef` **不是** infra `ObjectRef` 那个 branded 类型：那个类型的文法
   * 不含 `:`，也不承诺可反解。这里刻意不做品牌提升，避免让人以为它俩是同一个东西。
   */
  put(input: { readonly key: string; readonly body: Uint8Array; readonly contentType: string }): {
    readonly objectRef: ObjectRefText;
    readonly sha256: string;
    readonly byteLength: number;
  } {
    if (input.key === '') throw DomainError.invalid('ObjectKey');
    if (this.#objects.has(input.key)) {
      // 不可覆盖：第二次写是重放信号，不是"再存一遍"。
      // 用 infra 的 `OBJECT_ALREADY_EXISTS`（`packages/infra/src/object-store/memory.ts` 同一个
      // 判定、同一个错误），它在 `packages/infra/src/errors.ts` 映射到公开码 `REVISION_CONFLICT`
      // ⇒ HTTP 409。domain 的错误目录里**没有** `CONFLICT_ALREADY_EXISTS`，自己编一个码等于
      // 在契约外新增一条 wire 语义，§8 禁止。
      throw infraError('OBJECT_ALREADY_EXISTS');
    }
    // 复制一份：调用方手里的 `Uint8Array` 可能是一个更大 buffer 的视图，直接留引用
    // 会让"已固化的产物"随调用方后续写入而变。
    const bytes = new Uint8Array(input.body);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.#objects.set(input.key, { key: input.key, bytes, sha256, contentType: input.contentType });
    return { objectRef: input.key, sha256, byteLength: bytes.byteLength };
  }

  /** 取字节。不存在 ⇒ `RESOURCE_NOT_FOUND`（不是 `null`：端口签名不给"没有"这条路）。 */
  read(objectRef: ObjectRefText): Uint8Array {
    const stored = this.#objects.get(objectRef);
    if (stored === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 'Artifact');
    return new Uint8Array(stored.bytes);
  }

  has(objectRef: ObjectRefText): boolean {
    return this.#objects.has(objectRef);
  }

  /** 同一个 `turns/{taskId}/attempt/{n}/` 前缀下的全部对象，按 key 升序。 */
  listByPrefix(prefix: string): readonly StoredObject[] {
    const matched: StoredObject[] = [];
    for (const stored of this.#objects.values()) {
      if (stored.key.startsWith(prefix)) matched.push(stored);
    }
    return matched.sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
  }
}

/** prompt 全文的对象 key。与 chunk/envelope 同属 `turns/{taskId}/…` 命名空间。 */
export function taskInputKey(taskId: TaskId): string {
  return `turns/${taskId}/input`;
}

export function createTaskInputStore(store: InProcessObjectStore): TaskInputStore {
  return {
    // `now` 是端口签名的一部分（这一层的每个方法都收 `now`），进程内存储不用它：
    // 对象没有 TTL，过期属于 grant 层。不解构它，就不会有一个"看起来用了其实没用"的参数。
    async put(input) {
      const written = store.put({
        key: taskInputKey(input.taskId),
        body: input.body,
        contentType: 'text/plain; charset=utf-8',
      });
      return written;
    },
    async get(objectRef) {
      return store.read(objectRef);
    },
  };
}

/**
 * `envelope/` 前缀：从一个 chunk 引用推出同一次尝试的包络目录。
 *
 * `sealedPaths[0]` 是 `turns/{taskId}/attempt/{n}/chunk/000001`，而扫描要的是同一次
 * 尝试的 `envelope/index.html` + `envelope/work.json`。两者共享
 * `turns/{taskId}/attempt/{n}/` 这一段，所以截到最后一个 `/chunk/` 之前即可。
 * 推不出来（引用不是 chunk 形状）⇒ 返回 `null`，由调用方决定怎么失败。
 */
export function envelopePrefixOf(objectRef: ObjectRefText): string | null {
  const marker = '/chunk/';
  const at = objectRef.lastIndexOf(marker);
  if (at <= 0) return null;
  return `${objectRef.slice(0, at)}/envelope/`;
}

/** 包络里两个文件的 `FileRef.role`：入口是运行时，清单是源。 */
function roleOf(path: string): FileRef['role'] {
  return path === ENVELOPE_HTML_PATH ? 'RUNTIME' : 'SOURCE';
}

function toFileRef(stored: StoredObject, path: string): FileRef {
  return {
    path,
    role: roleOf(path),
    bytes: stored.bytes.byteLength,
    sha256: stored.sha256,
    mediaType: stored.contentType,
    objectRef: stored.key,
  };
}

function byteStream(bytes: Uint8Array, range?: FileRange): ReadableStream<Uint8Array> {
  const slice =
    range === undefined ? bytes : bytes.subarray(range.offset, range.offset + range.length);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(slice));
      controller.close();
    },
  });
}

export function createWorkArtifactStore(store: InProcessObjectStore): WorkArtifactStore {
  return {
    async put(input) {
      // `abortSignal` 在这里没有可中止的 IO（内存写入是同步的），但**必须检查**它：
      // 调用方给的信号可能在到达本行之前就已经超时，此时继续写就是在预算外干活。
      if (input.abortSignal.aborted) throw new DomainError('TASK_TIMEOUT', 'Artifact.put');
      const written = store.put({
        key: input.key,
        body: input.body,
        contentType: input.contentType,
      });
      return {
        objectRef: written.objectRef,
        sha256: parseArtifactDigest(written.sha256),
        byteLength: written.byteLength,
      };
    },

    async openScanSource(objectRef) {
      const prefix = envelopePrefixOf(objectRef);
      // 引用不是 chunk 形状 ⇒ 它没有指向任何我们能解析的东西，这是"不存在"。
      if (prefix === null) throw new DomainError('RESOURCE_NOT_FOUND', 'Artifact');
      const html = store.listByPrefix(`${prefix}${ENVELOPE_HTML_PATH}`)[0];
      const manifest = store.listByPrefix(`${prefix}${ENVELOPE_MANIFEST_PATH}`)[0];
      // 两个文件缺一个就不是一个可扫的包。**不**退化成"只扫有的那个"：
      // 少了 `work.json` 的扫描会因为没有清单而空洞地通过，正是 §11 说的假 PASS。
      // 这里用 `ARTIFACT_INCOMPLETE`（502、不可重试）而不是 `RESOURCE_NOT_FOUND`：
      // 包络写了一半是**存储侧**的故障，不是客户端请求了一个不存在的东西；同一个请求
      // 重试也修不好它。两个码在目录里都已存在，不新增 wire 语义。
      if (html === undefined || manifest === undefined) {
        throw new DomainError('ARTIFACT_INCOMPLETE', 'Artifact.envelope');
      }
      const entries: readonly [StoredObject, string][] = [
        [html, ENVELOPE_HTML_PATH],
        [manifest, ENVELOPE_MANIFEST_PATH],
      ];
      const source: ScanFileSource = {
        list() {
          return entries.map(([stored, path]) => toFileRef(stored, path));
        },
        async open(path, range) {
          const found = entries.find(([, entryPath]) => entryPath === path);
          if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 'Artifact');
          return byteStream(found[0].bytes, range);
        },
      };
      return source;
    },

    async read(objectRef) {
      return store.read(objectRef);
    },
  };
}

/**
 * 组合根的一次性构造：一个存储，两个端口视图。
 *
 * 两个视图共享同一个 `Map`，所以 SEALING 写下的包络与 `openScanSource` 读到的包络
 * 必然同源 —— 分成两个实例就会出现"写进 A、从 B 读"的空扫描。
 */
export function createObjectStores(): {
  readonly store: InProcessObjectStore;
  readonly inputs: TaskInputStore;
  readonly artifacts: WorkArtifactStore;
} {
  const store = new InProcessObjectStore();
  return { store, inputs: createTaskInputStore(store), artifacts: createWorkArtifactStore(store) };
}

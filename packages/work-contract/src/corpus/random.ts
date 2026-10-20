/**
 * 语料生成器的确定性随机源（ZLQ-156 §2.1「本地确定性模板生成与人工变体，**固定 seeds**」）。
 *
 * 为什么不用 `Math.random()`：语料样例要进 pin 版报告，报告里的 `packageHash` 必须能被人
 * 重跑复算。`Math.random()` 每跑一次都不一样 ⇒ hash 每次都不一样 ⇒ 「pin」是假的。
 * 所以种子只从**两个稳定字符串**派生：`corpusVersion` 与 `caseId`。
 * 同一份语料版本 + 同一个 caseId，任何机器上跑出来的字节都相同。
 *
 * 算法选 mulberry32 而不是引入一个随机库：§9 的零新依赖是硬约束，而这里需要的只是
 * 「可复现的均匀整数」，不是密码学强度 —— 语料不是密钥，可预测恰恰是它的验收条件。
 */

/**
 * FNV-1a 32 位。用它把字符串折成种子。
 * 选它是因为实现只有四行、无状态、跨平台位运算结果完全一致（`Math.imul` 保证 32 位环绕）。
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  // 中文码位 >0xFF 会让上面的按字节折叠丢掉高位；再混一次整码位，避免「不同汉字同一种子」。
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
  }
  return hash >>> 0;
}

/** mulberry32：32 位状态的均匀 PRNG。返回 `[0,1)`。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成器能取到的随机操作。全部由同一个种子流驱动，因此整体可复现。 */
export type Random = {
  /** `[0, bound)` 的整数。`bound <= 0` 一律返回 0，避免调用方写出 `Math.floor(x/-1)` 这类陷阱。 */
  readonly int: (bound: number) => number;
  /** `[min, max]` 闭区间整数。 */
  readonly between: (min: number, max: number) => number;
  /** 从非空数组里取一个元素。空数组抛错：静默返回 `undefined` 会把「模板表写空了」藏成运行期怪症。 */
  readonly pick: <T>(items: readonly T[]) => T;
  /** 取 `count` 个不重复元素（`count > items.length` 时返回全部，顺序打乱）。 */
  readonly sample: <T>(items: readonly T[], count: number) => readonly T[];
  /** 以 `probability` 为真率返回布尔值。 */
  readonly chance: (probability: number) => boolean;
  /** 原始 `[0,1)`。模板里的连续量（坐标、时长）用它。 */
  readonly next: () => number;
};

/**
 * 为单个样例建随机源。
 *
 * `salt` 用来在**同一个 caseId 内部**开多条互不相关的随机流（例如「选控制流形状」与
 * 「选素材布局」各自独立），这样改一处模板不会把另一处的取值也带着变 —— 单点变异
 * 的可归因性要求生成器本身也尽量单点。
 */
export function createRandom(corpusVersion: string, caseId: string, salt = ''): Random {
  const seed = fnv1a32(`${corpusVersion}\u0000${caseId}\u0000${salt}`);
  const next = mulberry32(seed);
  return {
    int(bound: number): number {
      if (!Number.isFinite(bound) || bound <= 0) return 0;
      return Math.min(Math.floor(next() * bound), bound - 1);
    },
    between(min: number, max: number): number {
      if (max <= min) return min;
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error(`createRandom.pick 收到空数组（salt=${salt}）`);
      const chosen = items[Math.floor(next() * items.length) % items.length];
      if (chosen === undefined) throw new Error(`createRandom.pick 越界（salt=${salt}）`);
      return chosen;
    },
    sample<T>(items: readonly T[], count: number): readonly T[] {
      const pool = [...items];
      for (let index = pool.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        const held = pool[index];
        const other = pool[swap];
        if (held === undefined || other === undefined) continue;
        pool[index] = other;
        pool[swap] = held;
      }
      return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
    },
    chance(probability: number): boolean {
      return next() < probability;
    },
    next,
  };
}

/** 32 位十六进制串，用于 family 分桶与 shard 分配。稳定、无浮点。 */
export function stableBucket(key: string): string {
  return fnv1a32(key).toString(16).padStart(8, '0');
}

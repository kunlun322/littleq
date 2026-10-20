/**
 * 扫描预算与 fail-closed 资源上限。
 *
 * 上限分两类，混在一起就会把「设计里的量」当成「实测出来的量」（ZLQ-201 §6 非协商 3）：
 *
 * - **契约冻结值**：来自 ZLQ-153 §8.1 与 ZLQ-156 §1.3/§6.3，不可由本实现放宽。
 * - **实现自定值**：`SCANNER_*` 前缀的那些。ZLQ-156 §6.3 明确「decode 深度/节点预算按
 *   parser 压测制定 ruleset」，本单没有做压测语料（那是 D3b 的活），所以这里给的是保守
 *   工程默认值，并在 `budgetProvenance` 里逐条标注来源，供 D3b 用实测语料替换。
 *
 * fail-closed 的语义是「超预算 = ERROR，不是 PASS」：ZLQ-156 §6.4「绝不因为『没读完』给 PASS」。
 */

const MIB = 1024 * 1024;

export const PACKAGE_LIMITS = {
  /** ZLQ-153 §8.1：压缩包 ≤ 10 MiB。 */
  maxArchiveBytes: 10 * MIB,
  /** ZLQ-153 §8.1：未压缩总体积 ≤ 15 MiB。 */
  maxTotalUncompressedBytes: 15 * MIB,
  /** ZLQ-153 §8.1 / ZLQ-156 §1.3：单文件 ≤ 4 MiB。 */
  maxFileBytes: 4 * MIB,
  /** ZLQ-153 §8.1：文件数 ≤ 200（含 work.json）。 */
  maxFileCount: 200,
  /** ZLQ-153 §8.1：目录深度 ≤ 8。 */
  maxPathDepth: 8,
  /** ZLQ-156 §1.3：path 最长 240 码点。 */
  maxPathCodePoints: 240,
  /** ZLQ-156 §6.3：解包与规范化流使用 64 KiB 块。 */
  chunkBytes: 64 * 1024,
  /** ZLQ-156 §6.3：单片总预算 8 秒。 */
  sliceBudgetMs: 8000,
  /** ZLQ-156 §6.3：前 6 秒处理/发起有界对象读。 */
  workDeadlineMs: 6000,
  /** ZLQ-156 §6.3：最后 1 秒准备 checkpoint/持久化（另留 1 秒余量）。 */
  checkpointReserveMs: 1000,
} as const;

/** ZLQ-156 §6.3 的 `budgetCounters`：跨片段累计，防预算重置。 */
export type BudgetCounters = {
  decompressedBytes: number;
  readBytes: number;
  fileCount: number;
  secondLevelDecodes: number;
  secondLevelDecodeBytes: number;
  tokens: number;
  nodes: number;
  resumes: number;
};

export type BudgetLimitId = keyof BudgetCounters;

export type BudgetLimits = Readonly<Record<BudgetLimitId, number>>;

export type BudgetProvenance = Readonly<Record<BudgetLimitId, 'contract' | 'implementation'>>;

/** 每个上限的来源，避免把实现默认值冒充成设计冻结值。 */
export const budgetProvenance: BudgetProvenance = {
  decompressedBytes: 'contract',
  readBytes: 'contract',
  fileCount: 'contract',
  secondLevelDecodes: 'implementation',
  secondLevelDecodeBytes: 'implementation',
  tokens: 'implementation',
  nodes: 'implementation',
  resumes: 'implementation',
};

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  // ZLQ-153 §8.1
  decompressedBytes: PACKAGE_LIMITS.maxTotalUncompressedBytes,
  readBytes: PACKAGE_LIMITS.maxTotalUncompressedBytes,
  fileCount: PACKAGE_LIMITS.maxFileCount,
  // 实现自定（ZLQ-156 §6.3 要求按 parser 压测制定，D3b 用实测语料替换）
  secondLevelDecodes: 200_000,
  secondLevelDecodeBytes: 8 * MIB,
  tokens: 4_000_000,
  nodes: 4_000_000,
  resumes: 10_000,
};

/** 二次解码链的深度上限（实现自定，见 `budgetProvenance`）。 */
export const SECOND_LEVEL_DEPTH_LIMIT = 6;

/** 单个候选串的二次解码字节上限（实现自定）。 */
export const SECOND_LEVEL_CANDIDATE_BYTES = 64 * 1024;

export const SCANNER_RESOURCE_LIMIT = 'SCANNER_RESOURCE_LIMIT' as const;

/**
 * 预算越界。它是**错误**而不是 finding：ZLQ-156 §6.4「达到实现预算返回资源 ERROR 不继续执行」。
 */
export class ScannerResourceLimitError extends Error {
  readonly code: typeof SCANNER_RESOURCE_LIMIT = SCANNER_RESOURCE_LIMIT;
  readonly retryable = false;
  readonly limit: BudgetLimitId;
  readonly value: number;
  readonly cap: number;

  constructor(limit: BudgetLimitId, value: number, cap: number) {
    super(`扫描预算越界：${limit} 累计 ${value} 超过上限 ${cap}（fail-closed，不给 PASS）`);
    this.name = 'ScannerResourceLimitError';
    this.limit = limit;
    this.value = value;
    this.cap = cap;
  }
}

export interface Budget {
  readonly counters: BudgetCounters;
  readonly limits: BudgetLimits;
  /** 累加用量；越界立即抛 `ScannerResourceLimitError`。 */
  spend(limit: BudgetLimitId, amount: number): void;
  peek(limit: BudgetLimitId): number;
  remaining(limit: BudgetLimitId): number;
  exceeded(limit: BudgetLimitId): boolean;
}

export function emptyCounters(): BudgetCounters {
  return {
    decompressedBytes: 0,
    readBytes: 0,
    fileCount: 0,
    secondLevelDecodes: 0,
    secondLevelDecodeBytes: 0,
    tokens: 0,
    nodes: 0,
    resumes: 0,
  };
}

export function createBudget(
  counters: BudgetCounters = emptyCounters(),
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
): Budget {
  return {
    counters,
    limits,
    spend(limit, amount) {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new ScannerResourceLimitError(limit, Number.NaN, limits[limit]);
      }
      const next = counters[limit] + amount;
      counters[limit] = next;
      if (next > limits[limit]) throw new ScannerResourceLimitError(limit, next, limits[limit]);
    },
    peek(limit) {
      return counters[limit];
    },
    remaining(limit) {
      return Math.max(0, limits[limit] - counters[limit]);
    },
    exceeded(limit) {
      return counters[limit] > limits[limit];
    },
  };
}

/**
 * 片段级时间预算（ZLQ-156 §6.3：总 8 秒，前 6 秒处理，最后 1 秒写 checkpoint，留 1 秒余量）。
 * 所有 async IO 必须用 `remainingWorkMs()` 作为 deadline，不能在第 7 秒发起一个无限等待的读。
 */
export interface SliceDeadline {
  readonly startedAt: number;
  readonly workDeadlineMs: number;
  now(): number;
  elapsedMs(): number;
  remainingWorkMs(): number;
  /** 处理窗口是否已用尽 —— 用尽就必须落 checkpoint 并 `CONTINUE`，而不是硬撑。 */
  workWindowExhausted(): boolean;
}

export function createSliceDeadline(
  now: () => number = () => Date.now(),
  workDeadlineMs: number = PACKAGE_LIMITS.workDeadlineMs,
): SliceDeadline {
  const startedAt = now();
  return {
    startedAt,
    workDeadlineMs,
    now,
    elapsedMs: () => now() - startedAt,
    remainingWorkMs: () => Math.max(0, workDeadlineMs - (now() - startedAt)),
    workWindowExhausted: () => now() - startedAt >= workDeadlineMs,
  };
}

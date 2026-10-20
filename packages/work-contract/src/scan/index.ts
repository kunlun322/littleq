/**
 * 扫描驱动：把 §6.1 的 `WorkScanner` 三步接口落成可跨实例续跑的状态机
 * （ZLQ-156 §6.3 的 checkpoint / 微工作单元 / 时间片预算，§6.4 的预算 fail-closed）。
 *
 * 十条设计约束，每一条都是被某个冻结签名或被 §11「扫描器必须是真判定」逼出来的：
 *
 * 1. **`start` 注册，`step` 校验。** `ScanErrorCode` 只存在于 `ScanStepResult` 上，而 `start`
 *    返回裸 `ScanCheckpoint` —— 它**没有失败通道**。所以身份/hash 完整性校验落在 INVENTORY 相位，
 *    由第一个 `step` 报 ERROR。`start` 里只做一件会抛的事：`validateWorkMetadata`。
 *    理由：一份结构上就不合法的 `work.json` 是**调用方**给错了输入，不是扫描结论；
 *    而「声明的 hash 与实测不符」是扫描结论，必须走 ERROR 码。
 * 2. **`scanRunId` 由 `inputHash` 派生** ⇒ 同一份输入在任何进程里都得到同一个 id。
 *    这就是**冷续跑协议**：checkpoint 从库里捞回来之后，先用**同一份** `StartScanInput`
 *    再调一次 `start`（重建内存态、重新注册），再拿旧 checkpoint 调 `step`。
 *    `step` 遇到未注册的 `scanRunId` 一律 `CHECKPOINT_INVALID`，绝不凭 checkpoint 里的 hash 编报告。
 * 3. **冷续跑必须回卷到 RESOURCE_GRAPH。** checkpoint 里的 `resourceGraphRefs` 只是 hash 指针，
 *    图本身在内存里。带着**空图**跑 RULES，B1 的「验证每个节点存在且不越界」会**空洞地通过**
 *    —— 那正是 §11 说的假 PASS。所以 `phase === 'RULES'` 而 `ctx.graph === null` 时，
 *    回卷相位、清空引用、把 `pendingCrossFileEdges` 按清单重新填满。
 *    `completedUnits` / `findingRefs` / `budgetCounters` **全部保留**，已跑过的规则由
 *    `rulesDone` 从 `completedUnits` 复原，不会重跑、也不会重复计数。
 * 4. **`step` 只改副本。** `cloneCheckpoint` 之后所有变更都落在副本上，调用方手里那份原封不动 ——
 *    平台的 CAS 比较才有意义（比较对象必须是提交前的值）。
 * 5. **预算分两处扣。** INVENTORY 一次扣 `fileCount` 与 `decompressedBytes`（按清单声明值），
 *    于是 300 个文件或 >15 MiB 的包**立刻** ERROR；NORMALIZE 每读一块扣 `readBytes`（按实测值），
 *    于是**低报体积**的清单也会被抓住。每个 `step` 扣 1 次 `resumes`（§6.3：跨片段累计，防预算重置）。
 *    **已声明的后果**：冷续跑会重读文件、重复计费，所以一个逼近 15 MiB 上限的包若跨实例被打断，
 *    可能以 `SCANNER_RESOURCE_LIMIT` fail-closed 结束，而不是悄悄少算。这是 §6.3/§6.4 的诚实读法。
 * 6. **四个错误码是冻结的，我没有权限新增**（R37 裁定），所以映射必须写出来：
 *    打开/读取文件失败 ⇒ `INPUT_HASH_MISMATCH` + `retryable: true`（`retryable` 就是「瞬时 IO」
 *    与「hash 真的对不上」的区分位）；解码/解析失败 ⇒ `PARSER_UNSUPPORTED` + `false`；
 *    预算溢出 ⇒ `SCANNER_RESOURCE_LIMIT` + `false`；checkpoint 未注册/身份不符/schema 不符/
 *    内部不变量被破坏 ⇒ `CHECKPOINT_INVALID` + `false`。**没有任何一条映射到 PASS。**
 *    **已声明的后果**：一个坏掉的 `.js` 会让整次扫描 ERROR 并挡住发布 —— 那是 §6.2
 *    「语法损坏是 ERROR」的冻结意图，不是缺陷。
 * 7. **`findingRefs` 在 `#emit` 里增量写，不留到 AGGREGATE。** 否则一次「RULES 已完成」的冷续跑
 *    会产出**空报告** —— 那是一句静默的谎。去重仍然正确：`findingRefs` 以内容派生的 `findingId`
 *    为键，重跑只会用相同值覆盖；报告一律从 `findingRefs` 重建，**从不**从 `factory.findings` 重建。
 * 8. **路径脱敏在输出口做一次**（§6.2：「若异常 filename 命中，summary path 使用稳定 `file-<ordinal>`
 *    占位，不回显原名或签名 query」）。占位符用的 ordinal 是 `comparePathBytes` 排序后的下标，
 *    跨进程确定。而 `findingIdentity` 用的是**真实路径**（§6.5：规范路径进确认范围 hash）——
 *    两者是不同用途，不能互相替代。
 * 9. **`DispositionCeilingError` / `UndeclaredSubTypeError` / `UnknownFindingPathError` 原样抛出，
 *    不折成 ERROR 码。** 它们是**实现缺陷**（规则越权、子类型漂移、报了不属于本产物的路径），
 *    不是扫描结论。折成 ERROR 码会让「B12 永不硬拦」的变异只表现为一个普通失败结果，
 *    而不是一个明确的抛错 —— §8 的变异对照 1 需要它响亮。
 * 10. **`createWorkScanner` 不接受预算上限选项。** 时钟与租约续期提示可以注入（它们削弱不了任何
 *     契约上限，且让测试可确定），但 `limits` 不行：能被调用方放宽的上限就不是
 *     `budgetProvenance` 里标着 `'contract'` 的那三个数了。要触发 `SCANNER_RESOURCE_LIMIT`，
 *     测试就构造一个**真的**超限的包（例如 201 个极小文件）—— 那同时也是对 §8.1 上限的更好测试。
 */

import { analyzeFile, isTextualMediaType } from './analysis/index.js';
import type { ParseSummary, ResourceReference } from './analysis/model.js';
import {
  PACKAGE_LIMITS,
  ScannerResourceLimitError,
  createBudget,
  createSliceDeadline,
  type Budget,
  type SliceDeadline,
} from './budget.js';
import { explanationText } from './explanations.js';
import {
  FROZEN_DISPOSITION_CEILING,
  FindingFactory,
  confirmationScopeHash,
  findingIdentity,
  locationKey,
  scanInputHash,
  type FindingDraft,
} from './finding.js';
import {
  buildResourceGraph,
  collectReferences,
  type ResourceGraph,
  type ResourceGraphEdge,
} from './graph.js';
import { canonicalJson, sha256Hex, sha256OfText } from './hash.js';
import { LineIndex } from './location.js';
import {
  ENTRY_FILE_NAME,
  MANIFEST_FILE_NAME,
  artifactSha256,
  checkPackagePath,
  comparePathBytes,
  findCaseConflicts,
  validateWorkMetadata,
  type ArtifactEntry,
} from './metadata.js';
import { decodePackageText } from './normalize.js';
import { RULES, RULE_BY_ID, assertDeclaredSubType } from './rules/index.js';
import type { RuleContext, RuleFileContext } from './rules/types.js';
import { findPathSecretShape } from './textsafety.js';
import {
  RULE_IDS,
  type Finding,
  type FileRef,
  type RuleId,
  type ScanCheckpoint,
  type ScanErrorCode,
  type ScanReport,
  type ScanStepResult,
  type StartScanInput,
  type ValidatedWorkMetadata,
  type WorkScanner,
} from './types.js';

/** checkpoint 的 schema 身份。§6.3「schema 固定」；改动它必须让旧 checkpoint 全部失效。 */
export const CHECKPOINT_SCHEMA_VERSION = 'littleq-scan-checkpoint-v1';

/**
 * 解析层版本。§6.3 的**逐文件**解析缓存 key 是 `fileHash + parserVersion`，
 * 所以升级 acorn / parse5 / postcss 或改动 `analysis/**` 的产出形状都必须抬高它，
 * 否则旧缓存会与新解析器混用。
 */
export const PARSER_VERSION = 'parse-v1';

/** 租约续期提示（实现值，不是契约值；不参与任何 hash，所以不影响报告确定性）。 */
export const DEFAULT_LEASE_RENEWAL_MS = 30_000;

export type WorkScannerOptions = {
  /** 只用于 `nextRunAt`。默认 `Date.now`；测试注入固定时钟以得到可比较的 checkpoint。 */
  readonly now?: () => number;
  readonly leaseRenewalMs?: number;
};

/** `finalize` 在扫描没有真正跑完时被调用。宁可抛，也不编一份报告出来（§6.3）。 */
export class IncompleteScanError extends Error {
  readonly code = 'INCOMPLETE_SCAN' as const;
  readonly reason: IncompleteScanReason;

  constructor(reason: IncompleteScanReason, detail: string) {
    super(`cannot finalize scan: ${reason} (${detail})`);
    this.name = 'IncompleteScanError';
    this.reason = reason;
  }
}

export type IncompleteScanReason =
  | 'not-registered'
  | 'schema-version'
  | 'identity-mismatch'
  | 'phase-not-complete'
  | 'manifest-invalid';

/** 扫描失败（带冻结错误码）。内部信号，`step` 会把它翻译成 `ScanStepResult`。 */
class ScanFailureSignal extends Error {
  constructor(
    readonly code: ScanErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ScanFailureSignal';
  }
}

/** 时间片用尽 / 收到中止：让出，返回 CONTINUE 与已持久化的 checkpoint。不是错误。 */
class SliceYieldSignal {
  readonly name = 'SliceYieldSignal';
}

/** 驱动自身的不变量被破坏。fail-closed 成 `CHECKPOINT_INVALID`，绝不 fail-open 成 PASS。 */
class ScannerInvariantError extends Error {
  readonly code = 'SCANNER_INVARIANT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ScannerInvariantError';
  }
}

/** `work.json` 结构不合法（调用方给错输入，见文件头约束 1）。 */
export class InvalidManifestError extends Error {
  readonly code = 'MANIFEST_INVALID' as const;
  readonly issues: readonly { pointer: string; message: string }[];

  constructor(issues: readonly { pointer: string; message: string }[]) {
    super(`work.json failed contract validation with ${issues.length} issue(s)`);
    this.name = 'InvalidManifestError';
    this.issues = issues;
  }
}

function failure(code: ScanErrorCode, retryable: boolean, message: string): ScanFailureSignal {
  return new ScanFailureSignal(code, retryable, message);
}

/** §6.3：处理窗口占时间片的比例由冻结常量给出（6 s / 8 s），不给调用方另开一个旋钮。 */
function workDeadlineMs(budgetMs: number): number {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new ScannerInvariantError('budgetMs must be a positive finite number');
  }
  const ratio = PACKAGE_LIMITS.workDeadlineMs / PACKAGE_LIMITS.sliceBudgetMs;
  return Math.max(1, Math.round(budgetMs * ratio));
}

type NormalizedFile = {
  readonly ref: FileRef;
  readonly ordinal: number;
  readonly bytes: Uint8Array;
  /** 非文本形态为 null；文本形态是严格解码后的内容。 */
  readonly text: string | null;
  /** 实测 sha256，即 `normalizedRefs` 里存的那个 hash 指针。 */
  readonly digest: string;
};

type FindingRef = {
  readonly findingId: string;
  /** 已脱敏（路径可能是 `file-<ordinal>` 占位符）。这是唯一会出现在报告里的形态。 */
  readonly finding: Finding;
  /** §6.5 的稳定语义标识，用**真实**路径。只进 `confirmationScopeHash`。 */
  readonly identity: string;
  readonly ordinal: number;
};

type ScanContext = {
  readonly input: StartScanInput;
  readonly metadata: ValidatedWorkMetadata;
  readonly scanRunId: string;
  readonly inputHash: string;
  /** 按 `comparePathBytes` 排序（§6.2 确定性输出）；ordinal 就是下标。 */
  readonly inventory: readonly FileRef[];
  readonly byPath: ReadonlyMap<string, FileRef>;
  /** 真实路径 → 实测 sha256，含 `work.json`（`FindingFactory` 要求）。 */
  readonly fileHashes: Readonly<Record<string, string>>;
  /** 真实路径 → 输出路径（正常原样，命中秘密/PII 形状则为 `file-<ordinal>`）。 */
  readonly safePathByPath: ReadonlyMap<string, string>;
  readonly factory: FindingFactory;
  files: StartScanInput['files'];
  readonly normalized: Map<string, NormalizedFile>;
  readonly partial: Map<string, { received: number; chunks: Uint8Array[] }>;
  readonly summaries: Map<string, ParseSummary>;
  references: ResourceReference[];
  graph: ResourceGraph | null;
  ruleFiles: RuleFileContext[];
  fileByPath: ReadonlyMap<string, RuleFileContext> | null;
  preparedCount: number;
  rulesDone: Set<RuleId>;
  newFindings: Finding[];
};

function cloneCheckpoint(source: ScanCheckpoint): ScanCheckpoint {
  return {
    ...source,
    cursor: { ...source.cursor },
    budgetCounters: { ...source.budgetCounters },
    normalizedRefs: { ...source.normalizedRefs },
    parseSummaryRefs: { ...source.parseSummaryRefs },
    resourceGraphRefs: { ...source.resourceGraphRefs },
    completedUnits: [...source.completedUnits],
    pendingCrossFileEdges: [...source.pendingCrossFileEdges],
    findingRefs: { ...source.findingRefs },
  };
}

function recoverRulesDone(completedUnits: readonly string[]): Set<RuleId> {
  const done = new Set<RuleId>();
  for (const unit of completedUnits) {
    if (!unit.startsWith('rule:')) continue;
    const ruleId = asRuleId(unit.slice('rule:'.length));
    if (ruleId !== null) done.add(ruleId);
  }
  return done;
}

function asRuleId(value: string): RuleId | null {
  const candidate = value as RuleId;
  return RULE_IDS.includes(candidate) ? candidate : null;
}

/** `RULE_IDS` 顺序里第一条还没跑完的规则；全跑完返回 null。 */
function firstUndoneRule(done: ReadonlySet<RuleId>): RuleId | null {
  for (const ruleId of RULE_IDS) if (!done.has(ruleId)) return ruleId;
  return null;
}

function graphDigest(graph: ResourceGraph): unknown {
  return {
    parserVersion: PARSER_VERSION,
    nodes: graph.nodes,
    edges: graph.edges.map((edge: ResourceGraphEdge) => ({
      fromPath: edge.fromPath,
      kind: edge.kind,
      raw: edge.raw,
      target: edge.resolved.target,
    })),
  };
}

function decodeFindingRef(raw: string, key: string): FindingRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failure('CHECKPOINT_INVALID', false, 'findingRefs 里存在不是合法 JSON 的条目');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw failure('CHECKPOINT_INVALID', false, 'findingRefs 条目形状不符');
  }
  const record = parsed as Record<string, unknown>;
  const finding = record['finding'];
  const identity = record['identity'];
  const ordinal = record['ordinal'];
  if (typeof finding !== 'object' || finding === null) {
    throw failure('CHECKPOINT_INVALID', false, 'findingRefs 条目缺少 finding');
  }
  if (typeof identity !== 'string' || typeof ordinal !== 'number') {
    throw failure('CHECKPOINT_INVALID', false, 'findingRefs 条目缺少 identity/ordinal');
  }
  const candidate = finding as Partial<Finding>;
  const ruleId = asRuleId(String(candidate.ruleId));
  if (
    ruleId === null ||
    typeof candidate.findingId !== 'string' ||
    candidate.findingId !== key ||
    (candidate.disposition !== 'BLOCK' && candidate.disposition !== 'CONFIRM_REQUIRED') ||
    typeof candidate.path !== 'string'
  ) {
    throw failure('CHECKPOINT_INVALID', false, 'findingRefs 条目里的 finding 不是合法 Finding');
  }
  return {
    findingId: candidate.findingId,
    finding: finding as Finding,
    identity,
    ordinal,
  };
}

/**
 * §6.2「BLOCK > CONFIRM_REQUIRED > PASS」的排序在报告里的落地形态：
 * 规则 id 顺序 → 路径字节序 → 定位串 → findingId。四级全部确定，
 * 所以同一份输入在任何进程里给出**逐字节相同**的 `findings` 数组。
 */
function compareFindingRefs(left: FindingRef, right: FindingRef): number {
  const byRule = RULE_IDS.indexOf(left.finding.ruleId) - RULE_IDS.indexOf(right.finding.ruleId);
  if (byRule !== 0) return byRule;
  const byPath = comparePathBytes(left.finding.path, right.finding.path);
  if (byPath !== 0) return byPath;
  const leftKey = locationKey(left.finding.location);
  const rightKey = locationKey(right.finding.location);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  if (left.findingId === right.findingId) return 0;
  return left.findingId < right.findingId ? -1 : 1;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class Scanner implements WorkScanner {
  readonly #contexts = new Map<string, ScanContext>();
  readonly #now: () => number;
  readonly #leaseRenewalMs: number;

  constructor(options: WorkScannerOptions) {
    this.#now = options.now ?? (() => Date.now());
    this.#leaseRenewalMs = options.leaseRenewalMs ?? DEFAULT_LEASE_RENEWAL_MS;
  }

  start(input: StartScanInput): ScanCheckpoint {
    const validated = validateWorkMetadata(input.metadata);
    if (!validated.ok) throw new InvalidManifestError(validated.issues);

    const inventory = [...input.files.list()].sort((left, right) =>
      comparePathBytes(left.path, right.path),
    );
    const byPath = new Map<string, FileRef>();
    const fileHashes: Record<string, string> = {};
    const safePathByPath = new Map<string, string>();
    inventory.forEach((ref, ordinal) => {
      byPath.set(ref.path, ref);
      fileHashes[ref.path] = ref.sha256;
      safePathByPath.set(
        ref.path,
        findPathSecretShape(ref.path) === undefined ? ref.path : `file-${ordinal}`,
      );
    });

    const inputHash = scanInputHash({
      artifactHash: input.artifactHash,
      manifestHash: input.manifestHash,
      schemaVersion: input.schemaVersion,
      contractVersion: input.contractVersion,
      scannerVersion: input.scannerVersion,
      rulesetVersion: input.rulesetVersion,
      policyRevision: input.policySnapshot.revision,
      lexiconRevision: input.policySnapshot.lexiconRevision,
    });
    const scanRunId = `scan-${inputHash.slice(0, 32)}`;

    this.#contexts.set(scanRunId, {
      input,
      metadata: validated.metadata,
      scanRunId,
      inputHash,
      inventory,
      byPath,
      fileHashes,
      safePathByPath,
      factory: new FindingFactory({
        scannerVersion: input.scannerVersion,
        rulesetVersion: input.rulesetVersion,
        fileHashes,
        // 冻结上限，**不**从规则自己的 `maxDisposition` 派生（见 finding.ts 文件头）。
        ceiling: FROZEN_DISPOSITION_CEILING,
      }),
      files: input.files,
      normalized: new Map(),
      partial: new Map(),
      summaries: new Map(),
      references: [],
      graph: null,
      ruleFiles: [],
      fileByPath: null,
      preparedCount: 0,
      rulesDone: new Set(),
      newFindings: [],
    });

    return this.#stamp(
      {
        scanRunId,
        checkpointSchemaVersion: CHECKPOINT_SCHEMA_VERSION,
        // 首个 checkpoint 是 revision 1，不变量恒为 `expectedTaskRevision === revision - 1`。
        revision: 1,
        artifactHash: input.artifactHash,
        manifestHash: input.manifestHash,
        schemaVersion: input.schemaVersion,
        contractVersion: input.contractVersion,
        scannerVersion: input.scannerVersion,
        rulesetVersion: input.rulesetVersion,
        phase: 'INVENTORY',
        cursor: { fileOrdinal: 0, byteOffset: 0, subphase: '' },
        budgetCounters: {
          decompressedBytes: 0,
          readBytes: 0,
          fileCount: 0,
          secondLevelDecodes: 0,
          secondLevelDecodeBytes: 0,
          tokens: 0,
          nodes: 0,
          resumes: 0,
        },
        normalizedRefs: {},
        parseSummaryRefs: {},
        resourceGraphRefs: {},
        completedUnits: [],
        pendingCrossFileEdges: [],
        findingRefs: {},
        expectedTaskRevision: 0,
        leaseFence: '',
        nextRunAt: '',
      },
      1,
    );
  }

  async step(input: {
    checkpoint: ScanCheckpoint;
    files: StartScanInput['files'];
    budgetMs: number;
    abortSignal: AbortSignal;
  }): Promise<ScanStepResult> {
    const mismatch = this.#mismatch(input.checkpoint);
    if (mismatch !== null) {
      return { state: 'ERROR', code: 'CHECKPOINT_INVALID', retryable: false };
    }
    const ctx = this.#contexts.get(input.checkpoint.scanRunId);
    if (ctx === undefined) {
      return { state: 'ERROR', code: 'CHECKPOINT_INVALID', retryable: false };
    }
    if (input.checkpoint.phase === 'COMPLETE') {
      return { state: 'COMPLETE', checkpoint: input.checkpoint };
    }

    const working = this.#stamp(cloneCheckpoint(input.checkpoint), input.checkpoint.revision + 1);
    ctx.files = input.files;
    ctx.newFindings = [];
    this.#rewind(ctx, working);

    const budget = createBudget(working.budgetCounters);
    const deadline = createSliceDeadline(this.#now, workDeadlineMs(input.budgetMs));

    try {
      // §6.3：`resumes` 跨片段累计，防「换个实例就把预算清零」。
      budget.spend('resumes', 1);
      // 单元上限：驱动自身的死循环保险丝。3n + 16 就够跑完整包，给到 4n + 21 留余量。
      const unitCap = ctx.inventory.length * 4 + RULE_IDS.length + 8;
      for (let units = 0; working.phase !== 'COMPLETE'; units += 1) {
        if (units >= unitCap) {
          throw new ScannerInvariantError('unit cap reached before COMPLETE');
        }
        if (input.abortSignal.aborted || deadline.workWindowExhausted()) break;
        await this.#runPhase(ctx, working, budget, deadline, input.abortSignal);
      }
    } catch (error) {
      if (error instanceof SliceYieldSignal) {
        return this.#continuation(ctx, working);
      }
      if (error instanceof ScannerResourceLimitError) {
        return { state: 'ERROR', code: 'SCANNER_RESOURCE_LIMIT', retryable: false };
      }
      if (error instanceof ScanFailureSignal) {
        return { state: 'ERROR', code: error.code, retryable: error.retryable };
      }
      if (error instanceof ScannerInvariantError) {
        return { state: 'ERROR', code: 'CHECKPOINT_INVALID', retryable: false };
      }
      // 文件头约束 9：这三类是实现缺陷，必须原样抛出，不折成 ERROR 码。
      throw error;
    }

    if (working.phase === 'COMPLETE') return { state: 'COMPLETE', checkpoint: working };
    return this.#continuation(ctx, working);
  }

  async finalize(checkpoint: ScanCheckpoint): Promise<ScanReport> {
    const mismatch = this.#mismatch(checkpoint);
    if (mismatch !== null) {
      throw new IncompleteScanError(mismatch, checkpoint.scanRunId);
    }
    const ctx = this.#contexts.get(checkpoint.scanRunId);
    if (ctx === undefined) {
      throw new IncompleteScanError('not-registered', checkpoint.scanRunId);
    }
    if (checkpoint.phase !== 'COMPLETE') {
      throw new IncompleteScanError('phase-not-complete', checkpoint.phase);
    }

    const refs = Object.keys(checkpoint.findingRefs).map((key) => {
      const raw = checkpoint.findingRefs[key];
      if (raw === undefined) {
        throw failure('CHECKPOINT_INVALID', false, 'findingRefs 键值不一致');
      }
      return decodeFindingRef(raw, key);
    });
    refs.sort(compareFindingRefs);

    const findings = refs.map((ref) => ref.finding);
    const block = findings.filter((finding) => finding.disposition === 'BLOCK').length;
    const confirm = findings.filter((finding) => finding.disposition === 'CONFIRM_REQUIRED').length;
    const bytes = ctx.inventory.reduce((sum, ref) => sum + ref.bytes, 0);

    const scopeHash = confirmationScopeHash({
      workId: ctx.metadata.workId,
      version: ctx.metadata.version,
      // §6.5 第②项：**除 work.json 外**全部文件的实测 hash。
      fileHashes: ctx.inventory
        .filter((ref) => ref.path !== MANIFEST_FILE_NAME)
        .map((ref) => ({ path: ref.path, sha256: ref.sha256 })),
      metadata: ctx.metadata,
      scannerVersion: ctx.input.scannerVersion,
      rulesetVersion: ctx.input.rulesetVersion,
      policyRevision: ctx.input.policySnapshot.revision,
      confirmIdentities: refs
        .filter((ref) => ref.finding.disposition === 'CONFIRM_REQUIRED')
        .map((ref) => ref.identity),
    });

    // 这次 run 已经结束：删掉上下文，第二次 `finalize` 会诚实地报 `not-registered`。
    this.#contexts.delete(checkpoint.scanRunId);

    return {
      scanRunId: ctx.scanRunId,
      inputHash: ctx.inputHash,
      confirmationScopeHash: scopeHash,
      scannerVersion: ctx.input.scannerVersion,
      rulesetVersion: ctx.input.rulesetVersion,
      complete: true,
      status: block > 0 ? 'BLOCK' : confirm > 0 ? 'CONFIRM_REQUIRED' : 'PASS',
      findings,
      counts: { files: ctx.inventory.length, bytes, block, confirm },
      summary: findings.map((finding) => ({
        ruleId: finding.ruleId,
        path: finding.path,
        location: finding.location,
        // §8.7 固定儿童文案，不插值源码/域名/完整 URL/秘密。
        explanation: explanationText(finding.ruleId),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 身份与租约
  // -------------------------------------------------------------------------

  /** 返回不匹配的原因；null 表示这个 checkpoint 属于本扫描器且身份一致。 */
  #mismatch(checkpoint: ScanCheckpoint): IncompleteScanReason | null {
    if (checkpoint.checkpointSchemaVersion !== CHECKPOINT_SCHEMA_VERSION) return 'schema-version';
    const ctx = this.#contexts.get(checkpoint.scanRunId);
    if (ctx === undefined) return 'not-registered';
    const identity: (keyof ScanCheckpoint)[] = [
      'artifactHash',
      'manifestHash',
      'schemaVersion',
      'contractVersion',
      'scannerVersion',
      'rulesetVersion',
    ];
    for (const field of identity) {
      if (checkpoint[field] !== ctx.input[field as keyof StartScanInput])
        return 'identity-mismatch';
    }
    return null;
  }

  /** 租约三件套。`leaseFence` 随 revision 变（栅栏要的正是这个）；两者都不进任何 hash。 */
  #stamp(checkpoint: ScanCheckpoint, revision: number): ScanCheckpoint {
    checkpoint.revision = revision;
    checkpoint.expectedTaskRevision = revision - 1;
    checkpoint.leaseFence = sha256OfText(`lease\u0000${checkpoint.scanRunId}\u0000${revision}`);
    checkpoint.nextRunAt = new Date(this.#now() + this.#leaseRenewalMs).toISOString();
    return checkpoint;
  }

  /** 冷续跑回卷（文件头约束 3）。 */
  #rewind(ctx: ScanContext, working: ScanCheckpoint): void {
    ctx.rulesDone = recoverRulesDone(working.completedUnits);
    if (working.phase !== 'RULES') return;
    if (ctx.graph === null) {
      working.phase = 'RESOURCE_GRAPH';
      working.cursor = { fileOrdinal: 0, byteOffset: 0, subphase: '' };
      ctx.references = [];
      working.pendingCrossFileEdges = ctx.inventory.map((_, index) => String(index));
    }
    if (ctx.preparedCount < ctx.inventory.length) {
      working.cursor.subphase = 'rules:prepare';
      working.cursor.fileOrdinal = ctx.preparedCount;
    }
  }

  #continuation(ctx: ScanContext, working: ScanCheckpoint): ScanStepResult {
    return {
      state: 'CONTINUE',
      checkpoint: working,
      progress: {
        filesDone: Object.keys(working.normalizedRefs).length,
        filesTotal: ctx.inventory.length,
      },
      newFindings: [...ctx.newFindings],
    };
  }

  // -------------------------------------------------------------------------
  // 相位机
  // -------------------------------------------------------------------------

  async #runPhase(
    ctx: ScanContext,
    working: ScanCheckpoint,
    budget: Budget,
    deadline: SliceDeadline,
    abortSignal: AbortSignal,
  ): Promise<void> {
    switch (working.phase) {
      case 'INVENTORY':
        this.#runInventory(ctx, working, budget);
        return;
      case 'NORMALIZE':
        await this.#runNormalize(ctx, working, budget, deadline, abortSignal);
        return;
      case 'PARSE':
        await this.#runParse(ctx, working, budget, deadline, abortSignal);
        return;
      case 'RESOURCE_GRAPH':
        await this.#runResourceGraph(ctx, working, budget, deadline, abortSignal);
        return;
      case 'RULES':
        await this.#runRules(ctx, working, budget, deadline, abortSignal);
        return;
      case 'AGGREGATE':
        this.#runAggregate(ctx, working);
        return;
      case 'COMPLETE':
        return;
    }
  }

  /**
   * 一个微工作单元（§6.3）。**全部**身份与 hash 完整性校验都在这里：
   * §6.1 明确「即使 TypeScript 叫 `Validated`，扫描器仍要检查 manifest / hash 完整性」。
   */
  #runInventory(ctx: ScanContext, working: ScanCheckpoint, budget: Budget): void {
    const inventory = ctx.inventory;
    budget.spend('fileCount', inventory.length);
    budget.spend(
      'decompressedBytes',
      inventory.reduce((sum, ref) => sum + ref.bytes, 0),
    );

    const input = ctx.input;
    const metadata = ctx.metadata;
    if (input.schemaVersion !== metadata.schemaVersion) {
      throw failure('INPUT_HASH_MISMATCH', false, 'schemaVersion 与 work.json 内声明的不一致');
    }
    if (input.contractVersion !== metadata.contractVersion) {
      throw failure('INPUT_HASH_MISMATCH', false, 'contractVersion 与 work.json 内声明的不一致');
    }

    const manifest = ctx.byPath.get(MANIFEST_FILE_NAME);
    if (manifest === undefined) {
      throw failure('INPUT_HASH_MISMATCH', false, '包内缺少 work.json（§1.2 要求 metadata 必有）');
    }
    if (manifest.sha256 !== input.manifestHash) {
      throw failure(
        'INPUT_HASH_MISMATCH',
        false,
        'manifestHash 与包内 work.json 的实测 hash 不一致',
      );
    }
    if (!ctx.byPath.has(metadata.entry)) {
      throw failure('INPUT_HASH_MISMATCH', false, '清单里没有 work.json 声明的运行入口');
    }
    if (metadata.entry !== ENTRY_FILE_NAME) {
      throw failure('INPUT_HASH_MISMATCH', false, '运行入口不是根目录 index.html（§8.1）');
    }

    const entries: ArtifactEntry[] = inventory.map((ref) => ({
      path: ref.path,
      sha256: ref.sha256,
      bytes: ref.bytes,
    }));
    if (artifactSha256(entries) !== input.artifactHash) {
      throw failure('INPUT_HASH_MISMATCH', false, 'artifactHash 与实测清单 hash 不一致');
    }

    for (const ref of inventory) {
      if (checkPackagePath(ref.path) !== null) {
        throw failure('INPUT_HASH_MISMATCH', false, '清单里存在非规范包内路径（§1.3）');
      }
    }
    if (findCaseConflicts(inventory.map((ref) => ref.path)).length > 0) {
      throw failure('INPUT_HASH_MISMATCH', false, '清单里存在大小写冲突路径（§1.3）');
    }

    // 清单 ↔ work.json.files 双向对照。少一边都会让「扫描了什么」与「声明了什么」脱钩。
    const declared = new Map(metadata.files.map((file) => [file.path, file]));
    for (const ref of inventory) {
      if (ref.path === MANIFEST_FILE_NAME) continue;
      const file = declared.get(ref.path);
      if (file === undefined) {
        throw failure('INPUT_HASH_MISMATCH', false, '清单里有 work.json 未声明的文件');
      }
      if (
        file.role !== ref.role ||
        file.bytes !== ref.bytes ||
        file.sha256 !== ref.sha256 ||
        file.mediaType !== ref.mediaType
      ) {
        throw failure(
          'INPUT_HASH_MISMATCH',
          false,
          '文件的 role/bytes/sha256/mediaType 与声明不一致',
        );
      }
    }
    for (const file of metadata.files) {
      if (!ctx.byPath.has(file.path)) {
        throw failure('INPUT_HASH_MISMATCH', false, 'work.json 声明的文件不在清单里');
      }
    }

    this.#pushUnit(working, 'inventory');
    working.phase = 'NORMALIZE';
    working.cursor = { fileOrdinal: 0, byteOffset: 0, subphase: '' };
  }

  async #runNormalize(
    ctx: ScanContext,
    working: ScanCheckpoint,
    budget: Budget,
    deadline: SliceDeadline,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const ordinal = working.cursor.fileOrdinal;
    if (ordinal >= ctx.inventory.length) {
      working.phase = 'PARSE';
      working.cursor = { fileOrdinal: 0, byteOffset: 0, subphase: '' };
      return;
    }
    const normalized = await this.#acquire(ctx, working, budget, deadline, abortSignal, ordinal);
    if (normalized === null) return;
    working.normalizedRefs[normalized.ref.path] = normalized.digest;
    this.#pushUnit(working, `normalize:${ordinal}`);
    working.cursor.fileOrdinal = ordinal + 1;
    working.cursor.byteOffset = 0;
  }

  async #runParse(
    ctx: ScanContext,
    working: ScanCheckpoint,
    budget: Budget,
    deadline: SliceDeadline,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const ordinal = working.cursor.fileOrdinal;
    if (ordinal >= ctx.inventory.length) {
      working.phase = 'RESOURCE_GRAPH';
      working.cursor = { fileOrdinal: 0, byteOffset: 0, subphase: '' };
      if (working.pendingCrossFileEdges.length === 0) {
        working.pendingCrossFileEdges = ctx.inventory.map((_, index) => String(index));
      }
      return;
    }
    const normalized = await this.#acquire(ctx, working, budget, deadline, abortSignal, ordinal);
    if (normalized === null) return;
    this.#analyze(ctx, normalized, budget);
    // 存的是**内容寻址指针**（解析器版本 + 文件 digest），不是摘要本身：§6.3 要求 checkpoint
    // 不把整棵 AST 背在身上，同时又能校验「这份摘要确实由这个解析器从这些字节产出」。
    working.parseSummaryRefs[normalized.ref.path] = sha256OfText(
      `${PARSER_VERSION}\u0000${normalized.digest}`,
    );
    this.#pushUnit(working, `parse:${ordinal}`);
    working.cursor.fileOrdinal = ordinal + 1;
  }

  async #runResourceGraph(
    ctx: ScanContext,
    working: ScanCheckpoint,
    budget: Budget,
    deadline: SliceDeadline,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const pending = working.pendingCrossFileEdges;
    if (pending.length > 0) {
      const head = pending[0];
      if (head === undefined) throw new ScannerInvariantError('pending head is undefined');
      const ordinal = Number.parseInt(head, 10);
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= ctx.inventory.length) {
        throw new ScannerInvariantError('pendingCrossFileEdges holds a non-ordinal entry');
      }
      const normalized = await this.#acquire(ctx, working, budget, deadline, abortSignal, ordinal);
      if (normalized === null) return;
      const summary = this.#analyze(ctx, normalized, budget);
      for (const reference of collectReferences(summary)) ctx.references.push(reference);
      pending.shift();
      this.#pushUnit(working, `graph:${ordinal}`);
      working.cursor.fileOrdinal = ordinal;
      return;
    }

    if (ctx.graph === null) {
      const graph = buildResourceGraph({
        entryPath: ctx.metadata.entry,
        packagePaths: ctx.inventory.map((ref) => ref.path),
        references: ctx.references,
        budget,
      });
      ctx.graph = graph;
      working.resourceGraphRefs['graph'] = sha256OfText(canonicalJson(graphDigest(graph)));
      this.#pushUnit(working, 'graph');
    }
    working.phase = 'RULES';
    working.cursor = {
      fileOrdinal: ctx.preparedCount,
      byteOffset: 0,
      subphase: this.#rulesSubphase(ctx),
    };
  }

  async #runRules(
    ctx: ScanContext,
    working: ScanCheckpoint,
    budget: Budget,
    deadline: SliceDeadline,
    abortSignal: AbortSignal,
  ): Promise<void> {
    if (working.cursor.subphase === 'rules:prepare') {
      const ordinal = working.cursor.fileOrdinal;
      if (ordinal < ctx.inventory.length) {
        const normalized = await this.#acquire(
          ctx,
          working,
          budget,
          deadline,
          abortSignal,
          ordinal,
        );
        if (normalized === null) return;
        const summary = this.#analyze(ctx, normalized, budget);
        ctx.ruleFiles.push({
          path: normalized.ref.path,
          role: normalized.ref.role,
          mediaType: normalized.ref.mediaType,
          sha256: normalized.digest,
          bytes: normalized.bytes,
          text: normalized.text,
          summary,
          lines: normalized.text === null ? null : new LineIndex(normalized.text),
        });
        ctx.preparedCount += 1;
        ctx.fileByPath = new Map(ctx.ruleFiles.map((file) => [file.path, file]));
        this.#pushUnit(working, `prepare:${ordinal}`);
        working.cursor.fileOrdinal = ordinal + 1;
        return;
      }
      working.cursor.fileOrdinal = 0;
      working.cursor.subphase = this.#rulesSubphase(ctx);
      return;
    }

    if (working.cursor.subphase === 'rules:done') {
      working.phase = 'AGGREGATE';
      working.cursor = { fileOrdinal: 0, byteOffset: 0, subphase: '' };
      return;
    }

    const ruleId = asRuleId(working.cursor.subphase);
    if (ruleId === null) {
      throw new ScannerInvariantError('RULES subphase is neither prepare, a rule id, nor done');
    }
    const rule = RULE_BY_ID.get(ruleId);
    if (rule === undefined) throw new ScannerInvariantError(`rule not registered: ${ruleId}`);

    if (!ctx.rulesDone.has(ruleId)) {
      rule.run(this.#ruleContext(ctx, working, budget));
      ctx.rulesDone.add(ruleId);
      this.#pushUnit(working, `rule:${ruleId}`);
    }
    working.cursor.subphase = firstUndoneRule(ctx.rulesDone) ?? 'rules:done';
  }

  /** AGGREGATE：把 `findingRefs` 解码、排序、按排序重新编码（§6.3「有序、脱敏、唯一键」）。 */
  #runAggregate(ctx: ScanContext, working: ScanCheckpoint): void {
    const refs = Object.keys(working.findingRefs).map((key) => {
      const raw = working.findingRefs[key];
      if (raw === undefined) {
        throw failure('CHECKPOINT_INVALID', false, 'findingRefs 键值不一致');
      }
      return decodeFindingRef(raw, key);
    });
    refs.sort(compareFindingRefs);
    const sorted: Record<string, string> = {};
    for (const ref of refs) sorted[ref.findingId] = working.findingRefs[ref.findingId] ?? '';
    working.findingRefs = sorted;

    this.#pushUnit(working, 'aggregate');
    working.phase = 'COMPLETE';
    working.cursor = { fileOrdinal: ctx.inventory.length, byteOffset: 0, subphase: 'complete' };
  }

  #rulesSubphase(ctx: ScanContext): string {
    if (ctx.preparedCount < ctx.inventory.length) return 'rules:prepare';
    return firstUndoneRule(ctx.rulesDone) ?? 'rules:done';
  }

  #ruleContext(ctx: ScanContext, working: ScanCheckpoint, budget: Budget): RuleContext {
    const graph = ctx.graph;
    const fileByPath = ctx.fileByPath;
    if (graph === null || fileByPath === null) {
      throw new ScannerInvariantError('RULES entered without a resource graph or prepared files');
    }
    return {
      metadata: ctx.metadata,
      policy: ctx.input.policySnapshot,
      graph,
      files: ctx.ruleFiles,
      fileByPath,
      budget,
      emit: (draft) => this.#emit(ctx, working, draft),
    };
  }

  /**
   * 规则的产出口。**先**校验子类型已声明（`assertDeclaredSubType`），再交给 `FindingFactory`
   * （它会强制处置上限、按内容去重、算 findingId），最后写进 `findingRefs`（文件头约束 7）。
   *
   * 返回给规则的是**脱敏后**的 finding —— 规则不需要、也不应该拿到别的形态。
   */
  #emit(ctx: ScanContext, working: ScanCheckpoint, draft: FindingDraft): Finding | null {
    assertDeclaredSubType(draft.ruleId, draft.subType);
    const stored = ctx.factory.emit(draft);
    if (stored === null) return null;

    const fileHash = ctx.fileHashes[draft.path];
    if (fileHash === undefined) {
      throw new ScannerInvariantError('FindingFactory accepted an unknown path');
    }
    const ordinal = ctx.inventory.findIndex((ref) => ref.path === draft.path);
    const safePath = ctx.safePathByPath.get(draft.path);
    const finding: Finding = { ...stored, path: safePath ?? `file-${ordinal}` };
    const isNew = !Object.prototype.hasOwnProperty.call(working.findingRefs, stored.findingId);
    working.findingRefs[stored.findingId] = canonicalJson({
      finding,
      // §6.5：身份用**真实**路径，不用占位符 —— 占位符会随清单顺序漂移，真实路径不会。
      identity: findingIdentity(stored, fileHash),
      ordinal,
    });
    if (isNew) ctx.newFindings.push(finding);
    return finding;
  }

  #pushUnit(working: ScanCheckpoint, unit: string): void {
    if (!working.completedUnits.includes(unit)) working.completedUnits.push(unit);
  }

  // -------------------------------------------------------------------------
  // 文件读取（可续跑的 64 KiB 分块）
  // -------------------------------------------------------------------------

  /**
   * 确保第 `ordinal` 个文件已规范化。返回 null 表示时间片用尽、已让出
   * （此时 `cursor.byteOffset` 已镜像 `partial.received` —— 这正是 §6.3 把 `byteOffset`
   * 放进冻结游标的原因）；完整性或解码失败抛 `ScanFailureSignal`。
   *
   * 分块上限固定 `PACKAGE_LIMITS.chunkBytes`（64 KiB）。§6.3 要求「所有异步 IO 用剩余 deadline」，
   * 而一次 `reader.read()` 本身不可中断 —— 所以协作点放在**块之间**，块大小就是不可中断的上界。
   */
  async #acquire(
    ctx: ScanContext,
    working: ScanCheckpoint,
    budget: Budget,
    deadline: SliceDeadline,
    abortSignal: AbortSignal,
    ordinal: number,
  ): Promise<NormalizedFile | null> {
    const ref = ctx.inventory[ordinal];
    if (ref === undefined) {
      throw new ScannerInvariantError(`file ordinal out of range: ${ordinal}`);
    }
    const cached = ctx.normalized.get(ref.path);
    if (cached !== undefined) return cached;

    let partial = ctx.partial.get(ref.path);
    if (partial === undefined) {
      partial = { received: 0, chunks: [] };
      ctx.partial.set(ref.path, partial);
    }
    working.cursor.byteOffset = partial.received;

    for (;;) {
      if (partial.received >= ref.bytes) break;
      if (abortSignal.aborted || deadline.workWindowExhausted()) return null;

      const before = partial.received;
      const range = {
        offset: before,
        length: Math.min(PACKAGE_LIMITS.chunkBytes, ref.bytes - before),
      };
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await ctx.files.open(ref.path, range);
      } catch {
        // 映射见文件头约束 6：`retryable: true` 区分「瞬时 IO」与「hash 真的对不上」。
        throw failure('INPUT_HASH_MISMATCH', true, '文件源无法打开清单里的文件；不给 PASS');
      }
      const reader = stream.getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const value: Uint8Array = result.value;
          if (value.byteLength === 0) continue;
          partial.chunks.push(value);
          partial.received += value.byteLength;
          budget.spend('readBytes', value.byteLength);
          working.cursor.byteOffset = partial.received;
          if (abortSignal.aborted || deadline.workWindowExhausted()) return null;
        }
      } catch (error) {
        if (error instanceof ScannerResourceLimitError) throw error;
        if (error instanceof ScanFailureSignal) throw error;
        throw failure('INPUT_HASH_MISMATCH', true, '读取清单里的文件失败；不给 PASS');
      } finally {
        reader.releaseLock();
      }
      if (partial.received === before) {
        throw failure(
          'INPUT_HASH_MISMATCH',
          true,
          '文件源在一整轮 open/read 里没有交付任何字节，无法证明包内容',
        );
      }
    }

    const bytes = concatChunks(partial.chunks, partial.received);
    ctx.partial.delete(ref.path);

    if (bytes.byteLength !== ref.bytes) {
      throw failure(
        'INPUT_HASH_MISMATCH',
        false,
        `实测字节数与清单声明不一致（声明 ${ref.bytes} / 实测 ${bytes.byteLength}）`,
      );
    }
    const digest = sha256Hex(bytes);
    if (digest !== ref.sha256) {
      throw failure('INPUT_HASH_MISMATCH', false, '实测 sha256 与清单声明不一致');
    }

    let text: string | null = null;
    if (isTextualMediaType(ref.mediaType)) {
      const decoded = decodePackageText(bytes);
      if (!decoded.ok) throw failure('PARSER_UNSUPPORTED', false, decoded.reason);
      text = decoded.text;
    }

    const normalized: NormalizedFile = { ref, ordinal, bytes, text, digest };
    ctx.normalized.set(ref.path, normalized);
    return normalized;
  }

  /** 解析（进程内缓存）。`parseError` 一律升级成 ERROR，绝不降级成「空文件、通过」。 */
  #analyze(ctx: ScanContext, normalized: NormalizedFile, budget: Budget): ParseSummary {
    const cached = ctx.summaries.get(normalized.ref.path);
    if (cached !== undefined) return cached;
    const summary = analyzeFile({
      path: normalized.ref.path,
      mediaType: normalized.ref.mediaType,
      bytes: normalized.bytes,
      text: normalized.text,
      budget,
    });
    if (summary.parseError !== null) {
      throw failure(
        'PARSER_UNSUPPORTED',
        false,
        `解析失败（${summary.parseError}）；§6.2：语法损坏是 ERROR，不能伪造 B10 来解释一切`,
      );
    }
    ctx.summaries.set(normalized.ref.path, summary);
    return summary;
  }
}

export function createWorkScanner(options: WorkScannerOptions = {}): WorkScanner {
  return new Scanner(options);
}

export type ScanRunResult =
  | { readonly ok: true; readonly report: ScanReport }
  | { readonly ok: false; readonly code: ScanErrorCode; readonly retryable: boolean };

export type ScanPackageOptions = {
  /** 单个时间片的预算。默认 §6.3 的 8 s。 */
  readonly budgetMs?: number;
  /** 步数硬上限，防驱动 bug 把 CI 挂死。默认 10000。 */
  readonly maxSteps?: number;
  readonly abortSignal?: AbortSignal;
  readonly now?: () => number;
};

/**
 * 一次跑完整包（黑盒验收证明用这个入口）。
 *
 * 它是 `start` / `step` / `finalize` 的循环，**不是**另一套实现：跑到 COMPLETE 才 `finalize`，
 * 中途 ERROR 就如实返回错误码。步数用尽既不返回 PASS 也不编报告，而是 fail-closed 成
 * `SCANNER_RESOURCE_LIMIT`（`retryable: true`：换更长的时间片可以再试）。
 */
export async function scanPackage(
  input: StartScanInput,
  options: ScanPackageOptions = {},
): Promise<ScanRunResult> {
  const scanner = createWorkScanner({ now: options.now });
  const budgetMs = options.budgetMs ?? PACKAGE_LIMITS.sliceBudgetMs;
  const maxSteps = options.maxSteps ?? 10_000;
  const abortSignal = options.abortSignal ?? new AbortController().signal;

  let checkpoint = scanner.start(input);
  for (let step = 0; step < maxSteps; step += 1) {
    const result = await scanner.step({ checkpoint, files: input.files, budgetMs, abortSignal });
    if (result.state === 'ERROR') {
      return { ok: false, code: result.code, retryable: result.retryable };
    }
    if (result.state === 'COMPLETE') {
      return { ok: true, report: await scanner.finalize(result.checkpoint) };
    }
    checkpoint = result.checkpoint;
  }
  return { ok: false, code: 'SCANNER_RESOURCE_LIMIT', retryable: true };
}

export { RULES };

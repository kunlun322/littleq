/**
 * 扫描器对外契约（ZLQ-156 §6.1 / §6.2 冻结原文）。
 *
 * 这里的类型是**规范本身**，不是我的发挥：`FileRef` / `ScanFileSource` / `StartScanInput` /
 * `WorkScanner` 逐字来自 §6.1，`RuleId` / `Finding` / `ScanReport` / `ScanStepResult` 逐字来自 §6.2。
 * 改动它们等于改契约，需要架构师裁定，不在 D3a 范围内。
 *
 * 扫描器是确定性检查服务，**不是新的基础设施 provider 抽象**（§6.1）：它不读 DB / QCA / Blob SDK，
 * 不联网、不写日志正文，输入只有「平台验证过的文件目录索引 + 可重开的文件流」。
 */

import type { BudgetCounters } from './budget.js';
import type { WorkMetadata } from './metadata.js';

// ---------------------------------------------------------------------------
// §6.1 输入形式
// ---------------------------------------------------------------------------

export type FileRole = 'RUNTIME' | 'SOURCE' | 'ASSET';

export type FileRef = {
  path: string;
  role: FileRole;
  bytes: number;
  sha256: string;
  mediaType: string;
  objectRef: string;
};

export type FileRange = { offset: number; length: number };

export interface ScanFileSource {
  list(): readonly FileRef[];
  open(path: string, range?: FileRange): Promise<ReadableStream<Uint8Array>>;
}

/**
 * 准入策略快照。§6.1：仅含准入能力开关/版本、词库/hash，**不含用户 PII / 凭证**。
 *
 * `allowWasm` / `allowPostMessageBridge` 在 v1 是字面量 `false`（ZLQ-153 §8.3「v1 默认禁止 wasm」、
 * B6「v1 默认不开放」）。写成字面量而不是 `boolean`，是为了让类型系统本身就拦住「悄悄打开」——
 * 打开它需要改这个类型，而改这个类型会 reddening 依赖它的测试。
 */
export type ScanPolicySnapshot = {
  /** 策略修订号；参与 `rulesetVersion` 推导（§6.1：不能把权限不同的结果共享同一个缓存 key）。 */
  readonly revision: string;
  /** 成人已批准的敏感能力（ZLQ-153 §8.4：只有成人开启**且** manifest 声明时才放行）。 */
  readonly adultApprovedCapabilities: readonly AdultApprovedCapability[];
  /** 强制的存储键前缀，形如 `littleq:{workId}:`（ZLQ-153 §8.4）。 */
  readonly storageKeyPrefix: string;
  /** 词库修订号；参与 `rulesetVersion` 推导。 */
  readonly lexiconRevision: string;
  /** 已知追踪/上报域名（同形字折叠后的小写 host）。仅作候选召回，不作最终判定。 */
  readonly knownTrackingDomains: readonly string[];
  /** 已知不适宜图片的 sha256（B13 的离线判定；扫描器不联网、不上传学生内容）。 */
  readonly denyListedImageHashes: readonly string[];
  /** v1 冻结为 false：ZLQ-153 §8.3「v1 默认禁止 wasm」。 */
  readonly allowWasm: false;
  /** v1 冻结为 false：B6「v1 默认不开放」跨窗口消息桥。 */
  readonly allowPostMessageBridge: false;
};

export type AdultApprovedCapability = 'CAMERA' | 'MICROPHONE' | 'ACCELEROMETER' | 'GYROSCOPE';

/**
 * 平台已校验的 work.json。§6.1 明确：即使 TypeScript 叫 `Validated`，
 * 扫描器仍要检查 manifest / hash 完整性，不因为类型名就信任网络边界。
 * 结构定义在 `./metadata.js`（ZLQ-156 §1.2 / §1.3 / §1.4）。
 */
export type ValidatedWorkMetadata = WorkMetadata;

export type StartScanInput = {
  artifactHash: string;
  manifestHash: string;
  schemaVersion: string;
  contractVersion: string;
  scannerVersion: string;
  rulesetVersion: string;
  metadata: ValidatedWorkMetadata;
  files: ScanFileSource;
  policySnapshot: ScanPolicySnapshot;
};

// ---------------------------------------------------------------------------
// §6.2 输出与脱敏
// ---------------------------------------------------------------------------

export type RuleId =
  | 'B1'
  | 'B2'
  | 'B3'
  | 'B4'
  | 'B5'
  | 'B6'
  | 'B7'
  | 'B8'
  | 'B9'
  | 'B10'
  | 'B11'
  | 'B12'
  | 'B13';

export const RULE_IDS: readonly RuleId[] = [
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
  'B7',
  'B8',
  'B9',
  'B10',
  'B11',
  'B12',
  'B13',
];

export type Disposition = 'BLOCK' | 'CONFIRM_REQUIRED';

export type Confidence = 'HIGH' | 'LOW';

export type SourceRange = {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

/**
 * 定位。line/column 从 1 开始，**按原始可读文件位置回映**，不用解码后文本位置骗人；
 * 二次解码没有可靠范围时 `location = null`，定位回原始封装节点。JSON Pointer 定位 metadata。
 */
export type FindingLocation = SourceRange | { jsonPointer: string } | null;

export type RepairAction =
  | 'LOCALIZE_RESOURCE'
  | 'REMOVE_NETWORK'
  | 'REMOVE_NAVIGATION'
  | 'REMOVE_SENSITIVE_INPUT'
  | 'MAKE_READABLE'
  | 'CORRECT_CLAIM'
  | 'CHANGE_CONTENT'
  | 'REVIEW_CAPABILITY';

export type Finding = {
  findingId: string;
  ruleId: RuleId;
  disposition: Disposition;
  confidence: Confidence;
  path: string;
  location: FindingLocation;
  explanationKey: string;
  repairAction: RepairAction;
};

export type ScanSummaryEntry = {
  ruleId: RuleId;
  path: string;
  location: FindingLocation;
  explanation: string;
};

export type ScanReport = {
  scanRunId: string;
  inputHash: string;
  confirmationScopeHash: string;
  scannerVersion: string;
  rulesetVersion: string;
  complete: true;
  status: 'PASS' | 'BLOCK' | 'CONFIRM_REQUIRED';
  findings: Finding[];
  counts: { files: number; bytes: number; block: number; confirm: number };
  summary: ScanSummaryEntry[];
};

export type ScanErrorCode =
  | 'INPUT_HASH_MISMATCH'
  | 'PARSER_UNSUPPORTED'
  | 'SCANNER_RESOURCE_LIMIT'
  | 'CHECKPOINT_INVALID';

export type ScanProgress = { filesDone: number; filesTotal: number };

export type ScanStepResult =
  | {
      state: 'CONTINUE';
      checkpoint: ScanCheckpoint;
      progress: ScanProgress;
      newFindings: Finding[];
    }
  | { state: 'COMPLETE'; checkpoint: ScanCheckpoint }
  | { state: 'ERROR'; code: ScanErrorCode; retryable: boolean };

export interface WorkScanner {
  start(input: StartScanInput): ScanCheckpoint;
  step(input: {
    checkpoint: ScanCheckpoint;
    files: ScanFileSource;
    budgetMs: number;
    abortSignal: AbortSignal;
  }): Promise<ScanStepResult>;
  finalize(checkpoint: ScanCheckpoint): Promise<ScanReport>;
}

// ---------------------------------------------------------------------------
// §6.3 checkpoint
// ---------------------------------------------------------------------------

export type ScanPhase =
  | 'INVENTORY'
  | 'NORMALIZE'
  | 'PARSE'
  | 'RESOURCE_GRAPH'
  | 'RULES'
  | 'AGGREGATE'
  | 'COMPLETE';

export const SCAN_PHASES: readonly ScanPhase[] = [
  'INVENTORY',
  'NORMALIZE',
  'PARSE',
  'RESOURCE_GRAPH',
  'RULES',
  'AGGREGATE',
  'COMPLETE',
];

/**
 * 微工作单元游标。§6.3：引用**确定排序**的文件，不是内存 FD —— 跨实例续跑不依赖上一次打开的句柄。
 * `subphase` 让 PARSE/RULES 能在文件内部继续（同一文件的不同语法工作单元）。
 */
export type ScanCursor = {
  fileOrdinal: number;
  byteOffset: number;
  subphase: string;
};

/**
 * 私有持久 checkpoint。§6.3 的字段表逐条落地：
 * schema 固定、不进前端 events、只当前 lease 可以提交。
 *
 * `normalizedRefs` / `parseSummaryRefs` / `resourceGraphRefs` / `findingRefs` 存的是**私有对象的引用**
 * （hash 键），不是对象本身 —— 语法/数据流摘要不含可公开源码，checkpoint 也不该把整棵 AST 背在身上。
 */
export type ScanCheckpoint = {
  scanRunId: string;
  checkpointSchemaVersion: string;
  revision: number;

  artifactHash: string;
  manifestHash: string;
  schemaVersion: string;
  contractVersion: string;
  scannerVersion: string;
  rulesetVersion: string;

  phase: ScanPhase;
  cursor: ScanCursor;
  budgetCounters: BudgetCounters;

  normalizedRefs: Record<string, string>;
  parseSummaryRefs: Record<string, string>;
  resourceGraphRefs: Record<string, string>;

  completedUnits: string[];
  pendingCrossFileEdges: string[];

  findingRefs: Record<string, string>;

  expectedTaskRevision: number;
  leaseFence: string;
  nextRunAt: string;
};

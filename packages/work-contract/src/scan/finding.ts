/**
 * finding 的产出、身份与去重（ZLQ-156 §6.2 输出与脱敏、§6.5 确认范围）。
 *
 * 四条设计约束：
 * 1. **处置上限在这里强制，不在各规则里自觉**。`FindingFactory` 拿到一张 `RuleId → 上限` 表，
 *    `emit` 超限就**抛**（不是静默降级）。为什么必须抛：静默 clamp 会让「把 B12 改成硬拦」这个
 *    变异看不出来 —— 输出仍然是 CONFIRM_REQUIRED，测试仍然绿，而规则已经越权了。
 *    ZLQ-201 的不可协商项 2「B12 上任何硬阻断 = 直接失败」靠这一条结构性成立。
 * 2. **`findingId` 用文件 hash，不用文件路径**（§6.2 原文：HMAC(规则/文件hash/安全位置/规则子类型)）。
 *    路径可能含敏感文件名，而 id 会落库、会进 `confirmationScopeHash`；用 hash 就既不泄露又可复算。
 * 3. **HMAC key 由 `scannerVersion + rulesetVersion` 派生，不含 `scanRunId`**。§6.5 要求确认范围覆盖
 *    「confirm findings 的稳定语义标识集」——如果 key 随 run 变，同一份作品扫两次会得到两套 id，
 *    成人点过的确认就永远对不上。
 * 4. **同一 `(规则, 文件, 位置, 子类型)` 只出一条**。重复命中不是两个问题，是两个计数；
 *    §6.5 的「标识集」和 §8.6 的 precision 分母都会被重复项污染。
 */

import { explanationKeyForRule } from './explanations.js';
import { canonicalJsonHash, hmacOfText, utf8 } from './hash.js';
import type {
  Confidence,
  Disposition,
  Finding,
  FindingLocation,
  RepairAction,
  RuleId,
  ValidatedWorkMetadata,
} from './types.js';

/** 规则允许产出的最高处置。B12 的上限是 `CONFIRM_REQUIRED`（§8.6「B12 始终确认」）。 */
export type DispositionCeiling = Readonly<Record<RuleId, Disposition>>;

const DISPOSITION_RANK: Readonly<Record<Disposition, number>> = {
  CONFIRM_REQUIRED: 1,
  BLOCK: 2,
};

/** 供注册表自检与驱动排序使用：处置的强弱序（§6.2「BLOCK > CONFIRM_REQUIRED > PASS」）。 */
export function dispositionRank(disposition: Disposition): number {
  return DISPOSITION_RANK[disposition];
}

/**
 * **冻结的**处置上限（ZLQ-153 §8.3 逐条）。
 *
 * 它刻意**不从规则自己的 `maxDisposition` 派生**。若上限由规则声明决定，把 B12 改成 BLOCK
 * 就会连上限一起改掉 —— 规则给自己打分，§8 的变异对照 1 永远不会红。写死在这里之后：
 *
 * - 规则试图越界 ⇒ `FindingFactory.emit` 抛 `DispositionCeilingError`（fail-closed，不静默降级）；
 * - 规则把自己的 `maxDisposition` 声明得比这里宽 ⇒ `registryViolations()` 报漂移。
 *
 * 两道闸互相独立，谁也不是另一道的输入。B12 上限是 `CONFIRM_REQUIRED`，
 * 出处是 §8.3「只标记确认，不硬拦」与 §8.6「B12 始终确认」。
 */
export const FROZEN_DISPOSITION_CEILING: DispositionCeiling = {
  B1: 'BLOCK',
  B2: 'BLOCK',
  B3: 'BLOCK',
  B4: 'BLOCK',
  B5: 'BLOCK',
  B6: 'BLOCK',
  B7: 'BLOCK',
  B8: 'BLOCK',
  B9: 'BLOCK',
  B10: 'BLOCK',
  B11: 'BLOCK',
  B12: 'CONFIRM_REQUIRED',
  B13: 'BLOCK',
};

/** key 前缀。写死在源码里：它不是秘密（HMAC 的作用是稳定身份，不是保密），但改动它会使既有 findingId 全部失效。 */
const FINDING_KEY_PREFIX = 'littleq-scanner-v1';

export type FindingDraft = {
  ruleId: RuleId;
  disposition: Disposition;
  confidence: Confidence;
  path: string;
  location: FindingLocation;
  repairAction: RepairAction;
  /** 规则子类型（§6.2）。只进 HMAC，不出现在输出里 —— 输出只有 `ruleId` 和固定的 `explanationKey`。 */
  subType: string;
};

/** 规则试图产出超过其上限的处置。这是实现缺陷，不是扫描结果，所以抛而不是记 finding。 */
export class DispositionCeilingError extends Error {
  readonly code = 'DISPOSITION_CEILING_EXCEEDED';
  readonly ruleId: RuleId;
  readonly attempted: Disposition;
  readonly ceiling: Disposition;

  constructor(ruleId: RuleId, attempted: Disposition, ceiling: Disposition) {
    super(`rule ${ruleId} attempted ${attempted} but its ceiling is ${ceiling}`);
    this.name = 'DispositionCeilingError';
    this.ruleId = ruleId;
    this.attempted = attempted;
    this.ceiling = ceiling;
  }
}

/** 规则报告了一个不在 `fileHashes` 里的路径。同样是实现缺陷。 */
export class UnknownFindingPathError extends Error {
  readonly code = 'UNKNOWN_FINDING_PATH';

  constructor(path: string) {
    super(`finding path is not part of the scanned artifact: ${path}`);
    this.name = 'UnknownFindingPathError';
  }
}

/**
 * 定位的稳定字符串形态。
 *
 * JSON Pointer 与行列**不同形**：§6.5 明确 metadata 定位不能用行列，因为插入可信时间字段
 * （`publicationId` / `publishedAt`）会让 work.json 的行号整体漂移，成人确认就失效了。
 */
export function locationKey(location: FindingLocation): string {
  if (location === null) return '-';
  if ('jsonPointer' in location) return `ptr:${location.jsonPointer}`;
  return `range:${location.line}:${location.column}-${location.endLine}:${location.endColumn}`;
}

export type FindingFactoryInput = {
  scannerVersion: string;
  rulesetVersion: string;
  /** 路径 → 该文件的实测 sha256。必须包含 `work.json`（§1.2：artifact hash 覆盖它）。 */
  fileHashes: Readonly<Record<string, string>>;
  ceiling: DispositionCeiling;
};

export class FindingFactory {
  readonly #fileHashes: Readonly<Record<string, string>>;
  readonly #ceiling: DispositionCeiling;
  readonly #key: Uint8Array;
  readonly #seen = new Set<string>();
  readonly #findings: Finding[] = [];

  constructor(input: FindingFactoryInput) {
    this.#fileHashes = input.fileHashes;
    this.#ceiling = input.ceiling;
    this.#key = utf8(`${FINDING_KEY_PREFIX}|${input.scannerVersion}|${input.rulesetVersion}`);
  }

  get findings(): readonly Finding[] {
    return this.#findings;
  }

  /** 返回产出的 finding；`null` 表示这是一次重复命中，已并入既有条目。 */
  emit(draft: FindingDraft): Finding | null {
    const ceiling = this.#ceiling[draft.ruleId];
    if (DISPOSITION_RANK[draft.disposition] > DISPOSITION_RANK[ceiling]) {
      throw new DispositionCeilingError(draft.ruleId, draft.disposition, ceiling);
    }
    const fileHash = this.#fileHashes[draft.path];
    if (fileHash === undefined) throw new UnknownFindingPathError(draft.path);

    const key = locationKey(draft.location);
    const identity = [draft.ruleId, fileHash, key, draft.subType].join('\u0000');
    if (this.#seen.has(identity)) return null;
    this.#seen.add(identity);

    const finding: Finding = {
      findingId: hmacOfText(this.#key, identity),
      ruleId: draft.ruleId,
      disposition: draft.disposition,
      confidence: draft.confidence,
      path: draft.path,
      location: draft.location,
      explanationKey: explanationKeyForRule(draft.ruleId),
      repairAction: draft.repairAction,
    };
    this.#findings.push(finding);
    return finding;
  }
}

/**
 * §6.5 的「稳定语义标识」：`ruleId + 规范路径 + (JSON Pointer | 源文件 hash + 原始范围)`。
 *
 * 与 `findingId` 是**两个不同的概念**，不能互相替代：`findingId` 还含规则子类型且被 HMAC 包裹，
 * 用于落库主键；这个标识用于成人确认范围的 hash，必须可读地对应「哪一处语义问题」。
 */
export function findingIdentity(finding: Finding, fileHash: string): string {
  const location = finding.location;
  if (location !== null && 'jsonPointer' in location) {
    return [finding.ruleId, finding.path, `ptr:${location.jsonPointer}`].join('\u0000');
  }
  return [finding.ruleId, finding.path, fileHash, locationKey(location)].join('\u0000');
}

export type ConfirmationScopeInput = {
  /**
   * 项目版本身份。§6.1 的 `StartScanInput` 里没有 `projectVersionId`，
   * 而 §1.2 的 `version` 就是 `project_versions.sequence` ⇒ 用 `(workId, version)` 这一对。
   * 这是**声明出来的映射**，不是悄悄假设的。
   */
  workId: string;
  version: number;
  /** 除 `work.json` 外全部文件的实测 hash，按路径排序。 */
  fileHashes: readonly { path: string; sha256: string }[];
  metadata: ValidatedWorkMetadata;
  scannerVersion: string;
  rulesetVersion: string;
  policyRevision: string;
  /** confirm 类 finding 的稳定语义标识集（已排序去重）。 */
  confirmIdentities: readonly string[];
};

/**
 * §6.5 的五项覆盖：① 明确的项目版本身份 ② 除 work.json 外全部文件的实际 hash
 * ③ 完整规范 work.json（**只**去掉 `publicationId` / `publishedAt`）④ 扫描器/规则集/策略修订
 * ⑤ confirm findings 的稳定语义标识集。
 *
 * 去掉那两个字段的原因：它们是发布成功**之后**由平台盖上的可信值。若把它们算进范围，
 * 盖章就会改变 hash，于是「盖章」永远需要一次新的成人点击 —— §6.5 恰好要求只有这两个字段的
 * 最终封印可以跳过重新点击。
 */
export function confirmationScopeHash(input: ConfirmationScopeInput): string {
  const { publicationId: _publicationId, publishedAt: _publishedAt, ...unsealed } = input.metadata;
  return canonicalJsonHash({
    projectVersion: { workId: input.workId, version: input.version },
    fileHashes: [...input.fileHashes]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    manifest: unsealed,
    revisions: {
      scannerVersion: input.scannerVersion,
      rulesetVersion: input.rulesetVersion,
      policyRevision: input.policyRevision,
    },
    confirmIdentities: [...new Set(input.confirmIdentities)].sort(),
  });
}

export type ScanInputHashInput = {
  artifactHash: string;
  manifestHash: string;
  schemaVersion: string;
  contractVersion: string;
  scannerVersion: string;
  rulesetVersion: string;
  policyRevision: string;
  lexiconRevision: string;
};

/**
 * `ScanReport.inputHash`：这次扫描的**全部输入身份**。
 *
 * 它比 §6.3 的缓存 key（`scannerVersion + artifactHash + rulesetVersion`）更宽：缓存 key 决定
 * 「能不能复用上次结论」，inputHash 决定「这份报告说的是哪一次输入」。策略修订与词库修订必须进
 * inputHash（同一份作品在不同策略下结论不同），但不进缓存 key 的推导之外 —— §6.1 已要求
 * 策略修订参与 `rulesetVersion` 推导，所以两者一致。
 */
export function scanInputHash(input: ScanInputHashInput): string {
  return canonicalJsonHash({ ...input });
}

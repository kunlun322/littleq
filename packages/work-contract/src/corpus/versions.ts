/**
 * 语料版本与**规则集指纹**（ZLQ-156 §7.3「判定缓存失效」+ §2.1 首版目标）。
 *
 * ## 为什么 `rulesetVersion` 必须由内容算出来，而不是写死一个字符串
 *
 * §7.3 的判据是「词库/策略/规范化/许可规则**任何一处**变化 ⇒ 判定缓存必须失效」。
 * 如果 `rulesetVersion` 是人手写死的 `'ruleset-v1'`，那么改一个词、调一个熵阈值、
 * 加一个同形字折叠，缓存 key 都**不变** —— 于是「缓存失效」这条永远测不出来：
 * 它不是失效了，是压根没参与。`test/support.ts` 里那个 `RULESET_VERSION='ruleset-test-v1'`
 * 是单元测试的常量，可以写死；语料流水线不行，因为语料的结论要**钉在版本上**复现。
 *
 * 所以这里把规则集的四类输入全部序列化进一个 sha256：
 * 1. **词库**：每条 `LexiconEntry` 的 `id` / `pattern.source` / `flags` / `tier`，以及全部路径表；
 * 2. **策略**：`ScanPolicySnapshot` 里参与判定的字段（词库修订号、追踪域名表、图片 hash 表、两个 v1 冻结开关）；
 * 3. **规范化**：`readability.ts` 的五个阈值常量（熵、行长、标识符比例、最小代码字节、最小标识符数）——
 *    它们是「混淆」的判据，改了等于改规则；
 * 4. **许可规则**：`LEXICON_REVISION`（词库自己的修订号）。
 *
 * 用的是 `src/scan/hash.ts` 的 `canonicalJsonHash`，**不是** `node:crypto`：
 * 语料的哈希必须和被测对象同一套实现，否则「hash 算错了」这种缺陷会同时移动
 * 期望值和实测值，两边一起错就永远对不上账（`package.ts` 里同一条纪律）。
 *
 * ## 版本号只能是 `0.x` / RC
 *
 * ZLQ-210 §2.3.5 要求双人盲标、§2.3.2 要求 ≥1 名 Web 安全 + ≥1 名教育背景标注员。
 * 一次自动化开发运行**只有我**，凑不出第二个人，也就凑不出 κ。所以本语料的版本号
 * 冻结在 `0.x.y-rc.N`，每条标注都带 `annotationMode: 'implementer-pass'`，
 * 整份报告标 **provisional**，并且**不得**声称 §2.3.4 的「一致率 ≥95% / κ ≥0.80」已达成。
 * 把这个常量写成 `1.0.0` 会让下游误以为语料已经过双人盲标准入 —— 那是造假。
 */

import { canonicalJsonHash } from '../scan/hash.js';
import * as lexicon from '../scan/lexicon.js';
import { LEXICON_REVISION } from '../scan/lexicon.js';
import { comparePathBytes } from '../scan/metadata.js';
import {
  ENTROPY_MIN_CODE_BYTES,
  HIGH_ENTROPY_BITS_PER_BYTE,
  MIN_IDENTIFIERS_FOR_RATIO,
  MINIFIED_AVERAGE_LINE_LENGTH,
  UNREADABLE_IDENTIFIER_RATIO,
} from '../scan/readability.js';
import type { ScanPolicySnapshot } from '../scan/types.js';

/**
 * 语料版本。参与每个样例的随机种子（`createRandom(corpusVersion, caseId, salt)`），
 * 所以**改这个字符串 = 重新生成整份语料**，不是换个标签。
 *
 * `0.1.0-rc.1`：`0.x` 表示尚未通过 §2.3.4 的双人盲标准入（见文件头）。
 */
export const CORPUS_VERSION = '0.1.0-rc.1';

/**
 * 标注模式。§2.3 的四个标签（SAFE / HARD_BLOCK / CONFIRM_REQUIRED / NOT_APPLICABLE）
 * 都由**单人、非盲**给出 —— 实现者自己标自己写的样例，既不是第二个人，也没做盲化。
 * 这个字段进每一条 case 的 manifest，让「谁标的」不可能被忘掉。
 */
export const ANNOTATION_MODE = 'implementer-pass' as const;
export type AnnotationMode = typeof ANNOTATION_MODE;

/** §2.3.4 的准入门槛。写在这里是为了让报告能**明确声明未达成**，而不是不提。 */
export const ADMISSION_AGREEMENT_TARGET = 0.95;
export const ADMISSION_KAPPA_TARGET = 0.8;

/**
 * 参与规则集指纹的词库表名。显式列出，避免「新加一张表却忘了进指纹」。
 *
 * **已知覆盖缺口（声明，不自行修补）**：`exif.ts` 里 B13 用的 EXIF GPS tag 常量是模块私有的，
 * 没有导出，因此**不在**本指纹内。改它们不会让 `rulesetVersion` 变化。补上需要给
 * `src/scan/exif.ts` 加导出 —— 那是 D3a 已交付并被接受的扫描器代码，本单不得改动，
 * 所以这里如实记一笔，交架构师裁定是否要在 D4 收口。
 */
const LEXICON_TABLE_NAMES = [
  'CREDENTIAL_PATTERNS',
  'PII_PATTERNS',
  'NETWORK_GLOBAL_NAMES',
  'NETWORK_MEMBER_PATHS',
  'NAVIGATION_LOCATION_SINKS',
  'NAVIGATION_WINDOW_SINKS',
  'FORBIDDEN_LINK_TARGETS',
  'DOWNLOAD_MEMBER_PATHS',
  'CROSS_WINDOW_GLOBAL_NAMES',
  'CROSS_WINDOW_MEMBER_PATHS',
  'POST_MESSAGE_NAMES',
  'SENSITIVE_MEMBER_PATHS',
  'CLIPBOARD_WRITE_PATHS',
  'REFERRER_PATH',
  'GATED_DEVICE_MEMBER_PATHS',
  'STORAGE_ENUMERATION_PATHS',
  'STORAGE_LENGTH_PROPERTIES',
  'STORAGE_OBJECTS',
  'STORAGE_DATABASE_ENUMERATION',
  'STORAGE_DATABASE_PROBE',
  'PII_STRONG_FIELD_CUES',
  'PII_WEAK_FIELD_CUES',
  'FICTIONAL_CONTEXT_CUES',
  'FICTIONAL_SUPPRESSIBLE_IDS',
  'PII_BEARING_ATTRIBUTES',
  'PII_AUTOCOMPLETE_TOKENS',
  'SAFE_AUTOCOMPLETE_TOKENS',
  'MINING_TERMS',
  'TRACKING_TERMS',
  'WASM_NAMES',
  'WORKER_CONSTRUCTORS',
  'HIDDEN_IFRAME_ATTRIBUTES',
  'DYNAMIC_EXEC_NAMES',
  'FUNCTION_CONSTRUCTOR',
  'TIMER_NAMES',
  'PACKER_SIGNATURES',
  'SCRIPT_SCHEME_PATTERN',
  'HTML_EVENT_HANDLER_ATTRIBUTE_PATTERN',
  'DYNAMIC_SCRIPT_ASSEMBLY_PROPERTIES',
  'AI_PROVIDER_TERMS',
  'CAPABILITY_CLAIM_TERMS',
  'CLAIM_NEGATION_CUES',
  'SENTENCE_BOUNDARY_PATTERN',
  'INAPPROPRIATE_HIGH',
  'INAPPROPRIATE_LOW',
  'MEDIA_TYPE_ADMISSION',
  'ALLOWED_DATA_MEDIA_TYPES',
  'HTML_RESOURCE_ATTRIBUTES',
  'ALWAYS_RESOURCE_ATTRIBUTES',
  'CSS_IMPORT_AT_RULES',
  'JS_RESOURCE_CALLEES',
] as const;

/**
 * 把一张词库表序列化成一个可哈希的形状。
 *
 * 表有两种形态：`readonly LexiconEntry[]`（带 `pattern`）和 `readonly string[]`（路径表）。
 * 正则必须取 `source` + `flags`，**不能**取 `String(regex)` 之外再拼接 —— 直接 JSON 化
 * 一个 `RegExp` 会得到 `{}`，指纹就退化成「表存在」而不是「表内容」。
 */
function tableFingerprint(name: string): unknown {
  const table = (lexicon as unknown as Record<string, unknown>)[name];
  if (table === undefined) throw new Error(`词库表不存在或没导出：${name}`);
  if (table instanceof RegExp) return { kind: 'regex', source: table.source, flags: table.flags };
  if (typeof table === 'string') return { kind: 'string', value: table };
  if (!Array.isArray(table)) throw new Error(`词库表形状不认识：${name}`);
  return {
    kind: 'array',
    items: table.map((item: unknown) => {
      if (typeof item === 'string') return { kind: 'string', value: item };
      if (item instanceof RegExp) return { kind: 'regex', source: item.source, flags: item.flags };
      const record = item as Record<string, unknown>;
      const pattern = record['pattern'];
      const shape: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        if (key === 'pattern') continue;
        const value = record[key];
        shape[key] =
          typeof value === 'object' && value !== null && 'path' in value
            ? JSON.stringify(value)
            : (value as string | number | boolean);
      }
      if (pattern instanceof RegExp) {
        shape['pattern'] = { source: pattern.source, flags: pattern.flags };
      } else if (Array.isArray(pattern)) {
        shape['pattern'] = pattern.map((p) =>
          p instanceof RegExp ? p.source + p.flags : String(p),
        );
      }
      return { kind: 'entry', shape };
    }),
  };
}

/** 策略里真正参与判定的字段。PII / 凭证按 §6.1 根本不进快照，这里也不进指纹。 */
function policyFingerprint(policy: ScanPolicySnapshot): unknown {
  return {
    revision: policy.revision,
    lexiconRevision: policy.lexiconRevision,
    adultApprovedCapabilities: [...policy.adultApprovedCapabilities].sort(),
    storageKeyPrefix: policy.storageKeyPrefix,
    knownTrackingDomains: [...policy.knownTrackingDomains].sort(),
    denyListedImageHashes: [...policy.denyListedImageHashes].sort(),
    allowWasm: policy.allowWasm,
    allowPostMessageBridge: policy.allowPostMessageBridge,
  };
}

export type RulesetFingerprint = {
  /** 全部四类输入序列化后的 sha256（hex）。 */
  readonly hash: string;
  /** 词库修订号（§8.6：改词库就是改规则）。 */
  readonly lexiconRevision: string;
  /** 进指纹的词库表数量。少一张表就是指纹退化，测试会钉住这个数。 */
  readonly lexiconTableCount: number;
  /** 规范化阈值。写进报告，让「混淆判据变了」这件事肉眼可见。 */
  readonly readabilityThresholds: {
    readonly minifiedAverageLineLength: number;
    readonly highEntropyBitsPerByte: number;
    readonly entropyMinCodeBytes: number;
    readonly unreadableIdentifierRatio: number;
    readonly minIdentifiersForRatio: number;
  };
};

/**
 * 计算规则集指纹。**纯函数**：同样的词库 + 策略 + 阈值 ⇒ 同样的 hash。
 */
export function rulesetFingerprint(policy: ScanPolicySnapshot): RulesetFingerprint {
  const tables: Record<string, unknown> = {};
  for (const name of LEXICON_TABLE_NAMES) tables[name] = tableFingerprint(name);

  const readabilityThresholds = {
    minifiedAverageLineLength: MINIFIED_AVERAGE_LINE_LENGTH,
    highEntropyBitsPerByte: HIGH_ENTROPY_BITS_PER_BYTE,
    entropyMinCodeBytes: ENTROPY_MIN_CODE_BYTES,
    unreadableIdentifierRatio: UNREADABLE_IDENTIFIER_RATIO,
    minIdentifiersForRatio: MIN_IDENTIFIERS_FOR_RATIO,
  };

  const payload = {
    schema: 'littleq-ruleset-fingerprint-v1',
    lexiconRevision: LEXICON_REVISION,
    tables,
    policy: policyFingerprint(policy),
    readabilityThresholds,
  };

  return {
    hash: canonicalJsonHash(payload),
    lexiconRevision: LEXICON_REVISION,
    lexiconTableCount: LEXICON_TABLE_NAMES.length,
    readabilityThresholds,
  };
}

/**
 * 语料用的 `rulesetVersion`。§6.1：不能把权限不同的结果共享同一个缓存 key，
 * 所以它必须是指纹的函数 —— 前缀固定，后 16 位来自指纹 hash。
 */
export function corpusRulesetVersion(policy: ScanPolicySnapshot): string {
  return `ruleset-corpus-${rulesetFingerprint(policy).hash.slice(0, 16)}`;
}

/** 语料用的 `scannerVersion`。扫描器代码变了它就得变，所以取扫描器源文件的清单 hash。 */
export const CORPUS_SCANNER_VERSION_PREFIX = 'scanner-corpus';

/**
 * 参与扫描器指纹的一个源文件：包内相对路径 + 实测 sha256。
 *
 * 只收 `path` 与 `sha256` 两个字段，不收内容：**指纹要能被写进报告**，而报告里出现
 * 扫描器源码正文既没有必要，也会把 §2.1 的载体纪律（有害字符串不落盘、不打印）
 * 牵连到一份本来干净的清单上。
 */
export type ScannerSourceFile = {
  readonly path: string;
  readonly sha256: string;
};

/**
 * 由扫描器源文件清单算出 `scannerVersion`。**纯函数**：不读文件系统。
 *
 * ## 为什么是「源文件清单 hash」而不是 `package.json` 里的版本号
 *
 * §2.5 要求 corpus / ruleset / scanner **各有独立的 semver 与内容哈希**，且 CI 报告把三者
 * 一起钉住。`packages/work-contract/package.json` 的版本号是发包节奏，不是判定语义：
 * 改一行 B7 的词法判据不必发新版，而发一次新版也不必改判定。拿它当 `scannerVersion`，
 * 就等于让「判定缓存失效」这条判据挂在一个人手维护、且与判定无关的数字上 ——
 * 与 `rulesetVersion` 那条同一个错误（见本文件开头）。
 *
 * 所以这里对 `src/scan/**` 的**每一个源文件**取 sha256，排序后整体哈希：
 * 任何一个字节变化 ⇒ `scannerVersion` 变化 ⇒ 判定缓存 key 变化 ⇒ 旧判定不被复用。
 *
 * ## 为什么必须是纯函数
 *
 * 读文件系统的那一步留在 runner 里（`scripts/lib.mjs`）。这样：
 * - 本模块可以在 vitest 里被直接调用（vitest 不跑 runner）；
 * - 「哪些文件算扫描器源码」这个**选择**是 runner 的策略，可以被单测钉住，
 *   而「给定清单算出哪个版本」是算法，必须与策略分离，否则换个 runner 就换个版本。
 *
 * ## 排序用 `comparePathBytes`，不用 `localeCompare`
 *
 * `localeCompare` 的结果依赖运行时 locale：同一份清单在不同机器上可能排出不同顺序，
 * 于是 hash 不同，于是「复现」变成看运气。`comparePathBytes` 是 §6.4 那条
 * 「清单按路径字节序」的同一个比较函数，跨平台确定。
 */
export function corpusScannerVersion(files: readonly ScannerSourceFile[]): string {
  const sorted = [...files].sort((left, right) => comparePathBytes(left.path, right.path));
  const hash = canonicalJsonHash({
    schema: 'littleq-scanner-fingerprint-v1',
    files: sorted.map((file) => ({ path: file.path, sha256: file.sha256 })),
  });
  return `${CORPUS_SCANNER_VERSION_PREFIX}-${hash.slice(0, 16)}`;
}

export type VersionTriple = {
  readonly corpusVersion: string;
  readonly scannerVersion: string;
  readonly rulesetVersion: string;
  readonly rulesetFingerprintHash: string;
  readonly annotationMode: AnnotationMode;
  /** §2.3.4 的准入是否达成。本语料恒为 false（单人非盲，见文件头）。 */
  readonly admissionMet: false;
  /** 报告状态。单人标注 ⇒ 只能是 provisional。 */
  readonly reportStatus: 'provisional';
};

/**
 * 三个版本号 + 内容哈希。**每一样例、每一份报告都要带上它**，否则「这份数字是哪版规则测的」
 * 就只能靠猜，而猜出来的复现不是复现。
 */
export function versionTriple(policy: ScanPolicySnapshot, scannerVersion: string): VersionTriple {
  const fingerprint = rulesetFingerprint(policy);
  return {
    corpusVersion: CORPUS_VERSION,
    scannerVersion,
    rulesetVersion: `ruleset-corpus-${fingerprint.hash.slice(0, 16)}`,
    rulesetFingerprintHash: fingerprint.hash,
    annotationMode: ANNOTATION_MODE,
    admissionMet: false,
    reportStatus: 'provisional',
  };
}

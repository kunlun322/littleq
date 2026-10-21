import {
  assertNotSensitiveText,
  brand,
  DomainError,
  parseAttempt,
  parseArtifactDigest,
  parseArtifactRef,
  parseTaskId,
  parseTimestamp,
  textValueObject,
  type ArtifactDigest,
  type ArtifactRef,
  type Branded,
  type TaskId,
  type Timestamp,
} from '@littleq/domain';
import type { ScanCheckpoint, ScanStepResult, StartScanInput } from '@littleq/work-contract';

/**
 * `task_private` 的完整记录（ZLQ-216 §3.2）。
 *
 * §3.2 的表尾逐字写着：「`task_private` 是本增量的数据库实现，**不伪称旧端口已经
 * 提供了这些字段**。」所以这个类型是**新增的**，不是把某个既有端口类型改个名 ——
 * 它承载的正是那些不能进 Task DTO 的东西：provider 的 Session/事件游标、恢复子阶段、
 * 外呼 journal、固化游标、扫描 checkpoint 与原 step 错误。
 *
 * ## 分层：这里只有形状，没有编排
 *
 * §10.2 的归属划分是「application 内部由 F1 拥有 ports、F2 拥有 use-cases」。本文件
 * 属于 ports 一侧：它定义**存什么**，不定义**什么时候推进到哪一步**。推进顺序在
 * domain 的状态机与 §5.2 的子阶段表里，由 F2 的用例驱动。
 *
 * ## 明文红线
 *
 * 原 prompt、provider 原始回执、PAT 一律不进这张表（§5.3「不包含 PAT」、
 * ZLQ-153 §5 关于 prompt 全文的禁令）。prompt 与配置只以 `inputRef` 指向的
 * **私有对象**存在，DB 侧只留引用与扫描输入身份。
 */

/**
 * `internal_subphase text`。
 *
 * 刻意是**有界文本**而不是枚举：§5.2 固定了这一列的存在与用途（记录"停在哪个恢复
 * 子阶段做只读对账"），但**没有**枚举取值 —— 取值随用例演进而变，归 F2。在这里
 * 编一份枚举会造成第二个事实源，而 F2 每加一个子阶段都要回来改 F1 的文件。
 * 边界（1..64、无控制字符、非纯空白）由 domain 的 `textValueObject` 统一给出。
 */
const internalSubphaseValue = textValueObject('InternalSubphase', 1, 64);
export type InternalSubphase = ReturnType<typeof internalSubphaseValue.parse>;
export const isInternalSubphase = internalSubphaseValue.is;
export const parseInternalSubphase = internalSubphaseValue.parse;

/**
 * `input_ref jsonb`：固定 prompt / 配置快照所在的**私有输入对象**（§3.4 步骤 2
 * 「固定 prompt/配置快照先写私有输入对象」）。
 *
 * `objectRef` 用 domain 的 `ArtifactRef`：它自带 `assertNotSensitiveText`，
 * 因此签名 URL / `password=` 这类形状在构造期就被拒，而不是等到写日志时靠 redactor
 * 补救。`sha256` 让"读回来的对象就是我写进去的那个"可验证 —— §3.3 要求
 * 「不得 head/ETag 冒充摘要」，这条同理。
 */
export type TaskInputRef = {
  readonly objectRef: ArtifactRef;
  readonly sha256: ArtifactDigest;
  readonly byteLength: number;
};

export function createTaskInputRef(input: {
  readonly objectRef: string;
  readonly sha256: string;
  readonly byteLength: number;
}): TaskInputRef {
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw DomainError.invalid('TaskInputRef.byteLength');
  }
  return {
    objectRef: parseArtifactRef(input.objectRef),
    sha256: parseArtifactDigest(input.sha256),
    byteLength: input.byteLength,
  };
}

/**
 * `input_snapshot jsonb`：重放同一份扫描输入所需的**身份字段**。
 *
 * 只取 §5.4 明令要求的那部分 —— 「冷实例先用同一 StartScanInput 再 start 注册」。
 * 冷实例上 `scan_checkpoint` 还是 null，能重建注册身份的只有这份快照，所以它必须
 * 与 checkpoint **分开**存：把身份藏在 checkpoint 里，恰好会让最需要它的那一刻
 * （还没有 checkpoint）拿不到它。
 *
 * 字段取自 `StartScanInput` 本身（`Pick`），不是另抄一遍名字：work-contract 改了
 * 字段名，这里跟着编译报错，不会静默漂移。
 */
export type ScanInputIdentity = Pick<
  StartScanInput,
  | 'artifactHash'
  | 'manifestHash'
  | 'schemaVersion'
  | 'contractVersion'
  | 'scannerVersion'
  | 'rulesetVersion'
>;

export type TaskInputSnapshot = {
  readonly scanInput: ScanInputIdentity;
};

/**
 * `operation_journal jsonb` 的意图状态。
 *
 * 三态直接来自 §5.3 的固定顺序：「外呼前事务保存意图，事务外请求，回执先持久化，
 * 再更新 task」—— `INTENDED` 是"意图已落库、还没发"，`SENT` 是"已发出、回执未确认"，
 * `RECEIPT_RECORDED` 是"回执已落库"。
 *
 * `SENT` 与 `INTENDED` 必须分开，因为它们是 §5.3 那条禁令的判据：
 * 「**未确认写调用结果时，停在恢复子阶段做只读对账，不换 key、不新建第二 Session**。」
 * 只记录"有没有回执"就无法区分"从没发过（可以安全重发）"与"可能已经发过（只能对账）"，
 * 而把后者当成前者重发，正是要避免的第二次付费外呼。
 */
export const OPERATION_INTENT_STATES = ['INTENDED', 'SENT', 'RECEIPT_RECORDED'] as const;
export type OperationIntentState = (typeof OPERATION_INTENT_STATES)[number];

/**
 * provider 回执。**不含 PAT**（§5.3）。
 *
 * 形态是字符串字典而不是某个 provider 的具体 DTO：journal 要同时容纳 QCA 的
 * Session 回执与百炼的图像回执，给每种回执定义一个联合类型会让 F2 每接一个 provider
 * 就回来改 F1 的文件。字典 + 规范序列化（见 `canonicalOperationReceipt`）已经足够
 * 支撑 §3.5 的幂等判定：「同回执幂等、异回执拒绝」。
 */
export type OperationReceipt = Readonly<Record<string, string>>;

/**
 * 回执的规范序列化，用作幂等比较基准。
 *
 * 键按码位排序后逐对拼接，不用 `JSON.stringify` 整个对象：后者的键序取决于对象
 * 自身的插入顺序，同一份回执经两条代码路径构造出来就可能得到两个字符串。
 * §5.3 要求「payload 不因重开/当前时间/随机重新变动」，比较基准必须先满足这一点。
 */
export function canonicalOperationReceipt(receipt: OperationReceipt): string {
  return Object.keys(receipt)
    .sort()
    .map((key) => `${key.length}:${key}=${receipt[key]?.length ?? 0}:${receipt[key] ?? ''}`)
    .join('\n');
}

/**
 * journal 的操作键。
 *
 * §5.3 逐字区分了两种键：domain 的 `OperationKey` 仍是 `${taskId}:${TaskStage}:${attempt}`，
 * 而「外部 journal 操作 key 另按 taskId＋内部操作名＋attempt＋ordinal 派生」。
 * 两者不通用 —— 同一个 stage 内可以有多个内部操作（创建 Session、发送消息、拉事件），
 * 只用 stage 无法把它们分开，而分不开就没法对单个操作做幂等。
 */
export type JournalOperationKey = Branded<string, 'JournalOperationKey'>;

export const JOURNAL_OPERATION_KEY_SEPARATOR = ':';

/** 内部操作名：一段不含分隔符与控制字符的短标识。 */
const journalOperationValue = textValueObject('JournalOperation', 1, 64);
export type JournalOperation = ReturnType<typeof journalOperationValue.parse>;
export const parseJournalOperation = journalOperationValue.parse;

export function formatJournalOperationKey(input: {
  readonly taskId: string;
  readonly operation: string;
  readonly attempt: number;
  readonly ordinal: number;
}): JournalOperationKey {
  const taskId = parseTaskId(input.taskId);
  const operation = journalOperationValue.parse(input.operation);
  const attempt = parseAttempt(input.attempt);
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
    throw DomainError.invalid('JournalOperationKey.ordinal');
  }
  if (operation.includes(JOURNAL_OPERATION_KEY_SEPARATOR)) {
    throw DomainError.invalid('JournalOperation');
  }
  assertNotSensitiveText(operation, 'JournalOperation');
  return brand<string, 'JournalOperationKey'>(
    [taskId, operation, String(attempt), String(input.ordinal)].join(
      JOURNAL_OPERATION_KEY_SEPARATOR,
    ),
  );
}

/**
 * Identity / Template / Environment 与版本快照（§5.3）。
 *
 * 存快照而不是存"当前配置"：外呼是**可能重放**的，重放时必须用当初那一套身份，
 * 否则运维中途改配置会让同一个 task 的两次外呼落到两个不同的 Template 上，
 * journal 就不再是那次外呼的证据。
 */
export type ProviderIdentitySnapshot = {
  readonly identityId: string;
  readonly templateId: string;
  readonly environmentId: string;
  readonly templateVersion: string;
};

export type OperationJournalEntry = {
  readonly operationKey: JournalOperationKey;
  /** 规范请求 hash。不含 PAT、不含 prompt 全文。 */
  readonly requestHash: string;
  /** 原外部 key：发给 provider 的那个幂等键，用于对账时认出是哪一次外呼。 */
  readonly externalKey: string;
  readonly providerSnapshot: ProviderIdentitySnapshot;
  readonly intent: OperationIntentState;
  readonly receipt: OperationReceipt | null;
  readonly recordedAt: Timestamp;
};

/**
 * `collection_cursor jsonb`（§3.4 步骤 4）。
 *
 * 「一个短步最多处理一个文件」⇒ `sealedPaths` 每步至多追加一项，因此它的长度就是
 * 已固化的文件数，重入时据此知道"下一个该做谁"。`artifactSha256` 钉住这个游标属于
 * 哪一件作品：换了作品还沿用旧游标，等于把上一件作品的完成项算到这一件头上。
 */
export type CollectionCursor = {
  readonly artifactSha256: ArtifactDigest;
  readonly sealedPaths: readonly string[];
};

export function createCollectionCursor(input: {
  readonly artifactSha256: string;
  readonly sealedPaths?: readonly string[];
}): CollectionCursor {
  return {
    artifactSha256: parseArtifactDigest(input.artifactSha256),
    sealedPaths: [...(input.sealedPaths ?? [])],
  };
}

/**
 * `scan_failure jsonb`（§5.2）：「私有 task_private 另存
 * `scan_failure:{code:ScanErrorCode,retryable:boolean}|null`，记录原 step 结果；
 * 不 finalize 成报告、不写版本、不发预览」。
 *
 * 用 `Omit<Extract<…>>` 从 `ScanStepResult` 的 ERROR 分支**派生**，而不是照抄两个
 * 字段名：work-contract 若给 ERROR 分支加字段，这里编译报错，逼出一次显式决定
 * 「新字段要不要落库」，而不是静默少存一项。
 */
export type ScanFailureRecord = Omit<Extract<ScanStepResult, { readonly state: 'ERROR' }>, 'state'>;

/** `task_private` 整行。字段与 §3.2 的列一一对应，nullable 也一一对应。 */
export type TaskPrivateRecord = {
  readonly taskId: TaskId;
  readonly inputRef: TaskInputRef;
  readonly qcaSessionId: string | null;
  readonly qcaEventCursor: string | null;
  readonly roundBoundary: string | null;
  readonly internalSubphase: InternalSubphase;
  readonly operationJournal: readonly OperationJournalEntry[];
  readonly collectionCursor: CollectionCursor;
  readonly scanCheckpoint: ScanCheckpoint | null;
  readonly scanFailure: ScanFailureRecord | null;
  readonly inputSnapshot: TaskInputSnapshot;
};

export function createTaskPrivateRecord(input: {
  readonly taskId: string;
  readonly inputRef: TaskInputRef;
  readonly qcaSessionId?: string | null;
  readonly qcaEventCursor?: string | null;
  readonly roundBoundary?: string | null;
  readonly internalSubphase: string;
  readonly operationJournal?: readonly OperationJournalEntry[];
  readonly collectionCursor: CollectionCursor;
  readonly scanCheckpoint?: ScanCheckpoint | null;
  readonly scanFailure?: ScanFailureRecord | null;
  readonly inputSnapshot: TaskInputSnapshot;
}): TaskPrivateRecord {
  const journal = [...(input.operationJournal ?? [])];
  const seen = new Set<string>();
  for (const entry of journal) {
    if (seen.has(entry.operationKey)) {
      throw DomainError.invalid('OperationJournalEntry.operationKey');
    }
    seen.add(entry.operationKey);
    parseTimestamp(entry.recordedAt);
  }
  return {
    taskId: parseTaskId(input.taskId),
    inputRef: input.inputRef,
    qcaSessionId: input.qcaSessionId ?? null,
    qcaEventCursor: input.qcaEventCursor ?? null,
    roundBoundary: input.roundBoundary ?? null,
    internalSubphase: parseInternalSubphase(input.internalSubphase),
    operationJournal: journal,
    collectionCursor: input.collectionCursor,
    scanCheckpoint: input.scanCheckpoint ?? null,
    scanFailure: input.scanFailure ?? null,
    inputSnapshot: input.inputSnapshot,
  };
}

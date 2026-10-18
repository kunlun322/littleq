import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_STATUSES,
  ACHIEVEMENT_CODE_MAX_LENGTH,
  ACHIEVEMENT_RULE_KINDS,
  ACHIEVEMENT_TITLE_MAX_LENGTH,
  AGE_BANDS,
  ARTIFACT_REF_MAX_LENGTH,
  ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH,
  ASSIGNMENT_STATUSES,
  ASSIGNMENT_TITLE_MAX_LENGTH,
  BUILD_STATUSES,
  CAPABILITIES,
  CONTENT_REF_MAX_LENGTH,
  COURSE_STATUSES,
  COURSE_TITLE_MAX_LENGTH,
  DomainError,
  EXTERNAL_OPERATION_KEY_SEPARATOR,
  GENERATION_CONTEXT_REF_MAX_LENGTH,
  GRADE_FEEDBACK_MAX_LENGTH,
  GROUP_KINDS,
  GROUP_NAME_MAX_LENGTH,
  GROUP_STATUSES,
  HARD_DEADLINE_MINUTES,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  LEARNING_PROGRESS_STATES,
  LEASE_SCAN_INTERVAL_MINUTES,
  LEDGER_EVENT_KEY_MAX_LENGTH,
  LESSON_TITLE_MAX_LENGTH,
  LOGIN_NAME_MAX_LENGTH,
  MODEL_ID_MAX_LENGTH,
  NICKNAME_MAX_LENGTH,
  OPERATOR_NOTE_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PROJECT_RESTORE_WINDOW_DAYS,
  PROJECT_STATUSES,
  PROJECT_TITLE_MAX_LENGTH,
  PROMPT_MAX_LENGTH,
  PROMPT_MIN_LENGTH,
  PROVIDER_REQUEST_ID_MAX_LENGTH,
  PUBLICATION_STATUSES,
  RESERVATION_STATES,
  RESTORABLE_PROJECT_STATUSES,
  RETRYABLE_ENTRY_TASK_STATES,
  ROLES,
  RUBRIC_CRITERION_KEY_MAX_LENGTH,
  RUBRIC_CRITERION_LABEL_MAX_LENGTH,
  RUNTIME_REF_MAX_LENGTH,
  SCAN_STATUSES,
  SECRET_KINDS,
  SECRET_REF_MAX_LENGTH,
  SOFT_DEADLINE_SECONDS_COMPLEX,
  SOFT_DEADLINE_SECONDS_SIMPLE,
  SOURCE_EVENT_KEY_MAX_LENGTH,
  SUBMISSION_STATUSES,
  TASK_EVENT_TYPES,
  TASK_KINDS,
  TASK_REPAIR_BUDGET,
  TASK_STAGES,
  TASK_STATES,
  TERMINAL_RESERVATION_STATES,
  TERMINAL_TASK_STATES,
  USAGE_PERIODS,
  USAGE_PROVIDERS,
  USAGE_UNITS,
  VISIBILITIES,
  WORK_RESTORE_WINDOW_DAYS,
  WORK_STATUSES,
  WORK_TYPES,
  WRITE_TASK_KINDS,
  assertNotSensitiveText,
  assertProviderUsageCoherent,
  assertPublishableVersion,
  assertReservationOutlivesTask,
  assertRestorableVersion,
  assertRetryableEntryState,
  brand,
  canAddMember,
  canLikeToday,
  canRequestRepair,
  canServePublicWork,
  capabilityOfTaskKind,
  compareRevisions,
  compareTimestamps,
  createAchievementRule,
  createGroupSettings,
  createProviderUsage,
  createRubric,
  createSafeScanSummary,
  createSecretMetadata,
  detectSensitiveText,
  etagMatches,
  formatETag,
  formatExternalOperationKey,
  formatRevision,
  formatTaskEventId,
  hasAttemptsLeft,
  integerValueObject,
  isAcceptablePasswordLength,
  isAcceptablePromptLength,
  isAccountStatus,
  isAchievementCode,
  isAchievementRuleKind,
  isAchievementTitle,
  isAgeBand,
  isArtifactDigest,
  isArtifactRef,
  isAssignmentInstructions,
  isAssignmentStatus,
  isAssignmentTitle,
  isBefore,
  isBuildStatus,
  isCapability,
  isContentRef,
  isContractVersion,
  isCourseStatus,
  isCourseTitle,
  isCursor,
  isETag,
  isErrorDigest,
  isForbiddenSafeKey,
  isGenerationContextRef,
  isGradeFeedback,
  isGroupKind,
  isGroupName,
  isGroupStatus,
  isIdempotencyKey,
  isLearningProgressState,
  isLedgerEventKey,
  isLessonTitle,
  isLockThresholdReached,
  isLoginName,
  isMemberRole,
  isModelId,
  isNickname,
  isOperatorNote,
  isProgress,
  isProjectStatus,
  isProjectTitle,
  isProviderRequestId,
  isPublishableVersion,
  isPublicationStatus,
  isRequestHash,
  isReservationState,
  isRestorableProjectStatus,
  isRestorableVersion,
  isRetryableEntryState,
  isRevocablePublication,
  isRole,
  isRuleTriggerable,
  isRuntimeRef,
  isSafeEntry,
  isSafeKey,
  isSafeScalar,
  isScanStatus,
  isScoreWithinRubric,
  isSecretKind,
  isSecretRef,
  isSensitiveText,
  isSlug,
  isSourceEventKey,
  isSubmissionStatus,
  isTaskEventId,
  isTaskEventType,
  isTaskKind,
  isTaskStage,
  isTaskState,
  isTerminalReservationState,
  isTerminalTaskState,
  isTimezone,
  isTimestamp,
  isUsagePeriod,
  isUsageProvider,
  isUsageUnit,
  isUuidV7,
  isVersionSequence,
  isVisibility,
  isWithinRestoreWindow,
  isWithinWorkRestoreWindow,
  isWorkStatus,
  isWorkType,
  isWriteTaskKind,
  loginNameKey,
  MEMBER_ROLES,
  nextRevision,
  nextTaskEventId,
  opaquePasswordDigest,
  parseAchievementCode,
  parseAchievementId,
  parseAchievementThreshold,
  parseArtifactDigest,
  parseAssignmentId,
  parseAttempt,
  parseContractVersion,
  parseCourseId,
  parseCredits,
  parseCursor,
  parseDurationMs,
  parseDueAt,
  parseErrorDigest,
  parseEstimatedMinutes,
  parseExternalOperationKey,
  parseFindingCount,
  parseGradingId,
  parseGroupId,
  parseGrowthLevel,
  parseIdempotencyKey,
  parseLedgerEventKey,
  parseLessonId,
  parseLessonSequence,
  parseLikeDailyLimit,
  parseLockDurationMinutes,
  parseLoginName,
  parseMaxAttempts,
  parseMaxFailedAttempts,
  parseMemberLimit,
  parsePoints,
  parseProgress,
  parseProjectId,
  parseProjectVersionId,
  parsePublicationId,
  parseRepairCount,
  parseRequestHash,
  parseRevision,
  parseScore,
  parseSecretKind,
  parseSlug,
  parseSubmissionId,
  parseTaskEventId,
  parseTaskId,
  parseTemplateId,
  parseTimezone,
  parseTimezoneOffsetMinutes,
  parseTimestamp,
  parseUsageLedgerEntryId,
  parseUsageLimitId,
  parseUsageQuantity,
  parseUsageReservationId,
  parseUserId,
  parseUuidV7,
  parseVersionSequence,
  parseWorkId,
  periodKey,
  plusDaysUtc,
  providerOfCapability,
  remainingMemberSlots,
  revisionFromETag,
  sameKey,
  stringEnum,
  textValueObject,
  timestampSortKey,
  unitOfCapability,
  type AccountLockPolicy,
  type BuildStatus,
  type Capability,
  type PublicationStatus,
  type ScanStatus,
  type TaskKind,
  type TaskStage,
  type Timestamp,
  type Visibility,
  type WorkStatus,
} from '../src/index.js';
import { EPOCH, digestAt, thrownDomainError, thrownMessage, uuidAt } from './support.js';

/**
 * 值对象层的验收测试。
 *
 * 三件事在这里被钉住：
 *
 * 1. **边界即契约**。每个长度/数值上限都是传输契约（附录 A §5.5）或冻结 PRD 里的
 *    产品数值，因此测试用字面量写死期望值，而不是从被测模块反读 —— 反读只能证明
 *    「代码等于代码」，改错了也照样绿。
 * 2. **抛什么错决定它变成什么 HTTP 响应**。`DomainError` 会被 adapter 映射成 §5.2
 *    的错误码，普通 `Error` 不会；把配置错误伪装成 400 等于让学生的请求为运维的
 *    部署问题背锅，所以「哪些守卫抛普通 Error」本身是被测行为。
 * 3. **被拒绝的值绝不回流**。`DomainError` 结构上不存在承载原文的字段，测试断言
 *    错误消息的逐字节内容，而不是「大概没泄漏」。
 *
 * 所有期望值都是字面量或由 `support.ts` 的字面量确定性派生，没有一个来自宿主状态
 * （当前时间、时区、环境变量、`node_modules`）—— 附录 A G6。
 */

const EPOCH_TS: Timestamp = parseTimestamp(EPOCH);

/** 一天后的时间戳，供窗口/时限类断言复用。 */
const NEXT_DAY: Timestamp = parseTimestamp('2026-03-02T00:00:00.000Z');

function repeat(char: string, count: number): string {
  return char.repeat(count);
}

describe('brand：品牌只存在于类型层', () => {
  it('运行时原样返回入参，因此序列化与比较都不需要适配', () => {
    expect(brand<string, 'Probe'>('abc')).toBe('abc');
    expect(brand<number, 'Probe'>(7)).toBe(7);
  });

  it('parse 出来的值对象与裸值全等（不是包装对象）', () => {
    expect(parseTimestamp(EPOCH)).toBe(EPOCH);
    expect(parseRevision('3')).toBe('3');
    expect(parseProgress(42)).toBe(42);
  });

  it('不把品牌符号暴露到公共出口', () => {
    // `VALUE_OBJECT_BRAND` 是模块私有 symbol：品牌若可被外部构造，parse 就不再是唯一入口。
    expect(Object.getOwnPropertySymbols(parseTimestamp(EPOCH))).toEqual([]);
  });
});

describe('stringEnum：枚举声明顺序就是 OpenAPI enum 顺序', () => {
  it('members 原样保留，不被排序', () => {
    const probe = stringEnum('Probe', ['ZEBRA', 'APPLE', 'MANGO'] as const);
    expect(probe.members).toEqual(['ZEBRA', 'APPLE', 'MANGO']);
  });

  it('is 只接受成员，parse 对非成员抛 REQUEST_INVALID 并带上值对象名', () => {
    const probe = stringEnum('Probe', ['A', 'B'] as const);
    expect(probe.is('A')).toBe(true);
    expect(probe.is('a')).toBe(false);
    expect(probe.is('C')).toBe(false);
    const error = thrownDomainError(() => probe.parse('C'));
    expect(error.code).toBe('REQUEST_INVALID');
    expect(error.valueObject).toBe('Probe');
    expect(error.message).toBe('REQUEST_INVALID: Probe');
  });

  it('空成员表与重复成员是配置错误，抛普通 Error 而不是 DomainError', () => {
    expect(() => stringEnum('Empty', [])).toThrow('empty enum: Empty');
    expect(() => stringEnum('Dup', ['A', 'A'] as const)).toThrow('duplicate enum member in Dup');
  });

  it('领域枚举的成员与顺序逐字固定（顺序改动会产生快照 diff）', () => {
    expect(ROLES).toEqual(['OWNER', 'STUDENT']);
    expect(ACCOUNT_STATUSES).toEqual(['ACTIVE', 'LOCKED', 'DELETED']);
    expect(AGE_BANDS).toEqual(['L1', 'L2', 'L3']);
    expect(GROUP_KINDS).toEqual(['FAMILY', 'CLASS']);
    expect(GROUP_STATUSES).toEqual(['ACTIVE', 'ARCHIVED']);
    expect(MEMBER_ROLES).toEqual(['OWNER', 'STUDENT']);
    expect(WORK_TYPES).toEqual(['GAME', 'WEB', 'ANIMATION', 'PICTURE_BOOK']);
    expect(BUILD_STATUSES).toEqual(['VALID', 'INVALID']);
    expect(SCAN_STATUSES).toEqual(['PASS', 'BLOCK', 'CONFIRM_REQUIRED']);
    expect(PROJECT_STATUSES).toEqual(['ACTIVE', 'ARCHIVED', 'DELETED']);
    expect(RESTORABLE_PROJECT_STATUSES).toEqual(['ACTIVE', 'ARCHIVED']);
    expect(VISIBILITIES).toEqual(['PRIVATE', 'GROUP', 'PUBLIC']);
    expect(WORK_STATUSES).toEqual(['ACTIVE', 'DELETED']);
    expect(PUBLICATION_STATUSES).toEqual(['PREPARING', 'LIVE', 'BLOCKED', 'REVOKED']);
    expect(CAPABILITIES).toEqual(['QCA_TASK', 'IMAGE_GENERATION', 'TTS', 'STT']);
    expect(USAGE_PERIODS).toEqual(['DAILY', 'MONTHLY']);
    expect(USAGE_UNITS).toEqual(['CREDIT', 'IMAGE', 'CHARACTER', 'SECOND']);
    expect(USAGE_PROVIDERS).toEqual(['QCA', 'BAILIAN']);
    expect(RESERVATION_STATES).toEqual(['HELD', 'COMMITTED', 'RELEASED', 'EXPIRED']);
    expect(TERMINAL_RESERVATION_STATES).toEqual(['COMMITTED', 'RELEASED', 'EXPIRED']);
    expect(COURSE_STATUSES).toEqual(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
    expect(ASSIGNMENT_STATUSES).toEqual(['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED']);
    expect(SUBMISSION_STATUSES).toEqual(['SUBMITTED', 'GRADED', 'REVISION_REQUESTED']);
    expect(LEARNING_PROGRESS_STATES).toEqual([
      'NOT_STARTED',
      'IN_PROGRESS',
      'SUBMITTED',
      'GRADED',
      'REVISION_REQUIRED',
    ]);
    expect(ACHIEVEMENT_RULE_KINDS).toEqual([
      'POINTS_TOTAL',
      'GROWTH_LEVEL_REACHED',
      'WORK_PUBLISHED',
      'LIKE_RECEIVED',
      'STREAK_DAYS',
    ]);
    expect(SECRET_KINDS).toEqual(['QCA_PAT', 'BAILIAN_API_KEY']);
    expect(TASK_EVENT_TYPES).toEqual(['STATE_CHANGED', 'PROGRESS', 'SAFE_MESSAGE', 'COMPLETED']);
  });

  it('每个枚举的 is 都接受自己的全部成员并拒绝一个近邻串', () => {
    const probes: readonly (readonly [string, (value: string) => boolean])[] = [
      ['OWNER', isRole],
      ['ACTIVE', isAccountStatus],
      ['L1', isAgeBand],
      ['FAMILY', isGroupKind],
      ['ARCHIVED', isGroupStatus],
      ['STUDENT', isMemberRole],
      ['GAME', isWorkType],
      ['VALID', isBuildStatus],
      ['PASS', isScanStatus],
      ['DELETED', isProjectStatus],
      ['ACTIVE', isRestorableProjectStatus],
      ['PUBLIC', isVisibility],
      ['DELETED', isWorkStatus],
      ['LIVE', isPublicationStatus],
      ['QCA_TASK', isCapability],
      ['DAILY', isUsagePeriod],
      ['CREDIT', isUsageUnit],
      ['QCA', isUsageProvider],
      ['HELD', isReservationState],
      ['DRAFT', isCourseStatus],
      ['CLOSED', isAssignmentStatus],
      ['GRADED', isSubmissionStatus],
      ['IN_PROGRESS', isLearningProgressState],
      ['POINTS_TOTAL', isAchievementRuleKind],
      ['QCA_PAT', isSecretKind],
      ['PROGRESS', isTaskEventType],
    ];
    for (const [member, is] of probes) {
      expect(is(member)).toBe(true);
      expect(is(member.toLowerCase())).toBe(false);
      expect(is(`${member}_X`)).toBe(false);
    }
  });

  it('DELETED 不是可恢复的项目状态（恢复到 DELETED 没有意义）', () => {
    expect(isRestorableProjectStatus('DELETED')).toBe(false);
    expect(isRestorableProjectStatus('ACTIVE')).toBe(true);
    expect(isRestorableProjectStatus('ARCHIVED')).toBe(true);
  });
});

describe('Timestamp：UTC RFC3339，日历字段必须真实存在', () => {
  it('接受 Z 结尾、1–6 位小数秒的形态', () => {
    expect(isTimestamp('2026-03-01T00:00:00Z')).toBe(true);
    expect(isTimestamp('2026-03-01T00:00:00.000Z')).toBe(true);
    expect(isTimestamp('2026-03-01T12:34:56.123456Z')).toBe(true);
  });

  it('拒绝偏移时区、缺 Z、缺秒、空串与非字符串', () => {
    expect(isTimestamp('2026-03-01T00:00:00+08:00')).toBe(false);
    expect(isTimestamp('2026-03-01T00:00:00')).toBe(false);
    expect(isTimestamp('2026-03-01 00:00:00Z')).toBe(false);
    expect(isTimestamp('2026-03-01T00:00Z')).toBe(false);
    expect(isTimestamp('')).toBe(false);
    expect(isTimestamp(1_700_000_000 as unknown as string)).toBe(false);
  });

  it('拒绝不存在的日历日期（形状对但语义错）', () => {
    expect(isTimestamp('2026-02-30T00:00:00.000Z')).toBe(false);
    expect(isTimestamp('2026-13-01T00:00:00.000Z')).toBe(false);
    expect(isTimestamp('2026-03-01T24:00:00.000Z')).toBe(false);
    // 闰年判定走的是 Date 往返，不是硬编码的年份表。
    expect(isTimestamp('2024-02-29T00:00:00.000Z')).toBe(true);
    expect(isTimestamp('2026-02-29T00:00:00.000Z')).toBe(false);
  });

  it('parseTimestamp 对非法值抛 REQUEST_INVALID/Timestamp，且消息不含原文', () => {
    const error = thrownDomainError(() => parseTimestamp('2026-02-30T00:00:00.000Z'));
    expect(error.code).toBe('REQUEST_INVALID');
    expect(error.valueObject).toBe('Timestamp');
    expect(error.message).toBe('REQUEST_INVALID: Timestamp');
  });

  it('timestampSortKey 把小数秒补齐到 6 位，字典序即时间序', () => {
    expect(timestampSortKey(parseTimestamp('2026-03-01T00:00:00Z'))).toBe(
      '2026-03-01T00:00:00.000000Z',
    );
    expect(timestampSortKey(parseTimestamp('2026-03-01T00:00:00.1Z'))).toBe(
      '2026-03-01T00:00:00.100000Z',
    );
    const sorted = [
      parseTimestamp('2026-03-01T00:00:00.5Z'),
      parseTimestamp('2026-03-01T00:00:00Z'),
      parseTimestamp('2026-03-01T00:00:00.05Z'),
    ]
      .map(timestampSortKey)
      .sort();
    expect(sorted).toEqual([
      '2026-03-01T00:00:00.000000Z',
      '2026-03-01T00:00:00.050000Z',
      '2026-03-01T00:00:00.500000Z',
    ]);
  });

  it('compareTimestamps / isBefore 在毫秒与微秒精度上都成立', () => {
    const a = parseTimestamp('2026-03-01T00:00:00.000001Z');
    const b = parseTimestamp('2026-03-01T00:00:00.001Z');
    expect(compareTimestamps(a, b)).toBe(-1);
    expect(compareTimestamps(b, a)).toBe(1);
    expect(compareTimestamps(a, a)).toBe(0);
    expect(isBefore(a, b)).toBe(true);
    expect(isBefore(b, a)).toBe(false);
    expect(isBefore(a, a)).toBe(false);
  });

  it('plusDaysUtc 跨月跨年，输出固定为毫秒精度 UTC', () => {
    expect(plusDaysUtc(EPOCH_TS, 0)).toBe('2026-03-01T00:00:00.000Z');
    expect(plusDaysUtc(EPOCH_TS, 1)).toBe('2026-03-02T00:00:00.000Z');
    expect(plusDaysUtc(EPOCH_TS, 30)).toBe('2026-03-31T00:00:00.000Z');
    expect(plusDaysUtc(parseTimestamp('2026-12-31T23:59:59.999Z'), 1)).toBe(
      '2027-01-01T23:59:59.999Z',
    );
    expect(plusDaysUtc(parseTimestamp('2024-02-28T00:00:00.000Z'), 1)).toBe(
      '2024-02-29T00:00:00.000Z',
    );
  });

  it('plusDaysUtc 拒绝非整数天数', () => {
    const error = thrownDomainError(() => plusDaysUtc(EPOCH_TS, 0.5));
    expect(error.code).toBe('REQUEST_INVALID');
    expect(error.valueObject).toBe('Timestamp');
  });

  it('不读宿主时区：同一输入连续两次给出逐字节相同的输出', () => {
    expect(plusDaysUtc(EPOCH_TS, 30)).toBe(plusDaysUtc(EPOCH_TS, 30));
    expect(timestampSortKey(EPOCH_TS)).toBe(timestampSortKey(EPOCH_TS));
  });
});

describe('Revision 与 ETag：强校验值 "rev-<Revision>"', () => {
  it('formatRevision 接受 bigint 与 number，输出无前导零十进制串', () => {
    expect(formatRevision(1n)).toBe('1');
    expect(formatRevision(0)).toBe('0');
    expect(formatRevision(9_007_199_254_740_991n)).toBe('9007199254740991');
  });

  it('parseRevision 拒绝非十进制与前导零', () => {
    expect(parseRevision('12')).toBe('12');
    for (const bad of ['', '01', '-1', '1.0', 'abc', 'rev-1', '"rev-1"']) {
      expect(thrownDomainError(() => parseRevision(bad)).valueObject).toBe('Revision');
    }
  });

  it('nextRevision 在超过 Number.MAX_SAFE_INTEGER 后仍精确', () => {
    expect(nextRevision(parseRevision('9007199254740991'))).toBe('9007199254740992');
    expect(nextRevision(parseRevision('0'))).toBe('1');
  });

  it('compareRevisions 按数值而非字典序比较', () => {
    expect(compareRevisions(parseRevision('9'), parseRevision('10'))).toBe(-1);
    expect(compareRevisions(parseRevision('10'), parseRevision('9'))).toBe(1);
    expect(compareRevisions(parseRevision('10'), parseRevision('10'))).toBe(0);
    // 字典序会给出相反结论，这条断言因此不是同义反复。
    expect('9' < '10').toBe(false);
  });

  it('formatETag / revisionFromETag 往返一致', () => {
    const etag = formatETag(parseRevision('7'));
    expect(etag).toBe('"rev-7"');
    expect(isETag(etag)).toBe(true);
    expect(revisionFromETag(etag)).toBe('7');
    expect(etagMatches(etag, parseRevision('7'))).toBe(true);
    expect(etagMatches(etag, parseRevision('8'))).toBe(false);
  });

  it('弱校验值与错误形状一律拒绝（If-Match 必须是强校验值）', () => {
    for (const bad of ['W/"rev-7"', 'rev-7', '"rev-"', '"rev-01"', '"rev--1"', '']) {
      expect(isETag(bad)).toBe(false);
      expect(thrownDomainError(() => parseRevision(bad)).code).toBe('REQUEST_INVALID');
    }
  });
});

type BoundedTextEntry = {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly is: (value: string) => boolean;
};

/**
 * 全部有界文本值对象。`min` / `max` 是**字面量**：它们来自附录 A §5.5 的 DTO 边界
 * 与冻结 PRD 的产品数值，改动了就必须有人看见红灯，而不是让测试跟着代码一起漂。
 *
 * `AchievementCode` 是唯一 `min = 2` 的：单字符成就码在儿童界面里无法辨识。
 */
const BOUNDED_TEXT_VALUE_OBJECTS: readonly BoundedTextEntry[] = [
  { name: 'LoginName', min: 1, max: 64, is: isLoginName },
  { name: 'Nickname', min: 1, max: 64, is: isNickname },
  { name: 'GroupName', min: 1, max: 80, is: isGroupName },
  { name: 'ProjectTitle', min: 1, max: 100, is: isProjectTitle },
  { name: 'CourseTitle', min: 1, max: 100, is: isCourseTitle },
  { name: 'LessonTitle', min: 1, max: 100, is: isLessonTitle },
  { name: 'AssignmentTitle', min: 1, max: 100, is: isAssignmentTitle },
  { name: 'AssignmentInstructions', min: 1, max: 4000, is: isAssignmentInstructions },
  { name: 'GradeFeedback', min: 1, max: 2000, is: isGradeFeedback },
  { name: 'AchievementCode', min: 2, max: 64, is: isAchievementCode },
  { name: 'AchievementTitle', min: 1, max: 60, is: isAchievementTitle },
  { name: 'SourceEventKey', min: 1, max: 128, is: isSourceEventKey },
  { name: 'OperatorNote', min: 1, max: 200, is: isOperatorNote },
  { name: 'LedgerEventKey', min: 1, max: 128, is: isLedgerEventKey },
];

describe('有界文本值对象：闭区间 + 非空白 + 无控制字符', () => {
  it.each(BOUNDED_TEXT_VALUE_OBJECTS)('$name 接受长度 min 与 max，拒绝 max+1', (entry) => {
    expect(entry.is(repeat('a', entry.min))).toBe(true);
    expect(entry.is(repeat('a', entry.max))).toBe(true);
    expect(entry.is(repeat('a', entry.max + 1))).toBe(false);
  });

  it.each(BOUNDED_TEXT_VALUE_OBJECTS)('$name 拒绝空串、纯空白与控制字符', (entry) => {
    expect(entry.is('')).toBe(false);
    expect(entry.is(repeat(' ', entry.min + 1))).toBe(false);
    expect(entry.is(`a\nb`)).toBe(false);
    expect(entry.is(`a\rb`)).toBe(false);
    expect(entry.is(`a\tb`)).toBe(false);
    expect(entry.is('a\u0000b')).toBe(false);
    expect(entry.is('a\u007fb')).toBe(false);
  });

  it('控制字符被拒不是为了美观：它挡住伪造日志行与 SSE 帧（§7.5）', () => {
    // 一条带换行的"项目标题"能在日志里凭空造出第二行。
    expect(isProjectTitle('我的作品\n[audit] result=SUCCESS')).toBe(false);
    // SSE 的 data: 行同样按换行分帧。
    expect(isOperatorNote('event: completed\ndata: {}')).toBe(false);
  });

  it('长度上限常量与表格里的字面量一致', () => {
    expect(LOGIN_NAME_MAX_LENGTH).toBe(64);
    expect(NICKNAME_MAX_LENGTH).toBe(64);
    expect(GROUP_NAME_MAX_LENGTH).toBe(80);
    expect(PROJECT_TITLE_MAX_LENGTH).toBe(100);
    expect(COURSE_TITLE_MAX_LENGTH).toBe(100);
    expect(LESSON_TITLE_MAX_LENGTH).toBe(100);
    expect(ASSIGNMENT_TITLE_MAX_LENGTH).toBe(100);
    expect(ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH).toBe(4000);
    expect(GRADE_FEEDBACK_MAX_LENGTH).toBe(2000);
    expect(ACHIEVEMENT_CODE_MAX_LENGTH).toBe(64);
    expect(ACHIEVEMENT_TITLE_MAX_LENGTH).toBe(60);
    expect(SOURCE_EVENT_KEY_MAX_LENGTH).toBe(128);
    expect(OPERATOR_NOTE_MAX_LENGTH).toBe(200);
    expect(LEDGER_EVENT_KEY_MAX_LENGTH).toBe(128);
    expect(RUBRIC_CRITERION_KEY_MAX_LENGTH).toBe(40);
    expect(RUBRIC_CRITERION_LABEL_MAX_LENGTH).toBe(120);
  });

  it('parse 拒绝时带出值对象名，消息里不回流被拒文本', () => {
    const tooLong = repeat('a', 101);
    const error = thrownDomainError(() => parseAchievementCode(tooLong));
    expect(error.code).toBe('REQUEST_INVALID');
    expect(error.message).toBe('REQUEST_INVALID: AchievementCode');
    expect(error.message).not.toContain(tooLong);
  });

  it('AchievementCode 的下限是 2，不是 1', () => {
    expect(isAchievementCode('a')).toBe(false);
    expect(isAchievementCode('ab')).toBe(true);
    expect(parseAchievementCode('ab')).toBe('ab');
  });

  it('RubricCriterion 的 key/label 上限由 createRubric 强制（没有独立的 parse 出口）', () => {
    expect(
      thrownDomainError(() => createRubric([{ key: repeat('k', 41), label: 'L', maxScore: 1 }]))
        .valueObject,
    ).toBe('RubricCriterionKey');
    expect(
      thrownDomainError(() => createRubric([{ key: 'k', label: repeat('L', 121), maxScore: 1 }]))
        .valueObject,
    ).toBe('RubricCriterionLabel');
    expect(
      createRubric([{ key: repeat('k', 40), label: repeat('L', 120), maxScore: 1 }]).criteria,
    ).toHaveLength(1);
  });
});

type BoundedIntegerEntry = {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly parse: (value: number) => number;
};

const MAX_SAFE = 9_007_199_254_740_991;

/**
 * 全部有界整数值对象。上下限同样是字面量：`EstimatedMinutes ≤ 600`、
 * `Attempt/MaxAttempts ≤ 1000`、`LockDurationMinutes ≤ 10080`（7 天）都是产品数值，
 * 不是实现细节。
 */
const BOUNDED_INTEGER_VALUE_OBJECTS: readonly BoundedIntegerEntry[] = [
  { name: 'MemberLimit', min: 1, max: MAX_SAFE, parse: parseMemberLimit },
  { name: 'FindingCount', min: 0, max: MAX_SAFE, parse: parseFindingCount },
  { name: 'LessonSequence', min: 1, max: MAX_SAFE, parse: parseLessonSequence },
  { name: 'EstimatedMinutes', min: 1, max: 600, parse: parseEstimatedMinutes },
  { name: 'AchievementThreshold', min: 1, max: MAX_SAFE, parse: parseAchievementThreshold },
  { name: 'LikeDailyLimit', min: 1, max: MAX_SAFE, parse: parseLikeDailyLimit },
  { name: 'Attempt', min: 1, max: 1000, parse: parseAttempt },
  { name: 'MaxAttempts', min: 1, max: 1000, parse: parseMaxAttempts },
  { name: 'RepairCount', min: 0, max: 1000, parse: parseRepairCount },
  { name: 'MaxFailedAttempts', min: 1, max: 1000, parse: parseMaxFailedAttempts },
  { name: 'LockDurationMinutes', min: 1, max: 10_080, parse: parseLockDurationMinutes },
  { name: 'UsageQuantity', min: 0, max: MAX_SAFE, parse: parseUsageQuantity },
  { name: 'Credits', min: 0, max: MAX_SAFE, parse: parseCredits },
  { name: 'DurationMs', min: 0, max: MAX_SAFE, parse: parseDurationMs },
];

describe('有界整数值对象：闭区间 + 只接受 JS 安全整数', () => {
  it.each(BOUNDED_INTEGER_VALUE_OBJECTS)('$name 接受 min 与 max，原值返回', (entry) => {
    expect(entry.parse(entry.min)).toBe(entry.min);
    expect(entry.parse(entry.max)).toBe(entry.max);
  });

  it.each(BOUNDED_INTEGER_VALUE_OBJECTS)('$name 拒绝越界、非整数、NaN 与 Infinity', (entry) => {
    for (const bad of [
      entry.min - 1,
      entry.max + 1,
      entry.min + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const error = thrownDomainError(() => entry.parse(bad));
      expect(error.code).toBe('REQUEST_INVALID');
      expect(error.valueObject).toBe(entry.name);
    }
  });

  it('拒绝不安全整数，即使它落在区间内', () => {
    // `MAX_SAFE + 1` 仍能与自己全等，但已不能精确表示"再加一"。
    expect(thrownDomainError(() => parseUsageQuantity(MAX_SAFE + 1)).valueObject).toBe(
      'UsageQuantity',
    );
  });

  it('错误消息只带值对象名', () => {
    expect(thrownMessage(() => parseAttempt(0))).toBe('REQUEST_INVALID: Attempt');
    expect(thrownMessage(() => parseEstimatedMinutes(601))).toBe(
      'REQUEST_INVALID: EstimatedMinutes',
    );
  });

  it('textValueObject / integerValueObject 的边界本身是配置错误，抛普通 Error', () => {
    expect(() => textValueObject('Bad', 10, 1)).toThrow(
      'invalid text value object bounds: Bad 10..1',
    );
    expect(() => textValueObject('Bad', 0, 10)).toThrow(
      'invalid text value object bounds: Bad 0..10',
    );
    expect(() => textValueObject('Bad', 1.5, 10)).toThrow(
      'invalid text value object bounds: Bad 1.5..10',
    );
    expect(() => integerValueObject('Bad', 10, 1)).toThrow(
      'invalid integer value object bounds: Bad 10..1',
    );
    expect(() => integerValueObject('Bad', 1.5, 10)).toThrow(
      'invalid integer value object bounds: Bad 1.5..10',
    );
  });

  it('工厂把 name/min/max 原样暴露，供契约生成与错误消息复用', () => {
    const text = textValueObject('Probe', 2, 5);
    expect(text.name).toBe('Probe');
    expect(text.minLength).toBe(2);
    expect(text.maxLength).toBe(5);
    expect(text.is('ab')).toBe(true);
    expect(text.is('a')).toBe(false);
    expect(text.is('abcdef')).toBe(false);

    const integer = integerValueObject('Probe', -3, 3);
    expect(integer.name).toBe('Probe');
    expect(integer.min).toBe(-3);
    expect(integer.max).toBe(3);
    expect(integer.is(0)).toBe(true);
    expect(integer.is(-4)).toBe(false);
    expect(integer.is(4)).toBe(false);
  });
});

describe('其它原语值对象', () => {
  it('Cursor 是不透明 base64url，不接受填充与非法字符', () => {
    expect(isCursor('YWJj')).toBe(true);
    expect(isCursor('a-b_c')).toBe(true);
    expect(isCursor('')).toBe(false);
    expect(isCursor('YWJj=')).toBe(false);
    expect(isCursor('YW Jj')).toBe(false);
    expect(isCursor('YWJj+')).toBe(false);
    expect(parseCursor('YWJj')).toBe('YWJj');
    expect(thrownDomainError(() => parseCursor('YWJj=')).valueObject).toBe('Cursor');
  });

  it('Slug 是小写字母数字与连字符，长度 3..80', () => {
    expect(isSlug('my-work')).toBe(true);
    expect(isSlug(repeat('a', 3))).toBe(true);
    expect(isSlug(repeat('a', 80))).toBe(true);
    expect(isSlug('ab')).toBe(false);
    expect(isSlug(repeat('a', 81))).toBe(false);
    expect(isSlug('My-Work')).toBe(false);
    expect(isSlug('my_work')).toBe(false);
    // 字符集与长度是被钉住的部分；连字符**位置**不约束：`-my-work` 合法。
    // 「不以连字符开头」属于 slug 分配策略（避免与 `:verb` 形式的自定义方法路径混淆），
    // 在生成侧保证。写进值对象会拒绝掉数据库里已存在的 slug，那是破坏性收窄。
    expect(isSlug('-my-work')).toBe(true);
    expect(thrownDomainError(() => parseSlug('ab')).valueObject).toBe('Slug');
  });

  it('ArtifactDigest 是 64 位小写十六进制（publication.content_hash 同形）', () => {
    expect(isArtifactDigest(digestAt(1))).toBe(true);
    // `digestAt(1)` 只含数字，大写化是恒等变换 —— 要验「必须小写」就得用含字母的摘要，
    // 否则这条断言在放宽成大小写不敏感时依然是绿的。
    const lowercase = repeat('a', 32) + repeat('f', 32);
    expect(isArtifactDigest(lowercase)).toBe(true);
    expect(isArtifactDigest(lowercase.toUpperCase())).toBe(false);
    expect(isArtifactDigest(repeat('a', 63))).toBe(false);
    expect(isArtifactDigest(repeat('g', 64))).toBe(false);
    expect(parseArtifactDigest(digestAt(2))).toBe(digestAt(2));
  });

  it('ErrorDigest 与 ArtifactDigest 同形：用摘要而不是原文（§7.5）', () => {
    expect(isErrorDigest(digestAt(3))).toBe(true);
    expect(isErrorDigest('boom: connection reset')).toBe(false);
    expect(thrownDomainError(() => parseErrorDigest('boom')).valueObject).toBe('ErrorDigest');
  });

  it('RequestHash 是 SHA-256 形状，计算方式属于 adapter', () => {
    expect(isRequestHash(digestAt(4))).toBe(true);
    expect(isRequestHash('not-a-hash')).toBe(false);
    expect(thrownDomainError(() => parseRequestHash('nope')).valueObject).toBe('RequestHash');
  });

  it('ContractVersion 是三段 semver，不接受预发布与构建元数据后缀', () => {
    expect(isContractVersion('1.0.0')).toBe(true);
    expect(isContractVersion('12.34.56')).toBe(true);
    expect(isContractVersion('1.0')).toBe(false);
    expect(isContractVersion('1.0.0-beta.1')).toBe(false);
    expect(isContractVersion('1.0.0+build')).toBe(false);
    expect(isContractVersion('v1.0.0')).toBe(false);
    expect(thrownDomainError(() => parseContractVersion('1.0')).valueObject).toBe(
      'ContractVersion',
    );
  });

  it('VersionSequence 从 1 起；Progress 是 0..100 的整数', () => {
    expect(isVersionSequence(1)).toBe(true);
    expect(isVersionSequence(0)).toBe(false);
    expect(isVersionSequence(1.5)).toBe(false);
    expect(parseVersionSequence(9)).toBe(9);
    expect(isProgress(0)).toBe(true);
    expect(isProgress(100)).toBe(true);
    expect(isProgress(101)).toBe(false);
    expect(isProgress(-1)).toBe(false);
    expect(parseProgress(50)).toBe(50);
  });

  it('Score / Points 非负整数，GrowthLevel 正整数', () => {
    expect(parseScore(0)).toBe(0);
    expect(thrownDomainError(() => parseScore(-1)).valueObject).toBe('Score');
    expect(thrownDomainError(() => parseScore(1.5)).valueObject).toBe('Score');
    expect(parsePoints(0)).toBe(0);
    expect(thrownDomainError(() => parsePoints(-1)).valueObject).toBe('Points');
    expect(parseGrowthLevel(1)).toBe(1);
    expect(thrownDomainError(() => parseGrowthLevel(0)).valueObject).toBe('GrowthLevel');
  });

  it('IdempotencyKey 是 16–128 个 ^[A-Za-z0-9._:-]+$ 字符', () => {
    expect(IDEMPOTENCY_KEY_MIN_LENGTH).toBe(16);
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
    const valid = 'aB3._:-aB3._:-aB';
    expect(valid).toHaveLength(16);
    expect(isIdempotencyKey(valid)).toBe(true);
    expect(isIdempotencyKey(repeat('a', 128))).toBe(true);
    expect(isIdempotencyKey(repeat('a', 15))).toBe(false);
    expect(isIdempotencyKey(repeat('a', 129))).toBe(false);
    expect(isIdempotencyKey('a b c d e f g h i')).toBe(false);
    expect(isIdempotencyKey(repeat('é', 16))).toBe(false);
    expect(parseIdempotencyKey(valid)).toBe(valid);
    expect(thrownDomainError(() => parseIdempotencyKey('short')).valueObject).toBe(
      'IdempotencyKey',
    );
  });

  it('LoginName 唯一性按 lower(login_name) 判定，toLowerCase 由 ECMAScript 定义与宿主 locale 无关', () => {
    expect(loginNameKey(parseLoginName('Student01'))).toBe('student01');
    expect(loginNameKey(parseLoginName('student01'))).toBe('student01');
    expect(isLoginName('Student01')).toBe(true);
    expect(isLoginName(repeat('a', 65))).toBe(false);
  });

  it('PasswordDigest 是不可透明摘要：只拒绝空串，不做任何格式假设', () => {
    // 任何格式校验都会把 Argon2id 的参数泄漏进领域层。
    expect(opaquePasswordDigest('$argon2id$v=19$m=65536,t=3,p=4$abc$def')).not.toBe('');
    expect(opaquePasswordDigest('x')).toBe('x');
    expect(thrownDomainError(() => opaquePasswordDigest('')).valueObject).toBe('PasswordDigest');
  });

  it('口令明文只有长度边界，不存在可传递的明文值对象', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(isAcceptablePasswordLength(repeat('a', 8))).toBe(true);
    expect(isAcceptablePasswordLength(repeat('a', 128))).toBe(true);
    expect(isAcceptablePasswordLength(repeat('a', 7))).toBe(false);
    expect(isAcceptablePasswordLength(repeat('a', 129))).toBe(false);
    expect(isAcceptablePasswordLength(undefined as unknown as string)).toBe(false);
  });

  it('DueAt 与 Timestamp 同构，parseDueAt 复用同一套校验', () => {
    expect(parseDueAt(EPOCH)).toBe(EPOCH);
    expect(thrownDomainError(() => parseDueAt('2026-02-30T00:00:00.000Z')).valueObject).toBe(
      'Timestamp',
    );
  });
});

describe('标识符：UUIDv7 与联合键', () => {
  it('isUuidV7 要求小写、版本号 7、变体 8/9/a/b', () => {
    expect(isUuidV7(uuidAt(1))).toBe(true);
    expect(isUuidV7(uuidAt(1).toUpperCase())).toBe(false);
    // 版本号位改成 4（随机 UUID）就不是 v7。
    expect(isUuidV7('0190f3a4-b5c6-4d7e-8f90-000000000001')).toBe(false);
    // 变体位改成 0。
    expect(isUuidV7('0190f3a4-b5c6-7d7e-0f90-000000000001')).toBe(false);
    expect(isUuidV7('')).toBe(false);
    expect(isUuidV7('not-a-uuid')).toBe(false);
    expect(parseUuidV7(uuidAt(2))).toBe(uuidAt(2));
    expect(thrownDomainError(() => parseUuidV7('nope')).valueObject).toBe('UuidV7');
  });

  it('每个实体 ID 的 parse 都拒绝非 UUIDv7，并带出自己的值对象名', () => {
    const parsers: readonly (readonly [string, (value: string) => unknown])[] = [
      ['UserId', parseUserId],
      ['GroupId', parseGroupId],
      ['ProjectId', parseProjectId],
      ['ProjectVersionId', parseProjectVersionId],
      ['WorkId', parseWorkId],
      ['PublicationId', parsePublicationId],
      ['TaskId', parseTaskId],
      ['UsageLimitId', parseUsageLimitId],
      ['UsageReservationId', parseUsageReservationId],
      ['UsageLedgerEntryId', parseUsageLedgerEntryId],
      ['CourseId', parseCourseId],
      ['LessonId', parseLessonId],
      ['AssignmentId', parseAssignmentId],
      ['SubmissionId', parseSubmissionId],
      ['GradingId', parseGradingId],
      ['AchievementId', parseAchievementId],
      ['TemplateId', parseTemplateId],
    ];
    // 17 个 ID 类型，与附录 A §6.1 的清单一致；少一个就说明某个聚合的 ID 没被建模。
    expect(parsers).toHaveLength(17);
    for (const [name, parse] of parsers) {
      expect(parse(uuidAt(3))).toBe(uuidAt(3));
      expect(thrownDomainError(() => parse('bogus')).valueObject).toBe(name);
    }
  });

  it('TaskEventId 是十进制串（bigint 序列），不是 UUID', () => {
    expect(isTaskEventId('1')).toBe(true);
    expect(isTaskEventId('9007199254740993')).toBe(true);
    expect(isTaskEventId('0')).toBe(false);
    expect(isTaskEventId('-1')).toBe(false);
    expect(isTaskEventId('01')).toBe(false);
    expect(isTaskEventId('1.0')).toBe(false);
    expect(isTaskEventId(uuidAt(4))).toBe(false);
    expect(parseTaskEventId('42')).toBe('42');
    expect(thrownDomainError(() => parseTaskEventId('0')).valueObject).toBe('TaskEventId');
  });

  it('formatTaskEventId / nextTaskEventId 单调递增且拒绝 0', () => {
    expect(formatTaskEventId(1n)).toBe('1');
    expect(formatTaskEventId(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(thrownDomainError(() => formatTaskEventId(0n)).valueObject).toBe('TaskEventId');
    expect(thrownDomainError(() => formatTaskEventId(-1n)).valueObject).toBe('TaskEventId');
    expect(nextTaskEventId(null)).toBe('1');
    expect(nextTaskEventId(parseTaskEventId('1'))).toBe('2');
    expect(nextTaskEventId(parseTaskEventId('9007199254740991'))).toBe('9007199254740992');
  });

  it('sameKey 与键的书写顺序无关，与值有关', () => {
    const groupId = brand<string, 'GroupId'>(uuidAt(5));
    const userId = brand<string, 'UserId'>(uuidAt(6));
    expect(sameKey({ groupId, userId }, { userId, groupId })).toBe(true);
    expect(
      sameKey({ groupId, userId }, { groupId, userId: brand<string, 'UserId'>(uuidAt(7)) }),
    ).toBe(false);
    expect(
      sameKey(
        { userId: brand<string, 'UserId'>(uuidAt(8)) },
        { userId: brand<string, 'UserId'>(uuidAt(8)) },
      ),
    ).toBe(true);
  });
});

describe('Account 值对象：锁定阈值不硬编码产品默认值', () => {
  const policy: AccountLockPolicy = {
    maxFailedAttempts: parseMaxFailedAttempts(3),
    lockDurationMinutes: parseLockDurationMinutes(30),
  };

  it('阈值是闭区间下界：等于 maxFailedAttempts 即触发', () => {
    expect(isLockThresholdReached(2, policy)).toBe(false);
    expect(isLockThresholdReached(3, policy)).toBe(true);
    expect(isLockThresholdReached(4, policy)).toBe(true);
    expect(isLockThresholdReached(0, policy)).toBe(false);
  });

  it('非法计数是配置/编程错误，抛普通 Error', () => {
    expect(() => isLockThresholdReached(-1, policy)).toThrow('invalid failedLoginCount: -1');
    expect(() => isLockThresholdReached(1.5, policy)).toThrow('invalid failedLoginCount: 1.5');
  });

  it('锁定时长上限是 7 天 = 10080 分钟，不是产品默认值', () => {
    expect(parseLockDurationMinutes(10_080)).toBe(10_080);
    expect(thrownDomainError(() => parseLockDurationMinutes(10_081)).valueObject).toBe(
      'LockDurationMinutes',
    );
    expect(parseMaxFailedAttempts(1000)).toBe(1000);
    expect(thrownDomainError(() => parseMaxFailedAttempts(1001)).valueObject).toBe(
      'MaxFailedAttempts',
    );
  });
});

describe('Group 值对象：memberLimit 没有默认值', () => {
  const settings = createGroupSettings({ memberLimit: 3, studentPeerViewEnabled: true });

  it('createGroupSettings 原样保留两个字段', () => {
    expect(settings).toEqual({ memberLimit: 3, studentPeerViewEnabled: true });
  });

  it('memberLimit 下限是 1：产品数值由 Owner 建档时给出，domain 不猜', () => {
    expect(parseMemberLimit(1)).toBe(1);
    expect(thrownDomainError(() => parseMemberLimit(0)).valueObject).toBe('MemberLimit');
  });

  it('remainingMemberSlots 返回剩余名额而不是布尔值，满员时为 0', () => {
    expect(remainingMemberSlots(0, settings)).toBe(3);
    expect(remainingMemberSlots(2, settings)).toBe(1);
    expect(remainingMemberSlots(3, settings)).toBe(0);
    // 计数超过上限的情况对真实 Group 聚合不可达：`updateGroupSettings` 拒绝把上限
    // 缩到已有成员数以下（entities/group.ts），所以这里不断言负数分支。
  });

  it('canAddMember 在剩余 1 个名额时为真，为 0 时为假', () => {
    expect(canAddMember(2, settings)).toBe(true);
    expect(canAddMember(3, settings)).toBe(false);
  });

  it('非布尔的 studentPeerViewEnabled 与非法计数抛普通 Error', () => {
    expect(() =>
      createGroupSettings({
        memberLimit: 3,
        studentPeerViewEnabled: 'yes' as unknown as boolean,
      }),
    ).toThrow('GroupSettings.studentPeerViewEnabled must be a boolean');
    expect(() => remainingMemberSlots(-1, settings)).toThrow('invalid memberCount: -1');
    expect(() => remainingMemberSlots(1.5, settings)).toThrow('invalid memberCount: 1.5');
  });
});

describe('Project / Work 值对象：恢复窗口是半开区间 [deletedAt, deletedAt + N 天)', () => {
  it('删除那一刻起可恢复，到第 30 天整点起不可恢复', () => {
    expect(isWithinRestoreWindow(EPOCH_TS, EPOCH_TS)).toBe(true);
    expect(isWithinRestoreWindow(EPOCH_TS, parseTimestamp('2026-03-30T23:59:59.999Z'))).toBe(true);
    expect(isWithinRestoreWindow(EPOCH_TS, parseTimestamp('2026-03-31T00:00:00.000Z'))).toBe(false);
    expect(isWithinRestoreWindow(EPOCH_TS, parseTimestamp('2026-04-01T00:00:00.000Z'))).toBe(false);
  });

  it('now 早于 deletedAt 说明时钟或数据有问题，一律不可恢复', () => {
    expect(isWithinRestoreWindow(NEXT_DAY, EPOCH_TS)).toBe(false);
    expect(isWithinWorkRestoreWindow(NEXT_DAY, EPOCH_TS)).toBe(false);
  });

  /**
   * Legacy 负向对照（PM §4.5 第三段）。本行早期版本把判据写成
   * `!isBefore(now, deletedAt + N 天)`，也就是「窗口**过期之后**才可恢复」——
   * 与冻结 PRD 的 30 天恢复语义恰好相反：窗口内的 `restoreProject` 会抛
   * `RESOURCE_NOT_FOUND`，而一年前的删除反而能恢复。
   *
   * 下面四条在旧实现下**同时**变红，因此它们不是对上面用例的重复覆盖，而是把那次
   * 勘误钉住：任何回退（包括「顺手统一成 `>=`」这种看起来无害的改写）都会立刻现形。
   */
  it('legacy 对照：判据不是「窗口过期后才可恢复」的反向实现', () => {
    const farFuture = parseTimestamp('2027-03-01T00:00:00.000Z');
    expect(isWithinRestoreWindow(EPOCH_TS, EPOCH_TS)).toBe(true);
    expect(isWithinRestoreWindow(EPOCH_TS, farFuture)).toBe(false);
    expect(isWithinWorkRestoreWindow(EPOCH_TS, EPOCH_TS)).toBe(true);
    expect(isWithinWorkRestoreWindow(EPOCH_TS, farFuture)).toBe(false);
  });

  it('窗口天数可注入，非法天数抛普通 Error', () => {
    // 半开区间 `[deletedAt, deletedAt + N 天)`：7 天窗口在 2026-03-08T00:00:00.000Z
    // 这一瞬间关闭，前一刻还开着。1 天窗口在 2026-03-02T00:00:00.000Z 关闭。
    expect(isWithinRestoreWindow(EPOCH_TS, parseTimestamp('2026-03-07T23:59:59.999Z'), 7)).toBe(
      true,
    );
    expect(isWithinRestoreWindow(EPOCH_TS, parseTimestamp('2026-03-08T00:00:00.000Z'), 7)).toBe(
      false,
    );
    expect(isWithinRestoreWindow(EPOCH_TS, parseTimestamp('2026-03-02T00:00:00.000Z'), 1)).toBe(
      false,
    );
    expect(isWithinWorkRestoreWindow(EPOCH_TS, parseTimestamp('2026-03-07T23:59:59.999Z'), 7)).toBe(
      true,
    );
    expect(() => isWithinRestoreWindow(EPOCH_TS, EPOCH_TS, 0)).toThrow('invalid restore window: 0');
    expect(() => isWithinRestoreWindow(EPOCH_TS, EPOCH_TS, 1.5)).toThrow(
      'invalid restore window: 1.5',
    );
    expect(() => isWithinWorkRestoreWindow(EPOCH_TS, EPOCH_TS, -3)).toThrow(
      'invalid restore window: -3',
    );
  });

  it('Project 与 Work 的窗口都是 30 天，且判据一致', () => {
    expect(PROJECT_RESTORE_WINDOW_DAYS).toBe(30);
    expect(WORK_RESTORE_WINDOW_DAYS).toBe(30);
    const probe: readonly Timestamp[] = [
      EPOCH_TS,
      parseTimestamp('2026-03-15T12:00:00.000Z'),
      parseTimestamp('2026-03-31T00:00:00.000Z'),
      parseTimestamp('2027-01-01T00:00:00.000Z'),
    ];
    for (const now of probe) {
      expect(isWithinWorkRestoreWindow(EPOCH_TS, now)).toBe(isWithinRestoreWindow(EPOCH_TS, now));
    }
  });

  it('SafeScanSummary 只有计数、扫描时刻与不可透明报告引用，没有规则名或命中片段', () => {
    const summary = createSafeScanSummary({
      blockedCount: 1,
      warningCount: 2,
      confirmRequiredCount: 3,
      reportRef: brand<string, 'ArtifactRef'>('reports/scan/abc.json'),
      scannedAt: EPOCH_TS,
    });
    expect(Object.keys(summary).sort()).toEqual([
      'blockedCount',
      'confirmRequiredCount',
      'reportRef',
      'scannedAt',
      'warningCount',
    ]);
    expect(summary).toEqual({
      blockedCount: 1,
      warningCount: 2,
      confirmRequiredCount: 3,
      reportRef: 'reports/scan/abc.json',
      scannedAt: EPOCH,
    });
    // 学生代码原文可能出现在规则消息里，因此这些字段在结构上不存在。
    for (const forbidden of ['ruleId', 'message', 'snippet', 'finding', 'details', 'text']) {
      expect(Object.prototype.hasOwnProperty.call(summary, forbidden)).toBe(false);
    }
    expect(
      thrownDomainError(() =>
        createSafeScanSummary({
          blockedCount: -1,
          warningCount: 0,
          confirmRequiredCount: 0,
          reportRef: null,
          scannedAt: EPOCH_TS,
        }),
      ).valueObject,
    ).toBe('FindingCount');
  });

  it('可回滚/可预览允许 CONFIRM_REQUIRED，可发布不允许', () => {
    const matrix: readonly (readonly [BuildStatus, ScanStatus, boolean, boolean])[] = [
      ['VALID', 'PASS', true, true],
      ['VALID', 'CONFIRM_REQUIRED', true, false],
      ['VALID', 'BLOCK', false, false],
      ['INVALID', 'PASS', false, false],
      ['INVALID', 'CONFIRM_REQUIRED', false, false],
      ['INVALID', 'BLOCK', false, false],
    ];
    for (const [buildStatus, scanStatus, restorable, publishable] of matrix) {
      expect(isRestorableVersion({ buildStatus, scanStatus })).toBe(restorable);
      // 预览跑的是同一份不可变产物，因此与可回滚同判据。
      expect(isPublishableVersion({ buildStatus, scanStatus })).toBe(publishable);
      if (!restorable) {
        expect(
          thrownDomainError(() => assertRestorableVersion({ buildStatus, scanStatus })).code,
        ).toBe('VERSION_NOT_RESTORABLE');
      }
      if (!publishable) {
        expect(
          thrownDomainError(() => assertPublishableVersion({ buildStatus, scanStatus })).code,
        ).toBe('VERSION_NOT_PUBLISHABLE');
      }
    }
  });

  it('版本断言抛出的 DomainError 不带 valueObject：这不是入参校验失败', () => {
    const error = thrownDomainError(() =>
      assertRestorableVersion({ buildStatus: 'VALID', scanStatus: 'BLOCK' }),
    );
    expect(error.valueObject).toBeUndefined();
    expect(error.message).toBe('VERSION_NOT_RESTORABLE');
  });

  it('CONFIRM_REQUIRED 必须经 Owner 确认，不能靠发布绕过（§5.4）', () => {
    expect(isPublishableVersion({ buildStatus: 'VALID', scanStatus: 'CONFIRM_REQUIRED' })).toBe(
      false,
    );
    expect(isRestorableVersion({ buildStatus: 'VALID', scanStatus: 'CONFIRM_REQUIRED' })).toBe(
      true,
    );
  });
});

describe('Work 值对象：可服务判定不返回原因', () => {
  it('只有 PUBLIC + ACTIVE + LIVE 三者同时成立才可服务', () => {
    expect(
      canServePublicWork({
        visibility: 'PUBLIC',
        workStatus: 'ACTIVE',
        publicationStatus: 'LIVE',
      }),
    ).toBe(true);
    const negatives: readonly (readonly [Visibility, WorkStatus, PublicationStatus])[] = [
      ['PRIVATE', 'ACTIVE', 'LIVE'],
      ['GROUP', 'ACTIVE', 'LIVE'],
      ['PUBLIC', 'DELETED', 'LIVE'],
      ['PUBLIC', 'ACTIVE', 'PREPARING'],
      ['PUBLIC', 'ACTIVE', 'BLOCKED'],
      ['PUBLIC', 'ACTIVE', 'REVOKED'],
      ['PRIVATE', 'DELETED', 'REVOKED'],
    ];
    for (const [visibility, workStatus, publicationStatus] of negatives) {
      expect(canServePublicWork({ visibility, workStatus, publicationStatus })).toBe(false);
    }
  });

  it('返回布尔而不返回原因：原因本身就是枚举面（§5.3）', () => {
    // 「不存在 / PRIVATE / REVOKED / DELETED」对外必须不可区分，否则可以用 slug
    // 探测私有能力与账号状态。函数签名里没有承载原因的位置，这不是调用方纪律。
    const result: boolean = canServePublicWork({
      visibility: 'PRIVATE',
      workStatus: 'ACTIVE',
      publicationStatus: 'REVOKED',
    });
    expect(result).toBe(false);
  });

  it('只有正在服务的 publication 谈得上撤销', () => {
    expect(isRevocablePublication('LIVE')).toBe(true);
    for (const status of ['PREPARING', 'BLOCKED', 'REVOKED'] as const) {
      expect(isRevocablePublication(status)).toBe(false);
    }
  });
});

describe('Task 值对象', () => {
  it('TaskKind / TaskState / TaskStage 的成员与顺序逐字固定', () => {
    expect(TASK_KINDS).toEqual(['VIBE_TURN', 'BAILIAN_IMAGE', 'TTS', 'STT', 'PUBLISH', 'RESCAN']);
    expect(TASK_STATES).toEqual([
      'QUEUED',
      'CLAIMED',
      'SESSION_CREATING',
      'RUNNING',
      'COLLECTING',
      'REPAIRING',
      'VALIDATING',
      'COMMITTING',
      'RETRY_WAIT',
      'CANCELLING',
      'SUCCEEDED',
      'FAILED',
      'BLOCKED',
      'CANCELLED',
      'TIMED_OUT',
    ]);
    expect(TASK_STAGES).toEqual([
      'AUTH',
      'QUOTA',
      'TRANSPORT',
      'AGENT_RUN',
      'COLLECT',
      'BUILD',
      'CONTRACT',
      'CONTENT',
      'TIMEOUT',
      'CANCEL',
      'DEPENDENCY',
      'INTERNAL',
    ]);
    expect(isTaskKind('VIBE_TURN')).toBe(true);
    expect(isTaskKind('vibe_turn')).toBe(false);
    expect(isTaskState('REPAIRING')).toBe(true);
    expect(isTaskStage('INTERNAL')).toBe(true);
    expect(isTaskEventType('SAFE_MESSAGE')).toBe(true);
  });

  it('终态集合与判定一致', () => {
    expect(TERMINAL_TASK_STATES).toEqual([
      'SUCCEEDED',
      'FAILED',
      'BLOCKED',
      'CANCELLED',
      'TIMED_OUT',
    ]);
    for (const state of TASK_STATES) {
      expect(isTerminalTaskState(state)).toBe(
        (TERMINAL_TASK_STATES as readonly string[]).includes(state),
      );
    }
  });

  it('写任务种类恰好是会计量的种类：PUBLISH / RESCAN 只作用于已提交的不可变版本', () => {
    expect(WRITE_TASK_KINDS).toEqual(['VIBE_TURN', 'BAILIAN_IMAGE', 'TTS', 'STT']);
    for (const kind of TASK_KINDS) {
      expect(isWriteTaskKind(kind)).toBe(capabilityOfTaskKind(kind) !== null);
    }
    expect(isWriteTaskKind('PUBLISH')).toBe(false);
    expect(isWriteTaskKind('RESCAN')).toBe(false);
  });

  it('补交预算是 1，且不折算成 attempt', () => {
    expect(TASK_REPAIR_BUDGET).toBe(1);
    expect(canRequestRepair(parseRepairCount(0))).toBe(true);
    expect(canRequestRepair(parseRepairCount(1))).toBe(false);
    expect(canRequestRepair(parseRepairCount(2))).toBe(false);
    expect(hasAttemptsLeft(parseAttempt(1), parseMaxAttempts(2))).toBe(true);
    expect(hasAttemptsLeft(parseAttempt(2), parseMaxAttempts(2))).toBe(false);
    expect(hasAttemptsLeft(parseAttempt(2), parseMaxAttempts(3))).toBe(true);
  });

  it('prompt 只有长度边界，不存在持有全文的值对象（§5 禁止出口）', () => {
    expect(PROMPT_MIN_LENGTH).toBe(1);
    expect(PROMPT_MAX_LENGTH).toBe(8000);
    expect(isAcceptablePromptLength('做一个小游戏')).toBe(true);
    expect(isAcceptablePromptLength(repeat('a', 8000))).toBe(true);
    expect(isAcceptablePromptLength('')).toBe(false);
    expect(isAcceptablePromptLength(repeat('a', 8001))).toBe(false);
    expect(isAcceptablePromptLength(42 as unknown as string)).toBe(false);
  });

  it('运维备注 1..200', () => {
    expect(isOperatorNote(repeat('n', 200))).toBe(true);
    expect(isOperatorNote(repeat('n', 201))).toBe(false);
  });

  it('时限数值：软 SLA 两档都严格小于硬超时', () => {
    expect(SOFT_DEADLINE_SECONDS_SIMPLE).toBe(30);
    expect(SOFT_DEADLINE_SECONDS_COMPLEX).toBe(120);
    expect(HARD_DEADLINE_MINUTES).toBe(10);
    expect(LEASE_SCAN_INTERVAL_MINUTES).toBe(5);
    const hardSeconds = HARD_DEADLINE_MINUTES * 60;
    expect(hardSeconds).toBeGreaterThan(SOFT_DEADLINE_SECONDS_COMPLEX);
    expect(SOFT_DEADLINE_SECONDS_COMPLEX).toBeGreaterThan(SOFT_DEADLINE_SECONDS_SIMPLE);
    // 租约扫描周期必须短于硬超时，否则超时任务在下一次扫描前一直占着租约。
    expect(LEASE_SCAN_INTERVAL_MINUTES * 60).toBeLessThan(hardSeconds);
  });

  it('可重试入口状态是 FAILED 与 TIMED_OUT，且两者都是终态', () => {
    expect(RETRYABLE_ENTRY_TASK_STATES).toEqual(['FAILED', 'TIMED_OUT']);
    for (const state of RETRYABLE_ENTRY_TASK_STATES) {
      expect(isRetryableEntryState(state)).toBe(true);
      expect(isTerminalTaskState(state)).toBe(true);
    }
    for (const state of TASK_STATES) {
      if (state === 'FAILED' || state === 'TIMED_OUT') continue;
      expect(isRetryableEntryState(state)).toBe(false);
    }
  });

  it('assertRetryableEntryState 抛 TASK_NOT_RETRYABLE 且不带 valueObject', () => {
    const error = thrownDomainError(() => assertRetryableEntryState('SUCCEEDED'));
    expect(error.code).toBe('TASK_NOT_RETRYABLE');
    expect(error.valueObject).toBeUndefined();
    expect(error.message).toBe('TASK_NOT_RETRYABLE');
    expect(() => assertRetryableEntryState('FAILED')).not.toThrow();
  });
});

describe('Usage 值对象：capability → unit / provider 是全覆盖的固定映射', () => {
  it('每个 capability 都有 unit 与 provider，且映射逐字固定', () => {
    const expectedUnits: readonly (readonly [Capability, string])[] = [
      ['QCA_TASK', 'CREDIT'],
      ['IMAGE_GENERATION', 'IMAGE'],
      ['TTS', 'CHARACTER'],
      ['STT', 'SECOND'],
    ];
    for (const [capability, unit] of expectedUnits) {
      expect(unitOfCapability(capability)).toBe(unit);
    }
    expect(providerOfCapability('QCA_TASK')).toBe('QCA');
    expect(providerOfCapability('IMAGE_GENERATION')).toBe('BAILIAN');
    expect(providerOfCapability('TTS')).toBe('BAILIAN');
    expect(providerOfCapability('STT')).toBe('BAILIAN');
  });

  it('没有 capability 落到映射之外，也没有 unit/provider 是死枚举成员', () => {
    const units = new Set<string>();
    const providers = new Set<string>();
    for (const capability of CAPABILITIES) {
      expect(unitOfCapability(capability)).toBeDefined();
      expect(providerOfCapability(capability)).toBeDefined();
      units.add(unitOfCapability(capability));
      providers.add(providerOfCapability(capability));
    }
    expect([...units].sort()).toEqual([...USAGE_UNITS].sort());
    expect([...providers].sort()).toEqual([...USAGE_PROVIDERS].sort());
  });

  it('capabilityOfTaskKind 对六个 TaskKind 全覆盖，PUBLISH / RESCAN 不计量', () => {
    expect(capabilityOfTaskKind('VIBE_TURN')).toBe('QCA_TASK');
    expect(capabilityOfTaskKind('BAILIAN_IMAGE')).toBe('IMAGE_GENERATION');
    expect(capabilityOfTaskKind('TTS')).toBe('TTS');
    expect(capabilityOfTaskKind('STT')).toBe('STT');
    // null 而不是抛错：不产生用量的任务不受"额度为零"阻断（§6.6）。
    expect(capabilityOfTaskKind('PUBLISH')).toBeNull();
    expect(capabilityOfTaskKind('RESCAN')).toBeNull();
    const kinds: readonly TaskKind[] = TASK_KINDS;
    expect(kinds).toHaveLength(6);
    for (const kind of kinds) {
      const capability = capabilityOfTaskKind(kind);
      if (capability !== null) expect(isCapability(capability)).toBe(true);
    }
  });

  it('预留终态不可回退：HELD 是唯一非终态', () => {
    for (const state of RESERVATION_STATES) {
      expect(isTerminalReservationState(state)).toBe(state !== 'HELD');
    }
  });

  it('Timezone 只做形状校验，不解析偏移（偏移查表要用 Intl，那是宿主相关的）', () => {
    expect(isTimezone('Asia/Shanghai')).toBe(true);
    expect(isTimezone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isTimezone('Etc/GMT+8')).toBe(true);
    expect(isTimezone('UTC')).toBe(false);
    expect(isTimezone('')).toBe(false);
    expect(isTimezone('Asia/')).toBe(false);
    expect(isTimezone('/Shanghai')).toBe(false);
    // 64 是闭区间上界：60 个 'a' + '/bbb' 恰好 64 个字符，仍然合法；65 就出局。
    expect(repeat('a', 60) + '/bbb').toHaveLength(64);
    expect(isTimezone(repeat('a', 60) + '/bbb')).toBe(true);
    expect(isTimezone(repeat('a', 61) + '/bbb')).toBe(false);
    expect(parseTimezone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(thrownDomainError(() => parseTimezone('UTC')).valueObject).toBe('Timezone');
  });

  it('偏移分钟数覆盖现实中的 -12:00..+14:00', () => {
    for (const value of [0, 480, -60, 840, -840]) {
      expect(parseTimezoneOffsetMinutes(value)).toBe(value);
    }
    for (const value of [841, -841, 0.5, Number.NaN]) {
      expect(thrownDomainError(() => parseTimezoneOffsetMinutes(value)).valueObject).toBe(
        'TimezoneOffsetMinutes',
      );
    }
  });

  it('periodKey 是纯函数：偏移由调用方传入，不读宿主时区', () => {
    const cases: readonly (readonly [string, 'DAILY' | 'MONTHLY', number, string])[] = [
      [EPOCH, 'DAILY', 0, '2026-03-01'],
      [EPOCH, 'MONTHLY', 0, '2026-03'],
      [EPOCH, 'DAILY', 480, '2026-03-01'],
      [EPOCH, 'DAILY', -60, '2026-02-28'],
      [EPOCH, 'MONTHLY', -60, '2026-02'],
      [EPOCH, 'DAILY', 840, '2026-03-01'],
      ['2026-01-01T00:00:00.000Z', 'DAILY', -60, '2025-12-31'],
      ['2026-01-01T00:00:00.000Z', 'MONTHLY', -60, '2025-12'],
      ['2026-03-01T16:00:00.000Z', 'DAILY', 480, '2026-03-02'],
      ['2026-03-01T16:00:00.000Z', 'MONTHLY', 480, '2026-03'],
    ];
    for (const [occurredAt, period, offset, expected] of cases) {
      const actual = periodKey(
        parseTimestamp(occurredAt),
        period,
        parseTimezoneOffsetMinutes(offset),
      );
      // 期望值是写死的字面量：若实现改读了宿主时区，这些断言会在不同时区的机器上分裂。
      expect(actual).toBe(expected);
    }
  });

  it('LedgerEventKey 上限 128，全局唯一由调用方按确定性规则生成', () => {
    expect(LEDGER_EVENT_KEY_MAX_LENGTH).toBe(128);
    expect(isLedgerEventKey(repeat('k', 128))).toBe(true);
    expect(isLedgerEventKey(repeat('k', 129))).toBe(false);
    expect(isLedgerEventKey('')).toBe(false);
    expect(parseLedgerEventKey('task:1:commit')).toBe('task:1:commit');
  });

  it('预留过期时刻不得早于任务硬超时，否则同一笔消耗会被记两次', () => {
    const hardDeadline = parseTimestamp('2026-03-01T00:10:00.000Z');
    expect(() => assertReservationOutlivesTask(hardDeadline, hardDeadline)).not.toThrow();
    expect(() =>
      assertReservationOutlivesTask(parseTimestamp('2026-03-01T00:10:00.001Z'), hardDeadline),
    ).not.toThrow();
    expect(() =>
      assertReservationOutlivesTask(parseTimestamp('2026-03-01T00:09:59.999Z'), hardDeadline),
    ).toThrow('UsageReservation.expiresAt must not precede the task hard deadline');
  });
});

describe('Teaching 值对象：量规不变量在构造期成立', () => {
  it('totalMaxScore 等于各项满分之和，因此批改越界无从发生', () => {
    const rubric = createRubric([
      { key: 'logic', label: '逻辑', maxScore: 3 },
      { key: 'art', label: '美术', maxScore: 2 },
    ]);
    expect(rubric.totalMaxScore).toBe(5);
    expect(rubric.criteria).toEqual([
      { key: 'logic', label: '逻辑', maxScore: 3 },
      { key: 'art', label: '美术', maxScore: 2 },
    ]);
    expect(isScoreWithinRubric(parseScore(5), rubric)).toBe(true);
    expect(isScoreWithinRubric(parseScore(0), rubric)).toBe(true);
    expect(isScoreWithinRubric(parseScore(6), rubric)).toBe(false);
  });

  it('空量规、重复 key、非正满分都被拒绝', () => {
    expect(thrownDomainError(() => createRubric([])).valueObject).toBe('Rubric');
    expect(
      thrownDomainError(() =>
        createRubric([
          { key: 'a', label: 'A', maxScore: 1 },
          { key: 'a', label: 'B', maxScore: 2 },
        ]),
      ).valueObject,
    ).toBe('Rubric');
    expect(
      thrownDomainError(() => createRubric([{ key: 'a', label: 'A', maxScore: 0 }])).valueObject,
    ).toBe('Rubric');
    // `-1` 连 `Score`（非负整数）都不是，先被 `parseScore` 拦下；`0` 是合法 Score
    // 但不是合法的分项满分，才落到 `createRubric` 自己的 `'Rubric'`。两者报不同名字，
    // 因为「分数格式错了」和「量规设计错了」是两种不同的用户输入错误。
    expect(
      thrownDomainError(() => createRubric([{ key: 'a', label: 'A', maxScore: -1 }])).valueObject,
    ).toBe('Score');
    expect(
      thrownDomainError(() => createRubric([{ key: '', label: 'A', maxScore: 1 }])).valueObject,
    ).toBe('RubricCriterionKey');
  });

  it('sequence 从 1 起，estimatedMinutes 上限 600', () => {
    expect(parseLessonSequence(1)).toBe(1);
    expect(thrownDomainError(() => parseLessonSequence(0)).valueObject).toBe('LessonSequence');
    expect(parseEstimatedMinutes(600)).toBe(600);
    expect(thrownDomainError(() => parseEstimatedMinutes(601)).valueObject).toBe(
      'EstimatedMinutes',
    );
  });
});

describe('Reward 值对象', () => {
  it('createAchievementRule 产出封闭 kind + 正整数阈值', () => {
    expect(createAchievementRule({ kind: 'POINTS_TOTAL', threshold: 100 })).toEqual({
      kind: 'POINTS_TOTAL',
      threshold: 100,
    });
    expect(
      thrownDomainError(() => createAchievementRule({ kind: 'WHATEVER', threshold: 1 }))
        .valueObject,
    ).toBe('AchievementRuleKind');
    expect(
      thrownDomainError(() => createAchievementRule({ kind: 'STREAK_DAYS', threshold: 0 }))
        .valueObject,
    ).toBe('AchievementThreshold');
  });

  it('enabled=false 的成就不参与判定，但记录被保留', () => {
    const rule = createAchievementRule({ kind: 'WORK_PUBLISHED', threshold: 1 });
    expect(isRuleTriggerable(rule, true)).toBe(true);
    expect(isRuleTriggerable(rule, false)).toBe(false);
    expect(() => isRuleTriggerable(rule, 'yes' as unknown as boolean)).toThrow();
    expect(
      thrownDomainError(() => isRuleTriggerable(rule, 1 as unknown as boolean)).valueObject,
    ).toBe('Achievement');
  });

  it('点赞每日上限不硬编码默认值，由策略配置注入', () => {
    const limit = parseLikeDailyLimit(3);
    expect(canLikeToday(0, limit)).toBe(true);
    expect(canLikeToday(2, limit)).toBe(true);
    expect(canLikeToday(3, limit)).toBe(false);
    expect(canLikeToday(4, limit)).toBe(false);
    expect(() => canLikeToday(-1, limit)).toThrow('invalid todayLikeCount: -1');
    expect(() => canLikeToday(1.5, limit)).toThrow('invalid todayLikeCount: 1.5');
  });

  it('SourceEventKey 上限 128，与 (user, achievement) 联合唯一一起保证解锁幂等', () => {
    expect(SOURCE_EVENT_KEY_MAX_LENGTH).toBe(128);
    expect(isSourceEventKey(repeat('s', 128))).toBe(true);
    expect(isSourceEventKey(repeat('s', 129))).toBe(false);
  });
});

describe('不透明引用：签名 URL 在 parse 期就被拒绝', () => {
  const REF_ENTRIES = [
    { name: 'ArtifactRef', max: ARTIFACT_REF_MAX_LENGTH, is: isArtifactRef },
    { name: 'RuntimeRef', max: RUNTIME_REF_MAX_LENGTH, is: isRuntimeRef },
    { name: 'ContentRef', max: CONTENT_REF_MAX_LENGTH, is: isContentRef },
    {
      name: 'GenerationContextRef',
      max: GENERATION_CONTEXT_REF_MAX_LENGTH,
      is: isGenerationContextRef,
    },
    { name: 'SecretRef', max: SECRET_REF_MAX_LENGTH, is: isSecretRef },
    { name: 'ModelId', max: MODEL_ID_MAX_LENGTH, is: isModelId },
    { name: 'ProviderRequestId', max: PROVIDER_REQUEST_ID_MAX_LENGTH, is: isProviderRequestId },
  ] as const;

  it('五个 ref + 两个 provider 侧标识符的长度上限逐字固定', () => {
    expect(ARTIFACT_REF_MAX_LENGTH).toBe(512);
    expect(RUNTIME_REF_MAX_LENGTH).toBe(512);
    expect(CONTENT_REF_MAX_LENGTH).toBe(512);
    expect(GENERATION_CONTEXT_REF_MAX_LENGTH).toBe(512);
    expect(SECRET_REF_MAX_LENGTH).toBe(256);
    expect(MODEL_ID_MAX_LENGTH).toBe(128);
    expect(PROVIDER_REQUEST_ID_MAX_LENGTH).toBe(128);
    expect(REF_ENTRIES).toHaveLength(7);
  });

  it.each(REF_ENTRIES)('$name 接受普通逻辑 key，拒绝空串与超长', (entry) => {
    expect(entry.is('projects/abc/manifest.json')).toBe(true);
    expect(entry.is(repeat('a', entry.max))).toBe(true);
    expect(entry.is('')).toBe(false);
    expect(entry.is(repeat('a', entry.max + 1))).toBe(false);
    expect(entry.is(repeat(' ', 4))).toBe(false);
  });

  it.each(REF_ENTRIES)('$name 在 parse 期就拒绝签名 URL 与凭证形状', (entry) => {
    const forbidden: readonly string[] = [
      'https://r2.example.com/o/k?sig=abc',
      '//cdn.example.com/o/k',
      'o/k?X-Amz-Signature=abc',
      'o/k?expires=1700000000&token=abc',
      'Bearer abc.def.ghi',
      'authorization=Basic xyz',
      'o/k\nX-Injected: 1',
    ];
    for (const value of forbidden) {
      expect(entry.is(value)).toBe(false);
    }
  });

  it('被拒绝的引用原文既不进 message 也不进 stack', () => {
    const signed = 'https://r2.example.com/o/k?X-Amz-Signature=deadbeef';
    const error = thrownDomainError(() =>
      isArtifactRef(signed) ? signed : parseArtifactRefLike(signed),
    );
    expect(error.code).toBe('REQUEST_INVALID');
    expect(error.valueObject).toBe('ArtifactRef');
    expect(error.message).toBe('REQUEST_INVALID: ArtifactRef');
    expect(error.message).not.toContain('deadbeef');
    expect(error.stack ?? '').not.toContain('deadbeef');
  });

  it('parseSecretKind 抛 SECRET_KIND_UNSUPPORTED，不是 REQUEST_INVALID', () => {
    expect(isSecretKind('QCA_PAT')).toBe(true);
    expect(isSecretKind('LITTLEQ_MASTER_KEY')).toBe(false);
    const error = thrownDomainError(() => parseSecretKind('LITTLEQ_MASTER_KEY'));
    expect(error.code).toBe('SECRET_KIND_UNSUPPORTED');
    expect(error.valueObject).toBe('SecretKind');
    expect(error.message).toBe('SECRET_KIND_UNSUPPORTED: SecretKind');
  });

  it('SecretMetadata 结构上不存在 value 字段', () => {
    const metadata = createSecretMetadata({
      kind: 'QCA_PAT',
      configured: true,
      lastRotatedAt: EPOCH,
    });
    expect(metadata).toEqual({ kind: 'QCA_PAT', configured: true, lastRotatedAt: EPOCH });
    expect(Object.keys(metadata).sort()).toEqual(['configured', 'kind', 'lastRotatedAt']);
    expect(
      createSecretMetadata({ kind: 'BAILIAN_API_KEY', configured: false }).lastRotatedAt,
    ).toBeNull();
    expect(
      thrownDomainError(() => createSecretMetadata({ kind: 'QCA_PAT', configured: 'yes' }))
        .valueObject,
    ).toBe('SecretMetadata.configured');
    expect(
      thrownDomainError(() => createSecretMetadata({ kind: 'NOPE', configured: true })).code,
    ).toBe('SECRET_KIND_UNSUPPORTED');
    expect(
      thrownDomainError(() =>
        createSecretMetadata({ kind: 'QCA_PAT', configured: true, lastRotatedAt: 'yesterday' }),
      ).valueObject,
    ).toBe('Timestamp');
  });
});

function parseArtifactRefLike(value: string): unknown {
  if (!isArtifactRef(value)) throw DomainError.invalid('ArtifactRef');
  return value;
}

describe('ExternalOperationKey：taskId:stage:attempt，恰好三段', () => {
  const taskId = parseTaskId(uuidAt(9));

  it('format 与 parse 往返一致', () => {
    const key = formatExternalOperationKey(taskId, 'AGENT_RUN', 1);
    expect(key).toBe(`${uuidAt(9)}:AGENT_RUN:1`);
    expect(EXTERNAL_OPERATION_KEY_SEPARATOR).toBe(':');
    const parts = parseExternalOperationKey(key);
    expect(parts).toEqual({ key, taskId: uuidAt(9), stage: 'AGENT_RUN', attempt: 1 });
  });

  it('format 拒绝非法 stage 与 attempt < 1', () => {
    expect(
      thrownDomainError(() => formatExternalOperationKey(taskId, 'NOPE' as TaskStage, 1))
        .valueObject,
    ).toBe('TaskStage');
    expect(thrownDomainError(() => formatExternalOperationKey(taskId, 'AUTH', 0)).valueObject).toBe(
      'Attempt',
    );
    expect(
      thrownDomainError(() => formatExternalOperationKey(taskId, 'AUTH', 1.5)).valueObject,
    ).toBe('Attempt');
  });

  it('parse 要求恰好三段：多一段或少一段都说明这个键不是本系统生成的', () => {
    for (const bad of [
      '',
      uuidAt(9),
      `${uuidAt(9)}:AUTH`,
      `${uuidAt(9)}:AUTH:1:extra`,
      'a:b:c:d:e',
    ]) {
      expect(thrownDomainError(() => parseExternalOperationKey(bad)).valueObject).toBe(
        'ExternalOperationKey',
      );
    }
  });

  it('parse 拒绝伪造的 attempt：0 与前导零都出局', () => {
    // 十进制模式 `^(?:0|[1-9][0-9]*)$` 接受 `0` 但拒绝 `01`；随后 `attempt < 1` 再拒 `0`。
    // 两条路径报的都是 `'Attempt'` —— 键的整体形状没问题，坏的只是那一段。
    expect(
      thrownDomainError(() => parseExternalOperationKey(`${uuidAt(9)}:AUTH:0`)).valueObject,
    ).toBe('Attempt');
    expect(
      thrownDomainError(() => parseExternalOperationKey(`${uuidAt(9)}:AUTH:01`)).valueObject,
    ).toBe('Attempt');
    expect(
      thrownDomainError(() => parseExternalOperationKey(`${uuidAt(9)}:AUTH:x`)).valueObject,
    ).toBe('Attempt');
    expect(
      thrownDomainError(() => parseExternalOperationKey(`${uuidAt(9)}:NOPE:1`)).valueObject,
    ).toBe('TaskStage');
    expect(thrownDomainError(() => parseExternalOperationKey(`bogus:AUTH:1`)).valueObject).toBe(
      'TaskId',
    );
  });

  it('键本身也过敏感形状检查，且不回流原文', () => {
    const bad = `${uuidAt(9)}:AUTH:1?sig=abc`;
    const error = thrownDomainError(() => parseExternalOperationKey(bad));
    expect(error.message).not.toContain('sig=abc');
  });
});

describe('ProviderUsage：domain 接受规范化用量，不接原始 provider response', () => {
  it('unit 是必填输入，不由 capability 派生（派生会掩盖账本上的量纲不一致）', () => {
    const usage = createProviderUsage({
      provider: 'QCA',
      capability: 'QCA_TASK',
      unit: 'CREDIT',
      quantity: 12,
      estimatedCredits: 30,
    });
    expect(usage).toEqual({
      provider: 'QCA',
      capability: 'QCA_TASK',
      unit: 'CREDIT',
      quantity: 12,
      estimatedCredits: 30,
      providerReportedCredits: null,
      durationMs: null,
      modelId: null,
    });
    expect(Object.keys(usage).sort()).toEqual([
      'capability',
      'durationMs',
      'estimatedCredits',
      'modelId',
      'provider',
      'providerReportedCredits',
      'quantity',
      'unit',
    ]);
  });

  it('可选字段显式给 null 与省略等价', () => {
    const usage = createProviderUsage({
      provider: 'BAILIAN',
      capability: 'TTS',
      unit: 'CHARACTER',
      quantity: 480,
      estimatedCredits: 3,
      providerReportedCredits: null,
      durationMs: null,
      modelId: null,
    });
    expect(usage.providerReportedCredits).toBeNull();
    expect(usage.durationMs).toBeNull();
    expect(usage.modelId).toBeNull();
  });

  it('estimatedCredits 与 providerReportedCredits 都保留，谁也不覆盖谁', () => {
    const usage = createProviderUsage({
      provider: 'BAILIAN',
      capability: 'IMAGE_GENERATION',
      unit: 'IMAGE',
      quantity: 2,
      estimatedCredits: 20,
      providerReportedCredits: 17,
      modelId: 'wanx-v1',
    });
    expect(usage.estimatedCredits).toBe(20);
    expect(usage.providerReportedCredits).toBe(17);
    expect(usage.modelId).toBe('wanx-v1');
  });

  it('负数量、负额度与非法 modelId 都被拒绝', () => {
    const base = {
      provider: 'QCA',
      capability: 'QCA_TASK',
      unit: 'CREDIT',
    } as const;
    expect(
      thrownDomainError(() => createProviderUsage({ ...base, quantity: -1, estimatedCredits: 1 }))
        .valueObject,
    ).toBe('UsageQuantity');
    expect(
      thrownDomainError(() => createProviderUsage({ ...base, quantity: 1, estimatedCredits: -1 }))
        .valueObject,
    ).toBe('Credits');
    expect(
      thrownDomainError(() =>
        createProviderUsage({ ...base, quantity: 1, estimatedCredits: 1, durationMs: -1 }),
      ).valueObject,
    ).toBe('DurationMs');
    expect(
      thrownDomainError(() =>
        createProviderUsage({
          ...base,
          quantity: 1,
          estimatedCredits: 1,
          modelId: repeat('m', 129),
        }),
      ).valueObject,
    ).toBe('ModelId');
    expect(
      thrownDomainError(() =>
        createProviderUsage({
          ...base,
          quantity: 1,
          estimatedCredits: 1,
          providerReportedCredits: -1,
        }),
      ).valueObject,
    ).toBe('Credits');
  });

  it('assertProviderUsageCoherent 挡住量纲不一致，否则结算差额算不出来', () => {
    const usage = createProviderUsage({
      provider: 'QCA',
      capability: 'QCA_TASK',
      unit: 'CREDIT',
      quantity: 1,
      estimatedCredits: 1,
    });
    expect(() => assertProviderUsageCoherent(usage, 'CREDIT')).not.toThrow();
    const error = thrownDomainError(() => assertProviderUsageCoherent(usage, 'IMAGE'));
    expect(error.code).toBe('REQUEST_INVALID');
    expect(error.valueObject).toBe('ProviderUsage.unit');
  });
});

describe('safe-text：敏感形状识别与规则优先级', () => {
  it('识别控制字符、绝对/协议相对 URL、签名参数、Bearer、凭证赋值与 JWT', () => {
    expect(detectSensitiveText('a\u0000b')).toBe('CONTROL_CHARACTER');
    expect(detectSensitiveText('a\nb')).toBe('CONTROL_CHARACTER');
    expect(detectSensitiveText('https://example.com/a')).toBe('ABSOLUTE_URL');
    expect(detectSensitiveText('s3://bucket/key')).toBe('ABSOLUTE_URL');
    expect(detectSensitiveText('//cdn.example.com/a')).toBe('PROTOCOL_RELATIVE_URL');
    expect(detectSensitiveText('/a?sig=abc')).toBe('SIGNED_URL_PARAMETER');
    expect(detectSensitiveText('/a?X-Amz-Credential=abc')).toBe('SIGNED_URL_PARAMETER');
    expect(detectSensitiveText('/a?x-goog-signature=abc')).toBe('SIGNED_URL_PARAMETER');
    expect(detectSensitiveText('Bearer abc')).toBe('BEARER_TOKEN');
    expect(detectSensitiveText('basic Zm9vOmJhcg==')).toBe('BEARER_TOKEN');
    expect(detectSensitiveText('password = hunter2')).toBe('CREDENTIAL_ASSIGNMENT');
    expect(detectSensitiveText('api_key:abc')).toBe('CREDENTIAL_ASSIGNMENT');
    expect(detectSensitiveText(jwtLike())).toBe('JWT_LIKE');
    expect(detectSensitiveText('/a?b=1')).toBe('URL_QUERY_STRING');
    expect(detectSensitiveText('projects/abc/manifest.json')).toBeNull();
    expect(detectSensitiveText('work.json')).toBeNull();
    expect(detectSensitiveText('v1.0.0')).toBeNull();
    expect(detectSensitiveText('')).toBeNull();
  });

  it('规则顺序是语义的：多命中时报告最具体的那一条', () => {
    // SIGNED_URL_PARAMETER 必须排在 URL_QUERY_STRING 之前，否则真正的原因被埋掉。
    expect(detectSensitiveText('/a?sig=1')).toBe('SIGNED_URL_PARAMETER');
    expect(detectSensitiveText('/a?b=1')).toBe('URL_QUERY_STRING');
    // 控制字符优先于一切：换行能把任何一行伪造成两行。
    expect(detectSensitiveText('https://x.example/a?sig=1\n')).toBe('CONTROL_CHARACTER');
    // 绝对 URL 优先于它自带的签名参数：先说清"这是个外部 URL"更有用。
    expect(detectSensitiveText('https://x.example/a?sig=1')).toBe('ABSOLUTE_URL');
    // Bearer 优先于凭证赋值。
    expect(detectSensitiveText('Authorization: Bearer abc')).toBe('BEARER_TOKEN');
    expect(detectSensitiveText('authorization = abc')).toBe('CREDENTIAL_ASSIGNMENT');
  });

  it('isSensitiveText 与 detectSensitiveText 结论一致', () => {
    expect(isSensitiveText('https://example.com/a')).toBe(true);
    expect(isSensitiveText('projects/abc/manifest.json')).toBe(false);
  });

  it('ABSOLUTE_URL 锚定在串首：整串是 URL 才拒，正文里提到 URL 不误伤', () => {
    expect(detectSensitiveText('see https://example.com/a')).toBeNull();
    // 现实中的失误形态是「把供应商 URL 当成逻辑 key 传进来」，那种值整体以 `scheme://`
    // 开头，因此被 `^`-anchored 的规则拦下；签名参数规则不锚定，出现在串中任何位置都拦。
    expect(isArtifactRef('https://bucket.example.com/a/b')).toBe(false);
    expect(isRuntimeRef('https://bucket.example.com/a/b')).toBe(false);
    expect(isArtifactRef('projects/x/manifest.json?X-Amz-Signature=deadbeef')).toBe(false);
    // 串中一段无签名的 URL 不含任何凭证，放行；这里钉住的是「不锚定就会误伤」的反面。
    expect(isArtifactRef('see https://example.com/a')).toBe(true);
  });

  it('非字符串输入按控制字符处理，不抛 TypeError', () => {
    expect(detectSensitiveText(42 as unknown as string)).toBe('CONTROL_CHARACTER');
    expect(detectSensitiveText(null as unknown as string)).toBe('CONTROL_CHARACTER');
    expect(detectSensitiveText(undefined as unknown as string)).toBe('CONTROL_CHARACTER');
  });

  it('assertNotSensitiveText 抛 DomainError，被拒文本不进 message 也不进 stack', () => {
    const signed = 'https://x.example/a?X-Amz-Signature=deadbeef';
    const error = thrownDomainError(() => assertNotSensitiveText(signed, 'ArtifactRef'));
    expect(error.message).toBe('REQUEST_INVALID: ArtifactRef');
    expect(error.message).not.toContain('deadbeef');
    expect(error.stack ?? '').not.toContain('deadbeef');
    expect(() => assertNotSensitiveText('projects/a/b.json', 'ArtifactRef')).not.toThrow();
  });

  it('安全载荷键名：小驼峰 1..64，黑名单按词边界匹配', () => {
    for (const good of [
      'taskId',
      'progress',
      'state',
      'attempt',
      'idempotencyKey',
      'eventKey',
      'sourceEventKey',
      'path',
      'revision',
    ]) {
      expect(isSafeKey(good)).toBe(true);
    }
    for (const bad of [
      'TaskId',
      'task_id',
      'task-id',
      '1task',
      '',
      repeat('a', 65),
      'password',
      'passwordHint',
      'pat',
      'studentPrompt',
      'stackTrace',
      'errorDigest',
      'sessionToken',
      'cookieHeader',
      'authorizationHeader',
      'xAmzSignature',
      'bearerToken',
      'credentialRef',
      'secretRef',
    ]) {
      expect(isSafeKey(bad)).toBe(false);
    }
  });

  it('pat 用词边界匹配，不误伤 path；key 不做子串匹配，否则合法的领域概念全被挡掉', () => {
    expect(isForbiddenSafeKey('pat')).toBe(true);
    expect(isForbiddenSafeKey('path')).toBe(false);
    expect(isForbiddenSafeKey('patch')).toBe(false);
    expect(isForbiddenSafeKey('dispatch')).toBe(false);
    expect(isForbiddenSafeKey('idempotencyKey')).toBe(false);
    expect(isForbiddenSafeKey('eventKey')).toBe(false);
    expect(isForbiddenSafeKey('sourceEventKey')).toBe(false);
    expect(isForbiddenSafeKey('signature')).toBe(true);
  });

  it('安全载荷键名上限 64，正好卡在形状边界', () => {
    expect(isSafeKey('a' + repeat('b', 63))).toBe(true);
    expect(isSafeKey('a' + repeat('b', 64))).toBe(false);
  });

  it('只允许 JSON 标量：对象与数组一律拒绝，防止嵌套夹带', () => {
    expect(isSafeScalar(null)).toBe(true);
    expect(isSafeScalar(true)).toBe(true);
    expect(isSafeScalar(false)).toBe(true);
    expect(isSafeScalar(0)).toBe(true);
    expect(isSafeScalar(-1.5)).toBe(true);
    expect(isSafeScalar('x')).toBe(true);
    expect(isSafeScalar('')).toBe(true);
    for (const bad of [undefined, {}, [], () => 1, Symbol('s'), 1n]) {
      expect(isSafeScalar(bad)).toBe(false);
    }
  });

  it('NaN / Infinity 虽然 typeof 是 number，但 JSON 会把它们序列化成 null（静默丢字段）', () => {
    expect(isSafeScalar(Number.NaN)).toBe(false);
    expect(isSafeScalar(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeScalar(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(JSON.stringify({ progress: Number.NaN })).toBe('{"progress":null}');
  });

  it('isSafeEntry 同时查键名与值形状：两者缺一不可', () => {
    expect(isSafeEntry('taskId', 'abc')).toBe(true);
    expect(isSafeEntry('progress', 42)).toBe(true);
    expect(isSafeEntry('done', null)).toBe(true);
    // 键名无害但内容是签名 URL。
    expect(isSafeEntry('location', 'https://x.example/a?sig=1')).toBe(false);
    expect(isSafeEntry('location', '/a?sig=1')).toBe(false);
    // 键名就宣告了这是凭证。
    expect(isSafeEntry('password', 'x')).toBe(false);
    expect(isSafeEntry('studentPrompt', '做一个小游戏')).toBe(false);
    // 值不是标量。
    expect(isSafeEntry('payload', { a: 1 })).toBe(false);
    expect(isSafeEntry('payload', [1, 2])).toBe(false);
    expect(isSafeEntry('payload', Number.NaN)).toBe(false);
    expect(isSafeEntry('TaskId', 'abc')).toBe(false);
  });
});

function jwtLike(): string {
  const segment = repeat('a', 16);
  return `${segment}.${segment}.${segment}`;
}

describe('配置/编程错误抛普通 Error，不抛 DomainError', () => {
  /**
   * `DomainError` 会被 adapter 映射成 §5.2 的错误码并变成一个 HTTP 响应；普通 `Error`
   * 不会。下面这些守卫挡的是**部署配置或调用方 bug**，不是学生发来的坏请求：把它们
   * 变成 400 等于让学生的请求为运维的部署问题背锅，还会把一个应当在 CI 里就红的
   * 问题推迟到线上。因此"抛哪一种错"本身是被测行为。
   */
  const guards: readonly (readonly [string, () => unknown])[] = [
    ['stringEnum 空成员表', () => stringEnum('Empty', [])],
    ['stringEnum 重复成员', () => stringEnum('Dup', ['A', 'A'] as const)],
    ['textValueObject 边界倒置', () => textValueObject('Bad', 10, 1)],
    ['textValueObject minLength < 1', () => textValueObject('Bad', 0, 10)],
    ['integerValueObject 边界倒置', () => integerValueObject('Bad', 10, 1)],
    [
      'createGroupSettings 非布尔开关',
      () =>
        createGroupSettings({ memberLimit: 3, studentPeerViewEnabled: 1 as unknown as boolean }),
    ],
    [
      'remainingMemberSlots 负计数',
      () =>
        remainingMemberSlots(
          -1,
          createGroupSettings({ memberLimit: 3, studentPeerViewEnabled: false }),
        ),
    ],
    ['canLikeToday 负计数', () => canLikeToday(-1, parseLikeDailyLimit(3))],
    [
      'isLockThresholdReached 负计数',
      () =>
        isLockThresholdReached(-1, {
          maxFailedAttempts: parseMaxFailedAttempts(3),
          lockDurationMinutes: parseLockDurationMinutes(30),
        }),
    ],
    ['isWithinRestoreWindow 非法窗口', () => isWithinRestoreWindow(EPOCH_TS, EPOCH_TS, 0)],
    ['isWithinWorkRestoreWindow 非法窗口', () => isWithinWorkRestoreWindow(EPOCH_TS, EPOCH_TS, 0)],
    [
      'assertReservationOutlivesTask 预留先于硬超时',
      () => assertReservationOutlivesTask(EPOCH_TS, NEXT_DAY),
    ],
  ];

  it.each(guards)('%s 抛出的不是 DomainError', (_label, run) => {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DomainError);
  });

  it('反向对照：入参校验失败确实抛 DomainError，并带出被拒的值对象名', () => {
    // 只断言「抛了 Error」不足以区分这两类：DomainError 的 `valueObject` 才是 adapter
    // 用来生成错误消息 key 的东西，普通 Error 没有它，只有堆栈。
    expect(thrownDomainError(() => parseMemberLimit(0)).valueObject).toBe('MemberLimit');
    expect(thrownDomainError(() => parseAttempt(0)).valueObject).toBe('Attempt');
    expect(thrownDomainError(() => parseLikeDailyLimit(0)).valueObject).toBe('LikeDailyLimit');
    expect(thrownDomainError(() => parseMaxFailedAttempts(0)).valueObject).toBe(
      'MaxFailedAttempts',
    );
    expect(thrownDomainError(() => parseLockDurationMinutes(0)).valueObject).toBe(
      'LockDurationMinutes',
    );
  });
});

describe('值对象不承载宿主状态', () => {
  it('序列化后不含绝对路径、当前日期或当前时刻', () => {
    const serialized = JSON.stringify({
      kinds: TASK_KINDS,
      states: TASK_STATES,
      stages: TASK_STAGES,
      capabilities: CAPABILITIES,
      units: USAGE_UNITS,
      providers: USAGE_PROVIDERS,
      secretKinds: SECRET_KINDS,
      limits: {
        prompt: [PROMPT_MIN_LENGTH, PROMPT_MAX_LENGTH],
        idempotencyKey: [IDEMPOTENCY_KEY_MIN_LENGTH, IDEMPOTENCY_KEY_MAX_LENGTH],
        password: [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH],
        restoreWindow: [PROJECT_RESTORE_WINDOW_DAYS, WORK_RESTORE_WINDOW_DAYS],
        deadlines: [
          SOFT_DEADLINE_SECONDS_SIMPLE,
          SOFT_DEADLINE_SECONDS_COMPLEX,
          HARD_DEADLINE_MINUTES,
          LEASE_SCAN_INTERVAL_MINUTES,
        ],
        repairBudget: TASK_REPAIR_BUDGET,
      },
      periodKey: periodKey(EPOCH_TS, 'DAILY', parseTimezoneOffsetMinutes(0)),
    });
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('C:\\');
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // 期望值来自写死的字面量，不是扫描宿主得来的。
    expect(serialized).toContain('2026-03-01');
    expect(serialized).not.toContain(String(new Date().getFullYear() + 1));
  });

  it('同一批输入连续两次求值逐字节相同', () => {
    const evaluate = (): string =>
      JSON.stringify([
        periodKey(EPOCH_TS, 'MONTHLY', parseTimezoneOffsetMinutes(-60)),
        plusDaysUtc(EPOCH_TS, 30),
        timestampSortKey(EPOCH_TS),
        formatETag(parseRevision('7')),
        formatExternalOperationKey(parseTaskId(uuidAt(9)), 'AUTH', 1),
      ]);
    expect(evaluate()).toBe(evaluate());
  });
});

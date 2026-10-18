import { DomainError } from '../errors/domain-error.js';
import { brand, type Branded } from './brand.js';

/**
 * 实体标识符。
 *
 * 除 `TaskEventId` 外一律是 UUIDv7（ZLQ-153 §4.2：主键统一 UUIDv7，D1 以 36 字符
 * 文本保存，PostgreSQL 用 `uuid`）。`TaskEventId` 是单任务内单调递增的序列，
 * 对外序列化为十进制字符串 —— bigint 经 JSON 会丢精度，所以线上不用数字类型。
 */

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export type UuidV7 = Branded<string, 'UuidV7'>;

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

export function parseUuidV7(value: string): UuidV7 {
  if (!isUuidV7(value)) throw DomainError.invalid('UuidV7');
  return brand<string, 'UuidV7'>(value);
}

export type UuidV7Parser<Name extends string> = (value: string) => Branded<string, Name>;

function uuidV7Parser<Name extends string>(name: string): UuidV7Parser<Name> {
  return (value) => {
    if (!isUuidV7(value)) throw DomainError.invalid(name);
    return brand<string, Name>(value);
  };
}

export type UserId = Branded<string, 'UserId'>;
/** 同一身份在「归属者」角色下的名字；不另立品牌，避免无意义的来回转换。 */
export type OwnerId = UserId;
export type GroupId = Branded<string, 'GroupId'>;
export type ProjectId = Branded<string, 'ProjectId'>;
export type ProjectVersionId = Branded<string, 'ProjectVersionId'>;
export type WorkId = Branded<string, 'WorkId'>;
export type PublicationId = Branded<string, 'PublicationId'>;
export type TaskId = Branded<string, 'TaskId'>;
export type UsageLimitId = Branded<string, 'UsageLimitId'>;
export type UsageReservationId = Branded<string, 'UsageReservationId'>;
export type UsageLedgerEntryId = Branded<string, 'UsageLedgerEntryId'>;
export type CourseId = Branded<string, 'CourseId'>;
export type LessonId = Branded<string, 'LessonId'>;
export type AssignmentId = Branded<string, 'AssignmentId'>;
export type SubmissionId = Branded<string, 'SubmissionId'>;
export type GradingId = Branded<string, 'GradingId'>;
export type AchievementId = Branded<string, 'AchievementId'>;
/** 模板不是本行的聚合，但 `projects.template_id` 已存在，故只需一个 ID 值对象。 */
export type TemplateId = Branded<string, 'TemplateId'>;

export const parseUserId = uuidV7Parser<'UserId'>('UserId');
export const parseGroupId = uuidV7Parser<'GroupId'>('GroupId');
export const parseProjectId = uuidV7Parser<'ProjectId'>('ProjectId');
export const parseProjectVersionId = uuidV7Parser<'ProjectVersionId'>('ProjectVersionId');
export const parseWorkId = uuidV7Parser<'WorkId'>('WorkId');
export const parsePublicationId = uuidV7Parser<'PublicationId'>('PublicationId');
export const parseTaskId = uuidV7Parser<'TaskId'>('TaskId');
export const parseUsageLimitId = uuidV7Parser<'UsageLimitId'>('UsageLimitId');
export const parseUsageReservationId = uuidV7Parser<'UsageReservationId'>('UsageReservationId');
export const parseUsageLedgerEntryId = uuidV7Parser<'UsageLedgerEntryId'>('UsageLedgerEntryId');
export const parseCourseId = uuidV7Parser<'CourseId'>('CourseId');
export const parseLessonId = uuidV7Parser<'LessonId'>('LessonId');
export const parseAssignmentId = uuidV7Parser<'AssignmentId'>('AssignmentId');
export const parseSubmissionId = uuidV7Parser<'SubmissionId'>('SubmissionId');
export const parseGradingId = uuidV7Parser<'GradingId'>('GradingId');
export const parseAchievementId = uuidV7Parser<'AchievementId'>('AchievementId');
export const parseTemplateId = uuidV7Parser<'TemplateId'>('TemplateId');

/** 单任务内单调递增的事件序列；SSE 的 `id:` 行与 `TaskEvent.sequence` 都是它。 */
export type TaskEventId = Branded<string, 'TaskEventId'>;

export function isTaskEventId(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && BigInt(value) > 0n;
}

export function parseTaskEventId(value: string): TaskEventId {
  if (!isTaskEventId(value)) throw DomainError.invalid('TaskEventId');
  return brand<string, 'TaskEventId'>(value);
}

export function formatTaskEventId(sequence: bigint): TaskEventId {
  if (sequence <= 0n) throw DomainError.invalid('TaskEventId');
  return brand<string, 'TaskEventId'>(sequence.toString(10));
}

export function nextTaskEventId(previous: TaskEventId | null): TaskEventId {
  return formatTaskEventId(previous === null ? 1n : BigInt(previous) + 1n);
}

/**
 * `GroupMembership` / `AchievementUnlock` / `Like` 没有自己的 ID：它们的主键是
 * 联合键（ZLQ-153 §4.3 / §4.7），领域侧用组合值表示而不是造一个代理键。
 */
export type GroupMembershipKey = { readonly groupId: GroupId; readonly userId: UserId };
export type AchievementUnlockKey = {
  readonly userId: UserId;
  readonly achievementId: AchievementId;
};
export type LikeKey = { readonly userId: UserId; readonly workId: WorkId };

/** `RewardProfile` 以 user_id 为主键，不另设 ID。 */
export type RewardProfileKey = { readonly userId: UserId };

export function sameKey<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left).sort() as (keyof T)[];
  return keys.every((key) => left[key] === right[key]);
}

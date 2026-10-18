import { DomainError } from '../errors/domain-error.js';
import { integerValueObject, parseScore, textValueObject, type Score } from './primitives.js';
import { stringEnum } from './enum.js';

/**
 * Teaching 聚合的值对象（ZLQ-153 §4.7 / 附录 A §6.1–§6.3）。
 *
 * `rubric_json` 的物理编解码属于 infra；进入 domain 前必须已经解析成这里的
 * 有类型 `Rubric`（附录 A §6.4）。
 */

export const COURSE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];
const courseStatusEnum = stringEnum<CourseStatus>('CourseStatus', COURSE_STATUSES);
export const isCourseStatus = courseStatusEnum.is;
export const parseCourseStatus = courseStatusEnum.parse;

export const ASSIGNMENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
const assignmentStatusEnum = stringEnum<AssignmentStatus>('AssignmentStatus', ASSIGNMENT_STATUSES);
export const isAssignmentStatus = assignmentStatusEnum.is;
export const parseAssignmentStatus = assignmentStatusEnum.parse;

/**
 * 提交状态。**重交创建新的 Submission，不覆盖历史**（附录 A §6.2），
 * 所以这里没有 `RESUBMITTED`：一次重交就是另一条记录。
 */
export const SUBMISSION_STATUSES = ['SUBMITTED', 'GRADED', 'REVISION_REQUESTED'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
const submissionStatusEnum = stringEnum<SubmissionStatus>('SubmissionStatus', SUBMISSION_STATUSES);
export const isSubmissionStatus = submissionStatusEnum.is;
export const parseSubmissionStatus = submissionStatusEnum.parse;

/**
 * 学习进度是**派生**状态，不落库为独立枚举列（附录 A §6.2）。
 * 「逾期」是独立 flag，不塞进这个枚举 —— 逾期与进度是两个正交维度。
 */
export const LEARNING_PROGRESS_STATES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'GRADED',
  'REVISION_REQUIRED',
] as const;
export type LearningProgressState = (typeof LEARNING_PROGRESS_STATES)[number];
const learningProgressEnum = stringEnum<LearningProgressState>(
  'LearningProgressState',
  LEARNING_PROGRESS_STATES,
);
export const isLearningProgressState = learningProgressEnum.is;
export const parseLearningProgressState = learningProgressEnum.parse;

export type LessonSequence = ReturnType<typeof lessonSequenceValue.parse>;
export type EstimatedMinutes = ReturnType<typeof estimatedMinutesValue.parse>;

const lessonSequenceValue = integerValueObject('LessonSequence', 1, Number.MAX_SAFE_INTEGER);
const estimatedMinutesValue = integerValueObject('EstimatedMinutes', 1, 600);

/** 同一课程内 sequence 唯一（附录 A §6.3）。 */
export function parseLessonSequence(value: number): LessonSequence {
  return lessonSequenceValue.parse(value);
}

export function parseEstimatedMinutes(value: number): EstimatedMinutes {
  return estimatedMinutesValue.parse(value);
}

export const COURSE_TITLE_MAX_LENGTH = 100;
const courseTitleValue = textValueObject('CourseTitle', 1, COURSE_TITLE_MAX_LENGTH);
export type CourseTitle = ReturnType<typeof courseTitleValue.parse>;
export const isCourseTitle = courseTitleValue.is;
export const parseCourseTitle = courseTitleValue.parse;

export const LESSON_TITLE_MAX_LENGTH = 100;
const lessonTitleValue = textValueObject('LessonTitle', 1, LESSON_TITLE_MAX_LENGTH);
export type LessonTitle = ReturnType<typeof lessonTitleValue.parse>;
export const isLessonTitle = lessonTitleValue.is;
export const parseLessonTitle = lessonTitleValue.parse;

export const ASSIGNMENT_TITLE_MAX_LENGTH = 100;
const assignmentTitleValue = textValueObject('AssignmentTitle', 1, ASSIGNMENT_TITLE_MAX_LENGTH);
export type AssignmentTitle = ReturnType<typeof assignmentTitleValue.parse>;
export const isAssignmentTitle = assignmentTitleValue.is;
export const parseAssignmentTitle = assignmentTitleValue.parse;

export const ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH = 4000;
const assignmentInstructionsValue = textValueObject(
  'AssignmentInstructions',
  1,
  ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH,
);
export type AssignmentInstructions = ReturnType<typeof assignmentInstructionsValue.parse>;
export const isAssignmentInstructions = assignmentInstructionsValue.is;
export const parseAssignmentInstructions = assignmentInstructionsValue.parse;

export const GRADE_FEEDBACK_MAX_LENGTH = 2000;
const gradeFeedbackValue = textValueObject('GradeFeedback', 1, GRADE_FEEDBACK_MAX_LENGTH);
export type GradeFeedback = ReturnType<typeof gradeFeedbackValue.parse>;
export const isGradeFeedback = gradeFeedbackValue.is;
export const parseGradeFeedback = gradeFeedbackValue.parse;

export const RUBRIC_CRITERION_KEY_MAX_LENGTH = 40;
const rubricCriterionKeyValue = textValueObject(
  'RubricCriterionKey',
  1,
  RUBRIC_CRITERION_KEY_MAX_LENGTH,
);
export type RubricCriterionKey = ReturnType<typeof rubricCriterionKeyValue.parse>;

export const RUBRIC_CRITERION_LABEL_MAX_LENGTH = 120;
const rubricCriterionLabelValue = textValueObject(
  'RubricCriterionLabel',
  1,
  RUBRIC_CRITERION_LABEL_MAX_LENGTH,
);
export type RubricCriterionLabel = ReturnType<typeof rubricCriterionLabelValue.parse>;

export type RubricCriterion = {
  readonly key: RubricCriterionKey;
  readonly label: RubricCriterionLabel;
  readonly maxScore: Score;
};

export type Rubric = {
  readonly criteria: readonly RubricCriterion[];
  readonly totalMaxScore: Score;
};

/**
 * 评分量规。不变量：至少一条评分项、key 唯一、`totalMaxScore` 等于各项满分之和。
 *
 * 把「总分等于分项之和」放在构造期而不是查询期，批改分数越界就无从发生。
 */
export function createRubric(
  criteria: readonly { readonly key: string; readonly label: string; readonly maxScore: number }[],
): Rubric {
  if (criteria.length === 0) throw DomainError.invalid('Rubric');
  const seen = new Set<string>();
  let total = 0;
  const parsed: RubricCriterion[] = [];
  for (const criterion of criteria) {
    const key = rubricCriterionKeyValue.parse(criterion.key);
    if (seen.has(key)) throw DomainError.invalid('Rubric');
    seen.add(key);
    const maxScore = parseScore(criterion.maxScore);
    if (maxScore < 1) throw DomainError.invalid('Rubric');
    total += maxScore;
    parsed.push({ key, label: rubricCriterionLabelValue.parse(criterion.label), maxScore });
  }
  return { criteria: parsed, totalMaxScore: parseScore(total) };
}

/** 批改分数是否落在量规允许的区间内。 */
export function isScoreWithinRubric(score: Score, rubric: Rubric): boolean {
  return score <= rubric.totalMaxScore;
}

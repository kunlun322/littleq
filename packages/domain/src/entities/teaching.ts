/**
 * Teaching 聚合（附录 A §6.1、§6.2、§6.3 `courses/lessons`、`assignments`、
 * `submissions/gradings`）。
 *
 * domain 侧持有课程/课时的身份与状态、作业的量规与截止、提交与批改的绑定关系。
 * `content_object_key` 的 provider 映射、rubric JSON 编解码、查询索引与事务都在
 * infra（§6.3 右栏）：因此 `Lesson.contentRef` 是 opaque 的 `ContentRef`，
 * `Assignment.rubric` 是**已解析的有类型值对象**而不是 JSON（§6.4）。
 *
 * 三条关键不变量：
 * 1. 同课程内 `sequence` 唯一且从 1 连续（§6.3）；
 * 2. 归档只读 —— Course `ARCHIVED` 之后课时与作业都不可再改（§6.2）；
 * 3. 提交绑定**不可变** projectVersion，重交创建**新** Submission（§6.3），
 *    批改一对一当前 Submission 并保留历史（旧 Submission 的 Grading 不迁移）。
 */

import { DomainError } from '../errors/domain-error.js';
import {
  ASSIGNMENT_TRANSITIONS,
  COURSE_TRANSITIONS,
  LEARNING_PROGRESS_TRANSITIONS,
  SUBMISSION_TRANSITIONS,
} from '../states/machines.js';
import { assertTransition } from '../states/transition.js';
import {
  parseAssignmentId,
  parseCourseId,
  parseGradingId,
  parseGroupId,
  parseLessonId,
  parseProjectVersionId,
  parseSubmissionId,
  parseUserId,
  type AssignmentId,
  type CourseId,
  type GradingId,
  type GroupId,
  type LessonId,
  type ProjectVersionId,
  type SubmissionId,
  type UserId,
} from '../value-objects/identifiers.js';
import {
  isBefore,
  nextRevision,
  parseDueAt,
  parseRevision,
  parseScore,
  parseTimestamp,
  type DueAt,
  type Revision,
  type Score,
  type Timestamp,
} from '../value-objects/primitives.js';
import {
  createRubric,
  isScoreWithinRubric,
  parseAssignmentInstructions,
  parseAssignmentStatus,
  parseAssignmentTitle,
  parseCourseStatus,
  parseCourseTitle,
  parseEstimatedMinutes,
  parseLearningProgressState,
  parseLessonSequence,
  parseLessonTitle,
  parseSubmissionStatus,
  type AssignmentInstructions,
  type AssignmentStatus,
  type AssignmentTitle,
  type CourseStatus,
  type CourseTitle,
  type EstimatedMinutes,
  type GradeFeedback,
  type LearningProgressState,
  type LessonSequence,
  type LessonTitle,
  type Rubric,
  type SubmissionStatus,
  parseGradeFeedback,
} from '../value-objects/teaching.js';
import { parseContentRef, type ContentRef } from '../value-objects/refs.js';

export type Course = {
  readonly id: CourseId;
  readonly groupId: GroupId;
  readonly title: CourseTitle;
  readonly status: CourseStatus;
  readonly createdBy: UserId;
  readonly createdAt: Timestamp;
  readonly revision: Revision;
};

export function createCourse(input: {
  readonly id: string;
  readonly groupId: string;
  readonly title: string;
  readonly status?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revision?: string;
}): Course {
  return {
    id: parseCourseId(input.id),
    groupId: parseGroupId(input.groupId),
    title: parseCourseTitle(input.title),
    status: input.status === undefined ? 'DRAFT' : parseCourseStatus(input.status),
    createdBy: parseUserId(input.createdBy),
    createdAt: parseTimestamp(input.createdAt),
    revision: input.revision === undefined ? parseRevision('0') : parseRevision(input.revision),
  };
}

export function publishCourse(course: Course): Course {
  return withCourseStatus(course, 'PUBLISHED');
}

export function archiveCourse(course: Course): Course {
  return withCourseStatus(course, 'ARCHIVED');
}

function withCourseStatus(course: Course, status: CourseStatus): Course {
  assertTransition(COURSE_TRANSITIONS, course.status, status, 'REQUEST_INVALID');
  return { ...course, status, revision: nextRevision(course.revision) };
}

/** 归档只读（§6.2）。`ARCHIVED` 是终态，没有恢复边。 */
export function assertCourseWritable(course: Course): void {
  if (course.status === 'ARCHIVED') throw DomainError.invalid('Course.status');
}

export function renameCourse(course: Course, title: string): Course {
  assertCourseWritable(course);
  return { ...course, title: parseCourseTitle(title), revision: nextRevision(course.revision) };
}

export type Lesson = {
  readonly id: LessonId;
  readonly courseId: CourseId;
  readonly sequence: LessonSequence;
  readonly title: LessonTitle;
  readonly contentRef: ContentRef;
  readonly estimatedMinutes: EstimatedMinutes;
};

export function createLesson(input: {
  readonly id: string;
  readonly courseId: string;
  readonly sequence: number;
  readonly title: string;
  readonly contentRef: string;
  readonly estimatedMinutes: number;
}): Lesson {
  return {
    id: parseLessonId(input.id),
    courseId: parseCourseId(input.courseId),
    sequence: parseLessonSequence(input.sequence),
    title: parseLessonTitle(input.title),
    contentRef: parseContentRef(input.contentRef),
    estimatedMinutes: parseEstimatedMinutes(input.estimatedMinutes),
  };
}

/**
 * 同课程内 `sequence` 唯一（§6.3）。
 *
 * 这里只判定唯一性，不判定连续性：课时可以被删除，留下空洞是正常的，
 * 强行要求 1..N 连续会让"删掉第 3 课"变成一次全表重排。
 */
export function assertLessonSequenceFree(lesson: Lesson, existing: readonly Lesson[]): void {
  for (const other of existing) {
    if (other.id === lesson.id) continue;
    if (other.courseId !== lesson.courseId) continue;
    if (other.sequence === lesson.sequence) throw DomainError.invalid('Lesson.sequence');
  }
}

export function updateLesson(
  lesson: Lesson,
  input: {
    readonly title?: string;
    readonly contentRef?: string;
    readonly estimatedMinutes?: number;
  },
): Lesson {
  return {
    ...lesson,
    title: input.title === undefined ? lesson.title : parseLessonTitle(input.title),
    contentRef:
      input.contentRef === undefined ? lesson.contentRef : parseContentRef(input.contentRef),
    estimatedMinutes:
      input.estimatedMinutes === undefined
        ? lesson.estimatedMinutes
        : parseEstimatedMinutes(input.estimatedMinutes),
  };
}

export type Assignment = {
  readonly id: AssignmentId;
  readonly courseId: CourseId;
  readonly lessonId: LessonId | null;
  readonly title: AssignmentTitle;
  readonly instructions: AssignmentInstructions;
  readonly dueAt: DueAt;
  readonly rubric: Rubric;
  readonly status: AssignmentStatus;
  readonly revision: Revision;
};

export function createAssignment(input: {
  readonly id: string;
  readonly courseId: string;
  readonly lessonId?: string | null;
  readonly title: string;
  readonly instructions: string;
  readonly dueAt: string;
  readonly rubric: readonly {
    readonly key: string;
    readonly label: string;
    readonly maxScore: number;
  }[];
  readonly status?: string;
  readonly revision?: string;
}): Assignment {
  return {
    id: parseAssignmentId(input.id),
    courseId: parseCourseId(input.courseId),
    lessonId:
      input.lessonId === null || input.lessonId === undefined
        ? null
        : parseLessonId(input.lessonId),
    title: parseAssignmentTitle(input.title),
    instructions: parseAssignmentInstructions(input.instructions),
    dueAt: parseDueAt(input.dueAt),
    rubric: createRubric(input.rubric),
    status: input.status === undefined ? 'DRAFT' : parseAssignmentStatus(input.status),
    revision: input.revision === undefined ? parseRevision('0') : parseRevision(input.revision),
  };
}

export function publishAssignment(assignment: Assignment): Assignment {
  return withAssignmentStatus(assignment, 'PUBLISHED');
}

export function closeAssignment(assignment: Assignment): Assignment {
  return withAssignmentStatus(assignment, 'CLOSED');
}

export function archiveAssignment(assignment: Assignment): Assignment {
  return withAssignmentStatus(assignment, 'ARCHIVED');
}

function withAssignmentStatus(assignment: Assignment, status: AssignmentStatus): Assignment {
  assertTransition(ASSIGNMENT_TRANSITIONS, assignment.status, status, 'REQUEST_INVALID');
  return { ...assignment, status, revision: nextRevision(assignment.revision) };
}

/**
 * `PUBLISHED` 之后修改 rubric/dueAt 必须推进 revision（§6.3）。
 *
 * 学生已经看到的评分标准不能悄悄变：revision 前进让客户端的 `If-Match`
 * 失效，从而在协议层暴露"这份作业被改过"。草稿期（`DRAFT`）不推进 revision，
 * 因为那时还没有任何人在依赖它。
 */
export function updateAssignment(
  assignment: Assignment,
  input: {
    readonly title?: string;
    readonly instructions?: string;
    readonly dueAt?: string;
    readonly rubric?: readonly {
      readonly key: string;
      readonly label: string;
      readonly maxScore: number;
    }[];
  },
): Assignment {
  assertAssignmentWritable(assignment);
  const published = assignment.status === 'PUBLISHED';
  const rubric = input.rubric === undefined ? assignment.rubric : createRubric(input.rubric);
  const dueAt = input.dueAt === undefined ? assignment.dueAt : parseDueAt(input.dueAt);
  const semanticChange = input.rubric !== undefined || dueAt !== assignment.dueAt;
  return {
    ...assignment,
    title: input.title === undefined ? assignment.title : parseAssignmentTitle(input.title),
    instructions:
      input.instructions === undefined
        ? assignment.instructions
        : parseAssignmentInstructions(input.instructions),
    dueAt,
    rubric,
    revision: published && semanticChange ? nextRevision(assignment.revision) : assignment.revision,
  };
}

/**
 * 关闭与归档后不可再改。`CLOSED` 表示不再接受提交但批改仍可进行，
 * 所以"可写"指的是作业定义本身，与批改无关。
 */
export function assertAssignmentWritable(assignment: Assignment): void {
  if (assignment.status === 'CLOSED' || assignment.status === 'ARCHIVED') {
    throw DomainError.invalid('Assignment.status');
  }
}

/**
 * 个人延期是**独立 override**（§6.3）：它不改 `Assignment.dueAt`，
 * 因此不推进作业 revision，也不会影响其他学生。
 */
export type DueAtOverride = {
  readonly assignmentId: AssignmentId;
  readonly studentId: UserId;
  readonly dueAt: DueAt;
};

export function createDueAtOverride(input: {
  readonly assignmentId: string;
  readonly studentId: string;
  readonly dueAt: string;
}): DueAtOverride {
  return {
    assignmentId: parseAssignmentId(input.assignmentId),
    studentId: parseUserId(input.studentId),
    dueAt: parseDueAt(input.dueAt),
  };
}

/** 生效的截止时间：有个人延期用它，否则用作业本身的。 */
export function effectiveDueAt(assignment: Assignment, override: DueAtOverride | null): DueAt {
  if (override === null) return assignment.dueAt;
  if (override.assignmentId !== assignment.id)
    throw DomainError.invalid('DueAtOverride.assignmentId');
  return override.dueAt;
}

export type Submission = {
  readonly id: SubmissionId;
  readonly assignmentId: AssignmentId;
  readonly studentId: UserId;
  /** 绑定不可变的 projectVersion（§6.3）。 */
  readonly projectVersionId: ProjectVersionId;
  readonly submittedAt: Timestamp;
  readonly status: SubmissionStatus;
};

export function createSubmission(input: {
  readonly id: string;
  readonly assignmentId: string;
  readonly studentId: string;
  readonly projectVersionId: string;
  readonly submittedAt: string;
  readonly status?: string;
}): Submission {
  return {
    id: parseSubmissionId(input.id),
    assignmentId: parseAssignmentId(input.assignmentId),
    studentId: parseUserId(input.studentId),
    projectVersionId: parseProjectVersionId(input.projectVersionId),
    submittedAt: parseTimestamp(input.submittedAt),
    status: input.status === undefined ? 'SUBMITTED' : parseSubmissionStatus(input.status),
  };
}

/**
 * 逾期是**派生**的，不是存下来的字段（§6.3「submittedAt>dueAt 派生 late」）。
 * 存字段就意味着"什么时候算逾期"会被写死在插入时刻，个人延期一改就失真。
 */
export function isLateSubmission(submission: Submission, dueAt: DueAt): boolean {
  return isBefore(dueAt, submission.submittedAt);
}

export function gradeSubmissionRequest(submission: Submission): Submission {
  return withSubmissionStatus(submission, 'GRADED');
}

export function requestSubmissionRevision(submission: Submission): Submission {
  return withSubmissionStatus(submission, 'REVISION_REQUESTED');
}

function withSubmissionStatus(submission: Submission, status: SubmissionStatus): Submission {
  assertTransition(SUBMISSION_TRANSITIONS, submission.status, status, 'REQUEST_INVALID');
  return { ...submission, status };
}

export type Grading = {
  readonly id: GradingId;
  readonly submissionId: SubmissionId;
  readonly graderId: UserId;
  readonly score: Score;
  readonly feedback: GradeFeedback;
  readonly gradedAt: Timestamp;
  readonly revision: Revision;
};

export function createGrading(input: {
  readonly id: string;
  readonly submissionId: string;
  readonly graderId: string;
  readonly score: number;
  readonly feedback: string;
  readonly gradedAt: string;
  readonly revision?: string;
}): Grading {
  return {
    id: parseGradingId(input.id),
    submissionId: parseSubmissionId(input.submissionId),
    graderId: parseUserId(input.graderId),
    score: parseScore(input.score),
    feedback: parseGradeFeedback(input.feedback),
    gradedAt: parseTimestamp(input.gradedAt),
    revision: input.revision === undefined ? parseRevision('0') : parseRevision(input.revision),
  };
}

/**
 * 分数必须落在量规允许的区间内。
 *
 * 判据用 `Assignment.rubric` 而不是 `Grading` 自带的数字：量规是作业定义的一部分，
 * 批改时若允许另立标准，学生看到的评分依据就与实际打分脱钩。
 */
export function assertGradingWithinRubric(grading: Grading, assignment: Assignment): void {
  if (!isScoreWithinRubric(grading.score, assignment.rubric))
    throw DomainError.invalid('Grading.score');
}

/** 批改一对一当前 Submission；重交创建新 Submission，因此历史批改保留在原记录上。 */
export function gradingAppliesTo(grading: Grading, submission: Submission): boolean {
  return grading.submissionId === submission.id;
}

/**
 * 派生的学习进度（§6.2 `NOT_STARTED → IN_PROGRESS → SUBMITTED → GRADED →
 * REVISION_REQUIRED`）。逾期是**独立 flag**，不进入这个状态：
 * 「迟交但已批改」与「按时但要求返工」是两件正交的事，压进同一个枚举会丢信息。
 */
export function learningProgressOf(input: {
  readonly started: boolean;
  readonly submission: Submission | null;
}): LearningProgressState {
  if (input.submission === null) return input.started ? 'IN_PROGRESS' : 'NOT_STARTED';
  return deriveFromSubmissionStatus(input.submission.status);
}

function deriveFromSubmissionStatus(status: SubmissionStatus): LearningProgressState {
  const state: LearningProgressState =
    status === 'GRADED'
      ? 'GRADED'
      : status === 'REVISION_REQUESTED'
        ? 'REVISION_REQUIRED'
        : 'SUBMITTED';
  return parseLearningProgressState(state);
}

/**
 * 进度推进的合法迁移校验。返工后重新提交（`REVISION_REQUIRED → SUBMITTED`）
 * 是显式加进状态表的一条边 —— 少了它，`REVISION_REQUIRED` 会成为一个非终态死胡同。
 */
export function assertLearningProgressAdvance(
  from: LearningProgressState,
  to: LearningProgressState,
): void {
  assertTransition(LEARNING_PROGRESS_TRANSITIONS, from, to, 'REQUEST_INVALID');
}

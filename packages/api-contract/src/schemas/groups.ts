/**
 * 小组与学生的 DTO —— §5.5 的 `Group` / `StudentSummary` 加上两个写接口的请求体。
 *
 * 这个文件里有一条贯穿的安全约束：`initialPassword` 只能出现在
 * `batchCreateStudents` 的**单次响应**里。所以它是 `batchCreatedStudentSchema` 的字段，
 * 而**不是** `studentSummarySchema` 的字段 —— 把密码放进共享的学生摘要，等于让任何
 * 将来返回 `StudentSummary` 的接口都有机会把它带出去（§5.5「禁止日志/后续读取」）。
 */
import { z } from 'zod';

import {
  accountStatusSchema,
  ageBandSchema,
  CONTROL_CHARACTER_WIRE_PATTERN,
  cursorSchema,
  groupKindSchema,
  groupNameSchema,
  groupStatusSchema,
  listLimitSchema,
  loginNameSchema,
  nicknameSchema,
  pageSchema,
  revisionSchema,
  timestampSchema,
  uuidV7Schema,
} from './common.js';

/** 小组容量与同伴可见性设置。`memberLimit` 不在 domain 硬编码默认值（§6.3）。 */
export const groupSettingsSchema = z
  .object({
    memberLimit: z.number().int().min(1),
    studentPeerViewEnabled: z.boolean(),
  })
  .meta({ id: 'GroupSettings' });

/** 小组。`membership` 刻意不出现在读模型里：成员清单由专门接口分页返回。 */
export const groupSchema = z
  .object({
    id: uuidV7Schema,
    name: groupNameSchema,
    kind: groupKindSchema,
    status: groupStatusSchema,
    settings: groupSettingsSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .meta({ id: 'Group' });

export const groupPageSchema = pageSchema(groupSchema, 'GroupPage');

/** 学生摘要。不含 `initialPassword`，理由见文件注释。 */
export const studentSummarySchema = z
  .object({
    id: uuidV7Schema,
    loginName: loginNameSchema,
    nickname: nicknameSchema,
    ageBand: ageBandSchema,
    status: accountStatusSchema,
    revision: revisionSchema,
  })
  .meta({ id: 'StudentSummary' });

/**
 * `GET /groups` 的查询参数。
 *
 * `limit` 不再叠 `.optional()`：`listLimitSchema` 自带 `default`，`.optional()` 会让
 * parse 之后的 TS 类型变成 `number | undefined`，而实际永远是 `number`。OpenAPI 侧
 * 两种写法生成结果一致（有 default 的参数不进 `required`），所以只按更真实的那种写。
 */
export const listGroupsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: listLimitSchema,
  status: groupStatusSchema.optional(),
});

export const createGroupRequestSchema = z
  .object({
    name: groupNameSchema,
    kind: groupKindSchema,
    settings: groupSettingsSchema,
  })
  .meta({ id: 'CreateGroupRequest' });

/**
 * 学生初始密码。仅出现在 `batchCreateStudents` 的单次响应里（§5.5）。
 * 它作为独立 schema 存在，就是为了让「哪个接口能返回它」在契约里可被逐条审计。
 */
export const initialPasswordSchema = z
  .string()
  .min(8)
  .max(128)
  .refine((value) => !CONTROL_CHARACTER_WIRE_PATTERN.test(value))
  .meta({ id: 'InitialPassword', description: '8..128 字符。只随创建响应返回一次。' });

/** 待创建的学生行。`initialPassword` 可省略：省略时由服务端生成并随响应返回。 */
export const studentCreateItemSchema = z
  .object({
    loginName: loginNameSchema,
    nickname: nicknameSchema,
    ageBand: ageBandSchema,
    initialPassword: initialPasswordSchema.optional(),
  })
  .meta({ id: 'StudentCreateItem' });

/**
 * 批量创建请求。1..100 行。
 *
 * 上限 100 不是性能调优，是**事务边界**：§5.4 规定这个接口的事务策略是「逐项结果」，
 * 一次请求里能失败多少项、客户端要处理多少条 `failed`，必须有确定的上界。
 */
export const batchCreateStudentsRequestSchema = z
  .object({
    students: z.array(studentCreateItemSchema).min(1).max(100),
  })
  .meta({ id: 'BatchCreateStudentsRequest' });

/** 创建成功的一行。 */
export const batchCreatedStudentSchema = z
  .object({
    student: studentSummarySchema,
    initialPassword: initialPasswordSchema,
  })
  .meta({ id: 'BatchCreatedStudent' });

/**
 * 逐项失败的一行。
 *
 * 只有 `index` + `code` + `messageKey`：**不回显** `loginName` 或 `nickname`。
 * 逐项失败意味着这一行的输入本身可能是别人的学生姓名，把输入原样送回会让「第 3 行
 * 失败」的诊断顺带携带一份儿童个人信息；`index` 足以让客户端定位到它自己发的那一行。
 *
 * 这里只承载**逐项业务校验失败**（§5.4）。权限不足、小组已归档这类请求级错误仍然走
 * 统一 envelope（`FORBIDDEN_CAPABILITY` / `GROUP_ARCHIVED`），不会出现在 `failed` 里 ——
 * 那种情况下整批都没有被执行，逐项结果是误导。
 */
export const batchCreateStudentFailureSchema = z
  .object({
    index: z.number().int().min(0),
    code: z.string().min(1),
    messageKey: z.string().min(1),
  })
  .meta({ id: 'BatchCreateStudentFailure' });

export const batchCreateStudentsResponseSchema = z
  .object({
    items: z.array(batchCreatedStudentSchema),
    failed: z.array(batchCreateStudentFailureSchema),
  })
  .meta({ id: 'BatchCreateStudentsResponse' });

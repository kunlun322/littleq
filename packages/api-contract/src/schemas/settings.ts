/**
 * 平台设置的 DTO：目前只有 AI 凭证的秘密元数据与三条写入动作的请求体。
 *
 * 本文件最重要的一条约束是**否定式**的：`SecretMetadata` 永不含 `value`（§5.5）。
 * 这不是「文档里没写」，而是 schema 里没有这个键 —— 三条写入动作全部返回 204 无 body，
 * `GET` 只能拿到三个字段，服务端因此没有第二条把明文送出去的路径。`test/schemas.test.ts`
 * 把「秘密值不得出现在任何响应 schema 的键集合里」写成断言，防止后来者顺手加上。
 *
 * 秘密**值**作为独立 schema（`secretValueSchema`）存在，就是为了让「哪个接口能收到它」
 * 在契约里可被逐条审计：引用它的只有两个请求体（`putSecretRequestSchema` 与
 * `rotateSecretRequestSchema`），而且都是入向。`revokeSecretRequestSchema` **不**引用它
 * —— 撤销不需要新值，让它带一个 `value` 字段就等于凭空开一条"顺便改一下"的路径。
 */
import { z } from 'zod';

import {
  CONTROL_CHARACTER_WIRE_PATTERN,
  operatorNoteSchema,
  secretKindSchema,
  timestampSchema,
} from './common.js';

/**
 * 秘密元数据：种类、是否已配置、上次轮换时间。
 *
 * `lastRotatedAt` 为 null 表示从未轮换过（首次写入即视为一次轮换，由服务端决定），
 * 按附录 A §6.4 建模成 required + nullable 而不是 optional。
 *
 * **撤销不清空 `lastRotatedAt`**：它是"这个凭证上一次被换掉是什么时候"这条审计事实，
 * 撤销之后仍然为真；清空它会让"谁在什么时候让凭证失效"这个问题失去一半答案。
 * 撤销这个事实本身由 `configured: false` 表达。
 */
export const secretMetadataSchema = z
  .object({
    kind: secretKindSchema,
    configured: z.boolean(),
    lastRotatedAt: timestampSchema.nullable(),
  })
  .meta({ id: 'SecretMetadata' });

/**
 * 秘密值：1..8192 字符，不含控制字符。
 *
 * 上限 8192 来自 §5.4 的接口表；下限 1 表示「不能写空串当作清除」—— 清除是一个
 * **动作**（`:revoke`），不是一次写入的空值。把清除表达成空串会让"凭证失效"这件事
 * 在审计里长得和"写入失败"一模一样。
 * 这里刻意**不声明** format/password：OpenAPI 的 `format: password` 只影响文档 UI
 * 的掩码显示，不构成任何传输保证，写上去会让读者误以为契约层做了脱敏。
 */
export const secretValueSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !CONTROL_CHARACTER_WIRE_PATTERN.test(value))
  .meta({ id: 'SecretValue', description: '1..8192 字符，不含控制字符。永不回显。' });

/** `PUT /settings/secrets/{kind}` 的请求体。 */
export const putSecretRequestSchema = z
  .object({ value: secretValueSchema })
  .meta({ id: 'PutSecretRequest' });

/**
 * `POST /settings/secrets/{kind}:rotate` 的请求体。
 *
 * 与 `putSecretRequestSchema` 的差别只有可选的 `reason`，但两个动作**不是**同义词：
 * PUT 是"让这个值成为当前值"（首次写入也走它），`:rotate` 是"让当前值失效并换上一个
 * 新的"，因此它要求凭证**已经配置过**。分开是因为审计要能区分两者 —— 一次首配和一次
 * 因为怀疑泄漏而做的轮换，在 `audit_logs` 里必须是两条不同的动作。
 */
export const rotateSecretRequestSchema = z
  .object({
    value: secretValueSchema,
    reason: operatorNoteSchema.optional(),
  })
  .meta({ id: 'RotateSecretRequest' });

/**
 * `POST /settings/secrets/{kind}:revoke` 的请求体。
 *
 * 唯一字段是可选的操作注记，所以 `requestBody.required` 显式为 false（与 `retryTask`
 * 同理：全部字段 optional 的请求体不能声明成必填，否则空 body 的合法调用会被 400）。
 */
export const revokeSecretRequestSchema = z
  .object({
    reason: operatorNoteSchema.optional(),
  })
  .meta({ id: 'RevokeSecretRequest' });

/**
 * `{kind}` 路径参数。
 *
 * `kind` 用闭集枚举（`SECRET_KINDS`，当前是 `QCA_PAT | BAILIAN_API_KEY`），同时
 * `SECRET_KIND_UNSUPPORTED` 仍按 §5.4 声明为这些接口的专属码。两者不矛盾，理由值得
 * 写下来：枚举是**当前**支持的集合，而 domain 的 `parseSecretKind` 对无法识别的种类抛
 * `SECRET_KIND_UNSUPPORTED`。将来 domain 增加一个种类时，wire 枚举随之变宽（§4.2 的
 * 放宽方向，非破坏性），但「语法合法却在本部署下不可配置」的种类必须仍然映射到这个
 * 专属码，而不是退化成 `REQUEST_INVALID` —— 后者会让运维看不出该去配置凭证。
 *
 * `{kind}` 不是 `{id}`，所以 `RESOURCE_NOT_FOUND` **不**由路径推导（见 `openapi.ts`
 * 的挂载规则）：种类不存在时的正确响应是 400 而不是 404。
 */
export const secretKindPathSchema = z.object({ kind: secretKindSchema });

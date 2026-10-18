/**
 * 平台设置的 DTO：目前只有 AI 凭证的秘密元数据。
 *
 * 本文件最重要的一条约束是**否定式**的：`SecretMetadata` 永不含 `value`（§5.5）。
 * 这不是「文档里没写」，而是 schema 里没有这个键 —— `PUT` 成功返回 204 无 body，
 * `GET` 只能拿到三个字段，服务端因此没有第二条把明文送出去的路径。`test/schemas.test.ts`
 * 把「秘密值不得出现在任何响应 schema 的键集合里」写成断言，防止后来者顺手加上。
 *
 * 秘密**值**作为独立 schema（`secretValueSchema`）存在，就是为了让「哪个接口能收到它」
 * 在契约里可被逐条审计：它只被 `putSecretRequestSchema` 引用一次。
 */
import { z } from 'zod';

import { CONTROL_CHARACTER_WIRE_PATTERN, secretKindSchema, timestampSchema } from './common.js';

/**
 * 秘密元数据：种类、是否已配置、上次轮换时间。
 *
 * `lastRotatedAt` 为 null 表示从未轮换过（首次写入即视为一次轮换，由服务端决定），
 * 按附录 A §6.4 建模成 required + nullable 而不是 optional。
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
 * 上限 8192 来自 §5.4 的接口表；下限 1 表示「不能写空串当作清除」—— 清除凭证不是
 * v1 的能力（`SECRET_IMMUTABLE_REDEPLOY_REQUIRED` 正是这条限制的机器码）。
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
 * `{kind}` 路径参数。
 *
 * `kind` 用闭集枚举（`SECRET_KINDS`，当前是 `QCA_PAT | BAILIAN_API_KEY`），同时
 * `SECRET_KIND_UNSUPPORTED` 仍按 §5.4 声明为这两个接口的专属码。两者不矛盾，理由值得
 * 写下来：枚举是**当前**支持的集合，而 domain 的 `parseSecretKind` 对无法识别的种类抛
 * `SECRET_KIND_UNSUPPORTED`。将来 domain 增加一个种类时，wire 枚举随之变宽（§4.2 的
 * 放宽方向，非破坏性），但「语法合法却在本部署下不可配置」的种类必须仍然映射到这个
 * 专属码，而不是退化成 `REQUEST_INVALID` —— 后者会让运维看不出该去配置凭证。
 *
 * `{kind}` 不是 `{id}`，所以 `RESOURCE_NOT_FOUND` **不**由路径推导（见 `openapi.ts`
 * 的挂载规则）：种类不存在时的正确响应是 400 而不是 404。
 */
export const secretKindPathSchema = z.object({ kind: secretKindSchema });

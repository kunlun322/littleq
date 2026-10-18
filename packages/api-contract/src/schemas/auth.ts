/**
 * 认证接口的 DTO。
 *
 * 只有 `POST /auth/login` 有请求体：`logout` 靠 cookie 识别会话，没有输入。
 * 登录响应是 `204` 加 `Set-Cookie`，**没有 body** —— 把用户对象返回给登录者会顺带
 * 把角色、锁定策略等只属于服务端判断的字段带出去（§5.3 要求角色判断留在服务端）。
 */
import { z } from 'zod';

import { CONTROL_CHARACTER_WIRE_PATTERN, loginNameSchema } from './common.js';

/**
 * 登录口令。只在请求方向出现；任何响应 schema 都不得引用它。
 *
 * 长度下限 8 来自 §5.4 的表格（`password:8..128`），与 domain 的
 * `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` 同源，但**不在这里 import 那两个常量**：
 * 口令长度是「服务端接受什么」的传输事实，写在契约层才能被快照与 comparator 看见。
 * `test/schemas.test.ts` 用探针把它与 domain 的 `isAcceptablePasswordLength` 对齐，
 * 防止两侧漂移。
 */
export const passwordSchema = z
  .string()
  .min(8)
  .max(128)
  .refine((value) => !CONTROL_CHARACTER_WIRE_PATTERN.test(value))
  .meta({ id: 'Password', description: '8..128 字符，不含控制字符。' });

/**
 * 登录请求。
 *
 * `rememberMe` 是**请求方向**的可选字段，用 `.optional()` 而不是 `.nullable()`：
 * §6.4「可选即 required 但 nullable」约束的是对外**资源表示**（客户端必须能区分
 * 「字段缺席」与「值为 null」），而请求体的「不传」与「传 null」对服务端是同一个
 * 意思 —— 用默认值。把请求字段也强行 nullable 会逼客户端多写一个 `null` 分支，
 * 换不到任何信息。
 */
export const loginRequestSchema = z
  .object({
    loginName: loginNameSchema,
    password: passwordSchema,
    rememberMe: z.boolean().optional(),
  })
  .meta({ id: 'LoginRequest' });

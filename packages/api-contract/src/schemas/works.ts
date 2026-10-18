/**
 * 作品与公开访问的 DTO —— §5.5 的 `Work` / `PublicWork`，以及 `PATCH /works/{id}` 的请求体。
 *
 * 两条贯穿本文件的规则：
 *
 * 1. **响应字段一律 required + nullable，不用 optional**（附录 A §6.4）。domain 里
 *    `Work.latestPublicationId` 是 `PublicationId | null`，线上就是
 *    `latestPublicationId: UuidV7 | null`。这样「键一定在」，客户端只需判断 null；
 *    同时给 §4.2 的「把 required 响应字段改成 optional 是破坏性变更」一个确定起点。
 * 2. **结构上不出现的字段就是最强的保证**。`Work` 没有 `deletedAt`（§5.5 的对外清单
 *    只有 10 个字段，30 天恢复窗口是 domain 事实，不是客户端可算的量）；
 *    `PublicWork` 没有 `status` —— 把 `REVOKED` 交给匿名访问者本身就是信息泄漏。
 */
import { z } from 'zod';

import {
  nicknameSchema,
  revisionSchema,
  slugSchema,
  timestampSchema,
  uuidV7Schema,
  visibilitySchema,
  workStatusSchema,
  workTitleSchema,
} from './common.js';

/** 作品读模型 —— §5.5 的 10 个字段。 */
export const workSchema = z
  .object({
    id: uuidV7Schema,
    projectId: uuidV7Schema,
    slug: slugSchema,
    visibility: visibilitySchema,
    commentsEnabled: z.boolean(),
    status: workStatusSchema,
    latestPublicationId: uuidV7Schema.nullable(),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .meta({ id: 'Work' });

/**
 * 开放图谱卡片。`imageUrl` 可为 null（缩略图尚未生成）。
 *
 * `description` 上限 300 与 §5.5 一致；这里只约束长度，不约束内容 —— 卡片文案由
 * 作品契约阶段生成，属于内容面而不是传输面。
 */
export const openGraphSchema = z
  .object({
    title: workTitleSchema,
    description: z.string().max(300),
    imageUrl: z.string().max(512).nullable(),
  })
  .meta({ id: 'OpenGraph' });

/**
 * 匿名可看的作品投影。
 *
 * §5.3：对不存在、PRIVATE、REVOKED、DELETED 一律返回 404 与同一机器码，所以这个
 * schema 只在「确实可公开服务」时出现。`runtimeUrl` 是短期独立源地址，契约只声明
 * 它是一个不超过 512 字符的串，**不含任何示例值** —— 一个样例签名 URL 就是一份可
 * 复用的凭证模板（§5 禁止签名 URL 进入快照与 fixture）。
 */
export const publicWorkSchema = z
  .object({
    id: uuidV7Schema,
    slug: slugSchema,
    title: workTitleSchema,
    authorNickname: nicknameSchema,
    visibility: visibilitySchema,
    commentsEnabled: z.boolean(),
    runtimeUrl: z.string().max(512),
    og: openGraphSchema,
  })
  .meta({ id: 'PublicWork' });

/** `GET /public/works/{slug}` 的路径参数。`{slug}` 不是 `{id}`，因此不推导 `RESOURCE_NOT_FOUND`（见 `openapi.ts`）。 */
export const publicWorkPathSchema = z.object({ slug: slugSchema });

/**
 * `PATCH /works/{id}` 的请求体：**至少一项**，且**禁止额外字段**。
 *
 * 「禁止额外字段」用 `.strict()` 而不是靠文档说明：zod-openapi 对普通 `z.object`
 * 在**请求方向**不输出 `additionalProperties`（实测），只有 `.strict()` 会在请求与
 * 响应两侧都输出 `additionalProperties: false`。少了这一位，「多传一个字段被静默
 * 忽略」与「多传一个字段被拒绝」在契约上无法区分，而 §4.2 要求请求接受集合的收窄
 * 必须是可裁定的显式变更。
 *
 * 「至少一项」用 `.refine()` 表达。它是一条**语义**约束而不是形状约束，因此
 * OpenAPI 里没有对应关键字；映射的错误码是 `REQUEST_INVALID`（§5.4 的共享码），
 * 由 `openapi.ts` 从「声明了 body」这一事实推导出来，不需要在这里重复声明。
 */
export const updateWorkRequestSchema = z
  .object({
    visibility: visibilitySchema.optional(),
    commentsEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.visibility !== undefined || value.commentsEnabled !== undefined, {
    message: 'visibility 与 commentsEnabled 至少提供一项。',
  })
  .meta({ id: 'UpdateWorkRequest' });

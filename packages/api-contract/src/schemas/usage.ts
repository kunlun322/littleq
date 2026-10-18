/**
 * 用量与额度的 DTO —— §5.5 的 `UsageLimit` / `UsageLedgerEntry`，以及 ledger 的 CSV 导出。
 *
 * 三条建模决定，都值得写下来：
 *
 * 1. **账本行是追加写、不可变的**（附录 A §6.6），所以它没有 `revision`、没有
 *    `updatedAt`，也没有任何 `PATCH` 接口。契约层能表达这一点的方式就是不给它并发
 *    控制字段 —— 客户端拿不到 `ETag`，也就无从发起条件写。
 * 2. **`estimatedCredits` 与 `providerReportedCredits` 分开**：前者是本平台口径、用于
 *    计费，后者是供应商上报的**规范化数值**（domain 的 `ProviderUsage`）。附录 A §6.4
 *    明确「不接原始 provider response」，所以这里只有一个数字，没有 provider 的
 *    payload、请求 ID 或原始 usage 对象。
 * 3. **`eventKey` 不出现在线上**。它是账本的去重键（§6.6「ledger `eventKey` 唯一」），
 *    属于服务端幂等实现；回显它等于把内部的幂等 scope 交给客户端。
 */
import { z } from 'zod';

import {
  capabilitySchema,
  creditsSchema,
  cursorSchema,
  durationMsSchema,
  ledgerLimitSchema,
  listLimitSchema,
  pageSchema,
  revisionSchema,
  timestampSchema,
  timezoneSchema,
  usagePeriodSchema,
  usageProviderSchema,
  usageQuantitySchema,
  usageUnitSchema,
  uuidV7Schema,
} from './common.js';

/** 额度设置。`limitUnits = 0` 是合法值：额度为零只阻断新的 AI task（附录 A §6.6）。 */
export const usageLimitSchema = z
  .object({
    id: uuidV7Schema,
    subjectUserId: uuidV7Schema,
    capability: capabilitySchema,
    period: usagePeriodSchema,
    limitUnits: usageQuantitySchema,
    timezone: timezoneSchema,
    enabled: z.boolean(),
    revision: revisionSchema,
    updatedAt: timestampSchema,
  })
  .meta({ id: 'UsageLimit' });

export const usageLimitPageSchema = pageSchema(usageLimitSchema, 'UsageLimitPage');

/**
 * 账本行 —— §5.5 的 12 个字段。
 *
 * `taskId` 可为 null：并非所有用量都绑定一个 task（例如直接计费的媒体调用），
 * 而 §6.6 要求「调用已发生即写 ledger，即使任务失败」，所以失败任务的用量同样在账本里。
 */
export const usageLedgerEntrySchema = z
  .object({
    id: uuidV7Schema,
    taskId: uuidV7Schema.nullable(),
    subjectUserId: uuidV7Schema,
    capability: capabilitySchema,
    quantity: usageQuantitySchema,
    unit: usageUnitSchema,
    provider: usageProviderSchema,
    modelId: z.string().max(128).nullable(),
    estimatedCredits: creditsSchema.nullable(),
    providerReportedCredits: creditsSchema.nullable(),
    durationMs: durationMsSchema.nullable(),
    occurredAt: timestampSchema,
  })
  .meta({ id: 'UsageLedgerEntry' });

export const usageLedgerPageSchema = pageSchema(usageLedgerEntrySchema, 'UsageLedgerPage');

/**
 * CSV 导出的列名，**从 `usageLedgerEntrySchema` 的 shape 派生**并按字母序固定。
 *
 * 派生而不是手抄，是为了让「JSON 与 CSV 是同一 allowlist 字段」（§5.4）成为一条编译期
 * 事实：给账本行加字段时，CSV 列自动跟随，不会出现「JSON 有、CSV 没有」的静默缺口。
 * 显式排序则是因为这份顺序会被写进快照的描述文本 —— 交给 `Object.keys` 的插入序虽然
 * 由规范保证，但把确定性外包给语言实现细节没有收益（PM G6）。
 *
 * 首行是表头，其后每行一条记录，逗号分隔、RFC 4180 转义。
 */
export const LEDGER_CSV_COLUMNS: readonly string[] = Object.keys(
  usageLedgerEntrySchema.shape,
).sort();

/**
 * CSV 响应体。
 *
 * `SuccessResponse` 的不变量是「`mediaType === null` 当且仅当 `schema === null`」，
 * 所以一个非 null 的 `text/csv` 必须带 schema；而对 `text/csv` 唯一诚实的 JSON Schema
 * 就是 `type: string` —— 列结构不是 JSON，硬塞一个 array-of-array 反而会让文档声称
 * 服务端会返回 JSON。列名因此写在 description 里，并由 `test/operations.test.ts`
 * 断言它与 `LEDGER_CSV_COLUMNS` 一致。
 */
export const ledgerCsvSchema = z.string().meta({
  id: 'LedgerCsv',
  description: `RFC 4180 CSV。首行表头，列固定为：${LEDGER_CSV_COLUMNS.join(', ')}。与 JSON 导出同一 allowlist 字段。`,
});

/** `GET /usage/limits` 的查询参数。`subjectUserId` 缺省时由服务端按调用方角色固定。 */
export const getUsageLimitsQuerySchema = z.object({
  subjectUserId: uuidV7Schema.optional(),
  capability: capabilitySchema.optional(),
  cursor: cursorSchema.optional(),
  limit: listLimitSchema,
});

/**
 * `GET /usage/ledger` 的查询参数。
 *
 * `from` / `to` 是**闭区间**的 UTC RFC3339 时间戳；日历有效性由 domain 判定并映射
 * `REQUEST_INVALID`（wire pattern 只做语法检查，见 `common.ts` 的文件注释）。
 * `limit` 用 ledger 专属区间 1..500 默认 100（§5.5），与普通列表的 1..100 默认 20 不同：
 * 导出是批量场景，把两者的默认值统一会让「翻页 20 条导一整月账本」变成 25 次请求。
 * `format` 缺省 `json`，`.default()` 会同时输出 `default` 并把参数移出 `required`。
 */
export const getUsageLedgerQuerySchema = z.object({
  subjectUserId: uuidV7Schema.optional(),
  capability: capabilitySchema.optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: ledgerLimitSchema,
  format: z.enum(['json', 'csv']).default('json').meta({
    id: 'LedgerExportFormat',
    description:
      '导出格式，缺省 json。csv 分支与 json 是同一 allowlist 字段，并额外带 Content-Disposition。',
  }),
});

/**
 * `PUT /usage/limits` 的请求体。
 *
 * `PUT` 而不是 `PATCH`：额度是「一条设置的完整替换」，不是「若干字段的局部修改」。
 * 因此这里所有字段都必填 —— 少一个就是 `REQUEST_INVALID`，而不是「保留原值」。
 * 「仅当不存在时创建」由 `If-None-Match: *` 表达（§5.4 的 `putUsageLimit` 行），
 * 不在 body 里加 `createOnly` 之类的开关。
 */
export const putUsageLimitRequestSchema = z
  .object({
    subjectUserId: uuidV7Schema,
    capability: capabilitySchema,
    period: usagePeriodSchema,
    limitUnits: usageQuantitySchema,
    timezone: timezoneSchema,
    enabled: z.boolean(),
  })
  .meta({ id: 'PutUsageLimitRequest' });

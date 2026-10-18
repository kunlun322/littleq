/**
 * 契约层的公共词汇：线上原语、枚举、分页信封、错误 envelope、响应头与 operation 类型。
 *
 * 为什么 `schemas/common.ts` 里既有 schema 又有类型：`operations.ts` 声明 28 条数据、
 * `openapi.ts` 做错误码挂载与文档派生，两者都需要 `OperationContract` 这套类型。把类型
 * 放进 `operations.ts` 会让 `openapi.ts → operations.ts` 变成数据与类型的混合依赖，
 * 放进 `openapi.ts` 则会让 `operations.ts → openapi.ts` 成环。放在公共层，依赖图是
 * 单向的：`schemas/* ← operations.ts ← openapi.ts ← index.ts`。
 *
 * ## 为什么在这里重写一份正则，而不是从 `packages/domain` 导入
 *
 * domain 的绝大多数 pattern 是**模块私有**的（只有 `SHA256_PATTERN` 被导出），把它改成
 * 公开只为了让契约层复用，等于让领域层为自己的表示形式负责 —— 而「UUIDv7 长什么样」
 * 在 HTTP 线上和在数据库里是两个独立可演进的决定（附录 A §6.4：SQL 类型与索引语法留在
 * infra，domain 不生成数据库列类型）。
 *
 * 代价是「两份正则可能漂移」，因此 `test/schemas.test.ts` 用一份**提交进仓库的探针集**
 * 对每条 wire pattern 与对应的 domain `is*` 谓词做双向交叉校验：探针里的 accepts 必须
 * 两侧都接受、rejects 必须两侧都拒绝。漂移会让那条测试变红，而不是让线上契约悄悄宽于
 * 或窄于领域规则。
 *
 * 唯一已知的、且是**故意保留的**分歧：`Timestamp` 的 wire pattern 只做语法检查，
 * 日历有效性（`2026-02-30` 不存在）由 domain 判定并映射 `REQUEST_INVALID`。这一条
 * 在测试里被显式钉住，避免后来者把日历校验塞进正则、或反过来以为正则已经管住了。
 */
import {
  ACCOUNT_STATUSES,
  AGE_BANDS,
  BUILD_STATUSES,
  CAPABILITIES,
  GROUP_KINDS,
  GROUP_STATUSES,
  HELP_LEVELS,
  PROJECT_STATUSES,
  SCAN_STATUSES,
  SECRET_KINDS,
  TASK_EVENT_TYPES,
  TASK_KINDS,
  TASK_STAGES,
  TASK_STATES,
  USAGE_PERIODS,
  USAGE_PROVIDERS,
  USAGE_UNITS,
  VISIBILITIES,
  WORK_STATUSES,
  WORK_TYPES,
  type ErrorCode,
} from '@littleq/domain';
import { z } from 'zod';
import type { oas31, ZodObjectInput } from 'zod-openapi';

/** 任意 zod schema 的最宽公共上界（`ZodType` 的三个参数都是 `out`，故协变可赋值）。 */
export type WireSchema = z.ZodType;

/**
 * 参数位置（path / query / header）专用的 schema 上界。
 *
 * 比 `WireSchema` 窄，而且必须窄：`zod-openapi` 的 `ZodOpenApiParameters` 把这三个位置
 * 声明为 `ZodObjectInput = $ZodType<unknown, Record<string, unknown>>`，输入类型是
 * **对象**。用 `WireSchema`（输入类型 `unknown`）赋值会编译失败，而用 `as` 绕过去就等于
 * 放弃「参数位置只能放 object」这条由类型系统白送的保证。
 *
 * `z.object(…)`、`.strict()`、`.strict().refine(…)` 三种写法都满足它（实测），所以
 * 收窄不限制任何现有声明。
 */
export type WireObjectSchema = ZodObjectInput;

// ---------------------------------------------------------------------------
// 线上格式常量
// ---------------------------------------------------------------------------

export const UUID_V7_WIRE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DECIMAL_WIRE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
/** 正十进制（不含 `0`）。domain 的 `isTaskEventId` 额外要求 `BigInt(value) > 0n`。 */
export const POSITIVE_DECIMAL_WIRE_PATTERN = /^[1-9][0-9]*$/;
/** 语法层面：与 domain 的 `TIMESTAMP_PATTERN` 同宽（小数秒 1..6 位可省略）。 */
export const TIMESTAMP_WIRE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
export const CURSOR_WIRE_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SLUG_WIRE_PATTERN = /^[a-z0-9-]{3,80}$/;
/**
 * IANA 时区名的 `Area/Location` 形状，与 domain 的 `TIMEZONE_PATTERN` 同宽。
 *
 * 必须同宽，不能只写 `minLength: 1`：domain 要求至少一个 `/`，所以裸 `UTC` 会被服务端
 * 判 `REQUEST_INVALID`。契约若比 domain 宽，客户端就会照文档发一个注定 400 的值 ——
 * 那不是「宽松」，是把一次必然失败的往返写进了契约。
 */
export const TIMEZONE_WIRE_PATTERN = /^[A-Za-z][A-Za-z0-9+_./-]*(?:\/[A-Za-z0-9+._-]+)+$/;
export const SHA256_WIRE_PATTERN = /^[0-9a-f]{64}$/;
export const SEMVER_WIRE_PATTERN = /^\d+\.\d+\.\d+$/;
export const IDEMPOTENCY_KEY_WIRE_PATTERN = /^[A-Za-z0-9._:-]+$/;
export const E_TAG_WIRE_PATTERN = /^"rev-(?:0|[1-9][0-9]*)"$/;
/** `If-None-Match` 额外接受 `*`（「仅当不存在时创建」，见 `putUsageLimit`）。 */
export const IF_NONE_MATCH_WIRE_PATTERN = /^(?:\*|"rev-(?:0|[1-9][0-9]*)")$/;
// 控制字符**就是** no-control-regex 要拦的东西：这里的字符类是「拒绝把不可见字符
// 带进自由文本」的判据本身，不是误写。说明写在上面，指令必须紧贴被禁的那行。
/** 控制字符（C0 + DEL）。契约层用它拒绝把不可见字符带进任何自由文本字段。 */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARACTER_WIRE_PATTERN = /[\u0000-\u001f\u007f]/;

/** 幂等键长度（§5.5：16–128 ASCII）。 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
/** 普通列表分页区间与默认值（§5.5）。 */
export const LIST_LIMIT_MIN = 1;
export const LIST_LIMIT_MAX = 100;
export const LIST_LIMIT_DEFAULT = 20;
/** 账本导出分页区间与默认值（§5.5：ledger `1..500` 默认 100）。 */
export const LEDGER_LIMIT_MIN = 1;
export const LEDGER_LIMIT_MAX = 500;
export const LEDGER_LIMIT_DEFAULT = 100;

// ---------------------------------------------------------------------------
// 原语 schema
// ---------------------------------------------------------------------------

/**
 * 实体 ID。全部是小写 UUIDv7；唯一例外是 `TaskEventId`（十进制字符串），
 * 见 §6.1「除 `TaskEventId` 外，实体 ID 为 UUIDv7 值对象」。
 */
export const uuidV7Schema = z
  .string()
  .regex(UUID_V7_WIRE_PATTERN)
  .meta({ id: 'UuidV7', description: '小写 UUIDv7。' });

/** 乐观并发版本号。用十进制字符串而非 number：bigint 经 JSON 会丢精度。 */
export const revisionSchema = z
  .string()
  .regex(DECIMAL_WIRE_PATTERN)
  .meta({ id: 'Revision', description: '非负十进制字符串。同时充当 ETag 的比较基准。' });

/** UTC RFC3339，`Z` 结尾；日历有效性由服务端 domain 判定。 */
export const timestampSchema = z
  .string()
  .regex(TIMESTAMP_WIRE_PATTERN)
  .meta({ id: 'Timestamp', description: 'UTC RFC3339 时间戳，以 Z 结尾。' });

/** 不透明分页游标：base64url。契约层刻意不定义其内部结构（§5.5「不泄露 SQL offset」）。 */
export const cursorSchema = z
  .string()
  .regex(CURSOR_WIRE_PATTERN)
  .meta({ id: 'Cursor', description: '不透明 base64url 分页游标。排序键编码在其中。' });

/**
 * `TaskEvent.id`：单任务内单调递增的十进制字符串（bigint 的线上表示）。
 *
 * 同一个 schema 也充当 SSE 重连的 `Last-Event-ID` 请求头值 —— 那本来就是客户端
 * 回填的最后一个 `TaskEvent.sequence`，再声明一个 `LastEventId` 只会让快照里多一个
 * 与之逐字相同的 component。
 *
 * 用正十进制而不是 `DECIMAL_WIRE_PATTERN`：序列从 1 开始（domain 的 `isTaskEventId`
 * 额外要求 `BigInt(value) > 0n`），`0` 不是任何事件。若这里放行 `0`，客户端就能按文档
 * 发一个服务端必然判 `REQUEST_INVALID` 的 `Last-Event-ID`。`Revision` 仍用非负那一支，
 * 两者不共享 pattern 是**事实不同**，不是疏漏。
 */
export const taskEventIdSchema = z
  .string()
  .regex(POSITIVE_DECIMAL_WIRE_PATTERN)
  .meta({ id: 'TaskEventId', description: '单任务内单调递增的正十进制字符串，从 1 开始。' });

/** 强校验 ETag 值，形如 `"rev-3"`（含双引号，按 RFC 9110 的 entity-tag 语法）。 */
export const eTagValueSchema = z.string().regex(E_TAG_WIRE_PATTERN).meta({
  id: 'ETagValue',
  description: '强校验值 "rev-<Revision>"。响应头 ETag 与请求头 If-Match 共用这一形状。',
});

/**
 * `If-Match` 请求头值。
 *
 * 只接受服务端自己签发过的强校验值，**不**接受 RFC 9110 的 `*`：这个 API 里
 * `If-Match: *`（「只要存在就写」）没有定义语义 —— 需要「仅当不存在时创建」的
 * 场景走 `If-None-Match: *`（见 `putUsageLimit`）。契约声明的就是服务端真正会
 * 兑现的那部分；按 §4.2 收窄请求接受集合是破坏性变更，写宽了将来收不回来。
 */
export const ifMatchSchema = z.string().regex(E_TAG_WIRE_PATTERN).meta({
  id: 'IfMatch',
  description: '强校验 ETag，形如 "rev-3"。不匹配映射 REVISION_CONFLICT。',
});

/** `If-None-Match` 请求头值：条件读取回填 ETag，或创建时传 `*`。 */
export const ifNoneMatchSchema = z
  .string()
  .regex(IF_NONE_MATCH_WIRE_PATTERN)
  .meta({ id: 'IfNoneMatch', description: 'ETag 或 *。命中时读取接口返回 304。' });

/** `Idempotency-Key` 请求头值：16–128 ASCII，字符集 `[A-Za-z0-9._:-]`。 */
export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_WIRE_PATTERN)
  .meta({
    id: 'IdempotencyKey',
    description: '16–128 个 ASCII 字符，字符集 [A-Za-z0-9._:-]。',
  });

/** 产物/请求摘要：小写 SHA-256 十六进制。 */
export const sha256Schema = z
  .string()
  .regex(SHA256_WIRE_PATTERN)
  .meta({ id: 'Sha256', description: '小写 SHA-256 十六进制摘要（64 字符）。' });

/** 作品契约版本：语义化版本三段式。 */
export const contractVersionSchema = z
  .string()
  .regex(SEMVER_WIRE_PATTERN)
  .meta({ id: 'ContractVersion', description: '语义化版本，形如 1.4.0。' });

/** 公开作品 slug。 */
export const slugSchema = z
  .string()
  .regex(SLUG_WIRE_PATTERN)
  .meta({ id: 'Slug', description: '公开访问路径片段：小写字母、数字与连字符，3..80。' });

/**
 * IANA 时区名。用量限额的「每日」边界由它决定，因此必须显式出现在契约里。
 *
 * 只校验形状，**不查时区表**：查表要用 `Intl`，而 `Intl` 的可用时区数据随宿主 ICU 版本
 * 变化（PM G6 点名的宿主相关源之一）。真正的偏移由调用方显式传入，见 domain 的
 * `isTimezone` 注释。
 */
export const timezoneSchema = z
  .string()
  .max(64)
  .regex(TIMEZONE_WIRE_PATTERN)
  .meta({ id: 'Timezone', description: 'IANA 时区名，Area/Location 形状，例如 Asia/Shanghai。' });

/**
 * 自由文本：拒绝控制字符。
 *
 * 这条不是排版偏好 —— prompt、昵称、小组名都会进入 UI 与 SSE safe event，
 * 携带 C0 控制字符的文本可以在浏览器里制造视觉欺骗（§5 禁止把学生 prompt 全文
 * 写进日志，但允许它经接口传输，所以传输层必须把它约束成可安全渲染的形状）。
 */
function boundedText(min: number, max: number): z.ZodString {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !CONTROL_CHARACTER_WIRE_PATTERN.test(value) && value.trim().length > 0);
}

export const loginNameSchema = boundedText(1, 64).meta({ id: 'LoginName' });
export const nicknameSchema = boundedText(1, 64).meta({ id: 'Nickname' });
export const groupNameSchema = boundedText(1, 80).meta({ id: 'GroupName' });
export const projectTitleSchema = boundedText(1, 100).meta({ id: 'ProjectTitle' });
export const workTitleSchema = boundedText(1, 100).meta({ id: 'WorkTitle' });

/** 操作说明（重试原因、恢复原因等）。 */
export const operatorNoteSchema = boundedText(1, 200).meta({ id: 'OperatorNote' });

/**
 * 生成式回合的用户输入。
 *
 * 刻意只约束**长度**，不把它建模成持有文本的值对象：prompt 全文是 §5 明令禁止
 * 进入 domain、快照、日志与 fixture 的内容之一。契约层能声明的只有「1..8000 字符」
 * 这条形状约束，示例值一律使用无意义的占位文本。
 */
export const promptSchema = z
  .string()
  .min(1)
  .max(8000)
  .meta({ id: 'Prompt', description: '1..8000 字符。快照与测试夹具中不出现任何真实学生输入。' });

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/**
 * 枚举集合一律直接引用 domain 的 `as const` 元组，不重写字面量。
 *
 * 这样「domain 加了一个状态而契约没跟上」会变成编译错误而不是快照里悄悄少一个成员。
 * 反过来，**不是每个 domain 枚举都上线**：`ROLES` / `MEMBER_ROLES`（授权模型不对外
 * 暴露，§5.3 的 403/404 规则要求角色判断留在服务端）与 `PUBLICATION_STATUSES`
 * （§5.5 的对外资源里没有 publication 表示，`Work` 只带 `latestPublicationId`）
 * 刻意没有 wire schema。给它们注册 schema 会让 `components.schemas` 出现无人引用的
 * 成员，读者会误以为存在对应的接口。
 */
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES).meta({ id: 'AccountStatus' });
export const ageBandSchema = z.enum(AGE_BANDS).meta({ id: 'AgeBand' });
export const groupKindSchema = z.enum(GROUP_KINDS).meta({ id: 'GroupKind' });
export const groupStatusSchema = z.enum(GROUP_STATUSES).meta({ id: 'GroupStatus' });
export const workTypeSchema = z.enum(WORK_TYPES).meta({ id: 'WorkType' });
export const helpLevelSchema = z.enum(HELP_LEVELS).meta({ id: 'HelpLevel' });
export const projectStatusSchema = z.enum(PROJECT_STATUSES).meta({ id: 'ProjectStatus' });
export const buildStatusSchema = z.enum(BUILD_STATUSES).meta({ id: 'BuildStatus' });
export const scanStatusSchema = z.enum(SCAN_STATUSES).meta({ id: 'ScanStatus' });
export const visibilitySchema = z.enum(VISIBILITIES).meta({ id: 'Visibility' });
export const workStatusSchema = z.enum(WORK_STATUSES).meta({ id: 'WorkStatus' });
export const taskKindSchema = z.enum(TASK_KINDS).meta({ id: 'TaskKind' });
export const taskStateSchema = z.enum(TASK_STATES).meta({ id: 'TaskState' });
export const taskStageSchema = z.enum(TASK_STAGES).meta({ id: 'TaskStage' });
export const taskEventTypeSchema = z.enum(TASK_EVENT_TYPES).meta({ id: 'TaskEventType' });
export const capabilitySchema = z.enum(CAPABILITIES).meta({ id: 'Capability' });
export const usagePeriodSchema = z.enum(USAGE_PERIODS).meta({ id: 'UsagePeriod' });
export const usageUnitSchema = z.enum(USAGE_UNITS).meta({ id: 'UsageUnit' });
export const usageProviderSchema = z.enum(USAGE_PROVIDERS).meta({ id: 'UsageProvider' });
export const secretKindSchema = z.enum(SECRET_KINDS).meta({ id: 'SecretKind' });

// ---------------------------------------------------------------------------
// 数值
// ---------------------------------------------------------------------------

/** 非负整数计数（文件数、字节数、发现数）。 */
export const countSchema = z.number().int().min(0).meta({ id: 'NonNegativeCount' });

/** 进度百分比 0..100。 */
export const progressSchema = z.number().int().min(0).max(100).meta({ id: 'Progress' });

/** 尝试序号，1 起。 */
export const attemptSchema = z.number().int().min(1).meta({ id: 'Attempt' });

/** 版本序号，1 起，项目内唯一。 */
export const versionSequenceSchema = z.number().int().min(1).meta({ id: 'VersionSequence' });

/** 用量数值。`limitUnits = 0` 是合法值（§6.6：额度为零只阻断新的 AI task）。 */
export const usageQuantitySchema = z.number().int().min(0).meta({ id: 'UsageQuantity' });

/** 积分。允许小数：provider 上报的 credits 不保证是整数。 */
export const creditsSchema = z.number().min(0).meta({ id: 'Credits' });

/** 时长毫秒。 */
export const durationMsSchema = z.number().int().min(0).meta({ id: 'DurationMs' });

/**
 * 普通列表的 `limit` 查询参数。
 *
 * `z.coerce` 让「查询串里的十进制文本」在运行时可用，而在 OpenAPI 里不留痕迹
 * （生成结果是纯 `integer`）—— 传输编码是服务器的事，契约只声明值的形状与区间。
 * `.default()` 会同时把参数移出 `required` 并写出 `default`，这正是 §5.5「默认 20」
 * 在文档里的表达方式。
 */
export const listLimitSchema = z.coerce
  .number()
  .int()
  .min(LIST_LIMIT_MIN)
  .max(LIST_LIMIT_MAX)
  .default(LIST_LIMIT_DEFAULT)
  .meta({ id: 'ListLimit', description: '1..100，默认 20。' });

/** 账本导出的 `limit`：区间与默认值都不同（§5.5：`1..500` 默认 100）。 */
export const ledgerLimitSchema = z.coerce
  .number()
  .int()
  .min(LEDGER_LIMIT_MIN)
  .max(LEDGER_LIMIT_MAX)
  .default(LEDGER_LIMIT_DEFAULT)
  .meta({ id: 'LedgerLimit', description: '1..500，默认 100。' });

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

/**
 * 统一错误 envelope。字段集合逐字来自 domain 的 `ERROR_ENVELOPE_FIELDS`，
 * `test/schemas.test.ts` 直接比对这个 schema 的键集合与该常量，两边漂移即红。
 *
 * `code` 声明为 string 而**不是** 42 个成员的 enum：新增错误码是 §4.2「保守按破坏性
 * 处理」的一类，那个判定必须发生在**错误目录快照**上（那里带 httpStatus /
 * messageKey / retryable / sameRequestRetrySafety 四项事实），而不是发生在 envelope
 * 的一个 enum 里 —— 后者只会给出一条「enum 多了个成员」的噪声诊断，丢掉真正
 * 需要人裁定的信息（状态码变了吗？可重试性变了吗？）。
 */
export const errorEnvelopeSchema = z
  .object({
    code: z.string().min(1),
    messageKey: z.string().min(1),
    retryable: z.boolean(),
    traceId: z.string().max(64),
  })
  .meta({ id: 'ErrorEnvelope' });

/**
 * 游标分页信封。`nextCursor` 为 null 表示没有下一页。
 *
 * 排序键编码进 cursor、cursor 对客户端不透明（§5.4），所以这里只约束 base64url 形状，
 * 不声明任何内部结构 —— 一旦把 offset 写进 schema，它就变成了契约的一部分。
 */
export function pageSchema<T extends z.ZodType>(itemSchema: T, id: string) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: cursorSchema.nullable(),
    })
    .meta({ id });
}

// ---------------------------------------------------------------------------
// 响应头
// ---------------------------------------------------------------------------

/**
 * 响应头一律用**纯 JSON Schema 对象**而不是 zod schema。
 *
 * 这不是风格选择，是 `zod-openapi@6.0.2` 的实测行为：把 zod schema 放进响应的
 * `headers` 里，生成结果会多出一层非法的 `def` 包装 ——
 * `{"ETag":{"def":{"type":"string"},"type":"string"}}`（无论该 schema 是否经
 * `.meta({id})` 注册、是否有兄弟 `description` 都一样）。`createSchema(z.string())`
 * 则产出双层嵌套 `{"schema":{…},"components":{}}`，同样不是合法的 Header Object。
 * 纯 JSON Schema 对象原样透传，是正确的唯一路径。
 *
 * 请求头不受此影响：`requestParams.header` 接受 zod object 并正确展开成
 * `parameters`，所以请求方向仍然用 zod（见 `operations.ts`）。
 *
 * ETag 的 pattern 从 `E_TAG_WIRE_PATTERN.source` 取，与请求方向共用一处拼写。
 *
 * 类型取 `oas31.HeaderObject` 而**不是** `ZodOpenApiHeaderObject`：后者是
 * `$ZodType | HeaderObject | ReferenceObject` 的联合，而响应 `headers` 的目标类型
 * `ZodOpenApiHeadersObject = ZodObjectInput | HeadersObject` 只接受**纯** JSON Schema
 * 那一种（`HeadersObject = { [name]: HeaderObject | ReferenceObject }`）。用宽联合去
 * 填窄位置编译不过，而既然本文件已经决定只用纯 JSON Schema，类型就该写成实际用的那个。
 */
export const RESPONSE_HEADER_NAMES = [
  'Content-Disposition',
  'ETag',
  'Location',
  'Retry-After',
  'Set-Cookie',
] as const;
export type ResponseHeaderName = (typeof RESPONSE_HEADER_NAMES)[number];

/**
 * 五个响应头的形状。**只声明形状，不含任何示例值** —— 一个 `Set-Cookie` 的示例就是
 * 一份会话凭证模板，而 §5 禁止凭证明文进入快照与 fixture。
 *
 * `required` 里唯一的 `false` 是 `Content-Disposition`，理由不是「它可有可无」，而是
 * OpenAPI 的 `headers` 挂在 **Response Object** 上、无法按 media type 收窄：唯一用到它的
 * `getUsageLedger` 的 200 同时有 `application/json` 与 `text/csv` 两个 content 条目，
 * 写 `true` 就等于宣称 JSON 分支也返回附件文件名。CSV 分支必带它这件事写进 description，
 * 并由服务端实现与 QA 用例负责，而不是由一个会说谎的 `required` 负责。
 */
export const RESPONSE_HEADERS: Record<ResponseHeaderName, oas31.HeaderObject> = {
  'Content-Disposition': {
    description: 'CSV 导出的附件文件名。**仅 `text/csv` 分支必带**，JSON 分支不返回。',
    required: false,
    schema: { type: 'string', minLength: 1 },
  },
  ETag: {
    description: '强校验值 "rev-<Revision>"；变更请求需回填到 If-Match。',
    required: true,
    schema: { type: 'string', pattern: E_TAG_WIRE_PATTERN.source },
  },
  Location: {
    description: '新建资源或异步任务的相对 URL。',
    required: true,
    schema: { type: 'string', minLength: 1 },
  },
  'Retry-After': {
    description: 'delta-seconds。429（RATE_LIMITED 与各类额度耗尽）必须携带。',
    required: true,
    schema: { type: 'integer', minimum: 0 },
  },
  'Set-Cookie': {
    description: 'Secure HttpOnly 会话 cookie。契约只声明形状，不含任何示例值。',
    required: true,
    schema: { type: 'string', minLength: 1 },
  },
};

/**
 * 取一组响应头，按名字排序后返回。
 *
 * 排序在这里做而不是留给归一化器：`test/operations.test.ts` 会直接断言 registry 里
 * 每个 operation 的响应头集合，那份断言不该依赖「归一化器恰好会排」。
 */
export function responseHeaders(names: readonly ResponseHeaderName[]): oas31.HeadersObject {
  const out: oas31.HeadersObject = {};
  for (const name of [...names].sort()) out[name] = RESPONSE_HEADERS[name];
  return out;
}

// ---------------------------------------------------------------------------
// operation 契约的类型词汇表
// ---------------------------------------------------------------------------

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const JSON_MEDIA_TYPE = 'application/json';
export const SSE_MEDIA_TYPE = 'text/event-stream';
/** §5.5：ledger 导出另支持 CSV。带 charset，与 OpenAPI media type 的写法一致。 */
export const CSV_MEDIA_TYPE = 'text/csv; charset=utf-8';

/**
 * Security Requirement Object 数组。
 *
 * §4.2 的精确语义：**顶层数组元素之间是 OR，同一对象内的 scheme 之间是 AND**。
 * 所以写接口的 `[{ CookieAuth: [], CsrfHeader: [] }]` 表示「必须同时带会话 cookie
 * 与 CSRF token」，而 `[]`（空数组）表示匿名可访问 —— 空数组不等于「未声明」，
 * 未声明会继承文档顶层的 security，因此公开接口必须显式写 `[]`（§5.5）。
 */
export type SecurityRequirements = readonly Readonly<Record<string, readonly string[]>>[];

/** 只读接口：需要会话，不需要 CSRF。 */
export const SESSION_SECURITY: SecurityRequirements = [{ CookieAuth: [] }];
/** 写接口：会话与 CSRF 同时必需（同一对象 = AND）。 */
export const SESSION_WITH_CSRF_SECURITY: SecurityRequirements = [
  { CookieAuth: [], CsrfHeader: [] },
];
/** 公开 / license / health：显式匿名。 */
export const ANONYMOUS_SECURITY: SecurityRequirements = [];

/**
 * 会话 cookie 名。
 *
 * OpenAPI 3.1 **没有** `type: 'cookie'` 这种 security scheme —— `SecuritySchemeType`
 * 只有 `apiKey | http | mutualTLS | oauth2 | openIdConnect`，而 cookie 的正规表达是
 * `{ type: 'apiKey', in: 'cookie', name: <cookie 名> }`，其中 `name` 对 `apiKey` 是
 * 必填的。所以要把 §5.5 的「Secure HttpOnly 会话 cookie」写成合法 OpenAPI，就必须
 * 给这个 cookie 一个名字。
 *
 * 附录 A §5.5 只说了「会话 cookie」，没有指定名字（这是本行发现的设计缺口，已在交付
 * 评论里声明）。取 `littleq_session`：带产品前缀，避免与同域下其它应用的 cookie 撞名；
 * 不含 `__Host-` / `__Secure-` 前缀，因为那两个前缀会连带约束 `Path=/` 与 `Domain`
 * 缺省，属于部署期决定，不该由传输契约钉死。`Secure` 与 `HttpOnly` 是 cookie 属性，
 * OpenAPI 无处表达，因此写进 scheme 的 `description`，由服务端实现负责。
 *
 * 改名是破坏性变更（§4.2「把幂等 header 改名」同源），比较器会报出来。
 */
export const SESSION_COOKIE_NAME = 'littleq_session';

/** CSRF 双提交令牌的头名（§5.5 明确规定为 `X-CSRF-Token`）。 */
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/**
 * 请求面。四个位置都用 zod object 声明，由生成器原样交给 zod-openapi 的
 * `requestParams`；缺省即「该位置没有参数」。
 *
 * `X-CSRF-Token` **不在**这里：它由 `CsrfHeader` security scheme 声明（§5.5），
 * 校验失败映射 `CSRF_REJECTED` 而不是 `REQUEST_INVALID`。把它同时写成 header 参数
 * 会让同一个头在文档里出现两次，并且把「令牌格式不对」错误地归到请求体校验里。
 */
export interface OperationRequest {
  readonly path?: WireObjectSchema;
  readonly query?: WireObjectSchema;
  readonly header?: WireObjectSchema;
  readonly body?: {
    readonly schema: WireSchema;
    readonly description: string;
    /**
     * 请求体本身是否必须出现，缺省为 `true`。
     *
     * 需要显式写 `false` 的是「字段全部 optional」的 body：`retryTask` /
     * `restoreProjectVersion` 的 `{reason?}` 与 `createPreview` 的 `{versionId?}`。
     * 这三条接口不带 body 也必须能成功，把 `requestBody.required` 写成 true 会让
     * 契约要求一个服务端并不要求的字节流 —— 而按 §4.2「增加必填字段」是破坏性变更，
     * 写错方向将来收不回来。反过来 `updateWork` 的 body 必须为 true：它的语义是
     * 「至少改一项」，空 body 无法满足。
     */
    readonly required?: boolean;
  };
}

/**
 * 一条成功响应。
 *
 * `success` 是**数组**（PM G5(1)）：同一个 operation 可以有多个成功状态码
 * （`200` + `304`）与多个 media type（ledger 的 JSON + CSV），一个对象装不下。
 *
 * 不变量：`mediaType === null` 当且仅当 `schema === null`（无 body 的 204/304）。
 * `test/operations.test.ts` 逐条断言，防止出现「声明了 media type 却没有 schema」
 * 这种会生成非法 OpenAPI 的半截条目。
 */
export interface SuccessResponse {
  readonly status: number;
  readonly description: string;
  readonly mediaType: string | null;
  readonly headers: readonly ResponseHeaderName[];
  readonly schema: WireSchema | null;
}

/**
 * 一条 operation 的完整声明。
 *
 * 这里是**框架无关**的：不含任何 Nest/Fastify 装饰器、不含数据库或 provider 概念
 * （附录 A §3.5）。apps/api 之后只能引用由它派生的 schema，不得再声明第二套 DTO
 * 校验规则。
 */
export interface OperationContract {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** 相对 `servers[0].url`（`/api/v1`）的路径模板。 */
  readonly path: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly security: SecurityRequirements;
  readonly request?: OperationRequest;
  readonly success: readonly SuccessResponse[];
  /** §5.4 表格右栏的专属错误码；共享码由 `openapi.ts` 从上面几项事实推导。 */
  readonly exclusiveErrorCodes: readonly ErrorCode[];
}

// ---------------------------------------------------------------------------
// 平台级 DTO：路径参数与 license / health
// ---------------------------------------------------------------------------

/**
 * 单对象路径参数 `{id}`。
 *
 * 28 条 operation 里有 12 条用它。注册成一个具名 component 而不是各处内联，是为了让
 * 快照里「哪些接口按对象 id 寻址」这件事只有一处拼写 —— 将来若要把实体 ID 换成别的
 * 形状（附录 A §6.4 允许线上表示独立演进），改这一个 schema 即可，且 §4.2 的
 * 破坏性比较会立刻在所有引用点同时报出。
 */
export const idPathSchema = z.object({ id: uuidV7Schema }).meta({ id: 'IdPath' });

/**
 * license 与 health 的响应 DTO 放在本文件，是因为附录 A §3.2 的目录清单里没有
 * `platform.ts`，而这三条接口（`getLicense` / `getLiveHealth` / `getReadyHealth`）
 * 是仅有的**不返回领域资源**的 operation。`ErrorEnvelope` 同样住在这里，理由相同。
 */

/** 40 位小写十六进制 commit SHA。契约只声明形状，快照里不出现任何真实 SHA。 */
export const COMMIT_SHA_WIRE_PATTERN = /^[0-9a-f]{40}$/;

/**
 * `GET /license`（§5.4）。
 *
 * `license` 用 `z.literal` 而不是 string：本仓库是 AGPL-3.0-only，这个字段的全部价值
 * 就在于它**不可能**是别的值；一旦有人把它改成枚举或字符串，比较器会按「扩大服务端
 * 可能输出集合」判为破坏性变更（§4.2），而那正是需要人来裁定的时刻。
 */
export const licenseSchema = z
  .object({
    version: contractVersionSchema,
    commit: z.string().regex(COMMIT_SHA_WIRE_PATTERN),
    sourceUrl: z.string().min(1).max(512),
    license: z.literal('AGPL-3.0-only'),
  })
  .meta({ id: 'LicenseInfo' });

/** `GET /health/live`：进程存活，**不探测任何依赖**（§5.4）。 */
export const liveHealthSchema = z.object({ status: z.literal('ok') }).meta({ id: 'LiveHealth' });

/**
 * `GET /health/ready` 的 200 分支。
 *
 * 依赖不可用时走 503 + 统一错误 envelope（专属码 `DEPENDENCY_UNAVAILABLE`），
 * **不**返回依赖的原始错误体（§5）。因此这个 schema 只有 `status` 一个字段：
 * 多一个「哪个依赖挂了」就是把内部拓扑暴露给匿名调用者。
 */
export const readyHealthSchema = z
  .object({ status: z.literal('ready') })
  .meta({ id: 'ReadyHealth' });

// ---------------------------------------------------------------------------
// 请求头组合
// ---------------------------------------------------------------------------

/**
 * 请求头组合。**这些 object 一律不带 `.meta({id})`**：它们只是「哪几个头同时出现」的
 * 分组，注册成 component 会在 `components.schemas` 里留下一堆无人复用的
 * `IfMatchHeader` / `IdempotencyHeader`，读者会误以为它们是可被引用的数据类型。
 * 真正需要复用的是叶子 schema（`IfMatch` / `IfNoneMatch` / `IdempotencyKey`），
 * 它们各自带 id，因此生成结果里是 `$ref`，拼写只有一处。
 *
 * 「必填」的表达方式是**不加 `.optional()`**：zod-openapi 对非 optional 的字段输出
 * `required: true`（实测）。`Idempotency-Key` 与 `If-Match` 因此是文档级必填，而
 * §5.4 仍然为它们保留了专属错误码（`IDEMPOTENCY_KEY_REQUIRED` / `REVISION_CONFLICT`）。
 * 两者不矛盾：OpenAPI 的 `required` 是**客户端义务**，专属码是**服务端在义务被违反时
 * 的应答**。把 header 声明成 optional 会让文档不再要求客户端发送它，那才是真正的漂移。
 */

/** 条件读取：`GET` 系列回填上次的 ETag，命中时服务端返回 304。 */
export const conditionalReadHeaderSchema = z.object({
  'If-None-Match': ifNoneMatchSchema.optional(),
});

/** 条件写：变更资源必须回填 `If-Match`，不匹配映射 `REVISION_CONFLICT`（§5.5）。 */
export const ifMatchHeaderSchema = z.object({ 'If-Match': ifMatchSchema });

/**
 * `PUT /usage/limits` 的双条件头。
 *
 * 两个都 optional，因为语义由服务端组合决定：带 `If-Match` 是「更新且版本必须匹配」，
 * 带 `If-None-Match: *` 是「仅当不存在时创建」，都不带是「无条件覆盖」。把三种组合
 * 拆成三条 operation 会让同一个 `PUT` 路径出现三次，OpenAPI 不允许。
 */
export const usageLimitConditionalHeaderSchema = z.object({
  'If-Match': ifMatchSchema.optional(),
  'If-None-Match': ifNoneMatchSchema.optional(),
});

/** 幂等写：`createTurn` 必填（§5.5「turn/publish 必填」）。 */
export const idempotencyHeaderSchema = z.object({ 'Idempotency-Key': idempotencyKeySchema });

/** 发布同时是幂等写与条件写：两个头都必填，位于同一个 header object 里。 */
export const publishHeaderSchema = z.object({
  'Idempotency-Key': idempotencyKeySchema,
  'If-Match': ifMatchSchema,
});

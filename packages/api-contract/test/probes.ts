/**
 * 线上格式探针集 —— **提交进仓库的数据**，不是运行时扫描的结果。
 *
 * `schemas/common.ts` 为每条线上格式重写了一份正则，而不是从 `packages/domain` 导入
 * （理由写在那个文件的头注释里：domain 的 pattern 绝大多数是模块私有的，把「UUIDv7
 * 长什么样」变成领域层的公开 API 等于让它为传输表示负责）。代价是两份约束可能漂移，
 * 而漂移的后果是**静默的**：契约比 domain 宽，客户端照文档发一个注定 400 的值；契约比
 * domain 窄，服务端能接受的输入被文档宣称非法。
 *
 * 这份探针就是防漂移的机制。每条记录只声明三件事：一对**同名的**契约 schema 与 domain
 * 谓词，加上一组 accepts / rejects。`schemas.test.ts` 对每条探针做双向交叉校验：
 * accepts 必须两侧都接受，rejects 必须两侧都拒绝。任何一侧单独变化都会让那条测试变红。
 *
 * ## 为什么是数据而不是「拿 domain 的实现当期望值」
 *
 * PM G6(2)：「任何期望值来自『对本机扫描』的断言一律拒绝」。把 `isUuidV7` 的实现直接
 * 当作 wire pattern 的期望值，等价于让一侧给自己判卷 —— 两侧一起改错就永远是绿的。
 * 字面量探针是第三方：它既不来自 wire 正则，也不来自 domain 谓词，改错任何一侧都会撞上它。
 *
 * 探针里出现的每一个值都是手写常量。少数 `'a'.repeat(80)` 形式的长度边界是纯函数调用
 * （不读时钟、不读环境、不读文件系统、不读 domain 常量），结果在任何宿主上逐字节相同，
 * 也因此仍然是第三方期望值：把上限改成 81 会让契约侧单独变绿、探针立刻变红。
 *
 * ## 一处**故意保留**的分歧
 *
 * `Timestamp` 的 wire pattern 只做语法检查，日历有效性由 domain 判定并映射
 * `REQUEST_INVALID`（`schemas/common.ts` 头注释明写了这一条）。这不是漏网，所以它不进
 * 下面的 `WIRE_PROBES`（进了就永远红），而是单独放在 `TIMESTAMP_KNOWN_DIVERGENCE`，
 * 由 `schemas.test.ts` 逐条钉住方向：wire 接受、domain 拒绝。钉住方向的价值在于——
 * 后来者若把日历校验塞进正则，或反过来以为正则已经管住了 `2026-02-30`，都会立刻红。
 */
import {
  isAcceptablePasswordLength,
  isAcceptablePromptLength,
  isArtifactDigest,
  isContractVersion,
  isCursor,
  isETag,
  isGroupName,
  isIdempotencyKey,
  isLoginName,
  isNickname,
  isOperatorNote,
  isProjectTitle,
  isRevision,
  isSlug,
  isTaskEventId,
  isTimezone,
  isTimestamp,
  isUuidV7,
} from '@littleq/domain';
import type { z } from 'zod';

import {
  contractVersionSchema,
  cursorSchema,
  eTagValueSchema,
  groupNameSchema,
  idempotencyKeySchema,
  loginNameSchema,
  nicknameSchema,
  operatorNoteSchema,
  passwordSchema,
  projectTitleSchema,
  promptSchema,
  revisionSchema,
  sha256Schema,
  slugSchema,
  taskEventIdSchema,
  timestampSchema,
  timezoneSchema,
  uuidV7Schema,
} from '../src/index.js';

export interface WireProbe {
  /** 探针名，同时是测试用例名的一部分。 */
  readonly name: string;
  /** 出处：契约侧的 schema 与领域侧的谓词必须成对出现，缺一侧这条探针就没有意义。 */
  readonly spec: string;
  readonly schema: z.ZodType;
  readonly predicate: (value: string) => boolean;
  readonly accepts: readonly string[];
  readonly rejects: readonly string[];
}

/** 幂等键长度边界（§5.5：16–128 ASCII）。 */
const KEY_16 = '0123456789abcdef';
const KEY_128 = KEY_16.repeat(8);
const KEY_15 = '0123456789abcde';
const KEY_129 = `${KEY_128}z`;

export const WIRE_PROBES: readonly WireProbe[] = [
  {
    name: 'UuidV7',
    spec: '§5.5「UuidV7 小写 UUID」；domain identifiers.ts isUuidV7',
    schema: uuidV7Schema,
    predicate: isUuidV7,
    accepts: [
      '0190f1a2-3b4c-7d5e-8f60-123456789abc',
      'ffffffff-ffff-7fff-bfff-ffffffffffff',
      '00000000-0000-7000-8000-000000000000',
    ],
    rejects: [
      '',
      // 版本位不是 7（这是 v4）
      '0190f1a2-3b4c-4d5e-8f60-123456789abc',
      // variant 位不在 8/9/a/b
      '0190f1a2-3b4c-7d5e-cf60-123456789abc',
      // 大写：线上表示固定小写
      '0190F1A2-3B4C-7D5E-8F60-123456789ABC',
      // 缺连字符
      '0190f1a23b4c7d5e8f60123456789abc',
      // 末段少一位
      '0190f1a2-3b4c-7d5e-8f60-123456789ab',
    ],
  },
  {
    name: 'Revision',
    spec: '§5.5「Revision 非负十进制字符串」；domain primitives.ts isRevision',
    schema: revisionSchema,
    predicate: isRevision,
    accepts: ['0', '1', '42', '9007199254740993'],
    rejects: ['', '-1', '01', '1.0', ' 1', '1 ', 'abc', '+1'],
  },
  {
    name: 'TaskEventId',
    spec: '§5.5「TaskEvent.id 例外为十进制字符串」；domain identifiers.ts isTaskEventId',
    schema: taskEventIdSchema,
    predicate: isTaskEventId,
    accepts: ['1', '42', '9007199254740993'],
    // `0` 被两侧同时拒绝，但理由不同：wire 的 pattern 是 `^[1-9][0-9]*$`，
    // domain 是「十进制且 BigInt > 0」。`007` 也被两侧拒绝（domain 的十进制 pattern
    // 不允许前导零），所以两条实现在这个集合上恰好等价 —— 探针钉的就是这个等价。
    rejects: ['', '0', '007', '00', '-1', '1.0', 'abc'],
  },
  {
    name: 'Cursor',
    spec: '§5.5「Cursor 不透明 base64url」；domain primitives.ts isCursor',
    schema: cursorSchema,
    predicate: isCursor,
    accepts: ['abc', 'a-_Z09', 'gAAAAA', 'A'],
    // base64url 不含 `+` `/` `=`：padding 与标准 base64 的两个符号都必须拒绝，
    // 否则「不透明游标」就有了第二条拼写，排序键的比较会随之歧义。
    rejects: ['', 'ab=', 'a+b', 'a/b', 'a b', 'a\tb'],
  },
  {
    name: 'Slug',
    spec: '§5.5 公开作品 slug；domain primitives.ts isSlug',
    schema: slugSchema,
    predicate: isSlug,
    accepts: ['abc', 'my-work-2026', '-a-', 'a'.repeat(80)],
    rejects: ['', 'ab', 'a'.repeat(81), 'Abc', 'a_b', 'a.b', 'a b', '工作'],
  },
  {
    name: 'ContractVersion',
    spec: '§5.4 license.commit 之外的契约版本；domain primitives.ts isContractVersion',
    schema: contractVersionSchema,
    predicate: isContractVersion,
    accepts: ['0.0.0', '1.0.0', '12.34.56'],
    rejects: ['', '1.0', '1.0.0.0', '1.0.0-beta', 'v1.0.0', '1.0.0+build'],
  },
  {
    name: 'ETag',
    spec: '§5.5「ETag 强校验值 "rev-<Revision>"」；domain primitives.ts isETag',
    schema: eTagValueSchema,
    predicate: isETag,
    accepts: ['"rev-0"', '"rev-3"', '"rev-9007199254740993"'],
    // 弱校验值与裸值都拒绝：`revisionFromETag` 直接 slice 掉固定前后缀，
    // 放过 `W/"rev-3"` 会解析出错误的 revision。
    rejects: ['', 'rev-3', 'W/"rev-3"', '"rev-01"', '"rev--1"', '"rev-"', '"rev-1.0"'],
  },
  {
    name: 'IdempotencyKey',
    spec: '§5.5「16–128 ASCII ^[A-Za-z0-9._:-]+$」；domain primitives.ts isIdempotencyKey',
    schema: idempotencyKeySchema,
    predicate: isIdempotencyKey,
    accepts: [KEY_16, 'Turn_2026-10-16.a', KEY_128, 'aaaaaaaaaaaaaaaa:1'],
    rejects: [
      '',
      KEY_15,
      KEY_129,
      // 长度够但字符集越界：空格与非 ASCII 都必须拒绝
      'has space.......',
      '中文中文中文中文',
      'key#1...........'.slice(0, 16),
    ],
  },
  {
    name: 'Timezone',
    spec: '§5.5 用量限额的每日边界；domain usage.ts isTimezone',
    schema: timezoneSchema,
    predicate: isTimezone,
    accepts: [
      'Asia/Shanghai',
      'America/New_York',
      'Etc/GMT+8',
      // IANA 数据库里真实存在的三段名。两侧都只校验**形状**（Area/Location，可多段），
      // 都不对着 IANA 数据库验真 —— 那份数据是运行时事实，不是契约事实。
      'America/Argentina/Buenos_Aires',
      `${'A'.repeat(31)}/${'b'.repeat(32)}`,
    ],
    rejects: [
      '',
      // 裸 `UTC` 没有 `/`：domain 要求 Area/Location，契约若放过它，客户端就会发一个
      // 服务端必定判 REQUEST_INVALID 的值（common.ts 头注释点名的那条）。
      'UTC',
      '/Asia',
      'Asia/',
      '/Asia/',
      '1Asia/Shanghai',
      `${'A'.repeat(32)}/${'b'.repeat(32)}`,
    ],
  },
  {
    name: 'Sha256',
    spec: '§5.5 产物摘要；domain primitives.ts isArtifactDigest（SHA256_PATTERN）',
    schema: sha256Schema,
    predicate: isArtifactDigest,
    accepts: ['a'.repeat(64), '0'.repeat(64), 'deadbeef'.repeat(8)],
    // 大写与 0x 前缀都拒绝：摘要是**比较键**，两种拼写会让同一份产物产生两条记录。
    rejects: [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      `0x${'a'.repeat(62)}`,
    ],
  },
  {
    name: 'LoginName',
    spec: '§5.4 login.loginName；domain primitives.ts isLoginName（1..64，无控制字符，非全空白）',
    schema: loginNameSchema,
    predicate: isLoginName,
    accepts: ['zlq', 'student-01', '张三', 'a'.repeat(64)],
    // `'   '` 与 `'a\tb'` 两侧都拒绝：契约的 refine 与 domain 的 isBoundedText 是同一组条件。
    rejects: ['', 'a'.repeat(65), '   ', 'a\tb', 'a\nb'],
  },
  {
    name: 'Nickname',
    spec: '§5.5 学生昵称；domain primitives.ts isNickname（1..64）',
    schema: nicknameSchema,
    predicate: isNickname,
    accepts: ['小明', 'a'.repeat(64)],
    rejects: ['', 'a'.repeat(65), '\u0007', ' '],
  },
  {
    name: 'GroupName',
    spec: '§5.4 createGroup.name；domain group.ts isGroupName（1..80）',
    schema: groupNameSchema,
    predicate: isGroupName,
    accepts: ['三年级一班', 'a'.repeat(80)],
    rejects: ['', 'a'.repeat(81), '  \t '],
  },
  {
    name: 'ProjectTitle',
    spec: '§5.4 createProject.title；domain project.ts isProjectTitle（1..100）',
    schema: projectTitleSchema,
    predicate: isProjectTitle,
    accepts: ['我的小游戏', 'a'.repeat(100)],
    rejects: ['', 'a'.repeat(101)],
  },
  {
    name: 'OperatorNote',
    spec: '§5.5 retryTask.reason / restoreProjectVersion.reason；domain task.ts isOperatorNote（1..200）',
    schema: operatorNoteSchema,
    predicate: isOperatorNote,
    accepts: ['网络抖动，重试一次', 'a'.repeat(200)],
    rejects: ['', 'a'.repeat(201)],
  },
  {
    name: 'Prompt',
    spec: '§5.4 createTurn.prompt；domain task.ts isAcceptablePromptLength（1..8000）',
    schema: promptSchema,
    predicate: isAcceptablePromptLength,
    // 值一律是无意义占位文本：§5 禁止真实学生 prompt 进入 fixture。
    accepts: ['a', '占位文本', 'a'.repeat(8000)],
    rejects: ['', 'a'.repeat(8001)],
  },
  {
    name: 'Password',
    spec: '§5.4 login.password 8..128；domain account.ts isAcceptablePasswordLength',
    schema: passwordSchema,
    predicate: isAcceptablePasswordLength,
    // **只探长度边界**：契约侧额外拒绝控制字符，domain 侧只判长度（它从不持有口令明文），
    // 所以带控制字符的值两侧结论不同 —— 那是有意分工，不是漂移，不能进探针。
    accepts: ['a'.repeat(8), 'a'.repeat(128)],
    rejects: ['', 'a'.repeat(7), 'a'.repeat(129)],
  },
];

/**
 * `Timestamp`：wire 只做语法检查、domain 额外做日历校验，是**唯一一处故意的分歧**。
 *
 * 四个值都满足 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$`，但都不是真实
 * 存在的时刻：2 月 30 日、13 月、24 时、以及非闰年的 2 月 29 日。domain 通过
 * `Date.parse` + `toISOString()` 往返把它们全部拒掉，并映射 `REQUEST_INVALID`。
 *
 * 方向必须钉死：wire 宽于 domain 是**有意**的（契约层不做日历运算，服务端做），
 * 反过来（wire 窄于 domain）才是要报警的漂移。
 */
export const TIMESTAMP_KNOWN_DIVERGENCE: readonly string[] = [
  '2026-02-30T00:00:00Z',
  '2026-13-01T00:00:00Z',
  '2026-01-01T24:00:00Z',
  '2023-02-29T00:00:00Z',
];

/**
 * `Timestamp` 两侧**一致**的部分：语法与日历同时成立（accepts），或语法就已经不成立
 * （rejects）。单独列出来是因为 `TIMESTAMP_KNOWN_DIVERGENCE` 只覆盖「wire 宽于 domain」
 * 这一侧，没有这一组就无法证明两者在正常输入上确实等价。
 */
export const TIMESTAMP_AGREEMENT = {
  accepts: [
    '2026-01-01T00:00:00Z',
    '2024-02-29T12:00:00Z', // 2024 是闰年，这一天真实存在
    '2026-10-16T08:59:00.123456Z', // 小数秒 6 位
    '2026-12-31T23:59:59.5Z', // 小数秒 1 位
  ],
  rejects: [
    '',
    '2026-01-01T00:00:00', // 缺 Z
    '2026-01-01 00:00:00Z', // 空格分隔
    '2026-01-01T00:00:00.1234567Z', // 小数秒 7 位
    '2026-01-01T00:00:00+08:00', // 带偏移量而非 UTC
    '2026-1-01T00:00:00Z', // 月份没补零
  ],
} as const satisfies { accepts: readonly string[]; rejects: readonly string[] };

/** `Timestamp` 的一对，形状与 `WIRE_PROBES` 的条目一致，供测试直接取用。 */
export const TIMESTAMP_PAIR: WireProbe = {
  name: 'Timestamp',
  spec: '§5.5「Timestamp UTC RFC3339」；domain primitives.ts isTimestamp（额外做日历校验）',
  schema: timestampSchema,
  predicate: isTimestamp,
  accepts: TIMESTAMP_AGREEMENT.accepts,
  rejects: TIMESTAMP_AGREEMENT.rejects,
};

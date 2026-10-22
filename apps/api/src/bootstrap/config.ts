/**
 * 形态 B（Vercel 主站）的部署配置解析 —— ZLQ-157 §2.1 装配顺序的前两步
 * （「读取部署形态/可信平台标识 → Zod 校验基础配置」）与第三步（「形态允许组合校验」）。
 *
 * ## 为什么变量清单写在这里，而 `packages/infra/src/env.ts` 里没有
 *
 * `env.ts` 的文件头逐字写着「**本文件刻意不定义任何具体变量。** 完整变量清单属于
 * ZLQ-157（部署与运行时形态），这里只落地机制」。本文件就是那份清单在形态 B 上的落地：
 * 机制（`defineEnv` / `EnvValidationError`）原样复用，一个字段也不重写。清单的**事实源**
 * 是 ZLQ-157 §3.1 那张表，本文件只收形态 B 的 API 进程真正要读的那几行。
 *
 * ## 🚨 红线：这里只出现变量**名**，永不出现变量**值**
 *
 * §2.2 逐字：「原始异常只在驱动边界转固定码，**禁止 body/SQL 参数/connection URL 落日志**」。
 * 于是本文件有两条结构性约束，都由测试钉住（`test/bootstrap-config.test.ts`）：
 *
 * 1. `BootstrapConfigError.message` 只由**固定码 + 变量名 + 一句不含数据的说明**拼成。
 *    连接串、主密钥、口令一律不进消息。测试的做法是往输入里塞一个可识别的哨兵值，
 *    然后断言抛出的消息里**不含**那个哨兵 —— 这不需要测试自己知道任何真实值。
 * 2. **连接串不出现在解析结果里。** `FormBConfig` 只带「哪个变量名胜出」这类**名字**事实；
 *    真要拿值走 {@link runtimeConnectionOf} / {@link migrationConnectionOf}，它们返回的是
 *    `source` 里那个字符串**本体**（同一个引用，未做任何拼接、改写或参数增删）。
 *    于是「逐字原样透传」不是一句自述，而是一条可以用 `Object.is` 断言的性质 ——
 *    §2.1 的 `sources.ts` 文件头写明「不发明 TLS 选项、不猜超时、不塞应用名。连接串是
 *    部署期秘密，它已经携带了 `sslmode` 之类的参数」，本文件连一个字符都不碰它。
 *
 * ## ⚠️ 命名冲突：三个名字都认，但**不自行裁定**哪个为准
 *
 * 同一个「运行连接串」在仓库里有三个来源，彼此矛盾，本文件全部接受：
 *
 * | 名字 | 出处 | 现状 |
 * | --- | --- | --- |
 * | `DATABASE_URL` | ZLQ-157 §3.1（B = Neon pooled） | 设计文档点的名 |
 * | `LITTLEQ_DATABASE_URL` | `packages/infra/src/init/bootstrap-accounts.ts:77` | 仓库里**唯一已有**的真实读者 |
 * | `.env.example` 规则 4 的 `LQ_` 前缀 | 仓库既有约定 | 前两个都不符合 |
 *
 * 两个都给了且**值不同**时抛 `DATABASE_URL_AMBIGUOUS`，而不是按某个优先级悄悄挑一个：
 * 挑错了不会报错，只会让运行连接打到另一台库上。裁定「以哪个为准」需要改
 * `.env.example` 或改 `bootstrap-accounts.ts` 的历史，那是治理修订，不在本单。
 *
 * `DB_POOL_MAX` 是同一类冲突（§3.1 写「B=2」，而 `sources.ts` 写「**默认值交给 SDK**，
 * 不在这里编一个数」）。本文件两边都不硬编码：**给了就校验后透传，没给就整个字段不出现**，
 * 于是 `createNeonClientSource` 收到的是 `max: undefined`，池大小真的是 SDK 决定的。
 */
import { z } from 'zod';

import {
  EnvValidationError,
  MASTER_KEY_ENV_VAR,
  defineEnv,
  type EnvSource,
} from '@littleq/infra';

/**
 * 转出口给同目录的 `migrate.ts` / `vercel.ts`：它们只需要"一个能按名字读的环境"，
 * 不需要知道 infra 用的是什么形状。转出口而不是让它们各自去 import infra，
 * 是为了让「形态 B 读哪些变量」这件事只在一个文件里发生。
 */
export type { EnvSource };

/** ZLQ-157 §2.1 的三种部署形态。本文件只解析 `B`。 */
export type DeploymentForm = 'A' | 'B' | 'C';

/** §3.1 `LITTLEQ_ENV` 的三个取值，与 Vercel 注入的 `VERCEL_ENV` 同一套字面量。 */
export type PlatformEnv = 'production' | 'preview' | 'development';

/**
 * 本装配根服务的形态。§2.1 表里 A / B / C 各有各的组合根，不共用一个。
 *
 * 不写成 `: DeploymentForm`：那样会把类型放宽成三选一，`FormBConfig.deployment`
 * 就再也表达不出"这个配置只可能是 B"。`satisfies` 保住字面量的同时仍然检查它合法。
 */
export const FORM_B = 'B' satisfies DeploymentForm;

/**
 * 变量名常量。集中在一处是为了让「谁读什么」变成可 grep 的事实，
 * 也为了让交付说明里的逐变量表格与代码不会各说一套。
 */
export const FORM_B_ENV_VARS = {
  /** §3.1「必需，发行包自动；无值拒启」。 */
  deployment: 'LITTLEQ_DEPLOYMENT',
  /** §3.1「自动；与平台环境不一致拒启」。 */
  littleqEnv: 'LITTLEQ_ENV',
  /** §3.1 line 207「平台自动变量不在 `.env.example` 伪造：**B读取`VERCEL_ENV`**」。 */
  vercelEnv: 'VERCEL_ENV',
  /** §3.1（B = Neon pooled）。与 `littleqDatabaseUrl` 二者取一，都给了必须相等。 */
  databaseUrl: 'DATABASE_URL',
  /** `packages/infra/src/init/bootstrap-accounts.ts:77` 的 `DATABASE_URL_ENV_VAR`。 */
  littleqDatabaseUrl: 'LITTLEQ_DATABASE_URL',
  /** §3.1「PG迁移direct/admin专用；**禁止pool代替**」。只给迁移入口，不给运行装配。 */
  databaseDirectUrl: 'DATABASE_DIRECT_URL',
  /** §3.1「每函数/进程连接池」。缺省时**不编数字**，交给 SDK。 */
  poolMax: 'DB_POOL_MAX',
  /** §3.1「**必填**；未配置不能标部署成功」。 */
  sourceCodeUrl: 'SOURCE_CODE_URL',
  /** §3.1 `GIT_COMMIT`「Build自动；缺失release失败；运行不能伪造commit」。 */
  commitSha: 'VERCEL_GIT_COMMIT_SHA',
  /** `packages/infra/src/ports/secret-store.ts:33`。值校验由 `loadMasterKey` 做，本文件不重复。 */
  masterKey: MASTER_KEY_ENV_VAR,
} as const;

/**
 * 迁移专用的那一个变量名，单独拎出来是为了让类型层面就能表达
 * 「迁移入口只会告诉你它读的是 `DATABASE_DIRECT_URL`」——
 * `migrate.ts` 的返回类型写的是 `typeof FORM_B_MIGRATION_URL_ENV_VAR`，
 * 换成任何一个别的名字都编译不过，而运行时它其实只是个字符串。
 */
export const FORM_B_MIGRATION_URL_ENV_VAR = FORM_B_ENV_VARS.databaseDirectUrl;

/** Neon 池化主机名的标记。§5.4「运行连接使用Neon pooled URL…迁移专用direct URL」。 */
const POOLED_HOST_MARKER = '-pooler';

/**
 * 固定码集合。**不是** §5.4 那 42 个对外错误码的一部分 —— 那套是冻结的，不能新增；
 * 这里的码只在进程启动阶段出现，调用方是部署者与运维，不是 HTTP 客户端。
 */
export type BootstrapConfigCode =
  | 'ENV_SCHEMA_INVALID'
  | 'DEPLOYMENT_FORM_MISSING'
  | 'DEPLOYMENT_FORM_UNSUPPORTED'
  | 'PLATFORM_ENV_MISMATCH'
  | 'DATABASE_URL_MISSING'
  | 'DATABASE_URL_AMBIGUOUS'
  | 'MIGRATION_URL_MISSING'
  | 'MIGRATION_URL_IS_POOLED'
  | 'MIGRATION_URL_UNPARSEABLE'
  | 'SOURCE_CODE_URL_MISSING'
  | 'BUILD_IDENTITY_MISSING'
  | 'CONNECTION_STRING_HAS_WHITESPACE'
  | 'PROVIDER_CONFIG_UNREGISTERED';

/**
 * 启动期配置错误。
 *
 * `message` 的形状是刻意的：`[固定码] 变量名…: 说明`。**不含任何值**，
 * 因为这条消息会进部署日志，而 §2.2 禁止 connection URL 落日志。
 */
export class BootstrapConfigError extends Error {
  readonly code: BootstrapConfigCode;
  /** 只放变量**名**。放值是红线。 */
  readonly variables: readonly string[];

  constructor(code: BootstrapConfigCode, variables: readonly string[], detail: string) {
    super(
      `[${code}]${variables.length > 0 ? ` ${variables.join(', ')}` : ''}: ${detail}`.trim(),
    );
    this.name = 'BootstrapConfigError';
    this.code = code;
    this.variables = variables;
  }
}

/**
 * 一条连接串的**出处**与它本身。`connectionString` 是 `EnvSource` 里那个字符串本体
 * （不 trim、不改写，见 {@link optionalConnection}）。
 *
 * `Variable` 参数化是为了让"读的是哪一个变量名"变成编译期事实：迁移那条腿传字面量
 * `'DATABASE_DIRECT_URL'`，运行时那条腿传 {@link RuntimeUrlVariable}，写错名字编译不过。
 */
export interface SqlConnectionRef<Variable extends string = string> {
  readonly variableName: Variable;
  readonly connectionString: string;
}

/** 运行时连接串可能被读到的两个名字（三个命名口径里被认下的那两个，见文件头）。 */
export type RuntimeUrlVariable =
  | typeof FORM_B_ENV_VARS.databaseUrl
  | typeof FORM_B_ENV_VARS.littleqDatabaseUrl;

/**
 * 解析结果。**不含任何秘密值。**
 *
 * 连接串只以「哪个变量名胜出」的形式出现（{@link FormBConfig.runtimeUrlVariable}），
 * 取值另走 {@link runtimeConnectionOf}。这样做的理由写在文件头红线 2。
 */
export interface FormBConfig {
  readonly deployment: typeof FORM_B;
  readonly platformEnv: PlatformEnv;
  /** 胜出的运行连接串变量名。`DATABASE_URL` 或 `LITTLEQ_DATABASE_URL` 之一。 */
  readonly runtimeUrlVariable: RuntimeUrlVariable;
  /**
   * `undefined` = 部署没给 `DB_POOL_MAX` ⇒ 整个字段不往驱动传，池大小由 SDK 决定。
   * 刻意不默认成 2 也不默认成 10：§3.1 与 `sources.ts` 在这件事上互相矛盾（见文件头）。
   */
  readonly poolMax: number | undefined;
  /** §3.1 必填。空值即 `SOURCE_CODE_URL_MISSING`。 */
  readonly sourceCodeUrl: string;
  /**
   * 生产环境下必须有真值；缺失即 `BUILD_IDENTITY_MISSING`。
   * **绝不兜底成 `'unknown'`** —— `apps/web/src/build-info.ts` 的失败关闭是同一原则，
   * 软化它等于让一个部署对外声称一个它自己都不知道的身份。
   */
  readonly commitSha: string | undefined;
  /** 主密钥所在的变量名。值由 `loadMasterKey(env)` 自己取并校验。 */
  readonly masterKeyVariable: typeof MASTER_KEY_ENV_VAR;
}

/**
 * Zod 只做**单字段形状**校验：枚举、正整数、非空串。
 *
 * 跨字段的判据（两个连接串名字是否冲突、迁移串是不是池化串、生产环境有没有 commit）
 * 一律放在下面的解析函数里 —— zod 的 `superRefine` 也能表达，但那样错误消息会由 zod 生成，
 * 而 zod 的消息里可能带上收到的输入。把跨字段判据留在自己手里，才能保证消息里只有变量名。
 *
 * ⚠️ 连接串字段刻意只用 `z.string()`，**不套 `z.url()`**：那会让 zod 去解析一段可能含
 * 特殊字符的秘密，并且它的失败消息形态由 zod 版本决定。形状判据交给
 * {@link assertNotPooled}（它自己 `try/catch` 了 `new URL`）。
 */
const RAW_FORM_B_ENV_SCHEMA = z.object({
  LITTLEQ_DEPLOYMENT: z.enum(['A', 'B', 'C']).optional(),
  LITTLEQ_ENV: z.enum(['production', 'preview', 'development']).optional(),
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
  DATABASE_URL: z.string().optional(),
  LITTLEQ_DATABASE_URL: z.string().optional(),
  DATABASE_DIRECT_URL: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
  SOURCE_CODE_URL: z.string().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
});

type RawFormBEnv = z.output<typeof RAW_FORM_B_ENV_SCHEMA>;

const SCHEMA_NAME = 'api-form-b';

function parseRawEnv(source: EnvSource | undefined): RawFormBEnv {
  try {
    return source === undefined
      ? defineEnv({ name: SCHEMA_NAME, schema: RAW_FORM_B_ENV_SCHEMA })
      : defineEnv({ name: SCHEMA_NAME, schema: RAW_FORM_B_ENV_SCHEMA, source });
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // `EnvValidationError.issues` 的 `path` 是变量名、`message` 由 zod 生成。
      // 这里只把两者拼起来，并且 `test/bootstrap-config.test.ts` 用哨兵值断言了
      // 拼出来的消息里不含输入值本身。
      const detail = error.issues
        .map((issue) => `${issue.path || '(root)'} ${issue.message} [${issue.code}]`)
        .join('; ');
      throw new BootstrapConfigError(
        'ENV_SCHEMA_INVALID',
        error.issues.map((issue) => issue.path || '(root)'),
        detail,
      );
    }
    throw error;
  }
}

/** 空白-only 视同未设置：`LITTLEQ_DEPLOYMENT=" "` 不该被当成一个形态。 */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 连接串专用：**判存在**用修剪后的形状，**取值**一律返回原样字符串。
 *
 * 与 {@link present} 的区别是刻意的。非秘密字段（形态、环境、commit）修剪掉首尾空白是
 * 无害的便利；连接串是部署期秘密，本文件对它承诺的是「逐字原样透传」，那承诺要能用
 * `Object.is(source[name], ref.connectionString)` 断言，就不能在中途改写一个字符。
 * 首尾空白改成**大声失败**（{@link assertNoSurroundingWhitespace}）而不是悄悄修掉：
 * 悄悄修掉之后，部署者永远不知道自己在控制台里粘错了一次。
 */
function optionalConnection(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? undefined : value;
}

function assertNoSurroundingWhitespace(connectionString: string, variableName: string): void {
  if (connectionString !== connectionString.trim()) {
    throw new BootstrapConfigError(
      'CONNECTION_STRING_HAS_WHITESPACE',
      [variableName],
      '该连接串有首尾空白（多半是控制台粘贴时带进来的换行）。' +
        '本文件不会替你修掉它：连接串是部署期秘密，承诺是逐字原样透传，' +
        '改一个字符就不再是可断言的透传。请在平台侧把值重新粘一次。',
    );
  }
}

function assertNotPooled(connectionString: string, variableName: string): void {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    // 解析不出主机名就没法证明它**不是**池化地址。此时拒绝而不是放过：
    // 一条静默通过的负向守卫等于没有守卫。消息里只有变量名。
    throw new BootstrapConfigError(
      'MIGRATION_URL_UNPARSEABLE',
      [variableName],
      '无法从该连接串解析出主机名，因此无法证明它不是池化地址（§5.4：迁移必须走 direct）。',
    );
  }
  if (hostname.toLowerCase().includes(POOLED_HOST_MARKER)) {
    throw new BootstrapConfigError(
      'MIGRATION_URL_IS_POOLED',
      [variableName],
      `主机名含 "${POOLED_HOST_MARKER}"，这是 Neon 的**池化**地址。` +
        '§5.4 逐字：「运行连接使用Neon pooled URL…迁移专用direct URL」。' +
        '迁移要在同一个后端会话里持有 advisory lock 直到提交，池化地址会在语句之间换后端。',
    );
  }
}

/**
 * 解析形态 B 的基础配置。任何一项不符即抛 {@link BootstrapConfigError}，**不降级、不兜底**。
 *
 * @param source 显式来源；省略时由 `defineEnv` 读 `process.env` 并尝试加载仓库根 `.env`
 *               （本地开发路径；Vercel 上没有 `.env`，`loadEnvFile` 返回 false，不是错误）。
 */
export function resolveFormBConfig(source?: EnvSource): FormBConfig {
  const raw = parseRawEnv(source);

  // —— 第 1 步：部署形态（§2.1「`LITTLEQ_DEPLOYMENT=A|B|C` 是**安装时冻结**值，不由客户端指定」）
  const deployment = present(raw.LITTLEQ_DEPLOYMENT);
  if (deployment === undefined) {
    throw new BootstrapConfigError(
      'DEPLOYMENT_FORM_MISSING',
      [FORM_B_ENV_VARS.deployment],
      '§3.1：该变量「必需，发行包自动；**无值拒启**」。它是安装时冻结值，不能由请求指定，' +
        '也不能从别的变量推出来 —— 推出来就等于让客户端选择部署形态。',
    );
  }
  if (deployment !== FORM_B) {
    throw new BootstrapConfigError(
      'DEPLOYMENT_FORM_UNSUPPORTED',
      [FORM_B_ENV_VARS.deployment],
      `本装配根只服务形态 B，读到的是形态 ${deployment}。` +
        '§2.1 的组合根表给 A / C 各留了自己的入口；在这里替它们装配等于用错的驱动组合起进程。',
    );
  }

  // —— 第 2 步：可信平台标识（§2.1「B 与 `VERCEL_ENV`…不符时拒绝启动」）
  const littleqEnv = present(raw.LITTLEQ_ENV) as PlatformEnv | undefined;
  const vercelEnv = present(raw.VERCEL_ENV) as PlatformEnv | undefined;
  if (littleqEnv !== undefined && vercelEnv !== undefined && littleqEnv !== vercelEnv) {
    throw new BootstrapConfigError(
      'PLATFORM_ENV_MISMATCH',
      [FORM_B_ENV_VARS.littleqEnv, FORM_B_ENV_VARS.vercelEnv],
      '两个环境标识都在，且不相等。这正是 §2.1 line 77 点名为致命配置错误的「生产/preview混绑」：' +
        '一份 preview 的绑定跑到 production 的域名上，或反过来。拒绝启动，不挑一个。',
    );
  }
  const platformEnv: PlatformEnv = littleqEnv ?? vercelEnv ?? 'development';
  if (platformEnv === 'production' && vercelEnv === undefined) {
    // 声称 production 却读不到平台注入的 `VERCEL_ENV` ⇒ 这不是 Vercel 上的生产运行。
    // §8.1 的配置硬检查里有一项正是「非 preview 的 production 绑定」。
    throw new BootstrapConfigError(
      'PLATFORM_ENV_MISMATCH',
      [FORM_B_ENV_VARS.littleqEnv, FORM_B_ENV_VARS.vercelEnv],
      `解析出的环境是 production，但 ${FORM_B_ENV_VARS.vercelEnv} 不存在。` +
        '形态 B 的 production 只能跑在 Vercel 上，而 Vercel 一定会注入它。',
    );
  }

  // —— 第 3 步：形态允许组合校验（§2.1）。运行连接串、源码地址、构建身份。
  const runtimeUrlVariable = resolveRuntimeUrlVariable(raw);

  const sourceCodeUrl = present(raw.SOURCE_CODE_URL);
  if (sourceCodeUrl === undefined) {
    throw new BootstrapConfigError(
      'SOURCE_CODE_URL_MISSING',
      [FORM_B_ENV_VARS.sourceCodeUrl],
      '§3.1：「**必填**；未配置不能标部署成功；不自动指向与fork不符的上游」。' +
        '刻意不兜底成仓库的 origin —— 那正是「自动指向与 fork 不符的上游」。',
    );
  }
  if (!/^https:\/\/./i.test(sourceCodeUrl)) {
    throw new BootstrapConfigError(
      'SOURCE_CODE_URL_MISSING',
      [FORM_B_ENV_VARS.sourceCodeUrl],
      '该变量必须是 https 地址：AGPL-3.0 的源码获取途径要对使用者真的可达。',
    );
  }

  const commitSha = present(raw.VERCEL_GIT_COMMIT_SHA);
  if (platformEnv === 'production' && commitSha === undefined) {
    throw new BootstrapConfigError(
      'BUILD_IDENTITY_MISSING',
      [FORM_B_ENV_VARS.commitSha],
      '§3.1 `GIT_COMMIT`：「Build自动；缺失release失败；**运行不能伪造commit**」。' +
        '生产环境拿不到真实提交号就拒绝启动，绝不静默写成 "unknown" —— ' +
        '与 apps/web 的 build-info.ts 失败关闭是同一条原则。',
    );
  }

  return {
    deployment: FORM_B,
    platformEnv,
    runtimeUrlVariable,
    poolMax: raw.DB_POOL_MAX,
    sourceCodeUrl,
    commitSha,
    masterKeyVariable: MASTER_KEY_ENV_VAR,
  };
}

/**
 * 两个候选名字都认；都给了就必须相等，否则 `DATABASE_URL_AMBIGUOUS`。
 *
 * 「相等」比的是**原样字符串**（`Object.is`），不是解析后的等价性：两段语义相同但写法
 * 不同的连接串仍然是两个人各配了一次的证据，而本文件不打算替他们猜哪个是最新的。
 */
function resolveRuntimeUrlVariable(raw: RawFormBEnv): RuntimeUrlVariable {
  const databaseUrl = optionalConnection(raw.DATABASE_URL);
  const littleqDatabaseUrl = optionalConnection(raw.LITTLEQ_DATABASE_URL);
  if (databaseUrl !== undefined && littleqDatabaseUrl !== undefined) {
    if (!Object.is(databaseUrl, littleqDatabaseUrl)) {
      throw new BootstrapConfigError(
        'DATABASE_URL_AMBIGUOUS',
        [FORM_B_ENV_VARS.databaseUrl, FORM_B_ENV_VARS.littleqDatabaseUrl],
        '两个变量都设了，而且值不一样。不挑一个：挑错了不会报错，只会让运行连接打到另一台库上。' +
          '请把两者改成同一个值，或只留一个（命名冲突的裁定见本单交付说明）。',
      );
    }
    return FORM_B_ENV_VARS.databaseUrl;
  }
  if (databaseUrl !== undefined) return FORM_B_ENV_VARS.databaseUrl;
  if (littleqDatabaseUrl !== undefined) return FORM_B_ENV_VARS.littleqDatabaseUrl;
  throw new BootstrapConfigError(
    'DATABASE_URL_MISSING',
    [FORM_B_ENV_VARS.databaseUrl, FORM_B_ENV_VARS.littleqDatabaseUrl],
    '§3.1：运行连接串「postgres必需…**不存在ready失败**」。两个候选名字一个都没给。',
  );
}

/**
 * 取运行连接串（Neon **pooled**）。返回的是 `source` 里那个字符串**本体**，未做任何加工。
 *
 * 刻意**不**在这里正向要求主机名含 `-pooler`：本地开发与非 Neon 的外部 PG 都没有那个标记，
 * 正向要求会把「本地能起」变成不可能。负向守卫放在 {@link migrationConnectionOf} 上
 * （迁移串含 `-pooler` 即拒），那才是 §5.4 真正要防的搞反方向。
 */
export function runtimeConnectionOf(
  source: EnvSource,
  config: FormBConfig,
): SqlConnectionRef<RuntimeUrlVariable> {
  const connectionString = optionalConnection(source[config.runtimeUrlVariable]);
  if (connectionString === undefined) {
    throw new BootstrapConfigError(
      'DATABASE_URL_MISSING',
      [config.runtimeUrlVariable],
      '解析阶段判定该变量存在，取值时却读不到 —— 说明两次读取之间环境变量被改过。',
    );
  }
  assertNoSurroundingWhitespace(connectionString, config.runtimeUrlVariable);
  return { variableName: config.runtimeUrlVariable, connectionString };
}

/**
 * 取迁移连接串（Neon **direct**）。只给 `bootstrap/migrate.ts` 用，运行装配不碰它 ——
 * §3.1 逐字：「`DATABASE_DIRECT_URL`…运行服务无需；**禁止pool代替**」，
 * §5.4 逐字：「`DATABASE_DIRECT_URL`不部署给日常Functions」。
 *
 * 返回类型刻意比 {@link SqlConnectionRef} 窄：变量名是字面量 `'DATABASE_DIRECT_URL'`
 * 而不是 `string`。这样"迁移读的是哪一个变量"就成了编译期事实，交付说明里那一句
 * 不可能与代码悄悄分叉。
 */
export function migrationConnectionOf(
  source: EnvSource,
): SqlConnectionRef<typeof FORM_B_MIGRATION_URL_ENV_VAR> {
  const raw = parseRawEnv(source);
  const connectionString = optionalConnection(raw.DATABASE_DIRECT_URL);
  if (connectionString === undefined) {
    throw new BootstrapConfigError(
      'MIGRATION_URL_MISSING',
      [FORM_B_ENV_VARS.databaseDirectUrl],
      '§3.1：该变量「migrator必需」。迁移只走 direct 连接，不接受用运行串代替。',
    );
  }
  // 顺序要紧：先查空白（`new URL` 对首尾空白会直接抛，那样报出来的就是
  // 「解析不出主机名」而不是真正的原因）。除这一条守卫之外**一个字符都不改**，
  // `sslmode` / `channel_binding=require` 之类一律原样保留（§2.1 `sources.ts` 的红线）。
  assertNoSurroundingWhitespace(connectionString, FORM_B_ENV_VARS.databaseDirectUrl);
  assertNotPooled(connectionString, FORM_B_ENV_VARS.databaseDirectUrl);
  return { variableName: FORM_B_ENV_VARS.databaseDirectUrl, connectionString };
}

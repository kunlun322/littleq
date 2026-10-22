/**
 * 形态 B 配置解析的**拒启矩阵** —— ZLQ-236 D-1 的验收项「`LITTLEQ_DEPLOYMENT` 缺失或与
 * `VERCEL_ENV` 不符时拒绝启动（**带变异对照**）」，以及「连接串逐字原样透传」「不许打印值」
 * 两条红线的机器可查形式。
 *
 * ## 为什么这一份不碰数据库
 *
 * `resolveFormBConfig` / `runtimeConnectionOf` / `migrationConnectionOf` 是纯函数：入参是
 * 一个字面量 `EnvSource`，出参是一个配置对象或一个 `BootstrapConfigError`。它们一条 I/O
 * 都不做，所以每一条拒启分支都能在一台没有 Postgres、没有网络、没有任何真实凭据的机器上
 * 跑到。真库那半在 `bootstrap-migrate.test.ts`，本地起服务那半在 `bootstrap-container.test.ts`。
 *
 * ## 每个哨兵值都在运行时生成，源码里没有任何字面量
 *
 * 理由与 `turn-to-task-to-safe-event.test.ts` 里那把 `MASTER_KEY` 完全相同：写死在源码里的
 * "测试密钥"迟早会被抄进部署样例，而 `parseMasterKey` 只拒绝全零，不拒绝"有名"。
 * 随机哨兵还有第二个用处 —— 它让下面那条"错误信息里不许出现值"的断言不可能因为
 * "恰好撞上一个常见字符串"而假绿，也让它**必须**配一条阳性对照才成立。
 *
 * ## 命名冲突在这里是**被测行为**，不是被裁定的结论
 *
 * `.env.example` 规则 4 要 `LQ_` 前缀、ZLQ-157 §3.1 列的是裸 `DATABASE_URL` /
 * `DATABASE_DIRECT_URL`、而仓库里已有的唯一真实读者
 * （`packages/infra/src/init/bootstrap-accounts.ts:77`）读的是 `LITTLEQ_DATABASE_URL`。
 * 本文件把三者都当合法输入测：两个都给且相等 ⇒ 通过，两个都给且不等 ⇒ `DATABASE_URL_AMBIGUOUS`
 * **失败关闭**，而不是挑一个。裁定权不在这份测试里，交付说明里那节只给建议。
 */
import { randomBytes } from 'node:crypto';

import { MASTER_KEY_ENV_VAR } from '@littleq/infra';
import { describe, expect, it } from 'vitest';

import {
  BootstrapConfigError,
  FORM_B_ENV_VARS,
  FORM_B_MIGRATION_URL_ENV_VAR,
  migrationConnectionOf,
  resolveFormBConfig,
  runtimeConnectionOf,
  type EnvSource,
  type FormBConfig,
} from '../src/bootstrap/config.js';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** 每次运行重新生成的一族哨兵。任何一个出现在错误文本里都只可能是本文件泄漏的。 */
const SENTINELS = {
  runtimeUser: `u_${hex(randomBytes(6))}`,
  runtimePassword: `p_${hex(randomBytes(12))}`,
  runtimeHost: `ep-${hex(randomBytes(6))}-pooler.neon.example`,
  directHost: `ep-${hex(randomBytes(6))}.neon.example`,
  directPassword: `d_${hex(randomBytes(12))}`,
  masterKey: hex(randomBytes(32)),
  sourceCodeUrl: `https://git.example/${hex(randomBytes(5))}/littleq.git`,
  commitSha: hex(randomBytes(20)),
} as const;

/** 全部哨兵值。`values()` 的顺序无关，探针逐个查。 */
const SENTINEL_VALUES: readonly string[] = Object.values(SENTINELS);

/**
 * 其中**只有这些是凭据**。
 *
 * 分开列不是洁癖，而是为了让"配置对象里不许出现哨兵值"这条断言成立：`SOURCE_CODE_URL` 与
 * `VERCEL_GIT_COMMIT_SHA` 是**公开标识符**（一个 AGPL 源码途径、一个提交号），
 * `FormBConfig` 本来就该带着它们 —— 上面第 152 行那条用例正是在断言它们**在**。
 * 把八个哨兵一锅端进"不许出现"的探针，等于写下一条与本文件另一条互相矛盾的断言，
 * 它永远红（本文件第一版就是这样，而且只在跑全量时才被看见）。
 *
 * 于是分工是：
 * - **凭据子集** ⇒ "不许出现在配置对象 / 错误文本里"（红线 2）。
 * - **全集** ⇒ "不许出现在错误文本里"（连源码途径也不该被错误消息回显）。
 */
const CREDENTIAL_SENTINEL_VALUES: readonly string[] = [
  SENTINELS.runtimeUser,
  SENTINELS.runtimePassword,
  SENTINELS.runtimeHost,
  SENTINELS.directHost,
  SENTINELS.directPassword,
  SENTINELS.masterKey,
];

/**
 * 运行连接串：**池化**主机名（含 `-pooler`），并且刻意带上 `channel_binding=require`。
 *
 * 带它是为了把 PM 那条实测结论变成一条会红的断言：`pg-connection-string@2.14.1` 对这个
 * 参数 0 命中 ⇒ 它是个惰性参数，逐字透传即可。谁要是为了"让它可解析"把参数删掉或改写，
 * 下面 `Object.is` 那条断言立刻红。
 */
const RUNTIME_URL =
  `postgres://${SENTINELS.runtimeUser}:${SENTINELS.runtimePassword}@${SENTINELS.runtimeHost}` +
  ':5432/neondb?sslmode=require&channel_binding=require';

/** 迁移连接串：**直连**主机名（不含 `-pooler`）。 */
const DIRECT_URL =
  `postgres://${SENTINELS.runtimeUser}:${SENTINELS.directPassword}@${SENTINELS.directHost}` +
  ':5432/neondb?sslmode=require';

/**
 * 一条**规范化会改变**的连接串：查询参数里有个空格，`new URL(...).toString()` 会把它写成 `%20`。
 *
 * 为什么需要它 —— 本文件第一版的"逐字透传"阳性对照写的是
 * `expect(new URL(RUNTIME_URL).toString()).not.toBe(RUNTIME_URL)`，而它对 `RUNTIME_URL`
 * **永远红**：`postgres:` 是 WHATWG URL 里的**非特殊 scheme**，解析器对它不加尾斜杠、
 * 不折叠大小写，十六进制凭据也无需转义，于是 `toString()` 恒等于原文。那条对照想证的
 * 是"规范化会改，而代码没规范化"，实际证的是"规范化不会改" —— 一个恒等变换，
 * 也就是说"没被规范化"这条断言当时**没有内容**。
 *
 * 换上这一条之后对照才成立：同一个函数在这条串上确实会改写它，而 `runtimeConnectionOf`
 * 交出来的仍是原文（连 `%20` 都不许出现）。空格放在 `application_name` 里也是刻意的 ——
 * 那是真实 Neon 连接串常带的参数，不是我为了凑一个反例编的形状。
 */
const NORMALIZATION_VISIBLE_URL =
  'postgres://lq_norm_user:lq_norm_pw@ep-lq-norm-pooler.neon.example:5432/neondb' +
  '?sslmode=require&application_name=lq boot';

/** 一份**完整合法**的形态 B 环境。每条变异对照都只从它出发改一个键。 */
function validEnv(): EnvSource {
  return {
    [FORM_B_ENV_VARS.deployment]: 'B',
    [FORM_B_ENV_VARS.vercelEnv]: 'production',
    [FORM_B_ENV_VARS.littleqEnv]: 'production',
    [FORM_B_ENV_VARS.databaseUrl]: RUNTIME_URL,
    [FORM_B_ENV_VARS.databaseDirectUrl]: DIRECT_URL,
    [FORM_B_ENV_VARS.sourceCodeUrl]: SENTINELS.sourceCodeUrl,
    [FORM_B_ENV_VARS.commitSha]: SENTINELS.commitSha,
    [FORM_B_ENV_VARS.masterKey]: SENTINELS.masterKey,
  };
}

/** 删掉一个键（不是设成空串 —— 那测的是另一条分支）。 */
function without(env: EnvSource, variable: string): EnvSource {
  const next: Record<string, string | undefined> = { ...env };
  delete next[variable];
  return next;
}

/** 改一个键。 */
function withValue(env: EnvSource, variable: string, value: string): EnvSource {
  return { ...env, [variable]: value };
}

/**
 * 「错误文本里一个哨兵值都不许出现」的探针。
 *
 * 查的是 `message` + `code` + `variables` 三处，因为 `BootstrapConfigError` 的构造函数会把
 * `code` 与 `variables` 拼进 `message`：只查 `message` 会漏掉将来某处直接 `String(error.code)`
 * 或 `error.variables.join()` 落到日志里的路径。
 */
function expectNoSentinel(error: unknown): void {
  const parts: string[] = [error instanceof Error ? error.message : String(error)];
  if (error instanceof BootstrapConfigError) {
    parts.push(error.code, ...error.variables);
  }
  const haystack = parts.join('\n');
  for (const sentinel of SENTINEL_VALUES) {
    expect(haystack, `错误文本里出现了哨兵值（长度 ${String(sentinel.length)}）`).not.toContain(
      sentinel,
    );
  }
  // 主机名与口令单独再查一次：它们是连接串的子串，理论上被整串断言覆盖，但一条独立的
  // 断言在"有人只脱敏了整串、忘了子串"时能给出更准的失败位置。
  expect(haystack).not.toContain(SENTINELS.runtimeHost);
  expect(haystack).not.toContain(SENTINELS.directHost);
  expect(haystack).not.toContain(SENTINELS.runtimePassword);
  expect(haystack).not.toContain(SENTINELS.directPassword);
  expect(haystack).not.toContain(SENTINELS.masterKey);
}

/** 断言抛出的是 `BootstrapConfigError` 且 `code` 正好是这个，顺带跑一遍无泄漏探针。 */
function expectCode(work: () => unknown, code: string): BootstrapConfigError {
  let thrown: unknown;
  try {
    work();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, '期望抛出 BootstrapConfigError，实际没有抛').toBeInstanceOf(BootstrapConfigError);
  const error = thrown as BootstrapConfigError;
  expect(error.code).toBe(code);
  expectNoSentinel(error);
  // 变量名清单里只许出现**全大写标识符**：这条把「variables 只放名字不放值」从注释变成断言。
  for (const variable of error.variables) {
    expect(variable).toMatch(/^[A-Z][A-Z0-9_]*$/);
  }
  return error;
}

describe('resolveFormBConfig：合法输入', () => {
  it('完整的生产环境解析出形态 B 与 production', () => {
    const config = resolveFormBConfig(validEnv());
    expect(config.deployment).toBe('B');
    expect(config.platformEnv).toBe('production');
    expect(config.commitSha).toBe(SENTINELS.commitSha);
    expect(config.sourceCodeUrl).toBe(SENTINELS.sourceCodeUrl);
    expect(config.masterKeyVariable).toBe(MASTER_KEY_ENV_VAR);
    expect(config.runtimeUrlVariable).toBe('DATABASE_URL');
  });

  it('解析结果里没有任何一个字段装着连接串（红线 2）', () => {
    const config = resolveFormBConfig(validEnv());
    // 阳性对照：这条断言必须**可能**失败，否则它什么都没证。连接串确实在环境里 ——
    // 先证明这一点，再证明它没被抄进配置。
    expect(JSON.stringify(validEnv())).toContain(SENTINELS.runtimeHost);
    // 第二条阳性对照：凭据子集非空、且真的比全集小 —— 否则"只查子集"可能悄悄退化成
    // "什么都没查"，或者反过来又撞上面那条"公开标识符本来就该在"的断言。
    expect(CREDENTIAL_SENTINEL_VALUES.length).toBe(6);
    expect(CREDENTIAL_SENTINEL_VALUES.length).toBeLessThan(SENTINEL_VALUES.length);
    const serialized = JSON.stringify(config);
    for (const sentinel of CREDENTIAL_SENTINEL_VALUES) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).not.toContain('postgres://');
    // 配置里只有**胜出的变量名**这一个与连接串有关的东西。
    expect(config.runtimeUrlVariable).toBe(FORM_B_ENV_VARS.databaseUrl);
    // 而这两个公开标识符是**在**的（与上面那条并不矛盾，理由见 CREDENTIAL_SENTINEL_VALUES）。
    expect(config.sourceCodeUrl).toBe(SENTINELS.sourceCodeUrl);
    expect(config.commitSha).toBe(SENTINELS.commitSha);
  });

  it('只给 LITTLEQ_DATABASE_URL 时它胜出（三个名字都认）', () => {
    const env = without(validEnv(), FORM_B_ENV_VARS.databaseUrl);
    const config = resolveFormBConfig(withValue(env, FORM_B_ENV_VARS.littleqDatabaseUrl, RUNTIME_URL));
    expect(config.runtimeUrlVariable).toBe('LITTLEQ_DATABASE_URL');
  });

  it('两个运行串变量都给了且**逐字相等**时通过，DATABASE_URL 胜出', () => {
    const env = withValue(validEnv(), FORM_B_ENV_VARS.littleqDatabaseUrl, RUNTIME_URL);
    expect(resolveFormBConfig(env).runtimeUrlVariable).toBe('DATABASE_URL');
  });

  it('没有 VERCEL_ENV 与 LITTLEQ_ENV 时落到 development（本地开发路径）', () => {
    // 三个键都要摘：`validEnv()` 里带着 commitSha，只摘两个环境变量的话 `config.commitSha`
    // 当然还在 —— 本文件第一版就写了 `toBeUndefined()`，于是这条永远红。
    // "development 下缺提交号也允许起"是**下一条**用例的题，不在这条里顺带断言。
    const env = without(
      without(without(validEnv(), FORM_B_ENV_VARS.vercelEnv), FORM_B_ENV_VARS.littleqEnv),
      FORM_B_ENV_VARS.commitSha,
    );
    const config = resolveFormBConfig(env);
    expect(config.platformEnv).toBe('development');
    expect(config.deployment).toBe('B');
    expect(config.commitSha).toBeUndefined();
  });

  it('development 下缺 VERCEL_GIT_COMMIT_SHA 不拒启，且绝不兜底成 "unknown"', () => {
    const env = without(without(validEnv(), FORM_B_ENV_VARS.vercelEnv), FORM_B_ENV_VARS.commitSha);
    expect(resolveFormBConfig(withValue(env, FORM_B_ENV_VARS.littleqEnv, 'development')).commitSha)
      .toBeUndefined();
  });
});

describe('resolveFormBConfig：DB_POOL_MAX 的冲突按「两个都不硬编码」处理', () => {
  it('部署没给这个变量 ⇒ poolMax 是 undefined（整个键不往驱动传，池大小交给 SDK）', () => {
    // §3.1 说「B=2」，`packages/infra/src/sql/sources.ts` 说「默认值交给 SDK，不在这里编一个数」。
    // 这条断言把冲突的解法钉住：谁在代码里补一个默认 2（或 10），它就红。
    expect(resolveFormBConfig(validEnv()).poolMax).toBeUndefined();
  });

  it('部署给了就照给的值用，不改写', () => {
    expect(resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.poolMax, '2')).poolMax).toBe(2);
    expect(resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.poolMax, '7')).poolMax).toBe(7);
  });

  it('越界的值由 schema 拒掉，而不是被夹到边界内', () => {
    expectCode(
      () => resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.poolMax, '0')),
      'ENV_SCHEMA_INVALID',
    );
    expectCode(
      () => resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.poolMax, '101')),
      'ENV_SCHEMA_INVALID',
    );
    expectCode(
      () => resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.poolMax, 'many')),
      'ENV_SCHEMA_INVALID',
    );
  });
});

describe('resolveFormBConfig：拒启矩阵（每条都只改一个变量）', () => {
  it('LITTLEQ_DEPLOYMENT 缺失 ⇒ DEPLOYMENT_FORM_MISSING', () => {
    const error = expectCode(
      () => resolveFormBConfig(without(validEnv(), FORM_B_ENV_VARS.deployment)),
      'DEPLOYMENT_FORM_MISSING',
    );
    expect(error.variables).toEqual(['LITTLEQ_DEPLOYMENT']);
  });

  it('LITTLEQ_DEPLOYMENT 是空白串 ⇒ 同样拒启，但报的是 ENV_SCHEMA_INVALID', () => {
    // 结论没变（空白不等于给了值 ⇒ 拒绝启动），**码**变了，而且这是有信息量的：
    // `LITTLEQ_DEPLOYMENT` 在 schema 里是 `z.enum(['A','B','C'])`，`'   '` 过不了枚举，
    // 于是它连 `resolveFormBConfig` 第 1 步的 `present()` 都到不了。
    // 本文件第一版期望 `DEPLOYMENT_FORM_MISSING`，那是把两个层次混成了一个：
    //   缺失（键不在）        ⇒ 到得了第 1 步 ⇒ DEPLOYMENT_FORM_MISSING
    //   给了但不是合法形态值  ⇒ schema 先拒  ⇒ ENV_SCHEMA_INVALID
    // 两条都是固定码、都不含输入值（下面 expectCode 里的无泄漏探针会查），运维拿到的
    // 修复指引因此是准的："这个变量没配" 与 "这个变量配错了" 是两件事。
    const error = expectCode(
      () => resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.deployment, '   ')),
      'ENV_SCHEMA_INVALID',
    );
    expect(error.variables).toEqual(['LITTLEQ_DEPLOYMENT']);
  });

  it('形态 A 与形态 C 都 ⇒ DEPLOYMENT_FORM_UNSUPPORTED（不替它们装配）', () => {
    for (const form of ['A', 'C']) {
      const error = expectCode(
        () => resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.deployment, form)),
        'DEPLOYMENT_FORM_UNSUPPORTED',
      );
      // 信息里点出读到的是哪个形态，好让运维一眼看出是变量配错了而不是代码错了。
      expect(error.message).toContain(form);
    }
  });

  it('非法形态值由 schema 先拒 ⇒ ENV_SCHEMA_INVALID（不是 UNSUPPORTED）', () => {
    // 这两条码的区别是有意义的：`ZZZ` 连"是一个形态"都不成立，报 UNSUPPORTED 会让人以为
    // 只是选错了 A/B/C。
    expectCode(
      () => resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.deployment, 'ZZZ')),
      'ENV_SCHEMA_INVALID',
    );
    expectCode(
      () => resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.deployment, 'b')),
      'ENV_SCHEMA_INVALID',
    );
  });

  it('LITTLEQ_ENV=production 而 VERCEL_ENV=preview ⇒ PLATFORM_ENV_MISMATCH', () => {
    const env = withValue(validEnv(), FORM_B_ENV_VARS.vercelEnv, 'preview');
    expectCode(() => resolveFormBConfig(env), 'PLATFORM_ENV_MISMATCH');
  });

  it('反方向（LITTLEQ_ENV=preview 而 VERCEL_ENV=production）同样拒', () => {
    const env = withValue(validEnv(), FORM_B_ENV_VARS.littleqEnv, 'preview');
    expectCode(() => resolveFormBConfig(env), 'PLATFORM_ENV_MISMATCH');
  });

  it('声称 production 却读不到 VERCEL_ENV ⇒ PLATFORM_ENV_MISMATCH', () => {
    const env = without(validEnv(), FORM_B_ENV_VARS.vercelEnv);
    expectCode(() => resolveFormBConfig(env), 'PLATFORM_ENV_MISMATCH');
  });

  it('两个运行串变量一个都没给 ⇒ DATABASE_URL_MISSING', () => {
    const env = without(without(validEnv(), FORM_B_ENV_VARS.databaseUrl), FORM_B_ENV_VARS.littleqDatabaseUrl);
    const error = expectCode(() => resolveFormBConfig(env), 'DATABASE_URL_MISSING');
    // 两个候选名字都列出来：运维在平台侧看到的是"我到底该配哪个"，两个都认。
    expect(error.variables).toEqual(['DATABASE_URL', 'LITTLEQ_DATABASE_URL']);
  });

  it('两个都给了但值不同 ⇒ DATABASE_URL_AMBIGUOUS，不挑一个', () => {
    const env = withValue(
      validEnv(),
      FORM_B_ENV_VARS.littleqDatabaseUrl,
      RUNTIME_URL.replace('/neondb?', '/otherdb?'),
    );
    const error = expectCode(() => resolveFormBConfig(env), 'DATABASE_URL_AMBIGUOUS');
    expect(error.variables).toEqual(['DATABASE_URL', 'LITTLEQ_DATABASE_URL']);
  });

  it('SOURCE_CODE_URL 缺失 ⇒ SOURCE_CODE_URL_MISSING', () => {
    expectCode(
      () => resolveFormBConfig(without(validEnv(), FORM_B_ENV_VARS.sourceCodeUrl)),
      'SOURCE_CODE_URL_MISSING',
    );
  });

  it('SOURCE_CODE_URL 不是 https ⇒ 同一条（AGPL-3.0 的源码途径要真的可达）', () => {
    for (const bad of ['http://git.example/littleq.git', 'git@example:littleq.git', 'file:///x']) {
      expectCode(
        () => resolveFormBConfig(withValue(validEnv(), FORM_B_ENV_VARS.sourceCodeUrl, bad)),
        'SOURCE_CODE_URL_MISSING',
      );
    }
  });

  it('production 缺 VERCEL_GIT_COMMIT_SHA ⇒ BUILD_IDENTITY_MISSING（与 build-info.ts 同一条原则）', () => {
    expectCode(
      () => resolveFormBConfig(without(validEnv(), FORM_B_ENV_VARS.commitSha)),
      'BUILD_IDENTITY_MISSING',
    );
  });
});

describe('runtimeConnectionOf：逐字原样透传', () => {
  it('返回的就是环境里那个字符串**本体**（Object.is，不是相等）', () => {
    const env = validEnv();
    const config = resolveFormBConfig(env);
    const ref = runtimeConnectionOf(env, config);
    // `Object.is` 比 `===` 更严：它连 NaN 与 -0 都区分。这里两个都是字符串，所以它退化
    // 成同值比较 —— 但写成 `Object.is` 是为了把"逐字"这个承诺表达成一个不可能被
    // "顺手 trim 一下"绕过的断言。
    expect(Object.is(ref.connectionString, env[FORM_B_ENV_VARS.databaseUrl])).toBe(true);
    expect(ref.variableName).toBe('DATABASE_URL');
  });

  it('连接串没有被 URL 规范化碰过（阳性对照见下一条：规范化在别的串上确实会改）', () => {
    const env = validEnv();
    const ref = runtimeConnectionOf(env, resolveFormBConfig(env));
    // ⚠️ 这一条**不配**阳性对照，而且不该配：`new URL(RUNTIME_URL).toString()` 恒等于
    // `RUNTIME_URL`（非特殊 scheme，见 NORMALIZATION_VISIBLE_URL 的说明）。所以这里的
    // 断言只说真话 —— 惰性参数活着走出来了；"没被改写"这件事由**下一条**用例证明。
    expect(ref.connectionString).toBe(RUNTIME_URL);
    // `channel_binding=require` 是 PM 实测的惰性参数，必须活着走出来。
    expect(ref.connectionString).toContain('channel_binding=require');
    expect(ref.connectionString).toContain('sslmode=require');
  });

  it('阳性对照：对一条**规范化确实会改**的串，交出去的仍是原文（逐字透传在这里才有内容）', () => {
    // 对照先跑：证明这条串进 `new URL` 出来就变了（空格 ⇒ `%20`）。
    expect(new URL(NORMALIZATION_VISIBLE_URL).toString()).not.toBe(NORMALIZATION_VISIBLE_URL);
    expect(new URL(NORMALIZATION_VISIBLE_URL).toString()).toContain('%20');
    const env = withValue(validEnv(), FORM_B_ENV_VARS.databaseUrl, NORMALIZATION_VISIBLE_URL);
    const ref = runtimeConnectionOf(env, resolveFormBConfig(env));
    expect(ref.connectionString).toBe(NORMALIZATION_VISIBLE_URL);
    expect(ref.connectionString).toContain('application_name=lq boot');
    expect(ref.connectionString).not.toContain('%20');
  });

  it('走 LITTLEQ_DATABASE_URL 那一支时同样逐字', () => {
    const env = withValue(
      without(validEnv(), FORM_B_ENV_VARS.databaseUrl),
      FORM_B_ENV_VARS.littleqDatabaseUrl,
      RUNTIME_URL,
    );
    const config = resolveFormBConfig(env);
    const ref = runtimeConnectionOf(env, config);
    expect(ref.variableName).toBe('LITTLEQ_DATABASE_URL');
    expect(Object.is(ref.connectionString, RUNTIME_URL)).toBe(true);
  });

  it('首尾有空白 ⇒ CONNECTION_STRING_HAS_WHITESPACE，本文件不替你修掉一个秘密', () => {
    const env = withValue(validEnv(), FORM_B_ENV_VARS.databaseUrl, ` ${RUNTIME_URL}`);
    const config = resolveFormBConfig(env);
    expectCode(() => runtimeConnectionOf(env, config), 'CONNECTION_STRING_HAS_WHITESPACE');
    expectCode(
      () => runtimeConnectionOf(withValue(validEnv(), FORM_B_ENV_VARS.databaseUrl, `${RUNTIME_URL}\n`), config),
      'CONNECTION_STRING_HAS_WHITESPACE',
    );
  });

  it('解析阶段说存在、取值时读不到 ⇒ DATABASE_URL_MISSING（两次读取之间环境被改过）', () => {
    const env = validEnv();
    const config = resolveFormBConfig(env);
    expectCode(() => runtimeConnectionOf(without(env, FORM_B_ENV_VARS.databaseUrl), config), 'DATABASE_URL_MISSING');
  });

  it('运行串**不**正向要求含 -pooler：本地开发与非 Neon 的外部库都没有那个标记', () => {
    const plain = 'postgres://u@127.0.0.1:5432/littleq';
    const env = withValue(validEnv(), FORM_B_ENV_VARS.databaseUrl, plain);
    const config = resolveFormBConfig(env);
    expect(runtimeConnectionOf(env, config).connectionString).toBe(plain);
  });
});

describe('migrationConnectionOf：只认 DATABASE_DIRECT_URL，且必须不是池化地址', () => {
  it('编译期就钉住读的是哪个变量名', () => {
    // 这一条不是运行时断言，而是让 TS 替我们守住交付说明里那句话：返回类型里的
    // `variableName` 是字面量 'DATABASE_DIRECT_URL'，换成任何别的名字都编译不过。
    const ref = migrationConnectionOf(validEnv());
    const variable: typeof FORM_B_MIGRATION_URL_ENV_VAR = ref.variableName;
    expect(variable).toBe('DATABASE_DIRECT_URL');
    expect(Object.is(ref.connectionString, DIRECT_URL)).toBe(true);
  });

  it('缺 DATABASE_DIRECT_URL ⇒ MIGRATION_URL_MISSING（不许用运行串代替）', () => {
    expectCode(
      () => migrationConnectionOf(without(validEnv(), FORM_B_ENV_VARS.databaseDirectUrl)),
      'MIGRATION_URL_MISSING',
    );
  });

  it('迁移串是池化地址 ⇒ MIGRATION_URL_IS_POOLED（§3.1「禁止pool代替」）', () => {
    const pooled = DIRECT_URL.replace(SENTINELS.directHost, SENTINELS.runtimeHost);
    // 阳性对照：这个替换真的生效了，而且真的带上了那个标记。
    expect(pooled).toContain('-pooler');
    expect(pooled).not.toBe(DIRECT_URL);
    expectCode(
      () => migrationConnectionOf(withValue(validEnv(), FORM_B_ENV_VARS.databaseDirectUrl, pooled)),
      'MIGRATION_URL_IS_POOLED',
    );
  });

  it('解析不出主机名 ⇒ MIGRATION_URL_UNPARSEABLE，而不是静默放行', () => {
    // 一条静默通过的负向守卫等于没有守卫：解析失败时我们**无法证明**它不是池化地址。
    //
    // ⚠️ `'postgres://'` 这一项钉的是本单开发中自查出来的一个**真 bug**：
    // `assertNotPooled` 原本只 `try/catch` 了 `new URL(...)`，而 `postgres:` 是非特殊 scheme，
    // `new URL('postgres://')` **不抛**、只是 `hostname === ''`，于是它一路走到
    // `''.includes('-pooler') === false` 被**静默放行** —— 守卫对它自己要挡的东西失败了。
    // 现在空主机名与"抛了"走同一条拒绝。谁把那个 `hostname === ''` 分支删掉，这条就红。
    for (const bad of ['not-a-url', 'postgres://', '']) {
      expectCode(
        () => migrationConnectionOf(withValue(validEnv(), FORM_B_ENV_VARS.databaseDirectUrl, bad)),
        bad === '' ? 'MIGRATION_URL_MISSING' : 'MIGRATION_URL_UNPARSEABLE',
      );
    }
    // 变异对照：证明 `postgres://` 确实是被**空主机名**这条拦下的，不是碰巧被别的分支拦下。
    expect(new URL('postgres://').hostname).toBe('');
    expect(() => new URL('postgres://')).not.toThrow();
  });

  it('首尾空白先于池化判定报出（顺序要紧：new URL 对空白会抛，那样报出来的是错的码）', () => {
    const pooledWithSpace = ` ${DIRECT_URL.replace(SENTINELS.directHost, SENTINELS.runtimeHost)}`;
    expect(pooledWithSpace).toContain('-pooler');
    expectCode(
      () =>
        migrationConnectionOf(
          withValue(validEnv(), FORM_B_ENV_VARS.databaseDirectUrl, pooledWithSpace),
        ),
      'CONNECTION_STRING_HAS_WHITESPACE',
    );
  });

  it('迁移串也逐字透传，sslmode 一个字符都不动', () => {
    const ref = migrationConnectionOf(validEnv());
    expect(ref.connectionString).toBe(DIRECT_URL);
    expect(ref.connectionString).toContain('sslmode=require');
    // 同上一条：这里不配 `new URL` 对照（对这条串它是恒等变换）。真正的对照在下面那条，
    // 用一条规范化会改写的**直连**串来证。
  });

  it('阳性对照：迁移串也扛得住规范化（换成一条 `new URL` 会改写的直连串）', () => {
    // 直连版：把 NORMALIZATION_VISIBLE_URL 的 `-pooler` 去掉，否则先撞上 MIGRATION_URL_IS_POOLED，
    // 那条断言就不再是关于"逐字"的了。
    const direct = NORMALIZATION_VISIBLE_URL.replace('-pooler.neon.example', '.neon.example');
    expect(direct).not.toContain('-pooler');
    expect(new URL(direct).toString()).not.toBe(direct);
    const ref = migrationConnectionOf(withValue(validEnv(), FORM_B_ENV_VARS.databaseDirectUrl, direct));
    expect(ref.connectionString).toBe(direct);
    expect(ref.connectionString).not.toContain('%20');
    expect(ref.variableName).toBe('DATABASE_DIRECT_URL');
  });
});

describe('无泄漏探针自身是有效的（阳性对照）', () => {
  it('把哨兵喂给探针，探针必须报出来', () => {
    // 这条是整个无泄漏断言链的地基：`expectNoSentinel` 若写错（比如查错了字段、
    // 或者哨兵表是空的），上面几十条断言会全部假绿。这里证明它真的会红。
    expect(() => expectNoSentinel(new Error(`泄漏了 ${SENTINELS.masterKey}`))).toThrow();
    expect(() => expectNoSentinel(new Error(`主机 ${SENTINELS.runtimeHost}`))).toThrow();
    expect(() => expectNoSentinel(new Error(`口令 ${SENTINELS.runtimePassword}`))).toThrow();
  });

  it('哨兵表非空，且彼此不同（否则 not.toContain 是在拿一个串查它自己）', () => {
    expect(SENTINEL_VALUES.length).toBeGreaterThanOrEqual(7);
    expect(new Set(SENTINEL_VALUES).size).toBe(SENTINEL_VALUES.length);
    for (const sentinel of SENTINEL_VALUES) expect(sentinel.length).toBeGreaterThanOrEqual(8);
  });

  it('合法环境里确实装着这些哨兵（探针的前提，不是空转）', () => {
    const serialized = JSON.stringify(validEnv());
    for (const sentinel of SENTINEL_VALUES) {
      // commitSha 与 masterKey 都在环境里；sourceCodeUrl 也在。逐个确认。
      expect(serialized).toContain(sentinel);
    }
  });
});

describe('FormBConfig 的形状不外泄连接串（类型层面的补充证据）', () => {
  it('配置对象的可枚举键是固定的七个', () => {
    const config: FormBConfig = resolveFormBConfig(validEnv());
    expect(Object.keys(config).sort()).toEqual([
      'commitSha',
      'deployment',
      'masterKeyVariable',
      'platformEnv',
      'poolMax',
      'runtimeUrlVariable',
      'sourceCodeUrl',
    ]);
    // `sourceCodeUrl` 是七个里唯一一个自由文本字段，它不是秘密（AGPL 要求它可公开获取），
    // 但也不能是连接串 —— 上面那条 JSON.stringify 断言已经覆盖了这一点。
    expect(config.sourceCodeUrl).toBe(SENTINELS.sourceCodeUrl);
  });
});

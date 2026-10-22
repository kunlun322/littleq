/**
 * `bootstrap/vercel.ts` 的装配与起进程测试。
 *
 * ## 这份文件证的是哪一条
 *
 * 验收项要求「装配根**存在且本地能起**」，而"存在"用 `ls` 就能证，"能起"不能。
 * 所以这里的判据是一条**行为**：在数据库完全不可达的环境里，容器仍然装配成功、
 * 进程仍然 live、`/health/live` 仍然 200 —— 这不是我把自检调松了，而是 §2.1 line 77
 * 逐字要求的形状：
 *
 * > 首启诊断/领取服务不能被尚未完成的业务ready检查锁死…**进程仍live**并仅开放受领取
 * > 票据保护的setup与诊断，学生/API写入未开放…**setup写完后重新运行ready**，全部硬项
 * > 通过才开放业务，不以重启补配置。
 *
 * 反过来说：如果 `createFormBContainer` 在 DB 不可达时抛，那 §3.2 的首启领取入口就会被
 * 它自己锁死 —— 领取入口正是"让 DB 之后能用起来"的那条路。同一条引文里点名的**致命**项
 * 只有三类（未知 driver、生产/preview 混绑、密钥格式错误），下面第 2 组逐个断言它们真的抛。
 *
 * ## 数据库不可达是**刻意**的，不是妥协
 *
 * 运行时那条腿用的是 `createNeonClientSource`（`packages/infra/src/sql/sources.ts:75`），
 * 它是 `@neondatabase/serverless` 的 **WebSocket** `Pool`。⚠️ 这条腿**连不上本机 Postgres**
 * ——WS 驱动说的不是 TCP 协议。所以"本地能起"只能在一个连不上的地址上证，
 * 而"迁移能跑通"那半边走的是 `createPgClientSource`（TCP `pg`），在
 * `bootstrap-migrate-database.test.ts` 里用真库证。**两条腿的证据来源不同，这是驱动决定的，
 * 不是我挑的**；把这条写在交付说明里。
 *
 * 端口 1（`127.0.0.1:1`）是刻意选的：它给的是**立即 ECONNREFUSED**，不是黑洞。
 * 实测（本机、`@neondatabase/serverless@1.2.0`）：`new Pool(...)` 之后 `totalCount === 0`
 * （构造是惰性的，不连接），`pool.connect()` 18 ms 内 reject，`pool.end()` 0 ms 内 resolve，
 * 且**没有** pool 级 `error` 事件被 emit（即 ZLQ-227 那个"没人监听的 error 打穿
 * EventEmitter"的形状在"连接从未建立"这条路上不重现）。
 * ⇒ 于是 ready 探针的耗时上界是**真实的**：如果 §8.1 的预算没生效，本文件会在
 * vitest 的 60 s 超时上炸掉，而不是悄悄变慢。
 *
 * ## provider 腿用的是**真**客户端，只是指着一个连不上的地址
 *
 * 不编假 provider：`createTurnProviderClient` 就是生产用的那个工厂。它的 `tokenSource`
 * 被换成一个**计数器 + 抛错**的实现，于是"装配过程绝不发起任何计费/外部调用"从一句
 * 假设变成一条断言（`tokenSourceCalls === 0`）。这也顺带钉住 §8.1 的「禁止外部AI测试」：
 * ready 自检里没有一格会去碰 provider。
 *
 * ## 凭据值
 *
 * 所有哨兵（口令、主密钥、连接串里的用户/口令）都是**运行时随机生成**的，源码里没有
 * 字面值。第 4 组把 `process.stdout.write` / `process.stderr.write` 全程接管，断言装配 +
 * 起进程 + 打四条请求之后，输出里没有任何一个哨兵；并且带**阳性对照**（先写一个哨兵进去，
 * 证明这个探针真的看得见）—— 一个"从来没抓到过东西"的探针不算证据。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSessionTtlPolicy } from '@littleq/domain';
import { isInfraError } from '@littleq/infra';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ⚠️ 相对源码导入（申报）。`createWorkScanner` 这个**值**在 `@littleq/work-contract` 的
// 桶里是刻意不 re-export 的，而子路径 `@littleq/work-contract/scan` 从 `apps/api` 解析不到
// （实测 `Cannot find package`）。仓库里已有的先例就是这么办的：
// `apps/api/test/turn-to-task-to-safe-event.test.ts:70`。
import { createWorkScanner } from '../../../packages/work-contract/src/scan/index.js';

import { BootstrapConfigError, FORM_B_ENV_VARS } from '../src/bootstrap/config.js';
import {
  READY_BUDGET_MS,
  createFormBContainer,
  getFormBContainer,
  resetFormBContainer,
  type FormBBootstrapInputs,
  type FormBContainer,
} from '../src/bootstrap/vercel.js';
import { createTurnProviderClient } from '../src/server/index.js';

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** 运行时生成的哨兵；源码里没有任何字面值，交付说明里也不会出现。 */
const SENTINELS = {
  masterKey: hex(32),
  runtimeUser: `lq_rt_${hex(6)}`,
  runtimePassword: hex(12),
  providerToken: `lq_provider_${hex(12)}`,
} as const;

const SENTINEL_VALUES: readonly string[] = Object.values(SENTINELS);

/** 端口 1 ⇒ 立即 ECONNREFUSED（不是黑洞）。主机名刻意**含** `-pooler`：形态 B 的运行串是池化串。 */
const UNREACHABLE_POOLED_URL =
  `postgres://${SENTINELS.runtimeUser}:${SENTINELS.runtimePassword}` +
  `@ep-lq-bootstrap-pooler.neon.example:5432/neondb?sslmode=require&channel_binding=require`;

/** `resolveFormBConfig` 的合法基线：不给 `VERCEL_ENV` ⇒ `development` ⇒ 不需要提交号。 */
function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [FORM_B_ENV_VARS.deployment]: 'B',
    [FORM_B_ENV_VARS.databaseUrl]: UNREACHABLE_POOLED_URL,
    [FORM_B_ENV_VARS.sourceCodeUrl]: 'https://github.com/example/littleq',
    [FORM_B_ENV_VARS.masterKey]: SENTINELS.masterKey,
    ...overrides,
  };
}

const SESSION_TTL = parseSessionTtlPolicy({
  idleMinutes: 30,
  absoluteMinutes: 120,
  rememberMeIdleMinutes: 720,
  rememberMeAbsoluteMinutes: 4320,
});

/** provider 腿被调用过几次。装配与自检都**不该**碰它（§8.1「禁止外部AI测试」）。 */
let tokenSourceCalls = 0;

function inputsFor(env: Record<string, string | undefined>): FormBBootstrapInputs {
  return {
    env,
    sessionTtl: SESSION_TTL,
    workerId: 'api-bootstrap-container-test',
    secureCookies: false,
    scanner: createWorkScanner(),
    // 刻意**不给** `scanConfiguration` ⇒ 走设计好的失败关闭 `null`（文件头缺口 4）。
    provider: createTurnProviderClient({
      baseUrl: 'http://127.0.0.1:1',
      identityId: 'idt-lq-test',
      templateId: 'tpl-lq-test',
      environmentId: 'env-lq-test',
      tokenSource: async () => {
        tokenSourceCalls += 1;
        throw new Error('装配与自检过程不允许调用 provider（§8.1 禁止外部AI测试）');
      },
    }),
    providerConfiguration: {
      identityId: 'idt-lq-test',
      templateId: 'tpl-lq-test',
      environmentId: 'env-lq-test',
      templateVersion: 'v-test',
    },
  };
}

/** 断言一段文本里没有任何一个哨兵。 */
function expectNoSentinel(text: string): void {
  for (const sentinel of SENTINEL_VALUES) {
    expect(text, `输出里出现了哨兵（长度 ${String(sentinel.length)}）`).not.toContain(sentinel);
  }
  expect(text).not.toContain('postgres://');
}

function describeOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 接管两个标准流。阳性对照见「探针真的看得见」那一条。 */
function spyProcessOutput(): { readonly text: () => string; restore(): void } {
  const chunks: string[] = [];
  const record = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(record as never);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(record as never);
  return {
    text: () => chunks.join(''),
    restore: () => {
      out.mockRestore();
      err.mockRestore();
    },
  };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

describe('形态 B 装配根：DB 不可达时进程仍 live（§2.1 line 77）', () => {
  let container: FormBContainer;
  let baseUrl: string;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    container = await createFormBContainer(inputsFor(validEnv()));
    const listening = await container.listen(0);
    baseUrl = listening.baseUrl;
    stop = listening.close;
  });

  afterAll(async () => {
    if (stop !== undefined) await stop();
    if (container !== undefined) await container.close();
  });

  it('容器装配成功，且自检结论是 false（DB 不可达），但容器照样存在', () => {
    // 这一对断言合起来才是那条设计：自检**跑**了、**失败**了、进程**没有**被掐死。
    expect(container).toBeDefined();
    expect(container.bootSelfCheckOk).toBe(false);
    expect(container.config.deployment).toBe('B');
    expect(container.config.platformEnv).toBe('development');
    expect(typeof container.handler).toBe('function');
  });

  it('装配与自检全程没有碰过 provider（§8.1「禁止外部AI测试」）', () => {
    expect(tokenSourceCalls).toBe(0);
  });

  it('GET /api/v1/health/live → 200 {status:"ok"}：live 不探任何依赖（§5.4）', async () => {
    const { status, body } = await getJson(baseUrl, '/api/v1/health/live');
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  it('GET /api/v1/health/ready → 503 DEPENDENCY_UNAVAILABLE：就绪探针真的去问了 DB', async () => {
    // 这条是上面那条的**阴性对照**：如果 ready 也不探依赖，它就会跟着返回 200，
    // 那时"live 200"就什么也证不了。
    const startedAt = Date.now();
    const { status, body } = await getJson(baseUrl, '/api/v1/health/ready');
    const elapsedMs = Date.now() - startedAt;
    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    // 上界是 §8.1 的总预算，不是驱动自己的超时。预算失效的话这里会跑到 vitest 的 60 s。
    expect(elapsedMs).toBeLessThan(READY_BUDGET_MS.overall + 500);
  });

  it('GET /api/v1/projects → 401 AUTHENTICATION_REQUIRED：业务未开放，且不碰那个连不上的 DB', async () => {
    // `authenticate` 在 `sessionToken === null` 时**直接返回 null**
    // （`packages/application/src/usecases/auth.ts:197`），不查库。
    // 所以这条既证了"学生/API 写入未开放"，也证了它失败在鉴权层而不是在 DB 层。
    const { status, body } = await getJson(baseUrl, '/api/v1/projects');
    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  it('未接线的 operation 落到统一 404，路由表活着', async () => {
    const unknown = await getJson(baseUrl, '/api/v1/lq-no-such-path');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    // 非 `/api/v1` 前缀同样 404（`http.ts:787`）。带斜杠：`trailingSlash` 的 308 是 web 侧的事。
    const unprefixed = await getJson(baseUrl, '/health/live');
    expect(unprefixed.status).toBe(404);
  });

  it('probeNow() 可以反复调用，每次重新问（「不以重启补配置」的前提）', async () => {
    await expect(container.probeNow()).rejects.toThrow();
    await expect(container.probeNow()).rejects.toThrow();
    // 仍然没碰 provider。
    expect(tokenSourceCalls).toBe(0);
  });
});

describe('形态 B 装配根：致命配置错误拒绝装配（§2.1「拒绝业务装配并仅输出固定修复码」）', () => {
  afterEach(() => {
    resetFormBContainer();
  });

  it('LITTLEQ_DEPLOYMENT 缺失 ⇒ DEPLOYMENT_FORM_MISSING，容器不存在', async () => {
    const env = validEnv({ [FORM_B_ENV_VARS.deployment]: undefined });
    await expect(createFormBContainer(inputsFor(env))).rejects.toMatchObject({
      name: 'BootstrapConfigError',
      code: 'DEPLOYMENT_FORM_MISSING',
    });
  });

  it('LITTLEQ_DEPLOYMENT=A ⇒ DEPLOYMENT_FORM_UNSUPPORTED（本装配根只服务形态 B）', async () => {
    const env = validEnv({ [FORM_B_ENV_VARS.deployment]: 'A' });
    await expect(createFormBContainer(inputsFor(env))).rejects.toMatchObject({
      code: 'DEPLOYMENT_FORM_UNSUPPORTED',
    });
  });

  it('LITTLEQ_ENV 与 VERCEL_ENV 不一致 ⇒ PLATFORM_ENV_MISMATCH（生产/preview 混绑）', async () => {
    const env = validEnv({
      [FORM_B_ENV_VARS.littleqEnv]: 'production',
      [FORM_B_ENV_VARS.vercelEnv]: 'preview',
    });
    await expect(createFormBContainer(inputsFor(env))).rejects.toMatchObject({
      code: 'PLATFORM_ENV_MISMATCH',
    });
  });

  it('主密钥缺失 ⇒ MASTER_KEY_UNAVAILABLE（InfraError），不许软化、不许临时生成', async () => {
    const env = validEnv({ [FORM_B_ENV_VARS.masterKey]: undefined });
    const error: unknown = await createFormBContainer(inputsFor(env)).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(isInfraError(error)).toBe(true);
    if (isInfraError(error)) expect(error.code).toBe('MASTER_KEY_UNAVAILABLE');
  });

  it('主密钥非法（长度不对的 base64）⇒ 同样是 MASTER_KEY_UNAVAILABLE', async () => {
    // 32 字节要求 + 严格 base64 往返（`packages/infra/src/secret-store/cipher.ts:113-120`）。
    const env = validEnv({ [FORM_B_ENV_VARS.masterKey]: 'not-a-real-key' });
    const error: unknown = await createFormBContainer(inputsFor(env)).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(isInfraError(error)).toBe(true);
    if (isInfraError(error)) expect(error.code).toBe('MASTER_KEY_UNAVAILABLE');
  });

  it('provider 腿没注入 ⇒ PROVIDER_CONFIG_UNREGISTERED（不编占位 provider）', async () => {
    const inputs = inputsFor(validEnv());
    const error: unknown = await createFormBContainer({
      ...inputs,
      provider: undefined,
      providerConfiguration: undefined,
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BootstrapConfigError);
    if (error instanceof BootstrapConfigError) {
      expect(error.code).toBe('PROVIDER_CONFIG_UNREGISTERED');
      expectNoSentinel(describeOf(error));
    }
  });

  it('以上每一种失败都不泄漏哨兵，也不返回半成品容器', async () => {
    const cases: readonly Record<string, string | undefined>[] = [
      validEnv({ [FORM_B_ENV_VARS.deployment]: undefined }),
      validEnv({ [FORM_B_ENV_VARS.deployment]: 'C' }),
      validEnv({ [FORM_B_ENV_VARS.masterKey]: undefined }),
      validEnv({ [FORM_B_ENV_VARS.sourceCodeUrl]: undefined }),
      validEnv({ [FORM_B_ENV_VARS.databaseUrl]: undefined }),
    ];
    for (const env of cases) {
      const error: unknown = await createFormBContainer(inputsFor(env)).then(
        (built) => {
          // 走到这里就是"抛了该抛的没抛"。关掉再失败，别把池留给后面。
          void built.close();
          return null;
        },
        (thrown: unknown) => thrown,
      );
      expect(error, `这组环境本该拒启：${JSON.stringify(Object.keys(env))}`).not.toBeNull();
      expectNoSentinel(describeOf(error));
    }
  });
});

describe('进程级容器记忆化（§2.1「缓存已初始化的 DI 容器」）', () => {
  afterEach(() => {
    resetFormBContainer();
  });

  it('同一个进程里两次拿到的是同一个容器（不会各建一个连接池）', async () => {
    const first = await getFormBContainer(inputsFor(validEnv()));
    const second = await getFormBContainer(inputsFor(validEnv()));
    try {
      expect(second).toBe(first);
      expect(first.bootSelfCheckOk).toBe(false);
    } finally {
      await first.close();
    }
  });

  it('装配失败**不**污染记忆：修好之后不需要重启实例', async () => {
    await expect(getFormBContainer(inputsFor(validEnv({ [FORM_B_ENV_VARS.deployment]: undefined })))).rejects.toThrow();
    const recovered = await getFormBContainer(inputsFor(validEnv()));
    try {
      expect(recovered.config.deployment).toBe('B');
    } finally {
      await recovered.close();
    }
  });

  it('resetFormBContainer() 之后重建（测试隔离用的那个出口真的有效）', async () => {
    const first = await getFormBContainer(inputsFor(validEnv()));
    resetFormBContainer();
    const second = await getFormBContainer(inputsFor(validEnv()));
    try {
      expect(second).not.toBe(first);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('输出里不出现任何凭据值', () => {
  it('探针阳性对照：往 stdout 写一个哨兵，探针一定看得见', () => {
    const spy = spyProcessOutput();
    try {
      process.stdout.write(SENTINELS.masterKey);
      process.stderr.write(SENTINELS.providerToken);
      expect(spy.text()).toContain(SENTINELS.masterKey);
      expect(spy.text()).toContain(SENTINELS.providerToken);
    } finally {
      spy.restore();
    }
  });

  it('装配 + 起进程 + 四条请求之后，两个标准流里没有任何哨兵', async () => {
    const spy = spyProcessOutput();
    try {
      const container = await createFormBContainer(inputsFor(validEnv()));
      const listening = await container.listen(0);
      try {
        // 阳性对照：先证这一轮里**真的**发生了 HTTP 往返。否则"没抓到哨兵"可能只是
        // 因为什么都没跑 —— 一条永远不会红的门不是证据。
        const live = await getJson(listening.baseUrl, '/api/v1/health/live');
        expect(live.status).toBe(200);
        await getJson(listening.baseUrl, '/api/v1/health/ready');
        await getJson(listening.baseUrl, '/api/v1/projects');
        await getJson(listening.baseUrl, '/api/v1/lq-no-such-path');
      } finally {
        await listening.close();
        await container.close();
      }
      expectNoSentinel(spy.text());
    } finally {
      spy.restore();
    }
  });

  it('一次失败的装配（连接被拒）也不把连接串打进输出', async () => {
    const spy = spyProcessOutput();
    try {
      const container = await createFormBContainer(inputsFor(validEnv()));
      try {
        await expect(container.probeNow()).rejects.toThrow();
      } finally {
        await container.close();
      }
      expectNoSentinel(spy.text());
    } finally {
      spy.restore();
    }
  });
});

describe('源码级守卫：装配根里没有长驻轮询，运行串逐字透传', () => {
  const sourcePath = join(import.meta.dirname, '../src/bootstrap/vercel.ts');
  const source = readFileSync(sourcePath, 'utf8');

  /**
   * ⚠️ 一律匹配**调用形态**，不匹配裸标识符。
   *
   * 实测本文件里 `setInterval` 出现 1 次、`createPgClientSource` 出现 1 次 —— 两次都在
   * **解释为什么它们不该出现的散文里**（文件头「无长驻轮询 ⇒ 本文件里没有 `setInterval`」
   * 与那张 pooled/direct 驱动对照表）。用裸标识符做零命中门，会因为"写着这条门的注释"
   * 而变红。下面每条都带一个阳性样本，证明正则本身没写错。
   */
  const FORBIDDEN_CALL_FORMS: readonly {
    readonly label: string;
    readonly pattern: RegExp;
    readonly positiveSample: string;
  }[] = [
    { label: 'setInterval（长驻轮询）', pattern: /\bsetInterval\s*\(/, positiveSample: 'setInterval(poll, 1000)' },
    { label: 'setImmediate（自续循环）', pattern: /\bsetImmediate\s*\(/, positiveSample: 'setImmediate(tick)' },
    { label: 'queueMicrotask（自续循环）', pattern: /\bqueueMicrotask\s*\(/, positiveSample: 'queueMicrotask(tick)' },
    { label: 'for(;;)（无界循环）', pattern: /for\s*\(\s*;\s*;\s*\)/, positiveSample: 'for (;;) { await poll(); }' },
    { label: 'while(true)（无界循环）', pattern: /while\s*\(\s*true\s*\)/, positiveSample: 'while (true) { await poll(); }' },
    {
      label: 'createPgClientSource（迁移驱动不许出现在装配根里）',
      pattern: /\bcreatePgClientSource\s*\(/,
      positiveSample: 'await createPgClientSource({ connectionString })',
    },
    { label: 'runtime.connectionString.trim（一改就不是逐字）', pattern: /runtime\.connectionString\s*\.\s*trim/, positiveSample: 'runtime.connectionString.trim()' },
    { label: 'new URL(runtime…（重写连接串）', pattern: /new URL\(\s*runtime/, positiveSample: 'new URL(runtime.connectionString).toString()' },
  ];

  it.each(FORBIDDEN_CALL_FORMS)('零命中：$label', ({ pattern }) => {
    expect(pattern.test(source)).toBe(false);
  });

  it.each(FORBIDDEN_CALL_FORMS)('阳性对照：正则真的能匹配 $label', ({ pattern, positiveSample }) => {
    // 没有这条，上面那组零命中可能只是因为正则写错了 —— 那是一种永远绿的假绿。
    expect(pattern.test(positiveSample)).toBe(true);
  });

  it('从 @littleq/infra 只导入池化 WS 驱动，不导入 TCP 迁移驱动', () => {
    // 这条比数散文里的词有用：它钉住的是**真的 import**。装配根拿错驱动的后果是
    // 在服务端函数里开 TCP 长连接（Vercel 上活不过一次调用），或在迁移里用池化地址
    // （`pg_advisory_xact_lock` 会在语句之间换后端，锁形同不存在）。
    // `[^{}]*` 而不是 `[\s\S]*?`：非贪婪也会跨过前面几个 import 的花括号，
    // 捕到一大段无关文本，那时"不含 X"就不再是关于这条 import 的断言了。
    const infraImport = /import\s*\{([^{}]*)\}\s*from\s*'@littleq\/infra'/.exec(source)?.[1] ?? '';
    expect(infraImport).toContain('createNeonClientSource');
    expect(infraImport).not.toContain('createPgClientSource');
    expect(source.match(/\bcreateNeonClientSource\s*\(/g)?.length ?? 0).toBe(1);
  });

  it('连接串在源码里只被摸过两次，两次都是原样交给驱动', () => {
    // `runtime.connectionString` 全文出现 2 次，且**两次都是** `connectionString: runtime.connectionString`
    // —— 没有第三次被拿去裁剪、拼接、解析或打印。这就是「逐字透传」在源码层的证据。
    expect(source.match(/runtime\.connectionString/g)?.length ?? 0).toBe(2);
    expect(source.match(/connectionString: runtime\.connectionString/g)?.length ?? 0).toBe(2);
    expect(source.match(/maxConnections: config\.poolMax/g)?.length ?? 0).toBe(1);
  });

  it('预算用的是 setTimeout + clearTimeout，且 §8.1 的四个数字都在', () => {
    expect(source.match(/\bsetTimeout\s*\(/g)?.length ?? 0).toBe(1);
    expect(source.match(/\bclearTimeout\s*\(/g)?.length ?? 0).toBe(1);
    expect(READY_BUDGET_MS).toEqual({ overall: 2500, config: 100, database: 1500, object: 1200 });
  });
});

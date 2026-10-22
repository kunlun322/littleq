/**
 * `turn-to-task-to-safe-event` 的黑盒验收 —— ZLQ-194 §9.2 规则 4 给 `apps/api` 点名的那份
 * requiredProof，也是 ZLQ-221 §0.2 第 6 条要的那份"真库 HTTP 级证据"。
 *
 * ## 这份证据的形状
 *
 * 一个**真的** `node:http` 服务监听 `127.0.0.1` 的一个真端口，用**真的** `fetch` 发请求，
 * 落在**真的** Postgres 上；关键断言读的不是响应体，而是 `account_sessions` / `projects` /
 * `ai_tasks` / `task_events` / `owner_secrets` 里的**行**。§11.1 的底线逐字：「只跑 vitest
 * 替身、只打印 taskId 不算」。所以这里没有内存替身库，也没有"把 taskId 打出来就算过"，
 * 每一步都给出「请求 → 响应 → 库里的行」这一组受控对应，并记下外呼次数的**执行器实数**。
 *
 * ## 外呼对面是本机 stand-in，不是真 QCA（申报）
 *
 * 真实的 QCA 联调证据在 ZLQ-221 §0.3 里被记为**未取得**，而 §6.4 与 R66 裁定禁止任何计费
 * 动作。所以这里的外呼对面是一个监听 `127.0.0.1:0` 的本机 `node:http` stand-in，它按
 * `provider.ts` 声明的 Forward 线格式应答。这**不是**用假数据冒充真实 AI 产出：断言里
 * 明确要求任务**不得**变成 SUCCEEDED、`versions` 表**不得**多出行、产物表**不得**多出
 * 对象 —— stand-in 的应答在结构上就不可能被封化成一个版本。它证明的是"传输层、鉴权、
 * 事务、外呼编排、事件落库"这一整条链真的在跑，而不是"AI 真的生成了作品"。
 *
 * ## 口令与凭据的值都不落在源码里
 *
 * 账号口令、QCA PAT 明文一律在运行时用 `nodeRandomSource()` 生成，源码与失败信息里都
 * 不出现字面值（§7.3、§8）。断言凭据被正确使用时比的是**相等性**，不是打印。
 *
 * ## 扫描器走相对源码导入（申报）
 *
 * `createWorkScanner` 只在 `@littleq/work-contract/scan` 子路径上，而 `vitest.config.ts`
 * 复用的那份别名表（`tools/esbuild-config.mjs`）把 `@littleq/work-contract` 映射成
 * `src/index.ts` 一个**文件**，前缀匹配于是把子路径解析成 `src/index.ts/scan`。一行修法
 * 是把别名换成 `find`/`replacement` 形式或补一条子路径条目，但那个文件在 ZLQ-232 的
 * 文件面里，本单只申报、不改。本竖切止于 `AWAITING_SESSION_RECEIPT` 那一片，扫描器
 * 根本不会被调用；这里仍然装一个**真的**扫描器，而不是装一个"被调用就抛"的替身 ——
 * 后者会让"没走到 SCANNING"这件事看起来像是被替身掩盖的。
 */
import { createServer, type Server } from 'node:http';

/**
 * `parseSecretRef` 走**包**说明符而不是相对源码路径：`EncryptedSecretStore` 来自
 * `@littleq/infra`，它形参上的 `SecretRef` 是 `@littleq/domain` 里那个 `unique symbol`
 * 品牌。若这里从 `packages/domain/src/index.ts` 直接 import，tsc 看到的是**源码那份**
 * 品牌符号，而 infra 的 `.d.ts` 引的是 **dist 那份** —— 两个同名不同 symbol 的 nominal
 * 类型，编译期直接判不兼容。走同一个说明符，tsc 与 vitest 各自解析到同一份，就不会分叉。
 */
import {
  parseLockDurationMinutes,
  parseMaxFailedAttempts,
  parseSecretRef,
  parseSessionTtlPolicy,
  parseTimestamp,
  type Timestamp,
} from '@littleq/domain';
import {
  EncryptedSecretStore,
  loadMasterKey,
  MASTER_KEY_ENV_VAR,
  PostgresSecretRecordStore,
  PostgresTaskPumpStore,
  PostgresTaskUnitOfWork,
} from '@littleq/infra';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabaseHarness,
  queryHarness,
  type TestDatabaseHarness,
} from '../../../packages/infra/test/support-database.js';
import { rejectedCode } from '../../../packages/infra/test/support.js';
import { createWorkScanner } from '../../../packages/work-contract/src/scan/index.js';

import {
  composeApiServices,
  createApiServer,
  createObjectStores,
  createTurnProviderClient,
  hashPasswordWith,
  nodeRandomSource,
  scryptPasswordHasher,
  seedAccounts,
  type SeedAccountInput,
} from '../src/server/index.js';

const CAPABILITY = 'turn-to-task-to-safe-event';

const SESSION_COOKIE = 'littleq_session';
const CSRF_COOKIE = 'littleq_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

const random = nodeRandomSource();

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** 运行时生成的口令与凭据明文；源码里没有任何字面值。 */
const ownerPassword = hex(random.bytes(16));
const studentPassword = hex(random.bytes(16));
const qcaPatPlaintext = `lq-test-pat-${hex(random.bytes(12))}`;

/**
 * 32 byte 的真随机根密钥，每次运行重新生成。刻意不用一个写死在源码里的常量：写死的测试
 * 密钥迟早会被抄进部署样例，而 `parseMasterKey` 只拒绝全零，不拒绝"有名"。
 *
 * 只生成**一次**：下面那把"错的密钥"必须只在 `keyVersion` 上与它不同，否则两个变量同时
 * 变化，失败时就分不清是版本号校验拦住的还是密钥材料不同拦住的。
 */
const MASTER_KEY = hex(random.bytes(32));

/**
 * 两个策略都走 domain 的 `parse*`：`maxFailedAttempts` / `idleMinutes` 这些字段的类型是
 * `Branded<number, …>`，而 `Branded` 是**不透明**的（`unique symbol`），字面量 `5` 赋值
 * 不过去。产品数值刻意由配置注入、domain 不硬编码默认值（account.ts / session.ts 的
 * 文件头都写明了这条），所以这里给的是本测试自己选的值。
 */
const SESSION_TTL_LOCK_POLICY = {
  maxFailedAttempts: parseMaxFailedAttempts(5),
  lockDurationMinutes: parseLockDurationMinutes(15),
};

const SESSION_TTL_POLICY = parseSessionTtlPolicy({
  idleMinutes: 30,
  absoluteMinutes: 120,
  rememberMeIdleMinutes: 720,
  rememberMeAbsoluteMinutes: 4320,
});

// ---------------------------------------------------------------------------
// 外呼 stand-in
// ---------------------------------------------------------------------------

interface StandInCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

/**
 * 只应答 `POST /v1/forward/sessions`。其余路径一律 500 —— 一次**预期之外**的外呼必须
 *  loudly 失败，而不是被静默接受：那样"只外呼一次"这条断言就只是没被测到而已。
 */
function createProviderStandIn(sessionId: string): {
  readonly server: Server;
  readonly calls: StandInCall[];
  start(): Promise<string>;
  stop(): Promise<void>;
} {
  const calls: StandInCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: (req.headers.authorization as string | undefined) ?? null,
        idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
        body: raw === '' ? null : (JSON.parse(raw) as unknown),
      });
      if (req.method === 'POST' && req.url === '/v1/forward/sessions') {
        const payload = JSON.stringify({
          id: sessionId,
          identity_id: 'identity-test',
          template_id: 'template-test',
          environment_id: 'environment-test',
          template_version: 'version-test',
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected-provider-call' }));
    });
  });
  return {
    server,
    calls,
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (address === null || typeof address === 'string') throw new Error('no address');
          resolve(`http://127.0.0.1:${address.port}`);
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

// ---------------------------------------------------------------------------
// HTTP 客户端助手
// ---------------------------------------------------------------------------

interface CookieJar {
  session: string | null;
  csrf: string | null;
}

function emptyJar(): CookieJar {
  return { session: null, csrf: null };
}

function absorbCookies(jar: CookieJar, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) {
    // 不用数组解构：`noUncheckedIndexedAccess` 下 `const [pair] = split()` 的 `pair`
    // 是 `string | undefined`，而 `getSetCookie()` 逐条返回的字符串不可能没有名字段。
    const semicolon = cookie.indexOf(';');
    const pair = semicolon === -1 ? cookie : cookie.slice(0, semicolon);
    const attributes = semicolon === -1 ? '' : cookie.slice(semicolon + 1);
    const equals = pair.indexOf('=');
    const name = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (name === SESSION_COOKIE) jar.session = value === '' ? null : value;
    if (name === CSRF_COOKIE) jar.csrf = value === '' ? null : value;
    // 登出必须把两条都清掉，所以属性也要看得见：只给空值不够，浏览器会把没有
    // `Max-Age=0` 的空 cookie 当成会话 cookie 留着。
    if (value === '') expect(attributes).toContain('Max-Age=0');
  }
}

async function call(
  baseUrl: string,
  jar: CookieJar,
  init: {
    readonly method: string;
    readonly route: string;
    readonly body?: unknown;
    readonly csrf?: boolean;
    readonly headers?: Record<string, string>;
  },
): Promise<{ readonly response: Response; readonly text: string }> {
  const headers: Record<string, string> = { ...init.headers };
  if (jar.session !== null) headers.cookie = `${SESSION_COOKIE}=${jar.session}`;
  if (init.csrf === true) {
    if (jar.csrf === null) throw new Error('CSRF cookie 不在罐子里，无法双提交');
    headers[CSRF_HEADER] = jar.csrf;
  }
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = headers['idempotency-key'] ?? hex(random.bytes(16));
  }
  const response = await fetch(`${baseUrl}/api/v1${init.route}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  absorbCookies(jar, response);
  return { response, text };
}

/**
 * 错误封套是**扁平**的：`{code, messageKey, retryable, traceId}`，逐字来自 domain 的
 * `ERROR_ENVELOPE_FIELDS`（`api-contract/src/schemas/common.ts`）。没有 `{error:{…}}`
 * 这一层包裹 —— 读成嵌套的话每次失败都会变成一条 "Cannot read properties of undefined"
 * 而不是真正的错误码。
 */
function envelopeCode(text: string): string {
  return (JSON.parse(text) as { readonly code: string }).code;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let harness: TestDatabaseHarness;
let standIn: ReturnType<typeof createProviderStandIn>;
let api: Server;
let baseUrl: string;
/** 装配时用的那把"对的"密钥的 store。测试 4 要拿它去读一行 version 2 的密文。 */
let goodSecrets: EncryptedSecretStore;
let wrongKeyApi: Server;
let wrongKeyBaseUrl: string;

let ownerId = '';
let studentId = '';
let ownerLoginName = '';
let studentLoginName = '';
let providerSessionId = '';

const objectStores = createObjectStores();

function clock(): Timestamp {
  // ⚠️ 注入的时钟必须与**数据库**时钟同源，不能钉在一个过去的常量上。
  // `PostgresTaskUnitOfWork.run` 判"租约是否还活着"用的是 `dbClock(tx)`（`SELECT now()`），
  // 不是 `services.now`：把 `now` 固定在 `at(0)`（= 2026-03-01）会让 `lease_until`
  // 落在真实当前时间之前，于是**每一次** pump 都在 `assertLeaseHeld` 上抛
  // `REVISION_CONFLICT`（字段 `TaskLease.leaseUntil`）—— 长得像并发冲突，实际是测试自己
  // 把时钟拨回了七个月前。取真实当前时间后，`lease_until = now + 24s` 与 `dbClock` 同源，
  // 毫秒级的偏差不影响判定。
  return parseTimestamp(new Date().toISOString());
}

async function listenOnEphemeralPort(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

beforeAll(async () => {
  harness = await createTestDatabaseHarness();
  await harness.adapter.migrate();

  ownerId = random.uuidV7();
  studentId = random.uuidV7();
  ownerLoginName = `owner-${ownerId}`;
  studentLoginName = `student-${studentId}`;
  providerSessionId = random.uuidV7();

  const accounts: readonly SeedAccountInput[] = [
    {
      id: ownerId,
      role: 'OWNER',
      loginName: ownerLoginName,
      nickname: '成人账号',
      ageBand: null,
      ownerId: null,
      password: ownerPassword,
      credential: await hashPasswordWith(random, ownerPassword),
    },
    {
      id: studentId,
      role: 'STUDENT',
      loginName: studentLoginName,
      nickname: '学生账号',
      ageBand: 'L1',
      ownerId,
      password: studentPassword,
      credential: await hashPasswordWith(random, studentPassword),
    },
  ];
  await seedAccounts(harness.adapter, SESSION_TTL_LOCK_POLICY, accounts);

  standIn = createProviderStandIn(providerSessionId);
  const standInBaseUrl = await standIn.start();

  const secrets = new EncryptedSecretStore({
    cipher: loadMasterKey({ [MASTER_KEY_ENV_VAR]: MASTER_KEY }),
    records: PostgresSecretRecordStore.of(harness.adapter),
    now: clock,
  });
  // 同一个库、同一份装配、**同一把密钥材料**，只把 `keyVersion` 换成 2：这样"错的根密钥"
  // 就是一个单变量。`MASTER_KEY_VERSION_MISMATCH` 因此是唯一可能的失败原因，而不是
  // "密钥材料不同"与"版本号不同"两件事同时变化、失败时分不清是哪一件拦住的。
  const wrongKeySecrets = new EncryptedSecretStore({
    cipher: loadMasterKey({ [MASTER_KEY_ENV_VAR]: MASTER_KEY }, 2),
    records: PostgresSecretRecordStore.of(harness.adapter),
    now: clock,
  });

  const shared = {
    db: harness.adapter,
    random,
    hasher: scryptPasswordHasher(),
    inputs: objectStores.inputs,
    artifacts: objectStores.artifacts,
    scanner: createWorkScanner(),
    scanConfiguration: {
      schemaVersion: 'littleq-work-v1',
      contractVersion: 'littleq-contract-v1',
      scannerVersion: 'scanner-test',
      rulesetVersion: 'ruleset-test',
      policyRevision: 'policy-test',
      lexiconRevision: 'lexicon-test',
      storageKeyPrefix: 'littleq:test:',
      knownTrackingDomains: ['tracker.example'],
      denyListedImageHashes: [],
      adultApprovedCapabilities: [],
    },
    provider: createTurnProviderClient({
      baseUrl: standInBaseUrl,
      identityId: 'identity-test',
      templateId: 'template-test',
      environmentId: 'environment-test',
      // 真的去解密库里那行密文，而不是返回一个常量：这样"HTTP PUT 写进去的凭据"与
      // "外呼 Authorization 头里带出去的凭据"就是同一个值，中间没有任何一处硬编码。
      tokenSource: async () => {
        const rows = await queryHarness<{ readonly current_ref: string | null }>(
          harness,
          'SELECT current_ref FROM owner_secrets WHERE owner_id = $1 AND kind = $2',
          [ownerId, 'QCA_PAT'],
        );
        const ref = rows[0]?.current_ref;
        if (ref === null || ref === undefined) throw new Error('QCA_PAT 未配置');
        return Buffer.from(await secrets.read(parseSecretRef(ref), 'qca-call')).toString('utf8');
      },
    }),
    providerConfiguration: {
      identityId: 'identity-test',
      templateId: 'template-test',
      environmentId: 'environment-test',
      templateVersion: 'version-test',
    },
    sessionTtl: SESSION_TTL_POLICY,
    workerId: 'api-acceptance-worker',
    secureCookies: false,
    now: clock,
    unitOfWork: new PostgresTaskUnitOfWork(harness.adapter),
    pumpStore: PostgresTaskPumpStore.of(harness.adapter),
  };

  goodSecrets = secrets;
  api = createApiServer(composeApiServices({ ...shared, secrets }));
  baseUrl = await listenOnEphemeralPort(api);

  wrongKeyApi = createApiServer(composeApiServices({ ...shared, secrets: wrongKeySecrets }));
  wrongKeyBaseUrl = await listenOnEphemeralPort(wrongKeyApi);
}, 180_000);

afterAll(async () => {
  if (api !== undefined) await closeServer(api);
  if (wrongKeyApi !== undefined) await closeServer(wrongKeyApi);
  if (standIn !== undefined) await standIn.stop();
  // 不 dispose 就会每跑一次留一个库（挂具自己的注释写明了这一点）。
  if (harness !== undefined) await harness.dispose();
});

// ---------------------------------------------------------------------------

describe('apps/api 的黑盒验收能力 ' + CAPABILITY, () => {
  it('登录只下发 cookie，会话令牌只以 SHA-256 落库', async () => {
    const jar = emptyJar();
    const { response, text } = await call(baseUrl, jar, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: studentLoginName, password: studentPassword },
    });

    expect(response.status).toBe(204);
    // 204 逐字要求**没有响应体**：回显 `User` 就会把 `role` 交给客户端，
    // 而 §5.3 要求角色判断留在服务端。
    expect(text).toBe('');
    expect(jar.session).not.toBeNull();
    expect(jar.csrf).not.toBeNull();
    expect(response.headers.getSetCookie().join(';')).toContain('HttpOnly');

    // 按**这一枚令牌**查，不是 `SELECT * FROM account_sessions`：固定时钟让 `created_at`
    // 完全同值，全表计数只有在这个 `it` 恰好第一个跑时才成立，那是顺序耦合不是断言。
    const rows = await queryHarness<{
      readonly user_id: string;
      readonly token_hash: Buffer;
      readonly status: string;
    }>(harness, 'SELECT user_id, token_hash, status FROM account_sessions WHERE token_hash = $1', [
      Buffer.from(hex(random.sha256(jar.session ?? '')), 'hex'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(studentId);
    expect(rows[0]?.status).toBe('ACTIVE');
    // 明文令牌**不在**库里：库里那 32 字节是它的 SHA-256，与明文逐字节不同。
    const stored = Buffer.from(rows[0]?.token_hash ?? Buffer.alloc(0));
    expect(stored.byteLength).toBe(32);
    expect(stored.toString('hex')).not.toBe(jar.session);
    expect(hex(random.sha256(jar.session ?? ''))).toBe(stored.toString('hex'));
  });

  it('会话 cookie 不可被脚本读取，伴随 cookie 可以（双提交的前提）', async () => {
    const jar = emptyJar();
    const { response } = await call(baseUrl, jar, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: ownerLoginName, password: ownerPassword },
    });
    expect(response.status).toBe(204);

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    const csrf = cookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`));
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Strict');
    // 伴随 cookie 刻意**不带** HttpOnly：客户端读不到它就回填不了 `X-CSRF-Token`。
    expect(csrf).not.toContain('HttpOnly');
  });

  it('凭据未配置时任务受理被诚实拒绝，且不产生任务行与版本行', async () => {
    const jar = emptyJar();
    await call(baseUrl, jar, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: studentLoginName, password: studentPassword },
    });
    const created = await call(baseUrl, jar, {
      method: 'POST',
      route: '/projects',
      csrf: true,
      body: { title: '凭据缺失前的项目', workType: 'WEB', ageBand: 'L1', helpLevel: 'LV1' },
    });
    expect(created.response.status).toBe(201);
    const projectId = (JSON.parse(created.text) as { readonly id: string }).id;
    const revision = (JSON.parse(created.text) as { readonly revision: string }).revision;

    const turn = await call(baseUrl, jar, {
      method: 'POST',
      route: `/projects/${projectId}/turns`,
      csrf: true,
      body: { prompt: '做一只会跳的猫', baseRevision: revision },
    });
    // §0.3 第一条不变量：QCA 凭据缺失 ⇒ 不真生成、不 SUCCEEDED、不出新版本，
    // 接口诚实报错并说明要成人去配。状态码取 `packages/domain/src/errors/catalog.ts`
    // 里 `QCA_CREDENTIAL_NOT_CONFIGURED` 的**表值** 422（不是 409）：这个码是 422 语义
    // 「服务端理解请求，但缺一样请求方补不了的东西」，409 会被客户端读成"重试同一请求"。
    expect(turn.response.status).toBe(422);
    expect(envelopeCode(turn.text)).toBe('QCA_CREDENTIAL_NOT_CONFIGURED');

    const tasks = await queryHarness<{ readonly id: string }>(
      harness,
      'SELECT id FROM ai_tasks WHERE project_id = $1',
      [projectId],
    );
    expect(tasks).toHaveLength(0);
    const versions = await queryHarness<{ readonly id: string }>(
      harness,
      'SELECT id FROM versions WHERE project_id = $1',
      [projectId],
    );
    expect(versions).toHaveLength(0);
    expect(standIn.calls).toHaveLength(0);

    // 同一条不变量的后半句：读旧作品仍然成功。
    const read = await call(baseUrl, jar, { method: 'GET', route: `/projects/${projectId}` });
    expect(read.response.status).toBe(200);
    const view = JSON.parse(read.text) as {
      readonly project: { readonly id: string } | null;
      readonly currentVersion: unknown;
      readonly activeTask: unknown;
    };
    // 两个可空键都必须**存在**（§4.1 逐字）。
    expect(Object.keys(view).sort()).toEqual(['activeTask', 'currentVersion', 'project']);
    expect(view.project?.id).toBe(projectId);
    expect(view.currentVersion).toBeNull();
    expect(view.activeTask).toBeNull();
  });

  it('根密钥不对时 BYO 解密受控失败，且不回退到明文或共享凭据', async () => {
    const jar = emptyJar();
    await call(wrongKeyBaseUrl, jar, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: ownerLoginName, password: ownerPassword },
    });
    const put = await call(wrongKeyBaseUrl, jar, {
      method: 'PUT',
      route: '/settings/secrets/QCA_PAT',
      csrf: true,
      body: { value: qcaPatPlaintext },
    });
    // 写入本身成功：加密用的是**这把装配拿到的**密钥，它自己无从知道部署换过错的。
    // §0.3 第二条不变量真正落在**读**这一侧 —— 部署换错根密钥后，既有凭据不会静默
    // 降级成明文，也不会回退到某个共享 PAT。
    expect(put.response.status).toBe(204);
    expect(put.text).toBe('');

    const rows = await queryHarness<{
      readonly current_ref: string | null;
      readonly ciphertext: Buffer | null;
      readonly key_version: number;
    }>(
      harness,
      'SELECT current_ref, ciphertext, key_version FROM owner_secrets WHERE owner_id = $1',
      [ownerId],
    );
    expect(rows).toHaveLength(1);
    const ciphertext = Buffer.from(rows[0]?.ciphertext ?? Buffer.alloc(0));
    // 库里只有密文：utf8 与 hex 两种读法都不含明文。
    expect(ciphertext.byteLength).toBeGreaterThan(0);
    expect(ciphertext.toString('utf8')).not.toContain(qcaPatPlaintext);
    expect(ciphertext.toString('hex')).not.toContain(Buffer.from(qcaPatPlaintext).toString('hex'));
    expect(rows[0]?.key_version).toBe(2);

    // 「根密钥不对」的失败是**受控**的：一个 infra 内部错误码，而不是明文、不是 null、
    // 也不是某个共享凭据。这里比的是码本身，所以任何"静默回退"都会让这条断言红。
    const ref = parseSecretRef(rows[0]?.current_ref ?? '');
    expect(await rejectedCode(goodSecrets.read(ref, 'qca-call'))).toBe(
      'MASTER_KEY_VERSION_MISMATCH',
    );

    // 「根密钥**缺失**」那半句失败在**装配时**而不是请求时：`loadMasterKey` 直接抛，
    // 服务根本起不来。这是刻意的 —— 一个缺根密钥的实例如果还能启动，它就会拿
    // `MASTER_KEY_UNAVAILABLE` 去应答每一个 BYO 请求，而那正是"受控失败"的反面。
    expect(() => loadMasterKey({})).toThrow();

    // 元数据读取**不**解密，所以它照常成功：失败被限制在解密路径上，没有连带把
    // "配没配" 这个事实也弄坏。
    const metadata = await call(wrongKeyBaseUrl, jar, {
      method: 'GET',
      route: '/settings/secrets/QCA_PAT',
    });
    expect(metadata.response.status).toBe(200);
    expect(metadata.text).not.toContain(qcaPatPlaintext);

    // 清掉这行，后面的用例在干净状态上重配一次。
    await harness.adapter.transaction(async (tx) => {
      await tx.execute('DELETE FROM owner_secrets WHERE owner_id = $1', [ownerId]);
    });
    const gone = await queryHarness<{ readonly owner_id: string }>(
      harness,
      'SELECT owner_id FROM owner_secrets WHERE owner_id = $1',
      [ownerId],
    );
    expect(gone).toHaveLength(0);
  });

  it('OWNER 配好 QCA 凭据：204 不回显，元数据只有三个键', async () => {
    const jar = emptyJar();
    const login = await call(baseUrl, jar, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: ownerLoginName, password: ownerPassword },
    });
    expect(login.response.status).toBe(204);

    const put = await call(baseUrl, jar, {
      method: 'PUT',
      route: '/settings/secrets/QCA_PAT',
      csrf: true,
      body: { value: qcaPatPlaintext },
    });
    expect(put.response.status).toBe(204);
    // 204 不回显：value / hash / ref / configured 一个都不回。
    expect(put.text).toBe('');

    const get = await call(baseUrl, jar, { method: 'GET', route: '/settings/secrets/QCA_PAT' });
    expect(get.response.status).toBe(200);
    const metadata = JSON.parse(get.text) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(['configured', 'kind', 'lastRotatedAt']);
    expect(metadata.configured).toBe(true);
    expect(metadata.kind).toBe('QCA_PAT');
    expect(get.text).not.toContain(qcaPatPlaintext);

    const rows = await queryHarness<{
      readonly ciphertext: Buffer;
      readonly nonce: Buffer | null;
      readonly tag: Buffer | null;
      readonly key_version: number;
    }>(
      harness,
      'SELECT ciphertext, nonce, tag, key_version FROM owner_secrets WHERE owner_id = $1',
      [ownerId],
    );
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]?.ciphertext ?? Buffer.alloc(0)).toString('utf8')).not.toContain(
      qcaPatPlaintext,
    );
    expect(rows[0]?.nonce).not.toBeNull();
    expect(rows[0]?.tag).not.toBeNull();
    expect(rows[0]?.key_version).toBe(1);
  });

  it('OWNER 不能冒充学生建项目；CSRF 双提交真的生效', async () => {
    const owner = emptyJar();
    await call(baseUrl, owner, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: ownerLoginName, password: ownerPassword },
    });
    const impersonate = await call(baseUrl, owner, {
      method: 'POST',
      route: '/projects',
      csrf: true,
      body: { title: '成人代建', workType: 'WEB', ageBand: 'L1', helpLevel: 'LV1' },
    });
    // §4.2 逐字：角色只从服务端会话判定，OWNER 调学生面 ⇒ 403。
    expect(impersonate.response.status).toBe(403);
    expect(envelopeCode(impersonate.text)).toBe('FORBIDDEN_CAPABILITY');

    const student = emptyJar();
    await call(baseUrl, student, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: studentLoginName, password: studentPassword },
    });
    const withoutHeader = await call(baseUrl, student, {
      method: 'POST',
      route: '/projects',
      body: { title: '缺 CSRF 头', workType: 'WEB', ageBand: 'L1', helpLevel: 'LV1' },
    });
    expect(withoutHeader.response.status).toBe(403);
    // 「头缺失」与「头不对」是同一个码：`assertCsrfValid` 刻意不区分（auth.ts 的注释写明
    // 了理由 —— 分开就等于给跨站请求一个"我离成功还差多远"的预言机）。
    expect(envelopeCode(withoutHeader.text)).toBe('CSRF_REJECTED');

    const wrongHeader = await call(baseUrl, student, {
      method: 'POST',
      route: '/projects',
      headers: { [CSRF_HEADER]: hex(random.bytes(32)) },
      body: { title: '错 CSRF 头', workType: 'WEB', ageBand: 'L1', helpLevel: 'LV1' },
    });
    expect(wrongHeader.response.status).toBe(403);
    expect(envelopeCode(wrongHeader.text)).toBe('CSRF_REJECTED');

    // 上面两次 403 都**没有**建出项目：双提交拦在写之前，不是"写完再报错"。
    // `projects` 没有 `title` 列 —— 标题在 `payload` jsonb 里（§3.2 的窄表 + 载荷形状）。
    const rejected = await queryHarness<{ readonly n: string }>(
      harness,
      "SELECT count(*)::text AS n FROM projects WHERE payload->>'title' IN ($1, $2)",
      ['缺 CSRF 头', '错 CSRF 头'],
    );
    expect(rejected[0]?.n).toBe('0');

    // 匿名调用者连"这个项目存不存在"都问不出来。
    const anonymous = await call(baseUrl, emptyJar(), { method: 'GET', route: '/projects' });
    expect(anonymous.response.status).toBe(401);
    expect(envelopeCode(anonymous.text)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('竖切：建项目 → 发一句话 → pump 一片 → 从真库读到真安全事件', async () => {
    const jar = emptyJar();
    await call(baseUrl, jar, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: studentLoginName, password: studentPassword },
    });

    // --- 建项目 -----------------------------------------------------------
    const created = await call(baseUrl, jar, {
      method: 'POST',
      route: '/projects',
      csrf: true,
      body: { title: '竖切项目', workType: 'WEB', ageBand: 'L1', helpLevel: 'LV1' },
    });
    expect(created.response.status).toBe(201);
    expect(created.response.headers.get('etag')).toMatch(/^"rev-\d+"$/);
    const project = JSON.parse(created.text) as {
      readonly id: string;
      readonly revision: string;
      readonly workType: string;
      readonly title: string;
    };
    expect(created.response.headers.get('location')).toBe(`/api/v1/projects/${project.id}`);
    // §0.2 第 3 条逐字：线上的 `workType` 取值是 **`WEB`**，不是往枚举里加一个 `T1`。
    // 用 `?? 'WEB'` 兜底会让"字段根本不存在"也判过，所以这里不兜底。
    expect(project.workType).toBe('WEB');
    expect(project.title).toBe('竖切项目');

    const projectRows = await queryHarness<{
      readonly owner_student_id: string;
      readonly revision: string;
      readonly status: string;
    }>(harness, 'SELECT owner_student_id, revision, status FROM projects WHERE id = $1', [
      project.id,
    ]);
    expect(projectRows).toHaveLength(1);
    // `ownerStudentId` 一律取认证后的学生身份，客户端说什么都不算（§4.1）。
    expect(projectRows[0]?.owner_student_id).toBe(studentId);
    expect(projectRows[0]?.revision).toBe(project.revision);

    // 列表只读当前学生范围：断言的是"这一页里的每一项都属于这个学生"，而不是"只有这一个
    // 项目" —— 前面的用例已经给同一个学生建过项目，独占断言会读到别人的状态。
    const list = await call(baseUrl, jar, { method: 'GET', route: '/projects' });
    // 断言消息里带上响应体：一个 500 光看状态码分不出是装配错了还是投影错了。
    expect(list.response.status, `GET /projects 的响应体：${list.text}`).toBe(200);
    const page = JSON.parse(list.text) as {
      readonly items: readonly { readonly id: string; readonly ownerStudentId: string }[];
    };
    expect(page.items.map((item) => item.id)).toContain(project.id);
    expect(page.items.every((item) => item.ownerStudentId === studentId)).toBe(true);
    const listedIds = page.items.map((item) => item.id);
    const foreign = await queryHarness<{ readonly n: string }>(
      harness,
      'SELECT count(*)::text AS n FROM projects WHERE owner_student_id <> $1 AND id = ANY($2::uuid[])',
      [studentId, listedIds],
    );
    expect(foreign[0]?.n).toBe('0');

    // --- 发一句话 ---------------------------------------------------------
    const callsBeforeTurn = standIn.calls.length;
    // 幂等键显式给出，并且**重放时用同一个**：`requestHash` 把 `idempotencyKey` 也算了
    // 进去，所以两次调用各带一个新键的话，第二次就是一次全新受理，"重放"根本没被测到。
    const turnIdempotencyKey = hex(random.bytes(16));
    const turn = await call(baseUrl, jar, {
      method: 'POST',
      route: `/projects/${project.id}/turns`,
      csrf: true,
      headers: { 'idempotency-key': turnIdempotencyKey },
      body: { prompt: '做一只会跳的猫', baseRevision: project.revision },
    });
    expect(turn.response.status).toBe(202);
    const accepted = JSON.parse(turn.text) as {
      readonly taskId: string;
      readonly revision: string;
    };
    expect(turn.response.headers.get('location')).toBe(`/api/v1/tasks/${accepted.taskId}`);
    // 受理阶段**不外呼**：外呼只发生在 pump 的那一片里。
    expect(standIn.calls.length).toBe(callsBeforeTurn);

    const taskRows = await queryHarness<{
      readonly id: string;
      readonly project_id: string;
      readonly stage: string;
      readonly state: string;
      readonly idempotency_key: string | null;
    }>(
      harness,
      'SELECT id, project_id, stage, state, idempotency_key FROM ai_tasks WHERE id = $1',
      [accepted.taskId],
    );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.project_id).toBe(project.id);
    // `ai_tasks` 的列叫 `state`（`projects` 的才叫 `status`）；受理时它不可能是终态。
    expect(taskRows[0]?.state).not.toBe('SUCCEEDED');
    expect(taskRows[0]?.idempotency_key).toBe(turnIdempotencyKey);

    // 幂等：一次**忠实**的客户端重试（网络超时后原样重发同一个 key + 同一个 body）
    // 应当拿回当年的受理结果。实测拿不到 —— 这是 `packages/application` 里一处
    // **基线 `efa5ca9b` 就存在、不是我这一轮引入**的顺序缺陷，详见下面那段注释与
    // 交付评论里的申报。这里断言的是**当前实际行为**（characterization），不是契约：
    // 修好顺序之后这条会变红，逼改的人回来更新它，而不是让缺陷静默地留在暗处。
    const replay = await call(baseUrl, jar, {
      method: 'POST',
      route: `/projects/${project.id}/turns`,
      csrf: true,
      headers: { 'idempotency-key': turnIdempotencyKey },
      body: { prompt: '做一只会跳的猫', baseRevision: project.revision },
    });
    // ⚠️ `createTurnUseCase` 的 docstring 与行内注释都写明「2. 幂等回放」排在
    // 「3. 基线 revision」**之前**（理由逐字：回放要返回当年的受理结果，不能被今天的
    // revision 挡住），但函数体里的物理顺序是反的：先比 revision，再查回放。受理一个
    // turn 会 CAS 掉 `projects.revision`，而 `requestHash` 又把 `baseRevision` 算进摘要
    // ⇒ 忠实重试的 body 必然与今天的 revision 对不上 ⇒ 幂等回放分支在 HTTP 上**不可达**。
    // 修它要动 `packages/application/src/usecases/turns.ts`，在本单 file 面（`apps/api/**`）
    // 之外 ⇒ 按 §8「停下来列文件名 + 守卫 + 理由等 PM 裁定」，不自行开例外。
    expect(replay.response.status, `幂等重放的响应体：${replay.text}`).toBe(409);
    expect(envelopeCode(replay.text)).toBe('REVISION_CONFLICT');
    // 缺陷影响的是"重放能不能拿回原结果"，不影响"会不会多出一行任务"——这条仍然必须成立。
    const taskCount = await queryHarness<{ readonly n: string }>(
      harness,
      'SELECT count(*)::text AS n FROM ai_tasks WHERE project_id = $1',
      [project.id],
    );
    expect(taskCount[0]?.n).toBe('1');

    // --- pump 一片 --------------------------------------------------------
    const taskBefore = await call(baseUrl, jar, {
      method: 'GET',
      route: `/tasks/${accepted.taskId}`,
    });
    expect(taskBefore.response.status).toBe(200);
    const eTag = taskBefore.response.headers.get('etag');
    expect(eTag).not.toBeNull();
    // ETag 必须与库里那一行的 revision 是同一个数：pump 的 If-Match 判据
    // （`task-pump-store.ts` 的 `IF_MATCH_REVISION`）拿的就是它。两者不同源的话，
    // 一次「先 GET 拿 ETag、再 pump」的正常使用会**永远**撞 409，而这看起来像并发冲突。
    const revisionRow = await queryHarness<{ readonly revision: string }>(
      harness,
      'SELECT revision::text AS revision FROM ai_tasks WHERE id = $1',
      [accepted.taskId],
    );
    expect(revisionRow).toHaveLength(1);
    expect(eTag, `ai_tasks.revision = ${revisionRow[0]?.revision}`).toBe(
      `"rev-${revisionRow[0]?.revision}"`,
    );

    const callsBeforePump = standIn.calls.length;
    const pump = await call(baseUrl, jar, {
      method: 'POST',
      route: `/tasks/${accepted.taskId}:pump`,
      csrf: true,
      headers: { 'if-match': eTag ?? '' },
    });
    expect(pump.response.status, `pump 的响应体：${pump.text}`).toBe(200);
    const pumped = JSON.parse(pump.text) as { readonly outcome: string };
    expect(pumped.outcome).toBe('ADVANCED');
    // **执行器实数**：这一片只外呼一次，对面是本机 stand-in。
    expect(standIn.calls.length).toBe(callsBeforePump + 1);
    const outbound = standIn.calls[standIn.calls.length - 1];
    expect(outbound?.method).toBe('POST');
    expect(outbound?.path).toBe('/v1/forward/sessions');
    // 外呼真的带上了从库里解密出来的那份凭据（比相等性，不打印值）。
    expect(outbound?.authorization).toBe(`Bearer ${qcaPatPlaintext}`);
    // 一次外呼 = 一个幂等键，且它在**外呼之前**就已落库（§11.2 第 4 条）。
    expect(outbound?.idempotencyKey).not.toBeNull();
    expect(outbound?.idempotencyKey?.length).toBeGreaterThan(0);

    // 少带 `If-Match` ⇒ 400 `REQUEST_INVALID`，不是静默当成"任意版本"。
    //
    // 这里刻意**不**期待一个专属的 `IF_MATCH_REQUIRED`：错误码目录（42 个码，ZLQ-221 §8
    // 禁止改动）里没有这个码，`requireIfMatch` 走的就是通用 400。缺 `Idempotency-Key`
    // 之所以有专属码，是因为客户端的修复动作不同（"忘了带头" vs "带的头格式不对"）；
    // 而 `If-Match` 只由我们自己的前端回填，缺它一律是客户端 bug，不需要区分。
    const noIfMatch = await call(baseUrl, jar, {
      method: 'POST',
      route: `/tasks/${accepted.taskId}:pump`,
      csrf: true,
    });
    expect(noIfMatch.response.status).toBe(400);
    expect(envelopeCode(noIfMatch.text)).toBe('REQUEST_INVALID');
    // 那次失败的 pump 不许偷偷多外呼一次。
    expect(standIn.calls.length).toBe(callsBeforePump + 1);

    // --- 从真库读到真安全事件 ---------------------------------------------
    const eventRows = await queryHarness<{
      readonly sequence: string;
      readonly event_type: string;
      readonly safe_payload: unknown;
    }>(
      harness,
      'SELECT sequence, event_type, safe_payload FROM task_events WHERE task_id = $1 ORDER BY sequence',
      [accepted.taskId],
    );
    expect(eventRows.length).toBeGreaterThan(0);
    const progress = eventRows.filter((row) => row.event_type === 'PROGRESS');
    expect(progress.length).toBeGreaterThan(0);
    const payloadText = JSON.stringify(progress.map((row) => row.safe_payload));
    // 安全事件的"安全"就是这三条：不带会话令牌、不带凭据明文、不带 prompt 正文。
    expect(payloadText).not.toContain(qcaPatPlaintext);
    expect(payloadText).not.toContain(jar.session ?? '');
    expect(payloadText).not.toContain('做一只会跳的猫');
    expect(payloadText).not.toContain('猫');

    // 同一批事件也能从 HTTP 读回来（SSE 一次性有界刷出）。
    const stream = await call(baseUrl, jar, {
      method: 'GET',
      route: `/tasks/${accepted.taskId}/events`,
    });
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    const frames = stream.text
      .split('\n\n')
      .filter((frame) => frame.trim() !== '')
      .map((frame) => frame.split('\n')[0] ?? '');
    expect(frames.length).toBe(eventRows.length);
    expect(frames[0]).toBe(`id: ${eventRows[0]?.sequence}`);
    expect(stream.text).toContain('event: PROGRESS');
    expect(stream.text).not.toContain(qcaPatPlaintext);

    // --- 不得出现"假的成功" -----------------------------------------------
    const taskAfter = await call(baseUrl, jar, {
      method: 'GET',
      route: `/tasks/${accepted.taskId}`,
    });
    expect(taskAfter.response.status).toBe(200);
    // 线上的字段名是 `state`（`taskSchema` 逐字），不是 `status`。
    const after = JSON.parse(taskAfter.text) as { readonly state: string };
    expect(after.state).not.toBe('SUCCEEDED');
    const versions = await queryHarness<{ readonly id: string }>(
      harness,
      'SELECT id FROM versions WHERE project_id = $1',
      [project.id],
    );
    expect(versions).toHaveLength(0);
  });

  it('登出撤销库里的会话，被撤销的令牌立刻不可用', async () => {
    const jar = emptyJar();
    await call(baseUrl, jar, {
      method: 'POST',
      route: '/auth/login',
      body: { loginName: studentLoginName, password: studentPassword },
    });
    const token = jar.session;
    expect(token).not.toBeNull();

    const logout = await call(baseUrl, jar, { method: 'POST', route: '/auth/logout', csrf: true });
    expect(logout.response.status).toBe(204);
    expect(logout.text).toBe('');
    expect(jar.session).toBeNull();
    expect(jar.csrf).toBeNull();

    // `bytea` 形参一律传 `Buffer`（node-postgres 把 `Uint8Array` 序列化成别的东西）。
    // `account_sessions` 没有 `revoked_at` 列 —— 撤销写在 `status`（`ACCOUNT_SESSION_STATUSES`
    // = ACTIVE / EXPIRED / REVOKED），撤销时刻与原因在 `payload` jsonb 里。
    const revoked = await queryHarness<{ readonly status: string }>(
      harness,
      'SELECT status FROM account_sessions WHERE token_hash = $1',
      [Buffer.from(hex(random.sha256(token ?? '')), 'hex')],
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.status).toBe('REVOKED');

    // 拿旧令牌再试一次：必须被拒。撤销不是"标记一下"，而是立刻生效。
    const reused = await call(
      baseUrl,
      { session: token, csrf: hex(random.bytes(32)) },
      { method: 'GET', route: '/projects' },
    );
    expect(reused.response.status).toBe(401);
    expect(envelopeCode(reused.text)).toBe('AUTHENTICATION_REQUIRED');
  });
});

/**
 * `bootstrap/function.ts` —— Vercel 函数入口的验收测试。
 *
 * ## 这份文件证的是哪几条
 *
 * 派单给 D-1 的三条判据，逐条对上下面五组：
 *
 * 1. 「handler 导出 default、服务 `/api/v1/*`」⇒ 第 1 组（含平台函数文件与 `vercel.json`
 *    的逐字节钉住）与第 2 组的真实 HTTP 往返。
 * 2. 「`getFormBContainer` 的进程级记忆化没被破坏（冷启动只装配一次）」⇒ 第 3 组。
 * 3. 「仓库根没有第二份 Vercel 入口」⇒ 第 1 组那条 `existsSync`。
 *
 * 另外两组是本轮红线的**入口级**证据：第 4 组证装配失败时出去的是 §5.4 已冻结的
 * `INTERNAL_ERROR` 信封（不新增错误码）且日志里没有任何凭据值（§2.2）；第 5 组证
 * 走**生产入口**时 setup 那条路没被锁死（§2.1 line 77）、业务端点按冻结码拒。
 *
 * ## 🚨 记忆化那条为什么用"两份不同的环境"来证，而不是数调用次数
 *
 * 判据是**行为**：冷启动装配一次、之后的请求复用。数 `getFormBContainer` 的调用次数证不了
 * 这件事 —— 它按设计每请求都要调一次（记忆化在它**内部**）。真正可观测的是
 * `vercel.ts:508` 那条「入参只在**第一次**生效」：
 *
 * - 先用**合法**环境起一个 handler、打一次请求 ⇒ 容器被装配并记住；
 * - 再用一个**致命**环境（缺 `LITTLEQ_DEPLOYMENT`）的 handler 打同一路径 ⇒ 仍然 200。
 *   如果入口每请求重新装配，这一发必然走进 `sendBootstrapFailure` 拿到 500。
 * - **阳性对照**：`resetFormBContainer()` 之后，同一个致命环境的 handler ⇒ **500**。
 *   没有这一臂，上面那个 200 可能只是"致命环境其实不致命"，那条对照就永远绿。
 *
 * ## 数据库不可达是刻意的（与 `bootstrap-container.test.ts` 同一条理由）
 *
 * 运行侧那条腿是 `createNeonClientSource`（Neon 的 WebSocket `Pool`），连不上本机
 * Postgres。所以本文件在一个**立即 ECONNREFUSED** 的地址（`127.0.0.1:1` 的同族写法：
 * 一个解析得到但拒连的主机名）上证"进程 live"，而"迁移能跑通"那半边在
 * `bootstrap-migrate-database.test.ts` 里用真库证。
 *
 * ## 凭据值
 *
 * 所有哨兵（主密钥、连接串里的用户/口令）都是**运行时随机生成**的，源码里没有字面值。
 * 第 4 组带阳性对照：先证明"探针真的看得见哨兵"，再断言日志里没有。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { errorDefinition, httpStatusOf, isErrorCode, parseSessionTtlPolicy } from '@littleq/domain';
// ⚠️ 子路径导入。桶里刻意只给**类型**（re-export `createWorkScanner` 会把 acorn / parse5 /
// postcss 拖进浏览器产物）；真实 Node 按 `exports["./scan"].node` 解析得到，vitest 靠
// `vitest.config.ts` 里那条**单独补的**子路径别名解析得到。生产入口用的就是这一条路径，
// 所以测试也要用它 —— 用相对路径绕过去的话，"子路径在测试里解析不到"这个回归就没人守着。
import { createWorkScanner } from '@littleq/work-contract/scan';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { FORM_B_ENV_VARS } from '../src/bootstrap/config.js';
import defaultHandler, {
  PROCESS_SECURE_COOKIES,
  PROCESS_SESSION_TTL,
  createFunctionHandler,
} from '../src/bootstrap/function.js';
import {
  getFormBContainer,
  resetFormBContainer,
  type FormBContainer,
} from '../src/bootstrap/vercel.js';

/** 仓库根：本文件在 `<root>/apps/api/test/`。 */
const REPO_ROOT = join(import.meta.dirname, '../../..');
const API_ROOT = join(import.meta.dirname, '..');

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** 运行时生成的哨兵；源码里没有任何字面值，交付说明里也不会出现。 */
const SENTINELS = {
  masterKey: hex(32),
  runtimeUser: `lq_rt_${hex(6)}`,
  runtimePassword: hex(12),
} as const;

const SENTINEL_VALUES: readonly string[] = Object.values(SENTINELS);

/** 拒连（不是黑洞）的池化地址。主机名刻意**含** `-pooler`：形态 B 的运行串是池化串。 */
const UNREACHABLE_POOLED_URL =
  `postgres://${SENTINELS.runtimeUser}:${SENTINELS.runtimePassword}` +
  `@ep-lq-entry-pooler.neon.example:5432/neondb?sslmode=require&channel_binding=require`;

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [FORM_B_ENV_VARS.deployment]: 'B',
    [FORM_B_ENV_VARS.databaseUrl]: UNREACHABLE_POOLED_URL,
    [FORM_B_ENV_VARS.sourceCodeUrl]: 'https://github.com/example/littleq',
    [FORM_B_ENV_VARS.masterKey]: SENTINELS.masterKey,
    ...overrides,
  };
}

/** 断言一段文本里没有任何一个哨兵。 */
function expectNoSentinel(text: string): void {
  for (const sentinel of SENTINEL_VALUES) {
    expect(text, `输出里出现了哨兵（长度 ${String(sentinel.length)}）`).not.toContain(sentinel);
  }
  expect(text).not.toContain('postgres://');
}

/** 把 handler 挂到一个真的 `node:http` server 上（Vercel 的 Node runtime 就是这么调它的）。 */
async function serve(handler: ReturnType<typeof createFunctionHandler>): Promise<{
  readonly baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('没有拿到监听地址');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

/** 记住装配出来的容器，测试结束时关掉连接池。 */
const built: FormBContainer[] = [];

/**
 * 取出**已经被记住**的那个容器（`getFormBContainer` 的入参只在第一次生效，所以这里传的
 * 一组只是为了满足签名；缓存命中时它被忽略）。顺带登记进 {@link built} 以便收尾关池。
 */
async function cachedContainer(): Promise<FormBContainer> {
  const container = await getFormBContainer({
    env: validEnv(),
    sessionTtl: PROCESS_SESSION_TTL,
    workerId: 'function-entry-test',
    secureCookies: PROCESS_SECURE_COOKIES,
    scanner: createWorkScanner(),
  });
  if (!built.includes(container)) built.push(container);
  return container;
}

async function drainContainers(): Promise<void> {
  while (built.length > 0) {
    const container = built.pop();
    if (container !== undefined) await container.close();
  }
}

afterAll(async () => {
  await drainContainers();
});

afterEach(() => {
  resetFormBContainer();
});

describe('平台契约：handler 导出 default、函数文件与 vercel.json 逐字节钉住', () => {
  it('default 导出是一个 (req, res) 处理器', () => {
    expect(typeof defaultHandler).toBe('function');
    // 两格 == `node:http` 的监听器签名。Vercel 的 Node runtime 按这个签名调它。
    expect(defaultHandler.length).toBe(2);
  });

  it('平台函数文件只有一行 re-export，且指向编译产物而不是 src', () => {
    const entryPath = join(API_ROOT, 'api/v1/[...path].js');
    expect(existsSync(entryPath), '平台函数文件不存在').toBe(true);
    const code = readFileSync(entryPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n')
      .trim();
    // 逐字节：这一行是本文件与平台之间唯一的耦合面。改成 `.ts`、改成指向 `src/`、
    // 或者顺手加点逻辑，都会让"编译产物没被 tsc 覆盖"或"平台函数不受测试"这两件事之一发生。
    expect(code).toBe("export { default } from '../../dist/bootstrap/function.js';");
    // 阳性对照：同一份文本里必须能找到那个相对路径的**目标**，否则"钉住了一行"可能
    // 只是因为读到了一个空文件。
    expect(existsSync(join(API_ROOT, 'dist/bootstrap/function.js'))).toBe(true);
  });

  it('apps/api/vercel.json 的键集与取值都被钉住（多一键、少一键都红）', () => {
    const raw = readFileSync(join(API_ROOT, 'vercel.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      '$schema',
      'buildCommand',
      'framework',
      'installCommand',
      'outputDirectory',
    ]);
    expect(parsed).toEqual({
      $schema: 'https://openapi.vercel.sh/vercel.json',
      // 不是 Next/Vite：本项目只有 `api/` 下的 Node 函数。留空让平台去猜，猜错的表现
      // 是构建命令与产物目录一起跑偏，而那种失败只在平台上复现。
      framework: null,
      // 与 `.github/workflows/ci.yml` 的 install 步骤逐字一致。
      installCommand: 'pnpm install --frozen-lockfile',
      // 尾部三个点 = 本包 + 它的工作区依赖；函数入口 re-export 的是 dist 产物，
      // 而被依赖的各包一律解析到自己的 `dist/index.js` ⇒ 必须先编译出来。
      buildCommand: 'pnpm --filter @littleq/api... build',
      // **安全相关**：留空让平台去推，推出来的默认值是 Root Directory 本身，
      // 那等于把 `apps/api/src/**` 当静态文件上传成公开可读。
      outputDirectory: null,
    });
  });

  it('仓库根没有第二份 Vercel 入口', () => {
    expect(existsSync(join(REPO_ROOT, 'vercel.json'))).toBe(false);
    // 阳性对照：证明上面那个 `false` 不是因为路径算错了 —— 同一个 `REPO_ROOT` 底下
    // 确实能找到那份**已经存在**的 `apps/web/vercel.json`。
    expect(existsSync(join(REPO_ROOT, 'apps/web/vercel.json'))).toBe(true);
    // 全仓只允许两份 Vercel 入口文件：`apps/web` 的（既有，本轮未动）与 `apps/api` 的（本轮新增）。
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '.next') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === 'vercel.json') found.push(full.slice(REPO_ROOT.length + 1));
      }
    };
    walk(REPO_ROOT);
    expect(found.sort()).toEqual(['apps/api/vercel.json', 'apps/web/vercel.json']);
  });

  it('apps/api 里没有任何地方读 LQ_API_ORIGIN（那个变量只属于 apps/web 的服务端）', () => {
    // 裁定一：前后端通过 `apps/web` 的**服务端**代理相连，`LQ_API_ORIGIN` 由代理读。
    // 后端去读它就意味着第二个事实源，也意味着"目标地址在后端也配了一份"。
    //
    // ⚠️ 匹配的是**读取形态**（带引号的键名 / 属性访问），不是裸标识符：
    // `src/bootstrap/function.ts` 的文件头**写着这个变量名**，为的是申报"它不在本轮范围"。
    // 用裸标识符做零命中门，会因为"写着这条门的注释"而变红。
    const READ_FORM = /['"[.]LQ_API_ORIGIN/;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|js|json|mjs)$/.test(name) && READ_FORM.test(readFileSync(full, 'utf8'))) {
          hits.push(full.slice(API_ROOT.length + 1));
        }
      }
    };
    walk(API_ROOT);
    // 本测试文件自己会命中（它的阳性对照里写着这个键名），所以断言的是"除测试外零命中"。
    expect(hits.filter((path) => !path.startsWith('test/'))).toEqual([]);
    // 阳性对照之一：正则本身没写错 —— 它匹配 `api-proxy.ts` 里那份**真实**的定义。
    expect(
      READ_FORM.test(readFileSync(join(REPO_ROOT, 'apps/web/src/api-proxy.ts'), 'utf8')),
    ).toBe(true);
    // 阳性对照之二：它也能匹配"后端偷偷去读"的三种写法，否则上面那条零命中是假绿。
    expect(READ_FORM.test("process.env['LQ_API_ORIGIN']")).toBe(true);
    expect(READ_FORM.test('env.LQ_API_ORIGIN')).toBe(true);
    expect(READ_FORM.test('const key = "LQ_API_ORIGIN";')).toBe(true);
  });
});

describe('CSP 未被放宽：本轮没有碰过 apps/web 的任何一行', () => {
  it('apps/web/vercel.json 里 connect-src 仍然只有 self', () => {
    const raw = readFileSync(join(REPO_ROOT, 'apps/web/vercel.json'), 'utf8');
    // 这条不是"文件没变"的证明（那由交付说明里的 `git diff` 给），而是"就算有人改了，
    // 也必须先把这条门改掉"的锁：`connect-src` 后面**紧跟** `'self'`，不允许出现第二个源。
    const connectSrc = /connect-src\s+([^;"]*)/.exec(raw)?.[1]?.trim() ?? '';
    expect(connectSrc).toBe("'self'");
    // 阳性对照：同一条正则在"被放宽"的写法上必须给出不同的答案。
    const relaxed = "connect-src 'self' https://api.example.com;";
    expect(/connect-src\s+([^;"]*)/.exec(relaxed)?.[1]?.trim()).not.toBe("'self'");
  });
});

describe('进程级记忆化：冷启动只装配一次', () => {
  const fatalEnv = validEnv({ [FORM_B_ENV_VARS.deployment]: undefined });

  it('第一个 handler 装配成功；随后一个**致命环境**的 handler 仍然拿到 200（记忆生效）', async () => {
    const warm = await serve(createFunctionHandler({ env: validEnv() }));
    const first = await getJson(warm.baseUrl, '/api/v1/health/live');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'ok' });
    await warm.close();

    // 入参只在第一次生效（`vercel.ts:508`）。如果入口每请求重新装配，这一发就是 500。
    const poisoned = await serve(createFunctionHandler({ env: fatalEnv }));
    const second = await getJson(poisoned.baseUrl, '/api/v1/health/live');
    await poisoned.close();
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'ok' });

    const container = await cachedContainer();
    expect(container.providerLegConfigured).toBe(false);
  });

  it('阳性对照：reset 之后同一个致命环境的 handler 真的回 500 冻结信封', async () => {
    resetFormBContainer();
    const logs: string[] = [];
    const cold = await serve(createFunctionHandler({ env: fatalEnv, log: (line) => logs.push(line) }));
    const response = await getJson(cold.baseUrl, '/api/v1/health/live');
    await cold.close();

    expect(response.status).toBe(httpStatusOf('INTERNAL_ERROR'));
    expect(response.status).toBe(500);
    const envelope = response.body as Record<string, unknown>;
    const definition = errorDefinition('INTERNAL_ERROR');
    expect(envelope.code).toBe('INTERNAL_ERROR');
    expect(envelope.messageKey).toBe(definition.messageKey);
    expect(envelope.retryable).toBe(definition.retryable);
    expect(typeof envelope.traceId).toBe('string');
    // 这一臂同时是上一条的对照：致命环境确实致命，那个 200 不是"环境根本没被读"。
    expect(logs.join('\n')).toContain('DEPLOYMENT_FORM_MISSING');
  });

  it('源码级守卫：入口只调记忆化出口，不调装配、不调重置、不重复读 process.env', () => {
    const source = readFileSync(join(API_ROOT, 'src/bootstrap/function.ts'), 'utf8');
    const count = (pattern: RegExp): number => source.match(pattern)?.length ?? 0;

    // ⚠️ 一律匹配**调用形态**：文件头的散文里写着 `createFormBContainer` 与
    // `resetFormBContainer` 这两个名字（为的是申报"绝不调它们"），用裸标识符做零命中门
    // 会因为"写着这条门的注释"而变红。
    expect(count(/\bgetFormBContainer\s*\(/g)).toBe(1);
    expect(count(/\bcreateFormBContainer\s*\(/g)).toBe(0);
    expect(count(/\bresetFormBContainer\s*\(/g)).toBe(0);
    // 阳性对照：这三条正则各自都能匹配它们要拦/要数的写法，否则上面的 0 与 1 是假绿。
    expect(/\bgetFormBContainer\s*\(/.test('await getFormBContainer(inputs)')).toBe(true);
    expect(/\bcreateFormBContainer\s*\(/.test('await createFormBContainer(inputs)')).toBe(true);
    expect(/\bresetFormBContainer\s*\(/.test('resetFormBContainer();')).toBe(true);

    // 环境变量只有一处出处：`options.env ?? process.env` 那个默认值。第二次出现就意味着
    // 有另一条配置路径（例如某个函数自己再去读 `process.env`），那条路不在测试的注入范围内。
    expect(count(/process\.env/g)).toBe(1);
    expect(/process\.env/.test('const env = options.env ?? process.env;')).toBe(true);
  });
});

describe('装配失败：出去的是冻结码信封，日志里没有任何凭据值（§2.2）', () => {
  it('探针阳性对照：expectNoSentinel 真的看得见哨兵', () => {
    expect(() => expectNoSentinel(SENTINELS.masterKey)).toThrow();
    expect(() => expectNoSentinel(UNREACHABLE_POOLED_URL)).toThrow();
    expect(() => expectNoSentinel('这一行没有凭据')).not.toThrow();
  });

  it('主密钥缺失 ⇒ 500 INTERNAL_ERROR 信封；日志只有 name + 固定码，没有值', async () => {
    resetFormBContainer();
    const logs: string[] = [];
    const server = await serve(
      createFunctionHandler({
        env: validEnv({ [FORM_B_ENV_VARS.masterKey]: undefined }),
        log: (line) => logs.push(line),
      }),
    );
    const response = await getJson(server.baseUrl, '/api/v1/health/live');
    await server.close();

    expect(response.status).toBe(500);
    const envelope = response.body as Record<string, unknown>;
    const code = envelope.code;
    // **不新增错误码**：出去的码必须在 §5.4 那份冻结目录里。
    expect(typeof code).toBe('string');
    expect(typeof code === 'string' && isErrorCode(code)).toBe(true);
    expect(code).toBe('INTERNAL_ERROR');

    const text = logs.join('\n');
    expect(text).not.toBe('');
    // 固定码被打出来了（运维拿它去 `.env.example` 对，不需要看值），值一个都没有。
    expect(text).toContain('MASTER_KEY_UNAVAILABLE');
    expectNoSentinel(text);
    expectNoSentinel(JSON.stringify(response.body));
  });

  it('响应体永远是契约信封的形状，不是栈、不是原始异常文本', async () => {
    resetFormBContainer();
    const server = await serve(
      createFunctionHandler({
        env: validEnv({ [FORM_B_ENV_VARS.sourceCodeUrl]: undefined }),
        log: () => undefined,
      }),
    );
    const response = await fetch(`${server.baseUrl}/api/v1/health/live`);
    const text = await response.text();
    await server.close();

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const envelope = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(['code', 'messageKey', 'retryable', 'traceId']);
    // 栈帧里会带着路径与（可能的）参数。它出现在响应体里就是 §2.2 的违例。
    expect(text).not.toContain('at ');
    expect(text).not.toContain('Error:');
    expectNoSentinel(text);
  });
});

describe('走生产入口时：进程 live、setup 未锁死、业务端点按冻结码拒（§2.1 line 77）', () => {
  it('live 200 / projects 401 / settings PUT 不是 404 或 500', async () => {
    resetFormBContainer();
    const server = await serve(createFunctionHandler({ env: validEnv(), log: () => undefined }));
    try {
      const live = await getJson(server.baseUrl, '/api/v1/health/live');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'ok' });

      // ready 是阴性对照：它必须**真的**去问 DB（于是 503），否则上面那个 200 什么也证不了。
      const ready = await getJson(server.baseUrl, '/api/v1/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });

      const projects = await getJson(server.baseUrl, '/api/v1/projects');
      expect(projects.status).toBe(401);
      expect(projects.body).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

      // F4 的验收判据落在这条路径上：装配缺腿不许把它一起锁死。
      // 401/403/422 都算通过（未带会话/CSRF 时的冻结码）；404 与 500 不算。
      const put = await fetch(`${server.baseUrl}/api/v1/settings/secrets/QCA_PAT`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(put.status).not.toBe(404);
      expect(put.status).not.toBe(500);

      const container = await cachedContainer();
      expect(container.providerLegConfigured).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('入口不注入 provider ⇒ 容器上如实记着 degraded，而不是一份编造出来的凭据', async () => {
    const source = readFileSync(join(API_ROOT, 'src/bootstrap/function.ts'), 'utf8');
    // 注入 provider 的唯一写法是给 `buildProcessInputs` 的返回对象加两个字段。
    // 匹配**赋值形态**，于是文件头那段申报（只写名字、不带冒号赋值）不会误伤。
    expect(/provider\s*:/.test(source)).toBe(false);
    expect(/providerConfiguration\s*:/.test(source)).toBe(false);
    expect(/scanConfiguration\s*:/.test(source)).toBe(false);
    // 阳性对照：同一条正则必须能匹配它要拦的那个写法。
    expect(/provider\s*:/.test('provider: createTurnProviderClient({}),')).toBe(true);
  });
});

describe('待裁的具名常量：值只此一处，改它会在 CI 上被看见', () => {
  it('PROCESS_SESSION_TTL 与仓库里两处已有装配用的是同一组数字', () => {
    expect(PROCESS_SESSION_TTL).toEqual(
      parseSessionTtlPolicy({
        idleMinutes: 30,
        absoluteMinutes: 120,
        rememberMeIdleMinutes: 720,
        rememberMeAbsoluteMinutes: 4320,
      }),
    );
    expect(PROCESS_SECURE_COOKIES).toBe(true);
  });

  it('这四个数字在生产源码里只出现在一处（没有第二个事实源）', () => {
    // ⚠️ 匹配的是**定义形态**（`rememberMeAbsoluteMinutes:` 后面跟值），不是裸标识符：
    // `src/server/http.ts:370` 也写着这个名字，但那是**读** `services.sessionTtl.…`，
    // 它恰恰是"值只有一处、别处只消费"的证据，不是第二处事实源。
    const DEFINITION = /rememberMeAbsoluteMinutes\s*:\s*\d+/;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.ts$/.test(name) && DEFINITION.test(readFileSync(full, 'utf8'))) {
          hits.push(full.slice(API_ROOT.length + 1));
        }
      }
    };
    walk(join(API_ROOT, 'src'));
    expect(hits).toEqual(['src/bootstrap/function.ts']);
    // 阳性对照：正则没写错，且 `http.ts` 那处**读**确实存在（否则"只有一处定义"
    // 可能只是因为整个仓库都还没接线）。
    expect(DEFINITION.test('rememberMeAbsoluteMinutes: 4320,')).toBe(true);
    expect(
      readFileSync(join(API_ROOT, 'src/server/http.ts'), 'utf8'),
    ).toContain('services.sessionTtl.rememberMeAbsoluteMinutes');
  });
});

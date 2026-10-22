#!/usr/bin/env node
/**
 * 站点构建产物的存在性与合规标记检查（ZLQ-190 §6.1 的 `build` 门禁；ZLQ-232 按架构师
 * ZLQ-233 的 Q3-补-1 ～ Q3-补-3 裁定**原地改造**为「文件侧 + HTTP 侧」的混合门）。
 *
 * ## 为什么必须有这一步
 *
 * `build` 过去只跑 `tsc -b`，产物是 `apps/web/dist/index.js`。加了 Next 之后，
 * **`tsc -b` 成功不再意味着站点被构建出来了** —— 类型检查通过而 `next build` 失败、
 * 或者产物形态被改掉因而页面根本没生成，都能让旧门禁全绿。§6.1 的原话是
 * 「不得仅凭旧的 `dist/index.js` 通过」。这句话在服务构建下**更**成立，不是更弱。
 *
 * ## 为什么从「静态导出目录」改成「文件侧 + HTTP 侧」
 *
 * ZLQ-232 把 `apps/web` 从 `output:'export'` 翻成服务构建（Q3 裁定），`out/` 不再产生。
 * 但**门禁可以改变断言形态，不得丢失任何一条断言意图**（Q3-补-4 的反削弱条款）。
 * 于是原先钉在 `out/` 上的六件事被逐一搬到新的稳定契约上：
 *
 * - **「站点真的被构建出来了」** → 文件侧 `.next/BUILD_ID` 存在且非空。
 * - **「令牌真的被打进产物 CSS」** → 文件侧 `.next/static/**\/*.css` 递归至少一份非空、
 *   且至少一份含 `--lq-`。递归是硬要求：ZLQ-219 的 Next 16.4.2 生产日志里 CSS 落在
 *   `_next/static/immutable/chunks/`，中间目录名是实现细节，钉死 `chunks/` 会假红。
 * - **「法务文件真的进了部署产物」** → 先查 `apps/web/public/` 四份源文件存在且非空
 *   （Q3-补-2 要求的**先**文件后 URL），再由 HTTP 侧确认四个 URL 都 200 且非空，
 *   并把**响应字节与 `public/` 文件逐字节比较** —— 否则「部署出去的那份」可以和
 *   「仓库里被门禁盯着的那份」悄悄漂移，而 AGPL-3.0 §13 要求的正是前者的准确性。
 * - **「首页与法务页真的能打开、合规标记真的在里面」** → HTTP 侧起一次本地生产服务，
 *   `GET /` 与 `GET /source-and-license/` 必须**直接** 200（`redirect:'manual'`），
 *   正文非空，且逐条命中各自的标记。
 *
 * ## 为什么页面契约走 HTTP 而不是 `.next/server/app/**\/*.html`
 *
 * 那些文件名会随预渲染/动态渲染策略、Next 版本与路由形态漂移，不是一个稳定接口；
 * 而 HTTP 是页面与动态路由**共享**的那一份契约（Q3-补-1 的理由，逐字采纳）。
 * 反过来，CSS 有稳定的构建根 `.next/static/`，所以令牌断言留在文件侧 —— 起服务查 CSS
 * 只会把一条文件事实变成一条网络事实，多一处可以假绿的地方。
 *
 * ## 刻意**不**断言的东西
 *
 * **不断言页面元素个数、不断言测试条数、不断言产物字节数或文件数、不钉令牌变量个数。**
 * 那些都是观测量，写进门禁就变成每次改版都要同步修改的假契约（既有裁定）。
 * 也不得把 ZLQ-219 日志里的「2 行 CSS」误读成令牌数量下限（Q3-补-3）。
 * 文案层面的断言（诚实状态条、分龄档位、主行动真实性）交给 vitest 与 e2e，
 * 因为它们能直接引用 `apps/web/src/site-content.ts` 这唯一一份文案出处。
 *
 * ## 失败姿态
 *
 * 任何一条不成立就退出 1，并打印**具体 URL 或相对路径**。失败信息按六类加前缀，
 * 便于把「产物没建出来」和「服务起不来」和「URL 404」区分开，而不是全都长得像连接失败：
 * 构建产物缺失 / 服务启动超时（或失败）/ URL·状态码·空正文 / 缺失标记 / CSS 缺失 / 令牌缺失。
 * 文件侧已经红了就**不再起服务** —— 否则真因（产物缺失）会被一屏连接失败淹掉。
 *
 * 这道门留在 `pnpm verify` 第 7 门（`build` → `web:build` → `web:export:check`）之内，
 * 不移出、不改键名（Q3-补-4：改名等于用改名掩盖删除门禁）。`e2e-smoke` 可以复验，
 * **不得替代**它。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 站点包相对仓库根的位置。 */
export const WEB_DIR = 'apps/web';

/** 构建产物侧：服务构建的 BUILD_ID（`.next/BUILD_ID`）。 */
export const BUILD_ID_PATH = '.next/BUILD_ID';

/** 构建产物侧：CSS 的递归搜索根。**不得**收窄成 `.next/static/chunks`。 */
export const STATIC_DIR = '.next/static';

/** 设计令牌的判定前缀。只判「有没有」，不判「有几个」。 */
export const TOKEN_PREFIX = '--lq-';

/**
 * 法务资产：部署后的 URL ↔ `apps/web/public/` 下的相对位置。
 * 这四份由 `tools/prepare-web-legal.mjs` 在 `web:build` 期间从仓库根**逐字节复制**过来。
 */
export const LEGAL_ASSETS = [
  { url: '/legal/AGPL-3.0.txt', publicPath: 'legal/AGPL-3.0.txt' },
  { url: '/legal/NOTICE.txt', publicPath: 'legal/NOTICE.txt' },
  { url: '/legal/THIRD_PARTY_LICENSES.txt', publicPath: 'legal/THIRD_PARTY_LICENSES.txt' },
  { url: '/licenses.txt', publicPath: 'licenses.txt' },
];

/**
 * 页面契约：URL ↔ 该页正文里必须出现的标记。
 *
 * `data-design-system-unit` 证明视觉基线真的取自 workspace 包（§5.2）；
 * `AGPL-3.0-only` 证明许可证声明进了**部署产物**而不只是仓库（验收标准 5）。
 * `/source-and-license/` 带尾斜杠是 `next.config.ts` 的 `trailingSlash: true` 决定的，
 * 且必须**直接** 200 —— 一个重定向后的 200 会掩盖错误路径（Q3-补-2 的硬约束）。
 */
export const PAGE_CONTRACTS = [
  {
    url: '/',
    markers: ['data-design-system-unit="@littleq/design-system"', 'AGPL-3.0-only'],
  },
  { url: '/source-and-license/', markers: ['AGPL-3.0-only'] },
];

/** `next start` 的就绪上限。太短会在冷容器里假红，太长会让门禁失去反馈速度。 */
export const START_TIMEOUT_MS = 30_000;

/** 单次请求上限。 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** 就绪轮询间隔。 */
export const POLL_INTERVAL_MS = 250;

/** SIGTERM 之后等这么久，仍活着就 SIGKILL。 */
export const STOP_GRACE_MS = 5_000;

/**
 * 递归收集 `STATIC_DIR` 下的全部 `.css`（绝对路径）。
 *
 * 手写递归而不用 `readdirSync(…, { recursive: true })`：后者返回的相对路径与
 * `withFileTypes` 的 `parentPath` 组合在各 Node 版本上形状不一致，而这里只需要
 * 「有哪些 css 文件」这一个事实。
 */
export function collectCssFiles(webDir) {
  const root = join(webDir, STATIC_DIR);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.css')) found.push(absolute);
    }
  };
  walk(root);
  return found;
}

/**
 * 文件侧之一：服务构建产物存在。
 *
 * 只认 `BUILD_ID`。**不得**改回认 `.next/server/app/**\/*.html` 是否存在 ——
 * 那些文件名随预渲染策略与 Next 版本漂移（Q3-补-1）。
 */
export function checkBuildArtefacts(webDir) {
  const failures = [];
  const buildId = join(webDir, BUILD_ID_PATH);
  if (!existsSync(buildId) || !statSync(buildId).isFile()) {
    failures.push(
      `构建产物缺失：${WEB_DIR}/${BUILD_ID_PATH} 不存在 —— ` +
        `\`next build\` 没有产出服务构建产物（先跑 pnpm web:build）`,
    );
    return failures;
  }
  if (readFileSync(buildId, 'utf8').trim().length === 0) {
    failures.push(`构建产物缺失：${WEB_DIR}/${BUILD_ID_PATH} 是空的`);
  }
  return failures;
}

/**
 * 文件侧之二：设计令牌真的被打进产物 CSS。
 *
 * 口径不变（Q3-补-3）：至少一份非空 CSS，且至少一份含 `--lq-`。
 * 不钉变量个数、文件数、字节数或固定文件名 —— 那些都是观测量。
 */
export function checkCssTokens(webDir) {
  const failures = [];
  const cssFiles = collectCssFiles(webDir);
  if (cssFiles.length === 0) {
    failures.push(
      `CSS 缺失：${WEB_DIR}/${STATIC_DIR} 下递归找不到任何 *.css —— ` +
        `tokens.css 没有被打进服务构建产物`,
    );
    return failures;
  }
  let nonEmpty = 0;
  let withToken = 0;
  for (const file of cssFiles) {
    const content = readFileSync(file, 'utf8');
    if (content.trim().length > 0) nonEmpty += 1;
    if (content.includes(TOKEN_PREFIX)) withToken += 1;
  }
  if (nonEmpty === 0) {
    failures.push(`CSS 缺失：${WEB_DIR}/${STATIC_DIR} 下 ${cssFiles.length} 份 .css 全部为空`);
    // 空文件里当然也没有令牌，但真因是「CSS 是空的」；同时报两条会把真因稀释掉。
    return failures;
  }
  if (withToken === 0) {
    failures.push(
      `令牌缺失：产物 CSS 里找不到任何 ${TOKEN_PREFIX}* 设计令牌，` +
        `packages/design-system/src/tokens.css 没有被打进站点（只查源码 tokens.css 不算数）`,
    );
  }
  return failures;
}

/**
 * 文件侧之三：四份法务文件的**源**存在且非空。
 *
 * Q3-补-2 要求先查文件、再查 URL：URL 200 但内容是空的、或者服务把别的东西
 * 塞在那个路径上，都不该被算成「法务义务已履行」。
 */
export function checkPublicLegalFiles(webDir) {
  const failures = [];
  for (const asset of LEGAL_ASSETS) {
    const absolute = join(webDir, 'public', asset.publicPath);
    const relative = `${WEB_DIR}/public/${asset.publicPath}`;
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      failures.push(
        `法务源文件缺失：${relative} —— tools/prepare-web-legal.mjs 没有跑，` +
          `或它在仓库根/artifacts 里的来源缺失`,
      );
      continue;
    }
    if (statSync(absolute).size === 0) {
      failures.push(`法务源文件为空：${relative}`);
    }
  }
  return failures;
}

/** 一次带超时、不跟随重定向的 GET。返回 `{ body, response }` 或 `{ failure }`。 */
async function fetchOnce(fetchImpl, origin, path) {
  const url = `${origin}${path}`;
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { response, body: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    return {
      failure:
        `URL 不可用：${path} 请求失败（${url}）—— ${error.name}: ${error.message}` +
        `（单次请求上限 ${REQUEST_TIMEOUT_MS} ms）`,
    };
  }
}

/**
 * HTTP 侧：起一次本地生产服务，逐个 URL 断言。
 *
 * 收 `origin` 而不是自己起服务，是为了让 `tools/test/web-export-check.test.mjs` 能用
 * 一个**临时** `node:http` 服务把每条断言单独打红 —— 变异对照不许碰真产物、也不许
 * 真的去起 `next start`（Q3-补-4）。
 */
export async function checkHttpSide({ origin, webDir, fetchImpl = fetch }) {
  const failures = [];

  for (const page of PAGE_CONTRACTS) {
    const result = await fetchOnce(fetchImpl, origin, page.url);
    if (result.failure !== undefined) {
      failures.push(result.failure);
      continue;
    }
    if (result.response.status !== 200) {
      // `redirect:'manual'` 之下 3xx 会原样落在这里：重定向后的 200 不得掩盖错误路径。
      failures.push(
        `状态码不符：${page.url} 返回 ${result.response.status}，要求**直接** 200` +
          `（不允许靠重定向凑成一个 200）`,
      );
      continue;
    }
    const body = result.body.toString('utf8');
    if (body.trim().length === 0) {
      failures.push(`正文为空：${page.url} 返回 200 但正文是空的`);
      continue;
    }
    for (const marker of page.markers) {
      if (!body.includes(marker)) {
        failures.push(`缺失标记：${page.url} 的正文里没有 ${marker}`);
      }
    }
  }

  for (const asset of LEGAL_ASSETS) {
    const result = await fetchOnce(fetchImpl, origin, asset.url);
    if (result.failure !== undefined) {
      failures.push(result.failure);
      continue;
    }
    if (result.response.status !== 200) {
      failures.push(
        `状态码不符：${asset.url} 返回 ${result.response.status}，要求 200` +
          `（法务文件必须真的由这次构建的站点提供）`,
      );
      continue;
    }
    if (result.body.length === 0) {
      failures.push(`正文为空：${asset.url} 返回 200 但正文是空的`);
      continue;
    }
    // 逐字节比较：发布出去的法务文本不得与仓库里被 license:third-party:check 盯着的
    // 那份漂移。源文件缺失时 checkPublicLegalFiles 已经报过，这里不重复报。
    const source = join(webDir, 'public', asset.publicPath);
    if (existsSync(source) && !readFileSync(source).equals(result.body)) {
      failures.push(
        `法务内容漂移：${asset.url} 的响应字节与 ${WEB_DIR}/public/${asset.publicPath} ` +
          `不一致（${result.body.length} 字节 vs ${statSync(source).size} 字节）`,
      );
    }
  }

  return failures;
}

/**
 * 向内核要一个空闲端口再立刻释放 —— **不许写死 3000**（Q3-补-1 的硬约束）。
 *
 * 释放与 `next start` 绑定之间有极小的竞态窗口；这是标准做法，且失败会表现为
 * 服务启动超时并被如实报出，不会静默通过。
 */
export async function reserveDynamicPort(hostname = '127.0.0.1') {
  const probe = createServer();
  await new Promise((ok, fail) => {
    probe.once('error', fail);
    probe.listen(0, hostname, ok);
  });
  const { port } = probe.address();
  await new Promise((ok, fail) => {
    probe.once('error', fail);
    probe.close(ok);
  });
  return port;
}

/**
 * 解析真实的 `next` 可执行入口。
 *
 * `node_modules/.bin/next` 是 pnpm 生成的 `#!/bin/sh` 垫片，**不是 JS** —— 用
 * `process.execPath` 去跑它等于让 Node 解析一段 shell 脚本。所以优先指向包里的
 * `dist/bin/next`（用当前 Node 跑），只有在它不存在时才退回垫片（作为可执行文件直接跑）。
 */
export function resolveNextCommand(webDir) {
  const jsBin = join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (existsSync(jsBin)) return [process.execPath, jsBin];
  const shim = join(webDir, 'node_modules', '.bin', 'next');
  if (existsSync(shim)) return [shim];
  return null;
}

/**
 * 起 `next start`。子进程的 stdout/stderr 被**捕获**而不是继承：
 * 启动错误必须能进入失败信息，不许被吞掉（Q3-补-1 的硬约束）。
 */
export function startNextService({ webDir, port, hostname = '127.0.0.1' }) {
  const command = resolveNextCommand(webDir);
  if (command === null) {
    throw new Error(
      `服务启动失败：${webDir} 下找不到 next 可执行入口` +
        `（node_modules/next/dist/bin/next 与 node_modules/.bin/next 都不存在）—— 先跑 pnpm install`,
    );
  }
  const [file, ...args] = command;
  const child = spawn(file, [...args, 'start', '--hostname', hostname, '--port', String(port)], {
    cwd: webDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOSTNAME: hostname, PORT: String(port) },
  });
  const output = [];
  let exit = null;
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  child.once('error', (error) => {
    output.push(`spawn error: ${error.name}: ${error.message}\n`);
  });
  return { child, output, exitInfo: () => exit };
}

/** 轮询到「有任何 HTTP 响应」为止；子进程提前退出立刻失败并带出它的输出。 */
export async function waitForService({ origin, exitInfo, output, deadlineMs, fetchImpl = fetch }) {
  const deadline = Date.now() + deadlineMs;
  let lastError = '尚无请求';
  while (Date.now() < deadline) {
    const exited = exitInfo();
    if (exited !== null) {
      return (
        `服务启动失败：next start 提前退出（code=${exited.code} signal=${exited.signal}）。` +
        `捕获到的输出：\n${output.join('').trim() || '(空)'}`
      );
    }
    try {
      await fetchImpl(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
      return null;
    } catch (error) {
      lastError = `${error.name}: ${error.message}`;
      await new Promise((ok) => setTimeout(ok, POLL_INTERVAL_MS));
    }
  }
  return (
    `服务启动超时：${deadlineMs} ms 内 ${origin}/ 没有给出任何 HTTP 响应` +
    `（最后一次错误：${lastError}）。捕获到的输出：\n${output.join('').trim() || '(空)'}`
  );
}

/**
 * 精确回收**本脚本自己起的**那一个子进程（Q3-补-1：`finally` 里做，不许留后台服务）。
 *
 * 按 PID 杀，不按名字杀：构建容器里可能有别的 node 进程（包括调用方自己）。
 */
export async function stopService(child, graceMs = STOP_GRACE_MS) {
  if (child === null || child === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await new Promise((ok) => {
    const timer = setTimeout(() => ok(false), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      ok(true);
    });
  });
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function report(failures) {
  for (const failure of failures) process.stderr.write(`✗ ${failure}\n`);
}

/**
 * 跑完整条门：文件侧三项，然后（且仅当文件侧全绿时）起一次本地生产服务跑 HTTP 侧。
 *
 * 返回 `{ failures, origin, port }`；调用方决定退出码。`skipService` 只给测试用，
 * 生产路径（`web:export:check`）永远不传它 —— HTTP 侧不许变成「只在本地跑」。
 */
export async function runGate({ repoRoot = process.cwd(), skipService = false } = {}) {
  const webDir = resolve(repoRoot, WEB_DIR);
  const fileFailures = [
    ...checkBuildArtefacts(webDir),
    ...checkCssTokens(webDir),
    ...checkPublicLegalFiles(webDir),
  ];
  if (fileFailures.length > 0 || skipService) {
    return { failures: fileFailures, origin: null, port: null, webDir };
  }

  const port = await reserveDynamicPort();
  const origin = `http://127.0.0.1:${port}`;
  let child = null;
  try {
    const service = startNextService({ webDir, port });
    child = service.child;
    const startupFailure = await waitForService({
      origin,
      exitInfo: service.exitInfo,
      output: service.output,
      deadlineMs: START_TIMEOUT_MS,
    });
    if (startupFailure !== null) return { failures: [startupFailure], origin, port, webDir };
    const httpFailures = await checkHttpSide({ origin, webDir });
    return { failures: httpFailures, origin, port, webDir };
  } catch (error) {
    return { failures: [String(error.message ?? error)], origin, port, webDir };
  } finally {
    await stopService(child);
  }
}

async function main() {
  const { failures, origin } = await runGate({ repoRoot: process.cwd() });
  if (failures.length > 0) {
    report(failures);
    return 1;
  }
  process.stdout.write(
    `web export: 服务构建产物通过（${WEB_DIR}/${BUILD_ID_PATH} 非空、` +
      `${WEB_DIR}/${STATIC_DIR}/**/*.css 含 ${TOKEN_PREFIX}* 令牌、` +
      `四份法务源文件齐备；本地生产服务 ${origin} 上首页/法务页与四个法务 URL 均 200 非空，` +
      `合规标记命中，法务响应与 public/ 逐字节一致）\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`✗ 门禁自身异常：${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}

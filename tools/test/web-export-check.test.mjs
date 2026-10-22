// tools/check-web-export.mjs 的变异对照（ZLQ-233 Q3-补-4 强制的四组）。
//
// ## 为什么这个文件存在
//
// 架构师的裁定原话是「**证明脚本会退出 1 不够**」：一条能退 1 的门和一条**在正确的地方**
// 退 1 的门是两回事。把 `checkBuildArtefacts` 写成永远返回 `[]`，脚本照样能在别处退 1，
// 于是「BUILD_ID 缺失会被抓住」这个命题**从来没被证明过** —— 门看着在，其实空转。
// 所以下面每一组都断言**具体那一条**失败文本，而不是只断言 `failures.length > 0`。
//
// ## 为什么全部跑在临时目录与临时服务上
//
// 裁定要求变异对照「在临时目录 / 临时本地服务里跑，不得修改或残留真实构建产物与生产配置」。
// 这里因此**一次都不起 `next start`**、**一次都不碰 `apps/web/.next`**：
// 文件侧用 `mkdtempSync` 造的假 webDir，HTTP 侧用一个测试自己起的 `node:http`。
// 顺带这也让四组对照能在毫秒级跑完 —— 真起一次 Next 服务要十几秒，跑二十几次不现实。
//
// ## 为什么 `checkHttpSide` 收 `origin` 而不是自己起服务
//
// 就是为了这里可测。生产路径（`runGate`）自己保留动态端口、自己起服务、自己在 `finally`
// 里回收；测试路径注入一个受控 origin，两边跑的是**同一份**断言代码。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  BUILD_ID_PATH,
  LEGAL_ASSETS,
  PAGE_CONTRACTS,
  STATIC_DIR,
  TOKEN_PREFIX,
  WEB_DIR,
  checkBuildArtefacts,
  checkCssTokens,
  checkHttpSide,
  checkPublicLegalFiles,
  collectCssFiles,
  reserveDynamicPort,
  resolveNextCommand,
  runGate,
  stopService,
  waitForService,
} from '../check-web-export.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_SOURCE = readFileSync(join(HERE, '..', 'check-web-export.mjs'), 'utf8');

/** 首页与法务页的 fixture 正文。标记取自真实产物里必须出现的那两个字符串。 */
const HOME_BODY =
  '<!doctype html><html lang="zh-CN"><body>' +
  '<div data-design-system-unit="@littleq/design-system">Little Q</div>' +
  '<footer>AGPL-3.0-only</footer>' +
  '</body></html>';
const LEGAL_PAGE_BODY =
  '<!doctype html><html lang="zh-CN"><body><p>AGPL-3.0-only</p></body></html>';
const CSS_WITH_TOKENS = '.lq-shell{color:var(--lq-color-text);padding:var(--lq-space-3)}\n';
/** 一份**没有**任何设计令牌的 CSS：形态合法，令牌不在。 */
const CSS_WITHOUT_TOKENS = '.lq-shell{color:#123456;padding:8px}\n';

const tempDirs = [];
const openServers = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一棵**完整**的假 webDir：BUILD_ID 非空、CSS 含令牌、四份法务源文件非空。
 *
 * 返回 webDir 与四份法务文件的真实字节 —— HTTP fixture 必须按这些字节响应，
 * 否则「逐字节比较」那条断言会自己先红，阳性对照就失去意义。
 */
function makeFixtureWebDir(at = makeTempDir('lq-web-export-')) {
  mkdirSync(join(at, dirname(BUILD_ID_PATH)), { recursive: true });
  writeFileSync(join(at, BUILD_ID_PATH), 'FIXTUREBUILDID0001\n', 'utf8');
  mkdirSync(join(at, STATIC_DIR, 'chunks'), { recursive: true });
  writeFileSync(join(at, STATIC_DIR, 'chunks', 'fixture.css'), CSS_WITH_TOKENS, 'utf8');

  const legalBytes = new Map();
  for (const asset of LEGAL_ASSETS) {
    const absolute = join(at, 'public', asset.publicPath);
    mkdirSync(dirname(absolute), { recursive: true });
    const body = `${asset.url} 的法务正文 fixture\n`.repeat(3);
    writeFileSync(absolute, body, 'utf8');
    legalBytes.set(asset.url, Buffer.from(body, 'utf8'));
  }
  return { webDir: at, legalBytes };
}

/** 从 fixture 推导一张 path → 响应的路由表。返回可变的 Map，供各组对照逐项破坏。 */
function makeRoutes(legalBytes) {
  const routes = new Map();
  for (const page of PAGE_CONTRACTS) {
    routes.set(page.url, {
      status: 200,
      body: page.url === '/' ? HOME_BODY : LEGAL_PAGE_BODY,
    });
  }
  for (const asset of LEGAL_ASSETS) {
    routes.set(asset.url, { status: 200, body: legalBytes.get(asset.url).toString('utf8') });
  }
  return routes;
}

/** 起一个临时 node:http。`routes` 是**同一个** Map 引用，改它即可改变服务行为。 */
async function startFixtureServer(routes) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const route = routes.get(pathname);
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('fixture 404');
      return;
    }
    response.writeHead(route.status, { 'content-type': route.contentType ?? 'text/plain' });
    response.end(route.body ?? '');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  openServers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    await new Promise((ok) => server.close(ok));
  }
});

/** 把失败列表里命中某个前缀的那些挑出来，便于断言「报的是这一条，不是别条」。 */
function withPrefix(failures, prefix) {
  return failures.filter((failure) => failure.startsWith(prefix));
}

/**
 * 去掉源码里的注释，**保留字符串字面量**。源码级扫描必须先过这一层。
 *
 * 为什么：门禁自己的文档注释里就写着「**不许写死 3000**」—— 那句是**说明**，不是配置。
 * 裸扫描会被自己的解释绊红；而一条被自己的注释绊红的门，之后再也分不清「真的写死了端口」
 * 和「碰巧又提到这个词」，也就染不红了（与 apps/web/test/index.test.ts 的 stripComments
 * 同一理由，那边是被头注释里的 `apps/runtime` 散文绊倒）。
 *
 * 为什么必须字符串感知：`'http://…'` 里的 `//` 不是行注释起点。按 `//` 一刀切会把该行
 * 后半截吃掉，而在别处这一刀可能正好吃掉一处真写死的端口 —— **假绿比假红更危险**。
 */
function stripComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += source[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

describe('阳性对照：完整的 fixture 必须**全绿**', () => {
  it('文件侧三项各自返回空失败列表', () => {
    const { webDir } = makeFixtureWebDir();
    expect(checkBuildArtefacts(webDir)).toEqual([]);
    expect(checkCssTokens(webDir)).toEqual([]);
    expect(checkPublicLegalFiles(webDir)).toEqual([]);
  });

  it('HTTP 侧六个 URL 全过（两个页面 + 四个法务）', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const origin = await startFixtureServer(makeRoutes(legalBytes));
    // 少了这一条，下面二十几条变异对照就都可以被「checkHttpSide 恒返回 []」糊过去。
    expect(await checkHttpSide({ origin, webDir })).toEqual([]);
  });

  it('runGate 在文件侧全绿时不会自己报任何失败（skipService 让它停在文件侧）', async () => {
    const repoRoot = makeTempDir('lq-web-export-root-');
    makeFixtureWebDir(join(repoRoot, WEB_DIR));
    // fixture 里没有 next 可执行入口，所以这里只验「文件侧全绿 ⇒ 无失败」这一层；
    // 服务侧的行为由上面那条 HTTP 阳性对照与下面「找不到 next 入口」那条共同覆盖。
    expect((await runGate({ repoRoot, skipService: true })).failures).toEqual([]);
  });
});

describe('变异对照 ①：.next/BUILD_ID（构建产物缺失）', () => {
  it('整个文件被删掉 ⇒ 报「构建产物缺失」并点名 apps/web/.next/BUILD_ID', () => {
    const { webDir } = makeFixtureWebDir();
    rmSync(join(webDir, BUILD_ID_PATH));
    const failures = checkBuildArtefacts(webDir);
    expect(withPrefix(failures, '构建产物缺失：')).toHaveLength(1);
    expect(failures[0]).toContain(`${WEB_DIR}/${BUILD_ID_PATH}`);
    expect(failures[0]).toContain('不存在');
  });

  it('文件在但内容是空的 ⇒ 同样报「构建产物缺失」，措辞是「空的」', () => {
    const { webDir } = makeFixtureWebDir();
    writeFileSync(join(webDir, BUILD_ID_PATH), '   \n', 'utf8');
    const failures = checkBuildArtefacts(webDir);
    expect(withPrefix(failures, '构建产物缺失：')).toHaveLength(1);
    expect(failures[0]).toContain('空的');
  });

  it('`.next` 整个目录不存在 ⇒ 也是「构建产物缺失」，而不是抛异常', () => {
    const { webDir } = makeFixtureWebDir();
    rmSync(join(webDir, '.next'), { recursive: true, force: true });
    expect(withPrefix(checkBuildArtefacts(webDir), '构建产物缺失：')).toHaveLength(1);
  });

  it('恢复之后同一检查转绿（证明上面三条红是这条断言造成的，不是 fixture 坏了）', () => {
    const { webDir } = makeFixtureWebDir();
    rmSync(join(webDir, BUILD_ID_PATH));
    expect(checkBuildArtefacts(webDir)).not.toEqual([]);
    writeFileSync(join(webDir, BUILD_ID_PATH), 'RESTORED0000000001\n', 'utf8');
    expect(checkBuildArtefacts(webDir)).toEqual([]);
  });
});

describe('变异对照 ②：四个法务 URL（缺失 / 空正文 / 源文件 / 漂移）', () => {
  // 用 for-of 而不是 it.each：`it.each(...)` 的调用括号被 prettier 推到下一行时，
  // eslint 的 no-unexpected-multiline 会判红，两条规则打架；循环生成同名用例效果一样。
  for (const asset of LEGAL_ASSETS) {
    it(`${asset.url} 从服务上消失 ⇒ 报状态码不符并点名该 URL`, async () => {
      const { webDir, legalBytes } = makeFixtureWebDir();
      const routes = makeRoutes(legalBytes);
      routes.delete(asset.url);
      const origin = await startFixtureServer(routes);
      const hits = withPrefix(await checkHttpSide({ origin, webDir }), '状态码不符：');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(asset.url);
      expect(hits[0]).toContain('404');
    });

    it(`${asset.url} 返回 200 但正文为空 ⇒ 报「正文为空」`, async () => {
      const { webDir, legalBytes } = makeFixtureWebDir();
      const routes = makeRoutes(legalBytes);
      routes.set(asset.url, { status: 200, body: '' });
      const origin = await startFixtureServer(routes);
      const hits = withPrefix(await checkHttpSide({ origin, webDir }), '正文为空：');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(asset.url);
    });

    it(`public/${asset.publicPath} 源文件缺失 ⇒ 文件侧先报「法务源文件缺失」`, () => {
      const { webDir } = makeFixtureWebDir();
      rmSync(join(webDir, 'public', asset.publicPath));
      const hits = withPrefix(checkPublicLegalFiles(webDir), '法务源文件缺失：');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(`${WEB_DIR}/public/${asset.publicPath}`);
    });

    it(`public/${asset.publicPath} 源文件为空 ⇒ 报「法务源文件为空」`, () => {
      const { webDir } = makeFixtureWebDir();
      writeFileSync(join(webDir, 'public', asset.publicPath), '', 'utf8');
      const hits = withPrefix(checkPublicLegalFiles(webDir), '法务源文件为空：');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(asset.publicPath);
    });
  }

  it('响应字节与 public/ 不一致 ⇒ 报「法务内容漂移」（逐字节比较这条真的在跑）', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    const target = LEGAL_ASSETS[0].url;
    routes.set(target, { status: 200, body: '被改写过的法务正文\n' });
    const origin = await startFixtureServer(routes);
    const hits = withPrefix(await checkHttpSide({ origin, webDir }), '法务内容漂移：');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(target);
  });

  it('四个 URL 全部恢复之后 HTTP 侧转绿', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    for (const asset of LEGAL_ASSETS) routes.delete(asset.url);
    const origin = await startFixtureServer(routes);
    expect((await checkHttpSide({ origin, webDir })).length).toBeGreaterThan(0);
    for (const asset of LEGAL_ASSETS) {
      routes.set(asset.url, { status: 200, body: legalBytes.get(asset.url).toString('utf8') });
    }
    expect(await checkHttpSide({ origin, webDir })).toEqual([]);
  });
});

describe('变异对照 ③：页面标记与状态码（缺失标记 / 重定向不得掩盖）', () => {
  const HOME_MARKERS = PAGE_CONTRACTS.find((page) => page.url === '/').markers;
  const LEGAL_PAGE = '/source-and-license/';
  const LEGAL_PAGE_MARKERS = PAGE_CONTRACTS.find((page) => page.url === LEGAL_PAGE).markers;

  it('首页第一个标记（设计系统单元自述）被删 ⇒ 报「缺失标记」并点名该标记', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    routes.set('/', { status: 200, body: HOME_BODY.replace(HOME_MARKERS[0], 'data-x="y"') });
    const origin = await startFixtureServer(routes);
    const hits = withPrefix(await checkHttpSide({ origin, webDir }), '缺失标记：');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(HOME_MARKERS[0]);
  });

  it('首页第二个标记（AGPL-3.0-only）被删 ⇒ 报「缺失标记」并点名该标记', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    routes.set('/', { status: 200, body: HOME_BODY.replace(HOME_MARKERS[1], 'MIT') });
    const origin = await startFixtureServer(routes);
    const hits = withPrefix(await checkHttpSide({ origin, webDir }), '缺失标记：');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(HOME_MARKERS[1]);
  });

  it('两个标记同时被删 ⇒ 两条各自报出，不合并成一条', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    routes.set('/', {
      status: 200,
      body: HOME_BODY.replace(HOME_MARKERS[0], 'data-x="y"').replace(HOME_MARKERS[1], 'MIT'),
    });
    const origin = await startFixtureServer(routes);
    expect(withPrefix(await checkHttpSide({ origin, webDir }), '缺失标记：')).toHaveLength(2);
  });

  it('法务页的 AGPL-3.0-only 被删 ⇒ 报「缺失标记」并点名 /source-and-license/', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    routes.set(LEGAL_PAGE, {
      status: 200,
      body: LEGAL_PAGE_BODY.replace(LEGAL_PAGE_MARKERS[0], 'UNLICENSED'),
    });
    const origin = await startFixtureServer(routes);
    const hits = withPrefix(await checkHttpSide({ origin, webDir }), '缺失标记：');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(LEGAL_PAGE);
  });

  it.each([
    ['308', 308],
    ['307', 307],
    ['301', 301],
    ['500', 500],
  ])('首页返回 %s ⇒ 报状态码不符（重定向后的 200 不得掩盖错误路径）', async (_label, status) => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    routes.set('/', { status, body: HOME_BODY });
    const origin = await startFixtureServer(routes);
    const hits = withPrefix(await checkHttpSide({ origin, webDir }), '状态码不符：');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(String(status));
    expect(hits[0]).toContain('直接');
  });

  it('首页 200 但正文为空 ⇒ 报「正文为空」，且不再去查标记（否则一屏全是缺失标记）', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    routes.set('/', { status: 200, body: '   ' });
    const origin = await startFixtureServer(routes);
    const failures = await checkHttpSide({ origin, webDir });
    expect(withPrefix(failures, '正文为空：')).toHaveLength(1);
    expect(withPrefix(failures, '缺失标记：')).toEqual([]);
  });

  it('服务连不上 ⇒ 每个 URL 各报一条「URL 不可用」并带上完整 URL', async () => {
    const { webDir } = makeFixtureWebDir();
    const failures = await checkHttpSide({ origin: 'http://127.0.0.1:1', webDir });
    const hits = withPrefix(failures, 'URL 不可用：');
    expect(hits).toHaveLength(PAGE_CONTRACTS.length + LEGAL_ASSETS.length);
    expect(hits[0]).toContain('http://127.0.0.1:1/');
  });

  it('标记恢复之后 HTTP 侧转绿', async () => {
    const { webDir, legalBytes } = makeFixtureWebDir();
    const routes = makeRoutes(legalBytes);
    routes.set('/', { status: 200, body: HOME_BODY.replace(HOME_MARKERS[1], 'MIT') });
    const origin = await startFixtureServer(routes);
    expect((await checkHttpSide({ origin, webDir })).length).toBeGreaterThan(0);
    routes.set('/', { status: 200, body: HOME_BODY });
    expect(await checkHttpSide({ origin, webDir })).toEqual([]);
  });
});

describe('变异对照 ④：CSS 与设计令牌', () => {
  it('static 目录整个不存在 ⇒ 报「CSS 缺失」', () => {
    const { webDir } = makeFixtureWebDir();
    rmSync(join(webDir, '.next', 'static'), { recursive: true, force: true });
    const failures = checkCssTokens(webDir);
    expect(withPrefix(failures, 'CSS 缺失：')).toHaveLength(1);
    expect(failures[0]).toContain(STATIC_DIR);
  });

  it('有 .css 但全是空文件 ⇒ 报「CSS 缺失」，且不顺带再报令牌缺失', () => {
    const { webDir } = makeFixtureWebDir();
    writeFileSync(join(webDir, STATIC_DIR, 'chunks', 'fixture.css'), '', 'utf8');
    const failures = checkCssTokens(webDir);
    expect(withPrefix(failures, 'CSS 缺失：')).toHaveLength(1);
    expect(failures[0]).toContain('全部为空');
    // 空文件里当然也没有令牌，但真因是「CSS 是空的」；同时报两条会把真因稀释掉。
    expect(withPrefix(failures, '令牌缺失：')).toEqual([]);
  });

  it('有非空 .css 但 --lq- 全被删掉 ⇒ 报「令牌缺失」，且不报 CSS 缺失', () => {
    const { webDir } = makeFixtureWebDir();
    writeFileSync(join(webDir, STATIC_DIR, 'chunks', 'fixture.css'), CSS_WITHOUT_TOKENS, 'utf8');
    const failures = checkCssTokens(webDir);
    expect(withPrefix(failures, 'CSS 缺失：')).toEqual([]);
    const hits = withPrefix(failures, '令牌缺失：');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(TOKEN_PREFIX);
  });

  it('令牌只出现在深层子目录的 CSS 里也算命中（递归，不钉死 chunks/）', () => {
    // ZLQ-219 的 Next 16.4.2 生产日志里 CSS 落在 _next/static/immutable/chunks/。
    // 把检查收窄成 `${STATIC_DIR}/chunks/*.css` 会在那种形态下假红。
    const { webDir } = makeFixtureWebDir();
    rmSync(join(webDir, STATIC_DIR, 'chunks', 'fixture.css'));
    const deep = join(webDir, STATIC_DIR, 'immutable', 'chunks', 'a', 'b');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'deep.css'), CSS_WITH_TOKENS, 'utf8');
    expect(collectCssFiles(webDir)).toHaveLength(1);
    expect(checkCssTokens(webDir)).toEqual([]);
  });

  it('令牌恢复之后同一检查转绿', () => {
    const { webDir } = makeFixtureWebDir();
    const css = join(webDir, STATIC_DIR, 'chunks', 'fixture.css');
    writeFileSync(css, CSS_WITHOUT_TOKENS, 'utf8');
    expect(checkCssTokens(webDir)).not.toEqual([]);
    writeFileSync(css, CSS_WITH_TOKENS, 'utf8');
    expect(checkCssTokens(webDir)).toEqual([]);
  });
});

describe('服务生命周期：动态端口、启动错误不被吞、子进程被精确回收', () => {
  it('端口由内核分配，且拿到手就是空闲可用的（不是写死的 3000）', async () => {
    const port = await reserveDynamicPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
    // 真的能绑上去 ⇒ 它确实是个空闲端口，而不是一个随机数。
    const probe = createServer();
    await new Promise((ok, fail) => {
      probe.once('error', fail);
      probe.listen(port, '127.0.0.1', ok);
    });
    await new Promise((ok) => probe.close(ok));
  });

  it('门禁源码里不出现写死的 3000 端口（扫去注释后，附阳性对照）', () => {
    const pattern = /(^|[^0-9])3000([^0-9]|$)/;
    // 阳性对照 ①：这个正则确实抓得住写死端口的写法，也不会误伤 30001 这类更长的数字。
    expect(pattern.test('next start --port 3000')).toBe(true);
    expect(pattern.test('30001')).toBe(false);
    // 阳性对照 ②：`stripComments` 只吃注释，不吃字符串里的 `//`。这一条不成立的话，
    // 下面那次「源码里没写死」就有可能是被剥掉一大块真源码换来的 —— 假绿比假红更危险。
    expect(stripComments('const url = "http://127.0.0.1:8080"; // 端口')).toBe(
      'const url = "http://127.0.0.1:8080"; ',
    );
    expect(stripComments('const port = 3000;')).toMatch(pattern);

    // 说明性散文里出现 3000 是应当的：门禁与本文件都在解释这条规则。
    expect(GATE_SOURCE.includes('3000')).toBe(true);
    expect(stripComments(GATE_SOURCE)).not.toMatch(pattern);
    expect(stripComments(GATE_SOURCE).length).toBeGreaterThan(0);
  });

  it('子进程提前退出 ⇒ 报「服务启动失败」并带出它捕获的输出', async () => {
    const failure = await waitForService({
      origin: 'http://127.0.0.1:1',
      exitInfo: () => ({ code: 1, signal: null }),
      output: ['Error: Cannot find `.next` directory\n'],
      deadlineMs: 30_000,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(failure).toContain('服务启动失败：');
    expect(failure).toContain('code=1');
    expect(failure).toContain('Cannot find `.next` directory');
  });

  it('服务一直不响应 ⇒ 到点报「服务启动超时」，并带上最后一次错误', async () => {
    const failure = await waitForService({
      origin: 'http://127.0.0.1:1',
      exitInfo: () => null,
      output: [],
      deadlineMs: 400,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(failure).toContain('服务启动超时：');
    expect(failure).toContain('400 ms');
    expect(failure).toContain('ECONNREFUSED');
  });

  it('一旦拿到任何 HTTP 响应就返回 null（哪怕是 500 —— 那是 checkHttpSide 的事）', async () => {
    const failure = await waitForService({
      origin: 'http://127.0.0.1:1',
      exitInfo: () => null,
      output: [],
      deadlineMs: 30_000,
      fetchImpl: async () => ({ status: 500 }),
    });
    expect(failure).toBeNull();
  });

  it('stopService 真的能收掉一个活着的子进程（`finally` 回收不是空话）', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    expect(child.exitCode).toBeNull();
    await stopService(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 20_000);

  it('stopService 对 null 与已退出的子进程都是无操作', async () => {
    await expect(stopService(null)).resolves.toBeUndefined();
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((ok) => child.once('exit', ok));
    await expect(stopService(child)).resolves.toBeUndefined();
  }, 20_000);

  it('resolveNextCommand 优先选包内的 JS 入口，而不是 pnpm 的 #!/bin/sh 垫片', () => {
    // 垫片是 shell 脚本；用 process.execPath 跑它等于让 Node 去解析一段 shell。
    const fakeWebDir = makeTempDir('lq-next-cmd-');
    mkdirSync(join(fakeWebDir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(fakeWebDir, 'node_modules', '.bin', 'next'), '#!/bin/sh\n', 'utf8');
    expect(resolveNextCommand(fakeWebDir)).toEqual([
      join(fakeWebDir, 'node_modules', '.bin', 'next'),
    ]);
    mkdirSync(join(fakeWebDir, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(fakeWebDir, 'node_modules', 'next', 'dist', 'bin', 'next'), '', 'utf8');
    expect(resolveNextCommand(fakeWebDir)).toEqual([
      process.execPath,
      join(fakeWebDir, 'node_modules', 'next', 'dist', 'bin', 'next'),
    ]);
    expect(resolveNextCommand(makeTempDir('lq-next-none-'))).toBeNull();
  });

  it('文件侧全绿但找不到 next 入口 ⇒ runGate 报「服务启动失败」，不静默通过', async () => {
    const repoRoot = makeTempDir('lq-no-next-');
    makeFixtureWebDir(join(repoRoot, WEB_DIR));
    const result = await runGate({ repoRoot });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('服务启动失败：');
    expect(result.failures[0]).toContain('next 可执行入口');
  });

  it('文件侧已经红了就不起服务（真因不被一屏连接失败淹掉）', async () => {
    const repoRoot = makeTempDir('lq-file-red-');
    mkdirSync(join(repoRoot, WEB_DIR), { recursive: true });
    const result = await runGate({ repoRoot });
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.origin).toBeNull();
    expect(withPrefix(result.failures, '构建产物缺失：').length).toBeGreaterThan(0);
    // 反证：没有任何一条是连接类或启动类失败 —— 服务确实没被起过。
    expect(withPrefix(result.failures, 'URL 不可用：')).toEqual([]);
    expect(result.failures.filter((f) => f.startsWith('服务启动'))).toEqual([]);
  });

  it('runGate 的 webDir 指向 repoRoot/apps/web，不随调用方的 cwd 漂移', async () => {
    const repoRoot = makeTempDir('lq-webdir-');
    const { webDir } = makeFixtureWebDir(join(repoRoot, WEB_DIR));
    expect((await runGate({ repoRoot, skipService: true })).webDir).toBe(webDir);
  });
});

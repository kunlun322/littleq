// tools/static-server.mjs 的测试。
//
// 这个服务器只服务于 e2e smoke，但它是一个会监听端口、按 URL 读磁盘的进程，
// 路径穿越与白名单绕过必须在无浏览器的情况下也被证明挡住 —— Playwright 在 CI 上
// 可能因浏览器未下载而跳过，安全断言不能跟着一起消失。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticServer, resolveRequestTarget, resolveSafePath } from '../static-server.mjs';

const ALLOW = ['artifacts'];

const root = mkdtempSync(join(tmpdir(), 'lq-static-server-'));
const secretOutside = join(root, 'secret.env');
const bundles = join(root, 'artifacts', 'bundles');
const dotdir = join(root, 'artifacts', '.hidden');

beforeAll(() => {
  mkdirSync(bundles, { recursive: true });
  mkdirSync(dotdir, { recursive: true });
  writeFileSync(
    join(bundles, 'web.js'),
    'export const sentinel = "LQ_TEST_SENTINEL_FAKE";\n',
    'utf8',
  );
  writeFileSync(join(root, 'artifacts', 'notes.txt'), 'plain\n', 'utf8');
  writeFileSync(join(dotdir, 'token.txt'), 'LQ_TEST_SENTINEL_FAKE\n', 'utf8');
  writeFileSync(secretOutside, 'LQ_TEST_SENTINEL_FAKE\n', 'utf8');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const resolve = (urlPath) => resolveSafePath(root, urlPath, ALLOW);

describe('路径解析：白名单内放行', () => {
  it('artifacts/ 下的文件解析到 root 内的绝对路径', () => {
    expect(resolve('/artifacts/bundles/web.js')).toBe(join(bundles, 'web.js'));
    expect(resolve('/artifacts/notes.txt')).toBe(join(root, 'artifacts', 'notes.txt'));
  });

  it('查询串不参与路径解析', () => {
    expect(resolve('/artifacts/notes.txt?v=1')).toBe(join(root, 'artifacts', 'notes.txt'));
  });
});

describe('路径解析：白名单外与穿越一律拒绝', () => {
  it.each([
    ['根清单', '/package.json'],
    ['策略文件', '/config/license-policy.json'],
    ['凭证文件', '/secret.env'],
    ['点文件', '/.env'],
    ['点目录', '/.git/config'],
    ['产物目录下的点目录', '/artifacts/.hidden/token.txt'],
    ['仓库根', '/'],
  ])('拒绝 %s：%s', (_label, urlPath) => {
    expect(resolve(urlPath)).toBeNull();
  });

  it('白名单目录本身能解析出路径，但由服务器按「非普通文件」判 404', () => {
    // resolveSafePath 只管「在不在白名单里、有没有穿越」，不做 stat；
    // 目录请求落到 HTTP 层的 isFile() 检查上（见下面「不做目录列表」那条）。
    expect(resolve('/artifacts')).toBe(join(root, 'artifacts'));
    expect(resolve('/artifacts/bundles')).toBe(bundles);
  });

  it.each([
    ['裸 ../', '/artifacts/../secret.env'],
    ['编码 ../', '/artifacts/%2e%2e/secret.env'],
    ['编码 ../（整段）', '/artifacts/%2e%2e%2fsecret.env'],
    ['多级穿越到系统路径', '/artifacts/../../etc/passwd'],
    ['大写编码', '/artifacts/%2E%2E/secret.env'],
  ])('拒绝穿越 %s：%s', (_label, urlPath) => {
    expect(resolve(urlPath)).toBeNull();
  });

  it('前缀匹配不是朴素的 startsWith', () => {
    // `artifacts-evil` 以 `artifacts` 开头，但不在白名单目录内。
    expect(resolve('/artifacts-evil/web.js')).toBeNull();
  });

  it('畸形百分号编码返回 null，而不是抛出 URIError', () => {
    // 请求处理器里抛异常会直接打死这个进程。
    expect(resolve('/artifacts/%')).toBeNull();
    expect(resolve('/artifacts/%zz')).toBeNull();
  });

  it('解析结果始终留在 root 内（即使白名单被放宽）', () => {
    const resolved = resolveSafePath(root, '/artifacts/bundles/web.js', ['artifacts']);
    expect(resolved.startsWith(root + sep)).toBe(true);
  });
});

describe('HTTP 行为', () => {
  let started;

  beforeAll(async () => {
    // port 0 让内核分配空闲端口：写死端口会让并行任务互相抢占。
    started = await createStaticServer({ root, port: 0, allow: ALLOW });
  });
  afterAll(async () => {
    await started?.close();
  });

  it('只监听回环地址', () => {
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const address = started.server.address();
    expect(typeof address === 'object' && address ? address.address : null).toBe('127.0.0.1');
  });

  it('健康检查返回白名单内容', async () => {
    const response = await fetch(`${started.url}/__health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, allow: ['artifacts'] });
  });

  it('白名单内的文件按正确的 content-type 返回', async () => {
    const js = await fetch(`${started.url}/artifacts/bundles/web.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toBe('no-store');
    expect(await js.text()).toContain('LQ_TEST_SENTINEL_FAKE');

    const txt = await fetch(`${started.url}/artifacts/notes.txt`);
    expect(txt.headers.get('content-type')).toContain('text/plain');
  });

  it.each([
    ['白名单外的文件', '/secret.env'],
    ['根清单', '/package.json'],
    ['裸穿越', '/artifacts/../secret.env'],
    ['编码穿越', '/artifacts/%2e%2e/secret.env'],
    ['目录请求（不做目录列表）', '/artifacts/'],
    ['不存在的文件', '/artifacts/bundles/nope.js'],
  ])('%s 返回 404 且不泄漏内容：%s', async (_label, urlPath) => {
    const response = await fetch(`${started.url}${urlPath}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('LQ_TEST_SENTINEL_FAKE');
  });
});

// ---------------------------------------------------------------------------
// ZLQ-190 §6.2 / PM 裁定 2 新增的两条能力：目录 → index.html、`--allow .`（root 整体可服务）。
//
// 刻意用**独立**的 fixture 根，不往上面那棵树里塞 index.html：上面那组断言钉的是
// `resolveSafePath` 的既有契约（含「白名单目录本身能解析出路径，但由服务器按非普通
// 文件判 404」与 `/artifacts/` 返回 404）。共用一棵树会让那两条要么假绿要么假红，
// 分不清是新能力坏了还是 fixture 变了。分开之后上面一字未改地继续跑，本身就是回归证明。
// ---------------------------------------------------------------------------
const siteParent = mkdtempSync(join(tmpdir(), 'lq-static-site-'));
const siteRoot = join(siteParent, 'out');
const outsideSecret = join(siteParent, 'secret.env');

const HOME_MARK = 'LQ_SITE_HOME_MARK';
const LEGAL_PAGE_MARK = 'LQ_SITE_LEGAL_PAGE_MARK';
const LEGAL_FILE_MARK = 'LQ_SITE_AGPL_TEXT_MARK';
const OUTSIDE_MARK = 'LQ_SITE_OUTSIDE_SECRET_MARK';

beforeAll(() => {
  mkdirSync(join(siteRoot, 'source-and-license'), { recursive: true });
  mkdirSync(join(siteRoot, 'legal'), { recursive: true });
  mkdirSync(join(siteRoot, 'empty-dir'), { recursive: true });
  mkdirSync(join(siteRoot, '.git'), { recursive: true });
  writeFileSync(join(siteRoot, 'index.html'), `<html>${HOME_MARK}</html>\n`, 'utf8');
  writeFileSync(
    join(siteRoot, 'source-and-license', 'index.html'),
    `<html>${LEGAL_PAGE_MARK}</html>\n`,
    'utf8',
  );
  writeFileSync(join(siteRoot, 'legal', 'AGPL-3.0.txt'), `${LEGAL_FILE_MARK}\n`, 'utf8');
  writeFileSync(join(siteRoot, '.git', 'config'), `${OUTSIDE_MARK}\n`, 'utf8');
  writeFileSync(outsideSecret, `${OUTSIDE_MARK}\n`, 'utf8');
});
afterAll(() => rmSync(siteParent, { recursive: true, force: true }));

const WHOLE_ROOT = ['.'];

describe('目录请求：只改写到 index.html，绝不列目录', () => {
  it('根请求解析到根下的 index.html', () => {
    expect(resolveRequestTarget(siteRoot, '/', WHOLE_ROOT)).toBe(join(siteRoot, 'index.html'));
  });

  it.each([
    ['带尾斜杠', '/source-and-license/'],
    ['不带尾斜杠', '/source-and-license'],
  ])('%s 的目录请求都解析到该目录下的 index.html：%s', (_label, urlPath) => {
    expect(resolveRequestTarget(siteRoot, urlPath, WHOLE_ROOT)).toBe(
      join(siteRoot, 'source-and-license', 'index.html'),
    );
  });

  it('没有 index.html 的目录：解析层给出改写后的路径，由 HTTP 层判 404', () => {
    // 契约与 resolveSafePath 一致：解析层只管「守卫过没过、该改写成谁」，**不 stat 结果**。
    // 「这个 index.html 到底存不存在」是 HTTP 层 isFile() 的职责（见下面那条 404 断言）。
    // 把存在性判断塞进解析层会让「被守卫拒绝」与「文件不存在」返回同一个 null，
    // 反而分不清是哪一层起了作用。
    expect(resolveRequestTarget(siteRoot, '/empty-dir/', WHOLE_ROOT)).toBe(
      join(siteRoot, 'empty-dir', 'index.html'),
    );
    expect(resolveRequestTarget(siteRoot, '/empty-dir', WHOLE_ROOT)).toBe(
      join(siteRoot, 'empty-dir', 'index.html'),
    );
    // 关键的一条：改写只会指向 index.html，绝不会返回目录本身 —— 返回目录就意味着
    // 调用方可能去列它。
    expect(resolveRequestTarget(siteRoot, '/empty-dir/', WHOLE_ROOT)).not.toBe(
      join(siteRoot, 'empty-dir'),
    );
  });

  it('普通文件请求不受影响', () => {
    expect(resolveRequestTarget(siteRoot, '/legal/AGPL-3.0.txt', WHOLE_ROOT)).toBe(
      join(siteRoot, 'legal', 'AGPL-3.0.txt'),
    );
  });

  it('畸形百分号编码仍返回 null 而不是抛 URIError', () => {
    expect(resolveRequestTarget(siteRoot, '/%', WHOLE_ROOT)).toBeNull();
    expect(resolveRequestTarget(siteRoot, '/%zz', WHOLE_ROOT)).toBeNull();
  });
});

describe('目录改写不放宽任何一条守卫', () => {
  // 点段守卫跑在 normalize 之前，所以任何含 `..` 段的解码结果一律 null ——
  // 这条比「解析结果不逃出 root」更强，也就没必要退而断言后者。
  it.each([
    ['点文件', '/.env'],
    ['点目录里的文件', '/.git/config'],
    ['点目录的 index 改写', '/.git/'],
    ['点目录伪装成合法段', '/legal/.hidden'],
    ['裸 ../', '/../secret.env'],
    ['编码 ../', '/%2e%2e/secret.env'],
    ['编码 ../（整段）', '/%2e%2e%2fsecret.env'],
    ['多级穿越', '/legal/../../secret.env'],
    ['大写编码', '/%2E%2E/secret.env'],
    ['借目录改写上跳', '/source-and-license/../index.html'],
  ])('拒绝 %s：%s', (_label, urlPath) => {
    expect(resolveRequestTarget(siteRoot, urlPath, WHOLE_ROOT)).toBeNull();
  });

  it('解析结果始终留在 root 内（即使 root 整体可服务）', () => {
    const resolved = resolveRequestTarget(siteRoot, '/', WHOLE_ROOT);
    expect(resolved.startsWith(siteRoot + sep)).toBe(true);
  });
});

describe('窄前缀下，目录改写不能成为越界通道', () => {
  // 上面那组是 root 整体可服务，前缀守卫本来就不设防。这里换成窄前缀，
  // 才能证明「改写后的目标」与「直接请求的目标」受同一套前缀检查。
  const NARROW = ['source-and-license'];

  it('前缀内的目录可改写到 index.html', () => {
    expect(resolveRequestTarget(siteRoot, '/source-and-license/', NARROW)).toBe(
      join(siteRoot, 'source-and-license', 'index.html'),
    );
  });

  it.each([
    ['借 .. 跳到前缀外的文件', '/source-and-license/../index.html'],
    ['借 .. 跳到前缀外的目录', '/source-and-license/../legal/'],
    ['直接请求前缀外文件', '/index.html'],
    ['直接请求前缀外目录', '/legal/'],
    ['前缀同名的兄弟目录', '/source-and-license-evil/'],
  ])('拒绝 %s：%s', (_label, urlPath) => {
    expect(resolveRequestTarget(siteRoot, urlPath, NARROW)).toBeNull();
  });
});

describe('白名单仍生效：`.` 之外一律拒绝，空 --allow 什么都不可服务', () => {
  it('前缀内可解析，前缀外拒绝', () => {
    expect(resolveRequestTarget(siteRoot, '/legal/AGPL-3.0.txt', ['legal'])).toBe(
      join(siteRoot, 'legal', 'AGPL-3.0.txt'),
    );
    expect(resolveRequestTarget(siteRoot, '/index.html', ['legal'])).toBeNull();
  });

  it('根请求只在 root 确实被允许时才回退到 index.html', () => {
    // `/` 的 index.html 回退不能变成「绕过白名单读根目录」的通道。
    expect(resolveRequestTarget(siteRoot, '/', ['legal'])).toBeNull();
    expect(resolveRequestTarget(siteRoot, '/source-and-license/', ['legal'])).toBeNull();
    expect(resolveRequestTarget(siteRoot, '/source-and-license/', ['source-and-license'])).toBe(
      join(siteRoot, 'source-and-license', 'index.html'),
    );
  });

  it.each([
    ['/', '/'],
    ['根下文件', '/index.html'],
    ['法务文件', '/legal/AGPL-3.0.txt'],
  ])('空 --allow 时 %s 也拒绝（失败关闭）：%s', (_label, urlPath) => {
    expect(resolveRequestTarget(siteRoot, urlPath, [])).toBeNull();
  });

  it('前缀匹配不是朴素的 startsWith', () => {
    expect(resolveRequestTarget(siteRoot, '/legal-evil/AGPL-3.0.txt', ['legal'])).toBeNull();
  });
});

describe('HTTP 行为：站点形态（root=out，--allow .）', () => {
  let site;

  beforeAll(async () => {
    site = await createStaticServer({ root: siteRoot, port: 0, allow: WHOLE_ROOT });
  });
  afterAll(async () => {
    await site?.close();
  });

  it('健康检查把生效的前缀报告成可回输的取值', async () => {
    // 空前缀回写成 '.'：报告值本身就是一个合法的 --allow 输入，
    // 于是 e2e 断言的字符串与人能敲的字符串是同一个，不会各说各话。
    const response = await fetch(`${site.url}/__health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, allow: ['.'] });
  });

  it('目录请求以 text/html 返回该目录的 index.html', async () => {
    const home = await fetch(`${site.url}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).toContain(HOME_MARK);

    const legal = await fetch(`${site.url}/source-and-license/`);
    expect(legal.status).toBe(200);
    expect(await legal.text()).toContain(LEGAL_PAGE_MARK);
  });

  it('没有 index.html 的目录返回 404，且响应体不是目录列表', async () => {
    const response = await fetch(`${site.url}/empty-dir/`);
    expect(response.status).toBe(404);
    const body = await response.text();
    // 目录列表会把子项名字回显出来；这里连「有没有 index.html」都不该透露。
    expect(body).not.toContain('index.html');
    expect(body).not.toContain('AGPL');
    expect(body).not.toContain(HOME_MARK);
  });

  it.each([
    ['root 外路径的解析落点不存在', '/secret.env', OUTSIDE_MARK],
    ['点目录里的真实文件', '/.git/config', OUTSIDE_MARK],
    ['编码穿越', '/%2e%2e/secret.env', OUTSIDE_MARK],
    ['借 .. 上跳后再穿越', '/legal/../../secret.env', OUTSIDE_MARK],
  ])('%s 返回 404 且不泄漏内容：%s', async (_label, urlPath, mark) => {
    const response = await fetch(`${site.url}${urlPath}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(mark);
  });

  it('客户端归一化挡不住的编码穿越，由服务端自己拒绝', async () => {
    // `..%2f` 不是 WHATWG URL 意义上的「双点路径段」（只有 `..`、`.%2e`、`%2e.`、`%2e%2e` 是），
    // 所以 URL 客户端不会替我们把它抹平，服务端会真的收到这个段并自行解码 ——
    // 这正是解析层那条 `/%2e%2e%2f` 断言在 HTTP 层的对应物。
    const response = await fetch(`${site.url}/source-and-license/..%2findex.html`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(HOME_MARK);
  });
});

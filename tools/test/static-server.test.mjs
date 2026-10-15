// tools/static-server.mjs 的测试。
//
// 这个服务器只服务于 e2e smoke，但它是一个会监听端口、按 URL 读磁盘的进程，
// 路径穿越与白名单绕过必须在无浏览器的情况下也被证明挡住 —— Playwright 在 CI 上
// 可能因浏览器未下载而跳过，安全断言不能跟着一起消失。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticServer, resolveSafePath } from '../static-server.mjs';

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

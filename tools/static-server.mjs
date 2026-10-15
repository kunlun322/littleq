#!/usr/bin/env node
// 最小静态文件服务器：只为 e2e smoke 提供构建产物（artifacts/bundles/*.js）。
//
// 刻意不做的事：没有 HMR、没有 watch、没有 SPA fallback、没有目录列表。
// M1 Stage 1-1 还没有任何产品页面，Playwright 需要一个能真正加载 bundle 的地址，
// 于是有了这个 60 行的服务器；它不是开发服务器，也不打算长成开发服务器。
//
// 安全约束（本地工具同样按公开标准写）：
//   - 只监听 127.0.0.1，不对外暴露；
//   - 只服务 --allow 白名单内的前缀，默认仅 artifacts/，因此 .git、.env、config/ 不可达；
//   - 解析后必须仍落在 root 内，挡住 ../ 穿越；
//   - 拒绝任何以 . 开头的路径段（点文件）；
//   - 不提供目录列表，目录请求一律 404。
import { createServer } from 'node:http';
import { statSync, createReadStream, existsSync } from 'node:fs';
import { extname, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function resolveSafePath(root, urlPath, allowedPrefixes) {
  // decodeURIComponent 遇到畸形百分号编码（/%、/%zz）会抛 URIError。
  // 这是外部输入，必须当成「拒绝」而不是让请求处理器崩掉整个进程。
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '');
  } catch {
    return null;
  }
  if (decoded.split('/').some((segment) => segment.startsWith('.') && segment !== '')) return null;
  const candidate = resolve(root, `.${normalize(decoded).replaceAll(sep, '/')}`);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) return null;
  const posixRel = rel.replaceAll(sep, '/');
  if (!allowedPrefixes.some((prefix) => posixRel === prefix || posixRel.startsWith(`${prefix}/`)))
    return null;
  return candidate;
}

export function createStaticServer({
  root = process.cwd(),
  port = 0,
  host = '127.0.0.1',
  allow = ['artifacts'],
}) {
  const allowedPrefixes = allow.map((prefix) => prefix.replace(/^\/+|\/+$/g, ''));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname === '/__health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify({ ok: true, allow: allowedPrefixes })}\n`);
      return;
    }
    const file = resolveSafePath(root, url.pathname, allowedPrefixes);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('404 Not Found\n');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolvePromise({
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () => new Promise((done) => server.close(done)),
        server,
      });
    });
  });
}

function parseArgs(argv) {
  const args = { root: process.cwd(), port: 4173, host: '127.0.0.1', allow: ['artifacts'] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--port') args.port = Number(argv[++i]);
    else if (flag === '--host') args.host = argv[++i];
    else if (flag === '--root') args.root = resolve(argv[++i]);
    else if (flag === '--allow') args.allow = argv[++i].split(',').filter(Boolean);
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`未知参数：${flag}`);
  }
  return args;
}

const invokedDirect =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirect) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      '用法：node tools/static-server.mjs [--port 4173] [--host 127.0.0.1] [--root .] [--allow artifacts]\n',
    );
  } else {
    const started = await createStaticServer(args);
    process.stdout.write(
      `静态服务器：${started.url}（白名单 ${args.allow.join(', ')}；根 ${relative(process.cwd(), args.root) || '.'}）\n`,
    );
    process.stdout.write(`健康检查：${started.url}/__health\n`);
    const shutdown = () => {
      started.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

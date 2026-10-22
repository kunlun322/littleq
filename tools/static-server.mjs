#!/usr/bin/env node
// 最小静态文件服务器：为 e2e smoke 提供构建产物。
// ZLQ-232 起它只服务一份东西 —— 仓库根的 artifacts/（esbuild 合规 bundle），
// 保持白名单前缀形态。站点那一份不再由它承载：apps/web 已翻成服务构建，
// `apps/web/out` 不复存在，e2e 改由 `next start` 直接起 apps/web/.next（见 playwright.config.ts）。
// 下面「目录 → index.html」的能力因此在本仓库里暂时没有调用方，但它是这台服务器的既定
// 边界（ZLQ-190 §6.2 要求过、也有测试钉着），不随这次形态切换删掉。
//
// 刻意不做的事：没有 HMR、没有 watch、没有 SPA fallback、**没有目录列表**。
// ZLQ-190 §6.2 要求它「支持目录 index.html」，这条能力的边界写死在这里：
// 目录请求只会被改写成该目录下的 `index.html`，改写结果**重新过一遍全部守卫**；
// 目录里没有 index.html 就仍然 404，绝不会退化成列目录。
//
// 安全约束（本地工具同样按公开标准写）：
//   - 只监听 127.0.0.1，不对外暴露；
//   - 只服务 --allow 白名单内的前缀，默认仅 artifacts/，因此 .git、.env、config/ 不可达；
//     `--allow .` 是**显式**的「整个 root 都可服务」，空 --allow 则什么都不可服务（失败关闭）；
//   - 解析后必须仍落在 root 内，挡住 ../ 穿越；
//   - 拒绝任何以 . 开头的路径段（点文件）；
//   - 不提供目录列表，目录请求一律 404（除非该目录下正好有 index.html）。
import { createServer } from 'node:http';
import { statSync, createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
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

/** 目录请求唯一允许改写到的文件名。硬编码常量，不含分隔符与点号，因此不可能被用来穿越。 */
const INDEX_FILE = 'index.html';

/** `--allow .` 归一成空前缀，空前缀的含义是「root 整体」；其余前缀去掉首尾斜杠。 */
export function normalizeAllowPrefixes(allow) {
  return allow
    .map((prefix) => prefix.replace(/^\/+|\/+$/g, ''))
    .map((prefix) => (prefix === '.' ? '' : prefix));
}

/**
 * 全部路径守卫的唯一实现，输入是**已解码**的 URL 路径。
 * resolveSafePath 与目录 → index.html 改写共用它，所以「改写后的目标」与
 * 「直接请求的目标」受到的检查逐字相同 —— 这是新增能力不放宽安全边界的理由。
 */
function guard(root, decoded, prefixes) {
  if (decoded.split('/').some((segment) => segment.startsWith('.') && segment !== '')) return null;
  const candidate = resolve(root, `.${normalize(decoded).replaceAll(sep, '/')}`);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) return null;
  const posixRel = rel.replaceAll(sep, '/');
  // 空前缀 = root 整体可服务。它必须显式出现在 prefixes 里，
  // 默认的 ['artifacts'] 与空的 [] 都不会命中这一支。
  if (
    !prefixes.some(
      (prefix) => prefix === '' || posixRel === prefix || posixRel.startsWith(`${prefix}/`),
    )
  )
    return null;
  return candidate;
}

/** 对已经是绝对路径的目标重跑一遍守卫，用于「目录 + index.html」这类由代码拼出的路径。 */
function guardAbsolute(root, absolute, prefixes) {
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) return null;
  return guard(root, `/${rel.replaceAll(sep, '/')}`, prefixes);
}

function tryDecode(urlPath) {
  // decodeURIComponent 遇到畸形百分号编码（/%、/%zz）会抛 URIError。
  // 这是外部输入，必须当成「拒绝」而不是让请求处理器崩掉整个进程。
  try {
    return decodeURIComponent(urlPath.split('?')[0] ?? '');
  } catch {
    return null;
  }
}

export function resolveSafePath(root, urlPath, allowedPrefixes) {
  const decoded = tryDecode(urlPath);
  if (decoded === null) return null;
  return guard(root, decoded, allowedPrefixes);
}

/**
 * HTTP 层用的解析入口：在 resolveSafePath 之上只多做一件事 —— 目录请求改写到该目录下的
 * index.html。resolveSafePath 的契约（含「白名单目录本身能解析出路径」）保持原样，
 * 既有测试与安全断言全部继续针对它，不会被这条新能力悄悄改写。
 * 返回 null 表示拒绝；返回的路径仍可能不存在，由调用方按 404 处理。
 */
export function resolveRequestTarget(root, urlPath, allowedPrefixes) {
  const prefixes = normalizeAllowPrefixes(allowedPrefixes);
  const decoded = tryDecode(urlPath);
  if (decoded === null) return null;

  const direct = guard(root, decoded, prefixes);
  // guard 拒绝 rel === ''：仓库根本身不是一个可服务的文件。但当 root 整体可服务时，
  // `/` 必须能应答，于是把它显式落到根下的 index.html —— 走的还是同一个 guard。
  const isRootRequest = decoded === '' || decoded === '/';
  const target =
    direct ??
    (isRootRequest && prefixes.includes('') ? guard(root, `/${INDEX_FILE}`, prefixes) : null);
  if (!target) return null;

  if (!existsSync(target) || !statSync(target).isDirectory()) return target;
  const index = guardAbsolute(root, join(target, INDEX_FILE), prefixes);
  // 目录里没有 index.html 时，这里交回的是那个**改写后但不存在**的路径，不是 null：
  // 解析层只判「守卫过没过、该改写成谁」，存不存在由 HTTP 层 isFile() 判 404（与
  // resolveSafePath 的契约一致）。真正的不变量是改写目标只可能是 INDEX_FILE 这一个
  // 硬编码文件名，因此永远不会返回目录本身 —— 返回目录就等于给「列目录」留了口子。
  return index;
}

export function createStaticServer({
  root = process.cwd(),
  port = 0,
  host = '127.0.0.1',
  allow = ['artifacts'],
}) {
  const allowedPrefixes = normalizeAllowPrefixes(allow);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname === '/__health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      // 报告**生效**的前缀；空前缀回写成 '.'，因为它本身就是一个合法的 --allow 取值，
      // 这样 e2e 断言的字符串与人能输入的字符串是同一个。
      response.end(
        `${JSON.stringify({ ok: true, allow: allowedPrefixes.map((prefix) => prefix || '.') })}\n`,
      );
      return;
    }
    const file = resolveRequestTarget(root, url.pathname, allowedPrefixes);
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
      '用法：node tools/static-server.mjs [--port 4173] [--host 127.0.0.1] [--root .] [--allow artifacts]\n' +
        '  --allow  逗号分隔的白名单前缀；`.` 表示 root 整体可服务；留空则什么都不可服务。\n' +
        '  目录请求只会改写到该目录下的 index.html，永远不列目录。\n',
    );
  } else {
    const started = await createStaticServer(args);
    process.stdout.write(
      `静态服务器：${started.url}（白名单 ${args.allow.join(', ') || '<空，什么都不可服务>'}；根 ${relative(process.cwd(), args.root) || '.'}）\n`,
    );
    process.stdout.write(`健康检查：${started.url}/__health\n`);
    const shutdown = () => {
      started.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

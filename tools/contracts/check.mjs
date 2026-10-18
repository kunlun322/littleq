#!/usr/bin/env node
// 生成一致性门禁 `contract:check`（附录 A §4.2 A）。
//
//   1. 从已构建的 @littleq/api-contract 生成 OpenAPI 与错误目录；
//   2. 规范化后与 committed snapshot **逐字节**比较；
//   3. 任一差异以 CONTRACT_SNAPSHOT_DRIFT 退出非零，并打印首批 JSON Pointer 差异。
//
// 为什么是逐字节而不是「语义等价」：语义等价比较需要一个"什么算语义"的定义，而那个定义
// 一旦比生成器宽松，就会出现「check 绿、快照里的字节却和生成器不一致」的状态 —— 下一次
// 任何人重新生成都会带出一份看似无关的排版 diff，把真正的契约变化埋在里面（这也是
// .prettierignore 要排除 contracts/ 的同一条理由）。逐字节没有这个缝。
//
// **本命令刻意不提供 --write。** 能自动重写快照的 check 一旦进了 verify 链路，
// 「生成结果与已提交快照一致」就永远为真，门禁当场失效（§4.2 A 第 4 条）。
// 要更新快照只能显式跑 `pnpm contract:generate`，那是一次有意的动作，会留在 diff 里。
//
// 用法：pnpm contract:check [--repo-root DIR] [--json] [--quiet] [--max-diffs N]
// 退出码：0 一致；1 CONTRACT_SNAPSHOT_DRIFT / CONTRACT_SNAPSHOT_MISSING；2 前置条件缺失（包未构建）。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTRACT_PATHS,
  ContractGenerateError,
  REPO_ROOT,
  compareCodePoints,
  generateSnapshotTexts,
  sha256Hex,
} from './generate.mjs';

const DRIFT = 'CONTRACT_SNAPSHOT_DRIFT';
const MISSING = 'CONTRACT_SNAPSHOT_MISSING';

function escapeToken(token) {
  return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}

// 递归收集差异，产出 RFC 6901 JSON Pointer。对象按 key 比较（顺序无关，规范化后本就有序），
// 数组按**下标**比较 —— 数组顺序是有语义的（enum、required、security 的 OR 分支），
// 所以「同一批元素换了顺序」必须报成差异，不能被当成集合相等放过去。
export function diffJson(base, head, pointer = '', out = [], limit = Number.POSITIVE_INFINITY) {
  if (out.length >= limit) return out;
  const push = (entry) => {
    if (out.length < limit) out.push(entry);
    return out;
  };

  if (Array.isArray(base) || Array.isArray(head)) {
    if (!Array.isArray(base) || !Array.isArray(head)) {
      return push({ pointer: pointer || '/', kind: 'changed', base, head });
    }
    const length = Math.max(base.length, head.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= base.length) push({ pointer: `${pointer}/${index}`, kind: 'added', head: head[index] });
      else if (index >= head.length)
        push({ pointer: `${pointer}/${index}`, kind: 'removed', base: base[index] });
      else diffJson(base[index], head[index], `${pointer}/${index}`, out, limit);
      if (out.length >= limit) return out;
    }
    return out;
  }

  if (base !== null && head !== null && typeof base === 'object' && typeof head === 'object') {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort(compareCodePoints);
    for (const key of keys) {
      const child = `${pointer}/${escapeToken(key)}`;
      if (!Object.hasOwn(base, key)) push({ pointer: child, kind: 'added', head: head[key] });
      else if (!Object.hasOwn(head, key)) push({ pointer: child, kind: 'removed', base: base[key] });
      else diffJson(base[key], head[key], child, out, limit);
      if (out.length >= limit) return out;
    }
    return out;
  }

  if (!Object.is(base, head)) push({ pointer: pointer || '/', kind: 'changed', base, head });
  return out;
}

export function parseArgs(argv) {
  const args = { repoRoot: REPO_ROOT, json: false, quiet: false, maxDiffs: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--repo-root') args.repoRoot = resolve(argv[(i += 1)]);
    else if (token === '--json') args.json = true;
    else if (token === '--quiet') args.quiet = true;
    else if (token === '--max-diffs') args.maxDiffs = Number.parseInt(argv[(i += 1)], 10);
    else throw new Error(`未知参数：${token}`);
  }
  if (!Number.isInteger(args.maxDiffs) || args.maxDiffs < 1) {
    throw new Error(`--max-diffs 必须是正整数，收到 ${args.maxDiffs}`);
  }
  return args;
}

export async function runCheck({ repoRoot = REPO_ROOT, maxDiffs = 20 } = {}) {
  const texts = await generateSnapshotTexts(repoRoot);
  const targets = [
    { id: 'openapi', rel: CONTRACT_PATHS.openapi, generated: texts.openapi },
    { id: 'errorCatalog', rel: CONTRACT_PATHS.errorCatalog, generated: texts.errorCatalog },
  ];

  const results = [];
  for (const target of targets) {
    const file = join(repoRoot, target.rel);
    if (!existsSync(file)) {
      results.push({
        id: target.id,
        path: target.rel,
        diagnosis: MISSING,
        diffs: [],
        identical: false,
        detail: '仓库里没有这份 committed snapshot。首次落库请显式运行 pnpm contract:generate。',
      });
      continue;
    }
    const committed = readFileSync(file, 'utf8');
    const generated = target.generated;
    if (committed === generated) {
      results.push({
        id: target.id,
        path: target.rel,
        diagnosis: null,
        diffs: [],
        identical: true,
        bytes: Buffer.byteLength(committed, 'utf8'),
        sha256: sha256Hex(committed),
      });
      continue;
    }
    // 走到这里说明字节不同。优先给出结构化 Pointer 差异；解析失败（例如有人把快照改成了
    // 非法 JSON）就退化成纯字节报告，而不是抛异常让门禁以"崩溃"收场。
    let diffs;
    try {
      diffs = diffJson(JSON.parse(committed), JSON.parse(generated), '', [], maxDiffs);
    } catch {
      diffs = [{ pointer: '/', kind: 'changed', detail: 'committed snapshot 不是合法 JSON' }];
    }
    results.push({
      id: target.id,
      path: target.rel,
      diagnosis: DRIFT,
      diffs,
      identical: false,
      committedSha256: sha256Hex(committed),
      generatedSha256: sha256Hex(generated),
      detail:
        diffs.length === 0
          ? '字节不同但 JSON 语义相同 —— 说明入库那份没有按 §4.1 的规范化规则写（排版/换行/末尾空行），' +
            '同样算漂移：下一次重新生成会带出一份纯排版的 diff。'
          : undefined,
    });
  }
  return results;
}

function preview(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '<undefined>';
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let results;
  try {
    results = await runCheck({ repoRoot: args.repoRoot, maxDiffs: args.maxDiffs });
  } catch (error) {
    const message =
      error instanceof ContractGenerateError ? error.message : (error.stack ?? error.message);
    process.stderr.write(`!! 无法生成契约：${message}\n`);
    process.exit(2);
  }

  const failed = results.filter((item) => !item.identical);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, results }, null, 2)}\n`);
    process.exit(failed.length === 0 ? 0 : 1);
  }

  const line = (text = '') => {
    if (!args.quiet) process.stdout.write(`${text}\n`);
  };
  line('== 契约生成一致性门禁 ==');
  for (const item of results) {
    if (item.identical) {
      line(
        `  ✓ ${item.path} 与生成结果逐字节相同（${item.bytes} 字节，sha256 ${item.sha256.slice(0, 12)}…）`,
      );
      continue;
    }
    line(`  ✗ ${item.path}：${item.diagnosis}`);
    if (item.detail) line(`    ${item.detail}`);
    for (const diff of item.diffs) {
      const where = diff.pointer === '/' ? '<整个文档>' : diff.pointer;
      line(`    - ${diff.kind} ${where}`);
      if (diff.kind === 'changed') line(`        base=${preview(diff.base)}  head=${preview(diff.head)}`);
      else if (diff.kind === 'removed') line(`        已提交里有、生成结果里没有：${preview(diff.base)}`);
      else line(`        生成结果里有、已提交里没有：${preview(diff.head)}`);
    }
    if (item.committedSha256) {
      line(`    committed sha256 ${item.committedSha256}`);
      line(`    generated sha256 ${item.generatedSha256}`);
    }
  }

  if (failed.length === 0) {
    line('结果：快照与生成器一致。');
    process.exit(0);
  }
  line('');
  line(
    `结果：${failed.length} 份快照漂移（${failed.map((item) => item.path).join(', ')}）。`,
  );
  line(
    '修法只有两种，且都必须是有意的动作：把 packages/api-contract 改回与快照一致，' +
      '或跑 pnpm contract:generate 重写快照并在 PR 里说明契约为什么变了。',
  );
  line('本命令不会自动覆盖快照。');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`!! ${error.stack ?? error.message}\n`);
    process.exit(2);
  });
}

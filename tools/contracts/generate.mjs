#!/usr/bin/env node
// 契约快照生成器（附录 A §3.2 / §4.1）。
//
// 这里只做两件事：**生成**与**规范化**。判定在 check.mjs / compatibility.mjs，
// 三者共享本文件的规范化函数 —— 规范化只写一份，是为了让「生成结果」与「比较输入」
// 永远是同一种字节形状。若两处各写一套排序，check 会因为排版差异报漂移，
// compat 会因为排版差异漏报语义变更，两边都是假的。
//
// 规范化规则（§4.1 逐字）：UTF-8、LF、2 空格、末尾换行、对象 key 递归排序；
// 仅对语义无序集合排序，不改变 enum、oneOf 或优先级数组的语义顺序；禁止时间戳和环境路径。
// 落地上是三条硬约束：
//   1. **所有**对象 key 递归按码点排序（对象在 JSON 里本来就是无序映射）；
//   2. 数组**只**排 JSON Schema 的 `required` —— 它的规范定义是「唯一的字符串集合」，
//      顺序无语义，而 zod 按 shape 声明顺序产出它；不排的话，仅仅调换两个字段的声明
//      次序就会让快照出现一份纯排版的 diff，把真正的契约变化埋在里面（§4.1 要排的
//      「语义无序集合」在这里就是它）。
//   3. 其余数组一律原样保留：`enum`、`anyOf`/`oneOf`（§4.1 点名不许动）、`tags`、
//      `servers`、`security` 的 OR 分支、`parameters`、`x-littleq-error-codes`
//      （生成器已按稳定规则排过）顺序都是契约的一部分。
// 排序比较用码点（`<` / `>`），**不用 `localeCompare`** —— 后者跟 ICU locale 走，
// 同一份源码在不同 LANG 下能给出不同顺序（PM G6 点名的宿主差异来源之一）。
//
// 用法：pnpm contract:generate [--repo-root DIR] [--out DIR] [--bootstrap-base SHA] [--quiet]
// 退出码：0 写出成功；2 前置条件缺失（包未构建 / 生成器抛错）。
//
// 注意：本命令**不在** `pnpm verify` 链路里。verify 跑的是只读的 contract:check ——
// 能自动重写快照的生成器一旦进了 verify，「生成结果与已提交快照一致」这条门禁就
// 永远为真，等于没有门禁（§4.2 A 第 4 条）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = dirname(resolve(import.meta.filename));
export const REPO_ROOT = resolve(HERE, '..', '..');

// 快照路径同时被 check / compat / control / CI 使用，所以在这里定一次。
export const CONTRACT_PATHS = Object.freeze({
  openapi: 'contracts/openapi/v1/openapi.json',
  errorCatalog: 'contracts/errors/v1/error-catalog.json',
  bootstrap: 'contracts/openapi/v1/bootstrap.json',
});

// 设计基线（附录 B「bootstrap 同步修正」）：只作溯源，不参与任何判定，也**不**等于
// bootstrap 的 `introducedFromBase`（那个必须是本次事件真正解析出的 base commit）。
export const DESIGN_BASELINE_SHA = '88edd3f57ebf3fa34dd86c083a2757f21d969c9b';

export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function compareCodePoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 只对「全是字符串的 required 数组」排序。OpenAPI 的 parameter/requestBody 上也有一个
// 叫 `required` 的键，但那是布尔值，这里的类型守卫天然把它排除掉。
function isUnorderedStringSet(key, value) {
  return key === 'required' && Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// 递归排序对象 key；数组仅排 `required`（见文件头第 2 条）。
export function normalizeKeys(value, key = null) {
  if (Array.isArray(value)) {
    const mapped = value.map((item) => normalizeKeys(item));
    return isUnorderedStringSet(key, value) ? [...mapped].sort(compareCodePoints) : mapped;
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const child of Object.keys(value).sort(compareCodePoints)) {
      out[child] = normalizeKeys(value[child], child);
    }
    return out;
  }
  return value;
}

// 序列化成入库字节：2 空格 + LF + 末尾换行。
// JSON.stringify 只产生 \n（不产生 \r），数字格式由 ECMAScript Number::toString 规定，
// 两者都与平台、locale 无关，所以这一步不需要额外的 EOL 处理（PM G6）。
export function serializeSnapshot(value) {
  return `${JSON.stringify(normalizeKeys(value), null, 2)}\n`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 以**相对路径**导入已构建产物，而不是把 @littleq/api-contract 加成仓库根的 workspace 依赖。
// 附录 B G4 明确：「仓库根工具不得新增对它的 workspace 依赖，生成入口应放在 api-contract
// 自身 script/CLI 内」。生成逻辑（createOpenApiDocument / errorCatalogDocument）确实全部住在
// 包内，本文件只是把它落盘的薄 CLI；相对导入 dist 让「从已构建的包生成」（§4.2 A 第 1 条）
// 与 G4 同时成立。代价是必须先 build —— verify 链路里 contract:check 就排在 build 之后。
export async function loadApiContract(repoRoot = REPO_ROOT) {
  const entry = join(repoRoot, 'packages', 'api-contract', 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new ContractGenerateError(
      `找不到已构建的 API 契约包：${relative(repoRoot, entry)}\n` +
        `   先跑 pnpm build（verify 链路里 contract:* 就排在 build 之后）。`,
    );
  }
  return import(pathToFileURL(entry).href);
}

export class ContractGenerateError extends Error {}

// 生成两份快照的**文本**。不落盘，方便 check.mjs 拿它与已提交字节比较。
export async function generateSnapshotTexts(repoRoot = REPO_ROOT) {
  let api;
  try {
    api = await loadApiContract(repoRoot);
  } catch (error) {
    if (error instanceof ContractGenerateError) throw error;
    throw new ContractGenerateError(`导入 @littleq/api-contract 失败：${error.message}`);
  }
  for (const name of ['createOpenApiDocument', 'errorCatalogDocument', 'API_MAJOR']) {
    if (api[name] === undefined) {
      throw new ContractGenerateError(
        `已构建的 @littleq/api-contract 没有导出 ${name} —— dist 过期或包结构变了，重新 pnpm build。`,
      );
    }
  }

  let openApiDocument;
  let errorCatalog;
  try {
    openApiDocument = api.createOpenApiDocument();
    errorCatalog = api.errorCatalogDocument(api.API_MAJOR);
  } catch (error) {
    // 生成器内部的断言（operationId 唯一、错误码全覆盖、无泄露字段名）在这里抛出。
    // 这类失败必须挡住落盘，否则会写出一份自己都校验不过的快照。
    throw new ContractGenerateError(`契约生成器自检失败：${error.message}`);
  }

  return {
    openapi: serializeSnapshot(openApiDocument),
    errorCatalog: serializeSnapshot(errorCatalog),
  };
}

// bootstrap.json（§4.2 B「首次落库」）是一份**派生记录**：两份 snapshot 的 sha256 必须
// 逐字等于当次 head 的字节，所以它不能手写 —— 手写的那份一旦与生成结果不一致，
// compat 的 bootstrap 分支就会以 CONTRACT_BOOTSTRAP_INVALID 变红，而红的原因看不出来。
// 因此它也走生成器，但必须**显式**要（`--bootstrap-base <sha>`）：本任务之后不会再有首落，
// 默认每次 generate 都重写它等于让「一次性凭据」变成可以随手刷新的东西。
export function buildBootstrapDocument({ introducedFromBase, texts }) {
  if (!COMMIT_SHA_PATTERN.test(String(introducedFromBase))) {
    throw new ContractGenerateError(
      `--bootstrap-base 必须是 40 位小写 commit SHA，收到 ${String(introducedFromBase)}`,
    );
  }
  return {
    apiMajor: 1,
    designBaseline: DESIGN_BASELINE_SHA,
    introducedFromBase,
    snapshots: {
      [CONTRACT_PATHS.openapi]: sha256Hex(texts.openapi),
      [CONTRACT_PATHS.errorCatalog]: sha256Hex(texts.errorCatalog),
    },
  };
}

export function parseArgs(argv) {
  const args = { repoRoot: REPO_ROOT, out: null, quiet: false, bootstrapBase: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--repo-root') args.repoRoot = resolve(argv[(i += 1)]);
    else if (token === '--out') args.out = resolve(argv[(i += 1)]);
    else if (token === '--bootstrap-base') args.bootstrapBase = argv[(i += 1)];
    else if (token === '--quiet') args.quiet = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (args.bootstrapBase === undefined) throw new Error('--bootstrap-base 需要一个值');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.out ?? args.repoRoot;
  let texts;
  let bootstrap;
  try {
    texts = await generateSnapshotTexts(args.repoRoot);
    bootstrap =
      args.bootstrapBase === null
        ? null
        : serializeSnapshot(buildBootstrapDocument({ introducedFromBase: args.bootstrapBase, texts }));
  } catch (error) {
    process.stderr.write(`!! ${error.message}\n`);
    process.exit(2);
  }

  const targets = [
    [CONTRACT_PATHS.openapi, texts.openapi],
    [CONTRACT_PATHS.errorCatalog, texts.errorCatalog],
  ];
  if (bootstrap !== null) targets.push([CONTRACT_PATHS.bootstrap, bootstrap]);
  for (const [rel, text] of targets) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
    if (!args.quiet) {
      process.stdout.write(
        `写出 ${rel}（${Buffer.byteLength(text, 'utf8')} 字节，sha256 ${sha256Hex(text).slice(0, 12)}…）\n`,
      );
    }
  }
  if (!args.quiet) {
    process.stdout.write(
      '提示：本命令不在 verify 链路里。verify 跑只读的 contract:check，' +
        '重写快照必须是一次显式动作。\n',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`!! ${error.stack ?? error.message}\n`);
    process.exit(2);
  });
}

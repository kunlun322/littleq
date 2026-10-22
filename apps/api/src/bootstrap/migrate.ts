/**
 * 形态 B 的**部署期迁移入口**（ZLQ-157 §5.4）。
 *
 * 设计原文：「初次安装/升级由**本地CLI迁移阶段**执行direct连接，不是平台build script、
 * 不在请求冷启动。」所以这个文件是一条命令，不是一个中间件：
 *
 *   pnpm --filter @littleq/api migrate
 *
 * 它与装配根 `vercel.ts` 的分工是**驱动级的**，不是风格偏好：
 *
 * | 用途 | 工厂 | 驱动 | 连接串来源 | 为什么 |
 * | --- | --- | --- | --- | --- |
 * | 迁移（本文件） | `createPgClientSource` | `pg` TCP | `DATABASE_DIRECT_URL` | DDL 要一条独占的长会话去持 `pg_advisory_xact_lock`；池化代理会在会话中途换后端，事务级 advisory lock 因此不可靠 |
 * | 运行时（`vercel.ts`） | `createNeonClientSource` | `@neondatabase/serverless` WebSocket `Pool` | `DATABASE_URL` / `LITTLEQ_DATABASE_URL`（含 `-pooler`） | serverless 函数不能占 TCP 连接；短事务走池化端点 |
 *
 * 两个工厂都只接受 `{connectionString, maxConnections?}`，连接串**逐字原样**交给驱动
 * （不发明 TLS 选项、不猜超时、不塞应用名——`packages/infra/src/sql/sources.ts` 的文件头
 * 已经把这条写成契约）。本文件唯一自己决定的数是 `maxConnections: 1`：迁移按定义是串行
 * 独占的，多开连接不会更快，只会让两个会话去抢同一把 advisory lock。
 *
 * ## 值不进输出（红线）
 *
 * `PostgresDatabaseAdapter.migrate()` **不包装**驱动异常：`pg` 自己的 `Error.message`
 * 会原样冒出来，而它常常印着连接目标（`ECONNREFUSED <host>:<port>`、
 * `getaddrinfo ENOTFOUND <host>`）——连接目标就是连接串的一部分，而连接串带着口令。
 * 所以这里对所有往 stdout/stderr 写的文本做一次 `redactSecrets`：把连接串本身、
 * 以及从它解析出来的主机名，替换成 `[REDACTED]`。
 *
 * 这不是"防一下"，是一条可以被测试抓住的断言：`redactSecrets` 是导出的纯函数，
 * `apps/api/test/bootstrap-migrate.test.ts` 用一条假连接串做**阳性对照**
 * （先证明它没被调用时确实会漏，再证明调用后不漏）。
 *
 * ## 退出码就是"迁移失败不许起服务"的执行点
 *
 * 失败一律 `process.exitCode = 1`。§5.4 把迁移放在部署流水线的一个阶段，而部署阶段
 * 的语义是"非零即中止"：迁移没过，后面那一步（把流量指过来）就不会发生。
 * ⚠️ 但这半条链的**另一半不在本仓库里**——`littleq` 这个 Vercel 项目现在只构建
 * `apps/web`，没有任何东西会先跑这条命令。所以"迁移失败 ⇒ 服务起不来"目前只在
 * 命令这一半成立，另一半和「`apps/api` 由谁部署」是同一个待裁定的拓扑问题，
 * 在交付评论里单独标了 `blocked`。
 *
 * ⚠️ 另一处**如实申报的缺口**：`getReadyHealth` 的数据库探针是 `SELECT 1`，
 * 一个**可达但没迁移过**的库会让它返回 200。也就是说本文件管得住"迁移跑不起来"，
 * 管不住"服务对着空 schema 说自己 ready"。要堵这一条得在就绪探针里加一次
 * `schema_migrations` 查询，那是一条设计里没有的新门，按红线**不自行增加**，申报待裁。
 */
import { pathToFileURL } from 'node:url';

import {
  PostgresDatabaseAdapter,
  createPgClientSource,
  isInfraError,
  type MigrationReport,
  type SqlMigration,
} from '@littleq/infra';

import {
  BootstrapConfigError,
  FORM_B_MIGRATION_URL_ENV_VAR,
  migrationConnectionOf,
  resolveFormBConfig,
  type EnvSource,
} from './config.js';

/** 迁移会话数。串行的 advisory lock 只需要一条；见文件头。 */
const MIGRATION_MAX_CONNECTIONS = 1;

const REDACTED = '[REDACTED]';

export interface MigrationIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface RunFormBMigrationsOptions {
  readonly env: EnvSource;
  /** 只为测试存在：默认 `SQL_MIGRATIONS`，注入篡改过的迁移来跑失败臂。 */
  readonly migrations?: readonly SqlMigration[];
  readonly io?: MigrationIo;
}

export interface FormBMigrationOutcome {
  readonly report: MigrationReport;
  readonly directUrlVariable: typeof FORM_B_MIGRATION_URL_ENV_VAR;
  readonly elapsedMs: number;
}

/**
 * 把 `secrets` 里出现过的每一个串替换成 `[REDACTED]`。
 *
 * 纯函数、不打印、不抛。空串与长度 < 4 的串直接忽略：拿 `''` 去 `replaceAll`
 * 会在每个字符之间插一个 `[REDACTED]`，把一个本来能读的错误变成噪音；
 * 而三四个字符的"秘密"更可能是误伤（`pg`、`5432`）而不是真的漏了口令。
 *
 * **长的先替换**，而且排序在本函数里做，不指望调用方排好：整串包含主机名，
 * 先替短的会把整串撕成两半、留下一截仍然可辨认的口令残片。把这个前提留在调用方
 * 等于给每一个将来的调用点埋一个只有脱敏失效时才暴露的坑。
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    if (secret.length < 4) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** 从一条连接串里取出所有"算秘密"的片段：整串 + 主机名 + 口令 + 用户名。 */
function secretsOf(connectionString: string): string[] {
  const found = new Set<string>([connectionString]);
  try {
    const url = new URL(connectionString);
    // 只放**解析出来的那几段**，不放整条 URL：`url.toString()` 会把 `pg` 已经
    // 规范化过的东西再吐回来，反而可能对不上原始文本、漏掉真正的命中。
    if (url.hostname.length >= 4) found.add(url.hostname);
    if (url.password.length >= 4) found.add(url.password);
    if (url.username.length >= 4) found.add(url.username);
  } catch {
    // 解析不出来就只按整串脱敏。这条路径在 `migrationConnectionOf` 里已经先被
    // `MIGRATION_URL_UNPARSEABLE` 挡住了，留着 catch 只是不让脱敏本身变成崩溃点。
  }
  return [...found];
}

function describeError(error: unknown, secrets: readonly string[]): string {
  if (isInfraError(error)) {
    // InfraError 的 message 就是它的 code（`packages/infra/src/errors.ts`），天生不含值。
    return `InfraError ${error.code}（publicCode=${error.publicCode} retryable=${String(error.retryable)}）`;
  }
  if (error instanceof BootstrapConfigError) {
    return `BootstrapConfigError ${error.code} 变量=[${error.variables.join(', ')}]`;
  }
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecrets(raw, secrets);
}

/**
 * 跑一次形态 B 迁移。成功返回报告；失败**抛**（由 `main` 转成非零退出码）。
 *
 * 顺序是刻意的：先解析配置（会拒掉 `LITTLEQ_DEPLOYMENT` 缺失/不一致、`SOURCE_CODE_URL`
 * 缺失），再取直连串（会拒掉池化地址）。配置不对就不该连库——一次连不上的库
 * 只会把"配置错了"伪装成"网络不通"。
 *
 * ⚠️ 一个反直觉的后果，说清楚免得下一个人以为是 bug：`resolveFormBConfig` 按 §3.1
 * 要求**运行串**存在，所以本命令会在缺少一个它根本不拨的变量（`DATABASE_URL` /
 * `LITTLEQ_DATABASE_URL`）时拒跑，报 `DATABASE_URL_MISSING`。这是"复用同一套形态自洽
 * 判定、不自建子集"的直接代价，而它换来的是：迁移永远不会跑在一个半配好的安装上。
 * 装错库比没装成危险得多。已被 `apps/api/test/bootstrap-migrate.test.ts` 钉住。
 */
export async function runFormBMigrations(
  options: RunFormBMigrationsOptions,
): Promise<FormBMigrationOutcome> {
  const io = options.io ?? consoleIo();
  const config = resolveFormBConfig(options.env);
  const direct = migrationConnectionOf(options.env);
  const secrets = secretsOf(direct.connectionString);

  const startedAt = Date.now();
  let report: MigrationReport;
  let adapter: PostgresDatabaseAdapter | undefined;
  // try 的范围刻意从 `createPgClientSource` 就开始：`secrets` 已经算出来了，而这之后任何
  // 一步失败都可能带着驱动原文（里面常有连接目标）。范围窄一格，就有一条错误路径没人脱敏。
  try {
    // 让驱动只在真的要用时才被加载（`packages/infra/src/sql/sources.ts:39`）。
    const source = await createPgClientSource({
      connectionString: direct.connectionString,
      maxConnections: MIGRATION_MAX_CONNECTIONS,
    });
    adapter = new PostgresDatabaseAdapter(
      options.migrations === undefined ? { source } : { source, migrations: options.migrations },
    );
    report = await adapter.migrate();
  } catch (error) {
    io.stderr(redactSecrets(`迁移失败：${describeError(error, secrets)}`, secrets));
    throw error;
  } finally {
    // 池不关，进程不会退出：`pg` 的空闲连接会把事件循环吊住，命令跑完了却永远不返回，
    // 部署阶段只能等超时。关池本身失败也不能盖掉迁移的原始失败，所以单独 catch。
    if (adapter !== undefined) {
      try {
        await adapter.close();
      } catch (error) {
        io.stderr(redactSecrets(`关闭迁移连接失败：${describeError(error, secrets)}`, secrets));
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  io.stdout(
    `迁移完成（${config.deployment} / ${config.platformEnv}）：` +
      `本次应用 ${String(report.applied.length)} 个版本` +
      `${report.applied.length > 0 ? `：${report.applied.join(', ')}` : ''}；` +
      `schema_migrations 累计 ${String(report.schemaVersion)} 条；耗时 ${String(elapsedMs)}ms。`,
  );
  io.stdout(`连接串来源：环境变量 ${direct.variableName}（直连，非 -pooler）。值不打印。`);
  return { report, directUrlVariable: direct.variableName, elapsedMs };
}

function consoleIo(): MigrationIo {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

/**
 * 命令行入口。**部署阶段的唯一执法点**：迁移失败 ⇒ `process.exitCode = 1` ⇒ 部署中止 ⇒
 * 服务起不来。这条链的另一半（谁来跑这条命令）不在本仓库里，见文件头缺口申报。
 *
 * ⚠️ 用 `exitCode` 而不是 `process.exit()`：`exit()` 会在 stdout 还是异步管道时
 * 把没冲完的输出直接丢掉，而这条命令的输出就是它唯一的交付物。
 *
 * `argv` / `env` / `io` 三个都能注入，默认值就是真进程的那三个。这不是为测试开的后门，
 * 而是让"退出码真的是 1"这件事可以在一台没有 Postgres 的机器上被断言 —— 否则这一条
 * 只能靠读代码相信。
 */
export interface MainOptions {
  readonly argv?: readonly string[];
  readonly env?: EnvSource;
  readonly io?: MigrationIo;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv;
  const io = options.io ?? consoleIo();
  if (argv.slice(2).length > 0) {
    io.stderr('这条命令不接受参数。连接串只从 DATABASE_DIRECT_URL 读，不从 argv 读。');
    process.exitCode = 2;
    return;
  }
  try {
    await runFormBMigrations({ env: options.env ?? process.env, io });
  } catch (error) {
    // 只有**构造上就不可能含值**的两类错误才在这里补一句：`BootstrapConfigError` 的
    // message 是固定码 + 变量名（`config.ts` 的构造函数），`InfraError` 的 message 就是
    // 码本身（`packages/infra/src/errors.ts:194` 的 `super(code)`）。
    //
    // 其余一律**不补**。驱动原文里常带连接目标，而 `runFormBMigrations` 已经写过一份
    // 脱敏的描述了 —— 在这里再 `String(error.message)` 一遍，等于把刚脱敏掉的东西原样
    // 放回 stderr。宁可少一句解释，也不打一个可能带口令的行。
    if (error instanceof BootstrapConfigError || isInfraError(error)) {
      io.stderr(`部署中止（exitCode=1）：${error.message}`);
    } else {
      io.stderr('部署中止（exitCode=1）：原因见上一行（已脱敏）。');
    }
    process.exitCode = 1;
  }
}

/** 直接执行本文件时才跑 `main`；被测试 import 时不跑。 */
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) await main();

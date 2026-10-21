/**
 * 真 Postgres 测试挂具（ZLQ-216 §7.1「真 DB 黑盒证据」）。
 *
 * ## 为什么它是**另一个**文件，而不是并入 `support.ts`
 *
 * `support.ts` 的文件头写着一条本层的硬约束：「每个值都是硬字面量或由入参确定性推导，
 * 没有一个来自宿主状态 —— 不读时钟、不读环境变量、不读 locale、不读文件系统」，理由是
 * 「一条依赖宿主状态的用例在 CI 与本机会给出不同判定，而那种分歧不会报错」。那条约束在
 * 夹具上完全成立，本文件一个字也不改它。
 *
 * 但 §7.1 要的是**真数据库上的黑盒证据**，而真数据库按定义就是宿主状态。两者不可调和，
 * 于是分开：确定性的那一半留在 `support.ts` 与 `migrations.test.ts` / `password-scrypt.test.ts`
 * / `uuidv7.test.ts`（它们钉 SQL 文本与形状，任何机器上都跑、都红得一样）；本文件只承担
 * "需要一台 Postgres"的那一半。
 *
 * ## 拿不到数据库时**大声失败**，既不静默通过、也不静默跳过
 *
 * 上面那条约束里最要命的半句是"那种分歧不会报错"。一个悄悄跳过的集成测试正是同一种病：
 * 门禁全绿，而绿的原因是根本没跑。所以这里**不返回 `null`**：探测不到可用的 Postgres 就
 * 直接抛，调用方在模块顶层 `await`，于是整个测试文件收集失败、里面的用例一律记成 failed
 * —— 数字不会消失，只会变红。
 *
 * 这条不是风格偏好，而是 ZLQ-194 §9.2 规则 5 的直接后果。`readiness-no-retirement-tokens`
 * 那道门把 `skipIf` 与 `skip` / `only` / `todo` 并列禁掉，理由写得很清楚：「被跳过的用例
 * 不会变红，只会消失」。早先这里的设计是「返回 `null` + 调用方 `describe.skipIf`」，指望
 * 执行器计数里的 skipped 把跳过暴露出来 —— 但计数只有在有人读它的时候才可见，而门要的是
 * **不读计数也藏不住**。于是挂具改成必得，`skipIf` 全部退场。
 *
 * 本文件**不提供任何内存替身**。§2.2 逐字：「若用户不愿完成此动作，不把 DB 换成
 * 进程内或浏览器存储来假交付」—— 拿不到真库时的正确答案是"这一项没有证据、并且红给
 * 所有人看"，不是"用假库造一条证据"，也不是"跳过然后宣布全绿"。
 *
 * ## 每次运行一个新数据库
 *
 * 不复用既有库：`CREATE DATABASE` 一个随机名的库、跑迁移、用完 `DROP`。这样测试可以
 * 断言"迁移从零建出全部表"（§3.2 的表清单）与"第二次运行是幂等的"，而不会因为上一轮
 * 留下的行给出假判定。库名只由 `lq_f1_test_` + 随机 hex 组成 —— 标识符不能参数化，
 * 所以它的字符集必须是白名单而不是"过滤黑名单"。
 */
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';

import {
  type AiTask,
  type ProjectId,
  type UserId,
  createAiTask,
  createProject,
  createUser,
  parseLoginName,
  parseLockDurationMinutes,
  parseMaxFailedAttempts,
  parseNickname,
} from '@littleq/domain';

import {
  createCollectionCursor,
  createTaskInputRef,
  createTaskPrivateRecord,
  type TaskPrivateRecord,
} from '@littleq/application';

import { PostgresDatabaseAdapter } from '../src/sql/postgres-adapter.js';
import { USER_INSERT_SQL, userInsertParams } from '../src/sql/account-rows.js';
import { PROJECT_INSERT_SQL, projectInsertParams } from '../src/sql/project-rows.js';
import { AI_TASK_INSERT_SQL, taskInsertParams } from '../src/sql/task-rows.js';
import { TASK_PRIVATE_INSERT_SQL, taskPrivateParams } from '../src/sql/task-private-rows.js';
import { newUuidV7 } from '../src/sql/uuidv7.js';
import { createPgClientSource, type SqlClientSourceOptions } from '../src/sql/sources.js';
import type { SqlClientSource } from '../src/sql/client.js';
import { EPOCH } from './support.js';

/** 让挂具用它的连接串；设了它就一定用它，不再去探测本机默认实例。 */
export const TEST_DATABASE_URL_ENV_VAR = 'LQ_TEST_DATABASE_URL';

const MISSING_DATABASE_HINT =
  `真 Postgres 测试需要一台可达的数据库，而一个都没有探测到。设 ${TEST_DATABASE_URL_ENV_VAR} ` +
  '指向一个可以随意建库/删库的 Postgres（例如 postgres://USER@127.0.0.1:5432/postgres）。' +
  '刻意不降级成跳过：§9.2 规则 5 禁止用 skipIf 让门禁静默通过，被跳过的用例不会变红，只会消失。';

/** DROP 前排干轮询的间隔。 */
const DRAIN_POLL_INTERVAL_MS = 20;

/**
 * DROP 前排干的上限。
 *
 * 取 20 秒是被两个已知数夹出来的，不是随手写的：下界要**大于** `pg-pool` 的默认
 * `idleTimeoutMillis = 10000` —— 万一某个测试漏了一个池没 `close()`，那些空闲 client
 * 会在 10 秒时被池自己 `end()` 掉，等得到就还能正常收场；上界要**远小于** vitest 的
 * `hookTimeout = 60_000`（`dispose()` 常在 `afterAll` 里跑），否则超时会先以
 * "hook timed out" 的形式出现，把真正的原因埋掉。
 *
 * 自然排干实测中位数 12–14 ms；把机器压到 8× 超订（160 个忙循环 / 20 核）后最大值也
 * 只有 97 ms（量法是进程外的 `pg_stat_activity` 轮询，数字见 ZLQ-227 的交付说明）。
 * 20 秒对中位数留着三个数量级的余量，对那个最大值也还有两百倍；CI 的 4 核 runner
 * 再慢一个量级也吃不满。
 */
const DRAIN_DEADLINE_MS = 20_000;

export type TestDatabaseHarness = {
  readonly adapter: PostgresDatabaseAdapter;
  /** 已迁移完成的那个**新建**数据库的连接串。不含口令时也不打印它（连接串是部署期秘密）。 */
  readonly connectionString: string;
  readonly databaseName: string;
  /** 关连接并 `DROP DATABASE`。必须在 `afterAll` 里调用，否则每次运行留一个库。 */
  dispose(): Promise<void>;
};

/**
 * 没有显式 URL 时探测本机约定实例。
 *
 * 只试**一次**、只试约定地址（当前 OS 用户 @ 127.0.0.1:5432/postgres，以及本机 unix
 * socket），并且带 3 秒连接超时。不做端口扫描、不读 `.pgpass`、不猜密码：猜错一次的代价
 * 是测试挂几十秒，而收益只是省掉一个环境变量。
 */
function candidateBaseUrls(): readonly string[] {
  const explicit = process.env[TEST_DATABASE_URL_ENV_VAR];
  if (explicit !== undefined && explicit.length > 0) return [explicit];
  let user = 'postgres';
  try {
    user = userInfo().username;
  } catch {
    // 拿不到用户名就退回 'postgres'：探测失败会走跳过路径，不值得为此抛。
  }
  return [`postgres://${user}@127.0.0.1:5432/postgres`, `postgres://${user}@/postgres`];
}

async function probe(baseUrl: string): Promise<SqlClientSource | null> {
  const options: SqlClientSourceOptions = { connectionString: baseUrl, maxConnections: 4 };
  let source: SqlClientSource;
  try {
    source = await createPgClientSource(options);
  } catch {
    return null;
  }
  try {
    const client = await source.connect();
    try {
      await client.query('SELECT 1 AS ok', []);
    } finally {
      await client.release();
    }
    return source;
  } catch {
    await source.end().catch(() => undefined);
    return null;
  }
}

function withDatabase(baseUrl: string, databaseName: string): string {
  // 连接串的形态是 `scheme://[user[:pass]@][host][:port][/db][?query]`。只替换路径段的
  // 数据库名，其余（含查询串里的 sslmode、host 是目录形式的 unix socket）原样保留。
  const withoutQuery = baseUrl.split('?')[0] ?? baseUrl;
  const query = baseUrl.length > withoutQuery.length ? baseUrl.slice(withoutQuery.length) : '';
  const lastSlash = withoutQuery.lastIndexOf('/');
  const authorityEnd = withoutQuery.indexOf('://');
  if (lastSlash < 0 || lastSlash < authorityEnd + 3) {
    return `${withoutQuery}/${databaseName}${query}`;
  }
  return `${withoutQuery.slice(0, lastSlash)}/${databaseName}${query}`;
}

/**
 * 服务器侧还挂着几条连到这个库的后端。
 *
 * `baseSource` 连的是**默认库**（`postgres`），所以它自己的连接不会落进 `datname = $1`
 * 这个过滤条件里 —— 不需要"排除自己"这种容易写错的特例。
 *
 * 可见性前提：非超级用户只能看见**同角色**的后端（`pg_stat_activity` 的权限规则）。
 * 这条在这里成立，因为连到这个一次性库的所有连接都来自同一个连接串、同一个角色，
 * 与 `baseSource` 用的是同一个。
 */
async function countDatabaseBackends(
  source: SqlClientSource,
  databaseName: string,
): Promise<number> {
  const client = await source.connect();
  try {
    const result = await client.query<{ readonly n: string }>(
      'SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1',
      [databaseName],
    );
    return Number(result.rows[0]?.n ?? '0');
  } finally {
    await client.release();
  }
}

/**
 * 等到服务器说"这个库上再没有后端了"，然后才允许 DROP。
 *
 * ## 为什么不能只等 `adapter.close()`
 *
 * `pg-pool@3.14.0` 的 `Pool.end()` 在它的 `_clients` 数组空掉时就 resolve，而
 * `_remove()` 是**同步**清空那个数组、之后才**不 await** 地调 `client.end()`
 * （`index.js:172-186`、`:133-145`、`:488-498`）。于是 `await adapter.close()` 返回时，
 * `Client.end()` 写出去的那个 terminate 报文（`0x58`）可能还在路上，后端仍活着 ——
 * 客户端的 `_ending: true, _ended: false` 就是这个中间态。紧接着的
 * `DROP DATABASE … WITH (FORCE)` 会把它强杀，服务器回一条 FATAL `57P01`
 * （`routine: ProcessInterrupts`）；那条错误落在一个**没人监听**的 pg client 上：
 * `pg-pool` 给每个 client 挂了 `idleListener`，它把错误转成 `pool.emit('error', …)`，
 * 而 `createPgClientSource` 没给 pool 注册 error 监听 ⇒ EventEmitter 直接抛 ⇒
 * vitest 记一条 unhandled error ⇒ 全绿的 1794 条用例照样退出码 1（ZLQ-227）。
 *
 * ## 为什么判据是服务器，而不是"我以为我关完了"
 *
 * 「`datname = 这个库` 的后端数为 0」是 DROP 之后不可能再有连接被强杀的**充分**条件，
 * 而且它对连接是**谁**建的不作任何假设：挂具自己的池、`secondaryAdapter` 的第二个池、
 * 将来某个测试自建的第三个 source，一律同等对待。反过来，只去 await 某一个池的
 * `end()`（哪怕它真的等到底）也覆盖不了 `postgres-drivers.test.ts` 里那些绕过挂具、
 * 直接连同一个库的路径 —— 而这条修法必须对它们同样成立。
 *
 * ## 为什么超时了要**抛**，而不是照样 DROP
 *
 * 20 秒还没排干，说明有条连接既没被任何 `close()` 覆盖、也没被 `pg-pool` 的空闲回收
 * 收走 —— 那是测试真的漏了连接，是个 bug。此时继续 `WITH (FORCE)` 等于把本函数要修的
 * 那场竞态**每次**都重造一遍，而且造在一个更难查的位置上。抛出的消息带着库名、剩余
 * 条数与已等时长，比一条不知道从哪来的 `57P01` 好查得多。
 *
 * 抛了会留下一个残留库，但残留库**不会**造成假绿：库名带 16 位随机 hex，下一轮不可能
 * 撞上它，因此"迁移从零建出全部表"那条断言永远不会跑在一个已经建好的库上。
 */
async function waitForDatabaseBackendsToDrain(
  source: SqlClientSource,
  databaseName: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const remaining = await countDatabaseBackends(source, databaseName);
    if (remaining === 0) return;
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= DRAIN_DEADLINE_MS) {
      throw new Error(
        `一次性测试库 ${databaseName} 等了 ${waitedMs}ms 仍有 ${remaining} 条后端连着它，` +
          '拒绝在这种状态下 DROP（那会重现 ZLQ-227 的 57P01 竞态）。' +
          '请检查是否有连接没有被 dispose() 覆盖。',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
  }
}

/**
 * 建一个一次性的**空**数据库。拿不到任何可用的 Postgres 时返回 `null`。
 *
 * **不在这里跑迁移**：迁移报告本身就是被测对象（首次应用 1 条、重跑应用 0 条、
 * checksum 被改过就报错），由 harness 代跑等于把「首次迁移建出了全部表」这条断言
 * 变成一条永远看不到首次的断言。调用方自己在 `beforeAll` 里跑
 * `harness.adapter.migrate()`。
 *
 * 调用方：
 * ```ts
 * const harness = await createTestDatabaseHarness();
 * afterAll(async () => { await harness.dispose(); });
 * describe('…', () => { … });
 * ```
 *
 * 拿不到数据库时**抛**，不返回 `null`：调用方在模块顶层 `await`，于是整份文件收集失败。
 * 返回类型里没有 `| null`，是为了让编译器替我们守住这条 —— 任何 `if (harness === null)
 * return;` 都会以 TS2367 报出来，而那种提前返回正是一条"什么都不验也报绿"的假绿路径。
 */
export async function createTestDatabaseHarness(): Promise<TestDatabaseHarness> {
  for (const baseUrl of candidateBaseUrls()) {
    const baseSource = await probe(baseUrl);
    if (baseSource === null) continue;

    const databaseName = `lq_f1_test_${randomBytes(8).toString('hex')}`;
    try {
      // 库名不能参数化（Postgres 不接受 `$1` 作为标识符），所以字符集由上面那句
      // `randomBytes().toString('hex')` 保证：只有 `[0-9a-f]`，没有可注入的字符。
      const created = await baseSource.connect();
      try {
        await created.query(`CREATE DATABASE ${databaseName}`, []);
      } finally {
        await created.release();
      }
    } catch {
      await baseSource.end().catch(() => undefined);
      continue;
    }

    const connectionString = withDatabase(baseUrl, databaseName);
    const source = await createPgClientSource({ connectionString, maxConnections: 8 });
    const adapter = new PostgresDatabaseAdapter({ source });

    return {
      adapter,
      connectionString,
      databaseName,
      async dispose(): Promise<void> {
        await adapter.close();
        // 关池**不等于**后端已经消失（`Pool.end()` 在 `client.end()` 还没落地时就
        // resolve 了），所以这里再等一次服务器侧的事实，然后才 DROP。理由与实测见
        // `waitForDatabaseBackendsToDrain` 的文件内说明。
        await waitForDatabaseBackendsToDrain(baseSource, databaseName);
        const drop = await baseSource.connect();
        try {
          // `WITH (FORCE)`：本进程若还留着一条没归还的连接，普通 DROP 会因"库正在使用"
          // 失败，于是每跑一轮就多一个残留库 —— 而残留库会让下一次"迁移建出全部表"的
          // 断言在一个已经建好的库上通过，那是一条假绿。
          await drop.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`, []);
        } finally {
          await drop.release();
        }
        await baseSource.end().catch(() => undefined);
      },
    };
  }
  throw new Error(MISSING_DATABASE_HINT);
}

/** 在**已迁移**的库上执行一段 SQL，用于断言 schema 事实（`information_schema` 等）。 */
export async function queryHarness<TRow>(
  harness: TestDatabaseHarness,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly TRow[]> {
  return harness.adapter.transaction(async (tx) => tx.query<TRow>(sql, params));
}

/** 第二个适配器：同库、**独立连接池**。用完必须 `dispose()`。 */
export type SecondaryAdapter = {
  readonly adapter: PostgresDatabaseAdapter;
  dispose(): Promise<void>;
};

/**
 * 在**同一个库**上再开一个走独立连接池的适配器。
 *
 * 为什么需要它：「两个 worker 抢同一个任务，只有一个赢」这条性质，内存替身证明不了
 * （`task-lease-cas.test.ts` 的文件头写明了原因：单进程事件循环里两次 `claim` 天然串行，
 * 第一个 `await` 之前就已经写完了）；而**共用一个连接池**同样证明不了 —— 池会替你把两次
 * 调用排到同一条连接上，`FOR UPDATE SKIP LOCKED` 根本没有两个后端可裁决。只有两个独立池
 * 上的两条连接同时进入 `SELECT … FOR UPDATE SKIP LOCKED`，仲裁者才真的是数据库。
 */
export async function secondaryAdapter(harness: TestDatabaseHarness): Promise<SecondaryAdapter> {
  const source = await createPgClientSource({
    connectionString: harness.connectionString,
    maxConnections: 4,
  });
  const adapter = new PostgresDatabaseAdapter({ source });
  return { adapter, dispose: () => adapter.close() };
}

/** 一对成人／学生账号。`users.owner_id` 是自引用外键，学生必须挂在一个真成人下面。 */
export type SeededAccounts = {
  readonly ownerId: UserId;
  readonly studentId: UserId;
};

/**
 * 播种夹具。**走生产编解码器**（`userInsertParams` / `projectInsertParams` /
 * `taskInsertParams`），不走裸 SQL：这些驱动测试要验的就是"领域对象 → 行 → 领域对象"
 * 这条往返，用裸 SQL 播种会让编解码器的写入侧整段不参与测试。
 * （`postgres-schema-migration.test.ts` 反过来刻意用裸 SQL —— 那个文件测的是 DDL 的
 * 约束会不会拒非法值，用编解码器就造不出非法值了。两处分工不同，不是重复。）
 *
 * `revision` 一律给 `'1'`：domain 的九个实体工厂都默认 `parseRevision('0')`，而 §3.2 的
 * DDL 是 `CHECK (revision > 0)`。这个冲突本身在交付说明里单列申报。
 *
 * `login_name` 用**完整** id：UUIDv7 的前 8 个 hex 是毫秒时间戳的高 32 位，约 65 秒才变
 * 一次，截断会让同一轮里所有账号撞 UNIQUE。
 */
export async function seedAccounts(harness: TestDatabaseHarness): Promise<SeededAccounts> {
  const ownerId = newUuidV7();
  const studentId = newUuidV7();
  const lockPolicy = {
    maxFailedAttempts: parseMaxFailedAttempts(5),
    lockDurationMinutes: parseLockDurationMinutes(15),
  };
  const owner = createUser({
    id: ownerId,
    role: 'OWNER',
    loginName: parseLoginName(`owner_${ownerId}`),
    nickname: parseNickname('成人账号'),
    lockPolicy,
    revision: '1',
  });
  const student = createUser({
    id: studentId,
    role: 'STUDENT',
    loginName: parseLoginName(`student_${studentId}`),
    nickname: parseNickname('学生账号'),
    ageBand: 'L1',
    ownerId,
    lockPolicy,
    revision: '1',
  });
  await harness.adapter.transaction(async (tx) => {
    // 先成人后学生：自引用外键决定次序，反过来是 23503。
    await tx.execute(USER_INSERT_SQL, userInsertParams(owner));
    await tx.execute(USER_INSERT_SQL, userInsertParams(student));
  });
  return { ownerId: owner.id, studentId: student.id };
}

export async function seedProject(
  harness: TestDatabaseHarness,
  studentId: UserId,
): Promise<ProjectId> {
  const project = createProject({
    id: newUuidV7(),
    ownerStudentId: studentId,
    title: '夹具项目',
    workType: 'GAME',
    ageBand: 'L1',
    helpLevel: 'LV1',
    createdAt: EPOCH,
    updatedAt: EPOCH,
    revision: '1',
  });
  await harness.adapter.transaction(async (tx) => {
    await tx.execute(PROJECT_INSERT_SQL, projectInsertParams(project));
  });
  return project.id;
}

export type SeedTaskOptions = {
  readonly state?: string;
  readonly projectId?: ProjectId;
  readonly requestedBy?: UserId;
  readonly idempotencyKey?: string | null;
  readonly nextRunAt?: string | null;
  /**
   * 默认 `'1'`。开出来是为了 §4 条 2 那句「`revision` 在 DB 是正整数 `bigint`……**不能
   * JS Number 精度丢失**」：要证明它，就得写一个超过 `Number.MAX_SAFE_INTEGER` 的值进去，
   * 而 `'1'` 证明不了任何事。
   */
  readonly revision?: string;
  /**
   * 以下四个只为播种**终态**任务而存在，`assertTaskCoherent` 逐条要求：
   * 终态 ⟺ `finishedAt !== null`；`FAILED`/`BLOCKED`/`TIMED_OUT` ⟺ `error !== null`；
   * `SUCCEEDED` ⟺ `resultVersionId !== null`；`CANCELLED` ⇒ `cancelRequestedAt !== null`。
   * 不开这几个口子就只能播 `QUEUED` 一类的非终态，而 `acquire` 的判据完备性恰恰要
   * 15 个状态**逐个**钉住 —— 少了终态那五个，`TERMINAL_NO_OP` 那一项就没有任何用例走过。
   */
  readonly cancelRequestedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly resultVersionId?: string | null;
  readonly error?: { readonly code: string } | null;
};

/**
 * 播种一个任务，默认连带它自己的项目与账号。
 *
 * 默认自建项目是因为 `ai_tasks_one_active_per_project` 这条部分唯一索引：一个项目里同时
 * 只能有一个非终态任务，连续播种两个 QUEUED 任务必须落在两个项目上，否则第二个是 23505
 * ——而那看起来像"驱动坏了"。要往同一个项目里播种就显式传 `projectId`。
 */
export async function seedTask(
  harness: TestDatabaseHarness,
  options: SeedTaskOptions = {},
): Promise<AiTask> {
  const accounts = options.requestedBy === undefined ? await seedAccounts(harness) : undefined;
  const studentId = options.requestedBy ?? accounts?.studentId;
  if (studentId === undefined) throw new Error('seedTask: 需要 requestedBy 或自建账号');
  const projectId = options.projectId ?? (await seedProject(harness, studentId));
  const task = createAiTask({
    id: newUuidV7(),
    kind: 'VIBE_TURN',
    projectId,
    requestedBy: studentId,
    maxAttempts: 3,
    createdAt: EPOCH,
    state: options.state ?? 'QUEUED',
    idempotencyKey: options.idempotencyKey ?? null,
    nextRunAt: options.nextRunAt ?? null,
    revision: options.revision ?? '1',
    cancelRequestedAt: options.cancelRequestedAt ?? null,
    finishedAt: options.finishedAt ?? null,
    resultVersionId: options.resultVersionId ?? null,
    error: options.error ?? null,
  });
  await harness.adapter.transaction(async (tx) => {
    await tx.execute(AI_TASK_INSERT_SQL, taskInsertParams(task, null, null));
  });
  return task;
}

/**
 * 播种一行 `task_private`，内容全部是硬字面量。
 *
 * `seedTask` **不**顺带建它，因为 §3.5 的装配端口才是"两行同事务 INSERT"的那个作者，
 * 夹具替它做会把 `createTurn` 的顺序断言变成永远为真。谁需要 private 行就自己调一次，
 * 于是"有 task 行而没有 private 行"这个状态在测试里是**可构造**的 ——
 * `lockPrivateState` 对它报 `STORED_ROW_INCONSISTENT` 而不是返回 `null`
 * （`sql/task-private-rows.ts:155-159` 给了理由），那条分支要有用例走过才算钉住。
 */
export async function seedPrivateState(
  harness: TestDatabaseHarness,
  taskId: string,
  overrides: Partial<Parameters<typeof createTaskPrivateRecord>[0]> = {},
): Promise<TaskPrivateRecord> {
  const record = createTaskPrivateRecord({
    taskId,
    inputRef: createTaskInputRef({
      objectRef: 'littleq/task-input/0198f2a4-6c7e-7a41-9c1b-2f6d0a4b8c11.json',
      sha256: 'b'.repeat(64),
      byteLength: 128,
    }),
    internalSubphase: 'AWAITING_SESSION_RECEIPT',
    collectionCursor: createCollectionCursor({ artifactSha256: 'c'.repeat(64) }),
    inputSnapshot: {
      scanInput: {
        artifactHash: 'c'.repeat(64),
        manifestHash: 'd'.repeat(64),
        schemaVersion: '1.0.0',
        contractVersion: '1.0.0',
        scannerVersion: '1.0.0',
        rulesetVersion: '1.0.0',
      },
    },
    ...overrides,
  });
  await harness.adapter.transaction(async (tx) => {
    await tx.execute(TASK_PRIVATE_INSERT_SQL, taskPrivateParams(record));
  });
  return record;
}

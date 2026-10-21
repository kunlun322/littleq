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
 * ## 拿不到数据库时**大声**跳过，不静默通过
 *
 * 上面那条约束里最要命的半句是"那种分歧不会报错"。一个悄悄跳过的集成测试正是同一种病：
 * 门禁全绿，而绿的原因是根本没跑。所以这里的跳过有三重可见性 ——
 *
 * 1. `console.warn` 打出**为什么**跳、以及怎么让它跑（设 `LQ_TEST_DATABASE_URL`）；
 * 2. 调用方一律用 `describe.skipIf(harness === null)`，于是执行器的计数里会出现
 *    skipped，交付评论报的是执行器的真实数字，跳过无法被藏进"通过"里；
 * 3. 本文件**不提供任何内存替身**。§2.2 逐字：「若用户不愿完成此动作，不把 DB 换成
 *    进程内或浏览器存储来假交付」—— 拿不到真库时的正确答案是"这一项没有证据"，
 *    不是"用假库造一条证据"。
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

const SKIP_HINT =
  `跳过真 Postgres 测试：没有可用的数据库。设 ${TEST_DATABASE_URL_ENV_VAR} 指向一个` +
  '可以随意建库/删库的 Postgres（例如 postgres://USER@127.0.0.1:5432/postgres）即可让它们执行。';

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
 * afterAll(async () => { await harness?.dispose(); });
 * describe.skipIf(harness === null)('…', () => { … });
 * ```
 */
export async function createTestDatabaseHarness(): Promise<TestDatabaseHarness | null> {
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
  console.warn(SKIP_HINT);
  return null;
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

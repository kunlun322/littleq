/**
 * Layer B：真 Postgres 上的迁移与 schema 事实。
 *
 * ## 与 `migrations.test.ts` 的分工
 * 那边钉 **SQL 文本**（表名清单、CHECK 子句、部分索引的终态清单、时间列类型、
 * checksum 敏感性、INSERT 的占位符形状），任何机器上都执行、从不跳过。
 * 这边钉 **数据库真的照那份文本建出来了**：`information_schema` 里查得到、
 * 约束真的会拒、幂等重跑真的不重复应用、advisory lock 真的挡住了并发迁移。
 *
 * 两层缺一不可。只有文本层，一份"写着 CHECK 却被数据库忽略"的 DDL 也能全绿；
 * 只有真库层，没有数据库的机器上就是一片红 —— 而红至少不会被误读成"验过了"。
 *
 * ## 没有数据库时
 * `createTestDatabaseHarness()` **抛**，不返回 `null`；模块顶层的 `await` 于是让整份文件
 * 收集失败、用例记成 failed。§9.2 规则 5 禁止用 `skipIf` 让门禁静默通过，而"跳过但计数
 * 可见"仍然要把可见性寄托在有人去读计数上 —— 直接红不需要任何人读任何东西。
 * §2.2 明确禁止用进程内存储假装交付，所以这里不提供任何内存替身。
 *
 * ## 时间戳用 EPOCH 常量，不用 `new Date()`
 * 这一层已经必然读宿主状态（连数据库就是），但没必要连**时间**也读：所有 `updated_at`
 * 都填 `support.ts` 的固定 `EPOCH`，于是断言只依赖被测代码，不依赖跑测试的那一刻。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TASK_TRANSITIONS } from '@littleq/domain';
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  PostgresDatabaseAdapter,
  SLICE_TABLE_NAMES,
  SQL_MIGRATIONS,
  createPgClientSource,
  isInfraError,
  migrationChecksum,
  newUuidV7,
} from '../src/index.js';
import { EPOCH } from './support.js';
import {
  createTestDatabaseHarness,
  queryHarness,
  type TestDatabaseHarness,
} from './support-database.js';

const harness = await createTestDatabaseHarness();

afterAll(async () => {
  await harness.dispose();
});

// 放在顶层而不是某个 describe 里：三个 describe 共用同一个库，靠"第一个块先跑"来迁移
// 是一条隐式次序依赖，vitest 换个执行策略就会变成一片莫名其妙的 42P01（表不存在）。
beforeAll(async () => {
  await harness.adapter.migrate();
});

/** pg 驱动错误的可读子集。适配器不做统一映射，所以约束违反会带着 SQLSTATE 原样抛上来。 */
type PgError = { readonly code?: string; readonly constraint?: string };

function sqlStateOf(error: unknown): string {
  return (error as PgError | null)?.code ?? `<不是错误：${String(error)}>`;
}

function constraintOf(error: unknown): string {
  return (error as PgError | null)?.constraint ?? '';
}

/** 捕获 rejection；成功时返回 `null`，让调用方对 `null` 的断言直接红。 */
async function attempt(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
}

const USER_INSERT_SQL = `
INSERT INTO users(id, role, login_name, owner_id, age_band, status, revision, payload)
VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb)`;

const PROJECT_INSERT_SQL = `
INSERT INTO projects(id, owner_student_id, revision, current_version_id, status, updated_at, payload)
VALUES ($1, $2, 1, NULL, 'ACTIVE', $3, $4::jsonb)`;

const TASK_INSERT_SQL = `
INSERT INTO ai_tasks(id, project_id, requested_by, idempotency_key, request_hash,
                     accepted_project_revision, state, stage, attempt, revision,
                     next_run_at, lease_owner, lease_token, lease_until, payload)
VALUES ($1, $2, $3, $4, NULL, NULL, $5, NULL, 0, 1, NULL, NULL, NULL, NULL, $6::jsonb)`;

/**
 * 最小可插入行。这里刻意用裸 SQL 而不是 `*InsertParams` 编解码器：本文件测的是 **DDL 的
 * 约束**，不是编解码器；用编解码器会让"约束拒了一个非法值"和"编解码器没能造出非法值"
 * 两件事纠缠在一起。编解码器的往返在 `postgres-drivers.test.ts` 里用真实领域对象验。
 *
 * `payload` 填 `{}`：它是 `jsonb NOT NULL`，而所有 CHECK 都不看它的内容。
 *
 * `login_name` 用**完整** id 而不是 `id.slice(0, 8)`：UUIDv7 的前 8 个 hex 字符是毫秒
 * 时间戳的高 32 位，约 65 秒才变一次，同一轮测试里所有行都撞同一个值，于是 `users`
 * 的 UNIQUE 约束会以一条与被测约束毫无关系的 23505 把用例打红。要取"随机的那一段"
 * 得用尾部，要取"唯一的那一段"就用整个 id。
 */
async function insertOwner(h: TestDatabaseHarness): Promise<string> {
  const id = newUuidV7();
  await h.adapter.transaction((tx) =>
    tx.execute(USER_INSERT_SQL, [id, 'OWNER', `owner_${id}`, null, null, 'ACTIVE', {}]),
  );
  return id;
}

/** 建一个学生（连带它的成人账号 —— `users.owner_id` 是自引用外键，编不出假 id）。 */
async function insertStudent(h: TestDatabaseHarness): Promise<string> {
  const ownerId = await insertOwner(h);
  const id = newUuidV7();
  await h.adapter.transaction((tx) =>
    tx.execute(USER_INSERT_SQL, [id, 'STUDENT', `student_${id}`, ownerId, 'L1', 'ACTIVE', {}]),
  );
  return id;
}

async function insertProject(h: TestDatabaseHarness, studentId: string): Promise<string> {
  const id = newUuidV7();
  await h.adapter.transaction((tx) => tx.execute(PROJECT_INSERT_SQL, [id, studentId, EPOCH, {}]));
  return id;
}

async function insertTask(
  h: TestDatabaseHarness,
  projectId: string,
  requestedBy: string,
  state: string,
  idempotencyKey: string | null = null,
): Promise<string> {
  const id = newUuidV7();
  await h.adapter.transaction((tx) =>
    tx.execute(TASK_INSERT_SQL, [id, projectId, requestedBy, idempotencyKey, state, {}]),
  );
  return id;
}

describe('迁移 runner（真 Postgres）', () => {
  const h = harness as TestDatabaseHarness;

  it('已经是最新时，重跑迁移应用 0 条、schemaVersion 仍是 1', async () => {
    const report = await h.adapter.migrate();
    expect(report).toEqual({ applied: [], schemaVersion: 1 });
  });

  it('空库上的首次迁移报告应用了 0001_initial_slice', async () => {
    // 正对照：必须在一个**没迁移过**的库上看首次报告，否则这条只是上一条的复述。
    const fresh = await createTestDatabaseHarness();
    try {
      expect(await fresh.adapter.migrate()).toEqual({
        applied: ['0001_initial_slice'],
        schemaVersion: 1,
      });
      expect(await fresh.adapter.migrate()).toEqual({ applied: [], schemaVersion: 1 });
    } finally {
      await fresh.dispose();
    }
  });

  it('health() 在迁移后是 ok', async () => {
    expect((await h.adapter.health()).status).toBe('ok');
  });

  it('schema_migrations 里记着版本与代码算出的同一个 checksum', async () => {
    const rows = await queryHarness<{ version: string; checksum: string }>(
      h,
      `SELECT version, checksum FROM schema_migrations ORDER BY version`,
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const [migration] = SQL_MIGRATIONS;
    expect(migration).toBeDefined();
    if (row === undefined || migration === undefined) return;
    expect(row.version).toBe('0001_initial_slice');
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    // 库里的 checksum 必须与代码算出来的一致，否则 runner 每次启动都会报不符。
    expect(row.checksum).toBe(migrationChecksum(migration));
  });

  it('负对照：篡改已应用的 checksum 会让下一次迁移报 MIGRATION_CHECKSUM_MISMATCH', async () => {
    // §3.2：「迁移 runner 按版本/checksum 执行」。这条约束的意义是发现"已应用的迁移被事后
    // 改写"—— 两个环境的 schema 会分叉且无人知晓，所以必须报错而不是静默跳过。
    const tampered = await createTestDatabaseHarness();
    try {
      await tampered.adapter.migrate();
      await tampered.adapter.transaction((tx) =>
        tx.execute(`UPDATE schema_migrations SET checksum = $1 WHERE version = $2`, [
          '0'.repeat(64),
          '0001_initial_slice',
        ]),
      );
      const error = await attempt(tampered.adapter.migrate());
      expect(isInfraError(error), `期望 InfraError，实际 ${String(error)}`).toBe(true);
      if (!isInfraError(error)) return;
      expect(error.code).toBe('MIGRATION_CHECKSUM_MISMATCH');
      // 重跑同一条迁移只会得到同一个不符，必须由人裁决，所以不可重试。
      expect(error.retryable).toBe(false);
    } finally {
      await tampered.dispose();
    }
  });

  it('并发迁移由 advisory lock 串行化：两个实例都成功，且只应用一次', async () => {
    // 两个实例同时冷启动是本切片真实的部署形状（Serverless 冷启动、多副本）。
    // `CREATE TABLE IF NOT EXISTS` 本身幂等，但 `schema_migrations` 的写入不是：
    // 没有 advisory lock，两个实例会各写一行同版本记录，或一个在另一个建表途中失败。
    const fresh = await createTestDatabaseHarness();
    const secondSource = await createPgClientSource({
      connectionString: fresh.connectionString,
      maxConnections: 2,
    });
    const other = new PostgresDatabaseAdapter({ source: secondSource });
    try {
      expect(MIGRATION_ADVISORY_LOCK_KEY).toBe(7_610_216n);
      const [a, b] = await Promise.all([fresh.adapter.migrate(), other.migrate()]);
      expect([...a.applied, ...b.applied]).toEqual(['0001_initial_slice']);
      const rows = await queryHarness<{ total: string }>(
        fresh,
        `SELECT COUNT(*)::text AS total FROM schema_migrations`,
      );
      expect(rows[0]?.total).toBe('1');
    } finally {
      await other.close();
      await fresh.dispose();
    }
  });
});

describe('§3.2 schema 在真库里的形状', () => {
  const h = harness as TestDatabaseHarness;

  it('17 张表全部存在，且没有多建', async () => {
    const rows = await queryHarness<{ table_name: string }>(
      h,
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const actual = rows.map((r) => r.table_name);
    expect(actual).toEqual([...SLICE_TABLE_NAMES].sort());
    expect(actual).toHaveLength(17);
  });

  it('users / projects / ai_tasks 的 revision 列在库里是 bigint', async () => {
    // §3.1：revision 必须能超过 JS 的安全整数，`integer` 会在 21 亿次写入后溢出。
    const rows = await queryHarness<{ table_name: string; data_type: string }>(
      h,
      `SELECT table_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'revision'
          AND table_name IN ('users','projects','ai_tasks') ORDER BY table_name`,
    );
    expect(rows.map((r) => `${r.table_name}=${r.data_type}`)).toEqual([
      'ai_tasks=bigint',
      'projects=bigint',
      'users=bigint',
    ]);
  });

  it('每个 *_at / *_until 列在库里都是 timestamp with time zone', async () => {
    const rows = await queryHarness<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      h,
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name LIKE '%\\_at' OR column_name LIKE '%\\_until')
        ORDER BY table_name, column_name`,
    );
    // 正对照：Layer A 的文本扫描实测到 16 个，扫到 0 个说明 LIKE 的转义写坏了。
    expect(rows.length).toBeGreaterThanOrEqual(16);
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name} 必须是 timestamptz`).toBe(
        'timestamp with time zone',
      );
    }
  });

  it('blob_digest_index 按 §3.3 建出来，主键是 pathname', async () => {
    const columns = await queryHarness<{ column_name: string }>(
      h,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'blob_digest_index'
        ORDER BY ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      'pathname',
      'sha256',
      'byte_length',
      'created_at',
    ]);
    const pk = await queryHarness<{ column_name: string }>(
      h,
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'blob_digest_index' AND tc.constraint_type = 'PRIMARY KEY'`,
    );
    expect(pk.map((r) => r.column_name)).toEqual(['pathname']);
  });

  it('部分唯一索引存在、唯一、且 WHERE 里就是 domain 的五个终态', async () => {
    const rows = await queryHarness<{ indexdef: string }>(
      h,
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
         AND indexname = 'ai_tasks_one_active_per_project'`,
    );
    expect(rows).toHaveLength(1);
    const definition = rows[0]?.indexdef ?? '';
    expect(definition).toMatch(/^CREATE UNIQUE INDEX/);
    expect(definition).toMatch(/ON (public\.)?ai_tasks USING btree \(project_id\)/);
    expect(definition).toMatch(/WHERE/);
    // 清单来自 domain：漂移的后果不是报错而是"已完成的项目再也发不起新 turn"。
    const listed = [...definition.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] ?? '');
    expect(listed).toEqual([...TASK_TRANSITIONS.terminal]);
  });
});

describe('§3.2 约束在真库里真的会拒', () => {
  const h = harness as TestDatabaseHarness;

  it('负对照：revision = 0 被 CHECK 拒（23514）', async () => {
    const studentId = await insertStudent(h);
    const error = await attempt(
      h.adapter.transaction((tx) =>
        tx.execute(
          `INSERT INTO projects(id, owner_student_id, revision, current_version_id, status, updated_at, payload)
           VALUES ($1, $2, 0, NULL, 'ACTIVE', $3, $4::jsonb)`,
          [newUuidV7(), studentId, EPOCH, {}],
        ),
      ),
    );
    expect(sqlStateOf(error)).toBe('23514');
  });

  it('负对照：users_role_shape 拒一个带 owner_id 的 OWNER', async () => {
    const ownerId = await insertOwner(h);
    const error = await attempt(
      h.adapter.transaction((tx) =>
        tx.execute(USER_INSERT_SQL, [
          newUuidV7(),
          'OWNER',
          `owner_${newUuidV7()}`,
          ownerId,
          null,
          'ACTIVE',
          {},
        ]),
      ),
    );
    expect(sqlStateOf(error)).toBe('23514');
    expect(constraintOf(error)).toBe('users_role_shape');
  });

  it('负对照：projects.owner_student_id 的外键拒一个不存在的学生（23503）', async () => {
    // 这条同时证明建表次序里 users 确实在 projects 之前，且 FK 真的挂上了 ——
    // 一份只有列没有约束的 DDL 在这里会绿。
    const error = await attempt(
      h.adapter.transaction((tx) =>
        tx.execute(PROJECT_INSERT_SQL, [newUuidV7(), newUuidV7(), EPOCH, {}]),
      ),
    );
    expect(sqlStateOf(error)).toBe('23503');
  });

  it('负对照：同一项目第二个非终态 task 被部分唯一索引拒（23505）', async () => {
    const studentId = await insertStudent(h);
    const projectId = await insertProject(h, studentId);
    await insertTask(h, projectId, studentId, 'QUEUED');
    const error = await attempt(insertTask(h, projectId, studentId, 'RUNNING'));
    expect(sqlStateOf(error)).toBe('23505');
    expect(constraintOf(error)).toBe('ai_tasks_one_active_per_project');
  });

  it('正对照：前一个 task 进入终态后，同项目可以再开一个（五个终态都试）', async () => {
    // 上一条只证明了"会拒"。这一条证明拒的判据是**状态**而不是"每项目一行"——
    // 少了它，一个把 project_id 整个设成 UNIQUE 的错误索引也能让上一条通过。
    const studentId = await insertStudent(h);
    const projectId = await insertProject(h, studentId);
    const first = await insertTask(h, projectId, studentId, 'QUEUED');

    for (const terminal of TASK_TRANSITIONS.terminal) {
      await h.adapter.transaction((tx) =>
        tx.execute(`UPDATE ai_tasks SET state = $1 WHERE id = $2`, [terminal, first]),
      );
      const next = await insertTask(h, projectId, studentId, 'QUEUED');
      await h.adapter.transaction((tx) =>
        tx.execute(`UPDATE ai_tasks SET state = 'SUCCEEDED' WHERE id = $1`, [next]),
      );
    }
  });

  it('负对照：同项目同 idempotency_key 只能有一行', async () => {
    const studentId = await insertStudent(h);
    const projectId = await insertProject(h, studentId);
    const key = `idem_${newUuidV7()}`;
    await insertTask(h, projectId, studentId, 'SUCCEEDED', key);
    const error = await attempt(insertTask(h, projectId, studentId, 'SUCCEEDED', key));
    expect(sqlStateOf(error)).toBe('23505');
    expect(constraintOf(error)).toBe('ai_tasks_project_idempotency_key');
  });

  it('正对照：idempotency_key 为 NULL 的任务可以共存（不同项目）', async () => {
    // Postgres 把 NULL 视为互不相同，所以 PUBLISH/RESCAN 这类无幂等键的任务不被这条
    // 唯一约束挡住。用不同项目是为了不先撞上部分唯一索引。
    const studentId = await insertStudent(h);
    const first = await insertProject(h, studentId);
    const second = await insertProject(h, studentId);
    await insertTask(h, first, studentId, 'QUEUED', null);
    await insertTask(h, second, studentId, 'QUEUED', null);
    const rows = await queryHarness<{ total: string }>(
      h,
      `SELECT COUNT(*)::text AS total FROM ai_tasks
        WHERE project_id IN ($1, $2) AND idempotency_key IS NULL`,
      [first, second],
    );
    expect(rows[0]?.total).toBe('2');
  });

  it('负对照：request_hash 必须是 64 位小写十六进制', async () => {
    const studentId = await insertStudent(h);
    const projectId = await insertProject(h, studentId);
    const error = await attempt(
      h.adapter.transaction((tx) =>
        tx.execute(
          `INSERT INTO ai_tasks(id, project_id, requested_by, idempotency_key, request_hash,
                                 accepted_project_revision, state, stage, attempt, revision,
                                 next_run_at, lease_owner, lease_token, lease_until, payload)
           VALUES ($1, $2, $3, NULL, 'not-a-digest', NULL, 'QUEUED', NULL, 0, 1,
                   NULL, NULL, NULL, NULL, $4::jsonb)`,
          [newUuidV7(), projectId, studentId, {}],
        ),
      ),
    );
    expect(sqlStateOf(error)).toBe('23514');
  });

  it('事务回滚：work 抛错时同一事务里的写入全部消失', async () => {
    // DatabaseAdapter 的核心不变量。所有 revision CAS 都依赖它，否则
    // 「读到版本 → 写入版本」之间的窗口就是一次静默丢更新。
    const studentId = await insertStudent(h);
    const projectId = newUuidV7();
    const error = await attempt(
      h.adapter.transaction(async (tx) => {
        await tx.execute(PROJECT_INSERT_SQL, [projectId, studentId, EPOCH, {}]);
        throw new Error('故意失败');
      }),
    );
    expect(error).toBeInstanceOf(Error);
    const rows = await queryHarness<{ id: string }>(h, `SELECT id FROM projects WHERE id = $1`, [
      projectId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('抛错时调用方看到的是原始错误，不是 ROLLBACK 的错误', async () => {
    const original = new Error('原始失败原因');
    const thrown = await attempt(
      h.adapter.transaction(async () => {
        throw original;
      }),
    );
    expect(thrown).toBe(original);
  });

  it('close() 之后再开事务报 PROVIDER_UNAVAILABLE，且不泄漏连接串', async () => {
    // §4.1：不得把驱动原文透出去 —— 原文里通常原样印着连接目标（含口令）。
    const doomed = await createTestDatabaseHarness();
    try {
      await doomed.adapter.migrate();
      await doomed.adapter.close();
      const error = await attempt(doomed.adapter.transaction(async () => undefined));
      expect(isInfraError(error), `期望 InfraError，实际 ${String(error)}`).toBe(true);
      if (!isInfraError(error)) return;
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(error.message).toBe('PROVIDER_UNAVAILABLE');
      expect(error.message).not.toContain('postgres://');
    } finally {
      await doomed.dispose();
    }
  });
});

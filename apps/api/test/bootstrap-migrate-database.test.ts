/**
 * `bootstrap/migrate.ts` 的**真库**那一半 —— ZLQ-236 D-1 验收项「迁移在 PG 上真的跑成功
 * （17 张表全部建出来）」「重跑幂等」「checksum 被改过就报错，而不是静默跳过」。
 *
 * ## 用的是那个一次性库挂具，而且它**不代跑迁移**
 *
 * `createTestDatabaseHarness()`（`packages/infra/test/support-database.ts:262`）建一个
 * 随机名的**空**库、用完 `DROP`。它的函数注释逐字写着「**不在这里跑迁移**：迁移报告本身
 * 就是被测对象……由 harness 代跑等于把「首次迁移建出了全部表」这条断言变成一条永远看不到
 * 首次的断言」，调用方自己跑。本文件要跑的正是**我这条**入口（`runFormBMigrations`），
 * 不是 harness 的 `adapter.migrate()` —— 于是"迁移能跑通"这件事是端到端的：
 * 环境变量名 → `createPgClientSource` → `pg_advisory_xact_lock` → 25 条 DDL → `schema_migrations`。
 *
 * ⚠️ 挂具的文件头（`:41`）有一句「`CREATE DATABASE` 一个随机名的库、**跑迁移**、用完 `DROP`」，
 * 与它自己 `:246` 的函数注释相反。以**函数体**为准（`CREATE DATABASE` 之后没有任何 `migrate()`
 * 调用）。这是一处已提交文件里的文档自相矛盾，本单只申报、不改它。
 *
 * ## 本机跑的是 PG 17，线上 Neon 是 PG 18（申报的版本替换）
 *
 * 这一份证据的 PG 大版本与生产**不同**，所以它证明的是"这套 DDL 在 PG 17 上从零跑通、
 * 幂等、checksum 守得住"，不是"在 Neon 18 上跑通"。PM 已实测生产侧的兼容性事实
 * （无 `CREATE EXTENSION`、无 `PARTITION BY`、无 `GENERATED ALWAYS AS`、无 `MERGE INTO`，
 * 唯一的特权调用是 `pg_advisory_xact_lock`），但那也是静态检查。**在 Neon 上真跑一次**
 * 需要一个直连串的值，而红线禁止我索取或记录任何一个值 ⇒ 那一步只能由用户/运维执行，
 * 交付说明里单列。
 *
 * ## 拿不到 Postgres 时这一整份文件红，不跳过
 *
 * 挂具必得（不返回 `null`、没有 `skipIf`），理由是 `readiness-no-retirement-tokens` 那道门
 * 写的那句「被跳过的用例不会变红，只会消失」。
 */
import { SLICE_TABLE_NAMES, isInfraError } from '@littleq/infra';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabaseHarness,
  queryHarness,
  type TestDatabaseHarness,
} from '../../../packages/infra/test/support-database.js';

import { FORM_B_ENV_VARS } from '../src/bootstrap/config.js';
import { runFormBMigrations, type MigrationIo } from '../src/bootstrap/migrate.js';

let harness: TestDatabaseHarness;
/** 首次运行留下的输出。后面的断言要拿它证明"连接串没被打印出来"。 */
const firstRunStdout: string[] = [];
const firstRunStderr: string[] = [];
let serverVersion = '';

function captureIo(stdout: string[], stderr: string[]): MigrationIo {
  return { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) };
}

/** 指向挂具那个一次性库的形态 B 环境。`DATABASE_DIRECT_URL` 是唯一与库有关的键。 */
/**
 * 运行串。迁移命令**不拨它**（它只拨 `DATABASE_DIRECT_URL`），但 `runFormBMigrations`
 * 第一步是 `resolveFormBConfig`，那一步按 §3.1 要求运行串存在。
 *
 * 刻意指向一个**永不会连**的地址、并给它一对独有的凭据：于是"迁移命令没碰过运行串的值"
 * 变成一条可断言的事实（见下面 stdout/stderr 那一条），而不是靠读代码相信。
 */
const UNUSED_RUNTIME_URL =
  'postgres://lq_runtime_unused:lq_runtime_unused_pw@127.0.0.1:1/lq_never_dialed?sslmode=require';

function migrateEnv(): Record<string, string | undefined> {
  return {
    [FORM_B_ENV_VARS.deployment]: 'B',
    [FORM_B_ENV_VARS.databaseUrl]: UNUSED_RUNTIME_URL,
    [FORM_B_ENV_VARS.databaseDirectUrl]: harness.connectionString,
    [FORM_B_ENV_VARS.sourceCodeUrl]: 'https://git.example/littleq.git',
  };
}

async function publicTables(): Promise<string[]> {
  const rows = await queryHarness<{ readonly table_name: string }>(
    harness,
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return rows.map((row) => row.table_name);
}

beforeAll(async () => {
  harness = await createTestDatabaseHarness();
  // `SHOW server_version` 回来的列名是 `server_version`，起不了别名 —— 用
  // `current_setting()` 才能把它 alias 成 `v`（本文件第一版写成 `SHOW` + 读 `.v`，
  // 于是永远读到 `''`，一条关于"这份证据跑在哪个 PG 上"的断言成了永远红的空转）。
  const version = await queryHarness<{ readonly v: string }>(
    harness,
    "SELECT current_setting('server_version') AS v",
  );
  serverVersion = version[0]?.v ?? '';
});

afterAll(async () => {
  await harness.dispose();
});

describe('前置事实：挂具给的库真的是空的（否则"首次建出全部表"是空转）', () => {
  it('迁移之前 public 下一张表都没有，连 schema_migrations 也没有', async () => {
    expect(await publicTables()).toEqual([]);
  });

  it('连得上，而且能报出自己的大版本（这一份证据跑在哪个 PG 上必须可见）', () => {
    expect(serverVersion).toMatch(/^\d+\./);
  });
});

describe('首次迁移：从零建出全部 17 张表', () => {
  it('应用了 0001_initial_slice，schema_migrations 累计 1 条', async () => {
    const outcome = await runFormBMigrations({
      env: migrateEnv(),
      io: captureIo(firstRunStdout, firstRunStderr),
    });
    expect(outcome.report.applied).toEqual(['0001_initial_slice']);
    expect(outcome.report.schemaVersion).toBe(1);
    // 返回类型里的变量名是**字面量** 'DATABASE_DIRECT_URL'（config.ts 的
    // `SqlConnectionRef<typeof FORM_B_MIGRATION_URL_ENV_VAR>`），所以这条断言同时也是
    // 一份编译期证据：迁移读的就是那一个名字。
    expect(outcome.directUrlVariable).toBe('DATABASE_DIRECT_URL');
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('SLICE_TABLE_NAMES 里 17 张表全部存在，且 public 下没有多余的东西', async () => {
    const tables = await publicTables();
    expect(SLICE_TABLE_NAMES).toHaveLength(17);
    for (const name of SLICE_TABLE_NAMES) expect(tables).toContain(name);
    // 反过来也查：多出一张没人声明的表，说明 DDL 与表清单已经漂移。
    expect(tables.slice().sort()).toEqual([...SLICE_TABLE_NAMES].sort());
  });

  it('schema_migrations 里那一行的版本号与 checksum 都落了地', async () => {
    const rows = await queryHarness<{ readonly version: string; readonly checksum: string }>(
      harness,
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe('0001_initial_slice');
    // checksum 是 sha256 十六进制。不比字面值：它是 DDL 文本的哈希，谁改一条 DDL 它就变，
    // 钉死字面值会把"改 DDL"变成"必须同时改测试"，而那不是这条断言要守的东西。
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('打印出来的是变量**名**，连接串、库名、postgres:// 一个都没出现', () => {
    expect(firstRunStdout.length).toBeGreaterThan(0);
    const joined = [...firstRunStdout, ...firstRunStderr].join('\n');
    expect(joined).toContain('DATABASE_DIRECT_URL');
    expect(joined).toContain('值不打印');
    expect(joined).not.toContain('postgres://');
    expect(joined).not.toContain(harness.connectionString);
    // 库名不在 secretsOf 的清单里（它不是秘密），但把它查一遍能证明输出里没有
    // 顺手带出连接串的任何一段。
    expect(joined).not.toContain(harness.databaseName);
    // 运行串的凭据也**不在** secretsOf 的清单里（它由直连串算出来），所以这是又一条
    // 独立断言：迁移命令确实没碰过运行串的值，只在 `resolveFormBConfig` 里确认过它存在。
    expect(joined).not.toContain('lq_runtime_unused');
    expect(joined).not.toContain('lq_never_dialed');
  });
});

describe('第二次运行：幂等', () => {
  it('applied 是空的，schema_migrations 仍然只有 1 条', async () => {
    const stdout: string[] = [];
    const outcome = await runFormBMigrations({ env: migrateEnv(), io: captureIo(stdout, []) });
    expect(outcome.report.applied).toEqual([]);
    expect(outcome.report.schemaVersion).toBe(1);
    expect(stdout.join('\n')).toContain('本次应用 0 个版本');
  });

  it('表还是那 17 张（重跑没有把什么建两遍或删掉）', async () => {
    const tables = await publicTables();
    expect(tables.slice().sort()).toEqual([...SLICE_TABLE_NAMES].sort());
  });
});

describe('已经应用过的迁移被事后改写 ⇒ 停下，不是跳过', () => {
  it('同版本不同 checksum 抛 MIGRATION_CHECKSUM_MISMATCH（不可重试）', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let thrown: unknown;
    try {
      await runFormBMigrations({
        env: migrateEnv(),
        // 注入一条**版本号相同、内容不同**的迁移。这正是"已应用的迁移被事后改写过"的形状：
        // 两个环境的 schema 会静默分叉，所以必须停，而不是当成"已经跑过了"跳过。
        migrations: [{ version: '0001_initial_slice', statements: ['SELECT 1'] }],
        io: captureIo(stdout, stderr),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, '被改写过的迁移必须让整条命令失败').toBeDefined();
    expect(isInfraError(thrown)).toBe(true);
    if (isInfraError(thrown)) {
      expect(thrown.code).toBe('MIGRATION_CHECKSUM_MISMATCH');
      expect(thrown.retryable).toBe(false);
    }
    // 失败也要脱敏，也要把原因写出来（部署日志里得能看出是哪一类失败）。
    const joined = [...stdout, ...stderr].join('\n');
    expect(joined).toContain('MIGRATION_CHECKSUM_MISMATCH');
    expect(joined).not.toContain('postgres://');
    expect(joined).not.toContain(harness.connectionString);
  });

  it('失败的那一次没有破坏已经建好的 schema（advisory lock 是事务级的，回滚即释放）', async () => {
    const tables = await publicTables();
    expect(tables.slice().sort()).toEqual([...SLICE_TABLE_NAMES].sort());
    // 也没有留下一条半截的记录：schema_migrations 仍然只有那一行真 checksum。
    const rows = await queryHarness<{ readonly n: string }>(
      harness,
      'SELECT count(*)::text AS n FROM schema_migrations',
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('修好之后还能再跑通（失败不是终态，这一点部署阶段要靠它重试）', async () => {
    const outcome = await runFormBMigrations({ env: migrateEnv(), io: captureIo([], []) });
    expect(outcome.report.applied).toEqual([]);
    expect(outcome.report.schemaVersion).toBe(1);
  });
});

/**
 * §3.2 schema 与迁移的**确定性**钉子（Layer A）。
 *
 * ## 为什么这一层不碰数据库
 * `support.ts` 开头写死了一条不变量：测试固件「不读时钟、不读环境变量、不读 locale、
 * 不读文件系统」——一条依赖宿主状态的用例在 CI 与本机会给出不同判定，而那种分歧不会
 * 报错，只会让门禁在某一台机器上悄悄失去意义。真 Postgres 断言必然读宿主状态，所以它们
 * 被隔到 `postgres-*.test.ts` + `support-database.ts` 里，没有数据库时**大声跳过**。
 *
 * 本文件是另一半：它钉的是 **SQL 文本与形状**。文本层面的错误（少一张表、部分索引的终态
 * 清单与 domain 漂移、`revision` 少了 `> 0`、时间列写成 `timestamp`、迁移里混进凭据、
 * INSERT 的列数与占位符数不一致）在任何一台机器上都同样红，**永远不会跳过**。
 * 少了这一层，"没有数据库所以全绿"就成了可能的假绿。
 *
 * ## 每条断言都带正对照
 * 一个提取器写坏了会返回空集合，空集合上的 `for … expect(...)` 一次都不执行，测试照样绿
 * ——那是本仓库反复踩过的空门。所以凡是用正则/扫描得到的集合，都先断言它的**元素个数**
 * 等于一个写死的期望值，再断言元素内容。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TASK_TRANSITIONS } from '@littleq/domain';
import {
  SCHEMA_MIGRATIONS_BOOTSTRAP_DDL,
  SLICE_TABLE_NAMES,
  SQL_MIGRATIONS,
  migrationChecksum,
} from '../src/index.js';
import { stripComments } from './support.js';

const SQL_DIR = fileURLToPath(new URL('../src/sql/', import.meta.url));

/** 迁移里出现的全部语句（不含 `schema_migrations` 自身的引导 DDL）。 */
const MIGRATION_STATEMENTS: readonly string[] = SQL_MIGRATIONS.flatMap((m) => m.statements);

function sqlSources(): ReadonlyMap<string, string> {
  const files = readdirSync(SQL_DIR).filter((name) => name.endsWith('.ts'));
  return new Map(
    files.map((name) => [name, stripComments(readFileSync(`${SQL_DIR}${name}`, 'utf8'))]),
  );
}

describe('§3.2 表清单', () => {
  it('恰好 17 张表，且与 §3.2 的 16 张加 §3.3 的 blob_digest_index 一致', () => {
    // 写死个数：SLICE_TABLE_NAMES 少一项或多一项都必须在这里红，而不是等到某张表没人建。
    expect(SLICE_TABLE_NAMES).toHaveLength(17);
    expect([...SLICE_TABLE_NAMES]).toEqual([
      'users',
      'password_credentials',
      'account_sessions',
      'projects',
      'versions',
      'ai_tasks',
      'task_private',
      'task_events',
      'owner_secrets',
      'artifact_files',
      'preview_tickets',
      'object_read_grants',
      'grant_read_leases',
      'usage_reservations',
      'usage_ledger',
      'schema_migrations',
      'blob_digest_index',
    ]);
  });

  it('每张表都有 CREATE TABLE，schema_migrations 只由引导 DDL 建', () => {
    // 正对照：确认提取器真的找到了东西，否则下面的循环是空转。
    const created = new Set<string>();
    for (const statement of [...MIGRATION_STATEMENTS, SCHEMA_MIGRATIONS_BOOTSTRAP_DDL]) {
      for (const match of statement.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+)/g)) {
        created.add(match[1] ?? '');
      }
    }
    expect(created.size).toBe(17);
    for (const table of SLICE_TABLE_NAMES) expect(created.has(table), table).toBe(true);

    // 「没有任何迁移能创建记录自己的那张表」——引导 DDL 是唯一出处。
    const inMigration = MIGRATION_STATEMENTS.filter((s) =>
      /CREATE TABLE(?: IF NOT EXISTS)? schema_migrations/.test(s),
    );
    expect(inMigration).toHaveLength(0);
    expect(SCHEMA_MIGRATIONS_BOOTSTRAP_DDL).toMatch(
      /CREATE TABLE IF NOT EXISTS schema_migrations/,
    );
  });

  it('建表次序满足 FK 依赖：users 先于其引用者，ai_tasks 先于 versions', () => {
    const order = MIGRATION_STATEMENTS.map(
      (s) => /CREATE TABLE(?: IF NOT EXISTS)? (\w+)/.exec(s)?.[1] ?? null,
    ).filter((name): name is string => name !== null);
    const indexOf = (table: string): number => {
      const found = order.indexOf(table);
      expect(found, table).toBeGreaterThanOrEqual(0);
      return found;
    };
    // versions.source_task_id → ai_tasks；projects.current_version_id 是事后 ALTER，
    // 所以 projects 本身可以早于 versions。
    expect(indexOf('ai_tasks')).toBeLessThan(indexOf('versions'));
    expect(indexOf('users')).toBeLessThan(indexOf('password_credentials'));
    expect(indexOf('users')).toBeLessThan(indexOf('account_sessions'));
    expect(order.indexOf('projects')).toBeLessThan(order.indexOf('ai_tasks'));
    // projects.current_version_id 的 FK 必须在 versions 之后补。
    const fkIndex = MIGRATION_STATEMENTS.findIndex(
      (s) => /ALTER TABLE projects/.test(s) && /current_version_id/.test(s),
    );
    expect(fkIndex).toBeGreaterThan(indexOf('versions'));
  });
});

describe('§3.2 列级约束', () => {
  it('users / projects / ai_tasks 的 revision 是 bigint NOT NULL CHECK (revision > 0)', () => {
    for (const table of ['users', 'projects', 'ai_tasks']) {
      const ddl = MIGRATION_STATEMENTS.find(
        (s) => new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`).test(s),
      );
      expect(ddl, table).toBeDefined();
      expect(ddl ?? '').toMatch(/revision\s+bigint\s+NOT NULL CHECK \(revision > 0\)/);
    }
  });

  it('每个 *_at 时间列都是 timestamptz，没有裸 timestamp', () => {
    // §4 item 2：「时间用 timestamptz」。扫描所有 DDL 里形如 `name_at  type` 的列声明。
    // `_until` 一起扫：`ai_tasks.lease_until` 是时间列，但不遵循 `_at` 命名。
    const timeColumns: string[] = [];
    for (const statement of [...MIGRATION_STATEMENTS, SCHEMA_MIGRATIONS_BOOTSTRAP_DDL]) {
      for (const match of statement.matchAll(/^\s*(\w*(?:_at|_until))\s+(\w+)/gm)) {
        timeColumns.push(`${match[1]}=${match[2]}`);
      }
    }
    // 正对照：实测 16 个时间列声明，扫到 0 个说明正则坏了。
    expect(timeColumns.length).toBeGreaterThanOrEqual(16);
    for (const entry of timeColumns) {
      expect(/=timestamptz$/.test(entry), `时间列类型必须是 timestamptz：${entry}`).toBe(true);
    }
    const all = [...MIGRATION_STATEMENTS, SCHEMA_MIGRATIONS_BOOTSTRAP_DDL].join('\n');
    expect(all).not.toMatch(/\btimestamp\b/);
  });

  it('ai_tasks_one_active_per_project 的终态清单与 domain 的 TASK_TRANSITIONS.terminal 一致', () => {
    const ddl = MIGRATION_STATEMENTS.find((s) =>
      /CREATE UNIQUE INDEX ai_tasks_one_active_per_project/.test(s),
    );
    expect(ddl).toBeDefined();
    const listed = [...(ddl ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] ?? '');
    // 清单来自 domain，不是这里写死：domain 新增终态而索引没跟上，这条会红。
    // 漂移的后果不是报错而是"已完成的项目再也发不起新 turn"，属于静默故障，必须钉住。
    expect(listed).toEqual([...TASK_TRANSITIONS.terminal]);
    expect(listed).toHaveLength(5);
    expect(ddl ?? '').toMatch(/ON ai_tasks\(project_id\)/);
    expect(ddl ?? '').toMatch(/WHERE state NOT IN/);
  });

  it('users_role_shape 把 OWNER/STUDENT 的 owner_id 与 age_band 形状写进数据库', () => {
    const ddl = MIGRATION_STATEMENTS.find((s) => /CREATE TABLE IF NOT EXISTS users \(/.test(s));
    expect(ddl ?? '').toMatch(/CONSTRAINT users_role_shape CHECK/);
    expect(ddl ?? '').toMatch(/role = 'OWNER' AND owner_id IS NULL AND age_band IS NULL/);
    expect(ddl ?? '').toMatch(/role = 'STUDENT' AND owner_id IS NOT NULL AND age_band IS NOT NULL/);
  });
});

describe('§3.2「凭据不写 migration SQL」', () => {
  const CREDENTIAL_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    { name: '连接串', pattern: /:\/\// },
    { name: 'PEM 私钥', pattern: /-----BEGIN/ },
    { name: 'OpenAI 风格密钥', pattern: /\bsk-[A-Za-z0-9]/ },
    { name: 'GitHub token', pattern: /\b(ghp_|github_pat_)/ },
    { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{8}/ },
    { name: 'Slack token', pattern: /\bxox[baprs]-/ },
    { name: 'Bearer 头', pattern: /\bBearer\s+[A-Za-z0-9._-]{8}/ },
    { name: 'Vercel Blob token', pattern: /vercel_blob_/i },
    { name: '口令赋值', pattern: /\b(password|passwd|secret|token|api_?key)\s*=\s*'/i },
  ];

  /** 取出 SQL 文本里所有单引号字面量的内容。 */
  function stringLiterals(sql: string): readonly string[] {
    return [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
  }

  it('迁移与引导 DDL 的字面量里没有任何凭据形状', () => {
    const literals = [
      ...MIGRATION_STATEMENTS.flatMap(stringLiterals),
      ...stringLiterals(SCHEMA_MIGRATIONS_BOOTSTRAP_DDL),
    ];
    // 正对照：实测 25 个字面量（DDL 里的 CHECK 枚举），扫到 0 个说明提取器坏了。
    expect(literals.length).toBeGreaterThan(20);
    expect(literals).toContain('OWNER');
    expect(literals).toContain('SUCCEEDED');

    const offenders: string[] = [];
    for (const literal of literals) {
      for (const { name, pattern } of CREDENTIAL_SHAPES) {
        if (pattern.test(literal)) offenders.push(`${name}: ${literal}`);
      }
      // 长 base64/hex 串：真实的密钥与摘要不会以字面量形式出现在 DDL 里。
      if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(literal)) offenders.push(`长 base64: ${literal}`);
      if (/^[0-9a-f]{32,}$/i.test(literal)) offenders.push(`长 hex: ${literal}`);
    }
    expect(offenders).toEqual([]);
  });

  it('整个 sql/ 目录的源码里没有连接串或密钥字面量', () => {
    // 比上一条更宽：连注释和常量一起扫。连接串只能来自环境变量，不能出现在代码里。
    for (const [name, source] of sqlSources()) {
      for (const { name: shapeName, pattern } of CREDENTIAL_SHAPES) {
        if (shapeName === '口令赋值') continue; // 列名 password_hash 会误伤，上一条已覆盖字面量
        expect(pattern.test(source), `${name} 命中 ${shapeName}`).toBe(false);
      }
    }
  });
});

describe('migrationChecksum', () => {
  const base = { version: '0001_initial_slice', statements: ['CREATE TABLE a (x int)'] };

  it('等于独立重算的 sha256（正对照）', () => {
    const expected = createHash('sha256')
      .update(base.version)
      .update('\u0000')
      .update(base.statements.join('\u0000'))
      .digest('hex');
    expect(migrationChecksum(base)).toBe(expected);
    expect(migrationChecksum(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('对语句内容、语句顺序、语句边界、版本号都敏感', () => {
    const digest = migrationChecksum(base);
    // 内容
    expect(migrationChecksum({ ...base, statements: ['CREATE TABLE a (x bigint)'] })).not.toBe(
      digest,
    );
    // 顺序：['a','b'] 与 ['b','a'] 必须不同，否则改序的迁移不会被发现。
    const two = { version: 'v', statements: ['stmt-one', 'stmt-two'] };
    expect(migrationChecksum({ ...two, statements: ['stmt-two', 'stmt-one'] })).not.toBe(
      migrationChecksum(two),
    );
    // 边界：分隔符是 \u0000 而不是空格，就是为了这一条。
    expect(migrationChecksum({ version: 'v', statements: ['a b', 'c'] })).not.toBe(
      migrationChecksum({ version: 'v', statements: ['a', 'b c'] }),
    );
    // 版本
    expect(migrationChecksum({ ...base, version: '0002_initial_slice' })).not.toBe(digest);
  });

  it('本期唯一一条迁移的 checksum 稳定，改一个字就变', () => {
    expect(SQL_MIGRATIONS).toHaveLength(1);
    const [migration] = SQL_MIGRATIONS;
    expect(migration).toBeDefined();
    if (migration === undefined) return;
    expect(migration.version).toBe('0001_initial_slice');
    const digest = migrationChecksum(migration);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // 变异对照：往最后一条语句里塞一个空格之外的实义字符，checksum 必须变。
    const mutated = {
      ...migration,
      statements: migration.statements.map((s, i) =>
        i === migration.statements.length - 1 ? `${s.trimEnd()}\n-- mutated` : s,
      ),
    };
    expect(migrationChecksum(mutated)).not.toBe(digest);
  });
});

describe('INSERT 语句的列数与占位符一致', () => {
  type InsertShape = {
    readonly file: string;
    readonly name: string;
    readonly table: string;
    readonly columnCount: number;
    readonly placeholders: readonly number[];
  };

  function scanInserts(): readonly InsertShape[] {
    const found: InsertShape[] = [];
    for (const [file, source] of sqlSources()) {
      // 只扫 export const X = `...`; 里的 INSERT。
      const constants = source.matchAll(/export const (\w+) = `([^`]*)`/g);
      for (const match of constants) {
        const name = match[1] ?? '';
        const body = match[2] ?? '';
        const insert = /INSERT INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/s.exec(body);
        if (insert === null) continue;
        const columns = (insert[2] ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        const placeholders = [...(insert[3] ?? '').matchAll(/\$(\d+)/g)].map((m) =>
          Number(m[1]),
        );
        found.push({
          file,
          name,
          table: insert[1] ?? '',
          columnCount: columns.length,
          placeholders,
        });
      }
    }
    return found;
  }

  const inserts = scanInserts();

  it('扫描器确实找到了 INSERT（正对照）', () => {
    // 正则或 stripComments 改坏了会返回空数组，后面所有 for 循环都空转成假绿。
    expect(inserts.length).toBeGreaterThanOrEqual(12);
    expect(inserts.map((i) => i.table)).toContain('users');
    expect(inserts.map((i) => i.table)).toContain('ai_tasks');
    expect(inserts.map((i) => i.table)).toContain('blob_digest_index');
  });

  it('每条 INSERT 的占位符恰好是 $1..$N，N 等于列数', () => {
    for (const insert of inserts) {
      const label = `${insert.file}:${insert.name}`;
      // §3.1「所有生产 SQL 参数化」：VALUES 里不许出现裸字面量。
      expect(insert.placeholders.length, `${label} 占位符数 ≠ 列数`).toBe(insert.columnCount);
      expect(
        [...insert.placeholders].sort((a, b) => a - b),
        `${label} 占位符必须是 $1..$N 连续无重复`,
      ).toEqual(Array.from({ length: insert.columnCount }, (_, i) => i + 1));
    }
  });

  it('每条 INSERT 都写进了 §3.2 的表清单', () => {
    for (const insert of inserts) {
      expect(
        (SLICE_TABLE_NAMES as readonly string[]).includes(insert.table),
        `${insert.file}:${insert.name} 写向未知表 ${insert.table}`,
      ).toBe(true);
    }
  });
});

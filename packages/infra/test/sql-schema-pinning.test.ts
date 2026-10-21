/**
 * SQL 文本、行类型与 DDL 三者之间的**绑定**（Layer A：确定性，不碰数据库）。
 *
 * ## 这个文件钉的是"两处各自正确但彼此漂移"这一类错
 *
 * `task-rows.ts:222` 的注释点名了本文件。索引名 `ai_tasks_one_active_per_project` 有两个
 * 事实源：迁移 DDL 里是**字面量**（插值进去会让 checksum 随常量变动），
 * `AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX` 是常量。没有任何机制让它们一致 —— 直到这里。
 *
 * 而漂移的代价**只在真并发下显形**，这正是它最贵的地方。`task-unit-of-work.ts:507`：
 * ```ts
 * if (uniqueViolationConstraint(error) === AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX) {
 *   throw activeWriteConflictError();
 * }
 * throw error;
 * ```
 * 名字对不上，这个分支就永远不进：两个请求同时 `createTurn`，输的那个拿到的是**裸 23505**
 * 而不是 `ACTIVE_WRITE_TASK_EXISTS`（409）—— §6.5 规则 4 逐字警告的「同一个用户可见结果
 * 会因为竞态胜负给出两种响应」。编译期看不见（两边都是合法字符串），单元测试也看不见
 * （单进程事件循环里两次 INSERT 天然串行，压根撞不到那条索引）。只有本文件这种把两处文本
 * 摆在一起比的断言能在合并前拦住它。
 *
 * ## 列清单的两条绑定，各自挡的是什么
 *
 * - **列清单 ⊆ DDL**：`AI_TASK_COLUMNS` 写了一个表里没有的列，运行期是 42703。要等到
 *   第一次真查询才发现，而在没有数据库的 CI 上永远发现不了。这一条不需要数据库。
 * - **列清单 ↔ 行类型**：这一条**不是**"TypeScript 看不见"。实测：从 `AiTaskRow` 删掉
 *   `lease_token`，`tsc` 会在 `task-rows.ts:384`（`leaseFromRow(row)` 的入参形状）报
 *   TS2741 —— 编译期就红了。真正编译期看不见的是**反方向**：往行类型里加一个
 *   `AI_TASK_COLUMNS` 没选的字段，那个字段的类型写着 `string | null`，运行期却是
 *   `undefined`（SELECT 从没要过它）。这一条把两个方向都收进同一条集合相等断言，
 *   于是"哪一边多、哪一边少"都红，且都不需要数据库。
 *
 * ## 为什么每个提取器都带一条"元素个数"正对照
 *
 * 这些断言全是"集合 A 等于集合 B"。一个写坏的提取器会返回**空集合**，而
 * `expect([]).toEqual([])` 是绿的 —— 于是几条绑定同时失效，门禁照过。这是本仓库反复
 * 踩过的空门，所以每处提取都先报出自己找到了几个。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SQL_MIGRATIONS } from '../src/sql/migrations.js';
import { OWNER_SECRETS_COLUMNS } from '../src/sql/secret-records.js';
import { AI_TASK_COLUMNS, AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX } from '../src/sql/task-rows.js';
import { stripComments } from './support.js';

const SQL_DIR = fileURLToPath(new URL('../src/sql/', import.meta.url));

/** 全部迁移语句拼成一段文本，用于查 DDL 里的字面量。 */
const MIGRATION_TEXT: string = SQL_MIGRATIONS.flatMap((migration) => migration.statements).join(
  '\n',
);

function sqlSource(name: string): string {
  return stripComments(readFileSync(`${SQL_DIR}${name}`, 'utf8'));
}

/** 把 `a, b,\n  c` 这样的列清单切成名字数组。 */
function columnNames(list: string): readonly string[] {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 从建表语句里取出列名。
 *
 * 只认**顶格两空格开头、名字后跟类型**的行，于是 `CONSTRAINT …`、`PRIMARY KEY (…)`、
 * `CHECK (…)` 这些表级约束不会被当成列。返回顺序就是 DDL 里的声明顺序。
 */
function ddlColumns(table: string): readonly string[] {
  const start = MIGRATION_TEXT.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  const from = start >= 0 ? start : MIGRATION_TEXT.indexOf(`CREATE TABLE ${table} (`);
  expect(from, `迁移文本里没有 ${table} 的建表语句`).toBeGreaterThanOrEqual(0);
  const body = MIGRATION_TEXT.slice(from);
  const end = body.indexOf('\n)');
  expect(end, `${table} 的建表语句没有闭合`).toBeGreaterThan(0);
  const names: string[] = [];
  for (const rawLine of body.slice(0, end).split('\n')) {
    const line = rawLine.trim();
    const match = /^([a-z_][a-z0-9_]*)\s+(?:uuid|text|varchar|bigint|integer|boolean|jsonb|bytea|timestamptz)\b/.exec(
      line,
    );
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

describe('索引名常量 ↔ 迁移 DDL 字面量', () => {
  it('导出的索引名在建表迁移里被 CREATE UNIQUE INDEX 逐字使用', () => {
    expect(AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX).toBe('ai_tasks_one_active_per_project');
    const hits = MIGRATION_TEXT.split(AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX).length - 1;
    // 恰好两次：一次在 `CREATE UNIQUE INDEX <name>`，一次不可能有第三处 ——
    // 多于两次说明有别的语句也引用了它（例如又建了一个同名索引），那必须是人看的。
    expect(hits, `迁移文本里出现 ${hits} 次`).toBe(1);
    expect(MIGRATION_TEXT).toContain(`CREATE UNIQUE INDEX ${AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX}`);
    expect(MIGRATION_TEXT).toContain(
      `CREATE UNIQUE INDEX ${AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX}\nON ai_tasks(project_id)`,
    );
  });

  it('正对照：常量本身不是空串，且不含可注入的字符', () => {
    // 这个名字会出现在错误翻译的判据里（`uniqueViolationConstraint(error) === 常量`），
    // 一个空串会让"任何一次唯一冲突"都被翻译成 `ACTIVE_WRITE_TASK_EXISTS`。
    expect(AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX.length).toBeGreaterThan(0);
    expect(AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe('列清单 ↔ 行类型 ↔ DDL', () => {
  const cases = [
    {
      label: 'ai_tasks',
      table: 'ai_tasks',
      columns: AI_TASK_COLUMNS,
      sourceFile: 'task-rows.ts',
      rowTypeName: 'AiTaskRow',
    },
    {
      label: 'owner_secrets',
      table: 'owner_secrets',
      columns: OWNER_SECRETS_COLUMNS,
      sourceFile: 'secret-records.ts',
      rowTypeName: 'OwnerSecretRow',
    },
  ] as const;

  it('正对照：这份表驱动的用例覆盖两张表', () => {
    expect(cases.length).toBe(2);
  });

  for (const testCase of cases) {
    it(`${testCase.label}: SELECT 列清单与 ${testCase.rowTypeName} 的键集合逐字相同`, () => {
      const selected = columnNames(testCase.columns);
      // 正对照：提取器真的拿到了东西。空集合上的集合相等断言是绿的。
      expect(selected.length, `${testCase.label} 列清单提取为空`).toBeGreaterThan(9);

      const rowKeys = parseRowTypeKeys(sqlSource(testCase.sourceFile), testCase.rowTypeName);
      expect(rowKeys.length, `${testCase.rowTypeName} 字段提取为空`).toBe(selected.length);
      expect([...selected].sort()).toEqual([...rowKeys].sort());
    });

    it(`${testCase.label}: SELECT 列清单里的每个列名都真的在建表语句里`, () => {
      const selected = columnNames(testCase.columns);
      const declared = ddlColumns(testCase.table);
      expect(declared.length, `${testCase.table} 的列提取为空`).toBeGreaterThan(9);
      // 方向很重要：列清单 ⊆ DDL。反过来不成立 —— 表可以有 SELECT 不取的列
      // （例如 `ai_tasks` 若将来加一列内部审计字段），那不该红。
      const missing = selected.filter((name) => !declared.includes(name));
      expect(missing, `${testCase.label} 选了 DDL 里不存在的列`).toEqual([]);
      expect(declared.length, `${testCase.table} 的列数`).toBe(selected.length);
    });
  }
});

/**
 * 从源码文本里取出一个 `type X = { readonly a: …; readonly b: … }` 的字段名。
 *
 * 只能读文本：`keyof AiTaskRow` 是纯类型层的，产生不了运行期数组，而行类型在运行期根本
 * 不存在（`{} as AiTaskRow` 没有任何键可反射）。这也正是"少一个字段"这类漂移在编译期
 * 看不见的同一个原因 —— 所以这里要先过一遍 `stripComments`，注释里的 `readonly foo:`
 * 不算字段。
 */
function parseRowTypeKeys(source: string, typeName: string): readonly string[] {
  const start = source.indexOf(`export type ${typeName} = {`);
  expect(start, `${typeName} 的声明没找到`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start);
  const end = body.indexOf('};');
  expect(end, `${typeName} 的声明没有闭合`).toBeGreaterThan(0);
  const keys: string[] = [];
  for (const rawLine of body.slice(0, end).split('\n')) {
    const match = /^\s*(?:readonly\s+)?([a-z_][a-z0-9_]*)\s*[?]?:/.exec(rawLine);
    if (match?.[1] !== undefined) keys.push(match[1]);
  }
  return keys;
}

describe('sql 目录里没有第二份索引名字面量', () => {
  it('除 migrations.ts 的 DDL 与 task-rows.ts 的常量外，没有别处硬写这个名字', () => {
    // 这条把"两个事实源"钉成"恰好两个"。第三个硬写点意味着改名时要找三处，
    // 而漏掉的那处会在运行期把一次唯一冲突翻译成错误的业务码。
    const files = readdirSync(SQL_DIR).filter((name) => name.endsWith('.ts'));
    expect(files.length, 'sql 目录提取为空').toBeGreaterThan(10);
    const hits = files.filter((name) =>
      sqlSource(name).includes(AI_TASK_ONE_ACTIVE_PER_PROJECT_INDEX),
    );
    expect([...hits].sort()).toEqual(['migrations.ts', 'task-rows.ts']);
  });
});

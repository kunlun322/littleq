import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createProject,
  createUsageLedgerEntry,
  createUsageReservation,
  parseTimestamp,
} from '@littleq/domain';
import { describe, expect, it } from 'vitest';

import { isInfraError } from '../src/index.js';
import {
  PROJECT_CAS_SQL,
  PROJECT_INSERT_SQL,
  projectCasParams,
  projectInsertParams,
} from '../src/sql/project-rows.js';
import {
  fromNullableTimestamptz,
  fromTimestamptz,
  toNullableTimestamptz,
  toTimestamptz,
} from '../src/sql/rows.js';
import {
  AI_TASK_ENTITY_CAS_SQL,
  AI_TASK_INSERT_SQL,
  taskEntityCasParams,
  taskInsertParams,
} from '../src/sql/task-rows.js';
import {
  USAGE_LEDGER_INSERT_SQL,
  USAGE_RESERVATION_INSERT_SQL,
  ledgerInsertParams,
  reservationInsertParams,
} from '../src/sql/usage-rows.js';
import { countOccurrences, makeTask, uuidAt } from './support.js';

/**
 * `timestamptz` 编解码的方向与归一 —— 一个**真缺陷**留下的守卫。
 *
 * ## 缺陷是什么
 *
 * `toTimestamptz` 的第一版用字符串手术把小数位归一到 3 位：
 * `text.replace(/\.(\d+)Z$/, 'Z')` 再拼 `.000Z`。`replace` 只改**匹配上**的部分，而
 * `TIMESTAMP_PATTERN` 允许小数整体缺省 —— 于是没有小数的输入原样穿过，拼出来是
 * `2026-03-01T00:00:00Z.000Z`，一个非法 ISO 串。**每一次** `timestamptz` 写入都会失败。
 *
 * ## 为什么 79 条绿用例没有发现它
 *
 * 因为在它被发现之前，**没有任何一条用例让一个非空时间戳穿过编解码器**：
 *
 * - `support.ts` 的 `makeTask` 默认 fixture 里根本没有 `nextRunAt` 键（`createAiTask`
 *   因此得到 `null`，而 `toNullableTimestamptz(null)` 走的是那条不碰归一的短路）；
 * - `postgres-schema-migration.test.ts` 刻意用**裸 SQL** 播种，为的是断言"迁移从零建出
 *   全部表"，绕开了参数构造器；
 * - 其余用例钉的是 SQL 文本与形状，不执行写入。
 *
 * 缺陷是在 §7.1 的真 DB 层被 `seedProject` 撞出来的：那是第一条真的把实体交给
 * `projectInsertParams` 的路径。这正是 ZLQ-216 §7.1 要"真 DB 黑盒证据"而不是"再多几条
 * 形状断言"的理由 —— 形状断言全绿，值仍然是坏的。
 *
 * ## 两道守卫，各管一件事
 *
 * - **值层**（下面 A、C 两节）：归一的输出恒合法、恒为 3 位小数、round-trip 恒等，
 *   且**每个** `$N::timestamptz` 槽位上放的确实是这样的值。
 * - **方向层**（B 节）：读编解码器（`rows.ts` 的 `from*`，入参一律 `unknown`）不得出现在
 *   `*Params` 构造器里。这一条必须存在，因为**类型系统拦不住**：`fromNullableTimestamptz`
 *   收 `unknown`，把一个 `Timestamp` 喂给它编译得过、跑起来也"对"（它内部会调
 *   `toTimestamptz`），坏的只是异常码与可读性。同一个缺陷当时出现在**两个文件四处**
 *   （`projectInsertParams` / `projectCasParams` / `reservationInsertParams` /
 *   `ledgerInsertParams`），枚举 fixture 只能证明枚举到的那几处。
 */

/** 缺陷当时产出的那个串。用 `parseTimestamp` 判它非法 —— 判据来自 domain，不是本文件的副本。 */
const DEFECTIVE_OUTPUT = '2026-03-01T00:00:00Z.000Z';

/**
 * 归一的输入表。四格覆盖了 `TIMESTAMP_PATTERN` 允许的全部小数形态：缺省、1 位、3 位、6 位。
 * 第一格是缺陷形态本身 —— 当时它产出的正是 `DEFECTIVE_OUTPUT`。
 */
const NORMALIZATION_TABLE: readonly (readonly [input: string, expected: string])[] = [
  ['2026-03-01T00:00:00Z', '2026-03-01T00:00:00.000Z'],
  ['2026-03-01T00:00:06.5Z', '2026-03-01T00:00:06.500Z'],
  ['2026-03-01T00:00:06.123Z', '2026-03-01T00:00:06.123Z'],
  ['2026-03-01T00:00:06.123456Z', '2026-03-01T00:00:06.123Z'],
];

/** 毫秒精度的输入：这些的 round-trip 必须**逐字**恒等。 */
const ROUND_TRIP_INPUTS: readonly string[] = NORMALIZATION_TABLE.map(
  ([, expected]) => expected,
).filter((value, index, all) => all.indexOf(value) === index);

describe('A. 归一化契约（值层）', () => {
  it('正对照：domain 自己判缺陷形态非法，而表里每个期望值合法', () => {
    expect(() => parseTimestamp(DEFECTIVE_OUTPUT)).toThrow();
    for (const [, expected] of NORMALIZATION_TABLE) {
      expect(() => parseTimestamp(expected), expected).not.toThrow();
    }
  });

  it('表里每一格都归一到声明的期望值（含缺省小数位那一格）', () => {
    for (const [input, expected] of NORMALIZATION_TABLE) {
      expect(toTimestamptz(parseTimestamp(input)), `${input} 的归一结果`).toBe(expected);
    }
  });

  it('输出恒为合法 Timestamp、恒为 3 位小数、且只有一个 Z', () => {
    for (const [input] of NORMALIZATION_TABLE) {
      const output = toTimestamptz(parseTimestamp(input));
      expect(() => parseTimestamp(output), output).not.toThrow();
      expect(output, '小数位必须恒为 3 位').toMatch(/\.\d{3}Z$/);
      expect(countOccurrences(output, 'Z'), '缺陷形态的特征就是多出一个 Z').toBe(1);
    }
  });

  it('幂等：再归一一次不改变结果', () => {
    for (const [input] of NORMALIZATION_TABLE) {
      const once = toTimestamptz(parseTimestamp(input));
      expect(toTimestamptz(parseTimestamp(once))).toBe(once);
    }
  });

  it('round-trip 恒等：fromTimestamptz(toTimestamptz(t)) === t（毫秒精度内）', () => {
    // 反空对照：这一格必须真的有用例在跑，否则「全部相等」是空集合上的真话。
    expect(ROUND_TRIP_INPUTS.length).toBeGreaterThan(0);
    for (const text of ROUND_TRIP_INPUTS) {
      const timestamp = parseTimestamp(text);
      expect(fromTimestamptz(toTimestamptz(timestamp))).toBe(timestamp);
    }
  });

  it('已申报的取舍：微秒被截断而不是四舍五入', () => {
    // `.123456` → `.123`（截断）。四舍五入会得到 `.123`，但 `.999999` 会暴露差别：
    // 四舍五入进位到下一秒，截断留在原秒。这条断言钉的是**截断**。
    expect(toTimestamptz(parseTimestamp('2026-03-01T00:00:06.999999Z'))).toBe(
      '2026-03-01T00:00:06.999Z',
    );
  });

  it('读回时同时接受 Date 与字符串，且两条路一致', () => {
    for (const [, expected] of NORMALIZATION_TABLE) {
      const asDate = new Date(expected);
      expect(fromTimestamptz(asDate), `${expected} 走 Date`).toBe(expected);
      expect(fromTimestamptz(expected), `${expected} 走字符串`).toBe(expected);
    }
  });

  it('可空版本把 NULL 原样传下去，不归一成 epoch', () => {
    expect(toNullableTimestamptz(null)).toBeNull();
    expect(fromNullableTimestamptz(null)).toBeNull();
    expect(fromNullableTimestamptz(undefined)).toBeNull();
    // 反空对照：非空那一侧必须仍然工作，否则「NULL 通过」可能只是整个函数返回 null。
    expect(toNullableTimestamptz(parseTimestamp('2026-03-01T00:00:00Z'))).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });

  it('形状不符一律 STORED_ROW_INCONSISTENT，且异常消息不带列名也不带读到的值', () => {
    const shapes: readonly unknown[] = [
      0,
      1_700_000_000_000,
      {},
      [],
      '2026-03-01',
      DEFECTIVE_OUTPUT,
    ];
    for (const shape of shapes) {
      let thrown: unknown;
      try {
        fromTimestamptz(shape);
      } catch (error) {
        thrown = error;
      }
      expect(isInfraError(thrown), `形状 ${String(shape)} 应当抛 InfraError`).toBe(true);
      if (!isInfraError(thrown)) continue;
      expect(thrown.code).toBe('STORED_ROW_INCONSISTENT');
      // §4.1：不返回原异常/原值。消息就是码本身，所以它不可能夹带读到的内容。
      expect(thrown.message).toBe('STORED_ROW_INCONSISTENT');
    }
  });
});

/** `rows.ts` 里全部**读**编解码器的名字。入参一律 `unknown` —— 这正是它们能被误用到写路径上的原因。 */
function readCodecNames(): readonly string[] {
  const source = readFileSync(
    fileURLToPath(new URL('../src/sql/rows.ts', import.meta.url)),
    'utf8',
  );
  return [...source.matchAll(/^export function (from\w+)\s*\(/gm)].map((match) => match[1] ?? '');
}

/** 从 prettier 格式化过的源码里取出顶层 `export function <name>Params(…)` 的函数体。 */
function paramsFunctionBodies(source: string): readonly (readonly [name: string, body: string])[] {
  const lines = source.split('\n');
  const found: [string, string][] = [];
  let current: { readonly name: string; readonly body: string[] } | null = null;
  for (const line of lines) {
    if (current === null) {
      const match = /^export function (\w*Params)\s*\(/.exec(line);
      if (match !== null) current = { name: match[1] ?? '', body: [] };
      continue;
    }
    // 顶层函数的右花括号在第 0 列；嵌套块一律有缩进，所以这一判据不会提前收尾。
    if (line === '}') {
      found.push([current.name, current.body.join('\n')]);
      current = null;
      continue;
    }
    current.body.push(line);
  }
  return found;
}

const SQL_DIR = fileURLToPath(new URL('../src/sql/', import.meta.url));

function sqlFiles(): readonly string[] {
  return readdirSync(SQL_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `${SQL_DIR}/${name}`);
}

describe('B. 读编解码器不得出现在写参数构造器里（方向层）', () => {
  it('正对照：名单非空，且确实来自 rows.ts 的 from* 导出', () => {
    const names = readCodecNames();
    expect(names.length).toBeGreaterThan(5);
    expect(names).toContain('fromNullableTimestamptz');
    expect(names).toContain('fromTimestamptz');
    // 写方向的编解码器不在名单里，否则下面那条扫描会把正确代码也报成违规。
    expect(names).not.toContain('toTimestamptz');
    expect(names).not.toContain('toJsonb');
  });

  it('正对照：探针本身能抓出违规（否则「0 处」可能只是扫描器坏了）', () => {
    const names = readCodecNames();
    const violating = [
      'export function projectInsertParams(project: Project): readonly unknown[] {',
      '  return [',
      '    fromNullableTimestamptz(project.updatedAt),',
      '  ];',
      '}',
    ].join('\n');
    const bodies = paramsFunctionBodies(violating);
    expect(bodies.length).toBe(1);
    const [name, body] = bodies[0] ?? ['', ''];
    expect(name).toBe('projectInsertParams');
    const hits = names.filter((codec) => body.includes(`${codec}(`));
    expect(hits, '探针必须能在构造出的违规样本上报出 fromNullableTimestamptz').toEqual([
      'fromNullableTimestamptz',
    ]);
  });

  it('正对照：探针不把正确的写构造器报成违规', () => {
    const names = readCodecNames();
    const correct = [
      'export function projectInsertParams(project: Project): readonly unknown[] {',
      '  return [',
      '    toTimestamptz(project.updatedAt),',
      '    toJsonb(project),',
      '  ];',
      '}',
    ].join('\n');
    const bodies = paramsFunctionBodies(correct);
    expect(bodies.length).toBe(1);
    const [, body] = bodies[0] ?? ['', ''];
    expect(names.filter((codec) => body.includes(`${codec}(`))).toEqual([]);
  });

  it('src/sql 下每个 *Params 构造器都不调用任何读编解码器', () => {
    const names = readCodecNames();
    const files = sqlFiles();
    expect(files.length, '扫描必须真的扫到文件').toBeGreaterThan(10);

    let scanned = 0;
    const violations: string[] = [];
    for (const file of files) {
      for (const [name, body] of paramsFunctionBodies(readFileSync(file, 'utf8'))) {
        scanned += 1;
        for (const codec of names) {
          if (body.includes(`${codec}(`)) violations.push(`${name} -> ${codec}`);
        }
      }
    }
    // 反空对照：扫到 0 个构造器的话，「没有违规」就是一句空话。
    expect(scanned, '*Params 构造器数量').toBeGreaterThan(5);
    expect(violations, '读编解码器出现在写参数构造器里').toEqual([]);
  });
});

/** SQL 文本里所有 `$N::timestamptz` 的 N（1 起）。 */
function timestamptzSlots(sql: string): readonly number[] {
  return [...sql.matchAll(/\$(\d+)::timestamptz/g)].map((match) => Number(match[1]));
}

const PROJECT = createProject({
  id: uuidAt(11),
  ownerStudentId: uuidAt(12),
  title: '编解码夹具项目',
  workType: 'GAME',
  ageBand: 'L1',
  helpLevel: 'LV1',
  createdAt: '2026-03-01T00:00:00Z',
  // 刻意用**非 3 位**的小数：3 位的输入即使归一坏掉也可能碰巧对上。
  updatedAt: '2026-03-01T04:05:06.123456Z',
  revision: '1',
});

const TASK = makeTask({
  state: 'RETRY_WAIT',
  nextRunAt: '2026-03-01T04:05:06.5Z',
  revision: '1',
});

const LEASE = {
  owner: 'worker-a',
  token: 'lease_00000001_deadbeefdeadbeef',
  until: parseTimestamp('2026-03-01T04:06:06Z'),
} as const;

const RESERVATION = createUsageReservation({
  id: uuidAt(13),
  taskId: uuidAt(14),
  subjectUserId: uuidAt(15),
  capability: 'QCA_TASK',
  reservedUnits: 10,
  expiresAt: '2026-03-01T05:00:00.999999Z',
});

const LEDGER_ENTRY = createUsageLedgerEntry({
  id: uuidAt(16),
  eventKey: 'codec-fixture-1',
  taskId: uuidAt(14),
  subjectUserId: uuidAt(15),
  capability: 'QCA_TASK',
  quantity: 7,
  provider: 'QCA',
  occurredAt: '2026-03-01T06:00:00Z',
});

/** 每一对 (SQL, 参数) —— 覆盖两个曾出缺陷的文件与两个当时就正确的文件。 */
const WRITE_PARAM_PAIRS: readonly (readonly [
  label: string,
  sql: string,
  params: readonly unknown[],
])[] = [
  ['projectInsertParams', PROJECT_INSERT_SQL, projectInsertParams(PROJECT)],
  ['projectCasParams', PROJECT_CAS_SQL, projectCasParams(PROJECT, '1')],
  ['taskInsertParams', AI_TASK_INSERT_SQL, taskInsertParams(TASK, '1', LEASE)],
  ['taskEntityCasParams', AI_TASK_ENTITY_CAS_SQL, taskEntityCasParams(TASK, '1')],
  ['reservationInsertParams', USAGE_RESERVATION_INSERT_SQL, reservationInsertParams(RESERVATION)],
  ['ledgerInsertParams', USAGE_LEDGER_INSERT_SQL, ledgerInsertParams(LEDGER_ENTRY)],
];

describe('C. 每个 $N::timestamptz 槽位上放的都是能直接写进库的值', () => {
  it('槽位总数是实测值（反空对照：0 个槽位的话这一节什么都没证明）', () => {
    const total = WRITE_PARAM_PAIRS.reduce((sum, [, sql]) => sum + timestamptzSlots(sql).length, 0);
    expect(total).toBe(7);
    // 逐对也要有：某一对悄悄丢掉 ::timestamptz 转换会让总数下降，而下降后的数字仍然 > 0。
    expect(timestamptzSlots(PROJECT_INSERT_SQL)).toEqual([6]);
    expect(timestamptzSlots(AI_TASK_INSERT_SQL)).toEqual([11, 14]);
    expect(timestamptzSlots(USAGE_LEDGER_INSERT_SQL)).toEqual([13]);
  });

  it('每个槽位的值要么是 null，要么是合法且已归一到 3 位小数的字符串', () => {
    for (const [label, sql, params] of WRITE_PARAM_PAIRS) {
      for (const slot of timestamptzSlots(sql)) {
        const value = params[slot - 1];
        if (value === null) continue;
        expect(typeof value, `${label} 的 $${slot} 应当是字符串`).toBe('string');
        if (typeof value !== 'string') continue;
        expect(() => parseTimestamp(value), `${label} 的 $${slot}`).not.toThrow();
        expect(value, `${label} 的 $${slot} 未归一`).toMatch(/\.\d{3}Z$/);
        expect(countOccurrences(value, 'Z'), `${label} 的 $${slot}`).toBe(1);
      }
    }
  });

  it('夹具里的非空时间戳真的走到了槽位上（否则上一格是在 null 上空转）', () => {
    // PROJECT.updatedAt 带 6 位小数 ⇒ 槽位上必须是截断后的 3 位。这一格证明
    // 「归一发生在写路径上」，而不只是发生在 toTimestamptz 的单元里。
    expect(projectInsertParams(PROJECT)[5]).toBe('2026-03-01T04:05:06.123Z');
    expect(projectCasParams(PROJECT, '1')[5]).toBe('2026-03-01T04:05:06.123Z');
    // TASK.nextRunAt 带 1 位小数 ⇒ 补齐成 3 位。
    expect(taskInsertParams(TASK, '1', LEASE)[10]).toBe('2026-03-01T04:05:06.500Z');
    // 租约的 until 没有小数 ⇒ 补齐成 .000，这正是缺陷形态那一格。
    expect(taskInsertParams(TASK, '1', LEASE)[13]).toBe('2026-03-01T04:06:06.000Z');
    expect(reservationInsertParams(RESERVATION)[6]).toBe('2026-03-01T05:00:00.999Z');
    expect(ledgerInsertParams(LEDGER_ENTRY)[12]).toBe('2026-03-01T06:00:00.000Z');
  });

  it('没有租约时租约槽位是 null，而不是 epoch', () => {
    expect(taskInsertParams(TASK, '1', null)[13]).toBeNull();
    expect(taskInsertParams(TASK, '1', null)[11]).toBeNull();
    expect(taskInsertParams(TASK, '1', null)[12]).toBeNull();
    // nextRunAt 仍然在 $11 之前的位置被写出来，证明 null 只影响租约三列。
    expect(taskInsertParams(TASK, '1', null)[10]).toBe('2026-03-01T04:05:06.500Z');
  });
});

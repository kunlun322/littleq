/**
 * DTO 层测试：线上格式与领域规则的**双向**一致性，以及三处「结构上不存在」的否定式约束。
 *
 * 这里的每一条断言都在防同一类事故 —— 契约与 domain 各说各话，而两侧都是绿的：
 *
 * - 线上格式（`UUID_V7_WIRE_PATTERN` 等 14 条正则）在契约层重写了一份，不从 domain
 *   导入（理由在 `schemas/common.ts` 头注释里）。两份约束漂移的后果是静默的，所以用
 *   `test/probes.ts` 那份**提交进仓库的字面量探针**做第三方裁判：accepts 必须两侧都接受，
 *   rejects 必须两侧都拒绝。
 * - `ErrorEnvelope` 的字段集合、`SecretMetadata` 不含 `value`、`Task` 不含 provider 生命
 *   周期字段，这三条都是「少一个键」比「多一个键」更难发现的约束，因此写成显式断言。
 *
 * ## 为什么每条门禁都带一个会红的对照（PM §4 验收门 4）
 *
 * 「两侧一致」是一条零命中断言：它绿的时候什么都不打印。零命中断言最容易被写成空转 ——
 * 例如探针数组打错名字导致 `it.each` 一条都没生成，或者比较函数把两侧都当成 true。
 * 所以 `crossCheck` 被单独抽出来，并由两条**故意错配**的对照证明它确实会报告分歧：
 * 一条把 uuid schema 配给 revision 谓词（模拟两侧实现漂移），一条把合法值写进 rejects
 * （模拟探针本身写错）。两条都必须产生非空的失配清单，否则本文件其余的绿全部无效。
 *
 * ## 平台无关性（PM G6）
 *
 * 期望值全部是 `test/probes.ts` 里的字面量或由字面量确定性派生（`'a'.repeat(80)`）。
 * 不读时钟、不读环境变量、不做 IO、不扫 `node_modules`、不读 git，也不用 `Intl`。
 */
import { ERROR_ENVELOPE_FIELDS, isRevision, type ErrorEnvelopeField } from '@littleq/domain';
import { describe, expect, it } from 'vitest';

import {
  errorEnvelopeSchema,
  revisionSchema,
  secretMetadataSchema,
  taskSchema,
  timestampSchema,
  uuidV7Schema,
} from '../src/index.js';
import {
  TIMESTAMP_KNOWN_DIVERGENCE,
  TIMESTAMP_PAIR,
  WIRE_PROBES,
  type WireProbe,
} from './probes.js';

/** `crossCheck` 的四类失配。全部为空才算两侧一致。 */
interface CrossCheckResult {
  /** 探针说「接受」，但契约 schema 拒绝了 —— 契约窄于探针。 */
  readonly schemaRejectedAccepted: readonly string[];
  /** 探针说「接受」，但 domain 谓词拒绝了 —— domain 窄于探针。 */
  readonly predicateRejectedAccepted: readonly string[];
  /** 探针说「拒绝」，但契约 schema 接受了 —— 契约宽于探针。 */
  readonly schemaAcceptedRejected: readonly string[];
  /** 探针说「拒绝」，但 domain 谓词接受了 —— domain 宽于探针。 */
  readonly predicateAcceptedRejected: readonly string[];
}

const EMPTY_RESULT: CrossCheckResult = {
  schemaRejectedAccepted: [],
  predicateRejectedAccepted: [],
  schemaAcceptedRejected: [],
  predicateAcceptedRejected: [],
};

/**
 * 对一条探针做双向交叉校验。返回失配清单而不是直接 `expect`，是为了让对照用例能
 * 复用同一个函数 —— 对照要证明的正是「这个函数在分歧存在时确实报告分歧」。
 */
function crossCheck(probe: WireProbe): CrossCheckResult {
  const schemaRejectedAccepted: string[] = [];
  const predicateRejectedAccepted: string[] = [];
  const schemaAcceptedRejected: string[] = [];
  const predicateAcceptedRejected: string[] = [];

  for (const value of probe.accepts) {
    if (!probe.schema.safeParse(value).success) schemaRejectedAccepted.push(value);
    if (!probe.predicate(value)) predicateRejectedAccepted.push(value);
  }
  for (const value of probe.rejects) {
    if (probe.schema.safeParse(value).success) schemaAcceptedRejected.push(value);
    if (probe.predicate(value)) predicateAcceptedRejected.push(value);
  }
  return {
    schemaRejectedAccepted,
    predicateRejectedAccepted,
    schemaAcceptedRejected,
    predicateAcceptedRejected,
  };
}

/** 一条**故意错配**的探针：uuid 的 schema 配 revision 的谓词。 */
const MISMATCHED_PAIR_PROBE: WireProbe = {
  name: '对照·错配的一对',
  spec: '仅用于证明 crossCheck 会报告分歧',
  schema: uuidV7Schema,
  predicate: isRevision,
  // uuid：schema 接受、谓词拒绝。`0`：schema 拒绝、谓词接受。
  accepts: ['0190f1a2-3b4c-7d5e-8f60-123456789abc', '0'],
  // `42`：schema 接受、谓词接受，却被写进了 rejects。
  rejects: ['42'],
};

/** 一条**探针自身写错**的记录：把合法值列进了 rejects。 */
const BAD_LITERAL_PROBE: WireProbe = {
  name: '对照·写错的探针',
  spec: '仅用于证明 crossCheck 会报告「契约宽于探针」',
  schema: revisionSchema,
  predicate: isRevision,
  accepts: ['7'],
  rejects: ['42'],
};

describe('crossCheck 本身不是空转（正向对照）', () => {
  it('错配的 schema/谓词对：三类失配全部被点名', () => {
    const result = crossCheck(MISMATCHED_PAIR_PROBE);
    expect(result.schemaRejectedAccepted).toEqual(['0']);
    expect(result.predicateRejectedAccepted).toEqual(['0190f1a2-3b4c-7d5e-8f60-123456789abc']);
    expect(result.predicateAcceptedRejected).toEqual(['42']);
    // 这一类在本对照里恰好为空：`42` 被 schema 接受已归入 predicateAcceptedRejected。
    expect(result.schemaAcceptedRejected).toEqual([]);
  });

  it('把合法值写进 rejects：schemaAcceptedRejected 被点名', () => {
    const result = crossCheck(BAD_LITERAL_PROBE);
    expect(result.schemaAcceptedRejected).toEqual(['42']);
    expect(result.predicateAcceptedRejected).toEqual(['42']);
    expect(result.schemaRejectedAccepted).toEqual([]);
    expect(result.predicateRejectedAccepted).toEqual([]);
  });

  it('四条真实探针都通过时结果是逐字段空数组（形状没有被写歪）', () => {
    expect(crossCheck(TIMESTAMP_PAIR)).toEqual(EMPTY_RESULT);
  });
});

describe('线上格式与 domain 谓词双向一致（探针集）', () => {
  it('探针集非空，且每条都同时有 accepts 与 rejects', () => {
    expect(WIRE_PROBES.length).toBeGreaterThan(0);
    for (const probe of WIRE_PROBES) {
      expect(probe.accepts.length, `${probe.name} 没有 accepts`).toBeGreaterThan(0);
      expect(probe.rejects.length, `${probe.name} 没有 rejects`).toBeGreaterThan(0);
      // 同一个值同时出现在两侧，说明探针写错了；这种错误会让两个方向互相抵消。
      const overlap = probe.accepts.filter((value) => probe.rejects.includes(value));
      expect(overlap, `${probe.name} 的 accepts/rejects 有重叠`).toEqual([]);
    }
  });

  it.each(WIRE_PROBES.map((probe) => [probe.name, probe] as const))(
    '%s：契约 schema 与 domain 谓词在探针集上结论一致',
    (_name, probe) => {
      expect(crossCheck(probe), probe.spec).toEqual(EMPTY_RESULT);
    },
  );

  it('Timestamp 在语法与日历同时成立/不成立时两侧也一致', () => {
    expect(crossCheck(TIMESTAMP_PAIR), TIMESTAMP_PAIR.spec).toEqual(EMPTY_RESULT);
  });
});

describe('Timestamp 的唯一一处故意分歧被钉住方向', () => {
  // wire 只做语法检查，日历有效性由 domain 判定并映射 REQUEST_INVALID（§5.5）。
  // 方向必须固定：wire 宽于 domain 是**有意**的；反过来（wire 窄于 domain）才是漂移。
  it.each(TIMESTAMP_KNOWN_DIVERGENCE.map((value) => [value]))(
    '%s：契约接受、domain 拒绝',
    (value) => {
      expect(timestampSchema.safeParse(value).success, 'wire pattern 不应做日历校验').toBe(true);
      expect(TIMESTAMP_PAIR.predicate(value), 'domain 必须判这个时刻非法').toBe(false);
    },
  );

  it('分歧清单非空（空清单会让上面那条 it.each 一条都不生成）', () => {
    expect(TIMESTAMP_KNOWN_DIVERGENCE.length).toBeGreaterThan(0);
  });
});

describe('ErrorEnvelope 的字段集合与 domain 常量逐字一致', () => {
  it('键集合等于 ERROR_ENVELOPE_FIELDS（含顺序）', () => {
    expect(Object.keys(errorEnvelopeSchema.shape)).toEqual([...ERROR_ENVELOPE_FIELDS]);
  });

  it('domain 侧的常量本身没有被改成空表', () => {
    expect(ERROR_ENVELOPE_FIELDS.length).toBeGreaterThan(0);
    const fields: readonly ErrorEnvelopeField[] = ERROR_ENVELOPE_FIELDS;
    expect(fields).toContain('traceId');
  });
});

describe('结构上不存在的字段（否定式约束）', () => {
  it('secret-never-echoed：SecretMetadata 没有 value 键（§5.5：秘密值永不回显）', () => {
    expect(Object.keys(secretMetadataSchema.shape)).toEqual([
      'kind',
      'configured',
      'lastRotatedAt',
    ]);
    expect(Object.hasOwn(secretMetadataSchema.shape, 'value')).toBe(false);
  });

  it('Task 不含 lease / provider 生命周期 / 幂等实现字段', () => {
    const shape = taskSchema.shape;
    // 这份清单逐字来自 schemas/tasks.ts 的 KDoc；少一个键比多一个键难发现，所以逐条列。
    const forbidden = [
      'leaseOwner',
      'leaseUntil',
      'qcaSessionId',
      'qcaEventCursor',
      'externalOperationKey',
      'providerRequestId',
      'errorDigest',
      'requestedBy',
      'idempotencyKey',
      'requestHash',
      'repairCount',
    ];
    const present = forbidden.filter((name) => Object.hasOwn(shape, name));
    expect(present, 'Task 不得把内部状态搬到线上').toEqual([]);
  });

  it('对照：上面的检查在字段真的存在时会红', () => {
    // 同一个判定函数作用在一个**含**禁字段的形状上必须报告它，
    // 否则「present 为空」可能只是判定写歪了。
    const shapeWithLeak: Record<string, unknown> = {
      id: 'x',
      leaseOwner: 'y',
      repairCount: 0,
    };
    const forbidden = ['leaseOwner', 'qcaSessionId', 'repairCount'];
    expect(forbidden.filter((name) => Object.hasOwn(shapeWithLeak, name))).toEqual([
      'leaseOwner',
      'repairCount',
    ]);
  });
});

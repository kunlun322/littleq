import { describe, expect, it } from 'vitest';

import {
  canonicalOperationReceipt,
  createCollectionCursor,
  createTaskInputRef,
  createTaskPrivateRecord,
  formatJournalOperationKey,
  isInternalSubphase,
  OPERATION_INTENT_STATES,
  type OperationJournalEntry,
  type TaskInputRef,
} from '@littleq/application';
import { DomainError, parseTaskId, parseTimestamp } from '@littleq/domain';

/**
 * `task_private` 记录形态的验收测试（ZLQ-216 §3.2 / §5.3 / §5.4）。
 *
 * 本文件钉的是 F1 拥有的那一半：`packages/application` 里的**形状与纯函数**。
 * §10.2 的归属划分是「application 内部由 F1 拥有 ports、F2 拥有 use-cases」，
 * 所以这里刻意不含任何推进顺序的用例 —— 那些归 F2。
 *
 * 三条最有价值的断言：
 *
 * 1. `canonicalOperationReceipt` 不受键插入顺序影响。§5.3 要求「payload 不因重开 /
 *    当前时间 / 随机重新变动」，而它是 `recordReceipt`「同回执幂等、异回执拒绝」的
 *    **唯一**比较基准：基准不稳，幂等判定就不稳。
 * 2. `inputRef.objectRef` 拒收签名 URL 形状。§3.3 明令「不得 head/ETag 冒充摘要」，
 *    而 ref 一旦带着查询串落库，后面任何一层都无法再证明它是干净的。
 * 3. journal 不允许重复 `operationKey`。重复键意味着"同一个内部操作被记了两次意图"，
 *    而 §5.3 的禁令是「不换 key、不新建第二 Session」。
 */

const TASK_ID = '0198f2a4-6c7e-7a41-9c1b-2f6d0a4b8c11';

function journalEntry(overrides: Partial<OperationJournalEntry> = {}): OperationJournalEntry {
  return {
    operationKey: formatJournalOperationKey({
      taskId: TASK_ID,
      operation: 'createSession',
      attempt: 1,
      ordinal: 1,
    }),
    requestHash: 'a'.repeat(64),
    externalKey: `${TASK_ID}:AGENT_RUN:1`,
    providerSnapshot: {
      identityId: 'idn_1',
      templateId: 'tpl_1',
      environmentId: 'env_1',
      templateVersion: '3',
    },
    intent: 'INTENDED',
    receipt: null,
    recordedAt: parseTimestamp('2026-10-21T00:00:00.000000Z'),
    ...overrides,
  };
}

function inputRef(overrides: Partial<TaskInputRef> = {}): TaskInputRef {
  return createTaskInputRef({
    objectRef: 'littleq/task-input/0198f2a4-6c7e-7a41-9c1b-2f6d0a4b8c11.json',
    sha256: 'b'.repeat(64),
    byteLength: 128,
    ...overrides,
  });
}

function privateRecord(overrides: Partial<Parameters<typeof createTaskPrivateRecord>[0]> = {}) {
  return createTaskPrivateRecord({
    taskId: TASK_ID,
    inputRef: inputRef(),
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
}

describe('formatJournalOperationKey（§5.3：taskId＋内部操作名＋attempt＋ordinal）', () => {
  it('按四段派生，与 domain 的 OperationKey 形状不同', () => {
    const key = formatJournalOperationKey({
      taskId: TASK_ID,
      operation: 'createSession',
      attempt: 2,
      ordinal: 3,
    });
    expect(key).toBe(`${TASK_ID}:createSession:2:3`);
    // domain 的 `OperationKey` 是 `${taskId}:${TaskStage}:${attempt}` —— 恰好三段。
    // 四段是"同一 stage 内多个内部操作"能被分开的前提。
    expect(key.split(':')).toHaveLength(4);
  });

  it('ordinal 不同即键不同：同一 stage 内的两次外呼不会互相顶掉', () => {
    const first = formatJournalOperationKey({
      taskId: TASK_ID,
      operation: 'sendMessage',
      attempt: 1,
      ordinal: 1,
    });
    const second = formatJournalOperationKey({
      taskId: TASK_ID,
      operation: 'sendMessage',
      attempt: 1,
      ordinal: 2,
    });
    expect(first).not.toBe(second);
  });

  it('拒绝把分隔符塞进操作名（否则四段解析立刻歧义）', () => {
    expect(() =>
      formatJournalOperationKey({
        taskId: TASK_ID,
        operation: 'send:message',
        attempt: 1,
        ordinal: 1,
      }),
    ).toThrow(DomainError);
  });

  it('拒绝凭证赋值形状的操作名 —— 键会落库并进日志', () => {
    expect(() =>
      formatJournalOperationKey({
        taskId: TASK_ID,
        operation: 'token=abc',
        attempt: 1,
        ordinal: 1,
      }),
    ).toThrow(DomainError);
  });

  it('拒绝非正 ordinal 与越界 attempt', () => {
    for (const ordinal of [0, -1, 1.5]) {
      expect(() =>
        formatJournalOperationKey({ taskId: TASK_ID, operation: 'poll', attempt: 1, ordinal }),
      ).toThrow(DomainError);
    }
    expect(() =>
      formatJournalOperationKey({ taskId: TASK_ID, operation: 'poll', attempt: 0, ordinal: 1 }),
    ).toThrow(DomainError);
  });

  it('拒绝不是 UUIDv7 的 taskId', () => {
    expect(() =>
      formatJournalOperationKey({
        taskId: 'not-a-task-id',
        operation: 'poll',
        attempt: 1,
        ordinal: 1,
      }),
    ).toThrow(DomainError);
  });
});

describe('canonicalOperationReceipt（§3.5「同回执幂等、异回执拒绝」的比较基准）', () => {
  it('键插入顺序不改变规范序列化', () => {
    const a = canonicalOperationReceipt({ sessionId: 'sess_1', requestId: 'req_1' });
    const b = canonicalOperationReceipt({ requestId: 'req_1', sessionId: 'sess_1' });
    expect(a).toBe(b);
  });

  it('值不同即序列化不同', () => {
    expect(canonicalOperationReceipt({ sessionId: 'sess_1' })).not.toBe(
      canonicalOperationReceipt({ sessionId: 'sess_2' }),
    );
  });

  it('长度前缀框住键与值，拼接不能伪造出另一份回执', () => {
    // 没有长度前缀时，{a:'b=c'} 与 {a:'b', c:''} 之类的组合会拼出同一个串。
    const left = canonicalOperationReceipt({ 'x=y': 'z' });
    const right = canonicalOperationReceipt({ x: 'y=z' });
    expect(left).not.toBe(right);
  });

  it('空回执是良定义的（外呼失败也可能有回执）', () => {
    expect(canonicalOperationReceipt({})).toBe('');
  });
});

describe('createTaskInputRef（§3.4 步骤 2：固定 prompt/配置快照先写私有输入对象）', () => {
  it('接受逻辑键 + 64 位十六进制摘要 + 非负字节数', () => {
    const ref = inputRef();
    expect(ref.byteLength).toBe(128);
  });

  it('拒绝绝对 URL 形状的 objectRef —— ref 是逻辑键，不是 URL', () => {
    expect(() =>
      createTaskInputRef({
        objectRef: 'https://blob.example/x.json?sig=aaaa',
        sha256: 'b'.repeat(64),
        byteLength: 1,
      }),
    ).toThrow(DomainError);
  });

  it('拒绝带签名参数的相对形状', () => {
    expect(() =>
      createTaskInputRef({
        objectRef: 'littleq/x.json?x-goog-signature=aaaa',
        sha256: 'b'.repeat(64),
        byteLength: 1,
      }),
    ).toThrow(DomainError);
  });

  it('拒绝不是 SHA-256 十六进制的摘要（§3.3：Blob ETag 不是 SHA-256）', () => {
    expect(() =>
      createTaskInputRef({
        objectRef: 'littleq/x.json',
        sha256: '"9d94a4e0f1f6a9b0c1d2e3f4a5b6c7d8"',
        byteLength: 1,
      }),
    ).toThrow(DomainError);
  });

  it('拒绝负数与非安全整数的 byteLength', () => {
    for (const byteLength of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() =>
        createTaskInputRef({ objectRef: 'littleq/x.json', sha256: 'b'.repeat(64), byteLength }),
      ).toThrow(DomainError);
    }
  });
});

describe('createTaskPrivateRecord（§3.2 task_private 完整记录）', () => {
  it('nullable 列缺省为 null，与 §3.2 的列定义一致', () => {
    const record = privateRecord();
    expect(record.qcaSessionId).toBeNull();
    expect(record.qcaEventCursor).toBeNull();
    expect(record.roundBoundary).toBeNull();
    expect(record.scanCheckpoint).toBeNull();
    expect(record.scanFailure).toBeNull();
    expect(record.operationJournal).toEqual([]);
    expect(record.taskId).toBe(parseTaskId(TASK_ID));
  });

  it('拒绝重复的 journal operationKey（§5.3：不换 key、不新建第二 Session）', () => {
    const entry = journalEntry();
    expect(() => privateRecord({ operationJournal: [entry, { ...entry }] })).toThrow(DomainError);
  });

  it('接受同一操作的不同 ordinal —— 那是两个不同的内部操作', () => {
    const first = journalEntry();
    const second = journalEntry({
      operationKey: formatJournalOperationKey({
        taskId: TASK_ID,
        operation: 'createSession',
        attempt: 1,
        ordinal: 2,
      }),
    });
    expect(privateRecord({ operationJournal: [first, second] }).operationJournal).toHaveLength(2);
  });

  it('拒绝不是 RFC3339 UTC 的 recordedAt', () => {
    expect(() =>
      privateRecord({
        operationJournal: [journalEntry({ recordedAt: '2026-10-21T00:00:00+08:00' as never })],
      }),
    ).toThrow(DomainError);
  });

  it('拒绝空与超长的 internalSubphase（§5.2 只固定列，不枚举取值）', () => {
    expect(() => privateRecord({ internalSubphase: '' })).toThrow(DomainError);
    expect(() => privateRecord({ internalSubphase: 'x'.repeat(65) })).toThrow(DomainError);
    expect(isInternalSubphase('RECONCILING')).toBe(true);
  });

  it('记录里没有 prompt 全文的位置 —— 结构上不存在这个字段', () => {
    // ZLQ-153 §5：prompt 全文不得进入 domain、快照、日志与 fixture。
    // 这条断言把"结构上不存在"钉住：谁给记录加一个 prompt 字段，这里就红。
    expect(Object.keys(privateRecord()).sort()).toEqual([
      'collectionCursor',
      'inputRef',
      'inputSnapshot',
      'internalSubphase',
      'operationJournal',
      'qcaEventCursor',
      'qcaSessionId',
      'roundBoundary',
      'scanCheckpoint',
      'scanFailure',
      'taskId',
    ]);
  });
});

describe('createCollectionCursor（§3.4 步骤 4：一个短步最多处理一个文件）', () => {
  it('缺省没有已固化项', () => {
    expect(createCollectionCursor({ artifactSha256: 'c'.repeat(64) }).sealedPaths).toEqual([]);
  });

  it('返回的是副本，改入参不会改到游标', () => {
    const paths = ['index.html'];
    const cursor = createCollectionCursor({ artifactSha256: 'c'.repeat(64), sealedPaths: paths });
    paths.push('work.json');
    expect(cursor.sealedPaths).toEqual(['index.html']);
  });

  it('拒绝不是 SHA-256 的 artifactSha256', () => {
    expect(() => createCollectionCursor({ artifactSha256: 'nope' })).toThrow(DomainError);
  });
});

describe('OPERATION_INTENT_STATES（§5.3 的三段顺序）', () => {
  it('三态且顺序即"意图 → 已发出 → 回执已落库"', () => {
    expect([...OPERATION_INTENT_STATES]).toEqual(['INTENDED', 'SENT', 'RECEIPT_RECORDED']);
  });

  it('SENT 与 RECEIPT_RECORDED 分开存在 —— 合并就无法执行"未确认结果时只读对账"', () => {
    expect(OPERATION_INTENT_STATES).toContain('SENT');
    expect(OPERATION_INTENT_STATES).toContain('RECEIPT_RECORDED');
    expect(OPERATION_INTENT_STATES.indexOf('SENT')).toBeLessThan(
      OPERATION_INTENT_STATES.indexOf('RECEIPT_RECORDED'),
    );
  });
});

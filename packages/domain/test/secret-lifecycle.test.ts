import { describe, expect, it } from 'vitest';

import {
  SECRET_KINDS,
  SECRET_REF_MAX_LENGTH,
  SECRET_SOURCES,
  applySecretPut,
  assertSecretWritable,
  createSecretRecord,
  nextSecretGeneration,
  parseSecretGeneration,
  revokeSecretRecord,
  rotateSecretRecord,
  unconfiguredSecretRecord,
  type SecretRecord,
  type SecretSource,
} from '../src/index.js';
import { EPOCH, atSeconds, thrownCode } from './support.js';

/**
 * 密钥的领域侧生命周期：写入 → 轮换 → 撤销 → 重新写入。
 *
 * 对应契约面上的三个接口（`PUT /settings/secrets/{kind}`、`:rotate`、`:revoke`）。
 * 这一组测试要钉住的是四条会直接影响用户裁决的事实：
 *
 * 1. **旧值在轮换后立即失效**：`currentRef` 被替换、`generation` 前进，旧句柄在新记录里
 *    一个字节都不剩 —— domain 不持有密文，所以「让它从记录上消失」是它能做也唯一需要做的。
 * 2. **撤销不清空历史**：`configured` 变 false、`currentRef` 变 null，但 `lastRotatedAt`
 *    与 `generation` 保留。抹掉它们会让一次撤销顺带销毁一条审计事实。
 * 3. **`lastRotatedAt` 与 `generation` 永远同步**：`(generation === 0) === (lastRotatedAt === null)`
 *    由 `createSecretRecord` 强制，首次写入即算一次轮换。
 * 4. **部署期密钥写不动**：三个写操作共用 `assertSecretWritable`，一律
 *    `SECRET_IMMUTABLE_REDEPLOY_REQUIRED` —— 这条断言就是那个冻结错误码在新语义下
 *    仍然逐字准确的证据（见 `value-objects/refs.ts` 里 `SECRET_SOURCES` 的文件级说明）。
 */

/** 形状合法的不透明句柄：无冒号斜杠、无点分长段、无 `key=value`，因此不会被误判成敏感文本。 */
function secretRefAt(index: number): string {
  return `kv-littleq-secret-${index}`;
}

const RECORD_KEYS = [
  'kind',
  'source',
  'configured',
  'currentRef',
  'generation',
  'lastRotatedAt',
  'revokedAt',
];

/** 与 `api-contract` 的 `LEAKY_FIELD_NAMES` 同一意图，此处独立字面量：不跨单元 import。 */
const LEAKY_KEY_PATTERN = /(value|plaintext|secret$|credential|apikey)|token$|signature/i;

function put(index: number, previous: SecretRecord | null = null, atSecond = 0): SecretRecord {
  return applySecretPut(previous, {
    kind: 'QCA_PAT',
    secretRef: secretRefAt(index),
    now: atSecond === 0 ? EPOCH : atSeconds(atSecond),
  });
}

function deploymentRecord(): SecretRecord {
  return createSecretRecord({
    kind: 'QCA_PAT',
    source: 'DEPLOYMENT',
    configured: true,
    currentRef: secretRefAt(900),
    generation: 1,
    lastRotatedAt: EPOCH,
  });
}

describe('secret-rotate-revoke：写入与轮换', () => {
  it('secret-rotate-revoke：首次写入即算一次轮换 —— generation 为 1 且 lastRotatedAt 落地', () => {
    const record = put(1);
    expect(record.configured).toBe(true);
    expect(record.generation).toBe(1);
    expect(record.lastRotatedAt).toBe(EPOCH);
    expect(record.revokedAt).toBeNull();
    expect(record.source).toBe('USER');
  });

  it('secret-rotate-revoke：轮换推进 generation 与 lastRotatedAt，旧句柄在新记录里一个字节都不剩', () => {
    const first = put(1);
    const second = rotateSecretRecord(first, { secretRef: secretRefAt(2), now: atSeconds(3600) });
    expect(second.generation).toBe(2);
    expect(second.lastRotatedAt).toBe(atSeconds(3600));
    expect(second.currentRef).toBe(secretRefAt(2));
    // 「旧值立即失效」在 domain 侧可判定的形态：旧句柄不再出现在记录的任何字段里。
    expect(JSON.stringify(second)).not.toContain(secretRefAt(1));
    expect(second.kind).toBe(first.kind);
    expect(second.source).toBe(first.source);
  });

  it('secret-rotate-revoke：轮换一个从未配置过的种类是 REQUEST_INVALID，不静默当成首次写入', () => {
    // 悄悄当成首次写入会让 UI 上的「轮换」按钮在空状态下也能点，而它本不该出现。
    expect(
      thrownCode(() => rotateSecretRecord(null, { secretRef: secretRefAt(1), now: EPOCH })),
    ).toBe('REQUEST_INVALID');
    expect(
      thrownCode(() =>
        rotateSecretRecord(unconfiguredSecretRecord('QCA_PAT', 'USER'), {
          secretRef: secretRefAt(1),
          now: EPOCH,
        }),
      ),
    ).toBe('REQUEST_INVALID');
  });

  it('secret-rotate-revoke：PUT 没有这个前置条件 —— 它是幂等的「就让这个值成为当前值」', () => {
    // `:rotate` 与 PUT 的载荷几乎一样，差别全在这条前置条件上；少了这条对照，
    // 「轮换要求已配置」看起来像是可以随手加在 PUT 上的多余限制。
    expect(put(1).generation).toBe(1);
    expect(put(2, put(1)).generation).toBe(2);
  });

  it('secret-rotate-revoke：连续轮换三次，generation 单调递增且 lastRotatedAt 每次都前进', () => {
    let record = put(1);
    const seen: string[] = [String(record.lastRotatedAt)];
    for (const index of [2, 3, 4]) {
      record = rotateSecretRecord(record, {
        secretRef: secretRefAt(index),
        now: atSeconds(index * 3600),
      });
      expect(record.generation).toBe(index);
      expect(record.lastRotatedAt).toBe(atSeconds(index * 3600));
      seen.push(String(record.lastRotatedAt));
    }
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(4);
  });
});

describe('secret-rotate-revoke：撤销', () => {
  it('secret-rotate-revoke：撤销把 configured 置 false、丢弃句柄，但保留 lastRotatedAt 与 generation', () => {
    const configured = rotateSecretRecord(put(1), {
      secretRef: secretRefAt(2),
      now: atSeconds(60),
    });
    const revoked = revokeSecretRecord(configured, { kind: 'QCA_PAT', now: atSeconds(600) });
    expect(revoked.configured).toBe(false);
    expect(revoked.currentRef).toBeNull();
    expect(revoked.revokedAt).toBe(atSeconds(600));
    // 撤销不抹掉历史：GET 仍然能回答「这个凭证最后一次是什么时候换的」。
    expect(revoked.lastRotatedAt).toBe(atSeconds(60));
    expect(revoked.generation).toBe(2);
    expect(JSON.stringify(revoked)).not.toContain(secretRefAt(1));
    expect(JSON.stringify(revoked)).not.toContain(secretRefAt(2));
  });

  it('secret-rotate-revoke：撤销是幂等的 —— 对未配置或已撤销的记录再撤销一次原样返回', () => {
    // 报 409 会让重试逻辑必须区分「我撤过了」与「撤销失败」，而这两者对调用方是同一件事。
    const never = unconfiguredSecretRecord('BAILIAN_API_KEY', 'USER');
    expect(revokeSecretRecord(never, { kind: 'BAILIAN_API_KEY', now: EPOCH })).toBe(never);
    expect(revokeSecretRecord(null, { kind: 'BAILIAN_API_KEY', now: EPOCH })).toEqual(never);

    const revoked = revokeSecretRecord(put(1), { kind: 'QCA_PAT', now: atSeconds(600) });
    const again = revokeSecretRecord(revoked, { kind: 'QCA_PAT', now: atSeconds(1200) });
    expect(again).toBe(revoked);
    // 第二次撤销不得把 revokedAt 推到更晚：撤销时刻是「它什么时候失效的」，不是「最后一次点击」。
    expect(again.revokedAt).toBe(atSeconds(600));
  });

  it('secret-rotate-revoke：撤销后重新 PUT 会复活配置、清空 revokedAt，且 generation 不归零', () => {
    const revoked = revokeSecretRecord(put(1), { kind: 'QCA_PAT', now: atSeconds(600) });
    const revived = put(5, revoked, 1200);
    expect(revived.configured).toBe(true);
    expect(revived.revokedAt).toBeNull();
    // 归零会让「撤销后重新填入」与「从未配置过」在数据上无法区分。
    expect(revived.generation).toBe(2);
    expect(revived.lastRotatedAt).toBe(atSeconds(1200));
  });

  it('secret-rotate-revoke：撤销之后不能轮换 —— 没有当前值可换，报 REQUEST_INVALID', () => {
    const revoked = revokeSecretRecord(put(1), { kind: 'QCA_PAT', now: atSeconds(600) });
    expect(
      thrownCode(() => rotateSecretRecord(revoked, { secretRef: secretRefAt(2), now: EPOCH })),
    ).toBe('REQUEST_INVALID');
  });
});

describe('secret-rotate-revoke：部署期密钥不可经 API 变更', () => {
  it('secret-rotate-revoke：PUT / rotate / revoke 三条路径对 DEPLOYMENT 一律 SECRET_IMMUTABLE_REDEPLOY_REQUIRED', () => {
    const deployment = deploymentRecord();
    const expected = 'SECRET_IMMUTABLE_REDEPLOY_REQUIRED';
    expect(
      thrownCode(() =>
        applySecretPut(deployment, { kind: 'QCA_PAT', secretRef: secretRefAt(1), now: EPOCH }),
      ),
    ).toBe(expected);
    expect(
      thrownCode(() => rotateSecretRecord(deployment, { secretRef: secretRefAt(1), now: EPOCH })),
    ).toBe(expected);
    expect(thrownCode(() => revokeSecretRecord(deployment, { kind: 'QCA_PAT', now: EPOCH }))).toBe(
      expected,
    );
  });

  it('secret-rotate-revoke：拒绝发生在任何写入之前 —— 抛错的那一次不产生新记录', () => {
    // 这一条是「三个写接口共用一处断言」的可观察后果：先判来源，再动状态。
    const deployment = deploymentRecord();
    expect(() => revokeSecretRecord(deployment, { kind: 'QCA_PAT', now: EPOCH })).toThrow();
    expect(deployment.configured).toBe(true);
    expect(deployment.currentRef).toBe(secretRefAt(900));
    expect(deployment.revokedAt).toBeNull();
  });

  it('secret-rotate-revoke：assertSecretWritable 只对 USER 放行，来源是二值闭集', () => {
    expect(SECRET_SOURCES).toEqual(['DEPLOYMENT', 'USER']);
    expect(() => assertSecretWritable('USER')).not.toThrow();
    expect(thrownCode(() => assertSecretWritable('DEPLOYMENT'))).toBe(
      'SECRET_IMMUTABLE_REDEPLOY_REQUIRED',
    );
    const sources: SecretSource[] = [...SECRET_SOURCES];
    expect(sources).toHaveLength(2);
  });
});

describe('secret-rotate-revoke：记录里不存在明文', () => {
  it('secret-rotate-revoke：记录的键集合是 7 个字面量，没有一个像令牌或明文', () => {
    // write-only 的结构性证据：不是「文档里没写 value」，而是记录里根本没有这个键。
    const record = rotateSecretRecord(put(1), { secretRef: secretRefAt(2), now: atSeconds(60) });
    expect(Object.keys(record).sort()).toEqual([...RECORD_KEYS].sort());
    for (const key of Object.keys(record)) {
      expect(LEAKY_KEY_PATTERN.test(key), key).toBe(false);
    }
    const revoked = revokeSecretRecord(record, { kind: 'QCA_PAT', now: atSeconds(600) });
    expect(Object.keys(revoked).sort()).toEqual([...RECORD_KEYS].sort());
  });

  it('secret-rotate-revoke：句柄是不透明引用，受长度上限约束且不能是敏感文本', () => {
    expect(SECRET_REF_MAX_LENGTH).toBe(256);
    expect(
      thrownCode(() =>
        applySecretPut(null, {
          kind: 'QCA_PAT',
          secretRef: 'x'.repeat(SECRET_REF_MAX_LENGTH + 1),
          now: EPOCH,
        }),
      ),
    ).toBe('REQUEST_INVALID');
    // 句柄本身若长得像凭据（`key=value`、绝对 URL、JWT），也会被拒 —— 这是 §7.5 的
    // 脱敏要求落在不透明引用上的形态。
    expect(
      thrownCode(() =>
        applySecretPut(null, { kind: 'QCA_PAT', secretRef: 'token=abc123', now: EPOCH }),
      ),
    ).toBe('REQUEST_INVALID');
  });

  it('secret-rotate-revoke：未知种类是 SECRET_KIND_UNSUPPORTED，而不是 REQUEST_INVALID', () => {
    // 种类不存在时的正确响应是 400 + 这个专属码：运维要能看出「该去配置凭证」，
    // 退化成 REQUEST_INVALID 会把这条线索抹掉。
    expect(
      thrownCode(() =>
        createSecretRecord({
          kind: 'OPENAI_KEY',
          source: 'USER',
          configured: false,
          currentRef: null,
          generation: 0,
          lastRotatedAt: null,
        }),
      ),
    ).toBe('SECRET_KIND_UNSUPPORTED');
    expect(SECRET_KINDS).toEqual(['QCA_PAT', 'BAILIAN_API_KEY']);
  });
});

describe('secret-rotate-revoke：构造期不变量', () => {
  it('secret-rotate-revoke：configured 与 currentRef 必须同时存在或同时不存在', () => {
    expect(
      thrownCode(() =>
        createSecretRecord({
          kind: 'QCA_PAT',
          source: 'USER',
          configured: true,
          currentRef: null,
          generation: 1,
          lastRotatedAt: EPOCH,
        }),
      ),
    ).toBe('REQUEST_INVALID');
    expect(
      thrownCode(() =>
        createSecretRecord({
          kind: 'QCA_PAT',
          source: 'USER',
          configured: false,
          currentRef: secretRefAt(1),
          generation: 1,
          lastRotatedAt: EPOCH,
        }),
      ),
    ).toBe('REQUEST_INVALID');
  });

  it('secret-rotate-revoke：generation 为 0 当且仅当 lastRotatedAt 为 null', () => {
    expect(
      thrownCode(() =>
        createSecretRecord({
          kind: 'QCA_PAT',
          source: 'USER',
          configured: true,
          currentRef: secretRefAt(1),
          generation: 1,
          lastRotatedAt: null,
        }),
      ),
    ).toBe('REQUEST_INVALID');
    expect(
      thrownCode(() =>
        createSecretRecord({
          kind: 'QCA_PAT',
          source: 'USER',
          configured: false,
          currentRef: null,
          generation: 0,
          lastRotatedAt: EPOCH,
        }),
      ),
    ).toBe('REQUEST_INVALID');
    const never = unconfiguredSecretRecord('QCA_PAT', 'USER');
    expect(never.generation).toBe(0);
    expect(never.lastRotatedAt).toBeNull();
    expect(never.revokedAt).toBeNull();
  });

  it('secret-rotate-revoke：撤销时刻只在「当前不可用」期间有意义', () => {
    expect(
      thrownCode(() =>
        createSecretRecord({
          kind: 'QCA_PAT',
          source: 'USER',
          configured: true,
          currentRef: secretRefAt(1),
          generation: 1,
          lastRotatedAt: EPOCH,
          revokedAt: atSeconds(60),
        }),
      ),
    ).toBe('REQUEST_INVALID');
  });

  it('secret-rotate-revoke：generation 有上限，越界抛 REQUEST_INVALID 而不是回绕成 0', () => {
    expect(nextSecretGeneration(parseSecretGeneration(0))).toBe(1);
    expect(thrownCode(() => nextSecretGeneration(parseSecretGeneration(1_000_000)))).toBe(
      'REQUEST_INVALID',
    );
    expect(thrownCode(() => parseSecretGeneration(-1))).toBe('REQUEST_INVALID');
  });
});

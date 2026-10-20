/**
 * 能力 `sensitive-url-log-redaction`：ZLQ-194 §14 第 6 项「原始签名 URL 不落日志」。
 *
 * ## 断言挂在**真实写入路径**上
 * 下面大部分用例不是调一个旁路的 `redactText()` 然后比对返回值 —— 那证明不了任何事，因为
 * 生产代码可能压根不调它。这里把一个 spy sink 交给真实的 `ObjectReadGrantService`，跑完
 * `issue → open → close → revoke → 各种拒绝`，再对 sink 收到的**全部**记录做一次整体字符串
 * 断言：裸 token 不在其中，任何 URL 都只剩 `scheme://host/[redacted]`。
 *
 * ## 反空洞对照
 * 「日志里没有 token」这句话在一个**什么都不写**的 logger 上也是真的。所以每个「没有 X」的
 * 断言都配一条「确实有 Y」：`grantId`、`audience`、`objectRef`、`artifactHash`、`maxBytes`、
 * `authFingerprint` 必须以**原值**出现在 sink 收到的记录里。字段名 `authFingerprint` 而不是
 * `tokenFingerprint` 也是被这条对照钉住的 —— 后者含 `token`，会被 deny-list 整值吃掉，
 * 于是「日志里能关联同一次签发」这个能力会静默消失。
 */
import { describe, expect, it } from 'vitest';

import {
  DENY_LISTED_FIELD_NAME_PARTS,
  LOG_LEVELS,
  REDACTED,
  createRedactingLogger,
  fingerprint,
  redactRecord,
  redactText,
  redactUrlText,
} from '../src/log/redaction.js';
import { InMemoryGrantRecordStore } from '../src/grant/memory-records.js';
import {
  GRANT_TOKEN_QUERY_PARAMETER,
  ObjectReadGrantService,
} from '../src/grant/object-read-grant.js';
import { InMemoryObjectStore } from '../src/object-store/memory.js';
import { idleAbortSignal, streamFromBytes } from '../src/object-store/budget.js';
import { RUNTIME_PREVIEW_AUDIENCE } from '../src/ports/runtime-publisher.js';
import { SensitiveUrl, markSensitiveUrl, parseObjectRef } from '../src/types.js';

import { SpySink, at, bytes, sha256Of } from './support.js';

const URL_CONFIG = { origin: 'https://littleq.test', basePath: '/internal/object-read' };
const KEY = 'artifacts/dd/redaction-probe';
/** 匹配任何「还带着 path / query / fragment」的绝对 URL。 */
const UNREDACTED_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]*\/(?!\[redacted\])/;

function harness() {
  const sink = new SpySink();
  const store = new InMemoryObjectStore({ now: () => new Date(0) });
  const records = new InMemoryGrantRecordStore();
  const service = new ObjectReadGrantService({
    store,
    records,
    url: URL_CONFIG,
    now: () => at(0),
    sink,
  });
  return { sink, store, records, service };
}

async function seed(store: InMemoryObjectStore, payload: Uint8Array) {
  await store.putImmutable({
    key: KEY,
    body: streamFromBytes(payload),
    declaredBytes: payload.byteLength,
    maxBytes: payload.byteLength,
    sha256: sha256Of(payload),
    contentType: 'application/octet-stream',
    abortSignal: idleAbortSignal(),
  });
  return { ref: parseObjectRef(KEY), digest: sha256Of(payload) };
}

function tokenOf(url: SensitiveUrl): string {
  const token = new URL(url.reveal()).searchParams.get(GRANT_TOKEN_QUERY_PARAMETER);
  if (token === null) throw new Error('grant URL 里没有 token');
  return token;
}

describe('sensitive-url-log-redaction', () => {
  it('deny-list 与日志级别取值域被逐字点名', () => {
    expect([...DENY_LISTED_FIELD_NAME_PARTS]).toEqual([
      'authorization',
      'bloburl',
      'ciphertext',
      'cookie',
      'downloadurl',
      'granturl',
      'masterkey',
      'nonce',
      'oidctoken',
      'password',
      'plaintext',
      'presign',
      'secret',
      'signature',
      'tag',
      'token',
      'url',
    ]);
    expect([...LOG_LEVELS]).toEqual(['debug', 'info', 'warn', 'error']);
    expect(REDACTED).toBe('[redacted]');
  });

  it('真实服务跑完签发/打开/归还/撤销/拒绝，sink 里没有裸 token 也没有未脱敏 URL', async () => {
    const { sink, store, service } = harness();
    const payload = bytes(128, 17);
    const { ref, digest } = await seed(store, payload);

    const issued = await service.issue({
      objectRef: ref,
      artifactHash: digest,
      maxBytes: 1024,
      now: at(0),
    });
    const token = tokenOf(issued.url);
    const lease = await service.open({
      token,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      now: at(0),
    });
    await service.close(lease);
    // 四条拒绝路径各写一条 warn：过期、未知 token、audience 不符、并发超限。
    await service
      .open({ token: 'not-a-token', audience: RUNTIME_PREVIEW_AUDIENCE, now: at(0) })
      .catch(() => undefined);
    await service.open({ token, audience: 'someone-else', now: at(0) }).catch(() => undefined);
    for (let i = 0; i < 8; i += 1) {
      await service.open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(0) });
    }
    await service
      .open({ token, audience: RUNTIME_PREVIEW_AUDIENCE, now: at(0) })
      .catch(() => undefined);
    expect(await service.revoke(issued.grantId, at(1))).toBe(8);

    expect(sink.count).toBeGreaterThan(10);
    const serialized = sink.serialized();
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(issued.url.reveal());
    expect(serialized).not.toContain('/internal/object-read');
    expect(serialized).not.toMatch(UNREDACTED_URL);

    // **反空洞对照**：允许进日志的那些值必须以原值出现，否则上面的「不含」全是空断言。
    expect(serialized).toContain(issued.grantId);
    expect(serialized).toContain(RUNTIME_PREVIEW_AUDIENCE);
    expect(serialized).toContain(KEY);
    expect(serialized).toContain(String(digest));
    expect(serialized).toContain('object-read-grant.issued');
    expect(serialized).toContain('object-read-grant.opened');
    expect(serialized).toContain('object-read-grant.closed');
    expect(serialized).toContain('object-read-grant.revoked');
    expect(serialized).toContain('object-read-grant.denied');
    const issuedRecord = sink.records.find((r) => r.message === 'object-read-grant.issued');
    expect(issuedRecord?.fields['maxBytes']).toBe(1024);
    expect(issuedRecord?.fields['maxConcurrentReads']).toBe(8);
    // 指纹可关联、不可逆：12 位十六进制，且不等于 token 本身。
    expect(issuedRecord?.fields['authFingerprint']).toBe(fingerprint(token));
    expect(String(issuedRecord?.fields['authFingerprint'])).toMatch(/^[0-9a-f]{12}$/);
    // 拒绝记录带上内部原因码，但**不带**任何可区分「过期 / 不存在」的对外细节之外的东西。
    const denied = sink.records.filter((r) => r.message === 'object-read-grant.denied');
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied.map((r) => r.fields['reason'])).toContain('OBJECT_READ_GRANT_UNKNOWN');
    expect(denied.map((r) => r.fields['reason'])).toContain('GRANT_AUDIENCE_MISMATCH');
    expect(denied.map((r) => r.fields['reason'])).toContain('OBJECT_READ_CONCURRENCY_LIMIT');
  });

  it('就算调用方硬把 token / 签名 URL 塞进字段，落盘的也是脱敏形状', () => {
    const sink = new SpySink();
    const logger = createRedactingLogger(sink);
    const raw = 'https://blob.store/x/y?token=abc123&X-Amz-Signature=deadbeef';
    logger.info('probe', {
      grantUrl: raw,
      downloadUrl: raw,
      presignedUrl: raw,
      blobUrl: raw,
      token: 'abc123',
      accessToken: 'abc123',
      authorization: 'Bearer abc123',
      cookie: 'session=abc123',
      masterKey: 'abc123',
      plaintext: 'abc123',
      ciphertext: 'abc123',
      nonce: 'abc123',
      tag: 'abc123',
      password: 'abc123',
      secret: 'abc123',
      signature: 'abc123',
      oidcToken: 'abc123',
      nested: { deep: { authorization: 'Bearer abc123' } },
      list: [raw, { downloadUrl: raw }],
      // 允许进日志的：内部 id、状态码、字节数、耗时。
      grantId: 'grant_01',
      reason: 'OBJECT_READ_GRANT_EXPIRED',
      bytes: 2048,
      latencyMs: 12,
    });
    logger.error(`provider said ${raw} and failed`, { status: 500 });

    const serialized = sink.serialized();
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toMatch(UNREDACTED_URL);
    // **反空洞对照**：deny-list 没有把所有字段一起吃掉。
    expect(serialized).toContain('grant_01');
    expect(serialized).toContain('OBJECT_READ_GRANT_EXPIRED');
    expect(serialized).toContain('2048');
    const record = sink.records[0];
    expect(record?.fields['grantId']).toBe('grant_01');
    expect(record?.fields['bytes']).toBe(2048);
    expect(record?.fields['grantUrl']).toBe(REDACTED);
    expect(record?.fields['nested']).toEqual({ deep: { authorization: REDACTED } });
    // message 里的 URL 也被脱敏，同时保留可读的上下文。
    const errorRecord = sink.records[1];
    expect(errorRecord?.message).toContain('provider said');
    expect(errorRecord?.message).toContain('https://blob.store/[redacted]');
    expect(errorRecord?.message).not.toContain('abc123');
  });

  it('redactUrlText 丢掉 path/query/fragment/userinfo，只留 scheme + host', () => {
    expect(redactUrlText('https://x.test/a/b?sig=1#f')).toBe(`https://x.test/${REDACTED}`);
    expect(redactUrlText('https://user:pw@x.test/a')).toBe(`https://x.test/${REDACTED}`);
    expect(redactUrlText('https://x.test')).toBe(`https://x.test/${REDACTED}`);
    expect(redactUrlText('https://x.test/')).toBe(`https://x.test/${REDACTED}`);
    // 没有 `://` 的东西（裸 token、相对路径）不配被当成 URL 保留任何部分。
    expect(redactUrlText('abc123')).toBe(REDACTED);
    expect(redactUrlText('/internal/object-read?grant=abc')).toBe(REDACTED);
    expect(redactUrlText('')).toBe(REDACTED);
    // 正向对照：不是所有输入都变成同一个常量。
    expect(redactUrlText('https://a.test/x')).not.toBe(redactUrlText('https://b.test/x'));
    expect(redactText('no url here')).toBe('no url here');
    expect(redactText('see https://a.test/x?sig=1 ok')).toBe(`see https://a.test/${REDACTED} ok`);
  });

  it('SensitiveUrl 的原文只在私有字段里：toString/toJSON/展开/结构化克隆都拿不到', () => {
    const raw = 'https://littleq.test/internal/object-read?grant=super-secret-token';
    const url = markSensitiveUrl(raw);
    expect(url.toString()).toBe(`https://littleq.test/${REDACTED}`);
    expect(url.redacted).toBe(`https://littleq.test/${REDACTED}`);
    expect(url.toJSON()).toEqual({
      sensitiveUrl: true,
      redacted: `https://littleq.test/${REDACTED}`,
    });
    expect(JSON.stringify(url)).not.toContain('super-secret-token');
    expect(JSON.stringify({ url })).not.toContain('super-secret-token');
    expect(String(url)).not.toContain('super-secret-token');
    expect(`${url}`).not.toContain('super-secret-token');
    // 实例上唯一可枚举的属性是那个类型标记；原文在私有字段里，浅拷贝与 inspect 都拿不到。
    expect(Object.keys(url)).toEqual(['sensitiveUrl']);
    expect({ ...url }).toEqual({ sensitiveUrl: true });
    expect(JSON.stringify({ ...url })).not.toContain('super-secret-token');
    // 唯一出口是显式 reveal()。
    expect(url.reveal()).toBe(raw);
    expect(url.sensitiveUrl).toBe(true);
  });

  it('SensitiveUrl.from 只接受带 scheme 的绝对 URL，裸 token 进不来', () => {
    expect(() => SensitiveUrl.from('')).toThrow('SENSITIVE_URL_INVALID');
    expect(() => SensitiveUrl.from('abc123')).toThrow('SENSITIVE_URL_INVALID');
    expect(() => SensitiveUrl.from('/internal/object-read?grant=abc')).toThrow(
      'SENSITIVE_URL_INVALID',
    );
    expect(() => SensitiveUrl.from('https://x.test/a b')).toThrow('SENSITIVE_URL_INVALID');
    expect(SensitiveUrl.from('https://x.test/a').reveal()).toBe('https://x.test/a');
  });

  it('fingerprint 是不可逆短指纹：12 位十六进制、确定性、不同输入不同输出', () => {
    const a = fingerprint('grant-token-a');
    const b = fingerprint('grant-token-b');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(fingerprint('grant-token-a'));
    expect(a).not.toBe(b);
    expect(a).not.toContain('grant-token-a');
  });

  it('redactRecord 返回新对象，不改调用方手里的那份', () => {
    const input = { level: 'info' as const, message: 'x', fields: { token: 'abc123' } };
    const output = redactRecord(input);
    expect(output).not.toBe(input);
    expect(input.fields['token']).toBe('abc123');
    expect(output.fields['token']).toBe(REDACTED);
    expect(output.message).toBe('x');
    expect(output.level).toBe('info');
  });

  it('深度上限只限制**对象展开**，不改变字符串的脱敏：第 5 层对象整体塌成 [redacted]', () => {
    // 这条上限是递归护栏（一个超深/自引用的对象不能把脱敏器拖死），**不是**脱敏手段：
    // 字符串在进入深度判定之前就先走 `redactText`，所以埋得再深的 URL 也照样被脱敏。
    // 两侧都钉住，免得把上限悄悄调成 0 之后这条断言还是绿的。
    const fourDeep = redactRecord({
      level: 'debug',
      message: 'four',
      fields: { l1: { l2: { l3: { l4: 'leaf' } } } },
    });
    expect(fourDeep.fields['l1']).toEqual({ l2: { l3: { l4: 'leaf' } } });

    const fiveDeep = redactRecord({
      level: 'debug',
      message: 'five',
      fields: { l1: { l2: { l3: { l4: { l5: { l6: 'buried' } } } } } },
    });
    expect(JSON.stringify(fiveDeep.fields)).not.toContain('buried');
    expect(fiveDeep.fields['l1']).toEqual({ l2: { l3: { l4: { l5: REDACTED } } } });

    // 深层里的敏感字符串照样被脱敏：埋深不等于放行。
    const buriedUrl = redactRecord({
      level: 'debug',
      message: 'buried-url',
      fields: { a: { b: { c: 'see https://blob.store/x?sig=deadbeef' } } },
    });
    expect(JSON.stringify(buriedUrl.fields)).not.toContain('deadbeef');
    expect(buriedUrl.fields['a']).toEqual({ b: { c: `see https://blob.store/${REDACTED}` } });

    const listDeep = redactRecord({
      level: 'debug',
      message: 'list',
      fields: { items: ['a', { token: 'abc123' }] },
    });
    expect(listDeep.fields['items']).toEqual(['a', { token: REDACTED }]);
  });
});

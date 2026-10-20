/**
 * `secret-store-encrypted-lifecycle` —— 成人 BYO 凭据的加密生命周期（ZLQ-194 §6.2 / §6.4、
 * ZLQ-201 裁定一 §7、本单验收项「三个 SecretStore 写操作各有一个测试证明 204 + 不回显；
 * rotate/revoke 各有一个并发 CAS 冲突测试」）。
 *
 * ## 「204 + 不回显」在本层能被证明到什么程度（诚实分层，先说清楚）
 * 端口不发 HTTP 状态码 —— 那是 D5 的 `apps/api`。所以本文件把这条验收拆成两半，各证各的：
 *
 * 1. **wire 侧**：直接读**冻结的** `contracts/openapi/v1/openapi.json`，断言 `putSecret` /
 *    `rotateSecret` / `revokeSecret` 三个 operation 的成功响应就是 `204` 且 `content` 为空。
 *    这份契约不是本单写的，是 D1 落库、被 `contract:check` 的哈希钉住的那一份，所以它红不了 ——
 *    它在这里的作用是**把端口的返回面与已冻结的 wire 语义对齐**，而不是重新定义 wire。
 * 2. **端口侧**：断言三个写操作的返回值**结构上没有能装明文/密文的地方** —— `revoke` 返回
 *    `void`，`set` / `rotate` 只返回一个不可逆的 `SecretRef`，`metadata` 的键集合里
 *    plaintext / ciphertext / nonce / tag 一个都没有。
 *
 * 两半合起来才等于「204，只写不回显」。真链路上「一次 PUT 真的回了 204 且响应体为空」属于
 * D5/D6，本单不声称。
 *
 * ## CAS 冲突为什么在内存替身上就可红可绿
 * 替身把 CAS 做成「读当前 `generation`、不等就返回 `null`」，形状与 D5 那条带
 * `WHERE generation = $expected` 的 SQL UPDATE 一致，所以「两个写者拿着同一个期望版本，
 * 只有第一个能落」这件事在本层就能测。**跨进程 / 跨连接**的冲突只有真数据库能保证 ——
 * 替身证明不了，那部分留给 D5/D6。计数器（`saveCount` / `conflictCount`）是为了让「冲突路径
 * 确实被走过」本身可断言：只断言抛了某个码，在一个永远不冲突的实现上也会绿。
 *
 * ## 撤销的并发形状与轮换不同（这一条是实测出来的，不是推的）
 * domain 的 `revokeSecretRecord` **保留** `generation`（撤销不抹掉审计事实），所以两个
 * 「revoke vs revoke」在替身上都会成功、且写入完全相同的状态 —— 那不构成丢失更新，也不该
 * 报 409（domain 显式要求撤销幂等）。revoke 真正的 CAS 冲突形状是 **revoke vs rotate**：
 * 一方拿着陈旧的期望版本去撤销，另一方已经把凭据换成了新的一代。
 *
 * 这个形状**只有在轮换先落库时才被 CAS 拦住**（下面第一条用例，用顺序而非 `allSettled` 把
 * 次序钉死）。反过来 —— 撤销先落库 —— 就拦不住了：`generation` 没动，紧随其后的 rotate 拿
 * 同一个期望版本去比对照样通过，于是**两个写者都对同一个版本落了库，撤销被静默覆盖**。
 * 这是版本 CAS 自身保证（「同一版本至多一个写者落库」）在这个交错下失效，实测值已单独钉在
 * 「已申报的设计缺口」那条用例里，并在交付评论中申报给架构师与 PM 裁定，本单不自行扩面去修
 * （两条可能的修法都要动本单无权动的面：domain 的撤销推进 `generation`，或给
 * `SecretRecordStore` 加一个 infra 自己的单调写序号）。
 *
 * 诚实分层：那个缺口**不破密码学意图** —— 第 1 代密文已被 rotate 销毁，旧 ref 不可读，
 * 撤销方看到的那个秘密确实用不了了；丢的是「撤销之后不该再有任何活凭据」这层意图。
 *
 * ## 两层 CAS 守卫各有一条用例，合起来才排除空转
 * 端口在 `revoke` / `rotate` 开头有一次**前置校验**（版本对不上直接抛，根本不碰存储，
 * `conflictCount` 保持 0），记录库 `save` 里还有第二次**存储级 CAS**（返回 `null`，
 * `conflictCount` 记 1）。前者由 revoke vs rotate 那条用例证明，后者由 rotate vs rotate
 * 那条用例证明。只断言其中一层，另一层可能整段是死代码而门禁照绿。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type SecretKind,
  type SecretMetadata,
  type SecretRef,
  type Timestamp,
  parseSecretRef,
} from '@littleq/domain';
import { describe, expect, it } from 'vitest';

import type { InfraErrorCode } from '../src/errors.js';
import {
  MASTER_KEY_ENV_VAR,
  SECRET_PURPOSES,
  type InternalSecretMetadata,
  type SecretSetInput,
  toPublicSecretMetadata,
} from '../src/ports/secret-store.js';
import {
  MASTER_KEY_BYTES,
  NONCE_BYTES,
  SECRET_PLAINTEXT_MAX_BYTES,
  SECRET_PLAINTEXT_MIN_BYTES,
  TAG_BYTES,
  SecretCipher,
  additionalData,
  assertPlaintextLength,
  loadMasterKey,
  parseMasterKey,
} from '../src/secret-store/cipher.js';
import { InMemorySecretRecordStore } from '../src/secret-store/memory-records.js';
import {
  type StoredSecret,
  EncryptedSecretStore,
  newSecretRef,
  purposeOf,
  unconfiguredStoredSecret,
} from '../src/secret-store/store.js';
import { TEST_MASTER_KEY_HEX, at, bytes, rejectedCode, sha256Of } from './support.js';

const CAPABILITY = 'secret-store-encrypted-lifecycle';

const OWNER = 'owner-alice';
const KIND: SecretKind = 'QCA_PAT';
const OTHER_KIND: SecretKind = 'BAILIAN_API_KEY';
const OTHER_OWNER = 'owner-bob';

/** 冻结契约的路径。用 `import.meta.url` 解析，于是不受 vitest 的 cwd 影响。 */
const OPENAPI_PATH = fileURLToPath(
  new URL('../../../contracts/openapi/v1/openapi.json', import.meta.url),
);

interface OpenApiDocument {
  readonly paths?: Record<string, Record<string, OpenApiOperation>>;
  readonly components?: {
    readonly schemas?: Record<string, Record<string, unknown>>;
  };
}

interface OpenApiOperation {
  readonly operationId?: string;
  readonly responses?: Record<string, { readonly content?: Record<string, unknown> }>;
}

function frozenContract(): OpenApiDocument {
  return JSON.parse(readFileSync(OPENAPI_PATH, 'utf-8')) as OpenApiDocument;
}

function operationOf(document: OpenApiDocument, path: string, method: string): OpenApiOperation {
  const item = document.paths?.[path]?.[method];
  if (item === undefined) throw new Error(`冻结契约里找不到 ${method.toUpperCase()} ${path}`);
  return item;
}

function schemaOf(document: OpenApiDocument, name: string): Record<string, unknown> {
  const schema = document.components?.schemas?.[name];
  if (schema === undefined) throw new Error(`冻结契约里找不到 schema ${name}`);
  return schema;
}

interface Harness {
  readonly cipher: SecretCipher;
  readonly records: InMemorySecretRecordStore;
  readonly store: EncryptedSecretStore;
  readonly clock: { seconds: number };
}

function harness(keyVersion = 1): Harness {
  const clock = { seconds: 0 };
  const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), keyVersion);
  const records = new InMemorySecretRecordStore();
  const store = new EncryptedSecretStore({
    cipher,
    records,
    now: (): Timestamp => at(clock.seconds),
  });
  return { cipher, records, store, clock };
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function setInput(overrides: Partial<SecretSetInput> = {}): SecretSetInput {
  return { ownerId: OWNER, kind: KIND, plaintext: text('qca-pat-first-value'), ...overrides };
}

/** 读回存储里的原始形态（密文 / nonce / tag / keyVersion），用来断言「库里没有明文」。 */
async function storedOf(
  h: Harness,
  ownerId = OWNER,
  kind: SecretKind = KIND,
): Promise<StoredSecret> {
  const loaded = await h.records.load(ownerId, kind);
  if (loaded === null) throw new Error('期望这条记录已经落库');
  return loaded;
}

function secretOf(stored: StoredSecret): NonNullable<StoredSecret['secret']> {
  if (stored.secret === null) throw new Error('期望这条记录已配置，密文应在');
  return stored.secret;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface RejectedShape {
  readonly code: string;
  readonly publicCode: string;
  readonly secretKind: SecretKind | undefined;
}

/** `rejectedCode` 只给码；有几处需要公开码与 `secretKind`，所以另给一个。 */
async function rejectedError(promise: Promise<unknown>): Promise<RejectedShape> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; publicCode?: string; secretKind?: SecretKind };
    return {
      code: failure.code ?? 'UNKNOWN',
      publicCode: failure.publicCode ?? 'UNKNOWN',
      secretKind: failure.secretKind,
    };
  }
  throw new Error('期望这次调用被拒绝，但它成功了');
}

describe(CAPABILITY, () => {
  it('secret-store-encrypted-lifecycle: 冻结契约里三个写操作都是 204 且响应体为空', () => {
    const document = frozenContract();
    const writes = [
      ['put', '/settings/secrets/{kind}', 'putSecret'],
      ['post', '/settings/secrets/{kind}:rotate', 'rotateSecret'],
      ['post', '/settings/secrets/{kind}:revoke', 'revokeSecret'],
    ] as const;

    for (const [method, path, operationId] of writes) {
      const operation = operationOf(document, path, method);
      // 反空断言之一：确认找到的确实是那三个 operation，而不是碰巧同路径的别的东西。
      expect(operation.operationId, path).toBe(operationId);
      const responses = operation.responses ?? {};
      expect(Object.keys(responses).sort(), path).toEqual(
        ['204', '400', '401', '403', '409'].sort(),
      );
      // **只写不回显**：成功响应存在，但没有任何 content type ⇒ 没有响应体可回显。
      const success = responses['204'];
      expect(success, `${path} 必须有 204`).toBeDefined();
      expect(success?.content ?? null, `${path} 的 204 不得带响应体`).toBeNull();
      // 反空断言之二：这个 operation 确实声明了 409（CAS 冲突对外就是它）。没有它，
      // 上面那条「204 没有响应体」可能只是因为整个 responses 都是空的。
      expect(responses['409'], `${path} 必须声明 409`).toBeDefined();
      expect(responses['409']?.content?.['application/json']).toBeDefined();
    }

    // 读操作是**唯一**有响应体的那个，而它的 schema 结构上就没有 value 字段。
    const read = operationOf(document, '/settings/secrets/{kind}', 'get');
    expect(read.operationId).toBe('getSecretMetadata');
    expect(Object.keys(read.responses ?? {}).sort()).toEqual(['200', '400', '401', '403']);
    expect(read.responses?.['200']?.content?.['application/json']).toBeDefined();
  });

  it('secret-store-encrypted-lifecycle: 端口侧三个写操作的返回值结构上装不下明文或密文', async () => {
    const h = harness();

    // revoke 返回 void —— 类型层面就没有东西可回显。
    const revoked: void = await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 0 });
    expect(revoked).toBeUndefined();

    const setRef = await h.store.set(setInput({ plaintext: text('qca-pat-first-value') }));
    const rotateRef = await h.store.rotate({
      ...setInput({ plaintext: text('qca-pat-second-value') }),
      expectedVersion: 1,
    });
    for (const ref of [setRef, rotateRef]) {
      // 句柄是不透明的：`sec_` + 32 位十六进制。既不是明文，也不是密文。
      expect(ref).toMatch(/^sec_[0-9a-f]{32}$/);
      expect(typeof ref).toBe('string');
      expect(JSON.stringify({ ref })).not.toContain('qca-pat');
    }
    expect(setRef).not.toBe(rotateRef);

    // metadata 的键集合是钉死的：内部比 wire 多 version / revokedAt，但没有一项能装秘密。
    const metadata = await h.store.metadata(OWNER, KIND);
    expect(Object.keys(metadata).sort()).toEqual([
      'configured',
      'revokedAt',
      'rotatedAt',
      'version',
    ]);
    const serializedMetadata = JSON.stringify(metadata);
    expect(serializedMetadata).not.toContain('qca-pat');
    const stored = await storedOf(h);
    const secret = secretOf(stored);
    // 控制组：把明文故意塞进同一形状的对象，同样的检查必须查得到 ——
    // 否则上面那条 not.toContain 只是因为序列化里根本没有可匹配的文本。
    expect(JSON.stringify({ metadata, leaked: 'qca-pat-second-value' })).toContain(
      'qca-pat-second-value',
    );
    expect(JSON.stringify({ metadata, leaked: hex(secret.ciphertext) })).toContain(
      hex(secret.ciphertext),
    );
    // 密文确实**在**库里（否则「没回显」可能只是「什么都没存」）。
    expect(
      hex(
        (await storedOf(h)).secret === null
          ? new Uint8Array(0)
          : secretOf(await storedOf(h)).ciphertext,
      ),
    ).toBe(hex(secret.ciphertext));

    // 跨 HTTP 边界前必须过的投影：键集合逐字等于冻结契约的 SecretMetadata。
    const projected = toPublicSecretMetadata(KIND, metadata);
    expect(Object.keys(projected).sort()).toEqual(['configured', 'kind', 'lastRotatedAt']);
    expect(projected).toEqual({ kind: KIND, configured: true, lastRotatedAt: at(0) });
  });

  it('secret-store-encrypted-lifecycle: 投影后的元数据形状与冻结契约的 SecretMetadata 一致', () => {
    const document = frozenContract();
    const schema = schemaOf(document, 'SecretMetadata');
    const properties = schema['properties'] as Record<string, unknown> | undefined;
    if (properties === undefined) throw new Error('SecretMetadata 没有 properties');
    // 反空断言：契约确实把键集合钉成了这三项，且 additionalProperties: false。
    expect(Object.keys(properties).sort()).toEqual(['configured', 'kind', 'lastRotatedAt']);
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['configured', 'kind', 'lastRotatedAt']);

    // 内部元数据多出的两项**不得**出现在投影结果里 —— 加字段就是破坏性变更。
    const internal: InternalSecretMetadata = {
      configured: true,
      version: 7,
      rotatedAt: at(30),
      revokedAt: at(90),
    };
    const projected: SecretMetadata = toPublicSecretMetadata(KIND, internal);
    expect(Object.keys(projected).sort()).toEqual(['configured', 'kind', 'lastRotatedAt']);
    expect(JSON.stringify(projected)).not.toContain('version');
    expect(JSON.stringify(projected)).not.toContain('revokedAt');
    expect(projected.lastRotatedAt).toBe(at(30));

    // 未配置过 ⇒ lastRotatedAt 是 null（契约允许 null，不允许 undefined 被序列化成缺键）。
    const empty = toPublicSecretMetadata(OTHER_KIND, {
      configured: false,
      version: undefined,
      rotatedAt: undefined,
      revokedAt: undefined,
    });
    expect(empty).toEqual({ kind: OTHER_KIND, configured: false, lastRotatedAt: null });
    expect(JSON.stringify(empty)).toContain('"lastRotatedAt":null');

    expect(operationOf(document, '/settings/secrets/{kind}', 'get').operationId).toBe(
      'getSecretMetadata',
    );
  });

  it('secret-store-encrypted-lifecycle: 库里只存密文/nonce/tag/keyVersion，明文与根密钥都不落库', async () => {
    const h = harness();
    const plaintext = text('qca-pat-super-secret-value');
    await h.store.set(setInput({ plaintext }));

    const stored = await storedOf(h);
    const secret = secretOf(stored);
    // 密文只有这四个字段，一个不多一个不少。
    expect(Object.keys(secret).sort()).toEqual(['ciphertext', 'keyVersion', 'nonce', 'tag']);
    expect(secret.nonce.byteLength).toBe(NONCE_BYTES);
    expect(secret.tag.byteLength).toBe(TAG_BYTES);
    expect(secret.keyVersion).toBe(1);

    const serialized = JSON.stringify(stored);
    // 明文原文、它的 base64、它的十六进制、它的摘要，都不得出现在存储里。
    expect(serialized).not.toContain('qca-pat-super-secret-value');
    expect(serialized).not.toContain(Buffer.from(plaintext).toString('base64'));
    expect(serialized).not.toContain(hex(plaintext));
    expect(serialized).not.toContain(String(sha256Of(plaintext)));
    // 根密钥原文（十六进制与 base64 两种形态）也不得出现。
    expect(serialized).not.toContain(TEST_MASTER_KEY_HEX);
    expect(serialized).not.toContain(
      Buffer.from(parseMasterKey(TEST_MASTER_KEY_HEX)).toString('base64'),
    );

    // 控制组：把明文/密钥故意塞进同形状的对象，上面每一类检查都必须查得到。
    // 没有这一组，「not.toContain」全绿也可能只是因为 JSON 把 Uint8Array 渲染成了
    // `{"0":1,"1":2,…}`，任何十六进制/base64 串都不可能命中。
    expect(JSON.stringify({ stored, leaked: 'qca-pat-super-secret-value' })).toContain(
      'qca-pat-super-secret-value',
    );
    expect(JSON.stringify({ stored, leaked: hex(plaintext) })).toContain(hex(plaintext));
    expect(JSON.stringify({ stored, leaked: TEST_MASTER_KEY_HEX })).toContain(TEST_MASTER_KEY_HEX);

    // 反空断言：密文确实存下来了，而且 GCM 是流式的 —— 长度等于明文、内容不等于明文。
    expect(secret.ciphertext.byteLength).toBe(plaintext.byteLength);
    expect(hex(secret.ciphertext)).not.toBe(hex(plaintext));
    expect(hex(secretOf(await storedOf(h)).ciphertext)).toBe(hex(secret.ciphertext));

    // 领域记录里也没有明文：currentRef 是句柄，generation 是代数。
    expect(stored.record.currentRef).not.toBeNull();
    expect(stored.record.generation).toBe(1);
    expect(stored.record.configured).toBe(true);
    expect(stored.record.source).toBe('USER');
    expect(JSON.stringify(stored.record)).not.toContain('qca-pat-super-secret-value');

    // 读回来必须逐字节等于原明文（否则「没落库」可能只是「加密坏了」）。
    const ref = stored.record.currentRef;
    if (ref === null) throw new Error('期望有 currentRef');
    expect(await h.store.read(ref, 'qca-call')).toEqual(plaintext);
  });

  it('secret-store-encrypted-lifecycle: 每条记录随机 96-bit nonce，同明文两次加密密文不同', async () => {
    const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX));
    const plaintext = text('same-plaintext-twice');
    const context = { ownerId: OWNER, kind: KIND, version: 1 };

    const first = cipher.encrypt(plaintext, context);
    const second = cipher.encrypt(plaintext, context);

    expect(first.nonce.byteLength).toBe(NONCE_BYTES);
    expect(second.nonce.byteLength).toBe(NONCE_BYTES);
    // GCM 在同一把密钥下重用 nonce 是灾难性的（可伪造认证标签、甚至恢复明文）。
    expect(hex(first.nonce)).not.toBe(hex(second.nonce));
    expect(hex(first.ciphertext)).not.toBe(hex(second.ciphertext));
    expect(hex(first.tag)).not.toBe(hex(second.tag));

    // 反空断言：两份都能解密回同一个明文 —— 「不同」不是因为其中一份坏了。
    expect(cipher.decrypt(first, context)).toEqual(plaintext);
    expect(cipher.decrypt(second, context)).toEqual(plaintext);

    // 跨记录（不同 owner / 不同 kind / 不同代）也各自随机。
    const otherOwner = cipher.encrypt(plaintext, { ...context, ownerId: OTHER_OWNER });
    const otherKind = cipher.encrypt(plaintext, { ...context, kind: OTHER_KIND });
    const otherVersion = cipher.encrypt(plaintext, { ...context, version: 2 });
    const nonces = new Set([
      hex(first.nonce),
      hex(second.nonce),
      hex(otherOwner.nonce),
      hex(otherKind.nonce),
      hex(otherVersion.nonce),
    ]);
    expect(nonces.size).toBe(5);

    // 走完整端口路径也一样：同一个明文 set → revoke → set，两次落库的 nonce 不同。
    const h = harness();
    await h.store.set(setInput({ plaintext }));
    const firstStored = secretOf(await storedOf(h));
    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 1 });
    await h.store.set(setInput({ plaintext }));
    const secondStored = secretOf(await storedOf(h));
    expect(hex(secondStored.nonce)).not.toBe(hex(firstStored.nonce));
    expect(hex(secondStored.ciphertext)).not.toBe(hex(firstStored.ciphertext));
  });

  it('secret-store-encrypted-lifecycle: AAD 绑定 ownerId + kind + version，换一个就解不开', async () => {
    const cipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX));
    const plaintext = text('aad-bound-value');
    const context = { ownerId: OWNER, kind: KIND, version: 3 };
    const encrypted = cipher.encrypt(plaintext, context);

    // 正解能开。
    expect(cipher.decrypt(encrypted, context)).toEqual(plaintext);

    // 把 A 用户的密文挪到 B 用户名下必须失败 —— 这就是 AAD 存在的理由。
    const mismatches = [
      { ownerId: OTHER_OWNER, kind: KIND, version: 3 },
      { ownerId: OWNER, kind: OTHER_KIND, version: 3 },
      { ownerId: OWNER, kind: KIND, version: 4 },
      { ownerId: OWNER, kind: KIND, version: 2 },
      { ownerId: `${OWNER} `, kind: KIND, version: 3 },
      { ownerId: OWNER.toUpperCase(), kind: KIND, version: 3 },
    ];
    for (const wrong of mismatches) {
      expect(
        await rejectedCode(Promise.resolve().then(() => cipher.decrypt(encrypted, wrong))),
      ).toBe('SECRET_DECRYPT_FAILED');
    }

    // 密文本身被改动（哪怕一个 bit）也必须失败，且失败码与上面**完全相同** ——
    // 区分「标签不对 / AAD 不对 / 密文被截断」等于给攻击者一个 oracle。
    const tamperedCipher = encrypted.ciphertext.slice();
    tamperedCipher[0] = (tamperedCipher[0] ?? 0) ^ 0xff;
    expect(
      await rejectedCode(
        Promise.resolve().then(() =>
          cipher.decrypt({ ...encrypted, ciphertext: tamperedCipher }, context),
        ),
      ),
    ).toBe('SECRET_DECRYPT_FAILED');

    const tamperedTag = encrypted.tag.slice();
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 0xff;
    expect(
      await rejectedCode(
        Promise.resolve().then(() => cipher.decrypt({ ...encrypted, tag: tamperedTag }, context)),
      ),
    ).toBe('SECRET_DECRYPT_FAILED');

    // 反空断言：只改 keyVersion 之外的字段都不影响正解；原封不动再解一次仍然成功。
    expect(cipher.decrypt(encrypted, context)).toEqual(plaintext);
  });

  it('secret-store-encrypted-lifecycle: AAD 是长度前缀的规范编码，拼接撞不出同一段', () => {
    // 少了长度前缀，("ab","QCA_PAT",1) 与 ("a","bQCA_PAT",1) 会撞出同一段 AAD，
    // 于是把 A 用户的密文挪到 B 用户名下也能通过认证 —— 绑定就白绑了。
    const left = additionalData({ ownerId: 'ab', kind: KIND, version: 1 });
    const right = additionalData({ ownerId: 'a', kind: `b${KIND}` as SecretKind, version: 1 });
    expect(hex(left)).not.toBe(hex(right));

    // version 用十进制无前导零：1 与 01 不能生成两段不同的 AAD 却指向同一代。
    const base = additionalData({ ownerId: OWNER, kind: KIND, version: 1 });
    expect(hex(base)).toBe(hex(additionalData({ ownerId: OWNER, kind: KIND, version: 1 })));
    expect(hex(base)).not.toBe(hex(additionalData({ ownerId: OWNER, kind: KIND, version: 2 })));
    expect(hex(base)).not.toBe(hex(additionalData({ ownerId: OWNER, kind: KIND, version: 10 })));

    // 带域分隔符；ownerId 里含换行也挤不动后面的字段。
    const decoded = new TextDecoder().decode(base);
    expect(decoded).toContain('littleq.secret.aad.v1');
    expect(decoded).toContain(`${OWNER.length}:${OWNER}`);
    expect(decoded).toContain(`v:1`);
    const smuggled = additionalData({
      ownerId: `a\n${KIND.length}:${KIND}`,
      kind: KIND,
      version: 1,
    });
    expect(hex(smuggled)).not.toBe(hex(additionalData({ ownerId: 'a', kind: KIND, version: 1 })));

    // 非法 context 一律 SECRET_CONTEXT_INVALID（version < 1 / 非整数、空 ownerId、空 kind）。
    const badContexts = [
      { ownerId: '', kind: KIND, version: 1 },
      { ownerId: OWNER, kind: '' as SecretKind, version: 1 },
      { ownerId: OWNER, kind: KIND, version: 0 },
      { ownerId: OWNER, kind: KIND, version: -1 },
      { ownerId: OWNER, kind: KIND, version: 1.5 },
      { ownerId: OWNER, kind: KIND, version: Number.NaN },
      { ownerId: OWNER, kind: KIND, version: Number.MAX_SAFE_INTEGER + 10 },
    ];
    for (const bad of badContexts) {
      expect(() => additionalData(bad)).toThrow('SECRET_CONTEXT_INVALID');
    }
    // 反空断言：合法 context 不抛。
    expect(() => additionalData({ ownerId: OWNER, kind: KIND, version: 1 })).not.toThrow();
  });

  it('secret-store-encrypted-lifecycle: 根密钥只从 LITTLEQ_MASTER_KEY 读取，值不出现在任何地方', () => {
    // 变量名逐字点名 —— 部署侧要注入的就是它。
    expect(MASTER_KEY_ENV_VAR).toBe('LITTLEQ_MASTER_KEY');
    expect(MASTER_KEY_BYTES).toBe(32);

    // 缺失 / 空串 ⇒ MASTER_KEY_UNAVAILABLE（启动阶段大声失败，不是运行中途 undefined）。
    expect(() => loadMasterKey({})).toThrow('MASTER_KEY_UNAVAILABLE');
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: '' })).toThrow('MASTER_KEY_UNAVAILABLE');
    // 给了合法值就能构造出 cipher，keyVersion 可显式指定。
    expect(loadMasterKey({ [MASTER_KEY_ENV_VAR]: TEST_MASTER_KEY_HEX }).keyVersion).toBe(1);
    expect(loadMasterKey({ [MASTER_KEY_ENV_VAR]: TEST_MASTER_KEY_HEX }, 4).keyVersion).toBe(4);

    // 编码要求：64 位十六进制，或解码后正好 32 字节的 base64。其它一律拒绝，且**不做 trim** ——
    // 多一个换行就该在启动阶段失败，好过悄悄用一把和写入时不同的密钥去解密。
    const keyBytes = parseMasterKey(TEST_MASTER_KEY_HEX);
    const asBase64 = Buffer.from(keyBytes).toString('base64');
    expect(hex(parseMasterKey(asBase64))).toBe(hex(keyBytes));
    const rejected = [
      `${TEST_MASTER_KEY_HEX}\n`, // 不 trim
      ` ${TEST_MASTER_KEY_HEX}`,
      TEST_MASTER_KEY_HEX.slice(0, 63), // 短一位
      `${TEST_MASTER_KEY_HEX}00`, // 长两位
      '0'.repeat(64), // 全零占位值被显式拒绝
      'not-a-key-at-all',
      '',
      Buffer.from(new Uint8Array(31)).toString('base64'), // 解码后 31 字节
      Buffer.from(new Uint8Array(33)).toString('base64'), // 解码后 33 字节
    ];
    for (const bad of rejected) {
      expect(() => parseMasterKey(bad), JSON.stringify(bad)).toThrow('MASTER_KEY_UNAVAILABLE');
    }
    // 反空断言：合法形状确实被接受（否则上面全红只是因为 parseMasterKey 永远抛）。
    expect(keyBytes.byteLength).toBe(MASTER_KEY_BYTES);
    expect(parseMasterKey(TEST_MASTER_KEY_HEX.toUpperCase()).byteLength).toBe(MASTER_KEY_BYTES);

    // 密钥长度不对 / keyVersion 非法 ⇒ 构造即失败。
    expect(() => new SecretCipher(new Uint8Array(31))).toThrow('MASTER_KEY_UNAVAILABLE');
    expect(() => new SecretCipher(new Uint8Array(33))).toThrow('MASTER_KEY_UNAVAILABLE');
    expect(() => new SecretCipher(new Uint8Array(32), 0)).toThrow('MASTER_KEY_UNAVAILABLE');
    expect(() => new SecretCipher(new Uint8Array(32), -1)).toThrow('MASTER_KEY_UNAVAILABLE');
    expect(() => new SecretCipher(new Uint8Array(32), 1.5)).toThrow('MASTER_KEY_UNAVAILABLE');

    // **唯一**允许进日志的密钥相关信息是不可逆短指纹。
    const cipher = loadMasterKey({ [MASTER_KEY_ENV_VAR]: TEST_MASTER_KEY_HEX });
    const fingerprint = cipher.keyFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).toBe(cipher.keyFingerprint());
    expect(fingerprint).not.toBe(TEST_MASTER_KEY_HEX.slice(0, 12));
    expect(TEST_MASTER_KEY_HEX).not.toContain(fingerprint);
  });

  it('secret-store-encrypted-lifecycle: keyVersion 不匹配 ⇒ MASTER_KEY_VERSION_MISMATCH，不拿新密钥硬解旧密文', async () => {
    const h = harness(1);
    const plaintext = text('value-under-key-version-1');
    const ref = await h.store.set(setInput({ plaintext }));
    expect(secretOf(await storedOf(h)).keyVersion).toBe(1);

    const stored = await storedOf(h);
    const secret = secretOf(stored);
    const context = { ownerId: OWNER, kind: KIND, version: 1 };

    // 同一把密钥、只换 keyVersion（轮换主密钥的场景）：旧密文必须显式失败，而不是被 GCM
    // 糊成一个 SECRET_DECRYPT_FAILED —— 部署侧需要区分「密钥换代了」与「数据坏了」，
    // 这两件事的处置完全不同（前者要重加密，后者要告警）。
    const rotatedCipher = new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX), 2);
    expect(
      await rejectedCode(Promise.resolve().then(() => rotatedCipher.decrypt(secret, context))),
    ).toBe('MASTER_KEY_VERSION_MISMATCH');
    // 反空断言：版本号对上就能解 —— 失败确实来自版本判定，不是密文本身坏了。
    expect(h.cipher.decrypt(secret, context)).toEqual(plaintext);
    expect(await h.store.read(ref, 'qca-call')).toEqual(plaintext);

    // 换一把**不同的密钥**（版本号相同）⇒ 认证失败，落到 SECRET_DECRYPT_FAILED。
    const otherKey = new SecretCipher(parseMasterKey('1'.repeat(64)), 1);
    expect(
      await rejectedCode(Promise.resolve().then(() => otherKey.decrypt(secret, context))),
    ).toBe('SECRET_DECRYPT_FAILED');

    // 密文形状非法在解密之前就被挡掉（nonce/tag 长度、空密文）。
    for (const bad of [
      { ...secret, nonce: new Uint8Array(NONCE_BYTES - 1) },
      { ...secret, nonce: new Uint8Array(NONCE_BYTES + 1) },
      { ...secret, tag: new Uint8Array(TAG_BYTES - 1) },
      { ...secret, tag: new Uint8Array(TAG_BYTES + 1) },
      { ...secret, ciphertext: new Uint8Array(0) },
    ]) {
      expect(await rejectedCode(Promise.resolve().then(() => h.cipher.decrypt(bad, context)))).toBe(
        'SECRET_DECRYPT_FAILED',
      );
    }
  });

  it('secret-store-encrypted-lifecycle: set 首次写入成功、同值重试幂等、异值必须走 rotate', async () => {
    const h = harness();
    const plaintext = text('first-value');

    const ref = await h.store.set(setInput({ plaintext }));
    expect(h.records.saveCount).toBe(1);
    expect(h.records.conflictCount).toBe(0);
    expect(await h.store.metadata(OWNER, KIND)).toEqual({
      configured: true,
      version: 1,
      rotatedAt: at(0),
      revokedAt: undefined,
    });

    // 同值重试幂等成功：返回**同一个**句柄，且没有多写一次库。
    expect(await h.store.set(setInput({ plaintext }))).toBe(ref);
    expect(h.records.saveCount).toBe(1);

    // 异值必须被拒 —— 否则 `set` 会悄悄覆盖掉一个正在被使用的凭据（调用方该走 rotate）。
    const failure = await rejectedError(
      h.store.set(setInput({ plaintext: text('different-value') })),
    );
    expect(failure.code).toBe<InfraErrorCode>('SECRET_ALREADY_CONFIGURED');
    expect(failure.publicCode).toBe('REVISION_CONFLICT'); // 对外 409，契约里 putSecret 声明了它
    expect(failure.secretKind).toBe(KIND);
    await expect(h.store.set(setInput({ plaintext: text('another-value') }))).rejects.toThrow(
      'SECRET_ALREADY_CONFIGURED',
    );

    // 被拒的 set 没有改动库里的值，也没有多写一次。
    expect(await h.store.read(ref, 'qca-call')).toEqual(plaintext);
    expect(h.records.saveCount).toBe(1);
    expect((await h.store.metadata(OWNER, KIND)).version).toBe(1);

    // 撤销之后可以重新 set（generation 前进，不与「从未配置过」混淆）。
    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 1 });
    expect((await h.store.metadata(OWNER, KIND)).configured).toBe(false);
    const afterRevoke = await h.store.set(setInput({ plaintext }));
    expect(afterRevoke).not.toBe(ref);
    expect((await h.store.metadata(OWNER, KIND)).version).toBe(2);
    expect(await h.store.read(afterRevoke, 'qca-call')).toEqual(plaintext);
    // 旧句柄仍然不可读。
    await expect(h.store.read(ref, 'qca-call')).rejects.toThrow('SECRET_NOT_CONFIGURED');
  });

  it('secret-store-encrypted-lifecycle: rotate 并发 CAS 冲突 —— 两个写者拿同一个期望版本，只有第一个能落', async () => {
    const h = harness();
    await h.store.set(setInput({ plaintext: text('v1') }));
    const versionAfterSet = (await h.store.metadata(OWNER, KIND)).version;
    if (versionAfterSet === undefined) throw new Error('期望已配置，version 应有值');
    expect(versionAfterSet).toBe(1);
    expect(h.records.conflictCount).toBe(0);

    // 两个写者都读到了 version=1 —— 这就是并发的形状：期望版本相同。
    const results = await Promise.allSettled([
      h.store.rotate({
        ...setInput({ plaintext: text('v2-by-first') }),
        expectedVersion: versionAfterSet,
      }),
      h.store.rotate({
        ...setInput({ plaintext: text('v2-by-second') }),
        expectedVersion: versionAfterSet,
      }),
    ]);

    const fulfilled = results.filter(
      (item): item is PromiseFulfilledResult<SecretRef> => item.status === 'fulfilled',
    );
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    // **恰好一个成功、恰好一个 409** —— 这是本用例的全部要点。
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const reason = rejected[0]?.reason as Error | undefined;
    expect(reason?.message).toBe('SECRET_VERSION_CONFLICT');
    expect((reason as { publicCode?: string } | undefined)?.publicCode).toBe('REVISION_CONFLICT');
    // 冲突路径确实被走过（不是「恰好一个先跑完、另一个读到新版本」这种假冲突）。
    expect(h.records.conflictCount).toBe(1);
    expect(h.records.saveCount).toBe(2); // set 一次 + 赢家 rotate 一次

    // 落库的是赢家的值，代数前进到 2。
    expect((await h.store.metadata(OWNER, KIND)).version).toBe(2);
    const winnerRef = fulfilled[0]?.value;
    if (winnerRef === undefined) throw new Error('期望一个成功的 rotate');
    expect(await h.store.read(winnerRef, 'qca-call')).toEqual(text('v2-by-first'));

    // 期望版本陈旧到不存在 ⇒ 同样 409，且库里什么都没变。
    const before = await h.store.metadata(OWNER, KIND);
    await expect(
      h.store.rotate({ ...setInput({ plaintext: text('stale') }), expectedVersion: 99 }),
    ).rejects.toThrow('SECRET_VERSION_CONFLICT');
    await expect(h.store.rotate({ ...setInput(), expectedVersion: 1 })).rejects.toThrow(
      'SECRET_VERSION_CONFLICT',
    );
    await expect(h.store.rotate({ ...setInput(), expectedVersion: -1 })).rejects.toThrow(
      'SECRET_VERSION_CONFLICT',
    );
    expect(await h.store.metadata(OWNER, KIND)).toEqual(before);
    expect(h.records.saveCount).toBe(2);
  });

  it('secret-store-encrypted-lifecycle: revoke vs rotate —— 轮换先落库时，陈旧撤销必须被拒且不得停掉新凭据', async () => {
    const h = harness();
    await h.store.set(setInput({ plaintext: text('gen-1') }));

    // 撤销方读到 version=1；在它发出请求之前，另一方已经把凭据轮换到第 2 代并落库。
    // 用**顺序**而不是 `Promise.allSettled` 来固定这个次序：并发下谁先落库取决于微任务顺序，
    // 而「陈旧撤销被拒」这条不变量必须在次序确定时确定地成立（下面另有一条用例专门量并发）。
    const newRef = await h.store.rotate({
      ...setInput({ plaintext: text('gen-2') }),
      expectedVersion: 1,
    });
    expect(h.records.saveCount).toBe(2);

    const failure = await rejectedError(
      h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 1 }),
    );
    expect(failure.code).toBe<InfraErrorCode>('SECRET_VERSION_CONFLICT');
    expect(failure.publicCode).toBe('REVISION_CONFLICT');
    expect(failure.secretKind).toBe(KIND);

    // 拦下它的是**端口自己的前置校验**（`store.ts` 的 revoke 开头），不是记录库的 CAS：
    // 所以 `conflictCount` 仍然是 0 —— 陈旧写**根本没碰到存储**。记录库那一层 CAS 由
    // 上面 rotate vs rotate 那条用例证明（那里 `conflictCount === 1`）；两层各有一条用例，
    // 合起来才排除了「守卫其实没在拦」的空转可能。
    expect(h.records.conflictCount).toBe(0);
    expect(h.records.saveCount).toBe(2);

    // 要防的事故没有发生：刚轮换出来的凭据仍然可用，撤销痕迹一个都没落下。
    const metadata = await h.store.metadata(OWNER, KIND);
    expect(metadata.configured).toBe(true);
    expect(metadata.version).toBe(2);
    expect(metadata.revokedAt).toBeUndefined();
    expect(await h.store.read(newRef, 'qca-call')).toEqual(text('gen-2'));

    // 反空转对照：换成**正确**的版本号，同一次撤销立刻成功。可见上面的 409 来自版本对不上，
    // 而不是「revoke 这条路本来就是坏的 / 断言根本碰不到它」。
    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 2 });
    expect(h.records.saveCount).toBe(3);
    expect((await h.store.metadata(OWNER, KIND)).configured).toBe(false);
    // 撤销后连 `SECRET_REVOKED` 都不外泄：句柄索引里的 ref 已经摘掉，`read` 在
    // `findByRef` 那一步就退化成普通的「不存在」，与从未签发过的 ref 完全同形
    // （这正是下面那条「不可区分」用例要的性质）。
    await expect(h.store.read(newRef, 'qca-call')).rejects.toThrow('SECRET_NOT_CONFIGURED');
  });

  it('secret-store-encrypted-lifecycle: 【已申报的设计缺口，勿当作背书】并发下 revoke 先落库会被 rotate 静默覆盖', async () => {
    // ⚠️ 这条用例**钉住的是一个已申报的缺陷实测值，不是期望行为**。
    //
    // 实测：两个写者都读到 version=1，撤销方先发出请求 —— 两边**都成功**，撤销被静默吞掉，
    // 最终库里是第 2 代、`configured: true`。原因是 domain 的 `revokeSecretRecord` **保留
    // `generation`**（这是撤销幂等所需要的），于是一次撤销落库对版本 CAS 是**不可见**的：
    // 紧随其后的 rotate 拿 `expectedVersion: 1` 去比对，看到的仍然是 1，照样放行。
    // 版本 CAS 本该保证「同一个版本至多一个写者落库」，在这个交错下它保证了不了。
    //
    // 影响面（诚实分层）：**密码学意图没有破**——第 1 代密文已被 rotate 销毁，旧 ref 不可读，
    // 撤销方看到的那个凭据确实用不了了。丢的是**「撤销后不该有任何活凭据」**这层意图：
    // 用户点了撤销、拿到 204，而另一个会话的轮换让一个新凭据活了下来。
    //
    // 为什么本单不自作主张修：可选的修法都要动本单无权动的面 —— 要么让 domain 的撤销推进
    // `generation`（`packages/domain/**` 冻结），要么给 `SecretRecordStore` 加一个 infra 自己的
    // 单调写序号（这会改掉 D5 要照着实现真库的端口签名）。按角色约定申报给架构师与 PM 裁定，
    // 不在开发单里自行取舍。**修掉它的人必须同步改掉这条钉子，这是故意的。**
    const h = harness();
    await h.store.set(setInput({ plaintext: text('gen-1') }));

    const staleRevoke = h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 1 });
    const rotate = h.store.rotate({
      ...setInput({ plaintext: text('gen-2') }),
      expectedVersion: 1,
    });
    const results = await Promise.allSettled([staleRevoke, rotate]);

    // 实测：两边都 fulfilled，一次存储级冲突都没触发。
    expect(results.map((item) => item.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(h.records.conflictCount).toBe(0);
    expect(h.records.saveCount).toBe(3); // set + revoke + rotate

    // 最终状态：撤销被覆盖，新凭据活着。
    const metadata = await h.store.metadata(OWNER, KIND);
    expect(metadata.configured).toBe(true);
    expect(metadata.version).toBe(2);
    expect(metadata.revokedAt).toBeUndefined();
    const newRef = await rotate;
    expect(await h.store.read(newRef, 'qca-call')).toEqual(text('gen-2'));

    // 但下面这两条**不是**缺口的一部分，它们在任一裁定下都必须成立，所以单独断言：
    // ① 存储形状不变量没被这次交错破坏；② 第 1 代密文确实销毁了，旧 ref 与「从未存在过」
    // 不可区分 —— 也就是说，即便撤销被吞，它想销毁的那个秘密并没有活下来。
    const stored = await storedOf(h);
    expect(stored.record.configured).toBe(stored.secret !== null);
    const staleFailure = await rejectedError(h.store.read(newSecretRef(), 'qca-call'));
    expect(staleFailure.code).toBe<InfraErrorCode>('SECRET_NOT_CONFIGURED');
  });

  it('secret-store-encrypted-lifecycle: revoke 幂等（不吃假 409）、期望版本错了照样 409、撤销即销毁密文', async () => {
    const h = harness();
    const ref = await h.store.set(setInput({ plaintext: text('to-be-revoked') }));
    expect(h.records.saveCount).toBe(1);

    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 1 });
    expect(h.records.saveCount).toBe(2);
    const metadata = await h.store.metadata(OWNER, KIND);
    expect(metadata.configured).toBe(false);
    // generation 撤销后**不归零**、lastRotatedAt 保留 —— 抹掉它会让一次撤销顺带销毁一条审计事实。
    expect(metadata.version).toBe(1);
    expect(metadata.rotatedAt).toBe(at(0));
    expect(metadata.revokedAt).toBe(at(0));
    // 撤销即销毁密文：库里 secret 必须是 null，不是「留着但读不出来」。
    expect((await storedOf(h)).secret).toBeNull();
    await expect(h.store.read(ref, 'qca-call')).rejects.toThrow('SECRET_NOT_CONFIGURED');

    // 再撤一次：幂等成功，**不改版本、不多写库**。domain 对已经不可用的记录原样返回同一个
    // 对象，此时不写库 —— 否则并发撤销里的一方会吃到假的 409。
    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 1 });
    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 1 });
    expect(h.records.saveCount).toBe(2);
    expect((await h.store.metadata(OWNER, KIND)).version).toBe(1);
    expect(h.records.conflictCount).toBe(0);

    // 期望版本对不上 ⇒ 409，且状态不动（幂等不等于「什么版本都收」）。
    const before = await h.store.metadata(OWNER, KIND);
    await expect(
      h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 2 }),
    ).rejects.toThrow('SECRET_VERSION_CONFLICT');
    await expect(
      h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 0 }),
    ).rejects.toThrow('SECRET_VERSION_CONFLICT');
    // `conflictCount` 保持 0，这不是漏断言：这两次都被 revoke 开头的**前置校验**挡下了，
    // 陈旧写根本没走到记录库那一层 CAS（那一层由上面 rotate vs rotate 那条用例证明会记 1）。
    // 真正要钉住的是「没多写一次库」——`saveCount` 仍是 2，状态逐字节没动。
    expect(h.records.conflictCount).toBe(0);
    expect(await h.store.metadata(OWNER, KIND)).toEqual(before);
    expect(h.records.saveCount).toBe(2);

    // 撤销一个从未配置过的 kind：**实测会落一行规范的空记录**。原因是
    // `revokeSecretRecord(null, …)` 返回一个**新**对象，于是端口里 `current.record === record`
    // 那个幂等短路不成立（`current` 本身就是 null），`#commit` 照常执行；第二次撤销才真短路。
    // 这不判为缺陷：落库形状仍满足 `configured === (secret !== null)`，行数被 kind 的取值域
    // （2 个）天然限死，而且落下的就是那条规范空记录本身。
    //
    // 一个值得钉住的实测细节：domain **不给它盖 `revokedAt`**（实测 `revokedAt: undefined`）——
    // 从不为「从未存在过的凭据」伪造一条审计时间，这是对的。于是 materialize 前后唯一可观测的
    // 差别是 `version: 0`（有一行规范空记录）对 `version: undefined`（什么都没碰过）。
    // 别把这跟「不可区分」那条不变量搞混：那条说的是 **ref 读取**，不是元数据。
    await h.store.revoke({ ownerId: OTHER_OWNER, kind: OTHER_KIND, expectedVersion: 0 });
    expect(h.records.saveCount).toBe(3);
    const materialized = await h.records.load(OTHER_OWNER, OTHER_KIND);
    expect(materialized?.record.configured).toBe(false);
    expect(materialized?.record.revokedAt).toBeNull();
    expect(materialized?.secret).toBeNull();
    expect(await h.store.metadata(OTHER_OWNER, OTHER_KIND)).toEqual({
      configured: false,
      version: 0,
      rotatedAt: undefined,
      revokedAt: undefined,
    });
    // 第二次撤销：这次真短路，一行都不多写。
    await h.store.revoke({ ownerId: OTHER_OWNER, kind: OTHER_KIND, expectedVersion: 0 });
    expect(h.records.saveCount).toBe(3);
    // materialize 之后 generation 是 0，所以 5 是陈旧的 ⇒ 照样 409，且不写库。
    await expect(
      h.store.revoke({ ownerId: OTHER_OWNER, kind: OTHER_KIND, expectedVersion: 5 }),
    ).rejects.toThrow('SECRET_VERSION_CONFLICT');
    expect(h.records.saveCount).toBe(3);
    expect(h.records.conflictCount).toBe(0);
  });

  it('secret-store-encrypted-lifecycle: rotate/revoke 之后旧 ref 立刻不可读，且与「从未存在过」不可区分', async () => {
    const h = harness();
    const firstRef = await h.store.set(setInput({ plaintext: text('gen-1') }));
    const secondRef = await h.store.rotate({
      ...setInput({ plaintext: text('gen-2') }),
      expectedVersion: 1,
    });
    expect(secondRef).not.toBe(firstRef);

    // 旧代立即不可读，新代可读。
    await expect(h.store.read(firstRef, 'qca-call')).rejects.toThrow('SECRET_NOT_CONFIGURED');
    expect(await h.store.read(secondRef, 'qca-call')).toEqual(text('gen-2'));

    // **不可区分**：拿旧 ref 读 与 拿一个从未签发过的 ref 读，内部码与公开码完全相同 ——
    // 否则探测者能用错误差异推断出「这个凭据被换过」（裁定一不变量 1）。
    const staleFailure = await rejectedError(h.store.read(firstRef, 'qca-call'));
    const unknownFailure = await rejectedError(h.store.read(newSecretRef(), 'qca-call'));
    expect(staleFailure).toEqual(unknownFailure);
    expect(staleFailure.code).toBe<InfraErrorCode>('SECRET_NOT_CONFIGURED');
    expect(staleFailure.publicCode).toBe('RESOURCE_NOT_FOUND');

    // 撤销之后同样：当前 ref 也退化成一个普通的「不存在」，与从未存在过无法区分。
    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 2 });
    expect(await rejectedError(h.store.read(secondRef, 'qca-call'))).toEqual(unknownFailure);
    expect((await storedOf(h)).secret).toBeNull();
  });

  it('secret-store-encrypted-lifecycle: purpose 与 kind 不匹配 ⇒ SECRET_PURPOSE_MISMATCH（跨 provider 泄漏在端口层就挡掉）', async () => {
    const h = harness();
    const qcaRef = await h.store.set(setInput({ plaintext: text('qca-value') }));
    const bailianRef = await h.store.set(
      setInput({ kind: OTHER_KIND, plaintext: text('bailian-value') }),
    );

    expect(SECRET_PURPOSES).toEqual(['qca-call', 'bailian-call']);
    expect(purposeOf(KIND)).toBe('qca-call');
    expect(purposeOf(OTHER_KIND)).toBe('bailian-call');

    // 正解：各读各的。
    expect(await h.store.read(qcaRef, 'qca-call')).toEqual(text('qca-value'));
    expect(await h.store.read(bailianRef, 'bailian-call')).toEqual(text('bailian-value'));

    // 把 QCA PAT 当百炼 key 发出去是一次跨 provider 的凭据泄漏。
    const mismatch = await rejectedError(h.store.read(qcaRef, 'bailian-call'));
    expect(mismatch.code).toBe('SECRET_PURPOSE_MISMATCH');
    expect(mismatch.publicCode).toBe('REQUEST_INVALID');
    expect(mismatch.secretKind).toBe(KIND);
    await expect(h.store.read(bailianRef, 'qca-call')).rejects.toThrow('SECRET_PURPOSE_MISMATCH');

    // 反空断言：失败发生在 purpose 判定上，不是因为 ref 找不到（两者的码必须不同）。
    expect(await rejectedCode(h.store.read(newSecretRef(), 'qca-call'))).toBe(
      'SECRET_NOT_CONFIGURED',
    );
    // 被拒的读没有把明文交出去：两条记录的值仍是原样。
    expect(await h.store.read(qcaRef, 'qca-call')).toEqual(text('qca-value'));
    expect(await h.store.read(bailianRef, 'bailian-call')).toEqual(text('bailian-value'));
  });

  it('secret-store-encrypted-lifecycle: 明文长度上下界与冻结契约的 SecretValue 是同一个数字', async () => {
    const h = harness();
    expect(SECRET_PLAINTEXT_MIN_BYTES).toBe(1);
    expect(SECRET_PLAINTEXT_MAX_BYTES).toBe(8192);
    const schema = schemaOf(frozenContract(), 'SecretValue');
    // 端口层与 wire 层在**同一个数字**上失败，而不是 wire 放行 8192、端口再拒一次造成两套语义。
    expect(schema['maxLength']).toBe(SECRET_PLAINTEXT_MAX_BYTES);
    expect(schema['minLength']).toBe(SECRET_PLAINTEXT_MIN_BYTES);

    // 数值边界直接打在校验函数上（负数与 NaN 无法构造成一个真实的 byteLength）。
    for (const bad of [0, -1, 1.5, Number.NaN, SECRET_PLAINTEXT_MAX_BYTES + 1]) {
      expect(() => assertPlaintextLength(bad), `byteLength=${bad}`).toThrow(
        'SECRET_PLAINTEXT_OUT_OF_RANGE',
      );
    }
    expect(() => assertPlaintextLength(1)).not.toThrow();
    expect(() => assertPlaintextLength(SECRET_PLAINTEXT_MAX_BYTES)).not.toThrow();

    // 走端口路径：0 字节与第 8193 个字节都被拒。
    await expect(h.store.set(setInput({ plaintext: new Uint8Array(0) }))).rejects.toThrow(
      'SECRET_PLAINTEXT_OUT_OF_RANGE',
    );
    await expect(
      h.store.set(setInput({ plaintext: new Uint8Array(SECRET_PLAINTEXT_MAX_BYTES + 1) })),
    ).rejects.toThrow('SECRET_PLAINTEXT_OUT_OF_RANGE');
    expect(await h.records.load(OWNER, KIND)).toBeNull();

    // 上界本身必须成功（边界值不是错误），且密文长度等于明文长度。
    const atLimit = bytes(SECRET_PLAINTEXT_MAX_BYTES, 9);
    const ref = await h.store.set(setInput({ plaintext: atLimit }));
    expect(await h.store.read(ref, 'qca-call')).toEqual(atLimit);
    expect(secretOf(await storedOf(h)).ciphertext.byteLength).toBe(SECRET_PLAINTEXT_MAX_BYTES);
    // 另一个 owner 的第 +1 个字节同样失败，且不留半条记录。
    await expect(
      h.store.set(
        setInput({
          ownerId: OTHER_OWNER,
          plaintext: new Uint8Array(SECRET_PLAINTEXT_MAX_BYTES + 1),
        }),
      ),
    ).rejects.toThrow('SECRET_PLAINTEXT_OUT_OF_RANGE');
    expect(await h.records.load(OTHER_OWNER, KIND)).toBeNull();
  });

  it('secret-store-encrypted-lifecycle: 未配置就 rotate ⇒ SECRET_NOT_CONFIGURED，公开码按 kind 分化', async () => {
    const h = harness();
    // rotate 一个从未设置过的密钥是范畴错误（没有「上一代」可失效）—— 不悄悄当成首次写入，
    // 否则 UI 上的「轮换」按钮在空状态下也能点，而它本不该出现。
    const qcaFailure = await rejectedError(h.store.rotate({ ...setInput(), expectedVersion: 0 }));
    expect(qcaFailure.code).toBe('SECRET_NOT_CONFIGURED');
    expect(qcaFailure.secretKind).toBe(KIND);
    // 冻结目录里已经有 QCA_CREDENTIAL_NOT_CONFIGURED / BAILIAN_CREDENTIAL_NOT_CONFIGURED
    // 两个 422，用它们比笼统的 404 更贴合 D1 已冻结的 GET /settings/secrets/{kind} 语义。
    expect(qcaFailure.publicCode).toBe('QCA_CREDENTIAL_NOT_CONFIGURED');

    const bailianFailure = await rejectedError(
      h.store.rotate({ ...setInput({ kind: OTHER_KIND }), expectedVersion: 0 }),
    );
    expect(bailianFailure.publicCode).toBe('BAILIAN_CREDENTIAL_NOT_CONFIGURED');

    // 没带 kind 的同一条内部码退回统一的 404（read 走的就是这条路径）。
    const bare = await rejectedError(h.store.read(newSecretRef(), 'qca-call'));
    expect(bare.code).toBe('SECRET_NOT_CONFIGURED');
    expect(bare.secretKind).toBeUndefined();
    expect(bare.publicCode).toBe('RESOURCE_NOT_FOUND');

    // 撤销之后记录仍在（审计事实保留），但 configured=false、密文为 null。
    await h.store.set(setInput());
    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 1 });
    const revoked = await storedOf(h);
    expect(revoked.record.revokedAt).not.toBeNull();
    expect(revoked.record.configured).toBe(false);
    expect(revoked.secret).toBeNull();
  });

  it('secret-store-encrypted-lifecycle: 不同 owner 的记录互不可见，句柄索引按 owner 归位', async () => {
    const h = harness();
    const aliceRef = await h.store.set(setInput({ plaintext: text('alice-value') }));
    const bobRef = await h.store.set(
      setInput({ ownerId: OTHER_OWNER, plaintext: text('bob-value') }),
    );
    expect(aliceRef).not.toBe(bobRef);

    // 各读各的：findByRef 把句柄解析回**它自己的** owner，AAD 才能对得上。
    expect(await h.store.read(aliceRef, 'qca-call')).toEqual(text('alice-value'));
    expect(await h.store.read(bobRef, 'qca-call')).toEqual(text('bob-value'));

    // 元数据按 (ownerId, kind) 隔离；不存在的 owner 是一条干净的「未配置」。
    expect((await h.store.metadata(OWNER, KIND)).version).toBe(1);
    expect((await h.store.metadata(OTHER_OWNER, KIND)).version).toBe(1);
    expect(await h.store.metadata('owner-nobody', KIND)).toEqual({
      configured: false,
      version: undefined,
      rotatedAt: undefined,
      revokedAt: undefined,
    });

    // 轮换 Alice 不影响 Bob，反之亦然。
    await h.store.rotate({ ...setInput({ plaintext: text('alice-v2') }), expectedVersion: 1 });
    expect((await h.store.metadata(OTHER_OWNER, KIND)).version).toBe(1);
    expect(await h.store.read(bobRef, 'qca-call')).toEqual(text('bob-value'));
    await expect(h.store.read(aliceRef, 'qca-call')).rejects.toThrow('SECRET_NOT_CONFIGURED');

    // ownerId 是记录键的一部分：空 ownerId 在替身层就被拒（否则所有匿名写会撞成一条）。
    await expect(h.records.load('', KIND)).rejects.toThrow('SECRET_CONTEXT_INVALID');
    await expect(
      h.records.save('', { record: unconfiguredStoredSecret(KIND).record, secret: null }, 0),
    ).rejects.toThrow('SECRET_CONTEXT_INVALID');
  });

  it('secret-store-encrypted-lifecycle: 时钟前进体现在 rotatedAt / revokedAt 上，且不依赖真实时间', async () => {
    const h = harness();
    await h.store.set(setInput());
    expect((await h.store.metadata(OWNER, KIND)).rotatedAt).toBe(at(0));

    h.clock.seconds = 3600;
    await h.store.rotate({ ...setInput({ plaintext: text('later-value') }), expectedVersion: 1 });
    const rotated = await h.store.metadata(OWNER, KIND);
    expect(rotated.rotatedAt).toBe(at(3600));
    expect(rotated.version).toBe(2);

    h.clock.seconds = 7200;
    await h.store.revoke({ ownerId: OWNER, kind: KIND, expectedVersion: 2 });
    const revoked = await h.store.metadata(OWNER, KIND);
    expect(revoked.revokedAt).toBe(at(7200));
    expect(revoked.rotatedAt).toBe(at(3600)); // 撤销不抹掉「最后一次轮换」这条审计事实
    expect(revoked.configured).toBe(false);
    // 投影出去只剩 lastRotatedAt：revokedAt 不上线。
    expect(toPublicSecretMetadata(KIND, revoked).lastRotatedAt).toBe(at(3600));
  });

  it('secret-store-encrypted-lifecycle: 句柄形状安全，可以出现在审计日志里', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      const ref = newSecretRef();
      expect(ref).toMatch(/^sec_[0-9a-f]{32}$/);
      // domain 的 parseSecretRef 会跑一遍敏感文本形状检查：三段式点分（JWT 形状）与
      // `token=` 这类查询参数都会被拒，所以句柄里绝不能出现这些字符。
      expect(() => parseSecretRef(ref)).not.toThrow();
      for (const forbidden of ['.', ':', '=', '?', '&', '/', ' ', '\n']) {
        expect(ref.includes(forbidden), `${forbidden} 出现在 ${ref} 里`).toBe(false);
      }
      seen.add(ref);
    }
    // 反空断言：句柄是随机的，不是常量。
    expect(seen.size).toBe(32);
    expect(newSecretRef()).not.toBe(newSecretRef());
  });

  it('secret-store-encrypted-lifecycle: 存储形状不变量 configured === (secret !== null)', async () => {
    const h = harness();
    await h.store.set(setInput({ plaintext: text('shape-probe') }));
    const real = await storedOf(h);
    const secret = secretOf(real);

    // 「configured 但密文是 null」是存储自身的不变量被破坏 —— 必须在写库之前就被挡掉，
    // 而不是等到 read 的时候以一个更难归因的 500 冒出来。
    await expect(h.records.save(OWNER, { record: real.record, secret: null }, 1)).rejects.toThrow(
      'SECRET_DECRYPT_FAILED',
    );
    // 反过来「未配置却留着密文」同样被拒 —— 撤销即销毁。
    await expect(
      h.records.save(OTHER_OWNER, { record: unconfiguredStoredSecret(KIND).record, secret }, 0),
    ).rejects.toThrow('SECRET_DECRYPT_FAILED');
    // 反空断言：形状正确的记录写得进去（否则上面两条红只是因为 save 永远抛）。
    expect(await h.records.save(OWNER, real, 1)).not.toBeNull();
    expect(h.records.saveCount).toBe(2);
  });
});

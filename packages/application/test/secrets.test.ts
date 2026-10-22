/**
 * BYO 凭据四个用例（`usecases/secrets.ts`）的真实测试。
 *
 * ## 这份测试要证明什么，以及为什么朴素的断言是空的
 *
 * 契约对这一组接口的要求不是"能存能取"，而是三条**否定性**事实：
 *
 * 1. **秘密值只进不出。** `PUT` / `:rotate` / `:revoke` 都是 204 无 body，`GET` 只回
 *    `kind` / `configured` / `lastRotatedAt` 三个键（`packages/api-contract/test/schemas.test.ts`
 *    钉死了这个键集合）。要证明这件事，光看返回值"没有 value 字段"是不够的 ——
 *    一个把所有字段都丢掉的实现同样满足它。所以这里的断言是**双向**的：既断言投影
 *    的键集合**恰好**是三个（多了少了都红），也断言整个套件跑完 `SecretAdmin.read`
 *    的调用次数**为 0**（读明文的唯一入口从未被这一层触碰）。
 *
 * 2. **身份先于载荷判定。** 学生调成人配置面必须拿到 `FORBIDDEN_CAPABILITY`，即使他
 *    同时带了一个非法 kind。若顺序反过来，一个无权调用方就能用"哪个 kind 报
 *    `SECRET_KIND_UNSUPPORTED`、哪个报 `FORBIDDEN_CAPABILITY`"当预言机，白拿一份合法
 *    kind 清单。因此第 3 组测试**故意**让学生带一个不存在的 kind，断言错误码仍是
 *    能力错误 —— 这条断言只有在判定顺序正确时才可能绿。
 *
 * 3. **CAS 的期望版本来自同一次请求内的读。** wire 上没有 `expectedVersion` 字段
 *    （`packages/infra/src/ports/secret-store.ts` 文件头逐字说明），所以用例必须先
 *    `metadata()` 再 `rotate()`。这个往返不是装饰：少了它，两个并发的成人配置请求
 *    会读到同一个旧版本，后到的那次静默覆盖先到的那次，`:rotate` 与 `PUT` 的区别
 *    当场消失。第 6 组因此断言 `rotate` 收到的**就是**刚才 `metadata` 返回的那个数字。
 *
 * ## 反面对照（positive control）
 *
 * 内存替身必须**真的会失败**，否则上面所有断言都是对一个永远点头的双胞胎说话。
 * 第一个测试就做这件事：让替身在版本不匹配时抛错，确认它抛了，再确认它抛的是
 * CAS 冲突而不是别的 —— 这样后面"传对了版本所以没抛"才是有意义的绿。
 */
import { describe, expect, it } from 'vitest';
import {
  type AccountSession,
  type SecretKind,
  type SecretRef,
  type Timestamp,
  type User,
  createAccountSession,
  createUser,
  parseLockDurationMinutes,
  parseLoginName,
  parseMaxFailedAttempts,
  parseNickname,
  parseTimestamp,
} from '@littleq/domain';

import { type Actor } from '../src/usecases/authorization.js';
import {
  type InternalSecretMetadata,
  type SecretAdmin,
  type SecretPurpose,
} from '../src/usecases/ports.js';
import {
  encodeSecretValue,
  getSecretMetadataUseCase,
  putSecretUseCase,
  revokeSecretUseCase,
  rotateSecretUseCase,
  toPublicSecretMetadata,
} from '../src/usecases/secrets.js';

// ---------------------------------------------------------------------------
// 事实（全部是常量，不读时钟）
// ---------------------------------------------------------------------------

const NOW: Timestamp = parseTimestamp('2026-10-22T03:04:05.000Z');
const ROTATED_AT: Timestamp = parseTimestamp('2026-10-20T09:00:00.000Z');

const LOCK_POLICY = {
  maxFailedAttempts: parseMaxFailedAttempts(5),
  lockDurationMinutes: parseLockDurationMinutes(30),
};

const OWNER_ID = '0198c0a1-0000-7000-8000-000000000001';
const STUDENT_ID = '0198c0a1-0000-7000-8000-000000000002';

function ownerUser(): User {
  return createUser({
    id: OWNER_ID,
    role: 'OWNER',
    loginName: parseLoginName('adult'),
    nickname: parseNickname('成人'),
    ageBand: null,
    status: 'ACTIVE',
    ownerId: null,
    lockPolicy: LOCK_POLICY,
    revision: '1',
  });
}

function studentUser(): User {
  return createUser({
    id: STUDENT_ID,
    role: 'STUDENT',
    loginName: parseLoginName('kid'),
    nickname: parseNickname('学生'),
    ageBand: 'L1',
    status: 'ACTIVE',
    ownerId: OWNER_ID,
    lockPolicy: LOCK_POLICY,
    revision: '1',
  });
}

function activeSession(userId: string): AccountSession {
  return createAccountSession({
    id: '0198c0a1-1111-7000-8000-000000000001',
    userId,
    status: 'ACTIVE',
    rememberMe: false,
    issuedAt: NOW,
    lastSeenAt: NOW,
    idleExpiresAt: parseTimestamp('2026-10-22T03:34:05.000Z'),
    absoluteExpiresAt: parseTimestamp('2026-10-29T03:04:05.000Z'),
    revokedAt: null,
    revocationReason: null,
  });
}

function ownerActor(): Actor {
  const user = ownerUser();
  return { user, session: activeSession(user.id) };
}

function studentActor(): Actor {
  const user = studentUser();
  return { user, session: activeSession(user.id) };
}

// ---------------------------------------------------------------------------
// 内存替身
// ---------------------------------------------------------------------------

interface Call {
  readonly method: 'metadata' | 'set' | 'rotate' | 'revoke' | 'read';
  readonly ownerId?: string;
  readonly kind?: string;
  readonly expectedVersion?: number;
}

/**
 * `SecretAdmin` 的内存实现。
 *
 * 它**会失败**：版本不匹配抛 `SECRET_VERSION_CONFLICT`、已配置再 `set` 异值抛
 * `SECRET_ALREADY_CONFIGURED` —— 与 infra 的 `EncryptedSecretStore` 同一套错误码，
 * 因为应用层刻意不翻译它们（`usecases/ports.ts` 里 `SecretAdmin` 的注释）。
 */
class FakeSecretAdmin implements SecretAdmin {
  readonly calls: Call[] = [];
  /** 每个 (ownerId, kind) 一行的内部状态。 */
  private readonly rows = new Map<string, InternalSecretMetadata>();
  /** 让 `read` 一旦被调用就能被数出来；它的返回值故意是哨兵，不是真明文。 */
  readCallCount = 0;
  /** 用于反面对照：把 CAS 判定关掉，替身就会对任何版本点头。 */
  enforceCas = true;

  private key(ownerId: string, kind: SecretKind): string {
    return `${ownerId}\u0000${kind}`;
  }

  private record(call: Call): void {
    this.calls.push(call);
  }

  /** 测试用的直接置位：绕过所有用例，只为搭出前置事实。 */
  seed(ownerId: string, kind: SecretKind, meta: InternalSecretMetadata): void {
    this.rows.set(this.key(ownerId, kind), meta);
  }

  row(ownerId: string, kind: SecretKind): InternalSecretMetadata | undefined {
    return this.rows.get(this.key(ownerId, kind));
  }

  callsOf(method: Call['method']): readonly Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  async metadata(ownerId: string, kind: SecretKind): Promise<InternalSecretMetadata> {
    this.record({ method: 'metadata', ownerId, kind });
    return (
      this.rows.get(this.key(ownerId, kind)) ?? {
        configured: false,
        version: undefined,
        rotatedAt: undefined,
        revokedAt: undefined,
      }
    );
  }

  async set(input: {
    ownerId: string;
    kind: SecretKind;
    plaintext: Uint8Array;
  }): Promise<SecretRef> {
    this.record({ method: 'set', ownerId: input.ownerId, kind: input.kind });
    const existing = this.rows.get(this.key(input.ownerId, input.kind));
    if (existing?.configured) {
      throw new SecretStoreFailure('SECRET_ALREADY_CONFIGURED');
    }
    const next: InternalSecretMetadata = {
      configured: true,
      version: (existing?.version ?? 0) + 1,
      rotatedAt: undefined,
      revokedAt: undefined,
    };
    this.rows.set(this.key(input.ownerId, input.kind), next);
    return `sec_${'0'.repeat(32)}` as SecretRef;
  }

  async rotate(input: {
    ownerId: string;
    kind: SecretKind;
    plaintext: Uint8Array;
    expectedVersion: number;
  }): Promise<SecretRef> {
    this.record({
      method: 'rotate',
      ownerId: input.ownerId,
      kind: input.kind,
      expectedVersion: input.expectedVersion,
    });
    const existing = this.rows.get(this.key(input.ownerId, input.kind));
    if (!existing?.configured) throw new SecretStoreFailure('SECRET_NOT_CONFIGURED');
    if (this.enforceCas && existing.version !== input.expectedVersion) {
      throw new SecretStoreFailure('SECRET_VERSION_CONFLICT');
    }
    this.rows.set(this.key(input.ownerId, input.kind), {
      configured: true,
      version: (existing.version ?? 0) + 1,
      rotatedAt: NOW,
      revokedAt: undefined,
    });
    return `sec_${'1'.repeat(32)}` as SecretRef;
  }

  async revoke(input: {
    ownerId: string;
    kind: SecretKind;
    expectedVersion: number;
  }): Promise<void> {
    this.record({
      method: 'revoke',
      ownerId: input.ownerId,
      kind: input.kind,
      expectedVersion: input.expectedVersion,
    });
    const existing = this.rows.get(this.key(input.ownerId, input.kind));
    if (!existing) throw new SecretStoreFailure('SECRET_NOT_CONFIGURED');
    if (this.enforceCas && existing.version !== input.expectedVersion) {
      throw new SecretStoreFailure('SECRET_VERSION_CONFLICT');
    }
    // domain 的 `SecretRecord` 不变量 (4)：吊销后 `configured === false`，
    // 而 generation **不回零**、`lastRotatedAt` **保留**（`operations.ts` 的 `:revoke`）。
    this.rows.set(this.key(input.ownerId, input.kind), {
      configured: false,
      version: existing.version,
      rotatedAt: existing.rotatedAt,
      revokedAt: NOW,
    });
  }

  async read(_ref: SecretRef, _purpose: SecretPurpose): Promise<Uint8Array> {
    this.readCallCount += 1;
    this.record({ method: 'read' });
    return new TextEncoder().encode('SENTINEL-PLAINTEXT-MUST-NEVER-BE-REQUESTED');
  }
}

/** 下层错误。应用层不翻译它，原样穿透到组合根的封套映射。 */
class SecretStoreFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function configured(version: number): InternalSecretMetadata {
  return { configured: true, version, rotatedAt: ROTATED_AT, revokedAt: undefined };
}

async function expectDomainError(
  run: () => Promise<unknown>,
  code: string,
): Promise<{ code: string; valueObject: string | undefined }> {
  try {
    await run();
  } catch (error) {
    const err = error as { code?: string; valueObject?: string };
    expect(err.code).toBe(code);
    return { code: err.code ?? '', valueObject: err.valueObject };
  }
  throw new Error(`expected DomainError(${code}) but the call resolved`);
}

// ---------------------------------------------------------------------------
// 0. 反面对照：替身真的会失败
// ---------------------------------------------------------------------------

describe('FakeSecretAdmin 反面对照', () => {
  it('版本不匹配时替身抛 CAS 冲突，而不是点头', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', configured(3));

    await expect(
      secrets.rotate({
        ownerId: OWNER_ID,
        kind: 'QCA_PAT',
        plaintext: encodeSecretValue('replacement-token'),
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: 'SECRET_VERSION_CONFLICT' });

    // 同一份事实、版本对上 ⇒ 不抛。两半合起来才说明"没抛"是判定结果，不是替身失灵。
    await expect(
      secrets.rotate({
        ownerId: OWNER_ID,
        kind: 'QCA_PAT',
        plaintext: encodeSecretValue('replacement-token'),
        expectedVersion: 3,
      }),
    ).resolves.toBeDefined();
  });

  it('已配置再首配异值 ⇒ SECRET_ALREADY_CONFIGURED（不静默覆盖）', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', configured(1));
    await expect(
      secrets.set({ ownerId: OWNER_ID, kind: 'QCA_PAT', plaintext: encodeSecretValue('v') }),
    ).rejects.toMatchObject({ code: 'SECRET_ALREADY_CONFIGURED' });
  });
});

// ---------------------------------------------------------------------------
// 1. GET：投影恰好三个键，且不含内部 generation
// ---------------------------------------------------------------------------

describe('getSecretMetadataUseCase', () => {
  it('投影的键集合恰好是契约那三个（多一个都红）', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', configured(7));

    const dto = await getSecretMetadataUseCase(
      { secrets },
      { actor: ownerActor(), kind: 'QCA_PAT' },
    );

    expect(Object.keys(dto).sort()).toEqual(['configured', 'kind', 'lastRotatedAt']);
    expect(dto).toEqual({ kind: 'QCA_PAT', configured: true, lastRotatedAt: ROTATED_AT });
    // 内部 generation 与吊销时刻**不上线**（`InternalSecretMetadata.version` 的注释）。
    expect(JSON.stringify(dto)).not.toContain('version');
    expect(JSON.stringify(dto)).not.toContain('revokedAt');
    expect(JSON.stringify(dto)).not.toContain('sec_');
  });

  it('未配置时 lastRotatedAt 是 null 而不是 undefined（键必须在）', async () => {
    const secrets = new FakeSecretAdmin();
    const dto = await getSecretMetadataUseCase(
      { secrets },
      { actor: ownerActor(), kind: 'BAILIAN_API_KEY' },
    );
    expect('lastRotatedAt' in dto).toBe(true);
    expect(dto.lastRotatedAt).toBeNull();
    expect(dto.configured).toBe(false);
  });

  it('学生调成人配置面 ⇒ FORBIDDEN_CAPABILITY，且身份判定先于 kind 解析', async () => {
    const secrets = new FakeSecretAdmin();
    // 故意带一个不存在的 kind：若顺序反了，这里会得到 SECRET_KIND_UNSUPPORTED。
    await expectDomainError(
      () => getSecretMetadataUseCase({ secrets }, { actor: studentActor(), kind: 'NOT_A_KIND' }),
      'FORBIDDEN_CAPABILITY',
    );
    // 无权调用方连"这个 kind 合法吗"都不该问出来 ⇒ 存储一次都没被碰。
    expect(secrets.calls).toHaveLength(0);
  });

  it('成人带未知 kind ⇒ SECRET_KIND_UNSUPPORTED，不退化成 REQUEST_INVALID', async () => {
    const secrets = new FakeSecretAdmin();
    const { valueObject } = await expectDomainError(
      () => getSecretMetadataUseCase({ secrets }, { actor: ownerActor(), kind: 'OPENAI_KEY' }),
      'SECRET_KIND_UNSUPPORTED',
    );
    expect(valueObject).toBe('SecretKind');
    expect(secrets.calls).toHaveLength(0);
  });

  it('凭据归属取成人自己的 id（学生名下没有凭据）', async () => {
    const secrets = new FakeSecretAdmin();
    await getSecretMetadataUseCase({ secrets }, { actor: ownerActor(), kind: 'QCA_PAT' });
    expect(secrets.callsOf('metadata')[0]).toMatchObject({ ownerId: OWNER_ID, kind: 'QCA_PAT' });
  });
});

// ---------------------------------------------------------------------------
// 2. PUT：204 无回显
// ---------------------------------------------------------------------------

describe('putSecretUseCase', () => {
  it('返回 undefined（契约是 204 无 body），且从不读明文', async () => {
    const secrets = new FakeSecretAdmin();
    const result = await putSecretUseCase(
      { secrets },
      { actor: ownerActor(), kind: 'QCA_PAT', plaintext: encodeSecretValue('pat-value') },
    );
    expect(result).toBeUndefined();
    expect(secrets.readCallCount).toBe(0);
    expect(secrets.callsOf('set')[0]).toMatchObject({ ownerId: OWNER_ID, kind: 'QCA_PAT' });
  });

  it('已配置再首配 ⇒ 下层错误原样穿透，应用层不翻译成自己的类型', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', configured(1));
    await expect(
      putSecretUseCase(
        { secrets },
        { actor: ownerActor(), kind: 'QCA_PAT', plaintext: encodeSecretValue('other') },
      ),
    ).rejects.toMatchObject({ code: 'SECRET_ALREADY_CONFIGURED' });
  });

  it('学生调 ⇒ FORBIDDEN_CAPABILITY，存储零调用', async () => {
    const secrets = new FakeSecretAdmin();
    await expectDomainError(
      () =>
        // kind 与载荷都完全合法：红的理由只能是身份。
        putSecretUseCase(
          { secrets },
          { actor: studentActor(), kind: 'QCA_PAT', plaintext: encodeSecretValue('pat') },
        ),
      'FORBIDDEN_CAPABILITY',
    );
    expect(secrets.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. :rotate —— CAS 的期望版本来自同一次请求内的读
// ---------------------------------------------------------------------------

describe('rotateSecretUseCase', () => {
  it('先读 metadata，再把读到的那个版本当 expectedVersion 传下去', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', configured(3));

    const result = await rotateSecretUseCase(
      { secrets },
      { actor: ownerActor(), kind: 'QCA_PAT', plaintext: encodeSecretValue('rotated') },
    );

    expect(result).toBeUndefined();
    // 顺序：metadata 必须在 rotate 之前（否则 expectedVersion 无从取得）。
    expect(secrets.calls.map((c) => c.method)).toEqual(['metadata', 'rotate']);
    expect(secrets.callsOf('rotate')[0]).toMatchObject({
      ownerId: OWNER_ID,
      kind: 'QCA_PAT',
      expectedVersion: 3,
    });
  });

  it('未配置就轮换 ⇒ REQUEST_INVALID，且不触碰存储的 rotate', async () => {
    const secrets = new FakeSecretAdmin();
    const { valueObject } = await expectDomainError(
      () =>
        rotateSecretUseCase(
          { secrets },
          { actor: ownerActor(), kind: 'QCA_PAT', plaintext: encodeSecretValue('x') },
        ),
      'REQUEST_INVALID',
    );
    expect(valueObject).toBe('SecretRecord.configured[QCA_PAT]');
    expect(secrets.callsOf('rotate')).toHaveLength(0);
  });

  it('configured 为真但内部 version 缺失 ⇒ INTERNAL_ERROR（行自身不自洽）', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', {
      configured: true,
      version: undefined,
      rotatedAt: ROTATED_AT,
      revokedAt: undefined,
    });
    await expectDomainError(
      () =>
        rotateSecretUseCase(
          { secrets },
          { actor: ownerActor(), kind: 'QCA_PAT', plaintext: encodeSecretValue('x') },
        ),
      'INTERNAL_ERROR',
    );
    expect(secrets.callsOf('rotate')).toHaveLength(0);
  });

  it('并发覆盖会被 CAS 拦住：版本对不上就红（替身 enforceCas 打开）', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', configured(3));
    // 模拟"另一个请求刚刚轮换过"：用例读到 3，落库时行已经是 4。
    const original = secrets.rotate.bind(secrets);
    let flipped = false;
    secrets.rotate = async (input) => {
      if (!flipped) {
        flipped = true;
        secrets.seed(OWNER_ID, 'QCA_PAT', configured(4));
      }
      return original(input);
    };
    await expect(
      rotateSecretUseCase(
        { secrets },
        { actor: ownerActor(), kind: 'QCA_PAT', plaintext: encodeSecretValue('late') },
      ),
    ).rejects.toMatchObject({ code: 'SECRET_VERSION_CONFLICT' });
  });
});

// ---------------------------------------------------------------------------
// 4. :revoke —— 幂等有**两个**不同的分支
// ---------------------------------------------------------------------------

describe('revokeSecretUseCase', () => {
  it('从未写过 ⇒ 直接返回，一次存储调用都不发（不臆造 expectedVersion 0）', async () => {
    const secrets = new FakeSecretAdmin();
    const result = await revokeSecretUseCase({ secrets }, { actor: ownerActor(), kind: 'QCA_PAT' });
    expect(result).toBeUndefined();
    // 只允许那次 metadata 读；revoke 本身不该发生。
    expect(secrets.calls.map((c) => c.method)).toEqual(['metadata']);
    expect(secrets.callsOf('revoke')).toHaveLength(0);
  });

  it('写过又已吊销 ⇒ 仍然带着读到的版本调 revoke，CAS 继续保护并发的 :rotate', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', {
      configured: false,
      version: 2,
      rotatedAt: ROTATED_AT,
      revokedAt: NOW,
    });
    const result = await revokeSecretUseCase({ secrets }, { actor: ownerActor(), kind: 'QCA_PAT' });
    expect(result).toBeUndefined();
    expect(secrets.callsOf('revoke')[0]).toMatchObject({
      ownerId: OWNER_ID,
      kind: 'QCA_PAT',
      expectedVersion: 2,
    });
    // domain `SecretRecord` 不变量 (4) + `operations.ts` 的 `:revoke`：
    // 吊销后 configured 为假，而 generation 与 lastRotatedAt **保留**。
    const after = secrets.row(OWNER_ID, 'QCA_PAT');
    expect(after).toMatchObject({ configured: false, version: 2, rotatedAt: ROTATED_AT });
  });

  it('已配置 ⇒ 吊销成功，且投影随后是 configured:false + 保留的 lastRotatedAt', async () => {
    const secrets = new FakeSecretAdmin();
    secrets.seed(OWNER_ID, 'QCA_PAT', configured(5));
    await revokeSecretUseCase({ secrets }, { actor: ownerActor(), kind: 'QCA_PAT' });

    const dto = await getSecretMetadataUseCase(
      { secrets },
      { actor: ownerActor(), kind: 'QCA_PAT' },
    );
    expect(dto).toEqual({ kind: 'QCA_PAT', configured: false, lastRotatedAt: ROTATED_AT });
    expect(secrets.readCallCount).toBe(0);
  });

  it('学生调 ⇒ FORBIDDEN_CAPABILITY，存储零调用', async () => {
    const secrets = new FakeSecretAdmin();
    await expectDomainError(
      () => revokeSecretUseCase({ secrets }, { actor: studentActor(), kind: 'QCA_PAT' }),
      'FORBIDDEN_CAPABILITY',
    );
    expect(secrets.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. 投影纯函数本身
// ---------------------------------------------------------------------------

describe('toPublicSecretMetadata', () => {
  it('rotatedAt 缺失 ⇒ lastRotatedAt 为 null（契约是 nullable，不是 optional）', () => {
    const dto = toPublicSecretMetadata('QCA_PAT', {
      configured: false,
      version: 1,
      rotatedAt: undefined,
      revokedAt: NOW,
    });
    expect(dto.lastRotatedAt).toBeNull();
    expect('lastRotatedAt' in dto).toBe(true);
    expect(Object.keys(dto).sort()).toEqual(['configured', 'kind', 'lastRotatedAt']);
  });
});

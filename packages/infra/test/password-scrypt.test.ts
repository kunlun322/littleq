/**
 * §1.3 口令基线的钉子：Node 异步 scrypt，salt 16 随机字节，N=32768/r=8/p=1，输出 64 字节，
 * maxmem 64MiB，参数随记录保存，校验用 `timingSafeEqual`，不引入密码库。
 *
 * ## 这一层为什么全是确定性断言
 * 口令哈希不碰数据库、不碰时钟、不碰环境变量，所以它属于 Layer A（见 `migrations.test.ts`
 * 的头注释）：没有 Postgres 也照样执行、照样红。真库里 `password_credentials` 的读写往返
 * 在 Layer B 的 `postgres-bootstrap-accounts.test.ts` 里验。
 *
 * ## 固件里没有凭据值
 * §8：「测试固件不保存凭据值」。所以本文件的每个口令都在运行时用 `randomBytes` 现生成，
 * 不写字面量；连"太短"/"太长"这两个边界探测值也是从随机口令切出来的，不是硬编码字符串。
 * 断言只比较**相等/不相等**与**形状**，从不打印口令、salt 或哈希的内容。
 *
 * ## 「参数随记录保存」是用一个独立实现交叉验证的
 * 只断言 `record.scryptN === 32768` 证明不了记录里存的哈希**真是**那组参数算出来的 ——
 * 换成别的 KDF 而保留同名字段，那条断言依然绿。所以这里用 `node:crypto` 直接按 §1.3 的
 * 参数重算一遍，逐字节比对 `hashPassword` 的输出。算法换了、参数没换，这条会红。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@littleq/domain';
import { isInfraError } from '../src/errors.js';
import {
  PASSWORD_HASH_BYTES,
  PASSWORD_SALT_BYTES,
  SCRYPT_MAXMEM_BYTES,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  baselineScryptParams,
  hashPassword,
  verifyPassword,
  type PasswordCredentialRecord,
} from '../src/password/scrypt.js';

/** 每次调用都产生一个新口令。不落到固件里，也不打印。 */
function randomPassword(): string {
  return randomBytes(24).toString('base64');
}

/** 按 §1.3 的参数独立重算，用来交叉验证 `hashPassword` 存进记录的确实是 scrypt 输出。 */
function independentDerive(
  plaintext: string,
  salt: Uint8Array,
  keyLength: number,
  params: { readonly n: number; readonly r: number; readonly p: number },
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(plaintext, 'utf8'),
      salt,
      keyLength,
      { N: params.n, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM_BYTES },
      (error, key) => (error !== null ? reject(error) : resolve(new Uint8Array(key))),
    );
  });
}

/** 取一个断言用的错误码；不是 InfraError 就让用例红在这里，而不是红在后面的比较上。 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(isInfraError(error), `期望 InfraError，实际 ${String(error)}`).toBe(true);
  return isInfraError(error) ? error.code : '';
}

describe('§1.3 基线参数', () => {
  it('salt 16 字节、输出 64 字节、N=32768/r=8/p=1', () => {
    expect(PASSWORD_SALT_BYTES).toBe(16);
    expect(PASSWORD_HASH_BYTES).toBe(64);
    expect(SCRYPT_N).toBe(32_768);
    expect(SCRYPT_R).toBe(8);
    expect(SCRYPT_P).toBe(1);
    expect(baselineScryptParams()).toEqual({ n: 32_768, r: 8, p: 1, hashBytes: 64 });
  });

  it('N 是 2 的幂（scrypt 的硬性要求，不是风格选择）', () => {
    expect(SCRYPT_N > 1 && (SCRYPT_N & (SCRYPT_N - 1)) === 0).toBe(true);
  });

  it('maxmem 恰好是 scrypt 所需内存的 2 倍 —— 64MiB 是下限，不是余量', () => {
    // scrypt 的内存开销是 128·N·r。32768·8·128 = 32MiB，正好等于 Node 的默认 maxmem，
    // 而 Node 要求严格大于 ⇒ 不给 maxmem 就跑不起来（下一条用例实测这件事）。
    expect(128 * SCRYPT_N * SCRYPT_R).toBe(32 * 1024 * 1024);
    expect(SCRYPT_MAXMEM_BYTES).toBe(2 * 128 * SCRYPT_N * SCRYPT_R);
  });

  it('负对照：不传 maxmem 时，基线参数在 Node 下直接被拒', async () => {
    // 这条钉住的是「64MiB 不是装饰性常量」。删掉 maxmem 或调小它，本模块就跑不起来了，
    // 而失败信息（memory limit exceeded）不会告诉后来的人该填多少。
    //
    // 实测细节：Node 在**派发到线程池之前**同步校验参数，所以这个失败是同步 `throw`，
    // 不走回调的 error 分支。两条路径都要接住，否则测试自己会被这个 RangeError 掀翻。
    const outcome: unknown = await (async () => {
      try {
        return await new Promise<unknown>((resolve, reject) => {
          scrypt(
            Buffer.from(randomPassword(), 'utf8'),
            randomBytes(PASSWORD_SALT_BYTES),
            PASSWORD_HASH_BYTES,
            { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
            (error, key) => (error !== null ? reject(error) : resolve(key)),
          );
        });
      } catch (error) {
        return error;
      }
    })();
    expect(outcome).toBeInstanceOf(RangeError);
    expect((outcome as NodeJS.ErrnoException).code).toBe('ERR_CRYPTO_INVALID_SCRYPT_PARAMS');
  });

  it('正对照：同一组参数给了 64MiB 就能算出来', async () => {
    const key = await independentDerive(randomPassword(), randomBytes(PASSWORD_SALT_BYTES), 64, {
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    expect(key).toHaveLength(PASSWORD_HASH_BYTES);
  });
});

describe('hashPassword / verifyPassword 往返', () => {
  it('正对照：正确的口令校验通过', async () => {
    const password = randomPassword();
    const record = await hashPassword(password);
    await expect(verifyPassword(password, record)).resolves.toBe(true);
  });

  it('负对照：错的口令校验不通过，且是 false 而不是抛错', async () => {
    const record = await hashPassword(randomPassword());
    // 「返回 false」和「抛异常」的区别是外部可观测的：抛异常会让登录端点 500，
    // 而 §5.3 要求登录失败与口令错误给出同一个响应。
    await expect(verifyPassword(randomPassword(), record)).resolves.toBe(false);
  });

  it('记录里的 salt / 哈希长度与基线一致，且参数被完整保存', async () => {
    const record = await hashPassword(randomPassword());
    expect(record.salt).toHaveLength(PASSWORD_SALT_BYTES);
    expect(record.passwordHash).toHaveLength(PASSWORD_HASH_BYTES);
    expect(record.scryptN).toBe(SCRYPT_N);
    expect(record.scryptR).toBe(SCRYPT_R);
    expect(record.scryptP).toBe(SCRYPT_P);
    expect(record.hashBytes).toBe(PASSWORD_HASH_BYTES);
  });

  it('记录里的哈希就是按 §1.3 参数独立重算的结果', async () => {
    const password = randomPassword();
    const record = await hashPassword(password);
    const expected = await independentDerive(password, record.salt, record.hashBytes, {
      n: record.scryptN,
      r: record.scryptR,
      p: record.scryptP,
    });
    expect(expected).toHaveLength(record.passwordHash.length);
    expect(timingSafeEqual(expected, record.passwordHash)).toBe(true);
  });

  it('同一口令两次哈希得到不同 salt 与不同哈希（salt 是随机的，不是口令的函数）', async () => {
    const password = randomPassword();
    const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
    expect(timingSafeEqual(first.salt, second.salt)).toBe(false);
    expect(timingSafeEqual(first.passwordHash, second.passwordHash)).toBe(false);
    // 但两条记录都能各自校验通过 —— salt 不同不等于口令不同。
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword(password, second)).resolves.toBe(true);
  });

  it('相同 salt 与参数下派生是确定的（证明它是 KDF，不是随机数）', async () => {
    const password = randomPassword();
    const record = await hashPassword(password);
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const [a, b] = await Promise.all([
      independentDerive(password, new Uint8Array(salt), 64, {
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      }),
      independentDerive(password, new Uint8Array(salt), 64, {
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      }),
    ]);
    expect(timingSafeEqual(a, b)).toBe(true);
    expect(timingSafeEqual(a, record.passwordHash)).toBe(false);
  });
});

describe('校验用记录自带的参数，不是模块常量', () => {
  it('一个用别的合法参数派生的记录能校验通过', async () => {
    // 「参数随记录保存」的全部意义在这里：将来提高 N，老记录仍须能登录。
    // 若 verify 用的是模块常量，这条会返回 false。
    const password = randomPassword();
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const derived = await independentDerive(password, new Uint8Array(salt), 64, {
      n: 1024,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    const legacy: PasswordCredentialRecord = {
      salt: new Uint8Array(salt),
      passwordHash: derived,
      scryptN: 1024,
      scryptR: SCRYPT_R,
      scryptP: SCRYPT_P,
      hashBytes: 64,
    };
    await expect(verifyPassword(password, legacy)).resolves.toBe(true);
    await expect(verifyPassword(randomPassword(), legacy)).resolves.toBe(false);
  });

  it('负对照：把记录里的 N 改掉，同一口令就不再通过', async () => {
    const password = randomPassword();
    const record = await hashPassword(password);
    const tampered: PasswordCredentialRecord = { ...record, scryptN: 1024 };
    await expect(verifyPassword(password, tampered)).resolves.toBe(false);
  });

  it('负对照：改一个哈希字节就不通过', async () => {
    const password = randomPassword();
    const record = await hashPassword(password);
    const flipped = Uint8Array.from(record.passwordHash);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await expect(verifyPassword(password, { ...record, passwordHash: flipped })).resolves.toBe(
      false,
    );
  });

  it('负对照：换一个 salt 就不通过', async () => {
    const password = randomPassword();
    const record = await hashPassword(password);
    const otherSalt = randomBytes(PASSWORD_SALT_BYTES);
    await expect(
      verifyPassword(password, { ...record, salt: new Uint8Array(otherSalt) }),
    ).resolves.toBe(false);
  });
});

describe('口令长度边界（domain 的 8..128）', () => {
  it('负对照：太短被拒，公开码是 REQUEST_INVALID', async () => {
    const tooShort = randomPassword().slice(0, 7);
    expect(tooShort).toHaveLength(7);
    expect(await codeOf(hashPassword(tooShort))).toBe('PASSWORD_OUT_OF_RANGE');
  });

  it('负对照：太长被拒', async () => {
    const tooLong = randomPassword().repeat(5);
    expect(tooLong.length).toBeGreaterThan(128);
    expect(await codeOf(hashPassword(tooLong))).toBe('PASSWORD_OUT_OF_RANGE');
  });

  it('边界取自 domain，不是 infra 自己另写一组数字', async () => {
    // 用 domain 的常量生成探测值：若 infra 私自放宽或收紧了边界，这条会红。
    // 不写死 8 与 128 —— 那样两处数字各自漂移时测试反而看不出问题。
    const at = (length: number): string => randomPassword().repeat(length).slice(0, length);
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);

    expect(await codeOf(hashPassword(at(PASSWORD_MIN_LENGTH - 1)))).toBe('PASSWORD_OUT_OF_RANGE');
    expect(await codeOf(hashPassword(at(PASSWORD_MAX_LENGTH + 1)))).toBe('PASSWORD_OUT_OF_RANGE');

    // 正对照：合法长度的两端都能真的算出记录，且能通过校验。
    for (const length of [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]) {
      const password = at(length);
      const record = await hashPassword(password);
      expect(record.passwordHash, `长度 ${length}`).toHaveLength(PASSWORD_HASH_BYTES);
      await expect(verifyPassword(password, record), `长度 ${length}`).resolves.toBe(true);
    }
  });

  it('空口令被拒，且拒绝发生在派生之前（不付 scrypt 的代价）', async () => {
    // 顺序本身是代码事实（`assertPasswordLength` 是 `hashPassword` 的第一句），
    // 这里只钉住可观测的那一半：空串给出的是口令码，而不是 crypto 的原生错误。
    expect(await codeOf(hashPassword(''))).toBe('PASSWORD_OUT_OF_RANGE');
  });

  it('verify 也检查长度，且映射到同一个公开码', async () => {
    const record = await hashPassword(randomPassword());
    expect(await codeOf(verifyPassword(randomPassword().slice(0, 7), record))).toBe(
      'PASSWORD_OUT_OF_RANGE',
    );
    const error: unknown = await verifyPassword('', record).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(isInfraError(error) ? error.publicCode : '').toBe('REQUEST_INVALID');
  });
});

describe('畸形记录被拒成 STORED_ROW_INCONSISTENT，不是原生异常', () => {
  /**
   * 数据库是信任边界：能写这一行的人不必改代码。所以读回来的参数必须校验，
   * 否则一个存坏的 N 会把一次登录变成一次 OOM，一个存坏的 hashBytes 会让
   * `timingSafeEqual` 抛 `RangeError` —— 也就是把"校验失败"变成"登录端点 500"，
   * 而那是外部可触发的。
   */
  async function validRecord(): Promise<PasswordCredentialRecord> {
    return hashPassword(randomPassword());
  }

  it('负对照：hashBytes 与实际长度不符', async () => {
    const record = await validRecord();
    expect(await codeOf(verifyPassword(randomPassword(), { ...record, hashBytes: 32 }))).toBe(
      'STORED_ROW_INCONSISTENT',
    );
  });

  it('负对照：N 不是 2 的幂', async () => {
    const record = await validRecord();
    expect(await codeOf(verifyPassword(randomPassword(), { ...record, scryptN: 3000 }))).toBe(
      'STORED_ROW_INCONSISTENT',
    );
  });

  it('负对照：N 大到会耗尽内存', async () => {
    const record = await validRecord();
    // 2^20 在允许的上界内，但 128·N·r = 1GiB 远超 maxmem ⇒ 必须被读侧挡住，
    // 不能等到 scrypt 真的去申请内存。
    expect(await codeOf(verifyPassword(randomPassword(), { ...record, scryptN: 2 ** 20 }))).toBe(
      'STORED_ROW_INCONSISTENT',
    );
  });

  it('负对照：r / p 越界，参数不是整数，salt 或哈希为空', async () => {
    const record = await validRecord();
    const cases: readonly (readonly [string, PasswordCredentialRecord])[] = [
      ['r=0', { ...record, scryptR: 0 }],
      ['r=33', { ...record, scryptR: 33 }],
      ['p=0', { ...record, scryptP: 0 }],
      ['p=17', { ...record, scryptP: 17 }],
      ['N=1.5', { ...record, scryptN: 1.5 }],
      ['N=NaN', { ...record, scryptN: Number.NaN }],
      ['hashBytes=0', { ...record, hashBytes: 0 }],
      ['空 salt', { ...record, salt: new Uint8Array(0) }],
      ['空哈希', { ...record, passwordHash: new Uint8Array(0), hashBytes: 0 }],
    ];
    // 正对照：这组用例本身非空，且原始记录是合法的。
    expect(cases.length).toBe(9);
    await expect(verifyPassword(randomPassword(), record)).resolves.toBe(false);
    for (const [label, tampered] of cases) {
      expect(await codeOf(verifyPassword(randomPassword(), tampered)), label).toBe(
        'STORED_ROW_INCONSISTENT',
      );
    }
  });

  it('负对照：salt 不是 Uint8Array（例如驱动直接给了 string）', async () => {
    const record = await validRecord();
    const wrong = { ...record, salt: 'not-bytes' } as unknown as PasswordCredentialRecord;
    expect(await codeOf(verifyPassword(randomPassword(), wrong))).toBe('STORED_ROW_INCONSISTENT');
  });
});

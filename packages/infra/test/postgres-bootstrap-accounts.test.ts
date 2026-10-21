/**
 * §1.3 口令基线 + §4 第 7 项「受控初始化命令」在**真库**上的验收（ZLQ-220 §7.1）。
 *
 * ## 这个文件里没有一个字面量口令
 *
 * §1.3 逐字禁止「把口令放命令行、脚本、fixture、issue 或截图」。测试口令一律用
 * `node:crypto` 现场随机生成、只存在于本次运行的进程内存里，跑完即弃。这不是洁癖：
 * 一个写死的 fixture 口令会被后来的人当成"测试专用、无所谓"，而同一个文件里紧挨着的
 * 断言正在证明"明文不进任何持久化通道"——两处并存会让读者以为前者是例外。
 *
 * ## 为什么必须真库
 *
 * 「建号 + 写校验材料在一个事务里」这条性质，内存替身证明不了：替身的事务是数组的
 * push/pop，回滚就是截断，而真库要验的是**外键次序**（`password_credentials.user_id`
 * → `users(id)`、`users.owner_id` → `users(id)`）与**已写行真的消失了**。B 组第 7 个
 * 用例刻意让失败发生在两条 INSERT **之后**，就是为了让"回滚"有东西可回滚。
 *
 * ## 申报：`LOGIN_NAME_TAKEN` 在串行路径上不可达
 *
 * `assertDatabaseEmpty` 先跑，`users` 非空即拒；而它为空时不可能有任何登录名被占。
 * 所以那条码只服务于**并发**（两个操作者同时跑本工具），单元测试无法在不引入竞态的
 * 前提下到达它。B 组最后一个用例钉住的是**次序**（非空库 + 撞名 ⇒ 报的是
 * `ACCOUNTS_ALREADY_EXIST` 而不是 `LOGIN_NAME_TAKEN`），并顺带申报：真并发下先到的
 * 一方提交后，后到的一方吃到的其实是 `login_name_key` 上的原始 23505，而不是这条码
 * ——本层没有 blanket SQL 错误映射（§4.1）。这不是缺陷，是那条码的实际可达范围比
 * 它的名字看起来窄，交给 PM 记录。
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  createUser,
  parseLockDurationMinutes,
  parseLoginName,
  parseMaxFailedAttempts,
  parseNickname,
} from '@littleq/domain';

import {
  BOOTSTRAP_REFUSAL_REASONS,
  BootstrapRefused,
  FORBIDDEN_PASSWORD_ENV_VARS,
  bootstrapAccounts,
  parseArgv,
  type BootstrapAccountsInput,
  type SecretReader,
} from '../src/init/bootstrap-accounts.js';
import { baselineScryptParams, verifyPassword } from '../src/password/scrypt.js';
import {
  PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
  USER_COUNT_SQL,
  USER_INSERT_SQL,
  USER_SELECT_BY_ID_SQL,
  credentialFromRow,
  userFromRow,
  userInsertParams,
  type PasswordCredentialRow,
  type UserRow,
} from '../src/sql/account-rows.js';
import { newUuidV7 } from '../src/sql/uuidv7.js';

import { stripComments } from './support.js';
import {
  createTestDatabaseHarness,
  queryHarness,
  type TestDatabaseHarness,
} from './support-database.js';

import { afterAll, describe, expect, it } from 'vitest';

/** 探针：只用来判断本机有没有可达的 Postgres，从而决定 B 组是跑还是**响亮地** skip。 */
const probe = await createTestDatabaseHarness();

afterAll(async () => {
  // 探针库全程不写，但必须收掉：留一个库在那儿，会让下一轮"迁移建出了全部表"的断言
  // 在一个已经建好的库上通过 —— 那是个假绿。
  await probe?.dispose();
});

/** 现场生成的测试口令，长度 24（在 8–128 之内），base64url 无空白、无控制字符。 */
function testPassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * 按脚本依次吐出值的替身读口令器。
 *
 * 脚本用完还再读就**抛**，而不是返回 `undefined`：一次多余的读取意味着实现悄悄多问了
 * 一遍口令，那是要被发现的行为变化，不该被一个宽容的替身吞掉。
 */
function scriptedSecretReader(values: readonly string[]): {
  readonly read: SecretReader;
  readonly prompts: string[];
} {
  const prompts: string[] = [];
  let index = 0;
  const read: SecretReader = async (prompt) => {
    prompts.push(prompt);
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error(`替身被读了第 ${index} 次，脚本只有 ${values.length} 个值`);
    }
    return value;
  };
  return { read, prompts };
}

function bootstrapInput(overrides: Partial<BootstrapAccountsInput> = {}): BootstrapAccountsInput {
  return {
    ownerLoginName: 'owner',
    ownerNickname: '成人账号',
    studentLoginName: 'student',
    studentNickname: '学生账号',
    studentAgeBand: 'L1',
    lockPolicy: {
      maxFailedAttempts: parseMaxFailedAttempts(5),
      lockDurationMinutes: parseLockDurationMinutes(15),
    },
    ...overrides,
  };
}

/** 每个用例一个**全新的空库**：`bootstrapAccounts` 的前置条件就是 `users` 为空。 */
async function withMigratedDatabase<T>(
  run: (harness: TestDatabaseHarness) => Promise<T>,
): Promise<T> {
  const harness = await createTestDatabaseHarness();
  if (harness === null) throw new Error('B 组需要可达的 Postgres；skipIf 应当已经跳过本用例');
  try {
    await harness.adapter.migrate();
    return await run(harness);
  } finally {
    await harness.dispose();
  }
}

async function userCount(harness: TestDatabaseHarness): Promise<string> {
  const rows = await queryHarness<{ readonly total: unknown }>(harness, USER_COUNT_SQL);
  const [row] = rows;
  return row === undefined ? '' : String(row.total);
}

/** 抛出的 `BootstrapRefused` 的 reason；不是这个类型就把原异常抛出去（让失败信息可读）。 */
async function captureRefusal(run: () => Promise<unknown>): Promise<string> {
  const error = await run().then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof BootstrapRefused)) {
    throw new Error(`期望 BootstrapRefused，实际是 ${String(error)}`);
  }
  return error.reason;
}

/**
 * A9/A10 的扫描形状。
 *
 * 刻意容忍空白与尾逗号，因为源码扫描型守卫与格式化器天然冲突：`printWidth: 100` 一旦装不下，
 * prettier 就会把 `new BootstrapRefused('PASSWORD_TOO_MANY_ATTEMPTS')` 拆成三行，而一个用
 * `includes` 写的守卫会因此**假红** —— 那是「不是缺陷的红」，最难排查的一类。
 *
 * 理由名全部落在 `[A-Z_]` 内（见 `BOOTSTRAP_REFUSAL_REASONS` 的字面量类型），所以直接插值
 * 进正则不需要转义；若以后允许别的字符，这里必须先转义。
 */
function throwPattern(reason: string): RegExp {
  return new RegExp(`new\\s+BootstrapRefused\\(\\s*'${reason}'\\s*,?\\s*\\)`);
}

const REQUIRED_FLAGS = [
  '--owner-login',
  'owner',
  '--owner-nickname',
  '成人账号',
  '--student-login',
  'student',
  '--student-nickname',
  '学生账号',
  '--student-age-band',
  'L1',
] as const;

describe('A 组 · CLI 层的结构性拒绝（不需要数据库）', () => {
  it('A1 · `--password=…` 被拒绝，且拒绝信息里不含传入的值', () => {
    const secret = testPassword();
    const error = (() => {
      try {
        parseArgv([...REQUIRED_FLAGS, `--password=${secret}`]);
        return null;
      } catch (cause) {
        return cause as Error;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    const message = error?.message ?? '';
    expect(message).toContain('命令行');
    // §8：不打值、不打前后缀。拒绝信息本身也不能变成一条泄漏通道。
    expect(message).not.toContain(secret);
    expect(message).not.toContain(secret.slice(0, 4));
  });

  it('A2 · 裸 `--owner-password` 与 `--student-password=` 两种写法都被拒绝', () => {
    expect(() => parseArgv([...REQUIRED_FLAGS, '--owner-password'])).toThrow(/命令行/);
    expect(() => parseArgv([...REQUIRED_FLAGS, '--student-password=x'])).toThrow(/命令行/);
  });

  it('A3 · 拒绝口令类 argv 的检查跑在「缺少参数」之前', () => {
    // 只给一半必填参数 + 一个口令参数：报的必须是"口令不能经命令行"，而不是"缺少参数"。
    // 次序反了的话，操作者会先看到一条与真正问题无关的提示，然后可能把口令改从环境变量传。
    expect(() => parseArgv(['--owner-login', 'owner', '--password=x'])).toThrow(/命令行/);
  });

  it('A4 · 五个必填参数缺任何一个都在提示里被点名', () => {
    const error = (() => {
      try {
        parseArgv(['--owner-login', 'owner']);
        return null;
      } catch (cause) {
        return cause as Error;
      }
    })();
    const message = error?.message ?? '';
    expect(message).toContain('缺少参数');
    for (const flag of [
      '--owner-nickname',
      '--student-login',
      '--student-nickname',
      '--student-age-band',
    ]) {
      expect(message).toContain(flag);
    }
  });

  it('A5 · `--migrate-only` 不要求任何必填参数', () => {
    const options = parseArgv(['--migrate-only']);
    expect(options.migrateOnly).toBe(true);
  });

  it('A6 · 全部参数给齐时映射正确，锁定策略取默认 5 次 / 15 分钟', () => {
    const options = parseArgv([...REQUIRED_FLAGS]);
    expect(options.migrateOnly).toBe(false);
    expect(options.input.ownerLoginName).toBe('owner');
    expect(options.input.studentLoginName).toBe('student');
    expect(options.input.studentAgeBand).toBe('L1');
    expect(options.input.lockPolicy).toEqual({
      maxFailedAttempts: parseMaxFailedAttempts(5),
      lockDurationMinutes: parseLockDurationMinutes(15),
    });
  });

  it('A7 · 锁定策略可经命令行覆盖，且仍走 domain 的解析器', () => {
    const options = parseArgv([
      ...REQUIRED_FLAGS,
      '--max-failed-attempts',
      '3',
      '--lock-duration-minutes',
      '30',
    ]);
    expect(options.input.lockPolicy).toEqual({
      maxFailedAttempts: parseMaxFailedAttempts(3),
      lockDurationMinutes: parseLockDurationMinutes(30),
    });
  });

  it('A8 · 被拒的口令类环境变量是**封闭的三个名字**，不做 /PASSWORD/i 全表扫描', () => {
    expect([...FORBIDDEN_PASSWORD_ENV_VARS]).toEqual([
      'LITTLEQ_PASSWORD',
      'LITTLEQ_OWNER_PASSWORD',
      'LITTLEQ_STUDENT_PASSWORD',
    ]);
    // 全表扫描会撞上 CI 的 GITHUB_PASSWORD、驱动自己的 PGPASSWORD，让工具在一台完全正常的
    // 机器上拒绝启动 —— 而"拒绝启动"是个没有任何诊断信息的死路。这条断言钉住那个取舍。
    expect(FORBIDDEN_PASSWORD_ENV_VARS.some((name) => !name.startsWith('LITTLEQ_'))).toBe(false);
  });

  it('A9 · 每个声明的拒绝理由都真的有一处抛出它（源码扫描守卫）', async () => {
    const source = stripComments(
      await readFile(
        fileURLToPath(new URL('../src/init/bootstrap-accounts.ts', import.meta.url)),
        'utf8',
      ),
    );
    for (const reason of BOOTSTRAP_REFUSAL_REASONS) {
      const thrown = throwPattern(reason).test(source);
      // 失败方向是安全的：以后新增一个理由却不抛它，这里立刻红。
      expect(thrown, `声明了 ${reason} 但源码里没有任何一处抛出它`).toBe(true);
    }
  });

  it('A10 · A9 的正对照：一个编造的理由确实扫不到', async () => {
    const source = stripComments(
      await readFile(
        fileURLToPath(new URL('../src/init/bootstrap-accounts.ts', import.meta.url)),
        'utf8',
      ),
    );
    expect(throwPattern('SUCH_REASON_DOES_NOT_EXIST').test(source)).toBe(false);
    // 再证一次扫描器不是恒真：每个真实理由都命中，而编造的那个命中数为 0。
    for (const reason of BOOTSTRAP_REFUSAL_REASONS) {
      expect(throwPattern(reason).test(source)).toBe(true);
    }
    // 把「容忍拆行」从假设变成实测：prettier 拆出来的两种形状都必须命中，
    // 否则上面的容忍只是写在了注释里。
    expect(throwPattern('R').test("new BootstrapRefused('R')")).toBe(true);
    expect(throwPattern('R').test("throw new BootstrapRefused(\n  'R',\n)")).toBe(true);
    expect(throwPattern('R').test("new BootstrapRefused('RX')")).toBe(false);
    // 划清分工：`throwPattern` **不**负责剥注释，那是 `stripComments` 的事（A9/A10 都先剥再扫）。
    // 钉住这一点，是为了让「删掉 stripComments」这种看似无害的简化立刻暴露 —— 少了它，
    // docstring 里提到某个理由名就会被当成「抛过」，一道真红会变成假绿。
    expect(throwPattern('R').test("// new BootstrapRefused('R')")).toBe(true);
  });

  it('A11 · `BootstrapRefused` 的 message **就是** reason，且没有能携带原文的字段', () => {
    const closed: readonly string[] = ['BootstrapRefused', ...BOOTSTRAP_REFUSAL_REASONS];
    for (const reason of BOOTSTRAP_REFUSAL_REASONS) {
      const error = new BootstrapRefused(reason);
      expect(error.message).toBe(reason);
      expect(error.name).toBe('BootstrapRefused');
      expect(error).toBeInstanceOf(Error);
      expect(error.reason).toBe(reason);
      // `this.name = …` 也是一个自有可枚举属性，所以键集是 name + reason 两个。
      const keys = Object.keys(error).sort();
      expect(keys).toEqual(['name', 'reason']);
      // 真正的断言在这里：每个自有属性的值都取自一个**封闭集合**，于是类上没有任何字段
      // 可以夹带口令原文 —— 这条性质不依赖每个 throw 点都记得只传枚举。
      for (const key of keys) {
        const value = (error as unknown as Record<string, unknown>)[key];
        expect(typeof value, `自有属性 ${key} 不是字符串`).toBe('string');
        expect(closed.includes(value as string), `自有属性 ${key} 的值不在封闭集合里`).toBe(true);
      }
    }
  });
});

describe.skipIf(probe === null)('B 组 · 真库上的建号与口令校验材料', () => {
  it('B1 · 成功路径：一个事务里建出成人与学生，学生挂在成人下面，两份校验材料都在', async () => {
    await withMigratedDatabase(async (harness) => {
      const password = testPassword();
      const { read } = scriptedSecretReader([password, password, password, password]);
      const result = await bootstrapAccounts(harness.adapter, bootstrapInput(), read);

      expect(await userCount(harness)).toBe('2');

      const ownerRows = await queryHarness<UserRow>(harness, USER_SELECT_BY_ID_SQL, [
        result.ownerId,
      ]);
      const studentRows = await queryHarness<UserRow>(harness, USER_SELECT_BY_ID_SQL, [
        result.studentId,
      ]);
      expect(ownerRows.length).toBe(1);
      expect(studentRows.length).toBe(1);
      const owner = userFromRow(ownerRows[0]!);
      const student = userFromRow(studentRows[0]!);
      expect(owner.role).toBe('OWNER');
      expect(student.role).toBe('STUDENT');
      expect(owner.ownerId).toBeNull();
      expect(student.ownerId).toBe(result.ownerId);
      expect(owner.loginName).toBe('owner');
      expect(student.loginName).toBe('student');
      // §3.2 的 CHECK (revision > 0)：新实体的首个已持久化 revision 是 1。
      expect(owner.revision).toBe('1');
      expect(student.revision).toBe('1');

      for (const userId of [result.ownerId, result.studentId]) {
        const rows = await queryHarness<PasswordCredentialRow>(
          harness,
          PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
          [userId],
        );
        expect(rows.length, `user ${userId} 缺校验材料`).toBe(1);
      }
    });
  });

  it('B2 · 库里的校验材料能真的校验口令，错口令一律 false', async () => {
    await withMigratedDatabase(async (harness) => {
      const ownerPassword = testPassword();
      const studentPassword = testPassword();
      const { read } = scriptedSecretReader([
        ownerPassword,
        ownerPassword,
        studentPassword,
        studentPassword,
      ]);
      const result = await bootstrapAccounts(harness.adapter, bootstrapInput(), read);

      for (const [userId, password] of [
        [result.ownerId, ownerPassword],
        [result.studentId, studentPassword],
      ] as const) {
        const rows = await queryHarness<PasswordCredentialRow>(
          harness,
          PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
          [userId],
        );
        const record = credentialFromRow(rows[0]!);
        await expect(verifyPassword(password, record)).resolves.toBe(true);
        await expect(verifyPassword(testPassword(), record)).resolves.toBe(false);
        // 两个账号的口令互换必须失败：证明校验材料没有串号。
        const other = userId === result.ownerId ? studentPassword : ownerPassword;
        await expect(verifyPassword(other, record)).resolves.toBe(false);
      }
    });
  });

  it('B3 · §1.3 的四元组随记录保存，读回来的就是基线值', async () => {
    await withMigratedDatabase(async (harness) => {
      const password = testPassword();
      const { read } = scriptedSecretReader([password, password, password, password]);
      const result = await bootstrapAccounts(harness.adapter, bootstrapInput(), read);
      const rows = await queryHarness<PasswordCredentialRow>(
        harness,
        PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
        [result.ownerId],
      );
      const record = credentialFromRow(rows[0]!);
      expect(record.scryptN).toBe(baselineScryptParams().n);
      expect(record.scryptR).toBe(baselineScryptParams().r);
      expect(record.scryptP).toBe(baselineScryptParams().p);
      expect(record.hashBytes).toBe(baselineScryptParams().hashBytes);
      expect(record.scryptN).toBe(32_768);
      expect(record.scryptR).toBe(8);
      expect(record.scryptP).toBe(1);
      expect(record.hashBytes).toBe(64);
      expect(record.salt.byteLength).toBe(16);
      expect(record.passwordHash.byteLength).toBe(64);
    });
  });

  it('B4 · 两个账号用同一个口令时，salt 与哈希都不同（salt 随机且不可注入）', async () => {
    await withMigratedDatabase(async (harness) => {
      const shared = testPassword();
      const { read } = scriptedSecretReader([shared, shared, shared, shared]);
      const result = await bootstrapAccounts(harness.adapter, bootstrapInput(), read);
      const records: string[] = [];
      for (const userId of [result.ownerId, result.studentId]) {
        const rows = await queryHarness<PasswordCredentialRow>(
          harness,
          PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
          [userId],
        );
        const record = credentialFromRow(rows[0]!);
        records.push(
          `${Buffer.from(record.salt).toString('hex')}|${Buffer.from(record.passwordHash).toString('hex')}`,
        );
      }
      const [first, second] = records;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first).not.toBe(second);
      expect(first?.split('|')[0]).not.toBe(second?.split('|')[0]);
      expect(first?.split('|')[1]).not.toBe(second?.split('|')[1]);
    });
  });

  it('B5 · 成功结果的键集是封闭的四个，且序列化后不含任何秘密材料', async () => {
    await withMigratedDatabase(async (harness) => {
      const password = testPassword();
      const { read } = scriptedSecretReader([password, password, password, password]);
      const result = await bootstrapAccounts(harness.adapter, bootstrapInput(), read);

      expect(Object.keys(result).sort()).toEqual([
        'ownerId',
        'ownerLoginName',
        'studentId',
        'studentLoginName',
      ]);

      const rows = await queryHarness<PasswordCredentialRow>(
        harness,
        PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
        [result.ownerId],
      );
      const record = credentialFromRow(rows[0]!);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(password);
      expect(serialized).not.toContain(Buffer.from(record.salt).toString('hex'));
      expect(serialized).not.toContain(Buffer.from(record.passwordHash).toString('hex'));
    });
  });

  it('B6 · 库里存的既不是明文、也不是明文的可搜索片段', async () => {
    await withMigratedDatabase(async (harness) => {
      const password = testPassword();
      const { read } = scriptedSecretReader([password, password, password, password]);
      const result = await bootstrapAccounts(harness.adapter, bootstrapInput(), read);
      const rows = await queryHarness<PasswordCredentialRow>(
        harness,
        PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
        [result.ownerId],
      );
      const record = credentialFromRow(rows[0]!);
      const plaintext = Buffer.from(password, 'utf8');
      expect(Buffer.from(record.passwordHash).includes(plaintext)).toBe(false);
      expect(Buffer.from(record.salt).includes(plaintext)).toBe(false);
      expect(Buffer.from(record.passwordHash).toString('utf8')).not.toContain(password);
      // 正对照：证明 includes 这把尺子不是恒假的 —— 拿明文自己去找明文，必须找得到。
      expect(plaintext.includes(plaintext)).toBe(true);
      expect(Buffer.concat([plaintext, plaintext]).includes(plaintext)).toBe(true);
    });
  });

  it('B7 · 两个账号自己撞名 ⇒ LOGIN_NAME_SELF_COLLISION，且**一次口令都没读**', async () => {
    await withMigratedDatabase(async (harness) => {
      const { read, prompts } = scriptedSecretReader([]);
      const reason = await captureRefusal(() =>
        bootstrapAccounts(harness.adapter, bootstrapInput({ studentLoginName: 'owner' }), read),
      );
      expect(reason).toBe('LOGIN_NAME_SELF_COLLISION');
      // 这条才是重点：便宜的校验排在读口令之前，所以操作者不会先输两遍口令再被告知
      // 命令行写错了。脚本是空的，任何一次读取都会让替身抛。
      expect(prompts.length).toBe(0);
      expect(await userCount(harness)).toBe('0');
    });
  });

  it('B7b · 撞名判定按 loginNameKey，所以 `Owner` 与 `owner` 也算撞名', async () => {
    await withMigratedDatabase(async (harness) => {
      const { read, prompts } = scriptedSecretReader([]);
      const reason = await captureRefusal(() =>
        bootstrapAccounts(
          harness.adapter,
          bootstrapInput({ ownerLoginName: 'Owner', studentLoginName: 'owner' }),
          read,
        ),
      );
      expect(reason).toBe('LOGIN_NAME_SELF_COLLISION');
      expect(prompts.length).toBe(0);
      expect(await userCount(harness)).toBe('0');
      // 反证：这条不是"任何输入都被拒"—— 同一组参数换个不撞名的学生登录名就成功。
      const password = testPassword();
      const ok = scriptedSecretReader([password, password, password, password]);
      const result = await bootstrapAccounts(
        harness.adapter,
        bootstrapInput({ ownerLoginName: 'Owner', studentLoginName: 'student' }),
        ok.read,
      );
      expect(result.ownerLoginName).toBe('Owner');
      expect(await userCount(harness)).toBe('2');
    });
  });

  it('B7c · 事务里已写的行在后续语句失败时真的回滚（用生产 INSERT 语句）', async () => {
    await withMigratedDatabase(async (harness) => {
      const ownerId = newUuidV7();
      const owner = createUser({
        id: ownerId,
        role: 'OWNER',
        loginName: parseLoginName('owner'),
        nickname: parseNickname('成人账号'),
        ageBand: null,
        status: 'ACTIVE',
        ownerId: null,
        lockPolicy: {
          maxFailedAttempts: parseMaxFailedAttempts(5),
          lockDurationMinutes: parseLockDurationMinutes(15),
        },
        revision: '1',
      });
      await expect(
        harness.adapter.transaction(async (tx) => {
          await tx.execute(USER_INSERT_SQL, userInsertParams(owner));
          // 同一个 id 再插一次：主键冲突。此刻事务里已经有一行了。
          await tx.execute(USER_INSERT_SQL, userInsertParams(owner));
        }),
      ).rejects.toThrow(/duplicate key/);
      expect(await userCount(harness)).toBe('0');
      const credentialRows = await queryHarness<{ readonly total: unknown }>(
        harness,
        'SELECT COUNT(*)::bigint AS total FROM password_credentials',
      );
      expect(String(credentialRows[0]?.total)).toBe('0');
    });
  });

  it('B8 · 第二次运行拒绝且不覆盖：ACCOUNTS_ALREADY_EXIST，原账号仍能校验', async () => {
    await withMigratedDatabase(async (harness) => {
      const ownerPassword = testPassword();
      const studentPassword = testPassword();
      const first = scriptedSecretReader([
        ownerPassword,
        ownerPassword,
        studentPassword,
        studentPassword,
      ]);
      const result = await bootstrapAccounts(harness.adapter, bootstrapInput(), first.read);

      const secondPassword = testPassword();
      const second = scriptedSecretReader([
        secondPassword,
        secondPassword,
        secondPassword,
        secondPassword,
      ]);
      const reason = await captureRefusal(() =>
        bootstrapAccounts(harness.adapter, bootstrapInput(), second.read),
      );
      expect(reason).toBe('ACCOUNTS_ALREADY_EXIST');
      expect(await userCount(harness)).toBe('2');

      // 覆盖会连带作废原账号的全部会话与项目归属，所以"没被覆盖"要验到能校验为止。
      const rows = await queryHarness<PasswordCredentialRow>(
        harness,
        PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
        [result.ownerId],
      );
      const record = credentialFromRow(rows[0]!);
      await expect(verifyPassword(ownerPassword, record)).resolves.toBe(true);
      await expect(verifyPassword(secondPassword, record)).resolves.toBe(false);
    });
  });

  it('B9 · 三次两次输入不一致 ⇒ PASSWORD_TOO_MANY_ATTEMPTS，且库里一行都没有', async () => {
    await withMigratedDatabase(async (harness) => {
      const { read, prompts } = scriptedSecretReader([
        testPassword(),
        testPassword(),
        testPassword(),
        testPassword(),
        testPassword(),
        testPassword(),
      ]);
      const reason = await captureRefusal(() =>
        bootstrapAccounts(harness.adapter, bootstrapInput(), read),
      );
      expect(reason).toBe('PASSWORD_TOO_MANY_ATTEMPTS');
      expect(prompts.length).toBe(6);
      expect(await userCount(harness)).toBe('0');
    });
  });

  it('B10 · 三次长度不合法 ⇒ PASSWORD_TOO_MANY_ATTEMPTS，提示只说边界不回显输入', async () => {
    await withMigratedDatabase(async (harness) => {
      const tooShort = 'a'.repeat(7);
      const { read, prompts } = scriptedSecretReader([
        tooShort,
        tooShort,
        tooShort,
        tooShort,
        tooShort,
        tooShort,
      ]);
      const reason = await captureRefusal(() =>
        bootstrapAccounts(harness.adapter, bootstrapInput(), read),
      );
      expect(reason).toBe('PASSWORD_TOO_MANY_ATTEMPTS');
      expect(prompts.length).toBe(6);
      expect(await userCount(harness)).toBe('0');
      for (const prompt of prompts) expect(prompt).not.toContain(tooShort);
    });
  });

  it('B11 · 前两次不一致、第三次成功 ⇒ 建号成功（重试循环是真的，不是摆设）', async () => {
    await withMigratedDatabase(async (harness) => {
      const ownerPassword = testPassword();
      const studentPassword = testPassword();
      const { read, prompts } = scriptedSecretReader([
        ownerPassword,
        testPassword(), // 第一次：两次不一致
        ownerPassword,
        testPassword(), // 第二次：又不一致
        ownerPassword,
        ownerPassword, // 第三次：一致，通过
        studentPassword,
        studentPassword,
      ]);
      const result = await bootstrapAccounts(harness.adapter, bootstrapInput(), read);
      expect(prompts.length).toBe(8);
      expect(await userCount(harness)).toBe('2');
      const rows = await queryHarness<PasswordCredentialRow>(
        harness,
        PASSWORD_CREDENTIAL_SELECT_BY_USER_ID_SQL,
        [result.ownerId],
      );
      await expect(verifyPassword(ownerPassword, credentialFromRow(rows[0]!))).resolves.toBe(true);
    });
  });

  it('B12 · 检查次序：非空库 + 撞名 ⇒ 报的是 ACCOUNTS_ALREADY_EXIST', async () => {
    await withMigratedDatabase(async (harness) => {
      const password = testPassword();
      const first = scriptedSecretReader([password, password, password, password]);
      await bootstrapAccounts(harness.adapter, bootstrapInput(), first.read);

      const second = scriptedSecretReader([password, password, password, password]);
      const reason = await captureRefusal(() =>
        bootstrapAccounts(harness.adapter, bootstrapInput(), second.read),
      );
      // 这一条同时是文件头那处申报的证据：LOGIN_NAME_TAKEN 在串行路径上到不了。
      expect(reason).toBe('ACCOUNTS_ALREADY_EXIST');
      expect(reason).not.toBe('LOGIN_NAME_TAKEN');
      expect(await userCount(harness)).toBe('2');
    });
  });

  it('B13 · 隐藏输入的提示语是固定文案，不含任何输入内容', async () => {
    await withMigratedDatabase(async (harness) => {
      const password = testPassword();
      const { read, prompts } = scriptedSecretReader([password, password, password, password]);
      await bootstrapAccounts(harness.adapter, bootstrapInput(), read);
      // 两次 readConfirmedSecret（成人、学生），每次两遍（输入 + 确认）。
      expect(prompts.length).toBe(4);
      for (const prompt of prompts) {
        // 提示语会打到 stdout，所以它不能是"请确认 xxxx"这种把上一次输入回显出来的形状。
        expect(prompt).not.toContain(password);
        expect(prompt).toMatch(/口令/);
        expect(prompt).toMatch(/不回显|再输入一次/);
      }
      expect(prompts.filter((prompt) => prompt.includes('不回显')).length).toBe(2);
      expect(prompts.filter((prompt) => prompt.includes('再输入一次')).length).toBe(2);
    });
  });
});

/**
 * 受控初始化命令（ZLQ-216 §1.3 / §4 第 7 项）。
 *
 * 一条命令做两件事：**跑迁移**（`PostgresDatabaseAdapter.migrate()`，幂等、advisory lock
 * 互斥、按版本/checksum 判定），以及**开出成人（OWNER）与学生（STUDENT）两个账号连同各自的
 * scrypt 校验材料**，全部在一个事务里。
 *
 * ## 口令只有一个入口：隐藏输入
 *
 * §1.3 逐字：「用户/授权操作者通过**交互式隐藏输入**设置成人及学生口令；**不把口令放
 * 命令行、脚本、fixture、issue 或截图**。」本文件把这句话做成了三条结构性拒绝，而不是
 * 一句文档里的提醒：
 *
 * 1. **没有 TTY 就不启动。** 非交互意味着口令只可能来自管道、重定向或脚本 —— 那正是
 *    被禁的通道。`process.stdin.isTTY !== true` 时直接退出，不给"那就退化成明文读一行"
 *    的余地。
 * 2. **`stty -echo` 失败就不读。** 关掉回显失败却继续读，等于把口令打印到终端（以及任何
 *    正在录屏/采集 stdout 的东西）上。宁可拒绝服务，不可悄悄降级。
 * 3. **显式拒绝口令类的 argv 与环境变量。** `--password=…` 会被认出并拒绝；
 *    `LITTLEQ_PASSWORD` / `LITTLEQ_OWNER_PASSWORD` / `LITTLEQ_STUDENT_PASSWORD` 若被设置，
 *    启动即失败 —— 静默忽略会让操作者以为那条通道生效了，而库里其实是一份他没输入过的
 *    口令（或根本没有口令）。
 *
 * ## 打印出来的东西里没有秘密
 *
 * 成功时只打印两个 user id 与两个登录名。salt、哈希、哈希长度、口令长度一律不打印
 * （§8：「不打值、不打前后缀、不打完整长度、不打 hash 全文」）。失败时打印的是
 * `BootstrapRefusalReason` —— 一个封闭枚举，没有任何可以携带原文的字段，与 `InfraError`
 * 同构。
 *
 * ## 已存在就拒绝，不覆盖
 *
 * `users` 非空即退出（`ACCOUNTS_ALREADY_EXIST`），登录名撞车也退出（`LOGIN_NAME_TAKEN`）。
 * 覆盖一个已有账号会连带作废它的全部会话与项目归属，而这条命令的使用场景（首次部署）根本
 * 不需要那个能力。**不提供 `--force`**：需要重置时应该由人直接操作数据库，那是一次有意识
 * 的、留下痕迹的动作，而不是一个 flag。
 *
 * ## 交付前提（§1.3 逐字，不是本单能自证的事）
 *
 * 「当前没有证明 applesoft 能运行本机命令，也没有证明存在可交付密码的私密通道。PM 必须
 * 安排用户可用的受控终端/已授权私密初始化方式；安排不到就不能声称用户已能登录，不可把
 * 密码补到公开评论解决。」所以本工具的存在**不等于**用户已能登录：它需要一次由人在受控
 * 终端上的交互执行，而那次执行有没有发生、由谁做，只有 PM 与用户能确认。
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  createUser,
  loginNameKey,
  parseAgeBand,
  parseLockDurationMinutes,
  parseLoginName,
  parseMaxFailedAttempts,
  parseNickname,
  type AccountLockPolicy,
  type User,
} from '@littleq/domain';

import { hashPassword } from '../password/scrypt.js';
import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';
import {
  PASSWORD_CREDENTIAL_INSERT_SQL,
  USER_COUNT_SQL,
  USER_INSERT_SQL,
  USER_SELECT_BY_LOGIN_NAME_KEY_SQL,
  credentialInsertParams,
  userInsertParams,
  type UserRow,
} from '../sql/account-rows.js';
import { PostgresDatabaseAdapter } from '../sql/postgres-adapter.js';
import { createPgClientSource } from '../sql/sources.js';
import { newUuidV7 } from '../sql/uuidv7.js';

/** 部署期秘密。不落日志、不进错误消息、不写迁移 SQL（§3.2）。 */
export const DATABASE_URL_ENV_VAR = 'LITTLEQ_DATABASE_URL';

/**
 * 被显式拒绝的口令类环境变量。
 *
 * 只列**本工具可能被误用的那三个名字**，不做 `/PASSWORD/i` 的全表扫描：后者会撞上部署
 * 环境里与 LittleQ 毫无关系的变量（CI 的 `GITHUB_PASSWORD`、数据库自己的 `PGPASSWORD`），
 * 让工具在一个完全正常的机器上拒绝启动，而"拒绝启动"是个没有任何诊断信息的死路。
 */
const FORBIDDEN_PASSWORD_ENV_VARS = [
  'LITTLEQ_PASSWORD',
  'LITTLEQ_OWNER_PASSWORD',
  'LITTLEQ_STUDENT_PASSWORD',
] as const;

const FORBIDDEN_PASSWORD_ARG_PATTERN = /^--(?:owner-|student-)?password(?:=|$)/;

/** 非秘密的输入。登录名/昵称不是秘密，放命令行不违反 §1.3（被禁的只有口令）。 */
export type BootstrapAccountsInput = {
  readonly ownerLoginName: string;
  readonly ownerNickname: string;
  readonly studentLoginName: string;
  readonly studentNickname: string;
  readonly studentAgeBand: string;
  readonly lockPolicy: AccountLockPolicy;
};

/** 成功结果。**不含任何秘密**：没有 salt、没有哈希、没有口令。 */
export type BootstrapAccountsResult = {
  readonly ownerId: string;
  readonly studentId: string;
  readonly ownerLoginName: string;
  readonly studentLoginName: string;
};

export const BOOTSTRAP_REFUSAL_REASONS = [
  /** `users` 已经有行：本工具只做首次初始化。 */
  'ACCOUNTS_ALREADY_EXIST',
  /** 两个登录名之一（按 `lower()` 判定）已存在。 */
  'LOGIN_NAME_TAKEN',
  /** 两次输入不一致。 */
  'PASSWORD_CONFIRM_MISMATCH',
  /** 连续三次不一致或长度不合法：放弃，不让它变成一次离线爆破式的反复尝试。 */
  'PASSWORD_TOO_MANY_ATTEMPTS',
] as const;

export type BootstrapRefusalReason = (typeof BOOTSTRAP_REFUSAL_REASONS)[number];

/**
 * 与 `InfraError` 同构的结构性保证：`message` **就是** reason，类上没有任何可以携带原文的
 * 字段。所以"拒绝原因不落秘密"不依赖每个 `throw` 点记得只传枚举。
 */
export class BootstrapRefused extends Error {
  readonly reason: BootstrapRefusalReason;

  constructor(reason: BootstrapRefusalReason) {
    super(reason);
    this.name = 'BootstrapRefused';
    this.reason = reason;
  }
}

/** 读一次秘密输入。CLI 传隐藏输入的实现；测试传一个字面量函数，不碰 TTY。 */
export type SecretReader = (prompt: string) => Promise<string>;

const MAX_PASSWORD_ATTEMPTS = 3;

/**
 * 读入口令并要求二次确认，最多 `MAX_PASSWORD_ATTEMPTS` 次。
 *
 * 二次确认不是仪式：隐藏输入下打错一个字是**看不见的**，而写进库的是一份无法反推的哈希
 * —— 没有确认，一次键入错误就表现为"这个账号永远登不进去"，且无从诊断（登录失败与口令
 * 错误在 §5.3 下必须是同一个响应）。
 *
 * 长度不合法时只说边界，不回显输入。
 */
async function readConfirmedSecret(
  readSecret: SecretReader,
  label: string,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt += 1) {
    const first = await readSecret(`${label} 口令（输入不回显，长度 8–128）: `);
    const second = await readSecret(`${label} 口令，再输入一次: `);
    if (first !== second) {
      if (attempt === MAX_PASSWORD_ATTEMPTS) throw new BootstrapRefused('PASSWORD_TOO_MANY_ATTEMPTS');
      process.stdout.write('两次输入不一致，请重新输入。\n');
      continue;
    }
    if (first.length < 8 || first.length > 128) {
      if (attempt === MAX_PASSWORD_ATTEMPTS) throw new BootstrapRefused('PASSWORD_TOO_MANY_ATTEMPTS');
      process.stdout.write('长度不在 8–128 之内，请重新输入。\n');
      continue;
    }
    return first;
  }
  throw new BootstrapRefused('PASSWORD_TOO_MANY_ATTEMPTS');
}

/**
 * 建号 + 写校验材料，全部在一个事务里。
 *
 * 原子性是这里的**全部**要点：`password_credentials.user_id` 外键指向 `users(id)`，而一个
 * "有账号没口令"的行意味着这个账号永远无法登录，且从外面看与"口令错误"完全一样。先建
 * OWNER 再建 STUDENT，因为 `users.owner_id` 是自引用外键。
 *
 * 哈希在**进事务之前**就算好：scrypt 基线一次是几十到上百毫秒，两次就是一段不必要的事务
 * 持有时间，而它并不需要数据库。代价是拒绝路径上白算一次哈希 —— 无害。
 */
export async function bootstrapAccounts(
  adapter: DatabaseAdapter,
  input: BootstrapAccountsInput,
  readSecret: SecretReader,
): Promise<BootstrapAccountsResult> {
  const ownerPassword = await readConfirmedSecret(readSecret, '成人（OWNER）');
  const studentPassword = await readConfirmedSecret(readSecret, '学生（STUDENT）');

  const ownerLoginName = parseLoginName(input.ownerLoginName);
  const studentLoginName = parseLoginName(input.studentLoginName);
  const ownerId = newUuidV7();
  const studentId = newUuidV7();

  const owner: User = createUser({
    id: ownerId,
    role: 'OWNER',
    loginName: ownerLoginName,
    nickname: parseNickname(input.ownerNickname),
    ageBand: null,
    status: 'ACTIVE',
    ownerId: null,
    lockPolicy: input.lockPolicy,
    // §3.2 的 `CHECK (revision > 0)`：新实体的首个已持久化 revision 是 1，不是 domain
    // 工厂默认的 '0'。见 `sql/rows.ts` 的 `assertPersistableRevision`。
    revision: '1',
  });
  const student: User = createUser({
    id: studentId,
    role: 'STUDENT',
    loginName: studentLoginName,
    nickname: parseNickname(input.studentNickname),
    ageBand: input.studentAgeBand,
    status: 'ACTIVE',
    ownerId: owner.id,
    lockPolicy: input.lockPolicy,
    revision: '1',
  });

  const [ownerCredential, studentCredential] = await Promise.all([
    hashPassword(ownerPassword),
    hashPassword(studentPassword),
  ]);

  return adapter.transaction(async (tx) => {
    await assertDatabaseEmpty(tx);
    await assertLoginNameFree(tx, loginNameKey(ownerLoginName));
    await assertLoginNameFree(tx, loginNameKey(studentLoginName));

    await tx.execute(USER_INSERT_SQL, userInsertParams(owner));
    await tx.execute(PASSWORD_CREDENTIAL_INSERT_SQL, credentialInsertParams(owner.id, ownerCredential));
    await tx.execute(USER_INSERT_SQL, userInsertParams(student));
    await tx.execute(
      PASSWORD_CREDENTIAL_INSERT_SQL,
      credentialInsertParams(student.id, studentCredential),
    );

    return {
      ownerId: owner.id,
      studentId: student.id,
      ownerLoginName: owner.loginName,
      studentLoginName: student.loginName,
    };
  });
}

async function assertDatabaseEmpty(tx: DatabaseTransaction): Promise<void> {
  const rows = await tx.query<{ readonly total: unknown }>(USER_COUNT_SQL, []);
  const [row] = rows;
  // `COUNT(*)::bigint` 经 node-pg 回来是**字符串**（OID 20 不做 number 转换）。
  const total = row === undefined ? '' : String(row.total);
  if (total !== '0') throw new BootstrapRefused('ACCOUNTS_ALREADY_EXIST');
}

async function assertLoginNameFree(tx: DatabaseTransaction, loginNameKey: string): Promise<void> {
  const rows = await tx.query<UserRow>(USER_SELECT_BY_LOGIN_NAME_KEY_SQL, [loginNameKey]);
  if (rows.length > 0) throw new BootstrapRefused('LOGIN_NAME_TAKEN');
}

/**
 * 隐藏输入。
 *
 * `stty -echo` 关掉终端回显，读一行，再 `stty echo` 打开。Node 的 `readline` 没有原生的
 * 隐藏模式，而 §1.3 明令「不引入密码库」，所以这里用的是 POSIX 终端自己的开关。
 *
 * 关掉回显失败时**抛**，不退化成明文读：见文件头结构性拒绝 2。
 */
async function readHiddenLine(prompt: string): Promise<string> {
  const off = spawnSync('stty', ['-echo'], { stdio: 'inherit' });
  if (off.error !== undefined || off.status !== 0) {
    throw new Error('无法关闭终端回显（stty -echo 失败）；拒绝以明文读取口令。');
  }
  process.stdout.write(prompt);
  try {
    const readline = createInterface({ input: process.stdin, terminal: false });
    const line = await new Promise<string>((resolve) => {
      readline.once('line', (value) => resolve(value));
    });
    readline.close();
    return line;
  } finally {
    spawnSync('stty', ['echo'], { stdio: 'inherit' });
    process.stdout.write('\n');
  }
}

type CliOptions = {
  readonly migrateOnly: boolean;
  readonly input: BootstrapAccountsInput;
};

function argValue(argv: readonly string[], flag: string): string | null {
  const inline = argv.find((entry) => entry.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  return argv[index + 1] ?? null;
}

function parseArgv(argv: readonly string[]): CliOptions {
  for (const entry of argv) {
    if (FORBIDDEN_PASSWORD_ARG_PATTERN.test(entry)) {
      throw new Error(
        '口令不能经命令行传入（§1.3）。本命令只从隐藏输入读取口令；请移除该参数。',
      );
    }
  }
  const migrateOnly = argv.includes('--migrate-only');
  const required = [
    '--owner-login',
    '--owner-nickname',
    '--student-login',
    '--student-nickname',
    '--student-age-band',
  ] as const;
  const values = required.map((flag) => argValue(argv, flag));
  if (!migrateOnly) {
    const missing = required.filter((_, index) => values[index] === null);
    if (missing.length > 0) throw new Error(`缺少参数：${missing.join(' ')}`);
  }
  const [ownerLogin, ownerNickname, studentLogin, studentNickname, ageBand] = values;
  return {
    migrateOnly,
    input: {
      ownerLoginName: ownerLogin ?? '',
      ownerNickname: ownerNickname ?? '',
      studentLoginName: studentLogin ?? '',
      studentNickname: studentNickname ?? '',
      studentAgeBand: ageBand ?? 'L1',
      lockPolicy: {
        maxFailedAttempts: parseMaxFailedAttempts(
          Number(argValue(argv, '--max-failed-attempts') ?? '5'),
        ),
        lockDurationMinutes: parseLockDurationMinutes(
          Number(argValue(argv, '--lock-duration-minutes') ?? '15'),
        ),
      },
    },
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const options = parseArgv(argv);
  // 年龄段写在命令行上，所以它可以在**任何口令输入之前**就校验掉。参数写错却先让人输两次
  // 口令再报错，等于把一次可避免的失败安排在了最贵的操作之后。
  if (!options.migrateOnly) parseAgeBand(options.input.studentAgeBand);

  for (const name of FORBIDDEN_PASSWORD_ENV_VARS) {
    if (process.env[name] !== undefined) {
      process.stderr.write(
        `环境变量 ${name} 已设置。口令只能经隐藏输入传入（§1.3），请取消该变量后重试。\n`,
      );
      return 1;
    }
  }

  const connectionString = process.env[DATABASE_URL_ENV_VAR];
  if (connectionString === undefined || connectionString.length === 0) {
    process.stderr.write(`缺少 ${DATABASE_URL_ENV_VAR}。\n`);
    return 1;
  }

  // §2.1：迁移用 `pg`（长连接、需要在会话级 advisory lock），不用 Neon 的 HTTP driver。
  const source = await createPgClientSource({ connectionString, maxConnections: 1 });
  const adapter = new PostgresDatabaseAdapter({ source });
  try {
    const report = await adapter.migrate();
    process.stdout.write(`迁移完成：本次应用 ${report.applied.length} 条。\n`);
    if (options.migrateOnly) return 0;

    if (process.stdin.isTTY !== true) {
      process.stderr.write(
        '标准输入不是终端，无法进行隐藏输入。本命令必须由授权操作者在受控终端上交互执行；' +
          '不接受管道、重定向或脚本喂入口令（§1.3）。\n',
      );
      return 1;
    }

    const result = await bootstrapAccounts(adapter, options.input, readHiddenLine);
    process.stdout.write(
      `初始化完成。\n成人账号 id=${result.ownerId} login=${result.ownerLoginName}\n` +
        `学生账号 id=${result.studentId} login=${result.studentLoginName}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BootstrapRefused) {
      process.stderr.write(`已拒绝：${error.reason}\n`);
      return 1;
    }
    // 连接串可能出现在驱动的原始异常里（`connection to <url> failed`）。§4.1 禁止把原异常
    // 透出，所以这里只打印**错误的名字**，细节留给部署侧自己的日志。
    process.stderr.write(
      `初始化失败：${error instanceof Error ? error.name : typeof error}。` +
        '（细节不打印：驱动原文可能含连接串。）\n',
    );
    return 1;
  } finally {
    await adapter.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}

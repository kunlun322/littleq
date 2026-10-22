/**
 * `bootstrap/migrate.ts` 的**确定性**那一半：脱敏、退出码、拒连。
 *
 * 这一份不需要 Postgres。真库那半（首次迁移建出 17 张表、重跑幂等、checksum 被改过就报错）
 * 在 `bootstrap-migrate-database.test.ts`，用的是 `packages/infra/test/support-database.ts`
 * 那个一次性库挂具。分成两份的理由是挂具文件头自己写的那条：确定性夹具与"需要一台
 * Postgres"的那一半不可调和，所以分开 —— 于是脱敏与退出码这两条**在没有数据库的机器上
 * 也必须红得一样**。
 *
 * ## 这一份里最要紧的一条断言
 *
 * 「迁移失败 ⇒ 部署中止」这个承诺的执法点是 `process.exitCode`。一个只在文档里写着、
 * 没有断言钉住的退出码，等于没有退出码 —— 所以这里直接调 `main()` 并读那个全局。
 * `main` 的 `argv` / `env` / `io` 三个参数因此都是可注入的，默认值才是真进程的那三个。
 *
 * ## 脱敏的阳性对照不是可选的
 *
 * 「stderr 里没有连接目标」这条断言，在"驱动原文本来就不带连接目标"的情况下会**假绿**。
 * 所以每一条脱敏断言都配一条方向相反的断言：先证明**原始**错误对象里确实带着它，
 * 再证明**打印出来的**那一行没有。两条一起才构成证据。
 */
import { isInfraError } from '@littleq/infra';
import { afterEach, describe, expect, it } from 'vitest';

import { BootstrapConfigError, FORM_B_ENV_VARS } from '../src/bootstrap/config.js';
import {
  main,
  redactSecrets,
  runFormBMigrations,
  type MigrationIo,
} from '../src/bootstrap/migrate.js';

/** 收集 io，而不是让它写到真 stdout/stderr：测试输出里不该出现任何连接串的残片。 */
function captureIo(): { readonly io: MigrationIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) }, stdout, stderr };
}

/**
 * 形态 B 的最小合法环境，指向一个**关闭的**端口。
 *
 * 用 `127.0.0.1:1` 而不是一个不可路由的地址：前者立刻拿到 ECONNREFUSED，后者会一直挂到
 * TCP 超时。`sslmode=require` 保留是为了让形状与生产一致（也让 `pg-connection-string`
 * 那条一次性 SECURITY WARNING 有机会出现 —— 它落在 stderr，不含任何秘密）。
 */
const REFUSED_HOST = '127.0.0.1';
const REFUSED_URL = `postgres://lq_migrate_user:lq_migrate_pass@${REFUSED_HOST}:1/lq_no_such_db?sslmode=require`;

/**
 * 运行串。迁移命令**不拨它**，但 `runFormBMigrations` 第一步是 `resolveFormBConfig`，
 * 而那一步按 §3.1 要求运行串存在 —— 少给一个变量，报出来的就是 `DATABASE_URL_MISSING`
 * 而不是下面那些真正要断言的迁移侧固定码（本文件第一版就栽在这里）。
 *
 * 这不是把校验放宽的理由，而是刻意的：迁移是**部署期**动作，一次装错了库比一次没装成
 * 危险得多，所以它复用同一个"这套形态 B 配置自洽吗"的判定，不自建一个子集。
 *
 * 凭据刻意与直连串**不同**：于是"运行串的值一个字都没进输出"成为一条真断言 ——
 * 谁哪天让迁移命令"顺手"退回用运行串，这条就红。
 */
const RUNTIME_URL = `postgres://lq_runtime_user:lq_runtime_pass@ep-x-pooler.${REFUSED_HOST}:1/lq_no_such_db?sslmode=require`;

function refusedEnv(): Record<string, string | undefined> {
  return {
    [FORM_B_ENV_VARS.deployment]: 'B',
    [FORM_B_ENV_VARS.databaseUrl]: RUNTIME_URL,
    [FORM_B_ENV_VARS.databaseDirectUrl]: REFUSED_URL,
    [FORM_B_ENV_VARS.sourceCodeUrl]: 'https://git.example/littleq.git',
  };
}

describe('redactSecrets：纯函数', () => {
  it('整串、主机名、口令、用户名都被替换成同一个占位符', () => {
    const out = redactSecrets(`connect ECONNREFUSED ${REFUSED_HOST}:1 user=lq_migrate_user`, [
      REFUSED_URL,
      REFUSED_HOST,
      'lq_migrate_pass',
      'lq_migrate_user',
    ]);
    expect(out).not.toContain(REFUSED_HOST);
    expect(out).not.toContain('lq_migrate_user');
    expect(out).toContain('[REDACTED]');
  });

  it('同一个值出现多次时全部替换（不是只替换第一处）', () => {
    // 秘密必须 ≥ 4 个字符才会被替换，所以这里用 'aa bb' 而不是 'a b'。
    expect(redactSecrets('aa bb cc aa bb cc', ['aa bb'])).toBe(
      '[REDACTED] cc [REDACTED] cc',
    );
  });

  it('长值先替换：否则短值会把长值切碎，剩下可识别的残片', () => {
    // 口令里包含主机名，而且口令**排在主机名之后**。排序在 redactSecrets 里做，
    // 不指望调用方排好 —— 这条断言钉的就是那个前提不存在。
    const password = `pw_${REFUSED_HOST}_x`;
    const out = redactSecrets(`口令是 ${password}，主机是 ${REFUSED_HOST}`, [
      REFUSED_HOST,
      password,
    ]);
    expect(out).not.toContain(REFUSED_HOST);
    expect(out).not.toContain(password);
    expect(out).not.toContain('pw_');
  });

  it('短于 4 个字符的值被忽略（阳性对照：不忽略就会把正常文本打成筛子）', () => {
    const text = 'SELECT 1 AS ok FROM users';
    expect(redactSecrets(text, ['1', 'AS', ''])).toBe(text);
    // 阳性对照：这个探针真的在起作用 —— 给一个够长的值，它必须改文本。
    expect(redactSecrets(text, ['users'])).not.toBe(text);
  });

  it('秘密列表为空时原样返回（这正是 main 里那个 bug 的形状，见下面的回归断言）', () => {
    expect(redactSecrets(`host ${REFUSED_HOST}`, [])).toBe(`host ${REFUSED_HOST}`);
  });
});

describe('runFormBMigrations：配置不对就不连库', () => {
  it('迁移串是池化地址 ⇒ MIGRATION_URL_IS_POOLED，且一个字都没写进 stderr', async () => {
    const { io, stdout, stderr } = captureIo();
    const pooled = REFUSED_URL.replace(REFUSED_HOST, `ep-x-pooler.${REFUSED_HOST}`);
    let thrown: unknown;
    try {
      await runFormBMigrations({
        env: { ...refusedEnv(), [FORM_B_ENV_VARS.databaseDirectUrl]: pooled },
        io,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BootstrapConfigError);
    expect((thrown as BootstrapConfigError).code).toBe('MIGRATION_URL_IS_POOLED');
    // 失败发生在建池之前 ⇒ 不该有任何输出，尤其不该有连接串。
    expect(stdout).toEqual([]);
    for (const line of stderr) expect(line).not.toContain('-pooler');
  });

  it('缺 DATABASE_DIRECT_URL ⇒ MIGRATION_URL_MISSING（不许用运行串代替）', async () => {
    const { io } = captureIo();
    const env = refusedEnv();
    delete env[FORM_B_ENV_VARS.databaseDirectUrl];
    await expect(runFormBMigrations({ env, io })).rejects.toMatchObject({
      code: 'MIGRATION_URL_MISSING',
    });
  });

  it('缺 LITTLEQ_DEPLOYMENT ⇒ DEPLOYMENT_FORM_MISSING（迁移也不许在形态未冻结时跑）', async () => {
    const { io } = captureIo();
    const env = refusedEnv();
    delete env[FORM_B_ENV_VARS.deployment];
    await expect(runFormBMigrations({ env, io })).rejects.toMatchObject({
      code: 'DEPLOYMENT_FORM_MISSING',
    });
  });

  it('缺运行串 ⇒ DATABASE_URL_MISSING，哪怕迁移自己只拨直连串', async () => {
    // 钉住一个反直觉但刻意的行为：`runFormBMigrations` 第一步是 `resolveFormBConfig`，
    // 它按 §3.1 要求运行串存在，于是**迁移命令会因为一个它根本不拨的变量而拒跑**。
    // 这是"复用同一套形态自洽判定、不自建子集"的直接后果 —— 装错库比没装成危险。
    // 谁想放宽它，就得先回答"半配好的安装该不该被迁移"。
    const { io, stdout } = captureIo();
    const env = refusedEnv();
    delete env[FORM_B_ENV_VARS.databaseUrl];
    await expect(runFormBMigrations({ env, io })).rejects.toMatchObject({
      code: 'DATABASE_URL_MISSING',
    });
    expect(stdout).toEqual([]);
  });
});

describe('runFormBMigrations：连不上时驱动原文里的连接目标被脱敏掉', () => {
  it('原始错误确实带出了连接目标，而打印出来的每一行都没有（一对方向相反的断言）', async () => {
    const { io, stderr } = captureIo();
    let thrown: unknown;
    try {
      await runFormBMigrations({ env: refusedEnv(), io });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, '连一个关闭的端口应该抛').toBeInstanceOf(Error);
    expect(isInfraError(thrown), '这是驱动原文，不是 InfraError').toBe(false);

    // 阳性对照在前：**原始**错误里必须真的能找到某个秘密片段，否则下面那条
    // "打印出来的没有"就是空转。
    const secrets = [REFUSED_URL, REFUSED_HOST, 'lq_migrate_pass', 'lq_migrate_user'];
    const leakedInRaw = secrets.filter((secret) => (thrown as Error).message.includes(secret));
    expect(
      leakedInRaw.length,
      `驱动原文里没有连接目标，这条脱敏断言就成了空转。原文：${(thrown as Error).message}`,
    ).toBeGreaterThan(0);

    // 然后才是真正要守的那条。
    expect(stderr.length).toBeGreaterThan(0);
    for (const line of stderr) {
      for (const secret of secrets) expect(line).not.toContain(secret);
      expect(line).not.toContain('postgres://');
      // 运行串的两个凭据片段**不在**上面那份 `secrets` 里（它由直连串算出来），
      // 所以这是一条独立的断言：迁移命令从头到尾没碰过运行串的**值**，
      // 只在 `resolveFormBConfig` 里确认过它存在。谁让它"顺手"退回用运行串，这条就红。
      expect(line).not.toContain('lq_runtime_user');
      expect(line).not.toContain('lq_runtime_pass');
    }
  });

  it('原始错误原样穿透给调用方（包一层就会把不可重试的失败变成可重试的）', async () => {
    const { io } = captureIo();
    await expect(runFormBMigrations({ env: refusedEnv(), io })).rejects.toBeInstanceOf(Error);
  });
});

describe('main：退出码就是「迁移失败 ⇒ 部署中止」的执法点', () => {
  const savedExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('带参数 ⇒ exitCode 2，并且根本不读环境（连接串不从 argv 读）', async () => {
    process.exitCode = 0;
    const { io, stderr } = captureIo();
    // 阳性对照：`refusedEnv()` 若真被读下去，得到的是连接被拒 ⇒ exitCode **1**。
    // 于是 exitCode **2** + 「不接受参数」这句话一起证明了它在读环境之前就返回了 ——
    // 连接串只从 `DATABASE_DIRECT_URL` 读，argv 里那个 `--url=` 从头到尾没被看过
    // （最后一行断言：argv 里的主机名不许出现在任何输出里）。
    await main({
      argv: ['node', 'migrate.js', `--url=${REFUSED_URL}`],
      env: refusedEnv(),
      io,
    });
    expect(process.exitCode).toBe(2);
    expect(stderr.join('\n')).toContain('不接受参数');
    for (const line of stderr) expect(line).not.toContain(REFUSED_HOST);
  });

  it('迁移失败 ⇒ exitCode 1（这就是"迁移失败阻止服务启动"在本仓库里可测的那一半）', async () => {
    process.exitCode = 0;
    const { io, stderr } = captureIo();
    await main({ argv: ['node', 'migrate.js'], env: refusedEnv(), io });
    expect(process.exitCode).toBe(1);
    // 补的那一句也不许带出连接目标。
    for (const line of stderr) {
      expect(line).not.toContain(REFUSED_HOST);
      expect(line).not.toContain('lq_migrate_pass');
    }
    expect(stderr.join('\n')).toContain('部署中止');
  });

  it('配置错误 ⇒ exitCode 1，且补的那一句只含固定码与变量名', async () => {
    process.exitCode = 0;
    const { io, stderr } = captureIo();
    const env = refusedEnv();
    delete env[FORM_B_ENV_VARS.deployment];
    await main({ argv: ['node', 'migrate.js'], env, io });
    expect(process.exitCode).toBe(1);
    const joined = stderr.join('\n');
    expect(joined).toContain('DEPLOYMENT_FORM_MISSING');
    expect(joined).toContain('LITTLEQ_DEPLOYMENT');
  });

  it('回归：非固定码的错误**不得**被 main 再打印一次原文', async () => {
    // 这一条钉的是本单开发中自查出来的一个真 bug：早先 main 的 catch 里写的是
    // `redactSecrets(String(error.message), [])` —— 秘密列表是**空的**，于是驱动原文
    // （里面常带连接目标）被原样写回 stderr，把 runFormBMigrations 刚脱敏掉的东西又放了出来。
    // 现在的规则是：只有构造上不含值的两类错误才补一句，其余只说"见上一行"。
    process.exitCode = 0;
    const { io, stderr } = captureIo();
    await main({ argv: ['node', 'migrate.js'], env: refusedEnv(), io });
    const extra = stderr.filter((line) => line.includes('部署中止'));
    expect(extra.length).toBe(1);
    const line = extra[0] ?? '';
    expect(line).toContain('见上一行');
    expect(line).not.toContain('ECONNREFUSED');
  });
});

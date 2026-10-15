import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EnvValidationError, defineEnv, loadEnvFile } from '../src/env.js';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tools/__fixtures__/env',
);

const schema = z.object({
  LQ_FIXTURE_REQUIRED: z.string().min(1),
  LQ_FIXTURE_OPTIONAL: z.string().optional(),
});

describe('defineEnv：缺失必填变量即启动失败', () => {
  it('变量缺失时抛 EnvValidationError，并点名变量', () => {
    let thrown: unknown;
    try {
      defineEnv({ name: 'test', schema, source: {} });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvValidationError);
    const failure = thrown as EnvValidationError;
    expect(failure.issues.map((issue) => issue.path)).toContain('LQ_FIXTURE_REQUIRED');
    expect(failure.message).toContain('LQ_FIXTURE_REQUIRED');
    expect(failure.message).toContain('.env');
  });

  it('变量存在但取值为空时同样失败（非法值不等于已提供）', () => {
    expect(() => defineEnv({ name: 'test', schema, source: { LQ_FIXTURE_REQUIRED: '' } })).toThrow(
      EnvValidationError,
    );
  });

  it('变量齐备时返回强类型结果', () => {
    const env = defineEnv({
      name: 'test',
      schema,
      source: { LQ_FIXTURE_REQUIRED: 'ok', LQ_FIXTURE_OPTIONAL: 'extra' },
    });
    expect(env.LQ_FIXTURE_REQUIRED).toBe('ok');
    expect(env.LQ_FIXTURE_OPTIONAL).toBe('extra');
  });
});

describe('loadEnvFile：本地读文件，部署平台读注入变量', () => {
  it('存在的 env 文件被载入 process.env，且只含假占位值', () => {
    const loaded = loadEnvFile(path.join(fixtureDir, 'ok', 'lq.env'));
    expect(loaded).toBe(true);
    expect(process.env.LQ_FIXTURE_SENTINEL).toBe('LQ_TEST_SENTINEL_FAKE');

    const env = defineEnv({ name: 'test', schema, envFile: false });
    expect(env.LQ_FIXTURE_REQUIRED).toBe('fixture-value');

    delete process.env.LQ_FIXTURE_SENTINEL;
    delete process.env.LQ_FIXTURE_REQUIRED;
  });

  it('文件不存在时返回 false（Vercel / Cloudflare / Docker 的常态，不是错误）', () => {
    expect(loadEnvFile(path.join(fixtureDir, 'does-not-exist.env'))).toBe(false);
  });

  it('违规 fixture 会让 defineEnv 失败', () => {
    loadEnvFile(path.join(fixtureDir, 'violation', 'lq.env'));
    expect(() => defineEnv({ name: 'test', schema, envFile: false })).toThrow(EnvValidationError);
    delete process.env.LQ_FIXTURE_REQUIRED;
  });
});

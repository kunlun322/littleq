/**
 * `@littleq/runtime` — 作品运行时骨架。
 *
 * 本文件由 ZLQ-159（仓库与质量基座）落地，**只含骨架，不含任何业务逻辑**：
 * 作品静态托管、沙箱执行边界与 iframe/CSP 策略由后续任务在此实现。
 *
 * 边界（ZLQ-153 §1.3）：作品运行时是隔离侧进程，**不访问主站 Cookie / 数据库 / AI 凭证**，
 * 不提供作品后端。下面这份自述不是注释装饰：`apps/runtime/test/isolation.test.ts` 会把它与
 * `config/dependency-graph.json` 中的 `runtime-*` 规则逐条比对，任何一侧单独改动都会让测试失败，
 * 从而杜绝"文档说一套、门禁查另一套"的漂移。
 */

export const UNIT_ID = '@littleq/runtime';

export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'app';
  readonly spec: string;
  readonly skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'app',
  spec: 'ZLQ-153 §1.3 apps/runtime',
  skeletonOnly: true,
};

/** 本单元被禁止触达的面，必须与 config/dependency-graph.json 的 runtime-* 规则一致。 */
export interface RuntimeIsolation {
  readonly forbiddenPackagePrefixes: readonly string[];
  readonly forbiddenPackages: readonly string[];
  readonly forbiddenUnits: readonly string[];
}

export const runtimeIsolation: RuntimeIsolation = {
  forbiddenPackagePrefixes: [
    '@nestjs/',
    '@fastify/',
    '@vercel/',
    '@aws-sdk/',
    '@cloudflare/',
    '@libsql/',
    '@ai-sdk/',
    '@anthropic-ai/',
    '@google/',
    'drizzle-',
    'openai',
    'dashscope',
  ],
  forbiddenPackages: ['pg', 'postgres', 'mysql2', 'better-sqlite3', 'minio', 'cookie', '@types/pg'],
  forbiddenUnits: ['apps/web', 'apps/api', 'apps/worker', 'packages/infra'],
};

/**
 * `@littleq/runtime` — 作品运行时（独立源内容服务）。
 *
 * 本单元由 ZLQ-159 落骨架，由 **ZLQ-204（D4）** 落地以下三件事：
 *
 * 1. **独立源内容服务**：作品字节从一个独立源发出，不与主站共享 Cookie / 数据库 / AI 凭证；
 *    `apps/runtime` 不 import `packages/infra`，也不 import `apps/api`。
 * 2. **安全响应头**：一份完整的、逐项可被单独断言的响应头基线。
 * 3. **「输入 grant URL → 服务端取字节」的客户端契约**：超时/中止、Range 转发、大小预算、
 *    流式 SHA-256 与摘要不一致拒绝。
 *
 * **本单只证明客户端契约与隔离边界，不证明真实链路。** 真实私有 Blob 的未授权/过期拒绝、
 * 即时吊销生效、同一 grant 第 9 路并发拒绝、跨 Range 的累计预算、真实日志中不含供应商
 * URL/token、以及端到端「主站签发 → Runtime 取字节」的产物摘要一致性，全部属于 D5/D6 的
 * 验收范围。上面的第 3 项在测试里对接的是一个**本地 authenticated substitute**，替身通过
 * 不等于真实链路通过。
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
  skeletonOnly: false,
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

export type UnitReadiness = {
  readonly status: 'skeleton' | 'implemented';
  /** 本单元对外承诺的能力名。稳定标识符，不是文件名、不是测试数量（§9.2 规则 6）。 */
  readonly capabilities: readonly string[];
  /** 能力名 → 本单元 test 目录下的验收测试路径。每条能力都必须有映射。 */
  readonly acceptanceTests: Readonly<Record<string, string>>;
};

/**
 * 就绪声明：本单元已实现，而且**自证**已实现。
 *
 * 只有上面那个 `skeletonOnly: false` 是不够的 —— 它是一个布尔值，翻动它不需要提交任何证据，
 * 所以「已实现」这句话本身可以是一句谎（ZLQ-194 §9.2 要治的正是这个）。下面每一条能力都被
 * `tools/check-unit-readiness.mjs` 反向核对：映射的测试文件必须存在、必须落在 vitest 会收集的
 * 形状里、必须至少有一条活着的用例、并且**文件正文里必须真的出现这个能力名**。
 *
 * 前两条是 `tools/unit-readiness-contract.json` 为 `apps/runtime` 点名的 `requiredProofs`；
 * 后四条是 D4「输入 grant URL → 服务端取字节」客户端契约的四个可独立红绿的面，
 * 按工单要求拆成四个独立测试文件、标题逐一点名。
 */
export const unitReadiness: UnitReadiness = {
  status: 'implemented',
  capabilities: [
    'separate-origin-content',
    'security-headers',
    'grant-fetch-timeout-abort',
    'grant-fetch-range-forwarding',
    'grant-fetch-size-budget',
    'grant-fetch-streaming-sha256',
  ],
  acceptanceTests: {
    'separate-origin-content': 'test/separate-origin-content.test.ts',
    'security-headers': 'test/security-headers.test.ts',
    'grant-fetch-timeout-abort': 'test/grant-fetch-timeout-abort.test.ts',
    'grant-fetch-range-forwarding': 'test/grant-fetch-range-forwarding.test.ts',
    'grant-fetch-size-budget': 'test/grant-fetch-size-budget.test.ts',
    'grant-fetch-streaming-sha256': 'test/grant-fetch-streaming-sha256.test.ts',
  },
};

export * from './errors.js';
export * from './range.js';
export * from './grant-url.js';
export * from './byte-budget.js';
export * from './security-headers.js';
export * from './origin.js';
export * from './grant-fetch.js';

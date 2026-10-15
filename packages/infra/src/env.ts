/**
 * 环境变量加载与校验骨架（ZLQ-159 交付项 5）。
 *
 * **本文件刻意不定义任何具体变量。** 完整变量清单属于 ZLQ-157（部署与运行时形态），
 * 这里只落地机制：本地读 `.env`、部署平台（Vercel / Cloudflare / Docker）读注入的
 * 同名环境变量，代码路径完全一致；缺失或非法的必填变量在启动阶段直接失败，并给出
 * 可定位到变量名的报错，而不是在运行中途以 undefined 触发难以归因的错误。
 *
 * 用法（变量清单落地后）：
 *
 * ```ts
 * const schema = z.object({ DATABASE_URL: z.url() });
 * export const env = defineEnv({ name: 'api', schema });
 * ```
 *
 * 安全红线（CONTRIBUTING.md）：构建脚本、依赖安装与数据库迁移不得读取生产凭证；
 * 任何真实凭证不得进入仓库、commit、CI 日志或示例文件，`.env.example` 只用占位值。
 */
import process from 'node:process';

import { z } from 'zod';

/** 环境变量来源。`process.env` 与测试注入的字面量都满足该形状。 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** 单条校验失败项，`path` 为变量名（嵌套 schema 时以 `.` 连接）。 */
export interface EnvIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** 必填变量缺失或格式非法时抛出：启动失败，且报错直接点名变量。 */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(name: string, issues: readonly EnvIssue[]) {
    super(formatMessage(name, issues));
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

function formatMessage(name: string, issues: readonly EnvIssue[]): string {
  const lines = issues.map(
    (issue) => `  - ${issue.path || '(root)'}: ${issue.message} [${issue.code}]`,
  );
  return [
    `环境变量校验失败（${name}），共 ${issues.length} 项：`,
    ...lines,
    '',
    '本地开发：把缺失变量写入仓库根 .env（参照 .env.example，只放占位值，切勿提交真实凭证）。',
    'Vercel / Cloudflare / Docker 部署：在平台侧注入同名环境变量；两者读取路径一致，无需分支代码。',
  ].join('\n');
}

export interface DefineEnvOptions<T extends z.ZodType> {
  /** 环境标识，仅用于报错信息，例如 `api` / `worker` / `web`。 */
  readonly name: string;
  readonly schema: T;
  /** 显式来源；给出后不再读取 `.env`，保证测试可重复。 */
  readonly source?: EnvSource;
  /** 传 `false` 关闭 `.env` 加载；默认在仓库根查找 `.env`，不存在则静默跳过。 */
  readonly envFile?: string | false;
}

/**
 * 加载 `.env` 到 `process.env`。文件不存在时返回 `false`——这是部署平台的常态，
 * 不是错误。使用 Node ≥ 20.12 内置的 `process.loadEnvFile`，不引入 dotenv 依赖。
 */
export function loadEnvFile(file = '.env'): boolean {
  try {
    process.loadEnvFile(file);
    return true;
  } catch {
    return false;
  }
}

/** 校验并返回强类型环境变量；失败即抛 {@link EnvValidationError}。 */
export function defineEnv<T extends z.ZodType>(options: DefineEnvOptions<T>): z.output<T> {
  const useProcessEnv = options.source === undefined;
  if (useProcessEnv && options.envFile !== false) {
    loadEnvFile(typeof options.envFile === 'string' ? options.envFile : '.env');
  }

  const source: EnvSource = useProcessEnv ? { ...process.env } : options.source;
  const result = options.schema.safeParse(source);
  if (!result.success) {
    const issues: EnvIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    }));
    throw new EnvValidationError(options.name, issues);
  }
  return result.data;
}

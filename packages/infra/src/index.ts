/**
 * `@littleq/infra` — 基础设施层骨架。
 *
 * 本文件由 ZLQ-159（仓库与质量基座）落地，**只含骨架，不含任何业务逻辑**：
 * `DatabaseAdapter` / `TaskRepository` / `ObjectStore` / `SecretStore` / `RuntimePublisher`
 * 的端口实现与 `drivers/*` 由 ZLQ-161 在此落地。本任务只提供环境变量加载校验机制，
 * 因为它是"启动即失败"的质量基座能力，不属于任何业务特性。
 *
 * 边界（ZLQ-153 §1.3 / §5）——由 `config/dependency-graph.json` 强制：
 *
 * - infra 不包含业务分支；所有 SDK 类型停在本层，不外泄到 domain。
 * - `domain-and-application-no-drivers`（§5.4(4)）禁止 domain / application 导入 `drivers/*`，
 *   即本层的驱动目录只能由组合根（apps/*）在装配时触达。
 */
import { unitManifest as domainManifest } from '@littleq/domain';

export { EnvValidationError, defineEnv, loadEnvFile } from './env.js';
export type { DefineEnvOptions, EnvIssue, EnvSource } from './env.js';

export const UNIT_ID = '@littleq/infra';

export interface UnitManifest {
  readonly unitId: string;
  readonly layer: 'infra';
  readonly spec: string;
  readonly skeletonOnly: boolean;
  /** 本单元装配时所依赖的下层单元，供组合根启动自检。 */
  readonly dependsOn: readonly string[];
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  layer: 'infra',
  spec: 'ZLQ-153 §1.3 packages/infra',
  skeletonOnly: true,
  dependsOn: [domainManifest.unitId],
};

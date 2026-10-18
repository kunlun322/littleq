// 故意违规 6（见 ../../../README.md）。请勿修复：作品运行时不得触达主站基础设施。
import { env } from '@littleq/infra';

// 故意违规 8（见 ../../../README.md）。请勿修复：作品运行时是隔离沙箱侧进程，不是 API
// 契约的合法消费方 —— `api-contract-no-platform-coupling` 的入向白名单只有 apps/api 与
// packages/application。行尾的 SENTINEL 标记是控制用例的移除锚点：删掉这一行，
// `pnpm dep-graph:control` 的 8 处计数必须立刻以退出码 2 变红。
import { operationRegistry } from '@littleq/api-contract'; // SENTINEL:api-contract-inbound

export const runtimeViolationFixture = { env, operationRegistry };

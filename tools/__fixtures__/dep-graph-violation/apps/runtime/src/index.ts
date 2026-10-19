// 故意违规 6（见 ../../../README.md）。请勿修复：作品运行时不得触达主站基础设施。
import { env } from '@littleq/infra';

// 故意违规 8（见 ../../../README.md）。请勿修复：作品运行时是隔离沙箱侧进程，不是 API
// 契约的合法消费方 —— `api-contract-no-platform-coupling` 的入向白名单只有 apps/api 与
// packages/application。行尾的 SENTINEL 标记是控制用例的移除锚点：删掉这一行，
// `pnpm dep-graph:control` 的 14 处计数必须立刻以退出码 2 变红。
import { operationRegistry } from '@littleq/api-contract'; // SENTINEL:api-contract-inbound

// 故意违规 13（见 ../../../README.md）。请勿修复：ZLQ-194 §13 行 4 要求受控边落地后
// 「client、runtime 仍禁止」。runtime 这一半由**既有**规则 `runtime-no-main-site-units`
// 承担（它的 deny.units 显式含 apps/api），不由新增的 `web-server-adapter-only-controlled-api-entry`
// 承担 —— 后者 from 只有 apps/web。
//
// 把它种在这里而不是只写在规则描述里，是为了让「runtime 仍禁止」成为可判定的事实：
// 谁哪天为了放行 web→api 而顺手把 apps/api 从那条 deny.units 里摘掉，这处计数就会掉，
// `pnpm dep-graph:control` 立刻以退出码 2 变红。
import { apiControlledEntryFixture } from '@littleq/api'; // SENTINEL:runtime-no-api

export const runtimeViolationFixture = { env, operationRegistry, apiControlledEntryFixture };

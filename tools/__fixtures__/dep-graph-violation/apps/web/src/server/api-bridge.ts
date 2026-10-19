// 故意违规 11（见 ../../../README.md）。请勿修复。
//
// 说明符合法、`server-only` 也在、也不是 Client Component —— 但文件不在适配层白名单里。
// 这是最容易被「集中一下调用」顺手写出来的一种越界：把 Route Handler 里的调用抽到
// `src/server/api-bridge.ts`，看着更干净，实际上把受控入口的访问面从
// 「HTTP 适配层」悄悄扩成了「apps/web 里任何自称 server 的目录」。
//
// 白名单只认 `apps/web/app/api/**/route.ts[x]`，因为 ZLQ-194 §4.3 对适配层的职责定义
// 是**按路由文件**给出的（「只做 HTTP 适配，不持有 QCA 状态、不含领域规则」）；
// 一个不在路由位置上的文件无从被这条职责定义约束。
import 'server-only';

import { apiControlledEntryFixture } from '@littleq/api/server'; // SENTINEL:web-controlled-edge-N3

export const apiBridgeFixture = apiControlledEntryFixture;

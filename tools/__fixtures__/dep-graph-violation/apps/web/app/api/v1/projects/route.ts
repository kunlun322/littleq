// 故意违规 9（见 ../../../README.md）。请勿修复。
//
// 路径合法（apps/web/app/api/**/route.ts 就是 ZLQ-194 §4.3 点名的适配层）、说明符合法
// （@littleq/api/server 正是那个受控入口）、也不是 Client Component —— 唯独少了
// `import 'server-only';`。
//
// 这一处单独成条的理由：`server-only` 不是装饰。它是构建期兜底 —— 一旦这个文件被任何
// 客户端模块图引用到，Next 的构建就会抛错，而不是等到运行时把服务端模块打进浏览器 chunk。
// 少了它，「路径 + 说明符都合法」这个静态判定就成了唯一的防线，而静态判定管不到
// 动态 import 与重新导出。所以四个条件里它是唯一一条「看起来最像形式主义、实际上最承重」的。
//
// 上面那句反引号里的 `import 'server-only';` **不要改写、也不要删掉**：
// 它是注释剥离的永久回归对照。扫描器读的是原文正则，若不在扫描前抹平注释，
// 这句解释就会被当成真的导入，条件 4 从此恒不触发 —— 而计数只掉 1，
// 看上去像「夹具写错了」，不像「门禁漏判了」。tools/test/dependency-graph.test.mjs
// 里的「注释里的 server-only 不算数」一条断言的就是这个文件。
import { apiControlledEntryFixture } from '@littleq/api/server'; // SENTINEL:web-controlled-edge-N1

export async function GET() {
  return Response.json(apiControlledEntryFixture);
}

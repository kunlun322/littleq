// 故意违规 12（见 ../../../README.md）。请勿修复。
'use client';

// Client Component 禁止导入 apps/api 的任何说明符（ZLQ-194 §4.3 / §13 行 4：
// 「client、runtime 仍禁止」）。这一处跑在浏览器里，而 apps/api 的应用处理器持有
// 数据库连接、对象存储凭证与 QCA 会话 —— 让它进入客户端模块图，等于把服务端凭证面
// 暴露给学生的浏览器。
//
// 门禁在这里**短路**：文件已经是 Client Component 时，路径不在适配层白名单、
// 没有 import 'server-only' 这些都不再值得报 —— `server-only` 被客户端图引用到时
// 构建期就会抛，路径与说明符的判定也失去意义。一处根因只报一条，
// 否则唯一可操作的那条会被埋在三条里。
//
// 哨兵在 import 行而不是 'use client' 行：删掉 import，剩下的 'use client' 是无害的，
// 违规计数正好少 1 —— 归因因此是可判定的，不是「删了点什么就变绿」。
import { apiControlledEntryFixture } from '@littleq/api/server'; // SENTINEL:web-controlled-edge-N4

export function ProjectListFixture() {
  return <pre>{JSON.stringify(apiControlledEntryFixture)}</pre>;
}

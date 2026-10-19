// **正对照**：本文件刻意 0 违规（见 ../../../README.md）。请勿往里植入违规。
//
// 判红的四棵树各缺一个条件，本文件四个条件全齐：不是 Client Component、
// 落在适配层白名单 `apps/web/app/api/**/route.ts` 里、导入的是受控入口
// `@littleq/api/server` 本身、并且显式 `import 'server-only';`。
//
// 没有这棵树，「受控边会红」就证明不了「受控边不是恒红」—— 而一条恒红的规则会让
// D6 唯一能做的事就是回来把它删掉。ZLQ-194 §4.3 描述的那个合法形态就是这里的样子。
import 'server-only';

import { apiControlledEntryFixture } from '@littleq/api/server';

export async function POST() {
  return Response.json(apiControlledEntryFixture, { status: 202 });
}

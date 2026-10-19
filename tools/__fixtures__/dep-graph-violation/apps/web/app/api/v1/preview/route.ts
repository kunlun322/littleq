// 故意违规 10（见 ../../../README.md）。请勿修复。
//
// 路径合法、`server-only` 也在，但导入的是**桶入口** `@littleq/api` 而不是受控入口
// `@littleq/api/server`。这正是受控边要拦的那一类：桶入口会把 apps/api 的整个导出面
// 拖进调用方的模块图，Next 的客户端 chunk 因此有可能引用到服务端模块（ZLQ-194 §13 行 11
// 的「服务端模块不进入客户端 bundle」负断言在构建期才成立，静态门禁必须在源头就拦住）。
//
// 注意本文件同时 import 'server-only'：这不是冗余，而是把归因锁死 ——
// 少了它，本文件会同时触发条件 3 与条件 4，两处违规挤在一行上，
// 就分不清门禁到底认不认得「说明符不对」这一条。
import 'server-only';

import { apiBarrelFixture } from '@littleq/api'; // SENTINEL:web-controlled-edge-N2

export async function GET() {
  return Response.json(apiBarrelFixture);
}

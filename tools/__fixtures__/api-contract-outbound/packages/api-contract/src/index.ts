// 隔离夹具：**出向**禁止的对照用例（见 ../../README.md）。请勿修复。
//
// 它单独成树而不并进 dep-graph-violation，是为了让 `--expect-failures 8` 这个计数只
// 统计主夹具里的违规（PM G2 已裁定不新建第二条 control 脚本、不改那五处锁步更新）。
// 本树由 tools/test/dependency-graph.test.mjs 直接调用**同一个生产 checker** 验证，
// 不占根 script，也不进入 8 处计数。
import { Controller } from '@nestjs/common'; // SENTINEL:api-contract-outbound

export const apiContractOutboundFixture = { Controller };

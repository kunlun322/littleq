// 反空转对照（a）：status 仍是 skeleton，却已经长出**具名实现**。
// 这正是 ZLQ-194 §9.2 规则 2 要抓的形状 —— 布尔值没翻，代码已经翻。
// 与同目录的 drivers/neon-driver.ts、scanner.ts 一起构成对照用例；每一处植入的违规
// 都登记在 tools/__fixtures__/unit-readiness/README.md 的表里，计数由
// tools/test/unit-readiness.test.mjs 锁死。
export const UNIT_ID = '@littleq/api';

export interface UnitManifest {
  unitId: string;
  skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  skeletonOnly: true,
};

export function projectsRouteHandler() {
  return null;
}

export class NeonDriver {}

// 合法骨架：文件、导出、依赖都在契约清单内，status=skeleton。
// 本夹具要判红的不是形状（门 2 全过），而是 test/ 里的退役写法（门 5）。
export const UNIT_ID = '@littleq/worker';

export interface UnitManifest {
  unitId: string;
  skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  skeletonOnly: true,
};

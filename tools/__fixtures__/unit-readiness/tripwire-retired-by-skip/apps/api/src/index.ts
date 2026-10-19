// 合法骨架（legacy 形状，与真实仓库今天的五个单元一致：只有 unitManifest.skeletonOnly，
// 还没有 unitReadiness 声明）。本夹具判红的不是 src，而是 test/ 里被退役的 tripwire。
export const UNIT_ID = '@littleq/api';

export interface UnitManifest {
  unitId: string;
  skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  skeletonOnly: true,
};

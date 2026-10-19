// 反空转对照（b1）：布尔值翻了、unitReadiness 声明也写了，但 capabilities 是空的。
// 这就是 ZLQ-194 §9.2 规则 3 要抓的「翻个布尔值就宣称已实现」。
// 同时契约点名 apps/api 必须声明 turn-to-task-to-safe-event 这项黑盒证明（规则 4），
// capabilities 为空 ⇒ 门 3 与门 4 各判红一处。
export const UNIT_ID = '@littleq/api';

export interface UnitManifest {
  unitId: string;
  skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  skeletonOnly: false,
};

export type UnitReadiness = {
  status: 'skeleton' | 'implemented';
  capabilities: readonly string[];
  acceptanceTests: Readonly<Record<string, string>>;
};

export const unitReadiness: UnitReadiness = {
  status: 'implemented',
  capabilities: [],
  acceptanceTests: {},
};

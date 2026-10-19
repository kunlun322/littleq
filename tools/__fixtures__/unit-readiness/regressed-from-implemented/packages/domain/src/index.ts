// 门 6 对照：@littleq/domain 在真实仓库里早已 implemented（skeletonOnly: false，src/ 下 37 个文件）。
// 本夹具把它解析回 skeleton —— 状态机里 implemented -> skeleton 是被禁止的转移。
// 契约没有为 domain 登记骨架清单，按此事实它已越过骨架期；门 6 判红 1 处。
// 门 2 会跟着判红 4 处（src/index.ts 不在清单、三个导出都不在清单）—— 那是设计意图：
// 想把一个已实现的单元退回骨架，必须先删掉它全部的实现文件、导出与依赖，
// 而那本身就是一次显式的、必须过评审的回退。合计 5 处。
export const UNIT_ID = '@littleq/domain';

export interface UnitManifest {
  unitId: string;
  skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  skeletonOnly: true,
};

// 正对照（合法骨架 + 就绪声明）：D2–D6 在**还没实现**的时候就可以先把 unitReadiness
// 声明写进 src/index.ts —— 契约的 alwaysAllowedExports 把 UnitReadiness / unitReadiness
// 这两个治理面导出放行，因此门 2 不会因为「多了一个导出」判红。
// 文件、导出、依赖全部在骨架清单内，status=skeleton ⇒ 门 2 不判红，门 3/4 只在
// status=implemented 时生效所以也不判红。本树期望 **0 处违规**：
// 它证明门 3/4 不是「只要声明了就必红」，也证明这套门不会把合法演进路径堵死。
export const UNIT_ID = '@littleq/api';

export interface UnitManifest {
  unitId: string;
  skeletonOnly: boolean;
}

export const unitManifest: UnitManifest = {
  unitId: UNIT_ID,
  skeletonOnly: true,
};

export type UnitReadiness = {
  status: 'skeleton' | 'implemented';
  capabilities: readonly string[];
  acceptanceTests: Readonly<Record<string, string>>;
};

export const unitReadiness: UnitReadiness = {
  status: 'skeleton',
  capabilities: [],
  acceptanceTests: {},
};

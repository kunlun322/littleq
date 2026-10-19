// 门 4 对照：契约给 @littleq/work-contract 点名了两项黑盒证明
//   safe-package-passes                （至少一个安全包能通过）
//   every-block-category-negative-fails（每个拦截类别的负例都必须失败）
// 本夹具只声明了第一项 —— 第二项缺席，门 4 判红 1 处。
// 门 3 不判红：capabilities 非空，且唯一那项映射到一个真实存在、活着、含能力名的测试。
export const UNIT_ID = '@littleq/work-contract';

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
  capabilities: ['safe-package-passes'],
  acceptanceTests: {
    'safe-package-passes': 'test/safe-package.test.ts',
  },
};

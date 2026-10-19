// 正对照（合法 implemented）：契约给 @littleq/work-contract 点名的两项黑盒证明
// 都出现在 capabilities 里，且各自映射到一个真实存在、用例活着、正文含能力名的测试。
// 本树期望 **0 处违规** —— 它是「门 3/4 不是恒红」的正对照：同一份契约、同一个门禁，
// 只换被测树，判红与判绿两种结论都能拿到。
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
  capabilities: ['safe-package-passes', 'every-block-category-negative-fails'],
  acceptanceTests: {
    'safe-package-passes': 'test/safe-package.test.ts',
    'every-block-category-negative-fails': 'test/block-categories.test.ts',
  },
};

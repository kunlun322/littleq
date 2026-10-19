// 反空转对照（b2）：capabilities 非空了，但能力→测试的映射是假的。
// 两种假法各植入一处：
//   turn-to-task-to-safe-event -> test/readiness/turn-to-task.test.ts  该文件根本不存在
//   ghost-capability           -> test/unrelated.test.ts               文件存在、用例活着，
//                                                                     但正文里没有能力名，
//                                                                     指向的是一个无关既有测试
// 门 3 各判红一处，共 2 处；门 4 因为契约点名的证明能力确实在 capabilities 里，不判红。
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
  capabilities: ['turn-to-task-to-safe-event', 'ghost-capability'],
  acceptanceTests: {
    'turn-to-task-to-safe-event': 'test/readiness/turn-to-task.test.ts',
    'ghost-capability': 'test/unrelated.test.ts',
  },
};

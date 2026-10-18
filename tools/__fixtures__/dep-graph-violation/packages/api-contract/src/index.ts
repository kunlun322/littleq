// 本单元在夹具里只是**入向约束的目标**，自身不含违规。
// 它刻意零依赖：这样「第 8 处违规确实来自 apps/runtime 的越界引用」与
// 「目标单元自己触发了出向禁止」两种情况在输出里可以区分开。
export const apiContractTargetFixture = { unit: 'packages/api-contract' };

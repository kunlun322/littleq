// 门 7 对照（一）：写了 unitReadiness 声明，但 status 不是状态机里的值，
// 且 capabilities / acceptanceTests 两个必填字面量都缺席。
// 解析不出就绪状态就必须判红，不能静默当作「没有声明」放过 —— 那正好是把门做成哑火的形状。
// 三处问题 ⇒ 门 7 判红 3 处。
export const UNIT_ID = '@littleq/runtime';

export const unitReadiness = {
  status: 'half-done',
};

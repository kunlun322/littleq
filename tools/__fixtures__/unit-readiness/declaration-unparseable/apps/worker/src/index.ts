// 门 7 对照（二）：unitReadiness 的对象字面量花括号不配对 —— 写到一半就提交了。
// 本文件**故意**不是合法的 TypeScript：夹具不参与 typecheck / lint / vitest，
// 它只是门禁的输入字节。花括号配不上对 ⇒ 解析不出就绪声明 ⇒ 门 7 判红 1 处。
export const UNIT_ID = '@littleq/worker';

export const unitReadiness = {
  status: 'implemented',
  capabilities: ['lease-cas-reclaim'],
  acceptanceTests: {

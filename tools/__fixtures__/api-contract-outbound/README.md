# api-contract 出向禁止 —— 隔离对照用例

这棵迷你树**不是可运行的代码，也永远不该被修复**。它只证明一件事：
`config/dependency-graph.json` 里 `api-contract-no-platform-coupling` 的**出向** `deny`
真的会拦住 `packages/api-contract` 引入平台 SDK。

主夹具 `tools/__fixtures__/dep-graph-violation` 证明的是同一条规则的**入向** `inbound`
（第 8 处违规：`apps/runtime → packages/api-contract`）。两个方向分树，是因为入向违规
的计数被根 `package.json` 的 `--expect-failures 14` 锁死，往主夹具里再塞一处出向违规
就要跟着改那串锁步文案。ZLQ-195 §3.3 已经要求把这个数字写成实测值（8 → 13，
再因 §3.4 的依赖冻结补上 `@neondatabase/` 一处 → 14），
所以「计数不许再动」这条早先的裁定不再成立；但**分树**本身仍然有意义：
出向与入向的归因分开，读输出的人不必在一堆 14 行里分辨方向。

本树由 `tools/test/dependency-graph.test.mjs` 调用**同一个生产 checker**
（`tools/check-dependency-graph.mjs`，策略仍是仓库里真实那一份）验证：

1. 先断言哨兵行 `SENTINEL:api-contract-outbound` 确实存在于夹具里；
2. 原样扫描 → 恰好 1 处违规，规则 id 是 `api-contract-no-platform-coupling`；
3. 复制到临时目录、删掉哨兵行 → 0 处违规（由红转绿，证明那 1 处确实归因于哨兵，
   而不是夹具里某个环境噪声）。

不新增根 script，不进入 `dep-graph:control` 的计数。

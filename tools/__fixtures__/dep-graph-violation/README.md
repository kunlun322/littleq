# 静态依赖图门禁 —— 故意违规的控制用例

这个迷你仓库**不是可运行的代码，也永远不该被修复**。它存在的唯一目的，是让
`pnpm dep-graph:control` 能证明 `tools/check-dependency-graph.mjs` 真的会失败。

一个从不失败的门禁等于没有门禁：假阴性比漏报更危险，因为它会让人误以为
ZLQ-153 §1.3 / §5.4(4) 的边界是被守住的，而实际上扫描器可能根本没在看。

## 植入的 8 处违规

| # | 位置 | 违规内容 | 命中规则 | 条款 |
| --- | --- | --- | --- | --- |
| 1 | `packages/domain/package.json` | 依赖 `@nestjs/common` | `domain-no-platform-sdk` | §1.3 / §3.1 |
| 2 | `packages/domain/package.json` | 依赖 `pg` | `domain-no-platform-sdk` | §1.3 / §3.1 |
| 3 | `packages/domain/src/index.ts` | 跨单元相对导入 `packages/infra` | `domain-no-workspace-deps` | §3.1 |
| 4 | `packages/domain/src/index.ts` | 导入 `./drivers/pg-driver` | `domain-and-application-no-drivers` | §5.4(4) |
| 5 | `apps/runtime/package.json` | 依赖 `openai` | `runtime-no-main-site-secrets` | §1.3 |
| 6 | `apps/runtime/src/index.ts` | 通过 `@littleq/infra` 别名导入主站基础设施 | `runtime-no-main-site-units` | §1.3 / §3.1 |
| 7 | `packages/application/src/index.ts` | 跨单元导入 `packages/domain/src/drivers/*` | `domain-and-application-no-drivers` | §5.4(4) |
| 8 | `apps/runtime/src/index.ts` | 通过 `@littleq/api-contract` 别名引用 API 契约层 | `api-contract-no-platform-coupling`（入向 `inbound.default=deny`） | §1.3 / §3.1 / 附录 A §3.5 |

`packages/infra` 与 `packages/api-contract` 在这里只是被违规指向的目标，两者自身都不含违规
（`packages/api-contract` 刻意零依赖，好让「第 8 处确实来自 apps/runtime 的越界引用」与
「目标单元自己触发了出向禁止」在输出里可以区分开）。

违规 7 是特意加的：`packages/application` **不在** ZLQ-153 §1.3 的目录清单里（§1.3 只列了
`domain / infra / work-contract / design-system`），但 §5.4(4) 已经点名禁止它导入 `drivers/*`。
规则按路径预先武装，这条控制用例证明该包一旦落地就立刻被约束，而不是等到有人想起补规则。
这个规格缺口本身已在 ZLQ-159 交付评论中声明，交架构师裁定，未自行改动 §1.3。

违规 8 走的是**入向**判定：`api-contract-no-platform-coupling` 的 `inbound` 段声明
`allowFrom: [apps/api, packages/application]`、`default: deny`，checker 对文件系统动态发现的
全部单元套用这个默认拒绝，所以 `apps/runtime` 不需要被任何规则点名就已经违规。
`apps/runtime/src/index.ts` 那一行带着 `SENTINEL:api-contract-inbound` 行尾标记，
`tools/test/dependency-graph.test.mjs` 用它做植入哨兵正向对照：先断言标记存在，
再把夹具复制到临时目录删掉该行，`--expect-failures 8` 必须立刻以退出码 2 变红。
同一条规则的**出向** `deny` 由隔离夹具 `tools/__fixtures__/api-contract-outbound` 验证，
不并入本树的计数。

## 计数是锁死的

根 `package.json` 的 `dep-graph:control` 脚本带 `--expect-failures 8`：

```sh
pnpm dep-graph:control   # 期望恰好 8 处违规，多了少了都以退出码 2 失败
```

因此扫描器哪天回归成漏报，**控制用例会先红**，而不是等到真实越界溜进主干。
新增或修改植入的违规时，必须同步更新该计数与本表格。

控制用例读的是仓库里**真实那一份** `config/dependency-graph.json`（`--policy` 默认取调用方
cwd，不取 `--root`）。fixture 里没有策略副本：否则「fixture 自带一份刚好能抓到 fixture 的
策略」就成了自证，证明不了线上策略有效。

## 为什么用独立的 fixture，而不是改真实单元

真实单元被 ESLint 的 `no-restricted-imports`（同一份 `config/dependency-graph.json` 生成）
与 TypeScript 项目引用同时约束，往里植入违规会连带让 `lint` / `build` 变红，
无法把「依赖图门禁失效」这一个信号隔离出来。fixture 目录被 `.prettierignore`、
`eslint.config.mjs` 与 `tools/tsconfig.json` 一并排除，只有本门禁会读它。

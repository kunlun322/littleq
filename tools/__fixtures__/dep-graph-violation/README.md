# 静态依赖图门禁 —— 故意违规的控制用例

这个迷你仓库**不是可运行的代码，也永远不该被修复**。它存在的唯一目的，是让
`pnpm dep-graph:control` 能证明 `tools/check-dependency-graph.mjs` 真的会失败。

一个从不失败的门禁等于没有门禁：假阴性比漏报更危险，因为它会让人误以为
ZLQ-153 §1.3 / §5.4(4) 的边界是被守住的，而实际上扫描器可能根本没在看。

## 植入的 7 处违规

| # | 位置 | 违规内容 | 命中规则 | 条款 |
| --- | --- | --- | --- | --- |
| 1 | `packages/domain/package.json` | 依赖 `@nestjs/common` | `domain-no-platform-sdk` | §1.3 / §3.1 |
| 2 | `packages/domain/package.json` | 依赖 `pg` | `domain-no-platform-sdk` | §1.3 / §3.1 |
| 3 | `packages/domain/src/index.ts` | 跨单元相对导入 `packages/infra` | `domain-no-workspace-deps` | §3.1 |
| 4 | `packages/domain/src/index.ts` | 导入 `./drivers/pg-driver` | `domain-and-application-no-drivers` | §5.4(4) |
| 5 | `apps/runtime/package.json` | 依赖 `openai` | `runtime-no-main-site-secrets` | §1.3 |
| 6 | `apps/runtime/src/index.ts` | 通过 `@littleq/infra` 别名导入主站基础设施 | `runtime-no-main-site-units` | §1.3 / §3.1 |
| 7 | `packages/application/src/index.ts` | 跨单元导入 `packages/domain/src/drivers/*` | `domain-and-application-no-drivers` | §5.4(4) |

`packages/infra` 在这里只是被违规指向的目标，它自身不含违规。

违规 7 是特意加的：`packages/application` **不在** ZLQ-153 §1.3 的目录清单里（§1.3 只列了
`domain / infra / work-contract / design-system`），但 §5.4(4) 已经点名禁止它导入 `drivers/*`。
规则按路径预先武装，这条控制用例证明该包一旦落地就立刻被约束，而不是等到有人想起补规则。
这个规格缺口本身已在 ZLQ-159 交付评论中声明，交架构师裁定，未自行改动 §1.3。

## 计数是锁死的

根 `package.json` 的 `dep-graph:control` 脚本带 `--expect-failures 7`：

```sh
pnpm dep-graph:control   # 期望恰好 7 处违规，多了少了都以退出码 2 失败
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

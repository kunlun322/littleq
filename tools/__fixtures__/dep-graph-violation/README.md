# 静态依赖图门禁 —— 故意违规的控制用例

这个迷你仓库**不是可运行的代码，也永远不该被修复**。它存在的唯一目的，是让
`pnpm dep-graph:control` 能证明 `tools/check-dependency-graph.mjs` 真的会失败。

一个从不失败的门禁等于没有门禁：假阴性比漏报更危险，因为它会让人误以为
ZLQ-153 §1.3 / §5.4(4) 与 ZLQ-194 §4.3 的边界是被守住的，而实际上扫描器可能根本没在看。

## 植入的 14 处违规

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
| 9 | `apps/web/app/api/v1/projects/route.ts` | 适配层没有 `import 'server-only'` | `web-server-adapter-only-controlled-api-entry` 条件 4 | ZLQ-194 §4.3 / §13(4) |
| 10 | `apps/web/app/api/v1/preview/route.ts` | 导入桶入口 `@littleq/api` 而非受控入口 | 同上 条件 3 | ZLQ-194 §4.3 / §13(4) |
| 11 | `apps/web/src/server/api-bridge.ts` | 从非适配层路径导入受控入口 | 同上 条件 2 | ZLQ-194 §4.3 / §13(4) |
| 12 | `apps/web/src/components/project-list.tsx` | Client Component 导入 `apps/api` | 同上 条件 1 | ZLQ-194 §4.3 / §13(4) |
| 13 | `apps/runtime/src/index.ts` | 通过 `@littleq/api` 别名触达主站应用处理器 | `runtime-no-main-site-units` | ZLQ-194 §13(4)「runtime 仍禁止」 |
| 14 | `packages/domain/package.json` | 依赖 `@neondatabase/serverless` | `domain-no-platform-sdk` | ZLQ-194 §6.1；ZLQ-195 §3.4 |

第 1–8 处是 ZLQ-153 边界，第 9–13 处由 ZLQ-195 §3.2 追加，第 14 处由 ZLQ-195 §3.4 的
依赖冻结追加（理由见下）。

**第 14 处是「冻结依赖」自己带出来的控制用例。** ZLQ-195 §3.4 要求 D0 把 D1–D6 的第三方
依赖一次冻结，其中含 Neon 的 `@neondatabase/serverless`（ZLQ-194 §6.1 的运行连接驱动，
落在 `packages/infra`）。冻结之前这个包不在仓库里，`domain-no-platform-sdk` 的
`packagePrefixes` 自然也没有 `@neondatabase/`；冻结之后它进了 `pnpm-lock.yaml`，
于是领域层可以在门禁**全绿**的情况下直接 `import '@neondatabase/serverless'` ——
这与该规则已经拦住的 `pg`、`@libsql/` 是同一类东西，属于我自己引入的治理回退。
所以补前缀与补控制用例必须同时发生：`@neondatabase/` 已加进**三条**本来就带 `@libsql/` 的规则
（`domain-no-platform-sdk`、`work-contract-no-platform-coupling`、
`api-contract-no-platform-coupling`），本行就是它在 `domain` 那一侧的命中证据。
**第四条 `runtime-no-main-site-secrets` 补不了**，理由与补法写在该规则的 `description` 里，
并由 `tools/test/dependency-graph.test.mjs` 的两条断言钉住（见下）。
种在 `packages/domain/package.json` 而不是某个
`.ts` 里，是为了紧挨着第 2 处的 `pg`：读到这张表的人应该一眼看出这两条是同一个道理。
`tools/test/dependency-graph.test.mjs` 用「把这个键从 JSON 里摘掉，`--expect-failures 14`
必须立刻以退出码 2 变红」做正向对照 —— JSON 不能带注释，所以这一处没有 `SENTINEL:`
行尾标记，靠键名定位。

`packages/infra` 与 `packages/api-contract` 在这里只是被违规指向的目标，两者自身都不含违规
（`packages/api-contract` 刻意零依赖，好让「第 8 处确实来自 apps/runtime 的越界引用」与
「目标单元自己触发了出向禁止」在输出里可以区分开）。`apps/api` 同理：它是第 9–12 处
指向的受控入口所在单元，自身零违规、零依赖。

`packages/work-contract/package.json` 也是零依赖、零违规，但它**不是**任何违规指向的目标 ——
它存在的唯一理由是让第 14 处那个前缀的武装范围可以被扫描证明：`@neondatabase/` 补进了三条
规则，`tools/test/dependency-graph.test.mjs` 会把这棵树复制到临时目录、往
`packages/work-contract`、`packages/api-contract` 两个 manifest 各写一行
`@neondatabase/serverless`，要求计数从 14 恰好变成 16、且新增的两条都归因于这个说明符。
删掉这个文件，`work-contract-no-platform-coupling` 那一侧就退回成「只有 JSON 文本作证据」——
前缀写在配置里不等于扫描器会为它报错（`from` 写错、`appliesTo` 漏掉 `manifest` 都会静默失效）。

### runtime 侧的已知缺口（显式声明，不是漏检）

同一条测试的**下半段**把 `apps/runtime` 的缺口钉成可判定的事实：往
`apps/runtime/package.json` 写 `@neondatabase/serverless`，计数一动不动（14 + 1 = 15，
多出来的那一处是同文件里一起种下的 `@libsql/client`，neon 那一行没被任何规则接住）。

那不是漏检，是 ZLQ-195 §2 的禁区逼出来的：`apps/runtime/src/index.ts` 的 `runtimeIsolation`
自述与 `runtime-no-main-site-secrets` 被 `apps/runtime/test/isolation.test.ts` **双向**锁死，
而那个测试还锁死了 `runtime-*` 规则恰好只有那两条 —— 于是无论「给既有规则补前缀」还是
「新加一条 runtime 规则」都强制同时修改 `apps/runtime/src/index.ts`，那是 D2–D5 的文件。
补法只能是一次**成对**的 D0 修订单：`config/dependency-graph.json` 加前缀 +
自述数组加同一行，缺一不可。落地时这条测试会红，改的人当场就知道要把「三条」改回「四条」、
把缺口那半的 15 改回 16。

缺口这一侧带**正对照**：`@libsql/client` 种在同一个文件里必须命中，否则「neon 没触发」
也可能只是那个 manifest 根本没进扫描面。当前该缺口由 `tools/check-unit-readiness.mjs`
的门 2 兜住（`apps/runtime` 的骨架依赖清单是空的，加任何依赖都判红）；
`apps/runtime` 翻成 `implemented` 之后该兜底失效。

违规 7 是特意加的：`packages/application` **不在** ZLQ-153 §1.3 的目录清单里（§1.3 只列了
`domain / infra / work-contract / design-system`），但 §5.4(4) 已经点名禁止它导入 `drivers/*`。
规则按路径预先武装，这条控制用例证明该包一旦落地就立刻被约束，而不是等到有人想起补规则。
这个规格缺口本身已在 ZLQ-159 交付评论中声明，交架构师裁定，未自行改动 §1.3。

违规 8 走的是**入向**判定：`api-contract-no-platform-coupling` 的 `inbound` 段声明
`allowFrom: [apps/api, packages/application]`、`default: deny`，checker 对文件系统动态发现的
全部单元套用这个默认拒绝，所以 `apps/runtime` 不需要被任何规则点名就已经违规。
`apps/runtime/src/index.ts` 那一行带着 `SENTINEL:api-contract-inbound` 行尾标记，
`tools/test/dependency-graph.test.mjs` 用它做植入哨兵正向对照：先断言标记存在，
再把夹具复制到临时目录删掉该行，`--expect-failures 14` 必须立刻以退出码 2 变红。
同一条规则的**出向** `deny` 由隔离夹具 `tools/__fixtures__/api-contract-outbound` 验证，
不并入本树的计数。

## 受控边（第 9–12 处）：一棵树只让一个条件失守

`web-server-adapter-only-controlled-api-entry` 是 `config/dependency-graph.json` 里第三种
**形状**：既不是出向 `deny`，也不是入向 `inbound`，而是一条**有条件的放行** ——
`apps/web` 可以访问 `apps/api`，但必须同时满足四个条件：

1. 文件序言里没有客户端指令（`'use client'` / `'use dom'`）
2. 文件落在适配层白名单 `apps/web/app/api/**/route.ts[x]` 里
3. 导入的说明符是受控入口 `@littleq/api/server` 本身（不含子路径）
4. 文件显式 `import 'server-only';`

checker 按 1→4 **短路**，一处根因只报一条。所以第 9–12 处每棵树都刻意只让一个条件失守、
其余三个条件全齐 —— 否则一个文件同时违反两三条，就只能证明「门禁会红」，
证明不了「门禁认得出是哪一条」。四棵树的哨兵分别是
`SENTINEL:web-controlled-edge-N1` … `N4`，编号按植入顺序，与条件编号反着来
（N1 是条件 4，N4 是条件 1），对照本表第 9–12 行读。

**正对照**：`apps/web/app/api/v1/turns/route.ts` 四个条件全齐，刻意 0 违规。
没有它，「受控边会红」就证明不了「受控边不是恒红」—— 而一条恒红的规则会让 D6
唯一能做的事就是回来把它删掉。`apps/web/package.json` 也是正对照的一半：它声明了
`"@littleq/api": "workspace:*"` 与 `server-only`，而这两条声明**不产生任何违规** ——
本规则的 `appliesTo` 只有 `source`，正因为 D6 必须能在 `apps/web/package.json` 里
合法地声明这个 workspace 依赖（把它算成违规的话，规则就无法与真实工程共存）。

**第 13 处**（`apps/runtime → @littleq/api`）证明 §13(4) 的另一半「runtime 仍禁止」
仍然成立，且是由**既有**规则 `runtime-no-main-site-units` 承担的 —— 新规则的 `from`
只有 `apps/web`。种在这里而不是只写在规则描述里，是为了让它成为可判定的事实：
谁哪天为了放行 web→api 而顺手把 `apps/api` 从那既有规则的 `deny.units` 里摘掉，
计数就会掉，`pnpm dep-graph:control` 立刻以退出码 2 变红。

### 注释里的 `import 'server-only';` 不算数

第 9 处（`projects/route.ts`）的说明文字里就写着 `` `import 'server-only';` ``，
而该文件**没有**真的导入它。这不是笔误，是永久的回归对照：扫描器用正则读原文，
若不在扫描前抹平注释，那句解释就会被当成真的导入，条件 4 从此恒不触发。
它的失效形态尤其难发现 —— 计数只掉 1（14 → 13），看上去像「夹具写错了」，
不像「门禁漏判了」。

抹平由 `tools/lib/source-scan.mjs` 的 `stripComments` 完成，与就绪门禁
（`tools/check-unit-readiness.mjs`）共用同一份实现：两道门各自维护一份剥离逻辑的话，
同一个文件会在两道门里得出不同判定，而这种分歧不报错，只会静默地让其中一道漏判。
`tools/test/dependency-graph.test.mjs` 里有一条 A/B 断言：把抹平关掉跑同一棵树，
结果必须**恰好少第 9 处这一条**，其余 13 处一条不少、一条不多。

## 计数是锁死的

根 `package.json` 的 `dep-graph:control` 脚本带 `--expect-failures 14`：

```sh
pnpm dep-graph:control   # 期望恰好 14 处违规，多了少了都以退出码 2 失败
```

因此扫描器哪天回归成漏报，**控制用例会先红**，而不是等到真实越界溜进主干。
新增或修改植入的违规时，必须同步更新该计数与本表格。

锁步更新的地方一共六处（`.github/workflows/ci.yml` 里那处只有文案、不含数字断言，
归 D6）：

1. `package.json` 的 `dep-graph:control`
2. `tools/tsconfig.json` 头注释里的示例命令
3. 本 README 的标题、表格与上面那行 `pnpm dep-graph:control`
4. `tools/__fixtures__/api-contract-outbound/README.md`
5. `tools/__fixtures__/api-contract-outbound/packages/api-contract/src/index.ts` 头注释
6. `tools/test/dependency-graph.test.mjs`

控制用例读的是仓库里**真实那一份** `config/dependency-graph.json`（`--policy` 默认取调用方
cwd，不取 `--root`）。fixture 里没有策略副本：否则「fixture 自带一份刚好能抓到 fixture 的
策略」就成了自证，证明不了线上策略有效。

## 为什么用独立的 fixture，而不是改真实单元

真实单元被 ESLint 的 `no-restricted-imports`（同一份 `config/dependency-graph.json` 生成）
与 TypeScript 项目引用同时约束，往里植入违规会连带让 `lint` / `build` 变红，
无法把「依赖图门禁失效」这一个信号隔离出来。fixture 目录被 `.prettierignore`、
`eslint.config.mjs` 与 `tools/tsconfig.json` 一并排除，只有本门禁会读它。

一个已知缺口：`eslint.config.mjs` 只消费 `rule.deny` 与 `rule.inbound`，
**不认** `controlledEdge` 形状，所以第 9–12 处这类越界在编辑器里没有即时反馈，
只有 CI 侧的权威判定。该文件不在 ZLQ-195 §2 的允许改动清单里，缺口已在
`config/dependency-graph.json` 的 `description` 里写明并交给 D6。

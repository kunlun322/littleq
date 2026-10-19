# `tools/__fixtures__/unit-readiness/` — UnitReadiness 门禁的夹具树

本目录的每一棵树都是 `tools/check-unit-readiness.mjs`（ZLQ-194 §9.2 / ZLQ-195 §3.1）的**被测输入**，
不是示例代码、不是模板、也不会被任何构建或测试收集器执行：

- vitest 的 `include` 只有 `packages/*/test/**`、`apps/*/test/**`、`tools/test/**/*.test.mjs`，
  匹配不到这里；
- `tools/tsconfig.json` 排除 `__fixtures__`；
- `eslint.config.mjs` 忽略 `tools/__fixtures__/**`；
- `.prettierignore` 忽略整个 `tools/__fixtures__/` —— **这些文件的字节本身就是被测输入**，
  自动格式化会改变行号，行号是门 5 的报错定位依据。

## 为什么必须用夹具而不是改真实单元

ZLQ-195 §4 陷阱 ②：D0 的文件所有权里**没有**任何单元的 `src/**`（那属于 D2–D6）。
「门会红」只能用夹具证明；为了演示去改真实单元，既是越权，又会把 D2–D6 的基线弄脏。

## 一条纪律：计数是锁死的，不是「大概」

每棵树的违规总数由 `tools/test/unit-readiness.test.mjs` 的 `CASES` 表**精确**断言：
少一处 = 门禁假阴性，多一处 = 规则误报。往任何一棵树里增删植入点，都必须同步改那张表，
否则测试会红 —— 这是刻意的，那张表就是本 README 的可执行版本。

扫描命令（契约固定用线上那份 `tools/unit-readiness-contract.json`，`--contract` 默认取 cwd
而不是 `--root`，所以夹具无法自带一份「专门抓得住自己」的契约来自证）：

```sh
node tools/check-unit-readiness.mjs --root tools/__fixtures__/unit-readiness/<树名> --json
```

## 逐棵树的违规归因

### 判红的树（9 棵）

#### `skeleton-with-named-implementation` — 9 处，门 2

反空转对照 **(a)**：`status` 仍然是 `skeleton`（沿用 `unitManifest.skeletonOnly: true`），
但单元里长出了 route handler、数据库 driver、扫描器，还多了一条新依赖。

| # | 门 | 文件 | subject | 归因 |
| - | -- | ---- | ------- | ---- |
| 1 | 门 2 | `apps/api/src/drivers/neon-driver.ts` | `src/drivers/neon-driver.ts` | 文件路径不在骨架清单（清单里只有 `src/index.ts`） |
| 2 | 门 2 | `apps/api/src/scanner.ts` | `src/scanner.ts` | 同上 |
| 3 | 门 2 | `apps/api/src/drivers/neon-driver.ts` | `connectPooled` | 导出不在骨架导出清单 |
| 4 | 门 2 | `apps/api/src/drivers/neon-driver.ts` | `neon-driver.ts` | 文件名命中具名实现标记 `driver` |
| 5 | 门 2 | `apps/api/src/index.ts` | `NeonDriver` | 导出名命中标记 `driver` |
| 6 | 门 2 | `apps/api/src/index.ts` | `projectsRouteHandler` | 导出名命中标记 `route` + `handler` |
| 7 | 门 2 | `apps/api/src/scanner.ts` | `artifactScanner` | 导出名命中标记 `scanner` |
| 8 | 门 2 | `apps/api/src/scanner.ts` | `scanner.ts` | 文件名命中标记 `scanner` |
| 9 | 门 2 | `apps/api/package.json` | `@neondatabase/serverless` | 依赖不在骨架依赖清单 |

**删文件对照**（`tools/test/unit-readiness.test.mjs` 里做，不改仓库内的夹具）：
把 `apps/api/src/scanner.ts` 从临时副本里删掉，第 2、7、8 三处一起消失，9 → 6，
`--expect-failures 9` 立刻以退出码 2 变红。这证明那 3 处确实归因于那个文件，
而不是环境噪声；也证明门禁不是「有个文件就判红」的恒红逻辑。

**这棵树的 `apps/api/package.json` 里为什么还有 `cookie` 与 `server-only`**：它们是
ZLQ-195 §3.4 冻结给 `apps/api` 的真实依赖，登记在生产契约的 `dependencyFreeze.entries`
里，而门 8 会对**每棵含该单元的树**核对一遍。桩里不写，这棵树就会多判两处门 8，
计数从 9 变 11 —— 而多出来的两处与「骨架长出实现」毫无关系，失败信息看起来却像门 2 坏了。
所以这两条**不是**本树的植入物：它们在契约的 `skeleton.frozenDependencies` 里，门 2 放行，
第 9 处仍然只归因于 `@neondatabase/serverless`（它冻结给的是 `packages/infra`，不在
`apps/api` 的清单内）。同一条锁步适用于所有含 `apps/api` 桩的树，由
`tools/test/unit-readiness.test.mjs` 里「夹具树里的单元桩必须跟着冻结条目走」那条断言看着：
往契约加冻结条目而忘了同步夹具，会得到一条点名到具体树与具体包的失败，而不是一次静默漂移。

#### `implemented-with-empty-capabilities` — 2 处，门 3 + 门 4

反空转对照 **(b1)**：布尔值翻成 `implemented` 了，`capabilities` 却是空数组。

| # | 门 | subject | 归因 |
| - | -- | ------- | ---- |
| 1 | 门 3 | `capabilities` | `implemented` 而能力面为空 —— 正是「翻个布尔值就宣称已实现」 |
| 2 | 门 4 | `turn-to-task-to-safe-event` | 契约为 `apps/api` 点名的黑盒证明缺席 |

这两处一起出现是设计意图：**门 3 单独判红只能说明数组空了，门 4 同时点名缺的是哪一项证明**，
才知道该补什么。

#### `implemented-with-broken-capability-mappings` — 2 处，门 3

反空转对照 **(b2)**：`capabilities` 非空，但能力→验收测试的映射是假的，两种假法各一处。

| # | 门 | 文件 | subject | 归因 |
| - | -- | ---- | ------- | ---- |
| 1 | 门 3 | `apps/api/src/index.ts` | `turn-to-task-to-safe-event -> test/readiness/turn-to-task.test.ts` | 映射指向一个不存在的文件（空指针） |
| 2 | 门 3 | `apps/api/test/unrelated.test.ts` | `ghost-capability` | 映射指向一个真实存在、真的会被收集、活着的测试，但文件正文里**没有出现该能力名** |

第 2 处是本棵树存在的理由：只查「文件存在」的门禁可以被一行空测试糊弄过去。
这里要求映射目标必须 (i) 存在、(ii) 落在契约的 `testFileGlobs` 内、(iii) 至少有一条活用例、
(iv) 正文出现能力名 —— 四条同时成立才算数。

#### `implemented-missing-required-proof` — 1 处，门 4

`packages/work-contract` 声称 `implemented`，契约为它点名两项黑盒证明
（`safe-package-passes`、`every-block-category-negative-fails`），声明里只有第一项。

| # | 门 | subject | 归因 |
| - | -- | ------- | ---- |
| 1 | 门 4 | `every-block-category-negative-fails` | 「每个拦截类别的负例都必须失败」这项证明缺席 |

#### `retired-with-skip-tokens` — 4 处，门 5

§9.2 规则 5 点名的四种退役写法各一处，行号写死在表里 —— 门 5 的报错必须可定位。

| # | 文件:行 | subject |
| - | ------- | ------- |
| 1 | `apps/worker/test/index.test.ts:14` | `describe.skip` |
| 2 | `apps/worker/test/index.test.ts:20` | `it.only` |
| 3 | `apps/worker/test/index.test.ts:24` | `it.todo` |
| 4 | `apps/worker/test/index.test.ts:26` | `it.skipIf` |

本棵树的 tripwire 是**活的**，所以门 1 不判红 —— 这是刻意的归因隔离：
门 5 独立生效，不是「因为门 1 顺带红了」。
刻意不含 `it.fails`：§9.2 规则 5 没有列它，而 D4 的「每个拦截类别的负例都必须失败」
可能正当地用到期望失败的写法；门禁不该比契约更严。

#### `regressed-from-implemented` — 5 处，门 6 + 门 2

`packages/domain` 从 `implemented` 退回 `skeleton`（`unitManifest.skeletonOnly: true`）。

| # | 门 | 文件 | subject | 归因 |
| - | -- | ---- | ------- | ---- |
| 1 | 门 6 | `packages/domain/src/index.ts:16` | `status` | 状态机只允许 `skeleton->implemented`，反向是被禁止的转移 |
| 2 | 门 2 | `packages/domain/src/index.ts` | `src/index.ts` | 门 6 判红后 `status=skeleton` 让门 2 开始生效，而 `packages/domain` 在契约里**没有骨架清单**，任何文件都不在清单内 |
| 3 | 门 2 | `packages/domain/src/index.ts` | `UNIT_ID` | 同上（导出） |
| 4 | 门 2 | `packages/domain/src/index.ts` | `UnitManifest` | 同上（导出） |
| 5 | 门 2 | `packages/domain/src/index.ts` | `unitManifest` | 同上（导出） |

第 2–5 处不是误报，而是棘轮的**牙齿**：想真把一个已实现的单元退回 skeleton，
必须先删掉它全部实现文件、导出与依赖才可能过门 2 —— 那本身就是一次显式的、必须过评审的回退。

棘轮的判据来自契约**结构**（「契约给了骨架清单的单元才允许处在 skeleton」），
不是契约里记一个「本单元曾经是 implemented」的布尔值。后者是当前值的快照，
而且 D2–D6 每翻一个单元都要回来改 D0 的文件 —— ZLQ-195 §7 弱出口 ① 明令禁止。

#### `declaration-unparseable` — 4 处，门 7

就绪声明写坏了必须判红，不能静默当作「没有声明」放过（那等于给绕过门禁留了一条路：
把声明写成解析不了的样子，门 2/3/4 就都不生效了）。

| # | 文件 | 归因 |
| - | ---- | ---- |
| 1 | `apps/runtime/src/index.ts` | `status` 的值不在状态机 `skeleton / implemented` 里 |
| 2 | `apps/runtime/src/index.ts` | 缺少 `capabilities` 数组字面量 |
| 3 | `apps/runtime/src/index.ts` | 缺少 `acceptanceTests` 对象字面量 |
| 4 | `apps/worker/src/index.ts` | 对象字面量花括号不配对，整体解析不出就绪声明 |

#### `missing-flip-tripwire` — 1 处，门 1

`apps/worker/test/index.test.ts` 里有活用例，但**没有一条断言就绪面**
（`skeletonOnly` / `unitReadiness`）。

| # | 门 | 文件 | subject | 归因 |
| - | -- | ---- | ------- | ---- |
| 1 | 门 1 | `apps/worker/test` | `skeletonOnly / unitReadiness` | 找不到活着的、断言就绪面的钉版测试 ⇒ 改状态不会先红 ⇒ 显式翻转门等于不存在 |

门 1 刻意**只查存在与活性，不查期望值**：断言的是 `true` 还是 `false` 属于单元自己的测试，
不属于 D0。这正是 §9.2 规则 1「双重 tripwire」的第一重，也是本门禁不复述那个布尔值的原因。

#### `tripwire-retired-by-skip` — 2 处，门 1 + 门 5

门 1 与门 5 的**交叉**用例：`apps/api/test/index.test.ts` 只有一行，形状完全合格
（既含就绪面词、又含 `expect(...).toBe(...)`），但被 `it.skip` 退役了。

| # | 门 | 文件 | subject | 归因 |
| - | -- | ---- | ------- | ---- |
| 1 | 门 1 | `apps/api/test` | `skeletonOnly / unitReadiness` | 形状合格但活性为 0 ⇒ tripwire 不存在 |
| 2 | 门 5 | `apps/api/test/index.test.ts:9` | `it.skip` | 用 skip 退役 |

没有这棵树，「门 1 只数活用例」就只是一句声明：一个把 `it.skip` 也算成存在的门禁
在这里会判绿。

### 判绿的正对照树（2 棵）

正对照和判红树同样重要 —— 它们证明门不是恒红的（恒红的门 D2–D6 无从落地，
最终只会被关掉）。

#### `legal-skeleton-with-readiness-declaration` — 0 处

`apps/api` 处在 `skeleton`，但**已经采用** §9.2 的 `unitReadiness` 声明形式
（`status` / `capabilities` / `acceptanceTests` 三个字段齐全），文件、导出、依赖都在
契约的骨架清单内，tripwire 活着。

它同时是「门 7 不是恒红」与「门 2 认得声明形式」的证据：D2–D6 一旦写下真正的
`unitReadiness` 声明，门 3、门 4 自动开始生效，**不需要回头改 D0**。

#### `legal-implemented-with-proofs` — 0 处

`packages/work-contract` 处在 `implemented`，契约点名的两项黑盒证明都出现在
`capabilities` 里，且各自映射到一个真实存在、落在 `testFileGlobs` 内、活着、
正文含能力名的测试：

- `safe-package-passes` → `test/safe-package.test.ts`
- `every-block-category-negative-fails` → `test/block-categories.test.ts`（用 `it.each` 覆盖
  三个拦截类别，正好对上「每个拦截类别的负例都必须失败」）

它同时是门 8（依赖冻结）对照用例的宿主树：往契约里加一个探针冻结条目
`@littleq/frozen-control-probe`，这棵树立刻判红；把该依赖写进
`packages/work-contract/package.json`，又回到 0 违规。两个方向都验，
且**不改生产契约**（生产契约的冻结条目是 D1–D6 真实要用的依赖）。

探针对照证明的是「门 8 有判别力」，但它两端都是合成的：合成树 + 合成契约。
所以还有一条走真东西的对照，也不在本目录里：把真实仓库的 `apps/api` 整棵复制到临时目录，
只删掉 `dependencies.cookie` 一个键，生产契约必须**恰好**判出一处门 8 且 subject 是 `cookie`、
reason 里点得出条目 id `session-cookie`。少了它，「八条冻结条目在真实仓库里都兑现了」
这句话就只剩 `scan(REPO_ROOT)` 的 0 违规作证据，而 0 违规同样可能来自门 8 整体哑火。

## 门 → 命中它的树（覆盖率自检）

| 门 | id | 命中的树 |
| -- | -- | -------- |
| 门 1 | `readiness-flip-tripwire-present` | `missing-flip-tripwire`、`tripwire-retired-by-skip` |
| 门 2 | `readiness-anti-lie-skeleton` | `skeleton-with-named-implementation`、`regressed-from-implemented` |
| 门 3 | `readiness-capabilities-non-empty` | `implemented-with-empty-capabilities`、`implemented-with-broken-capability-mappings` |
| 门 4 | `readiness-blackbox-proofs` | `implemented-with-empty-capabilities`、`implemented-missing-required-proof` |
| 门 5 | `readiness-no-retirement-tokens` | `retired-with-skip-tokens`、`tripwire-retired-by-skip` |
| 门 6 | `readiness-no-regression` | `regressed-from-implemented` |
| 门 7 | `readiness-declaration-unparseable` | `declaration-unparseable` |
| 门 8 | `readiness-dependency-freeze-intact` | **不由夹具树证明** —— 夹具树是真实仓库的局部副本，不该承担「真实依赖是否还在」这个事实。它由两组对照证明：临时契约探针（见上）与真实 `apps/api` 摘掉 `cookie`（见上），因为生产契约的冻结条目属于真实依赖，不能为了对照去改它 |

`tools/test/unit-readiness.test.mjs` 把这张表变成断言：契约声明的门减去被树命中的门，
必须**恰好**等于 `['readiness-dependency-freeze-intact']`；反向也断言门禁不会吐出一个
契约没声明的 id（否则报错里的 spec 锚点是空的）。

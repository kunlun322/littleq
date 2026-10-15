# 贡献指南

> 开发流程细节仍待架构设计补充。已经落定并写在这里的有三件事：**提交代码即同意
> AGPL-3.0**、**依赖许可证准入**（自仓库创建起即生效）、**TypeScript 双工具链**
> （7.0.2 原生编译器 + 6.x 编译器 API 并行）。CI 门禁一节列出这两条规则各自被哪一道
> 闸门强制。

## 提交代码即同意 AGPL-3.0

向本仓库提交 Pull Request 或补丁，即表示你同意你的贡献以 AGPL-3.0 许可证（见
[LICENSE](LICENSE)）对外授权，并同意项目所有者将你的贡献纳入本项目及其各分发形态
（含 Docker 镜像与部署模板）。本期不设 CLA、不做双授权。

修改本项目并通过网络对外提供服务的，依 AGPL-3.0 §13 须向你的用户提供你所修改版本
的对应源码获取途径。

## 依赖许可证准入规则（V11 / CI 门禁）

AGPL-3.0 具有网络传染性：与 AGPL 不兼容、或需商业授权才能使用的依赖，一经引入即
成为发布阻塞项。

下面三档与门禁实现**逐字一致**：机器可执行的事实来源是 `config/license-policy.json`，
`tools/test/license-policy.test.mjs` 断言本文档三档标题下的 SPDX 标识符集合与该文件的
`allowed` / `reviewRequired.exact` / `forbidden` 完全相同——改了一边没改另一边，CI 直接红。
因此三档标题下**只对许可证标识符加反引号**，别的内容一律不加，否则那条断言会把它当成许可证。

两点通用口径：门禁是 fail-closed 的，**未知即不合规**——解析不出任何许可表达式的依赖按
"无法解析"处理，与禁止项同一档（退出码 1）；禁止档里的 UNLICENSED 与 NOASSERTION
不是许可证名，而是"包内没有可用许可声明"的表达形式。

**允许**（自动放行，退出码 0）
`MIT`、`ISC`、`BSD-2-Clause`、`BSD-3-Clause`、`Apache-2.0`、`0BSD`。

**需逐案评审**（退出码 2；须在 config/license-policy.json 的 adjudications 里登记架构师裁定后方可通过）
`MPL-2.0`、`MPL-1.1`、`MPL-2.0-no-copyleft-exception`、`GPL-3.0-only`、`GPL-3.0-or-later`、
`GPL-3.0`、`GPL-2.0-or-later`、`AGPL-3.0-only`、`AGPL-3.0-or-later`、`AGPL-3.0`、
`LGPL-2.1-only`、`LGPL-2.1-or-later`、`LGPL-2.1`、`LGPL-3.0-only`、`LGPL-3.0-or-later`、
`LGPL-3.0`、`EPL-1.0`、`EPL-2.0`、`CDDL-1.0`、`CDDL-1.1`、`BlueOak-1.0.0`、`Zlib`、
`zlib-acknowledgement`、`Unlicense`、`CC0-1.0`、`CC-BY-3.0`、`CC-BY-4.0`、`CC-BY-SA-4.0`、
`OFL-1.1`、`Python-2.0`、`Artistic-2.0`、`WTFPL`、`UPL-1.0`。

**禁止**（退出码 1，硬性失败，无豁免通道）
`GPL-2.0-only`、`GPL-2.0`、`SSPL-1.0`、`BUSL-1.1`、`Elastic-2.0`、`Elastic-License-2.0`、
`UNLICENSED`、`NOASSERTION`、`CC-BY-NC-4.0`、`CC-BY-NC-SA-4.0`、`CC-BY-NC-ND-4.0`、
`CC-BY-NC-3.0`。
许可表达式里的自由文本命中下列任一子串（大小写不敏感）同样判禁止——写"见某某文件"
不等于声明了许可：
`commons clause`、`see license in`、`commercial only`、`commercial-only`、
`non-commercial`、`non commercial`、`noncommercial`、`source available`、
`source-available`、`proprietary`、`no license`、`busl`、`sspl`、`elastic license`。

**素材（字体、图片、音效）**：必须具有可再分发的商用授权（常见 OFL、CC0、CC-BY，
须附来源与许可说明）；授权不明的素材一律不得使用。素材许可清单与代码依赖许可清单
分开维护。注意上述素材许可证在代码依赖门禁里同样属于需逐案评审档。

### 为什么 MPL / AGPL / GPL-3.0 不在允许档

允许档只有六项，与 ZLQ-153 §10.3 的白名单一致。MPL-2.0、AGPL-3.0、GPL-3.0-or-later
虽然直觉上"与 AGPL 兼容"，但在本门禁里属于需逐案评审档：文件级/强 copyleft 的兼容性
取决于具体版本、附加条款与分发形态，须逐案确认。本项目自身以 AGPL-3.0-only 发布，
并不使声明 AGPL-3.0 的**依赖**自动获得放行。

### 裁定的登记与批准前提

裁定结果写成 approved 时**必须**带 distributed 前提声明。目前两条已批准的裁定
（lightningcss 的 MPL-2.0 家族、minimatch 的 BlueOak-1.0.0）前提是 distributed:false，
即"只作为 devDependency 使用、不随产物或镜像分发"。这个前提由代码强制，不是注释：
一旦某个包变成生产依赖、被打包进 bundle、或进入镜像，`tools/lib/collect.mjs` 的
`approvalOutOfScope()` 会让批准当场失效并退回待裁定档（退出码 2），三处扫描
（源码闭包 / bundle / 镜像）各判一次，因为"是否在分发"只有在各自那一侧才看得见。

批准也**不会**放宽许可档位：上述标识符仍留在 reviewRequired 里，新引入的同许可证依赖
照样要重新裁定。

## TypeScript 工具链：7.0.2 原生 + 6.x 编译器 API 并行

根 `package.json` 用 npm 别名把两条 TypeScript 工具链并排装在一起。这不是冗余，
两边各有不可替代的用途：

| devDependencies 键 | 实际安装的包 | 提供 | 谁在用 |
| --- | --- | --- | --- |
| `@typescript/native` | `typescript@7.0.2` | `tsc`（原生实现，按平台分发二进制，约 20 个 `@typescript/typescript-<os>-<arch>` 可选依赖） | `pnpm typecheck`、`pnpm build` 里的 `tsc -b` / `tsc -p` |
| `typescript` | `@typescript/typescript6@6.0.2`（转发到 `typescript@6.0.3`） | `tsc6` 与 JS 编译器 API（`import 'typescript'`） | typescript-eslint 的类型感知规则 |

为什么必须两套：7.x 原生编译器**不提供 JS 编译器 API**（`tools/check-dependency-graph.mjs`
的头部注释记录的是同一个约束），而 `typescript-eslint@8.71.2` 的 peer 范围是
`typescript: '>=4.8.4 <6.1.0'`——它既拿不到 7.x 的 API，也不接受 7.x 的版本号。
于是分工是：**跑类型检查与产出 `dist/`** 用 7.0.2（ZLQ-153 §2.1 冻结的目标版本），
**解析类型**（ESLint 侧）用 6.x。pnpm 会把 `@typescript-eslint/*` 的 peer 解析到 6.x
那一份，`node_modules/.pnpm` 目录名里的 `_@typescript+typescript6@6.0.2` 后缀就是
这次解析的结果。

这是对 ZLQ-153 §2.1 的一处**已获接受的偏离**（ZLQ-162 由产品经理裁定接受）。偏离的边界：

- `dist/` 只由 `tsc -b`（7.0.2）产出，不得改用 `tsc6` 生成交付物；
- 不得为了迁就 ESLint 把 `tsc` 降回 6.x——那会让类型检查不再覆盖 §2.1 冻结的版本；
- 升级任何一侧之前，先确认另一侧的约束仍然满足（尤其是 typescript-eslint 的 peer 上限）。

排障时以实际输出为准：6.x 这一侧有两个版本号，包本身是 `@typescript/typescript6@6.0.2`，
它转发的编译器自报 6.0.3，所以 `pnpm exec tsc6 --version` 与 `import('typescript').version`
都是 6.0.3。`pnpm exec tsc --version` 则是 7.0.2。

## CI 门禁

两道工作流，都是 fail-closed 的：

- `.github/workflows/ci.yml`（name: ci）——`quality` 作业跑 `pnpm verify` 的 14 道闸门
  （类型检查、lint、格式、依赖图及其反例对照、构建、四处许可证扫描、SBOM、测试），
  `e2e-smoke` 作业跑 Playwright 冒烟。
- `.github/workflows/license-check.yml`（name: license-check）——依赖许可证门禁，
  以 `pnpm license:scan` 的退出码为准，并把待裁定清单写进 step summary。

两条与实现绑定的性质，各有测试钉住，改坏了会红：

1. **工作流里实际执行的步骤顺序与 `pnpm verify` 的链路顺序等价**
   （`tools/test/ci-workflow.test.mjs`）。ZLQ-160 的首跑事故正是这两者不等价：
   类型检查排在构建之前，而 `packages/*/package.json` 的 `types` 指向只有构建才生成的
   `dist/index.d.ts`，干净检出上必然报 9 处 TS2307。现在的修法是让 `pnpm typecheck`
   自带 `tsc -b`（自足），而不是把 CI 的步骤顺序当成隐含前提。
2. **许可证判定结果与 runner 平台无关**（`tools/test/license-platform-independence.test.mjs`）。
   受 `os` / `cpu` / `libc` 约束的包（例如 darwin-only 的 `fsevents`、原生编译器的平台二进制）
   一律从已提交的 `config/license-registry-facts.json` 注册表事实快照解析，并与 lockfile 的
   `resolution.integrity` 交叉校验；快照缺条目或校验不过都判"无法解析"，不退回"本机装了什么"。
   快照由 `pnpm license:registry-facts` 生成，需要网络，因此**不在** `verify` 与任何工作流里；
   它是提交进仓库的事实，改动要走 PR。

引入新生态（Python / Go / Rust / JVM）时，请在同一个 PR 里为该生态配置检查器与允许清单：
`license-check.yml` 检测到依赖清单而没有对应检查器时会失败，不会静默通过。

## 安全红线

- 任何真实凭证（QCA PAT、百炼 API Key、数据库口令等）不得进入仓库、commit、分支、
  CI 日志或示例文件；示例只用明显的占位值（如 `CHANGE_ME`、`FAKE_PROBE_VALUE`）。
- `.gitignore` 已覆盖常见凭证载体，但它只是第一道防线，不依赖它兜底。
- 构建脚本、依赖安装、数据库迁移不得读取生产凭证（防止凭证进入平台侧构建日志）。

# 许可证门禁控制用例（反假阴性夹具）

目录布局：`ok/`、`review/`、`violation/` 各含一份 `pnpm-lock.yaml` 与一个 `installed/` 目录。

`tools/license/control.mjs` 用这三份夹具把 `tools/license/scan.mjs` 的三档退出码全部走一遍。
门禁最危险的失效方式不是报错，而是「永远返回 0」——一份能让门禁红起来的夹具，
和一份能让门禁绿起来的夹具，缺一不可。

| 夹具 | 期望退出码 | 证明的事 |
| --- | --- | --- |
| `ok/` | 0 | 六项白名单全通过；`link:` workspace 依赖不进闭包；npm alias、peer 后缀 snapshot、平台变体同族推断四条解析分支都真的走到了 |
| `review/` | 2 | GPL/LGPL/MPL 不被自动裁定：未登记 → 判红并要求架构师评审；已登记 `pending-architect` → 放行但三处留痕 |
| `violation/` | 1 | 禁止项硬性失败，六种形态逐条点名 |

## 为什么夹具不带自己的策略

三份夹具都用仓库线上那份 `config/license-policy.json`（`control.mjs` 以相对路径传给 `--policy`）。
如果夹具自带一份策略副本，那「夹具带一份能抓住夹具的策略」就成了自证——它证明的是副本有效，
不是门禁有效。同理，`--expect` 值直接写在 `control.mjs` 的断言里，不从夹具读。

## 为什么是 `installed/` 而不是 `node_modules/`

`indexInstalledPackages(root, 'flat')` 按 `<root>/<目录名>/package.json` 建索引，
索引键取自 manifest 的 `name` + `version`，目录名只是载体。
用 `flat` 是刻意的：`.gitignore` 排除了任意层级的 `node_modules/`，
而 git 无法重新包含「父目录已被排除」的文件——真实 pnpm 布局
`node_modules/.pnpm/<entry>/node_modules/<name>/package.json` 有两级这样的目录，
夹具一旦用它就永远进不了仓库，CI 上也就无从复现。

## 断言的不只是退出码

只断言退出码的话，一个把所有依赖都判成 `allowed` 的坏实现同样能通过 `license-ok`。
所以 `control.mjs` 逐条断言判定明细：闭包总量、prod/dev 归类、孤立条目、四种解析来源的分布、
每个夹具包的许可表达式与 verdict、待裁定登记状态，以及 stdout / 待裁定清单文件 / CI step summary
三处留痕是否都出现了该出现的包名。当前共 61 条断言。

## `violation/` 的六种失败形态

1. `unlicensedfixture` — `UNLICENSED`，策略显式禁止。
2. `nolicensefield` — 已安装但 `package.json` 无 `license`/`licenses` 字段。解析器在这里**立刻返回**
   而不继续降级（否则后面的同族推断会把它洗白），扫描器把它表达成 `NOASSERTION` 并判禁止。
   这是 issue 点名的「无许可声明」。
3. `ssplfixture` — `SSPL-1.0`，策略显式禁止。
4. `proprietaryfixture` — `SEE LICENSE IN proprietary-terms.txt`，命中禁止子串
   （`see license in` / `proprietary`）。自由文本不放行。
5. `absentfixture` — lockfile 里有、四级解析全部落空 → `unknown`。未知即不合规。
6. `conflictfamily-win32-x64` — 同族已安装兄弟给出互相矛盾的许可（`MIT` vs `ISC`）→ 解析器
   拒绝裁决，返回 `unknown`。这条证明「推断」没有退化成「猜测」：宁可判红让人来看，
   也不随便挑一个兄弟的许可证填上。

对照项 `zod`（MIT）、`conflictfamily`（MIT）、`conflictfamily-darwin-arm64`（MIT）、
`conflictfamily-linux-x64`（ISC）在同一份夹具里判为 `allowed`——证明扫描器是逐条判定，
不是一见禁止项就把整份报告判死。

## `ok/` 的包名约束

同族推断按「名字尾部逐段削去 + 同版本」找兄弟，所以 `fakebuild-*` 这一族之外的包
名字里不能出现 `fakebuild-` 前缀；反过来，若给某个不相关的包起名 `fakebuild-anything`
且版本同为 `1.0.0`，就会污染推断结果。新增夹具包时请沿用现在这套互不前缀重叠的命名。

`fakebuild`（父包，MIT）与 `fakebuild-darwin-arm64`（平台二进制，BSD-2-Clause）刻意用了
**不同**的许可证：真实的 esbuild 家族里两者一致，但那样就区分不出「推断取的是同族平台变体」
还是「推断错误地取了父包」。`control.mjs` 断言 `fakebuild-linux-x64` 的推断结果是
`BSD-2-Clause` 而非 `MIT`，正是靠这个差异。

## 假 integrity

所有 `resolution.integrity` 都是 `sha512-LQ159FIXTURENOTAREALINTEGRITY…` 形式的显式假值。
夹具不参与安装，也不该看起来像真包；解析器只把它原样存进报告，不做校验。

# 许可证门禁控制用例（反假阴性夹具）

目录布局：`ok/`、`review/`、`scope/`、`violation/` 各含一份 `pnpm-lock.yaml` 与一个 `installed/` 目录；
`ok/` 另有一份 `config/license-registry-facts.json`（手写的夹具快照，见下文）。

`tools/license/control.mjs` 用这四份夹具把 `tools/license/scan.mjs` 的三档退出码全部走一遍。
门禁最危险的失效方式不是报错，而是「永远返回 0」——一份能让门禁红起来的夹具，
和一份能让门禁绿起来的夹具，缺一不可。

| 夹具 | 期望退出码 | 证明的事 |
| --- | --- | --- |
| `ok/` | 0 | 六项白名单全通过；`link:` workspace 依赖不进闭包；npm alias、peer 后缀 snapshot 两条解析分支都真的走到了；被 os/cpu 约束的平台变体从**夹具快照**解析（本机没装也能判），无平台约束的包仍读真实 `installed/` manifest |
| `review/` | 2 | GPL/LGPL/MPL 不被自动裁定：未登记 → 判红并要求架构师评审；已登记 `approved` + `distributed:false` 且确实是 devDependency → 批准生效、放行，且不混进待裁定清单 |
| `scope/` | 2 → 0 → 0/2 | 同一条 `approved` + `distributed:false` 的裁定，包被放进 `dependencies`（生产依赖）后**批准前提失效**：判定退回 `review-required`、退出码 2、清单标 `STALE`。三次复跑构成对照，见「`scope/` 与派生策略」 |
| `violation/` | 1 | 禁止项硬性失败，六种形态逐条点名 |

## 为什么夹具不带自己的策略

四份夹具都用仓库线上那份 `config/license-policy.json`（`control.mjs` 以相对路径传给 `--policy`）。
如果夹具自带一份策略副本，那「夹具带一份能抓住夹具的策略」就成了自证——它证明的是副本有效，
不是门禁有效。同理，`--expect` 值直接写在 `control.mjs` 的断言里，不从夹具读。

## `scope/` 与派生策略

ZLQ-162 把线上策略里两条 `pending-architect` 裁定翻成了 `approved`（治理裁定 3），
于是「已登记但等待裁定」这一档在线上策略下已经无法触发。丢掉这档覆盖等于让门禁少一条被验证的分支，
所以 `control.mjs` 提供 `derivePolicy(id, set)`：从线上策略复制一份，**只**改
`adjudications.entries` 里某条的 `status` / `distributed`（可派生字段白名单之外一律抛错），
写进临时目录后以绝对路径传给 `--policy`。

这不是「夹具自带策略副本」的翻版，因为两件事被断言而不是被约定：

- `onlyEntriesChanged` — 除 `adjudications.entries` 之外的字节与线上策略完全一致。
  档位（`allowed` / `reviewRequired` / `forbidden` / `spdx`）一旦被派生策略动过，
  夹具通过与否就由派生出来的档位决定，控制用例当场退化成自证。
- `changed` — 这次改动确实改了值。否则「把 `approved` 派生成 `approved`」这种空对照
  会让绿半场毫无意义地通过。

`scope/` 的四次运行构成一组判别性对照：

| 运行 | 策略 | `--strict` | 期望 | 证明的事 |
| --- | --- | --- | --- | --- |
| 1 | 线上真策略 | 否 | 2 | `distributed:false` 的批准覆盖到生产依赖时**必须失效** |
| 2 | 派生 `distributed:true` | 否 | 0 | 判的是 `distributed` 这个前提，不是「生产依赖里的 reviewRequired 一律判红」 |
| 3 | 派生 `distributed:true` + `status:pending-architect` | 否 | 0 | 等待裁定不判死，但三处留痕齐全 |
| 4 | 同 3 | 是 | 2 | `--strict` 真的能把同一份夹具从 0 推到 2（判别力，不是恒真） |

运行 2 与运行 4 尤其重要：只有红半场的控制用例分辨不出「按前提判」与「一律判红」这两种实现，
而后者同样能让运行 1 通过，却抓不住真正的失效场景——批准跟着依赖搬进产物。
变异验证也确认了这一点：把 `approvalOutOfScope()` 改成永远返回 `null`（即批准无条件有效）
会让运行 1 变绿、11 条断言变红；把 `distributed !== false` 的判断去掉（即一律判红）
则让运行 2 变红、6 条断言变红。两处变异抓的是不同的那一半。

`review/` 夹具另配两次派生运行，覆盖裁定状态机的另外两档：`pending-architect` → 判定不抬升、
清单标 `pending`；`rejected` → 判 `forbidden`、退出码 1。没有 `rejected` 这一条，
「登记了就放行」这种坏实现在本控制用例下同样能通过。

## 为什么是 `installed/` 而不是 `node_modules/`

`indexInstalledPackages(root, 'flat')` 按 `<root>/<目录名>/package.json` 建索引，
索引键取自 manifest 的 `name` + `version`，目录名只是载体。
用 `flat` 是刻意的：`.gitignore` 排除了任意层级的 `node_modules/`，
而 git 无法重新包含「父目录已被排除」的文件——真实 pnpm 布局
`node_modules/.pnpm/<entry>/node_modules/<name>/package.json` 有两级这样的目录，
夹具一旦用它就永远进不了仓库，CI 上也就无从复现。

## 断言的不只是退出码

只断言退出码的话，一个把所有依赖都判成 `allowed` 的坏实现同样能通过 `license-ok`。
所以 `control.mjs` 逐条断言判定明细：闭包总量、prod/dev 归类、孤立条目、解析来源的分布、
每个夹具包的许可表达式与 verdict、裁定条目的 `status` / `distributed` / `outOfScope`，
以及 stdout / 待裁定清单文件 / CI step summary 三处留痕是否都出现了该出现的包名与档位标签
（`MISSING` / `STALE` / `pending` 三者不得互相混标）。当前共 131 条断言。

`control.mjs` 也刻意**不给 `scan.mjs` 传 `--json`**：报告从 `--out` 的文件里读，
stdout 保留给人读的那一档。传了 `--json` 的话 stdout 只剩 summary JSON，
「stdout 点名某某」这类断言会被 JSON 里的包名字段满足，于是证明不了
「`!! 待裁定但未登记`」那几行真的打印出来了——而「三处留痕」的第一处正是它。

## `ok/` 的注册表事实快照

`ok/config/license-registry-facts.json` 是手写的夹具数据，不是生成物：`fakebuild-*` 是虚构包，
注册表上不存在。它复刻的是 ZLQ-162 缺陷 2 的最小场景——`fakebuild-linux-x64` 被 `os`/`cpu`
约束，本机（macOS）装不到，修复前只能靠已安装的 darwin 兄弟同族推断；到 Linux runner 上
darwin 兄弟也没装，推断链断掉就变成 `unknown`、退出码 1。

两个变体都必须收录：resolver 对**所有**被 os/cpu/libc 约束的条目一律走快照，不管本机装没装到。
只收「本机装不到的那一个」会让已装的那个暴露成 `unknown`——那正是「判定依赖 runner 上恰好装了什么」
的另一种表现。其余 5 个包没有平台约束，仍从 `installed/` 下的真实 manifest 解析，
用来源分布断言（`installed-manifest: 5, registry-facts: 2`）钉住「快照不是给所有包发证的后门」：
否则 `violation/` 里「已装但未声明 license」那一禁止项就再也查不出来。

`violation/` 刻意**不带**快照，因此它的 `conflictfamily-*` 仍走同族推断分支，
「兄弟互相矛盾时拒绝裁决」这条性质由它覆盖。

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

`fakebuild`（父包，MIT）与 `fakebuild-*-1.0.0`（平台二进制，BSD-2-Clause）刻意用了
**不同**的许可证：真实的 esbuild 家族里两者一致，但那样就区分不出「取的是这一族平台变体的事实」
还是「错误地取了父包的 manifest」。`control.mjs` 断言 `fakebuild-linux-x64` 的结果是
`BSD-2-Clause` 而非 `MIT`，正是靠这个差异。

## 假 integrity

所有 `resolution.integrity` 都是 `sha512-LQ159FIXTURENOTAREALINTEGRITY…` 形式的显式假值。
夹具不参与安装，也不该看起来像真包。

但「不做校验」只对无平台约束的条目成立。走快照的平台变体会被 `resolveFromFacts()` 交叉校验：
快照里的 `integrity` 必须与 lockfile 的 `resolution.integrity` 逐字节相同，否则判 `unknown`。
所以改 `ok/pnpm-lock.yaml` 里 `fakebuild-*` 的 integrity 时，必须同步改
`ok/config/license-registry-facts.json` 里对应那一条——不同步会让 `license-ok` 以退出码 1 变红。
这是校验在起作用，不是夹具坏了。三道 fail-closed 检查（快照缺条目 / integrity 不一致 /
与已安装 manifest 矛盾）的单测在 `tools/test/license-registry-facts.test.mjs`。

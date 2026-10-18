# 这个目录代表「base 里已经有 v1 snapshot」

目录名 `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` 是一个合成的 40 位小写 hex，
`createFixtureTransport` 把「`git/<sha>/` 目录存在」当成「base commit 可读取」，把
`git/<sha>/<相对路径>` 文件存在当成「那个 blob 读得出来」。

## `openapi.json` 里为什么有一个 head 没有的端点

附录 B 对这一格的要求是两句话，缺一不可：

> 一旦 base 已含任一 v1 snapshot/bootstrap，必须进入正常兼容比较，bootstrap 分支永久不可再触发。

> SHA 不匹配或 base 已有 snapshot 必须**红**。

所以本 fixture 的 `paths` 里放了 `/probe-gone-in-head`：head（`bootstrap/head/`）里没有它，
退回比较后必然报 `OPENAPI_BREAKING_OPERATION_REMOVED`，退出码 1。若把这里清空成
`"paths": {}`，`bootstrap-refused-base-has-snapshot` 会退化成 exit 0 —— 首落窗口已过却仍然
放行，正是附录 B 要堵死的那条路。

同时 head 里有一个本 fixture 没有的 `/probe`，于是报告里必然同时出现
`OPENAPI_COMPATIBLE_OPERATION_ADDED`。两条规则一起断言，才证明「退回的是一次真实比较」，
而不是又一条短路分支。**不要**只保留其中一边。

## `error-catalog.json`

保持最小合法形状（`apiMajor: 1`、空 `codes`、空 `taskErrorRegistry`）。错误目录这一侧不参与
本 fixture 要证明的事，让它在比较里保持中立，findings 才不会混进无关规则。

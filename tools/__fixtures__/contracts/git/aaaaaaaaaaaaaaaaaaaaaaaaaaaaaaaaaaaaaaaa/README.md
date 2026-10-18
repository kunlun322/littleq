# 这个目录**故意**不含任何契约路径

目录名 `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` 是一个合成的 40 位小写 hex，
`createFixtureTransport` 把「`git/<sha>/` 这个目录存在」当成「base commit 可读取」。

所以本目录代表的是附录 B 反复强调的那个分界：

> base commit **可读取**，但其中不存在 `contracts/openapi/v1/` 与 `contracts/errors/v1/`
> 的任何 v1 snapshot / bootstrap。

它与「base commit 读不出来」（fixture 里表现为 `dddd…` 目录**不存在**）是两种完全不同的
情况，判定结果也完全不同：

| fixture | base 可读 | base 里有 v1 路径 | 期望 |
| --- | --- | --- | --- |
| `aaaa…`（本目录） | 是 | 否 | 只允许走一次性 bootstrap；没有合法 bootstrap.json 就 `CONTRACT_BASE_UNAVAILABLE`（exit 2） |
| `bbbb…` | 是 | 是 | bootstrap 分支永久失效，退回正常兼容比较；其快照里有一个 head 已删除的端点，所以比较结果必然是破坏（exit 1） |
| `dddd…`（不存在） | 否 | — | `CONTRACT_BASE_UNAVAILABLE`（exit 2） |

本文件存在的唯一目的是让 git 能提交一个空目录。**不要**在这里放任何
`contracts/openapi/v1/openapi.json`、`contracts/errors/v1/error-catalog.json` 或
`contracts/openapi/v1/bootstrap.json` —— `contract:control` 的
`assertPlatformIndependence()` 会主动检查它们不存在，放了就直接红。

# 贡献指南（占位版）

> 技术栈与开发流程待架构设计评审通过后补充。当前仅约定许可证与依赖准入两条硬规则，
> 二者自仓库创建起即生效。

## 提交代码即同意 AGPL-3.0

向本仓库提交 Pull Request 或补丁，即表示你同意你的贡献以 AGPL-3.0 许可证（见
[LICENSE](LICENSE)）对外授权，并同意项目所有者将你的贡献纳入本项目及其各分发形态
（含 Docker 镜像与部署模板）。本期不设 CLA、不做双授权。

修改本项目并通过网络对外提供服务的，依 AGPL-3.0 §13 须向你的用户提供你所修改版本
的对应源码获取途径。

## 依赖许可证准入规则（V11 / CI 门禁）

AGPL-3.0 具有网络传染性：与 AGPL 不兼容、或需商业授权才能使用的依赖，一经引入即
成为发布阻塞项。

**允许**（与 AGPL-3.0 兼容的宽松许可证）
MIT、BSD-2-Clause、BSD-3-Clause、0BSD、ISC、Apache-2.0、Zlib、Unlicense、
CC0-1.0、MPL-2.0（文件级 copyleft，引入时须在依赖许可清单中注明）、
AGPL-3.0、GPL-3.0-or-later（与 AGPL-3.0 兼容）。

**需逐案评审**
LGPL-2.1+/LGPL-3.0（链接方式影响兼容性）、EPL-2.0、CDDL，以及任何含附加条件的
变体许可证、任何"仅限非商业使用"的许可证。

**禁止**
GPL-2.0-only（与 AGPL-3.0 不兼容）、SSPL、BUSL、Elastic License、Commons Clause
等"源码可得但非开源"的许可证，以及一切需付费或商业授权才能使用/分发的依赖。

**素材（字体、图片、音效）**：必须具有可再分发的商用授权（常见 OFL、CC0、CC-BY，
须附来源与许可说明）；授权不明的素材一律不得使用。素材许可清单与代码依赖许可清单
分开维护。

## CI 门禁

`.github/workflows/license-check.yml` 是依赖许可证检查的最小骨架。当前仓库尚无依赖
清单，检查以"零清单"通过；一旦检测到任何依赖清单文件而对应的许可证检查器尚未配置，
工作流将失败（fail-closed）——请在引入依赖的同一个 PR 里配置好检查器与允许清单。
技术栈确定后由仓库初始化任务落地具体工具，候选方案：

| 技术栈 | 候选工具 |
| --- | --- |
| JS/TS（形态 B 大概率） | `pnpm licenses list` / `license-checker-reborn` + 允许清单 |
| Python | `pip-licenses --fail-on="..."` |
| Go | `go-licenses check` |
| Rust | `cargo-license` / `cargo deny licenses` |
| Java/Kotlin | Gradle `license-report` + 校验脚本 |

## 安全红线

- 任何真实凭证（QCA PAT、百炼 API Key、数据库口令等）不得进入仓库、commit、分支、
  CI 日志或示例文件；示例只用明显的占位值（如 `CHANGE_ME`、`FAKE_PROBE_VALUE`）。
- `.gitignore` 已覆盖常见凭证载体，但它只是第一道防线，不依赖它兜底。
- 构建脚本、依赖安装、数据库迁移不得读取生产凭证（防止凭证进入平台侧构建日志）。

# Little Q 部署手册

本手册适用于本地 / 虚拟机、Docker 和 Vercel。所有命令均从项目根目录执行。先准备数据库与 AI 服务配置，再启动正式服务；不要把开发机的密钥、数据库或测试账号复制到新部署。

## 1. 系统依赖

### 1.1 软件与服务

- **Node.js**：推荐 22 LTS，与 Docker 镜像一致；项目最低版本为 20.9。Vercel 项目的 Node.js Version 选择 22.x。
- **npm**：随 Node.js 安装。使用 `npm ci`，保留 `package-lock.json`，不要用另一套包管理器重新生成锁文件。
- **数据库**：二选一。单机单进程可使用随依赖安装的 PGlite；Vercel、多实例或需要集中运维的部署使用外部 PostgreSQL，建议 PostgreSQL 16 或更新版本。
- **AI 服务**：完整功能需要有效的 QCA Personal Access Token，账号需有相应 Forward API 权限、模型权限与额度。百炼创作模式另需 DashScope API Key 及所选模型权限与额度。
- **网络**：服务端能访问所选 AI API 和数据库；浏览器能访问应用。常规页面和图标不依赖外部字体或 UI CDN。
- **Docker 部署**：宿主机需 Docker Engine 与 Docker Compose v2。PGlite 模式需持久化卷。
- **公网部署**：配置域名与 HTTPS；虚拟机 / Docker 可在应用前使用 Nginx 或等效反向代理。

### 1.2 软件组件

| 组件 | 作用 |
| --- | --- |
| Next.js 16 / React 19 / React DOM 19 | 页面、服务端渲染、API、交互和图片优化 |
| TypeScript 5 与 `@types/node` / `@types/react` / `@types/react-dom` / `@types/qrcode` | 构建及类型检查 |
| `postgres` | 外部 PostgreSQL 驱动，支持 PostgreSQL 连接池地址 |
| `@electric-sql/pglite` | 嵌入式 PostgreSQL，包含所需 WASM 文件，不需另装 PostgreSQL 服务 |
| `qrcode` | 作品分享二维码 |
| 自有 React 组件与原生 CSS | 主题、导航、卡片、头像、SVG 图标、预览播放器；未使用第三方 UI 组件库 |
| Node.js 原生 `fetch`、加密与文件系统接口 | QCA / 百炼 API、密码哈希与本地数据库目录 |

精确版本见 `package-lock.json`。不需要 Python、Redis、独立后端服务或 AI SDK；Docker 会自行安装 Node 依赖。

## 2. 环境变量与 Key 对应关系

### 2.1 Key 填写位置

| 服务 | 正确变量名 | 填什么 | 什么时候需要 |
| --- | --- | --- | --- |
| QCA / Qoder Cloud Agents | `QODER_API_KEY` | QCA Personal Access Token 原文，不加 `Bearer ` | 默认 QCA 创作及所有智能体作品的角色聊天；完整功能必填 |
| 百炼 / DashScope | `AI_API_KEY` | 百炼 API Key 原文 | 选择 `AI_PROVIDER=bailian` 时必填 |
| PostgreSQL | `DATABASE_URL` | 数据库服务提供的完整 PostgreSQL 连接串 | Vercel、多实例必填；本地 / Docker 单进程可留空 |

**QCA Key 与百炼 Key 不可互换。** 将百炼 Key 填入 `QODER_API_KEY`，或将 QCA Key 填入 `AI_API_KEY`，都不会得到正确的认证。

这些变量只在服务端读取。不要使用 `NEXT_PUBLIC_` 前缀，不要把真实 Key 写入源码、README、Dockerfile 或镜像构建参数。`.env.example` 只是模板，应用不会把它当配置自动加载。

### 2.2 两种创作模式

**方案 A：QCA 创作与角色聊天（推荐的完整配置）**

```dotenv
AI_PROVIDER=qca
QODER_API_KEY=填写有效的QCA_PAT
AI_API_KEY=
```

创作伙伴和作品内 AI 角色都使用 QCA。无需百炼 Key，也无需手工创建 QCA 模板或会话。

**方案 B：百炼创作 + QCA 角色聊天**

```dotenv
AI_PROVIDER=bailian
AI_API_KEY=填写有效的百炼API_Key
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen3-coder-flash
QODER_API_KEY=填写有效的QCA_PAT
```

百炼只替换创作伙伴，智能体作品的角色聊天仍走 QCA。若仅配置百炼 Key，普通作品可以创作，但角色聊天不可用。未设置 `AI_PROVIDER` 时，代码在存在 QCA Key 时选择 QCA，否则选择百炼；部署时应显式设置，避免误用后端。

模型名与接口地域必须匹配账号实际权限；示例默认百炼接口为中国内地兼容接口。若使用其他地域或专有网关，同时修改 `AI_BASE_URL`、`AI_MODEL` 与该地域的 Key，不能只改其中一项。

### 2.3 完整变量表

| 变量 | 要求 / 默认值 | 用途 |
| --- | --- | --- |
| `AI_PROVIDER` | 建议显式填 `qca` 或 `bailian` | 仅选择创作伙伴后端 |
| `QODER_API_KEY` | 完整功能必填 | QCA PAT；代码兼容旧名 `QCA_API_KEY`，新部署统一用 `QODER_API_KEY`，不要同时设置 |
| `QCA_BASE_URL` | `https://api.qoder.com/api/v1/forward` | QCA Forward API 完整基础路径，不额外重复拼接 `/api/v1/forward` |
| `QCA_MODEL` | `qmodel_38max` | QCA 创作伙伴模型 |
| `QCA_AGENT_MODEL` | `qfmodel` | 智能体作品角色模型 |
| `QCA_ENVIRONMENT_ID` | 可空 | 同一 QCA 账号的现有环境 ID；留空自动查找或创建 `littleq-runtime` |
| `AGENT_TURNS_PER_CHAT` | 正整数，默认 `40` | 每段角色对话轮数上限 |
| `AGENT_DAILY_LIMIT` | 正整数，默认 `400` | 每个作品每天角色对话总轮数上限 |
| `AI_API_KEY` | 百炼模式必填 | 百炼 / OpenAI 兼容接口 Key |
| `AI_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 程序在后面添加 `/chat/completions`，不要填完整的聊天路径 |
| `AI_MODEL` | `qwen3-coder-flash` | 百炼创作模型 |
| `DATABASE_URL` | 按部署形态决定是否必填 | PostgreSQL 连接串；空值启用 PGlite |
| `PGLITE_DIR` | 本地默认 `./.data/pglite` | 仅无外部数据库时有效；相对目录基于服务进程工作目录；Compose 固定为 `/app/.data/pglite` |
| `HOST_PORT` | Compose 默认 `80` | Docker 宿主端口；不是容器监听端口，也不控制本地开发端口 |
| `PORT` | 生产启动默认 `80`（`npm start` 固定 `-p 80`，Docker 镜像内置 `PORT=80`） | 通过进程环境或 CLI 设置；不要依赖 `.env.local` 设置 Next CLI 的监听端口 |
| `HOSTNAME` | Docker 固定 `0.0.0.0` | standalone 监听地址；直接部署时设置为 `0.0.0.0` 可接受外部连接 |
| `GIT_COMMIT` | 可选 | 手动部署健康信息中的版本标识，不影响功能 |

`VERCEL`、`VERCEL_GIT_COMMIT_SHA` 等由 Vercel 自动注入，不要在本地伪造。`NODE_ENV` 由 Next CLI / Docker 设定，正常部署不需手动写入配置模板。

PostgreSQL 连接串应保留服务商要求的 TLS 参数。密码中含 `@`、`#`、`%` 等字符时需 URL 编码。Vercel 推荐使用数据库服务提供的 pooled 连接串；每个函数实例的连接池上限为 2，多个实例的连接数会叠加，需核对数据库总连接配额。

## 3. 本地 / 虚拟机部署

### 3.1 配置环境文件

Linux、macOS、Git Bash：

```bash
cp .env.example .env.local
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env.local
```

用编辑器打开**项目根目录**的 `.env.local`，填写第 2 节所选模式的 Key、模型与数据库配置。不要保留“填写有效的…”等占位内容作为真实值。

单进程使用 PGlite：保留空 `DATABASE_URL`，`PGLITE_DIR=./.data/pglite`。该目录需有写权限，并在服务升级时保留。使用 PostgreSQL：填写 `DATABASE_URL`，此时 `PGLITE_DIR` 不再使用。

Next.js 在开发与生产 CLI 启动时自动读取根目录环境文件；已有进程环境优先于文件。生产模式的文件优先级为进程环境、`.env.production.local`、`.env.local`、`.env.production`、`.env`。建议只维护一份 `.env.local`，避免重复变量。修改配置后重启进程；修改部署平台配置后重新部署。

Linux 可执行 `chmod 600 .env.local` 限制读取；Windows 使用文件 ACL 限制账号。文件已被 Git 与 Docker 构建上下文忽略。

### 3.2 安装与开发启动

```bash
npm ci
npm run dev
```

默认开发地址为 `http://localhost:3000`，项目开发脚本通过 `-p 3000` 固定端口。临时使用其他端口：`npx next dev -p 3001`。`HOST_PORT` 对本地启动无效。

### 3.3 正式启动

```bash
npm ci
npm run typecheck
npm run build
npm start
```

`npm start` 读取根目录 `.env.local`，并以 `next start -p 80` 监听 80 端口。Linux 上监听 80 需要 root 或 `CAP_NET_BIND_SERVICE`；普通账号运行请改用 `npx next start -p 8080`，或在应用前放 Nginx / 反向代理。不需要为构建提供真实 AI Key；不要在构建时调用 AI 验收接口。生产启动后的业务请求才会读取数据库和调用 AI。

需要改生产端口时使用 `npx next start -p 8080`（`npm start` 已固定 80，不再读取 `PORT` 环境变量）。通过 systemd / PM2 保持进程运行，并固定工作目录。PGlite 不支持多个进程共享同一目录，不要用 PM2 cluster 模式；多实例改用外部 PostgreSQL。

### 3.4 standalone 部署

项目已设置 `output: 'standalone'`。若只分发运行产物，Linux / Git Bash 在构建后执行：

```bash
cp -r public .next/standalone/public
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static
```

必须同时带上 `public`、`.next/static` 和生成的 standalone 依赖，不要只复制 `server.js`。不要用 Windows 的构建产物直接替代 Linux 容器构建；Dockerfile 会在 Linux 中重新构建。

从项目根目录启动，并显式注入配置：

```bash
PORT=80 HOSTNAME=0.0.0.0 node --env-file=.env.local .next/standalone/server.js
```

PowerShell：

```powershell
$env:PORT='80'
$env:HOSTNAME='0.0.0.0'
node --env-file=.env.local .next/standalone/server.js
```

生成的 `server.js` 使用自身所在目录作为工作目录；它不会自动找到原项目根的环境文件。上述 `--env-file` 在启动时读取根目录配置，也可改用 systemd 的 `EnvironmentFile=` 注入。PGlite 请配置**绝对** `PGLITE_DIR` 到独立持久化目录，否则相对数据目录会落在 standalone 内，升级产物时可能被覆盖。

### 3.5 HTTPS 与反向代理

- 转发原始 `Host` 和 `X-Forwarded-Proto`，避免 HTTPS 登录 Cookie 判断错误。
- 对 `/api/projects/*/chat` 和 `/api/agent/*` 关闭代理缓冲与缓存；Nginx 使用 `proxy_buffering off`、`proxy_cache off`。
- 为长对话设置足够的超时，例如 `proxy_read_timeout 360s`；网关、负载均衡器也需支持流式响应。
- 生产系统限制健康接口的公开访问，避免泄露部署信息或被重复触发外部 AI 检查。

## 4. Docker 部署

### 4.1 配置位置

在项目根目录复制并编辑 `.env.local`，变量名和填写规则与本地一致。Dockerfile **不包含 Key**；真实变量在容器启动时注入。`.dockerignore` 排除所有真实 `.env*` 文件、数据库、日志、依赖与本地构建缓存，只有 `.env.example` 可进入构建上下文。

容器中的 `localhost` 是容器自身：`DATABASE_URL` 不要指向宿主机的 `localhost`，应使用容器可访问的数据库地址；同一 Docker 网络内可使用实际数据库服务名。不要把未启用的数据库服务名填入连接串。

### 4.2 Compose（推荐）

```bash
cp .env.example .env.local
# 用编辑器填写 Key 与数据库配置
docker compose --env-file .env.local up -d --build
docker compose ps
docker compose logs --tail=100 app
```

Windows 复制命令可用 `Copy-Item`。Compose 的服务 `env_file` 将 `.env.local` 内容传入容器；命令行 `--env-file .env.local` 还会让 `HOST_PORT` 参与端口插值。这两个用途不同，不能互相替代。

- 默认访问 `http://localhost:80`（等价于 `http://localhost`）。
- 改宿主端口：在 `.env.local` 设置 `HOST_PORT=8080`，仍用同一条 Compose 命令，访问 `http://localhost:8080`。容器内部固定为 `80`，不要改成 `8080`。
- PGlite：`DATABASE_URL` 留空；Compose 固定数据目录 `/app/.data/pglite`，挂载命名卷 `littleq-data` 到 `/app/.data`。
- PostgreSQL：设置 `DATABASE_URL` 为可访问的外部连接串，PGlite 卷不参与业务存储。随项目交付的是应用服务配置，没有默认数据库账号或自动开启的 PostgreSQL 服务。
- 配置修改后再次执行启动命令以重建容器；仅 `docker compose restart` 不会载入新的环境变量。

正常更新保留数据卷。不要执行 `docker compose down -v`，除非已经备份且确认要删除本地业务数据。

### 4.3 直接 docker run

```bash
docker build -t littleq .
docker run -d --name littleq -p 80:80 --env-file .env.local -e PORT=80 -e HOSTNAME=0.0.0.0 -e PGLITE_DIR=/app/.data/pglite -v littleq-data:/app/.data --restart unless-stopped littleq
```

换宿主端口只改 `-p 8080:80`。`docker run` 不读取 `HOST_PORT` 自动映射。显式 `-e PGLITE_DIR` 覆盖本地相对目录，确保数据写入卷。真实 Key 通过 `--env-file` 注入，不要使用 `--build-arg` 烘焙进镜像。

Dockerfile 已复制 standalone 服务、静态文件和全部运行素材。容器使用 Node 22 Alpine，不需要在宿主机提前安装 npm 依赖。

## 5. Vercel 部署

### 5.1 项目配置

1. 准备外部 PostgreSQL 数据库，获取可供 Vercel 访问的连接串，配置 TLS、网络访问和连接池配额。
2. 将干净项目提交到部署仓库或交给部署工具。若位于大仓库内，Root Directory 指向包含 `package.json` 的 LittleQ 目录。
3. Framework Preset 选择 **Next.js**；Node.js Version 选择 **22.x**；Install Command 为 `npm ci`，Build Command 为 `npm run build`；Output Directory 保持 Next.js 默认，不手填 `.next/standalone`。
4. 在 **Project Settings → Environment Variables** 添加下面的变量。Name 填变量名，Value 填实际值，不要把 `NAME=value` 整行填入 Value，不要额外加引号。

### 5.2 要添加的变量

| 配置 | QCA 创作模式 | 百炼创作模式 |
| --- | --- | --- |
| `DATABASE_URL` | 必填：外部 PostgreSQL 连接串 | 必填：外部 PostgreSQL 连接串 |
| `AI_PROVIDER` | `qca` | `bailian` |
| `QODER_API_KEY` | 必填：QCA PAT | 完整角色功能仍必填：QCA PAT |
| `AI_API_KEY` | 不需要 | 必填：百炼 Key |
| `AI_BASE_URL` / `AI_MODEL` | 不需要 | 使用第 2 节默认值，或填写匹配地域与模型的值 |
| `QCA_BASE_URL` / `QCA_MODEL` / `QCA_AGENT_MODEL` | 默认值适用可不填；需定制时添加 | 角色聊天所需 QCA 配置，默认值适用可不填 |
| `QCA_ENVIRONMENT_ID` | 可选，同一账号有效环境 ID | 可选 |
| `AGENT_TURNS_PER_CHAT` / `AGENT_DAILY_LIMIT` | 可选，默认 40 / 400 | 可选，默认 40 / 400 |

**Vercel 必须填写 `DATABASE_URL`。** 不能把 `PGLITE_DIR` 设到 `/tmp` 后当作持久化方案，不能上传开发机 `.data`。函数文件系统、进程与内存都不是业务存储。无需设置 `PORT`、`HOSTNAME` 或 `HOST_PORT`，Vercel 管理请求入口。

生产变量选择 **Production**；如需预览部署，为 **Preview** 配置独立的数据库与 Key，避免测试污染正式数据；仅选择 Development 不会生效到 Production。保存变量后部署或 **Redeploy**，已发布版本不会自动读取刚修改的配置。

### 5.3 流式接口与执行时长

- 路由声明创作接口 `maxDuration=300` 秒、角色接口 `maxDuration=150` 秒，使用 Node.js Runtime，不是 Edge Runtime。
- 平台的实际上限取决于当前套餐、项目 Function 配置和 Fluid compute 设置；路由声明不能绕过平台限制。部署人员应在 Vercel 项目设置核对是否允许对应时长。
- QCA 的内部对话等待之外还有初始化、网络重试与保存耗时；接近平台上限的复杂创作仍可能超时。发布前在独立环境验证长对话和持续流式输出，不能只确认首页可打开。
- 若所选平台无法满足长生成需求，选择虚拟机或 Docker 部署。不要把函数部署成功等同于 AI 功能已经验收。

## 6. 部署验收与运维

### 6.1 基础验收（不发起 AI 对话）

1. 确认 `npm ci`、`npm run typecheck`、`npm run build` 成功，Docker 检查镜像构建与容器日志。
2. 打开首页、登录 / 注册页，切换三套界面主题；确认图标、图片和样式加载正常，手机宽度无横向溢出。
3. 访问部署域名下 `/api/health`，检查 `ok=true`、`db.ok=true` 与预期的 `db.kind`。首次访问会初始化表结构；该接口不是只读无副作用操作。
4. QCA 方案确认 `ai.provider=qca` 且 `qca.keyFingerprint` 非空；百炼方案确认 `ai.provider=bailian` 且 `ai.keyFingerprint` 非空。指纹只能证明变量存在，不能证明 Key 有效、权限足够或有额度。不要把数据库指纹、用户数或错误信息长期公开。
5. 重启服务验证数据库记录仍存在；PGlite 测试单进程和卷，PostgreSQL 测试外部连接及备份。

### 6.2 AI 与业务验收

主动访问 `/api/health?ai=1` 前确认目标是可操作的环境：QCA 会准备环境和创作模板；百炼会产生真实模型调用和可能的计费。QCA 检查成功也不代表已完成真实生成、角色聊天与长对话验收。

`npm run smoke` 仅在**独立测试数据库与测试 Key**上运行。脚本会注册账号、创建班级和作品、调用 AI、点赞、提交并公开发布作品，不会自动清空全部测试数据。`SKIP_AGENT=1` 只省略额外角色测试，仍会调用 AI 创作。不要让其他 Agent 为了“验证部署”直接对正式库运行此脚本。

脚本默认目标为 `http://localhost:3000`，不会自动跟随 `HOST_PORT` 或部署域名。换端口时，Linux / Git Bash 例如 `BASE=http://localhost:8080 npm run smoke`；PowerShell 使用 `$env:BASE='http://localhost:8080'; npm run smoke`。其他独立测试站点应将 `BASE` 设为该站点的实际 origin，不加末尾斜杠。执行前人工确认目标、数据库和 Key 均为测试环境，不能仅根据当前目录判断目标。

最终业务验收应覆盖注册登录、创建 / 修改作品、版本回退、发布分享、角色多轮聊天与权限隔离、教师作业流程。确认 HTTPS、流式代理、超时和数据持久化后再开放访问。

### 6.3 常见问题

| 现象 | 核对项 |
| --- | --- |
| Key 指纹为空 / 未配置错误 | 变量是否写在正确位置，模式是否匹配，环境变量是否覆盖了文件，修改后是否重启 / Redeploy |
| 401 / 403 | QCA 与百炼 Key 是否混填，PAT / Key 是否有效且有对应权限，地域与模型是否匹配 |
| API 404 | 基础 URL 是否重复拼接路径，QCA 环境 ID 是否属于当前账号 |
| Vercel 数据丢失 / PGlite 写入失败 | 必须改为外部 `DATABASE_URL`，不能使用本地文件系统 |
| 容器重建后数据不见 | 是否挂载同一卷，PGlite 目录是否落在 `/app/.data`，是否误删卷 |
| Docker 改端口后打不开 | `HOST_PORT` 只控制宿主映射，容器 PORT 保持 80，Compose 使用 `--env-file .env.local` |
| standalone 图片 404 | 是否复制 `public` 与 `.next/static` 到 standalone 对应目录 |
| 生成不流式 / 被截断 | 代理缓冲、网关超时、Vercel实际执行时长与AI服务响应情况 |

### 6.4 数据与交付边界

业务数据及 QCA 资源关联见 [运行规则](RULES.md)。上线使用独立数据库，按数据库服务商规范备份；PGlite 备份需停止该数据库的所有写入进程再完整复制目录。升级不要删除数据卷或数据目录。

交付文件夹不携带 Key、开发数据库、测试截图或本机依赖缓存。`next-env.d.ts`、`.next`、`node_modules`、类型缓存等由安装 / 构建过程生成，不应当作源码缺失。请完整保留源码、运行素材、`package-lock.json`、配置模板、Docker 配置与手册。

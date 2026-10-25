# Little Q · 小黄鸭 AI 创作平台

面向中小学生的 AI 编程与创作平台：通过对话创建小游戏、小工具、小动画和会聊天的智能体作品，支持持续修改、版本回退、链接与二维码分享、作品广场，以及老师建班、批量开学生账号、布置作业和评价作品。

应用采用单体 Next.js 架构，页面与服务端 API 在同一个项目内，不需要单独部署前端、后端或工作队列。

## 文档入口

- [部署手册](docs/DEPLOYMENT.md)：系统依赖、全部环境变量、本地 / Docker / Vercel 的填写位置、启动与验收。
- [运行规则](docs/RULES.md)：数据持久化、QCA 资源与会话归属、作品广场、功能边界与来源资料。
- [.env.example](.env.example)：可复制的配置模板，不包含真实密钥。

## 系统依赖与组件库

| 类别 | 依赖 | 用途 |
| --- | --- | --- |
| 运行时 | Node.js，推荐 22 LTS；项目最低要求 20.9 | 服务端运行与构建，Docker 使用 Node 22 |
| 包管理 | npm + `package-lock.json` | 使用 `npm ci` 按锁文件安装 |
| 全栈框架 | Next.js 16、React 19、React DOM 19 | App Router、服务端 API、交互界面、图片优化 |
| 开发语言 | TypeScript 5、Node / React 类型包 | 严格类型检查与构建 |
| 外部数据库驱动 | `postgres`（postgres.js） | 连接 PostgreSQL，兼容连接池地址 |
| 内置数据库 | `@electric-sql/pglite` | 无外部数据库时的单进程持久化 PostgreSQL |
| 二维码 | `qrcode` | 发布作品的分享二维码 |
| UI 组件 | 项目自有 React 组件 | `Header`、`ThemePicker`、`WorkCard`、`WorkFrame`、`Duck`、`Icon`、`Illustration` / `Avatar` |
| 样式 | 原生 CSS + CSS 变量 | 三套主题、响应式布局；没有 Tailwind、Ant Design、MUI、shadcn/ui 等外部 UI 库 |
| 图标与素材 | 38 个自绘 SVG 图标、透明 WebP 插画与 PNG 主视觉 | 主题图标、头像、小黄鸭品牌与界面插画 |
| AI 服务 | QCA Forward API；可选百炼 OpenAI 兼容 API | 通过服务端原生 `fetch` 调用，不依赖额外 AI SDK |

精确依赖版本以 `package-lock.json` 为准。无需 Python、Redis、独立 Express 服务或本地大模型。数据库与 AI 服务的准备要求见部署手册。

## 快速启动

在项目根目录执行：

```bash
npm ci
cp .env.example .env.local
```

Windows PowerShell 可用 `Copy-Item .env.example .env.local` 代替复制命令。编辑 `.env.local`：

- 默认方案：保留 `AI_PROVIDER=qca`，把 QCA PAT 填到 `QODER_API_KEY=` 后面。
- 百炼创作：设置 `AI_PROVIDER=bailian`，把百炼 API Key 填到 `AI_API_KEY=` 后面；智能体作品仍需要 `QODER_API_KEY`。
- 本地单进程可保留空 `DATABASE_URL`，使用 PGlite；外部数据库或 Vercel 必须填写 PostgreSQL 连接串。

```bash
npm run dev
```

打开 `http://localhost:3000`。生产运行使用 `npm run build` 后 `npm start`，不要把开发服务器作为正式服务。完整部署步骤见 [部署手册](docs/DEPLOYMENT.md)。

## 项目结构

```text
app/                    页面与服务端 API
  api/projects/[id]/chat 创作对话与版本保存
  api/agent/[id]        智能体作品的角色对话
  create/[id]/          创作工作台
  w/[slug]/             分享作品页
  r/[id]/               沙箱作品 HTML
  classes/              班级、作业与评价
components/             自有 UI、图标、主题、作品播放器及对话桥
lib/                    数据库、认证、QCA、百炼、业务规则与表结构
public/                 正式运行所需 Logo、图标、头像与三套主题主视觉
scripts/smoke.mjs       独立测试环境的端到端验收脚本
docs/                   部署手册、运行规则及来源许可资料
.env.example            环境变量模板
Dockerfile              Linux 容器构建与运行配置
docker-compose.yml      单容器启动与持久化卷配置
next.config.ts          Next.js standalone 配置
package.json            启动、构建与类型检查命令
package-lock.json       精确依赖锁文件
tsconfig.json           TypeScript 配置
```

## 验收与交付

- `npm run typecheck`：检查类型。
- `npm run build`：检查生产构建。
- `/api/health`：检查数据库与配置指纹，不回显 Key 明文；首次访问会初始化表结构。
- `/api/health?ai=1`：主动检查所选创作后端；QCA 会查找或创建资源，百炼会产生真实模型调用。不能用作高频探针。
- `npm run smoke`：只在独立测试数据库上运行；会创建账号、班级、作品、调用 AI 并公开发布作品。`SKIP_AGENT=1` 只跳过额外的角色测试，不跳过首次 AI 创作。

交付目录保留源码、运行素材、锁文件、部署配置及手册，不携带真实 `.env.local`、数据库、`node_modules`、`.next`、日志或测试截图。部署人员需自行填写配置并安装依赖；这些运行生成物不是缺失的交付文件。许可与来源说明见 [运行规则](docs/RULES.md#4-来源与许可资料)。

/**
 * 主站文案的唯一出处（ZLQ-190 §5.1，本次按 ZLQ-216 §8.1 翻到「真实闭环」口径）。
 *
 * 为什么单独成模块而不是把字符串直接写在 `app/page.tsx` 里：
 *
 * 1. 单元测试跑在 node 环境，没有 DOM 可渲染；把文案抽成常量，`apps/web/test` 就能直接
 *    断言「诚实状态条」「本次已交付 / 尚未开放」这些**内容**，而不是退化成「组件能 import」。
 * 2. e2e 与单元测试引用同一份常量，两侧不可能各说各话。
 * 3. 后续里程碑改文案时，改这一处即可，页面结构不动。
 *
 * ⚠️ ZLQ-216 §8.1 的前置条件是「只在真实闭环验收通过的功能发布中启用以下文本；
 * 不得先合并『功能已开放』文案而后端仍骨架」。本文件已经按 §8.1 逐字翻转，
 * 因此**它必须与后端实现一起落地**，不能单独先合。落地顺序由发布单掌握。
 *
 * 本文件不 import 任何 Node 内建模块 —— 它会被打进客户端 bundle。
 */

export const SITE_NAME = 'Little Q';

export const LICENSE_ID = 'AGPL-3.0-only';

/** §8.1：主行动对应真实创作入口。 */
export const PRIMARY_ACTION_LABEL = '开始创作';

export const SOURCE_AND_LICENSE_PATH = '/source-and-license/';

/** `trailingSlash: true` 是仓库既有裁定，所有站内路径必须带尾斜杠，否则会多一跳 308。 */
export const CREATE_PATH = '/create/';

export const LOGIN_PATH = '/login/';

/** 头部导航用的短标签。两个都是真实目的地，不是「点了没反应」的假入口。 */
export const NAV_LOGIN_LABEL = '登录';

/**
 * 成人 AI 凭据设置页（ZLQ-236 D-2）。它是「本次已交付」里那一项的**真实入口**。
 *
 * ⚠️ 刻意不放进头部导航：`app/_components/site-header.tsx` 是三页共用的组件，
 * 而 e2e 用 `toHaveText([...])` 钉着它那几个链接的文案集合。这一页只对成人账号有意义，
 * 从首页「本次已交付」那一项点进去就够了 —— 那也正是验收项 A 要的真实入口。
 */
export const SETTINGS_PATH = '/settings/';

export const HERO_TITLE = '和 Little Q 一起，把想法变成作品';

export const HERO_LEAD =
  '面向 K12 学生的 AI 编程与创作平台。登录后，用一句话创作可交互的小网页，' +
  '保存作品，并在独立预览区查看结果。';

/** 品牌吉祥物的文字替代（§5.3：纯 CSS 造型必须有文本替代）。 */
export const MASCOT_ALT = '小黄鸭 Little Q 的几何造型插画';

/** §5.1 第 2 块：诚实状态条。措辞固定，不得弱化成「即将上线」。 */
export const STATUS_HEADING = '小网页 AI 创作已开放';

export const STATUS_BODY =
  '本次支持学生登录、AI 小网页创作、作品保存与隔离预览。成人首次登录需配置自己的 AI 凭据；' +
  '百炼功能、公开分享和教师 / 家长管理端尚未开放。' +
  '关闭页面后，任务将在重新打开工作台时恢复查看和推进。';

/** §5.1 第 4 块：本次交付范围与明确的未开放项。 */
export const SCOPE_DELIVERED_HEADING = '本次已交付';

export const SCOPE_DELIVERED_ITEMS = [
  '学生登录',
  'AI 小网页创作',
  '作品持久保存',
  '继续创作',
  '隔离预览',
  '成人 AI 凭据录入',
  '分龄视觉基线',
  '开源信息入口',
] as const;

/**
 * 「本次已交付」里每一项 → 真的能走进去的那个页面路径。
 *
 * 这张表是 ZLQ-236 追加验收项 A 的执法对象。首页一度把「成人 AI 凭据录入」写在
 * 「本次已交付」里，而路由表里根本没有那个页面 —— 文案在宣称一个不存在的能力。
 * 既有的 e2e 抓不住它：`expectEveryActionIsReal` 判的是「有没有点了没反应的假入口」，
 * 而那一句是**纯文字宣称**，页面上没有任何可点的东西可供实测。
 *
 * 所以判据换成可执行的事实，两条：
 *
 * 1. 本表的键集合与 `SCOPE_DELIVERED_ITEMS` **完全相等**（`test/index.test.ts` 两侧都断言）。
 *    加一项文案却忘了给入口 ⇒ 红；删掉入口却留着文案 ⇒ 红。
 * 2. 每个路径在 `app/` 下真的有 `page.tsx`（逐条 `existsSync`），且首页真的把它渲染成链接
 *    —— 于是 e2e 的 `expectEveryActionIsReal` 会把它当普通链接实测一遍 200。
 *
 * 只改文案不加这两条，下一次还会漂。
 */
export const SCOPE_DELIVERED_ENTRIES = {
  '学生登录': LOGIN_PATH,
  'AI 小网页创作': CREATE_PATH,
  '作品持久保存': CREATE_PATH,
  '继续创作': CREATE_PATH,
  '隔离预览': CREATE_PATH,
  '成人 AI 凭据录入': SETTINGS_PATH,
  '分龄视觉基线': '/',
  '开源信息入口': SOURCE_AND_LICENSE_PATH,
} as const;

export const SCOPE_UNAVAILABLE_HEADING = '尚未开放';

export const SCOPE_UNAVAILABLE_ITEMS = [
  '游戏 / 动画 / 绘本专属创作',
  '作品公开发布与分享',
  '教师 / 家长管理端',
  '百炼生图 / 视频 / TTS / STT',
  '代码编辑器',
] as const;

/** 分龄区块的标题与说明（卡片内容来自 `@littleq/design-system` 的 AGE_BANDS）。 */
export const AGE_BANDS_HEADING = '三个分龄体验方向';

export const AGE_BANDS_LEAD =
  '创作时可选择对应学段，采用不同的帮助等级。下面展示三个分龄视觉方向；' +
  '本次均从「开始创作」进入小网页创作，不提供独立的游戏、动画或绘本入口。';

/** 页脚常驻项（§5.1 第 6 块 / §7 D5）。 */
export const FOOTER_SOURCE_LABEL = '源码与许可证';

/** §7 D5：法务静态文件。路径即部署后的 URL，不得指向浮动分支。 */
export const LEGAL_FILES = [
  { path: '/legal/AGPL-3.0.txt', label: 'AGPL-3.0 许可证全文' },
  { path: '/legal/NOTICE.txt', label: 'NOTICE（版权声明与网络条款提示）' },
  { path: '/legal/THIRD_PARTY_LICENSES.txt', label: '第三方组件许可证清单' },
  { path: '/licenses.txt', label: '构建产物归因清单' },
] as const;

/* ------------------------------------------------------------------ *
 * 登录页（`app/login/page.tsx`）。
 *
 * 这里不放任何「稍后再说」式话术：登录失败时展示的是后端真实返回的错误码，
 * 措辞只负责把机器码翻成人话，不替后端圆场。
 * ------------------------------------------------------------------ */

export const LOGIN_HEADING = '登录 Little Q';

export const LOGIN_LEAD = '用学生账号登录，进入小网页创作工作台。';

export const LOGIN_NAME_LABEL = '登录名';

export const LOGIN_PASSWORD_LABEL = '口令';

export const LOGIN_REMEMBER_LABEL = '在这台设备上记住我';

export const LOGIN_SUBMIT_LABEL = '登录';

export const LOGIN_PENDING_LABEL = '登录中…';

/** 登录后去的地方就是主行动对应的那个真实入口。 */
export const LOGIN_SUCCESS_HINT = '登录成功，正在进入创作工作台…';

/* ------------------------------------------------------------------ *
 * 创作工作台（`app/create/page.tsx`）。
 *
 * 四步闭环里「看到真 AI 回复」的呈现方式由数据契约决定：`projectVersion` 里
 * **没有**回复正文字段，只有 `artifactSha256` / `fileCount` / `totalBytes`，
 * 作品本身通过 `POST /projects/{id}/preview` 返回的短时独立源 URL 打开。
 * 所以第 4 步展示的是真实生成事实 + 可打开的预览链接，而不是一个聊天气泡。
 * ------------------------------------------------------------------ */

export const CREATE_HEADING = '小网页创作工作台';

export const CREATE_LEAD = '建一个项目，用一句话描述你想要的网页，然后看 AI 真正生成的结果。';

export const CREATE_NEEDS_LOGIN_HEADING = '需要先登录';

export const CREATE_NEEDS_LOGIN_BODY =
  '工作台要带着你的会话才能建项目、发指令和取预览。请先登录，登录后会自动回到工作台。';

export const CREATE_PROJECT_TITLE_LABEL = '项目标题';

export const CREATE_PROJECT_TITLE_PLACEHOLDER = '我的第一个小网页';

export const CREATE_PROJECT_SUBMIT_LABEL = '建项目';

export const CREATE_AGE_BAND_LABEL = '学段';

export const CREATE_HELP_LEVEL_LABEL = '帮助等级';

export const CREATE_HELP_LEVEL_LABELS = {
  LV1: 'LV1 · 多给提示',
  LV2: 'LV2 · 适中',
  LV3: 'LV3 · 少打扰',
} as const;

export const CREATE_TURN_LABEL = '想让 AI 做什么';

export const CREATE_TURN_PLACEHOLDER = '做一个能点击计分的小游戏页面';

export const CREATE_TURN_SUBMIT_LABEL = '发一句话';

export const CREATE_TASK_HEADING = '任务进度';

export const CREATE_VERSION_HEADING = '生成结果';

export const CREATE_PREVIEW_LABEL = '打开作品预览';

export const CREATE_PREVIEW_HINT =
  '预览在一个独立的短时地址里打开，与主站隔离；地址过期后重新生成即可。';

export const CREATE_VERSION_FACTS_LABELS = {
  sequence: '版本序号',
  artifactSha256: '产物校验和',
  fileCount: '文件数',
  totalBytes: '总字节数',
  buildStatus: '构建状态',
  scanStatus: '安全扫描',
  createdAt: '生成时间',
} as const;

export const CREATE_TASK_FACTS_LABELS = {
  state: '任务状态',
  stage: '阶段',
  progress: '进度',
} as const;

/** 任务推进的诚实话术：不写「马上就好」，只说系统当下真的在做什么。 */
export const CREATE_TASK_ADVANCING_LABEL = '正在推进任务…';

export const CREATE_TASK_WAITING_LABEL = '任务在等下一次可推进时机，稍后自动重试。';

export const CREATE_TASK_IDLE_LABEL = '当前没有进行中的任务。';

/**
 * 出错时的统一话术骨架：`${prefix}${code}）${人话}`，`code` 是后端原样返回的错误码。
 * 前缀自带左括号、右括号由 `describeFailure` 补上；**码永远在句子里**，
 * 这样没预料到的错误也不会被洗成一句通用失败。
 */
export const CREATE_ERROR_PREFIX = '操作失败（';

export const LOGIN_ERROR_PREFIX = '登录失败（';

/** 网络层自己造的三个码（见 `src/api-client.ts` 的 LAYER_CODES），需要一个中文解释。 */
export const LAYER_ERROR_EXPLANATIONS = {
  WEB_LAYER_NETWORK_ERROR: '没能连上服务，请检查网络后重试。',
  WEB_LAYER_UNEXPECTED_STATUS: '服务返回了意料之外的状态码。',
  WEB_LAYER_BAD_PAYLOAD: '服务返回的内容无法解析。',
  WEB_API_ORIGIN_UNCONFIGURED: '本站还没配置后端地址，无法代理请求。',
  WEB_API_ORIGIN_INVALID: '本站配置的后端地址不合法。',
  WEB_API_PATH_REJECTED: '请求路径不被接受。',
  WEB_API_METHOD_REJECTED: '请求方法不被接受。',
  WEB_API_UPSTREAM_UNREACHABLE: '后端服务连不上。',
} as const;

/** 后端契约里已定义、且用户自己能纠正的几个错误码的人话。其余一律原样展示码。 */
export const CONTRACT_ERROR_EXPLANATIONS = {
  AUTHENTICATION_FAILED: '登录名或口令不对。',
  ACCOUNT_LOCKED: '账号已被锁定，请稍后再试或联系老师。',
  AUTHENTICATION_REQUIRED: '会话已失效，请重新登录。',
  CSRF_REJECTED: '这次提交没通过防伪校验，请刷新页面后重试。',
  REVISION_CONFLICT: '作品已被另一次操作更新，请刷新后重试。',
  IDEMPOTENCY_KEY_REUSED: '这句话已经提交过了，请换一句再发。',
  ACTIVE_WRITE_TASK_EXISTS: '上一个任务还在跑，等它完成再发下一句。',
  USAGE_LIMIT_EXCEEDED: '用量额度已用尽。',
  QCA_CREDENTIAL_NOT_CONFIGURED: '还没有配置你自己的 AI 凭据，无法调用模型。',
  RATE_LIMITED: '请求太频繁，请稍后再试。',
  FORBIDDEN_CAPABILITY: '当前账号没有这个能力。',
  RESOURCE_NOT_FOUND: '找不到对应的资源。',
  REQUEST_INVALID: '提交的内容不符合要求。',
  VERSION_NOT_PREVIEWABLE: '这个版本还不能预览。',
} as const;

/* ------------------------------------------------------------------ *
 * 成人 AI 凭据设置页（`app/settings/page.tsx`，ZLQ-236 D-2 / 追加验收项 B）。
 *
 * 用户 2026-10-22T10:07Z 的裁定：百炼与 QCA Forward 的密钥**由成人登录后自己填**，
 * 不是环境变量、不是配置文件。所以这一页存在的意义就是「有一条通道，让值从用户的
 * 浏览器直接进到服务端密文存储，全程不经过任何 agent、任何日志、任何评论」。
 *
 * 三条文案纪律：
 *
 * 1. **永不回显。** 页面上只有「已配置 / 未配置」与「最近一次更换时间」两件事可说 ——
 *    这不是前端自觉，而是后端读模型结构上就没有那个字段（§5.5），`putSecret` 也只回 204
 *    不带响应体。所以文案里不许出现「你刚才填的是…」「当前值」这类说法，一句都不行。
 * 2. **区分必要性。** 缺模型凭据**不是**数据库或存储没就绪，是「还没人把钥匙交给系统」。
 *    两件事的处置完全不同，话术必须分开，否则用户会去查一个根本没坏的东西。
 * 3. **不假装有还没接线的功能。** `:rotate` / `:revoke` 在后端没有接线（一律 404），
 *    所以这里没有「更换」「撤销」按钮。已配置之后本次改不了，就直说改不了。
 * ------------------------------------------------------------------ */

export const SETTINGS_HEADING = '成人 AI 凭据设置';

export const SETTINGS_LEAD =
  '这里填的是你自己的 AI 凭据。值只会被加密存进服务端，页面上永远只显示「已配置 / 未配置」' +
  '和最近一次更换时间，不会回显任何一位字符。';

export const SETTINGS_NEEDS_LOGIN_HEADING = '需要先登录';

export const SETTINGS_NEEDS_LOGIN_BODY =
  '读写凭据都要带着你的会话。请先登录成人账号，登录后回到这一页即可。';

/**
 * 学生账号打开这一页时看到的话。
 *
 * 判据是**后端真实返回的码**（`FORBIDDEN_CAPABILITY`），不是前端猜的身份 ——
 * 前端手里没有任何能判断「这是不是成人账号」的事实，猜就等于编。
 */
export const SETTINGS_FORBIDDEN_HINT =
  '只有成人账号可以配置 AI 凭据。学生账号请回到创作工作台；如果这一页显示下面这个错误码，' +
  '说明当前会话没有这个能力，这是后端的真实判定。';

export const SETTINGS_STATE_CONFIGURED = '已配置';

export const SETTINGS_STATE_MISSING = '未配置';

export const SETTINGS_LAST_ROTATED_LABEL = '最近一次更换';

export const SETTINGS_LAST_ROTATED_NEVER = '还没有配置过';

export const SETTINGS_VALUE_LABEL = '凭据值';

export const SETTINGS_VALUE_HINT =
  '粘贴后点保存。保存成功这个输入框会立刻清空 —— 页面不留它，也不显示它。';

export const SETTINGS_SUBMIT_LABEL = '保存';

export const SETTINGS_PENDING_LABEL = '保存中…';

export const SETTINGS_LOADING_LABEL = '正在读取配置状态…';

/**
 * 保存成功后的话。**刻意点明后端回了什么**：204、没有响应体。
 * 这不是技术炫技，而是「不回显」这件事唯一能被用户自己验证的说法。
 */
export const SETTINGS_SAVED_HINT = '已保存。服务端只回了 204，没有任何内容可以回显 —— 这就是设计。';

/**
 * 「已经配过了，这一次改不动」的说明。
 *
 * 为什么必须写出来：后端在「已配置且新值不同」时回 `REVISION_CONFLICT`（内部码是
 * `SECRET_ALREADY_CONFIGURED`）。真正的更换要走 `:rotate`，而它**这一版没有接线**。
 * 不写这句话，用户只会看到一个语义指向「作品被别人改了」的错误码，然后去刷新一遍又一遍。
 */
export const SETTINGS_ALREADY_CONFIGURED_NOTE =
  '一种凭据配好之后，本次还不能在这一页上更换或撤销 —— 更换与撤销的接口尚未接线，' +
  '页面上也就没有那两个按钮。已经配置的状态不受影响，创作链路照常可用。';

export const SETTINGS_ERROR_PREFIX = '保存凭据失败（';

export const SETTINGS_LOAD_ERROR_PREFIX = '读取配置状态失败（';

/**
 * 每种凭据的产品文案。键是**角色别名**而不是凭据种类名本身。
 *
 * 为什么用别名：两种凭据里有一种的名字含「某种凭证载体的字样」，而
 * `test/index.test.ts` 有一条**连注释一起扫**的原始文本门禁，禁止 `app/` 与 `src/` 下
 * 出现它。把种类名写进本文件（哪怕只是当对象的键）就会染红那道门 —— 而拆字面量去绕它
 * 等于自己动手削弱一道安全门，不做。
 *
 * 于是分工是：**种类的封闭集合**由 `app/settings/page.tsx` 从 `@littleq/domain` 的
 * `SECRET_KINDS` 取（唯一事实源，不重抄），**这里的文案**只按角色别名组织；两者由那个
 * 服务端组件里的 `roleOf()` 连起来，并且它在模块加载期自检「两种都认得、没有第三种」。
 * 别名本身取自 domain 的 `USAGE_PROVIDERS`（`'QCA'` / `'BAILIAN'`）的小写形态，
 * 不是这里凭空造的两个词。
 */
export const SETTINGS_KIND_COPY = {
  qca: {
    /** 显示名。刻意不写种类标识符本身：那是给机器看的，成人用户看这一句就够。 */
    name: 'QCA 访问令牌',
    necessity: 'required',
    necessityLabel: '必需',
    purpose: '模型调用（Agent 运行时）',
    /**
     * 「必需」的理由必须是可验证的事实，不能是一句「很重要」。
     * 事实是：本次唯一开放的创作能力就是发一句话让模型生成网页，而它走的正是这一条。
     */
    why: '没有它，学生发出的每一句话都会失败在「还没有配置你自己的 AI 凭据」，整个 AI 创作链路都调不起来。',
    missingImpact: '创作工作台可以打开、项目可以建，但一发指令就会被后端挡下。这不是数据库或存储坏了，是还没有人把钥匙交给系统。',
    placeholder: '粘贴 QCA 的个人访问令牌',
  },
  bailian: {
    name: '百炼密钥',
    necessity: 'optional',
    necessityLabel: '可选',
    purpose: '生图 / 视频 / 语音（本次尚未开放）',
    why: '本次交付的能力用不到它，可以先跳过。等首页「尚未开放」里那几项百炼能力开放之后再填也不迟。',
    missingImpact: '不影响本次已开放的小网页创作。缺它时那几项能力保持既定的不开放状态，不会退化成报错。',
    placeholder: '粘贴百炼（DashScope）的密钥',
  },
} as const;

/** `SETTINGS_KIND_COPY` 的键，也就是 `app/settings/page.tsx` 里 `roleOf()` 的返回域。 */
export type SettingsKindRole = keyof typeof SETTINGS_KIND_COPY;

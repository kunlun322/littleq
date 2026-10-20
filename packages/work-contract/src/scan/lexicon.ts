/**
 * 词库与候选召回模式（B1–B13 共用）。
 *
 * ZLQ-153 §8.6 的分工是「**优先 AST/数据流与规范化，正则只用于候选召回**」。所以这个文件里的
 * 每一条都只是**召回**：命中它不等于命中规则，最终判定由各规则在 AST / 资源图 / 作用域绑定上做。
 * 反过来，这里没召回到的东西也不可能被硬拦 —— 这正是「不以单条正则作为最终判定」（§8.3 首句）的落地方式。
 *
 * 词库全部是**冻结常量**，`lexiconRevision` 参与 `rulesetVersion` 推导（ZLQ-156 §6.1：
 * 不能把权限不同的结果共享同一个缓存 key）。改一个词就是一次规则变更，必须重跑 §8.6 的语料。
 *
 * ⚠️ 所有 RegExp 都不带 `g` 标志：`RegExp.prototype.test` 在 `g` 下是有状态的（`lastIndex` 会跨调用残留），
 * 共享一个全局正则会让「同一个包扫两次结果不同」——扫描器是确定性服务，这不可接受。
 * 需要遍历的地方一律现场 `new RegExp(source, 'g')`。
 */

/** 词库修订号。任何词表增删都必须同步改它。 */
export const LEXICON_REVISION = 'lexicon-2026-10-20-r1';

function rx(source: string, flags = 'i'): RegExp {
  return new RegExp(source, flags);
}

export type LexiconEntry = {
  /** 规则子类型；参与 `findingId` 的 HMAC 输入（ZLQ-156 §6.2），不进 explanation。 */
  readonly id: string;
  readonly pattern: RegExp;
  /** HIGH = 可硬拦候选，LOW = 只进成人复核候选（§8.6「语义不确定项不升级为硬拦」）。 */
  readonly tier: 'HIGH' | 'LOW';
};

// ---------------------------------------------------------------------------
// §1.2 显示文本安全：可识别凭证
// ---------------------------------------------------------------------------

/**
 * 「拒绝……可识别凭证」。**只用于判定「这里有一个凭证形状的东西」，绝不把命中片段写进任何输出**
 * （ZLQ-156 §6.2：不把扫描发现的凭证片段加入 Agent 上下文）。
 */
export const CREDENTIAL_PATTERNS: readonly LexiconEntry[] = [
  { id: 'pem-private-key', pattern: rx('-----BEGIN [A-Z ]*PRIVATE KEY-----', ''), tier: 'HIGH' },
  {
    id: 'aws-access-key-id',
    pattern: rx('\\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|ASIA)[0-9A-Z]{16}\\b', ''),
    tier: 'HIGH',
  },
  { id: 'github-token', pattern: rx('\\bgh[pousr]_[0-9A-Za-z]{36,255}\\b', ''), tier: 'HIGH' },
  { id: 'slack-token', pattern: rx('\\bxox[baprs]-[0-9A-Za-z-]{10,}\\b', ''), tier: 'HIGH' },
  {
    id: 'openai-style-key',
    pattern: rx('\\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}\\b', ''),
    tier: 'HIGH',
  },
  { id: 'google-api-key', pattern: rx('\\bAIza[0-9A-Za-z_-]{35}\\b', ''), tier: 'HIGH' },
  {
    id: 'jwt-shape',
    pattern: rx('\\beyJ[0-9A-Za-z_-]{8,}\\.[0-9A-Za-z_-]{8,}\\.[0-9A-Za-z_-]{8,}\\b', ''),
    tier: 'HIGH',
  },
  {
    id: 'bearer-header',
    pattern: rx('\\bauthorization\\s*[:=]\\s*(?:bearer|basic)\\s+[0-9a-z+/._=~-]{16,}', ''),
    tier: 'HIGH',
  },
  {
    id: 'generic-secret-assignment',
    pattern: rx(
      '\\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?token)\\b\\s*[:=]\\s*[\'"`][^\'"`\\n]{8,}[\'"`]',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'signed-query',
    pattern: rx(
      '[?&](?:sig|signature|x-amz-signature|x-goog-signature|token|access_token|api_key)=',
      '',
    ),
    tier: 'HIGH',
  },
];

// ---------------------------------------------------------------------------
// §1.2 显示文本安全：PII
// ---------------------------------------------------------------------------

export const PII_PATTERNS: readonly LexiconEntry[] = [
  { id: 'email', pattern: rx('[0-9a-z._%+-]+@[0-9a-z.-]+\\.[a-z]{2,}', ''), tier: 'HIGH' },
  { id: 'cn-mobile', pattern: rx('(?<!\\d)(?:\\+?86[- ]?)?1[3-9]\\d{9}(?!\\d)', ''), tier: 'HIGH' },
  {
    id: 'cn-id-card',
    pattern: rx(
      '(?<!\\d)\\d{6}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dxX](?!\\d)',
      '',
    ),
    tier: 'HIGH',
  },
  { id: 'bank-card', pattern: rx('(?<!\\d)\\d{13,19}(?!\\d)', ''), tier: 'LOW' },
  {
    id: 'intl-phone',
    pattern: rx('(?<![\\w])\\+\\d{1,3}[- ]\\d{2,4}[- ]\\d{3,4}[- ]\\d{3,4}(?![\\w])', ''),
    tier: 'LOW',
  },
];

/** 双向控制字符与 NUL（§1.2 明文拒绝）。零宽与 BOM 另见 `normalize.ts`。 */
// eslint-disable-next-line no-control-regex -- \u0000 是**检测目标**（§1.2 明文拒绝 NUL），不是转义失误
export const BIDI_OR_NUL_PATTERN = /[\u0000\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

// ---------------------------------------------------------------------------
// B2 网络请求：候选召回（判定靠作用域绑定 + 调用形态）
// ---------------------------------------------------------------------------

/**
 * 必须是**全局绑定**上的这些名字才算。§2.4 的反例「名叫 fetch 的局部游戏函数」「模拟 XMLHttpRequest
 * 教学字符串」都靠这个前提排除：前者在作用域分析里是局部声明，后者只是字符串字面量、根本不是标识符。
 */
export const NETWORK_GLOBAL_NAMES: readonly string[] = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
];

/** 成员访问形态的网络出口（`navigator.sendBeacon`、`navigator.serviceWorker.register` 等）。 */
export const NETWORK_MEMBER_PATHS: readonly string[] = [
  'navigator.sendBeacon',
  'navigator.serviceWorker.register',
  'navigator.serviceWorker.getRegistration',
  'navigator.serviceWorker.getRegistrations',
  'navigator.connection',
  'navigator.onLine',
];

// ---------------------------------------------------------------------------
// B3 顶层导航
// ---------------------------------------------------------------------------

/** 赋值/调用即导航的 `location` 形态。`location.hash` **不在**其中 —— §2.4 的反例「hash 页内路由」必须放行。 */
export const NAVIGATION_LOCATION_SINKS: readonly string[] = [
  'location',
  'location.href',
  'location.assign',
  'location.replace',
  'location.pathname',
  'location.search',
  'location.origin',
];

export const NAVIGATION_WINDOW_SINKS: readonly string[] = ['window.open', 'open'];

/** sandbox 不授予 top-navigation/popups（§8.3 B3、§8.4），所以这三个 target 都不能放行。 */
export const FORBIDDEN_LINK_TARGETS: readonly string[] = ['_top', '_parent', '_blank'];

// ---------------------------------------------------------------------------
// B4 下载
// ---------------------------------------------------------------------------

export const DOWNLOAD_MEMBER_PATHS: readonly string[] = [
  'navigator.msSaveBlob',
  'navigator.msSaveOrOpenBlob',
  'showSaveFilePicker',
  'showDirectoryPicker',
  'showOpenFilePicker',
];

/**
 * `createObjectURL` 本身**不是**违规：§2.4 的反例是「Blob 给 audio/img／createObjectURL 仅播放」。
 * 违规的是 §8.3 B4 写的「Blob URL 与锚点 click 的数据流组合」——由 `b04` 做数据流判定，这里只给召回名。
 */
export const OBJECT_URL_FACTORY = 'createObjectURL';
export const OBJECT_URL_REVOKE = 'revokeObjectURL';
/** 这些接收者拿到 object URL 是「播放/显示」，不产生下载。 */
export const MEDIA_SINK_PROPERTIES: readonly string[] = [
  'src',
  'srcObject',
  'poster',
  'background',
  'backgroundImage',
];

// ---------------------------------------------------------------------------
// B6 父页/消息
// ---------------------------------------------------------------------------

/**
 * 只有解析到**全局** `window`/`self`/`globalThis`/裸 `parent`/`top`/`opener` 时才算。
 * §2.4 的反例「AST 树节点的 parent 字段」「Top 类」全靠作用域分析排除。
 */
export const CROSS_WINDOW_GLOBAL_NAMES: readonly string[] = [
  'parent',
  'top',
  'opener',
  'frameElement',
];
/**
 * **存的是去掉 `window.`/`self.`/`globalThis.` 之后的形态**，与 `NETWORK_MEMBER_PATHS`、
 * `NAVIGATION_LOCATION_SINKS`、`DOWNLOAD_MEMBER_PATHS` 同一个约定：调用方先过 `stripGlobalPrefix`
 * 再查表。把 `window.parent` 写进表里再对 `stripGlobalPrefix` 的结果查，是一条永远查不到的路径。
 *
 * 单段条目（`parent`/`top`/`opener`/`frameElement`）在 `b06` 里还允许后接更深的链
 * （`window.parent.document.title` 与 `window.parent` 是同一件事）；多段条目 `document.domain`
 * 只精确匹配 —— 按首段放行会把整个 `document.*` 都当成跨窗口访问。
 */
export const CROSS_WINDOW_MEMBER_PATHS: readonly string[] = [
  'parent',
  'top',
  'opener',
  'frameElement',
  'document.domain',
];
export const POST_MESSAGE_NAMES: readonly string[] = ['postMessage'];

// ---------------------------------------------------------------------------
// B7 敏感浏览器 API
// ---------------------------------------------------------------------------

export const SENSITIVE_MEMBER_PATHS: readonly LexiconEntry[] = [
  { id: 'document-cookie', pattern: rx('^document\\.cookie$', ''), tier: 'HIGH' },
  {
    id: 'credential-management',
    pattern: rx('^navigator\\.credentials(?:\\.|$)', ''),
    tier: 'HIGH',
  },
  {
    id: 'password-credential',
    pattern: rx('^(?:PasswordCredential|FederatedCredential|PublicKeyCredential)$', ''),
    tier: 'HIGH',
  },
  {
    id: 'clipboard-read',
    pattern: rx('^navigator\\.clipboard\\.read(?:Text)?$', ''),
    tier: 'HIGH',
  },
  { id: 'contacts', pattern: rx('^navigator\\.contacts(?:\\.|$)', ''), tier: 'HIGH' },
  { id: 'geolocation', pattern: rx('^navigator\\.geolocation(?:\\.|$)', ''), tier: 'HIGH' },
  { id: 'bluetooth', pattern: rx('^navigator\\.bluetooth(?:\\.|$)', ''), tier: 'HIGH' },
  { id: 'usb', pattern: rx('^navigator\\.usb(?:\\.|$)', ''), tier: 'HIGH' },
  { id: 'serial', pattern: rx('^navigator\\.serial(?:\\.|$)', ''), tier: 'HIGH' },
  { id: 'hid', pattern: rx('^navigator\\.hid(?:\\.|$)', ''), tier: 'HIGH' },
  { id: 'nfc', pattern: rx('^navigator\\.nfc(?:\\.|$)', ''), tier: 'HIGH' },
  { id: 'idle-detection', pattern: rx('^navigator\\.userActivity(?:\\.|$)', ''), tier: 'LOW' },
  {
    id: 'notifications',
    pattern: rx('^(?:Notification|navigator\\.permissions)(?:\\.|$)', ''),
    tier: 'LOW',
  },
];

/** Clipboard **写入**是 §2.4 的明确安全反例，不进上面的表。这里单列，供 `b07` 显式放行并留注释证据。 */
export const CLIPBOARD_WRITE_PATHS: readonly string[] = [
  'navigator.clipboard.writeText',
  'navigator.clipboard.write',
];

/** `document.referrer` 的普通读取（§2.4 反例「document.referrer 普通说明」）：只召回，不硬拦。 */
export const REFERRER_PATH = 'document.referrer';

/**
 * 摄像头/麦克风/传感器：按成人开关 + manifest 声明**单独准入**（§8.3 B7、§8.4）。
 * 值是 `capabilities` 里的枚举名，用于和 `policySnapshot.adultApprovedCapabilities` 对齐。
 */
export const GATED_DEVICE_MEMBER_PATHS: readonly {
  path: string;
  capability: 'CAMERA' | 'MICROPHONE' | 'ACCELEROMETER' | 'GYROSCOPE';
}[] = [
  { path: 'navigator.mediaDevices.getUserMedia', capability: 'CAMERA' },
  { path: 'navigator.mediaDevices.getDisplayMedia', capability: 'CAMERA' },
  { path: 'navigator.mediaDevices.enumerateDevices', capability: 'CAMERA' },
  { path: 'DeviceMotionEvent', capability: 'ACCELEROMETER' },
  { path: 'DeviceOrientationEvent', capability: 'GYROSCOPE' },
  { path: 'DeviceOrientationEventAbsolute', capability: 'GYROSCOPE' },
];

/**
 * ZLQ-153 §8.4：「存储键强制 `littleq:{workId}:` 前缀」「扫描器禁止枚举 `localStorage.key/length` 和跨前缀访问」。
 * §8.3 的 B 表没有独立的存储行，规则又不得合并，所以这条按 **B7「敏感浏览器 API」** 实现 ——
 * 枚举别的作品的存储就是敏感 API 误用。这个归类是我对冻结文本的读法，已在交付说明里点名。
 */
export const STORAGE_ENUMERATION_PATHS: readonly string[] = [
  'localStorage.key',
  'sessionStorage.key',
  'localStorage.clear',
  'sessionStorage.clear',
  'Object.keys',
  'Object.entries',
  'Object.getOwnPropertyNames',
];
export const STORAGE_LENGTH_PROPERTIES: readonly string[] = ['length'];
export const STORAGE_OBJECTS: readonly string[] = ['localStorage', 'sessionStorage'];
/**
 * IndexedDB 的枚举面。两者判定档**不同**，所以不能并列在一个数组里：
 * - `indexedDB.databases()` 列出**同源下所有**数据库，包含别的作品的 ⇒ 跨作品可见性，硬拦。
 * - `objectStoreNames` 只列出这个作品**自己打开的**那个库里的 store 名。平台的 IndexedDB 库名
 *   是否按作品隔离，冻结文本没有规定（§8.4 只固定了 localStorage 的键前缀）。§8.6
 *   「语义不确定项不升级为硬拦」⇒ 只进成人复核；何况 `INDEXED_DB` 本身就在 `CAPABILITIES`
 *   声明支持的能力里，把它最常用的自省调用硬拦掉正是 ≤2% 误拦率要防的形状。
 */
export const STORAGE_DATABASE_ENUMERATION: readonly string[] = ['indexedDB.databases'];
export const STORAGE_DATABASE_PROBE: readonly string[] = ['objectStoreNames'];

// ---------------------------------------------------------------------------
// B8 个人信息：只在「输入控件结构」上查，不在散文里查
// ---------------------------------------------------------------------------

/**
 * HIGH = 硬拦候选（§8.3「高置信硬拦」）。
 * 判定前提是**结构**：文本必须来自 `<input>/<textarea>/<select>` 的 `name/id/placeholder/aria-label`
 * 或与之关联的 `<label>`。§2.4 的反例「绘本人物住址作为剧情文字」「数学『学校人数』静态题」都是普通文本节点，
 * 结构上就不进这个判定，所以不会命中。
 */
export const PII_STRONG_FIELD_CUES: readonly LexiconEntry[] = [
  {
    id: 'phone-field',
    pattern: rx(
      '电话|手机号|手机号码|联系方式|联络方式|\\bphone\\b|\\bmobile\\b|\\btel\\b|\\btel\\.?\\s*no',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'address-field',
    pattern: rx(
      '住址|家庭住址|家住|家里的地址|通讯地址|\\bhome\\s*address\\b|\\bstreet\\b|\\baddress\\b',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'id-document-field',
    pattern: rx(
      '身份证|证件号|护照|学籍号|\\bid\\s*card\\b|\\bidcard\\b|\\bpassport\\b|\\bssn\\b|\\bsocial\\s*security\\b',
      '',
    ),
    tier: 'HIGH',
  },
  { id: 'email-field', pattern: rx('邮箱|电子邮箱|电子邮件|\\be-?mail\\b', ''), tier: 'HIGH' },
  {
    id: 'im-account-field',
    pattern: rx('微信号|微信|qq\\s*号?|\\bwechat\\b|\\bwhatsapp\\b|\\bskype\\b', ''),
    tier: 'HIGH',
  },
  {
    id: 'real-name-field',
    pattern: rx(
      '真实姓名|真名|家长姓名|监护人|实名|\\breal\\s*name\\b|\\bfull\\s*name\\b|\\bguardian\\b',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'school-field',
    pattern: rx(
      '学校名|就读学校|哪个学校|班级名|所在班级|\\bschool\\s*name\\b|\\bclass\\s*name\\b|\\bgrade\\b',
      '',
    ),
    tier: 'HIGH',
  },
  { id: 'plain-name-field', pattern: rx('姓名|名字|\\bname\\b', ''), tier: 'HIGH' },
];

/** LOW = 只进成人复核（§8.3「低置信成人复核」）。 */
export const PII_WEAK_FIELD_CUES: readonly LexiconEntry[] = [
  {
    id: 'birthdate-field',
    pattern: rx('生日|出生年月|出生日期|\\bbirthdate\\b|\\bbirthday\\b|\\bdob\\b', ''),
    tier: 'LOW',
  },
  { id: 'age-field', pattern: rx('几岁|年龄|\\bage\\b', ''), tier: 'LOW' },
  {
    id: 'photo-upload-field',
    pattern: rx('上传照片|上传头像|自拍|\\bselfie\\b|\\bupload\\s*photo\\b', ''),
    tier: 'LOW',
  },
];

/**
 * 虚构语境抑制：§2.4 的反例「虚构角色名输入」必须放行。
 * 这些线索出现在**同一个 label/placeholder/name** 里时，把 `plain-name-field` 一类降级为不命中。
 * 只抑制「名字/姓名」这一类（角色名本来就是虚构的），不抑制电话/住址/证件——那些即使在游戏里问也是真 PII。
 */
export const FICTIONAL_CONTEXT_CUES: readonly RegExp[] = [
  rx('角色|人物|主角|英雄|主人公|宠物|精灵|怪兽|虚构|故事|剧本|想象|昵称|化名|代号|队伍名|公会'),
  rx(
    '\\bcharacter\\b|\\bhero\\b|\\bavatar\\b|\\bnickname\\b|\\bpet\\b|\\bfictional\\b|\\bstory\\b|\\bplayer\\s*name\\b|\\bgamertag\\b|\\balias\\b',
  ),
];

/** 只对这些 cue id 生效虚构抑制。 */
export const FICTIONAL_SUPPRESSIBLE_IDS: readonly string[] = ['plain-name-field'];

/** 输入控件的 PII 承载属性：只有这些属性上的文本进入 B8 判定。 */
export const PII_BEARING_ATTRIBUTES: readonly string[] = [
  'name',
  'id',
  'placeholder',
  'aria-label',
  'title',
  'alt',
  'autocomplete',
];

/** `autocomplete` 里明确表示「填真人信息」的 token（HTML 标准语义，不是我自己发明的词）。 */
export const PII_AUTOCOMPLETE_TOKENS: readonly string[] = [
  'name',
  'honorific-prefix',
  'given-name',
  'additional-name',
  'family-name',
  'email',
  'tel',
  'tel-national',
  'tel-area-code',
  'tel-local',
  'address-line1',
  'address-line2',
  'address-level1',
  'address-level2',
  'postal-code',
  'country-name',
  'bday',
  'photo',
  'impp',
  'sex',
  'organization',
  'username',
  'current-password',
];

/**
 * 这些 `autocomplete` token 不构成真人身份收集。
 * `one-time-code`（短信验证码框）不在安全列 —— 它恰恰是「诱导提供手机号」的强信号。
 */
export const SAFE_AUTOCOMPLETE_TOKENS: readonly string[] = ['off', 'on'];

// ---------------------------------------------------------------------------
// B9 挖矿/追踪/广告
// ---------------------------------------------------------------------------

/**
 * 只收**技术标识**。§2.4 的反例「标题『探险挖矿』」必须放行，所以中文「挖矿」二字绝不进这张表；
 * `requestAnimationFrame`（可见游戏循环）与 WebGL 粒子同样不在表内。
 */
export const MINING_TERMS: readonly LexiconEntry[] = [
  {
    id: 'coinhive-family',
    pattern: rx(
      'coinhive|coin-hive|coinloot|coinimp|jsecoin|minero\\.cc|webminer|cryptoloot|deepminer',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'mining-protocol',
    pattern: rx(
      'cryptonight|stratum\\+tcp|stratum\\+ssl|xmrig|monero\\s*(?:wallet|pool)|\\bpool\\.(?:xmr|monero)',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'hashrate-loop',
    pattern: rx(
      '\\bhashrate\\b|\\bhashesPerSecond\\b|\\bnonce\\s*=\\s*0\\b[\\s\\S]{0,200}sha-?256',
      '',
    ),
    tier: 'LOW',
  },
];

/** 追踪/广告 SDK 与标识（B9「追踪标识」）。读取本身不硬拦——没有网络出口时它发不出去（B2 已拦）。 */
export const TRACKING_TERMS: readonly LexiconEntry[] = [
  {
    id: 'analytics-sdk',
    pattern: rx(
      'google-analytics|googletagmanager|\\bgtag\\b|\\bga\\s*\\(\\s*[\'"]send|facebook\\.com/tr|fbevents\\.js|doubleclick|adobe\\s*analytics|amplitude|mixpanel|segment\\.io|hotjar|clarity\\.ms|umami|plausible',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'ad-network',
    pattern: rx(
      'adsense|adsbygoogle|googlesyndication|admob|unityads|applovin|ironsource|chartboost|广告联盟',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'tracking-id',
    pattern: rx(
      '\\bgclid\\b|\\bfbclid\\b|\\butm_[a-z]+\\b|\\bdeviceId\\b|\\badvertisingId\\b|\\bidfa\\b|\\b GA-[0-9A-Z]{6,}\\b|\\bGTM-[0-9A-Z]{4,}\\b|\\bUA-\\d{4,}-\\d+\\b',
      '',
    ),
    tier: 'LOW',
  },
];

/** §8.3 B9「WebAssembly/Worker + 加密循环特征」；v1 默认禁止 wasm，且冻结 CSP 是 `worker-src 'none'`。 */
export const WASM_NAMES: readonly string[] = ['WebAssembly'];
export const WORKER_CONSTRUCTORS: readonly string[] = ['Worker', 'SharedWorker', 'ServiceWorker'];

/** 隐藏 iframe 的判定线索（B9「隐藏 iframe」）。真正判定在 CSS/属性上，见 `b09`。 */
export const HIDDEN_IFRAME_ATTRIBUTES: readonly string[] = ['hidden'];

// ---------------------------------------------------------------------------
// B10 混淆/动态执行
// ---------------------------------------------------------------------------

export const DYNAMIC_EXEC_NAMES: readonly string[] = ['eval'];
export const FUNCTION_CONSTRUCTOR = 'Function';
/** `setTimeout`/`setInterval` 的第一个实参是字符串时才是动态执行；是函数引用时完全正常。 */
export const TIMER_NAMES: readonly string[] = ['setTimeout', 'setInterval'];

/** packer/obfuscator 签名（§8.3「packer 签名」）。 */
export const PACKER_SIGNATURES: readonly LexiconEntry[] = [
  {
    id: 'packer-p-a-c-k-e-r',
    pattern: rx(
      'eval\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*[dr]',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'hex-identifier-density',
    pattern: rx('(?:_0x[0-9a-f]{4,8}[,;)\\]]\\s*){6,}', ''),
    tier: 'HIGH',
  },
  {
    id: 'js-obfuscator-marker',
    pattern: rx('javascript-obfuscator|__obfuscator|obfuscator\\.io|jsjiami|sojson', ''),
    tier: 'HIGH',
  },
  {
    id: 'fromcharcode-chain',
    pattern: rx('String\\s*\\.\\s*fromCharCode\\s*\\((?:\\s*0x[0-9a-f]{1,4}\\s*,){8,}', ''),
    tier: 'HIGH',
  },
  {
    id: 'decode-uri-exec',
    pattern: rx('(?:eval|Function)\\s*\\(\\s*(?:decodeURIComponent|unescape|atob)\\s*\\(', ''),
    tier: 'HIGH',
  },
];

/**
 * 脚本型 URL scheme。§8.1/§8.4：Runtime 的 CSP 是 `script-src 'self' 'sha256-…'`、`object-src 'none'`，
 * 这些 scheme 根本执行不了；它们出现即说明包里有「想执行外部/内联脚本」的意图。
 * 归 **B10**（动态执行）而不是 B1（外部资源），已在交付说明里点名这个归类。
 */
export const SCRIPT_SCHEME_PATTERN =
  /^(?:javascript|vbscript|livescript|mocha|data:text\/html|data:application\/x?javascript|data:text\/javascript)/i;

/** ZLQ-153 §8.4：「扫描器拒绝 HTML 事件处理属性和动态脚本拼接」。 */
export const HTML_EVENT_HANDLER_ATTRIBUTE_PATTERN = /^on[a-z]+$/i;
/** 动态脚本拼接：把字符串塞进 `script.text/textContent/innerHTML` 再插入文档。 */
export const DYNAMIC_SCRIPT_ASSEMBLY_PROPERTIES: readonly string[] = [
  'text',
  'textContent',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
];

// ---------------------------------------------------------------------------
// B11 AI
// ---------------------------------------------------------------------------

/**
 * 只收**代码级** SDK / 域名 / 模型调用符号（§8.3「识别 QCA/百炼/OpenAI 等 SDK、域名、模型调用符号与提示词拼装」）。
 * §2.4 的反例「已固化的 AI 风格头像/语音文件」「剧情角色『AI』」必须放行 —— 所以 B11 只看 JS 标识符/字符串里的
 * provider 符号和 URL host，**不看 HTML 散文、不看文件名、不看资源路径**。
 */
export const AI_PROVIDER_TERMS: readonly LexiconEntry[] = [
  {
    id: 'openai',
    pattern: rx(
      'openai|chatgpt|\\bgpt-[34o]|dall-?e|text-davinci|whisper-1|\\bcompletions?\\b\\s*:\\s*\\[',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'anthropic',
    pattern: rx('anthropic|claude-(?:instant|sonnet|opus|haiku|\\d)', ''),
    tier: 'HIGH',
  },
  {
    id: 'aliyun-bailian',
    pattern: rx('dashscope|bailian|百炼|qwen|tongyi|通义|aliyuncs\\.com/(?:api|v1)/', ''),
    tier: 'HIGH',
  },
  {
    id: 'google-gemini',
    pattern: rx(
      'generativelanguage\\.googleapis|googlegenerativeai|\\bgemini-(?:pro|ultra|flash)|\\bgenai\\b',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'other-providers',
    pattern: rx(
      'huggingface|replicate\\.com|stability\\.ai|stable-diffusion|elevenlabs|cohere|mistralai|groq\\.com|deepinfra|together\\.ai|zhipuai|chatglm|erniebot|sparkdesk|iflytek',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'qca-agent-endpoint',
    pattern: rx('qoder\\s*cloud\\s*agents|/v1/(?:sessions|agents)(?:/|\\b)|\\bagent_toolset_', ''),
    tier: 'HIGH',
  },
  {
    id: 'prompt-assembly',
    pattern: rx(
      '\\bmessages\\s*:\\s*\\[\\s*\\{[^}]*role\\s*:\\s*[\'"`](?:system|user|assistant)[\'"`]|\\bsystemPrompt\\b|\\bpromptTemplate\\b|\\brole\\s*:\\s*[\'"`]system[\'"`]',
      '',
    ),
    tier: 'HIGH',
  },
];

// ---------------------------------------------------------------------------
// B12 虚假能力（只标记确认，绝不硬拦）
// ---------------------------------------------------------------------------

/**
 * §8.3 B12「匹配『云存档/账号同步/全球排行』等」。
 * 注意词表里**没有** `存档`、`排行榜`、`同步` 这样的裸词 —— §2.4 的反例「本机存档」「这是模拟排行榜」必须放行。
 */
export const CAPABILITY_CLAIM_TERMS: readonly LexiconEntry[] = [
  {
    id: 'cloud-save',
    pattern: rx(
      '云存档|云端存档|云端保存|云保存|云备份|云端备份|\\bcloud\\s*save\\b|\\bsave\\s*to\\s*(?:the\\s*)?cloud\\b|\\bcloud\\s*backup\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'account-sync',
    pattern: rx(
      '账号同步|帐号同步|跨设备同步|多端同步|换设备.{0,6}(?:还在|继续|恢复)|\\baccount\\s*sync\\b|\\bsync\\s*(?:across|between)\\s*devices\\b|\\bcross-?device\\s*sync\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'cloud-sync',
    pattern: rx('云同步|云端同步|\\bcloud\\s*sync\\b|\\bsync\\s*to\\s*(?:the\\s*)?cloud\\b', ''),
    tier: 'LOW',
  },
  {
    id: 'global-leaderboard',
    pattern: rx(
      '全球排行|世界排行|全球排名|世界排名|全网排行|国际排行|全球榜|世界榜|\\bglobal\\s*(?:leaderboard|ranking)\\b|\\bworldwide\\s*(?:leaderboard|ranking)\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'online-multiplayer',
    pattern: rx(
      '在线对战|联机对战|多人在线|实时联网对战|好友联机|\\bonline\\s*multiplayer\\b|\\breal-?time\\s*multiplayer\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'server-progress',
    pattern: rx(
      '服务器存档|服务器保存进度|进度保存在服务器|\\bserver-?side\\s*save\\b|\\bprogress\\s*saved\\s*on\\s*(?:our\\s*)?servers?\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'ai-runtime-claim',
    pattern: rx(
      'AI\\s*(?:帮你|为你|自动)?(?:画画|作画|生成|续写|配音|讲解|陪玩|对话)|智能(?:生成|续写|对话)\\s*(?:由|基于)?\\s*(?:AI|大模型)|\\bAI-?generated\\s*at\\s*runtime\\b|\\bchat\\s*with\\s*(?:an?\\s*)?AI\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'payment-claim',
    pattern: rx(
      '内购|付费解锁|充值返利|提现|真实货币|\\bin-?app\\s*purchase\\b|\\breal\\s*money\\b',
      '',
    ),
    tier: 'LOW',
  },
];

/**
 * 否定/免责窗口。§2.4 的反例「不支持云同步」必须放行：声明词在**同一句**里被否定时不产生命中。
 * 窗口按句子边界取（`。！？；\n` 与 `.!?;`），不跨句 —— 跨句抑制会让「本作不支持联网。云存档功能完善。」被误放。
 */
export const CLAIM_NEGATION_CUES: readonly RegExp[] = [
  rx(
    '不支持|不提供|没有|不会|不能|无法|并非|不是|不联网|不可用|尚未|未提供|仅(?:支持|限|在)|只(?:支持|限|在|会)|单机|本机|本地|离线|模拟|虚拟|演示|假(?:的|装)|不需要(?:联网|账号)',
  ),
  rx(
    "\\b(?:no|not|never|without|doesn'?t|don'?t|isn'?t|can'?t|cannot|won'?t|there\\s+(?:is|are)\\s+no)\\b|\\boffline\\b|\\blocal(?:ly)?\\s*only\\b|\\bsimulated\\b|\\bfake\\b|\\bmock(?:ed)?\\b|\\bdisabled\\b|\\bunavailable\\b",
  ),
];

/** 句子边界。抑制窗口只在同一句内生效。 */
export const SENTENCE_BOUNDARY_PATTERN = /[。！？；\n.!?;]/;

// ---------------------------------------------------------------------------
// B13 不当内容
// ---------------------------------------------------------------------------

/**
 * HIGH = 确定硬命中（§8.3「高置信硬拦」）。
 *
 * 这张表故意**极窄**：只收在儿童作品里没有任何正当用途的表述。§2.4 的四个反例——
 * 「医学/安全教育引文」「正常词的子串」「虚构反派情节」「可解释的科学图」——靠的是词表本身不含
 * `出血`/`急救`/`心肺复苏`/`大魔王`/`邪恶`/`打败`/`杀`/`病毒`/`细菌` 这类词，而不是靠事后开脱。
 * 拉丁词一律加 `\b`，避免「正常词的子串」误命中。
 */
export const INAPPROPRIATE_HIGH: readonly LexiconEntry[] = [
  {
    id: 'csae',
    pattern: rx(
      '儿童色情|幼女(?:色情|视频|资源)|萝莉(?:资源|福利)|\\bcsae\\b|\\bchild\\s*(?:porn|pornography|exploitation)\\b|\\bcp\\s*(?:视频|资源)',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'explicit-porn',
    pattern: rx(
      '色情(?:网站|视频|小说|图片|片)|成人(?:影片|视频|网站)|黄(?:色)?(?:网站|视频|小说|片)|\\bporn(?:hub|ography)?\\b|\\bxxx\\s*(?:video|tube|site)\\b|\\bnsfw\\b|\\bonlyfans\\b',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'self-harm-instruction',
    pattern: rx(
      '教你(?:自杀|割腕)|自杀(?:方法|教程|方式)|一起(?:去死|自杀)|相约自杀|如何(?:自杀|结束自己的生命)|\\bhow\\s*to\\s*(?:kill\\s*yourself|commit\\s*suicide)\\b|\\bsuicide\\s*(?:method|tutorial|instructions?)\\b',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'drug-trade',
    pattern: rx(
      '出售(?:毒品|冰毒|大麻|摇头丸|k粉)|买(?:毒品|冰毒|大麻)|毒品(?:交易|购买|出售|制作)|制毒(?:方法|教程)|\\bbuy\\s*(?:drugs?|cocaine|heroin|meth)\\b|\\bdrug\\s*dealer\\b',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'weapon-manufacture',
    pattern: rx(
      '(?:自制|制作|制造)(?:炸弹|爆炸物|枪支|手枪|步枪|燃烧瓶)|炸弹(?:制作|教程|配方)|\\bhow\\s*to\\s*(?:make|build)\\s*(?:a\\s*)?bomb\\b|\\bpipe\\s*bomb\\s*(?:plans?|recipe)\\b|\\b3d\\s*print(?:ed)?\\s*gun\\b',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'gambling-money',
    pattern: rx(
      '现金提现|提现到(?:微信|支付宝|银行卡)|充值返利|赌(?:钱|资|博网站)|下注赢钱|\\bcash\\s*out\\b|\\breal\\s*money\\s*gambl(?:ing|e)\\b|\\bonline\\s*casino\\b|\\bslots?\\s*for\\s*money\\b',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'hate-violence',
    pattern: rx(
      '杀(?:死|光)所有(?:犹太人|黑人|穆斯林|女人|男人|同性恋)|种族清洗|\\bethn?ic\\s*cleansing\\b|\\bwhite\\s*power\\b|\\bkill\\s*all\\s+(?:jews|muslims|black\\s*people|women|men)\\b|纳粹(?:万岁|复辟)',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'terror-recruitment',
    pattern: rx(
      '加入(?:isis|伊斯兰国|基地组织)|恐怖组织招募|\\bjoin\\s*(?:isis|al-?qaeda)\\b|\\bbecome\\s*a\\s*(?:terrorist|school\\s*shooter)\\b|校园枪击(?:计划|实施)',
      '',
    ),
    tier: 'HIGH',
  },
  {
    id: 'doxxing',
    pattern: rx(
      '人肉搜索|曝光(?:他的|她的)?(?:住址|电话|身份证)|\\bdoxx?ing\\b|\\bswatting\\b',
      '',
    ),
    tier: 'HIGH',
  },
];

/**
 * LOW = 语义不确定，进成人复核（§8.6「语义不确定项不升级为硬拦」、§6.2「B8/B13 低置信按上游复核」）。
 * 这一层是**召回宽、判定软**：命中只产生 `CONFIRM_REQUIRED`，永不产生 `BLOCK`。
 */
export const INAPPROPRIATE_LOW: readonly LexiconEntry[] = [
  {
    id: 'gore-detail',
    pattern: rx(
      '肢解|虐杀|剥皮|开膛|鲜血喷溅|断肢|内脏外露|\\bgore\\b|\\bdismember(?:ment)?\\b|\\bmutilat(?:e|ion)\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'substance-use',
    pattern: rx(
      '抽烟|吸电子烟|喝酒醉倒|酗酒|\\bvape\\b|\\bvaping\\b|\\bsmoking\\s*weed\\b|\\bdrunk\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'swearing',
    pattern: rx(
      '他妈的|滚蛋|傻[逼比屌]|\\bfuck(?:ing|ed)?\\b|\\bshit\\b|\\bbitch\\b|\\bbastard\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'gambling-words',
    pattern: rx(
      '赌场|老虎机|扑克牌赌|骰子赌|\\bcasino\\b|\\bpoker\\s*(?:chips?|bet)\\b|\\bbetting\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'weapon-display',
    pattern: rx(
      '枪支|手枪|步枪|弹药|炸药|\\bfirearm\\b|\\bhandgun\\b|\\brifle\\b|\\bammunition\\b|\\bexplosives?\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'self-harm-mention',
    pattern: rx(
      '自残|割腕|抑郁到不想活|\\bself-?harm\\b|\\bcutting\\s*myself\\b|\\bsuicid(?:e|al)\\b',
      '',
    ),
    tier: 'LOW',
  },
  {
    id: 'dating-content',
    pattern: rx(
      '约会软件|相亲|谈恋爱(?:攻略|技巧)|\\bdating\\s*(?:app|site|simulator)\\b|\\btinder\\b|\\bonlyfans\\b',
      '',
    ),
    tier: 'LOW',
  },
];

/**
 * 可执行内容的图片 hash 无法离线判定「画了什么」，所以 B13 的图片路径是：
 * ① `policySnapshot.denyListedImageHashes`（已知不适宜图片的 sha256）；
 * ② EXIF GPS 标签（隐私泄露，属「图片元数据」）。
 * §8.3 的「可选云图审」**不实现**：§8.6 明文「不上传学生内容到官方服务」，扫描器离线。已在交付说明里点名。
 */
export const EXIF_GPS_IFD_TAG = 0x8825;
export const EXIF_GPS_LATITUDE_TAG = 0x0002;
export const EXIF_GPS_LONGITUDE_TAG = 0x0004;

// ---------------------------------------------------------------------------
// §1.3 固定准入 MIME 表
// ---------------------------------------------------------------------------

/**
 * 「固定准入 MIME 表，如 HTML/CSS/JS/JSON/PNG/JPEG/WebP/SVG/音频/字体」。
 * `executable` 标记该类型是否按可执行输入扫描（SVG 明文要求「同样作为可执行风险输入扫描」）。
 */
export const MEDIA_TYPE_ADMISSION: readonly {
  mediaType: string;
  extensions: readonly string[];
  kind: 'html' | 'css' | 'js' | 'json' | 'image' | 'audio' | 'video' | 'font' | 'text';
  executable: boolean;
}[] = [
  { mediaType: 'text/html', extensions: ['html', 'htm'], kind: 'html', executable: true },
  { mediaType: 'text/css', extensions: ['css'], kind: 'css', executable: true },
  { mediaType: 'text/javascript', extensions: ['js', 'mjs'], kind: 'js', executable: true },
  { mediaType: 'application/json', extensions: ['json'], kind: 'json', executable: false },
  { mediaType: 'text/plain', extensions: ['txt', 'md'], kind: 'text', executable: false },
  { mediaType: 'image/png', extensions: ['png'], kind: 'image', executable: false },
  { mediaType: 'image/jpeg', extensions: ['jpg', 'jpeg'], kind: 'image', executable: false },
  { mediaType: 'image/webp', extensions: ['webp'], kind: 'image', executable: false },
  { mediaType: 'image/gif', extensions: ['gif'], kind: 'image', executable: false },
  { mediaType: 'image/avif', extensions: ['avif'], kind: 'image', executable: false },
  { mediaType: 'image/svg+xml', extensions: ['svg'], kind: 'image', executable: true },
  { mediaType: 'audio/mpeg', extensions: ['mp3'], kind: 'audio', executable: false },
  { mediaType: 'audio/ogg', extensions: ['ogg', 'oga'], kind: 'audio', executable: false },
  { mediaType: 'audio/wav', extensions: ['wav'], kind: 'audio', executable: false },
  { mediaType: 'audio/webm', extensions: ['weba', 'webm'], kind: 'audio', executable: false },
  { mediaType: 'audio/mp4', extensions: ['m4a'], kind: 'audio', executable: false },
  { mediaType: 'video/mp4', extensions: ['mp4', 'm4v'], kind: 'video', executable: false },
  { mediaType: 'video/webm', extensions: ['webm'], kind: 'video', executable: false },
  { mediaType: 'font/woff2', extensions: ['woff2'], kind: 'font', executable: false },
  { mediaType: 'font/woff', extensions: ['woff'], kind: 'font', executable: false },
  { mediaType: 'font/ttf', extensions: ['ttf'], kind: 'font', executable: false },
  { mediaType: 'font/otf', extensions: ['otf'], kind: 'font', executable: false },
];

/** 受限允许的 `data:` 媒体类型（§8.3 B1「仅允许包内相对路径或受限 `data/blob`」）。 */
export const ALLOWED_DATA_MEDIA_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'font/woff2',
  'font/woff',
  'font/ttf',
  'font/otf',
];

/** HTML 里承载资源引用的属性（§8.3 B1 明文列举 `src/href/srcset/poster`，加上同类的其余入口）。 */
export const HTML_RESOURCE_ATTRIBUTES: readonly string[] = [
  'src',
  'href',
  'srcset',
  'poster',
  'data',
  'action',
  'formaction',
  'xlink:href',
  'background',
  'content',
  'value',
  'cite',
  'longdesc',
];

/** 其中只有这些属性上的值**才是资源引用**；`content` 只在 `<meta>`/`<track>` 上才是，`value` 只在 `<param>` 上才是。 */
export const ALWAYS_RESOURCE_ATTRIBUTES: readonly string[] = [
  'src',
  'href',
  'srcset',
  'poster',
  'data',
  'action',
  'formaction',
  'xlink:href',
  'background',
  'cite',
  'longdesc',
];

/** CSS 里承载资源引用的位置。 */
export const CSS_IMPORT_AT_RULES: readonly string[] = ['import', 'namespace', 'font-face'];

/**
 * JS 里承载资源引用的形态（§8.3 B1「JS import」）。
 * `import(...)` 的实参若是**字面量 URL**，同时是 B2 的「动态 import URL」。
 */
export const JS_RESOURCE_CALLEES: readonly string[] = [
  'createObjectURL',
  'Audio',
  'Image',
  'preload',
  'load',
];

/**
 * 违规样例的**单点变异**家族（ZLQ-156 §2.4「每条规则 60 个违规样例，全部由单点变异产生」）。
 *
 * ## 三条硬纪律
 *
 * **1. 期望值只能来自「读规则」，不能来自「跑扫描」。**
 * 每个家族带一个 `provenance`：`ruleset-table`（从词库/路径表派生）或 `rule-reading`（读了
 * 规则的 emit 点得出）。**没有** `scan-run` 这个取值 —— ZLQ-194 §16 点名的造假形状之一就是
 * 「把 expected 改成和 actual 一样」。跑出来的不一致叫**缺陷**，要么改语料（并说明为什么原
 * 期望是错的），要么停下点名扫描器缺陷；不允许反过来把期望迁就结果。
 *
 * **2. 一个家族只填一个槽，且必须与它的安全对照只差这一处。**
 * `payload()` 返回 `slotId` + 文本，由 `fillSlot` 替换槽标记。安全基座的其余字节原样不动，
 * 于是「这件样例被判违规」只可能来自这一处注入。需要新增文件的家族（B10 不可读产物、
 * B9 worker 脚本）走 `extraFiles`，同样不碰槽外的既有内容。
 *
 * **3. 有害文本一律由 `carrierFor` 从规则集自己的正则**派生**，不手写、不打印、不提交。**
 * B13 的高危类目（csae / hate-violence / self-harm-instruction / terror-recruitment …）
 * 的匹配串是**在生成时**由 `carriers.ts` 反推出来的：本文件只出现 `entry.id`，
 * 一个有害词面都不会落进源码。生成的字节只存在于内存与仓库根的 `artifacts/corpus/**`
 * （已 gitignore），报告与 manifest 里只记 ruleId / subType / entryId / 计数 / hash。
 * 这既满足 §2.1 的语料伦理，也让「语料里到底写了什么」不可能被人从仓库里读到。
 *
 * ## 跨规则共现是**声明**出来的，不是藏起来的
 *
 * 有些违规**按定义**同时属于两条规则：跨站表单的 action 是一个站外 URL，所以 B5 命中必然
 * 伴随 B1 的 `external-url`；`known-tracking-domain` 也得先是个外部资源引用。
 * 这类共现写在 `expectedOtherRules` 里，理由写在 `rationale`。
 * **不在这个清单里的其它规则命中 = 污染**，由 runner 单独出一张交叉触发表报出来 ——
 * 污染会把无辜规则的 precision 打到 98% 以下，猜是猜不出来的，只能量。
 */

import { carrierFor, entryById, type CarrierConstraint } from './carriers.js';
import { legalDataUrlAsset } from './templates.js';
import type { SafeBase, SlotId } from './templates.js';
import { corpusMinifiedJs } from './overlays.js';
import type { CorpusFile } from './package.js';
import type { Random } from './random.js';
import {
  AI_PROVIDER_TERMS,
  CAPABILITY_CLAIM_TERMS,
  INAPPROPRIATE_HIGH,
  INAPPROPRIATE_LOW,
  MINING_TERMS,
  TRACKING_TERMS,
  PII_AUTOCOMPLETE_TOKENS,
  PII_STRONG_FIELD_CUES,
  PII_WEAK_FIELD_CUES,
  type LexiconEntry,
} from '../scan/lexicon.js';
import type { Capability } from '../scan/metadata.js';
import { RULE_IDS, type Confidence, type Disposition, type RuleId } from '../scan/types.js';
import { corpusPolicy } from './package.js';

/** 期望值的出处。见文件头纪律 1。 */
export type ExpectationProvenance = 'ruleset-table' | 'rule-reading';

/**
 * 样例级状态（不是 finding 级）。
 *
 * 与 finding 的 `disposition` **分开**，因为一件样例的整体状态是「所有命中里最重的那个」：
 * B8 的弱线索字段本身是 `CONFIRM_REQUIRED/LOW`，但若同一次注入又让 B5 硬阻断，
 * 那么**这件样例**就是 BLOCK，而那条 B8 finding 仍然是 CONFIRM_REQUIRED。
 * 把两者混成一个值，就会为了对上样例状态而去改 finding 级期望 —— 那正是纪律 1 禁止的形状。
 */
export type CaseStatus = 'PASS' | 'BLOCK' | 'CONFIRM_REQUIRED';

export type ViolationPayload = {
  readonly slotId: SlotId;
  readonly text: string;
  /** 需要新增文件时给出。不碰槽外既有内容。 */
  readonly extraFiles?: readonly CorpusFile[];
  /** 需要收窄「可读源」清单时给出（B10 的不可读产物豁免判据）。 */
  readonly sourceEntryPaths?: readonly string[];
  /** 需要给 metadata 声明能力时给出（B7 的 gated-device-not-approved 对照）。 */
  readonly capabilities?: readonly Capability[];
};

/**
 * 变体级期望：家族声明的期望值按变体细化后的形态。
 *
 * 为什么需要它：B8/B9/B13 这类「词表轮转」家族的子类型与置信度**随变体变化**
 * （`LexiconEntry.tier` 就是 `confidence`，`entry.id` 就是 `subType`）。家族层面写一个
 * 固定值必然与一半变体不符。
 *
 * 为什么它是 `(variant) => ResolvedExpectation` 而**不是**让 `payload()` 顺带返回期望：
 * 它拿不到 `base`，也拿不到扫描结果，只是一个从变体号到期望值的纯函数。
 * 这让「期望值不来自实测」这一性质在**类型上**就成立，而不是靠人自觉 ——
 * `provenance: 'ruleset-table'` 那句话因此是有据的。
 */
export type ResolvedExpectation = {
  /** 覆盖家族级的 `expectedSubTypes`。 */
  readonly subTypes?: readonly string[];
  readonly disposition?: Disposition;
  readonly confidence?: Confidence;
  /** 覆盖家族级的 `expectedOtherRules`。 */
  readonly otherRules?: readonly RuleId[];
  /** 覆盖由 disposition 推出的样例级状态（例如共现规则把整件样例顶到 BLOCK）。 */
  readonly status?: CaseStatus;
};

export type ViolationFamily = {
  readonly ruleId: RuleId;
  /** 违规样例的家族命名空间**独立于**安全样例（`viol-<rule>-<name>`）。 */
  readonly familyId: string;
  /**
   * 期望命中的子类型**集合**。用集合而不是单值，是因为一次注入可以合法地触发同一规则的两个
   * 子类型（例如 `a.download = 'x'` + `a.click()` 同时是 `download-attribute` 与
   * `blob-anchor-click`）。判据是「实测子类型集合 ⊇ 期望集合」，多出来的算污染。
   *
   * 词表轮转家族用 `expectationOf` 覆盖它。
   */
  readonly expectedSubTypes: readonly string[];
  readonly disposition: Disposition;
  readonly confidence: Confidence;
  /** 这个家族出几件样例。默认 10；B8/B13 用 50/10 的高低危配比。 */
  readonly caseCount: number;
  readonly provenance: ExpectationProvenance;
  /** 按定义必然共现的其它规则。不在清单里的命中 = 污染。 */
  readonly expectedOtherRules: readonly RuleId[];
  /**
   * 样例级状态的显式声明（可选）。
   *
   * 缺省时由 `generator.ts` 的 `defaultStatusOf` 推：主规则的处置，或被
   * `ALWAYS_BLOCK_RULES` 里的共现规则顶到 BLOCK。**推不出来的情形必须在这里写死**，
   * 例如共现的是 B9（有 CONFIRM_REQUIRED 支路，不在那张表里）却确实硬阻断。
   * `ResolvedExpectation.status` 再按变体覆盖它。
   */
  readonly expectedStatus?: CaseStatus;
  /**
   * 同规则内**可接受但不要求**的额外子类型。
   *
   * 例：B8 的 `autocomplete="email"` 家族，判据除了 `autocomplete-pii` 之外，
   * 同一个 `<input>` 上的 `name` 线索也会独立命中 `pii-field`。这不是污染 ——
   * 两条子类型来自同一份注入的两个不同判据，都在 §6.2 的注册表里。
   * 把它列进 `expectedSubTypes` 会让「必须命中」变成对第二个判据的依赖，
   * 所以单开一栏：**出现算正常，不出现也不算缺陷。**
   */
  readonly toleratedSubTypes?: readonly string[];
  /** 变体级期望细化。见 `ResolvedExpectation`。 */
  readonly expectationOf?: (variant: number) => ResolvedExpectation;
  readonly rationale: string;
  payload(base: SafeBase, random: Random, variant: number): ViolationPayload;
};

/** 每个家族的默认样例数：13 规则 × 6 家族 × 10 = 780（§2.4 的「每规则约 60」）。 */
export const CASES_PER_FAMILY = 10;

/** §2.4：每条规则 60 件违规样例。 */
export const VIOLATION_CASES_PER_RULE = 60;

/** §2.4：B8 / B13 各 60 件，其中高危 50（硬阻断）、低危 10（转确认）。 */
export const HIGH_TIER_CASES_PER_RULE = 50;
export const LOW_TIER_CASES_PER_RULE = 10;

/** 轮转取词表条目：10 个变体覆盖 10 条高危类目，每条恰好在 5 种投放位置里各出现一次。 */
function rotate(table: readonly LexiconEntry[], variant: number): LexiconEntry {
  if (table.length === 0) throw new Error('词表为空，无法轮转');
  const entry = table[variant % table.length];
  if (entry === undefined) throw new Error(`轮转下标越界：${variant}`);
  return entry;
}

/** JS 字符串字面量投放。B12/B13 都会抽 JS 字符串进文案集，所以这条路是有效的。 */
function js(slotId: SlotId, body: string): ViolationPayload {
  return { slotId, text: `${body}\n` };
}

const scriptSlot = (text: string): ViolationPayload => ({ slotId: 'script', text });
const bodySlot = (text: string): ViolationPayload => ({ slotId: 'body', text });
const headSlot = (text: string): ViolationPayload => ({ slotId: 'head', text });

// ---------------------------------------------------------------------------
// B1 外部资源引用
// ---------------------------------------------------------------------------

const B1_FAMILIES: readonly ViolationFamily[] = [
  {
    ruleId: 'B1',
    familyId: 'viol-b1-external-https-image',
    expectedSubTypes: ['external-url'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      '<img src="https://…"> 是站外资源引用；host 不在 policy.knownTrackingDomains 里，所以只落 B1。',
    payload: (_base, random) =>
      bodySlot(
        `    <img src="https://cdn-${random.between(100, 999)}.example.test/art.png" alt="站外图" width="8" height="8" />`,
      ),
  },
  {
    ruleId: 'B1',
    familyId: 'viol-b1-root-escape',
    expectedSubTypes: ['root-escape'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale: '../ 逃出作品根目录；B1 的 checkContainment 直接判越界。',
    payload: () =>
      bodySlot(`    <img src="../shared/hero.png" alt="越界图" width="8" height="8" />`),
  },
  {
    ruleId: 'B1',
    familyId: 'viol-b1-scheme-not-allowed',
    expectedSubTypes: ['scheme-not-allowed'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale: 'ftp:// 不在允许的 scheme 白名单里。',
    payload: (base, random) =>
      bodySlot(`    <img src="ftp://files-${random.between(10, 99)}.example.test/a.png" alt="ftp 图" width="8" height="8" />
    <link rel="stylesheet" href="${base.slotFile['style']}" />`),
  },
  {
    ruleId: 'B1',
    familyId: 'viol-b1-data-media-not-allowed',
    expectedSubTypes: ['data-media-not-allowed'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'ALLOWED_DATA_MEDIA_TYPES 只收图片/音频/字体；这里轮转三种不在表里的类型（video/mp4、text/csv、application/zip）。' +
      '**载荷刻意不用 `;base64`**：`classifyUrlReference` 会先把引用值解码到不动点，' +
      '一段真 base64 会被解成二进制、`data:` 前缀随之消失，分类于是落到 internal-relative ⇒ 报成 missing-node。' +
      '这不是扫描器缺陷（§6.4 要求「解码到不动点」），是语料载荷写错了。',
    payload: (_base, random) => {
      const forbidden = ['video/mp4', 'text/csv', 'application/zip'] as const;
      const mediaType = forbidden[random.int(forbidden.length)] ?? 'video/mp4';
      return bodySlot(
        `    <video src="data:${mediaType},corpus-payload-${random.between(1000, 9999)}" controls width="8" height="8"></video>`,
      );
    },
  },
  {
    ruleId: 'B1',
    familyId: 'viol-b1-missing-node',
    expectedSubTypes: ['missing-node'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      '路径规范、深度合法、大小写无冲突，但包里确实没有这个文件 ⇒ `graph.ts:119` 判 ' +
      '`package-file` 且 `present: false`，B1 报 missing-node。这是学生作品里最常见的引用错误。',
    payload: (base, random) =>
      bodySlot(
        `    <img src="assets/missing-${random.between(1000, 9999)}.png" alt="缺失图" width="8" height="8" />
    <link rel="stylesheet" href="${base.slotFile['style']}" />`,
      ),
  },
  {
    ruleId: 'B1',
    familyId: 'viol-b1-executable-media-type',
    expectedSubTypes: ['executable-media-type'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      '`image/svg+xml` 在 MEDIA_TYPE_ADMISSION 里 executable: true，而 `support.ts` 的 roleFor 按 kind=image ' +
      '把它归成 ASSET —— `b01:171-175` 正是判这一撞（§1.3：可执行媒体类型不能伪装成 ASSET 混过许可审查）。' +
      '载荷是一段完全无害的静态 SVG：违规点只在**类型登记**，不在内容。',
    payload: (_base, random) => {
      const path = `assets/badge-${random.between(10, 99)}.svg`;
      return {
        slotId: 'body',
        text: `    <img src="${path}" alt="徽章" width="8" height="8" />`,
        extraFiles: [
          {
            path,
            role: 'ASSET',
            mediaType: 'image/svg+xml',
            content: [
              '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">',
              '  <rect x="1" y="1" width="6" height="6" fill="#ffd166"></rect>',
              '</svg>',
              '',
            ].join('\n'),
          },
        ],
      };
    },
  },
];

const B1: readonly ViolationFamily[] = B1_FAMILIES;

// ---------------------------------------------------------------------------
// B2 网络请求
// ---------------------------------------------------------------------------

const B2: readonly ViolationFamily[] = [
  {
    ruleId: 'B2',
    familyId: 'viol-b2-fetch-external',
    expectedSubTypes: ['network-call'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'fetch 在 NETWORK_GLOBAL_NAMES 里。URL 只是字符串实参，不进资源图，所以不连带 B1。',
    payload: (base, random) =>
      scriptSlot(
        `const endpoint = 'https://api-${random.between(10, 99)}.example.test/v1/save';
async function saveProgress(score) {
  const reply = await fetch(endpoint, { method: 'POST', body: String(score) });
  return reply.ok;
}
void saveProgress; void ${JSON.stringify(base.title)};
`,
      ),
  },
  {
    ruleId: 'B2',
    familyId: 'viol-b2-xhr-open',
    expectedSubTypes: ['network-call'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'XMLHttpRequest 在 NETWORK_GLOBAL_NAMES 里。',
    payload: () =>
      scriptSlot(
        `function loadBoard() {
  const request = new XMLHttpRequest();
  request.open('GET', 'https://board.example.test/list');
  request.send();
  return request;
}
void loadBoard;
`,
      ),
  },
  {
    ruleId: 'B2',
    familyId: 'viol-b2-websocket',
    expectedSubTypes: ['network-call'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'WebSocket 在 NETWORK_GLOBAL_NAMES 里。',
    payload: () =>
      scriptSlot(
        `function openRelay() {
  const socket = new WebSocket('wss://relay.example.test/ws');
  socket.onmessage = () => {};
  return socket;
}
void openRelay;
`,
      ),
  },
  {
    ruleId: 'B2',
    familyId: 'viol-b2-send-beacon',
    expectedSubTypes: ['network-member'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'navigator.sendBeacon 在 REQUEST_MEMBER_PATHS 里（上报类，硬拦），不是 navigator.onLine 那种探针。',
    payload: () =>
      scriptSlot(
        `function reportFinish() {
  navigator.sendBeacon('https://log.example.test/e', 'done');
}
void reportFinish;
`,
      ),
  },
  {
    ruleId: 'B2',
    familyId: 'viol-b2-online-probe',
    expectedSubTypes: ['network-state-probe'],
    disposition: 'CONFIRM_REQUIRED',
    confidence: 'LOW',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'navigator.onLine 只读联网状态、不发请求，规则把它归到探针档 ⇒ CONFIRM_REQUIRED 而不是 BLOCK。',
    payload: () =>
      scriptSlot(
        `function offlineHint() {
  if (navigator.onLine) {
    return '联网中';
  }
  return '离线中';
}
void offlineHint;
`,
      ),
  },
  {
    ruleId: 'B2',
    familyId: 'viol-b2-dynamic-import-external',
    expectedSubTypes: ['dynamic-import-external'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: ['B1'],
    rationale:
      'import() 的实参是站外 URL；动态导入本身就是网络取码。' +
      '**B1 必然同时命中**：`recordStringUrl`（`analysis/js.ts:301-303`）把动态导入的字符串实参记成 ' +
      '`js-dynamic-import` 引用边，该边逃出包外 ⇒ B1 的 `external-url` 也成立。这不是偶然串扰，' +
      '是两条规则对同一个引用边的两个视角（B1 判「资源在包外」，B2 判「取码行为」），所以声明出来。',
    payload: () =>
      scriptSlot(
        `async function loadExtra() {
  return await import('https://cdn.example.test/extra.mjs');
}
void loadExtra;
`,
      ),
  },
];

// ---------------------------------------------------------------------------
// B3 顶层导航
// ---------------------------------------------------------------------------

const B3: readonly ViolationFamily[] = [
  {
    ruleId: 'B3',
    familyId: 'viol-b3-location-href-assign',
    expectedSubTypes: ['location-assignment'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: ['B1'],
    rationale:
      'location.href 在 NAVIGATION_LOCATION_SINKS 里；给赋值目标会脱离沙箱 iframe。' +
      '**B1 必然同时命中**：`href` 在 `RESOURCE_SINK_PROPERTIES` 里，于是这条字符串赋值被 ' +
      '`recordStringUrl`（`analysis/js.ts:301-303`）记成 `js-string-url` 引用边并逃出包外 ⇒ ' +
      'B1 的 `external-url` 成立。同一个字面量、两条规则各自的判据，声明出来而不是当成污染。',
    payload: () =>
      scriptSlot(
        `function gotoNext() {
  location.href = 'https://example.test/next';
}
void gotoNext;
`,
      ),
  },
  {
    ruleId: 'B3',
    familyId: 'viol-b3-location-assign-call',
    expectedSubTypes: ['window-open'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'location.assign(…) 是同一个 sink 的**调用**形态。' +
      '注意 subType 是 `window-open` 而**不是** `location-assignment` —— 这不是我照着实测改的，' +
      '源码就是这么写的：`b03-top-navigation.ts` 的赋值臂（:50-64）才产 `location-assignment`，' +
      '调用臂（:66-81）对 `WINDOW_SINKS ∪ LOCATION_SINKS` **一律**产 `window-open`，' +
      '行内注释原文：「`window.open(...)` 是弹窗导航；`location.assign(...)` / `location.replace(...)` ' +
      '是调用形态的 location sink —— 只看赋值会漏掉它们」。' +
      '实参取包内路径 `/index.html`：这一族要单测「调用形态被逮住」，不该顺带拖出 B1 的包外资源边。',
    payload: () =>
      scriptSlot(
        `function restart() {
  location.assign('/index.html');
}
void restart;
`,
      ),
  },
  {
    ruleId: 'B3',
    familyId: 'viol-b3-window-open',
    expectedSubTypes: ['window-open'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: "NAVIGATION_WINDOW_SINKS = ['window.open','open']。",
    payload: () =>
      scriptSlot(
        `function showHelp() {
  window.open('https://example.test/help', 'help');
}
void showHelp;
`,
      ),
  },
  {
    ruleId: 'B3',
    familyId: 'viol-b3-meta-refresh',
    expectedSubTypes: ['meta-refresh'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'http-equiv="refresh" + url= 是纯标记形态的顶层导航。目标写成包内路径，避免连带 B1。',
    payload: () => headSlot(`    <meta http-equiv="refresh" content="3;url=index.html" />`),
  },
  {
    ruleId: 'B3',
    familyId: 'viol-b3-link-target-blank',
    expectedSubTypes: ['forbidden-link-target'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      "FORBIDDEN_LINK_TARGETS = ['_top','_parent','_blank']；href 指向包内既有文件，所以不连带 B1。",
    payload: (base) =>
      bodySlot(
        `    <a href="${base.sourceEntryPaths[0] ?? 'index.html'}" target="_blank">说明</a>`,
      ),
  },
  {
    ruleId: 'B3',
    familyId: 'viol-b3-link-target-top',
    expectedSubTypes: ['forbidden-link-target'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: '同上，换成 _top（直接把宿主页面顶掉，是三个里最危险的）。',
    payload: (base) =>
      bodySlot(
        `    <a href="${base.sourceEntryPaths[0] ?? 'index.html'}" target="_top">回首页</a>`,
      ),
  },
];

// ---------------------------------------------------------------------------
// B4 下载
// ---------------------------------------------------------------------------

const B4: readonly ViolationFamily[] = [
  {
    ruleId: 'B4',
    familyId: 'viol-b4-download-attribute-markup',
    expectedSubTypes: ['download-attribute'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'download 属性把资源变成落盘动作。href 指向包内既有文件（extraFiles 补一张真 PNG），避免连带 B1。',
    payload: () => ({
      slotId: 'body',
      text: `    <a href="assets/badge.png" download="badge.png">保存徽章</a>`,
      extraFiles: [legalDataUrlAsset(1)],
    }),
  },
  {
    ruleId: 'B4',
    familyId: 'viol-b4-download-attribute-bare',
    expectedSubTypes: ['download-attribute'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale: 'download 不带值（浏览器自动取文件名）是同一判据的另一种写法。',
    payload: (base) => ({
      slotId: 'body',
      text: `    <a href="${base.sourceEntryPaths[0] ?? 'index.html'}" download>下载源码</a>`,
    }),
  },
  {
    ruleId: 'B4',
    familyId: 'viol-b4-show-save-file-picker',
    expectedSubTypes: ['file-system-access'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'showSaveFilePicker 在 DOWNLOAD_MEMBER_PATHS 里（文件系统写入 API）。',
    payload: () =>
      scriptSlot(
        `async function exportArt() {
  const handle = await showSaveFilePicker();
  return handle;
}
void exportArt;
`,
      ),
  },
  {
    ruleId: 'B4',
    familyId: 'viol-b4-ms-save-blob',
    expectedSubTypes: ['file-system-access'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'navigator.msSaveBlob 是同一张表里的旧式落盘 API。',
    payload: () =>
      scriptSlot(
        `function saveCanvas(blob) {
  navigator.msSaveBlob(blob, 'art.png');
}
void saveCanvas;
`,
      ),
  },
  {
    ruleId: 'B4',
    familyId: 'viol-b4-blob-anchor-click',
    expectedSubTypes: ['blob-anchor-click'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'createObjectURL 本身合法（§8.3 允许 blob），触发点是「造一个带 download 的 a 再 click()」。' +
      '期望集合里**只写 `blob-anchor-click`，不写 `download-attribute`**：后者的唯一产出臂是 ' +
      '`checkHtml`（`b04-download.ts:49-65`），判据是标记里真有一个 `download` 属性节点；' +
      "本族载荷是在 JS 里 `document.createElement('a')` 之后赋 `anchor.download = …`，" +
      '那个节点不在 HTML 摘要里，所以结构上不可能产出 `download-attribute`。' +
      '把它写进期望集合等于宣称一条源码走不到的路径 —— 而「预期命中却没命中」在报告里长得' +
      '和真漏检一模一样，会把 B4 的检出率算低。标记臂已由 ' +
      '`viol-b4-download-attribute-markup` / `-bare` 两族单独覆盖。',
    payload: () =>
      scriptSlot(
        `function exportBlob() {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'export.png';
  anchor.click();
  URL.revokeObjectURL(url);
}
void exportBlob;
`,
      ),
  },
  {
    ruleId: 'B4',
    familyId: 'viol-b4-show-directory-picker',
    expectedSubTypes: ['file-system-access'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'showDirectoryPicker 比 showSaveFilePicker 权限更大，同表同判据。',
    payload: () =>
      scriptSlot(
        `async function pickFolder() {
  const directory = await showDirectoryPicker();
  return directory;
}
void pickFolder;
`,
      ),
  },
];

// ---------------------------------------------------------------------------
// B5 跨站表单
// ---------------------------------------------------------------------------

const B5: readonly ViolationFamily[] = [
  {
    ruleId: 'B5',
    familyId: 'viol-b5-form-without-action',
    expectedSubTypes: ['form-element'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'v1 不允许表单提交（会带着学生输入离开沙箱）。无 action 的 <form> 默认提交到当前 URL，仍然是提交。',
    payload: () =>
      bodySlot(
        `    <form method="post">
      <label for="answer">答案</label>
      <input id="answer" name="answer" type="text" />
      <button type="submit">提交</button>
    </form>`,
      ),
  },
  {
    ruleId: 'B5',
    familyId: 'viol-b5-form-empty-action',
    expectedSubTypes: ['form-element'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'action="" 与无 action 等价（HTML 规范：空串解析为当前文档 URL）。' +
      '**⚠ 已实测确认：本族 10 件全部是扫描器假阴性（零 finding，status=PASS）。**' +
      '根因在 `b05-cross-site-form.ts:49-53`：`attributeOf(element,\'action\')` 对 `action=""` 返回 ' +
      "**空串而不是 null**，于是走不进 `form-element` 那一臂；接着 `escapes('')` 里 " +
      "`findEdge(graph, path, '')` 把空相对路径解析成 `unresolved`（`analysis/graph.ts:94`），" +
      '`escapesPackage` 为 false ⇒ 一条都不产。' +
      '这与该规则自己的 docblock「`<form>` 元素本身就是『表单提交』的载体。v1 禁止它 ⇒ 硬拦」' +
      "以及 :50 的行内注释「没有 action 的 `<form>` 提交到当前文档 URL；在 `form-action 'none'` " +
      "下同样被拒」相矛盾 —— 冻结 CSP 是 `form-action 'none'`，包内提交同样被拒，所以硬拦是对的。" +
      '洞的边界实测为：**只有 `action` 属性缺失才命中**；`action=""` / `action="#top"` / ' +
      '`action="./index.html"` 三种不逃出包外的写法全部零命中。' +
      '**期望值保持 BLOCK/HIGH 不改**（改成 PASS 就是把缺陷洗成预期，ZLQ-194 §16 点名的形状）；' +
      '按 ZLQ-210「不重写扫描器判定算法」，本单不修 `b05`，只在交付评论里点名并附最小复现。' +
      '⚠ 另注：§8.6 的两个指标（false_block_rate / precision）**没有召回项**，' +
      '一个假阴性既不降低 precision 也不抬高误拦率，所以在 `evaluateCorpus` 里是完全不可见的 —— ' +
      '这就是 `corpus/metrics.ts` 必须自己量检出率的原因。',
    payload: () =>
      bodySlot(
        `    <form action="" method="post">
      <label for="guess">猜一猜</label>
      <input id="guess" name="guess" type="text" />
      <button type="submit">确定</button>
    </form>`,
      ),
  },
  {
    ruleId: 'B5',
    familyId: 'viol-b5-form-select-only',
    expectedSubTypes: ['form-element'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale: '只有 <select> 没有 <input> 的表单同样是表单；判据看的是 form 元素本身。',
    payload: () =>
      bodySlot(
        `    <form>
      <label for="level">关卡</label>
      <select id="level" name="level">
        <option value="1">第一关</option>
        <option value="2">第二关</option>
      </select>
      <button type="submit">选择</button>
    </form>`,
      ),
  },
  {
    ruleId: 'B5',
    familyId: 'viol-b5-cross-site-action',
    expectedSubTypes: ['cross-site-form-action'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: ['B1', 'B2'],
    rationale:
      '跨站 action **按定义**就是一个站外 URL，所以 B1 的 external-url 必然共现。这是语义重叠，不是污染，故显式声明。' +
      '**B2 同样必然共现**：`b02-network-request.ts` 的 `checkHtmlForms`（:150-175）独立遍历每个元素的 ' +
      '`action`/`formaction`，只要那条边逃出包外就产 `html-form-action`（BLOCK/HIGH）。' +
      'B2 的视角是「这是一次出站请求」，B5 的视角是「这是一个表单外壳」，同一个属性、两条规则各自的判据。',
    payload: () =>
      bodySlot(
        `    <form action="https://submit.example.test/collect" method="post">
      <label for="note">留言</label>
      <input id="note" name="note" type="text" />
      <button type="submit">发送</button>
    </form>`,
      ),
  },
  {
    ruleId: 'B5',
    familyId: 'viol-b5-formaction-on-button',
    expectedSubTypes: ['cross-site-form-action'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: ['B1', 'B2'],
    rationale:
      'form 本身指向包内路径，但按钮的 formaction 覆盖了它 —— 只看 form 的 action 会漏掉这一种，所以规则单独查 formaction。' +
      '**B2 必然共现**：`checkHtmlForms`（`b02-network-request.ts:150-175`）查的是 `action` **和** `formaction` ' +
      '两个属性，按钮上那个站外 formaction 同样产 `html-form-action`。' +
      '**B1 也共现，但注意它的 subType 与 `viol-b5-cross-site-action` 不同**：这里的 `action="save.html"` ' +
      '是个包内路径而文件表里没有它，所以 B1 产的是 `missing-node` 而不是 `external-url`。' +
      '`expectedOtherRules` 是按规则 id 声明的（`generator.ts` 的 `CaseExpectation.otherRules`），' +
      '这一层刻意不细到 subType —— 否则就等于把实测到的具体命中抄进期望。',
    payload: () =>
      bodySlot(
        `    <form action="save.html" method="post">
      <label for="code">口令</label>
      <input id="code" name="code" type="text" />
      <button type="submit" formaction="https://submit.example.test/alt">备用提交</button>
    </form>`,
      ),
  },
  {
    ruleId: 'B5',
    familyId: 'viol-b5-csp-form-action-weakened',
    expectedSubTypes: ['csp-form-action-weakened'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      '作品内 CSP 把 form-action 放宽成站外来源，等于自己给自己开提交通道。判据是「指令存在且不等于 none」，这里连 none 都不是。',
    payload: () =>
      headSlot(
        `    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; form-action https://submit.example.test" />`,
      ),
  },
];

// ---------------------------------------------------------------------------
// B6 父窗口消息
// ---------------------------------------------------------------------------

/**
 * B6 只有两个 subType，而 `b06` 有**四条**互相独立的产出臂：`globalReferences`（自由全局标识符）、
 * `memberReads`、`assignments`、`calls`。6 个家族按「一族打一条臂 + 覆盖一个冻结表条目」排布，
 * 于是 `CROSS_WINDOW_GLOBAL_NAMES` 的 4 条、`CROSS_WINDOW_MEMBER_PATHS` 的 5 条、
 * `POST_MESSAGE_NAMES` 的 1 条**全部**被真实样例打到（报告里可核对）。
 *
 * 一个必须记下来的判定顺序：`calls` 臂里 `isCrossWindowPath` 命中后会 **`continue`**
 * （`b06-parent-messaging.ts:112-124`），所以 `parent.postMessage(…)` **只**产出
 * `cross-window-access`，`post-message` 那一支根本走不到。要测 `post-message`，
 * 被调路径的末段必须是 `postMessage` 而**根不能是跨窗口对象** —— 也就是裸调用
 * `postMessage(…)` 或 `window.postMessage(…)`（`window` 不在 CROSS_WINDOW_GLOBAL_NAMES 里，
 * `stripGlobalPrefix` 又把 `window.` 去掉）。上一版把三个家族全写成 `parent/top/opener.postMessage`，
 * 结果是 B6 的 `post-message` 一件都没测到，而报告却宣称覆盖了两个 subType —— 典型的空洞门。
 */
const B6: readonly ViolationFamily[] = [
  {
    ruleId: 'B6',
    familyId: 'viol-b6-bare-post-message',
    expectedSubTypes: ['post-message'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'POST_MESSAGE_NAMES=[postMessage]，v1 默认不开放消息桥（allowPostMessageBridge 的类型是字面量 false）⇒ 无条件硬拦。' +
      '被调路径末段是 postMessage 且根不是跨窗口对象，才走得到 `b06:126-138` 那一支。' +
      '10 个变体在**裸调用**与 **window. 前缀**两种写法间轮转：后者要靠 `stripGlobalPrefix` 去掉 `window.` 才查得到表，' +
      '是同一判据的两个实现族（§2.4「含正常写法、编码规范化、边界/别名」的别名维度）。',
    payload: (_base, _random, variant) => {
      const receiver = variant % 2 === 0 ? '' : 'window.';
      return scriptSlot(
        `function announceReady() {
  ${receiver}postMessage({ kind: 'ready' }, '*');
}
void announceReady;
`,
      );
    },
  },
  {
    ruleId: 'B6',
    familyId: 'viol-b6-parent-global-reference',
    expectedSubTypes: ['cross-window-access'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      '打 `globalReferences` 那一条臂（`b06:71-84`）：`parent` 作为自由全局标识符被读走，不带任何成员链、也不带调用。' +
      '作用域分析是这条臂的关键 —— §2.4 的反例「AST 树节点的 parent 字段」靠 `rootIsGlobal === false` 放行，' +
      '所以样例必须让 `parent` 真的解析到全局，才测得到「放行局部同名」的反面。',
    payload: () =>
      scriptSlot(
        `function hostWindow() {
  const host = parent;
  return host;
}
void hostWindow;
`,
      ),
  },
  {
    ruleId: 'B6',
    familyId: 'viol-b6-top-post-message-call',
    expectedSubTypes: ['cross-window-access'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      '打 `calls` 那一条臂（`b06:110-125`）：`top.postMessage(…)` 的被调路径以跨窗口对象为链头。' +
      '**期望只有 `cross-window-access`**：源码在跨窗口分支命中后 `continue`，`post-message` 那一支走不到。' +
      '这不是漏检 —— 同一行代码既跨窗口又发消息，硬拦一次已经足够，重复产出只会让 finding 数虚高。' +
      '把 `post-message` 也写进期望，等于宣称一个源码结构上产不出的 finding（假 FN）。',
    payload: () =>
      scriptSlot(
        `function announceScore(score) {
  top.postMessage({ kind: 'score', value: score }, '*');
}
void announceScore;
`,
      ),
  },
  {
    ruleId: 'B6',
    familyId: 'viol-b6-opener-document-read',
    expectedSubTypes: ['cross-window-access'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      '打 `memberReads` 那一条臂（`b06:86-97`）：读 `opener.document`，不发消息、不调用。' +
      'opener 是由 B3 的 window.open 打开的窗口回指宿主的通道。' +
      '证明「跨窗口访问」和「消息」是两个独立子类型 —— 这一件只有前者。',
    payload: () =>
      scriptSlot(
        `function readHostTitle() {
  return opener.document.title;
}
void readHostTitle;
`,
      ),
  },
  {
    ruleId: 'B6',
    familyId: 'viol-b6-frame-element-read',
    expectedSubTypes: ['cross-window-access'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'frameElement 在 CROSS_WINDOW_GLOBAL_NAMES 里，是拿到宿主 iframe 节点的直接通道。' +
      '覆盖冻结表的第 4 个条目；同时打 `globalReferences`（裸 `frameElement`）与 `calls`（链头匹配）两条臂。',
    payload: () =>
      scriptSlot(
        `function readFrameId() {
  return frameElement.getAttribute('id');
}
void readFrameId;
`,
      ),
  },
  {
    ruleId: 'B6',
    familyId: 'viol-b6-document-domain-write',
    expectedSubTypes: ['cross-window-access'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'CROSS_WINDOW_MEMBER_PATHS 收 document.domain —— 改它可以让跨域窗口互相可读，是同源策略的绕过口。' +
      '打 `assignments` 那一条臂（`b06:99-109`），也是表里唯一的**多段**条目：' +
      '多段只精确匹配、不按首段放行，否则整个 `document.*` 都会被当成跨窗口访问（`lexicon.ts:201-203`）。',
    payload: () =>
      scriptSlot(
        `function relaxOrigin() {
  document.domain = 'example.test';
}
void relaxOrigin;
`,
      ),
  },
];

// ---------------------------------------------------------------------------
// B7 敏感 API
// ---------------------------------------------------------------------------

const B7: readonly ViolationFamily[] = [
  {
    ruleId: 'B7',
    familyId: 'viol-b7-document-cookie',
    expectedSubTypes: ['sensitive-api'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'SENSITIVE_MEMBER_PATHS 里有 document-cookie（^document\\.cookie$）。ALLOWED_PATHS 只放行 clipboard-write 与 document.referrer，cookie 不在内。',
    payload: () =>
      scriptSlot(
        `function readSession() {
  return document.cookie;
}
void readSession;
`,
      ),
  },
  {
    ruleId: 'B7',
    familyId: 'viol-b7-geolocation',
    expectedSubTypes: ['sensitive-api'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'navigator.geolocation 是 HIGH 档敏感路径。metadata 不声明能力，所以走 sensitive-api 而不是 gated-device。',
    payload: () =>
      scriptSlot(
        `function whereAmI() {
  navigator.geolocation.getCurrentPosition(() => {});
}
void whereAmI;
`,
      ),
  },
  {
    ruleId: 'B7',
    familyId: 'viol-b7-gated-device-not-declared',
    expectedSubTypes: ['gated-device-not-declared'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'GATED_DEVICE_MEMBER_PATHS 把 getUserMedia 绑到 CAMERA。metadata **没有**声明 CAMERA ⇒ not-declared（比 not-approved 更前一道门）。capabilities 显式给空数组，确保基座的默认声明不干扰判据。',
    payload: () => ({
      slotId: 'script',
      text: `async function takePhoto() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  return stream;
}
void takePhoto;
`,
      capabilities: [],
    }),
  },
  {
    ruleId: 'B7',
    familyId: 'viol-b7-storage-enumeration',
    expectedSubTypes: ['storage-enumeration'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'STORAGE_ENUMERATION_PATHS 收 localStorage.key；遍历存储等于读取别的作品的进度，是跨作品越权。',
    payload: () =>
      scriptSlot(
        `function listSaved() {
  const names = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    names.push(localStorage.key(index));
  }
  return names;
}
void listSaved;
`,
      ),
  },
  {
    ruleId: 'B7',
    familyId: 'viol-b7-storage-key-unprefixed',
    expectedSubTypes: ['storage-key-unprefixed'],
    disposition: 'CONFIRM_REQUIRED',
    confidence: 'LOW',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      '§8.4 强制存储键前缀 littleq:{workId}:。裸键 score 会和其它作品撞在一起，所以判违规。corpusPolicy 的前缀是 littleq:corpus:，这里刻意一个前缀都不写。' +
      '**档位是 CONFIRM_REQUIRED/LOW 而不是硬拦**（`b07:246-254`）：源码的理由是「写死的不带前缀键名只是风格问题（Runtime 仍会强制加前缀），而拼接/变量键名根本判不出来」，' +
      '硬拦会造出 §8.6 要防的误拦。把这一族记成 BLOCK 就会凭空造出 10 件假失败，把 B7 的 precision 分母搞脏。',
    payload: () =>
      scriptSlot(
        `function saveScore(score) {
  localStorage.setItem('score', String(score));
}
void saveScore;
`,
      ),
  },
  {
    ruleId: 'B7',
    familyId: 'viol-b7-storage-database-probe',
    expectedSubTypes: ['storage-database-probe'],
    disposition: 'CONFIRM_REQUIRED',
    confidence: 'LOW',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'STORAGE_DATABASE_PROBE=[objectStoreNames]，判据是 `target.includes(".") && DATABASE_PROBE.has(lastSegment(target))`（`b07:136-139`），' +
      '且**故意用末段匹配**：`objectStoreNames` 挂在局部的 db/store 对象上，`rootIsGlobal` 为假，全路径锚定根本对不上。' +
      '载荷因此必须是一个**局部对象**的 `objectStoreNames` 读取 —— 上一版写的是 `indexedDB.databases()`，' +
      '那走的是 `DATABASE_ENUMERATION` 分支（`b07:130-133`，BLOCK/HIGH 的 `storage-enumeration`），' +
      '两档在源码里就是分开的（`lexicon.ts:291-300` 记了理由：跨作品可见性 vs 只列自己打开的库），' +
      '拿硬拦档的载荷去测复核档，这一族等于一件都没测到。' +
      '档位 CONFIRM_REQUIRED/LOW 来自 `emitDatabaseProbe`（`b07:275-285`），§8.6「语义不确定项不升级为硬拦」。',
    payload: () =>
      scriptSlot(
        `function listStores(database) {
  return database.objectStoreNames;
}
void listStores;
`,
      ),
  },
];

// ---------------------------------------------------------------------------
// B8 个人信息（§2.4：50 高危硬拦 + 10 低危转确认）
// ---------------------------------------------------------------------------

/**
 * 输入控件形态：`<label>` 配对文本 + 承载属性，两个信号都齐，避免「靠一个词猜」。
 *
 * `wrapInForm` 之所以是参数而不是写死：B5 的 `form-element` 是 **BLOCK/HIGH**，样例里只要有
 * `<form>`，这件样例的**整体状态**就必然是 BLOCK（`src/scan/index.ts:578` 取最重的那个）。
 * 对高危 cue 家族这没问题——它本来就该 BLOCK；但对低危 cue 家族，整族 10 件是 §2.4 里 B8 的
 * **低危配额**，要证明的正是「低置信 ⇒ 转成人复核」。被 B5 顶成 BLOCK，这条性质在样例级就
 * 再也看不见了：语料里会一件「弱线索单独出现 ⇒ CONFIRM_REQUIRED」的样例都没有。
 * 所以低危家族不套 `<form>`——B8 的 `checkMarkup` 只要求 `<label for>` 指向真实控件，不需要表单。
 *
 * 注意这**不是**为了让实测对上期望而改载荷：期望值（CONFIRM_REQUIRED/LOW）来自
 * `b08-personal-information.ts:141-158` 的 `confidence === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED'`，
 * 先于任何一次扫描就写定了；改的是「让被测规则有机会单独说话」的样例结构。
 */
function piiForm(labelText: string, inputId: string, wrapInForm = true): ViolationPayload {
  const control = `      <label for="${inputId}">${labelText}</label>
      <input id="${inputId}" name="${inputId}" type="text" />`;
  if (!wrapInForm) {
    return bodySlot(`    <div class="field">
${control}
    </div>`);
  }
  return bodySlot(`    <form>
${control}
      <button type="submit">保存</button>
    </form>`);
}

/**
 * 载体串要嵌进 HTML 属性/文本时的额外约束。
 *
 * 为什么不能省：`carrierFor` 的取反字符类候选池 `NEGATED_POOL`（`carriers.ts:75-76`）含
 * `"` `'` `<` `>` `\`。今天 B8 的 11 条 cue 词条全是字面量交替、没有字符类，所以派生结果
 * 只可能是词条字面量加空格；但词库一改（给某条 cue 加上 `[^…]` 分支）就会派生出顶掉属性引号
 * 的串——生成的 HTML 结构变形，命中的不再是这条规则，而报告只会显示「预期命中却没命中」，
 * 看起来像扫描器漏检。这里在**生成期**拒掉：要么换分支，要么抛，绝不静默产出畸形标记。
 */
const HTML_SAFE_CARRIER: CarrierConstraint = {
  reject: (candidate) => /[<>"'&]/.test(candidate),
  rejectLabel: 'HTML_UNSAFE_CHAR',
};

const B8: readonly ViolationFamily[] = [
  {
    ruleId: 'B8',
    familyId: 'viol-b8-strong-cue-field',
    expectedSubTypes: ['pii-field'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: ['B5'],
    rationale:
      '高危 cue（PII_STRONG_FIELD_CUES：电话/住址/邮箱/证件/真实姓名…）落在 <label> 文本与 input 承载属性上。' +
      '外层是 <form>，所以 B5 的 form-element 必然共现 —— 真实作品里「收集个人信息的表单」本来就是这两条一起命中，声明出来而不是当污染。' +
      '10 个变体轮转 8 条高危 cue（8 条全覆盖，末两个变体重轮前两条），匹配串由 carrierFor 从词库正则派生。',
    payload: (base, random, variant) => {
      const entry = rotate(highPiiCues(), variant);
      return piiForm(
        `${base.title} · ${carrierFor(entry, random, HTML_SAFE_CARRIER)}`,
        `field-${variant}`,
      );
    },
  },
  {
    ruleId: 'B8',
    familyId: 'viol-b8-strong-cue-placeholder',
    expectedSubTypes: ['pii-field'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      '同一个高危 cue 只放在 placeholder 上（没有 <label>、没有 <form>）——证明判据不依赖 label 配对，也不被 B5 连带。',
    payload: (_base, random, variant) => {
      const entry = rotate(highPiiCues(), variant);
      return bodySlot(
        `    <input id="p-${variant}" name="p-${variant}" type="text" placeholder="${carrierFor(entry, random, HTML_SAFE_CARRIER)}" />`,
      );
    },
  },
  {
    ruleId: 'B8',
    familyId: 'viol-b8-strong-cue-aria-label',
    expectedSubTypes: ['pii-field'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'cue 放在 aria-label 上（PII_BEARING_ATTRIBUTES 收了它）——无障碍写法同样是收集面。',
    payload: (_base, random, variant) => {
      const entry = rotate(highPiiCues(), variant);
      return bodySlot(
        `    <input id="a-${variant}" name="a-${variant}" type="text" aria-label="${carrierFor(entry, random, HTML_SAFE_CARRIER)}" />`,
      );
    },
  },
  {
    ruleId: 'B8',
    familyId: 'viol-b8-strong-cue-scripted-placeholder',
    expectedSubTypes: ['pii-field'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      'B8 明确覆盖「JS 里给 placeholder / aria-label 赋的静态字符串」——标记里没有敏感词，只在脚本里出现，漏掉它这条规则就有半个盲区。',
    payload: (_base, random, variant) => {
      const entry = rotate(highPiiCues(), variant);
      return scriptSlot(
        `function prepareField() {
  const field = document.getElementById('input-${variant}');
  if (field !== null) {
    field.placeholder = ${JSON.stringify(carrierFor(entry, random))};
  }
}
void prepareField;
`,
      );
    },
  },
  {
    ruleId: 'B8',
    familyId: 'viol-b8-autocomplete-token',
    expectedSubTypes: ['autocomplete-pii'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    toleratedSubTypes: ['pii-field'],
    rationale:
      'autocomplete 用的是 HTML 标准 token（PII_AUTOCOMPLETE_TOKENS），比属性文本更强的信号：它明说「这里要填电话/邮箱/住址」。规则给它固定的 BLOCK+HIGH，与 cue 的 tier 无关。10 个变体轮转 token 表。' +
      '同一条 finding 之外还会**有时**多出一条 `pii-field`：`autocomplete` 本身也在 PII_BEARING_ATTRIBUTES 里，' +
      '于是 token 文本又走一遍 `addSite`——`tel`/`email`/`address-line1`/`country-name` 这类 token 会被 cue 词表二次命中，' +
      '而 `photo`/`bday`/`sex`/`impp` 不会。是否出现取决于轮转到的 token，所以记成 tolerated 而不是 expected：' +
      '逐变体声明等于照着实测结果改期望（ZLQ-194 §16 点名的形状）。',
    payload: (_base, _random, variant) => {
      const tokens = autocompleteTokens();
      const token = tokens[variant % tokens.length] ?? 'tel';
      return bodySlot(
        `    <input id="ac-${variant}" name="ac-${variant}" type="text" autocomplete="${token}" />`,
      );
    },
  },
  {
    ruleId: 'B8',
    familyId: 'viol-b8-weak-cue-field',
    expectedSubTypes: ['pii-field'],
    disposition: 'CONFIRM_REQUIRED',
    confidence: 'LOW',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      '低危 cue（PII_WEAK_FIELD_CUES：生日/年龄/上传照片）—— §8.6「低置信进入成人复核」，所以是 CONFIRM_REQUIRED 而不是 BLOCK。这一族 10 件构成 B8 的低危配额。' +
      '**不套 <form>**：套了就会被 B5 的 BLOCK 顶掉样例级状态，低危配额就白造了（见 `piiForm` 的说明）。' +
      '10 个变体轮转 3 条低危 cue（3 条全覆盖）。',
    payload: (base, random, variant) => {
      const entry = rotate(lowPiiCues(), variant);
      return piiForm(
        `${base.title} · ${carrierFor(entry, random, HTML_SAFE_CARRIER)}`,
        `weak-${variant}`,
        false,
      );
    },
  },
];

// ---------------------------------------------------------------------------
// B9 挖矿 / 追踪
// ---------------------------------------------------------------------------

/**
 * 词表轮转家族的逐变体期望：`disposition`/`confidence` 由词条自己的 `tier` 决定。
 *
 * 这**不是**「照着实测结果写期望」：B9 三个分支的判定式在源码里就写成
 * `tier === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED'`（`b09-mining-tracking.ts:113-121` 挖矿、
 * `:127-134` 追踪），而 `MINING_TERMS`/`TRACKING_TERMS` 是冻结词表 ⇒ 期望值可以只从
 * 「词表 + 判定式」推导出来，一次扫描都不需要。反过来的形状（先扫、再把期望改成扫出来的值）
 * 才是 ZLQ-194 §16 点名的造假。
 *
 * 为什么必须逐变体：两张表都是 2 HIGH + 1 LOW，10 个变体轮转下来 LOW 落在 v2/v5/v8。
 * 家族级写死一个 BLOCK/HIGH，就等于宣称「B9 对低置信词条也硬拦」—— 那既不符合 §8.3
 * 「低置信成人复核」，也会把 3/10 的样例记成假失败，掩盖真的漏检。
 */
function tieredExpectation(subType: string, entry: LexiconEntry): ResolvedExpectation {
  return {
    subTypes: [subType],
    disposition: entry.tier === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED',
    confidence: entry.tier,
  };
}

const B9: readonly ViolationFamily[] = [
  {
    ruleId: 'B9',
    familyId: 'viol-b9-mining-term',
    expectedSubTypes: ['mining'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    expectationOf: (variant) => tieredExpectation('mining', rotate(MINING_TERMS, variant)),
    rationale:
      'MINING_TERMS 的条目 id 轮转；匹配串由 carrierFor 从词表自己的正则派生。' +
      '3 条词条（coinhive-family / mining-protocol 为 HIGH，hashrate-loop 为 LOW）⇒ 10 个变体里 ' +
      'v2/v5/v8 是 CONFIRM_REQUIRED/LOW，其余 BLOCK/HIGH。subType 两侧都是 `mining`：' +
      '没有执行体时 LOW 词条不升级，`b09:118-120` 的三元式落到最后一个 `mining`。',
    payload: (_base, random, variant) => {
      const entry = rotate(MINING_TERMS, variant);
      return js(
        'script',
        `const miningMarker = ${JSON.stringify(carrierFor(entry, random))};\nvoid miningMarker;`,
      );
    },
  },
  {
    ruleId: 'B9',
    familyId: 'viol-b9-mining-with-executor',
    expectedSubTypes: ['mining', 'mining-with-executor', 'worker'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    expectationOf: (variant) => {
      const entry = rotate(MINING_TERMS, variant);
      // §8.3 的「WebAssembly/Worker **+** 加密循环特征」是合取：只有 LOW 词条才需要执行体来升级，
      // 升级后 subType 变成 `mining-with-executor`；HIGH 词条本来就硬拦，subType 仍是 `mining`
      // （`b09:118-120`）。`worker` 则来自 `checkExecutors` 对 `Worker` 这个自由全局标识符的独立命中。
      return {
        subTypes: [entry.tier === 'HIGH' ? 'mining' : 'mining-with-executor', 'worker'],
        disposition: 'BLOCK',
        confidence: 'HIGH',
      };
    },
    rationale:
      '挖矿词 + 一个真的执行体（Worker）才算 mining-with-executor：光有词是文案，有执行体才是真在算。' +
      'Worker 脚本用 extraFiles 补进包里，避免连带 B1。逐变体解析 subType（见 `expectationOf`）：' +
      'v2/v5/v8 轮到低危的 hashrate-loop 才升级成 `mining-with-executor`，其余高危词条仍是 `mining`。' +
      '两侧都必然多一条 `worker`（BLOCK/HIGH），它是执行体自己的命中，声明出来而不是当污染。',
    payload: (_base, random, variant) => {
      const entry = rotate(MINING_TERMS, variant);
      return {
        slotId: 'script',
        text: `const miningMarker = ${JSON.stringify(carrierFor(entry, random))};
const miner = new Worker('assets/miner.js');
miner.postMessage(miningMarker);
`,
        extraFiles: [{ path: 'assets/miner.js', content: 'onmessage = () => {};\n' }],
      };
    },
  },
  {
    ruleId: 'B9',
    familyId: 'viol-b9-tracking-term',
    expectedSubTypes: ['tracking'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    expectationOf: (variant) => tieredExpectation('tracking', rotate(TRACKING_TERMS, variant)),
    rationale:
      'TRACKING_TERMS 的条目 id 轮转（analytics-sdk / ad-network 为 HIGH，tracking-id 为 LOW）⇒ ' +
      'v2/v5/v8 是 CONFIRM_REQUIRED/LOW。subType 与 tier 无关，恒为 `tracking`（`b09:133`）。',
    payload: (_base, random, variant) => {
      const entry = rotate(TRACKING_TERMS, variant);
      return js(
        'script',
        `const trackingMarker = ${JSON.stringify(carrierFor(entry, random))};\nvoid trackingMarker;`,
      );
    },
  },
  {
    ruleId: 'B9',
    familyId: 'viol-b9-known-tracking-domain',
    expectedSubTypes: ['known-tracking-domain', 'tracking'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: ['B1'],
    rationale:
      'host 取自 policy.knownTrackingDomains（语料策略给的是 google-analytics.com / doubleclick.net）。它同时是个站外资源引用，所以 B1 external-url 按定义共现。' +
      '`tracking` 也是**必然**共现而不是偶发：两个域名分别命中 TRACKING_TERMS 的 analytics-sdk 分支里的 ' +
      '`google-analytics` 与 `doubleclick`（同一张冻结表），而 `checkLexicon` 对 html-reference token 同样生效 ⇒ 恒为 BLOCK/HIGH。' +
      '一条 URL 因此拿到两个 subType，正是 §8.3「不以单条正则作为最终判定」的多信号形状。',
    payload: (_base, _random, variant) => {
      const domains = knownTrackingDomains();
      const host = domains[variant % domains.length] ?? domains[0] ?? 'google-analytics.com';
      return bodySlot(
        `    <img src="https://${host}/collect?p=${variant}" alt="" width="1" height="1" />`,
      );
    },
  },
  {
    ruleId: 'B9',
    familyId: 'viol-b9-wasm',
    expectedSubTypes: ['wasm'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      "WASM_NAMES=['WebAssembly']，且 policy.allowWasm 在 v1 冻结为 false（§8.3「v1 默认禁止 wasm」）⇒ 硬拦。",
    payload: () =>
      scriptSlot(
        `async function compileModule(bytes) {
  const module = await WebAssembly.instantiate(bytes, {});
  return module;
}
void compileModule;
`,
      ),
  },
  {
    ruleId: 'B9',
    familyId: 'viol-b9-hidden-iframe',
    expectedSubTypes: ['hidden-iframe'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      "HIDDEN_IFRAME_ATTRIBUTES=['hidden']；隐藏的 iframe 是点击劫持/静默加载的载体。src 指向包内入口，避免连带 B1。",
    payload: () => bodySlot(`    <iframe src="index.html" hidden title="隐藏帧"></iframe>`),
  },
];

// ---------------------------------------------------------------------------
// B10 混淆 / 动态执行
// ---------------------------------------------------------------------------

const B10: readonly ViolationFamily[] = [
  // ⚠️ 下面两族的 `eval` / `new Function` 是**被检测的样本文本**，不是本仓库会执行的代码：
  // 它们作为字符串写进生成出来的 `artifacts/corpus/**` 样例文件里，交给扫描器做**静态**分析，
  // 全程没有任何一处 import 或运行它们。B10 的存在意义就是抓到学生作品里的这两种写法。
  {
    ruleId: 'B10',
    familyId: 'viol-b10-eval',
    expectedSubTypes: ['dynamic-exec'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: "DYNAMIC_EXEC_NAMES=['eval']。字符串是字面量，静态可判。",
    payload: () =>
      scriptSlot(
        `function applyCheat(code) {
  return eval(code);
}
void applyCheat;
`,
      ),
  },
  {
    ruleId: 'B10',
    familyId: 'viol-b10-function-constructor',
    expectedSubTypes: ['function-constructor'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'FUNCTION_CONSTRUCTOR：new Function(字符串) 是 eval 的等价替身，绕过静态审查。',
    payload: () =>
      scriptSlot(
        `const buildStep = new Function('a', 'b', 'return a + b;');
void buildStep;
`,
      ),
  },
  {
    ruleId: 'B10',
    familyId: 'viol-b10-timer-string-exec',
    expectedSubTypes: ['timer-string-exec'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale: 'TIMER_NAMES + 字符串首参：setTimeout("code") 会走隐式 eval。',
    payload: () =>
      scriptSlot(
        `function startLoop() {
  setTimeout('tick()', 100);
}
void startLoop;
`,
      ),
  },
  {
    ruleId: 'B10',
    familyId: 'viol-b10-html-event-handler',
    expectedSubTypes: ['html-event-handler'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'HTML_EVENT_HANDLER_ATTRIBUTE_PATTERN（\\bon[a-z]+\\s*=）：内联事件处理器是标记里的可执行代码，CSP 也挡不住。',
    payload: () => bodySlot(`    <button type="button" onclick="score += 1">加一分</button>`),
  },
  {
    ruleId: 'B10',
    familyId: 'viol-b10-script-scheme-url',
    expectedSubTypes: ['script-scheme-url'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'SCRIPT_SCHEME_PATTERN：javascript: 伪协议把可执行代码塞进 href，是资源引用形态的动态执行。',
    payload: () => bodySlot(`    <a href="javascript:void(0)" id="trap-link">点我</a>`),
  },
  {
    ruleId: 'B10',
    familyId: 'viol-b10-unreadable-without-source',
    expectedSubTypes: ['unreadable-without-source'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: [],
    rationale:
      '判据是「不可读 **且** 无可读源」（`b10-obfuscation.ts:151-186`）。`hasReadableCounterpart` ' +
      '有两条候选：① 去掉 `.min` 的同名兄弟文件，② `work.json` 的 `sourceEntryPaths` 里**任意一个**' +
      '存在且自身可读的文件。安全底座本来就带可读源入口，只过滤掉 `.min.js` 是不够的 —— ' +
      '必须把 `sourceEntryPaths` 清空，才能让候选 ② 落空；再配一份真不可读的产物让度量成立。' +
      '两边都对，才测到「压缩产物之外必须有可读源」这条；只做一边就是 §2.4 那条安全反例。',
    payload: (_base, _random, variant) => ({
      slotId: 'script',
      text: `// 产物入口：真正的逻辑在 build/bundle.min.js 里。\n`,
      extraFiles: [{ path: 'build/bundle.min.js', content: corpusMinifiedJs(variant) }],
      sourceEntryPaths: [],
    }),
  },
];

// ---------------------------------------------------------------------------
// B11 AI
// ---------------------------------------------------------------------------

const B11: readonly ViolationFamily[] = [
  {
    ruleId: 'B11',
    familyId: 'viol-b11-provider-symbol-in-script',
    expectedSubTypes: ['ai-provider-symbol'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'AI_PROVIDER_TERMS 轮转（openai / anthropic / aliyun-bailian / google-gemini / other-providers / qca-agent-endpoint）。subTypeOf 把非 prompt-assembly 的条目映射成 ai-provider-symbol。',
    payload: (_base, random, variant) => {
      const entry = rotate(providerSymbols(), variant);
      return js(
        'script',
        `const provider = ${JSON.stringify(carrierFor(entry, random))};\nvoid provider;`,
      );
    },
  },
  {
    ruleId: 'B11',
    familyId: 'viol-b11-provider-symbol-as-global',
    expectedSubTypes: ['ai-provider-symbol'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      '同一个 provider 符号换成**自由标识符**投放（`codeTokensOf` 的 js-identifier 一路），' +
      '与上一族的字符串字面量是不同的 token 来源 —— 学生直接写 `openai.create…` 而不是把 SDK 名塞进字符串时，' +
      '漏掉这一路就全看不见。**不投放到 HTML 文案里**：B11 按设计只读代码 token，' +
      '文案里的「AI」是 §2.4 点名的安全反例（剧情角色『AI』、已固化的 AI 风格头像），不是违规。',
    payload: (_base, random, variant) => {
      const entry = rotate(providerSymbols(), variant);
      return js('script', `const client = ${providerIdentifierFor(entry, random)};\nvoid client;`);
    },
  },
  {
    ruleId: 'B11',
    familyId: 'viol-b11-prompt-assembly',
    expectedSubTypes: ['ai-prompt-assembly'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale:
      'PROMPT_ASSEMBLY_ID=prompt-assembly 的条目单独映射成 ai-prompt-assembly：拼接提示词是把 AI 能力藏进作品里，比引用一个 SDK 名更难发现。',
    payload: (_base, random, variant) => {
      const entry = entryById('prompt-assembly', AI_PROVIDER_TERMS, 'AI_PROVIDER_TERMS');
      return js(
        'script',
        `const promptParts = [${JSON.stringify(carrierFor(entry, random))}];
const step = ${variant};
void promptParts; void step;`,
      );
    },
  },
  {
    ruleId: 'B11',
    familyId: 'viol-b11-provider-domain-script-src',
    expectedSubTypes: ['ai-provider-domain'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: ['B1'],
    rationale:
      'checkExternalHosts 在资源图的外部 host 边上跑 AI 词表 ⇒ 必须是站外引用，B1 external-url 按定义共现。' +
      'prompt-assembly 条目在这一路上被显式跳过，所以只会得到 ai-provider-domain。' +
      '**载体串落在 host 上而不是路径上** —— 判据只拿 `edge.resolved.host` 去匹配，放在路径里一条都不命中。',
    payload: (_base, random, variant) => {
      const entry = rotate(providerSymbols(), variant);
      const host = providerHostFor(entry, random);
      return headSlot(`    <script src="https://${host}/sdk.js"></script>`);
    },
  },
  {
    ruleId: 'B11',
    familyId: 'viol-b11-provider-domain-img',
    expectedSubTypes: ['ai-provider-domain'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: ['B1'],
    rationale:
      '同一条判据换个资源类型（img 而不是 script）——证明它查的是资源图的 host，不是脚本专属。',
    payload: (_base, random, variant) => {
      const entry = rotate(providerSymbols(), variant);
      const host = providerHostFor(entry, random);
      return bodySlot(
        `    <img src="https://${host}/sprite.png" alt="素材图" width="8" height="8" />`,
      );
    },
  },
  {
    ruleId: 'B11',
    familyId: 'viol-b11-provider-domain-css-import',
    expectedSubTypes: ['ai-provider-domain'],
    disposition: 'BLOCK',
    confidence: 'HIGH',
    caseCount: CASES_PER_FAMILY,
    provenance: 'rule-reading',
    expectedOtherRules: ['B1'],
    rationale:
      '第三种载体：CSS 的 @import（CSS_IMPORT_AT_RULES）。样式表也能把 AI 服务的域名带进作品。',
    payload: (_base, random, variant) => {
      const entry = rotate(providerSymbols(), variant);
      const host = providerHostFor(entry, random);
      return {
        slotId: 'style',
        text: `@import url('https://${host}/theme.css');\n`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// B12 虚假能力（全部 CONFIRM_REQUIRED —— 不可谈判项 2）
// ---------------------------------------------------------------------------

/**
 * B12 的六个家族。**每一个的 disposition 都是 CONFIRM_REQUIRED**，一个 BLOCK 都不许有：
 * §8.3「只标记确认，不硬拦」、§8.6「B12 始终确认」、ZLQ-201 PASS §6 不可谈判项 2。
 * 结构上有三道闸钉住这件事（`FindingFactory` 的处置上限会抛、registry 的冻结上限比对、
 * `verdict.ts` 把任何 B12 硬阻断判成最高优先级缺口），语料这一层再补第四道：
 * 60 件样例的期望值全是 CONFIRM_REQUIRED，只要扫描器硬拦一次，实测就与期望不符并被点名。
 *
 * 载荷必须避开 `CLAIM_NEGATION_CUES`：那张表收了「不支持/没有/仅/只/本机/本地/模拟/演示」等，
 * 同句出现任一个就会被 `isNegated` 放行。所以这里的句子都是**正面宣称**，
 * 而且一句一断言（`SENTENCE_BOUNDARY_PATTERN` 按 。！？；\n.!?; 切句，否证窗口只有一句）。
 */
function b12Family(
  familyId: string,
  entryId: string,
  placement: 'html-text' | 'alt' | 'js-string' | 'heading' | 'aria' | 'manifest-title',
  rationale: string,
): ViolationFamily {
  const payloadFor = (base: SafeBase, random: Random): ViolationPayload => {
    const entry = entryById(entryId, CAPABILITY_CLAIM_TERMS, 'CAPABILITY_CLAIM_TERMS');
    const claim = carrierFor(entry, random);
    switch (placement) {
      case 'alt':
        return bodySlot(
          `    <img src="${base.sourceEntryPaths[0] ?? 'index.html'}" alt="${claim}" width="8" height="8" />`,
        );
      case 'js-string':
        return scriptSlot(`const banner = ${JSON.stringify(claim)};\nvoid banner;\n`);
      case 'heading':
        return bodySlot(`    <h2>${claim}</h2>`);
      case 'aria':
        return bodySlot(`    <button type="button" aria-label="${claim}">开始</button>`);
      case 'manifest-title':
        // 走 work.json 的展示字段：B12 对 metadata 用 manifestCopyChunks + JSON Pointer 定位。
        return bodySlot(`    <p data-claim="${claim}">${claim}</p>`);
      case 'html-text':
      default:
        return bodySlot(`    <p>${claim}</p>`);
    }
  };
  return {
    ruleId: 'B12',
    familyId,
    expectedSubTypes: [entryId],
    disposition: 'CONFIRM_REQUIRED',
    confidence: 'LOW',
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    rationale,
    payload: (base, random) => payloadFor(base, random),
  };
}

const B12: readonly ViolationFamily[] = [
  b12Family(
    'viol-b12-cloud-save-text',
    'cloud-save',
    'html-text',
    '「云存档」出现在正文段落里。词表条目 id 即子类型。',
  ),
  b12Family(
    'viol-b12-account-sync-alt',
    'account-sync',
    'alt',
    '同一条宣称放在 img 的 alt 上 —— §8.3 点名「文本/ARIA/canvas」三个来源，ARIA 这一路必须被真测到。',
  ),
  b12Family(
    'viol-b12-cloud-sync-js-string',
    'cloud-sync',
    'js-string',
    'canvas 文案只存在于 JS 字符串里，所以 JS 字符串字面量必须进文案集；漏掉它 B12 形同虚设。',
  ),
  b12Family(
    'viol-b12-global-leaderboard-heading',
    'global-leaderboard',
    'heading',
    '标题级文案（<h2>）权重最高，学生最容易读到的位置。',
  ),
  b12Family(
    'viol-b12-online-multiplayer-aria',
    'online-multiplayer',
    'aria',
    'aria-label 上的宣称：屏幕阅读器会念出来，对低龄段等价于可见文案。',
  ),
  b12Family(
    'viol-b12-payment-claim-text',
    'payment-claim',
    'html-text',
    '付费宣称是最需要成人确认的一类（涉及金钱），但**仍然只转确认**，不硬拦 —— 这正是不可谈判项 2 要保护的边界。',
  ),
];

// ---------------------------------------------------------------------------
// B13 不适宜内容（§2.4：50 高危硬拦 + 10 低危转确认）
// ---------------------------------------------------------------------------

/**
 * B13 的六个家族 = **五种投放位置** × 高危词表轮转，再加一个低危家族。
 *
 * 「投放位置」和「说什么」被刻意分开：位置是本文件里可读的代码（段落 / alt / JS 字符串 /
 * 标题 / aria-label），内容一律由 `carrierFor` 在生成时从 `INAPPROPRIATE_HIGH` 自己的正则反推。
 * 于是 10 个变体 × 10 条高危类目 = **每一条高危类目都被测到**，而仓库里不出现一个有害词面。
 *
 * 排除法说明：`undecodable-copy` / `image-hash-deny-listed` / `image-exif-gps` 这几个子类型
 * 不进本家族的期望集合 —— 它们需要构造解码失败或特制二进制，属于 D3a 单元测试已覆盖的形状，
 * 混进语料会让「语料的 780 件单点变异」这个计数对不上 §2.4。
 */
function b13Family(
  familyId: string,
  tier: 'HIGH' | 'LOW',
  render: (claim: string, base: SafeBase, variant: number) => ViolationPayload,
  rationale: string,
): ViolationFamily {
  const table = tier === 'HIGH' ? INAPPROPRIATE_HIGH : INAPPROPRIATE_LOW;
  const tableName = tier === 'HIGH' ? 'INAPPROPRIATE_HIGH' : 'INAPPROPRIATE_LOW';
  return {
    ruleId: 'B13',
    familyId,
    // 家族级声明的是**上界**：这一族的子类型必然落在该 tier 表里。
    // 具体是哪一条由 `expectationOf` 按变体给出 —— 因为 `rotate` 是确定的，
    // 所以「第 n 件用第 n%|table| 条」在生成前就已知，不需要跑扫描。
    expectedSubTypes: table.map((entry) => entry.id),
    disposition: tier === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED',
    confidence: tier,
    caseCount: CASES_PER_FAMILY,
    provenance: 'ruleset-table',
    expectedOtherRules: [],
    /**
     * 逐变体解析。`b13-inappropriate-content.ts:179-205` 的判据是
     * `subTypeOf(entry) = DECLARED.has(entry.id) ? entry.id : 'unclassified-term'`、
     * `disposition = confidence === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED'`、
     * `confidence = entry.tier` —— 三者都是 `entry` 的纯函数，
     * 而 `entry` 由 `rotate(table, variant)` 决定。所以这个函数只读冻结词表，
     * 不读载荷、不读扫描结果，`provenance: 'ruleset-table'` 名副其实。
     */
    expectationOf: (variant) => {
      const entry = rotate(table, variant);
      return {
        subTypes: [entry.id],
        disposition: entry.tier === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED',
        confidence: entry.tier,
      };
    },
    rationale,
    payload: (base, random, variant) => {
      const entry = rotate(table, variant);
      const claim = carrierFor(entry, random, B13_CARRIER_CONSTRAINT);
      // 生成时就断言匹配（carriers.ts 的纪律 3）；tableName 只进错误信息，不进内容。
      void tableName;
      return render(claim, base, variant);
    },
  };
}

/**
 * B13 的载体串必须**避开** B12 的宣称词表。
 *
 * 实测到的真实碰撞：`gambling-money` 的一支派生串同时命中 `payment-claim`
 * （赌博与金钱在语义上相邻，两张表都收）。碰撞串本身仍然是合格的 B13 高危样例，
 * 但它会给报告添一条未声明的跨规则命中，把 B12 的 precision 分母弄脏。
 * 判据是 `CAPABILITY_CLAIM_TERMS` 这张**冻结表**，不查扫描器 —— 见 `CarrierConstraint`。
 */
const B13_CARRIER_CONSTRAINT: CarrierConstraint = {
  reject: (candidate) => CAPABILITY_CLAIM_TERMS.some((entry) => entry.pattern.test(candidate)),
  rejectLabel: 'CAPABILITY_CLAIM_TERMS',
};

const B13: readonly ViolationFamily[] = [
  b13Family(
    'viol-b13-high-paragraph',
    'HIGH',
    (claim) => bodySlot(`    <p>${claim}</p>`),
    '高危类目出现在正文段落里 —— 最常见的投放位置，也是学生最直接读到的地方。',
  ),
  b13Family(
    'viol-b13-high-image-alt',
    'HIGH',
    (claim, base) =>
      bodySlot(
        `    <img src="${base.sourceEntryPaths[0] ?? 'index.html'}" alt="${claim}" width="8" height="8" />`,
      ),
    '高危类目藏在 img 的 alt 上：页面上看不见，但屏幕阅读器会念、右键查看源码也能读到。',
  ),
  b13Family(
    'viol-b13-high-js-string',
    'HIGH',
    (claim) => scriptSlot(`const notice = ${JSON.stringify(claim)};\nvoid notice;\n`),
    '高危类目作为 JS 字符串常量（canvas fillText / 弹窗文案的来源）。标记层完全干净，只有抽 JS 字符串才抓得到。',
  ),
  b13Family(
    'viol-b13-high-heading',
    'HIGH',
    (claim) => bodySlot(`    <h2>${claim}</h2>`),
    '高危类目作为标题：权重最高的文案位置。',
  ),
  b13Family(
    'viol-b13-high-aria-label',
    'HIGH',
    (claim) => bodySlot(`    <button type="button" aria-label="${claim}">继续</button>`),
    '高危类目放在 aria-label 上：无障碍通道，容易被当成「不是给人看的」而漏审。',
  ),
  b13Family(
    'viol-b13-low-paragraph',
    'LOW',
    (claim) => bodySlot(`    <p>${claim}</p>`),
    '低危类目（INAPPROPRIATE_LOW：substance-use / swearing / gambling-words / weapon-display / self-harm-mention / dating-content）' +
      '按 §8.6「低置信进入成人复核」⇒ CONFIRM_REQUIRED。这一族 10 件构成 B13 的低危配额。' +
      '刻意放在段落里而不是 <a> 里：B13 的链接路径只跑高危表，低危放在链接上会测不到。',
  ),
];

/** 十三条规则的家族表。顺序即 `RULE_IDS`，报告按这个顺序出。 */
export const VIOLATION_FAMILIES: readonly ViolationFamily[] = [
  ...B1,
  ...B2,
  ...B3,
  ...B4,
  ...B5,
  ...B6,
  ...B7,
  ...B8,
  ...B9,
  ...B10,
  ...B11,
  ...B12,
  ...B13,
];

// ---------------------------------------------------------------------------
// 词表访问器。放在文件末尾是因为它们只是「把 D3a 的导出换个名字」，不是设计。
// ---------------------------------------------------------------------------

function highPiiCues(): readonly LexiconEntry[] {
  return PII_STRONG_FIELD_CUES;
}

function lowPiiCues(): readonly LexiconEntry[] {
  return PII_WEAK_FIELD_CUES;
}

function autocompleteTokens(): readonly string[] {
  return PII_AUTOCOMPLETE_TOKENS;
}

function knownTrackingDomains(): readonly string[] {
  return corpusPolicy().knownTrackingDomains;
}

function providerSymbols(): readonly LexiconEntry[] {
  // prompt-assembly 有自己的一族，不参与「provider 符号」轮转。
  return AI_PROVIDER_TERMS.filter((entry) => entry.id !== 'prompt-assembly');
}

/**
 * B11 的 `checkExternalHosts` 只把**资源图边的 host** 拿去对词表（`b11-ai.ts:90-100`），
 * 不看路径。所以载体串必须落在 host 里，而且落进去之后**仍然命中**该词条。
 *
 * host 段一律挂在保留测试顶级域 `.example.test` 下（RFC 6761），**不用真实 provider 域名**：
 * §2.1「不得指向云端 metadata 或外部目标」。B11 判的是「host 字符串命中 AI 词表」，
 * 不是「host 在某个真实域名清单里」，所以换成测试域不损失任何覆盖面。
 *
 * 词条里有若干分支天生进不了 host（`aliyuncs\.com/(?:api|v1)/` 带斜杠、`qoder\s*cloud\s*agents`
 * 带空格、`百炼`/`通义` 会被 URL 解析成 punycode），这里用 `CarrierConstraint` 在**生成时**
 * 把它们拒掉、重抽一个能用的分支 —— 而不是把不可用的分支写进期望再事后豁免。
 */
function providerHostFor(entry: LexiconEntry, random: Random): string {
  const carrier = carrierFor(entry, random, {
    reject: (candidate) =>
      !HOST_SAFE_LABEL.test(candidate) || !entry.pattern.test(`api-${candidate}.example.test`),
    rejectLabel: `HOST_EMBEDDING:${entry.id}`,
  });
  return `api-${carrier}.example.test`;
}

/** host 标签可用字符：ASCII 小写、数字、`-`、`_`、`.`（`replicate.com` 这类词条自带点）。 */
const HOST_SAFE_LABEL = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * B11 的 `checkTokens` 读 `codeTokensOf`，其中 `js.globals`（自由标识符）走 `js-identifier` 这一路。
 * 载体串要当标识符用就必须是合法 JS 标识符：`gpt-4`、`claude-sonnet`、`replicate.com` 都不行。
 * 同样在生成时拒掉、重抽，不事后豁免。
 */
function providerIdentifierFor(entry: LexiconEntry, random: Random): string {
  return carrierFor(entry, random, {
    reject: (candidate) => !JS_IDENTIFIER.test(candidate),
    rejectLabel: `JS_IDENTIFIER:${entry.id}`,
  });
}

const JS_IDENTIFIER = /^[$A-Z_a-z][$\w]*$/u;

// ---------------------------------------------------------------------------
// 结构校验（纯函数，供测试与 runner 复用）
// ---------------------------------------------------------------------------

/** 家族表的违规清单。返回清单而不是抛异常：注册表在模块加载时抛会让整包不可用。 */
export function violationFamilyViolations(): string[] {
  const violations: string[] = [];
  const seenFamily = new Set<string>();
  const perRule = new Map<string, { families: number; cases: number }>();

  for (const family of VIOLATION_FAMILIES) {
    if (seenFamily.has(family.familyId)) violations.push(`家族 id 重复：${family.familyId}`);
    seenFamily.add(family.familyId);
    if (!family.familyId.startsWith(`viol-${family.ruleId.toLowerCase()}-`)) {
      violations.push(`家族 id ${family.familyId} 与它的 ruleId ${family.ruleId} 不一致`);
    }
    if (family.expectedSubTypes.length === 0) {
      violations.push(`${family.familyId} 没有声明任何期望子类型`);
    }
    if (family.caseCount <= 0) violations.push(`${family.familyId} 的样例数必须为正`);
    if (family.expectedOtherRules.includes(family.ruleId)) {
      violations.push(`${family.familyId} 把自己列进了 expectedOtherRules`);
    }
    const tally = perRule.get(family.ruleId) ?? { families: 0, cases: 0 };
    tally.families += 1;
    tally.cases += family.caseCount;
    perRule.set(family.ruleId, tally);
  }

  // §2.4：每条规则 60 件违规样例。家族数不固定（≥6 是为了「不是只有一种触发形状」），
  // 但**件数**必须正好 60，否则规则间的 precision 分母不可比。
  for (const ruleId of RULE_IDS) {
    const tally = perRule.get(ruleId);
    if (tally === undefined) {
      violations.push(`${ruleId} 没有任何违规家族`);
      continue;
    }
    if (tally.families < 6) violations.push(`${ruleId} 只有 ${tally.families} 个家族（要求 ≥6）`);
    if (tally.cases !== VIOLATION_CASES_PER_RULE) {
      violations.push(`${ruleId} 的违规样例数是 ${tally.cases}，要求 ${VIOLATION_CASES_PER_RULE}`);
    }
  }

  // 不可谈判项 2：B12 的期望里不许出现 BLOCK。
  for (const family of VIOLATION_FAMILIES) {
    if (family.ruleId === 'B12' && family.disposition !== 'CONFIRM_REQUIRED') {
      violations.push(
        `B12 家族 ${family.familyId} 的期望处置是 ${family.disposition}（必须 CONFIRM_REQUIRED）`,
      );
    }
  }

  return violations;
}

/** 违规样例总数：13 × 60 = 780。 */
export const VIOLATION_TOTAL = VIOLATION_FAMILIES.reduce((sum, f) => sum + f.caseCount, 0);

/**
 * **B9 挖矿/追踪/广告** —— ZLQ-153 §8.3 原文：
 * 「已知域名/SDK/hash 签名、WebAssembly/Worker + 加密循环特征、追踪标识、隐藏 iframe；
 * v1 默认禁止 wasm，降低漏检」
 *
 * 词库输入集是 `codeTokensOf`（**只有**代码性质的串：自由标识符、调用路径、字符串字面量、
 * import 源、CSS 值、资源引用），不含 HTML 文本节点与展示属性。ZLQ-156 §2.4 的四条 B9 反例
 * 因此都是**结构性**放行，不是「词表恰好没写到」：
 * - 「标题『探险挖矿』」在 manifest `/title` 或 `<h1>` 文本里，压根不进 token 集；
 *   而且 `MINING_TERMS` 里**没有**中文「挖矿」二字，只收技术标识（coinhive/stratum/xmrig…）。
 * - 「可见游戏数值计算」「WebGL 粒子」不含 hashrate/cryptonight 一类符号。
 * - 「requestAnimationFrame」既不在 `WASM_NAMES` 也不在 `WORKER_CONSTRUCTORS`。
 *
 * §8.3 的「WebAssembly/Worker **+** 加密循环特征」是一个**合取**判定，不是单条正则：
 * LOW tier 的 `hashrate` 字样单独出现只进成人复核，只有同一文件里同时出现 Worker/WASM
 * 才升级为硬拦。这正是 §8.3「不以单条正则作为最终判定」落地的地方。
 *
 * Worker/WASM 只看 `globalReferences`（自由全局标识符）就够了：`WebAssembly.instantiate(…)`
 * 的 `WebAssembly` 与 `new Worker(…)` 的 `Worker` 都必然是自由全局标识符，
 * 被局部同名变量遮蔽时它本来就不是平台的那个对象。所以不需要再枚举调用形态。
 */

import type { HtmlElementSummary } from '../analysis/model.js';
import { MINING_TERMS, TRACKING_TERMS, WASM_NAMES, WORKER_CONSTRUCTORS } from '../lexicon.js';
import type { FindingLocation } from '../types.js';
import {
  attributeOf,
  codeTokensOf,
  cssSummariesOf,
  htmlSummaryOf,
  jsSummariesOf,
  matchDecoded,
} from './support.js';
import type { CodeToken } from './support.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';

export const B9_SUB_TYPES = [
  'mining',
  'mining-with-executor',
  'tracking',
  'known-tracking-domain',
  'wasm',
  'worker',
  'hidden-iframe',
] as const;

const WASM_SET = new Set(WASM_NAMES);
const WORKER_SET = new Set(WORKER_CONSTRUCTORS);
/** 让 iframe 不可见的声明；inline `style` 与 CSS 规则共用同一张表。 */
const HIDING_DECLARATIONS = new Set([
  'display:none',
  'visibility:hidden',
  'opacity:0',
  'width:0',
  'height:0',
  'width:0px',
  'height:0px',
]);
/** 移出视口同样算隐藏。阈值 −1000：正常的负值布局（居中、微调）远没这么远。 */
const OFF_SCREEN_PROPERTIES = new Set(['left', 'top', 'margin-left', 'margin-top']);
const OFF_SCREEN_THRESHOLD = -1000;
const OFF_SCREEN_PATTERN = /^(-\d+(?:\.\d+)?)(?:px|rem|em|vw|vh)?$/;

export const b09MiningTracking: Rule = {
  id: 'B9',
  maxDisposition: 'BLOCK',
  subTypes: B9_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      // 先判执行体：它的结果既是独立命中，也是挖矿合取升级的第二个信号。
      const hasExecutor = checkExecutors(context, file);
      // token 只抽一次：二级解码预算是**累计**的（§6.4），重复抽取会重复扣预算。
      const tokens = codeTokensOf(file);
      checkLexicon(context, file, tokens, hasExecutor);
      checkKnownDomains(context, file, tokens);
      checkHiddenIframe(context, file);
    }
  },
};

/** Worker / WebAssembly。冻结 CSP 是 `worker-src 'none'`，`policy.allowWasm` 是字面量 `false`。 */
function checkExecutors(context: RuleContext, file: RuleFileContext): boolean {
  let found = false;
  for (const js of jsSummariesOf(file.summary)) {
    for (const reference of js.globalReferences) {
      const subType = WASM_SET.has(reference.name)
        ? 'wasm'
        : WORKER_SET.has(reference.name)
          ? 'worker'
          : null;
      if (subType === null) continue;
      found = true;
      emitBlock(context, file.path, subType, reference.location);
    }
  }
  return found;
}

/** 词库命中（挖矿家族、追踪 SDK、追踪标识）+ 与执行体的合取升级。 */
function checkLexicon(
  context: RuleContext,
  file: RuleFileContext,
  tokens: readonly CodeToken[],
  hasExecutor: boolean,
): void {
  for (const token of tokens) {
    const mining = matchDecoded(MINING_TERMS, token.value, context.budget);
    if (mining.entry !== null) {
      const escalated = mining.entry.tier === 'HIGH' || hasExecutor;
      context.emit({
        ruleId: 'B9',
        disposition: escalated ? 'BLOCK' : 'CONFIRM_REQUIRED',
        confidence: escalated ? 'HIGH' : 'LOW',
        path: file.path,
        location: token.location,
        repairAction: 'REMOVE_NETWORK',
        subType:
          mining.entry.tier === 'HIGH' ? 'mining' : escalated ? 'mining-with-executor' : 'mining',
      });
      continue;
    }

    const tracking = matchDecoded(TRACKING_TERMS, token.value, context.budget);
    if (tracking.entry === null) continue;
    context.emit({
      ruleId: 'B9',
      // §8.3「追踪标识」：没有网络出口时它发不出去（B2 已硬拦），所以 LOW 只复核，HIGH 硬拦。
      disposition: tracking.entry.tier === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED',
      confidence: tracking.entry.tier,
      path: file.path,
      location: token.location,
      repairAction: 'REMOVE_NETWORK',
      subType: 'tracking',
    });
  }
}

/** 策略表里的已知追踪域名：既匹配已分类的外部引用，也匹配裸字符串。 */
function checkKnownDomains(
  context: RuleContext,
  file: RuleFileContext,
  tokens: readonly CodeToken[],
): void {
  const domains = context.policy.knownTrackingDomains;
  if (domains.length === 0) return;

  for (const edge of context.graph.edges) {
    // B1 的资源图已经把 URL 规范化过，这里不重新解析，也不重花解码预算。
    if (edge.fromPath !== file.path || edge.resolved.target !== 'external') continue;
    const host = edge.resolved.host;
    if (host === null || !isKnownDomain(host, domains)) continue;
    emitBlock(context, file.path, 'known-tracking-domain', edge.location);
  }

  // 域名也可能只出现在字符串里而没被识别成资源引用（例如拼进 `fetch` 的实参）。
  for (const token of tokens) {
    if (!mentionsKnownDomain(token.value, domains)) continue;
    emitBlock(context, file.path, 'known-tracking-domain', token.location);
  }
}

/** 真主机名：精确相等或子域。用包含匹配会让 `mygoogle.com` 误命中 `google.com`。 */
function isKnownDomain(host: string, domains: readonly string[]): boolean {
  const lowered = host.toLowerCase();
  return domains.some((domain) => {
    const needle = domain.toLowerCase();
    return lowered === needle || lowered.endsWith(`.${needle}`);
  });
}

/**
 * 裸字符串用包含匹配，**故意**比主机名判定宽：追踪域名出现在字符串里就说明代码在拼它，
 * 而拼出来的东西 B1/B2 未必能分类成引用。这里误报的代价是一次成人复核，
 * 漏报的代价是一个真追踪器上线。
 */
function mentionsKnownDomain(value: string, domains: readonly string[]): boolean {
  const lowered = value.toLowerCase();
  return domains.some((domain) => lowered.includes(domain.toLowerCase()));
}

/** 隐藏 iframe：`hidden` 属性、inline `style`，或 CSS 规则里针对 iframe 的隐藏声明。 */
function checkHiddenIframe(context: RuleContext, file: RuleFileContext): void {
  const html = htmlSummaryOf(file.summary);
  if (html !== null) {
    for (const element of html.elements) {
      if (element.tagName !== 'iframe') continue;
      if (isHiddenElement(element))
        emitBlock(context, file.path, 'hidden-iframe', element.location);
    }
  }

  for (const css of cssSummariesOf(file.summary)) {
    for (const declaration of css.declarations) {
      if (!declaration.selector.toLowerCase().includes('iframe')) continue;
      if (!hides(declaration.property, declaration.value)) continue;
      emitBlock(context, file.path, 'hidden-iframe', declaration.location);
    }
  }
}

/**
 * `hidden` 是布尔属性，`<iframe hidden>` 没有值 ⇒ 必须判「属性存在」而不是「属性非空」。
 * 只查非空值会让最直白的那种隐藏 iframe 静默通过。
 */
function isHiddenElement(element: HtmlElementSummary): boolean {
  if (element.attributes.some((attribute) => attribute.name === 'hidden')) return true;
  const style = attributeOf(element, 'style');
  if (style === null) return false;
  return styleDeclarationsHide(style);
}

function styleDeclarationsHide(style: string): boolean {
  for (const part of style.split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    if (hides(part.slice(0, index), part.slice(index + 1))) return true;
  }
  return false;
}

function hides(property: string, value: string): boolean {
  const name = property.trim().toLowerCase();
  const normalized = value.replace(/\s+/g, '').toLowerCase();
  if (HIDING_DECLARATIONS.has(`${name}:${normalized}`)) return true;
  if (!OFF_SCREEN_PROPERTIES.has(name)) return false;
  const match = OFF_SCREEN_PATTERN.exec(normalized);
  if (match === null) return false;
  const offset = Number(match[1]);
  return Number.isFinite(offset) && offset <= OFF_SCREEN_THRESHOLD;
}

function emitBlock(
  context: RuleContext,
  path: string,
  subType: string,
  location: FindingLocation,
): void {
  context.emit({
    ruleId: 'B9',
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path,
    location,
    repairAction: 'REMOVE_NETWORK',
    subType,
  });
}

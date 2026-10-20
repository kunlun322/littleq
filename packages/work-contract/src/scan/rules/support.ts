/**
 * 规则的公共取数层。
 *
 * 两个纪律写在这里，因为它们决定 §8.6 的误拦率能不能守住：
 *
 * 1. **代码 token 与展示文案是两个不相交的输入集。** B9/B11 只读 `codeTokensOf`
 *    （标识符、成员路径、调用路径、import 源、CSS 声明值、资源引用），
 *    B8/B12/B13 只读 `copyChunksOf`（HTML 文本节点、展示属性、JS 字符串、文本文件正文、
 *    manifest 展示字段）。ZLQ-156 §2.4 的安全反例「标题『探险挖矿』」「剧情角色『AI』」
 *    之所以必须通过，靠的就是这条划分：把它们混进同一个集合，任何一侧都要靠事后豁免来救。
 *
 * 2. **词库匹配一律跑在二级解码后的所有变体上**（§8.3 末句：混合编码、HTML entity、
 *    Unicode 同形字、字符串拼接与 base64 解码后的二级内容）。`truncated` 的候选
 *    **不能**判为干净 —— §6.4「绝不因为『没读完』给 PASS」。
 */

import type { Budget } from '../budget.js';
import type { ResourceGraph, ResourceGraphEdge } from '../graph.js';
import type { LexiconEntry } from '../lexicon.js';
import { CLAIM_NEGATION_CUES, SENTENCE_BOUNDARY_PATTERN } from '../lexicon.js';
import { collapseWhitespace, decodeToFixedPoint } from '../normalize.js';
import type { FindingLocation, SourceRange, ValidatedWorkMetadata } from '../types.js';
import type {
  CssParseSummary,
  HtmlElementSummary,
  HtmlParseSummary,
  JsArgShape,
  JsParseSummary,
  ParseSummary,
} from '../analysis/model.js';
import type { RuleFileContext } from './types.js';

// ---------------------------------------------------------------------------
// 摘要取数
// ---------------------------------------------------------------------------

/** 顶层 JS 摘要 + HTML 内联 `<script>` 子摘要（漏掉内联那一层就看不见内联 import）。 */
export function jsSummariesOf(summary: ParseSummary): readonly JsParseSummary[] {
  if (summary.kind === 'js') return [summary];
  if (summary.kind !== 'html') return [];
  return summary.inlineScriptSummaries;
}

/** 顶层 CSS 摘要 + HTML 内联 `<style>` 子摘要。 */
export function cssSummariesOf(summary: ParseSummary): readonly CssParseSummary[] {
  if (summary.kind === 'css') return [summary];
  if (summary.kind !== 'html') return [];
  return summary.inlineStyleSummaries;
}

export function htmlSummaryOf(summary: ParseSummary): HtmlParseSummary | null {
  return summary.kind === 'html' ? summary : null;
}

export function attributeOf(element: HtmlElementSummary, name: string): string | null {
  for (const attribute of element.attributes) if (attribute.name === name) return attribute.value;
  return null;
}

export function hasAttribute(element: HtmlElementSummary, name: string): boolean {
  return element.attributes.some((attribute) => attribute.name === name);
}

/** `window.location.href` → `location.href`。词库锚定的是裸路径，不剥前缀就全漏。 */
export function stripGlobalPrefix(path: string): string {
  if (path === 'window' || path === 'globalThis' || path === 'self') return path;
  for (const prefix of ['window.', 'globalThis.', 'self.']) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

export function lastSegment(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? path : path.slice(dot + 1);
}

// ---------------------------------------------------------------------------
// 资源图查询
// ---------------------------------------------------------------------------

/**
 * 按 (来源文件, 原始串) 找回已经分类过的边。
 *
 * B2/B5 都要知道 form action 指向哪里，但**不能重新调 `classifyUrlReference`** ——
 * 分类要花二级解码预算（§6.4 计入累计输入预算），同一个串分类两次会让预算翻倍，
 * 而且预算耗尽后两次结果可能不一致。分类只在 `buildResourceGraph` 里发生一次。
 */
export function findEdge(
  graph: ResourceGraph,
  fromPath: string,
  raw: string,
): ResourceGraphEdge | null {
  for (const edge of graph.edges) {
    if (edge.fromPath === fromPath && edge.raw === raw) return edge;
  }
  return null;
}

/** 边的落点是否逃出包外，或者根本解析不出落点（含 `truncated`）。 */
export function escapesPackage(edge: ResourceGraphEdge): boolean {
  switch (edge.resolved.target) {
    case 'external':
    case 'escaped-root':
    case 'scheme-not-allowed':
    case 'unresolved':
      return true;
    case 'package-file':
    case 'inline-data':
    case 'fragment':
    case 'blob-literal':
    case 'script-scheme':
    case 'empty':
      return false;
  }
}

// ---------------------------------------------------------------------------
// 作品自带的 meta CSP
// ---------------------------------------------------------------------------

/** §8.4 的冻结 CSP 里 `connect-src`/`form-action`/`frame-src`/`object-src`/`base-uri`/`worker-src` 都是 `'none'`。 */
export const CSP_NONE = "'none'";

export type MetaCsp = {
  readonly policy: string;
  readonly location: SourceRange | null;
};

/**
 * 取出作品里所有 `<meta http-equiv="Content-Security-Policy" content="…">`。
 *
 * B2 查 `connect-src`，B5 查 `form-action`：作品不能用自己的 meta CSP 把平台冻结的那一份放宽。
 * `<meta content>` 只有在 http-equiv=refresh 时才被当成资源引用（见 `analysis/html.ts`），
 * 所以 CSP 串不会污染资源图。
 */
export function metaCspOf(file: RuleFileContext): readonly MetaCsp[] {
  const html = htmlSummaryOf(file.summary);
  if (html === null) return [];

  const found: MetaCsp[] = [];
  for (const element of html.elements) {
    if (element.tagName !== 'meta') continue;
    let httpEquiv: string | null = null;
    let policy: string | null = null;
    let location: SourceRange | null = element.location;
    for (const attribute of element.attributes) {
      if (attribute.name === 'http-equiv') httpEquiv = attribute.value.trim().toLowerCase();
      if (attribute.name === 'content') {
        policy = attribute.value;
        location = attribute.location ?? element.location;
      }
    }
    if (httpEquiv !== 'content-security-policy' || policy === null) continue;
    found.push({ policy, location });
  }
  return found;
}

/**
 * 取一条 CSP 指令的值；没有该指令返回 null（交给 `default-src` 兜底）。
 *
 * 按空白切第一个 token 比 `startsWith` 安全 —— `connect-src-ish` 不该命中 `connect-src`。
 * 指令存在但源列表为空，在 CSP 语义里等于 `'none'`，直接归一化，
 * 免得回落到 `default-src` 造出误拦。
 */
export function cspDirective(policy: string, name: string): string | null {
  for (const directive of policy.split(';')) {
    const parts = directive.trim().split(/\s+/);
    if ((parts[0] ?? '').toLowerCase() !== name) continue;
    const value = parts.slice(1).join(' ').trim().toLowerCase();
    return value.length === 0 ? CSP_NONE : value;
  }
  return null;
}

/** `connect-src` 缺失时按 CSP 规范回落到 `default-src`。 */
export function effectiveDirective(policy: string, name: string): string | null {
  return cspDirective(policy, name) ?? cspDirective(policy, 'default-src');
}

// ---------------------------------------------------------------------------
// 二级解码
// ---------------------------------------------------------------------------

export type DecodedText = {
  /** 原始串 + 每一层解码产物。词库要对**每个**变体都跑一遍。 */
  readonly variants: readonly string[];
  /** 触到深度/字节上限。**true 时不得判定为「干净」。** */
  readonly truncated: boolean;
};

export function decodeText(text: string, budget: Budget): DecodedText {
  const decoded = decodeToFixedPoint(text, budget);
  return { variants: decoded.variants, truncated: decoded.truncated };
}

/** 在解码后的所有变体上跑词库；同形字大小写折叠由 `foldHomoglyphs` 在词库侧负责。 */
export function matchLexicon(
  entries: readonly LexiconEntry[],
  decoded: DecodedText,
): LexiconEntry | null {
  for (const variant of decoded.variants) {
    for (const entry of entries) {
      if (entry.pattern.test(variant)) return entry;
    }
  }
  return null;
}

/** 词库条目 tier → 输出置信度。LOW 一律不硬拦（§8.6：语义不确定项不升级为硬拦）。 */
export function confidenceOf(entry: LexiconEntry): 'HIGH' | 'LOW' {
  return entry.tier;
}

export type LexiconMatch = {
  readonly entry: LexiconEntry | null;
  /** 解码触到深度/字节上限。**true 时不得判定为「干净」**（§6.4）。 */
  readonly truncated: boolean;
};

/**
 * 对一段 token / 文案跑词库：先跳过内联数据，再定点解码，再对**每个**变体跑词库。
 *
 * B9/B10/B11/B12/B13 共用这一条路径，好让 §8.3 结尾那句「扫描器必须检查混合编码、
 * HTML entity、Unicode 同形字、字符串拼接与 base64 解码后的二级内容」只有一处实现 ——
 * 各规则各写一套解码必然漏掉某一层，而漏掉的那一层就是可绕过的口子。
 */
export function matchDecoded(
  entries: readonly LexiconEntry[],
  value: string,
  budget: Budget,
): LexiconMatch {
  if (isInlineDataToken(value)) return { entry: null, truncated: false };
  const decoded = decodeText(value, budget);
  return { entry: matchLexicon(entries, decoded), truncated: decoded.truncated };
}

/**
 * 内联数据（base64 图片、blob 引用）不进二级解码。
 * 解码预算是**累计**的（§6.4），对一段 base64 图片做定点解码会白吃预算把安全包变成 resource ERROR；
 * 而 ZLQ-156 §2.4 的 B10 反例「base64 图片」本来就必须放行。
 */
export function isInlineDataToken(value: string): boolean {
  return /^data:/i.test(value) || /^blob:/i.test(value);
}

// ---------------------------------------------------------------------------
// 参数形状
// ---------------------------------------------------------------------------

/**
 * 把一个参数形状里**静态可知**的文本拼出来。
 *
 * 拼接串（`'https://a/' + host`）按已知部分拼接后返回，**但 `partial` 标记为 true** ——
 * §8.3 末句要求检查「字符串拼接」，而拼接出来的串是不完整的：
 * 拿它当完整 URL 去判「包内相对路径」会造出误拦，所以调用方必须区别对待。
 */
export type StaticText = { readonly text: string; readonly partial: boolean };

export function staticTextOf(shape: JsArgShape): StaticText | null {
  switch (shape.shape) {
    case 'string-literal':
      return { text: shape.value, partial: false };
    case 'template-literal':
      // 有插值时 cooked 为 null：模板的静态骨架不可知，不能当成完整文本。
      return shape.cooked === null ? null : { text: shape.cooked, partial: false };
    case 'concat': {
      let text = '';
      let partial = false;
      for (const part of shape.parts) {
        const inner = staticTextOf(part);
        if (inner === null) {
          partial = true;
          continue;
        }
        text += inner.text;
        partial = partial || inner.partial;
      }
      return text.length === 0 && !partial ? null : { text, partial };
    }
    case 'array': {
      const parts = shape.elements
        .map(staticTextOf)
        .filter((item): item is StaticText => item !== null);
      return parts.length === 0
        ? null
        : { text: parts.map((part) => part.text).join(''), partial: true };
    }
    case 'object': {
      const parts = shape.entries.map(
        (entry) => `${entry.key}=${staticTextOf(entry.value)?.text ?? ''}`,
      );
      return { text: parts.join(' '), partial: true };
    }
    case 'identifier':
    case 'member':
    case 'call':
    case 'other':
      return null;
  }
}

/** 参数是否解析到全局（区分 `fetch` 与自己写的局部 `function fetch()`，ZLQ-156 §2.4 B2 反例）。 */
export function isGlobalReference(shape: JsArgShape): boolean {
  if (shape.shape === 'identifier') return shape.resolvesToGlobal;
  if (shape.shape === 'member') return shape.rootIsGlobal;
  return false;
}

// ---------------------------------------------------------------------------
// 代码 token（B9 / B11 的输入集）
// ---------------------------------------------------------------------------

export type CodeTokenOrigin =
  | 'js-identifier'
  | 'js-call'
  | 'js-member'
  | 'js-assignment'
  | 'js-string'
  | 'js-import'
  | 'js-event-handler'
  | 'css-value'
  | 'html-reference';

export type CodeToken = {
  readonly value: string;
  readonly origin: CodeTokenOrigin;
  readonly location: SourceRange | null;
  readonly detail: string;
};

/**
 * 抽取一个文件里所有「代码性质」的字符串。
 *
 * **不含** HTML 展示属性（alt/title/placeholder…）与文本节点 —— 那些是文案，
 * 归 `copyChunksOf`。把 `alt="OpenAI 风格的头像"` 当代码 token 会直接造出 §2.4
 * B11 反例「已固化的 AI 风格头像」的误拦。
 */
export function codeTokensOf(file: RuleFileContext): readonly CodeToken[] {
  const tokens: CodeToken[] = [];
  const push = (
    value: string,
    origin: CodeTokenOrigin,
    location: SourceRange | null,
    detail: string,
  ) => {
    if (value.length === 0) return;
    // 超长串（base64 图片、词典）不进 token 集：既不是标识符也不是域名，
    // 而二级解码预算是累计的，让合法长串撑爆预算会把安全包变成 resource ERROR。
    if (value.length > 4096) return;
    tokens.push({ value, origin, location, detail });
  };

  for (const js of jsSummariesOf(file.summary)) {
    for (const name of js.globals) push(name, 'js-identifier', null, 'free identifier');
    for (const call of js.calls) {
      if (call.calleePath !== null) push(call.calleePath, 'js-call', call.location, 'callee');
      for (const argument of call.args) {
        const text = staticTextOf(argument);
        if (text !== null) push(text.text, 'js-string', call.location, 'call argument');
      }
    }
    for (const assignment of js.assignments) {
      if (assignment.targetPath !== null) {
        push(assignment.targetPath, 'js-assignment', assignment.location, 'assignment target');
      }
      const text = staticTextOf(assignment.value);
      if (text !== null) push(text.text, 'js-string', assignment.location, 'assigned string');
    }
    for (const read of js.memberReads) push(read.path, 'js-member', read.location, 'member read');
    for (const literal of js.stringLiterals)
      push(literal.value, 'js-string', literal.location, 'string literal');
    for (const imported of js.importSources)
      push(imported.source, 'js-import', imported.location, 'import source');
  }

  for (const css of cssSummariesOf(file.summary)) {
    for (const declaration of css.declarations) {
      push(declaration.value, 'css-value', declaration.location, `${declaration.property}: …`);
    }
  }

  const html = htmlSummaryOf(file.summary);
  if (html !== null) {
    for (const reference of html.references)
      push(reference.raw, 'html-reference', reference.location, reference.kind);
    for (const handler of html.eventHandlerAttributes) {
      push(handler.name, 'js-event-handler', handler.location, 'inline event handler attribute');
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// 展示文案（B8 / B12 / B13 的输入集）
// ---------------------------------------------------------------------------

/** §8.3 B12「文本/ARIA/canvas 文案抽取」里的 ARIA 与替代文本部分。 */
export const COPY_ATTRIBUTES = [
  'alt',
  'title',
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-roledescription',
] as const;

export type CopyOrigin = 'html-text' | 'html-attribute' | 'js-string' | 'file-text' | 'manifest';

export type CopyChunk = {
  readonly text: string;
  readonly origin: CopyOrigin;
  /** 文件内文案是行列；manifest 字段是 JSON Pointer（§6.5：metadata 定位不能用行列）。 */
  readonly location: FindingLocation;
  /** 展示给成人的定位说明；**不含**原文（§6.2 脱敏）。 */
  readonly detail: string;
};

/**
 * 抽取一个文件里所有「展示给学生看」的文案。
 *
 * `<script>` / `<style>` 子树里的文本不算文案（`insideScriptOrStyle`），
 * 但 JS 字符串算 —— canvas 文案（`fillText('云存档')`）只存在于字符串里，
 * 漏掉它 B12 就形同虚设。
 */
export function copyChunksOf(file: RuleFileContext): readonly CopyChunk[] {
  const chunks: CopyChunk[] = [];

  const summary = file.summary;
  if (summary.kind === 'html') {
    for (const text of summary.texts) {
      if (text.insideScriptOrStyle) continue;
      const collapsed = collapseWhitespace(text.text);
      if (collapsed.length === 0) continue;
      chunks.push({
        text: collapsed,
        origin: 'html-text',
        location: text.location,
        detail: 'html text node',
      });
    }
    for (const element of summary.elements) {
      for (const attribute of element.attributes) {
        if (!(COPY_ATTRIBUTES as readonly string[]).includes(attribute.name)) continue;
        const value = collapseWhitespace(attribute.value);
        if (value.length === 0) continue;
        chunks.push({
          text: value,
          origin: 'html-attribute',
          location: element.location,
          detail: `<${element.tagName} ${attribute.name}>`,
        });
      }
    }
  }

  for (const js of jsSummariesOf(summary)) {
    for (const literal of js.stringLiterals) {
      const value = collapseWhitespace(literal.value);
      if (value.length === 0 || value.length > 2048) continue;
      chunks.push({
        text: value,
        origin: 'js-string',
        location: literal.location,
        detail: 'js string literal',
      });
    }
  }

  if (summary.kind === 'json' || summary.kind === 'text') {
    const body = summary.text;
    if (body !== null) {
      chunks.push({
        text: collapseWhitespace(body).slice(0, 8192),
        origin: 'file-text',
        location: summary.textLocation,
        detail: `${summary.kind} file body`,
      });
    }
  }

  return chunks;
}

/**
 * manifest 里的展示字段。定位用 **JSON Pointer**，不用行列 ——
 * §6.5 明确 metadata 定位不能用行列（插入可信 `publicationId`/`publishedAt` 会让行号漂移）。
 */
export function manifestCopyChunks(metadata: ValidatedWorkMetadata): readonly CopyChunk[] {
  const fields: readonly [string, string | null][] = [
    ['/title', metadata.title],
    ['/description', metadata.description],
    ['/authorNickname', metadata.authorNickname],
    ['/cover/alt', metadata.cover.alt],
  ];
  const chunks: CopyChunk[] = [];
  for (const [pointer, value] of fields) {
    const text = collapseWhitespace(value ?? '');
    if (text.length === 0) continue;
    chunks.push({
      text,
      origin: 'manifest',
      location: { jsonPointer: pointer },
      detail: 'work.json field',
    });
  }
  for (let index = 0; index < metadata.assets.length; index += 1) {
    const asset = metadata.assets[index];
    if (asset === undefined) continue;
    for (const [field, value] of [
      ['sourceName', asset.sourceName],
      ['creator', asset.creator],
      ['attribution', asset.attribution],
    ] as readonly [string, string][]) {
      const text = collapseWhitespace(value);
      if (text.length === 0) continue;
      chunks.push({
        text,
        origin: 'manifest',
        location: { jsonPointer: `/assets/${index}/${field}` },
        detail: 'work.json asset field',
      });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 句子切分与否证窗口
// ---------------------------------------------------------------------------

export type Sentence = {
  readonly text: string;
  /** 相对所属文本起点的偏移，用于把命中映射回原文件行列。 */
  readonly start: number;
};

/**
 * 按 §8.6 的语义边界切句。`SENTENCE_BOUNDARY_PATTERN` **没有 `g` 标志**，
 * 所以这里手工扫描而不是 `split` —— 带 `g` 的正则有 `lastIndex` 状态，
 * 跨文件复用会让同一个词库在不同包上给出不同结果（确定性被破坏）。
 */
export function sentencesOf(text: string): readonly Sentence[] {
  const result: Sentence[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (SENTENCE_BOUNDARY_PATTERN.test(char)) {
      const piece = text.slice(start, index);
      if (collapseWhitespace(piece).length > 0) result.push({ text: piece, start });
      start = index + 1;
    }
  }
  const tail = text.slice(start);
  if (collapseWhitespace(tail).length > 0) result.push({ text: tail, start });
  return result;
}

/**
 * 这句话是否自我否证（「不支持云同步」「这是模拟排行榜」）。
 *
 * **窗口只有一句话**：跨句否证会让「本作不支持联网。云存档功能完善。」被错误放行。
 */
export function isNegated(sentence: string): boolean {
  return CLAIM_NEGATION_CUES.some((cue) => cue.test(sentence));
}

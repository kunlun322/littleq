/**
 * HTML 解析（ZLQ-153 §8.3「扫描基于 HTML AST、CSS AST、JavaScript AST 与资源图」里的 HTML AST 一环）。
 *
 * 四条设计约束：
 * 1. **内联 `<script>` 的正文再走一遍 JS 分析**（§8.4「扫描器拒绝 HTML 事件处理属性和动态脚本拼接」，
 *    以及 §8.3 B10）。`js.ts` 接收 `offsetBase`，位置仍回映到 HTML 原文（§6.2）。
 * 2. **哪些 parse 错误算 ERROR**：parse5 完整实现 WHATWG 的错误恢复算法，缺 `</p>`、多余斜杠这类
 *    「parse error」在浏览器里照样渲染，把它们当 ERROR 会把大量合法作品挡在门外（§8.6 的误拦率 ≤2%）。
 *    只有「字节流根本不是文本」的四类（NUL / 控制字符 / 代理项 / 非字符）按 §6.2 报 ERROR。
 * 3. **`subtreeText` 不含 `<script>`/`<style>` 子树**：B12/B13 要匹配的是**作品文案**，脚本正文由 JS
 *    字符串字面量那条路径单独覆盖。两条路径都覆盖，才既不漏 canvas 里画的字，也不把 CSS 选择器当文案。
 * 4. **属性名由 parse5 统一小写**，所以 `onClick` 与 `ONCLICK` 一样被 `^on[a-z]+$` 召回。
 * 5. **数据脚本不是代码**：`<script type="application/json">` 这类正文按文案走，不塞给 acorn —— 否则会
 *    凭空造出一批「语法损坏」的 ERROR，把 §8.6 的误拦率直接顶穿。详见 `JS_SCRIPT_TYPES`。
 */

import { parse, type DefaultTreeAdapterTypes, type ParserError } from 'parse5';

import type { Budget } from '../budget.js';
import {
  ALWAYS_RESOURCE_ATTRIBUTES,
  HTML_EVENT_HANDLER_ATTRIBUTE_PATTERN,
  HTML_RESOURCE_ATTRIBUTES,
} from '../lexicon.js';
import { LineIndex } from '../location.js';
import { parseSrcset } from '../urlref.js';
import { analyzeCss } from './css.js';
import { analyzeJavaScript } from './js.js';
import type {
  CssParseSummary,
  HtmlAttribute,
  HtmlElementSummary,
  HtmlEventHandlerAttribute,
  HtmlParseSummary,
  HtmlTextChunk,
  JsParseSummary,
  ResourceReference,
} from './model.js';
import type { SourceRange } from '../types.js';

/** 只有这四类说明输入根本不是可解析文本（§6.2「不支持编码是 ERROR」）。其余 parse error 浏览器都能恢复。 */
const FATAL_PARSE_ERRORS: ReadonlySet<string> = new Set([
  'unexpected-null-character',
  'control-character-in-input-stream',
  'surrogate-in-input-stream',
  'noncharacter-in-input-stream',
]);

/** 这两类元素的正文不是作品文案。 */
const NON_COPY_TAGS: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * 会被浏览器当 JS 执行的 `type` 取值。**没有 `type` 也算 JS**（HTML 的默认）。
 *
 * 为什么必须区分：`<script type="application/json">`（关卡数据）、`type="text/template">`（模板）
 * 的正文不是代码，硬塞给 acorn 只会得到一条语法错误；而 §6.2 明确「语法损坏是 ERROR，不能伪造 B10
 * 来解释一切」，§8.6 又把误拦率压在 ≤2% —— 把数据脚本误判成语法损坏，等于凭空造出一批永远发不出去的作品。
 * 所以数据脚本的正文按**文案**走（进 `texts`，由 B12/B13 判定），不进 JS 分析。
 */
const JS_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

/** 同理，`<style type="text/x-foo">` 不会被当 CSS 应用。 */
const CSS_STYLE_TYPES: ReadonlySet<string> = new Set(['text/css']);

/** `content` 只在 `<meta>` / `<track>` 上承载引用，`value` 只在 `<param>` 上。 */
const CONDITIONAL_RESOURCE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  content: ['meta'],
  value: ['param'],
};

/** `<meta http-equiv="refresh" content="5;url=next.html">` 的 URL 部分。 */
const META_REFRESH_PATTERN = /^\s*\d+\s*;\s*url\s*=\s*(.*)$/i;

function metaRefreshUrl(value: string): string | null {
  const match = META_REFRESH_PATTERN.exec(value);
  if (match === null) return null;
  const url = (match[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
  return url.length === 0 ? null : url;
}

function httpEquivOf(attributes: readonly { name: string; value: string }[]): string | null {
  for (const attribute of attributes) {
    if (attribute.name.toLowerCase() === 'http-equiv') return attribute.value.trim().toLowerCase();
  }
  return null;
}

const ALWAYS_ATTRIBUTES: ReadonlySet<string> = new Set(ALWAYS_RESOURCE_ATTRIBUTES);
const CANDIDATE_ATTRIBUTES: ReadonlySet<string> = new Set(HTML_RESOURCE_ATTRIBUTES);

type ElementNode = DefaultTreeAdapterTypes.Element;
type TemplateNode = DefaultTreeAdapterTypes.Template;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type LocationLike = { startOffset?: number; endOffset?: number } | null | undefined;

export type HtmlAnalyzeInput = {
  path: string;
  source: string;
  budget: Budget;
};

function isElement(node: ChildNode | ParentNode): node is ElementNode {
  return (
    node.nodeName !== '#text' &&
    node.nodeName !== '#comment' &&
    node.nodeName !== '#document' &&
    node.nodeName !== '#document-fragment' &&
    node.nodeName !== '#documentType'
  );
}

/** `<template>` 的内容挂在 `content` fragment 上，不在 `childNodes` 里；不进去就会漏掉整个模板子树。 */
function templateContent(element: ElementNode): ParentNode | null {
  const candidate = element as TemplateNode;
  return candidate.nodeName === 'template' ? candidate.content : null;
}

function directTextOf(element: ElementNode): string {
  let text = '';
  for (const child of element.childNodes) {
    if (child.nodeName === '#text') text += (child as TextNode).value;
  }
  return text;
}

/** 元素自己声明的 `type` 是否在允许集里（缺失 = 用 HTML 默认，算允许）。 */
function typeIsAllowed(
  attributes: readonly HtmlAttribute[],
  allowed: ReadonlySet<string>,
): boolean {
  const declared = attributes.find((attribute) => attribute.name === 'type');
  if (!declared) return true;
  return allowed.has(declared.value.trim().toLowerCase());
}

export function analyzeHtml(input: HtmlAnalyzeInput): HtmlParseSummary {
  const lines = new LineIndex(input.source);
  const at = (location: LocationLike): SourceRange | null => {
    if (!location) return null;
    const { startOffset, endOffset } = location;
    if (typeof startOffset !== 'number') return null;
    return lines.range(startOffset, typeof endOffset === 'number' ? endOffset : startOffset);
  };

  const fatalErrors: string[] = [];
  const document = parse(input.source, {
    sourceCodeLocationInfo: true,
    onParseError: (error: ParserError) => {
      if (FATAL_PARSE_ERRORS.has(error.code)) fatalErrors.push(error.code);
    },
  });

  if (fatalErrors.length > 0) {
    return {
      kind: 'html',
      path: input.path,
      elements: [],
      texts: [],
      inlineScripts: [],
      inlineStyles: [],
      inlineScriptSummaries: [],
      inlineStyleSummaries: [],
      eventHandlerAttributes: [],
      references: [],
      parseError: fatalErrors[0] ?? 'parse-error',
    };
  }

  const elements: HtmlElementSummary[] = [];
  const texts: HtmlTextChunk[] = [];
  const inlineScripts: HtmlParseSummary['inlineScripts'] = [];
  const inlineStyles: HtmlParseSummary['inlineStyles'] = [];
  const inlineScriptSummaries: JsParseSummary[] = [];
  const inlineStyleSummaries: CssParseSummary[] = [];
  const eventHandlerAttributes: HtmlEventHandlerAttribute[] = [];
  const references: ResourceReference[] = [];

  const recordReference = (
    raw: string,
    kind: 'html-attribute' | 'html-srcset',
    detail: string,
    location: SourceRange | null,
  ): void => {
    references.push({ fromPath: input.path, kind, raw, location, detail });
  };

  /**
   * 深度优先遍历。`handleElement` 先 push 摘要再递归，递归返回后 `texts` 里正好是这个元素子树的全部文本
   * ⇒ 用「递归前的长度」切片就能拿到 `subtreeText`，不需要第二趟遍历，也不需要节点→下标的映射表。
   */
  const visit = (
    node: ParentNode,
    parentTag: string | null,
    insideScriptOrStyle: boolean,
  ): void => {
    for (const child of node.childNodes) {
      input.budget.spend('nodes', 1);
      if (child.nodeName === '#text') {
        const textNode = child as TextNode;
        texts.push({
          text: textNode.value,
          location: at(textNode.sourceCodeLocation),
          insideScriptOrStyle,
        });
        continue;
      }
      if (isElement(child)) handleElement(child, parentTag, insideScriptOrStyle);
    }
  };

  const handleElement = (
    element: ElementNode,
    parentTag: string | null,
    insideScriptOrStyle: boolean,
  ): void => {
    const tag = element.tagName.toLowerCase();
    const location = at(element.sourceCodeLocation);
    const attributes: HtmlAttribute[] = [];
    const attributeLocations = element.sourceCodeLocation?.attrs ?? {};

    for (const attribute of element.attrs) {
      input.budget.spend('tokens', 1);
      const name = attribute.name.toLowerCase();
      const attributeLocation = at(attributeLocations[name]);
      attributes.push({ name, value: attribute.value, location: attributeLocation });

      if (HTML_EVENT_HANDLER_ATTRIBUTE_PATTERN.test(name)) {
        // §8.4「扫描器拒绝 HTML 事件处理属性」：记下来由 B10 判定。冻结 CSP 是
        // `script-src 'self' 'sha256-…'`，内联处理器执行不了，但它的存在说明作品想执行脚本。
        eventHandlerAttributes.push({
          tagName: tag,
          name,
          value: attribute.value,
          location: attributeLocation,
        });
      }

      if (!CANDIDATE_ATTRIBUTES.has(name)) continue;
      const conditional = CONDITIONAL_RESOURCE_ATTRIBUTES[name];
      if (conditional ? !conditional.includes(tag) : !ALWAYS_ATTRIBUTES.has(name)) continue;

      if (name === 'srcset') {
        for (const candidate of parseSrcset(attribute.value)) {
          recordReference(candidate, 'html-srcset', `${tag}@srcset`, attributeLocation);
        }
        continue;
      }

      if (name === 'content') {
        // `<meta content>` 只有 http-equiv=refresh 时才承载 URL；CSP / description / keywords
        // 的 content 是纯文本。一律当资源引用会把
        // `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`
        // 判成「指向一个不存在的包内文件」而硬拦 —— 一个**加强**安全的写法反而被拦，
        // 正是 ZLQ-153 §8.6 的 ≤2% 误拦率要防的形状。
        if (tag !== 'meta' || httpEquivOf(element.attrs) !== 'refresh') continue;
        const url = metaRefreshUrl(attribute.value);
        if (url !== null)
          recordReference(url, 'html-attribute', 'meta@content-refresh', attributeLocation);
        continue;
      }

      recordReference(attribute.value, 'html-attribute', `${tag}@${name}`, attributeLocation);
    }

    const rawBody = directTextOf(element);
    const firstText = element.childNodes.find((child) => child.nodeName === '#text') as
      | TextNode
      | undefined;
    /**
     * 正文首字符在 HTML 原文里的偏移。parse5 在 `sourceCodeLocationInfo: true` 下总给 raw text 内容
     * 一个精确位置（`<script>`/`<style>` 都实测过）；万一拿不到就是 `-1` = 「没有可靠范围」，
     * 由 `js.ts`/`css.ts` 统一产出 `location = null`（§6.2），绝不拿元素起点硬凑一个指进标签里的行列。
     */
    const bodyOffset = firstText?.sourceCodeLocation?.startOffset;
    const offsetBase = typeof bodyOffset === 'number' ? bodyOffset : -1;

    // 只有真会被执行的 `<script>` 才进 JS 分析；数据脚本的正文按**文案**走（见 `JS_SCRIPT_TYPES` 的注释）。
    const scriptIsCode = tag === 'script' && typeIsAllowed(attributes, JS_SCRIPT_TYPES);
    const styleIsCode = tag === 'style' && typeIsAllowed(attributes, CSS_STYLE_TYPES);
    const isModule = attributes.some(
      (attribute) => attribute.name === 'type' && attribute.value.trim().toLowerCase() === 'module',
    );

    if (scriptIsCode && rawBody !== '') {
      inlineScripts.push({
        text: rawBody,
        location: firstText ? at(firstText.sourceCodeLocation) : location,
        offsetBase,
        attributes,
      });
      inlineScriptSummaries.push(
        analyzeJavaScript({
          path: input.path,
          source: rawBody,
          budget: input.budget,
          offsetBase,
          lines,
          // `<script type="module">` 必须按 module 解析，否则顶层 `import` 直接变语法错误。
          sourceType: isModule ? 'module' : undefined,
        }),
      );
    } else if (styleIsCode && rawBody !== '') {
      inlineStyles.push({
        text: rawBody,
        location: firstText ? at(firstText.sourceCodeLocation) : location,
        offsetBase,
        selector: '',
      });
      inlineStyleSummaries.push(
        analyzeCss({ path: input.path, source: rawBody, budget: input.budget, offsetBase, lines }),
      );
    }

    const styleAttribute = attributes.find((attribute) => attribute.name === 'style');
    if (styleAttribute && styleAttribute.value !== '') {
      // `style=""` 属性：parse5 只给「属性整体」的位置（含属性名与引号），给不出属性值的起点。
      // 硬算会把行列指到引号里去 ⇒ `offsetBase = -1`，定位由规则落回这个元素（§6.2「定位回原始封装节点」）。
      inlineStyles.push({
        text: styleAttribute.value,
        location: styleAttribute.location,
        offsetBase: -1,
        selector: tag,
      });
      inlineStyleSummaries.push(
        analyzeCss({
          path: input.path,
          source: styleAttribute.value,
          budget: input.budget,
          offsetBase: -1,
          lines,
        }),
      );
    }

    const childInsideScriptOrStyle =
      insideScriptOrStyle || (NON_COPY_TAGS.has(tag) && (scriptIsCode || styleIsCode));
    const summary: HtmlElementSummary = {
      tagName: tag,
      location,
      attributes,
      // `<script>`/`<style>` 的正文不是作品文案，走各自的 AST 路径；留在这里只会被 B12/B13 重复匹配。
      ownText: NON_COPY_TAGS.has(tag) ? '' : rawBody,
      ownTextLocation: location,
      subtreeText: '',
      ordinal: elements.length,
      parentTagName: parentTag,
    };
    elements.push(summary);

    const textsBefore = texts.length;
    const content = templateContent(element);
    if (content) visit(content, tag, childInsideScriptOrStyle);
    visit(element, tag, childInsideScriptOrStyle);

    if (!childInsideScriptOrStyle) {
      // `textsBefore` 取在 `visit` 之前，所以这一段切片**已经包含**本元素自己的直接文本节点，
      // 不能再把 `rawBody` 加一遍。
      let subtree = '';
      for (let index = textsBefore; index < texts.length; index += 1) {
        const chunk = texts[index];
        if (chunk && !chunk.insideScriptOrStyle) subtree += chunk.text;
      }
      summary.subtreeText = subtree;
    } else {
      summary.subtreeText = '';
    }
  };

  visit(document, null, false);

  return {
    kind: 'html',
    path: input.path,
    elements,
    texts,
    inlineScripts,
    inlineStyles,
    inlineScriptSummaries,
    inlineStyleSummaries,
    eventHandlerAttributes,
    references,
    parseError: null,
  };
}

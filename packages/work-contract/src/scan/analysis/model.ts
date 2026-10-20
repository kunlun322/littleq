/**
 * 解析摘要模型（ZLQ-156 §6.3 的 `parseSummaryRefs` 指向的就是这些对象的规范化 hash）。
 *
 * 三条设计约束：
 * 1. **摘要不含可公开源码**（§6.3「语法/数据流摘要不含可公开源码」）—— 所以字符串字面量的原文只留在
 *    进程内的 `stringLiterals` 里供规则判定，写进 checkpoint 的只有它的 hash。
 * 2. **每个位置都可能是 null** —— §6.2「二次解码没有可靠范围时 location=null」。
 * 3. **每个标识符引用都带「是否解析到全局」** —— 这是 §2.4 那批安全反例（局部 `fetch`、`node.parent`、
 *    叫 `location` 的变量、`Top` 类、烘焙游戏的 `cookie` 变量）能全部放行的唯一原因。
 *    没有作用域解析，规则就只剩关键词匹配，那是 §11 明文不算交付的东西。
 */

import type { SourceRange } from '../types.js';

export type ParseKind = 'html' | 'css' | 'js' | 'json' | 'text' | 'binary';

// ---------------------------------------------------------------------------
// 资源引用（B1 的输入）
// ---------------------------------------------------------------------------

export type ReferenceKind =
  | 'html-attribute'
  | 'html-srcset'
  | 'css-url'
  | 'css-import'
  | 'js-import'
  | 'js-dynamic-import'
  | 'js-string-url';

export type ResourceReference = {
  fromPath: string;
  kind: ReferenceKind;
  /** 原始字面量（未解码）。 */
  raw: string;
  location: SourceRange | null;
  /** 属性名 / at-rule 名 / 调用名，供规则区分子类型。 */
  detail: string;
};

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

export type JsArgShape =
  | { shape: 'string-literal'; value: string }
  | {
      shape: 'template-literal';
      /** 无插值时为静态文本，有插值时为 null。 */ cooked: string | null;
    }
  | { shape: 'identifier'; name: string; resolvesToGlobal: boolean }
  | { shape: 'member'; path: string; rootIsGlobal: boolean }
  | { shape: 'call'; calleePath: string | null }
  | { shape: 'array'; elements: JsArgShape[] }
  | { shape: 'object'; entries: { key: string; value: JsArgShape }[] }
  | { shape: 'concat'; parts: JsArgShape[] }
  | { shape: 'other' };

export type JsCallSite = {
  /** `fetch` / `URL.createObjectURL` / `navigator.clipboard.readText`。解析不出路径时为 null。 */
  calleePath: string | null;
  /** 被调名字是否解析到全局（false = 被局部声明遮蔽，例如自己写的 `function fetch()`）。 */
  calleeIsGlobal: boolean;
  isConstructor: boolean;
  isDynamicImport: boolean;
  args: JsArgShape[];
  location: SourceRange | null;
};

export type JsAssignment = {
  /** `a.href` / `location.hash` / `audio.src`。 */
  targetPath: string | null;
  /** 赋值目标的最左标识符是否解析到全局。 */
  targetRootIsGlobal: boolean;
  /** 目标是否是一个新声明的变量（`const url = URL.createObjectURL(...)`）。 */
  declaresBinding: string | null;
  value: JsArgShape;
  /** 右侧若是标识符，它解析到全局吗（数据流跟踪用）。 */
  valueIdentifierGlobal: boolean | null;
  location: SourceRange | null;
};

export type JsMemberRead = {
  path: string;
  rootIsGlobal: boolean;
  location: SourceRange | null;
};

export type JsBindingKind = 'var' | 'let' | 'const' | 'param' | 'function' | 'class' | 'import';

export type JsBindingSite = {
  name: string;
  kind: JsBindingKind;
  scopeId: number;
  initializer: JsArgShape | null;
  location: SourceRange | null;
};

export type ReadabilityAssessment = {
  /** 去掉注释与字符串字面量后的代码文本。 */
  codeOnlyBytes: number;
  lineCount: number;
  maxLineLength: number;
  averageCodeLineLength: number;
  identifierCount: number;
  unreadableIdentifierCount: number;
  unreadableIdentifierRatio: number;
  /** 去注释/字符串后每个字节的 Shannon 熵（bits）。 */
  entropyBitsPerByte: number;
  /** 综合判定：这份源码对人类儿童/老师是否可读。 */
  unreadable: boolean;
  /** 判定依据（可解释性要求，§8.3 B13「规则 ID 可解释」同样适用于 B10）。 */
  reasons: string[];
};

export type JsParseSummary = {
  kind: 'js';
  path: string;
  calls: JsCallSite[];
  assignments: JsAssignment[];
  memberReads: JsMemberRead[];
  /** 解析为全局的自由标识符（去重、排序）。 */
  globals: string[];
  /**
   * `globals` 的带位置版本（每个名字取**首次出现**处，按名字+行列排序）。
   * §6.2 要求「每条命中给文件、行列、规则 ID」，而 B6/B7 要按自由全局标识符判定
   * （`top !== self` 这种没有成员访问的写法只有名字），只有 `globals` 就只能给 `location: null`。
   */
  globalReferences: { name: string; location: SourceRange | null }[];
  stringLiterals: { value: string; location: SourceRange | null }[];
  importSources: { source: string; isDynamic: boolean; location: SourceRange | null }[];
  bindings: JsBindingSite[];
  references: ResourceReference[];
  readability: ReadabilityAssessment;
  /** 语法损坏是 ERROR，不是 B10（§6.2「不得伪造 B10 来解释一切」）。 */
  parseError: string | null;
};

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export type HtmlAttribute = {
  name: string;
  value: string;
  location: SourceRange | null;
};

export type HtmlElementSummary = {
  tagName: string;
  location: SourceRange | null;
  attributes: HtmlAttribute[];
  /** 直接文本内容（不含子元素文本），B8 的 `<label>` 判定要用。 */
  ownText: string;
  ownTextLocation: SourceRange | null;
  /** 子树全部文本（B12 文案抽取、B13 内容）。 */
  subtreeText: string;
  /** 在文档中的序号，用于稳定定位与 `file-<ordinal>` 占位。 */
  ordinal: number;
  parentTagName: string | null;
};

export type HtmlTextChunk = {
  text: string;
  location: SourceRange | null;
  insideScriptOrStyle: boolean;
};

export type HtmlEventHandlerAttribute = {
  tagName: string;
  name: string;
  value: string;
  location: SourceRange | null;
};

export type HtmlParseSummary = {
  kind: 'html';
  path: string;
  elements: HtmlElementSummary[];
  texts: HtmlTextChunk[];
  /** 内联 `<script>`：内容再走一遍 JS 分析（§8.4「扫描器拒绝……动态脚本拼接」）。 */
  inlineScripts: {
    text: string;
    location: SourceRange | null;
    /** 脚本正文首字符在 **HTML 原文**里的偏移；JS 分析的位置要加上它才能回映到 HTML 行列（§6.2）。 */
    offsetBase: number;
    attributes: HtmlAttribute[];
  }[];
  inlineStyles: {
    text: string;
    location: SourceRange | null;
    offsetBase: number;
    selector: string;
  }[];
  /**
   * 内联 `<script>` 正文的 JS 分析结果，与 `inlineScripts` 同序；位置已回映到 HTML 原文。
   * 语法损坏时仍是一条 `JsParseSummary`（其 `parseError` 非空），不是 `null` —— §6.2「语法损坏是 ERROR，
   * 不得伪造 B10 来解释一切」要求把损坏如实带出来，而不是当成「没有内容」。
   */
  inlineScriptSummaries: JsParseSummary[];
  /** 内联 `<style>` 与 `style=""` 属性的 CSS 分析结果，与 `inlineStyles` 同序。 */
  inlineStyleSummaries: CssParseSummary[];
  eventHandlerAttributes: HtmlEventHandlerAttribute[];
  references: ResourceReference[];
  parseError: string | null;
};

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

export type CssDeclaration = {
  selector: string;
  property: string;
  value: string;
  location: SourceRange | null;
};

export type CssParseSummary = {
  kind: 'css';
  path: string;
  references: ResourceReference[];
  declarations: CssDeclaration[];
  readability: ReadabilityAssessment;
  parseError: string | null;
};

// ---------------------------------------------------------------------------
// 其余形态
// ---------------------------------------------------------------------------

export type OpaqueParseSummary = {
  kind: 'json' | 'text' | 'binary';
  path: string;
  /** JSON / 纯文本的内容（供 B12/B13 的文案抽取）；二进制为 null。 */
  text: string | null;
  textLocation: SourceRange | null;
  /**
   * 仅对图片：EXIF 里是否存在 GPS IFD（B13「图片 hash/元数据」的元数据一路）。
   * 非图片、或图片里没有 EXIF、或 EXIF 结构读不通 ⇒ null（「没有证据」而不是「证据为否」）。
   */
  exifGps: boolean | null;
  parseError: string | null;
};

export type ParseSummary = JsParseSummary | HtmlParseSummary | CssParseSummary | OpaqueParseSummary;

export function referencesOf(summary: ParseSummary): readonly ResourceReference[] {
  switch (summary.kind) {
    case 'js':
    case 'html':
    case 'css':
      return summary.references;
    default:
      return [];
  }
}

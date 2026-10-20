/**
 * CSS 解析（ZLQ-153 §8.3「扫描基于 HTML AST、CSS AST、JavaScript AST 与资源图」里的 CSS AST 一环）。
 *
 * 三条设计约束：
 * 1. **资源引用只在这里召回，判定在 `graph.ts`。** §8.6「优先 AST/数据流与规范化，正则只用于候选召回」——
 *    `url(...)` 的词法切分是召回，「这个路径在包里存不存在、有没有越界」才是判定。
 * 2. **`@import` 与 `url()` 分开记 kind**（`css-import` / `css-url`），因为 §8.3 B1 明文把两者并列，
 *    而 `@import` 还能引入**新的样式表**（跨文件边），资源图要按边处理，`url()` 只是叶子资源。
 * 3. **注释区间要摘掉再算可读性**，理由与 `js.ts` 相同：§2.4 的「许可注释」反例在 CSS 里同样成立
 *    （一份带 MIT 头的样式表不该被判成混淆）。
 *
 * 位置：postcss 给的是**原始文本**上的行列，直接用 `LineIndex.offsetAt` 反算偏移，
 * 再统一走 `range()` 输出，保证 §6.2「按原始可读文件位置回映」。
 */

import postcss from 'postcss';

import type { Budget } from '../budget.js';
import { CSS_IMPORT_AT_RULES } from '../lexicon.js';
import { LineIndex } from '../location.js';
import { assessReadability, type ExcludedRange } from '../readability.js';
import type { CssDeclaration, CssParseSummary, ResourceReference } from './model.js';
import type { SourceRange } from '../types.js';

/** `url("…")` / `url('…')` / `url(…)` 的词法切分。只用于召回。 */
const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/gi;
/** `@import "x.css"` / `@import url(x.css)` 的裸字符串形态。 */
const BARE_STRING_TOKEN = /^\s*(?:"([^"]*)"|'([^']*)')/;
/** 选择器里的 class/id 原子（CSS 里唯一由作者命名的标识符）。 */
const SELECTOR_ATOM = /[.#](-?[_a-zA-Z\u00a0-\uffff][-\w\u00a0-\uffff]*)/g;
/** 自定义属性与标准属性名。 */
const PROPERTY_ATOM = /^-{0,2}[a-zA-Z][-a-zA-Z0-9]*$/;

const IMPORT_AT_RULES: ReadonlySet<string> = new Set(CSS_IMPORT_AT_RULES);

export type CssAnalyzeInput = {
  path: string;
  source: string;
  budget: Budget;
  /**
   * CSS 文本首字符在**宿主文件**里的偏移。独立 `.css` 文件是 0；`<style>` 元素是它在 HTML 里的偏移；
   * `style=""` 属性传 `-1` 表示「没有可靠范围」——parse5 只给属性整体的位置，不给属性值起点，
   * 硬算会把行列指到引号里去骗人。按 §6.2 这时 `location = null`，由规则把定位落到原始封装节点上。
   */
  offsetBase?: number;
  /** 宿主文件的行索引；给了 `offsetBase >= 0` 就必须一起给，否则偏移无处可映。 */
  lines?: LineIndex;
};

/** postcss 的 `Position` 在按字符串解析时带 `offset`；不带时用行列反算，绝不猜。 */
function offsetOf(
  lines: LineIndex,
  position: { line: number; column: number; offset?: number } | undefined,
): number | null {
  if (!position) return null;
  if (typeof position.offset === 'number') return position.offset;
  if (typeof position.line === 'number' && typeof position.column === 'number') {
    return lines.offsetAt(position.line, position.column);
  }
  return null;
}

function firstString(match: RegExpExecArray | null): string | null {
  if (!match) return null;
  for (let index = 1; index < match.length; index += 1) {
    const group = match[index];
    if (typeof group === 'string' && group.trim() !== '') return group.trim();
  }
  return null;
}

export function analyzeCss(input: CssAnalyzeInput): CssParseSummary {
  /** 相对 CSS 文本自身的行索引：注释区间要用它，因为 `excluded` 索引的是 `input.source`。 */
  const localLines = new LineIndex(input.source);
  const base = input.offsetBase ?? 0;
  /** 宿主文件的行索引：输出的 `location` 一律映射到宿主文件（§6.2「按原始可读文件位置回映」）。 */
  const hostLines = input.lines ?? localLines;
  /** `base < 0` = 没有可靠范围（`style=""` 属性）⇒ 一律 null，不硬算出一个指到引号里的行列。 */
  const locate = (source: {
    start?: { line: number; column: number; offset?: number };
    end?: { line: number; column: number; offset?: number };
  }): SourceRange | null => {
    if (base < 0) return null;
    const start = offsetOf(localLines, source.start);
    if (start === null) return null;
    const end = offsetOf(localLines, source.end);
    return hostLines.range(base + start, base + (end ?? start));
  };
  const empty = (
    parseError: string | null,
    readability: CssParseSummary['readability'],
  ): CssParseSummary => ({
    kind: 'css',
    path: input.path,
    references: [],
    declarations: [],
    readability,
    parseError,
  });

  let root: postcss.Root;
  try {
    root = postcss.parse(input.source, { from: undefined });
  } catch (error) {
    // §6.2：语法损坏是 ERROR，不是 B10。这里只如实带回 postcss 的消息。
    const message = error instanceof Error ? error.message : String(error);
    return empty(
      message,
      assessReadability({ source: input.source, excluded: [], identifiers: [] }),
    );
  }

  const references: ResourceReference[] = [];
  const declarations: CssDeclaration[] = [];
  const excluded: ExcludedRange[] = [];
  const identifiers: string[] = [];

  const recordUrls = (
    text: string,
    kind: 'css-url' | 'css-import',
    detail: string,
    location: SourceRange | null,
  ): void => {
    URL_TOKEN.lastIndex = 0;
    let match = URL_TOKEN.exec(text);
    while (match !== null) {
      input.budget.spend('tokens', 1);
      const raw = firstString(match);
      if (raw !== null && raw !== '') {
        references.push({ fromPath: input.path, kind, raw, location, detail });
      }
      match = URL_TOKEN.exec(text);
    }
  };

  root.walk((node) => {
    input.budget.spend('nodes', 1);
    switch (node.type) {
      case 'comment': {
        // 注释区间索引的是 `input.source`（CSS 文本本身），不是宿主文件 ⇒ 用 `localLines`。
        const start = offsetOf(localLines, node.source?.start);
        const end = offsetOf(localLines, node.source?.end);
        if (start !== null && end !== null && end > start) excluded.push({ start, end });
        return;
      }
      case 'rule': {
        const selector = node.selector ?? '';
        SELECTOR_ATOM.lastIndex = 0;
        let atom = SELECTOR_ATOM.exec(selector);
        while (atom !== null) {
          const name = atom[1];
          if (typeof name === 'string') identifiers.push(name);
          atom = SELECTOR_ATOM.exec(selector);
        }
        return;
      }
      case 'decl': {
        const parent = node.parent;
        const selector =
          parent && parent.type === 'rule'
            ? (parent.selector ?? '')
            : parent && parent.type === 'atrule'
              ? `@${parent.name}`
              : '';
        const location = locate({ start: node.source?.start, end: node.source?.end });
        declarations.push({ selector, property: node.prop, value: node.value, location });
        if (PROPERTY_ATOM.test(node.prop)) identifiers.push(node.prop);
        recordUrls(node.value, 'css-url', node.prop, location);
        const bare = firstString(BARE_STRING_TOKEN.exec(node.value));
        if (bare !== null && node.prop.toLowerCase() === 'src') {
          // `@font-face { src: "x.woff2" }` 不是合法 CSS（src 只接受 url()/local()），
          // 但真实产物里出现过，按资源引用召回，宁可多召回也不漏一个外链。
          references.push({
            fromPath: input.path,
            kind: 'css-url',
            raw: bare,
            location,
            detail: node.prop,
          });
        }
        return;
      }
      case 'atrule': {
        const location = locate({ start: node.source?.start, end: node.source?.end });
        const params = node.params ?? '';
        const isImport = IMPORT_AT_RULES.has(node.name.toLowerCase());
        recordUrls(params, isImport ? 'css-import' : 'css-url', `@${node.name}`, location);
        const bare = firstString(BARE_STRING_TOKEN.exec(params));
        if (bare !== null && isImport) {
          references.push({
            fromPath: input.path,
            kind: 'css-import',
            raw: bare,
            location,
            detail: `@${node.name}`,
          });
        }
        return;
      }
      default:
        return;
    }
  });

  excluded.sort((left, right) => left.start - right.start);

  return {
    kind: 'css',
    path: input.path,
    references,
    declarations,
    readability: assessReadability({ source: input.source, excluded, identifiers }),
    parseError: null,
  };
}

/**
 * JavaScript AST → 解析摘要（ZLQ-153 §8.3「JavaScript AST」、ZLQ-156 §6.3 `parseSummaryRefs`）。
 *
 * **为什么这一层是整条判定链的地基**：§8.3 首句要求「不以单条正则作为最终判定」，
 * 而 ZLQ-156 §2.4 给 B2/B3/B6/B7 的安全反例（名叫 `fetch` 的局部游戏函数、模拟 `XMLHttpRequest`
 * 的教学字符串、叫 `location` 的变量、AST 树节点的 `parent` 字段、烘焙游戏的 `cookie` 变量）
 * 全都只能靠**作用域解析**放行。所以这里记下的每一个调用点/成员读取都带一个
 * 「它的最左标识符是不是自由变量」的布尔值：浏览器里自由变量名就落在 `window` 上，
 * 被局部声明遮蔽的同名标识符则不是。少了这个布尔值，规则层就只剩关键词匹配。
 *
 * **`ecmaVersion` 用 2023 而不是 §8.1 的 ES2019**：扫描器的 fail-closed 方向是「多解析」而不是
 * 「拒绝解析」——一份用了 ES2020 语法的作品如果解析失败，它里面的 `fetch()` 就没人看见了。
 * ES2019 的语法约束属于 §8.2 的构建校验，不是 B 规则，两者不能混用同一个失败动作。
 *
 * **位置映射**：内联 `<script>` 的偏移是相对脚本文本的，必须加上 `offsetBase` 再走**原文件**的
 * `LineIndex`，否则 §6.2「行列映射回原始可读文件」就不成立。
 */

import * as acorn from 'acorn';

import type { Budget } from '../budget.js';
import {
  ALWAYS_RESOURCE_ATTRIBUTES,
  JS_RESOURCE_CALLEES,
  MEDIA_SINK_PROPERTIES,
} from '../lexicon.js';
import { LineIndex } from '../location.js';
import { assessReadability, type ExcludedRange } from '../readability.js';
import type {
  ResourceReference,
  JsArgShape,
  JsAssignment,
  JsBindingSite,
  JsCallSite,
  JsMemberRead,
  JsParseSummary,
  ReadabilityAssessment,
} from './model.js';
import {
  calleePathOf,
  declaredNamesOf,
  isNode,
  memberPathOf,
  stringLiteralValue,
  templateLiteralStaticText,
  walk,
  type JsNode,
} from './jsast.js';
import { ScopeIndex } from './jsscope.js';
import type { SourceRange } from '../types.js';

/** 赋值目标上算「资源入口」的属性名（`el.src = '…'` 与 `<img src="…">` 是同一类风险）。 */
const RESOURCE_SINK_PROPERTIES: ReadonlySet<string> = new Set([
  ...ALWAYS_RESOURCE_ATTRIBUTES,
  ...MEDIA_SINK_PROPERTIES,
]);

const RESOURCE_CALLEE_LAST_SEGMENTS: ReadonlySet<string> = new Set(JS_RESOURCE_CALLEES);

export type JsSourceType = 'module' | 'script';

export type JsParseOutcome = {
  ast: JsNode | null;
  comments: { value: string; start: number; end: number }[];
  sourceType: JsSourceType | null;
  parseError: string | null;
};

/**
 * 先按 module 解析，失败再按 script 解析。
 * 两种都失败才算语法损坏（§6.2：语法损坏是 ERROR，不是 B10）。
 */
export function parseJavaScript(source: string, preferred?: JsSourceType): JsParseOutcome {
  const order: JsSourceType[] = preferred
    ? [preferred, preferred === 'module' ? 'script' : 'module']
    : ['module', 'script'];
  let lastError: unknown = null;
  for (const sourceType of order) {
    const collected: acorn.Comment[] = [];
    try {
      const ast = acorn.parse(source, {
        ecmaVersion: 2023,
        sourceType,
        allowReturnOutsideFunction: sourceType === 'script',
        allowAwaitOutsideFunction: sourceType === 'module',
        allowImportExportEverywhere: true,
        allowHashBang: true,
        locations: false,
        onComment: collected,
      }) as unknown as JsNode;
      const comments = collected.map((comment) => ({
        value: comment.value,
        start: comment.start,
        end: comment.end,
      }));
      return { ast, comments, sourceType, parseError: null };
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return { ast: null, comments: [], sourceType: null, parseError: message };
}

export type JsAnalyzeInput = {
  path: string;
  /** 被解析的那段源码（整份 `.js` 文件，或内联 `<script>` 的内容）。 */
  source: string;
  budget: Budget;
  /** `source` 在原文件里的起始偏移；独立文件为 0。`-1` 表示宿主没有给出可靠起点（§6.2 ⇒ 全部 `location = null`）。 */
  offsetBase?: number;
  /** 原文件的行索引；省略时按 `source` 自身建。 */
  lines?: LineIndex;
  sourceType?: JsSourceType;
};

type NodeLocation = (start: number, end: number) => SourceRange;

/**
 * 判断一个 `Identifier` 是否处在**引用位置**（而不是属性名、声明名、标签、import 别名）。
 * 误把属性名当成引用会让 `a.b` 里的 `b` 落到「自由变量 ⇒ 全局」，`globals` 就被垃圾灌满，
 * B6 的 `parent`/`top`、B7 的 `cookie` 全会误命中 —— 这正是 §2.4 那批反例要防的事。
 */
function isIdentifierReference(parent: JsNode | null, key: string | null): boolean {
  if (!parent || key === null) return true;
  switch (parent.type) {
    case 'MemberExpression':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return !(key === 'property' || key === 'key') || parent.computed === true;
    case 'Property':
      // `{ a: 1 }` 的 `a` 不是引用；`{ a }` 简写与 `{ [a]: 1 }` 计算键才是
      if (key === 'key') return parent.computed === true || parent.shorthand === true;
      return true;
    case 'VariableDeclarator':
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return key !== 'id';
    case 'ArrowFunctionExpression':
      return key !== 'params';
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'LabeledStatement':
      return key !== 'label';
    case 'CatchClause':
      return key !== 'param';
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'MetaProperty':
      return false;
    default:
      return true;
  }
}

function lastSegment(path: string): string {
  const index = path.lastIndexOf('.');
  return index < 0 ? path : path.slice(index + 1);
}

export function analyzeJavaScript(input: JsAnalyzeInput): JsParseSummary {
  const offsetBase = input.offsetBase ?? 0;
  const lines = input.lines ?? new LineIndex(input.source);
  const at: NodeLocation = (start, end) => lines.range(offsetBase + start, offsetBase + end);

  const empty = (
    parseError: string | null,
    readability: ReadabilityAssessment,
  ): JsParseSummary => ({
    kind: 'js',
    path: input.path,
    calls: [],
    assignments: [],
    memberReads: [],
    globals: [],
    globalReferences: [],
    stringLiterals: [],
    importSources: [],
    bindings: [],
    references: [],
    readability,
    parseError,
  });

  const unreadableFallback = assessReadability({
    source: input.source,
    excluded: [],
    identifiers: [],
  });
  const parsed = parseJavaScript(input.source, input.sourceType);
  if (!parsed.ast) return empty(parsed.parseError, unreadableFallback);
  const ast = parsed.ast;

  const scopes = new ScopeIndex(ast);

  const calls: JsCallSite[] = [];
  const assignments: JsAssignment[] = [];
  const memberReads: JsMemberRead[] = [];
  const bindings: JsBindingSite[] = [];
  const references: ResourceReference[] = [];
  const stringLiterals: { value: string; location: SourceRange | null }[] = [];
  const importSources: { source: string; isDynamic: boolean; location: SourceRange | null }[] = [];
  const identifiers: string[] = [];
  const globalNames = new Map<string, SourceRange | null>();
  const excluded: ExcludedRange[] = [];

  for (const comment of parsed.comments) {
    excluded.push({ start: comment.start, end: comment.end });
  }

  const nodeRange = (node: JsNode): SourceRange | null => {
    // `offsetBase < 0` = 宿主没给出可靠起点（例如 `style=""` 那类只有整体位置的封装）
    // ⇒ 按 §6.2 一律 `location = null`，由规则把定位落到原始封装节点上，绝不硬算一个骗人的行列。
    if (offsetBase < 0) return null;
    const start = node.start;
    const end = node.end;
    return typeof start === 'number' && typeof end === 'number' ? at(start, end) : null;
  };
  const nodeOffsets = (node: JsNode): { start: number; end: number } | null => {
    const start = node.start;
    const end = node.end;
    return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
  };

  /** 把一个表达式归约成可判定的形状；判不出来就是 `other`，绝不猜运行时值。 */
  const shapeOf = (node: unknown): JsArgShape => {
    if (!isNode(node)) return { shape: 'other' };
    switch (node.type) {
      case 'Literal': {
        const value = stringLiteralValue(node);
        return value === null ? { shape: 'other' } : { shape: 'string-literal', value };
      }
      case 'TemplateLiteral':
        return { shape: 'template-literal', cooked: templateLiteralStaticText(node) };
      case 'Identifier': {
        const name = typeof node.name === 'string' ? node.name : '';
        return { shape: 'identifier', name, resolvesToGlobal: scopes.isFree(name, node) };
      }
      case 'MemberExpression': {
        const path = memberPathOf(node);
        if (path === null) return { shape: 'other' };
        return {
          shape: 'member',
          path: path.path,
          rootIsGlobal: scopes.isGlobalRooted(path.root, node),
        };
      }
      case 'CallExpression':
      case 'NewExpression': {
        const callee = calleePathOf(node);
        return { shape: 'call', calleePath: callee.path };
      }
      case 'ArrayExpression': {
        const elements = node.elements;
        if (!Array.isArray(elements)) return { shape: 'array', elements: [] };
        return {
          shape: 'array',
          elements: elements.map((item) => shapeOf(isNode(item) ? item : null)),
        };
      }
      case 'ObjectExpression': {
        const properties = node.properties;
        if (!Array.isArray(properties)) return { shape: 'object', entries: [] };
        const entries: { key: string; value: JsArgShape }[] = [];
        for (const property of properties) {
          if (!isNode(property)) continue;
          const keyNode = property.key;
          const key = isNode(keyNode) ? (stringLiteralValue(keyNode) ?? nameOfNode(keyNode)) : null;
          if (key === null) continue;
          const valueNode = property.value;
          entries.push({ key, value: shapeOf(isNode(valueNode) ? valueNode : null) });
        }
        return { shape: 'object', entries };
      }
      case 'BinaryExpression': {
        if (node.operator !== '+') return { shape: 'other' };
        const parts: JsArgShape[] = [];
        flattenConcat(node, parts);
        return { shape: 'concat', parts };
      }
      default:
        return { shape: 'other' };
    }
  };

  const flattenConcat = (node: JsNode, out: JsArgShape[]): void => {
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = node.left;
      const right = node.right;
      if (isNode(left)) flattenConcat(left, out);
      if (isNode(right)) flattenConcat(right, out);
      return;
    }
    out.push(shapeOf(node));
  };

  /** 字符串字面量出现在资源入口位置时记为引用（B1 的「JS import」与 B2 的动态 URL 都吃这个）。 */
  const recordStringUrl = (raw: string, location: SourceRange | null, detail: string): void => {
    references.push({ fromPath: input.path, kind: 'js-string-url', raw, location, detail });
  };

  walk(ast, ({ node, parent, key }) => {
    // 预算：§6.3 的微工作单元之一。节点数超预算就抛 ScannerResourceLimitError（fail-closed），
    // 绝不「没读完也给结论」。
    input.budget.spend('nodes', 1);

    switch (node.type) {
      case 'Identifier': {
        const name = typeof node.name === 'string' ? node.name : null;
        if (name === null) return;
        identifiers.push(name);
        if (
          isIdentifierReference(parent, key) &&
          scopes.isFree(name, node) &&
          !globalNames.has(name)
        ) {
          globalNames.set(name, nodeRange(node));
        }
        return;
      }
      case 'Literal': {
        const value = stringLiteralValue(node);
        const offsets = nodeOffsets(node);
        if (offsets) excluded.push(offsets);
        if (value !== null) stringLiterals.push({ value, location: nodeRange(node) });
        return;
      }
      case 'TemplateLiteral': {
        const offsets = nodeOffsets(node);
        if (offsets) excluded.push(offsets);
        const cooked = templateLiteralStaticText(node);
        if (cooked !== null) stringLiterals.push({ value: cooked, location: nodeRange(node) });
        return;
      }
      case 'ImportDeclaration': {
        const source = node.source;
        const value = isNode(source) ? stringLiteralValue(source) : null;
        const location = nodeRange(node);
        if (value !== null) {
          importSources.push({ source: value, isDynamic: false, location });
          references.push({
            fromPath: input.path,
            kind: 'js-import',
            raw: value,
            location,
            detail: 'import',
          });
        }
        return;
      }
      case 'ImportExpression': {
        const source = node.source;
        const value = isNode(source) ? stringLiteralValue(source) : null;
        const location = nodeRange(node);
        if (value !== null) {
          importSources.push({ source: value, isDynamic: true, location });
          references.push({
            fromPath: input.path,
            kind: 'js-dynamic-import',
            raw: value,
            location,
            detail: 'import()',
          });
        }
        return;
      }
      case 'CallExpression':
      case 'NewExpression': {
        const callee = calleePathOf(node);
        const calleeNode = node.callee;
        const rootIsGlobal =
          callee.root !== null && isNode(calleeNode)
            ? scopes.isGlobalRooted(callee.root, calleeNode)
            : false;
        const rawArgs = node.arguments;
        const args: JsArgShape[] = Array.isArray(rawArgs)
          ? rawArgs.map((arg) => shapeOf(isNode(arg) ? arg : null))
          : [];
        calls.push({
          calleePath: callee.path,
          calleeIsGlobal: rootIsGlobal,
          isConstructor: node.type === 'NewExpression',
          isDynamicImport: isNode(calleeNode) && calleeNode.type === 'Import',
          args,
          location: nodeRange(node),
        });
        // 资源入口调用（`new Audio('x.mp3')`、`URL.createObjectURL(blob)`）：只有被调名解析到全局才算，
        // 自己写的 `function load()` 不算 —— 这条区分直接决定 §2.4 B9 的「可见游戏数值计算」会不会被误拦。
        if (
          callee.path !== null &&
          rootIsGlobal &&
          RESOURCE_CALLEE_LAST_SEGMENTS.has(lastSegment(callee.path))
        ) {
          const first: unknown = Array.isArray(rawArgs) ? rawArgs[0] : undefined;
          const literal = isNode(first) ? stringLiteralValue(first) : null;
          if (literal !== null)
            recordStringUrl(literal, isNode(first) ? nodeRange(first) : null, callee.path);
        }
        return;
      }
      case 'MemberExpression': {
        // 赋值左边的成员表达式由 AssignmentExpression 分支处理，这里只收「读取」
        if (parent && parent.type === 'AssignmentExpression' && key === 'left') return;
        const path = memberPathOf(node);
        if (path === null) return;
        memberReads.push({
          path: path.path,
          rootIsGlobal: scopes.isGlobalRooted(path.root, node),
          location: nodeRange(node),
        });
        return;
      }
      case 'AssignmentExpression': {
        const left = node.left;
        const right = node.right;
        if (!isNode(left)) return;
        const location = nodeRange(node);
        let targetPath: string | null = null;
        let targetRootIsGlobal = false;
        if (left.type === 'Identifier') {
          targetPath = typeof left.name === 'string' ? left.name : null;
          targetRootIsGlobal = targetPath !== null ? scopes.isFree(targetPath, left) : false;
        } else if (left.type === 'MemberExpression') {
          const path = memberPathOf(left);
          if (path) {
            targetPath = path.path;
            targetRootIsGlobal = scopes.isGlobalRooted(path.root, left);
          }
        }
        const value = shapeOf(right);
        assignments.push({
          targetPath,
          targetRootIsGlobal,
          declaresBinding: null,
          value,
          valueIdentifierGlobal: valueGlobalFlag(right),
          location,
        });
        if (
          targetPath !== null &&
          targetRootIsGlobal &&
          RESOURCE_SINK_PROPERTIES.has(lastSegment(targetPath)) &&
          value.shape === 'string-literal'
        ) {
          recordStringUrl(value.value, location, targetPath);
        }
        return;
      }
      case 'VariableDeclarator': {
        const id = node.id;
        const init = node.init;
        if (!isNode(id) || id.type !== 'Identifier' || !isNode(init)) return;
        const name = typeof id.name === 'string' ? id.name : null;
        if (name === null) return;
        const value = shapeOf(init);
        assignments.push({
          targetPath: null,
          targetRootIsGlobal: false,
          declaresBinding: name,
          value,
          valueIdentifierGlobal: valueGlobalFlag(init),
          location: nodeRange(node),
        });
        return;
      }
      case 'VariableDeclaration': {
        const kind = node.kind;
        const declarations = node.declarations;
        const bindingKind = kind === 'var' ? 'var' : kind === 'let' ? 'let' : 'const';
        const scopeId = scopes.scopeOf(node) ?? 0;
        if (!Array.isArray(declarations)) return;
        for (const declarator of declarations) {
          if (!isNode(declarator)) continue;
          const id = declarator.id;
          if (!isNode(id)) continue;
          const init = declarator.init;
          for (const name of declaredNamesOf(id)) {
            bindings.push({
              name,
              kind: bindingKind,
              scopeId,
              initializer: isNode(init) ? shapeOf(init) : null,
              location: nodeRange(declarator),
            });
          }
        }
        return;
      }
      case 'FunctionDeclaration': {
        const id = node.id;
        if (isNode(id) && typeof id.name === 'string') {
          bindings.push({
            name: id.name,
            kind: 'function',
            scopeId: scopes.scopeOf(node) ?? 0,
            initializer: null,
            location: nodeRange(node),
          });
        }
        return;
      }
      case 'ClassDeclaration': {
        const id = node.id;
        if (isNode(id) && typeof id.name === 'string') {
          bindings.push({
            name: id.name,
            kind: 'class',
            scopeId: scopes.scopeOf(node) ?? 0,
            initializer: null,
            location: nodeRange(node),
          });
        }
        return;
      }
      default:
        return;
    }
  });

  function valueGlobalFlag(node: unknown): boolean | null {
    if (!isNode(node)) return null;
    if (node.type === 'Identifier') {
      const name = typeof node.name === 'string' ? node.name : null;
      return name === null ? null : scopes.isFree(name, node);
    }
    if (node.type === 'MemberExpression') {
      const path = memberPathOf(node);
      return path === null ? null : scopes.isGlobalRooted(path.root, node);
    }
    return null;
  }

  excluded.sort((a, b) => a.start - b.start);

  return {
    kind: 'js',
    path: input.path,
    calls,
    assignments,
    memberReads,
    globals: [...globalNames.keys()].sort(),
    globalReferences: [...globalNames.entries()]
      .map(([name, location]) => ({ name, location }))
      .sort(compareGlobalReference),
    stringLiterals,
    importSources,
    bindings,
    references,
    readability: assessReadability({ source: input.source, excluded, identifiers }),
    parseError: null,
  };
}

/**
 * `globalReferences` 的稳定排序：名字 → 行列 → 无位置排最后。
 * Map 的插入序本身就依赖遍历顺序，而 §6.3 要求同一输入可复算，所以这里显式排一次。
 */
function compareGlobalReference(
  a: { name: string; location: SourceRange | null },
  b: { name: string; location: SourceRange | null },
): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.location === null || b.location === null)
    return a.location === null ? (b.location === null ? 0 : 1) : -1;
  if (a.location.line !== b.location.line) return a.location.line - b.location.line;
  return a.location.column - b.location.column;
}

function nameOfNode(node: JsNode): string | null {
  if (node.type === 'Identifier') return typeof node.name === 'string' ? node.name : null;
  if (node.type === 'ThisExpression') return 'this';
  return null;
}

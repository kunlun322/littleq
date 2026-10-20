/**
 * 作用域与绑定解析。
 *
 * 这是「不以单条正则作为最终判定」（ZLQ-153 §8.3 首句）能不能成立的关键一环。
 * ZLQ-156 §2.4 给 B2/B3/B6/B7 的安全反例——**名叫 `fetch` 的局部游戏函数**、**AST 树节点的 `parent` 字段**、
 * **`Top` 类**、**叫 `location` 的变量**、**烘焙游戏里的 `cookie` 变量**——单靠名字全部会误命中。
 * 只有把每个标识符解析回它的作用域，判断它是不是**自由变量**（没有任何可见绑定 ⇒ 在浏览器里落到全局对象），
 * 才能既拦住 `fetch('https://…')` 又放行 `function fetch(item) { inventory.push(item) }`。
 *
 * 语义边界（明确写下，避免看起来比实际强）：
 * - `var` 与函数声明按 JavaScript 的提升规则挂到最近的**函数作用域**，所以「先用后声明」也算局部绑定；
 * - `let`/`const`/`class` 挂到**块作用域**；
 * - 计算成员（`a[b]`）、`with`、动态 `import()` 的运行时形状无法静态确定，一律按「不可判定」处理，
 *   由调用方选择保守方向（宁可 CONFIRM，不假装 SAFE，也不假装 BLOCK）；
 * - 这是**名字级**解析，不是类型/别名分析：`const f = window.fetch; f(url)` 会解析成自由变量 `f`
 *   ⇒ 由 `js.ts` 的赋值数据流单独覆盖（右侧是 `window.fetch` 这样的全局成员读取）。
 */

import { childEntries, declaredNamesOf, isFunctionNode, isNode, type JsNode } from './jsast.js';

export type ScopeKind = 'global' | 'function' | 'block';

export type Scope = {
  id: number;
  parentId: number | null;
  kind: ScopeKind;
  names: Set<string>;
};

/** 创建新作用域的节点类型。 */
const BLOCK_SCOPE_TYPES = new Set([
  'BlockStatement',
  'SwitchStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'CatchClause',
  'StaticBlock',
]);

export class ScopeIndex {
  readonly scopes: Scope[] = [];
  readonly #nodeScope = new Map<JsNode, number>();

  constructor(root: JsNode) {
    const globalScope = this.#create('global', null);
    this.#build(root, globalScope.id);
  }

  #create(kind: ScopeKind, parentId: number | null): Scope {
    const scope: Scope = { id: this.scopes.length, parentId, kind, names: new Set() };
    this.scopes.push(scope);
    return scope;
  }

  #nearestFunctionScope(scopeId: number): number {
    let current: number | null = scopeId;
    while (current !== null) {
      const scope: Scope | undefined = this.scopes[current];
      if (!scope) return scopeId;
      if (scope.kind === 'function' || scope.kind === 'global') return scope.id;
      current = scope.parentId;
    }
    return scopeId;
  }

  #declare(scopeId: number, names: readonly string[]): void {
    const scope = this.scopes[scopeId];
    if (!scope) return;
    for (const name of names) scope.names.add(name);
  }

  #build(root: JsNode, rootScopeId: number): void {
    // 显式栈：4 MiB 的深度嵌套文件（§6.3 的最坏合法输入）不能用递归。
    const stack: { node: JsNode; scopeId: number }[] = [{ node: root, scopeId: rootScopeId }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      const { node } = frame;
      const outerScopeId = frame.scopeId;
      let scopeId = outerScopeId;
      this.#nodeScope.set(node, scopeId);

      if (isFunctionNode(node)) {
        const functionScope = this.#create('function', outerScopeId);
        // 具名函数表达式的名字在自己的作用域里可见（自递归）
        if (node.type === 'FunctionExpression') {
          const id = node.id;
          if (isNode(id) && typeof id.name === 'string') this.#declare(functionScope.id, [id.name]);
        }
        // 函数声明的名字按提升规则挂到**外层**函数作用域，不是它自己的作用域 ——
        // 挂错会让外层的 `foo()` 解析成自由变量（即全局），从而把 §2.4 的「局部函数」安全反例误判成命中。
        if (node.type === 'FunctionDeclaration') {
          const id = node.id;
          if (isNode(id) && typeof id.name === 'string') {
            this.#declare(this.#nearestFunctionScope(outerScopeId), [id.name]);
          }
        }
        const params = node.params;
        if (Array.isArray(params)) {
          for (const param of params)
            if (isNode(param)) this.#declare(functionScope.id, declaredNamesOf(param));
        }
        scopeId = functionScope.id;
        this.#nodeScope.set(node, scopeId);
      } else if (node.type === 'CatchClause') {
        const blockScope = this.#create('block', scopeId);
        const param = node.param;
        if (isNode(param)) this.#declare(blockScope.id, declaredNamesOf(param));
        scopeId = blockScope.id;
        this.#nodeScope.set(node, scopeId);
      } else if (BLOCK_SCOPE_TYPES.has(node.type)) {
        const blockScope = this.#create('block', scopeId);
        scopeId = blockScope.id;
        this.#nodeScope.set(node, scopeId);
      }

      this.#collectDeclarations(node, scopeId);

      for (const child of childEntries(node)) stack.push({ node: child.node, scopeId });
    }
  }

  /** 把声明登记到正确的作用域（`var`/函数声明提升到最近函数作用域）。 */
  #collectDeclarations(node: JsNode, scopeId: number): void {
    switch (node.type) {
      case 'VariableDeclaration': {
        const target = node.kind === 'var' ? this.#nearestFunctionScope(scopeId) : scopeId;
        const declarations = node.declarations;
        if (!Array.isArray(declarations)) return;
        for (const declarator of declarations) {
          if (!isNode(declarator)) continue;
          const id = declarator.id;
          if (isNode(id)) this.#declare(target, declaredNamesOf(id));
        }
        return;
      }
      case 'FunctionDeclaration': {
        // 函数声明的名字挂到**外层**作用域（提升）；此时 scopeId 已经是外层，因为
        // FunctionDeclaration 本身不是 function-node 作用域的创建点（它创建的函数作用域给 body 用）。
        const id = node.id;
        if (isNode(id) && typeof id.name === 'string') {
          this.#declare(this.#nearestFunctionScope(scopeId), [id.name]);
        }
        return;
      }
      case 'ClassDeclaration': {
        const id = node.id;
        if (isNode(id) && typeof id.name === 'string') this.#declare(scopeId, [id.name]);
        return;
      }
      case 'ImportDeclaration': {
        const specifiers = node.specifiers;
        if (!Array.isArray(specifiers)) return;
        for (const specifier of specifiers) {
          if (!isNode(specifier)) continue;
          const local = specifier.local;
          if (isNode(local) && typeof local.name === 'string') this.#declare(scopeId, [local.name]);
        }
        return;
      }
      default:
        return;
    }
  }

  scopeOf(node: JsNode): number | null {
    return this.#nodeScope.get(node) ?? null;
  }

  /** 名字在 `node` 所在位置是否有可见绑定（含提升后的 `var`/函数声明）。 */
  hasBinding(name: string, node: JsNode): boolean {
    let current: number | null = this.#nodeScope.get(node) ?? null;
    while (current !== null) {
      const scope = this.scopes[current];
      if (!scope) return false;
      if (scope.names.has(name)) return true;
      current = scope.parentId;
    }
    return false;
  }

  /**
   * 名字是否是**自由变量**（没有任何可见绑定）。
   * 在浏览器全局作用域里，自由变量名就落到 `window` 上 —— 所以 `fetch` 自由 ⇒ 真的是 `window.fetch`。
   */
  isFree(name: string, node: JsNode): boolean {
    return !this.hasBinding(name, node);
  }

  /**
   * 成员路径的最左标识符是否解析到全局。
   * `window.parent` / 裸 `parent` / `document.cookie` ⇒ true；
   * `node.parent`（`node` 是局部变量）/ `this.parent` ⇒ false。
   */
  isGlobalRooted(rootName: string | null, node: JsNode): boolean {
    if (rootName === null) return false;
    if (rootName === 'this' || rootName === 'super') return false;
    return this.isFree(rootName, node);
  }
}

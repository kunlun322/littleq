/**
 * JavaScript AST 遍历与结构提取。
 *
 * **为什么自己写 walker**：`acorn-walk` 是独立 npm 包，不在本包的冻结依赖里（ZLQ-206 §7：不新增依赖，
 * 缺依赖就停下点名）。一个基于「属性值里凡是带 `type` 字符串的对象就是子节点」的通用遍历器
 * 覆盖全部 ESTree 节点类型，不需要维护节点表，也不会因为 acorn 升级新增节点类型而漏遍历。
 */

export type JsNode = {
  readonly type: string;
  readonly start?: number;
  readonly end?: number;
  readonly [key: string]: unknown;
};

export function isNode(value: unknown): value is JsNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type !== ''
  );
}

/** 直接子节点（按属性名顺序，稳定）。 */
export function childEntries(node: JsNode): { key: string; node: JsNode }[] {
  const out: { key: string; node: JsNode }[] = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
      continue;
    const value = node[key];
    if (isNode(value)) {
      out.push({ key, node: value });
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push({ key, node: item });
    }
  }
  return out;
}

export type WalkContext = {
  node: JsNode;
  parent: JsNode | null;
  key: string | null;
  depth: number;
  /** 从根到当前节点的祖先链（不含自身），供作用域/上下文判定回溯。 */
  ancestors: readonly JsNode[];
};

/**
 * 前序遍历。`enter` 返回 `false` 时跳过该节点的子树（用于跳过已单独处理的 `<script>` 内容等）。
 */
export function walk(root: JsNode, enter: (context: WalkContext) => boolean | void): void {
  const stack: {
    node: JsNode;
    parent: JsNode | null;
    key: string | null;
    depth: number;
    ancestors: JsNode[];
  }[] = [{ node: root, parent: null, key: null, depth: 0, ancestors: [] }];
  // 用显式栈而不是递归：4 MiB 的深度嵌套（§6.3 的最坏合法文件）会把调用栈打爆。
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const descend = enter({
      node: frame.node,
      parent: frame.parent,
      key: frame.key,
      depth: frame.depth,
      ancestors: frame.ancestors,
    });
    if (descend === false) continue;
    const children = childEntries(frame.node);
    const nextAncestors = [...frame.ancestors, frame.node];
    // 逆序压栈 ⇒ 出栈即前序
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (!child) continue;
      stack.push({
        node: child.node,
        parent: frame.node,
        key: child.key,
        depth: frame.depth + 1,
        ancestors: nextAncestors,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 结构提取
// ---------------------------------------------------------------------------

function nameOf(node: JsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return typeof node.name === 'string' ? node.name : null;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Super') return 'super';
  return null;
}

/**
 * 成员路径：`navigator.clipboard.readText` → `"navigator.clipboard.readText"`。
 * 计算属性（`a[b]`）与可选链的中间段无法静态确定 ⇒ 返回到最后一个静态段为止的路径，
 * 并由 `isFullyStatic` 告知是否完整。
 */
export type MemberPathResult = {
  path: string;
  root: string | null;
  fullyStatic: boolean;
  rootIsThis: boolean;
};

export function memberPathOf(node: JsNode): MemberPathResult | null {
  const segments: string[] = [];
  let current: JsNode | null = node;
  let fullyStatic = true;
  while (current) {
    if (current.type === 'MemberExpression' || current.type === 'ChainExpression') {
      if (current.type === 'ChainExpression') {
        const inner: unknown = current.expression;
        current = isNode(inner) ? inner : null;
        continue;
      }
      const property: unknown = current.property;
      if (current.computed === true) {
        // `a[b]`：静态段到此为止
        fullyStatic = false;
        const object: unknown = current.object;
        current = isNode(object) ? object : null;
        continue;
      }
      const propertyName = nameOf(isNode(property) ? property : null);
      if (propertyName === null) {
        fullyStatic = false;
        const object: unknown = current.object;
        current = isNode(object) ? object : null;
        continue;
      }
      segments.unshift(propertyName);
      const object: unknown = current.object;
      current = isNode(object) ? object : null;
      continue;
    }
    if (
      current.type === 'Identifier' ||
      current.type === 'ThisExpression' ||
      current.type === 'Super'
    ) {
      const root = nameOf(current);
      segments.unshift(root ?? '');
      return {
        path: segments.join('.'),
        root,
        fullyStatic,
        rootIsThis: current.type === 'ThisExpression',
      };
    }
    // 根不是标识符（例如 `foo().bar`、`(a ? b : c).d`、字符串字面量的属性）⇒ 没有可判定的全局根
    return { path: segments.join('.'), root: null, fullyStatic: false, rootIsThis: false };
  }
  return null;
}

/** 调用点的被调路径。`new X()` / `a.b()` / `foo()`；解析不出时 calleePath 为 null。 */
export function calleePathOf(node: JsNode): {
  path: string | null;
  root: string | null;
  fullyStatic: boolean;
} {
  const callee = node.callee;
  if (!isNode(callee)) return { path: null, root: null, fullyStatic: false };
  if (callee.type === 'Import') return { path: 'import', root: 'import', fullyStatic: true };
  const result = memberPathOf(callee);
  if (!result) return { path: null, root: null, fullyStatic: false };
  return { path: result.path, root: result.root, fullyStatic: result.fullyStatic };
}

/** 字符串字面量的值（`Literal` 且 `typeof value === 'string'`；正则/数字/bigint 不算）。 */
export function stringLiteralValue(node: JsNode): string | null {
  if (node.type !== 'Literal') return null;
  const value = node.value;
  return typeof value === 'string' ? value : null;
}

/** 模板字面量：无插值时给出静态文本，有插值时返回 null（不能假装知道运行时值）。 */
export function templateLiteralStaticText(node: JsNode): string | null {
  if (node.type !== 'TemplateLiteral') return null;
  const expressions = node.expressions;
  if (Array.isArray(expressions) && expressions.length > 0) return null;
  const quasis = node.quasis;
  if (!Array.isArray(quasis) || quasis.length === 0) return null;
  let text = '';
  for (const quasi of quasis) {
    if (!isNode(quasi)) continue;
    const value = quasi.value;
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { cooked?: unknown }).cooked === 'string'
    ) {
      text += (value as { cooked: string }).cooked;
    }
  }
  return text;
}

/** 声明的名字集合（`VariableDeclarator.id` 可能是解构模式）。 */
export function declaredNamesOf(node: JsNode): string[] {
  const names: string[] = [];
  const visit = (current: JsNode): void => {
    switch (current.type) {
      case 'Identifier':
        if (typeof current.name === 'string') names.push(current.name);
        return;
      case 'ObjectPattern': {
        const properties = current.properties;
        if (Array.isArray(properties)) {
          for (const property of properties) {
            if (!isNode(property)) continue;
            if (property.type === 'RestElement') {
              const argument = property.argument;
              if (isNode(argument)) visit(argument);
              continue;
            }
            const value = property.value;
            if (isNode(value)) visit(value);
          }
        }
        return;
      }
      case 'ArrayPattern': {
        const elements = current.elements;
        if (Array.isArray(elements)) {
          for (const element of elements) if (isNode(element)) visit(element);
        }
        return;
      }
      case 'RestElement': {
        const argument = current.argument;
        if (isNode(argument)) visit(argument);
        return;
      }
      case 'AssignmentPattern': {
        const left = current.left;
        if (isNode(left)) visit(left);
        return;
      }
      default:
        return;
    }
  };
  visit(node);
  return names;
}

/** 函数形态节点（创建自己的作用域与参数绑定）。 */
export function isFunctionNode(node: JsNode): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

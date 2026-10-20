/**
 * **B5 跨站表单** —— ZLQ-153 §8.3 原文：
 * 「v1 禁止表单提交；允许仅在页面内由 JS 处理的输入控件；`form-action 'none'`」
 *
 * 判定轴是**结构**，不是语义：
 * - `<form>` 元素本身就是「表单提交」的载体。v1 禁止它 ⇒ 硬拦。这不是在猜作者意图：
 *   Runtime 的冻结 CSP 是 `form-action 'none'`（§8.4），一个 `<form>` 在 v1 里根本提交不出去，
 *   所以它只可能是残留或误用，修复动作明确（去掉 `<form>` 外壳，保留控件）。
 * - 「允许仅在页面内由 JS 处理的**输入控件**」放行的是控件，不是表单。所以
 *   `<input>/<textarea>/<select>` 单独出现**零命中** —— 这正是 ZLQ-156 §2.4 B5 反例
 *   「非 form 输入组件」的放行路径。
 * - §2.4 的另一条反例「`button type=button` 的本机答题面板」同样零命中：`<button>` 不是 `<form>`，
 *   也没有 `formaction`。
 *
 * `action`/`formaction` 逃出包外时单独记 `cross-site-form-action`：修复动作不同（本地化 vs 删外壳），
 * 而且它是规则名「跨站表单」的字面命中。
 */

import type { HtmlElementSummary } from '../analysis/model.js';
import {
  CSP_NONE,
  attributeOf,
  effectiveDirective,
  escapesPackage,
  findEdge,
  htmlSummaryOf,
  metaCspOf,
} from './support.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';

export const B5_SUB_TYPES = [
  'form-element',
  'cross-site-form-action',
  'csp-form-action-weakened',
] as const;

export const b05CrossSiteForm: Rule = {
  id: 'B5',
  maxDisposition: 'BLOCK',
  subTypes: B5_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      const html = htmlSummaryOf(file.summary);
      if (html === null) continue;

      for (const element of html.elements) {
        if (element.tagName === 'form') {
          const action = attributeOf(element, 'action');
          // 没有 action 的 `<form>` 提交到当前文档 URL；在 `form-action 'none'` 下同样被拒。
          if (action === null) emitBlock(context, file, element, 'form-element');
          else if (escapes(context, file, action))
            emitBlock(context, file, element, 'cross-site-form-action');
          continue;
        }
        // `formaction` 可以挂在提交控件上，绕过 `<form action>`。它不需要祖先信息就能判：
        // 只有指向包外才产生命中；包内的提交语义由上面那条 `<form>` 判定覆盖。
        const override = attributeOf(element, 'formaction');
        if (override !== null && escapes(context, file, override)) {
          emitBlock(context, file, element, 'cross-site-form-action');
        }
      }

      checkMetaCsp(context, file);
    }
  },
};

function escapes(context: RuleContext, file: RuleFileContext, action: string): boolean {
  const edge = findEdge(context.graph, file.path, action);
  return edge !== null && escapesPackage(edge);
}

function emitBlock(
  context: RuleContext,
  file: RuleFileContext,
  element: HtmlElementSummary,
  subType: string,
): void {
  context.emit({
    ruleId: 'B5',
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path: file.path,
    location: element.location,
    repairAction: 'REMOVE_SENSITIVE_INPUT',
    subType,
  });
}

/** 作品自己写了 `<meta>` CSP 却把 `form-action` 放宽 —— 与冻结的 `form-action 'none'` 冲突。 */
function checkMetaCsp(context: RuleContext, file: RuleFileContext): void {
  for (const meta of metaCspOf(file)) {
    const directive = effectiveDirective(meta.policy, 'form-action');
    if (directive === null || directive === CSP_NONE) continue;
    context.emit({
      ruleId: 'B5',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: file.path,
      location: meta.location,
      repairAction: 'REMOVE_SENSITIVE_INPUT',
      subType: 'csp-form-action-weakened',
    });
  }
}

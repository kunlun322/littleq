/**
 * B3 顶层导航（ZLQ-153 §8.3）。
 *
 * 原文：「识别 `window/top/location` 赋值、`open`、meta refresh、`target=_top/_parent`；
 * sandbox 不授予 top-navigation/popups。」
 *
 * ZLQ-156 §2.4 给了四个必须通过的安全反例，它们决定了这里只能用 AST + 作用域：
 * - **hash 页内路由** —— `location.hash` 故意不在 `NAVIGATION_LOCATION_SINKS` 里；
 * - **history 状态** —— `history.pushState` 不在任何名单里；
 * - **变量叫 `location`** —— 靠 `targetRootIsGlobal` 区分，局部变量不是全局 `location`；
 * - **绘本「打开下一页」按钮** —— `addEventListener` + 局部状态，不碰任何 sink。
 *
 * 纯正则实现会把这四条全部误拦（§8 变异对照 3 就是用这个反例集把正则版染红的）。
 */

import {
  FORBIDDEN_LINK_TARGETS,
  NAVIGATION_LOCATION_SINKS,
  NAVIGATION_WINDOW_SINKS,
} from '../lexicon.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';
import { attributeOf, htmlSummaryOf, jsSummariesOf, stripGlobalPrefix } from './support.js';

export const B3_SUB_TYPES = [
  'location-assignment',
  'window-open',
  'meta-refresh',
  'forbidden-link-target',
] as const;

const LOCATION_SINKS: ReadonlySet<string> = new Set(NAVIGATION_LOCATION_SINKS);
const WINDOW_SINKS: ReadonlySet<string> = new Set(NAVIGATION_WINDOW_SINKS);
const FORBIDDEN_TARGETS: ReadonlySet<string> = new Set(FORBIDDEN_LINK_TARGETS);

export const b03TopNavigation: Rule = {
  id: 'B3',
  maxDisposition: 'BLOCK',
  subTypes: B3_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      checkJavaScript(context, file);
      checkHtml(context, file);
    }
  },
};

function checkJavaScript(context: RuleContext, file: RuleFileContext): void {
  for (const js of jsSummariesOf(file.summary)) {
    for (const assignment of js.assignments) {
      if (assignment.targetPath === null) continue;
      // 局部变量叫 location 不是导航（§2.4 反例）；只有解析到全局的根才算。
      if (!assignment.targetRootIsGlobal) continue;
      if (!LOCATION_SINKS.has(stripGlobalPrefix(assignment.targetPath))) continue;
      context.emit({
        ruleId: 'B3',
        disposition: 'BLOCK',
        confidence: 'HIGH',
        path: file.path,
        location: assignment.location,
        repairAction: 'REMOVE_NAVIGATION',
        subType: 'location-assignment',
      });
    }

    for (const call of js.calls) {
      if (call.calleePath === null || !call.calleeIsGlobal) continue;
      const path = stripGlobalPrefix(call.calleePath);
      // `window.open(...)` 是弹窗导航；`location.assign(...)` / `location.replace(...)`
      // 是调用形态的 location sink —— 只看赋值会漏掉它们。
      if (!WINDOW_SINKS.has(path) && !LOCATION_SINKS.has(path)) continue;
      context.emit({
        ruleId: 'B3',
        disposition: 'BLOCK',
        confidence: 'HIGH',
        path: file.path,
        location: call.location,
        repairAction: 'REMOVE_NAVIGATION',
        subType: 'window-open',
      });
    }
  }
}

function checkHtml(context: RuleContext, file: RuleFileContext): void {
  const html = htmlSummaryOf(file.summary);
  if (html === null) return;

  for (const element of html.elements) {
    if (element.tagName === 'meta') {
      const httpEquiv = attributeOf(element, 'http-equiv')?.trim().toLowerCase();
      // `<meta http-equiv="refresh">` 是纯声明式跳转，没有 JS 也能把顶层窗口带走。
      if (httpEquiv !== 'refresh') continue;
      context.emit({
        ruleId: 'B3',
        disposition: 'BLOCK',
        confidence: 'HIGH',
        path: file.path,
        location: element.location,
        repairAction: 'REMOVE_NAVIGATION',
        subType: 'meta-refresh',
      });
      continue;
    }

    const target = attributeOf(element, 'target')?.trim().toLowerCase();
    if (target === undefined || !FORBIDDEN_TARGETS.has(target)) continue;
    context.emit({
      ruleId: 'B3',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: file.path,
      location: element.location,
      repairAction: 'REMOVE_NAVIGATION',
      subType: 'forbidden-link-target',
    });
  }
}

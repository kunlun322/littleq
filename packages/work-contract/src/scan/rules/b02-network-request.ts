/**
 * B2 网络请求（ZLQ-153 §8.3）。
 *
 * 原文：「JS AST 识别 `fetch/XMLHttpRequest/WebSocket/EventSource/sendBeacon/importScripts`、
 * 动态 import URL、Service Worker；HTML form；CSP `connect-src 'none'` 兜底。」
 *
 * 判定必须走 AST 而不是关键词，理由是 ZLQ-156 §2.4 给的两个反例：
 * - **名叫 `fetch` 的局部游戏函数** —— 靠 `calleeIsGlobal`（作用域分析的结果）区分，
 *   正则会把它当成网络调用硬拦；
 * - **模拟 XMLHttpRequest 的教学字符串** —— 字符串不是调用，`calls[]` 里根本不会出现它。
 *
 * `navigator.connection` / `navigator.onLine` 是**网络状态读取**而不是请求，
 * 不在 §8.3 的 B2 名单里；这里按 LOW 置信度只标记确认，不硬拦（§8.6：语义不确定项不升级为硬拦）。
 */

import { NETWORK_GLOBAL_NAMES, NETWORK_MEMBER_PATHS } from '../lexicon.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';
import {
  CSP_NONE,
  effectiveDirective,
  escapesPackage,
  findEdge,
  htmlSummaryOf,
  jsSummariesOf,
  metaCspOf,
  stripGlobalPrefix,
} from './support.js';

export const B2_SUB_TYPES = [
  'network-call',
  'network-member',
  'network-state-probe',
  'dynamic-import-external',
  'html-form-action',
  'csp-connect-src-weakened',
] as const;

/** §8.3 B2 名单里属于「发请求」的成员路径。 */
const REQUEST_MEMBER_PATHS: ReadonlySet<string> = new Set([
  'navigator.sendBeacon',
  'navigator.serviceWorker.register',
  'navigator.serviceWorker.getRegistration',
  'navigator.serviceWorker.getRegistrations',
]);

/** 剩下的成员路径是状态读取，只标记确认。 */
const PROBE_MEMBER_PATHS: ReadonlySet<string> = new Set(
  NETWORK_MEMBER_PATHS.filter((path) => !REQUEST_MEMBER_PATHS.has(path)),
);

const NETWORK_GLOBALS: ReadonlySet<string> = new Set(NETWORK_GLOBAL_NAMES);

export const b02NetworkRequest: Rule = {
  id: 'B2',
  maxDisposition: 'BLOCK',
  subTypes: B2_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      checkJavaScript(context, file);
      checkDynamicImports(context, file);
      checkHtmlForms(context, file);
      checkMetaCsp(context, file);
    }
  },
};

function checkJavaScript(context: RuleContext, file: RuleFileContext): void {
  for (const js of jsSummariesOf(file.summary)) {
    for (const call of js.calls) {
      if (call.calleePath === null) continue;
      const path = stripGlobalPrefix(call.calleePath);

      if (call.calleeIsGlobal && NETWORK_GLOBALS.has(path)) {
        context.emit({
          ruleId: 'B2',
          disposition: 'BLOCK',
          confidence: 'HIGH',
          path: file.path,
          location: call.location,
          repairAction: 'REMOVE_NETWORK',
          subType: 'network-call',
        });
        continue;
      }

      if (REQUEST_MEMBER_PATHS.has(path)) {
        context.emit({
          ruleId: 'B2',
          disposition: 'BLOCK',
          confidence: 'HIGH',
          path: file.path,
          location: call.location,
          repairAction: 'REMOVE_NETWORK',
          subType: 'network-member',
        });
        continue;
      }

      if (PROBE_MEMBER_PATHS.has(path)) {
        context.emit({
          ruleId: 'B2',
          disposition: 'CONFIRM_REQUIRED',
          confidence: 'LOW',
          path: file.path,
          location: call.location,
          repairAction: 'REMOVE_NETWORK',
          subType: 'network-state-probe',
        });
      }
    }

    for (const read of js.memberReads) {
      const path = stripGlobalPrefix(read.path);
      if (!PROBE_MEMBER_PATHS.has(path)) continue;
      context.emit({
        ruleId: 'B2',
        disposition: 'CONFIRM_REQUIRED',
        confidence: 'LOW',
        path: file.path,
        location: read.location,
        repairAction: 'REMOVE_NETWORK',
        subType: 'network-state-probe',
      });
    }
  }
}

/**
 * 动态 `import()` 的落点。
 *
 * 复用资源图里已经分类好的边（`kind === 'js-dynamic-import'`），**不重新分类** ——
 * 分类要花二级解码预算，同一个串分类两次会让预算翻倍，且预算耗尽后两次结果可能不一致。
 */
function checkDynamicImports(context: RuleContext, file: RuleFileContext): void {
  for (const edge of context.graph.edges) {
    if (edge.fromPath !== file.path) continue;
    if (edge.kind !== 'js-dynamic-import') continue;
    if (!escapesPackage(edge)) continue;
    context.emit({
      ruleId: 'B2',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: file.path,
      location: edge.location,
      repairAction: 'REMOVE_NETWORK',
      subType: 'dynamic-import-external',
    });
  }
}

function checkHtmlForms(context: RuleContext, file: RuleFileContext): void {
  const html = htmlSummaryOf(file.summary);
  if (html === null) return;

  for (const element of html.elements) {
    for (const attribute of element.attributes) {
      if (attribute.name !== 'action' && attribute.name !== 'formaction') continue;
      const edge = findEdge(context.graph, file.path, attribute.value);
      // 找不到边说明这个值在图里被判成空串/纯 fragment，不构成提交目标。
      if (edge === null || !escapesPackage(edge)) continue;
      context.emit({
        ruleId: 'B2',
        disposition: 'BLOCK',
        confidence: 'HIGH',
        path: file.path,
        location: attribute.location,
        repairAction: 'REMOVE_NETWORK',
        subType: 'html-form-action',
      });
    }
  }
}

function checkMetaCsp(context: RuleContext, file: RuleFileContext): void {
  for (const meta of metaCspOf(file)) {
    const connect = effectiveDirective(meta.policy, 'connect-src');
    if (connect === null || connect === CSP_NONE) continue;
    context.emit({
      ruleId: 'B2',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: file.path,
      location: meta.location,
      repairAction: 'REMOVE_NETWORK',
      subType: 'csp-connect-src-weakened',
    });
  }
}

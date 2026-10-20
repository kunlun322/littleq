/**
 * B4 下载（ZLQ-153 §8.3）。
 *
 * 原文：「`download` 属性、`msSaveBlob`、File System Access、Blob URL 与锚点 click 的数据流组合；
 * sandbox 不授予 downloads。」
 *
 * 「Blob URL 与锚点 click 的**数据流组合**」是这条规则里唯一不能用关键词做的部分，
 * 也是 ZLQ-156 §2.4 两个安全反例的分界线：
 * - **Blob 给 audio/img** / **createObjectURL 仅播放** —— 落点是 `src`/`srcObject`/`poster`
 *   这类**播放/显示** sink（`MEDIA_SINK_PROPERTIES`），不是下载；
 * - 只有「object URL 流进 `href`」+「同一个根上发生 `.click()`」两件事**同时**成立才是下载。
 *
 * 所以这里做的是三趟：先收集 object URL 的持有者，再收集把持有者写进 `href` 的锚点根，
 * 最后看这些根上有没有 `.click()`。少了任何一趟，要么漏检要么把播放误判成下载。
 */

import { DOWNLOAD_MEMBER_PATHS, OBJECT_URL_FACTORY } from '../lexicon.js';
import type { JsArgShape } from '../analysis/model.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';
import {
  attributeOf,
  htmlSummaryOf,
  jsSummariesOf,
  lastSegment,
  stripGlobalPrefix,
} from './support.js';

export const B4_SUB_TYPES = [
  'download-attribute',
  'file-system-access',
  'blob-anchor-click',
] as const;

const DOWNLOAD_PATHS: ReadonlySet<string> = new Set(DOWNLOAD_MEMBER_PATHS);

export const b04Download: Rule = {
  id: 'B4',
  maxDisposition: 'BLOCK',
  subTypes: B4_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      checkHtml(context, file);
      checkJavaScript(context, file);
    }
  },
};

function checkHtml(context: RuleContext, file: RuleFileContext): void {
  const html = htmlSummaryOf(file.summary);
  if (html === null) return;

  for (const element of html.elements) {
    if (!attributeOf(element, 'download') && !hasDownloadAttribute(element)) continue;
    context.emit({
      ruleId: 'B4',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: file.path,
      location: element.location,
      repairAction: 'REMOVE_NAVIGATION',
      subType: 'download-attribute',
    });
  }
}

/** `download` 是布尔属性，`<a download>` 没有值；`attributeOf` 只能看到有值的写法。 */
function hasDownloadAttribute(element: { attributes: readonly { name: string }[] }): boolean {
  return element.attributes.some((attribute) => attribute.name === 'download');
}

function checkJavaScript(context: RuleContext, file: RuleFileContext): void {
  for (const js of jsSummariesOf(file.summary)) {
    for (const call of js.calls) {
      if (call.calleePath === null) continue;
      if (!DOWNLOAD_PATHS.has(stripGlobalPrefix(call.calleePath))) continue;
      context.emit({
        ruleId: 'B4',
        disposition: 'BLOCK',
        confidence: 'HIGH',
        path: file.path,
        location: call.location,
        repairAction: 'REMOVE_NAVIGATION',
        subType: 'file-system-access',
      });
    }

    // 第 1 趟：object URL 的持有者。
    const holders = new Set<string>();
    for (const binding of js.bindings) {
      if (binding.initializer !== null && isObjectUrlCall(binding.initializer))
        holders.add(binding.name);
    }
    for (const assignment of js.assignments) {
      if (!isObjectUrlCall(assignment.value)) continue;
      const name =
        assignment.declaresBinding ??
        (assignment.targetPath === null ? null : lastSegment(assignment.targetPath));
      if (name !== null) holders.add(name);
    }
    if (holders.size === 0) continue;

    // 第 2 趟：把持有者写进 `href` 的锚点根。`src`/`srcObject` 是播放，不算（§2.4 反例）。
    const anchorRoots = new Set<string>();
    for (const assignment of js.assignments) {
      if (assignment.targetPath === null) continue;
      if (lastSegment(assignment.targetPath) !== 'href') continue;
      const value = assignment.value;
      if (value.shape !== 'identifier' || !holders.has(value.name)) continue;
      const dot = assignment.targetPath.lastIndexOf('.');
      if (dot <= 0) continue;
      anchorRoots.add(assignment.targetPath.slice(0, dot));
    }
    if (anchorRoots.size === 0) continue;

    // 第 3 趟：这些根上的 `.click()`。
    for (const call of js.calls) {
      if (call.calleePath === null) continue;
      if (lastSegment(call.calleePath) !== 'click') continue;
      const dot = call.calleePath.lastIndexOf('.');
      if (dot <= 0) continue;
      if (!anchorRoots.has(call.calleePath.slice(0, dot))) continue;
      context.emit({
        ruleId: 'B4',
        disposition: 'BLOCK',
        confidence: 'HIGH',
        path: file.path,
        location: call.location,
        repairAction: 'REMOVE_NAVIGATION',
        subType: 'blob-anchor-click',
      });
    }
  }
}

function isObjectUrlCall(shape: JsArgShape): boolean {
  if (shape.shape !== 'call' || shape.calleePath === null) return false;
  return lastSegment(shape.calleePath) === OBJECT_URL_FACTORY;
}

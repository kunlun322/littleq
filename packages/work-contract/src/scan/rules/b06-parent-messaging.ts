/**
 * **B6 父页/消息** —— ZLQ-153 §8.3 原文：
 * 「识别 `parent/top/opener/frameElement` 读写；`postMessage` 只允许平台注入的受控 storage bridge
 * 且 targetOrigin 必须精确，v1 默认不开放」
 *
 * ZLQ-156 §2.4 的四条 B6 安全反例说明了为什么判定必须走作用域分析而不是关键词：
 * - 「AST 树节点的 `parent` 字段」：`node.parent` 的根是局部绑定 ⇒ `rootIsGlobal === false`，
 *   而且 `node.parent` 不在 `CROSS_WINDOW_MEMBER_PATHS` 里（那张表是**全路径**精确匹配，不是末段匹配）。
 * - 「`Top` 类」：`new Top()` 的 `calleeIsGlobal === false`（自己声明的类不是自由标识符）。
 * - 「Canvas 内文字」：B6 只读代码 token，不读文案。
 * - 「无消息的页面布局」：没有 `postMessage` 调用。
 *
 * 同一个理由让 `element.style.top = '0px'` 也不会命中 —— 末段匹配会把 CSS 定位属性全部误拦，
 * 所以这里只匹配**以跨窗口对象为根的完整路径**（含它更深的链，如 `window.parent.document.title`）
 * 与自由全局标识符，两者都要先过作用域分析。
 *
 * `postMessage` 没有「精确 targetOrigin 就放行」的分支：`ScanPolicySnapshot.allowPostMessageBridge`
 * 的类型是字面量 `false`（见 `types.ts` 的注释），v1 里这条 bridge 根本不存在。写一个永远走不到的
 * else 分支只会掩盖这一点，所以这里是无条件硬拦 + 把原因写在注释里。
 */

import {
  CROSS_WINDOW_GLOBAL_NAMES,
  CROSS_WINDOW_MEMBER_PATHS,
  POST_MESSAGE_NAMES,
} from '../lexicon.js';
import { jsSummariesOf, lastSegment, stripGlobalPrefix } from './support.js';
import type { Rule, RuleContext } from './types.js';

export const B6_SUB_TYPES = ['cross-window-access', 'post-message'] as const;

const CROSS_WINDOW_MEMBERS = new Set(CROSS_WINDOW_MEMBER_PATHS);
const CROSS_WINDOW_GLOBALS = new Set(CROSS_WINDOW_GLOBAL_NAMES);
const CROSS_WINDOW_CHAIN_HEADS = new Set(
  CROSS_WINDOW_MEMBER_PATHS.filter((path) => !path.includes('.')),
);
const POST_MESSAGE = new Set(POST_MESSAGE_NAMES);

/**
 * 全路径判定，**先过作用域分析**：根不解析到全局就一律不算。
 *
 * `parent` 是 AST 树节点的字段名、`top` 是 CSS 定位属性名 —— 这两种写法在 §2.4 里是明确的
 * 安全反例，靠的就是 `rootIsGlobal`（局部绑定的 `node`/`element` 不是自由全局标识符）
 * 与「只比完整路径、不比末段」这两条一起排除的。
 */
function isCrossWindowPath(path: string, rootIsGlobal: boolean): boolean {
  if (!rootIsGlobal) return false;
  const stripped = stripGlobalPrefix(path);
  if (CROSS_WINDOW_MEMBERS.has(stripped)) return true;
  const dot = stripped.indexOf('.');
  return dot > 0 && CROSS_WINDOW_CHAIN_HEADS.has(stripped.slice(0, dot));
}

export const b06ParentMessaging: Rule = {
  id: 'B6',
  maxDisposition: 'BLOCK',
  subTypes: B6_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      for (const js of jsSummariesOf(file.summary)) {
        for (const reference of js.globalReferences) {
          if (!CROSS_WINDOW_GLOBALS.has(reference.name)) continue;
          context.emit({
            ruleId: 'B6',
            disposition: 'BLOCK',
            confidence: 'HIGH',
            path: file.path,
            location: reference.location,
            repairAction: 'REMOVE_NETWORK',
            subType: 'cross-window-access',
          });
        }

        for (const read of js.memberReads) {
          if (!isCrossWindowPath(read.path, read.rootIsGlobal)) continue;
          context.emit({
            ruleId: 'B6',
            disposition: 'BLOCK',
            confidence: 'HIGH',
            path: file.path,
            location: read.location,
            repairAction: 'REMOVE_NETWORK',
            subType: 'cross-window-access',
          });
        }

        for (const assignment of js.assignments) {
          const target = assignment.targetPath;
          if (target === null) continue;
          if (!isCrossWindowPath(target, assignment.targetRootIsGlobal)) continue;
          context.emit({
            ruleId: 'B6',
            disposition: 'BLOCK',
            confidence: 'HIGH',
            path: file.path,
            location: assignment.location,
            repairAction: 'REMOVE_NETWORK',
            subType: 'cross-window-access',
          });
        }

        for (const call of js.calls) {
          const path = call.calleePath;
          if (path === null || !call.calleeIsGlobal) continue;
          if (isCrossWindowPath(path, true)) {
            context.emit({
              ruleId: 'B6',
              disposition: 'BLOCK',
              confidence: 'HIGH',
              path: file.path,
              location: call.location,
              repairAction: 'REMOVE_NETWORK',
              subType: 'cross-window-access',
            });
            continue;
          }
          // 局部对象上的同名方法（`bus.postMessage(…)`）`calleeIsGlobal === false`，上面已经 continue 掉了。
          if (!POST_MESSAGE.has(lastSegment(path))) continue;
          context.emit({
            ruleId: 'B6',
            disposition: 'BLOCK',
            confidence: 'HIGH',
            path: file.path,
            location: call.location,
            repairAction: 'REMOVE_NETWORK',
            subType: 'post-message',
          });
        }
      }
    }
  },
};

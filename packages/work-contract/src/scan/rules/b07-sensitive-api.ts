/**
 * **B7 敏感浏览器 API** —— ZLQ-153 §8.3 原文：
 * 「`document.cookie`、Credential Management、Clipboard read、联系人、位置等；
 * 摄像头/麦克风/传感器按成人开关和 Permissions-Policy 单独准入」
 *
 * ZLQ-156 §2.4 的四条 B7 安全反例决定了判定的形状：
 * - 「烘焙游戏 cookie 变量」：`SENSITIVE_MEMBER_PATHS` 的 `document-cookie` 是
 *   `^document\.cookie$` **全路径锚定**，局部的 `cookie`/`cookies` 变量不命中。
 * - 「Clipboard **写入**」：词表里只有 `^navigator\.clipboard\.read(?:Text)?$`。为了让这个放行是
 *   **结构性的**而不是「恰好正则没写到」，下面显式维护一个 allow 集：即便日后有人把词表放宽成
 *   `^navigator\.clipboard\.`，写入仍然不会被拦。
 * - 「document.referrer 普通说明」：同上，进 allow 集。冻结的 `referrerpolicy="no-referrer"`
 *   让 `document.referrer` 在 Runtime 里恒为空串，读不出任何东西，因此**不产出任何 finding**
 *   （连 CONFIRM 都不产出 —— 否则「安全包零命中」这条证明就不成立）。
 * - 「合法批准的本机摄像头」：`capabilities` 里声明了 **且** `adultApprovedCapabilities` 批准了 ⇒ 放行。
 *
 * §8.4 的「存储键强制 `littleq:{workId}:` 前缀」「扫描器禁止枚举 `localStorage.key/length`
 * 和跨前缀访问」也实现在这里：冻结的 B 表没有独立的存储行，而 §3 明令「不得合并」规则，
 * 所以归类到 B7「敏感浏览器 API」—— 枚举别的作品的存储就是敏感 API 误用。
 * 这个归类是对冻结文本的读法，已在交付说明里点名。
 *
 * 存储枚举分两档，档位差异是有意的（详见 `lexicon.ts` 的 `STORAGE_DATABASE_*` 注释）：
 * 跨作品可见的（`localStorage.key/length/clear`、`Object.keys(localStorage)`、
 * `indexedDB.databases()`）硬拦；只对作品自己那个库自省、且平台隔离方式冻结文本没规定的
 * （`objectStoreNames`）只进成人复核。§8.6「语义不确定项不升级为硬拦」。
 *
 * **已知漏检（声明，不静默）**：把 `indexedDB`/`localStorage` 存进局部变量再调用的写法
 * （`const idb = indexedDB; idb.databases()`）不命中硬拦档 —— 硬拦要求 precision ≥98%，
 * 末段匹配换来的召回不值得那个误拦率。别名写法目前完全无命中，留给 D3b 的实测语料量化。
 */

import type { JsArgShape } from '../analysis/model.js';
import {
  CLIPBOARD_WRITE_PATHS,
  GATED_DEVICE_MEMBER_PATHS,
  REFERRER_PATH,
  SENSITIVE_MEMBER_PATHS,
  STORAGE_DATABASE_ENUMERATION,
  STORAGE_DATABASE_PROBE,
  STORAGE_ENUMERATION_PATHS,
  STORAGE_LENGTH_PROPERTIES,
  STORAGE_OBJECTS,
} from '../lexicon.js';
import type { LexiconEntry } from '../lexicon.js';
import type { SourceRange } from '../types.js';
import {
  confidenceOf,
  jsSummariesOf,
  lastSegment,
  staticTextOf,
  stripGlobalPrefix,
} from './support.js';
import type { Rule, RuleContext } from './types.js';

export const B7_SUB_TYPES = [
  'sensitive-api',
  'gated-device-not-declared',
  'gated-device-not-approved',
  'storage-enumeration',
  'storage-database-probe',
  'storage-key-unprefixed',
] as const;

/** §2.4 点名安全、因此**显式**放行的路径。见文件头。 */
const ALLOWED_PATHS = new Set<string>([...CLIPBOARD_WRITE_PATHS, REFERRER_PATH]);

const ENUMERATION_PATHS = new Set(STORAGE_ENUMERATION_PATHS);
const STORAGE_OBJECT_SET = new Set(STORAGE_OBJECTS);
const LENGTH_PROPERTIES = new Set(STORAGE_LENGTH_PROPERTIES);
const DATABASE_ENUMERATION = new Set(STORAGE_DATABASE_ENUMERATION);
const DATABASE_PROBE = new Set(STORAGE_DATABASE_PROBE);
const GATED_PATHS = new Map(
  GATED_DEVICE_MEMBER_PATHS.map((entry) => [entry.path, entry.capability]),
);
const STORAGE_KEY_METHODS = new Set(['setItem', 'getItem', 'removeItem']);

export const b07SensitiveApi: Rule = {
  id: 'B7',
  maxDisposition: 'BLOCK',
  subTypes: B7_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      for (const js of jsSummariesOf(file.summary)) {
        for (const read of js.memberReads) {
          checkPath(context, file.path, read.path, read.rootIsGlobal, read.location);
        }
        for (const assignment of js.assignments) {
          if (assignment.targetPath === null) continue;
          checkPath(
            context,
            file.path,
            assignment.targetPath,
            assignment.targetRootIsGlobal,
            assignment.location,
          );
        }
        for (const reference of js.globalReferences) {
          const entry = matchSensitive(reference.name);
          if (entry === null) continue;
          emitSensitive(context, file.path, entry, reference.location);
        }
        for (const call of js.calls) {
          const path = call.calleePath;
          if (path === null) continue;
          checkPath(context, file.path, path, call.calleeIsGlobal, call.location);
          checkGatedDevice(context, file.path, path, call.calleeIsGlobal, call.location);
          checkStorageKey(context, file.path, path, call.calleeIsGlobal, call.args, call.location);
        }
      }
    }
  },
};

/** 成员路径判定：全路径锚定 + 全局性校验 + allow 集，三者都过才产生命中。 */
function checkPath(
  context: RuleContext,
  path: string,
  target: string,
  rootIsGlobal: boolean,
  location: SourceRange | null,
): void {
  const stripped = stripGlobalPrefix(target);
  if (ALLOWED_PATHS.has(stripped)) return;

  // IndexedDB 的枚举面分两档，理由见 `lexicon.ts` 的 `STORAGE_DATABASE_*` 注释。
  // **硬拦档只认完整路径**（`window.` 前缀已由 `stripGlobalPrefix` 去掉）：§8.6 要求每条硬拦
  // 规则 precision ≥98%，末段匹配会把 `world.databases` 这类游戏字段一起拦掉。代价是别名漏检
  // （`const idb = indexedDB; idb.databases()`）—— 已在文件头点名，不用末段匹配去补。
  if (DATABASE_ENUMERATION.has(stripped)) {
    emitStorage(context, path, location);
    return;
  }
  // **复核档才用末段匹配**：`objectStoreNames` 挂在局部的 db/store 对象上，`rootIsGlobal` 为假，
  // 完整路径根本对不上。这里误报的代价是一次成人点击，不是拒收作品。
  if (target.includes('.') && DATABASE_PROBE.has(lastSegment(target))) {
    emitDatabaseProbe(context, path, location);
    return;
  }
  if (!rootIsGlobal) return;

  // `localStorage.key` / `.clear` 这类接收者本身就是存储对象的枚举，路径足以判定。
  // `Object.keys(x)` 一类要看实参，交给 `checkStorageKey`（那里才拿得到 `args`）。
  const receiver = receiverOf(stripped);
  if (ENUMERATION_PATHS.has(stripped)) {
    if (STORAGE_OBJECT_SET.has(receiver)) emitStorage(context, path, location);
    return;
  }
  if (STORAGE_OBJECT_SET.has(receiver) && LENGTH_PROPERTIES.has(lastSegment(stripped))) {
    emitStorage(context, path, location);
    return;
  }

  const entry = matchSensitive(stripped);
  if (entry === null) return;
  emitSensitive(context, path, entry, location);
}

function receiverOf(path: string): string {
  const segment = lastSegment(path);
  return path.slice(0, Math.max(0, path.length - segment.length - 1));
}

function matchSensitive(candidate: string): LexiconEntry | null {
  for (const entry of SENSITIVE_MEMBER_PATHS) {
    if (entry.pattern.test(candidate)) return entry;
  }
  return null;
}

function emitSensitive(
  context: RuleContext,
  path: string,
  entry: LexiconEntry,
  location: SourceRange | null,
): void {
  const confidence = confidenceOf(entry);
  context.emit({
    ruleId: 'B7',
    // §8.6「语义不确定项不升级为硬拦」：LOW tier 只进成人复核。
    disposition: confidence === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED',
    confidence,
    path,
    location,
    repairAction: 'REVIEW_CAPABILITY',
    subType: 'sensitive-api',
  });
}

/** 摄像头/麦克风/传感器：manifest 声明 **且** 成人批准，缺一即硬拦（§8.3、§8.4）。 */
function checkGatedDevice(
  context: RuleContext,
  path: string,
  target: string,
  rootIsGlobal: boolean,
  location: SourceRange | null,
): void {
  if (!rootIsGlobal) return;
  const capability = GATED_PATHS.get(stripGlobalPrefix(target));
  if (capability === undefined) return;

  const declared = context.metadata.capabilities.includes(capability);
  const approved = context.policy.adultApprovedCapabilities.includes(capability);
  if (declared && approved) return;
  context.emit({
    ruleId: 'B7',
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path,
    location,
    repairAction: 'REVIEW_CAPABILITY',
    subType: declared ? 'gated-device-not-approved' : 'gated-device-not-declared',
  });
}

/**
 * §8.4 的存储键前缀条款。写死了不带前缀的键名只是风格问题（Runtime 仍会强制加前缀），
 * 而拼接/变量键名根本判不出来 ⇒ 只进成人复核，动态键名不产出任何 finding。
 * 硬拦会造出 §8.6 要防的误拦。
 *
 * `Object.keys(localStorage)` 这一类需要看实参的枚举也在这里判：`checkPath` 拿不到 `args`。
 */
function checkStorageKey(
  context: RuleContext,
  path: string,
  target: string,
  rootIsGlobal: boolean,
  args: readonly JsArgShape[],
  location: SourceRange | null,
): void {
  if (!rootIsGlobal) return;
  const stripped = stripGlobalPrefix(target);
  const segment = lastSegment(stripped);
  const receiver = receiverOf(stripped);
  const first = args[0];

  if (ENUMERATION_PATHS.has(stripped) && !STORAGE_OBJECT_SET.has(receiver)) {
    if (first !== undefined && isStorageObject(first)) emitStorage(context, path, location);
    return;
  }
  if (!STORAGE_OBJECT_SET.has(receiver) || !STORAGE_KEY_METHODS.has(segment)) return;
  if (first === undefined) return;
  const literal = staticTextOf(first);
  if (literal === null || literal.partial) return;
  if (literal.text.startsWith(context.policy.storageKeyPrefix)) return;
  context.emit({
    ruleId: 'B7',
    disposition: 'CONFIRM_REQUIRED',
    confidence: 'LOW',
    path,
    location,
    repairAction: 'REVIEW_CAPABILITY',
    subType: 'storage-key-unprefixed',
  });
}

function isStorageObject(shape: JsArgShape): boolean {
  if (shape.shape === 'identifier') return STORAGE_OBJECT_SET.has(shape.name);
  if (shape.shape === 'member') return STORAGE_OBJECT_SET.has(stripGlobalPrefix(shape.path));
  return false;
}

function emitStorage(context: RuleContext, path: string, location: SourceRange | null): void {
  context.emit({
    ruleId: 'B7',
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path,
    location,
    repairAction: 'REVIEW_CAPABILITY',
    subType: 'storage-enumeration',
  });
}

function emitDatabaseProbe(context: RuleContext, path: string, location: SourceRange | null): void {
  context.emit({
    ruleId: 'B7',
    disposition: 'CONFIRM_REQUIRED',
    confidence: 'LOW',
    path,
    location,
    repairAction: 'REVIEW_CAPABILITY',
    subType: 'storage-database-probe',
  });
}

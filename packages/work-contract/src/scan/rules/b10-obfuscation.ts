/**
 * **B10 混淆/动态执行** —— ZLQ-153 §8.3 原文：
 * 「`eval/Function/setTimeout(string)`、多层 base64/字符数组执行、packer 签名、
 * 异常熵/不可读标识；压缩产物之外必须有可读源」
 *
 * ZLQ-156 §8.4 的两条也归在这里判定：「扫描器拒绝 HTML 事件处理属性和动态脚本拼接」。
 * 脚本型 URL scheme（`javascript:`）同样归 B10 而不是 B1 —— 冻结 CSP 是
 * `script-src 'self' 'sha256-…'`、`object-src 'none'`，这些 scheme 在 Runtime 里根本执行不了，
 * 它出现即说明包里有「想执行脚本」的意图，属动态执行面。
 *
 * ## 判定分五层，各自的证据来源不同
 *
 * 1. **动态执行调用**（`eval` / `Function` / `setTimeout(string)`）——走 AST，不看正则。
 *    `setTimeout(fn, 100)` 是教学代码里最常见的写法，只有第一个实参**静态可知是字符串**时才算
 *    动态执行；`Function` 只在被**调用/构造**时才算，`Function.prototype.bind` 不算。
 * 2. **packer 签名**——走原始文本。这一层刻意**不**用「摘掉注释」的 code-only 文本：
 *    javascript-obfuscator 一类工具最可靠的指纹恰恰是它自己插的 banner 注释，
 *    摘掉注释等于把最稳的那条证据亲手扔掉。§2.4 的 B10 反例是「许可注释/长词典」，
 *    五条签名的形状（`_0x` 密度、`fromCharCode` 长链、`eval(function(p,a,c,k,e,`）
 *    都不可能被一条 MIT 头或一个 base64 图片串命中。
 * 3. **异常熵/不可读标识**——度量在解析层（`readability.ts`）已经算好，这里只做**判定**：
 *    度量说不可读，还要看有没有「可读源」对应；有就放行，没有才硬拦。度量与判定分开，
 *    才能让同一个数字在两种上下文里得出相反结论，而不是把豁免写进度量里。
 * 4. **HTML 事件处理属性 / 动态脚本拼接 / 脚本型 scheme**——§8.4 点名的三条。
 * 5. **声明类型与真实字节矛盾**——伪装成二进制的可解析内容会让前四层连输入都拿不到，
 *    所以它是其余四层的**前置**保障，判据见 `checkDeclaredTypeLie`。
 *
 * ## 已声明的漏检（不静默）
 *
 * - `(0, eval)('…')` / `const e = eval; e('…')` 这类间接形态拿不到 callee 路径，不命中。
 *   末段匹配换不来 precision ≥98%（§8.6），留给 D3b 的实测语料量化。别名形态同理。
 * - `el.innerHTML = someVariable`：变量内容静态不可知 ⇒ **不产出任何 finding**。
 *   结构上的兜底是 Runtime 的 CSP：`script-src 'self' 'sha256-…'` 让注入的 `<script>` 执行不了，
 *   HTML 规范本身也规定 `innerHTML` 插入的 script 不执行。只有静态可知的脚本标记才硬拦。
 */

import { isTextualMediaType } from '../analysis/index.js';
import type { JsArgShape, ParseSummary, ReadabilityAssessment } from '../analysis/model.js';
import {
  DYNAMIC_EXEC_NAMES,
  DYNAMIC_SCRIPT_ASSEMBLY_PROPERTIES,
  FUNCTION_CONSTRUCTOR,
  PACKER_SIGNATURES,
  TIMER_NAMES,
} from '../lexicon.js';
import { admittedMediaType } from '../metadata.js';
import { sniffContradictsDeclared, sniffMediaType } from '../sniff.js';
import type { FindingLocation, RepairAction } from '../types.js';
import { htmlSummaryOf, jsSummariesOf, lastSegment, staticTextOf } from './support.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';

export const B10_SUB_TYPES = [
  'dynamic-exec',
  'function-constructor',
  'timer-string-exec',
  'packer-signature',
  'unreadable-without-source',
  'html-event-handler',
  'dynamic-script-assembly',
  'script-scheme-url',
  'declared-type-contradicted',
] as const;

const DYNAMIC_EXEC_SET = new Set(DYNAMIC_EXEC_NAMES);
const TIMER_SET = new Set(TIMER_NAMES);
const ASSEMBLY_PROPERTIES = new Set(DYNAMIC_SCRIPT_ASSEMBLY_PROPERTIES);

/**
 * 「静态可知的脚本拼接」的判据：值里真的出现了脚本标记。
 * `el.textContent = score + ' 分'` 是教学代码里最常见的写法，没有这个判据就会大面积误拦（§8.6）。
 */
const SCRIPT_MARKUP_PATTERN = /<\s*script\b|<\/\s*script\b|javascript\s*:|\bon[a-z]+\s*=/i;

/** minified 构建产物的命名约定：`.min.js` / `.min.css`（含 `.production.min.js` 一类）。 */
const MINIFIED_SUFFIX_PATTERN = /\.min(?=\.[a-z]+$)/i;

export const b10Obfuscation: Rule = {
  id: 'B10',
  maxDisposition: 'BLOCK',
  subTypes: B10_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      checkDynamicExec(context, file);
      checkScriptAssembly(context, file);
      checkEventHandlers(context, file);
      checkScriptSchemeEdges(context, file);
      checkPackerSignatures(context, file);
      checkReadability(context, file);
      checkDeclaredTypeLie(context, file);
    }
  },
};

// ---------------------------------------------------------------------------
// 1. 动态执行调用
// ---------------------------------------------------------------------------

function checkDynamicExec(context: RuleContext, file: RuleFileContext): void {
  for (const js of jsSummariesOf(file.summary)) {
    for (const reference of js.globalReferences) {
      // `eval` 只作为自由全局标识符出现就足以判定：它是唯一没有「合法读取」用途的动态执行入口
      // （不像 `Function` 有 `.prototype`/`.bind` 这类正常成员访问）。
      if (DYNAMIC_EXEC_SET.has(reference.name))
        emit(context, file.path, 'dynamic-exec', reference.location);
    }

    for (const call of js.calls) {
      const name = call.calleePath;
      // 只认**裸全局名**：`path === name` 排除了 `obj.eval(…)` 这类成员调用，
      // `calleeIsGlobal` 排除了局部同名绑定（§2.4「名叫 fetch 的局部游戏函数」的同一形状）。
      if (name === null || !call.calleeIsGlobal || name !== lastSegment(name)) continue;

      if (DYNAMIC_EXEC_SET.has(name)) {
        emit(context, file.path, 'dynamic-exec', call.location);
      } else if (name === FUNCTION_CONSTRUCTOR) {
        // `Function('…')` 与 `new Function('…')` 等价，都是动态执行。
        emit(context, file.path, 'function-constructor', call.location);
      } else if (TIMER_SET.has(name) && isStaticString(call.args[0])) {
        emit(context, file.path, 'timer-string-exec', call.location);
      }
    }
  }
}

/** 实参静态可知是字符串（含无插值模板串）⇒ 动态执行。函数引用完全正常，不算。 */
function isStaticString(arg: JsArgShape | undefined): boolean {
  if (arg === undefined) return false;
  if (arg.shape === 'string-literal') return true;
  return arg.shape === 'template-literal' && arg.cooked !== null;
}

// ---------------------------------------------------------------------------
// 2. packer 签名（原始文本）
// ---------------------------------------------------------------------------

function checkPackerSignatures(context: RuleContext, file: RuleFileContext): void {
  const text = file.text;
  if (text === null) return;
  for (const entry of PACKER_SIGNATURES) {
    const match = entry.pattern.exec(text);
    if (match === null) continue;
    emit(context, file.path, 'packer-signature', offsetToLocation(file, match.index));
  }
}

// ---------------------------------------------------------------------------
// 3. 异常熵/不可读标识 + 「压缩产物之外必须有可读源」
// ---------------------------------------------------------------------------

function checkReadability(context: RuleContext, file: RuleFileContext): void {
  if (!readabilityOf(file.summary).some((assessment) => assessment.unreadable)) return;
  if (hasReadableCounterpart(context, file)) return;
  // 没有行列：度量是整份文件的统计量，指不到某一行。§6.2 允许在无可靠区间时给 null。
  emit(context, file.path, 'unreadable-without-source', null);
}

/**
 * 「压缩产物之外必须有可读源」的判定。两个候选，任一成立即放行：
 * ① 去掉 `.min` 后的同名兄弟文件在包里、且它自己**是可读的**；
 * ② `work.json` 的 `sourceEntryPaths` 指向的文件在包里、且它自己是可读的。
 *
 * ②是关键：§2.4 的反例「可读源对应的 minified 构建文件」靠的就是它 —— 那份文件熵高、行长，
 * 但 `sourceEntryPaths` 指向了它的可读源，所以合法。要求候选**自己可读**，是为了防止
 * 用「另一个同样混淆的文件」充当可读源。
 */
function hasReadableCounterpart(context: RuleContext, file: RuleFileContext): boolean {
  for (const candidate of counterpartCandidates(context, file.path)) {
    if (candidate === file.path) continue;
    const counterpart = context.fileByPath.get(candidate);
    if (counterpart === undefined) continue;
    const assessments = readabilityOf(counterpart.summary);
    if (assessments.length === 0) continue;
    if (assessments.every((assessment) => !assessment.unreadable)) return true;
  }
  return false;
}

function counterpartCandidates(context: RuleContext, path: string): string[] {
  const candidates = [...context.metadata.sourceEntryPaths];
  if (MINIFIED_SUFFIX_PATTERN.test(path))
    candidates.push(path.replace(MINIFIED_SUFFIX_PATTERN, ''));
  return candidates;
}

function readabilityOf(summary: ParseSummary): readonly ReadabilityAssessment[] {
  switch (summary.kind) {
    case 'js':
    case 'css':
      return [summary.readability];
    case 'html':
      // 内联脚本/内联样式各自有度量。它们不是独立文件，`sourceEntryPaths` 指不到，
      // 所以内联形态一旦不可读就没有「可读源」可豁免。
      return [
        ...summary.inlineScriptSummaries.map((inline) => inline.readability),
        ...summary.inlineStyleSummaries.map((inline) => inline.readability),
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 4. §8.4：HTML 事件处理属性、动态脚本拼接、脚本型 URL scheme
// ---------------------------------------------------------------------------

/**
 * `eventHandlerAttributes` 由解析层按 `HTML_EVENT_HANDLER_ATTRIBUTE_PATTERN` 收集，
 * 这里只补一条判据：**空值放行**。`/^on[a-z]+$/` 也会命中 `only`/`once` 这类自定义布尔属性，
 * 而真正的事件处理属性一定带非空值 —— 用这一条把误拦挡在硬拦之外（§8.6 precision ≥98%）。
 */
function checkEventHandlers(context: RuleContext, file: RuleFileContext): void {
  const html = htmlSummaryOf(file.summary);
  if (html === null) return;
  for (const handler of html.eventHandlerAttributes) {
    if (handler.value.trim() === '') continue;
    emit(context, file.path, 'html-event-handler', handler.location);
  }
}

function checkScriptAssembly(context: RuleContext, file: RuleFileContext): void {
  for (const js of jsSummariesOf(file.summary)) {
    for (const assignment of js.assignments) {
      const target = assignment.targetPath;
      if (target === null || !ASSEMBLY_PROPERTIES.has(lastSegment(target))) continue;
      const literal = staticTextOf(assignment.value);
      if (literal === null || !SCRIPT_MARKUP_PATTERN.test(literal.text)) continue;
      emit(context, file.path, 'dynamic-script-assembly', assignment.location);
    }

    for (const call of js.calls) {
      const path = call.calleePath;
      if (path === null || !ASSEMBLY_PROPERTIES.has(lastSegment(path))) continue;
      // `insertAdjacentHTML('afterbegin', '<script>…')`：脚本标记在第二个实参。
      const literal = call.args.map(staticTextOf).find((value) => value !== null);
      if (literal === undefined || !SCRIPT_MARKUP_PATTERN.test(literal.text)) continue;
      emit(context, file.path, 'dynamic-script-assembly', call.location);
    }
  }
}

/** `javascript:` / `data:text/html` 一类脚本型 scheme。B1 的资源图刻意跳过它，归这里判。 */
function checkScriptSchemeEdges(context: RuleContext, file: RuleFileContext): void {
  for (const edge of context.graph.edges) {
    if (edge.fromPath !== file.path || edge.resolved.target !== 'script-scheme') continue;
    emit(context, file.path, 'script-scheme-url', edge.location);
  }
}

// ---------------------------------------------------------------------------
// 5. 声明类型与真实字节矛盾（伪装成二进制的可解析内容）
// ---------------------------------------------------------------------------

/**
 * 判据是**「扫描器会不会因此看不见它」**，不是「声明是否整洁」。
 *
 * `analyzeFile` 按声明的 mediaType 派发解析器：声明成 `image/png` 的文件走二进制分支，
 * 里面的 `<script>`、`onload=`、`xlink:href` 对 B1–B13 **全部不可见**。所以真正的漏洞形状是
 * 「声明为不可解析形态、字节却是可解析形态」。用 `isTextualMediaType` 两侧各问一次，
 * 判据与派发共用同一个函数 ⇒ 两者不可能漂移（漂移了就变成「派发按 A 判、规则按 B 判」）。
 *
 * 反过来不报：声明 `image/webp` 实际是 `audio/wav`，两侧都不解析，没有内容被藏起来；
 * 那是 §1.3「扩展名、嗅探与声明一致」的 metadata 层问题，`checkMediaType` 已经管，
 * 在 B10 再报一次会让同一处缺陷被两条规则重复计数，污染 §8.6 的 precision 分母。
 *
 * 魔数矛盾本身是确定事实（不是语义猜测），所以 HIGH/BLOCK 与 B10 其余四层同档；
 * `probable` 档的文本嗅探已由 `sniffContradictsDeclared` 抑制，不会把一份以 `{` 开头的
 * `text/plain` 误判成 JSON 伪装。
 */
function checkDeclaredTypeLie(context: RuleContext, file: RuleFileContext): void {
  if (!declaredIsAdmitted(file.mediaType)) return;
  const sniffed = sniffMediaType(file.bytes);
  if (sniffed === null) return;
  if (!sniffContradictsDeclared(sniffed, file.mediaType)) return;
  if (!isTextualMediaType(sniffed.mediaType)) return;
  if (isTextualMediaType(file.mediaType)) return;
  // 整份文件的事实，指不到某一行 ⇒ location = null（§6.2 允许无可靠区间时给 null）。
  emit(context, file.path, 'declared-type-contradicted', null, 'CORRECT_CLAIM');
}

/** 只在准入表内的声明上做判定；不在表里的由 metadata 校验负责，避免重复报告。 */
function declaredIsAdmitted(mediaType: string): boolean {
  return admittedMediaType(mediaType) !== undefined;
}

// ---------------------------------------------------------------------------
// 发射
// ---------------------------------------------------------------------------

/** 把原始文本里的字符偏移换算成行列；拿不到行索引就给 null（§6.2 允许）。 */
function offsetToLocation(file: RuleFileContext, offset: number): FindingLocation {
  return file.lines === null ? null : file.lines.range(offset, offset);
}

function emit(
  context: RuleContext,
  path: string,
  subType: (typeof B10_SUB_TYPES)[number],
  location: FindingLocation,
  repairAction: RepairAction = 'MAKE_READABLE',
): void {
  context.emit({
    ruleId: 'B10',
    // B10 的每一条判据都是确定形状（裸全局 `eval`、packer 指纹、脚本标记、scheme、魔数矛盾），
    // 没有「语义不确定」的档位 ⇒ 一律 HIGH/BLOCK。§8.6「语义不确定项不升级为硬拦」在这里
    // 是通过**不产出低置信档**来满足的，而不是通过降级。
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path,
    location,
    repairAction,
    subType,
  });
}

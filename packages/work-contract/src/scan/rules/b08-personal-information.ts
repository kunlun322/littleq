/**
 * **B8 个人信息** —— ZLQ-153 §8.3 原文：
 * 「DOM 字段名/label/placeholder 与中文词典识别姓名、电话、住址、学校、证件；
 * 高置信硬拦，低置信成人复核；无网络仍不允许诱导收集」
 *
 * 判定面**只有输入控件结构**：`<input>/<textarea>/<select>` 的 PII 承载属性、与它们配对的
 * `<label>` 文本、`autocomplete` token，以及 JS 里给 `placeholder`/`aria-label` 赋的静态字符串。
 * 普通文本节点、散文、manifest 的 title/description **一律不进 B8** —— 那是 B12/B13 的输入集。
 *
 * 这个划分正是 ZLQ-156 §2.4 三条 B8 反例的放行路径，而且是**结构性**放行，不是「词表恰好没写到」：
 * - 「绘本人物住址作为剧情文字」：`<p>` 里的文本节点不是控件属性，压根不产生候选。
 * - 「数学『学校人数』静态题」：同上。题干文字不是字段名。
 * - 「虚构角色名输入」：`FICTIONAL_CONTEXT_CUES` 出现在**同一个**字段文本里时，抑制
 *   `plain-name-field`。注意只抑制「名字」这一类 —— 电话/住址/证件即便在游戏里问也是真 PII。
 *
 * 「无网络仍不允许诱导收集」⇒ 本规则的判定**不读** B1/B2 的结果：没有出口也照样命中。
 * 收集动作本身对儿童就是伤害，不取决于数据后来发不发得出去。
 */

import type { HtmlElementSummary } from '../analysis/model.js';
import {
  FICTIONAL_CONTEXT_CUES,
  FICTIONAL_SUPPRESSIBLE_IDS,
  PII_AUTOCOMPLETE_TOKENS,
  PII_BEARING_ATTRIBUTES,
  PII_STRONG_FIELD_CUES,
  PII_WEAK_FIELD_CUES,
  SAFE_AUTOCOMPLETE_TOKENS,
} from '../lexicon.js';
import type { LexiconEntry } from '../lexicon.js';
import { collapseWhitespace } from '../normalize.js';
import type { FindingLocation } from '../types.js';
import {
  attributeOf,
  confidenceOf,
  htmlSummaryOf,
  jsSummariesOf,
  lastSegment,
  staticTextOf,
} from './support.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';

export const B8_SUB_TYPES = ['pii-field', 'autocomplete-pii'] as const;

/** 承载 PII 判定的控件标签。 */
const CONTROL_TAGS = new Set(['input', 'textarea', 'select']);
/**
 * JS 赋值路径里只认这两个属性名。
 * `name`/`id`/`title`/`alt` 在**任何**元素上都存在（`div.title = '电话'` 完全正常），
 * 把它们也纳入会造出 §8.6 要防的误拦；而 `placeholder`/`aria-label` 的语义就是「给用户看的字段提示」。
 */
const JS_FIELD_PROPERTIES = new Set(['placeholder', 'aria-label']);
const AUTOCOMPLETE_TOKENS = new Set(PII_AUTOCOMPLETE_TOKENS);
const SAFE_TOKENS = new Set(SAFE_AUTOCOMPLETE_TOKENS);
const SUPPRESSIBLE = new Set(FICTIONAL_SUPPRESSIBLE_IDS);
const FIELD_CUES: readonly LexiconEntry[] = [...PII_STRONG_FIELD_CUES, ...PII_WEAK_FIELD_CUES];

export const b08PersonalInformation: Rule = {
  id: 'B8',
  maxDisposition: 'BLOCK',
  subTypes: B8_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      const html = htmlSummaryOf(file.summary);
      if (html !== null) checkMarkup(context, file, html.elements);
      checkScriptedFields(context, file);
    }
  },
};

function checkMarkup(
  context: RuleContext,
  file: RuleFileContext,
  elements: readonly HtmlElementSummary[],
): void {
  const controlsById = controlIdIndex(elements);

  for (const element of elements) {
    const isControl = CONTROL_TAGS.has(element.tagName);

    if (element.tagName === 'label') {
      // `<label for="x">` 只有在 x 真的是控件时才承载字段语义；
      // 没有 `for` 的包裹式 label 同样算（它必然包着一个控件）。
      const target = attributeOf(element, 'for');
      if (target !== null && !controlsById.has(target)) continue;
      addSite(context, file, element.ownText, element.ownTextLocation);
      continue;
    }

    if (!isControl) continue;
    // 隐藏域不可能向学生索取任何输入，判它只会造出误拦。
    if (attributeOf(element, 'type') === 'hidden') continue;

    checkAutocomplete(context, file, element);
    for (const name of PII_BEARING_ATTRIBUTES) {
      const value = attributeOf(element, name);
      if (value === null) continue;
      addSite(context, file, value, element.location);
    }
  }
}

/** `autocomplete` 用的是 HTML 标准语义 token，不是词典 —— 它是比属性文本更强的信号。 */
function checkAutocomplete(
  context: RuleContext,
  file: RuleFileContext,
  element: HtmlElementSummary,
): void {
  const value = attributeOf(element, 'autocomplete');
  if (value === null) return;
  const tokens = value.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.every((token) => SAFE_TOKENS.has(token.toLowerCase()))) return;
  const hit = tokens.find((token) => AUTOCOMPLETE_TOKENS.has(token.toLowerCase()));
  if (hit === undefined) return;
  context.emit({
    ruleId: 'B8',
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path: file.path,
    location: element.location,
    repairAction: 'REMOVE_SENSITIVE_INPUT',
    subType: 'autocomplete-pii',
  });
}

function checkScriptedFields(context: RuleContext, file: RuleFileContext): void {
  for (const js of jsSummariesOf(file.summary)) {
    for (const assignment of js.assignments) {
      const target = assignment.targetPath;
      if (target === null || !JS_FIELD_PROPERTIES.has(lastSegment(target))) continue;
      const literal = staticTextOf(assignment.value);
      // 拼接/变量文案判不出来：不产出 finding（宁漏不误，§8.6）。
      if (literal === null || literal.partial) continue;
      addSite(context, file, literal.text, assignment.location);
    }
  }
}

function addSite(
  context: RuleContext,
  file: RuleFileContext,
  raw: string,
  location: FindingLocation,
): void {
  const text = collapseWhitespace(raw);
  if (text.length === 0) return;
  const entry = matchFieldCue(text);
  if (entry === null) return;
  const confidence = confidenceOf(entry);
  context.emit({
    ruleId: 'B8',
    // §8.3「高置信硬拦，低置信成人复核」。
    disposition: confidence === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED',
    confidence,
    path: file.path,
    location,
    repairAction: 'REMOVE_SENSITIVE_INPUT',
    subType: 'pii-field',
  });
}

function matchFieldCue(text: string): LexiconEntry | null {
  const fictional = FICTIONAL_CONTEXT_CUES.some((cue) => cue.test(text));
  for (const entry of FIELD_CUES) {
    if (!entry.pattern.test(text)) continue;
    if (fictional && SUPPRESSIBLE.has(entry.id)) continue;
    return entry;
  }
  return null;
}

/** 文档里所有控件的 `id`，用于解析 `<label for>`。 */
function controlIdIndex(elements: readonly HtmlElementSummary[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const element of elements) {
    if (!CONTROL_TAGS.has(element.tagName)) continue;
    const id = attributeOf(element, 'id');
    if (id !== null && id.length > 0) ids.add(id);
  }
  return ids;
}

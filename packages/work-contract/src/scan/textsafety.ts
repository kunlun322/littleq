/**
 * 显示文本安全校验（ZLQ-156 §1.2）。
 *
 * §1.2 对 `title` / `description` / `authorNickname` / `cover.alt` / `assets[].sourceName` /
 * `assets[].creator` / `assets[].attribution` 的要求是同一套：
 * 「长度均按 Unicode 码点计算；显示文本 NFC 规范化，去首尾空白，拒绝 NUL/控制字符、双向控制字符、
 * 可识别凭证与 PII；HTML 作为纯文本转义，不能渲染成标签」。
 *
 * 「命中明显 PII/凭证不截断、不以脱敏默认值『洗白』后发布」——所以这里只回答「安全/不安全 + 原因 id」，
 * **从不返回命中片段本身**，也从不返回改写后的文本。定位一律用 JSON Pointer（§1.5）。
 */

import {
  BIDI_OR_NUL_PATTERN,
  CREDENTIAL_PATTERNS,
  PII_PATTERNS,
  type LexiconEntry,
} from './lexicon.js';
import { codePointLength, containsControlOrBidi, nfc } from './normalize.js';

export type TextSafetyIssue =
  | 'contains-control-or-bidi'
  | 'contains-credential'
  | 'contains-pii'
  | 'contains-html-markup'
  | 'not-nfc-normalized'
  | 'has-surrounding-whitespace'
  | 'too-long'
  | 'too-short';

export type TextSafetyResult =
  | { ok: true; value: string }
  | {
      ok: false;
      issue: TextSafetyIssue;
      /** 命中的词库条目 id，不是命中内容。 */ lexiconId?: string;
    };

/**
 * 只有能构成「标签」的 `<` 才算 HTML 标记。`a < b`、`3 < 5` 这类比较文案是合法的儿童作品标题，
 * 不能因为一个尖括号就拒；§1.2 禁的是「渲染成标签」，即 `<tag …>` / `</tag>` / `<!-- … -->` / `<!DOCTYPE`。
 */
const HTML_MARKUP_PATTERN = /<\/?[a-zA-Z!][^>]*>/;

function firstMatch(text: string, entries: readonly LexiconEntry[]): LexiconEntry | undefined {
  for (const entry of entries) if (entry.pattern.test(text)) return entry;
  return undefined;
}

/**
 * 校验一段显示文本。`minCodePoints` / `maxCodePoints` 按 §1.2 的「长度均按 Unicode 码点计算」。
 *
 * @param value        待校验文本（原样，不预先 trim —— 「去首尾空白」是校验项之一，先 trim 就查不出来了）
 * @param minCodePoints 允许的最小码点数（含）
 * @param maxCodePoints 允许的最大码点数（含）
 */
export function checkDisplayText(
  value: string,
  minCodePoints: number,
  maxCodePoints: number,
): TextSafetyResult {
  if (BIDI_OR_NUL_PATTERN.test(value) || containsControlOrBidi(value)) {
    return { ok: false, issue: 'contains-control-or-bidi' };
  }
  if (value !== nfc(value)) return { ok: false, issue: 'not-nfc-normalized' };
  if (value !== value.trim()) return { ok: false, issue: 'has-surrounding-whitespace' };

  const length = codePointLength(value);
  if (length < minCodePoints) return { ok: false, issue: 'too-short' };
  if (length > maxCodePoints) return { ok: false, issue: 'too-long' };

  const credential = firstMatch(value, CREDENTIAL_PATTERNS);
  if (credential) return { ok: false, issue: 'contains-credential', lexiconId: credential.id };

  const pii = firstMatch(
    value,
    PII_PATTERNS.filter((entry) => entry.tier === 'HIGH'),
  );
  if (pii) return { ok: false, issue: 'contains-pii', lexiconId: pii.id };

  if (HTML_MARKUP_PATTERN.test(value)) return { ok: false, issue: 'contains-html-markup' };

  return { ok: true, value };
}

/** 只查凭证/PII，不查长度与 NFC —— 给「文本里是否夹带了秘密」这类判定复用。 */
export function findSecretShape(text: string): LexiconEntry | undefined {
  return firstMatch(text, CREDENTIAL_PATTERNS) ?? firstMatch(text, PII_PATTERNS);
}

/**
 * **输出路径**脱敏的判据（ZLQ-156 §6.2：「输出路径也可能含 PII/秘密：正常路径先经过门禁安全化；
 * 若异常 filename 命中，summary path 使用稳定 `file-<ordinal>` 占位，不回显原名或签名 query」）。
 *
 * 与 `findSecretShape` 的差别是**故意**的：这里用 `checkDisplayText` 同一套「可作最终判定」的档位
 * —— 全部凭证形状 + **只有 HIGH 档** PII，不含 LOW 档。
 *
 * 为什么必须排除 LOW 档：LOW 档的两条（裸 13–19 位数字的 `bank-card`、`intl-phone`）是**召回型候选**，
 * §8.6「优先 AST/数据流与规范化，正则只用于候选召回」不允许把它们当最终判定。毫秒时间戳文件名
 * `assets/1729400000000.png` 有 13 位连续数字 ⇒ 会被 `bank-card` 命中 ⇒ 学生看不到自己那张图在哪，
 * 而 §8.6 同时要求「每条命中给文件、行列、规则 ID、修复动作」。脱敏过度就是可解释性缺陷。
 *
 * 反过来不漏：真正的儿童 PII（邮箱、中国手机号、身份证号）与全部凭证形状都在 HIGH 档，一条不少。
 */
export function findPathSecretShape(text: string): LexiconEntry | undefined {
  return (
    firstMatch(text, CREDENTIAL_PATTERNS) ??
    firstMatch(
      text,
      PII_PATTERNS.filter((entry) => entry.tier === 'HIGH'),
    )
  );
}

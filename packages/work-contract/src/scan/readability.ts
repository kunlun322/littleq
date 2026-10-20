/**
 * 可读性度量（ZLQ-153 §8.3 B10「异常熵/不可读标识；压缩产物之外必须有可读源」）。
 *
 * 这里**只度量、不判定**：B10 的规则层拿到这些数字后，还要看「有没有对应的可读源」
 * （§2.4 的安全反例之一就是「可读源对应的 minified 构建文件」——那份文件本身熵高、行长，
 * 但它是合法的，因为 `work.json` 的 `sourceEntryPaths` 指向了它的可读源）。
 * 把度量与判定分开，才能让同一个数字在两种上下文里得出相反的结论，而不是把豁免写进度量里。
 *
 * **度量前必须先摘掉注释与字符串字面量**：§2.4 的另外三条安全反例（许可注释、长词典、base64 图片）
 * 全都是「注释或字符串很长」，如果不摘掉，一份完全可读的作品会因为一条 MIT 许可头被判成混淆。
 * 摘掉的方式是**用空格覆盖而不是删除**，这样行列结构保持不变，行数与行长仍然可以对着原文解释。
 */

import type { ReadabilityAssessment } from './analysis/model.js';

/** 原文里要从度量中排除的区间（注释、字符串字面量），半开 `[start, end)`。 */
export type ExcludedRange = { start: number; end: number };

/**
 * 混淆器产出的标识符形状。刻意**不**把「单字母变量」算进来：
 * `for (let i = 0; …)` 与 `ctx.fillRect(x, y, w, h)` 是教学代码里最常见、也最可读的写法，
 * 把它判成不可读会直接把误拦率顶上去（§8.6 的 ≤2% 约束）。
 */
const HEX_MANGLED = /^_0x[0-9a-f]{3,}$/i;
const DOLLAR_SLOT = /^\$\d{2,}$/;
const LONG_ASCII_RUN = /^[a-z0-9_$]{10,}$/i;
const MIXED_SOUP = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d]{12,}$/;

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/** `LONG_ASCII_RUN` 会命中 `backgroundImage` 这类正常复合词 ⇒ 用元音比例把它们排除掉。 */
function looksLikeRandomSoup(name: string): boolean {
  const letters = [...name].filter((char) => /[a-z]/i.test(char));
  if (letters.length === 0) return true;
  const vowelCount = letters.filter((char) => VOWELS.has(char.toLowerCase())).length;
  return vowelCount / letters.length < 0.2;
}

function isUnreadableIdentifier(name: string): boolean {
  if (name.length < 3) return false;
  if (HEX_MANGLED.test(name) || DOLLAR_SLOT.test(name) || MIXED_SOUP.test(name)) return true;
  return LONG_ASCII_RUN.test(name) && looksLikeRandomSoup(name);
}

/**
 * 用空格覆盖排除区间，保留换行 —— 行列结构不变，度量结果才能对着原文解释。
 * 排除区间必须已排序且不重叠（调用方从 AST 收集，天然有序）。
 * 按 UTF-16 下标拼接：`slice` 的下标与 `start`/`end` 同源，不会因为增补平面字符而错位。
 */
export function buildCodeOnlyText(source: string, excluded: readonly ExcludedRange[]): string {
  if (excluded.length === 0) return source;
  let out = '';
  let cursor = 0;
  for (const range of excluded) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, source.length);
    if (end <= start) continue;
    out += source.slice(cursor, start);
    out += blankPreservingNewlines(source.slice(start, end));
    cursor = end;
  }
  return out + source.slice(cursor);
}

function blankPreservingNewlines(text: string): string {
  let out = '';
  for (const char of text) out += char === '\n' || char === '\r' ? char : ' ';
  return out;
}

/** 去掉首尾空白后的每行代码长度。 */
function codeLineLengths(codeOnly: string): number[] {
  const lengths: number[] = [];
  for (const line of codeOnly.split(/\r\n|\r|\n/)) lengths.push(line.trim().length);
  return lengths;
}

/** Shannon 熵（bits/byte），按 UTF-8 字节直方图计算。 */
export function entropyBitsPerByte(text: string): number {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) return 0;
  const histogram = new Map<number, number>();
  for (const byte of bytes) histogram.set(byte, (histogram.get(byte) ?? 0) + 1);
  let entropy = 0;
  for (const count of histogram.values()) {
    const p = count / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(4));
}

export type ReadabilityInput = {
  source: string;
  /** 注释与字符串字面量的区间（AST 收集，已排序、不重叠）。 */
  excluded: readonly ExcludedRange[];
  /** AST 里出现的全部标识符名（含重复）。 */
  identifiers: readonly string[];
};

/** 单行压缩产物的判定阈值：平均代码行长超过它就认为「这份文件没有为人类排版」。 */
export const MINIFIED_AVERAGE_LINE_LENGTH = 400;
/** 熵阈值：正常 JS/CSS 在 4.0–5.0，base64 字符汤接近 6.0。 */
export const HIGH_ENTROPY_BITS_PER_BYTE = 5.5;
/** 熵判定的最小样本量，避免小文件因为字符集窄而被误判。 */
export const ENTROPY_MIN_CODE_BYTES = 512;
/** 不可读标识符比例阈值。 */
export const UNREADABLE_IDENTIFIER_RATIO = 0.3;
/** 比例判定的最小标识符数。 */
export const MIN_IDENTIFIERS_FOR_RATIO = 20;

export function assessReadability(input: ReadabilityInput): ReadabilityAssessment {
  const codeOnly = buildCodeOnlyText(input.source, input.excluded);
  const codeOnlyBytes = new TextEncoder().encode(codeOnly).length;
  const lineLengths = codeLineLengths(codeOnly);
  const lineCount = lineLengths.length;
  const maxLineLength = lineLengths.reduce((max, length) => Math.max(max, length), 0);
  const nonEmptyLines = lineLengths.filter((length) => length > 0);
  const averageCodeLineLength =
    nonEmptyLines.length === 0
      ? 0
      : Number(
          (nonEmptyLines.reduce((sum, length) => sum + length, 0) / nonEmptyLines.length).toFixed(
            2,
          ),
        );

  const identifierCount = input.identifiers.length;
  let unreadableIdentifierCount = 0;
  for (const name of input.identifiers)
    if (isUnreadableIdentifier(name)) unreadableIdentifierCount += 1;
  const unreadableIdentifierRatio =
    identifierCount === 0 ? 0 : Number((unreadableIdentifierCount / identifierCount).toFixed(4));

  const entropy = entropyBitsPerByte(codeOnly);

  const reasons: string[] = [];
  if (
    identifierCount >= MIN_IDENTIFIERS_FOR_RATIO &&
    unreadableIdentifierRatio > UNREADABLE_IDENTIFIER_RATIO
  ) {
    reasons.push(
      `unreadable-identifiers:${unreadableIdentifierCount}/${identifierCount}=${unreadableIdentifierRatio}`,
    );
  }
  if (codeOnlyBytes >= ENTROPY_MIN_CODE_BYTES && entropy > HIGH_ENTROPY_BITS_PER_BYTE) {
    reasons.push(`high-entropy:${entropy}bits/byte`);
  }
  if (
    codeOnlyBytes >= ENTROPY_MIN_CODE_BYTES &&
    averageCodeLineLength > MINIFIED_AVERAGE_LINE_LENGTH
  ) {
    reasons.push(`minified-layout:avgLine=${averageCodeLineLength}`);
  }

  return {
    codeOnlyBytes,
    lineCount,
    maxLineLength,
    averageCodeLineLength,
    identifierCount,
    unreadableIdentifierCount,
    unreadableIdentifierRatio,
    entropyBitsPerByte: entropy,
    unreadable: reasons.length > 0,
    reasons,
  };
}

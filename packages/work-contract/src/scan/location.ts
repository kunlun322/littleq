/**
 * 位置回映（ZLQ-156 §6.2：「line/column 从 1 开始，按**原始可读文件位置**回映，不用解码后文本位置骗人」）。
 *
 * 三个 parser 给的都是**原始文本**上的偏移/行列（acorn `node.start`、parse5 `sourceCodeLocationInfo.startOffset`、
 * postcss `node.source.start`），所以只要把偏移映射回原文行列就满足要求。
 * 二次解码（entity / base64 / 同形字折叠）产生的命中**没有可靠的原文范围**，
 * 按 §6.2 只能 `location = null`，由调用方把定位落在原始封装节点上。
 */

import type { SourceRange } from './types.js';

/** 预计算行起始偏移，供 O(log n) 反查。扫描器要在 ≤8 秒片段里反复定位，不能每次重新扫全文。 */
export class LineIndex {
  readonly #lineStarts: number[];
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\n') starts.push(index + 1);
      // \r\n 由 \n 分支处理；孤立的 \r 在 HTML/JS 里也是行结束符
      else if (char === '\r' && text[index + 1] !== '\n') starts.push(index + 1);
    }
    this.#lineStarts = starts;
  }

  get lineCount(): number {
    return this.#lineStarts.length;
  }

  get text(): string {
    return this.#text;
  }

  /** 二分找包含 `offset` 的行号（1 开始）。 */
  #lineAt(offset: number): number {
    const starts = this.#lineStarts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  /** 偏移 → 1 开始的行列。超出文本末尾的偏移夹到最后一个字符，不抛错（fail-safe，不是 fail-open）。 */
  position(offset: number): { line: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, this.#text.length));
    const line = this.#lineAt(clamped);
    const lineStart = this.#lineStarts[line - 1] ?? 0;
    return { line, column: clamped - lineStart + 1 };
  }

  /**
   * 1 开始的行列 → 偏移（`position` 的逆映射）。
   * postcss 只给行列不给偏移，而可读性度量要摘掉注释区间 ⇒ 必须能反算回偏移。
   * 越界的行列夹到文本范围内，不抛错。
   */
  offsetAt(line: number, column: number): number {
    const lineIndex = Math.max(1, Math.min(line, this.#lineStarts.length)) - 1;
    const lineStart = this.#lineStarts[lineIndex] ?? 0;
    const lineEnd = lineStart + this.lineLength(lineIndex + 1);
    return Math.max(lineStart, Math.min(lineStart + Math.max(column, 1) - 1, lineEnd));
  }

  range(startOffset: number, endOffset: number): SourceRange {
    const start = this.position(startOffset);
    const end = this.position(Math.max(endOffset, startOffset));
    return {
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
    };
  }

  /** 某一行是否超长（B10 的可读性判定用）。 */
  lineLength(lineNumber: number): number {
    const start = this.#lineStarts[lineNumber - 1];
    if (start === undefined) return 0;
    const next = this.#lineStarts[lineNumber];
    const end = next === undefined ? this.#text.length : next;
    // 不把行尾的 \n / \r 算进长度
    let trimmed = end;
    while (trimmed > start) {
      const char = this.#text[trimmed - 1];
      if (char === '\n' || char === '\r') trimmed -= 1;
      else break;
    }
    return trimmed - start;
  }

  totalLineLength(): number {
    let total = 0;
    for (let line = 1; line <= this.#lineStarts.length; line += 1) total += this.lineLength(line);
    return total;
  }
}

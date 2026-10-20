/**
 * HTTP Range 的解析、求解与回填。
 *
 * 独立成一份的原因：D4 的「Range 转发」验收不是「把请求头抄过去」，而是**无论上游认不认
 * Range，交给浏览器的响应都必须是合法的 206/200 语义**。这需要三件事各自可判定 ——
 * 解析客户端请求、按对象总长求解区间、把结果回填成 `Content-Range`。
 */

export type ByteRangeSpec =
  | { readonly kind: 'closed'; readonly start: number; readonly end: number }
  | { readonly kind: 'from'; readonly start: number }
  | { readonly kind: 'suffix'; readonly length: number };

const RANGE_HEADER = /^[ \t]*bytes[ \t]*=[ \t]*([^ \t;]+)[ \t]*$/;
const CLOSED_RANGE = /^(\d+)-(\d+)$/;
const OPEN_RANGE = /^(\d+)-$/;
const SUFFIX_RANGE = /^-(\d+)$/;

/**
 * 解析 `Range` 请求头。返回 `null` 表示形状非法，调用方必须以 416 语义拒绝。
 *
 * **多段 Range 一律返回 `null`**：`bytes=0-9,20-29` 把一次取回拆成多个字节区间，正是
 * 「用切片绕过大小预算」的形状。运行时只接受单段区间，于是「一次请求 = 一个连续区间 =
 * 一次可核算的字节数」。
 */
export function parseByteRangeSpec(header: string): ByteRangeSpec | null {
  const matched = RANGE_HEADER.exec(header);
  if (!matched) return null;
  const value = matched[1];
  if (value === undefined || value.includes(',')) return null;

  const closed = CLOSED_RANGE.exec(value);
  if (closed) {
    const start = Number(closed[1]);
    const end = Number(closed[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    return { kind: 'closed', start, end };
  }
  const open = OPEN_RANGE.exec(value);
  if (open) {
    const start = Number(open[1]);
    if (!Number.isSafeInteger(start)) return null;
    return { kind: 'from', start };
  }
  const suffix = SUFFIX_RANGE.exec(value);
  if (suffix) {
    const length = Number(suffix[1]);
    if (!Number.isSafeInteger(length) || length === 0) return null;
    return { kind: 'suffix', length };
  }
  return null;
}

/** 按对象总长把区间求解成闭区间 `[start, end]`；不可满足返回 `null`。 */
export function resolveByteRange(
  spec: ByteRangeSpec,
  totalBytes: number,
): { start: number; end: number } | null {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  const last = totalBytes - 1;
  if (spec.kind === 'suffix') {
    const start = Math.max(0, totalBytes - spec.length);
    return { start, end: last };
  }
  if (spec.start > last) return null;
  const end = spec.kind === 'closed' ? Math.min(spec.end, last) : last;
  if (spec.start > end) return null;
  return { start: spec.start, end };
}

export function formatContentRange(start: number, end: number, totalBytes: number): string {
  return `bytes ${start}-${end}/${totalBytes}`;
}

export interface ParsedContentRange {
  readonly start: number;
  readonly end: number;
  /** 上游用星号形式表示总长未知时 total 为 `null`；区间缺失时 start/end 为 -1，调用方据此判失配。 */
  readonly total: number | null;
}

const CONTENT_RANGE = /^bytes[ \t]+(?:(\d+)-(\d+)|\*)[ \t]*\/[ \t]*(\d+|\*)$/;

/** 解析上游 `Content-Range` 响应头；形状不合法返回 `null`。 */
export function parseContentRange(header: string | null): ParsedContentRange | null {
  if (header === null) return null;
  const matched = CONTENT_RANGE.exec(header.trim());
  if (!matched) return null;
  const total = matched[3] === '*' ? null : Number(matched[3]);
  if (total !== null && !Number.isSafeInteger(total)) return null;
  if (matched[1] === undefined || matched[2] === undefined) return { start: -1, end: -1, total };
  const start = Number(matched[1]);
  const end = Number(matched[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  return { start, end, total };
}

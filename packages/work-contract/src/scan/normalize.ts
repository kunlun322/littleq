/**
 * 规范化与二级解码 —— ZLQ-153 §8.3 收尾句的落地：
 *
 * > 扫描器必须检查混合编码、HTML entity、Unicode 同形字、字符串拼接与 base64 解码后的二级内容
 *
 * 「字符串拼接」不在这里：拼接是 JS AST 的常量折叠职责（`analysis/js.ts`），折叠出来的字面量再
 * 交给本模块的 `decodeToFixedPoint` 做二级解码。其余四类都在这里。
 *
 * 两条不可让步的性质：
 *
 * 1. **解码必须迭代到不动点**。`&amp;#106;avascript:` 只解一层得到 `&#106;avascript:`，
 *    看不出是 `javascript:`；混合编码的全部意义就是让单层解码失效。深度受
 *    `SECOND_LEVEL_DEPTH_LIMIT` 约束，成本计入累计预算（ZLQ-156 §6.4）。
 * 2. **解码失败要 fail-closed，不能猜**。不支持的字符编码返回 `PARSER_UNSUPPORTED`
 *    让上层报 ERROR，绝不退化成 latin1 硬解再当成「没有命中」（ZLQ-156 §6.2：语法损坏/不支持
 *    编码是 build/scan ERROR，不得洗成假 B10）。
 */
import { SECOND_LEVEL_CANDIDATE_BYTES, SECOND_LEVEL_DEPTH_LIMIT, type Budget } from './budget.js';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export type TextDecodeResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly encoding: TextEncoding;
      readonly hadBom: boolean;
    }
  | { readonly ok: false; readonly code: 'PARSER_UNSUPPORTED'; readonly reason: string };

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

export function decodePackageText(bytes: Uint8Array): TextDecodeResult {
  if (startsWith(bytes, UTF8_BOM)) {
    return decodeWith('utf-8', bytes.subarray(3), 'utf-8', true);
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return decodeWith('utf-16le', bytes.subarray(2), 'utf-16le', true);
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return decodeWith('utf-16be', bytes.subarray(2), 'utf-16be', true);
  }
  // 无 BOM：只接受严格 UTF-8。解不出来就是「不支持的编码」，不猜 GBK/Big5，也不按 latin1 硬解。
  const nulCount = countByte(bytes, 0);
  if (nulCount > 0 && nulCount >= bytes.length / 4) {
    return {
      ok: false,
      code: 'PARSER_UNSUPPORTED',
      reason: '疑似无 BOM 的 UTF-16 文本（NUL 字节占比过高），无法在不猜编码的前提下安全解码',
    };
  }
  return decodeWith('utf-8', bytes, 'utf-8', false);
}

function decodeWith(
  label: string,
  bytes: Uint8Array,
  encoding: TextEncoding,
  hadBom: boolean,
): TextDecodeResult {
  try {
    const text = new TextDecoder(label, { fatal: true }).decode(bytes);
    return { ok: true, text, encoding, hadBom };
  } catch {
    return {
      ok: false,
      code: 'PARSER_UNSUPPORTED',
      reason: `字节流不是合法的 ${encoding}（严格解码失败）；按 ZLQ-156 §6.2 报 ERROR，不降级为假命中`,
    };
  }
}

function countByte(bytes: Uint8Array, target: number): number {
  let count = 0;
  for (const byte of bytes) if (byte === target) count += 1;
  return count;
}

export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function nfc(text: string): string {
  return text.normalize('NFC');
}

// ---------------------------------------------------------------------------
// 不可见字符与双向控制字符
// ---------------------------------------------------------------------------

/** ZLQ-156 §1.2：拒绝 NUL/控制字符、双向控制字符。 */
const CONTROL_OR_BIDI =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

export function containsControlOrBidi(text: string): boolean {
  return CONTROL_OR_BIDI.test(text);
}

/**
 * 去掉零宽/双向控制/软连字符。`j\u200bavascript:` 与 `javascript:` 在判定上必须等价，
 * 否则插一个零宽空格就能绕过整条规则链。
 */
export function stripInvisible(text: string): string {
  return text.replace(
    /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
    '',
  );
}

// ---------------------------------------------------------------------------
// Unicode 同形字
// ---------------------------------------------------------------------------

/**
 * NFKC 覆盖不到的同形字（西里尔/希腊/拉丁扩展）。NFKC 本身已经处理全角
 * （`ｊａｖａｓｃｒｉｐｔ` → `javascript`）与全角冒号，这里补它管不了的部分。
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0455': 's',
  '\u0456': 'i',
  '\u0458': 'j',
  '\u04bb': 'h',
  '\u0501': 'd',
  '\u051b': 'q',
  '\u051d': 'w',
  '\u0578': 'n',
  '\u0251': 'a',
  '\u0261': 'g',
  '\u0269': 'i',
  '\u026f': 'm',
  '\u0287': 't',
  '\u029c': 'h',
  '\u03bd': 'v',
  '\u03bf': 'o',
  '\u03c1': 'p',
  '\u03c4': 't',
  '\u03b1': 'a',
  '\u03b2': 'b',
  '\u03b5': 'e',
  '\u03b6': 'z',
  '\u03ba': 'k',
  '\u03bc': 'u',
  '\u0410': 'A',
  '\u0412': 'B',
  '\u0415': 'E',
  '\u041a': 'K',
  '\u041c': 'M',
  '\u041d': 'H',
  '\u041e': 'O',
  '\u0420': 'P',
  '\u0421': 'C',
  '\u0422': 'T',
  '\u0425': 'X',
  '\u0405': 'S',
  '\u0406': 'I',
  '\u0408': 'J',
  '\u04ae': 'Y',
  '\u04c0': 'I',
};

/** 只做同形字替换，不改大小写、不做 NFKC —— 供 `nextLayer` 判断「这一层是否真的有变化」。 */
export function replaceConfusables(text: string): string {
  let replaced = '';
  for (const char of text) replaced += CONFUSABLES[char] ?? char;
  return replaced;
}

/**
 * 同形字折叠：先去不可见字符，再 NFKC，再逐字符替换同形字，最后 ASCII 小写化。
 * 这是「`ｊａｖａｓｃｒｉｐｔ：` / `јavascript:` 都必须和 `javascript:` 同判」的实现。
 *
 * 注意它**只用于判定**，不用于回填给儿童看的文本 —— summary 里的位置必须映射回原始可读文件
 * 的行列（ZLQ-156 §6.2），不是折叠后文本的行列。
 */
export function foldHomoglyphs(text: string): string {
  return replaceConfusables(stripInvisible(text).normalize('NFKC')).toLowerCase();
}

/** 折叠后是否含某个 ASCII 关键词（同形字/全角/零宽免疫）。 */
export function foldedIncludes(text: string, asciiKeyword: string): boolean {
  return foldHomoglyphs(text).includes(asciiKeyword.toLowerCase());
}

// ---------------------------------------------------------------------------
// HTML entity
// ---------------------------------------------------------------------------

/**
 * 命名实体表。**只覆盖能拼出危险 token 的那部分**，不追求 HTML5 全表：真实 HTML 文档里的
 * 实体由 parse5 的 AST 完整解码（spec 正确），本表服务的是**二级**场景 —— 在 JS 字面量、
 * 已解码属性值里再次出现实体编码的 payload。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  semi: ';',
  sol: '/',
  bsol: '\\',
  commat: '@',
  period: '.',
  comma: ',',
  excl: '!',
  quest: '?',
  num: '#',
  dollar: '$',
  percnt: '%',
  plus: '+',
  minus: '-',
  equals: '=',
  lowbar: '_',
  lpar: '(',
  rpar: ')',
  lbrack: '[',
  rbrack: ']',
  lbrace: '{',
  rbrace: '}',
  verbar: '|',
  tab: '\t',
  newline: '\n',
  lf: '\n',
  cr: '\r',
  sp: ' ',
  Tab: '\t',
  NewLine: '\n',
};

const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[a-zA-Z][a-zA-Z0-9]{1,31})(;?)/g;

/**
 * 解一层 HTML entity。数字引用在没有分号时也解（HTML5 在文本上下文里就是这么消费的，
 * `&#106avascript:` 必须能被看出来）；但当引用后面紧跟字母数字时保留原文，避免把
 * `&#x41bc` 这类普通文本过度解码成一个 CJK 码点。
 */
export function decodeHtmlEntitiesOnce(text: string): string {
  return text.replace(
    ENTITY_PATTERN,
    (match: string, body: string, semicolon: string, offset: number, whole: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return numericEntity(Number.parseInt(body.slice(2), 16), semicolon, offset, whole, match);
      }
      if (body.startsWith('#')) {
        return numericEntity(Number.parseInt(body.slice(1), 10), semicolon, offset, whole, match);
      }
      const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    },
  );
}

function numericEntity(
  code: number,
  semicolon: string,
  offset: number,
  whole: string,
  match: string,
): string {
  if (semicolon !== ';') {
    const next = whole[offset + match.length];
    if (next !== undefined && /[0-9a-zA-Z=]/.test(next)) return match;
  }
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
  try {
    return String.fromCodePoint(code);
  } catch {
    return match;
  }
}

// ---------------------------------------------------------------------------
// percent 编码
// ---------------------------------------------------------------------------

const PERCENT_PATTERN = /(?:%[0-9a-fA-F]{2})+/;

/**
 * 解一层 percent 编码。只有当整段 `%XX` 序列能解成合法 UTF-8 时才替换，
 * 否则保留原文（`100%25` 之类的普通文本不能被误解成控制字符）。
 */
export function percentDecodeOnce(text: string): string {
  if (!PERCENT_PATTERN.test(text)) return text;
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return run;
    }
  });
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

const BASE64_PATTERN = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/** 严格 UTF-8 可解码时返回字节，否则 null（base64 图片这类二进制 payload 因此天然出局）。 */
export function tryBase64ToText(candidate: string): string | null {
  const compact = candidate.replace(/\s+/g, '');
  if (!BASE64_PATTERN.test(compact)) return null;
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atobLatin1(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // 解出来必须「像文本」：含字母或 CJK。纯二进制碰巧通过 UTF-8 校验的情况要挡掉。
    return /[\p{L}\p{N}]/u.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * 自己实现 base64 解码而不用全局 `atob`：`atob` 在 Node 与浏览器都存在，但本包要在
 * `platform: 'browser'` 的 bundle 里也可解析，且需要对非法输入抛错而不是产生乱码。
 */
function atobLatin1(input: string): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bits = 0;
  let bitCount = 0;
  let out = '';
  for (const char of input) {
    if (char === '=') break;
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`非法 base64 字符 ${char}`);
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out += String.fromCharCode((bits >> bitCount) & 0xff);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 二级解码：迭代到不动点
// ---------------------------------------------------------------------------

export type DecodeTransform = 'entity' | 'percent' | 'base64' | 'invisible' | 'homoglyph';

export type DecodeLayer = {
  readonly depth: number;
  readonly transform: DecodeTransform;
  readonly text: string;
};

export type SecondLevelDecodeResult = {
  /** 原始候选（未做任何解码）。 */
  readonly original: string;
  /** 每一层解码产物，按深度递增。 */
  readonly layers: readonly DecodeLayer[];
  /** 所有层里出现过的文本（含 original），供规则做包含判定。 */
  readonly variants: readonly string[];
  /** 是否因为触到深度/字节上限而停止（触顶 = 不能宣称「已看完」）。 */
  readonly truncated: boolean;
};

/**
 * 快速判断「这个串有没有可能需要二级解码」。纯自然语言文本（哪怕很长）直接返回，
 * 既不花预算也不会因为「长词典/许可注释」这种合法长串把累计解码预算撑爆
 * （ZLQ-156 §2.4 B10 反例）。
 */
export function looksEncoded(text: string): boolean {
  if (text.length === 0) return false;
  if (text.includes('&') || text.includes('%')) return true;
  if (/[=;]\s*base64/i.test(text)) return true;
  // eslint-disable-next-line no-control-regex
  if (
    /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(
      text,
    )
  )
    return true;
  if (text !== text.normalize('NFKC')) return true;
  for (const char of text) if (char in CONFUSABLES) return true;
  return BASE64_PATTERN.test(text.replace(/\s+/g, ''));
}

/**
 * 把一个候选串迭代解码到不动点：entity → percent → base64 → 不可见字符 → 同形字，
 * 每一层都记下来，成本计入累计预算（ZLQ-156 §6.4：二次解析成本计入累计输入预算）。
 *
 * 深度或字节触顶时 `truncated = true`，调用方**不得**把 truncated 的结果当成「干净」。
 */
export function decodeToFixedPoint(candidate: string, budget: Budget): SecondLevelDecodeResult {
  const layers: DecodeLayer[] = [];
  const seen = new Set<string>([candidate]);
  let current = candidate;
  let truncated = false;

  for (let depth = 1; depth <= SECOND_LEVEL_DEPTH_LIMIT; depth += 1) {
    if (!looksEncoded(current)) break;
    if (current.length > SECOND_LEVEL_CANDIDATE_BYTES) {
      truncated = true;
      break;
    }
    budget.spend('secondLevelDecodes', 1);
    budget.spend('secondLevelDecodeBytes', current.length);

    const next = nextLayer(current);
    if (next === null) break;
    if (seen.has(next.text)) break;
    seen.add(next.text);
    layers.push({ depth, transform: next.transform, text: next.text });
    current = next.text;
    if (depth === SECOND_LEVEL_DEPTH_LIMIT) truncated = true;
  }

  return { original: candidate, layers, variants: [...seen], truncated };
}

function nextLayer(text: string): { transform: DecodeTransform; text: string } | null {
  const withoutInvisible = stripInvisible(text);
  if (withoutInvisible !== text) return { transform: 'invisible', text: withoutInvisible };

  const entityDecoded = decodeHtmlEntitiesOnce(withoutInvisible);
  if (entityDecoded !== withoutInvisible) return { transform: 'entity', text: entityDecoded };

  const percentDecoded = percentDecodeOnce(entityDecoded);
  if (percentDecoded !== entityDecoded) return { transform: 'percent', text: percentDecoded };

  const base64Candidate = extractBase64Candidate(percentDecoded);
  if (base64Candidate !== null) {
    const decoded = tryBase64ToText(base64Candidate);
    if (decoded !== null) return { transform: 'base64', text: decoded };
  }

  // 同形字层：只有 NFKC 或同形字替换真的改变了字符串才算一层。单纯的大小写差异不算
  // （大小写无关由 `foldHomoglyphs`/`foldedIncludes` 在判定侧负责，不是解码层的事）。
  const deconfused = replaceConfusables(percentDecoded.normalize('NFKC'));
  if (deconfused !== percentDecoded) {
    return { transform: 'homoglyph', text: deconfused.toLowerCase() };
  }
  return null;
}

/** `data:...;base64,XXXX` 与裸 base64 串都要能取到 payload。 */
export function extractBase64Candidate(text: string): string | null {
  const dataUrl = /;base64,([A-Za-z0-9+/=_-]{16,})/.exec(text);
  if (dataUrl?.[1]) return dataUrl[1];
  const compact = text.replace(/\s+/g, '');
  return BASE64_PATTERN.test(compact) ? compact : null;
}

/** 折叠空白并去首尾，用于文本类判定（B12/B13 的文案抽取）。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 把多行文本的第 n 个字符偏移换算成 1-based 行列（ZLQ-156 §6.2 要求映射回原始可读文件）。 */
export function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: limit - lineStart + 1 };
}

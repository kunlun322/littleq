/**
 * **载体串派生器** —— 从词库正则的 `source` 机械地反推出一个**必然命中**的字符串。
 *
 * ## 为什么需要它，而不是我手写违规文案
 *
 * ZLQ-156 §2.4 要求每条 B 规则 60 个违规案例，其中 B13 的 60 个要覆盖 9 个 HIGH 类目与
 * 7 个 LOW 类目、B8 要覆盖 8 个强线索与 3 个弱线索。这些类目对应的具体词条**冻结在
 * `scan/lexicon.ts` 里**，而词库是规则集的一部分：改一个词就是一次规则变更（§8.6）。
 * 如果我在语料里把违规文案**手抄一份**，那么词库一改，语料就与它要测的东西脱钩 ——
 * 而语料脱钩的表现恰好是「预期命中却没命中」，会被误读成扫描器漏检。
 *
 * 所以载体串一律**在生成时从 `entry.pattern.source` 反推**：
 * 词库变了，语料自动跟着变；语料的 `expectedByRule` 因此永远与词库同源。
 *
 * ## 这些串是有害内容，因此本模块有三条硬约束
 *
 * 1. **绝不打印**。`CarrierMismatchError` 的 message 只带 `entry.id`，不带 pattern、不带派生结果。
 *    违规样例的字节只落 `artifacts/corpus/**`（§7：一个字节都不提交），报告里也不出现源片段（§2.6）。
 * 2. **绝不缓存到模块级可变状态之外**。派生结果只活在单次生成过程里。
 * 3. **生成即断言**。`carrierFor` 内部 `pattern.test()` 不通过就抛，绝不允许
 *    「派生出一个其实不命中的串」然后把它当成预期 HARD_BLOCK 的样例 —— 那会同时污染
 *    检出率（假 FN）与 precision 分母。
 *
 * ## 支持的正则子集（已对全部 53 条内容类词条验证）
 *
 * 交替、非捕获/捕获组、字符类（含 `^` 取反与区间）、`.`、`{n}`/`{n,m}`/`{n,}`/`*`/`+`/`?`、
 * `\d\D\w\W\s\S`、`\b`、转义字面量。量词一律取 **min**（`*`/`?` 取 0）：载体串越短，
 * 越不会因为附带内容触发别的规则，单点变异的可归因性越好。`\b` 由 `resolveBoundaries`
 * 按「两侧词字符性必须不同」求解，求不出来就换一条分支重抽（见 `carrierFor` 的重试）。
 *
 * **不支持**（`parsePattern` 显式抛错，不静默降级）：环视 `(?=`/`(?!`/`(?<=`/`(?<!`、
 * 反向引用 `\1`、命名组 `(?<name>`、`\B`。词库里目前没有这些；哪天加了，这里会红，
 * 那时再来扩子集 —— 好过悄悄生成一个不命中的串。
 */

import type { LexiconEntry } from '../scan/lexicon.js';
import type { Random } from './random.js';

type Node =
  | { readonly kind: 'alt'; readonly branches: readonly Node[] }
  | { readonly kind: 'seq'; readonly items: readonly Node[] }
  | { readonly kind: 'repeat'; readonly item: Node; readonly min: number }
  | { readonly kind: 'class'; readonly negate: boolean; readonly ranges: readonly CodeRange[] }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'boundary' };

type CodeRange = readonly [lo: number, hi: number];

export class CarrierMismatchError extends Error {
  readonly code = 'CARRIER_MISMATCH';
  constructor(
    readonly entryId: string,
    reason: string,
  ) {
    // 故意不带 pattern.source 与派生结果：这两样都是有害内容的一部分。
    super(`载体串派生失败：entry=${entryId}，原因=${reason}`);
    this.name = 'CarrierMismatchError';
  }
}

export class UnsupportedPatternError extends Error {
  readonly code = 'UNSUPPORTED_PATTERN';
  constructor(
    readonly entryId: string,
    readonly feature: string,
  ) {
    super(`词库正则用到本派生器不支持的构造：entry=${entryId}，构造=${feature}`);
    this.name = 'UnsupportedPatternError';
  }
}

/** `.` 与「随便挑一个字符」时的默认取值：可打印 ASCII、且是 `\w`，方便满足 `\b`。 */
const DEFAULT_CHAR = 'a';
/** 取反字符类的候选池：覆盖大小写、数字、空格与常见标点，够用且都可打印。 */
const NEGATED_POOL =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.:/,;!?()[]{}<>"\'`~@#$%^&*+=|\\';
/** 可打印 ASCII 区间。命中它就把选字符的范围收窄到这里，避免生成控制字符。 */
const PRINTABLE: CodeRange = [0x20, 0x7e];

const PARSE_CACHE = new Map<string, Node>();

/**
 * 载体串的额外约束。
 *
 * 为什么需要它：不同规则的词表**可能重叠**。实测到的一个真实碰撞是 B13 的
 * `gambling-money`（赌博金钱）派生出的串同时命中 B12 的 `payment-claim`（付费宣称）——
 * 两个类目在语义上确实相邻。这时样例仍然该判 BLOCK（B13 自己就够），但报告里会多出
 * 一条**未声明的跨规则命中**，把它算成污染就会低估 B12 的 precision。
 *
 * 处理方式不是「把 B12 补进 `expectedOtherRules`」：那条碰撞取决于 `random` 抽到哪一分支，
 * 逐变体声明等于照着实测结果改期望（ZLQ-194 §16 点名的造假形状）。
 * 正确做法是**在生成期就避开**：`reject` 的判据是另一张**冻结词表**，
 * 与扫描器无关，所以 `provenance: 'ruleset-table'` 依然成立。
 */
export type CarrierConstraint = {
  /** 返回 true 就重抽。 */
  readonly reject?: (candidate: string) => boolean;
  /** 只进错误信息，不进内容。 */
  readonly rejectLabel?: string;
};

/**
 * 派生一个命中 `entry.pattern` 的载体串。
 *
 * `random` 决定交替分支与字符类里的具体取值，因此同一个 entry 在不同 caseId 下会得到不同写法
 * （§2.4「每条 60 案覆盖至少 6 种实现族，含正常写法、编码规范化、边界/别名」里的「变体」维度之一）。
 * 随机源本身由 `createRandom(corpusVersion, caseId, salt)` 固定种子驱动 ⇒ 整体可复现。
 *
 * `constraint.reject` 命中的候选同样走重试：换一条交替分支通常就能避开碰撞，
 * 32 次都避不开说明这个词条的**每一支**都与另一张表重叠，那是词表设计问题，
 * 抛出来比悄悄生成一个跨规则串扰的样例好。
 */
export function carrierFor(
  entry: LexiconEntry,
  random: Random,
  constraint?: CarrierConstraint,
): string {
  const node = parsePattern(entry.id, entry.pattern.source);
  let rejected = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const out: string[] = [];
    render(entry.id, node, random, out);
    let candidate: string;
    try {
      candidate = resolveBoundaries(out.join(''));
    } catch {
      // 这条分支的边界约束不可满足 ⇒ 再抽一次（换分支或换字符），绝不生成一个不命中的串。
      continue;
    }
    // 生成即断言：不命中的载体串绝不能进语料（见文件头第 3 条）。
    if (!entry.pattern.test(candidate)) continue;
    if (constraint?.reject?.(candidate)) {
      rejected += 1;
      continue;
    }
    return candidate;
  }
  throw new CarrierMismatchError(
    entry.id,
    rejected > 0
      ? `${MAX_ATTEMPTS} 次派生中 ${rejected} 次命中约束 ${constraint?.rejectLabel ?? '(未命名)'}，其余未命中词库`
      : `${MAX_ATTEMPTS} 次派生均未命中`,
  );
}

const MAX_ATTEMPTS = 32;
/** 渲染期的 `\b` 占位符：零宽断言不产生字符，留到 `resolveBoundaries` 处理。 */
const WORD_BOUNDARY = '\u0000';

class BoundaryUnsatisfiable extends Error {}

/**
 * 把占位符换成能真正让断言成立的字符（通常是空串；两侧都是词字符时是一个空格）。
 *
 * 规则来自 `\b` 的定义：只有当左右两侧的「词字符性」不同时该位置才是边界，串首/串尾按非词字符算。
 * 重试是**必要的**而不是兜底：量词一律取 min，于是 `nonce\s*=\s*0\b[\s\S]{0,200}sha-?256`
 * 会渲染成 `0` 直接贴 `sha` —— 词字符相邻，那个位置根本不是边界。这里补一个空格即可成立。
 * 补不了的情形（两侧都是非词字符且不在串首）抛 `BoundaryUnsatisfiable`，由 `carrierFor` 换分支。
 *
 * 注意**不能靠插字符绕过所有情形**：`\b` 是零宽的，插进去的字符会顶掉紧随其后的那个模式元素的匹配。
 * 只有「串首 + 下一个是非词字符」这一种能救 —— 前面补一个词字符不影响任何后续匹配
 * （词库里 `\b GA-[0-9A-Z]{6,}` 这一支正是这个形状：`\b` 后面直接跟一个空格）。
 */
function resolveBoundaries(raw: string): string {
  const out: string[] = [];
  let needsWordPrefix = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char !== WORD_BOUNDARY) {
      out.push(char);
      continue;
    }
    const previous = out[out.length - 1];
    const next = nextRealChar(raw, index);
    const previousIsWord = previous !== undefined && isWord(previous);
    const nextIsWord = next !== undefined && isWord(next);
    if (previousIsWord !== nextIsWord) continue; // 已经是边界
    if (previousIsWord && nextIsWord) {
      out.push(' '); // 词 → 空格：空格之前那个位置就是边界
      continue;
    }
    if (previous === undefined && next !== undefined) {
      needsWordPrefix = true;
      continue;
    }
    throw new BoundaryUnsatisfiable();
  }
  return needsWordPrefix ? `x${out.join('')}` : out.join('');
}

function nextRealChar(raw: string, from: number): string | undefined {
  for (let index = from + 1; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char !== WORD_BOUNDARY) return char;
  }
  return undefined;
}

function isWord(char: string): boolean {
  const code = char.codePointAt(0) as number;
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    code === 0x5f ||
    (code >= 0x61 && code <= 0x7a)
  );
}

/**
 * 断言 `text` 命中 `entry.pattern`。
 *
 * 变异模板把载体串嵌进 HTML/JS/CSS/manifest 之后必须过这一关：嵌入位置可能改变边界
 * （例如把 `\b` 包裹的词直接贴在另一个单词后面），那时载体串本身是对的、样例却是废的。
 */
export function assertCarries(entry: LexiconEntry, text: string): void {
  if (!entry.pattern.test(text)) {
    throw new CarrierMismatchError(entry.id, '嵌入后的文本不再命中词库');
  }
}

/** 按 id 取词条。取不到就抛：拼错 id 必须是硬失败，不能静默生成一个不测任何东西的样例。 */
export function entryById(
  entryId: string,
  table: readonly LexiconEntry[],
  tableName: string,
): LexiconEntry {
  const found = table.find((entry) => entry.id === entryId);
  if (found === undefined) {
    throw new Error(
      `词表 ${tableName} 里没有 id=${entryId}（现有：${table.map((e) => e.id).join(', ')}）`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function parsePattern(entryId: string, source: string): Node {
  const cached = PARSE_CACHE.get(source);
  if (cached !== undefined) return cached;
  const parser = new PatternParser(entryId, source);
  const node = parser.parseAlternation();
  parser.expectEnd();
  PARSE_CACHE.set(source, node);
  return node;
}

class PatternParser {
  private position = 0;

  constructor(
    private readonly entryId: string,
    private readonly source: string,
  ) {}

  parseAlternation(): Node {
    const branches: Node[] = [this.parseSequence()];
    while (this.peek() === '|') {
      this.position += 1;
      branches.push(this.parseSequence());
    }
    return branches.length === 1 ? (branches[0] as Node) : { kind: 'alt', branches };
  }

  expectEnd(): void {
    if (this.position !== this.source.length) {
      throw new UnsupportedPatternError(this.entryId, `位置 ${this.position} 处有未消费的构造`);
    }
  }

  private parseSequence(): Node {
    const items: Node[] = [];
    for (;;) {
      const next = this.peek();
      if (next === null || next === '|' || next === ')') break;
      items.push(this.parseQuantified());
    }
    return { kind: 'seq', items };
  }

  private parseQuantified(): Node {
    const atom = this.parseAtom();
    const min = this.parseQuantifier();
    return min === null ? atom : { kind: 'repeat', item: atom, min };
  }

  /** 返回量词的 **min**；没有量词返回 `null`。惰性后缀 `?` 一并吃掉（生成时不区分）。 */
  private parseQuantifier(): number | null {
    const next = this.peek();
    let min: number | null = null;
    if (next === '*' || next === '+' || next === '?') {
      this.position += 1;
      min = next === '+' ? 1 : 0;
    } else if (next === '{') {
      const parsed = this.tryParseBraces();
      if (parsed !== null) min = parsed;
    }
    if (min === null) return null;
    if (this.peek() === '?') this.position += 1;
    return min;
  }

  /** `{n}`/`{n,}`/`{n,m}` → `n`。不是合法量词就原样当字面量（正则语义也是如此）。 */
  private tryParseBraces(): number | null {
    const rest = this.source.slice(this.position);
    const match = /^\{(\d+)(?:(,)(\d*)?)?\}/.exec(rest);
    if (match === null) return null;
    this.position += match[0].length;
    return Number(match[1]);
  }

  private parseAtom(): Node {
    const char = this.peek();
    if (char === null) throw new UnsupportedPatternError(this.entryId, '意外的模式结尾');
    if (char === '(') return this.parseGroup();
    if (char === '[') return this.parseClass();
    if (char === '.') {
      this.position += 1;
      return { kind: 'text', text: DEFAULT_CHAR };
    }
    if (char === '\\') return this.parseEscape();
    this.position += 1;
    return { kind: 'text', text: char };
  }

  private parseGroup(): Node {
    this.position += 1; // '('
    if (this.source.startsWith('?', this.position)) {
      const marker = this.source[this.position + 1];
      if (marker === '=' || marker === '!' || marker === '<') {
        throw new UnsupportedPatternError(this.entryId, `(?${marker}`);
      }
      if (marker !== ':') {
        throw new UnsupportedPatternError(this.entryId, `(?${marker ?? '?'}`);
      }
      this.position += 2; // '?:'
    }
    const node = this.parseAlternation();
    if (this.peek() !== ')') throw new UnsupportedPatternError(this.entryId, '组未闭合');
    this.position += 1;
    return node;
  }

  private parseClass(): Node {
    this.position += 1; // '['
    const negate = this.peek() === '^';
    if (negate) this.position += 1;
    const ranges: CodeRange[] = [];
    // `[]]` 里的第一个 `]` 是字面量；这里按 ECMAScript 语义处理。
    let first = true;
    for (;;) {
      const char = this.peek();
      if (char === null) throw new UnsupportedPatternError(this.entryId, '字符类未闭合');
      if (char === ']' && !first) {
        this.position += 1;
        break;
      }
      first = false;
      const lo = this.parseClassAtom();
      if (this.peek() === '-' && this.source[this.position + 1] !== ']') {
        this.position += 1;
        const hi = this.parseClassAtom();
        ranges.push([Math.min(lo, hi), Math.max(lo, hi)]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    return { kind: 'class', negate, ranges };
  }

  /** 字符类里的转义。`\b` 在类内是退格符而不是边界（ECMAScript 语义），这里单独处理。 */
  private parseClassAtom(): number {
    const char = this.source[this.position] as string;
    if (char !== '\\') {
      this.position += 1;
      return char.codePointAt(0) as number;
    }
    const expanded = this.expandEscape();
    if (expanded.kind === 'set') {
      // `\d` 一类在字符类里等价于它自己的区间集。这里只取区间下界：类内出现 `\d` 时它总是
      // 与别的字符并列，取哪个码位都能让整个类命中，而取下界是确定性的。
      this.position += 2;
      return expanded.ranges[0]?.[0] ?? 0x30;
    }
    this.position += expanded.kind === 'boundary' ? 2 : expanded.length;
    return expanded.kind === 'boundary' ? 0x08 : expanded.code;
  }

  private parseEscape(): Node {
    const expanded = this.expandEscape();
    if (expanded.kind === 'set') {
      this.position += 2;
      return { kind: 'class', negate: expanded.negate, ranges: expanded.ranges };
    }
    if (expanded.kind === 'boundary') {
      this.position += 2;
      return { kind: 'boundary' };
    }
    this.position += expanded.length;
    return { kind: 'text', text: String.fromCodePoint(expanded.code) };
  }

  private expandEscape():
    | { kind: 'code'; code: number; length: number }
    | { kind: 'set'; negate: boolean; ranges: readonly CodeRange[] }
    | { kind: 'boundary' } {
    const marker = this.source[this.position + 1];
    if (marker === undefined) {
      throw new UnsupportedPatternError(this.entryId, '模式以孤立的反斜杠结尾');
    }
    switch (marker) {
      case 'd':
        return { kind: 'set', negate: false, ranges: [[0x30, 0x39]] };
      case 'D':
        return { kind: 'set', negate: true, ranges: [[0x30, 0x39]] };
      case 'w':
        return { kind: 'set', negate: false, ranges: WORD_RANGES };
      case 'W':
        return { kind: 'set', negate: true, ranges: WORD_RANGES };
      case 's':
        return { kind: 'set', negate: false, ranges: [[0x20, 0x20]] };
      case 'S':
        return { kind: 'set', negate: true, ranges: [[0x20, 0x20]] };
      case 'b':
        return { kind: 'boundary' };
      case 'B':
        // 词库里目前没有 `\B`。与其写一个我无法用真实词条验证的分支，不如显式拒绝：
        // 哪天词库加了它，这里会红，那时再按真实形状实现。
        throw new UnsupportedPatternError(this.entryId, '\\B');
      case 'n':
        return { kind: 'code', code: 0x0a, length: 2 };
      case 't':
        return { kind: 'code', code: 0x09, length: 2 };
      case 'r':
        return { kind: 'code', code: 0x0d, length: 2 };
      case 'f':
        return { kind: 'code', code: 0x0c, length: 2 };
      case 'v':
        return { kind: 'code', code: 0x0b, length: 2 };
      case '0':
        return { kind: 'code', code: 0x30, length: 2 };
      default:
        break;
    }
    if (marker === 'u') {
      const hex = this.source.slice(this.position + 2, this.position + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { kind: 'code', code: Number.parseInt(hex, 16), length: 6 };
      }
    }
    if (marker === 'x') {
      const hex = this.source.slice(this.position + 2, this.position + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        return { kind: 'code', code: Number.parseInt(hex, 16), length: 4 };
      }
    }
    // 其余 `\X` 一律是字面量 X（`\.`、`\+`、`\/`、`\-`、`\\` 等）。
    return { kind: 'code', code: marker.codePointAt(0) as number, length: 2 };
  }

  private peek(): string | null {
    return this.position < this.source.length ? (this.source[this.position] as string) : null;
  }
}

const WORD_RANGES: readonly CodeRange[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

function render(entryId: string, node: Node, random: Random, out: string[]): void {
  switch (node.kind) {
    case 'alt':
      render(entryId, random.pick(node.branches), random, out);
      return;
    case 'seq':
      for (const item of node.items) render(entryId, item, random, out);
      return;
    case 'repeat':
      // 取 min：`*`/`?` 直接生成空。载体串越短越不容易附带触发别的规则。
      for (let index = 0; index < node.min; index += 1) {
        render(entryId, node.item, random, out);
      }
      return;
    case 'boundary':
      out.push(WORD_BOUNDARY);
      return;
    case 'text':
      out.push(node.text);
      return;
    case 'class':
      out.push(pickFrom(entryId, node, random));
      return;
  }
}

function pickFrom(entryId: string, node: Extract<Node, { kind: 'class' }>, random: Random): string {
  if (node.negate) {
    const pool = [...NEGATED_POOL].filter(
      (char) => !node.ranges.some(([lo, hi]) => within(char.codePointAt(0) as number, lo, hi)),
    );
    if (pool.length === 0) throw new CarrierMismatchError(entryId, '取反字符类没有可用候选');
    return random.pick(pool);
  }
  const clipped = node.ranges
    .map((range) => clipToPrintable(range))
    .filter((range): range is CodeRange => range !== null);
  const usable = clipped.length > 0 ? clipped : node.ranges;
  if (usable.length === 0) throw new CarrierMismatchError(entryId, '字符类为空');
  const [lo, hi] = random.pick(usable);
  return String.fromCodePoint(random.between(lo, hi));
}

function clipToPrintable(range: CodeRange): CodeRange | null {
  const lo = Math.max(range[0], PRINTABLE[0]);
  const hi = Math.min(range[1], PRINTABLE[1]);
  return lo <= hi ? [lo, hi] : null;
}

function within(code: number, lo: number, hi: number): boolean {
  return code >= lo && code <= hi;
}

// 两个静态门禁（tools/check-unit-readiness.mjs 与 tools/check-dependency-graph.mjs）
// 都要在源码里找说明符与标记词，也都会被注释里的说明文字误伤，所以剥离逻辑必须是同一份：
// 两处各写一遍的话，同一个文件在两道门里会得出不同的判定，而这种分歧不会报错，只会静默地
// 让其中一道门漏判。
//
// 之所以放在 lib 而不是让 dep-graph 从 readiness 导入：readiness 已经从 dep-graph 导入
// globToRegExp，反向再导入一次就是循环依赖。

// ---------------------------------------------------------------------------
// 注释剥离。
//
// 反撒谎门要扫「具名实现标记」，退役禁令要扫 `.skip`/`.todo`，受控边要判定
// `import 'server-only'` 是否真的存在，三者都会被注释里的说明文字误伤：
// packages/infra/src/index.ts 的头注释就写着 `DatabaseAdapter` / `TaskRepository` /
// `drivers/*`，tools/test/ci-workflow.test.mjs 里也有一行「刻意不用 describe.skip / skipIf」，
// 而依赖图夹具里解释「本文件故意少了 server-only」的那句话本身就写着
// `import 'server-only';` —— 不剥注释，扫描器会把那句解释当成真的导入，
// 于是「少了构建期兜底」这一条永远抓不到。
//
// 逐字符扫描并把注释替换成等长空格（换行保留），这样后续所有行号计算仍然对得上原文。
// 字符串/模板串/正则字面量里的 `//` 与 `/*` 不算注释开头。
// ---------------------------------------------------------------------------
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function regexMayStartHere(code, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(code[i])) i -= 1;
  if (i < 0) return true;
  const char = code[i];
  if (/[A-Za-z0-9_$)\]]/.test(char)) {
    // 前面是一个标识符或关键字：只有特定关键字之后 `/` 才是正则开头，否则是除号。
    let end = i + 1;
    let start = i;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(code[start])) start -= 1;
    return REGEX_PRECEDING_KEYWORDS.has(code.slice(start + 1, end));
  }
  return true;
}

// 用一个模式栈而不是递归：code 帧里遇到反引号压入 template 帧，template 帧里遇到 `${`
// 再压一个 code 帧（记下自己的花括号深度），深度归零后的第一个 `}` 弹回 template。
// 注释字节被替换成空格、`${` 与其配对的 `}` 也一并抹平，因此长度与换行都不变 —— 后面所有
// 行号计算和花括号配对仍然对得上原文。字符串内容原样保留：门 3 要靠它在测试文件里找到
// 能力名（能力名通常写在 `it('...')` 的标题里），受控边也靠它读到 `'server-only'` 这个说明符。
export function stripComments(code) {
  const out = code.split('');
  const stack = [{ kind: 'code', braces: 0 }];
  let i = 0;

  while (i < code.length) {
    const frame = stack[stack.length - 1];
    const char = code[i];
    const next = code[i + 1];

    if (frame.kind === 'template') {
      if (char === '\\') i += 2;
      else if (char === '`') {
        stack.pop();
        i += 1;
      } else if (char === '$' && next === '{') {
        stack.push({ kind: 'code', braces: 0 });
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      } else i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < code.length) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i += 1;
        if (code[i] === '\n') break; // 未闭合的字符串：不把余下整份文件当成字符串吞掉
        i += 1;
      }
      i += 1;
      continue;
    }
    if (char === '`') {
      stack.push({ kind: 'template' });
      i += 1;
      continue;
    }
    if (char === '/' && regexMayStartHere(code, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < code.length) {
        const c = code[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break; // 正则不跨行：这个 `/` 其实是除号
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        i = j + 1;
        while (i < code.length && /[a-z]/.test(code[i])) i += 1; // flags
      } else i += 1;
      continue;
    }
    if (char === '{') {
      frame.braces += 1;
      i += 1;
      continue;
    }
    if (char === '}') {
      if (frame.braces === 0 && stack.length > 1) {
        stack.pop();
        out[i] = ' ';
      } else if (frame.braces > 0) frame.braces -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

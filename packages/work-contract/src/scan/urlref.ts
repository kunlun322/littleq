/**
 * URL / 资源引用规范化与分类（ZLQ-153 §8.3 B1：「URL 规范化后仅允许包内相对路径或受限 `data/blob`」）。
 *
 * **规范化必须在分类之前**，否则这些都能绕过：
 * - `&#106;avascript:alert(1)`（HTML 实体，且**没有分号**）
 * - `java&#9;script:` / `j\u200bavascript:`（制表符、零宽空格）
 * - `ｊａｖａｓｃｒｉｐｔ：`（全角 + 全角冒号）
 * - `jav%61script:`（百分号编码）
 * - `//evil.example/x.js`（协议相对，按页面 scheme 解析成外部资源）
 *
 * 这正是 §8.3 收尾句「扫描器必须检查混合编码、HTML entity、Unicode 同形字、字符串拼接与 base64
 * 解码后的二级内容」在 URL 上的落地：走 `normalize.ts` 的定点解码，再判定。
 */

import type { Budget } from './budget.js';
import { ALLOWED_DATA_MEDIA_TYPES, SCRIPT_SCHEME_PATTERN } from './lexicon.js';
import { decodeToFixedPoint, stripInvisible } from './normalize.js';

export type UrlReferenceKind =
  /** 空串或纯空白：不是引用。 */
  | 'empty'
  /** `#section`：页内锚点，包内。 */
  | 'fragment-only'
  /** `assets/a.png` / `./a.js`：包内相对路径，需要在资源图里验证存在。 */
  | 'internal-relative'
  /** `data:image/png;base64,…`：受限允许（§8.3 B1）。 */
  | 'data-allowed'
  /** `data:` 但媒体类型不在受限表内，或解码失败。 */
  | 'data-forbidden'
  /** 源码里写死的 `blob:` 字面量：运行时不可能解析成功（blob URL 是会话级的）。 */
  | 'blob-literal'
  /** `javascript:` / `vbscript:` / `data:text/html`：归 B10（动态执行）。 */
  | 'script-scheme'
  /** `https://…` / `http://…`：外部资源。 */
  | 'absolute-external'
  /** `//host/path`：协议相对，等价于外部资源。 */
  | 'protocol-relative'
  /** 其余 scheme（`mailto:` `tel:` `ws:` `ftp:` `file:` `intent:` …）。 */
  | 'scheme-not-allowed';

export type UrlClassification = {
  kind: UrlReferenceKind;
  /** 定点解码 + 去不可见字符后的形态，仅内部使用；**绝不进 explanation**（§6.2）。 */
  normalized: string;
  /** `internal-relative` 时为去掉 query/fragment 的相对路径。 */
  relativePath: string | null;
  /** `absolute-external` / `protocol-relative` 时的 host（同形字折叠后的小写），供 B9/B11 域名判定。 */
  host: string | null;
  /** `data-allowed` / `data-forbidden` 时的媒体类型。 */
  dataMediaType: string | null;
  /** 定点解码是否被预算或深度截断。截断的引用**不得**当作干净（§6.4）。 */
  truncated: boolean;
};

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

/**
 * URL 里出现的 ASCII 控制字符与空白是经典的 scheme 绕过载体（`java\tscript:`）。
 * HTML 标准在解析 URL 时会剥掉 C0 控制字符与空格；这里同样剥掉，**在**分类之前。
 */
function stripUrlSeparators(text: string): string {
  return text.replace(/[\u0000-\u0020\u007f]/g, '');
}

function parseDataUrl(normalized: string): { mediaType: string | null; allowed: boolean } {
  // data:[<mediatype>][;base64],<data>
  const comma = normalized.indexOf(',');
  const header =
    comma >= 0 ? normalized.slice('data:'.length, comma) : normalized.slice('data:'.length);
  const withoutBase64 = header.replace(/;base64$/i, '');
  const mediaType = withoutBase64 === '' ? 'text/plain' : withoutBase64.toLowerCase();
  return { mediaType, allowed: ALLOWED_DATA_MEDIA_TYPES.includes(mediaType) };
}

function parseHost(authority: string): string | null {
  const withoutUserInfo = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority;
  const withoutPort = withoutUserInfo.replace(/:\d*$/, '');
  return withoutUserInfo === '' ? null : withoutPort.toLowerCase();
}

/**
 * 分类一个引用值。`budget` 用于给二次解码计费（§6.4：base64/实体/同形字/拼接的二次解析成本计入累计输入预算）。
 */
export function classifyUrlReference(raw: string, budget: Budget): UrlClassification {
  const decoded = decodeToFixedPoint(raw, budget);
  const normalized = stripUrlSeparators(
    stripInvisible(decoded.variants[decoded.variants.length - 1] ?? raw),
  );
  const base: Omit<UrlClassification, 'kind'> = {
    normalized,
    relativePath: null,
    host: null,
    dataMediaType: null,
    truncated: decoded.truncated,
  };

  if (normalized === '') return { ...base, kind: 'empty' };

  if (normalized.startsWith('#')) return { ...base, kind: 'fragment-only' };

  if (SCRIPT_SCHEME_PATTERN.test(normalized)) {
    return { ...base, kind: 'script-scheme' };
  }

  if (/^data:/i.test(normalized)) {
    const data = parseDataUrl(normalized);
    return {
      ...base,
      kind: data.allowed ? 'data-allowed' : 'data-forbidden',
      dataMediaType: data.mediaType,
    };
  }

  if (/^blob:/i.test(normalized)) return { ...base, kind: 'blob-literal' };

  if (normalized.startsWith('//')) {
    const rest = normalized.slice(2);
    const slash = rest.indexOf('/');
    const authority = slash >= 0 ? rest.slice(0, slash) : rest;
    return { ...base, kind: 'protocol-relative', host: parseHost(authority) };
  }

  const scheme = SCHEME_PATTERN.exec(normalized);
  if (scheme) {
    const name = (scheme[1] ?? '').toLowerCase();
    if (name === 'http' || name === 'https') {
      const rest = normalized.slice(name.length + 3);
      const slash = rest.indexOf('/');
      const authority = slash >= 0 ? rest.slice(0, slash) : rest;
      return { ...base, kind: 'absolute-external', host: parseHost(authority) };
    }
    return { ...base, kind: 'scheme-not-allowed' };
  }

  const withoutFragment = normalized.split('#')[0] ?? '';
  const relativePath = withoutFragment.split('?')[0] ?? '';
  if (relativePath === '') return { ...base, kind: 'fragment-only' };
  return { ...base, kind: 'internal-relative', relativePath };
}

/**
 * 把相对引用解析成包内规范路径。返回 `null` 表示越根（§8.1「路径不得越界」）。
 *
 * `fromFile` 是引用所在文件的路径（`index.html`、`styles/main.css`）；引用相对它所在**目录**解析。
 */
export function resolvePackagePath(fromFile: string, reference: string): string | null {
  const directory = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const segments = directory === '' ? [] : directory.split('/');
  for (const part of reference.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) return null;
  return segments.join('/');
}

/**
 * 解析 `srcset`：`url descriptor, url descriptor, …`。
 * 描述符里的逗号属于语法，URL 里的逗号必须百分号编码 —— 所以按顶层逗号切分是安全的。
 */
export function parseSrcset(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter((candidate) => candidate !== '');
}

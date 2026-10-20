/**
 * 分析派发：一份已解码的文件 → 一棵 AST 摘要（ZLQ-153 §8.3「扫描基于 HTML AST、CSS AST、
 * JavaScript AST 与资源图」的入口）。
 *
 * 两条设计约束：
 * 1. **派发只认准入表的 `kind`，不认扩展名**。§1.3 要求 mediaType 与扩展名一致，那是 metadata
 *    层的责任；这里再按扩展名派发一次，就会出现「声明 text/html、扩展名 .txt」时两套判定打架。
 *    唯一的例外是 SVG：它 `kind === 'image'` 但 §1.3 逐字要求按可执行输入扫描，所以按 **mediaType**
 *    （准入表里的那一个字符串，不是扩展名）单独分流，见 `isTextualMediaType`。
 * 2. **不可解码不静默**。文本形态却拿不到 `text` ⇒ `parseError = 'undecodable-text'`，由扫描器
 *    升级成 `PARSER_UNSUPPORTED` ERROR（§6.2「不支持编码是 ERROR」）。绝不降级成「空文件、通过」。
 */

import type { Budget } from '../budget.js';
import { hasExifGps } from '../exif.js';
import { LineIndex } from '../location.js';
import { admittedMediaType } from '../metadata.js';
import { analyzeCss } from './css.js';
import { analyzeHtml } from './html.js';
import { analyzeJavaScript } from './js.js';
import type { OpaqueParseSummary, ParseSummary } from './model.js';

/** 准入表里 `kind === 'image'` 却必须按文本解析的那一个（ZLQ-156 §1.3，判据见 `isTextualMediaType`）。 */
const SVG_MEDIA_TYPE = 'image/svg+xml';

/**
 * 这个 mediaType 是否需要先解码成文本。
 *
 * 驱动的 NORMALIZE 相位与这里的派发**必须用同一个判据**，否则会出现「按二进制读进来、
 * 按文本派发」或反过来的裂缝：前者让 `analyzeFile` 拿到 `text: null` 而报 `undecodable-text`，
 * 后者让一份 HTML 被当成图片跳过全部十三条规则。所以判据只在这里定义一次并导出。
 *
 * 不能由 `kind` 推导：SVG 的 `kind` 是 `image`，但 ZLQ-156 §1.3 逐字要求
 * 「SVG 同样作为可执行风险输入扫描」—— 一个内嵌 `<script>` 或 `onload=` 的 `.svg`
 * 若按二进制处理，它对 B1/B2/B10 完全不可见。
 */
export function isTextualMediaType(mediaType: string): boolean {
  const admitted = admittedMediaType(mediaType);
  if (!admitted) return false;
  if (mediaType === SVG_MEDIA_TYPE) return true;
  return (
    admitted.kind === 'html' ||
    admitted.kind === 'css' ||
    admitted.kind === 'js' ||
    admitted.kind === 'json' ||
    admitted.kind === 'text'
  );
}

export type AnalyzeFileInput = {
  path: string;
  /** manifest 声明的 mediaType（已通过 §1.3 的准入表与扩展名校验）。 */
  mediaType: string;
  /** 整份文件字节。只有图片元数据（B13 的 EXIF GPS）需要它。 */
  bytes: Uint8Array;
  /** 文本形态已解码的内容；二进制为 null。 */
  text: string | null;
  budget: Budget;
};

/** `text` 为 null 但准入表说它本该是文本 ⇒ 「读不通」，不是「没有内容」。 */
function undecodable(
  input: AnalyzeFileInput,
  kind: OpaqueParseSummary['kind'],
): OpaqueParseSummary {
  return {
    kind,
    path: input.path,
    text: null,
    textLocation: null,
    exifGps: null,
    parseError: 'undecodable-text',
  };
}

export function analyzeFile(input: AnalyzeFileInput): ParseSummary {
  // mediaType 不在准入表里时，上游（metadata 校验）已经产出 finding；这里按二进制兜底，
  // 不再造第二套解释，避免同一处缺陷被两条规则重复报告。
  const admitted = admittedMediaType(input.mediaType);
  if (!admitted) {
    return {
      kind: 'binary',
      path: input.path,
      text: null,
      textLocation: null,
      exifGps: null,
      parseError: null,
    };
  }

  // ZLQ-156 §1.3「SVG 同样作为可执行风险输入扫描」：SVG 的准入 kind 是 image，
  // 但它是文本，必须走 HTML 解析器，否则内嵌 `<script>` / `onload=` / `xlink:href` 全部不可见。
  // 已声明的局限：用的是 HTML 解析器而不是 XML 解析器（本包不引入第四个解析器，§7 禁止新增依赖），
  // 所以 XML 实体展开、CDATA、命名空间前缀绑定不建模；`<script>` 正文按 HTML raw-text 取。
  if (input.mediaType === SVG_MEDIA_TYPE) {
    return input.text === null
      ? undecodable(input, 'text')
      : analyzeHtml({ path: input.path, source: input.text, budget: input.budget });
  }

  switch (admitted.kind) {
    case 'html':
      return input.text === null
        ? undecodable(input, 'text')
        : analyzeHtml({ path: input.path, source: input.text, budget: input.budget });
    case 'css':
      return input.text === null
        ? undecodable(input, 'text')
        : analyzeCss({ path: input.path, source: input.text, budget: input.budget });
    case 'js':
      // 独立 `.js` 不指定 sourceType：`parseJavaScript` 先按 module 试、失败再按 script 试，
      // 两种都能解析的取 module（顶层 `import` 只有 module 能过）。
      return input.text === null
        ? undecodable(input, 'text')
        : analyzeJavaScript({ path: input.path, source: input.text, budget: input.budget });
    case 'json':
    case 'text': {
      const kind = admitted.kind;
      if (input.text === null) return undecodable(input, kind);
      const lines = new LineIndex(input.text);
      return {
        kind,
        path: input.path,
        text: input.text,
        textLocation: lines.range(0, input.text.length),
        exifGps: null,
        parseError: null,
      };
    }
    default:
      // image / audio / video / font：只有图片带 EXIF，其余形态问 GPS 没有意义。
      return {
        kind: 'binary',
        path: input.path,
        text: null,
        textLocation: null,
        exifGps: admitted.kind === 'image' ? hasExifGps(input.bytes) : null,
        parseError: null,
      };
  }
}

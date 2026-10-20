/**
 * 安全样例的「合法但易误判」覆盖层（ZLQ-156 §2.2 的必须覆盖清单 + §2.4 各规则的「合法反例」列）。
 *
 * §2.2 原文要求安全集必须覆盖：hash 路由、history 状态、不依赖 rewrite、模板字符串、多文件依赖、
 * **内联 CSP hash**、**合法 data/blob**、键盘/触屏、**许可注释**、**可读源 + minified 产物**。
 * 前六项由 `templates.ts` 的五个结构家族承担，后四项由本文件的覆盖层承担 —— 因为它们是
 * 「加料」而不是「换骨架」，挂在骨架上比复制五份骨架便宜得多，也不会让家族数虚增。
 *
 * ## 覆盖层绝不占用注入槽
 *
 * 违规样例的判据是「与它的安全对照只差一处」，而那一处就是注入槽。所以覆盖层只往
 * **槽标记之外**的位置加内容（文件头、`<h1>` 之后、CSS 末尾、新增文件），
 * `fillSlot` 的 `replace(marker, …)` 因此永远还能找到标记。
 * `applyOverlay` 末尾那条断言就是把这件事钉住：槽标记在覆盖之后必须仍然在。
 */

import {
  corpusPng,
  corpusPngDataUrl,
  corpusWoff2,
  sha256Base64,
  type CorpusFile,
} from './package.js';
import { SLOT_IDS, type SafeBase, type SlotId, type TechTag } from './templates.js';

/**
 * 不可读的压缩产物。
 *
 * 与 `test/support.ts` 的 `obfuscatedJs` 同一手法，理由也相同：`readability.ts` 度量前会先把
 * 注释与字符串字面量用空格覆盖掉（否则一条 MIT 许可头就能把一份可读作品判成混淆），
 * 所以字符串汤进不了度量 —— 必须用**标识符**制造不可读。
 * 熵与行长两条判据都要求 ≥512 字节代码，标识符比例那条要求 ≥20 个标识符。
 */
export function corpusMinifiedJs(seed: number): string {
  const lines: string[] = [];
  for (let index = 0; index < 24; index += 1) {
    lines.push(`const _0x${(0xabc100 + index * 7 + seed).toString(16)} = ${index + seed};`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 一份**合法**的作品内 CSP。
 *
 * 关键是它不能把 Runtime 冻结的那一份放宽：B2 查 `connect-src`、B5 查 `form-action`，
 * 两者的判据都是「指令存在且不等于 `'none'`」。这里 `connect-src`/`form-action` 都不写，
 * `default-src 'none'` 兜底 ⇒ B2 拿到 `'none'` 直接跳过，B5 拿到 null 也跳过。
 * `script-src` 带一个真实算出来的 `sha256-` 值，正是 §2.2 点名的「内联 CSP hash」。
 */
export function safeInlineCsp(scriptSources: readonly string[]): string {
  // 平台冻结 CSP 的形状是 `script-src 'self' 'sha256-…'`；语料里给每个脚本算一个真 hash，
  // 让「内联 CSP hash」这一格不是写个假 base64 糊过去。
  const hashes = scriptSources.map((source) => `'sha256-${sha256Base64(source)}'`);
  return `default-src 'none'; script-src 'self' ${hashes.join(' ')}; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src blob:`;
}

/** 许可注释：§2.2「许可注释」+ §2.4 B10 行的「带许可头的可读源」。 */
export function licenseHeaderComment(title: string): string {
  return `/*!
 * ${title}
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * 本文件里的人物与地名全部虚构，代码为原创教学示例。
 */
`;
}

/** 覆盖层 id。同一格内四个变体各拿一种，于是每种覆盖都有 12 格 × 1 家族 × 1 变体 = 12 件。 */
export const OVERLAY_IDS = [
  'none',
  'license-and-data-url',
  'readable-plus-minified',
  'inline-csp',
] as const;
export type OverlayId = (typeof OVERLAY_IDS)[number];

export type OverlaidBase = {
  readonly base: SafeBase;
  readonly files: readonly CorpusFile[];
  readonly tags: readonly TechTag[];
  readonly sourceEntryPaths: readonly string[];
  readonly overlay: OverlayId;
  /** 覆盖层新加/改动的文件路径。用来证明「覆盖层没有碰注入槽所在的文件」。 */
  readonly touchedPaths: readonly string[];
};

function slotFileOf(base: SafeBase, slotId: SlotId): string {
  return base.slotFile[slotId];
}

function assertMarkersSurvive(base: SafeBase, files: readonly CorpusFile[]): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const slotId of SLOT_IDS) {
    const path = slotFileOf(base, slotId);
    const content = byPath.get(path)?.content;
    if (typeof content !== 'string' || !content.includes(`SLOT:${slotId}`)) {
      throw new Error(`覆盖层破坏了 ${base.familyId} 的 ${slotId} 槽标记（${path}）`);
    }
  }
}

/**
 * 给一件安全基座套上覆盖层。
 *
 * `variant` 直接决定覆盖层（`variant % 4`），因此每种覆盖在语料里的数量是**可数的**、
 * 不依赖随机数 —— 报告里「内联 CSP hash 有几件」是一个确定值，不是一次抽样。
 */
export function applyOverlay(base: SafeBase, variant: number): OverlaidBase {
  const overlay = OVERLAY_IDS[variant % OVERLAY_IDS.length];
  if (overlay === undefined) throw new Error(`覆盖层下标越界：${variant}`);
  if (overlay === 'none') {
    assertMarkersSurvive(base, base.files);
    return {
      base,
      files: base.files,
      tags: base.tags,
      sourceEntryPaths: [...base.sourceEntryPaths],
      overlay,
      touchedPaths: [],
    };
  }

  const tags: TechTag[] = [...base.tags];
  const touched: string[] = [];
  let files: CorpusFile[] = [...base.files];
  let sourceEntryPaths = [...base.sourceEntryPaths];

  if (overlay === 'license-and-data-url') {
    // ① JS 文件头加 MIT 许可注释（B10 的反例：许可头不该把可读作品判成混淆）。
    const scriptPath = slotFileOf(base, 'script');
    files = files.map((file) => {
      if (file.path !== scriptPath || typeof file.content !== 'string') return file;
      touched.push(file.path);
      return { ...file, content: `${licenseHeaderComment(base.title)}${file.content}` };
    });
    // ② `<h1>` 之后插入许可说明文字 + 一个 data URL 图片（B1 的「合法 data」反例）。
    //    这段文字里刻意带一个 https 许可链接：§2.4 B1 行的反例就是「文案里的 URL 不是资源引用」。
    files = files.map((file) => {
      if (file.path !== 'index.html' || typeof file.content !== 'string') return file;
      touched.push(file.path);
      const marker = `    <p>${base.description}</p>`;
      const extra = `${marker}
    <p>素材许可说明：https://creativecommons.org/publicdomain/zero/1.0/</p>
    <p>上面那行只是文字，页面不会去访问它。</p>
    <img src="${corpusPngDataUrl(6, 6, variant)}" alt="一枚徽章" width="6" height="6" />`;
      if (!file.content.includes(marker)) {
        throw new Error(`覆盖层找不到插入点：${file.path}`);
      }
      return { ...file, content: file.content.replace(marker, extra) };
    });
    // ③ 包内字体 + @font-face（B1 的「合法相对路径资源」反例）。追加在 CSS **末尾**，槽标记之后。
    files = files.map((file) => {
      if (file.path !== slotFileOf(base, 'style') || typeof file.content !== 'string') return file;
      touched.push(file.path);
      return {
        ...file,
        content: `${file.content}
@font-face {
  font-family: 'Corpus Hand';
  src: url('../assets/hand.woff2') format('woff2');
}
`,
      };
    });
    files = [...files, { path: 'assets/hand.woff2', content: corpusWoff2(variant) }];
    files = [...files, { path: 'assets/badge.png', content: corpusPng(6, 6, variant + 3) }];
    tags.push('license-note', 'legal-data-url');
  }

  if (overlay === 'readable-plus-minified') {
    // §2.2「可读源 + minified 产物」：B10 的判据是「不可读**且**无可读源」，
    // 所以这一件必须同时有可读源与一份真不可读的产物，缺一边就证不到豁免。
    const minifiedPath = 'build/app.min.js';
    files = files.map((file) => {
      if (file.path !== 'index.html' || typeof file.content !== 'string') return file;
      touched.push(file.path);
      const marker = `    <script src="${base.sourceEntryPaths[0] ?? 'game.js'}"></script>`;
      if (!file.content.includes(marker)) throw new Error(`覆盖层找不到脚本插入点：${file.path}`);
      return {
        ...file,
        content: file.content.replace(
          marker,
          `${marker}\n    <script src="${minifiedPath}"></script>`,
        ),
      };
    });
    files = [...files, { path: minifiedPath, content: corpusMinifiedJs(variant) }];
    // 可读源与产物**都**登记进 sourceEntryPaths —— 这是豁免成立的依据，
    // 也是 §2.4「有可读源的压缩产物不算混淆」那一格能被真跑出来的原因。
    sourceEntryPaths = [...sourceEntryPaths, minifiedPath];
    tags.push('readable-source-plus-minified');
  }

  if (overlay === 'inline-csp') {
    // 顺序很重要：**先**把 blob 那段追加进脚本，**再**据最终字节算 CSP hash。
    // 反过来做的话写进 meta 的就是一个对不上脚本的假 hash —— 而「内联 CSP hash」这一格
    // 存在的意义恰恰是它得是个真 hash。
    const scriptPath = slotFileOf(base, 'script');
    files = files.map((file) => {
      if (file.path !== scriptPath || typeof file.content !== 'string') return file;
      touched.push(file.path);
      return {
        ...file,
        content: `${file.content}
// 本地合成一张图再当素材用：Blob + createObjectURL 是 §8.3 B4 允许的合法写法。
const localBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
const localUrl = URL.createObjectURL(localBlob);
const localPreview = new Image();
localPreview.src = localUrl;
`,
      };
    });

    const scriptPaths = sourceEntryPaths.length > 0 ? sourceEntryPaths : [scriptPath];
    const byPath = new Map(files.map((file) => [file.path, file]));
    const sources = scriptPaths
      .map((path) => byPath.get(path)?.content)
      .filter((content): content is string => typeof content === 'string');
    const csp = safeInlineCsp(sources);
    files = files.map((file) => {
      if (file.path !== 'index.html' || typeof file.content !== 'string') return file;
      touched.push(file.path);
      const marker = '    <title>';
      if (!file.content.includes(marker))
        throw new Error(`覆盖层找不到 title 插入点：${file.path}`);
      return {
        ...file,
        content: file.content.replace(
          marker,
          `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n${marker}`,
        ),
      };
    });
    tags.push('inline-csp-hash', 'legal-blob-url');
  }

  assertMarkersSurvive(base, files);
  return { base, files, tags, sourceEntryPaths, overlay, touchedPaths: touched };
}

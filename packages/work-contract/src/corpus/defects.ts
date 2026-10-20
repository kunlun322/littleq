/**
 * 语料**实测出来的扫描器分歧**，以及它们的最小复现（ZLQ-210；判据出处 ZLQ-156 §2.6 / §7.3）。
 *
 * ## 这个模块存在的理由
 *
 * 工单的话是「不重写扫描器判定算法（若语料暴露出扫描器真缺陷，那是**返工**，须停下点名
 * 并附最小复现，不要顺手改判定逻辑）」。于是缺陷必须以**数据**的形式活在语料侧：
 *
 * 1. 报告里有一节 `defects`，逐条给出实测到的分歧与它的最小复现结果；
 * 2. `gaps.ts` 里有对应的 `DeclaredGap`，写明谁来修、修之前不许干什么；
 * 3. 完整性测试跑一遍复现，确认「分歧还长这个样子」。
 *
 * 三处引用同一个模块，是为了让它们不能各自漂移：如果复现写在测试里、结论文字写在报告里，
 * 那么扫描器被修好之后会出现「测试绿、报告还在喊缺陷」或者反过来的形状，
 * 两种都比缺陷本身更糟。
 *
 * ## 为什么复现是**建四个真包**，不是四句断言
 *
 * 最小复现的价值在于它能被别人独立跑一遍。四个包**只差 `<form>` 开标签这一处**，
 * 其余文件、元数据、封面、`createdAt`、`workId` 派生规则全同 —— 所以实测到的差异
 * 只能来自那一处。写成断言就只剩「我说它不一样」。
 *
 * ## 载荷纪律
 *
 * 复现用的页面是一个**空表单**：没有提交地址、没有脚本、没有任何载体串。
 * 它触发的是 B5 对 `<form>` 元素本身的判据，不需要有害内容，
 * 因此可以安全地写进公开仓库里的报告（§2.1 载体纪律 + §2.6「不附源片段」：
 * 报告里只有开标签这一行 HTML，没有整页源码）。
 */

import type { Disposition } from '../scan/types.js';
import { CORPUS_CREATED_AT, workIdOf } from './generator.js';
import type { BuiltCorpusPackage } from './package.js';
import { buildCorpusPackage, corpusPng } from './package.js';

/** `gaps.ts` 里那条声明的 id。两处必须是同一个字符串，测试会核对。 */
export const B5_FORM_ACTION_GAP_ID = 'scanner-defect-b5-form-action';

/** 触发分歧的规则。B5 = 表单提交/外发。 */
export const B5_FORM_ACTION_RULE_ID = 'B5' as const;

export type DeclaredDefectVariant = {
  /** 复现里的名字。进报告，因此**不含**任何载荷文本。 */
  readonly label: string;
  /** 四个包之间唯一的差异：`<form>` 的开标签。 */
  readonly openTag: string;
  /** 这个变体在 HTML 语义上是什么，为什么它不逃出包外。 */
  readonly note: string;
  /**
   * 按 B5 自己的规则文档应当给出的处置。
   *
   * 出处是 `src/scan/rules/b05-cross-site-form.ts` 的 docblock
   * （「`<form>` 元素本身就是『表单提交』的载体。v1 禁止它 ⇒ 硬拦」）
   * 与 `action === null` 那一支的行内注释
   * （「没有 action 的 `<form>` 提交到当前文档 URL；在 `form-action 'none'` 下同样被拒」）。
   * 冻结处置上限 `FROZEN_DISPOSITION_CEILING.B5` 也是 `BLOCK`，三处一致。
   *
   * **分歧的成因**（写下来是为了让返工单能直接动手，不是为了让本单去改判定）：
   * `attributeOf(element, 'action')` 对 `action=""` 返回 `''` 而不是 `null`，
   * 于是 `form-element` 那一支被跳过，转到 `escapes(context, file, '')`；
   * 空串在引用图里解析成 `unresolved`（`src/scan/analysis/graph.ts`），
   * `escapesPackage` 因此为 false ⇒ 零命中。`#top` 与 `./index.html` 同理：
   * 两者都**不逃出包外**，所以都走不到 `cross-site-form-action`，
   * 而按 docblock 它们本该先被 `form-element` 拦下。
   */
  readonly documentedDisposition: Disposition;
};

/**
 * 四个变体。A 是**对照组**：它实测 BLOCK，证明 B5 的规则确实在跑、
 * 语料的建包路径也确实能触发它 —— 少了 A，「B/C/D 零命中」既可以读成缺陷，
 * 也可以读成「这套复现压根没接通扫描器」，两种读法没法区分。
 */
export const B5_FORM_ACTION_VARIANTS: readonly DeclaredDefectVariant[] = [
  {
    label: 'A-no-action-attribute',
    openTag: '<form>',
    note: '对照组：没有 action 属性 ⇒ 走 `form-element` 分支，实测硬拦。',
    documentedDisposition: 'BLOCK',
  },
  {
    label: 'B-action-empty-string',
    openTag: '<form action="">',
    note: 'HTML 规范里 `action=""` 等价于当前文档 URL，不逃出包外。',
    documentedDisposition: 'BLOCK',
  },
  {
    label: 'C-action-fragment',
    openTag: '<form action="#top">',
    note: '同文档片段，不逃出包外。',
    documentedDisposition: 'BLOCK',
  },
  {
    label: 'D-action-in-package',
    openTag: '<form action="./index.html">',
    note: '包内相对路径，引用图能解析到包内文件，不逃出包外。',
    documentedDisposition: 'BLOCK',
  },
];

/**
 * 复现页面的正文。**只有开标签是变量**，其余逐字节相同。
 *
 * 页面本身是合法的：有 `<!doctype>`、`lang`、`charset`、标题、一张包内封面图，
 * 因此除了 B5 之外不该有别的规则命中 —— 这一点由复现的实测结果自己证明
 * （报告 `defects[].variants[].rules` 里只有 B5 或空）。
 */
function formPageHtml(openTag: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>空表单复现</title>
  </head>
  <body>
    <h2 id="top">空表单复现</h2>
    ${openTag}
      <input id="nickname" name="nickname" type="text" />
      <button type="submit">保存</button>
    </form>
    <img src="assets/cover.png" alt="封面" width="8" height="8" />
  </body>
</html>
`;
}

export type DefectReproPackage = {
  readonly variant: DeclaredDefectVariant;
  readonly built: BuiltCorpusPackage;
};

/**
 * 建出四个复现包。**纯函数**：不扫、不读文件系统、不读时钟。
 *
 * `workId` 从变体名派生，所以四个包的 `storageKeyPrefix` 互不相同，
 * 也不会和语料里任何一件作品撞上（B7 的判据是按前缀的）。
 */
export function b5FormActionRepro(
  scannerVersion: string,
  rulesetVersion: string,
): readonly DefectReproPackage[] {
  return B5_FORM_ACTION_VARIANTS.map((variant) => ({
    variant,
    built: buildCorpusPackage(workIdOf(`repro-${variant.label}`), CORPUS_CREATED_AT, {
      files: [
        { path: 'index.html', content: formPageHtml(variant.openTag) },
        { path: 'assets/cover.png', content: corpusPng() },
      ],
      title: '空表单复现',
      // 描述里不能出现 `<form>`：展示文本校验禁止标记语言（这条校验在这里正好拦住了我）。
      description: 'B5 表单外发分歧的最小复现：四个包只差表单开标签一处。',
      workType: 'WEB',
      ageBand: 'L2',
      scannerVersion,
      rulesetVersion,
    }),
  }));
}

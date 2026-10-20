/**
 * **B12 虚假能力** —— ZLQ-153 §8.3 原文：
 * 「文本/ARIA/canvas 文案抽取后匹配"云存档/账号同步/全球排行"等；**只标记确认，不硬拦**」
 *
 * ## 这一条是「B12 永不硬拦」的**结构**保证，不是承诺
 *
 * `maxDisposition: 'CONFIRM_REQUIRED'` 由 `FindingFactory` 强制：本文件里任何一处
 * `emit({disposition: 'BLOCK'})` 都会抛 `DispositionCeilingError`，而不是被静默降级。
 * 所以 ZLQ-201 PASS §6 的第二条不可谈判项（「B12 上任何硬阻断 = 直接失败」）
 * 不是靠「记得别写 BLOCK」维持的 —— 写了就一定红。§8 的变异控制 1 就是冲这个设计去的。
 *
 * 文件里因此**只有一个** `disposition` 字面量，且它是 `CONFIRM_REQUIRED`。
 *
 * ## 文案抽取的三个来源（§8.3 点名「文本/ARIA/canvas」）
 *
 * `copyChunksOf`（`support.ts`）已经把三者收齐，本规则不自己再抽一遍：
 * - **文本**：HTML 文本节点（`<script>`/`<style>` 子树里的不算文案）；
 * - **ARIA**：`alt`/`title`/`placeholder`/`aria-label`/`aria-description`/`aria-roledescription`；
 * - **canvas**：canvas 文案只存在于 JS 字符串里（`ctx.fillText('云存档已开启', …)`），
 *   所以 JS 字符串字面量必须进文案集 —— 漏掉它 B12 就形同虚设。
 *
 * 另外加上 `work.json` 的展示字段（标题/描述/作者昵称/封面 alt/素材署名）。
 * 这些字段的定位是 **JSON Pointer** 而不是行列 —— §6.5 明确 metadata 定位不能用行列，
 * 因为插入可信的 `publicationId`/`publishedAt` 会让行号漂移。
 *
 * ## §2.4 的四条安全反例是**结构性**放行的
 *
 * 靠的是词表本身不含裸词（`lexicon.ts`：没有 `存档`、`排行榜`、`同步`）
 * **加上**同句否证窗口，两层都不依赖「恰好没写到」：
 * - 「本机存档」/「这是模拟排行榜」：`CLAIM_NEGATION_CUES` 收了 `本机`/`本地`/`模拟`/`虚拟`/`演示`；
 * - 「不支持云同步」：同句里的 `不支持` 直接否证；
 * - 「普通剧情对白」：词表里的每一条都是**复合短语**（`云存档`、`全球排行`、`跨设备同步`），
 *   普通对白不含这些短语。
 *
 * 否证窗口**只有一句话**（`sentencesOf` 按 `。！？；\n.!?;` 切）。跨句否证会让
 * 「本作不支持联网。云存档功能完善。」被错误放行 —— 那正是 B12 要抓的形状。
 *
 * ## 定位精度
 *
 * 命中定位到**整个文案块**（`chunk.location`），不定位到句内偏移。
 * 文案块是折叠过空白的，把块内偏移映射回原文件行列需要一份未折叠的对照表；
 * 早先试过直接用文件的 `LineIndex` 映射块内偏移，产出的行列是错的（对不上原文）。
 * §6.2 只要求「每条命中给文件、行列、规则 ID、修复动作」，块级行列已经满足，
 * 而一个**错**的行列比一个粗的行列更坏。
 */

import { CAPABILITY_CLAIM_TERMS } from '../lexicon.js';
import { MANIFEST_FILE_NAME } from '../metadata.js';
import type { FindingLocation } from '../types.js';
import {
  copyChunksOf,
  isNegated,
  manifestCopyChunks,
  matchDecoded,
  sentencesOf,
} from './support.js';
import type { CopyChunk } from './support.js';
import type { Rule, RuleContext } from './types.js';

/**
 * 与 `CAPABILITY_CLAIM_TERMS` 的 id 一一对应。**显式列出**（不是从词表派生），
 * 这样 registry 的「emitted subType 必须在声明里」这条断言才有意义；
 * 两份列表的一致性由测试 `lexicon 与 subTypes 不漂移` 双向钉住。
 *
 * `undecodable-claim` 不对应任何词表条目：它是「解码被预算截断」的专用子类型。
 */
export const B12_SUB_TYPES = [
  'cloud-save',
  'account-sync',
  'cloud-sync',
  'global-leaderboard',
  'online-multiplayer',
  'server-progress',
  'ai-runtime-claim',
  'payment-claim',
  'undecodable-claim',
  'unclassified-claim',
] as const;

type B12SubType = (typeof B12_SUB_TYPES)[number];

/** 词表条目 id 就是子类型（同一套字符串）。不在声明里的 id 返回 null，绝不就近误标成别的类目。 */
const DECLARED: ReadonlySet<string> = new Set<string>(B12_SUB_TYPES);

export const b12FalseCapability: Rule = {
  id: 'B12',
  // §8.3「只标记确认，不硬拦」。见文件头：这个上限由 `FindingFactory` 强制。
  maxDisposition: 'CONFIRM_REQUIRED',
  subTypes: B12_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      // `work.json` 也在 `context.files` 里，但它只能走下面那一路：§6.5 要求 metadata 定位用
      // JSON Pointer（插可信时间字段会让行号整体漂移），而按文件扫出来的是行列。两路都跑，
      // 同一句文案就产出两条确认项，成人要为同一处点两次。
      if (file.path === MANIFEST_FILE_NAME) continue;
      checkChunks(context, file.path, copyChunksOf(file));
    }
    checkChunks(context, MANIFEST_FILE_NAME, manifestCopyChunks(context.metadata));
  },
};

function checkChunks(context: RuleContext, path: string, chunks: readonly CopyChunk[]): void {
  for (const chunk of chunks) {
    for (const sentence of sentencesOf(chunk.text)) {
      if (isNegated(sentence.text)) continue;
      const match = matchDecoded(CAPABILITY_CLAIM_TERMS, sentence.text, context.budget);
      // 解码被预算截断 ⇒ 不得判定为干净（§6.4）。仍然只进复核：截断本身不是「虚假能力」的证据，
      // 而 B12 没有硬拦档，把它升级成 BLOCK 会直接违反不可谈判项 2。
      if (match.entry === null) {
        if (match.truncated) emit(context, path, 'undecodable-claim', chunk.location);
        continue;
      }
      // 词表加了新条目却没在 `B12_SUB_TYPES` 里声明 ⇒ 报「未归类」，不就近套一个已声明的类目，
      // 也不静默丢掉命中。两份列表的一致性由测试双向钉住，所以这条路径运行时不可达。
      emit(
        context,
        path,
        DECLARED.has(match.entry.id) ? (match.entry.id as B12SubType) : 'unclassified-claim',
        chunk.location,
      );
    }
  }
}

function emit(
  context: RuleContext,
  path: string,
  subType: B12SubType,
  location: FindingLocation,
): void {
  context.emit({
    ruleId: 'B12',
    disposition: 'CONFIRM_REQUIRED',
    // 低置信：§8.6「语义不确定项不升级为硬拦：B12 始终确认」。
    confidence: 'LOW',
    path,
    location,
    repairAction: 'CORRECT_CLAIM',
    subType,
  });
}

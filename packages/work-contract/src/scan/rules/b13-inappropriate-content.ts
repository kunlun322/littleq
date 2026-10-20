/**
 * **B13 不当内容** —— ZLQ-153 §8.3 原文：
 * 「本地敏感词和链接词库；图片 hash/元数据；可选云图审。高置信硬拦，规则 ID 可解释」
 *
 * ## 「可选云图审」**不实现**，这是有意的
 *
 * §8.6 明文「不上传学生内容到官方服务」，而扫描器离线（§8.1 的 Runtime 零网络请求同源）。
 * 一条会把儿童作品字节发到外部服务的规则，与「不上传」直接互斥 —— 二者只能留一个，
 * 留「不上传」。图片这一路因此只有两条**离线**证据：
 * ① `policySnapshot.denyListedImageHashes`（已知不适宜图片的 sha256，随规则集下发）；
 * ② EXIF GPS 标签（隐私泄露，属「图片元数据」）。
 * 「画了什么」离线判不出来，这个能力缺口在交付说明里点名，不用云图审假装补上。
 *
 * ## 两档判定（§8.6「B8/B13 低置信进入成人复核」）
 *
 * - `INAPPROPRIATE_HIGH` ⇒ **BLOCK/HIGH**。这张表刻意极窄：只收在儿童作品里没有任何正当用途的
 *   表述。§2.4 的四条反例——「医学/安全教育引文」「正常词的子串」「虚构反派情节」
 *   「可解释的科学图」——靠的是词表**本身不含** `出血`/`急救`/`心肺复苏`/`大魔王`/`邪恶`/`打败`/
 *   `杀`/`病毒`/`细菌` 这类词，而不是靠事后开脱；拉丁词一律加 `\b`，避免「正常词的子串」误命中。
 * - `INAPPROPRIATE_LOW` ⇒ **CONFIRM_REQUIRED/LOW**，永不产生 BLOCK。这一层召回宽、判定软。
 *
 * ## 「敏感词**和链接**词库」
 *
 * 同一份词表跑在两个输入集上，这正是原文的「和」：
 * - **展示文案**（`copyChunksOf` + manifest 字段）⇒ 两张表都跑；
 * - **代码 token**（`codeTokensOf`，含 URL 字符串、import 源、CSS 值）⇒ **只跑 HIGH 表**。
 *   链接词库抓的是「作品里放着一条通向不适宜站点的 URL」，那是确定形状；
 *   把 LOW 表也跑在代码 token 上只会把变量名撞进成人复核队列，噪声不是谨慎。
 *
 * ## 定位
 *
 * 文案命中定位到整个文案块（`chunk.location`），不定位到句内偏移 —— 折叠过空白的块内偏移
 * 映射回原文件行列需要未折叠对照表，早先直接用文件 `LineIndex` 映射产出的行列对不上原文。
 * §6.2 只要求「文件、行列、规则 ID、修复动作」，块级行列已满足，而错的行列比粗的行列更坏。
 * 图片两路的 `location` 是 `null`：证据是整份文件的字节，指不到某一行。
 */

import { admittedMediaType, MANIFEST_FILE_NAME } from '../metadata.js';
import { INAPPROPRIATE_HIGH, INAPPROPRIATE_LOW } from '../lexicon.js';
import type { LexiconEntry } from '../lexicon.js';
import type { FindingLocation } from '../types.js';
import {
  codeTokensOf,
  copyChunksOf,
  manifestCopyChunks,
  matchDecoded,
  sentencesOf,
} from './support.js';
import type { CopyChunk } from './support.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';

/** 词表条目 id 直接作为子类型 ⇒ 「规则 ID 可解释」：成人看到的是具体类目，不是一个笼统的 B13。 */
export const B13_SUB_TYPES = [
  'csae',
  'explicit-porn',
  'self-harm-instruction',
  'drug-trade',
  'weapon-manufacture',
  'gambling-money',
  'hate-violence',
  'terror-recruitment',
  'doxxing',
  'gore-detail',
  'substance-use',
  'swearing',
  'gambling-words',
  'weapon-display',
  'self-harm-mention',
  'dating-content',
  'image-hash-deny-listed',
  'image-exif-gps',
  'image-metadata-unreadable',
  'undecodable-copy',
  'undecodable-link',
  'unclassified-term',
] as const;

type B13SubType = (typeof B13_SUB_TYPES)[number];

const DECLARED: ReadonlySet<string> = new Set<string>(B13_SUB_TYPES);
const HIGH_TABLE: readonly LexiconEntry[] = INAPPROPRIATE_HIGH;
const BOTH_TABLES: readonly LexiconEntry[] = [...INAPPROPRIATE_HIGH, ...INAPPROPRIATE_LOW];

export const b13InappropriateContent: Rule = {
  id: 'B13',
  maxDisposition: 'BLOCK',
  subTypes: B13_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      // `work.json` 也在 `context.files` 里，但它只能走下面那一路：§6.5 要求 metadata 定位用
      // JSON Pointer，按文件扫出来的是行列；两路都跑会让同一处文案变成两条命中。
      if (file.path === MANIFEST_FILE_NAME) continue;
      checkCopy(context, file);
      checkLinks(context, file);
      checkImage(context, file);
    }
    for (const chunk of manifestCopyChunks(context.metadata)) {
      matchChunk(context, MANIFEST_FILE_NAME, chunk, BOTH_TABLES);
    }
  },
};

// ---------------------------------------------------------------------------
// 敏感词
// ---------------------------------------------------------------------------

function checkCopy(context: RuleContext, file: RuleFileContext): void {
  for (const chunk of copyChunksOf(file)) matchChunk(context, file.path, chunk, BOTH_TABLES);
}

/** 链接词库一路：只跑 HIGH 表，理由见文件头。 */
function checkLinks(context: RuleContext, file: RuleFileContext): void {
  for (const token of codeTokensOf(file)) {
    const match = matchDecoded(HIGH_TABLE, token.value, context.budget);
    if (match.entry === null) {
      // 解码被预算截断 ⇒ 不得判定为干净（§6.4），但截断不是「不当内容」的证据 ⇒ 只进复核。
      if (match.truncated) emit(context, file.path, 'undecodable-link', token.location, 'LOW');
      continue;
    }
    emit(context, file.path, subTypeOf(match.entry), token.location, match.entry.tier);
  }
}

function matchChunk(
  context: RuleContext,
  path: string,
  chunk: CopyChunk,
  entries: readonly LexiconEntry[],
): void {
  for (const sentence of sentencesOf(chunk.text)) {
    const match = matchDecoded(entries, sentence.text, context.budget);
    if (match.entry === null) {
      // 解码被预算截断 ⇒ 不得判定为干净（§6.4）。但截断本身不是「不当内容」的证据，
      // 所以只进成人复核 —— 硬拦需要 precision ≥98%，而这里的分子是 0。
      if (match.truncated) emit(context, path, 'undecodable-copy', chunk.location, 'LOW');
      continue;
    }
    emit(context, path, subTypeOf(match.entry), chunk.location, match.entry.tier);
  }
}

// ---------------------------------------------------------------------------
// 图片 hash / 元数据
// ---------------------------------------------------------------------------

function checkImage(context: RuleContext, file: RuleFileContext): void {
  const denyListed = new Set(
    context.policy.denyListedImageHashes.map((hash) => hash.toLowerCase()),
  );
  if (denyListed.has(file.sha256.toLowerCase())) {
    emit(context, file.path, 'image-hash-deny-listed', null, 'HIGH');
  }

  // `exifGps === null` 在**非图片**文件上是「不适用」，不是「没有证据」：
  // `analysis/index.ts` 只对 `kind === 'image'` 调 `hasExifGps`。所以先按 mediaType 把非图片挡掉，
  // 剩下的 `null` 才真的是「载体读不通」，按 §6.4 不得判干净，但也不够硬拦 ⇒ 成人复核。
  if (admittedMediaType(file.mediaType)?.kind !== 'image') return;
  const summary = file.summary;
  if (summary.kind !== 'binary') return;

  if (summary.exifGps === true) emit(context, file.path, 'image-exif-gps', null, 'HIGH');
  else if (summary.exifGps === null)
    emit(context, file.path, 'image-metadata-unreadable', null, 'LOW');
}

// ---------------------------------------------------------------------------
// 发射
// ---------------------------------------------------------------------------

/**
 * 词表条目 id 就是子类型（同一套字符串）⇒「规则 ID 可解释」：成人看到的是具体类目。
 *
 * 不在声明里的 id 落到 `unclassified-term`，**不**就近套一个已声明的类目：把一条漂移进来的
 * 词表条目标成 `csae` 或 `explicit-porn` 是最坏的那种错——它既误导成人复核，又会污染
 * D3b 语料的分母。两份列表的一致性由测试双向钉住，所以这条路径运行时不可达；
 * 真走到了，报「未归类」比报一个假类目诚实。
 */
function subTypeOf(entry: LexiconEntry): B13SubType {
  return DECLARED.has(entry.id) ? (entry.id as B13SubType) : 'unclassified-term';
}

function emit(
  context: RuleContext,
  path: string,
  subType: B13SubType,
  location: FindingLocation,
  confidence: 'HIGH' | 'LOW',
): void {
  context.emit({
    ruleId: 'B13',
    // §8.6「语义不确定项不升级为硬拦：B8/B13 低置信进入成人复核」。
    disposition: confidence === 'HIGH' ? 'BLOCK' : 'CONFIRM_REQUIRED',
    confidence,
    path,
    location,
    repairAction: 'CHANGE_CONTENT',
    subType,
  });
}

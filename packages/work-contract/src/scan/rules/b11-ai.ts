/**
 * **B11 AI** —— ZLQ-153 §8.3 原文：
 * 「B1/B2 基础上识别 QCA/百炼/OpenAI 等 SDK、域名、模型调用符号与提示词拼装；
 * Runtime 绝无 AI 代理端点」
 *
 * 「B1/B2 基础上」在这里是**字面**的实现约束，不是修辞：本规则的两个输入集正是 B1/B2 已经
 * 建好的东西 —— ① 资源图的**外部 host 边**（B1 的分类结果，不重新解析 URL），
 * ② 代码 token 集（B2 用来找网络调用符号的同一个集合）。
 * 之所以要复用而不是自己再扫一遍：§6.4 规定二级解码预算是**累计**的，各规则各解一次
 * 就会重复扣预算，把一个安全包扣成 `SCANNER_RESOURCE_LIMIT`。
 *
 * ## 为什么「Runtime 绝无 AI 代理端点」⇒ 命中即硬拦
 *
 * `CAPABILITIES`（`metadata.ts`）里**没有**任何 AI 能力项，`ScanPolicySnapshot` 也没有
 * 「成人批准的 AI」这种开关。也就是说这条规则**不存在**合法放行路径：作品里出现 provider
 * SDK / 端点 / 提示词拼装，在 Runtime 里必然失败（`connect-src 'none'`），
 * 而向学生承诺一个跑不通的能力正是 B12 要防的形状。所以 HIGH ⇒ BLOCK，没有 CONFIRM 档。
 *
 * ## §2.4 的三条安全反例是**结构性**放行的
 *
 * - 「已固化的 AI 风格头像/语音文件」：token 集里 `html-reference` 这一路（资源路径）被
 *   **显式排除**，图片/音频文件名根本不进判定。
 * - 「剧情角色『AI』」：只读代码 token，**不读** `copyChunksOf` 的展示文案，所以 HTML 散文、
 *   对白、`alt` 文本里的「AI」不会被看见。词表里也没有裸词 `AI`（见 `lexicon.ts` 的说明），
 *   这是第二道保险，不是唯一一道。
 * - 「纯本地选择式问答」：词表只收 provider 符号与提示词**拼装形状**
 *   （`messages: [{role: 'system'…}]` / `systemPrompt` / `promptTemplate`），
 *   `{question, options, answer}` 这类本地数据结构不命中。
 */

import { AI_PROVIDER_TERMS } from '../lexicon.js';
import type { LexiconEntry } from '../lexicon.js';
import type { FindingLocation } from '../types.js';
import { codeTokensOf, matchDecoded } from './support.js';
import type { CodeToken } from './support.js';
import type { Rule, RuleContext, RuleFileContext } from './types.js';

export const B11_SUB_TYPES = [
  'ai-provider-symbol',
  'ai-provider-domain',
  'ai-prompt-assembly',
] as const;

/** 提示词拼装与 provider 符号的修复动作不同：前者是改写代码结构，后者是断掉外部依赖。 */
const PROMPT_ASSEMBLY_ID = 'prompt-assembly';

/** 资源路径不进 B11。见文件头「已固化的 AI 风格头像/语音文件」。 */
const EXCLUDED_TOKEN_ORIGINS = new Set(['html-reference']);

export const b11Ai: Rule = {
  id: 'B11',
  maxDisposition: 'BLOCK',
  subTypes: B11_SUB_TYPES,

  run(context: RuleContext): void {
    for (const file of context.files) {
      // token 只抽一次：解码预算累计，重复抽取会重复扣（§6.4）。
      const tokens = codeTokensOf(file);
      checkTokens(context, file, tokens);
      checkExternalHosts(context, file);
    }
  },
};

function checkTokens(
  context: RuleContext,
  file: RuleFileContext,
  tokens: readonly CodeToken[],
): void {
  for (const token of tokens) {
    if (EXCLUDED_TOKEN_ORIGINS.has(token.origin)) continue;
    const match = matchDecoded(AI_PROVIDER_TERMS, token.value, context.budget);
    if (match.entry === null) {
      // 解码被预算截断 ⇒ **不得**判定为干净（§6.4）。归到 provider-symbol：
      // 截断说明这段 token 长得像编码数据，而 AI 端点正是最常被编码藏起来的一类。
      if (match.truncated) emit(context, file.path, 'ai-provider-symbol', token.location);
      continue;
    }
    emit(context, file.path, subTypeOf(match.entry), token.location);
  }
}

/** 复用 B1 的资源图：外部 host 边逐个对词表。不重新解析 URL，也不重新扣解码预算。 */
function checkExternalHosts(context: RuleContext, file: RuleFileContext): void {
  for (const edge of context.graph.edges) {
    if (edge.fromPath !== file.path || edge.resolved.target !== 'external') continue;
    const host = edge.resolved.host;
    if (host === null) continue;
    const match = matchDecoded(AI_PROVIDER_TERMS, host, context.budget);
    if (match.entry === null || match.entry.id === PROMPT_ASSEMBLY_ID) continue;
    emit(context, file.path, 'ai-provider-domain', edge.location);
  }
}

function subTypeOf(entry: LexiconEntry): (typeof B11_SUB_TYPES)[number] {
  return entry.id === PROMPT_ASSEMBLY_ID ? 'ai-prompt-assembly' : 'ai-provider-symbol';
}

function emit(
  context: RuleContext,
  path: string,
  subType: (typeof B11_SUB_TYPES)[number],
  location: FindingLocation,
): void {
  context.emit({
    ruleId: 'B11',
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path,
    location,
    repairAction: 'REMOVE_NETWORK',
    subType,
  });
}

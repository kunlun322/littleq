/**
 * ZLQ-153 §8.7「儿童友好解释与出口」——**逐字**照录，一个标点都不改。
 *
 * 为什么必须逐字：§6.2 要求 `explanation` 是**固定**的儿童向文案，不插值来源/域名/完整 URL/密钥。
 * 「固定」只有在文案是常量表时才成立；一旦允许拼接，某条规则就可能把 `https://evil.example/token=…`
 * 拼进给孩子看的句子里，既泄露又不可复算。所以这里只有查表，没有格式化函数接受外部字符串。
 *
 * 表格里的 `“ ”` `‘ ’` 是原文的排版引号，不是 ASCII 引号；B4/B5、B6/B7、B9/B10 在原文里共用一行，
 * 所以 `ExplanationKey` 也只有十个，不是十三个 —— 共用不是「合并规则」（§3 禁止的是合并**判定**），
 * 判定仍然逐条独立，只是给孩子的解释文案相同。
 */

import type { RuleId } from './types.js';

export const EXPLANATION_KEYS = [
  'b1',
  'b2',
  'b3',
  'b4-b5',
  'b6-b7',
  'b8',
  'b9-b10',
  'b11',
  'b12',
  'b13',
] as const;

export type ExplanationKey = (typeof EXPLANATION_KEYS)[number];

export type Explanation = {
  /** 给孩子看的那句话（含原文的排版引号）。 */
  readonly message: string;
  /** 原文箭头右边的出口动作。 */
  readonly exit: string;
};

export const EXPLANATIONS: Readonly<Record<ExplanationKey, Explanation>> = {
  b1: {
    message: '“作品里用了外面网站的东西，别人以后可能打不开。让 Little Q 把它放进作品里吧。”',
    exit: '一键固化资源',
  },
  b2: {
    message: '“发布后的作品不能上网取东西。我们可以提前把需要的内容放进去。”',
    exit: '一键改为本地素材',
  },
  b3: {
    message: '“作品不能把看的人带去别的网站哦。”',
    exit: '删除跳转/改为作品内页面',
  },
  'b4-b5': {
    message: '“作品不能替别人下载东西或把填写内容送出去。”',
    exit: '改为页面内展示',
  },
  'b6-b7': {
    message: '“这段代码想碰作品外面的地方，为了保护大家不能发布。”',
    exit: '使用允许的作品 API',
  },
  b8: {
    message: '“作品不能问看的人电话、住址或学校。”',
    exit: '删除字段/改为虚构昵称',
  },
  'b9-b10': {
    message: '“这段代码藏得太深，Little Q 看不清它安不安全。”',
    exit: '生成可读版本',
  },
  b11: {
    message: '“AI 只在创作时帮忙，发布后的作品不能自己调用 AI。”',
    exit: '创作期生成并固化素材',
  },
  b12: {
    message: '“你写了‘云存档’，其实只保存在这台设备。要改成‘本机存档’吗？”',
    exit: '确认/修改',
  },
  b13: {
    message: '“这里有不适合公开展示的内容，我们换一个安全版本。”',
    exit: '定位并修改；通知成人',
  },
};

/** §8.7 表格之外的那句收尾约束，同样是原文。 */
export const ROLLBACK_POLICY_TEXT = '同类连续三次失败后提供回滚；任何拦截都保留旧的可运行版本。';

const KEY_BY_RULE: Readonly<Record<RuleId, ExplanationKey>> = {
  B1: 'b1',
  B2: 'b2',
  B3: 'b3',
  B4: 'b4-b5',
  B5: 'b4-b5',
  B6: 'b6-b7',
  B7: 'b6-b7',
  B8: 'b8',
  B9: 'b9-b10',
  B10: 'b9-b10',
  B11: 'b11',
  B12: 'b12',
  B13: 'b13',
};

export function explanationKeyForRule(ruleId: RuleId): ExplanationKey {
  return KEY_BY_RULE[ruleId];
}

/**
 * 进 `ScanSummaryEntry.explanation` 的完整文案。形状与 §8.7 表格单元一致：`“文案”→ 出口`。
 * 不接受任何外部字符串 —— 见文件头。
 */
export function explanationText(ruleId: RuleId): string {
  const entry = EXPLANATIONS[explanationKeyForRule(ruleId)];
  return `${entry.message}→ ${entry.exit}`;
}

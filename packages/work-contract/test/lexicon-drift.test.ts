/**
 * 词表条目 id 与规则子类型声明的一致性（ZLQ-153 §8.3 B13「规则 ID 可解释」）。
 *
 * ## 为什么需要这条测试
 *
 * B12 与 B13 都采用同一个约定：**词表条目的 `id` 就是子类型字符串**，规则拿到命中条目后
 * 直接把 `entry.id` 当子类型发射。但两份列表写在两个文件里 ——
 * `src/scan/lexicon.ts` 的词表与 `src/scan/rules/b1{2,3}-*.ts` 的 `*_SUB_TYPES`。
 * 任何一侧单独加一项，另一侧不会报错，只会在运行时悄悄退化：
 *
 * - 词表加了、声明没加 ⇒ 命中落到 `unclassified-*`（B13 的 `subTypeOf` 明确不就近套类目），
 *   成人复核看到的是「未归类」而不是具体类目，§8.3 的「规则 ID 可解释」失效；
 *   声明加了、词表没加 ⇒ 那个子类型永远发不出来，是一处死声明，
 *   D3b 的语料会把它当成「测过但零命中」，白占一格 precision 分母。
 *
 * 两种漂移都不会让任何既有门变红：`registryViolations()` 查的是「发射出去的子类型必须在
 * 声明里」，而 `assertDeclaredSubType` 在发射前就拦住了未声明的 id —— 也就是说
 * **注册表自检只能发现「声明少了」，发现不了「词表多了」和「声明多了」**。这条测试补的正是那两格。
 *
 * 它同时是那两条 `unclassified-*` 路径「运行时不可达」的**唯一**证明：
 * `b13-inappropriate-content.ts` 的注释说这条路径不可达，靠的就是这里双向比对为空。
 *
 * ## 正对照
 *
 * 空集比对最容易空洞地成立（两边都取不到东西 ⇒ 相等）。所以每条断言前都先钉住
 * 「参与比对的集合确实非空」，并把非词表子类型**显式列出来**：
 * 日后谁往 `*_SUB_TYPES` 里加一项非词表子类型，必须同时改这里的白名单，
 * 否则红灯会指到它头上 —— 那正是这条棘轮要的。
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_CLAIM_TERMS,
  INAPPROPRIATE_HIGH,
  INAPPROPRIATE_LOW,
} from '../src/scan/lexicon.js';
import { B12_SUB_TYPES } from '../src/scan/rules/b12-false-capability.js';
import { B13_SUB_TYPES } from '../src/scan/rules/b13-inappropriate-content.js';

/**
 * B12 里不由词表驱动的子类型。
 * `undecodable-claim` = 解码被预算截断（§6.4）；`unclassified-claim` = 漂移兜底。
 */
const B12_NON_LEXICON = ['undecodable-claim', 'unclassified-claim'];

/**
 * B13 里不由词表驱动的子类型：三个来自图片侧（hash 名单 / EXIF GPS / 元数据读不出），
 * 两个来自解码截断，一个是漂移兜底。
 */
const B13_NON_LEXICON = [
  'image-hash-deny-listed',
  'image-exif-gps',
  'image-metadata-unreadable',
  'undecodable-copy',
  'undecodable-link',
  'unclassified-term',
];

function idsOf(entries: readonly { id: string }[]): string[] {
  return entries.map((entry) => entry.id);
}

function withoutAll(source: readonly string[], remove: readonly string[]): string[] {
  return source.filter((item) => !remove.includes(item));
}

describe('lexicon-drift：词表与子类型声明的一致性', () => {
  it('lexicon 与 subTypes 不漂移', () => {
    // ---- 正对照：参与比对的四份列表都非空，否则下面全是空集相等 ----
    expect(CAPABILITY_CLAIM_TERMS.length, 'B12 词表').toBeGreaterThan(0);
    expect(INAPPROPRIATE_HIGH.length, 'B13 高置信词表').toBeGreaterThan(0);
    expect(INAPPROPRIATE_LOW.length, 'B13 低置信词表').toBeGreaterThan(0);
    expect(B12_SUB_TYPES.length, 'B12 子类型声明').toBeGreaterThan(0);
    expect(B13_SUB_TYPES.length, 'B13 子类型声明').toBeGreaterThan(0);

    // ---- 非词表子类型的白名单本身也要钉住 ----
    // 这两条把「哪些子类型不该出现在词表里」写死。谁加一项非词表子类型而忘了改白名单，
    // 下面那两条 `toEqual` 就会红，红灯直接指到白名单上。
    expect(withoutAll(B12_SUB_TYPES, idsOf(CAPABILITY_CLAIM_TERMS)), 'B12 的非词表子类型').toEqual(
      B12_NON_LEXICON,
    );
    expect(
      withoutAll(B13_SUB_TYPES, [...idsOf(INAPPROPRIATE_HIGH), ...idsOf(INAPPROPRIATE_LOW)]),
      'B13 的非词表子类型',
    ).toEqual(B13_NON_LEXICON);

    // ---- B12 双向 ----
    const b12Declared = new Set<string>(B12_SUB_TYPES);
    const b12Lexicon = idsOf(CAPABILITY_CLAIM_TERMS);
    expect(
      b12Lexicon.filter((id) => !b12Declared.has(id)),
      '词表里有、声明里没有 ⇒ 命中会退化成 unclassified-claim',
    ).toEqual([]);
    expect(
      withoutAll(B12_SUB_TYPES, B12_NON_LEXICON).filter((id) => !b12Lexicon.includes(id)),
      '声明里有、词表里没有 ⇒ 死声明，D3b 会把它记成零命中',
    ).toEqual([]);

    // ---- B13 双向 ----
    const b13Declared = new Set<string>(B13_SUB_TYPES);
    const b13Lexicon = [...idsOf(INAPPROPRIATE_HIGH), ...idsOf(INAPPROPRIATE_LOW)];
    expect(
      b13Lexicon.filter((id) => !b13Declared.has(id)),
      '词表里有、声明里没有 ⇒ 命中会退化成 unclassified-term',
    ).toEqual([]);
    expect(
      withoutAll(B13_SUB_TYPES, B13_NON_LEXICON).filter((id) => !b13Lexicon.includes(id)),
      '声明里有、词表里没有 ⇒ 死声明',
    ).toEqual([]);
  });

  it('B13 的高置信与低置信两张词表互不重叠', () => {
    // 处置由档位决定（`confidence === 'HIGH' ? BLOCK : CONFIRM_REQUIRED`），
    // 同一个 id 出现在两张表里会让同一处文案的处置取决于遍历顺序 —— §8.6「语义不确定项
    // 不升级为硬拦」就不能成立了。两张表各自也不得有重复 id。
    const high = idsOf(INAPPROPRIATE_HIGH);
    const low = idsOf(INAPPROPRIATE_LOW);
    expect(
      high.filter((id) => low.includes(id)),
      '同一 id 不得同时是 HIGH 与 LOW',
    ).toEqual([]);
    expect(new Set(high).size, '高置信表无重复').toBe(high.length);
    expect(new Set(low).size, '低置信表无重复').toBe(low.length);
  });

  it('B12 词表全部是 LOW 档（§8.3「只标记确认，不硬拦」）', () => {
    // B12 的处置上限是 CONFIRM_REQUIRED，所以它的词表**不该**出现 HIGH 档：
    // 一个 HIGH 档条目在别的规则里意味着「高置信硬拦」，放在 B12 只会误导读词表的人。
    expect(
      CAPABILITY_CLAIM_TERMS.filter((entry) => entry.tier !== 'LOW').map((entry) => entry.id),
      'B12 词表的档位',
    ).toEqual([]);
  });

  it('两份词表的 id 都是合法的子类型字符串（小写连字符，无空白）', () => {
    // 子类型要进 §6.2 的 `findingId` HMAC，也会出现在 D3b 的语料表里；
    // 一个带空格或大写的 id 不会被任何门拦下，但会让两份报表对不上。
    const shape = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const entry of [...CAPABILITY_CLAIM_TERMS, ...INAPPROPRIATE_HIGH, ...INAPPROPRIATE_LOW]) {
      expect(shape.test(entry.id), `词表 id ${entry.id} 的形状`).toBe(true);
    }
    for (const subType of [...B12_SUB_TYPES, ...B13_SUB_TYPES]) {
      expect(shape.test(subType), `子类型 ${subType} 的形状`).toBe(true);
    }
  });
});

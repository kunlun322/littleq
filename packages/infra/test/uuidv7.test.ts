/**
 * UUIDv7 生成器的布局测试（Layer A：确定性，不碰数据库）。
 *
 * ## 为什么这个文件存在
 *
 * `newUuidV7` 最初把 RFC 4122 的变体位写在了 **byte 7**，而它实际在 **byte 8**
 * （连字符按 8-4-4-4-12 切分，版本半字节是第 3 组的第一个字符 = byte 6 的高 4 位，
 * 变体的两个位是第 4 组的第一个字符 = byte 8 的高 2 位）。
 *
 * 那个错的产物**不是**"总是失败"：byte 8 未被触碰时是纯随机字节，其高 2 位恰好等于
 * `10` 的概率是 1/4，于是生成器约 3/4 抛错、约 1/4 正常返回。一次调用成功的用例
 * 完全看不见它。真正把它逼出来的是"每个样本都必须合法"这条**跨样本**断言。
 *
 * 所以本文件的核心不是某一条 `expect`，而是**样本量**：下面用 512 个样本，若变体位
 * 写错，全过的概率是 0.25^512 ≈ 10^-309。这类断言写成"生成一个、检查一个"就是空门。
 *
 * ## 为什么可以确定性
 *
 * 熵来自 `randomFillSync`，不可注入，但这里断言的全是**布局不变量**（哪些位被写死、
 * 哪些位保留熵、时间戳落在哪 48 位），它们对任意熵都成立；需要固定时刻的用例走
 * `newUuidV7(now)` 的显式入参，不读时钟。符合 `test/support.ts` 头部那条
 * "不读时钟、不读环境变量、不读 locale、不读文件系统"。
 */
import { describe, expect, it } from 'vitest';

import { isUuidV7 } from '@littleq/domain';

import { newUuidV7, unixTsMsOfUuidV7 } from '../src/index.js';

/** 8-4-4-4-12 里，版本半字节与变体半字节的字符串下标（不是字节下标）。 */
const VERSION_CHAR_INDEX = 14;
const VARIANT_CHAR_INDEX = 19;
/** 见文件头：样本量本身就是断言的一部分，不要调小。 */
const SAMPLE_COUNT = 512;

function samples(count: number = SAMPLE_COUNT): readonly string[] {
  return Array.from({ length: count }, () => newUuidV7());
}

describe('UUIDv7 布局', () => {
  it(`正对照：${SAMPLE_COUNT} 个样本全部通过 domain 的 isUuidV7`, () => {
    const values = samples();
    expect(values.length).toBe(SAMPLE_COUNT);

    const rejected = values.filter((value) => !isUuidV7(value));
    // 逐条列出前几个坏值，而不只报个数：出问题时"哪个半字节错了"直接可见。
    expect(rejected.slice(0, 5), `${rejected.length}/${values.length} 个样本非法`).toEqual([]);
  });

  it('版本半字节恒为 7，且落在第 3 组第一个字符', () => {
    const versions = new Set(samples().map((value) => value.charAt(VERSION_CHAR_INDEX)));
    expect([...versions]).toEqual(['7']);
  });

  it('变体半字节只在 8/9/a/b 里取值，一次都不落在 c-f', () => {
    // 这条是那个 off-by-one 的**判别式**：byte 8 未被写死时它是均匀随机字节，
    // 高半字节会均匀铺满 0-f，512 个样本里出现 c-f 是必然事件。
    const variants = new Set(samples().map((value) => value.charAt(VARIANT_CHAR_INDEX)));
    const allowed = new Set(['8', '9', 'a', 'b']);
    const outside = [...variants].filter((nibble) => !allowed.has(nibble));
    expect(outside, `变体半字节越界：${[...variants].join(',')}`).toEqual([]);
    // 反向也要钉住：若有人把 byte 8 整个写死成 0x80，这里会只剩 '8'，
    // 那就是把 6 位熵扔掉了 —— 上一条断言看不出这种退化。
    expect(variants.size, '变体半字节应覆盖 8/9/a/b 四种').toBe(4);
  });

  it('rand_b 真的携带熵，而不是被清零', () => {
    // 布局断言的一个盲区：把所有随机字节置零同样能通过上面每一条
    // （版本、变体都"合法"，pattern 也匹配）。这里检查尾部 12 个 hex 字符
    // 在样本之间确实变化。
    const tails = new Set(samples(64).map((value) => value.slice(24)));
    expect(tails.size).toBe(64);
  });

  it('同一毫秒内不产生重复 ID', () => {
    const values = samples();
    expect(new Set(values).size).toBe(SAMPLE_COUNT);
  });
});

describe('UUIDv7 时间戳', () => {
  it('unixTsMsOfUuidV7 取回注入的毫秒值', () => {
    // 一个"合法但不好记"的时刻：非整秒、非 2 的幂，能暴露截断/取整错误。
    const now = 1_782_000_123_457;
    expect(unixTsMsOfUuidV7(newUuidV7(now))).toBe(now);
  });

  it('时间戳占高 48 位 ⇒ 字符串序等于创建时刻序', () => {
    const earlier = newUuidV7(1_700_000_000_000);
    const later = newUuidV7(1_800_000_000_000);
    expect(earlier < later).toBe(true);
    expect([later, earlier].toSorted()).toEqual([earlier, later]);
  });

  it('48 位边界内的最大时刻可编码', () => {
    const max = 2 ** 48 - 1;
    expect(unixTsMsOfUuidV7(newUuidV7(max))).toBe(max);
    expect(unixTsMsOfUuidV7(newUuidV7(0))).toBe(0);
  });

  it('越界或非整数的 now 抛 RangeError，不静默截断', () => {
    const cases: readonly [string, number][] = [
      ['负数', -1],
      ['超过 48 位', 2 ** 48],
      ['非整数', 1_700_000_000_000.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ];
    expect(cases.length).toBe(5);
    for (const [label, now] of cases) {
      expect(() => newUuidV7(now), label).toThrow(RangeError);
    }
  });
});

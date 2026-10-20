/**
 * `src/scan/hash.ts` 的自证 —— 它自己的文件头写着「用 NIST/RFC 4231 公开向量自证」，
 * 这份文件就是那句话的兑现。
 *
 * ## 为什么这个包要自己实现 SHA-256 而不是用 `node:crypto`
 *
 * `apps/web` 的合规 bundle 以 `platform: 'browser'` 打包，本包被它的 barrel 直接引用；
 * 引入 `node:` 内建模块会让浏览器侧解析失败（`hash.ts` 头部同一段理由）。
 * 代价是：**摘要的正确性不再有内建库兜底**，只能靠公开向量与交叉验证。
 * 一旦这里错一位，`findingId`、`inputHash`、`confirmationScopeHash`、资源图指纹全部跟着错，
 * 而它们的错误形态是「稳定但不一致」—— 最难查的那一类。
 *
 * ## 三层证据，缺一层就有空洞
 *
 * 1. **公开向量**（NIST FIPS 180-4 / RFC 4231）：证明实现与标准一致，不依赖任何本地环境。
 * 2. **`node:crypto` 交叉验证**：证明在向量之外的输入上也一致 —— 特别是跨块边界、
 *    长 key（>64 字节要先摘要）、空输入这三种最容易写错的形状。
 * 3. **确定性性质**：同输入同输出、不同输入不同输出、`canonicalJson` 与键插入顺序无关。
 *    §6.5 的 `confirmationScopeHash` 要求「可复算」，靠的就是这一层。
 *
 * 向量与交叉验证**同时**断言是刻意的自诊断设计：只有向量红 ⇒ 是这份文件里的常量抄错了；
 * 只有交叉验证红 ⇒ 是实现错了；两者都红 ⇒ 环境有问题。分开写就分不清这三种情况。
 */

import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  canonicalJsonHash,
  hmacOfText,
  hmacSha256,
  hmacSha256Hex,
  sha256,
  sha256Hex,
  sha256OfText,
  toHex,
  utf8,
} from '../src/scan/hash.js';

function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function nodeHmacSha256Hex(key: Uint8Array, message: Uint8Array): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function repeated(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

/**
 * NIST FIPS 180-4 的 SHA-256 公开向量。
 * 三条分别覆盖：空输入（填充只剩一个块）、单块内短输入、跨块的 56 字节输入
 * （56 + 1 + 8 = 65 > 64，所以必须开第二个块 —— 长度域写错就死在这一条上）。
 */
const SHA256_VECTORS: readonly { readonly text: string; readonly digest: string }[] = [
  {
    text: '',
    digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    text: 'abc',
    digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    text: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    digest: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
];

/**
 * RFC 4231 的 HMAC-SHA-256 公开向量。
 * 覆盖：短 key（case 1/2/3/4）、**长于块大小的 key**（case 6/7，必须先对 key 做一次摘要）、
 * 以及长 key + 长数据（case 7，跨块与长 key 两个难点叠在一起）。
 */
const HMAC_VECTORS: readonly {
  readonly name: string;
  readonly key: Uint8Array;
  readonly data: Uint8Array;
  readonly digest: string;
}[] = [
  {
    name: 'RFC 4231 case 1',
    key: repeated(0x0b, 20),
    data: utf8('Hi There'),
    digest: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  },
  {
    name: 'RFC 4231 case 2',
    key: utf8('Jefe'),
    data: utf8('what do ya want for nothing?'),
    digest: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  },
  {
    name: 'RFC 4231 case 3',
    key: repeated(0xaa, 20),
    data: repeated(0xdd, 50),
    digest: '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
  },
  {
    name: 'RFC 4231 case 4',
    key: bytes(
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      0x07,
      0x08,
      0x09,
      0x0a,
      0x0b,
      0x0c,
      0x0d,
      0x0e,
      0x0f,
      0x10,
      0x11,
      0x12,
      0x13,
      0x14,
      0x15,
      0x16,
      0x17,
      0x18,
      0x19,
    ),
    data: repeated(0xcd, 50),
    digest: '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
  },
  {
    name: 'RFC 4231 case 6（key 长于块大小）',
    key: repeated(0xaa, 131),
    data: utf8('Test Using Larger Than Block-Size Key - Hash Key First'),
    digest: '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  },
  {
    name: 'RFC 4231 case 7（key 长于块大小 + 数据也跨块）',
    key: repeated(0xaa, 131),
    data: utf8(
      'This is a test using a larger than block-size key and a larger than block-size data. ' +
        'The key needs to be hashed before being used by the HMAC algorithm.',
    ),
    digest: '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
  },
];

/**
 * 固定种子的线性同余发生器。
 * 刻意不用 `Math.random()`：性质测试必须可复现，否则一次偶发失败无法重跑定位。
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('hash：NIST FIPS 180-4 公开向量', () => {
  for (const vector of SHA256_VECTORS) {
    const label = vector.text === '' ? '(空输入)' : vector.text.slice(0, 24);
    it(`sha256(${label}) 与标准一致`, () => {
      expect(sha256Hex(utf8(vector.text)), '公开向量').toBe(vector.digest);
      expect(sha256Hex(utf8(vector.text)), '与 node:crypto 交叉验证').toBe(
        nodeSha256Hex(utf8(vector.text)),
      );
      expect(toHex(sha256(utf8(vector.text))), 'toHex 与 sha256Hex 同一条路径').toBe(vector.digest);
    });
  }

  it('sha256 的摘要恒为 32 字节 / 64 个小写十六进制字符', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128]) {
      const digest = sha256(repeated(0x61, length));
      expect(digest.length, `${length} 字节输入`).toBe(32);
      expect(toHex(digest), `${length} 字节输入的十六进制形状`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('块边界两侧（55/56/63/64/65 字节）都与 node:crypto 一致', () => {
    // 填充规则是「补 0x80、补零、末尾 8 字节大端长度」，
    // 55/56 与 63/64/65 正好是「刚好放得下」与「放不下必须多开一块」的分界。
    for (const length of [55, 56, 63, 64, 65, 119, 120]) {
      const input = repeated(0x61, length);
      expect(sha256Hex(input), `${length} 字节`).toBe(nodeSha256Hex(input));
    }
  });

  it('一百万个 `a`（NIST 的长输入向量）与标准一致', () => {
    const input = repeated(0x61, 1_000_000);
    expect(sha256Hex(input)).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
    expect(sha256Hex(input)).toBe(nodeSha256Hex(input));
  });

  it('非 ASCII 输入按 UTF-8 编码后与 node:crypto 一致', () => {
    // `utf8()` 用的是 `TextEncoder`；中文、emoji、组合字符都要走同一条编码路径。
    // 作品的文案里全是中文，这一条不是边角料。
    for (const text of ['小星星', '云存档 ☁️', 'áéıóú', '𝄞 mixed 中英']) {
      expect(sha256OfText(text), text).toBe(nodeSha256Hex(utf8(text)));
      expect(sha256OfText(text)).toBe(sha256Hex(utf8(text)));
    }
  });
});

describe('hash：RFC 4231 HMAC-SHA-256 公开向量', () => {
  for (const vector of HMAC_VECTORS) {
    it(`${vector.name} 与标准一致`, () => {
      expect(hmacSha256Hex(vector.key, vector.data), '公开向量').toBe(vector.digest);
      expect(hmacSha256Hex(vector.key, vector.data), '与 node:crypto 交叉验证').toBe(
        nodeHmacSha256Hex(vector.key, vector.data),
      );
      expect(toHex(hmacSha256(vector.key, vector.data)), 'toHex 同一条路径').toBe(vector.digest);
    });
  }

  it('key 恰好 64 字节（块大小）时不预先摘要，也与 node:crypto 一致', () => {
    // `hmacSha256` 的分支是 `key.length > BLOCK_BYTES ? sha256(key) : key`，
    // 64 是「不摘要」那一侧的边界值，65 才跨到另一侧。两侧都要过。
    for (const length of [63, 64, 65]) {
      const key = repeated(0x5a, length);
      const data = utf8('littleq');
      expect(hmacSha256Hex(key, data), `key ${length} 字节`).toBe(nodeHmacSha256Hex(key, data));
    }
  });

  it('空 key 与空消息也与 node:crypto 一致', () => {
    expect(hmacSha256Hex(new Uint8Array(0), new Uint8Array(0))).toBe(
      nodeHmacSha256Hex(new Uint8Array(0), new Uint8Array(0)),
    );
    expect(hmacOfText(new Uint8Array(0), '')).toBe(nodeHmacSha256Hex(new Uint8Array(0), utf8('')));
  });

  it('hmacOfText 就是「key 原样 + 消息按 UTF-8」，与 node:crypto 逐字相同', () => {
    // `findingId` 全靠这一条：`support.ts` 的 `expectedFindingId` 用 node:crypto 独立复算，
    // 两边必须逐字相同，否则归因断言会变成一场自说自话。
    const key = utf8('littleq-scanner-v1|scanner-test-v1|ruleset-test-v1');
    for (const text of [
      'B1\u0000abc123\u0000-\u0000external-url',
      'B13\u0000文件\u0000range:3:5-3:9\u0000gambling-money',
      '',
    ]) {
      expect(hmacOfText(key, text), JSON.stringify(text)).toBe(
        createHmac('sha256', key).update(text, 'utf8').digest('hex'),
      );
    }
  });
});

describe('hash：确定性与抗碰撞的性质（固定种子，可复现）', () => {
  it('同输入同输出，不同输入不同输出', () => {
    const random = lcg(20261020);
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const length = Math.floor(random() * 200);
      const input = new Uint8Array(length);
      for (let offset = 0; offset < length; offset += 1) {
        input[offset] = Math.floor(random() * 256);
      }
      const digest = sha256Hex(input);
      expect(digest, `${length} 字节随机输入也要与 node:crypto 一致`).toBe(nodeSha256Hex(input));
      expect(seen.has(digest), `摘要冲突：${digest}`).toBe(false);
      seen.add(digest);
    }
    expect(seen.size, '200 个不同输入').toBe(200);
  });

  it('HMAC 与裸摘要不同，且换一个 key 就换一个结果', () => {
    // §6.2 要 HMAC 而不是裸 hash 的理由：裸 hash 让「命中了什么」变成可离线枚举的口令。
    const message = utf8('B1\u0000abc\u0000-\u0000external-url');
    const keyA = utf8('key-a');
    const keyB = utf8('key-b');
    const plain = sha256Hex(message);
    const withA = hmacSha256Hex(keyA, message);
    const withB = hmacSha256Hex(keyB, message);
    expect(withA).not.toBe(plain);
    expect(withB).not.toBe(plain);
    expect(withA, '不同 key 必须给出不同 findingId').not.toBe(withB);
    expect(hmacSha256Hex(keyA, message), '同 key 同消息必须稳定').toBe(withA);
  });

  it('改一个字节就改整个摘要', () => {
    const base = utf8('littleq');
    const mutated = new Uint8Array(base);
    mutated[mutated.length - 1] = (mutated[mutated.length - 1] ?? 0) ^ 0x01;
    expect(sha256Hex(base)).not.toBe(sha256Hex(mutated));
  });
});

describe('hash：canonicalJson 的规范化（§6.5 要求可复算）', () => {
  it('对象键按 UTF-16 码元升序，与插入顺序无关', () => {
    const forward = { b: 1, a: 2, c: 3 };
    const backward = { c: 3, a: 2, b: 1 };
    expect(canonicalJson(forward)).toBe('{"a":2,"b":1,"c":3}');
    expect(canonicalJson(backward), '键顺序不同的同一个对象必须规范化成同一串').toBe(
      canonicalJson(forward),
    );
    expect(canonicalJsonHash(forward)).toBe(canonicalJsonHash(backward));
  });

  it('嵌套对象逐层排序，数组保序', () => {
    const nested = { z: { b: [3, 1, 2], a: { y: 1, x: 2 } }, a: null };
    expect(canonicalJson(nested)).toBe('{"a":null,"z":{"a":{"x":2,"y":1},"b":[3,1,2]}}');
    // 数组**不**排序：`[3,1,2]` 与 `[1,2,3]` 是两个不同的值，排了就等于篡改语义。
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('键名里的大写字母按码元序排在小写之前', () => {
    // `Array.prototype.sort()` 默认按 UTF-16 码元比较，所以 `'B' < 'a'`。
    // 这一条把「按码元」钉死：换成 locale 比较会让 `'a' < 'B'`，
    // 两份实现给出的 hash 就会分叉，而分叉只在特定键名组合下才显形。
    expect(canonicalJson({ a: 1, B: 2, _: 3 })).toBe('{"B":2,"_":3,"a":1}');
  });

  it('undefined 值的键被丢掉，null 保留', () => {
    // `JSON.stringify` 也丢 undefined，但两边必须一致：`confirmationScopeHash` 的输入里
    // 确实会出现「字段存在但值是 undefined」的形态。
    expect(canonicalJson({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
    expect(canonicalJson({ a: undefined, b: null, c: 1 })).toBe(JSON.stringify({ b: null, c: 1 }));
  });

  it('标量与转义', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-0), '负零规范化成 0，与 JSON.stringify 一致').toBe('0');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    // 与 JSON.stringify 逐条对齐（对象键序除外 —— 那正是规范化的全部意义）。
    expect(canonicalJson('小星星')).toBe(JSON.stringify('小星星'));
  });

  it('非有限数字与不支持的值类型抛 TypeError，而不是产出一个假 hash', () => {
    // 静默把 `NaN` 规范化成 `null` 会让两份不同的输入得到同一个 hash —— 正是 §6.5 要防的。
    expect(() => canonicalJson(Number.NaN)).toThrowError(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrowError(TypeError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrowError(TypeError);
    expect(() => canonicalJson(10n)).toThrowError(TypeError);
    expect(() => canonicalJson(() => 1)).toThrowError(TypeError);
    expect(() => canonicalJson(Symbol('s'))).toThrowError(TypeError);
  });

  it('canonicalJsonHash 等于「先规范化再 sha256」，与 node:crypto 一致', () => {
    const value = { b: [1, { d: 'x', c: true }], a: '中' };
    const canonical = canonicalJson(value);
    expect(canonicalJsonHash(value)).toBe(sha256OfText(canonical));
    expect(canonicalJsonHash(value)).toBe(nodeSha256Hex(utf8(canonical)));
  });
});

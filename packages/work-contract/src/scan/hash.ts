/**
 * 扫描器自用的 SHA-256 / HMAC-SHA256 / 规范化 JSON。
 *
 * 为什么不用 `node:crypto`：`apps/web` 的合规 bundle 以 `platform: 'browser'` 打包
 * （`tools/esbuild-config.mjs`），而本包被它的 barrel 直接引用；引入 `node:` 内建模块会让
 * 浏览器侧解析失败。这里只实现扫描器真正需要的三个原语，并用 NIST/RFC 4231 公开向量自证。
 *
 * `findingId` 之所以是 HMAC 而不是裸 hash（ZLQ-156 §6.2）：finding 会进入儿童可见的
 * summary 与成人确认记录，裸 hash 让「命中了什么」变成可离线枚举的口令；HMAC 用扫描器私有
 * key 把它变成不可预测的稳定标识，同时保留「同一命中跨片段/跨恢复得到同一 id」的去重语义。
 */

const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const BLOCK_BYTES = 64;

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export function sha256(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const totalBlocks = Math.ceil((input.length + 1 + 8) / BLOCK_BYTES);
  const total = totalBlocks * BLOCK_BYTES;
  const buffer = new Uint8Array(total);
  buffer.set(input);
  buffer[input.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(total - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(BLOCK_BYTES);

  for (let offset = 0; offset < total; offset += BLOCK_BYTES) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let hh = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  out.setUint32(0, h0);
  out.setUint32(4, h1);
  out.setUint32(8, h2);
  out.setUint32(12, h3);
  out.setUint32(16, h4);
  out.setUint32(20, h5);
  out.setUint32(24, h6);
  out.setUint32(28, h7);
  return digest;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const normalizedKey = key.length > BLOCK_BYTES ? sha256(key) : key;
  const block = new Uint8Array(BLOCK_BYTES);
  block.set(normalizedKey);
  const innerKey = new Uint8Array(BLOCK_BYTES);
  const outerKey = new Uint8Array(BLOCK_BYTES);
  for (let i = 0; i < BLOCK_BYTES; i += 1) {
    const byte = block[i] ?? 0;
    innerKey[i] = byte ^ 0x36;
    outerKey[i] = byte ^ 0x5c;
  }
  const innerInput = new Uint8Array(BLOCK_BYTES + message.length);
  innerInput.set(innerKey, 0);
  innerInput.set(message, BLOCK_BYTES);
  const innerDigest = sha256(innerInput);
  const outerInput = new Uint8Array(BLOCK_BYTES + innerDigest.length);
  outerInput.set(outerKey, 0);
  outerInput.set(innerDigest, BLOCK_BYTES);
  return sha256(outerInput);
}

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += HEX[byte >>> 4] ?? '0';
    text += HEX[byte & 0x0f] ?? '0';
  }
  return text;
}

export function sha256Hex(input: Uint8Array): string {
  return toHex(sha256(input));
}

export function hmacSha256Hex(key: Uint8Array, message: Uint8Array): string {
  return toHex(hmacSha256(key, message));
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function sha256OfText(text: string): string {
  return sha256Hex(utf8(text));
}

export function hmacOfText(key: Uint8Array, text: string): string {
  return hmacSha256Hex(key, utf8(text));
}

/**
 * 规范化 JSON：对象键按 UTF-16 码元升序，数组保序，只接受 JSON 值域。
 * `confirmationScopeHash`（ZLQ-156 §6.5）与 `inputHash` 都必须是可复算的确定值，
 * 不能因为键插入顺序不同就产生两个 hash。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: 非有限数字无法规范化');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: 不支持的值类型 ${typeof value}`);
}

export function canonicalJsonHash(value: unknown): string {
  return sha256OfText(canonicalJson(value));
}

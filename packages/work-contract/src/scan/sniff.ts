/**
 * 内容嗅探（ZLQ-156 §1.3：「扩展名、嗅探与声明一致」）。
 *
 * 只看头部魔数，不解码图片。SVG 是例外：它是文本，且 §1.3 明文「SVG 同样作为可执行风险输入扫描」，
 * 所以嗅到 `<svg` / XML 声明即判为 `image/svg+xml`。
 */

export type SniffResult = { mediaType: string; confidence: 'definite' | 'probable' } | null;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if ((bytes[offset + index] ?? 0) !== (signature[index] ?? 0)) return false;
  }
  return true;
}

function startsWithAscii(bytes: Uint8Array, text: string, offset = 0): boolean {
  return startsWith(
    bytes,
    [...text].map((char) => char.charCodeAt(0)),
    offset,
  );
}

/** ASCII 大小写不敏感前缀匹配（`<!DOCTYPE html>` / `<!doctype html>` 必须同判）。 */
function startsWithAsciiIgnoreCase(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    const byte = bytes[offset + index] ?? 0;
    const expected = text.charCodeAt(index);
    const lowerByte = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
    const lowerExpected = expected >= 0x41 && expected <= 0x5a ? expected + 0x20 : expected;
    if (lowerByte !== lowerExpected) return false;
  }
  return true;
}

/** 跳过 UTF-8 BOM 与前导空白，返回第一个有意义字节的位置。 */
function textStart(bytes: Uint8Array): number {
  let offset = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (offset < bytes.length) {
    const byte = bytes[offset] ?? 0;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      offset += 1;
      continue;
    }
    break;
  }
  return offset;
}

export function sniffMediaType(bytes: Uint8Array): SniffResult {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mediaType: 'image/png', confidence: 'definite' };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff]))
    return { mediaType: 'image/jpeg', confidence: 'definite' };
  if (startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')) {
    return { mediaType: 'image/gif', confidence: 'definite' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (startsWithAscii(bytes, 'RIFF') && startsWithAscii(bytes, 'WEBP', 8)) {
    const variant = bytes.slice(12, 16);
    const isAudio = startsWithAscii(variant, 'WAVE');
    return { mediaType: isAudio ? 'audio/wav' : 'image/webp', confidence: 'definite' };
  }
  if (startsWithAscii(bytes, 'wOFF')) return { mediaType: 'font/woff', confidence: 'definite' };
  if (startsWith(bytes, [0x77, 0x4f, 0x46, 0x32]))
    return { mediaType: 'font/woff2', confidence: 'definite' };
  if (startsWith(bytes, [0x00, 0x01, 0x00, 0x00, 0x00]))
    return { mediaType: 'font/ttf', confidence: 'probable' };
  if (startsWithAscii(bytes, 'OTTO')) return { mediaType: 'font/otf', confidence: 'definite' };
  if (startsWithAscii(bytes, '\u001aE\u00df\u00a3'))
    return { mediaType: 'video/webm', confidence: 'definite' };
  if (
    startsWithAscii(bytes, 'ID3') ||
    startsWith(bytes, [0xff, 0xfb]) ||
    startsWith(bytes, [0xff, 0xf3])
  ) {
    return { mediaType: 'audio/mpeg', confidence: 'probable' };
  }
  if (startsWithAscii(bytes, 'OggS')) return { mediaType: 'audio/ogg', confidence: 'probable' };
  if (startsWithAscii(bytes, 'fLaC')) return { mediaType: 'audio/wav', confidence: 'probable' };
  // ISO-BMFF (mp4/m4a/m4v)：ftyp box
  if (startsWithAscii(bytes, 'ftyp', 4)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (brand.startsWith('M4A')) return { mediaType: 'audio/mp4', confidence: 'definite' };
    return { mediaType: 'video/mp4', confidence: 'definite' };
  }

  const offset = textStart(bytes);
  if (
    startsWithAsciiIgnoreCase(bytes, '<?xml', offset) ||
    startsWithAsciiIgnoreCase(bytes, '<svg', offset)
  ) {
    return { mediaType: 'image/svg+xml', confidence: 'probable' };
  }
  if (
    startsWithAsciiIgnoreCase(bytes, '<!doctype html', offset) ||
    startsWithAsciiIgnoreCase(bytes, '<html', offset)
  ) {
    return { mediaType: 'text/html', confidence: 'probable' };
  }
  if (startsWith(bytes, [0x7b], offset) || startsWith(bytes, [0x5b], offset)) {
    return { mediaType: 'application/json', confidence: 'probable' };
  }
  return null;
}

/** 嗅探结果与声明/扩展名是否矛盾。`probable` 只对**图片/字体/音视频**这类二进制判定为矛盾。 */
export function sniffContradictsDeclared(sniffed: SniffResult, declared: string): boolean {
  if (!sniffed) return false;
  if (sniffed.mediaType === declared) return false;
  if (sniffed.confidence === 'probable' && sniffed.mediaType.startsWith('text/')) return false;
  return true;
}

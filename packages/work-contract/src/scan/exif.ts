/**
 * B13「图片 hash/元数据」的元数据一路：图片里是否带 GPS 坐标。
 *
 * 三条设计约束：
 * 1. **三态返回**。`true` = 真的找到 GPS 坐标；`false` = **证据为否**（没有 EXIF 载体，
 *    或载体读通了、里面没有 GPS）；`null` = **没有证据**（载体读不通，或扫到预算上限）。
 *    §6.2 要求把「没有证据」与「证据为否」分开报：把 `null` 折叠成 `false`，
 *    一个畸形 EXIF 的图片就会静默通过。反过来把「没有载体」也折叠进 `null` 同样错 ——
 *    那会让每一张不带 EXIF 的普通图片都变成待复核，噪声不是谨慎。
 * 2. **只读元数据，不解码像素**。整个函数最多触碰前 128 KiB，任何越界一律当「读不通」，
 *    绝不因为「没读完」推断出「没有 GPS」（§6.4 的同一条纪律）。
 * 3. **GPS IFD 里必须真的有坐标**。只出现 0x8825 指针而指向的 IFD 是空的，不算带 GPS ——
 *    相机固件经常留下空 GPS IFD，按指针存在就判定会把大批安全图片误拦（§8.6 的 ≤2%）。
 */

import { EXIF_GPS_IFD_TAG, EXIF_GPS_LATITUDE_TAG, EXIF_GPS_LONGITUDE_TAG } from './lexicon.js';

/** 超过这个字节数还没找到 EXIF 载体，就认为「读不通」。合法照片的 APP1 都在头部几十 KiB 内。 */
const MAX_EXIF_SCAN_BYTES = 128 * 1024;

/** EXIF 子 IFD 指针。GPS 指针正常挂在 IFD0，这里只在 IFD0 找（够用且不引入递归）。 */
const MAX_IFD_ENTRIES = 512;

const JPEG_SOI = [0xff, 0xd8];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if ((bytes[offset + index] ?? -1) !== prefix[index]) return false;
  }
  return true;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  let text = '';
  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) return '';
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * TIFF 头的起点，或「载体不存在」/「读不通」。
 *
 * 三态是**必需**的，`'absent'` 与 `null` 不能合并：
 * - `'absent'` = 扫完了整份字节（或撞到了该格式的结构性终点）也没有 EXIF 载体 ⇒ **证据为否**，
 *   上游可以判定「这张图没有 GPS」；
 * - `null` = 结构断了、或扫到 128 KiB 预算还没扫完 ⇒ **没有证据**，
 *   上游不得判定为干净（§6.4「绝不因为『没读完』给 PASS」）。
 *
 * 把两者合并成一个 `null` 会让**每一张**不带 EXIF 的普通 JPEG/PNG 都变成「没有证据」，
 * 于是一本 20 张插图的绘本会产出 20 条成人复核 —— 那不是谨慎，是噪声。
 */
type TiffStart = number | 'absent' | null;

/** 扫到预算上限还没扫完 ⇒ 没有证据；扫完了整份字节 ⇒ 载体确实不存在。 */
function exhausted(bytes: Uint8Array): 'absent' | null {
  return bytes.length <= MAX_EXIF_SCAN_BYTES ? 'absent' : null;
}

/** TIFF 头（`II*` / `MM*`）在整份字节里的起点；找不到载体 ⇒ 'absent'；读不通 ⇒ null。 */
function tiffStart(bytes: Uint8Array): TiffStart {
  if (startsWith(bytes, JPEG_SOI)) return jpegTiffStart(bytes);
  if (startsWith(bytes, PNG_SIGNATURE)) return pngTiffStart(bytes);
  if (fourcc(bytes, 0) === 'RIFF' && fourcc(bytes, 8) === 'WEBP') return webpTiffStart(bytes);
  // 不是这三种载体格式（SVG/GIF/AVIF，或根本不是图片）⇒ 谈不上 EXIF，证据为否。
  return 'absent';
}

function jpegTiffStart(bytes: Uint8Array): TiffStart {
  const limit = Math.min(bytes.length, MAX_EXIF_SCAN_BYTES);
  let index = 2;
  while (index + 4 <= limit) {
    if ((bytes[index] ?? -1) !== 0xff) return null; // 段结构断了 ⇒ 读不通
    const marker = bytes[index + 1] ?? -1;
    // SOS 之后是压缩像素数据，EXIF 不可能再出现 ⇒ 这是结构性终点，不是「读不通」。
    if (marker === 0xda || marker === 0xd9) return 'absent';
    const size = ((bytes[index + 2] ?? 0) << 8) | (bytes[index + 3] ?? 0);
    if (size < 2) return null;
    if (marker === 0xe1 && startsWith(bytes, EXIF_HEADER, index + 4))
      return index + 4 + EXIF_HEADER.length;
    index += 2 + size;
  }
  return exhausted(bytes);
}

function pngTiffStart(bytes: Uint8Array): TiffStart {
  const limit = Math.min(bytes.length, MAX_EXIF_SCAN_BYTES);
  let index = PNG_SIGNATURE.length;
  while (index + 12 <= limit) {
    const length =
      ((bytes[index] ?? 0) << 24) |
      ((bytes[index + 1] ?? 0) << 16) |
      ((bytes[index + 2] ?? 0) << 8) |
      (bytes[index + 3] ?? 0);
    if (length < 0) return null;
    if (fourcc(bytes, index + 4) === 'eXIf') return index + 8;
    if (fourcc(bytes, index + 4) === 'IEND') return 'absent'; // 结构性终点
    index += 12 + length;
  }
  return exhausted(bytes);
}

function webpTiffStart(bytes: Uint8Array): TiffStart {
  const limit = Math.min(bytes.length, MAX_EXIF_SCAN_BYTES);
  let index = 12;
  while (index + 8 <= limit) {
    const size =
      (bytes[index + 4] ?? 0) |
      ((bytes[index + 5] ?? 0) << 8) |
      ((bytes[index + 6] ?? 0) << 16) |
      ((bytes[index + 7] ?? 0) << 24);
    if (fourcc(bytes, index) === 'EXIF') {
      const payload = index + 8;
      // 早期 WebP 的 EXIF chunk 带一个 flag 字节，libwebp 现在写裸 TIFF；两种都接。
      if (isTiffHeader(bytes, payload)) return payload;
      if (isTiffHeader(bytes, payload + 1)) return payload + 1;
      return null; // 有 EXIF chunk 但里面不是 TIFF ⇒ 读不通
    }
    index += 8 + size + (size % 2);
  }
  return exhausted(bytes);
}

function isTiffHeader(bytes: Uint8Array, offset: number): boolean {
  const order = fourcc(bytes, offset);
  return order === 'II' || order === 'MM';
}

/**
 * 图片里是否有 GPS 坐标。
 *
 * - `true` = 真的找到 GPS 坐标；
 * - `false` = **证据为否** —— 这种格式谈不上 EXIF 载体，或扫完了整份字节/撞到结构性终点
 *   也没有载体，或载体读通了、GPS IFD 里没有坐标；
 * - `null` = **没有证据** —— 载体读不通，或扫到 128 KiB 预算上限还没扫完。
 *   上游不得把它当干净（§6.4），但也**不该**因此硬拦：它只够进成人复核。
 *
 * `bytes` 是整份文件字节。函数内部只用 `DataView` 读定长整数，任何越界都走 `null`。
 */
export function hasExifGps(bytes: Uint8Array): boolean | null {
  const start = tiffStart(bytes);
  if (start === 'absent') return false;
  if (start === null || !isTiffHeader(bytes, start)) return null;

  const little = fourcc(bytes, start) === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readU16 = (offset: number): number | null => {
    if (offset < 0 || offset + 2 > bytes.length) return null;
    try {
      return view.getUint16(offset, little);
    } catch {
      return null;
    }
  };
  const readU32 = (offset: number): number | null => {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    try {
      return view.getUint32(offset, little);
    } catch {
      return null;
    }
  };

  if (readU16(start + 2) !== 42) return null; // TIFF magic 不对 ⇒ 读不通
  const ifd0 = readU32(start + 4);
  if (ifd0 === null) return null;

  const gpsIfd = findIfdValue(readU16, readU32, start, ifd0, EXIF_GPS_IFD_TAG);
  if (gpsIfd === null) return false; // IFD0 读通了、没有 GPS 指针
  return ifdHasTag(readU16, start, gpsIfd, EXIF_GPS_LATITUDE_TAG) ||
    ifdHasTag(readU16, start, gpsIfd, EXIF_GPS_LONGITUDE_TAG)
    ? true
    : false;
}

function findIfdValue(
  readU16: (offset: number) => number | null,
  readU32: (offset: number) => number | null,
  tiffBase: number,
  ifdOffset: number,
  wantedTag: number,
): number | null {
  const absolute = tiffBase + ifdOffset;
  const count = readU16(absolute);
  if (count === null || count > MAX_IFD_ENTRIES) return null;
  for (let index = 0; index < count; index += 1) {
    const entry = absolute + 2 + index * 12;
    const tag = readU16(entry);
    if (tag === wantedTag) return readU32(entry + 8);
  }
  return null;
}

function ifdHasTag(
  readU16: (offset: number) => number | null,
  tiffBase: number,
  ifdOffset: number,
  wantedTag: number,
): boolean {
  const absolute = tiffBase + ifdOffset;
  const count = readU16(absolute);
  if (count === null || count > MAX_IFD_ENTRIES) return false;
  for (let index = 0; index < count; index += 1) {
    if (readU16(absolute + 2 + index * 12) === wantedTag) return true;
  }
  return false;
}

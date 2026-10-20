/**
 * 扫描器测试用的「一整包」构造器。
 *
 * B1–B13 的判定单位是包，不是文件：B1 要资源图，B10 要「压缩产物之外必须有可读源」，
 * 所以每个用例都得先有一份**结构合法**的 `work.json` + 清单 + 字节流。这个文件就是那份样板。
 *
 * 三条纪律：
 * 1. **sha256 用被测包自己的 `sha256Hex`，不用 `node:crypto`**。清单里的 hash 与被测代码算出的
 *    hash 必须同源，否则一个 hash 实现的 bug 会同时改掉期望值和实测值，永远测不出来。
 *    `hash.ts` 自身另有 NIST/RFC 4231 公开向量与 `node:crypto` 的交叉验证。
 * 2. **默认包必须是一件安全作品**。`safe-package-passes` 这条黑盒证明的判据就是它扫出 PASS；
 *    往默认包里加东西之前先想清楚它会不会把 PASS 变成 CONFIRM_REQUIRED。
 * 3. **不手搓 metadata**。`work.json` 由文件表推导，再走真实的 `validateWorkMetadata`。
 *    绕过那 16 条 refine，「包结构非法」这类负例就没有意义了。
 */

import { createHmac } from 'node:crypto';

import { locationKey } from '../src/scan/finding.js';
import { sha256Hex, utf8 } from '../src/scan/hash.js';
import { RULES, scanPackage } from '../src/scan/index.js';
import { LEXICON_REVISION, MEDIA_TYPE_ADMISSION } from '../src/scan/lexicon.js';
import {
  admittedMediaType,
  artifactSha256,
  comparePathBytes,
  ENTRY_FILE_NAME,
  LICENSE_REF_USER_ORIGINAL,
  MANIFEST_FILE_NAME,
  validateWorkMetadata,
} from '../src/scan/metadata.js';
import type { WorkAsset, WorkMetadata } from '../src/scan/metadata.js';
import type {
  FileRange,
  FileRef,
  FileRole,
  Finding,
  FindingLocation,
  RuleId,
  ScanFileSource,
  ScanPolicySnapshot,
  ScanReport,
  StartScanInput,
} from '../src/scan/types.js';

export const SCANNER_VERSION = 'scanner-test-v1';
export const RULESET_VERSION = 'ruleset-test-v1';
export const POLICY_REVISION = 'policy-test-r1';
export const STORAGE_KEY_PREFIX = 'littleq:work-1:';
export const WORK_ID = '019c8f3a-5c3e-7a11-9f2b-4c7d1e0a2b3c';
export const CREATED_AT = '2026-10-20T00:00:00Z';

/** `finding.ts` 的模块私有前缀。这里刻意硬编码同一份字面量：它一变，既有 findingId 全部失效。 */
const FINDING_KEY_PREFIX = 'littleq-scanner-v1';

export const DEFAULT_POLICY: ScanPolicySnapshot = {
  revision: POLICY_REVISION,
  adultApprovedCapabilities: [],
  storageKeyPrefix: STORAGE_KEY_PREFIX,
  lexiconRevision: LEXICON_REVISION,
  knownTrackingDomains: ['google-analytics.com', 'doubleclick.net'],
  denyListedImageHashes: [],
  allowWasm: false,
  allowPostMessageBridge: false,
};

// ---------------------------------------------------------------------------
// 扩展名 → mediaType
// ---------------------------------------------------------------------------

/**
 * `webm` 同时出现在 `audio/webm` 与 `video/webm` 两行，所以映射必须**先到先得**。
 * `new Map(pairs)` 是后到覆盖先到，会把音频 webm 判成视频。
 */
function extensionMediaTypeMap(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of MEDIA_TYPE_ADMISSION) {
    for (const extension of entry.extensions) {
      if (!map.has(extension)) map.set(extension, entry.mediaType);
    }
  }
  return map;
}

const MEDIA_TYPE_BY_EXTENSION = extensionMediaTypeMap();

export function mediaTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  const mediaType = MEDIA_TYPE_BY_EXTENSION.get(extension);
  if (mediaType === undefined) {
    throw new Error(`fixture 无法从扩展名推导 mediaType：${path}（请显式给出 mediaType）`);
  }
  return mediaType;
}

/** 可执行文本进 SOURCE（`index.html` 是 RUNTIME），媒体文件进 ASSET。 */
function roleFor(path: string, mediaType: string): FileRole {
  if (path === ENTRY_FILE_NAME) return 'RUNTIME';
  const kind = admittedMediaType(mediaType)?.kind;
  if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'font') return 'ASSET';
  return 'SOURCE';
}

// ---------------------------------------------------------------------------
// 图片字节。扫描器读结构与元数据，从不校验 CRC，所以程序化构造的最小图就够用。
// ---------------------------------------------------------------------------

function pngChunk(type: string, data: readonly number[]): number[] {
  const out: number[] = [];
  const length = data.length;
  out.push((length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  for (const char of type) out.push(char.charCodeAt(0));
  for (const byte of data) out.push(byte);
  out.push(0, 0, 0, 0); // CRC 占位
  return out;
}

function bigEndian(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** 最小结构的 PNG：签名 + IHDR + IDAT + IEND，共 61 字节，没有 eXIf 块 ⇒ GPS 证据为否。 */
export function minimalPng(width = 8, height = 8): Uint8Array {
  const ihdr = [...bigEndian(width), ...bigEndian(height), 8, 2, 0, 0, 0];
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk('IHDR', ihdr),
    ...pngChunk('IDAT', [0x78, 0x9c, 0x62, 0x00]),
    ...pngChunk('IEND', []),
  ]);
}

function jpegWithTiff(tiff: readonly number[]): Uint8Array {
  const payload = [...utf8('Exif\u0000\u0000'), ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (length >>> 8) & 0xff, length & 0xff, ...payload]);
}

/** 一条小端 TIFF IFD 条目（12 字节）。 */
function tiffEntry(tag: number, type: number, count: number, value: number): number[] {
  return [
    tag & 0xff,
    (tag >>> 8) & 0xff,
    type & 0xff,
    (type >>> 8) & 0xff,
    count & 0xff,
    (count >>> 8) & 0xff,
    0,
    0,
    value & 0xff,
    (value >>> 8) & 0xff,
    0,
    0,
  ];
}

/** GPS IFD 挂在 TIFF 偏移 26：TIFF 头 8 + IFD0（2 + 12×1 条目 + 4）= 26。 */
const GPS_IFD_OFFSET = 26;

/**
 * 带 GPS 坐标的 JPEG：IFD0 里挂 0x8825 指针，指向的 GPS IFD 里**真的有** 0x0002（纬度）。
 *
 * 只出现指针而 GPS IFD 为空不算带 GPS —— 相机固件常留空 IFD，按指针存在就判定会把大批
 * 安全图片误拦（§8.6 的 ≤2%）。所以下面两个构造器必须成对存在。
 */
export function jpegWithGpsExif(): Uint8Array {
  const ifd0 = [
    0x49,
    0x49,
    42,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
    ...tiffEntry(0x8825, 4, 1, GPS_IFD_OFFSET),
    0,
    0,
    0,
    0,
  ];
  const gpsIfd = [1, 0, ...tiffEntry(0x0002, 5, 3, 0), 0, 0, 0, 0];
  return jpegWithTiff([...ifd0, ...gpsIfd]);
}

/** 有 EXIF 载体、GPS IFD 里却没有坐标 ⇒「证据为否」，不是「没有证据」。 */
export function jpegWithEmptyGpsIfd(): Uint8Array {
  const ifd0 = [
    0x49,
    0x49,
    42,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
    ...tiffEntry(0x8825, 4, 1, GPS_IFD_OFFSET),
    0,
    0,
    0,
    0,
  ];
  return jpegWithTiff([...ifd0, 0, 0]);
}

/** 段结构断掉的 JPEG ⇒ `hasExifGps` 返回 `null`：没有证据，只够进成人复核，不够硬拦。 */
export function jpegWithBrokenSegments(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
}

// ---------------------------------------------------------------------------
// 默认的安全作品
// ---------------------------------------------------------------------------

export const SAFE_INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>小星星</title>
    <link rel="stylesheet" href="styles/main.css" />
  </head>
  <body>
    <h1>小星星</h1>
    <p>用左右方向键接住掉下来的星星。</p>
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
  </body>
</html>
`;

export const SAFE_MAIN_CSS = `#stage {
  display: block;
  margin: 0 auto;
  background: #101820;
}

h1 {
  font-size: 20px;
}
`;

/**
 * 默认脚本刻意用 §2.4 点名的安全写法：`requestAnimationFrame` 做主循环（B9 的反例之一）、
 * 局部函数名不与任何网络全局重名（B2 的反例之一）、Canvas 绘制（B9 的「可见游戏数值计算」）。
 */
export const SAFE_GAME_JS = `const stage = document.getElementById('stage');
const context = stage.getContext('2d');
let score = 0;

function drawStar(positionX, positionY) {
  context.fillRect(positionX, positionY, 6, 6);
}

function advance() {
  score += 1;
  context.clearRect(0, 0, 320, 240);
  drawStar(score % 320, 120);
  requestAnimationFrame(advance);
}

requestAnimationFrame(advance);
`;

/**
 * `minimalPng()` 的 base64 data URL。
 *
 * §8.3 B1 允许「受限 `data/blob`」，`ALLOWED_DATA_MEDIA_TYPES` 里有 `image/png`。用**真的** PNG
 * 字节而不是随手写的 `iVBORw0KGgo=`：半截 magic 会让「data 内容仍二次检查」这条在别处生效时
 * 变成一个说不清是解码失败还是判据失败的红灯。
 */
export function pngDataUrl(): string {
  return `data:image/png;base64,${Buffer.from(minimalPng()).toString('base64')}`;
}

/**
 * B1 反例用的入口页 —— §2.4「说明文字中的许可 URL」。
 *
 * 关键在那个 `<p>`：一条 `https://` URL 以**纯文本**出现在页面里。正则实现看见 `https://` 就拦，
 * 而这只是署名说明，既不加载也不请求。同一页还带一个合法 data 图片，覆盖 B1 的两种放行形态。
 */
export const ENTRY_HTML_WITH_LICENSE_NOTE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>星星收集册</title>
    <link rel="stylesheet" href="styles/main.css" />
  </head>
  <body>
    <h1>星星收集册</h1>
    <img src="${pngDataUrl()}" alt="一枚星星" width="8" height="8" />
    <p>封面素材许可说明：https://creativecommons.org/publicdomain/zero/1.0/</p>
    <p>上面那行只是文字，页面不会去访问它。</p>
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
  </body>
</html>
`;

export type FixtureFile = {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly role?: FileRole;
  readonly mediaType?: string;
  /** ASSET 角色的素材登记；不给就按 USER_ORIGINAL 自动生成一条。 */
  readonly asset?: Partial<WorkAsset>;
};

export const DEFAULT_FILES: readonly FixtureFile[] = [
  { path: ENTRY_FILE_NAME, content: SAFE_INDEX_HTML },
  { path: 'styles/main.css', content: SAFE_MAIN_CSS },
  { path: 'game.js', content: SAFE_GAME_JS },
  { path: 'assets/cover.png', content: minimalPng() },
];

/** 按 `path` 覆盖或追加，其余保持不变 —— 每条规则的负例都靠它只改一个文件。 */
export function withFiles(...overrides: readonly FixtureFile[]): readonly FixtureFile[] {
  const merged = [...DEFAULT_FILES];
  for (const override of overrides) {
    const index = merged.findIndex((file) => file.path === override.path);
    if (index < 0) merged.push(override);
    else merged[index] = override;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export type BuiltFile = {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly role: FileRole;
  readonly mediaType: string;
};

export type PackageOptions = {
  /** 完整替换默认文件表。与 `overrides` 二选一。 */
  readonly files?: readonly FixtureFile[];
  /** 按 path 覆盖/追加到默认文件表上。 */
  readonly overrides?: readonly FixtureFile[];
  readonly title?: string;
  readonly description?: string;
  readonly authorNickname?: string;
  readonly workType?: WorkMetadata['workType'];
  readonly ageBand?: WorkMetadata['ageBand'];
  readonly visibility?: WorkMetadata['visibility'];
  readonly capabilities?: readonly WorkMetadata['capabilities'][number][];
  readonly sourceEntryPaths?: readonly string[];
  readonly policy?: Partial<ScanPolicySnapshot>;
  readonly scannerVersion?: string;
  readonly rulesetVersion?: string;
};

export type BuiltPackage = {
  readonly input: StartScanInput;
  readonly source: ScanFileSource;
  readonly metadata: WorkMetadata;
  readonly manifestText: string;
  readonly files: readonly BuiltFile[];
  readonly refs: readonly FileRef[];
  /** path → 实测 sha256，**含** `work.json`。复算 `findingId` 要用它。 */
  readonly hashes: Readonly<Record<string, string>>;
};

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? utf8(content) : content;
}

function materialize(specs: readonly FixtureFile[]): BuiltFile[] {
  return specs.map((spec) => {
    const bytes = bytesOf(spec.content);
    const mediaType = spec.mediaType ?? mediaTypeForPath(spec.path);
    return {
      path: spec.path,
      bytes,
      sha256: sha256Hex(bytes),
      role: spec.role ?? roleFor(spec.path, mediaType),
      mediaType,
    };
  });
}

function defaultAsset(path: string, ordinal: number, override: Partial<WorkAsset>): WorkAsset {
  const base: WorkAsset = {
    path,
    sourceKind: 'USER_ORIGINAL',
    sourceName: `素材 ${ordinal}`,
    sourceUrl: null,
    creator: '小Q',
    licenseId: LICENSE_REF_USER_ORIGINAL,
    licenseTextPath: null,
    attribution: '',
    redistributionAllowed: true,
    modified: false,
  };
  return { ...base, ...override };
}

export function buildPackage(options: PackageOptions = {}): BuiltPackage {
  if (options.files !== undefined && options.overrides !== undefined) {
    throw new Error('buildPackage: files 与 overrides 不能同时给');
  }
  const specs =
    options.files ??
    (options.overrides === undefined ? DEFAULT_FILES : withFiles(...options.overrides));
  const materialized = materialize(specs);
  const byPath = new Map(materialized.map((file) => [file.path, file]));

  if (byPath.get(ENTRY_FILE_NAME) === undefined) {
    throw new Error(`fixture 缺少运行入口 ${ENTRY_FILE_NAME}`);
  }

  const declaredFiles = materialized
    .filter((file) => file.path !== MANIFEST_FILE_NAME)
    .map((file) => ({
      path: file.path,
      role: file.role,
      bytes: file.bytes.byteLength,
      sha256: file.sha256,
      mediaType: file.mediaType,
    }));

  const assetSpecs = materialized.filter((file) => file.role === 'ASSET');
  const assets = assetSpecs.map((file, ordinal) =>
    defaultAsset(
      file.path,
      ordinal + 1,
      specs.find((spec) => spec.path === file.path)?.asset ?? {},
    ),
  );

  const firstAsset = assets[0];
  const coverPath = firstAsset?.path ?? 'assets/cover.png';
  if (byPath.get(coverPath) === undefined) {
    throw new Error(`fixture 封面不在文件表里：${coverPath}（ASSET 文件至少要有一个）`);
  }

  const sourceEntryPaths =
    options.sourceEntryPaths ??
    materialized
      .filter((file) => file.role === 'SOURCE' && file.path !== ENTRY_FILE_NAME)
      .map((file) => file.path);

  const manifestObject: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    contractVersion: '1.0.0',
    workId: WORK_ID,
    version: 1,
    publicationId: null,
    title: options.title ?? '小星星',
    description: options.description ?? '用左右方向键接住掉下来的星星。',
    workType: options.workType ?? 'GAME',
    ageBand: options.ageBand ?? 'L1',
    authorNickname: options.authorNickname ?? '小Q',
    visibility: options.visibility ?? 'PRIVATE',
    commentsEnabled: false,
    commentsScope: 'NONE',
    createdAt: CREATED_AT,
    publishedAt: null,
    entry: ENTRY_FILE_NAME,
    cover: { path: coverPath, alt: '封面：一颗小星星', width: 8, height: 8 },
    files: declaredFiles,
    assets,
    capabilities: options.capabilities ?? [],
    sourceEntryPaths,
  };

  const manifestText = `${JSON.stringify(manifestObject, null, 2)}\n`;
  const validation = validateWorkMetadata(JSON.parse(manifestText));
  if (!validation.ok) {
    throw new Error(`fixture 的 work.json 不合法：${JSON.stringify(validation.issues)}`);
  }

  const manifestBytes = utf8(manifestText);
  const manifestSha256 = sha256Hex(manifestBytes);
  const all: BuiltFile[] = [
    ...materialized,
    {
      path: MANIFEST_FILE_NAME,
      bytes: manifestBytes,
      sha256: manifestSha256,
      role: 'SOURCE',
      mediaType: 'application/json',
    },
  ];

  const refs: FileRef[] = all.map(toFileRef);
  const hashes: Record<string, string> = {};
  for (const file of all) hashes[file.path] = file.sha256;

  const artifactHash = artifactSha256(
    all
      .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength }))
      .sort((left, right) => comparePathBytes(left.path, right.path)),
  );

  return {
    input: {
      artifactHash,
      manifestHash: manifestSha256,
      schemaVersion: '1.0.0',
      contractVersion: '1.0.0',
      scannerVersion: options.scannerVersion ?? SCANNER_VERSION,
      rulesetVersion: options.rulesetVersion ?? RULESET_VERSION,
      metadata: validation.metadata,
      files: memoryFileSource(all),
      policySnapshot: { ...DEFAULT_POLICY, ...options.policy },
    },
    source: memoryFileSource(all),
    metadata: validation.metadata,
    manifestText,
    files: all,
    refs,
    hashes,
  };
}

function toFileRef(file: BuiltFile): FileRef {
  return {
    path: file.path,
    role: file.role,
    bytes: file.bytes.byteLength,
    sha256: file.sha256,
    mediaType: file.mediaType,
    objectRef: `object:work-1/${file.path}`,
  };
}

function memoryFileSource(files: readonly BuiltFile[]): ScanFileSource {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return {
    list(): readonly FileRef[] {
      return files.map(toFileRef);
    },
    open(path: string, range?: FileRange): Promise<ReadableStream<Uint8Array>> {
      const file = byPath.get(path);
      if (file === undefined) return Promise.reject(new Error(`fixture 里没有这个文件：${path}`));
      const start = range?.offset ?? 0;
      const length = range?.length ?? file.bytes.byteLength - start;
      // 复制而不是 subarray：驱动把 chunk 攒起来再整体 hash，共享底层 buffer 会让
      // 「读到的是不是这一段的字节」依赖调用方有没有改写过原数组。
      const slice = file.bytes.slice(start, start + length);
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(slice);
            controller.close();
          },
        }),
      );
    },
  };
}

/**
 * 「调用方给错输入」的负例用：结构上就不合法的 metadata。
 *
 * `Scanner.start` 对它抛 `InvalidManifestError`，而不是产出一条 finding ——
 * 一份非法清单不是扫描结论，是调用方的 bug（ZLQ-156 §6.1）。
 */
export function brokenMetadata(): WorkMetadata {
  return { schemaVersion: '9.9.9' } as unknown as WorkMetadata;
}

// ---------------------------------------------------------------------------
// 结果断言用的助手
// ---------------------------------------------------------------------------

export async function scanToReport(built: BuiltPackage): Promise<ScanReport> {
  const result = await scanPackage(built.input);
  if (!result.ok) {
    throw new Error(`扫描没有产出报告：${result.code}（retryable=${result.retryable}）`);
  }
  return result.report;
}

export function findingsOf(report: ScanReport, ruleId: RuleId): Finding[] {
  return report.findings.filter((finding) => finding.ruleId === ruleId);
}

export function ruleIdsWithFindings(report: ScanReport): RuleId[] {
  return [...new Set(report.findings.map((finding) => finding.ruleId))];
}

/** 13 条规则各自声明的子类型表。用来断言「逐条实现、不得合并」。 */
export function subTypeRegistry(): ReadonlyMap<RuleId, readonly string[]> {
  return new Map(RULES.map((rule) => [rule.id, rule.subTypes]));
}

/**
 * 把一条 finding 归因回产出它的规则子类型。
 *
 * `Finding` 的输出形状里**没有** `subType`（§6.2：子类型只进 HMAC，不外露），所以归因靠复算：
 * 用 `finding.ts` 同一套身份串与 HMAC key 逐个试声明过的子类型，命中谁就是谁。
 * 这样「声明了却走不到的子类型」与「走到了却没声明的子类型」都会暴露出来。
 */
export function attributeSubType(
  finding: Finding,
  built: BuiltPackage,
  subTypes: readonly string[],
): string | null {
  const fileHash = built.hashes[finding.path];
  if (fileHash === undefined) return null;
  for (const subType of subTypes) {
    const expected = expectedFindingId(built, finding.ruleId, fileHash, finding.location, subType);
    if (expected === finding.findingId) return subType;
  }
  return null;
}

/**
 * 复算 `findingId`。
 *
 * **HMAC 用 `node:crypto` 自己算，不用被测包的 `hmacOfText`**：§6.2 只规定了「HMAC(规则/文件
 * hash/安全位置/规则子类型)」这个构造，没规定用哪套实现。用 `node:crypto` 复算，就等于顺带验证
 * 了 key 派生（`前缀|scannerVersion|rulesetVersion`）与身份串的字段顺序 —— 换成被测包自己的
 * `hmacOfText`，key 写错时两边会一起错，什么都测不出来。
 *
 * `locationKey` 仍从被测包导入：它是 §6.5 那条「metadata 定位用 JSON Pointer、源码定位用行列」
 * 的格式化函数，重写一遍只会把三种形态的字符串约定复制成两份、日后各自漂移。
 */
export function expectedFindingId(
  built: BuiltPackage,
  ruleId: RuleId,
  fileHash: string,
  location: FindingLocation,
  subType: string,
): string {
  const identity = [ruleId, fileHash, locationKey(location), subType].join('\u0000');
  const key = `${FINDING_KEY_PREFIX}|${built.input.scannerVersion}|${built.input.rulesetVersion}`;
  return createHmac('sha256', key).update(identity, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 混淆样本（B10「不可读标识」的正例与它的可读源）
// ---------------------------------------------------------------------------

/**
 * 24 个 `_0x…` 形状的标识符。
 *
 * 刻意用**标识符**而不是长字符串来制造不可读：`readability.ts` 度量前会先把注释与字符串字面量
 * 用空格覆盖掉（否则一条 MIT 许可头就能把一份可读作品判成混淆），字符串汤根本进不了度量。
 * 熵与行长两条判据都要求 ≥512 字节代码，小样本触发不了；标识符比例这条要求 ≥20 个标识符。
 */
export function obfuscatedJs(): string {
  const lines: string[] = [];
  for (let index = 0; index < 24; index += 1) {
    lines.push(`const _0x${(0xabc100 + index).toString(16)} = ${index};`);
  }
  return `${lines.join('\n')}\n`;
}

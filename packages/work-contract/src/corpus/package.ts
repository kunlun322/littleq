/**
 * 语料样例的「一整包」构造器。
 *
 * B1–B13 的判定单位是包而不是文件（B1 要资源图，B10 要「压缩产物之外必须有可读源」），
 * 所以每个语料样例都要先有一份**结构合法**的 `work.json`。本模块与 `test/support.ts` 的
 * `buildPackage` 同构，但有三处必须不同：
 *
 * 1. **不能 import `test/support.ts`**。`tsconfig.json` 是 `rootDir: src`，`src/**` 反向依赖
 *    `test/**` 会直接 TS6059；而且扫描器源码依赖测试助手是把判据交给被测方，方向错了。
 * 2. **每个样例有独立的 workId / storageKeyPrefix**。语料是 1000+ 件互不相干的作品，
 *    共用一个 workId 会让 B7 的 `storage-key-unprefixed` 判据失去意义。
 * 3. **sha256 一律用被测包自己的 `sha256Hex`，不用 `node:crypto`**（与 `support.ts` 同一纪律）：
 *    清单里的 hash 与被测代码算出的 hash 必须同源，否则一个 hash 实现的 bug 会同时改掉
 *    期望值和实测值，永远测不出来。
 *
 * **不手搓 metadata**：`work.json` 由文件表推导后走真实的 `validateWorkMetadata`，
 * 那 16 条 refine 一件都不能绕 —— 绕过它们，「包结构非法」这类样例就没有意义了。
 */

import { sha256Hex, utf8 } from '../scan/hash.js';
import { LEXICON_REVISION, MEDIA_TYPE_ADMISSION } from '../scan/lexicon.js';
import {
  admittedMediaType,
  artifactSha256,
  comparePathBytes,
  ENTRY_FILE_NAME,
  LICENSE_REF_USER_ORIGINAL,
  MANIFEST_FILE_NAME,
  validateWorkMetadata,
} from '../scan/metadata.js';
import type { WorkAsset, WorkMetadata } from '../scan/metadata.js';
import type { Capability, AgeBand, Visibility, WorkType } from '../scan/metadata.js';
import type {
  FileRange,
  FileRef,
  FileRole,
  ScanFileSource,
  ScanPolicySnapshot,
  StartScanInput,
} from '../scan/types.js';

/** 语料流水线自己的版本三元组占位；真实值由 `versions.ts` 算出后传进来。 */
export const CORPUS_SCANNER_VERSION_LABEL = 'scanner';
export const CORPUS_RULESET_VERSION_LABEL = 'ruleset';

/**
 * `webm` 同时出现在 `audio/webm` 与 `video/webm` 两行 ⇒ 映射必须**先到先得**。
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

/** 从扩展名推导 mediaType。推不出来就抛：静默填一个会让 B1 的准入判据失去输入。 */
export function mediaTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  const mediaType = MEDIA_TYPE_BY_EXTENSION.get(extension);
  if (mediaType === undefined) {
    throw new Error(`语料样例无法从扩展名推导 mediaType：${path}（请显式给出 mediaType）`);
  }
  return mediaType;
}

/** 可执行文本进 SOURCE（`index.html` 是 RUNTIME），媒体文件进 ASSET。 */
export function roleFor(path: string, mediaType: string): FileRole {
  if (path === ENTRY_FILE_NAME) return 'RUNTIME';
  const kind = admittedMediaType(mediaType)?.kind;
  if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'font') return 'ASSET';
  return 'SOURCE';
}

// ---------------------------------------------------------------------------
// 素材字节。扫描器读结构与元数据、从不校验 CRC，所以程序化构造的最小图就够用。
// 与 `support.ts` 的实现同源同纪律，但语料要**多种尺寸/多种内容**，所以参数化了。
// ---------------------------------------------------------------------------

function pngChunk(type: string, data: readonly number[]): number[] {
  const out: number[] = [];
  const length = data.length;
  out.push((length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  for (const byte of utf8(type)) out.push(byte);
  for (const byte of data) out.push(byte);
  // CRC 字段：扫描器不校验，但结构必须完整，否则 sniff 会把它判成不可解析媒体。
  out.push(0, 0, 0, 0);
  return out;
}

function bigEndian(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * 最小合法 PNG。`seed` 只改 IHDR 之后的一个私有填充块，**不改尺寸语义**，
 * 于是同一模板的不同样例拿到不同字节（⇒ 不同 packageHash），但媒体结构判定完全一致。
 */
export function corpusPng(width = 8, height = 8, seed = 0): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [
    ...bigEndian(width),
    ...bigEndian(height),
    8, // bit depth
    2, // color type: truecolor
    0,
    0,
    0,
  ];
  const filler = [(seed >>> 24) & 0xff, (seed >>> 16) & 0xff, (seed >>> 8) & 0xff, seed & 0xff];
  const bytes = [
    ...signature,
    ...pngChunk('IHDR', ihdr),
    ...pngChunk('sTER', filler),
    ...pngChunk('IDAT', [0x78, 0x9c, 0x62, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]),
    ...pngChunk('IEND', []),
  ];
  return new Uint8Array(bytes);
}

/** `data:` URL 用的 base64。手写而不引依赖（§9 零新依赖）。 */
function base64Of(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += alphabet.charAt(b0 >> 2);
    out += alphabet.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    out += b1 === undefined ? '=' : alphabet.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    out += b2 === undefined ? '=' : alphabet.charAt(b2 & 0x3f);
  }
  return out;
}

export function corpusPngDataUrl(width = 8, height = 8, seed = 0): string {
  return `data:image/png;base64,${base64Of(corpusPng(width, height, seed))}`;
}

/**
 * sha256 摘要的 base64 形式。CSP 的 `'sha256-…'` 源表达式要的就是这个，不是十六进制。
 *
 * 刻意不用 `Buffer`：本包是跨端契约包，`src/**` 里出现 Node 专有全局会把「这份代码能在
 * 浏览器里跑」这个前提悄悄破坏掉（门 13 的 web bundle 别名也正是盯着这件事）。
 */
export function sha256Base64(content: string): string {
  const hex = sha256Hex(utf8(content));
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return base64Of(new Uint8Array(bytes));
}

/**
 * 最小合法 WOFF2 头。B1 的反例里要一个**包内字体**，扩展名必须与准入表一致。
 * 只给签名与四个零字节：`sniff.ts` 认签名，不解析字表。
 */
export function corpusWoff2(seed = 0): Uint8Array {
  return new Uint8Array([0x77, 0x4f, 0x46, 0x32, (seed >>> 8) & 0xff, seed & 0xff, 0, 0]);
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export type CorpusFile = {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly role?: FileRole;
  readonly mediaType?: string;
  /** ASSET 角色的素材登记；不给就按 USER_ORIGINAL 自动生成一条。 */
  readonly asset?: Partial<WorkAsset>;
};

export type BuiltCorpusFile = {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly role: FileRole;
  readonly mediaType: string;
};

export type CorpusPackageOptions = {
  readonly files: readonly CorpusFile[];
  readonly title: string;
  readonly description: string;
  readonly workType: WorkType;
  readonly ageBand: AgeBand;
  readonly visibility?: Visibility;
  readonly capabilities?: readonly Capability[];
  readonly authorNickname?: string;
  /** 不给就从文件表推导全部 SOURCE。B10 的「有可读源」反例需要显式收窄。 */
  readonly sourceEntryPaths?: readonly string[];
  readonly policy?: Partial<ScanPolicySnapshot>;
  readonly scannerVersion: string;
  readonly rulesetVersion: string;
};

export type BuiltCorpusPackage = {
  readonly input: StartScanInput;
  readonly source: ScanFileSource;
  readonly metadata: WorkMetadata;
  readonly manifestText: string;
  readonly files: readonly BuiltCorpusFile[];
  readonly refs: readonly FileRef[];
  /** path → 实测 sha256，**含** `work.json`。 */
  readonly hashes: Readonly<Record<string, string>>;
  readonly artifactHash: string;
  readonly totalBytes: number;
};

/** 语料默认策略：与 D3a 冻结的默认策略同形，只有前缀/域名表按语料口径给出。 */
export function corpusPolicy(overrides: Partial<ScanPolicySnapshot> = {}): ScanPolicySnapshot {
  return {
    revision: 'corpus-policy-r1',
    adultApprovedCapabilities: [],
    storageKeyPrefix: 'littleq:corpus:',
    lexiconRevision: LEXICON_REVISION,
    knownTrackingDomains: ['google-analytics.com', 'doubleclick.net'],
    denyListedImageHashes: [],
    allowWasm: false,
    allowPostMessageBridge: false,
    ...overrides,
  };
}

function materialize(specs: readonly CorpusFile[]): BuiltCorpusFile[] {
  return specs.map((spec) => {
    const bytes = typeof spec.content === 'string' ? utf8(spec.content) : spec.content;
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

function toFileRef(file: BuiltCorpusFile, workId: string): FileRef {
  return {
    path: file.path,
    role: file.role,
    bytes: file.bytes.byteLength,
    sha256: file.sha256,
    mediaType: file.mediaType,
    objectRef: `object:${workId}/${file.path}`,
  };
}

function memoryFileSource(files: readonly BuiltCorpusFile[], workId: string): ScanFileSource {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return {
    list(): readonly FileRef[] {
      return files.map((file) => toFileRef(file, workId));
    },
    open(path: string, range?: FileRange): Promise<ReadableStream<Uint8Array>> {
      const file = byPath.get(path);
      if (file === undefined) return Promise.reject(new Error(`语料样例里没有这个文件：${path}`));
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
 * 构造一件语料作品。
 *
 * `workId` 从 `caseId` 派生（调用方负责），因此 storageKeyPrefix 也随 caseId 变 —— 语料里
 * 任何两件作品的 B7 判据都不会互相借用前缀。
 */
export function buildCorpusPackage(
  workId: string,
  createdAt: string,
  options: CorpusPackageOptions,
): BuiltCorpusPackage {
  const materialized = materialize(options.files);
  const byPath = new Map(materialized.map((file) => [file.path, file]));

  if (byPath.get(ENTRY_FILE_NAME) === undefined) {
    throw new Error(`语料样例 ${workId} 缺少运行入口 ${ENTRY_FILE_NAME}`);
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

  const specs = options.files;
  const assets = materialized
    .filter((file) => file.role === 'ASSET')
    .map((file, ordinal) =>
      defaultAsset(
        file.path,
        ordinal + 1,
        specs.find((spec) => spec.path === file.path)?.asset ?? {},
      ),
    );

  const firstAsset = assets[0];
  const coverPath = firstAsset?.path ?? 'assets/cover.png';
  if (byPath.get(coverPath) === undefined) {
    throw new Error(`语料样例 ${workId} 的封面不在文件表里：${coverPath}`);
  }

  const sourceEntryPaths =
    options.sourceEntryPaths ??
    materialized
      .filter((file) => file.role === 'SOURCE' && file.path !== ENTRY_FILE_NAME)
      .map((file) => file.path);

  const manifestObject: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    contractVersion: '1.0.0',
    workId,
    version: 1,
    publicationId: null,
    title: options.title,
    description: options.description,
    workType: options.workType,
    ageBand: options.ageBand,
    authorNickname: options.authorNickname ?? '小Q',
    visibility: options.visibility ?? 'PRIVATE',
    commentsEnabled: false,
    commentsScope: 'NONE',
    createdAt,
    publishedAt: null,
    entry: ENTRY_FILE_NAME,
    cover: { path: coverPath, alt: `封面：${options.title}`, width: 8, height: 8 },
    files: declaredFiles,
    assets,
    capabilities: options.capabilities ?? [],
    sourceEntryPaths,
  };

  const manifestText = `${JSON.stringify(manifestObject, null, 2)}\n`;
  const validation = validateWorkMetadata(JSON.parse(manifestText) as unknown);
  if (!validation.ok) {
    throw new Error(`语料样例 ${workId} 的 work.json 不合法：${JSON.stringify(validation.issues)}`);
  }

  const manifestBytes = utf8(manifestText);
  const manifestSha256 = sha256Hex(manifestBytes);
  const all: BuiltCorpusFile[] = [
    ...materialized,
    {
      path: MANIFEST_FILE_NAME,
      bytes: manifestBytes,
      sha256: manifestSha256,
      role: 'SOURCE',
      mediaType: 'application/json',
    },
  ];

  const hashes: Record<string, string> = {};
  for (const file of all) hashes[file.path] = file.sha256;

  const artifactHash = artifactSha256(
    all
      .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength }))
      .sort((left, right) => comparePathBytes(left.path, right.path)),
  );

  const policy = corpusPolicy({
    storageKeyPrefix: `littleq:${workId}:`,
    ...options.policy,
  });
  const source = memoryFileSource(all, workId);

  return {
    input: {
      artifactHash,
      manifestHash: manifestSha256,
      schemaVersion: '1.0.0',
      contractVersion: '1.0.0',
      scannerVersion: options.scannerVersion,
      rulesetVersion: options.rulesetVersion,
      metadata: validation.metadata,
      files: source,
      policySnapshot: policy,
    },
    source,
    metadata: validation.metadata,
    manifestText,
    files: all,
    refs: all.map((file) => toFileRef(file, workId)),
    hashes,
    artifactHash,
    totalBytes: all.reduce((sum, file) => sum + file.bytes.byteLength, 0),
  };
}

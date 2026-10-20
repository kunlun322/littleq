/**
 * work.json 契约 schema（ZLQ-156 §1.2 / §1.3 / §1.4）与 artifact 身份（§1.3 `artifact_sha256`）。
 *
 * 这一层是扫描器的**输入边界**，不是扫描结果。§6.1 说得很直白：
 * 「start 输入的 metadata/files 是平台重建过的数据，仍检查 manifest/hash 完整性，
 * 不能因为 TypeScript 叫 Validated 就信任网络边界。」所以 `WorkMetadata` 是 zod 校验的产物，
 * 不是一个可以直接 `as` 出来的类型。
 *
 * **不实现的部分（点名，不静默缩范围）**：
 * - §1.5「非法 JSON / 重复键」的**重复键**检测：JSON.parse 在到达这里之前就已经把重复键折叠掉了，
 *   要拦住它必须在词法层做（自己的 JSON tokenizer）。重复键属于 ingest/构建门禁（D5/D6）的入口，
 *   扫描器收到的是平台已解析的对象。
 * - §1.4 的**许可裁定**（THIRD_PARTY 是否真的可再分发、licenseTextPath 内容是否是那份许可）：
 *   §1.4 自己写了「此为 metadata readiness，不伪造 B12 命中」，属发布门禁而非扫描规则。
 * 两者都在交付说明里作为「未覆盖面」列出。
 */

import { z } from 'zod';

import { PACKAGE_LIMITS } from './budget.js';
import { MEDIA_TYPE_ADMISSION } from './lexicon.js';
import { utf8 } from './hash.js';
import { sha256Hex } from './hash.js';
import { codePointLength } from './normalize.js';
import { checkDisplayText } from './textsafety.js';

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

export const WORK_TYPES = ['GAME', 'WEB', 'ANIMATION', 'PICTURE_BOOK'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const AGE_BANDS = ['L1', 'L2', 'L3'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const VISIBILITIES = ['PRIVATE', 'GROUP', 'PUBLIC'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const COMMENTS_SCOPES = ['NONE', 'GROUP', 'ANYONE'] as const;
export type CommentsScope = (typeof COMMENTS_SCOPES)[number];

export const CAPABILITIES = [
  'LOCAL_STORAGE',
  'INDEXED_DB',
  'CAMERA',
  'MICROPHONE',
  'ACCELEROMETER',
  'GYROSCOPE',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const FILE_ROLES = ['RUNTIME', 'SOURCE', 'ASSET'] as const;
export type FileRoleName = (typeof FILE_ROLES)[number];

export const SOURCE_KINDS = ['USER_ORIGINAL', 'PLATFORM_MATERIAL', 'THIRD_PARTY'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** §1.2：「精确 semver，初版 `1.0.0`；白名单已支持版本，不接受任意最新」。 */
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0.0'] as const;
/** §1.2：`contractVersion` 必须等于实际应用的契约，不由 Agent 声明放宽。 */
export const SUPPORTED_CONTRACT_VERSIONS = ['1.0.0'] as const;

/** §1.4：自定义许可标识。未知/缺失停止发布，**不填 AGPL**。 */
export const LICENSE_REF_USER_ORIGINAL = 'LicenseRef-User-Original';
export const LICENSE_REF_PLATFORM_MATERIAL = 'LicenseRef-Platform-Material';
export const LICENSE_REF_CUSTOM = 'LicenseRef-Custom';

export const ENTRY_FILE_NAME = 'index.html';
export const MANIFEST_FILE_NAME = 'work.json';

// ---------------------------------------------------------------------------
// 路径（§1.3 / §8.1）
// ---------------------------------------------------------------------------

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** UUIDv7：version nibble 必须是 7，variant 必须是 RFC 4122 的 `8|9|a|b`。 */
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]00:00)$/;
/** SPDX 标识的保守形状；`LicenseRef-*` 单独放行。 */
const SPDX_ID_PATTERN = /^[A-Za-z0-9.-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.-]+)*$/;
/** 规范 HTTPS：无 userinfo、无 query 里的 token/signature（§1.4）。 */
const HTTPS_URL_PATTERN = /^https:\/\/[^\s/?#@][^\s?#]*(?:\?[^\s#]*)?(?:#[^\s]*)?$/;
const FORBIDDEN_URL_HOST_PATTERN =
  /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|localhost|localhost\.localdomain|127\.|0\.0\.0\.0|169\.254\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|metadata\.google\.internal|\[::1\])/i;
const TOKEN_QUERY_PATTERN =
  /[?&](?:sig|signature|x-amz-signature|x-goog-signature|x-amz-credential|token|access_token|api_key|se|expires|auth)=/i;

export type PathIssue =
  | 'empty'
  | 'absolute'
  | 'backslash'
  | 'parent-traversal'
  | 'control-character'
  | 'dot-segment'
  | 'trailing-slash'
  | 'too-long'
  | 'too-deep'
  | 'not-normalized';

/**
 * 规范化相对路径校验（§1.3）。返回问题 id，**不返回路径本身**（异常 filename 可能含 PII/秘密，§6.2）。
 *
 * 深度按 §8.1 的「目录深度 ≤ 8」实现为**路径段数 ≤ 8**：`index.html` = 1 段，`assets/img/a.png` = 3 段。
 */
export function checkPackagePath(path: string): PathIssue | null {
  if (path === '') return 'empty';
  if (codePointLength(path) > PACKAGE_LIMITS.maxPathCodePoints) return 'too-long';
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return 'absolute';
  if (path.includes('\\')) return 'backslash';
  // eslint-disable-next-line no-control-regex -- §1.3 明文「禁……控制字符」，这里必须直接写控制字符类
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'control-character';

  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) return 'parent-traversal';
  if (segments.some((segment) => segment === '.')) return 'dot-segment';
  if (segments.some((segment) => segment === '')) return 'trailing-slash';
  if (segments.length > PACKAGE_LIMITS.maxPathDepth) return 'too-deep';
  // 重复斜杠/尾斜杠会被上面的空段检查抓到；这里补「已经规范化」的正向断言
  if (segments.join('/') !== path) return 'not-normalized';
  return null;
}

/** 深度 = 路径段数（见 `checkPackagePath` 的定义）。 */
export function pathDepth(path: string): number {
  return path === '' ? 0 : path.split('/').length;
}

/** 大小写冲突检测（§1.3「重复/大小写冲突」）。返回冲突的键，不返回原路径。 */
export function findCaseConflicts(paths: readonly string[]): string[] {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, path);
    } else if (previous !== path) {
      conflicts.push(key);
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// MIME 准入（§1.3）
// ---------------------------------------------------------------------------

export type MediaTypeIssue = 'not-admitted' | 'extension-mismatch';

export function admittedMediaType(
  mediaType: string,
): (typeof MEDIA_TYPE_ADMISSION)[number] | undefined {
  return MEDIA_TYPE_ADMISSION.find((entry) => entry.mediaType === mediaType);
}

/** 声明的 mediaType 是否在准入表内、且与扩展名一致。嗅探一致性由扫描器在读到字节后另查（`sniff.ts`）。 */
export function checkMediaType(path: string, mediaType: string): MediaTypeIssue | null {
  const admitted = admittedMediaType(mediaType);
  if (!admitted) return 'not-admitted';
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'extension-mismatch';
  const extension = path.slice(dot + 1).toLowerCase();
  return admitted.extensions.includes(extension) ? null : 'extension-mismatch';
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** §1.2：长度按 Unicode 码点计算 + 显示文本安全。zod 的 `.max()` 数的是 UTF-16 单元，不能直接用。 */
function displayText(minCodePoints: number, maxCodePoints: number) {
  return z.string().refine((value) => checkDisplayText(value, minCodePoints, maxCodePoints).ok, {
    message: `display text must be ${minCodePoints}..${maxCodePoints} code points, NFC, no control/bidi/credential/PII/markup`,
  });
}

function packagePath() {
  return z.string().refine((value) => checkPackagePath(value) === null, {
    message: 'path must be a canonical relative package path within the depth/length limits',
  });
}

const uuidV7 = z.string().regex(UUID_V7_PATTERN, 'expected UUIDv7');
const rfc3339Utc = z.string().regex(RFC3339_UTC_PATTERN, 'expected UTC RFC3339 timestamp');
const sha256HexSchema = z
  .string()
  .regex(SHA256_HEX_PATTERN, 'expected 64 lowercase hex characters');

const coverSchema = z.strictObject({
  path: packagePath(),
  alt: displayText(0, 120),
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
});

const fileSchema = z.strictObject({
  path: packagePath(),
  role: z.enum(FILE_ROLES),
  bytes: z.number().int().min(0).max(PACKAGE_LIMITS.maxFileBytes),
  sha256: sha256HexSchema,
  mediaType: z.string().refine((value) => admittedMediaType(value) !== undefined, {
    message: 'mediaType must be in the fixed admission table',
  }),
});

/**
 * §1.4 `sourceUrl`：「仅离线许可引用，null 或规范 HTTPS；禁 userinfo、IP/内网/元数据域名、
 * token/signature 类 query，最大 2048；**不获取该 URL，不渲染成运行时外链**」。
 */
const sourceUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => HTTPS_URL_PATTERN.test(value), {
    message: 'sourceUrl must be a canonical https URL',
  })
  .refine((value) => !value.includes('@'), { message: 'sourceUrl must not contain userinfo' })
  .refine((value) => !FORBIDDEN_URL_HOST_PATTERN.test(hostOf(value) ?? ''), {
    message: 'sourceUrl must not point at an IP, intranet or metadata host',
  })
  .refine((value) => !TOKEN_QUERY_PATTERN.test(value), {
    message: 'sourceUrl must not carry a token/signature query',
  })
  .nullable();

function hostOf(url: string): string | null {
  const match = /^https:\/\/([^/?#]*)/i.exec(url);
  return match?.[1] ?? null;
}

const licenseIdSchema = z
  .string()
  .refine(
    (value) =>
      value === LICENSE_REF_USER_ORIGINAL ||
      value === LICENSE_REF_PLATFORM_MATERIAL ||
      value === LICENSE_REF_CUSTOM ||
      SPDX_ID_PATTERN.test(value),
    { message: 'licenseId must be an SPDX identifier or a known LicenseRef-*' },
  );

const assetSchema = z.strictObject({
  path: packagePath(),
  sourceKind: z.enum(SOURCE_KINDS),
  sourceName: displayText(1, 100),
  sourceUrl: sourceUrlSchema,
  creator: displayText(1, 100),
  licenseId: licenseIdSchema,
  licenseTextPath: packagePath().nullable(),
  attribution: displayText(0, 300),
  redistributionAllowed: z.boolean(),
  modified: z.boolean(),
});

export const workMetadataSchema = z
  .strictObject({
    schemaVersion: z.enum(SUPPORTED_SCHEMA_VERSIONS),
    contractVersion: z.enum(SUPPORTED_CONTRACT_VERSIONS),
    workId: uuidV7,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    publicationId: uuidV7.nullable(),
    title: displayText(1, 60),
    description: displayText(0, 200),
    workType: z.enum(WORK_TYPES),
    ageBand: z.enum(AGE_BANDS),
    authorNickname: displayText(1, 32),
    visibility: z.enum(VISIBILITIES),
    commentsEnabled: z.boolean(),
    commentsScope: z.enum(COMMENTS_SCOPES),
    createdAt: rfc3339Utc,
    publishedAt: rfc3339Utc.nullable(),
    entry: z.literal(ENTRY_FILE_NAME),
    cover: coverSchema,
    files: z.array(fileSchema),
    assets: z.array(assetSchema),
    capabilities: z.array(z.enum(CAPABILITIES)),
    sourceEntryPaths: z.array(packagePath()),
  })
  // §1.2：`commentsEnabled` 等于 `commentsScope !== NONE`
  .refine((work) => work.commentsEnabled === (work.commentsScope !== 'NONE'), {
    message: 'commentsEnabled must equal (commentsScope !== NONE)',
    path: ['commentsEnabled'],
  })
  // §1.2：capabilities 唯一
  .refine((work) => new Set(work.capabilities).size === work.capabilities.length, {
    message: 'capabilities must be unique',
    path: ['capabilities'],
  })
  // §1.2：commentsScope=GROUP 需要明确的 work_groups —— 公开包不存受众列表（§1.2 末段），
  // 所以这里只能校验「GROUP 受众不在包内声明」，实际授权由服务端 policy 决定。
  .refine((work) => work.files.length <= PACKAGE_LIMITS.maxFileCount, {
    message: `files must not exceed ${PACKAGE_LIMITS.maxFileCount} entries`,
    path: ['files'],
  })
  // §1.3：避免 manifest 自引用 —— work.json 不在自己的 files 数组里
  .refine((work) => !work.files.some((file) => file.path === MANIFEST_FILE_NAME), {
    message: 'work.json must not appear in its own files array',
    path: ['files'],
  })
  // §1.3：规范化路径唯一 + 无大小写冲突
  .refine((work) => new Set(work.files.map((file) => file.path)).size === work.files.length, {
    message: 'files[].path must be unique',
    path: ['files'],
  })
  .refine((work) => findCaseConflicts(work.files.map((file) => file.path)).length === 0, {
    message: 'files[].path must not differ only by case',
    path: ['files'],
  })
  // §8.1：必须有根目录唯一运行入口
  .refine(
    (work) => work.files.some((file) => file.path === ENTRY_FILE_NAME && file.role === 'RUNTIME'),
    {
      message: 'the package must contain index.html as a RUNTIME file',
      path: ['files'],
    },
  )
  // §1.3：mediaType 与扩展名一致
  .refine(
    (work) => work.files.every((file) => checkMediaType(file.path, file.mediaType) === null),
    {
      message: 'files[].mediaType must match the file extension and the admission table',
      path: ['files'],
    },
  )
  // §1.3：sourceEntryPaths 必须真的存在于 files 里
  .refine(
    (work) => {
      const known = new Set(work.files.map((file) => file.path));
      return work.sourceEntryPaths.every((path) => known.has(path));
    },
    {
      message: 'sourceEntryPaths must reference files present in the package',
      path: ['sourceEntryPaths'],
    },
  )
  // §1.3：cover.path 必须在包里
  .refine((work) => work.files.some((file) => file.path === work.cover.path), {
    message: 'cover.path must reference a file present in the package',
    path: ['cover', 'path'],
  })
  // §1.4：每个素材 file 有来源许可记录；同一素材只一条
  .refine(
    (work) => {
      const assetFiles = work.files
        .filter((file) => file.role === 'ASSET')
        .map((file) => file.path);
      const recorded = new Set(work.assets.map((asset) => asset.path));
      return assetFiles.every((path) => recorded.has(path));
    },
    { message: 'every ASSET file must have an assets[] provenance record', path: ['assets'] },
  )
  .refine((work) => new Set(work.assets.map((asset) => asset.path)).size === work.assets.length, {
    message: 'assets[].path must be unique (one record per asset)',
    path: ['assets'],
  })
  .refine(
    (work) => {
      const known = new Set(work.files.map((file) => file.path));
      return work.assets.every((asset) => known.has(asset.path));
    },
    { message: 'assets[].path must reference a file present in the package', path: ['assets'] },
  )
  // §1.4：自定义/平台单独许可需要包内 licenses/ 文件；THIRD_PARTY 需要可核查依据
  .refine(
    (work) =>
      work.assets.every((asset) => {
        if (
          asset.licenseId !== LICENSE_REF_CUSTOM &&
          asset.licenseId !== LICENSE_REF_PLATFORM_MATERIAL
        ) {
          return true;
        }
        if (asset.licenseTextPath === null) return false;
        return work.files.some((file) => file.path === asset.licenseTextPath);
      }),
    {
      message:
        'LicenseRef-Custom / LicenseRef-Platform-Material require a licenseTextPath present in files[]',
      path: ['assets'],
    },
  )
  .refine(
    (work) =>
      work.assets.every(
        (asset) =>
          asset.sourceKind !== 'THIRD_PARTY' ||
          (asset.redistributionAllowed && asset.attribution.length > 0),
      ),
    {
      message: 'THIRD_PARTY assets require redistributionAllowed and a non-empty attribution',
      path: ['assets'],
    },
  )
  // §1.4：redistributionAllowed=false 不可发公开作品
  .refine(
    (work) =>
      work.visibility !== 'PUBLIC' || work.assets.every((asset) => asset.redistributionAllowed),
    {
      message: 'PUBLIC visibility requires every asset to allow redistribution',
      path: ['visibility'],
    },
  );

export type WorkMetadata = z.infer<typeof workMetadataSchema>;
export type WorkCover = WorkMetadata['cover'];
export type WorkFile = WorkMetadata['files'][number];
export type WorkAsset = WorkMetadata['assets'][number];

export type MetadataValidation =
  | { ok: true; metadata: WorkMetadata }
  | {
      ok: false;
      /** JSON Pointer（§1.5：字段说明的 path 用 JSON Pointer，不是原始敏感片段）。 */
      issues: { pointer: string; message: string }[];
    };

/** `z.pathToPointer` 在 zod 4 里叫 `z.treeifyError`/`issue.path`；这里自己拼，避免依赖内部工具的形状。 */
function toPointer(path: readonly (string | number | symbol)[]): string {
  let pointer = '';
  for (const segment of path) {
    const text = String(segment);
    pointer += '/' + text.replace(/~/g, '~0').replace(/\//g, '~1');
  }
  return pointer === '' ? '/' : pointer;
}

export function validateWorkMetadata(input: unknown): MetadataValidation {
  const parsed = workMetadataSchema.safeParse(input);
  if (parsed.success) return { ok: true, metadata: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      pointer: toPointer(issue.path),
      message: issue.message,
    })),
  };
}

// ---------------------------------------------------------------------------
// §1.3 artifact_sha256
// ---------------------------------------------------------------------------

/**
 * 规范文件清单的 SHA-256：按 path 的 UTF-8 字节升序，对每行 `path + NUL + sha256 + NUL + bytes + LF`
 * 计算 hash，**包含 work.json**；不以 ZIP 压缩顺序或时间戳作为作品身份。
 */
export type ArtifactEntry = { path: string; sha256: string; bytes: number };

const NUL = 0x00;
const LF = 0x0a;

/** 按 path 的 UTF-8 字节升序（不是 JS 默认的 UTF-16 码元序 —— 对 CJK 文件名两者结果不同）。 */
export function comparePathBytes(left: string, right: string): number {
  const a = utf8(left);
  const b = utf8(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

export function canonicalManifestBytes(entries: readonly ArtifactEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => comparePathBytes(a.path, b.path));
  const chunks: Uint8Array[] = [];
  for (const entry of sorted) {
    chunks.push(utf8(entry.path));
    chunks.push(Uint8Array.of(NUL));
    chunks.push(utf8(entry.sha256));
    chunks.push(Uint8Array.of(NUL));
    chunks.push(utf8(String(entry.bytes)));
    chunks.push(Uint8Array.of(LF));
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function artifactSha256(entries: readonly ArtifactEntry[]): string {
  return sha256Hex(canonicalManifestBytes(entries));
}

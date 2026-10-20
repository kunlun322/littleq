/**
 * B1 外部资源（ZLQ-153 §8.3）。
 *
 * 原文：「遍历 HTML `src/href/srcset/poster`、CSS `url/@import`、JS import；URL 规范化后
 * 仅允许包内相对路径或受限 `data/blob`；构建资源图验证每个节点存在且不越界。」
 *
 * 三个判定源，缺一个就有洞：
 * 1. **引用边**（`context.graph.edges`）—— 规范化后的落点分类由 `urlref.ts` 给出，
 *    这里只读分类结果，不重新解析（重解析会让 B1/B9/B11 在预算耗尽后给出不一致的结论）。
 * 2. **包内容纳**（§8.1 的容量上限 + §1.3 的路径/媒体类型规范）—— 走 `metadata.ts`
 *    的结构校验器，只读 `files[]` 的 path/role/bytes/mediaType 四个字段。
 * 3. **资源图可达性** —— 见 `graph.ts`：不可达**不是**违规（SOURCE 文件本来就不被 index.html 链接），
 *    B1 判的是「边指向的节点存在且不越界」，不是节点入度。
 *
 * `script-scheme`（`javascript:` 等）在这里**跳过**，归 B10：
 * §8.4 明确「扫描器拒绝 HTML 事件处理属性和动态脚本拼接」，那是执行面而不是资源面。
 */

import { PACKAGE_LIMITS } from '../budget.js';
import {
  admittedMediaType,
  checkMediaType,
  checkPackagePath,
  findCaseConflicts,
  pathDepth,
} from '../metadata.js';
import type { Rule, RuleContext } from './types.js';

export const B1_SUB_TYPES = [
  'external-url',
  'root-escape',
  'scheme-not-allowed',
  'data-media-not-allowed',
  'unresolved-reference',
  'missing-node',
  'path-not-canonical',
  'path-too-deep',
  'path-case-conflict',
  'media-type-not-admitted',
  'media-type-extension-mismatch',
  'executable-media-type',
  'missing-entry',
  'package-limit-exceeded',
] as const;

export const b01ExternalResource: Rule = {
  id: 'B1',
  maxDisposition: 'BLOCK',
  subTypes: B1_SUB_TYPES,

  run(context: RuleContext): void {
    checkEdges(context);
    checkContainment(context);
  },
};

function checkEdges(context: RuleContext): void {
  for (const edge of context.graph.edges) {
    const resolved = edge.resolved;
    switch (resolved.target) {
      case 'external':
        // 「仅允许包内相对路径或受限 data/blob」—— 任何 http(s)/协议相对 URL 都越界。
        context.emit({
          ruleId: 'B1',
          disposition: 'BLOCK',
          confidence: 'HIGH',
          path: edge.fromPath,
          location: edge.location,
          repairAction: 'LOCALIZE_RESOURCE',
          subType: 'external-url',
        });
        continue;
      case 'escaped-root':
        context.emit({
          ruleId: 'B1',
          disposition: 'BLOCK',
          confidence: 'HIGH',
          path: edge.fromPath,
          location: edge.location,
          repairAction: 'LOCALIZE_RESOURCE',
          subType: 'root-escape',
        });
        continue;
      case 'scheme-not-allowed':
        context.emit({
          ruleId: 'B1',
          disposition: 'BLOCK',
          confidence: 'HIGH',
          path: edge.fromPath,
          location: edge.location,
          repairAction: 'LOCALIZE_RESOURCE',
          subType: 'scheme-not-allowed',
        });
        continue;
      case 'inline-data':
        if (!resolved.allowed) {
          context.emit({
            ruleId: 'B1',
            disposition: 'BLOCK',
            confidence: 'HIGH',
            path: edge.fromPath,
            location: edge.location,
            repairAction: 'LOCALIZE_RESOURCE',
            subType: 'data-media-not-allowed',
          });
        }
        continue;
      case 'unresolved':
        // `classification.truncated` 也落在这里：§6.4「绝不因为『没读完』给 PASS」。
        // 二级解码没跑完的引用不能算干净，只能算「解析不出落点」。
        context.emit({
          ruleId: 'B1',
          disposition: 'BLOCK',
          confidence: 'HIGH',
          path: edge.fromPath,
          location: edge.location,
          repairAction: 'LOCALIZE_RESOURCE',
          subType: 'unresolved-reference',
        });
        continue;
      case 'package-file':
        if (!resolved.present) {
          context.emit({
            ruleId: 'B1',
            disposition: 'BLOCK',
            confidence: 'HIGH',
            path: edge.fromPath,
            location: edge.location,
            repairAction: 'LOCALIZE_RESOURCE',
            subType: 'missing-node',
          });
        }
        continue;
      case 'script-scheme':
      case 'fragment':
      case 'blob-literal':
      case 'empty':
        continue;
    }
  }
}

function checkContainment(context: RuleContext): void {
  const metadata = context.metadata;
  const paths = metadata.files.map((file) => file.path);

  let totalBytes = 0;
  for (let index = 0; index < metadata.files.length; index += 1) {
    const file = metadata.files[index];
    if (file === undefined) continue;
    const pointer = `/files/${index}`;
    totalBytes += file.bytes;

    const pathIssue = checkPackagePath(file.path);
    if (pathIssue !== null) {
      emitContainment(context, pointer, 'path', 'path-not-canonical');
      continue;
    }
    if (pathDepth(file.path) > PACKAGE_LIMITS.maxPathDepth) {
      emitContainment(context, pointer, 'path', 'path-too-deep');
    }
    if (file.bytes > PACKAGE_LIMITS.maxFileBytes) {
      emitContainment(context, pointer, 'bytes', 'package-limit-exceeded');
    }

    const mediaIssue = checkMediaType(file.path, file.mediaType);
    if (mediaIssue === 'not-admitted') {
      emitContainment(context, pointer, 'mediaType', 'media-type-not-admitted');
    } else if (mediaIssue === 'extension-mismatch') {
      emitContainment(context, pointer, 'mediaType', 'media-type-extension-mismatch');
    } else if (admittedMediaType(file.mediaType)?.executable === true) {
      // §1.3：可执行媒体类型只能出现在 RUNTIME/SOURCE，不能伪装成 ASSET 混过许可审查。
      if (file.role === 'ASSET') {
        emitContainment(context, pointer, 'mediaType', 'executable-media-type');
      }
    }
  }

  // 大小写冲突是**包级**问题，定位到 files 数组本身而不是某一个下标。
  if (findCaseConflicts(paths).length > 0) {
    context.emit({
      ruleId: 'B1',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: 'work.json',
      location: { jsonPointer: '/files' },
      repairAction: 'LOCALIZE_RESOURCE',
      subType: 'path-case-conflict',
    });
  }

  if (!paths.includes('index.html')) {
    context.emit({
      ruleId: 'B1',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: 'work.json',
      location: { jsonPointer: '/entry' },
      repairAction: 'LOCALIZE_RESOURCE',
      subType: 'missing-entry',
    });
  }

  const overCount = metadata.files.length > PACKAGE_LIMITS.maxFileCount;
  const overBytes = totalBytes > PACKAGE_LIMITS.maxTotalUncompressedBytes;
  if (overCount || overBytes) {
    context.emit({
      ruleId: 'B1',
      disposition: 'BLOCK',
      confidence: 'HIGH',
      path: 'work.json',
      location: { jsonPointer: '/files' },
      repairAction: 'LOCALIZE_RESOURCE',
      subType: 'package-limit-exceeded',
    });
  }
}

/**
 * 定位用 JSON Pointer，**不用行列** —— §6.5：metadata 定位不能用行列，
 * 插入可信 `publicationId`/`publishedAt` 会让 work.json 的行号漂移，
 * 成人的一次确认就会因此失效。
 */
function emitContainment(
  context: RuleContext,
  filePointer: string,
  field: string,
  subType: (typeof B1_SUB_TYPES)[number],
): void {
  context.emit({
    ruleId: 'B1',
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path: 'work.json',
    location: { jsonPointer: `${filePointer}/${field}` },
    repairAction: 'LOCALIZE_RESOURCE',
    subType,
  });
}

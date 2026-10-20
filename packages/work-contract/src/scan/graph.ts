/**
 * 资源图（ZLQ-153 §8.3 B1 的后半句：「构建资源图验证每个节点存在且不越界」）。
 *
 * 三条设计约束：
 * 1. **分类与建图分离，但只分类一次**。`classifyUrlReference` 会花二次解码预算（§6.4），
 *    所以它在这里调用一次并把结果挂在边上；B1/B9/B11 都读同一份 `edge.classification`，
 *    不各自重算 —— 重算既翻倍预算，又可能因为预算耗尽而在两条规则里得出不同结论。
 * 2. **`truncated` 的引用不是干净引用**。§6.4 明说「绝不因为『没读完』给 PASS」，所以定点解码
 *    被预算或深度截断的边一律落到 `unresolved`，由 B1 当作「越界不可证」硬拦，而不是放行。
 * 3. **不可达不是违规**。`SOURCE` 角色的源文件本来就不会被 `index.html` 链接，所以 `reachable`
 *    只是图的事实（供测试与后续策略使用），不产生 finding；B1 判的是**边的目标**，不是节点的入度。
 */

import type { Budget } from './budget.js';
import { comparePathBytes } from './metadata.js';
import { classifyUrlReference, resolvePackagePath, type UrlClassification } from './urlref.js';
import type { ParseSummary, ReferenceKind, ResourceReference } from './analysis/model.js';
import type { SourceRange } from './types.js';

/** 一条引用的落点。判别式联合，B1 按 `target` 分支判定，不做字符串比较。 */
export type EdgeTarget =
  | { target: 'package-file'; path: string; present: boolean }
  /** 相对路径越过包根（`../../etc/passwd`）。§8.1「路径不得越界」。 */
  | { target: 'escaped-root' }
  /** `#section` 页内锚点。§2.4 B3 的「hash 页内路由」必须落在这里，不能被当外链。 */
  | { target: 'fragment' }
  | { target: 'inline-data'; allowed: boolean; mediaType: string | null }
  | { target: 'blob-literal' }
  /** `javascript:` 一类：归 B10，B1 跳过（见 rules/b01）。 */
  | { target: 'script-scheme' }
  | { target: 'external'; host: string | null }
  | { target: 'scheme-not-allowed' }
  | { target: 'empty' }
  /** 定点解码被截断，或解析不出落点 ⇒ 「无法证明它在包内」。 */
  | { target: 'unresolved' };

export type ResourceGraphEdge = {
  fromPath: string;
  kind: ReferenceKind;
  raw: string;
  location: SourceRange | null;
  detail: string;
  classification: UrlClassification;
  resolved: EdgeTarget;
};

export type ResourceGraph = {
  /** 包内全部文件，按 `comparePathBytes` 排序（确定性输出，§6.2）。 */
  readonly nodes: readonly string[];
  readonly edges: readonly ResourceGraphEdge[];
  /** 从运行入口出发、沿「存在且在包内」的边可达的文件。 */
  readonly reachable: ReadonlySet<string>;
};

/**
 * 把一份解析摘要里的**全部**引用收齐：顶层引用 + 内联 `<script>` / `<style>` 子摘要里的引用。
 *
 * 为什么必须合并：`html.ts` 只把属性引用推进自己的 `references`，内联脚本正文交给 `js.ts`
 * 单独分析，那些引用挂在 `inlineScriptSummaries[i].references` 上。漏掉这一层，
 * `<script>import x from 'https://evil.example/a.js'</script>` 就完全看不见。
 */
export function collectReferences(summary: ParseSummary): readonly ResourceReference[] {
  switch (summary.kind) {
    case 'js':
    case 'css':
      return summary.references;
    case 'html': {
      const merged: ResourceReference[] = [...summary.references];
      for (const inline of summary.inlineScriptSummaries) merged.push(...inline.references);
      for (const inline of summary.inlineStyleSummaries) merged.push(...inline.references);
      return merged;
    }
    default:
      return [];
  }
}

export type BuildResourceGraphInput = {
  /** 运行入口（§8.1：根目录唯一 `index.html`）。 */
  entryPath: string;
  /** manifest 声明的全部包内路径。 */
  packagePaths: readonly string[];
  /** 全部文件的引用，已按 `collectReferences` 收齐。 */
  references: readonly ResourceReference[];
  budget: Budget;
};

function resolveTarget(
  classification: UrlClassification,
  fromPath: string,
  known: ReadonlySet<string>,
): EdgeTarget {
  // 截断优先：解码没跑完时，后面任何分支的结论都不可信（§6.4）。
  if (classification.truncated) return { target: 'unresolved' };

  switch (classification.kind) {
    case 'empty':
      return { target: 'empty' };
    case 'fragment-only':
      return { target: 'fragment' };
    case 'script-scheme':
      return { target: 'script-scheme' };
    case 'data-allowed':
      return { target: 'inline-data', allowed: true, mediaType: classification.dataMediaType };
    case 'data-forbidden':
      return { target: 'inline-data', allowed: false, mediaType: classification.dataMediaType };
    case 'blob-literal':
      return { target: 'blob-literal' };
    case 'absolute-external':
    case 'protocol-relative':
      return { target: 'external', host: classification.host };
    case 'scheme-not-allowed':
      return { target: 'scheme-not-allowed' };
    case 'internal-relative': {
      const relative = classification.relativePath;
      if (relative === null || relative === '') return { target: 'unresolved' };
      const resolved = resolvePackagePath(fromPath, relative);
      if (resolved === null) return { target: 'escaped-root' };
      return { target: 'package-file', path: resolved, present: known.has(resolved) };
    }
    default:
      return { target: 'unresolved' };
  }
}

export function buildResourceGraph(input: BuildResourceGraphInput): ResourceGraph {
  const nodes = [...input.packagePaths].sort(comparePathBytes);
  const known = new Set(nodes);

  const edges: ResourceGraphEdge[] = input.references.map((reference) => {
    const classification = classifyUrlReference(reference.raw, input.budget);
    return {
      fromPath: reference.fromPath,
      kind: reference.kind,
      raw: reference.raw,
      location: reference.location,
      detail: reference.detail,
      classification,
      resolved: resolveTarget(classification, reference.fromPath, known),
    };
  });

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const resolved = edge.resolved;
    if (resolved.target !== 'package-file' || !resolved.present) continue;
    const list = adjacency.get(edge.fromPath);
    if (list) list.push(resolved.path);
    else adjacency.set(edge.fromPath, [resolved.path]);
  }

  // 广度优先。`nodes` 已排序、边按引用出现顺序，所以可达集与遍历顺序都是确定的。
  const reachable = new Set<string>();
  const queue: string[] = known.has(input.entryPath) ? [input.entryPath] : [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }

  return { nodes, edges, reachable };
}

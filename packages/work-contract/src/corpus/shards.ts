/**
 * 16 shard 固定分配（ZLQ-156 §2.6「按 family hash 固定分配 16 shards」）。
 *
 * ## 为什么不直接 `hash % 16`
 *
 * 取模是**逐家族**稳定的：加一个家族不会挪动别人。但它的落点由哈希分布决定。
 * 实测（1026 件 / 144 家族 / 16 片，`corpusVersion 0.1.0-rc.1`）：
 * `stableBucket(familyId) % 16` 给出片间件数 **33…106**，极差 **73**，
 * 最重片是平均值的 **1.65 倍**；而 §2.6 同时给了「热 CI ≤3min」的硬预算，
 * **流水线时长由最重的 shard 决定**，不由平均数决定。一个 1.65 倍重的 shard
 * 会把整条门禁拖到预算外，而这不是「优化实现」能救的：分配本身就是瓶颈。
 *
 * 所以这里用「哈希定序 + 最长优先贪心装箱」：
 * 1. 家族按 `stableBucket(familyId)` 升序排 —— 顺序是**哈希的函数**，不含时钟、不含随机、
 *    不依赖 `allCaseSpecs()` 的返回次序；
 * 2. 依次把家族放进当前件数最少的 shard（并列时取序号最小的那个，保证唯一解）。
 *
 * 代价必须说清楚：这个分配**不是逐家族稳定的** —— 语料扩充（minor 版本）会改变排序，
 * 从而可能挪动已有家族的 shard。§2.6 要的「固定」由**钉住的计划清单**保证，
 * 而不是由公式保证：`planHash` 进报告，聚合作业核对「计划清单 hash 一致」后才算指标
 * （`manifest.ts` 的 `assertPlanComplete`）。钉住的清单比取模公式更强：
 * 取模只保证「同样的输入给同样的桶」，清单还保证「跑的就是当初批准的那份计划」。
 *
 * ## 家族原子性
 *
 * 一个家族的全部变体必须落在**同一个** shard。理由不是性能，是 §2.5 的
 * 「同一家族与它的变体只能位于一侧」——如果变体被拆到两个 shard，
 * 一个 shard 失败而另一个通过时，聚合报告会给出「这个家族一半有结果」的状态，
 * 而 §2.6 明确禁止「缺 shard / 跳过样例」被静默吸收。原子性让「家族缺结果」
 * 变成可判定的命题。
 */

import { canonicalJsonHash } from '../scan/hash.js';
import type { CorpusCaseSpec } from './generator.js';
import { stableBucket } from './random.js';

/** §2.6 表格里写死的分片数。改它就是改 CI 计划，必须同时改报告口径。 */
export const SHARD_COUNT = 16;

export type ShardIndex = number;

/** 一个家族的分片输入：它有多少件样例。 */
export type FamilyLoad = {
  readonly familyId: string;
  readonly caseCount: number;
};

/** 分配结果里的单行。`hash` 是排序键，写进清单让「谁排在谁前面」可核对。 */
export type ShardFamily = {
  readonly familyId: string;
  readonly shard: ShardIndex;
  readonly hash: string;
  readonly caseCount: number;
};

/**
 * 均衡度诊断。**报告里必须带上它**：只说「分了 16 片」而不说片间差多少，
 * 读者无法判断「热 CI ≤3min」这个预算有没有被最重的一片吃掉。
 */
export type ShardBalance = {
  readonly shardCount: number;
  readonly familyTotal: number;
  readonly caseTotal: number;
  readonly caseMin: number;
  readonly caseMax: number;
  readonly caseMean: number;
  /** `caseMax - caseMin`。0 表示完全均衡。 */
  readonly caseSpread: number;
  /** `caseMax / caseMean`。>1.5 说明分片本身成了瓶颈，该调分配而不是调并发。 */
  readonly caseImbalanceRatio: number;
  readonly familyMin: number;
  readonly familyMax: number;
};

export type ShardAssignment = {
  readonly shardCount: number;
  /** 按 (shard, hash) 排序的全量家族行。`planHash` 的输入就是它。 */
  readonly families: readonly ShardFamily[];
  /** `byShard[i]` = 第 i 片分到的家族，顺序同上。 */
  readonly byShard: readonly (readonly ShardFamily[])[];
  readonly balance: ShardBalance;
  /** 计划清单哈希。§2.6「聚合作业检查…计划清单 hash 一致后才算指标」。 */
  readonly planHash: string;
};

/** 从样例清单折叠出家族负载。家族内件数必须 >0，否则该家族根本不该出现在清单里。 */
export function familyLoadsOf(specs: readonly CorpusCaseSpec[]): readonly FamilyLoad[] {
  const counts = new Map<string, number>();
  for (const spec of specs) counts.set(spec.familyId, (counts.get(spec.familyId) ?? 0) + 1);
  return [...counts.entries()]
    .map(([familyId, caseCount]) => ({ familyId, caseCount }))
    .sort((a, b) => a.familyId.localeCompare(b.familyId));
}

/**
 * 哈希定序 + 最长优先贪心。**纯函数**：同样的负载清单 ⇒ 同样的分配 ⇒ 同样的 `planHash`。
 */
export function assignShards(
  families: readonly FamilyLoad[],
  shardCount: number = SHARD_COUNT,
): ShardAssignment {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`assignShards: shardCount 必须是 ≥1 的整数，收到 ${String(shardCount)}`);
  }
  const seen = new Set<string>();
  for (const family of families) {
    if (seen.has(family.familyId)) throw new Error(`assignShards: 家族重复 ${family.familyId}`);
    seen.add(family.familyId);
    if (!Number.isInteger(family.caseCount) || family.caseCount < 1) {
      throw new Error(
        `assignShards: 家族 ${family.familyId} 的 caseCount 必须是 ≥1 的整数，` +
          `收到 ${String(family.caseCount)}`,
      );
    }
  }

  const ordered = families
    .map((family) => ({ ...family, hash: stableBucket(family.familyId) }))
    // 先按哈希、再按 id 兜底：`stableBucket` 是 8 位十六进制，144 个家族里撞桶的概率
    // 非零（生日悖论下约 0.02%），撞桶时若不定序，分配就取决于输入顺序 —— 那是不可复现的。
    .sort((a, b) =>
      a.hash === b.hash ? a.familyId.localeCompare(b.familyId) : a.hash < b.hash ? -1 : 1,
    );

  const placed = new Array<ShardFamily[]>(shardCount);
  const loads = new Array<number>(shardCount);
  for (let shard = 0; shard < shardCount; shard += 1) {
    placed[shard] = [];
    loads[shard] = 0;
  }

  for (const family of ordered) {
    // 最长优先：件数多的先放。贪心在「大件先放」时的最坏界是 4/3·OPT，
    // 对 144 个家族 / 16 片的规模，实测片间件数 **60…69**、极差 **9**、
    // 最重片是平均值的 **1.076 倍**（对照上面的取模：73 / 1.65）。
    let target = 0;
    for (let shard = 1; shard < shardCount; shard += 1) {
      const current = loads[shard];
      const best = loads[target];
      if (current !== undefined && best !== undefined && current < best) target = shard;
    }
    const bucket = placed[target];
    const load = loads[target];
    if (bucket === undefined || load === undefined) throw new Error('assignShards: 内部分片表损坏');
    bucket.push({
      familyId: family.familyId,
      shard: target,
      hash: family.hash,
      caseCount: family.caseCount,
    });
    loads[target] = load + family.caseCount;
  }

  const byShard = placed.map((bucket) =>
    [...bucket].sort((a, b) =>
      a.hash === b.hash ? a.familyId.localeCompare(b.familyId) : a.hash < b.hash ? -1 : 1,
    ),
  );
  const flat = byShard.flatMap((bucket) => bucket);

  const caseCounts = byShard.map((bucket) => bucket.reduce((sum, row) => sum + row.caseCount, 0));
  const familyCounts = byShard.map((bucket) => bucket.length);
  const caseTotal = caseCounts.reduce((sum, n) => sum + n, 0);
  const caseMean = shardCount === 0 ? 0 : caseTotal / shardCount;

  return {
    shardCount,
    families: flat,
    byShard,
    balance: {
      shardCount,
      familyTotal: families.length,
      caseTotal,
      caseMin: Math.min(...caseCounts),
      caseMax: Math.max(...caseCounts),
      caseMean,
      caseSpread: Math.max(...caseCounts) - Math.min(...caseCounts),
      caseImbalanceRatio: caseMean === 0 ? 0 : Math.max(...caseCounts) / caseMean,
      familyMin: Math.min(...familyCounts),
      familyMax: Math.max(...familyCounts),
    },
    planHash: canonicalJsonHash({
      schema: 'littleq-corpus-shard-plan-v1',
      shardCount,
      families: flat.map((row) => ({
        familyId: row.familyId,
        shard: row.shard,
        hash: row.hash,
        caseCount: row.caseCount,
      })),
    }),
  };
}

/** caseId → shard 的反查表。runner 用它把实测行归到片，不必自己重算分配。 */
export function shardOfSpecs(
  specs: readonly CorpusCaseSpec[],
  shardCount: number = SHARD_COUNT,
): {
  readonly assignment: ShardAssignment;
  readonly shardOfCaseId: ReadonlyMap<string, ShardIndex>;
} {
  const assignment = assignShards(familyLoadsOf(specs), shardCount);
  const byFamily = new Map(assignment.families.map((row) => [row.familyId, row.shard]));
  const shardOfCaseId = new Map<string, ShardIndex>();
  for (const spec of specs) {
    const shard = byFamily.get(spec.familyId);
    if (shard === undefined) throw new Error(`shardOfSpecs: 家族未分配 ${spec.familyId}`);
    shardOfCaseId.set(spec.caseId, shard);
  }
  return { assignment, shardOfCaseId };
}

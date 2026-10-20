/**
 * 从 `findingId` 反解规则子类型（ZLQ-156 §6.2 / §8.6 的 subType 级实测通道）。
 *
 * ## 为什么需要这个模块
 *
 * `Finding` 的输出面（`src/scan/types.ts:146`）**没有 `subType` 字段**。`src/scan/finding.ts:81`
 * 写得很明确：「规则子类型（§6.2）。只进 HMAC，不出现在输出里 —— 输出只有 `ruleId` 和固定的
 * `explanationKey`」，而 `explanationKeyForRule(ruleId)` 是每条规则一个常量，也不携带子类型信息。
 *
 * 这留下一个实测缺口：§8.6 要按规则算 precision，而一条规则（例如 B13）下挂着 9~10 个子类型，
 * 只看 `ruleId` 就只能知道「B13 命中了」，不能知道「命中的是 hate-violence 还是 csae」。
 * 于是 13 条规则 × 6 个变异家族精心构造出来的**单点归因**在报告里会被压平成 13 个数字。
 *
 * 补这个缺口有两条路：
 * - **改 `Finding` 的输出面，把 `subType` 暴露出来** —— 那是改已交付并已被 PM 验收的 D3a 代码，
 *   本单无权做（票面：「不重写扫描器判定算法」），而且会改 `openapi.json` 快照。
 * - **从 `findingId` 反解** —— `findingId = HMAC(key, ruleId \0 fileHash \0 locationKey \0 subType)`，
 *   其中 `key = utf8('littleq-scanner-v1|' + scannerVersion + '|' + rulesetVersion)`。
 *   这四个输入里，`ruleId` / `location` 来自报告本身，`fileHash` 来自建包时的实测 `built.hashes`，
 *   `scannerVersion` / `rulesetVersion` 由调用方给定 —— 也就是说**除了 `subType` 全部已知**。
 *   而语料样例的 `subType` 候选集是有限且已声明的（每个变异家族在 `violations.ts` 里写明
 *   `expectedSubTypes`），所以逐个候选重算 HMAC、与实测 `findingId` 比对即可唯一确定。
 *
 * 本模块走第二条路。
 *
 * ## 这不是「拿结果改期望」
 *
 * ZLQ-194 §16 明令禁止「把 expected 改写成 actual 的样子」。反解不触犯它，因为方向是反的：
 * 候选集来自**样例构造时就声明好的** `expectedSubTypes`，反解只回答「实测命中的是候选集里的
 * 哪一个」，命中不了任何一个就是 `null`，由上层记为**不一致**（污染或期望错误），
 * 绝不反过来把 `null` 填回声明。声明集是输入，反解结果是输出，两者不能互换。
 *
 * ## 反解失败要响亮，不要静默
 *
 * `FINDING_KEY_PREFIX` 在 `finding.ts` 里是模块私有的，本模块只能把它抄一份。若上游改了前缀，
 * 反解会对**所有** finding 返回 `null`。这必须被识别成「反解通道失效」而不是「780 个语料缺陷」，
 * 所以 `assertSubTypeChannelLive` 提供一个阳性对照：拿一条已知子类型的 finding 试反解，
 * 失败就抛，并指名是通道问题。上层流水线在跑全量之前必须先过这道对照。
 */

import { hmacOfText, utf8 } from '../scan/hash.js';
import { locationKey } from '../scan/finding.js';
import type { Finding } from '../scan/types.js';

/**
 * 抄自 `src/scan/finding.ts:72` 的 `FINDING_KEY_PREFIX`（模块私有，未导出）。
 *
 * 抄常量是有代价的：上游改了它，这里会静默失配。所以配了 `assertSubTypeChannelLive`
 * 做阳性对照 —— 失配会在跑全量之前抛错，而不是把整份报告变成一片 `null`。
 */
const FINDING_KEY_PREFIX = 'littleq-scanner-v1';

/** 与 `FindingFactory` 构造函数里逐字节同形的 key 派生。 */
function findingKey(scannerVersion: string, rulesetVersion: string): Uint8Array {
  return utf8(`${FINDING_KEY_PREFIX}|${scannerVersion}|${rulesetVersion}`);
}

/** 与 `FindingFactory.emit` 里逐字节同形的身份串拼接。 */
function identityOf(
  finding: Finding,
  fileHashes: Readonly<Record<string, string>>,
  subType: string,
): string {
  const fileHash = fileHashes[finding.path];
  if (fileHash === undefined) {
    throw new SubTypeChannelError(
      `finding 的路径不在实测 hash 表里：${finding.path}（建包时的 hashes 与扫描输入不是同一份）`,
    );
  }
  return [finding.ruleId, fileHash, locationKey(finding.location), subType].join('\u0000');
}

/** 反解通道自身的故障（区别于「语料与扫描器不一致」）。 */
export class SubTypeChannelError extends Error {
  readonly code = 'SUBTYPE_CHANNEL_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'SubTypeChannelError';
  }
}

export type SubTypeRecovery =
  | { readonly ok: true; readonly subType: string }
  /** 命中了候选集里的多个：说明候选集里有两项在同位置同规则下等价，是语料声明缺陷。 */
  | { readonly ok: false; readonly reason: 'ambiguous'; readonly matched: readonly string[] }
  /** 一个都没命中：期望集与实测不符（污染，或期望写错），由上层记账。 */
  | { readonly ok: false; readonly reason: 'no-match' };

/**
 * 在声明的候选集里反解一条 finding 的子类型。
 *
 * `candidates` 必须是**样例构造时声明的** `expectedSubTypes`，不能是「扫描器可能产出的一切」。
 * 传全集会让反解退化成枚举攻击式的猜谜，也就失去了归因意义。
 */
export function recoverSubType(
  finding: Finding,
  fileHashes: Readonly<Record<string, string>>,
  scannerVersion: string,
  rulesetVersion: string,
  candidates: readonly string[],
): SubTypeRecovery {
  const key = findingKey(scannerVersion, rulesetVersion);
  const matched: string[] = [];
  for (const candidate of candidates) {
    if (hmacOfText(key, identityOf(finding, fileHashes, candidate)) === finding.findingId) {
      matched.push(candidate);
    }
  }
  if (matched.length === 1) return { ok: true, subType: matched[0] as string };
  if (matched.length > 1) return { ok: false, reason: 'ambiguous', matched };
  return { ok: false, reason: 'no-match' };
}

/**
 * 阳性对照：证明反解通道当前是通的。
 *
 * 用法是拿一条**已知**子类型的 finding 反解 —— 已知，因为它就是本模块自己按
 * `identityOf` 正算出来的。正算与反解必须互逆；不互逆只可能是 key 前缀或拼接顺序变了。
 *
 * 这道对照必须在跑全量语料之前过一次。少了它，一次上游前缀改动会把整份报告的
 * subType 列变成 `null`，而 `null` 在指标里长得像「没有命中」，不像「测不了」。
 */
export function assertSubTypeChannelLive(scannerVersion: string, rulesetVersion: string): void {
  const probeSubType = 'corpus-channel-probe';
  const probePath = 'corpus/probe.txt';
  const probeHash = 'a'.repeat(64);
  const key = findingKey(scannerVersion, rulesetVersion);
  const probe: Finding = {
    findingId: hmacOfText(key, ['B1', probeHash, locationKey(null), probeSubType].join('\u0000')),
    ruleId: 'B1',
    disposition: 'BLOCK',
    confidence: 'HIGH',
    path: probePath,
    location: null,
    explanationKey: 'b1-external-resource',
    repairAction: 'LOCALIZE_RESOURCE',
  };
  const recovered = recoverSubType(
    probe,
    { [probePath]: probeHash },
    scannerVersion,
    rulesetVersion,
    ['decoy-not-it', probeSubType, 'another-decoy'],
  );
  if (!recovered.ok || recovered.subType !== probeSubType) {
    throw new SubTypeChannelError(
      `子类型反解通道失效（正算的 findingId 反解不回来，得到 ${JSON.stringify(recovered)}）。` +
        `最可能的原因是 src/scan/finding.ts 的 FINDING_KEY_PREFIX 已改动，而本模块抄的是旧值。` +
        `这是**测量通道**故障，不是语料缺陷：不要把它记成样例不一致。`,
    );
  }
}

/**
 * 规则接口（ZLQ-153 §8.3 的 B1–B13 表；ZLQ-156 §6.2 的 finding 形状）。
 *
 * 三条设计约束：
 * 1. **一条规则一个文件、一个 `id`、一份 `subTypes`**。§3 要求「逐条实现，不得合并、不得降级为正则」——
 *    「不得合并」必须**结构上**可见，所以这里不是一个 `switch (ruleId)` 的大函数，而是十三个各自
 *    声明自己子类型的独立模块；`registry` 再断言 id 集合恰好等于 `RULE_IDS`。
 * 2. **`maxDisposition` 由规则自己声明，由 `FindingFactory` 强制**。规则不能靠自己「记得」不硬拦：
 *    B12 声明 `CONFIRM_REQUIRED` 之后，它内部的任何一条 `emit({disposition:'BLOCK'})` 都会抛
 *    `DispositionCeilingError`（§8 变异控制 1 就是冲这个设计去的）。
 * 3. **规则拿到的是整包上下文，不是单个文件**。B1 的资源图、B10 的「压缩产物之外必须有可读源」
 *    都是跨文件判定；把接口收窄成 per-file 会逼着这两条规则退化成局部猜测。
 */

import type { Budget } from '../budget.js';
import type { FindingDraft } from '../finding.js';
import type { ResourceGraph } from '../graph.js';
import type { LineIndex } from '../location.js';
import type { ParseSummary } from '../analysis/model.js';
import type {
  Disposition,
  FileRole,
  Finding,
  RuleId,
  ScanPolicySnapshot,
  ValidatedWorkMetadata,
} from '../types.js';

export type RuleFileContext = {
  readonly path: string;
  readonly role: FileRole;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  /** 解码后的文本；二进制形态为 null。 */
  readonly text: string | null;
  readonly summary: ParseSummary;
  /** 对 `text` 建的行索引；`text` 为 null 时为 null。 */
  readonly lines: LineIndex | null;
};

export type RuleContext = {
  readonly metadata: ValidatedWorkMetadata;
  readonly policy: ScanPolicySnapshot;
  readonly graph: ResourceGraph;
  /** 全部文件，按 `comparePathBytes` 排序（确定性遍历顺序）。 */
  readonly files: readonly RuleFileContext[];
  readonly fileByPath: ReadonlyMap<string, RuleFileContext>;
  readonly budget: Budget;
  /** 产出一条 finding；重复命中返回 null；超过该规则 `maxDisposition` 会抛。 */
  emit(draft: FindingDraft): Finding | null;
};

export type Rule = {
  readonly id: RuleId;
  /**
   * 这条规则能产出的最高处置。
   *
   * B12 只能是 `CONFIRM_REQUIRED`（ZLQ-153 §8.3「只标记确认，不硬拦」、§8.6「B12 始终确认」、
   * ZLQ-201 不可协商项 2）。其余规则允许 `BLOCK`，但**允许**不等于**总是**：B8/B13 的低置信项
   * 按 §8.6「低置信进入成人复核」产出 CONFIRM_REQUIRED。
   */
  readonly maxDisposition: Disposition;
  /** 规则覆盖的子类型（进 `findingId` 的 HMAC，也用于测试断言「逐条实现」）。 */
  readonly subTypes: readonly string[];
  run(context: RuleContext): void;
};

/**
 * 用量策略（附录 A §6.6）。
 *
 * §6.6 的四条规则在这里各有一个纯函数出口，彼此不重叠：
 *
 * 1. **准入** —— 创建 AI task 时在同一事务里检查 limit（`decideUsageAdmission`）。
 *    「额度为零只阻断新的 AI task；编辑、预览、发布已有版本、批改和浏览不受影响」
 *    不是靠调用方记得跳过检查实现的：`capabilityOfTaskKind(kind)` 对 `PUBLISH` /
 *    `RESCAN` 返回 `null`，domain 据此**结构性地**不认识"发布的额度"，
 *    因此不存在一条能阻断它们的代码路径。
 * 2. **结算** —— `planUsageSettlement` 决定 reservation 落 `COMMITTED` 还是
 *    `RELEASED`，以及是否必须写 ledger。
 * 3. **入账优先于结果** —— 「调用已发生即写 ledger，即使任务失败」：只要
 *    `providerCallHappened` 为真，`ledgerEntryRequired` 就是真，与任务终态无关。
 *    取消**不能**推翻它：取消一个已经打过 provider 的任务仍然要入账，
 *    否则这笔消耗会被无声退回额度。
 * 4. **重试安全性不外推** —— §6.6「`retryable` 不得通过异常继承推导，只能查固定
 *    `(stage,code)` 表」由 `./retry-policy.js` 承担；这里不做任何异常分类。
 *
 * 与 §6.5 一样，本模块**不持有计数**：周期内已提交量与在留量都由调用方从持久化的
 * ledger / reservation 行里查出来再传进来。domain 不知道 `periodKey` 对应的行锁怎么加，
 * 也不知道事务怎么开（§6.3 右栏）。
 */

import {
  capabilityOfTaskKind,
  parseUsagePeriod,
  type Capability,
  type UsagePeriod,
} from '../value-objects/usage.js';
import { parseTaskKind, type TaskKind } from '../value-objects/task.js';

/** 该 capability 在本周期内的限额行状态。 */
export type UsageLimitRecord =
  /** `usage_limits` 里有这一行。 */
  | { readonly kind: 'CONFIGURED'; readonly limitUnits: number; readonly enabled: boolean }
  /**
   * 没有这一行，即**未设上限**，结论是 ADMIT。
   *
   * domain 不发明默认额度值：附录 A §6.3 对 `memberLimit` 的裁定是「默认数值不在 domain
   * 硬编码」，用量同理 —— 契约里没有"新学生的初始额度"，编一个数字出来等于把产品决策
   * 藏进代码。限额行是否应当预置、预置成多少，是 application / 运维的决定。
   */
  | { readonly kind: 'ABSENT' };

export type UsageAdmissionDecision =
  | { readonly kind: 'ADMIT' }
  | { readonly kind: 'BLOCK'; readonly errorCode: 'USAGE_LIMIT_EXCEEDED' };

/** 计量任务申请准入时必须给出的额度快照。 */
export type UsageQuotaSnapshot = {
  readonly capability: Capability;
  readonly period: UsagePeriod;
  /** 本周期内已 `COMMITTED` 的量之和（ledger 行，不是内存累加）。 */
  readonly committedInPeriod: number;
  /** 本周期内仍处 `HELD` 的预留量之和。 */
  readonly heldInPeriod: number;
  readonly limit: UsageLimitRecord;
};

export type UsageAdmissionContext = {
  readonly kind: TaskKind;
  /**
   * 本次要预留的量，必须是 ≥1 的整数。
   *
   * 0 被拒绝而不是被当成"免费的准入检查"：§6.6 要求预留与限额检查在同一事务里发生，
   * 一笔 0 量的预留只会造出一行没有意义的 `HELD`，还会让「额度为零只阻断新的 AI task」
   * 变成假话（0 ≤ 0 会放行）。调用方若只想问"这个学生还能不能开任何 AI 任务"，
   * 传 1 就是最小的一次。
   */
  readonly requestedUnits: number;
  /** 计量任务必填；不计量任务（`PUBLISH`/`RESCAN`）忽略。 */
  readonly quota?: UsageQuotaSnapshot;
};

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/**
 * 该周期内还剩多少可用量；可以为负（结算超出预留时），负数意味着任何申请都被阻断。
 * `null` 表示**没有上限**（限额行不存在），与"上限很大"不是一回事，所以不用一个巨大的
 * 数字冒充它 —— 那样调用方无从判断自己拿到的是真额度还是哨兵值。
 */
export function availableUnits(quota: UsageQuotaSnapshot): number | null {
  assertCount(quota.committedInPeriod, 'committedInPeriod');
  assertCount(quota.heldInPeriod, 'heldInPeriod');
  if (quota.limit.kind === 'ABSENT') return null;
  assertCount(quota.limit.limitUnits, 'limitUnits');
  return quota.limit.limitUnits - quota.committedInPeriod - quota.heldInPeriod;
}

/**
 * 创建 AI task 前的准入判定。
 *
 * `ADMIT` / `BLOCK` 是二值的，没有 §6.5 那样的 `QUEUE`：额度不是并发调度问题，
 * 撞了上限就是 `429 USAGE_LIMIT_EXCEEDED`，排队等额度会让学生面对一个永远不动的进度条。
 */
export function decideUsageAdmission(context: UsageAdmissionContext): UsageAdmissionDecision {
  const kind = parseTaskKind(context.kind);
  const capability = capabilityOfTaskKind(kind);
  if (capability === null) return { kind: 'ADMIT' };

  if (!Number.isSafeInteger(context.requestedUnits) || context.requestedUnits < 1) {
    throw new RangeError(
      `requestedUnits must be a safe integer >= 1, got ${String(context.requestedUnits)}`,
    );
  }

  const quota = context.quota;
  if (quota === undefined) {
    throw new TypeError(`quota is required for metered task kind: ${kind}`);
  }
  if (quota.capability !== capability) {
    throw new TypeError(
      `quota capability ${quota.capability} does not match task kind ${kind} (${capability})`,
    );
  }
  parseUsagePeriod(quota.period);

  if (quota.limit.kind === 'CONFIGURED' && !quota.limit.enabled) {
    return { kind: 'BLOCK', errorCode: 'USAGE_LIMIT_EXCEEDED' };
  }
  const available = availableUnits(quota);
  if (available === null) return { kind: 'ADMIT' };
  return context.requestedUnits <= available
    ? { kind: 'ADMIT' }
    : { kind: 'BLOCK', errorCode: 'USAGE_LIMIT_EXCEEDED' };
}

/** 结算请求。判别式是「provider 调用有没有真的发生」，它决定要不要入账。 */
export type SettlementRequest =
  /** 调用已发生：必须给出实际量，否则 domain 无从结算，也不会拿预留量顶替。 */
  | { readonly providerCallHappened: true; readonly actualUnits: number }
  /** 未调用 provider：预留全额释放，不产生 ledger 行。 */
  | { readonly providerCallHappened: false };

export type SettlementPlan = {
  /** reservation 的终态（`commitUsage` / `releaseUsage` 的判据）。 */
  readonly reservationState: 'COMMITTED' | 'RELEASED';
  /** 是否必须写 `usage_ledger`。 */
  readonly ledgerEntryRequired: boolean;
  /** 入账量；`RELEASED` 时为 0。 */
  readonly ledgerQuantity: number;
};

/**
 * 结算方案。`cancelled` 之所以**不是**入参：取消只影响 reservation 的终态，
 * 而终态已经被 `providerCallHappened` 完全决定 —— 调用没发生就是 `RELEASED`
 * （§6.6「取消或未调用 provider 时 RELEASED」的两种情形在这里是同一条路径），
 * 调用发生了就是 `COMMITTED`。把 `cancelled` 也传进来只会造出一个能推翻入账的分支。
 *
 * 「释放差额」不在这里算：差额是 `reservedUnits - actualUnits`，而预留量属于
 * reservation 实体，`settlementDelta` 已经算过了。在这里再算一遍就得把预留量也传进来，
 * 于是同一条减法有了两个事实源。
 */
export function planUsageSettlement(request: SettlementRequest): SettlementPlan {
  if (!request.providerCallHappened) {
    return { reservationState: 'RELEASED', ledgerEntryRequired: false, ledgerQuantity: 0 };
  }
  assertCount(request.actualUnits, 'actualUnits');
  return {
    reservationState: 'COMMITTED',
    ledgerEntryRequired: true,
    ledgerQuantity: request.actualUnits,
  };
}

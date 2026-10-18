/**
 * `(stage, code)` 重试策略表（arch §7.4：「可重试性是 `(stage,code)` **显式表**，
 * 不使用异常类继承推导」；附录 A §6.6 同一条）。
 *
 * ## 为什么 catalog 里已经有 `retryable` 了还要这张表
 *
 * 因为它们回答的是**三个不同的问题**，混成一个字段就会说假话：
 *
 * | 问题 | 事实源 | `TASK_TIMEOUT` 的答案 |
 * | --- | --- | --- |
 * | 客户端能不能原样重放这个 HTTP 请求 | `catalog.retryable` + `sameRequestRetrySafety` | 否 |
 * | 推进器能不能自动重试这一阶段 | **本表** | 否 |
 * | 用户能不能对终态任务点开一次新 attempt | `RETRYABLE_ENTRY_TASK_STATES` + `beginRetryAttempt` | 能 |
 *
 * 反过来看 `AGENT_FAILED`：对外 `retryable: 否`（客户端重放同一个 turn 请求不会让
 * Agent 变得能跑），但 arch §7.4 允许推进器「仅明确可重试码 1 次」。这两个答案同时成立，
 * 只有分成两张表才写得出来。
 *
 * ## `requiresProviderVerdict`
 *
 * arch §7.4 对 `AGENT_FAILED` 的限定是「仅明确可重试码」。哪些 provider 错误码算"明确
 * 可重试"这件事 domain **不能**知道：原始 provider body / headers / stack 被 §6.4 明确
 * 划到 application/infra。所以这里只声明"需要一个外部判定"，把判定本身留给调用方 ——
 * 预算（1 次）是领域事实，白名单（哪些码）是集成事实。
 *
 * ## `stageRetryCap: null`
 *
 * `null` 表示"没有阶段专属上限，由 `AiTask.maxAttempts` 与 `hasAttemptsLeft` 统一约束"。
 * arch §7.4 只为三处钉了数字（`QCA_UNREACHABLE` 2、`AGENT_FAILED` 1、产物补交 1），
 * 其余交给任务级 attempt 预算。给没有钉数字的地方编一个上限，就是把产品决策藏进代码。
 */

import { isErrorCode, type ErrorCode } from '../errors/catalog.js';
import { taskErrorRegistry } from '../errors/task-registry.js';
import {
  TASK_KINDS,
  TASK_REPAIR_BUDGET,
  TASK_STAGES,
  type TaskStage,
} from '../value-objects/task.js';

export type RetryMechanism = 'NONE' | 'RETRY_WAIT' | 'SESSION_REPAIR';
export type RetryBackoff = 'NONE' | 'EXPONENTIAL';

export type StageErrorRetryPolicy = {
  readonly stage: TaskStage;
  readonly code: ErrorCode;
  /** 推进器能否自动重试本阶段。不是对外的 `retryable` 字段。 */
  readonly retryable: boolean;
  /** 阶段专属重试次数上限；`null` = 由任务级 `maxAttempts` 约束。 */
  readonly stageRetryCap: number | null;
  readonly backoff: RetryBackoff;
  readonly mechanism: RetryMechanism;
  /** true = 还须调用方给出"provider 错误码在可重试白名单内"的显式判定。 */
  readonly requiresProviderVerdict: boolean;
};

function no(stage: TaskStage, code: ErrorCode): StageErrorRetryPolicy {
  return {
    stage,
    code,
    retryable: false,
    stageRetryCap: 0,
    backoff: 'NONE',
    mechanism: 'NONE',
    requiresProviderVerdict: false,
  };
}

/**
 * 全表。**每一对 `(stage, code)` 都必须出现且只出现一次** —— 覆盖范围就是
 * `taskErrorRegistry` 里登记过的全部异步错误对，由 `assertRetryPolicyCoherent`
 * 在模块加载期双向核对（表里不许有孤儿行，登记表里不许有未裁决的对）。
 *
 * "查不到就当不可重试"是兜底而不是设计：显式登记每一对，才能让评审者一眼看出
 * 哪些失败是**故意**不重试的。
 */
export const STAGE_ERROR_RETRY_POLICIES: readonly StageErrorRetryPolicy[] = [
  // 凭证问题不会靠重试自愈：需要人去配 / 去换 PAT 或 API Key。
  no('AUTH', 'QCA_CREDENTIAL_NOT_CONFIGURED'),
  no('AUTH', 'QCA_CREDENTIAL_INVALID'),
  no('AUTH', 'BAILIAN_CREDENTIAL_NOT_CONFIGURED'),
  no('AUTH', 'BAILIAN_CREDENTIAL_INVALID'),
  // 额度耗尽同理：重试只会再撞一次 429，并让学生在进度条前多等一轮退避。
  no('QUOTA', 'QCA_QUOTA_EXHAUSTED'),
  no('QUOTA', 'BAILIAN_QUOTA_EXHAUSTED'),
  // arch §7.4：`QCA_UNREACHABLE` 最多 2 次，指数退避。
  {
    stage: 'TRANSPORT',
    code: 'QCA_UNREACHABLE',
    retryable: true,
    stageRetryCap: 2,
    backoff: 'EXPONENTIAL',
    mechanism: 'RETRY_WAIT',
    requiresProviderVerdict: false,
  },
  // Bailian 侧对称。arch §7.4 的注解写在 QCA 段落里，但 catalog 已把两者标为同形
  // （retryable 是、REQUIRES_IDEMPOTENCY_KEY），故沿用同一预算 2 次。
  // 这是一处**补齐**而非引用，属于需要架构师确认的声明项。
  {
    stage: 'TRANSPORT',
    code: 'BAILIAN_UNREACHABLE',
    retryable: true,
    stageRetryCap: 2,
    backoff: 'EXPONENTIAL',
    mechanism: 'RETRY_WAIT',
    requiresProviderVerdict: false,
  },
  // arch §7.4：`AGENT_FAILED` 仅明确可重试码 1 次。
  {
    stage: 'AGENT_RUN',
    code: 'AGENT_FAILED',
    retryable: true,
    stageRetryCap: 1,
    backoff: 'EXPONENTIAL',
    mechanism: 'RETRY_WAIT',
    requiresProviderVerdict: true,
  },
  // arch §7.4：产物缺失 / 不完整可请求 Agent 补交 1 次。
  // 走 SESSION_REPAIR：同一 task、同一 session、同一 operation key（§6.2），
  // 上限与 `TASK_REPAIR_BUDGET` 是同一个数字，由自检钉住，不各写一份。
  {
    stage: 'COLLECT',
    code: 'ARTIFACT_MISSING',
    retryable: true,
    stageRetryCap: TASK_REPAIR_BUDGET,
    backoff: 'NONE',
    mechanism: 'SESSION_REPAIR',
    requiresProviderVerdict: false,
  },
  {
    stage: 'COLLECT',
    code: 'ARTIFACT_INCOMPLETE',
    retryable: true,
    stageRetryCap: TASK_REPAIR_BUDGET,
    backoff: 'NONE',
    mechanism: 'SESSION_REPAIR',
    requiresProviderVerdict: false,
  },
  // 构建、契约、内容三类失败重跑同样的输入只会得到同样的结论：它们是确定性判定。
  no('BUILD', 'BUILD_FAILED'),
  no('CONTRACT', 'WORK_CONTRACT_BLOCKED'),
  no('CONTENT', 'CONTENT_REJECTED'),
  // 超时是终态（arch §6.1 `RUNNING → TIMED_OUT`）。用户仍可 `POST /tasks/{id}:retry`
  // 开一次新 attempt —— 那是 `beginRetryAttempt` 的语义，不由推进器自动发生。
  no('TIMEOUT', 'TASK_TIMEOUT'),
  no('CANCEL', 'USER_CANCELLED'),
  // 依赖不可用：catalog 标为可重试，故推进器也重试；arch §7.4 未钉阶段上限
  // （`DEPENDENCY` 是本文补齐的阶段），交任务级 attempt 预算，因此为 null。
  {
    stage: 'DEPENDENCY',
    code: 'DEPENDENCY_UNAVAILABLE',
    retryable: true,
    stageRetryCap: null,
    backoff: 'EXPONENTIAL',
    mechanism: 'RETRY_WAIT',
    requiresProviderVerdict: false,
  },
  // 未知内部错误不自动重试：重放一个我们不明白的失败是最容易放大损害的做法。
  no('INTERNAL', 'INTERNAL_ERROR'),
];

const POLICY_BY_PAIR: ReadonlyMap<string, StageErrorRetryPolicy> = new Map(
  STAGE_ERROR_RETRY_POLICIES.map((policy) => [`${policy.stage}\u0000${policy.code}`, policy]),
);

function pairKey(stage: TaskStage, code: ErrorCode): string {
  return `${stage}\u0000${code}`;
}

/** 登记过的异步 `(stage, code)` 对，来自 `taskErrorRegistry`（派生集合，语义无序，故排序）。 */
export function registeredStageErrorPairs(): readonly string[] {
  const pairs = new Set<string>();
  for (const kind of TASK_KINDS) {
    const stages = taskErrorRegistry[kind];
    for (const stage of TASK_STAGES) {
      for (const code of stages[stage] ?? []) pairs.add(pairKey(stage, code));
    }
  }
  return [...pairs].sort();
}

/** 查表。`undefined` 表示未登记 —— 调用方必须按不可重试处理。 */
export function stageErrorRetryPolicy(
  stage: TaskStage,
  code: ErrorCode,
): StageErrorRetryPolicy | undefined {
  return POLICY_BY_PAIR.get(pairKey(stage, code));
}

/** 推进器能否自动重试这一对失败。未登记 = 不能（fail-closed）。 */
export function canAutoRetryStageError(stage: TaskStage, code: ErrorCode): boolean {
  return stageErrorRetryPolicy(stage, code)?.retryable ?? false;
}

/**
 * 自动重试的完整判据：表说可重试，且（若需要）调用方已给出 provider 判定。
 *
 * 这里不检查次数 —— 次数属于任务状态（`attempt` / `repairCount`），由
 * `hasAttemptsLeft` 与 `canRequestRepair` 判定；本表只给出上限值。
 */
export function shouldAutoRetryStageError(
  stage: TaskStage,
  code: ErrorCode,
  providerVerdict: { readonly retryableByProviderCode: boolean } = {
    retryableByProviderCode: false,
  },
): boolean {
  const policy = stageErrorRetryPolicy(stage, code);
  if (policy === undefined || !policy.retryable) return false;
  return policy.requiresProviderVerdict ? providerVerdict.retryableByProviderCode : true;
}

/**
 * 自检。类型系统已经保证了字段形状，所以这里只查类型查不出来的东西：
 * 与 `taskErrorRegistry` 的**双向覆盖**、内部一致性、以及产物补交上限与
 * `TASK_REPAIR_BUDGET` 同源。抛普通 `Error`（这是我们代码里的 bug，不是外部输入不合法），
 * 并且在模块加载期就抛 —— 一张漏了裁决的重试表不该活到运行期。
 */
export function assertRetryPolicyCoherent(
  policies: readonly StageErrorRetryPolicy[] = STAGE_ERROR_RETRY_POLICIES,
): void {
  const seen = new Set<string>();
  for (const policy of policies) {
    if (!isErrorCode(policy.code))
      throw new Error(`unknown error code in retry policy: ${policy.code}`);
    if (!(TASK_STAGES as readonly string[]).includes(policy.stage)) {
      throw new Error(`unknown stage in retry policy: ${policy.stage}`);
    }
    const key = pairKey(policy.stage, policy.code);
    if (seen.has(key)) throw new Error(`duplicate retry policy for ${policy.stage}/${policy.code}`);
    seen.add(key);

    if (policy.retryable) {
      if (policy.mechanism === 'NONE')
        throw new Error(`retryable policy without mechanism: ${key}`);
      if (
        policy.stageRetryCap !== null &&
        (!Number.isInteger(policy.stageRetryCap) || policy.stageRetryCap < 1)
      ) {
        throw new Error(`retryable policy needs stageRetryCap >= 1 or null: ${key}`);
      }
      if (policy.stage === 'COLLECT' && policy.stageRetryCap !== TASK_REPAIR_BUDGET) {
        throw new Error(`artifact repair cap must equal TASK_REPAIR_BUDGET: ${key}`);
      }
    } else {
      if (policy.mechanism !== 'NONE')
        throw new Error(`non-retryable policy must not name a mechanism: ${key}`);
      if (policy.stageRetryCap !== 0)
        throw new Error(`non-retryable policy must have stageRetryCap 0: ${key}`);
      if (policy.backoff !== 'NONE')
        throw new Error(`non-retryable policy must have no backoff: ${key}`);
      if (policy.requiresProviderVerdict)
        throw new Error(`non-retryable policy must not require a provider verdict: ${key}`);
    }
  }

  const registered = new Set(registeredStageErrorPairs());
  for (const key of registered) {
    if (!seen.has(key))
      throw new Error(
        `registered stage/code pair has no retry policy: ${key.replace('\u0000', '/')}`,
      );
  }
  for (const key of seen) {
    if (!registered.has(key))
      throw new Error(
        `retry policy for a pair no task kind can produce: ${key.replace('\u0000', '/')}`,
      );
  }
}

assertRetryPolicyCoherent();

/**
 * 只读视图：按 `(stage, code)` 升序。
 *
 * 用码位比较而不是 `localeCompare` —— 后者跟随宿主默认 locale，同一张表在不同机器上
 * 可能给出不同顺序，而这张表的顺序会进入派生输出（附录 A G6 / §4.1）。
 */
export function stageErrorRetryPolicyRows(): readonly StageErrorRetryPolicy[] {
  return [...STAGE_ERROR_RETRY_POLICIES].sort((a, b) => {
    const left = pairKey(a.stage, a.code);
    const right = pairKey(b.stage, b.code);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

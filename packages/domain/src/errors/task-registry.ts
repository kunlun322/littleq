import { isErrorCode, type ErrorCode } from './catalog.js';
import { TASK_KINDS, TASK_STAGES, type TaskKind, type TaskStage } from '../value-objects/task.js';

/**
 * 异步错误登记表 —— 附录 A §5.4 要求的纯 TS 结构：
 * `Record<TaskKind, Partial<Record<TaskStage, ErrorCode[]>>>`。
 *
 * 为什么单独一张表，而不是把异步错误也挂到 operation 上：`GET /tasks/{id}` 与
 * `GET /tasks/{id}/events` 自身**不产生**这些错误（它们的 operation 级专属码为空），
 * 但 task body 与 SSE safe event 里会承载全部异步分类。把它挂在 operation 上会让
 * 「这个接口会返回 502」变成一句假话；挂在 `(taskKind, stage)` 上才是它的真实归属
 * ——错误由哪一类任务的哪一阶段产生。
 *
 * 生成器对这张表做**双向**校验：表里的每个码必须存在于 domain catalog（防止写错
 * 字或引用一个已被删除的码），catalog 里每个非全局码必须至少被一个 operation 或一个
 * `(taskKind, stage)` 引用（防止错误码目录里躺着孤儿）。
 *
 * `INTERNAL_ERROR` 与 `DEPENDENCY_UNAVAILABLE` **不隐式挂载**：它们出现在这里是因为
 * 每类任务都显式登记了 `INTERNAL` / `DEPENDENCY` 两个阶段，而不是因为生成器给所有
 * operation 兜底加了它们。
 */
export type TaskErrorRegistry = Record<TaskKind, Partial<Record<TaskStage, ErrorCode[]>>>;

/**
 * QCA 与 Bailian 共有的、与供应商无关的收尾阶段。
 *
 * 用工厂而不是共享常量：`ErrorCode[]` 是可变数组，六个 kind 复用同一个实例的话，
 * 任何一处就地修改都会同时改掉其它 kind 的登记表。
 */
function commonTailStages(): Partial<Record<TaskStage, ErrorCode[]>> {
  return {
    CONTENT: ['CONTENT_REJECTED'],
    TIMEOUT: ['TASK_TIMEOUT'],
    CANCEL: ['USER_CANCELLED'],
    DEPENDENCY: ['DEPENDENCY_UNAVAILABLE'],
    INTERNAL: ['INTERNAL_ERROR'],
  };
}

export const taskErrorRegistry: TaskErrorRegistry = {
  /**
   * 生成式回合：唯一会走完整 Agent 运行与产物收集/构建/契约链路的任务类型，
   * 因此阶段最多。
   */
  VIBE_TURN: {
    AUTH: ['QCA_CREDENTIAL_NOT_CONFIGURED', 'QCA_CREDENTIAL_INVALID'],
    QUOTA: ['QCA_QUOTA_EXHAUSTED'],
    TRANSPORT: ['QCA_UNREACHABLE'],
    AGENT_RUN: ['AGENT_FAILED'],
    COLLECT: ['ARTIFACT_MISSING', 'ARTIFACT_INCOMPLETE'],
    BUILD: ['BUILD_FAILED'],
    CONTRACT: ['WORK_CONTRACT_BLOCKED'],
    ...commonTailStages(),
  },
  /**
   * 发布与重扫只作用于**已经提交的不可变版本**（附录 A §6.6），不跑 Agent、不产出
   * 新产物，所以没有 AUTH/QUOTA/TRANSPORT/AGENT_RUN/COLLECT 阶段。
   */
  PUBLISH: {
    BUILD: ['BUILD_FAILED'],
    CONTRACT: ['WORK_CONTRACT_BLOCKED'],
    ...commonTailStages(),
  },
  RESCAN: {
    BUILD: ['BUILD_FAILED'],
    CONTRACT: ['WORK_CONTRACT_BLOCKED'],
    ...commonTailStages(),
  },
  /**
   * 媒体生成三种类型共享同一套供应商错误形状。M2b 之前不开放创建 operation，但
   * domain 侧的状态与错误集合是完整的 —— 附录 A §5.4「不留半个 TaskKind」。
   */
  BAILIAN_IMAGE: {
    AUTH: ['BAILIAN_CREDENTIAL_NOT_CONFIGURED', 'BAILIAN_CREDENTIAL_INVALID'],
    QUOTA: ['BAILIAN_QUOTA_EXHAUSTED'],
    TRANSPORT: ['BAILIAN_UNREACHABLE'],
    ...commonTailStages(),
  },
  TTS: {
    AUTH: ['BAILIAN_CREDENTIAL_NOT_CONFIGURED', 'BAILIAN_CREDENTIAL_INVALID'],
    QUOTA: ['BAILIAN_QUOTA_EXHAUSTED'],
    TRANSPORT: ['BAILIAN_UNREACHABLE'],
    ...commonTailStages(),
  },
  STT: {
    AUTH: ['BAILIAN_CREDENTIAL_NOT_CONFIGURED', 'BAILIAN_CREDENTIAL_INVALID'],
    QUOTA: ['BAILIAN_QUOTA_EXHAUSTED'],
    TRANSPORT: ['BAILIAN_UNREACHABLE'],
    ...commonTailStages(),
  },
};

/** 某一类任务可能出现的全部错误码，去重升序（派生集合，语义无序）。 */
export function taskErrorCodes(kind: TaskKind): readonly ErrorCode[] {
  const stages = taskErrorRegistry[kind];
  const codes = new Set<ErrorCode>();
  for (const stage of TASK_STAGES) {
    for (const code of stages[stage] ?? []) codes.add(code);
  }
  return [...codes].sort();
}

/** 登记表里出现过的全部异步错误码，去重升序。 */
export function registeredAsyncErrorCodes(): readonly ErrorCode[] {
  const codes = new Set<ErrorCode>();
  for (const kind of TASK_KINDS) {
    for (const code of taskErrorCodes(kind)) codes.add(code);
  }
  return [...codes].sort();
}

/**
 * 登记表自检。类型系统已经保证了键是合法的 `TaskKind` / `TaskStage`、值是合法的
 * `ErrorCode`，所以这里只查类型查不出来的东西：**每一类任务都至少登记了一个阶段**。
 *
 * `Partial<Record<…>>` 允许一个空对象通过编译，那正好是「留了半个 TaskKind」的形态。
 */
export function assertTaskErrorRegistryComplete(
  registry: TaskErrorRegistry = taskErrorRegistry,
): void {
  for (const kind of TASK_KINDS) {
    const stages = registry[kind];
    const registered = TASK_STAGES.filter((stage) => (stages[stage] ?? []).length > 0);
    if (registered.length === 0) throw new Error(`task error registry is empty for kind: ${kind}`);
    for (const stage of registered) {
      for (const code of stages[stage] ?? []) {
        if (!isErrorCode(code))
          throw new Error(`unknown error code in task registry: ${kind}/${stage}/${code}`);
      }
    }
  }
}

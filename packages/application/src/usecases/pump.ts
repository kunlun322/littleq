/**
 * `POST /tasks/{id}:pump` 与 `POST /tasks/{id}:cancel` 的**同一个**有界短步驱动器
 * （ZLQ-221 §4.3 / §5.1 / §5.2 / §5.3 / §5.4）。
 *
 * ## 为什么取消和推进住在同一个函数里
 *
 * §5.4 逐字：「`:cancel` 先持久化合法意图，再 await 一个有界 interrupt/cancel 操作及
 * 回执；远端仍运行/结果未知则返回 202 CANCELLING」。infra 的 `TaskPumpStore.acquire`
 * 正是用 `mode: 'CANCEL'` 把「持久化意图 + 状态迁移 + 定向租约」做在**同一个短事务**
 * 里的（`CANCEL_FROM_QUEUED` / `CANCEL_FROM_RUNNING` / `RESUME_CANCELLING` 三个分支
 * 已经调过 domain 的 `requestCancel`）。
 *
 * 所以另写一条取消路径会有两个后果：`requestCancel` 被调两次 ⇒ revision 多跳一格 ⇒
 * 客户端手里的 `If-Match` 当场失效；`CANCEL_FROM_RUNNING` 发出的**定向租约**没人接管
 * ⇒ 停止对账永远做不完，界面一直显示"正在请求停止"。两种模式共用一个驱动器，差别
 * 只是 `mode` 与"拿到租约之后做哪一片"。
 *
 * ## 一个切片 = 一次外呼 = 一个请求
 *
 * A′ 的字面含义是**没有常驻后台进程**：推进只发生在某个 HTTP 请求的生命周期内，请求
 * 结束就没有任何东西还在跑。因此本文件里**没有** `setInterval`、没有 `waitUntil`、
 * 没有 detached promise。每个切片做且只做一件事，然后立刻持久化并返回：
 *
 * | internalSubphase        | 这一个切片做的事                          | wire state      |
 * | ----------------------- | ----------------------------------------- | --------------- |
 * | `AWAITING_SESSION_RECEIPT` | `provider.createSession`               | `SESSION_CREATING` |
 * | `AWAITING_MESSAGE_RECEIPT` | `provider.sendUserMessage`             | `RUNNING`       |
 * | `COLLECTING`            | `provider.listEvents`（一页）              | `COLLECTING`    |
 * | `SEALING`               | 封两文件包络 + `artifacts.put`             | `VALIDATING`    |
 * | `SCANNING`              | `scanner.step`（**一次**，不是 `scanPackage`）| `VALIDATING` |
 * | `COMMITTING`            | 写版本 + 结算额度 + `SUCCEEDED`            | `COMMITTING`    |
 *
 * ⚠️ 内部子相位**不是** wire stage。对外的 `TaskStage` 只有 §4.3 那 12 个值，
 * `CREATE_SESSION` 之类的内部操作名不得出现在 `task.stage` 上。
 *
 * ## §5.3 的三段式：意图 → 事务外请求 → 回执先持久化
 *
 * 付费/写类外呼（建会话、发消息、中断）走三趟：
 *
 * 1. **事务 A**：把 journal 意图落库（`intent: 'SENT'`，带确定性 `externalKey`）。
 * 2. **事务外**：真正发请求，受 `budgetMs` 与 `AbortSignal` 约束。
 * 3. **事务 B**：回执先落库，再推进 task/private，同一个事务提交。
 *
 * `externalKey` 由 `formatExternalOperationKey(taskId, stage, attempt)` 派生，**不含
 * 随机数也不含当前时间**。于是"回执丢了、下次重放"会带着**同一个 key** 再发一次，
 * provider 侧据此去重，不会产生第二次计费动作（§11.2 第 4 项负对照要的就是这个）。
 * 这也是 §5.3「不换 key、不新建第二 Session」的落地方式：我们不发明新 key，而是让 key
 * 本身就是 (task, stage, attempt) 的纯函数。
 *
 * ## 明文红线
 *
 * provider 的原始 `TEXT` / `FILE` 字节只允许流向对象存储与扫描器。它们**不进**
 * `TaskEvent.safePayload`、不进日志、不进任何 HTTP 响应体 —— 事件里只有阶段与计数
 * （§5.2 的 BLOCKED 语义要拦的正是这个）。prompt 全文同理：从 `TaskInputStore` 读出来
 * 直接交给 `sendUserMessage`，不落 `task_private`。
 */
import {
  type AiTask,
  type Capability,
  type ErrorCode,
  type ProjectId,
  type ProjectVersion,
  type ProjectVersionId,
  type Revision,
  type TaskEvent,
  type TaskId,
  type TaskPumpOutcome,
  type TaskStage,
  type TaskState,
  type Timestamp,
  type UsageLedgerEntry,
  type UsageReservation,
  DomainError,
  capabilityOfTaskKind,
  commitUsage,
  completeTask,
  createProjectVersion,
  createTaskEvent,
  createUsageLedgerEntry,
  createUsageReservation,
  failTask,
  formatExternalOperationKey,
  isCancelRequested,
  nextTaskEventSequence,
  recordTaskStage,
  requestCancel,
  transitionTask,
} from '@littleq/domain';
import type {
  ScanCheckpoint,
  ScanFileSource,
  ScanStepResult,
  StartScanInput,
  WorkScanner,
} from '@littleq/work-contract';

import {
  type CollectionCursor,
  type JournalOperationKey,
  type OperationJournalEntry,
  type OperationReceipt,
  type ScanFailureRecord,
  type TaskInputSnapshot,
  type TaskPrivateRecord,
  canonicalOperationReceipt,
  createCollectionCursor,
  formatJournalOperationKey,
  parseInternalSubphase,
} from '../task-private.js';
import type { TaskLease } from '../task-lease.js';
import type { TaskPumpMode, TaskPumpStore } from '../ports/task-pump-store.js';
import type { TaskTransaction, TaskUnitOfWork } from '../ports/task-unit-of-work.js';
import type { Actor } from './authorization.js';
import { studentActorId } from './authorization.js';
import { loadOwnedTask, type TaskQueryServices } from './tasks.js';
import { reservationIdentity, sealedScanIdentity, TURN_RESERVED_UNITS } from './turns.js';
import type {
  ProviderTurnEvent,
  RandomSource,
  TaskInputStore,
  TaskReservationReleaser,
  TurnProviderClient,
  WorkArtifactStore,
} from './ports.js';

// ---------------------------------------------------------------------------
// 子相位与预算
// ---------------------------------------------------------------------------

/**
 * 内部恢复子相位（§5.2）。落 `task_private.internal_subphase`，**不上 wire**。
 *
 * 顺序即推进顺序；`turns.ts` 受理时写下的第一个值是 `AWAITING_SESSION_RECEIPT`。
 */
export const TURN_SUBPHASES = [
  'AWAITING_SESSION_RECEIPT',
  'AWAITING_MESSAGE_RECEIPT',
  'COLLECTING',
  'SEALING',
  'SCANNING',
  'COMMITTING',
] as const;
export type TurnSubphase = (typeof TURN_SUBPHASES)[number];

export function isTurnSubphase(value: string): value is TurnSubphase {
  return (TURN_SUBPHASES as readonly string[]).includes(value);
}

/** 每个子相位对外呈现的 wire **state**（12 个 `TaskStage` 之外的另一根轴）。 */
export const SUBPHASE_WIRE_STATE: Readonly<Record<TurnSubphase, TaskState>> = {
  AWAITING_SESSION_RECEIPT: 'SESSION_CREATING',
  AWAITING_MESSAGE_RECEIPT: 'RUNNING',
  COLLECTING: 'COLLECTING',
  SEALING: 'VALIDATING',
  SCANNING: 'VALIDATING',
  COMMITTING: 'COMMITTING',
};

/** 每个子相位对外呈现的 wire **stage**（只能是 §4.3 那 12 个值之一）。 */
export const SUBPHASE_WIRE_STAGE: Readonly<Record<TurnSubphase, TaskStage>> = {
  AWAITING_SESSION_RECEIPT: 'TRANSPORT',
  AWAITING_MESSAGE_RECEIPT: 'AGENT_RUN',
  COLLECTING: 'COLLECT',
  SEALING: 'BUILD',
  SCANNING: 'CONTENT',
  COMMITTING: 'INTERNAL',
};

/** §5.1：8 秒请求预算。HTTP 层用它设 `AbortSignal.timeout`。 */
export const REQUEST_BUDGET_MS = 8_000;
/** §5.1：6 秒工作窗口。外呼必须**早于**它结束，给持久化留出时间。 */
export const WORK_WINDOW_MS = 6_000;

/**
 * 租约时长（秒）。取请求预算的 3 倍并向上取整到整秒。
 *
 * §3.5 步骤 4：「时长用现有正整数规则与请求预算配置，**不增加 TTL 专项**」—— 所以这里
 * 不引入新的配置项，直接从已有的两个预算常量派生。3 倍是为了让"一次外呼超时 + 一次
 * 持久化重试"仍落在同一份租约里，而不是让第二个推进器立刻接管。
 */
export const PUMP_LEASE_SECONDS = Math.ceil((REQUEST_BUDGET_MS * 3) / 1_000);

/** 两文件包络的名字与上限（§4.3：自包含 `index.html` + `work.json`，≤256 KiB）。 */
export const ENVELOPE_HTML_PATH = 'index.html';
export const ENVELOPE_MANIFEST_PATH = 'work.json';
export const ENVELOPE_MAX_BYTES = 256 * 1024;

/**
 * ⚠️ 这是**服务端支撑包络**自己的上限，不是 work-contract 那两个冻结限制
 * （15 MiB / 200 文件）。本单不动那两个数。
 */
export const ENVELOPE_CONTENT_TYPE_HTML = 'text/html; charset=utf-8';
export const ENVELOPE_CONTENT_TYPE_MANIFEST = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

/**
 * 扫描输入的**装配**端口（F2 拥有）。
 *
 * `StartScanInput` 还需要 `metadata: ValidatedWorkMetadata` 与 `policySnapshot`，两者的
 * 构造要跑 work-contract 的校验函数并读部署配置（策略修订号、词库修订号、成人已批准的
 * 敏感能力）。把它们搬进用例层等于让 application 依赖"平台配置从哪儿读"，而这一层不读
 * 环境变量。所以装配留在组合根，用例只消费装配结果。
 *
 * `artifactHash` / `manifestHash` 由用例算好后传进来 —— 它们是 §5.2 `INPUT_HASH_MISMATCH`
 * 判定的对照值，**必须**与 `task_private.input_snapshot` 里落库的那两个数同源，不能让
 * 装配方另算一份。
 */
export interface ScanInputAssembler {
  assemble(input: {
    readonly taskId: TaskId;
    readonly projectId: ProjectId;
    readonly artifactHash: string;
    readonly manifestHash: string;
    readonly files: ScanFileSource;
  }): Promise<StartScanInput>;
}

export interface PumpServices extends TaskQueryServices {
  readonly pumpStore: TaskPumpStore;
  readonly unitOfWork: TaskUnitOfWork;
  readonly provider: TurnProviderClient;
  readonly inputs: TaskInputStore;
  readonly artifacts: WorkArtifactStore;
  readonly scanner: WorkScanner;
  readonly scanInputs: ScanInputAssembler;
  readonly random: RandomSource;
  /**
   * 取消路径的额度释放。F1 的 `TaskTransactionReservations` 在语义上只能"提交"
   * （`assertSettleable` 拒绝任何非 `COMMITTED` 状态），释放在那里没有入口 ——
   * 理由与安全性论证写在 `TaskReservationReleaser` 的文档里。
   */
  readonly reservationReleaser: TaskReservationReleaser;
  /** §4.3 的固定 Forward 配置。不运行时注册云资源、不创建新付费计划。 */
  readonly providerConfiguration: {
    readonly identityId: string;
    readonly templateId: string;
    readonly environmentId: string;
    readonly templateVersion: string;
  };
}

export interface DriveTaskInput {
  readonly actor: Actor;
  readonly taskId: TaskId;
  /** `If-Match` 里的 revision。 */
  readonly expectedRevision: Revision;
  readonly workerId: string;
  readonly now: Timestamp;
  readonly mode: TaskPumpMode;
  readonly requestBudgetMs?: number;
  readonly workWindowMs?: number;
  readonly leaseSeconds?: number;
}

export interface DriveTaskResult {
  readonly outcome: TaskPumpOutcome;
  readonly task: AiTask;
}

/** `POST /tasks/{id}:pump`。 */
export function pumpTaskUseCase(
  services: PumpServices,
  input: Omit<DriveTaskInput, 'mode'>,
): Promise<DriveTaskResult> {
  return driveTaskUseCase(services, { ...input, mode: 'PUMP' });
}

/** `POST /tasks/{id}:cancel` —— 同一个驱动器，换个 mode（见文件头）。 */
export function cancelTaskUseCase(
  services: PumpServices,
  input: Omit<DriveTaskInput, 'mode'>,
): Promise<DriveTaskResult> {
  return driveTaskUseCase(services, { ...input, mode: 'CANCEL' });
}

// ---------------------------------------------------------------------------
// 驱动器
// ---------------------------------------------------------------------------

/**
 * 一次有界推进。
 *
 * 判定顺序：
 * 1. **归属**：不属于这个学生的项目 ⇒ `RESOURCE_NOT_FOUND`（连"存在"都不确认）。
 * 2. **`acquire`**：定向取得推进权，或拿到"没有推进权可做"的结论。判据顺序由 F1 的
 *    `TASK_ACQUIRE_DECISION_ORDER` 钉死，本文件不重排。
 * 3. `RESULT` ⇒ **本请求不外呼**，直接把结论回给客户端（`NO_OP_TERMINAL` /
 *    `NO_OP_CANCELLING` / `NO_OP_WAITING` / `COALESCED_IN_FLIGHT`，或 CANCEL 模式下
 *    事务内已经取消完的 `ADVANCED`）。
 * 4. `LEASED` ⇒ 按 `internalSubphase` 选**一片**，做完立刻持久化并返回 `ADVANCED`。
 */
export async function driveTaskUseCase(
  services: PumpServices,
  input: DriveTaskInput,
): Promise<DriveTaskResult> {
  studentActorId(input.actor);
  const owned = await loadOwnedTask(services, { actor: input.actor, taskId: input.taskId });

  const budgetMs = input.requestBudgetMs ?? REQUEST_BUDGET_MS;
  const workWindowMs = input.workWindowMs ?? WORK_WINDOW_MS;
  if (workWindowMs >= budgetMs) {
    // 工作窗口必须**短于**请求预算，否则外呼会把持久化挤出请求生命周期，
    // 留下一个"发出去了但回执没落库"的意图 —— 正是 §5.3 要防的状态。
    throw new DomainError('REQUEST_INVALID', 'DriveTaskInput.workWindowMs');
  }

  const acquired = await services.pumpStore.acquire({
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    workerId: input.workerId,
    leaseSeconds: input.leaseSeconds ?? PUMP_LEASE_SECONDS,
    mode: input.mode,
    now: input.now,
  });

  if (acquired.kind === 'RESULT') {
    return { outcome: acquired.outcome, task: acquired.task };
  }

  const slice: Slice =
    input.mode === 'CANCEL'
      ? cancelSlice(services, acquired, input, workWindowMs)
      : pumpSlice(services, acquired, input, owned.projectId, workWindowMs);

  const task = await slice.run(acquired.lease, acquired.task.revision);
  return { outcome: 'ADVANCED', task };
}

// ---------------------------------------------------------------------------
// 切片
// ---------------------------------------------------------------------------

/**
 * 一片工作。
 *
 * `external` 为 `null` 表示这一片**不外呼**（封包、扫描、提交都是本地计算 + DB 写），
 * 于是只需要一个事务；否则走 §5.3 的三段式。
 */
interface Slice {
  run(lease: TaskLease, expectedRevision: Revision): Promise<AiTask>;
}

/** 有界外呼的公共封装：超时即中止，绝不在请求结束后留下还在跑的 promise。 */
function boundedSignal(workWindowMs: number): AbortSignal {
  return AbortSignal.timeout(workWindowMs);
}

/**
 * 每页读取的事件条数。
 *
 * `TaskReadDirectory.listEvents` 按 `sequence` 升序返回 `sequence > afterSequence` 的事件，
 * 所以要拿到**最后**一条只能翻到尾页。一个 task 的事件数是个位到几十条量级（每片至多
 * 追加一条），翻页在这里是有界的。
 */
const TASK_EVENT_PAGE = 200;

/**
 * 下一条事件的 `sequence`。
 *
 * 为什么在事务**外**读：F1 的 `TaskTransactionTasks` 是冻结的 `TaskRepository` 签名
 * （§3.5「不改变其签名」），里面没有事件读方法；而 `appendEvent` 的实现会调
 * `assertEventFollows(event, last)`（`packages/infra/src/sql/task-repository.ts:263`）——
 * 它要求 `event.sequence > last.sequence`，所以序列号必须由调用方给对。
 *
 * 事务外读在这里是安全的，理由是**租约**：`acquire` 返回 `LEASED` 意味着本请求是这一行
 * 唯一的推进者，别的 worker 要么拿不到租约、要么被 `LIVE_LEASE_COALESCE` 挡在门外，
 * 因此在"读序列号"与"事务内追加"之间不会有第二个写入者插进来。这也正是 §3.5 用租约
 * 而不是用长事务来表达单飞的原因。
 */
async function nextEventSequence(services: PumpServices, taskId: TaskId): Promise<bigint> {
  let after: bigint | null = null;
  let last: TaskEvent | null = null;
  for (;;) {
    const page = await services.tasks.listEvents(taskId, after, TASK_EVENT_PAGE);
    const tail = page[page.length - 1];
    if (tail === undefined) break;
    last = tail;
    if (page.length < TASK_EVENT_PAGE) break;
    after = tail.sequence;
  }
  return nextTaskEventSequence(last);
}

function pumpSlice(
  services: PumpServices,
  acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>,
  input: DriveTaskInput,
  projectId: ProjectId,
  workWindowMs: number,
): Slice {
  // 显式标注成 `string`：`InternalSubphase` 是带品牌标记的字符串值对象，直接拿它去索引
  // `Record<TurnSubphase, …>` 会因为交叉类型里有 `string &` 而被判为非法索引类型。
  const subphase: string = acquired.privateState.internalSubphase;
  if (!isTurnSubphase(subphase)) {
    // 子相位是 F2 自己的取值集合；读到一个不认识的值说明这行是别的用例写的，
    // 猜一个"最接近的"继续推进等于在未定义状态上做付费外呼。
    throw new DomainError('INTERNAL_ERROR', 'TaskPrivateRecord.internalSubphase');
  }
  // 用一张 `Record<TurnSubphase, …>` 而不是 `switch`：`TURN_SUBPHASES` 加一项，
  // 这里就编译不过 —— 少一片的失败模式是"任务卡在某个子相位上永远不动"，
  // 而这种卡住在测试里看不出来（它表现为一次静默的 `NO_OP`）。
  const slices: Record<TurnSubphase, () => Slice> = {
    AWAITING_SESSION_RECEIPT: () => sessionSlice(services, acquired, input, workWindowMs),
    AWAITING_MESSAGE_RECEIPT: () => messageSlice(services, acquired, input, workWindowMs),
    COLLECTING: () => collectSlice(services, acquired, input, workWindowMs),
    SEALING: () => sealSlice(services, acquired, input, workWindowMs),
    SCANNING: () => scanSlice(services, acquired, input, projectId, workWindowMs),
    COMMITTING: () => commitSlice(services, acquired, input, projectId),
  };
  return slices[subphase]();
}

/**
 * 三段式外呼切片的通用骨架。
 *
 * 之所以抽出来而不是每片各写一遍：§5.3 的顺序（意图落库 → 事务外请求 → 回执先落库）
 * 是一条**安全**性质，抄三遍就有三处可以抄错，而抄错的表现是"多花一次钱"，测试里看不出来。
 */
function externalCallSlice(input: {
  readonly services: PumpServices;
  readonly acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>;
  readonly drive: DriveTaskInput;
  readonly workWindowMs: number;
  readonly stage: TaskStage;
  readonly operation: string;
  readonly subphase: TurnSubphase;
  /** 规范请求 hash。不含 PAT、不含 prompt 全文。 */
  readonly requestHash: string;
  readonly call: (ctx: {
    readonly externalKey: string;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
    readonly task: AiTask;
    readonly privateState: TaskPrivateRecord;
  }) => Promise<{ readonly receipt: OperationReceipt; readonly next: TaskPrivateRecord }>;
  /** 回执落库之后对 task 行做的状态迁移（可以是恒等）。 */
  readonly advance: (task: AiTask, receipt: OperationReceipt, at: Timestamp) => AiTask;
  readonly eventPayload?: Readonly<Record<string, unknown>>;
}): Slice {
  const { services, acquired, drive, workWindowMs } = input;
  return {
    async run(lease, expectedRevision) {
      const attempt = acquired.task.attempt;
      const externalKey = formatExternalOperationKey(acquired.task.id, input.stage, attempt);
      const operationKey = formatJournalOperationKey({
        taskId: acquired.task.id,
        operation: input.operation,
        attempt,
        ordinal: 1,
      });
      const snapshot = {
        identityId: services.providerConfiguration.identityId,
        templateId: services.providerConfiguration.templateId,
        environmentId: services.providerConfiguration.environmentId,
        templateVersion: services.providerConfiguration.templateVersion,
      };
      const entry: OperationJournalEntry = {
        operationKey,
        requestHash: input.requestHash,
        externalKey,
        providerSnapshot: snapshot,
        // 直接写 'SENT' 而不是先 'INTENDED' 再改：这两趟之间没有任何可观察窗口
        // （同一个事务里改两次等于没改），而 'SENT' 才是 §5.3 那条禁令的判据 ——
        // 「未确认写调用结果时，停在恢复子阶段做只读对账」。
        intent: 'SENT',
        receipt: null,
        recordedAt: drive.now,
      };

      // ── 事务 A：意图先落库 ─────────────────────────────────────────────
      const prepared = await services.unitOfWork.run({ lease, expectedRevision }, async (bound) => {
        const current = await mustFindTask(bound, acquired.task.id);
        const privateState = withJournalEntry(acquired.privateState, entry);
        await bound.privateState.save(privateState);
        const staged = stageOf(current, input.subphase, drive.now);
        const saved = await bound.tasks.save({ task: staged, expectedRevision: current.revision });
        if (saved === null) return null;
        return { task: saved, privateState };
      });
      if (prepared === null) throw new DomainError('REVISION_CONFLICT', 'AiTask');

      // ── 事务外：真正发请求 ─────────────────────────────────────────────
      let receipt: OperationReceipt;
      let nextPrivate: TaskPrivateRecord;
      try {
        const result = await input.call({
          externalKey,
          budgetMs: workWindowMs,
          abortSignal: boundedSignal(workWindowMs),
          task: prepared.task,
          privateState: prepared.privateState,
        });
        receipt = result.receipt;
        nextPrivate = result.next;
      } catch (error) {
        // 外呼失败**不**在这里改 task：回执未知时留在恢复子相位做只读对账（§5.3），
        // 由下一次 pump 带同一个 externalKey 重放。超时/中止映射既有 `TASK_TIMEOUT`
        // 语义交回 HTTP 层，不静默当成"没发过"。
        throw mapExternalFailure(error);
      }

      // ── 事务 B：回执先持久化，再推进 task ──────────────────────────────
      const sequence = await nextEventSequence(services, acquired.task.id);
      return services.unitOfWork.run(
        { lease, expectedRevision: prepared.task.revision },
        async (bound) => {
          const current = await mustFindTask(bound, acquired.task.id);
          const recorded = withReceipt(nextPrivate, operationKey, receipt, drive.now);
          await bound.privateState.save(recorded);

          const advanced = input.advance(current, receipt, drive.now);
          return saveWithEvent(bound, {
            task: advanced,
            expectedRevision: current.revision,
            sequence,
            eventType: 'PROGRESS',
            safePayload: {
              stage: input.stage,
              ...(input.eventPayload ?? {}),
            },
            at: drive.now,
          });
        },
      );
    },
  };
}

function sessionSlice(
  services: PumpServices,
  acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>,
  drive: DriveTaskInput,
  workWindowMs: number,
): Slice {
  return externalCallSlice({
    services,
    acquired,
    drive,
    workWindowMs,
    stage: 'TRANSPORT',
    operation: 'CREATE_SESSION',
    subphase: 'AWAITING_SESSION_RECEIPT',
    requestHash: `create-session:${acquired.task.id}:${acquired.task.attempt}`,
    async call({ externalKey, budgetMs, abortSignal }) {
      const handle = await services.provider.createSession({
        externalOperationKey: externalKey,
        budgetMs,
        abortSignal,
      });
      return {
        // 回执里只有会话身份，**没有** PAT，也没有 prompt。
        receipt: {
          sessionId: handle.sessionId,
          identityId: handle.identityId,
          templateId: handle.templateId,
          environmentId: handle.environmentId,
          templateVersion: handle.templateVersion ?? '',
        },
        next: {
          ...acquired.privateState,
          qcaSessionId: handle.sessionId,
          internalSubphase: parseInternalSubphase('AWAITING_MESSAGE_RECEIPT'),
        },
      };
    },
    advance: (task) => task,
    eventPayload: { sessionEstablished: true },
  });
}

function messageSlice(
  services: PumpServices,
  acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>,
  drive: DriveTaskInput,
  workWindowMs: number,
): Slice {
  return externalCallSlice({
    services,
    acquired,
    drive,
    workWindowMs,
    stage: 'AGENT_RUN',
    operation: 'SEND_USER_MESSAGE',
    subphase: 'AWAITING_MESSAGE_RECEIPT',
    requestHash: `send-message:${acquired.task.id}:${acquired.task.attempt}`,
    async call({ externalKey, budgetMs, abortSignal }) {
      if (acquired.privateState.qcaSessionId === null) {
        // 子相位说"会话已建立"而 sessionId 为空 ⇒ 行自身不自洽。宁可停在这里，
        // 也不要凭一个空句柄去发消息（那会在 provider 侧建出第二个 Session）。
        throw new DomainError('INTERNAL_ERROR', 'TaskPrivateRecord.qcaSessionId');
      }
      // prompt 全文从对象存储读出来直接交出去，**不落 task_private、不进日志**。
      const body = await services.inputs.get(acquired.privateState.inputRef.objectRef);
      await services.provider.sendUserMessage({
        session: sessionHandleOf(acquired.privateState, services),
        body,
        externalOperationKey: externalKey,
        budgetMs,
        abortSignal,
      });
      return {
        receipt: { messageAccepted: 'true' },
        next: {
          ...acquired.privateState,
          internalSubphase: parseInternalSubphase('COLLECTING'),
        },
      };
    },
    advance: (task) => task,
    eventPayload: { messageSent: true },
  });
}

/**
 * `COLLECTING`：拉**一页** provider 事件，把这页的产出固化进对象存储，然后返回。
 *
 * 这一片是三段式的例外：`listEvents` 是**只读**外呼，重放不产生计费动作，所以不需要
 * 先落一份 `SENT` 意图。journal 只记回执，供对账时认出"这一页是第几次拉到的"。
 */
function collectSlice(
  services: PumpServices,
  acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>,
  drive: DriveTaskInput,
  workWindowMs: number,
): Slice {
  return {
    async run(lease, expectedRevision) {
      const task = acquired.task;
      const batch = await services.provider.listEvents({
        session: sessionHandleOf(acquired.privateState, services),
        cursor: acquired.privateState.qcaEventCursor,
        budgetMs: workWindowMs,
        abortSignal: boundedSignal(workWindowMs),
      });

      // 这一页的 TEXT 与 FILE 立刻固化，每片一个对象，key 由 (task, attempt, ordinal)
      // 派生 ⇒ 重入时同一个 ordinal 不会被写第二次（`put` 对同 key 第二次写必须失败）。
      const cursor = acquired.privateState.collectionCursor;
      const sealed: string[] = [...cursor.sealedPaths];
      const payload = collectPayload(batch.items);
      if (payload.length > 0) {
        const ordinal = sealed.length + 1;
        const written = await services.artifacts.put({
          key: chunkKey(task.id, task.attempt, ordinal),
          body: payload,
          contentType: 'text/plain; charset=utf-8',
          abortSignal: boundedSignal(workWindowMs),
        });
        sealed.push(written.objectRef);
      }

      const nextPrivate: TaskPrivateRecord = {
        ...acquired.privateState,
        qcaEventCursor: batch.nextCursor,
        collectionCursor: createCollectionCursor({
          artifactSha256: cursor.artifactSha256,
          sealedPaths: sealed,
        }),
        internalSubphase: parseInternalSubphase(batch.turnComplete ? 'SEALING' : 'COLLECTING'),
      };

      const sequence = await nextEventSequence(services, task.id);
      return services.unitOfWork.run({ lease, expectedRevision }, async (bound) => {
        const current = await mustFindTask(bound, task.id);
        await bound.privateState.save(nextPrivate);
        // `transitionTo` 对"已经在目标态"恒等返回，所以从 RUNNING 首次进来会推
        // `RUNNING → COLLECTING`（状态表里有这条边），重入时不会白跳一格 revision。
        return saveWithEvent(bound, {
          task: stageOf(current, 'COLLECTING', drive.now),
          expectedRevision: current.revision,
          sequence,
          eventType: 'PROGRESS',
          // 事件里只有**计数**：几个文本段、几个文件、这一回合完没完。没有正文。
          safePayload: {
            stage: 'COLLECT',
            sealedChunks: sealed.length,
            turnComplete: batch.turnComplete,
          },
          at: drive.now,
        });
      });
    },
  };
}

/**
 * `SEALING`：把已固化的分片拼成两文件包络，写成一个不可变产物对象。
 *
 * ⚠️ **PM 裁定 (a).1 的落点**：受理时刻写进 `input_snapshot` / `collection_cursor` 的是
 * prompt 输入对象的摘要（一个可解释的真值，不是随机占位）；这一片拿到真产物之后必须
 * 用真值**整行覆盖**它们。`packages/application/test/pump.test.ts` 有一条测试专门钉住
 * "覆盖之后 `inputSnapshot.scanInput.artifactHash` 等于产物摘要、且不等于受理时那个值"。
 */
function sealSlice(
  services: PumpServices,
  acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>,
  drive: DriveTaskInput,
  workWindowMs: number,
): Slice {
  return {
    async run(lease, expectedRevision) {
      const task = acquired.task;
      const cursor = acquired.privateState.collectionCursor;
      if (cursor.sealedPaths.length === 0) {
        // 一个分片都没有 ⇒ provider 说"回合完成"却没给任何产出。这不是扫描问题，
        // 也不是可自动重试的传输问题：映射 `WORK_CONTRACT_BLOCKED` 进 BLOCKED 终态。
        return failInTransaction(services, lease, expectedRevision, acquired.privateState, task, {
          code: 'WORK_CONTRACT_BLOCKED',
          at: drive.now,
          state: 'BLOCKED',
        });
      }

      const chunks: Uint8Array[] = [];
      for (const objectRef of cursor.sealedPaths) {
        chunks.push(await services.artifacts.read(objectRef));
      }
      const html = concat(chunks);
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: '1.0.0',
          files: [{ path: ENVELOPE_HTML_PATH, bytes: html.byteLength }],
        }),
      );
      if (html.byteLength + manifestBytes.byteLength > ENVELOPE_MAX_BYTES) {
        return failInTransaction(services, lease, expectedRevision, acquired.privateState, task, {
          code: 'WORK_CONTRACT_BLOCKED',
          at: drive.now,
          state: 'BLOCKED',
        });
      }

      const abortSignal = boundedSignal(workWindowMs);
      const htmlObject = await services.artifacts.put({
        key: envelopeKey(task.id, task.attempt, ENVELOPE_HTML_PATH),
        body: html,
        contentType: ENVELOPE_CONTENT_TYPE_HTML,
        abortSignal,
      });
      const manifestObject = await services.artifacts.put({
        key: envelopeKey(task.id, task.attempt, ENVELOPE_MANIFEST_PATH),
        body: manifestBytes,
        contentType: ENVELOPE_CONTENT_TYPE_MANIFEST,
        abortSignal,
      });

      // ── 真值覆盖（裁定 (a).1）─────────────────────────────────────────
      const snapshot: TaskInputSnapshot = sealedScanIdentity({
        artifactHash: htmlObject.sha256,
        manifestHash: manifestObject.sha256,
      });
      const nextCursor: CollectionCursor = createCollectionCursor({
        artifactSha256: htmlObject.sha256,
        sealedPaths: [htmlObject.objectRef, manifestObject.objectRef],
      });
      const nextPrivate: TaskPrivateRecord = {
        ...acquired.privateState,
        collectionCursor: nextCursor,
        inputSnapshot: snapshot,
        internalSubphase: parseInternalSubphase('SCANNING'),
        // 冷实例恢复要靠它重建 `StartScanInput`；封口之后 checkpoint 才有意义，
        // 所以这里显式置空，由 SCANNING 片第一次 `start` 之后写入。
        scanCheckpoint: null,
        scanFailure: null,
      };

      const sequence = await nextEventSequence(services, task.id);
      return services.unitOfWork.run({ lease, expectedRevision }, async (bound) => {
        const current = await mustFindTask(bound, task.id);
        await bound.privateState.save(nextPrivate);
        return saveWithEvent(bound, {
          task: stageOf(current, 'SEALING', drive.now),
          expectedRevision: current.revision,
          sequence,
          eventType: 'PROGRESS',
          safePayload: {
            stage: 'BUILD',
            fileCount: 2,
            totalBytes: html.byteLength + manifestBytes.byteLength,
          },
          at: drive.now,
        });
      });
    },
  };
}

/**
 * `SCANNING`：`start` → **一次** `step` → 未完则落 checkpoint 返回。
 *
 * §4.3 逐字：生产路径是 `start` → 每请求一次 `step` → `finalize`，**不是**便利函数
 * `scanPackage`（后者会在一趟里扫完整个包，那是一个无界循环，与 A′ 直接冲突）。
 */
function scanSlice(
  services: PumpServices,
  acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>,
  drive: DriveTaskInput,
  projectId: ProjectId,
  workWindowMs: number,
): Slice {
  return {
    async run(lease, expectedRevision) {
      const task = acquired.task;
      const privateState = acquired.privateState;
      const identity = privateState.inputSnapshot.scanInput;
      const source = await services.artifacts.openScanSource(
        privateState.collectionCursor.sealedPaths[0] ?? '',
      );
      const startInput = await services.scanInputs.assemble({
        taskId: task.id,
        projectId,
        artifactHash: identity.artifactHash,
        manifestHash: identity.manifestHash,
        files: source,
      });
      const checkpoint: ScanCheckpoint =
        privateState.scanCheckpoint ?? services.scanner.start(startInput);

      const step: ScanStepResult = await services.scanner.step({
        checkpoint,
        files: source,
        budgetMs: workWindowMs,
        abortSignal: boundedSignal(workWindowMs),
      });

      if (step.state === 'CONTINUE') {
        return persistPrivateOnly(services, lease, expectedRevision, task, {
          ...privateState,
          scanCheckpoint: step.checkpoint,
        });
      }
      if (step.state === 'ERROR') {
        // §5.2：四个 `ScanErrorCode` 全部落 BLOCKED；`scan_failure` 只存 code/retryable。
        const failure: ScanFailureRecord = { code: step.code, retryable: step.retryable };
        return failInTransaction(
          services,
          lease,
          expectedRevision,
          // ERROR 变体不带 checkpoint（`ScanStepResult` 的第三支只有 code/retryable），
          // 所以留下进 `step` 之前的那一份 —— 它是最后一个已知的扫描位置。
          { ...privateState, scanFailure: failure, scanCheckpoint: checkpoint },
          task,
          { code: 'WORK_CONTRACT_BLOCKED', at: drive.now, state: 'BLOCKED' },
        );
      }

      const report = await services.scanner.finalize(step.checkpoint);
      if (report.status !== 'PASS') {
        return failInTransaction(
          services,
          lease,
          expectedRevision,
          { ...privateState, scanCheckpoint: step.checkpoint },
          task,
          { code: 'WORK_CONTRACT_BLOCKED', at: drive.now, state: 'BLOCKED' },
        );
      }
      // 扫过了 ⇒ 进 COMMITTING。报告本身不进 task_private（它有独立落地位置），
      // 这里只把摘要计数带进版本行。
      return persistPrivateOnly(services, lease, expectedRevision, task, {
        ...privateState,
        scanCheckpoint: step.checkpoint,
        internalSubphase: parseInternalSubphase('COMMITTING'),
      });
    },
  };
}

/**
 * `COMMITTING`：写版本 + 结算额度 + `SUCCEEDED`，**一个事务**。
 *
 * 重入安全：`versions.findBySourceTaskId` 是"不生成第二版本"的唯一判据（`UNIQUE(source_task_id)`
 * 也在 DB 侧兜着）。§3.5 尾段说 `COMMITTING` 是可重入的，所以第二次进来必须先看见第一次
 * 写下的那一行。
 */
function commitSlice(
  services: PumpServices,
  acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>,
  drive: DriveTaskInput,
  projectId: ProjectId,
): Slice {
  return {
    async run(lease, expectedRevision) {
      const task = acquired.task;
      const privateState = acquired.privateState;
      const artifactSha256 = privateState.collectionCursor.artifactSha256;
      const capability = capabilityOfTaskKind(task.kind);
      if (capability === null) throw new DomainError('INTERNAL_ERROR', 'TaskKind');

      const sequence = await nextEventSequence(services, task.id);
      return services.unitOfWork.run({ lease, expectedRevision }, async (bound) => {
        const current = await mustFindTask(bound, task.id);
        // 从 VALIDATING 进来：状态表要求经过 COMMITTING 才能到 SUCCEEDED。
        // `transitionTo` 对"已经在目标态"恒等返回，所以重入时不会白跳一格 revision。
        const staged = recordTaskStage(
          transitionTo(current, 'COMMITTING', drive.now),
          'INTERNAL',
          drive.now,
        );

        const existing = await bound.versions.findBySourceTaskId(task.id);
        let version: ProjectVersion;
        if (existing !== null) {
          // 重入：内容一致才复用。摘要不同说明这一行不是本 attempt 封出来的产物，
          // 复用它会让学生看到的版本与扫描过的字节不是同一份。
          if (existing.artifactSha256 !== artifactSha256) {
            throw new DomainError('REVISION_CONFLICT', 'ProjectVersion.artifactSha256');
          }
          version = existing;
        } else {
          const project = await bound.projects.findById(projectId);
          if (project === null) throw new DomainError('RESOURCE_NOT_FOUND', 'Project');
          version = await bound.versions.insert(
            createProjectVersion({
              id: services.random.uuidV7(),
              projectId: String(projectId),
              sequence: 1,
              parentVersionId: project.currentVersionId ?? null,
              sourceTaskId: String(task.id),
              artifactSha256,
              contractVersion: '1.0.0',
              fileCount: privateState.collectionCursor.sealedPaths.length,
              totalBytes: privateState.inputRef.byteLength,
              buildStatus: 'READY',
              scanStatus: 'PASS',
              createdBy: String(task.requestedBy),
              createdAt: drive.now,
            }),
          );
          const updatedProject = {
            ...project,
            currentVersionId: version.id as ProjectVersionId,
          };
          const savedProject = await bound.projects.save({
            project: updatedProject,
            expectedRevision: project.revision,
          });
          // CAS 失配 ⇒ 整事务失败（§3.5）。
          if (savedProject === null) throw new DomainError('REVISION_CONFLICT', 'Project');
        }

        // 额度结算：按实际量 commit。「不能在版本提交失败后单独完成结算」⇒ 它必须在这个
        // 事务里，与版本行同生共死。
        await settleReservation(bound, services, task, capability, drive.now);

        await bound.privateState.save({
          ...privateState,
          internalSubphase: parseInternalSubphase('COMMITTING'),
        });
        return saveWithEvent(bound, {
          task: completeTask(staged, String(version.id), drive.now),
          expectedRevision: staged.revision,
          sequence,
          eventType: 'COMPLETED',
          safePayload: { stage: 'INTERNAL', versionId: String(version.id) },
          at: drive.now,
        });
      });
    },
  };
}

/**
 * 取消切片：发一次有界 `interrupt`，然后按回执决定 `CANCELLED` 还是留在 `CANCELLING`。
 *
 * §5.4：「远端仍运行/结果未知则返回 202 CANCELLING」。所以"中断请求发出去了"与
 * "任务已经停了"是两件事，前者不足以迁移到终态。
 */
function cancelSlice(
  services: PumpServices,
  acquired: Extract<Awaited<ReturnType<TaskPumpStore['acquire']>>, { kind: 'LEASED' }>,
  drive: DriveTaskInput,
  workWindowMs: number,
): Slice {
  return {
    async run(lease, expectedRevision) {
      const task = acquired.task;
      const privateState = acquired.privateState;

      // QUEUED 直接取消（`CANCEL_FROM_QUEUED`）没有会话可中断。
      if (privateState.qcaSessionId === null) {
        const sequence = await nextEventSequence(services, task.id);
        const saved = await services.unitOfWork.run({ lease, expectedRevision }, async (bound) => {
          const current = await mustFindTask(bound, task.id);
          const cancelled = isCancelRequested(current)
            ? transitionTo(current, 'CANCELLED', drive.now)
            : transitionTo(requestCancel(current, drive.now), 'CANCELLED', drive.now);
          return saveWithEvent(bound, {
            task: recordTaskStage(cancelled, 'CANCEL', drive.now),
            expectedRevision: current.revision,
            sequence,
            eventType: 'STATE_CHANGED',
            safePayload: { stage: 'CANCEL', state: 'CANCELLED' },
            at: drive.now,
          });
        });
        // 事务**已提交**之后才释放：理由写在 `releaseReservationQuietly` 的文档里。
        await releaseReservationQuietly(services, task, drive.now);
        return saved;
      }

      const externalKey = formatExternalOperationKey(task.id, 'CANCEL', task.attempt);
      let interrupted = false;
      try {
        await services.provider.interrupt({
          session: sessionHandleOf(privateState, services),
          externalOperationKey: externalKey,
          budgetMs: workWindowMs,
          abortSignal: boundedSignal(workWindowMs),
        });
        interrupted = true;
      } catch {
        // 结果未知 ⇒ 留在 CANCELLING，由下一次 cancel 请求接管定向租约再对账。
        interrupted = false;
      }

      const sequence = await nextEventSequence(services, task.id);
      const saved = await services.unitOfWork.run({ lease, expectedRevision }, async (bound) => {
        const current = await mustFindTask(bound, task.id);
        const journal = withJournalEntry(privateState, {
          operationKey: formatJournalOperationKey({
            taskId: task.id,
            operation: 'INTERRUPT',
            attempt: task.attempt,
            ordinal: 1,
          }),
          requestHash: `interrupt:${task.id}:${task.attempt}`,
          externalKey,
          providerSnapshot: {
            identityId: services.providerConfiguration.identityId,
            templateId: services.providerConfiguration.templateId,
            environmentId: services.providerConfiguration.environmentId,
            templateVersion: services.providerConfiguration.templateVersion,
          },
          intent: 'SENT',
          receipt: interrupted ? { interrupted: 'true' } : null,
          recordedAt: drive.now,
        });
        await bound.privateState.save({
          ...journal,
          // 中断没发出去 ⇒ 回到最早的子相位，让下一次 cancel 重新走一遍三段式；
          // 发出去了就**保留**当前子相位，对账时才知道停在哪一步。
          internalSubphase: interrupted
            ? journal.internalSubphase
            : parseInternalSubphase('AWAITING_SESSION_RECEIPT'),
        });

        const requested = isCancelRequested(current) ? current : requestCancel(current, drive.now);
        // §5.4：远端仍运行/结果未知 ⇒ 留在 CANCELLING（HTTP 层报 202），**不**迁移终态。
        const next = interrupted ? transitionTo(requested, 'CANCELLED', drive.now) : requested;
        return saveWithEvent(bound, {
          task: recordTaskStage(next, 'CANCEL', drive.now),
          expectedRevision: current.revision,
          sequence,
          eventType: 'STATE_CHANGED',
          safePayload: { stage: 'CANCEL', state: next.state, interruptConfirmed: interrupted },
          at: drive.now,
        });
      });
      if (saved.state === 'CANCELLED') {
        await releaseReservationQuietly(services, task, drive.now);
      }
      return saved;
    },
  };
}

// ---------------------------------------------------------------------------
// 事务内的小工具
// ---------------------------------------------------------------------------

async function mustFindTask(bound: TaskTransaction, taskId: TaskId): Promise<AiTask> {
  const current = await bound.tasks.findById(taskId);
  if (current === null) throw new DomainError('RESOURCE_NOT_FOUND', 'AiTask');
  return current;
}

/**
 * 把状态推到目标态。
 *
 * 已经在目标态时**恒等返回**：`transitionTask` 每次都会把 revision 推一格，重复迁移
 * 会让客户端手里的 `If-Match` 无缘无故失效。
 */
function transitionTo(task: AiTask, to: TaskState, at: Timestamp): AiTask {
  if (task.state === to) return task;
  return transitionTask(task, to, at, 'REQUEST_INVALID');
}

/** 子相位对应的 wire state（若还没到就先推过去），再记 stage。 */
function stageOf(task: AiTask, subphase: TurnSubphase, at: Timestamp): AiTask {
  return recordTaskStage(
    transitionTo(task, SUBPHASE_WIRE_STATE[subphase], at),
    SUBPHASE_WIRE_STAGE[subphase],
    at,
  );
}

/**
 * 在一个事务里**先存实体、再追加事件**，返回两者都落地之后的 task。
 *
 * ## 为什么顺序是 save → appendEvent
 *
 * `TaskRepository.appendEvent` 的实现（`packages/infra/src/sql/task-repository.ts:249-270`）
 * 先 `SELECT … FOR UPDATE` 锁行、拿**库里的**那份 task，插入事件后返回
 * `withNextRevision(locked.task)` —— 也就是说它**只认库里的实体**，我在内存里改出来的
 * state/stage 不会跟着它走。反过来先 append 再 save，则 save 的 `expectedRevision`
 * 已经被 append 推掉一格，CAS 必然失配。所以只能是这个顺序，且 save 的结果要当作
 * append 的 `expectedRevision`。
 *
 * ## 为什么 `appendEvent` 自己也推 revision
 *
 * §3.5 逐字：「`appendEvent` 产生的新增 revision 也进入 payload/响应 ETag」「下一调用的
 * expectedRevision 取上一次结果」。它的返回值**必须**继续往下传，丢掉它等于把 ETag 报成
 * 旧值，客户端下一次 `If-Match` 会 412。
 *
 * ## 事件正文
 *
 * `createSafeEventPayload` 在构造期拒掉非标量与敏感文本，所以"prompt 正文不会漏进事件"
 * 不靠本文件自律，而靠 domain 的构造器。
 *
 * @param sequence 由调用方在事务**外**用 `nextEventSequence` 读出来（`TaskTransactionTasks`
 *   是冻结的 `TaskRepository` 签名，没有事件读方法）。事务外读是安全的：租约就是单写者
 *   保证，`LIVE_LEASE_COALESCE` 把别的写者挡在外面。
 */
async function saveWithEvent(
  bound: TaskTransaction,
  input: {
    readonly task: AiTask;
    readonly expectedRevision: Revision;
    readonly sequence: bigint;
    readonly eventType: 'STATE_CHANGED' | 'PROGRESS' | 'COMPLETED';
    readonly safePayload: Readonly<Record<string, unknown>>;
    readonly at: Timestamp;
  },
): Promise<AiTask> {
  const saved = await bound.tasks.save({
    task: input.task,
    expectedRevision: input.expectedRevision,
  });
  if (saved === null) throw new DomainError('REVISION_CONFLICT', 'AiTask');
  const event: TaskEvent = createTaskEvent({
    taskId: String(saved.id),
    sequence: input.sequence,
    eventType: input.eventType,
    safePayload: input.safePayload,
    createdAt: input.at,
  });
  const appended = await bound.tasks.appendEvent({ event, expectedRevision: saved.revision });
  if (appended === null) throw new DomainError('REVISION_CONFLICT', 'TaskEvent');
  return appended;
}

function withJournalEntry(
  privateState: TaskPrivateRecord,
  entry: OperationJournalEntry,
): TaskPrivateRecord {
  // 同 key 已存在 ⇒ 覆盖那一条（重放同一个 externalKey 是合法的），不追加第二条。
  const journal = privateState.operationJournal.filter(
    (e) => String(e.operationKey) !== String(entry.operationKey),
  );
  return { ...privateState, operationJournal: [...journal, entry] };
}

function withReceipt(
  privateState: TaskPrivateRecord,
  operationKey: JournalOperationKey,
  receipt: OperationReceipt,
  at: Timestamp,
): TaskPrivateRecord {
  const journal = privateState.operationJournal.map((entry) =>
    String(entry.operationKey) === String(operationKey)
      ? { ...entry, intent: 'RECEIPT_RECORDED' as const, receipt, recordedAt: at }
      : entry,
  );
  return { ...privateState, operationJournal: journal };
}

async function persistPrivateOnly(
  services: PumpServices,
  lease: TaskLease,
  expectedRevision: Revision,
  task: AiTask,
  privateState: TaskPrivateRecord,
): Promise<AiTask> {
  return services.unitOfWork.run({ lease, expectedRevision }, async (bound) => {
    const current = await mustFindTask(bound, task.id);
    await bound.privateState.save(privateState);
    // 只写 `task_private`，不动 `ai_tasks`：`run` 的最终校验要求返回值的 revision 等于
    // 事务里最后一次 CAS 的结果，而这里没有 CAS，`latest` 仍是加锁时读到的那一格，
    // 所以直接返回 `current` 就对得上。做一次恒等 CAS 只会白写一行。
    return current;
  });
}

async function failInTransaction(
  services: PumpServices,
  lease: TaskLease,
  expectedRevision: Revision,
  privateState: TaskPrivateRecord,
  task: AiTask,
  input: { readonly code: ErrorCode; readonly at: Timestamp; readonly state: TaskState },
): Promise<AiTask> {
  return services.unitOfWork.run({ lease, expectedRevision }, async (bound) => {
    const current = await mustFindTask(bound, task.id);
    await bound.privateState.save(privateState);
    const failed = failTask(current, input.code, input.at, input.state);
    const saved = await bound.tasks.save({ task: failed, expectedRevision: current.revision });
    if (saved === null) throw new DomainError('REVISION_CONFLICT', 'AiTask');
    return saved;
  });
}

/**
 * 复现受理时写下的那一行预留。
 *
 * ## 为什么能在事务里"凭空"造出这一行
 *
 * `TaskTransactionReservations.settle` 收的是一个**实体**，而它的 SQL 是
 * `UPDATE … WHERE id = $1 AND task_id = $2`（`packages/infra/src/sql/usage-rows.ts:96`）
 * —— 也就是说必须交出**库里那一行的 `id`**。可是 F1 的端口没有读预留的方法，
 * `TaskPrivateRecord` 也没有存这个 id 的列，而 `AiTask` 与预留之间没有任何关联字段。
 * 换个说法：光凭一个 task，`COMMITTING` 片**无法**恢复出 `settle` 需要的参数。
 *
 * 出路是让 `id` 成为自然键 `(taskId, capability)` 的确定性函数（`reservationIdentity`，
 * 受理时用的就是它）。`usage_reservations` 上的 `UNIQUE (task_id, capability)` 本来就
 * 说明这两个字段唯一决定一行，所以由它们派生出的 `id` 也唯一决定那一行 —— 两边算出来
 * 必然是同一个值。这条推理**不改动任何 F1 端口**，也让结算留在同一个事务里（§3.5：
 * 「不能在版本提交失败后单独完成结算」）。
 *
 * 代价已如实申报：`id` 不再是时间有序的，削弱了 UUIDv7 的排序意图（ZLQ-153 §4.2）；
 * 该表只按主键与唯一索引点查，功能不受影响。**建议架构师给
 * `TaskTransactionReservations` 加一个 `findReservation(taskId, capability)`**，加了之后
 * 这个派生 id 就可以退回普通 UUIDv7。
 */
function reservationEntity(
  services: PumpServices,
  task: AiTask,
  capability: Capability,
  now: Timestamp,
): UsageReservation {
  return createUsageReservation({
    id: reservationIdentity({ random: services.random, taskId: task.id, capability }),
    taskId: String(task.id),
    subjectUserId: String(task.requestedBy),
    capability,
    reservedUnits: TURN_RESERVED_UNITS,
    // `hardDeadlineAt` 可空（受理时按策略填），空的时候用当前时刻兜底：这一行只是用来
    // 定位与结算，`expiresAt` 不参与 `settle` 的 WHERE。
    expiresAt: task.hardDeadlineAt ?? now,
  });
}

/**
 * 结算：把这次预留 commit 掉并写一条账目。
 *
 * 实际用量取 `TURN_RESERVED_UNITS`（与受理时预留的同一个计量单位）：契约里没有按 token
 * 计费的形状，编一个比例出来等于把定价决策藏进代码。
 */
async function settleReservation(
  bound: TaskTransaction,
  services: PumpServices,
  task: AiTask,
  capability: Capability,
  now: Timestamp,
): Promise<UsageReservation> {
  const committed = commitUsage(
    reservationEntity(services, task, capability, now),
    TURN_RESERVED_UNITS,
  );
  const ledger: UsageLedgerEntry = createUsageLedgerEntry({
    id: services.random.uuidV7(),
    // `event_key UNIQUE` + infra 侧 `ON CONFLICT (event_key) DO NOTHING` ⇒ 同一个 task 的
    // 同一个 capability 只会记一次账，重入 COMMITTING 是**成功**而不是错误。
    eventKey: `commit:${task.id}:${capability}:${task.attempt}`,
    taskId: String(task.id),
    subjectUserId: String(task.requestedBy),
    capability,
    quantity: TURN_RESERVED_UNITS,
    provider: 'qca',
    occurredAt: now,
  });
  await bound.reservations.settle({ reservation: committed, ledger });
  return committed;
}

/**
 * 取消路径释放预留：额度没被真的用掉（§6.6）。失败不掩盖取消本身。
 *
 * 刻意跑在取消事务**之外**：§3.5 的「不能在版本提交失败后单独完成结算」约束的是
 * **结算**（扣钱，版本回滚了钱却扣了 = 不可逆损害）；释放是反方向（还钱），中间态
 * "取消已提交但释放没跑成"只意味着一格额度仍被占着，而 `expiresAt`（硬截止）就是它的
 * 兜底 —— 到期自动 EXPIRED。反过来把释放塞进取消事务，就得改 F1 的端口形状，而
 * `assertSettleable` 明确拒绝任何非 `COMMITTED` 状态（`usage-rows.ts:192`），
 * 那个端口在语义上只能提交、不能释放。理由与安全论证写在 `TaskReservationReleaser` 上。
 */
async function releaseReservationQuietly(
  services: PumpServices,
  task: AiTask,
  now: Timestamp,
): Promise<void> {
  const capability = capabilityOfTaskKind(task.kind);
  if (capability === null) return;
  try {
    await services.reservationReleaser.releaseReservation({ taskId: task.id, capability, now });
  } catch {
    // 释放失败不能让"取消成功"变成"取消失败"：学生看到的必须是取消已受理。
    // 额度那一格由 `expiresAt` 到期回收，不会永久占用。
  }
}

function sessionHandleOf(
  privateState: TaskPrivateRecord,
  services: PumpServices,
): {
  sessionId: string;
  identityId: string;
  templateId: string;
  environmentId: string;
  templateVersion: string | undefined;
} {
  const sessionId = privateState.qcaSessionId;
  if (sessionId === null) throw new DomainError('INTERNAL_ERROR', 'TaskPrivateRecord.qcaSessionId');
  return {
    sessionId,
    identityId: services.providerConfiguration.identityId,
    templateId: services.providerConfiguration.templateId,
    environmentId: services.providerConfiguration.environmentId,
    templateVersion: services.providerConfiguration.templateVersion,
  };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 把一页 provider 事件压成**待固化的字节**。
 *
 * `OTHER` 分支被显式丢掉：它既不是正文也不是文件（工具调用、思考、心跳）。显式写成
 * 一个分支而不是"不匹配就跳过"，是为了让"看见了但决定不用"与"根本没看见"在代码里
 * 长得不一样 —— 后者会让 `safePayload` 的白名单失去对照。
 */
export function collectPayload(items: readonly ProviderTurnEvent[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const item of items) {
    if (item.kind === 'TEXT') parts.push(new TextEncoder().encode(item.text));
    else if (item.kind === 'FILE') parts.push(item.bytes);
    // OTHER: 有意忽略。
  }
  return concat(parts);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** 分片对象 key：由 (task, attempt, ordinal) 派生 ⇒ 重入不会写第二次同 key。 */
export function chunkKey(taskId: TaskId, attempt: number, ordinal: number): string {
  return `turns/${taskId}/attempt/${attempt}/chunk/${String(ordinal).padStart(6, '0')}`;
}

/** 包络对象 key。同上，确定性 ⇒ 幂等。 */
export function envelopeKey(taskId: TaskId, attempt: number, path: string): string {
  return `turns/${taskId}/attempt/${attempt}/envelope/${path}`;
}

/**
 * 外呼失败 → 既有错误码。**不发明新码**。
 *
 * 中止/超时 ⇒ `TASK_TIMEOUT`（§5.1 的预算耗尽）；其余 ⇒ `TRANSPORT_FAILED`，它是
 * `(TRANSPORT, …)` 那张自动重试表里已有的条目，因此下一次 pump 会按 domain 的
 * `shouldAutoRetryStageError` 决定是否重试，而不是由这里拍脑袋。
 */
export function mapExternalFailure(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const name = error instanceof Error ? error.name : '';
  const isTimeout = name === 'TimeoutError' || name === 'AbortError';
  // `QCA_UNREACHABLE` 是 `errors/task-registry.ts` 里登记在 `TRANSPORT` 阶段的那一个
  // （可重试、上限 2、EXPONENTIAL、落 `RETRY_WAIT`）；编一个目录里没有的 code 出来
  // 会让 `toSafeError` 在运行期抛 `INVALID_INPUT`。超时走 `TASK_TIMEOUT`（不可重试）。
  const code: ErrorCode = isTimeout ? 'TASK_TIMEOUT' : 'QCA_UNREACHABLE';
  return new DomainError(code, 'TurnProviderClient');
}

/** 回执的规范序列化，供 journal 幂等比较（`canonicalOperationReceipt` 的转发）。 */
export function receiptFingerprint(receipt: OperationReceipt): string {
  return canonicalOperationReceipt(receipt);
}

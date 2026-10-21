import type { Branded, Revision, TaskId, Timestamp } from '@littleq/domain';

/**
 * 租约令牌与租约句柄。
 *
 * ## 为什么在 application 里"再声明一遍"
 *
 * 这两个类型的**权威定义**在 `packages/infra/src/ports/task-repository.ts`（ZLQ-216
 * §3.5 明令「本期不改这份冻结端口签名」，所以那份定义不能动、也不能搬）。而 §3.5
 * 要求 `TaskPumpStore.acquire` 与 `TaskUnitOfWork.run` 的签名里出现 `TaskLease`，
 * 这两个端口归 application。于是只有两条路：
 *
 * 1. application `import type` 自 infra —— 但 infra 要 `implements` 这两个端口，
 *    就得反向 import application。`tsc -b` 的项目引用不允许环，两边都编译不过。
 * 2. 在这里重新声明 —— 只要声明出来的类型与 infra 那份**逐字段相同**，
 *    TypeScript 的结构类型系统就把它们当同一个类型。
 *
 * 选 2，而且它能成立有一个具体原因：`Branded<Base, Name>` 的品牌是一个
 * `unique symbol`，那个 symbol 只在 `packages/domain/src/value-objects/brand.ts`
 * 里声明了一次。所以这里写 `Branded<string, 'LeaseToken'>` 得到的 branded 类型
 * 与 infra 写同一行得到的**是同一个类型**，不是"形状相同的两个类型"。
 *
 * ## 漂移由谁看住
 *
 * 复制的代价是两份声明可能各自漂移。看守它的不是注释，而是
 * `packages/infra/test/task-pump-store-transaction.test.ts` 里的一对**双向可赋值
 * 断言**：任一侧改了字段，另一侧立刻编译不过（`pnpm typecheck` 是门 1）。
 */
export type LeaseToken = Branded<string, 'LeaseToken'>;

export interface TaskLease {
  readonly taskId: TaskId;
  readonly leaseToken: LeaseToken;
  readonly leaseUntil: Timestamp;
  readonly revision: Revision;
}

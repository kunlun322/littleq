import { randomBytes } from 'node:crypto';

import { brand, parseTaskId, type Timestamp } from '@littleq/domain';

import { infraError } from '../errors.js';
import type { LeaseToken, TaskLease } from '../ports/task-repository.js';
import { shiftTimestamp } from '../types.js';
import { fromRevisionColumn, fromTimestamptz } from './rows.js';

/**
 * 租约的铸造与到期时刻。
 *
 * ## 为什么不复用 `reference-backends.ts` 里的同名逻辑
 *
 * 内存替身里有一份逐字相同的 `leaseUntilOf` / `#newLease`。让生产驱动去 import 替身是
 * 反向依赖（组合根装配时会把整个内存账本拖进来），把替身改成 import 生产模块又会让
 * 「替身不依赖任何驱动」这条性质消失。所以这里**重写一遍**，并用
 * `test/postgres-task-repository.test.ts` 里的成对断言把两份钉在一起：
 * `leaseSeconds = 0` 必须从**两个**实现都得到 `LEASE_TTL_OUT_OF_RANGE`。
 *
 * 那条测试是这份重复的唯一守卫。删掉它，两处就会各自漂移 —— 而漂移的方向恰好是
 * 「生产比替身宽松」，也就是一份当场过期的租约能被铸出来，两个推进器同时驱动同一个任务。
 */

/**
 * `leaseUntil = now + leaseSeconds`，**下界 1 秒**。
 *
 * 这不是随手加的夹紧，而是租约语义的一部分：`shiftTimestamp` 只保证算得出合法 ISO 串
 * （它拒绝的是 NaN / 非整数），它管不了符号，所以 `leaseSeconds <= 0` 必须在这里补上。
 * 冻结端口 `TaskRepository.claim` 的注释逐字写着「**必须是正整数**：非正数会铸出一份
 * 当场就已过期的租约……违规抛 `LEASE_TTL_OUT_OF_RANGE`。注意这条下界**不在** domain 的
 * 判据里。」—— 即 domain 的 `canRenewLease` / `canReacquireLease` 不会替本层挡住它。
 *
 * `Number.isSafeInteger` 那个前置判断照抄替身：一个 `NaN` 或 `Infinity` 的 `leaseSeconds`
 * 走不进 `< 1` 分支，要留给 `shiftTimestamp` 用同一个码拒绝，两条路的公开形态才一致。
 */
export function leaseUntilOf(now: Timestamp, leaseSeconds: number): Timestamp {
  if (Number.isSafeInteger(leaseSeconds) && leaseSeconds < 1) {
    throw infraError('LEASE_TTL_OUT_OF_RANGE');
  }
  return shiftTimestamp(now, leaseSeconds, 'LEASE_TTL_OUT_OF_RANGE');
}

/**
 * 不透明随机令牌。
 *
 * 形态 `lease_<8位十六进制序号>_<16位十六进制随机>`：序号让日志里能看出铸造顺序（诊断
 * 「谁先领的」时不必比对时间戳），随机后缀才是所有权凭据 —— 可猜的令牌等于没有令牌，
 * 而 `releaseLease` / `renewLease` 的唯一判据就是它。
 *
 * 令牌**不进 DTO**（§3.5 步骤 4：「token/owner 不出 DTO」），也不进日志：它是持有权的
 * 全部证明，写进日志就等于把推进权广播出去。
 */
export function newLeaseToken(serial: number): LeaseToken {
  if (!Number.isSafeInteger(serial) || serial < 1) {
    throw infraError('LEASE_TTL_OUT_OF_RANGE');
  }
  const serialText = serial.toString(16).padStart(8, '0');
  return brand<string, 'LeaseToken'>(`lease_${serialText}_${randomBytes(8).toString('hex')}`);
}

/** 从 `ai_tasks` 的三列租约字段重建 `TaskLease`；三列有任一为 NULL 就没有租约。 */
export function leaseFromRow(row: {
  readonly id: string;
  readonly lease_token: string | null;
  readonly lease_until: unknown;
  readonly revision: unknown;
}): TaskLease | null {
  if (row.lease_token === null || row.lease_until === null) return null;
  return {
    taskId: parseTaskId(row.id),
    leaseToken: brand<string, 'LeaseToken'>(row.lease_token),
    leaseUntil: fromTimestamptz(row.lease_until),
    revision: fromRevisionColumn(row.revision),
  };
}

/** 租约是否已到期。与 domain 的 `isLeaseExpired` 同一条判据（`leaseUntil <= now`）。 */
export function isLeaseRowExpired(leaseUntil: Timestamp | null, now: Timestamp): boolean {
  if (leaseUntil === null) return true;
  return Date.parse(leaseUntil) <= Date.parse(now);
}

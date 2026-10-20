/**
 * 单对象的字节预算账本。
 *
 * ## 为什么账本按「对象」而不是按「grant token」记
 *
 * 大小预算如果按请求记，那么把一次 `bytes=0-N` 拆成 N 次 `bytes=i-i` 就能把预算放大 N 倍 ——
 * 每一次请求都「没超」。所以账本的键是对象身份（`origin + pathname`，见 `grant-url.ts`），
 * **不含查询串里的 token**：为同一个对象重新签发一个新 grant，也不会拿到一份新预算。
 *
 * ## 为什么已收到的字节即使被拒绝也照记
 *
 * `charge` 在字节到达时立即入账，随后才判断是否超限。被拒绝的那一次不会把账本回滚 ——
 * 那些字节确实已经过了网络、确实占了运行时内存。回滚等于给「故意超限再重试」发免费额度。
 *
 * ## 边界（诚实分层）
 *
 * 这份账本活在**单个 fetcher 实例的内存里**，进程重启即归零。跨进程、跨 grant 签发批次的
 * **权威**累计核算属 D2 的 grant 机制与 D5 的 `apps/api`。本单要证明的不是「权威账本存在」，
 * 而是**客户端契约这一层不是一个可以绕过的点**：在这一层里，切片、换 token、多次请求都
 * 落在同一个账本上。
 */

export interface ByteBudgetLedger {
  readonly objectKey: string;
  readonly maxBytes: number;
  consumedBytes(): number;
  remainingBytes(): number;
  /** 预检：再来 `byteLength` 字节是否仍在预算内。不改变账本。 */
  fits(byteLength: number): boolean;
  /** 实扣：字节已到达。返回扣完之后的累计值。 */
  charge(byteLength: number): number;
}

export interface ByteBudgetSnapshot {
  readonly objectKey: string;
  readonly maxBytes: number;
  readonly consumedBytes: number;
  readonly remainingBytes: number;
}

export function createByteBudgetLedger(objectKey: string, maxBytes: number): ByteBudgetLedger {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(`maxBytes 必须是正整数，收到 ${String(maxBytes)}`);
  }
  let consumed = 0;
  return {
    objectKey,
    maxBytes,
    consumedBytes: () => consumed,
    remainingBytes: () => Math.max(0, maxBytes - consumed),
    fits: (byteLength) => consumed + byteLength <= maxBytes,
    charge: (byteLength) => {
      consumed += byteLength;
      return consumed;
    },
  };
}

export function snapshotByteBudget(ledger: ByteBudgetLedger): ByteBudgetSnapshot {
  return {
    objectKey: ledger.objectKey,
    maxBytes: ledger.maxBytes,
    consumedBytes: ledger.consumedBytes(),
    remainingBytes: ledger.remainingBytes(),
  };
}

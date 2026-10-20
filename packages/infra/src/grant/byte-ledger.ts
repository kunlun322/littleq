/**
 * 跨请求累计的字节账本（ZLQ-201 裁定一不变量 5、ZLQ-194 §14「并发下载」）。
 *
 * ## 为什么不能只在单次读取上限量
 * 如果预算是「每次 `getPrivate` 最多读 N 字节」，那么发 100 个各读 N 字节的 Range 请求
 * 就能把 N×100 字节搬走 —— 上界形同虚设。所以账本必须**跨租约、跨 Range 累计**，而且
 * 结算点必须在字节**真正流向调用方**的那一刻，不是在 `open` 时预扣：预扣会让一个开了租约
 * 却从不读的客户端把预算占死，那是一次免费的拒绝服务。
 *
 * ## 越界即打断，不截断
 * 一个 chunk 装不下剩余预算时，**整个 chunk 都不放行**，流以 `OBJECT_READ_BUDGET_EXCEEDED`
 * 结束。部分放行等于交付一份残缺产物，而残缺产物对下游是「看起来成功」的，比失败难查得多。
 */
import { type InfraError, type InfraErrorCode, infraError, isInfraError } from '../errors.js';

export class ByteLedger {
  readonly #maxBytes: number;
  #committed: number;

  /**
   * `seededBytes` 是**上一次进程**已经交付、并且落库了的字节数。
   *
   * 没有它，重启就等于把预算清零：「跨 Range 累计」会退化成「每次重启重新计一次」，
   * 而攻击者只要能把服务打重启就能反复领满预算。超过 `maxBytes` 的种子值意味着库里的
   * 计数已经和预算矛盾，这里选择**大声失败**而不是夹紧 —— 夹紧会静默地少记，正是这个
   * 类要防的那种错。
   */
  constructor(maxBytes: number, seededBytes = 0) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw infraError('GRANT_BUDGET_OUT_OF_RANGE');
    }
    if (!Number.isSafeInteger(seededBytes) || seededBytes < 0 || seededBytes > maxBytes) {
      throw infraError('GRANT_BUDGET_OUT_OF_RANGE');
    }
    this.#maxBytes = maxBytes;
    this.#committed = seededBytes;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  /** 已经真正交付出去的字节数。撤销/过期都不把它退回：预算是总量，不是余额可再生。 */
  get committed(): number {
    return this.#committed;
  }

  get remaining(): number {
    return this.#maxBytes - this.#committed;
  }

  /** 能不能再交付 `byteLength` 字节。要么整批入账，要么整批不入 —— 没有部分成功。 */
  tryCommit(byteLength: number): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return false;
    if (this.#committed + byteLength > this.#maxBytes) return false;
    this.#committed += byteLength;
    return true;
  }
}

/**
 * 把一条字节流接到账本上，同时接上取消信号与一个逐 chunk 复查的守卫。
 *
 * `abortCode` 是一个**函数**而不是常量：撤销与过期在对外映射上都是无细节的 404，但内部必须
 * 可区分，而「为什么被打断」在流创建的那一刻还不知道 —— 它取决于后来是 `revoke` 先到还是
 * 过期先到。`onDelivered` 让调用方能按租约记账（账本本身是跨租约共享的）。`guard` 用来在
 * 每个 chunk 之前复查一个只有当时才能判定的条件（grant 是否已经过期）。
 *
 * ## 为什么是 pull 驱动，而不是 `source.pipeThrough(new TransformStream(...))`
 * `pipeThrough` 会**立刻**在内部起一个管道，而这个管道返回的 promise 没有任何人持有。于是
 * 一条「开了租约但一个字节都没读」的流被 `abort()` 时，`controller.error()` 会把那次失败
 * 送进一个无人认领的 promise —— Node 默认对未处理的 rejection 是抛出的，也就是说**撤销一个
 * 没人读的 grant 会把主站进程打挂**。改成自己持有 reader 之后，失败原因只是被记在闭包里，
 * 等到真有人 `read()` 时才交出去；没人读，就没有任何 rejection 产生。
 */
export function pipeThroughLedger(
  source: ReadableStream<Uint8Array>,
  ledger: ByteLedger,
  abortSignal: AbortSignal,
  abortCode: () => InfraErrorCode,
  onDelivered?: (byteLength: number) => void,
  guard?: () => InfraErrorCode | null,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let failure: InfraError | null = null;
  let upstreamReleased = false;

  const failWith = (code: InfraErrorCode): InfraError => {
    failure ??= infraError(code);
    return failure;
  };
  // 上游一旦不再需要就必须 `cancel()`：一条没人读的流会一直占着 provider 的连接。
  // 取消本身失败（上游已经出错）不算问题，这里没有可上报的对象，也没有可重试的动作。
  const releaseUpstream = async (): Promise<void> => {
    if (upstreamReleased) return;
    upstreamReleased = true;
    await reader.cancel().catch(() => undefined);
  };

  if (abortSignal.aborted) failWith(abortCode());
  // 撤销要**立即**生效：不能等到下一个 chunk 才被发现。这里只记下失败原因，不去 `error()`
  // 一条可能根本没人读的流 —— 见上面那段注释。同时把上游 reader 放掉：撤销之后没有人还会
  // 来读这条流，而底层是一条占着 provider 连接的 HTTP 流。
  abortSignal.addEventListener(
    'abort',
    () => {
      failWith(abortCode());
      void releaseUpstream();
    },
    { once: true },
  );

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // 复查失败原因与守卫。两者都只看闭包/时钟，是同步的。
        const pendingFailure = (): InfraError | null => {
          if (failure !== null) return failure;
          const guarded = guard?.() ?? null;
          return guarded === null ? null : failWith(guarded);
        };
        const stopWith = async (error: InfraError): Promise<void> => {
          await releaseUpstream();
          controller.error(error);
        };

        let pending = pendingFailure();
        if (pending !== null) {
          await stopWith(pending);
          return;
        }
        // provider 侧读取失败按依赖不可用上报；已经入过账的字节留在账本里（它们确实交付了）。
        const outcome = await reader.read().catch((error: unknown) => {
          upstreamReleased = true;
          controller.error(isInfraError(error) ? error : infraError('PROVIDER_UNAVAILABLE'));
          return null;
        });
        if (outcome === null) return;
        // **这一道复查是「撤销立即生效」的真正承重墙。** 上面那次 `await` 期间，撤销 / 过期可能
        // 正好落下来；而这一次的 `pull` 很可能不是消费者请求的那一次，而是实现快一步的前瞻拉取。
        // 只在入口复查的话，前瞻拉取会带着一个已经撤销的 grant 继续把 chunk 塞进队列，下一次
        // `read()` 直接从队列取走它 —— 于是「撤销之后一个字节都拿不到」变成了「还能多拿一块」，
        // 而且那一块还被记进了账本。此刻字节还没交给任何人，所以既不入账也不下发。
        pending = pendingFailure();
        if (pending !== null) {
          await stopWith(pending);
          return;
        }
        if (outcome.done === true || outcome.value === undefined) {
          controller.close();
          await releaseUpstream();
          return;
        }
        const chunk = outcome.value;
        if (!ledger.tryCommit(chunk.byteLength)) {
          await stopWith(failWith('OBJECT_READ_BUDGET_EXCEEDED'));
          return;
        }
        // 从这里到函数返回之间没有任何 `await`：撤销只能落在上面那道复查之前，或者落在下一次
        // `pull` 之前，不可能插进「已复查但还没下发」的缝里。
        controller.enqueue(chunk);
        if (onDelivered !== undefined) onDelivered(chunk.byteLength);
      },
      async cancel() {
        await releaseUpstream();
      },
    },
    // 队列深度压到 0。**它必须是第二个实参（queuing strategy），写在 source 对象里等于没写** ——
    // 实测：`new ReadableStream({ pull, highWaterMark: 0 })` 的 `controller.desiredSize` 仍是 1，
    // 与完全不传逐字节相同；只有 `new ReadableStream({ pull }, { highWaterMark: 0 })` 才把它压到 0。
    //
    // 为什么要压到 0：`pull` 是异步的，实现会因为 `pullAgain` 比消费者**快一步**多拉一个 chunk。
    // 那一个 chunk 会停在队列里 —— 已经 `tryCommit` 过账、却还没交给任何人。实测（消费者读走
    // 第 1 块后走开，50 ms 之后计数）：默认深度下 `pull` 被调 **2** 次、队列里滞留 **1** 块；
    // 深度 0 下 `pull` **1** 次、滞留 **0** 块。滞留的那一块正是撤销的缺口：它入过账、也已通过
    // 那道复查，撤销落在它入队之后，而下一次 `read()` 会**直接从队列取走它、根本不触发 `pull`**，
    // 于是复查一次都不会跑 —— 「撤销之后一个字节都拿不到」退化成「还能多拿一块，而且照样计费」。
    //
    // 深度 0 不会把流饿死：规范里 `ReadableStreamDefaultControllerShouldCallPull` 的第 3 步是
    // 「流被锁定且有挂起的 read 请求 ⇒ 返回真」，它排在 `desiredSize > 0` 那一步之前，所以只要
    // 有人在读，`pull` 就一定会被调用。
    { highWaterMark: 0 },
  );
}

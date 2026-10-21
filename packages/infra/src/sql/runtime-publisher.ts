import type {
  ArtifactDigest,
  ProjectId,
  ProjectVersionId,
  RuntimeRef,
  Timestamp,
} from '@littleq/domain';
import { parseRuntimeRef } from '@littleq/domain';

import { infraError } from '../errors.js';
import { hashGrantToken } from '../grant/object-read-grant.js';
import { MANIFEST_MAX_BYTES, manifestKey } from '../object-store/artifact-sealer.js';
import type { DatabaseAdapter, DatabaseTransaction } from '../ports/database-adapter.js';
import {
  RUNTIME_PREVIEW_AUDIENCE,
  type RuntimePreview,
  type RuntimePublisher,
} from '../ports/runtime-publisher.js';
import type { HealthResult, ObjectRef, SensitiveUrl } from '../types.js';
import { parseObjectRef } from '../types.js';
import type { SqlExecutor } from './executor.js';
import { executorBound, executorOf } from './executor.js';
import {
  fromJsonArray,
  fromTextColumn,
  fromTimestamptz,
  toHexBytea,
  toJsonb,
  toTimestamptz,
} from './rows.js';

/**
 * 冻结端口 `RuntimePublisher` 的生产驱动（ZLQ-220 §4 条 1、ZLQ-216 §3.2／设计 line 502）。
 *
 * ## 它替换的是哪一部分
 *
 * 设计 line 502 逐字：「**持久 grant ledger 替换内存参考实现的存储端**；TTL／并发／累计
 * 预算沿用现成语义，不新增 TTL 专项工程。」所以本驱动与 `InMemoryRuntimePublisher`
 * 的差别**只有一处**：那张进程内的 `Map<RuntimeRef, grantId>` 换成 `preview_tickets` 的一行。
 * 签发什么 grant、给多少字节、多久过期，一律照抄 —— 那些语义在
 * `ObjectReadGrantService` 里，已经被既有测试钉住，本单 §8 明令不动。
 *
 * 那一处差别修掉的是一个真实缺陷：内存 Map 随进程消失，于是**冷启动之前**签发的预览
 * 在冷启动之后就撤销不了了（`revokePreview` 报 `OBJECT_READ_GRANT_UNKNOWN`），而它对应的
 * grant 还在有效期内、还能读字节。落库之后"这个 ref 签发过"变成一个持久事实。
 *
 * ## 为什么 `runtimeRef` 要**散列**入库，而它本身并不是秘密
 *
 * `preview_tickets.token_hash` 是 §3.2 给定的列，F2 往里写的是随机 256bit ticket 的散列
 * —— 那种 token 是 bearer 凭据，泄了就等于把预览交出去。本驱动写进去的 `runtimeRef`
 * 不是 bearer 凭据（真正的凭据是 grant token，它的散列在 `object_read_grants.token_hash`），
 * 但两种 token 共用同一列，就必须共用同一种敏感度：**这一列里永远只有散列**。
 * 否则一次数据库导出会不会泄露可用的预览入口，取决于"这一行是哪个流程写的"——
 * 那是一条没人能在读日志时回答的问题。
 *
 * ## 为什么不像内存版那样把 `grantId` 从 ref 里拆出来
 *
 * `runtimeRef` 的形态是 `preview/<versionId>/<grantId>`，看上去 `revokePreview` 只要切一下
 * 字符串就能拿到 grantId，根本不需要台账。不这么做，因为 `RuntimeRef` 在 domain 里是
 * **opaque** 值对象（`value-objects/refs.ts:89`：只约束长度，不约束格式）。让生产驱动
 * 依赖一个 domain 明确声明为不透明的字符串的内部结构，等于把一条没有守卫的隐式契约
 * 变成撤销路径的前提 —— 谁改了签发格式，撤销就静默失效（找不到 grant，而不是报错）。
 *
 * ## 一处 FK 带来的**收紧**
 *
 * `preview_tickets.version_id REFERENCES versions(id)`，所以为一个**尚未落库**的 version
 * 签发预览会失败。内存版没有这条约束。这是收紧不是放宽：预览的对象必须是一个真实存在
 * 的版本，否则 `preview:resolve`（F2）会把一个指向空处的入口交出去。
 */

/**
 * 签发预览所需的 grant 能力。`ObjectReadGrantService` 结构上就满足它。
 *
 * 刻意**不复用** `reference-backends.ts` 里同名的 `PreviewGrantIssuer`：那会让生产驱动
 * 在源码层面依赖内存替身模块（两份声明会先在包出口上撞名，然后形成 `sql/ → 替身 →
 * grant/` 的环）。理由与 `sql/lease.ts` 重写一遍 `leaseUntilOf` 而不 import 替身的那份
 * 逐字相同。
 */
export interface RuntimePreviewGrantIssuer {
  issue(input: IssuePreviewGrantInput): Promise<IssuedPreviewGrant>;
  revoke(grantId: string, now: Timestamp): Promise<number>;
}

export interface IssuePreviewGrantInput {
  readonly objectRef: ObjectRef;
  readonly artifactHash: ArtifactDigest;
  readonly audience: string;
  readonly maxBytes: number;
  readonly ttlSeconds: number;
  readonly now: Timestamp;
}

export interface IssuedPreviewGrant {
  readonly grantId: string;
  readonly url: SensitiveUrl;
  readonly expiresAt: Timestamp;
}

/**
 * `preview_tickets.token_hash` 的散列。
 *
 * 与 `hashGrantToken` 是同一个 sha256-hex，但**不借用那个名字**：ticket 与 grant 是两种
 * 凭据，一个叫 "grant" 的函数出现在 ticket 的写入路径上会让读者以为 ticket 就是 grant。
 * 实现直接委托，不写第二份 sha256 —— 两份散列实现漂移的后果是同一列里混进两种编码。
 */
export function hashTicketToken(token: string): string {
  return hashGrantToken(token);
}

export const PREVIEW_TICKET_COLUMNS = `token_hash, version_id, expires_at, grant_ids, created_at`;

export type PreviewTicketRow = {
  readonly token_hash: unknown;
  readonly version_id: string;
  readonly expires_at: unknown;
  readonly grant_ids: unknown;
  readonly created_at: unknown;
};

/**
 * 台账落库。**没有** `ON CONFLICT DO NOTHING`。
 *
 * 主键撞上意味着"同一个 ref 已经有一行台账"，而 ref 里嵌着刚铸出来的随机 grantId，
 * 撞上的概率是 2⁻²⁵⁶ 量级；真的撞上了就说明库里有东西不对，此时静默跳过会留下一张
 * **指向别人 grant** 的台账 —— 之后 `revokePreview` 撤销的是另一张授权，而我们这张
 * 永远活着。让它抛，由 `publishPreview` 的补偿分支把刚铸的 grant 撤销掉。
 */
export const PREVIEW_TICKET_INSERT_SQL = `
INSERT INTO preview_tickets(token_hash, version_id, expires_at, grant_ids, created_at)
VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5::timestamptz)`;

export const PREVIEW_TICKET_SELECT_BY_TOKEN_HASH_SQL = `
SELECT ${PREVIEW_TICKET_COLUMNS} FROM preview_tickets WHERE token_hash = $1`;

export interface PostgresRuntimePublisherOptions {
  readonly grants: RuntimePreviewGrantIssuer;
  readonly now?: () => Date;
}

export class PostgresRuntimePublisher implements RuntimePublisher {
  readonly #execute: SqlExecutor;
  readonly #grants: RuntimePreviewGrantIssuer;
  readonly #now: () => Date;

  private constructor(execute: SqlExecutor, options: PostgresRuntimePublisherOptions) {
    this.#execute = execute;
    this.#grants = options.grants;
    this.#now = options.now ?? (() => new Date());
  }

  static of(db: DatabaseAdapter, options: PostgresRuntimePublisherOptions) {
    return new PostgresRuntimePublisher(executorOf(db), options);
  }

  static bound(tx: DatabaseTransaction, options: PostgresRuntimePublisherOptions) {
    return new PostgresRuntimePublisher(executorBound(tx), options);
  }

  async publishPreview(input: {
    readonly projectId: ProjectId;
    readonly projectVersionId: ProjectVersionId;
    readonly artifactHash: ArtifactDigest;
    readonly ttlSeconds: number;
    readonly now: Timestamp;
  }): Promise<RuntimePreview> {
    // 预览入口指向**固化清单**：Runtime 先读清单，再按清单里的分片各自取字节。
    // TTL 上界不在这里重判 —— grant 层已经把 300 秒钉死，两处各判一次只会在两者不一致时
    // 产生一个说不清谁对的行为。
    const issued = await this.#grants.issue({
      objectRef: parseObjectRef(manifestKey(input.artifactHash)),
      artifactHash: input.artifactHash,
      audience: RUNTIME_PREVIEW_AUDIENCE,
      maxBytes: MANIFEST_MAX_BYTES,
      ttlSeconds: input.ttlSeconds,
      now: input.now,
    });
    const runtimeRef = parseRuntimeRef(`preview/${input.projectVersionId}/${issued.grantId}`);

    try {
      await this.#execute((tx) =>
        tx.execute(PREVIEW_TICKET_INSERT_SQL, [
          toHexBytea(hashTicketToken(runtimeRef)),
          input.projectVersionId,
          toTimestamptz(issued.expiresAt),
          toJsonb([issued.grantId]),
          toTimestamptz(input.now),
        ]),
      );
    } catch (error) {
      /**
       * 补偿撤销。grant 已经铸出来了而台账没落库 ⇒ `revokePreview` 再也找不到它
       * （它只认台账），于是这张 grant 会在自己的 TTL（≤300 秒）里一直可读。
       * "自然过期"不等于"已撤销"，所以就地撤销。
       *
       * 撤销本身失败不再抛：调用方需要看到的是**原始的**落库错误（FK 缺失／主键冲突），
       * 而不是一个把它盖掉的次生错误。
       */
      await this.#grants.revoke(issued.grantId, input.now).catch(() => undefined);
      throw error;
    }

    return {
      runtimeRef,
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      artifactHash: input.artifactHash,
      issuedAt: input.now,
      expiresAt: issued.expiresAt,
      url: issued.url,
    };
  }

  async revokePreview(input: {
    readonly runtimeRef: RuntimeRef;
    readonly now: Timestamp;
  }): Promise<void> {
    const rows = await this.#execute((tx) =>
      tx.query<PreviewTicketRow>(PREVIEW_TICKET_SELECT_BY_TOKEN_HASH_SQL, [
        toHexBytea(hashTicketToken(input.runtimeRef)),
      ]),
    );
    const row = rows[0];
    // 撤销一个从没签发过的 ref 是调用方 bug：静默返回会让调用方以为预览已经断了。
    if (row === undefined) throw infraError('OBJECT_READ_GRANT_UNKNOWN');

    for (const grantId of grantIdsOf(row)) {
      await this.#grants.revoke(grantId, input.now);
    }
    // 台账行刻意**不删**，与内存版同调：**重复**撤销同一个 ref 必须安静地成功
    // （`ObjectReadGrantService.revoke` 对已撤销的 grant 返回原样、不抛）。删掉行会让
    // 第二次撤销变成 `OBJECT_READ_GRANT_UNKNOWN`，而幂等撤销正是"撤销必须立即生效"
    // 这条要求能被安全重试的前提。
  }

  async health(): Promise<HealthResult> {
    // 本 publisher 自己没有 provider 连接可探（字节读取的健康在 `ObjectStore.health`，
    // 数据库的健康在 `DatabaseAdapter.health`），所以它只报「我还活着」，`latencyMs`
    // 留 null 表示没有测量对象。刻意**不**代理 `DatabaseAdapter.health()`：`bound` 形态
    // 拿不到 adapter，于是同一个端口会有两种健康语义，取决于它是怎么装配的。
    return { status: 'ok', checkedAt: this.#now(), latencyMs: null, detail: null };
  }
}

/** `grant_ids` 是 jsonb 数组；一张 ticket 可以覆盖多个 grant（F2 的 resolve 会用这一点）。 */
function grantIdsOf(row: PreviewTicketRow): readonly string[] {
  return fromJsonArray(row.grant_ids).map(fromTextColumn);
}

/** 台账行的到期时刻。F2 的 `preview:resolve` 用它判"未过期"，本端口不判。 */
export function previewTicketFromRow(row: PreviewTicketRow): {
  readonly versionId: string;
  readonly grantIds: readonly string[];
  readonly expiresAt: Timestamp;
  readonly createdAt: Timestamp;
} {
  return {
    versionId: fromTextColumn(row.version_id),
    grantIds: grantIdsOf(row),
    expiresAt: fromTimestamptz(row.expires_at),
    createdAt: fromTimestamptz(row.created_at),
  };
}

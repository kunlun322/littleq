/**
 * 端口 3／5：`ObjectStore` —— 私有对象存储（ZLQ-194 §6.2、ZLQ-201 裁定一）。
 *
 * ## 选型结论（已定案，不在本层重新讨论）
 * **Vercel Blob（`access: 'private'`）**，`@vercel/blob@2.8.2`。S3 兼容路线被否：在 Hobby
 * 计划上要额外准备一个外部 bucket，运维负担更大（C21 Vercel-first）。`@aws-sdk/client-s3`
 * 与 `@aws-sdk/s3-request-presigner` 仍然留在 `packages/infra/package.json` 的冻结清单里
 * （D0 故意两条路线都预置，摘掉会红 `readiness-dependency-freeze-intact`）。
 *
 * ## 这个端口对外**不发**任何 provider URL
 * `putImmutable` 返回 `ObjectRef`（内部 key，语法里没有 `:`，装不下一个 URL），不返回
 * `PutBlobResult.url` / `downloadUrl`，也不返回 presign URL。对外的读取入口只有一条：
 * 平台自己的 opaque grant URL，见 `../grant/object-read-grant.ts`。
 *
 * ## §14 六项未实证点 → 本端口的方法签名与不变量
 * 逐项点名，每一项都有对应测试（能力名见 `src/index.ts` 的 `unitReadiness.capabilities`）：
 *
 * | §14 | 落在哪 |
 * | --- | --- |
 * | 未授权直读 | `getPrivate` 只接受 `ObjectRef`；grant 侧校验不过时**根本不调用它** |
 * | 过期 URL | 本端口不签发任何带有效期的 URL —— 过期语义只在 grant 层存在 |
 * | 15MiB 边界 | `putImmutable` 的 `maxBytes` + `declaredBytes` + `sha256` 三重判定 |
 * | 并发下载 | `getPrivate` 的 `maxBytes` 是**每次读取**的预算；跨 Range 累计在 grant 层 |
 * | 产物可分片固化 | `putImmutable` 的 key 不可覆盖 + `artifact-sealer` 的清单最后写 |
 * | 原始签名 URL 不落日志 | 端口只吐 `ObjectRef` / `SensitiveUrl`，`InfraError` 上没有可装原文的字段 |
 *
 * ⚠️ 诚实分层：本单对**真实** private Blob 链路的证明做不到（没有也不允许引入生产凭据）。
 * 这里测到的是端口不变量（用内存实现与 SDK 替身），真链路的未授权/过期拒绝、撤销即时生效、
 * 第 9 路并发拒绝、真实日志无 provider URL、以及端到端 artifact-hash 一致性属于 D5/D6。
 */
import type { ArtifactDigest } from '@littleq/domain';

import type {
  ByteRange,
  HealthResult,
  ObjectRef,
  StoredObjectMetadata,
  StoredObjectStream,
} from '../types.js';

/** §14 的六项，逐字点名；测试用它对照，保证一项都没被悄悄丢掉。 */
export const OBJECT_STORE_INVARIANTS = [
  'unauthorized-direct-read',
  'expired-url',
  'size-boundary-15mib',
  'concurrent-download',
  'chunked-artifact-sealing',
  'raw-signed-url-never-logged',
] as const;

export type ObjectStoreInvariant = (typeof OBJECT_STORE_INVARIANTS)[number];

/** §6.2 的产物大小上界：15 MiB。边界值本身必须成功，第 `+1` 个字节必须失败。 */
export const ARTIFACT_MAX_BYTES = 15 * 1024 * 1024;

export interface PutImmutableInput {
  /**
   * 内部存储 key，同时就是 `ObjectRef` 的原值。分片 key 的形状由 `artifact-sealer` 固定为
   * `artifacts/{artifactHash}/chunks/{ordinal}-{chunkSha256}`，不由调用方自由拼。
   */
  readonly key: string;
  readonly body: ReadableStream<Uint8Array>;
  /** 调用方声称的字节数；与实际读到的不一致 ⇒ `OBJECT_DECLARED_BYTES_MISMATCH`。 */
  readonly declaredBytes: number;
  /** 硬上界；实际字节数超过它 ⇒ `OBJECT_UPLOAD_TOO_LARGE`，且不产生 `ObjectRef`。 */
  readonly maxBytes: number;
  /** 调用方声称的内容 sha256（小写十六进制）；不一致 ⇒ `OBJECT_HASH_MISMATCH`。 */
  readonly sha256: ArtifactDigest;
  readonly contentType: string;
  readonly abortSignal: AbortSignal;
}

export interface GetPrivateInput {
  readonly ref: ObjectRef;
  /** 省略即整对象读取；给了就是闭区间 Range。 */
  readonly range?: ByteRange;
  /** 本次读取的字节预算；超出 ⇒ 流以 `OBJECT_READ_BUDGET_EXCEEDED` 结束，不静默截断。 */
  readonly maxBytes: number;
  readonly abortSignal: AbortSignal;
}

export interface ObjectStore {
  /**
   * 写一个**不可覆盖**的对象。
   *
   * 不变量：同一个 key 第二次写必须失败（`OBJECT_ALREADY_EXISTS`），因为已固化的产物分片
   * 一旦被覆盖，先前签发出去的 artifactHash 就不再描述实际字节。失败路径（超限、声明不符、
   * 摘要不符、中断）必须把已写入的残留清掉，且**不返回** `ObjectRef`。
   */
  putImmutable(input: PutImmutableInput): Promise<ObjectRef>;

  /**
   * 私有读取。**只有**已经通过 grant 校验的调用方才该走到这里；本方法自己不做授权判定，
   * 它只保证：没有 provider 凭据的调用方拿不到任何可读的 URL，而 `ref` 语法上装不下 URL。
   */
  getPrivate(input: GetPrivateInput): Promise<StoredObjectStream>;

  /** 对象不存在返回 `null`，不抛 —— `head` 被固化流程用来逐片核对，抛异常会淹没真实原因。 */
  head(ref: ObjectRef): Promise<StoredObjectMetadata | null>;

  /** 按前缀批量清理（取消的任务、过期预览）；provider 不支持原子批量时逐 key 删。 */
  deletePrefix(prefix: string): Promise<void>;

  /** 健康检查。`detail` 只能是内部错误码，绝不能是 provider 的原文（原文里带签名 URL）。 */
  health(): Promise<HealthResult>;
}

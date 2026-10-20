/**
 * 端口 5／5：`RuntimePublisher` —— 短期隔离预览（ZLQ-194 §6.2）。
 *
 * §6.2 的原话是「首切片只实现短期隔离预览，不实现永久公开发布/slug/回滚」。所以这个端口
 * **只有**预览相关的三个方法：`publishPreview` / `revokePreview` / `health`。永久公开发布、
 * slug 分配、版本回滚不是「以后再加的方法」，而是**现在不存在的方法** —— 缺失本身就是契约，
 * `five-port-contract` 测试会对着本文件源码断言那三个名字的命中数为 0。
 *
 * 预览入口是平台自己的 opaque grant URL（见 `../grant/object-read-grant.ts`），不是 Blob URL，
 * 也不是 provider 的 presign URL；所以 `RuntimePreview.url` 的类型是 `SensitiveUrl`。
 */
import type {
  ArtifactDigest,
  ProjectId,
  ProjectVersionId,
  RuntimeRef,
  Timestamp,
} from '@littleq/domain';

import type { HealthResult, SensitiveUrl } from '../types.js';

/**
 * 预览的受众标记。grant 只在 `audience` 完全相等时放行，所以「拿预览 grant 去读别的产物」
 * 在 grant 层就是一次 `GRANT_AUDIENCE_MISMATCH`，不需要每个调用点自己判。
 */
export const RUNTIME_PREVIEW_AUDIENCE = 'runtime-preview';

export type RuntimePreviewAudience = typeof RUNTIME_PREVIEW_AUDIENCE;

export interface RuntimePreview {
  readonly runtimeRef: RuntimeRef;
  readonly projectId: ProjectId;
  readonly projectVersionId: ProjectVersionId;
  readonly artifactHash: ArtifactDigest;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly url: SensitiveUrl;
}

export interface RuntimePublisher {
  /** 发一个**有上界有效期**的隔离预览；`ttlSeconds` 的上界由 grant 层钉在 300 秒。 */
  publishPreview(input: {
    readonly projectId: ProjectId;
    readonly projectVersionId: ProjectVersionId;
    readonly artifactHash: ArtifactDigest;
    readonly ttlSeconds: number;
    readonly now: Timestamp;
  }): Promise<RuntimePreview>;

  /** 撤销预览；撤销必须立即生效，已经开出去的读租约也要被切断。 */
  revokePreview(input: { readonly runtimeRef: RuntimeRef; readonly now: Timestamp }): Promise<void>;

  health(): Promise<HealthResult>;
}

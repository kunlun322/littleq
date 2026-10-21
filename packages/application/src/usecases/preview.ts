/**
 * 预览用例（ZLQ-221 §4.1 `POST /projects/{id}/preview`）。
 *
 * ## 这一层做的事
 *
 * 三件：把项目与版本都收敛到**这个学生**名下、拿 domain 的可预览判据过一遍、把签发交给
 * `PreviewPublisher` 端口。响应就是契约 `createPreviewResponseSchema` 的三键
 * `{url, expiresAt, versionId}`，一个不多。
 *
 * ## 为什么"没有当前版本"是 422 而不是 404
 *
 * 契约把 `versionId` 定成 optional + nullable，缺省语义是"用当前版本"。于是一个刚建好、
 * 还没跑完任何回合的项目会走到这里 —— 而它**确实存在**，学生刚刚还 `GET` 到过它。
 * 报 404 `RESOURCE_NOT_FOUND` 等于对着一个存在的项目说"查无此物"，客户端只能把它理解成
 * 自己的 id 抄错了，接着去重试一个永远不会成功的请求。
 *
 * `VERSION_NOT_PREVIEWABLE`（422）说的是"项目在这儿，只是现在还没有可预览的东西"，
 * 与"版本不可预览"是同一类事实：**资源在，状态不允许**。`valueObject` 取
 * `Project.currentVersionId` 把这两种情况再分开一档，日志里一眼能看出是哪条路。
 *
 * ## 为什么显式再查一次 `version.projectId === projectId`
 *
 * `loadOwnedVersion` 只证明"这个版本属于**这个学生**的某个项目"—— 它是从
 * `version.projectId` 反查项目的。所以一个学生拿自己 A 项目的真实 versionId 去请求
 * B 项目的预览，归属检查会**通过**。B 项目的产物没被泄露给别人，但跨项目取产物本身
 * 就是一条不该存在的路径：预览地址是按 `(projectId, versionId)` 签发的，两者对不上时
 * 签出来的 grant 指向哪个项目就说不清了。
 *
 * 与"版本不存在"用**同一个** `RESOURCE_NOT_FOUND` + 同一个 `valueObject`：§11.1 步骤 6
 * 的那条要求（不泄漏、也不可探测）在这里同样成立 —— "这个 versionId 存在吗"不该是一个
 * 能问出答案的问题。`turns.ts` 的 `loadTurnBaseVersion` 对 `baseVersionId` 用的是同一套
 * 判法，两处因此不会漂移。
 *
 * ## 不可预览的两个原因分开报
 *
 * domain 只有 `isPreviewableVersion`，**没有** `assertPreviewableVersion`（对比
 * `assertRestorableVersion` / `assertPublishableVersion` 都在），所以抛错由本层做。
 * 判据是 `buildStatus === 'VALID' && scanStatus !== 'BLOCK'` 两个字段的合取，
 * `valueObject` 就取**实际不成立的那一个**，客户端不必去猜。
 *
 * `CONFIRM_REQUIRED` 是**允许**预览的（与允许回滚同判据）：扫描发现了需要人工确认的东西，
 * 而"确认"的前提正是看得见。
 *
 * ## 两条红线
 *
 * 1. `url` 是短期、独立源的 opaque grant URL，它**只**进响应的 `url` 字段。不打日志、
 *    不写进 `TaskEvent`、不进 `safeScanSummary` —— 一处泄漏就是一份可复用的凭证
 *    （`ports.ts` 的 `PreviewPublisher` 注释同一条）。
 * 2. `ttlSeconds` 由**注入**决定，不在这里写死。数值属于部署配置，与 domain 不硬编码
 *    默认值是同一条约束；写死在这里就等于把运维参数藏进了代码。
 *
 * ## 不在本文件里的两件事
 *
 * - **§4.5 的内部运行时端点**（`POST /api/runtime/preview:resolve`、
 *   `GET /api/runtime/objects/{grantId}?token=…`）不经过这一层。`ports.ts` 里**没有**
 *   grant 端口，这两个端点是 server-only 的装配，直接建在 infra 已导出的
 *   `ObjectReadGrantService` / `PreviewGrantIssuer` 之上，放在组合根（`apps/api`）。
 *   它们不进冻结的公开业务接口（§9.2 门 8）。
 * - **`operations.ts:486` 的 `:restore` 本期不交付，也没有任何按钮指向它。**
 *   `isPreviewableVersion` 与 `isRestorableVersion` 共用判据是 domain 既有的事实
 *   （"预览跑的是同一份不可变产物"），**不代表回滚已经通了** —— 回滚要写
 *   `Project.currentVersionId`，而 `entities/project.ts` 里根本没有那个入口。
 */
import {
  type Project,
  type ProjectId,
  type ProjectVersion,
  type ProjectVersionId,
  type Timestamp,
  DomainError,
  isPreviewableVersion,
} from '@littleq/domain';
import type { Actor } from './authorization.js';
import type { PreviewPublisher, ProjectDirectory } from './ports.js';
import { loadOwnedProject, loadOwnedVersion } from './projects.js';

export interface PreviewServices {
  readonly projects: ProjectDirectory;
  readonly preview: PreviewPublisher;
  /** 预览地址有效期（秒）。由组合根从配置/环境变量给，见文件头的红线 2。 */
  readonly previewTtlSeconds: number;
}

export interface CreatePreviewInput {
  readonly actor: Actor;
  readonly projectId: ProjectId;
  /** 契约里 optional + nullable，两条路都在适配层归一到 `null` = 用当前版本。 */
  readonly versionId: ProjectVersionId | null;
  readonly now: Timestamp;
}

/** 与 `createPreviewResponseSchema` 三键一一对应，`versionId` 恒非空。 */
export interface PreviewView {
  readonly url: string;
  readonly expiresAt: Timestamp;
  readonly versionId: ProjectVersionId;
}

/**
 * 把"要预览哪个版本"这件事定下来。
 *
 * 三条出口，每条都有明确理由（见文件头）：请求里给了 id ⇒ 归属 + 同项目双查；
 * 没给 ⇒ 当前版本；当前版本也没有 ⇒ 422。
 */
async function resolvePreviewVersion(
  services: PreviewServices,
  input: {
    readonly actor: Actor;
    readonly project: Project;
    readonly requestedVersionId: ProjectVersionId | null;
  },
): Promise<ProjectVersion> {
  if (input.requestedVersionId === null) {
    const currentVersionId = input.project.currentVersionId;
    if (currentVersionId === null) {
      throw new DomainError('VERSION_NOT_PREVIEWABLE', 'Project.currentVersionId');
    }
    const current = await services.projects.findVersionById(currentVersionId);
    if (current === null) throw new DomainError('RESOURCE_NOT_FOUND', 'ProjectVersion');
    return current;
  }

  const { version } = await loadOwnedVersion(services, {
    actor: input.actor,
    versionId: input.requestedVersionId,
  });
  if (String(version.projectId) !== String(input.project.id)) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'ProjectVersion');
  }
  return version;
}

function assertPreviewable(version: ProjectVersion): void {
  if (isPreviewableVersion(version)) return;
  throw new DomainError(
    'VERSION_NOT_PREVIEWABLE',
    version.buildStatus === 'VALID' ? 'ProjectVersion.scanStatus' : 'ProjectVersion.buildStatus',
  );
}

export async function createPreviewUseCase(
  services: PreviewServices,
  input: CreatePreviewInput,
): Promise<PreviewView> {
  const project = await loadOwnedProject(services, input);
  const version = await resolvePreviewVersion(services, {
    actor: input.actor,
    project,
    requestedVersionId: input.versionId,
  });
  assertPreviewable(version);

  const published = await services.preview.publishPreview({
    projectId: project.id,
    projectVersionId: version.id,
    artifactHash: version.artifactSha256,
    ttlSeconds: services.previewTtlSeconds,
    now: input.now,
  });
  return { url: published.url, expiresAt: published.expiresAt, versionId: version.id };
}

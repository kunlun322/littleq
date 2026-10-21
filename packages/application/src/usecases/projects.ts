/**
 * 项目用例（ZLQ-216 §4.1 / §4.2 / §5.5）。
 *
 * ## 这一层做的事
 *
 * 只有三件：把**认证后的身份**换算成资源归属（`authorization.ts`）、调 domain 的构造
 * 函数得到实体、把实体交给目录端口持久化。DTO 投影在组合根（`apps/api`），因为
 * `@littleq/api-contract` 的 schema 是**线上形状**的事实源，而本层的出入参一律是
 * domain 实体 —— 让用例直接吐 DTO 会把契约层拉进应用层的依赖里，`api-contract-no-platform-coupling`
 * 那条入向白名单也就失去了意义。
 *
 * ## 归属判断为什么每次都要重做
 *
 * `loadOwnedProject` 是这一层的唯一入口守卫，turn / preview / versions 三条用例都经它。
 * 它存在的理由是 §11.1 步骤 6：「学生 B 直接拿 A 的真实 project/task ID 请求项目、任务、
 * 事件、预览**全部 404 且无标题/prompt/URL 泄漏**」。四条路径各有各的响应形状，只要
 * 有一条忘了先查归属，泄漏就从那条出去 —— 比如 `listProjectVersions` 直接按 projectId
 * 查版本，学生 B 就能拿到 A 每个版本的 `artifactSha256` 与文件数。
 *
 * 顺序也是契约的一部分：**先按 id 查、查不到 404、查到了但归属不符也 404**，两种情况
 * 的响应形状必须一致（同一个 `RESOURCE_NOT_FOUND`、同一个 `valueObject`），否则
 * "这个 id 存在吗"就成了可探测事实。
 */
import {
  type AiTask,
  type Project,
  type ProjectId,
  type ProjectStatus,
  type ProjectVersion,
  type ProjectVersionId,
  type Timestamp,
  type UserId,
  DomainError,
  createProject,
} from '@littleq/domain';
import { type Actor, assertOwnedBy, studentActorId } from './authorization.js';
import type { Page, ProjectDirectory, RandomSource, TaskReadDirectory } from './ports.js';

export interface ProjectServices {
  readonly projects: ProjectDirectory;
  readonly tasks: TaskReadDirectory;
  readonly random: RandomSource;
}

/**
 * 按 id 取项目并断言归属。
 *
 * 导出给 turn / preview 用例复用：它们的入参里都只有 `projectId`，而"这个项目是谁的"
 * 必须从 DB 读，不能从请求体拿（§4.2：「所有 API 都从服务器会话判断，不信任客户端声明」）。
 */
export async function loadOwnedProject(
  services: ProjectServices,
  input: { readonly actor: Actor; readonly projectId: ProjectId },
): Promise<Project> {
  const studentId = studentActorId(input.actor);
  const project = await services.projects.findById(input.projectId);
  if (project === null) throw new DomainError('RESOURCE_NOT_FOUND', 'Project');
  assertOwnedBy(project.ownerStudentId, studentId);
  return project;
}

/** 同理：取版本并断言它属于这个学生的项目。 */
export async function loadOwnedVersion(
  services: ProjectServices,
  input: { readonly actor: Actor; readonly versionId: ProjectVersionId },
): Promise<{ readonly project: Project; readonly version: ProjectVersion }> {
  const version = await services.projects.findVersionById(input.versionId);
  if (version === null) throw new DomainError('RESOURCE_NOT_FOUND', 'ProjectVersion');
  const project = await loadOwnedProject(services, {
    actor: input.actor,
    projectId: version.projectId,
  });
  return { project, version };
}

export interface CreateProjectInput {
  readonly actor: Actor;
  readonly title: string;
  /** §4.1 逐字：线上 `workType` 值是 **`WEB`**，T1 只是 UI 标签、不是 enum 取值。 */
  readonly workType: string;
  readonly ageBand: string;
  readonly helpLevel: string;
  readonly templateId: string | null;
  readonly now: Timestamp;
}

/**
 * `POST /projects` ⇒ 201 + ETag/Location（§4.1）。
 *
 * `ownerStudentId` **永远**取认证后的学生身份，请求体里没有这个键 —— 契约的
 * `createProjectRequestSchema` 也不含它，所以"客户端指定别人"这条路在解析阶段就不存在。
 * OWNER 调到这里得到 `FORBIDDEN_CAPABILITY`，不会被隐式当成学生（§4.2）。
 *
 * `revision` / `status` 用 domain 的默认值而不是在这里写死：初值属于实体的构造规则，
 * 抄一份到这里就有了第二个事实源。
 */
export async function createProjectUseCase(
  services: ProjectServices,
  input: CreateProjectInput,
): Promise<Project> {
  const ownerStudentId: UserId = studentActorId(input.actor);
  const project = createProject({
    id: services.random.uuidV7(),
    ownerStudentId,
    title: input.title,
    workType: input.workType,
    ageBand: input.ageBand,
    helpLevel: input.helpLevel,
    templateId: input.templateId,
    currentVersionId: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await services.projects.insert(project);
  return project;
}

/**
 * `GET /projects/{id}` 的聚合视图（§4.1）。
 *
 * 两个可空键**必须存在**：契约的 `getProjectResponseSchema` 把它们定成 required-but-nullable
 * 而不是 optional，所以这里返回的也永远是三键齐全的对象 —— 少一个键，客户端就要用
 * `key in obj` 去区分"没有当前版本"和"服务端没查"，而这两种情况对首屏的意义完全不同。
 */
export interface ProjectView {
  readonly project: Project;
  readonly currentVersion: ProjectVersion | null;
  readonly activeTask: AiTask | null;
}

export async function getProjectView(
  services: ProjectServices,
  input: { readonly actor: Actor; readonly projectId: ProjectId; readonly now: Timestamp },
): Promise<ProjectView> {
  const project = await loadOwnedProject(services, input);
  const [currentVersion, activeTask] = await Promise.all([
    project.currentVersionId === null
      ? Promise.resolve(null)
      : services.projects.findVersionById(project.currentVersionId),
    services.tasks.findActiveWriteTask(project.id),
  ]);
  return { project, currentVersion, activeTask };
}

export interface ListProjectsQuery {
  readonly actor: Actor;
  readonly status: ProjectStatus | null;
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * `GET /projects`。
 *
 * §4.1 逐字：「只读当前学生范围，**不是 localStorage 列表**。」契约的
 * `listProjectsQuerySchema` 里有一个 `ownerStudentId` 查询参数，本用例**不接受**它：
 * 范围一律钉在认证后的学生身份上。参数留在契约里是给将来成人查看面的，而 §12.3 把
 * 「教师/家长管理端」列在本切片之外 ⇒ 现在没有任何调用方能合法地用到它。
 * 这一处偏离已在交付评论里声明。
 */
export async function listProjects(
  services: ProjectServices,
  input: ListProjectsQuery,
): Promise<Page<Project>> {
  const ownerStudentId = studentActorId(input.actor);
  return services.projects.list({
    ownerStudentId,
    status: input.status,
    cursor: input.cursor,
    limit: input.limit,
  });
}

export interface ListVersionsQuery {
  readonly actor: Actor;
  readonly projectId: ProjectId;
  readonly cursor: string | null;
  readonly limit: number;
}

/** `GET /projects/{id}/versions` —— §11.1 步骤 5 要求旧 Version N 仍保留可查看。 */
export async function listProjectVersions(
  services: ProjectServices,
  input: ListVersionsQuery,
): Promise<Page<ProjectVersion>> {
  const project = await loadOwnedProject(services, input);
  return services.projects.listVersions({
    projectId: project.id,
    cursor: input.cursor,
    limit: input.limit,
  });
}

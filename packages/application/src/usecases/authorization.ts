/**
 * 授权语义（ZLQ-216 §4.2 / §5.3）—— 「谁在调这个接口」到「这个动作用哪个身份」的唯一换算处。
 *
 * ## 为什么单独立一个文件
 *
 * §4.2 逐字：「登录 UI 的『学生登录 / 成人配置』只决定**白名单 next 路径**，**这不是
 * 授权依据**；所有 API 都从服务器会话判断角色/能力。」这句话要落地，就得有一个地方
 * **只**接受"已从服务器会话解析出来的 `User`"，并且把它换算成动作真正需要的身份。
 * 散在各用例里的话，"从会话判断"就会退化成"从请求体判断"，而后者正是这条禁令要防的。
 *
 * 因此本文件的三个函数有一个共同点：**入参里没有 request body**。角色只可能来自
 * `Actor.user`，而 `Actor.user` 只可能来自 `authenticate()` 读 DB 会话的结果。
 *
 * ## 三条换算
 *
 * - `studentActorId`：学生面动作（建项目、发 turn、看作品）用的身份。
 *   §4.2 逐字：「**OWNER 不能冒充 STUDENT 创建项目**，`Project.ownerStudentId`
 *   **永远取认证后的学生身份**。OWNER 进入学生 API 返回**既有能力错误**，不变成隐式
 *   学生。」⇒ OWNER 拿到的是 `FORBIDDEN_CAPABILITY`（403），**不是**"那就当他是学生"。
 * - `ownerActorId`：成人配置面动作（BYO 凭据、用量上限）用的身份。学生调它同样是
 *   `FORBIDDEN_CAPABILITY` —— 否则学生能给自己换一份凭据，绕开成人配置这道关。
 * - `secretOwnerIdOf`：凭据归属。`owner_secrets.owner_id` 是**成人**的 id，所以学生
 *   发任务时要沿 `users.owner_id` 找到他的成人；成人本人就是自己。
 *
 * ## 跨租户隔离不在这里
 *
 * 「学生 B 拿学生 A 的 id 必须 404」是**资源归属**判断，不是角色判断，放在
 * `projects.ts` 的 `assertOwnedBy`。两者分开是因为它们的错误码不同：角色不符是 403
 * （调用方知道自己是谁、也知道自己不该调这个），资源不属于你是 404（连"它存在"都不
 * 该让对方知道，§11.1 步骤 6 逐字要求「无标题/prompt/URL 泄漏」）。
 */
import { type AccountSession, type User, type UserId, DomainError } from '@littleq/domain';

/** 已通过服务器会话认证的调用方。`user` 来自 DB，不是来自请求体。 */
export interface Actor {
  readonly user: User;
  readonly session: AccountSession;
}

/**
 * 学生面动作的身份。
 *
 * 会话在这里已经解析成功，所以"账号已停用"不是 `AUTHENTICATION_REQUIRED`（那意味着
 * 没登录）而是 `FORBIDDEN_CAPABILITY`：调用方确实登录了，只是这个账号不再被允许动作。
 * 会话本身的可用性由 `authenticate()` 里的 `assertAccountSessionUsable` 判，不在这里重复。
 */
export function studentActorId(actor: Actor): UserId {
  if (actor.user.role !== 'STUDENT') {
    throw new DomainError('FORBIDDEN_CAPABILITY', 'Actor.role');
  }
  if (actor.user.status !== 'ACTIVE') {
    throw new DomainError('FORBIDDEN_CAPABILITY', 'Actor.status');
  }
  return actor.user.id;
}

/** 成人配置面动作的身份。理由同 `studentActorId` 的文件头。 */
export function ownerActorId(actor: Actor): string {
  if (actor.user.role !== 'OWNER') {
    throw new DomainError('FORBIDDEN_CAPABILITY', 'Actor.role');
  }
  if (actor.user.status !== 'ACTIVE') {
    throw new DomainError('FORBIDDEN_CAPABILITY', 'Actor.status');
  }
  return actor.user.id;
}

/**
 * 这个用户的凭据归谁。
 *
 * `null` 分支在良构库里不可达：`users` 的 `users_role_shape` CHECK 要求 STUDENT 必须
 * 有 `owner_id`。所以它不是"凭据未配置"（那是 `QCA_CREDENTIAL_NOT_CONFIGURED`，由
 * `owner_secrets` 的行缺失触发），而是行自身不自洽 —— 与 infra 把
 * `STORED_ROW_INCONSISTENT` 映射成 `INTERNAL_ERROR` 同一条口径。
 */
export function secretOwnerIdOf(user: User): string {
  if (user.role === 'OWNER') return user.id;
  if (user.ownerId === null) {
    throw new DomainError('INTERNAL_ERROR', 'User.ownerId');
  }
  return user.ownerId;
}

/**
 * 资源归属断言：不属于这个学生 ⇒ `RESOURCE_NOT_FOUND`，**不是** 403。
 *
 * 用 403 会把"这个 id 存在、只是不是你的"变成可探测事实。§11.1 步骤 6 逐字要求
 * 「学生 B 直接拿 A 的真实 project/task ID 请求项目、任务、事件、预览**全部 404 且无
 * 标题/prompt/URL 泄漏**」—— 404 与"不存在"必须是同一个响应形状，否则隔离等于没做。
 */
export function assertOwnedBy(ownerStudentId: UserId, actorStudentId: UserId): void {
  if (ownerStudentId !== actorStudentId) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Project.ownerStudentId');
  }
}

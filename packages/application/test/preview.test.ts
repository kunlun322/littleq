/**
 * `POST /projects/{id}/preview` 的用例测试（ZLQ-221 §4.1 / §4.5 / §11.1 步骤 6）。
 *
 * ## 这个文件钉住的四件事
 *
 * 1. **版本解析的三条出口**：显式 id / 缺省=当前版本 / 当前版本也没有。第三条是
 *    **422 `VERSION_NOT_PREVIEWABLE`** 而不是 404 —— 项目确实存在，学生刚刚还 `GET` 到过它，
 *    对着它说"查无此物"会让客户端去重试一个永远不会成功的请求。
 * 2. **跨项目取产物被挡住**。`loadOwnedVersion` 只证明"版本属于**这个学生**的某个项目"
 *    （它从 `version.projectId` 反查项目），所以学生拿自己 A 项目的 versionId 去请求
 *    B 项目的预览时，**归属检查会通过**。挡下它的是用例里多出来的那一次
 *    `version.projectId === project.id` 比较。所以那一条配了一个反面对照：先证明
 *    `loadOwnedVersion` 单独确实会放行，再证明用例挡住了 ⇒ 那条断言不是恒绿的。
 * 3. **可预览判据与 domain 同源**。真值表不手抄：穷举 `BUILD_STATUSES × SCAN_STATUSES`
 *    六个组合，期望值直接调 `isPreviewableVersion` 算。手抄的表会与 domain 悄悄漂移，
 *    于是 domain 改判据时这条测试**照样绿**。
 * 4. **签发入参与红线**：`artifactHash` 必须是**版本的** `artifactSha256`；`ttlSeconds`
 *    必须是**注入的**（换 harness 就换值 ⇒ 证明没写死）；`now` 必须是入参
 *    （这一层不读时钟）；不可预览时 `publishPreview` **一次都不能被调**；
 *    响应恰好三键（`url` 只进这里，不泄漏 `objectRef` / `artifactSha256`）；
 *    整个用例**零写库**（契约原文：「虽然是 POST，它不改项目状态」）。
 *
 * ## 反面对照纪律（与 `pump.test.ts` / `task-retry-rehold.test.ts` 同一条）
 *
 * 内存替身必须**真的会失败**。所以：每一条"抛错"都配一条"同样的替身、只差一个事实 ⇒ 成功"；
 * publisher 抛错那条配一个开关，先证明开关关上时是绿的。恒绿的断言不是证据 ——
 * 上一轮 F2 交付正是因为"看起来绿"而整条链其实是短路掉的。
 */
import { describe, expect, it } from 'vitest';
import {
  type AccountSession,
  type ArtifactDigest,
  type Project,
  type ProjectId,
  type ProjectVersion,
  type ProjectVersionId,
  type Timestamp,
  type User,
  BUILD_STATUSES,
  SCAN_STATUSES,
  createAccountSession,
  createProject,
  createProjectVersion,
  createUser,
  isPreviewableVersion,
  parseLoginName,
  parseLockDurationMinutes,
  parseMaxFailedAttempts,
  parseNickname,
  parseTimestamp,
} from '@littleq/domain';

import type { Actor } from '../src/usecases/authorization.js';
import type { PreviewPublisher, ProjectDirectory } from '../src/usecases/ports.js';
import { loadOwnedVersion } from '../src/usecases/projects.js';
import {
  createPreviewUseCase,
  type PreviewServices,
  type PreviewView,
} from '../src/usecases/preview.js';

// ---------------------------------------------------------------------------
// 事实（全部是常量，不读时钟 —— 与 `usecases/` 全层同一条约束）
// ---------------------------------------------------------------------------

const NOW = parseTimestamp('2026-10-22T03:04:05.000Z');
const EXPIRES_AT = parseTimestamp('2026-10-22T03:14:05.000Z');
const TTL_SECONDS = 600;

const LOCK_POLICY = {
  maxFailedAttempts: parseMaxFailedAttempts(5),
  lockDurationMinutes: parseLockDurationMinutes(30),
};

const OWNER_ID = '0198c0a1-0000-7000-8000-000000000001';
const STUDENT_ID = '0198c0a1-0000-7000-8000-000000000002';
const STRANGER_ID = '0198c0a1-0000-7000-8000-000000000009';

const PROJECT_ID = '0198c0a1-3333-7000-8000-000000000001';
/** 同一个学生的**另一个**项目：跨项目那条用例要用它。 */
const OTHER_PROJECT_ID = '0198c0a1-3333-7000-8000-000000000002';

const CURRENT_VERSION_ID = '0198c0a1-4444-7000-8000-000000000001';
const OLD_VERSION_ID = '0198c0a1-4444-7000-8000-000000000002';
const OTHER_PROJECT_VERSION_ID = '0198c0a1-4444-7000-8000-000000000003';
/** 库里根本不存在的 id：悬空指针与"项目不存在"两条用例各用一个。 */
const MISSING_VERSION_ID = '0198c0a1-4444-7000-8000-0000000000fe';
const MISSING_PROJECT_ID = '0198c0a1-3333-7000-8000-0000000000ff';

const CURRENT_ARTIFACT = 'a'.repeat(64) as ArtifactDigest;
const OLD_ARTIFACT = 'b'.repeat(64) as ArtifactDigest;
const PUBLISHED_URL = 'https://preview.invalid/g/0198c0a1';

function studentActor(userId: string = STUDENT_ID, loginName: string = 'kid'): Actor {
  const user: User = createUser({
    id: userId,
    role: 'STUDENT',
    loginName: parseLoginName(loginName),
    nickname: parseNickname(loginName),
    ageBand: 'L1',
    status: 'ACTIVE',
    ownerId: OWNER_ID,
    lockPolicy: LOCK_POLICY,
    revision: '1',
  });
  const session: AccountSession = createAccountSession({
    id: '0198c0a1-1111-7000-8000-000000000001',
    userId: user.id,
    status: 'ACTIVE',
    rememberMe: false,
    issuedAt: NOW,
    lastSeenAt: NOW,
    idleExpiresAt: parseTimestamp('2026-10-22T03:34:05.000Z'),
    absoluteExpiresAt: parseTimestamp('2026-10-29T03:04:05.000Z'),
    revokedAt: null,
    revocationReason: null,
  });
  return { user, session };
}

// ---------------------------------------------------------------------------
// 内存"数据库"与替身
// ---------------------------------------------------------------------------

interface PublishCall {
  readonly projectId: string;
  readonly projectVersionId: string;
  readonly artifactHash: string;
  readonly ttlSeconds: number;
  readonly now: string;
}

class MemoryStore {
  readonly projects = new Map<string, Project>();
  readonly versions = new Map<string, ProjectVersion>();
  /**
   * 任何**写**动作在这里留一条记录。预览用例必须让它保持为空 ——
   * 契约对这个 operation 的原文是「虽然是 POST，它不改项目状态」。
   */
  readonly writes: string[] = [];
}

class ProjectsDouble implements ProjectDirectory {
  constructor(private readonly store: MemoryStore) {}

  async findById(projectId: ProjectId): Promise<Project | null> {
    return this.store.projects.get(String(projectId)) ?? null;
  }

  async findVersionById(versionId: ProjectVersionId): Promise<ProjectVersion | null> {
    return this.store.versions.get(String(versionId)) ?? null;
  }

  // 下面四个方法预览用例**不该**碰到。抛错而不是返回空值：返回空会让"用例走错了一条路"
  // 表现为一个莫名的 404 或一个空页面；抛错则直接指出是哪条不该被走的路被走了。
  async insert(): Promise<void> {
    this.store.writes.push('insert');
    throw new Error('预览用例不得写 projects 表（契约：它不改项目状态）');
  }
  async insertVersion(): Promise<void> {
    this.store.writes.push('insertVersion');
    throw new Error('预览用例不得写 versions 表');
  }
  async list(): Promise<never> {
    throw new Error('预览用例不得列出项目（那是 GET /projects 的路径）');
  }
  async listVersions(): Promise<never> {
    throw new Error('预览用例不得列出版本（那是 GET /projects/{id}/versions 的路径）');
  }
}

class PublisherDouble implements PreviewPublisher {
  readonly calls: PublishCall[] = [];
  /** 置 `true` 只给"签发失败原样传出"那条用例用。 */
  failWith: Error | null = null;

  async publishPreview(input: {
    readonly projectId: ProjectId;
    readonly projectVersionId: ProjectVersionId;
    readonly artifactHash: ArtifactDigest;
    readonly ttlSeconds: number;
    readonly now: Timestamp;
  }): Promise<{ readonly url: string; readonly expiresAt: Timestamp }> {
    this.calls.push({
      projectId: String(input.projectId),
      projectVersionId: String(input.projectVersionId),
      artifactHash: String(input.artifactHash),
      ttlSeconds: input.ttlSeconds,
      now: String(input.now),
    });
    if (this.failWith !== null) throw this.failWith;
    return { url: PUBLISHED_URL, expiresAt: EXPIRES_AT };
  }
}

// ---------------------------------------------------------------------------
// 固件
// ---------------------------------------------------------------------------

interface HarnessSeed {
  /** `null` ⇒ 项目没有当前版本（刚建好、还没跑完任何回合）。 */
  readonly currentVersionId?: string | null;
  readonly buildStatus?: string;
  readonly scanStatus?: string;
  readonly ttlSeconds?: number;
  /** 额外种一个属于**另一个项目**的版本，供跨项目那条用例用。 */
  readonly withOtherProjectVersion?: boolean;
  /** 额外种一个旧版本（不是当前版本），供"显式 id 走的是所指版本"那条用例用。 */
  readonly withOldVersion?: boolean;
}

interface Harness {
  readonly store: MemoryStore;
  readonly publisher: PublisherDouble;
  readonly services: PreviewServices;
  readonly actor: Actor;
  readonly previewOnce: (input?: {
    readonly actor?: Actor;
    readonly projectId?: string;
    readonly versionId?: string | null;
  }) => Promise<PreviewView>;
}

function makeVersion(input: {
  readonly id: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly artifactSha256: ArtifactDigest;
  readonly buildStatus: string;
  readonly scanStatus: string;
}): ProjectVersion {
  return createProjectVersion({
    id: input.id,
    projectId: input.projectId,
    sequence: input.sequence,
    parentVersionId: null,
    sourceTaskId: null,
    artifactSha256: input.artifactSha256,
    contractVersion: '1.0.0',
    fileCount: 2,
    totalBytes: 128,
    buildStatus: input.buildStatus,
    scanStatus: input.scanStatus,
    createdBy: STUDENT_ID,
    createdAt: NOW,
  });
}

function makeHarness(seed: HarnessSeed = {}): Harness {
  const store = new MemoryStore();
  const buildStatus = seed.buildStatus ?? 'VALID';
  const scanStatus = seed.scanStatus ?? 'PASS';
  // `currentVersionId` 缺省指向 CURRENT_VERSION_ID；显式传 `null` 才是"没有当前版本"。
  const currentVersionId =
    seed.currentVersionId === undefined ? CURRENT_VERSION_ID : seed.currentVersionId;

  const project = createProject({
    id: PROJECT_ID,
    ownerStudentId: STUDENT_ID,
    title: '会跳的小猫',
    workType: 'WEB',
    ageBand: 'L1',
    helpLevel: 'LV1',
    currentVersionId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.projects.set(String(project.id), project);

  if (currentVersionId !== null) {
    store.versions.set(
      CURRENT_VERSION_ID,
      makeVersion({
        id: CURRENT_VERSION_ID,
        projectId: PROJECT_ID,
        sequence: 2,
        artifactSha256: CURRENT_ARTIFACT,
        buildStatus,
        scanStatus,
      }),
    );
  }

  if (seed.withOldVersion === true) {
    store.versions.set(
      OLD_VERSION_ID,
      makeVersion({
        id: OLD_VERSION_ID,
        projectId: PROJECT_ID,
        sequence: 1,
        artifactSha256: OLD_ARTIFACT,
        buildStatus: 'VALID',
        scanStatus: 'PASS',
      }),
    );
  }

  if (seed.withOtherProjectVersion === true) {
    const other = createProject({
      id: OTHER_PROJECT_ID,
      ownerStudentId: STUDENT_ID,
      title: '另一个作品',
      workType: 'WEB',
      ageBand: 'L1',
      helpLevel: 'LV1',
      currentVersionId: OTHER_PROJECT_VERSION_ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    store.projects.set(String(other.id), other);
    store.versions.set(
      OTHER_PROJECT_VERSION_ID,
      makeVersion({
        id: OTHER_PROJECT_VERSION_ID,
        projectId: OTHER_PROJECT_ID,
        sequence: 1,
        artifactSha256: OLD_ARTIFACT,
        buildStatus: 'VALID',
        scanStatus: 'PASS',
      }),
    );
  }

  const publisher = new PublisherDouble();
  const services: PreviewServices = {
    projects: new ProjectsDouble(store),
    preview: publisher,
    previewTtlSeconds: seed.ttlSeconds ?? TTL_SECONDS,
  };
  const actor = studentActor();

  return {
    store,
    publisher,
    services,
    actor,
    previewOnce(input) {
      return createPreviewUseCase(services, {
        actor: input?.actor ?? actor,
        projectId: (input?.projectId ?? PROJECT_ID) as ProjectId,
        versionId: (input?.versionId === undefined
          ? null
          : input.versionId) as ProjectVersionId | null,
        now: NOW,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 版本解析的三条出口
// ---------------------------------------------------------------------------

describe('createPreviewUseCase：版本解析', () => {
  it('缺省 versionId ⇒ 用项目的当前版本', async () => {
    const harness = makeHarness({ withOldVersion: true });
    const view = await harness.previewOnce();

    expect(view).toEqual({
      url: PUBLISHED_URL,
      expiresAt: EXPIRES_AT,
      versionId: CURRENT_VERSION_ID,
    });
    expect(harness.publisher.calls).toHaveLength(1);
    expect(harness.publisher.calls[0]?.projectVersionId).toBe(CURRENT_VERSION_ID);
    // 产物摘要必须是**当前版本**的那一份，不是旧版本的。
    expect(harness.publisher.calls[0]?.artifactHash).toBe(CURRENT_ARTIFACT);
  });

  it('显式 versionId ⇒ 走所指的那个版本（这里是旧版本，不是当前版本）', async () => {
    const harness = makeHarness({ withOldVersion: true });
    const view = await harness.previewOnce({ versionId: OLD_VERSION_ID });

    expect(view.versionId).toBe(OLD_VERSION_ID);
    expect(harness.publisher.calls[0]?.projectVersionId).toBe(OLD_VERSION_ID);
    expect(harness.publisher.calls[0]?.artifactHash).toBe(OLD_ARTIFACT);
    // §11.1 步骤 5：旧 Version N 仍保留可查看 —— 预览旧版本不需要它还是"当前"的。
    expect(view.url).toBe(PUBLISHED_URL);
  });

  it('没有当前版本 ⇒ 422 VERSION_NOT_PREVIEWABLE，而不是 404；且一次都不签发', async () => {
    const harness = makeHarness({ currentVersionId: null });

    const thrown = await harness.previewOnce().then(
      () => null,
      (error: unknown) => error as { code: string; valueObject?: string },
    );
    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe('VERSION_NOT_PREVIEWABLE');
    expect(thrown?.valueObject).toBe('Project.currentVersionId');
    // 项目**存在**，所以不能报"查无此物"：那会让客户端去重试一个永远不会成功的请求。
    expect(thrown?.code).not.toBe('RESOURCE_NOT_FOUND');
    expect(harness.publisher.calls).toHaveLength(0);
  });

  it('currentVersionId 是悬空指针 ⇒ 404，与"没有当前版本"分开', async () => {
    // 项目声称有当前版本，但那一行不在库里。这是数据不一致，不是"还没跑完回合"，
    // 两者若混成同一个码，运维就再也分不出该修数据还是该等任务。
    const harness = makeHarness();
    harness.store.versions.delete(CURRENT_VERSION_ID);

    await expect(harness.previewOnce()).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      valueObject: 'ProjectVersion',
    });
    expect(harness.publisher.calls).toHaveLength(0);
  });

  it('显式给了一个不存在的 versionId ⇒ 同一个 404 形状', async () => {
    const harness = makeHarness();

    await expect(harness.previewOnce({ versionId: MISSING_VERSION_ID })).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      valueObject: 'ProjectVersion',
    });
    expect(harness.publisher.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 归属与跨项目（§11.1 步骤 6）
// ---------------------------------------------------------------------------

describe('createPreviewUseCase：归属与跨项目', () => {
  it('陌生学生 ⇒ 404，且不泄漏任何字段、一次都不签发', async () => {
    const harness = makeHarness();
    const stranger = studentActor(STRANGER_ID, 'otherkid');

    await expect(harness.previewOnce({ actor: stranger })).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(harness.publisher.calls).toHaveLength(0);
  });

  it('项目不存在与项目不属于你 ⇒ 同一个 404 码（"存在吗"不可探测）', async () => {
    const harness = makeHarness();
    const stranger = studentActor(STRANGER_ID, 'otherkid');

    const missing = await harness.previewOnce({ projectId: MISSING_PROJECT_ID }).then(
      () => null,
      (error: unknown) => error as { code: string; valueObject?: string },
    );
    const foreign = await harness.previewOnce({ actor: stranger }).then(
      () => null,
      (error: unknown) => error as { code: string; valueObject?: string },
    );

    expect(missing?.code).toBe('RESOURCE_NOT_FOUND');
    expect(foreign?.code).toBe(missing?.code);
    expect(harness.publisher.calls).toHaveLength(0);
    // 两者的 `valueObject` **确实不同**（`Project` vs `Project.ownerStudentId`），但它不进
    // 契约：`packages/api-contract/src` 里 `valueObject` 零命中，所以它只是服务端诊断字段，
    // 不构成线上的可探测差异。把差异如实断言出来，比假装两者全同更有用 —— 谁将来把
    // `valueObject` 加进错误响应体，这条就是他会先撞上的那根钉子。
    expect(missing?.valueObject).toBe('Project');
    expect(foreign?.valueObject).toBe('Project.ownerStudentId');
  });

  it('拿自己另一个项目的 versionId ⇒ 404，且不签发', async () => {
    const harness = makeHarness({ withOtherProjectVersion: true });

    await expect(
      harness.previewOnce({ versionId: OTHER_PROJECT_VERSION_ID }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', valueObject: 'ProjectVersion' });
    expect(harness.publisher.calls).toHaveLength(0);
  });

  it('反面对照：少了那一次同项目比较，`loadOwnedVersion` 确实会放行', async () => {
    // 上一条"挡住跨项目"若没有这一条，就无法区分"用例真的多比了一次"与
    // "`loadOwnedVersion` 本来就挡住了"。后者是假的：它从 `version.projectId` 反查项目，
    // 于是"这个版本属于**这个学生**"成立，跨项目就一路通过了。
    const harness = makeHarness({ withOtherProjectVersion: true });

    const { project, version } = await loadOwnedVersion(harness.services, {
      actor: harness.actor,
      versionId: OTHER_PROJECT_VERSION_ID as ProjectVersionId,
    });
    // 归属检查通过了 —— 拿到的却是**另一个**项目。
    expect(String(project.id)).toBe(OTHER_PROJECT_ID);
    expect(String(project.id)).not.toBe(PROJECT_ID);
    expect(String(version.projectId)).toBe(OTHER_PROJECT_ID);
    expect(String(version.id)).toBe(OTHER_PROJECT_VERSION_ID);
    // 所以用例里那一次 `version.projectId === project.id` 比较是唯一挡住它的东西：
    // 把它删掉，上一条用例会从 404 变成"成功签发一个指向别人项目的 grant"。
    expect(String(version.projectId)).not.toBe(PROJECT_ID);
  });
});

// ---------------------------------------------------------------------------
// 3. 可预览判据（与 domain 同源，真值表不手抄）
// ---------------------------------------------------------------------------

describe('createPreviewUseCase：可预览判据', () => {
  it('穷举 BUILD_STATUSES × SCAN_STATUSES：成功当且仅当 domain 说可预览', async () => {
    // 期望值直接调 `isPreviewableVersion` 算，不手抄真值表：手抄的表会与 domain 悄悄
    // 漂移，于是 domain 改判据时这条测试**照样绿**。
    expect(BUILD_STATUSES).toEqual(['VALID', 'INVALID']);
    expect(SCAN_STATUSES).toEqual(['PASS', 'BLOCK', 'CONFIRM_REQUIRED']);

    const previewed: string[] = [];
    const refused: string[] = [];
    for (const buildStatus of BUILD_STATUSES) {
      for (const scanStatus of SCAN_STATUSES) {
        const harness = makeHarness({ buildStatus, scanStatus });
        const expected = isPreviewableVersion({ buildStatus, scanStatus });
        const combo = `${buildStatus}|${scanStatus}`;
        const view = await harness.previewOnce().then(
          (value) => value,
          () => null,
        );
        if (expected) {
          previewed.push(combo);
          expect(view, `${combo} 应当可预览`).not.toBeNull();
          expect(harness.publisher.calls).toHaveLength(1);
        } else {
          refused.push(combo);
          expect(view, `${combo} 应当被拒`).toBeNull();
          // 不可预览时**绝不签发**：一旦签出去，那份 grant 就撤不回来了
          // （`PreviewPublisher` 刻意不含 `revokePreview`）。
          expect(harness.publisher.calls).toHaveLength(0);
        }
      }
    }

    // 这两份清单是**独立写死**的交叉校验，不是从上面的循环推出来的：domain 若改了判据，
    // 循环里的断言与这里会一起红。（写这条用例时它当场抓到过一次我自己的算错 ——
    // 我原以为 `INVALID` 那一行也可预览，于是把数写成了 4；实际是 2。）
    expect(previewed).toEqual(['VALID|PASS', 'VALID|CONFIRM_REQUIRED']);
    expect(refused).toEqual([
      'VALID|BLOCK',
      'INVALID|PASS',
      'INVALID|BLOCK',
      'INVALID|CONFIRM_REQUIRED',
    ]);
  });

  it('INVALID ⇒ valueObject 指 buildStatus', async () => {
    const harness = makeHarness({ buildStatus: 'INVALID', scanStatus: 'PASS' });
    await expect(harness.previewOnce()).rejects.toMatchObject({
      code: 'VERSION_NOT_PREVIEWABLE',
      valueObject: 'ProjectVersion.buildStatus',
    });
  });

  it('BLOCK ⇒ valueObject 指 scanStatus（两个原因分开报，客户端不必猜）', async () => {
    const harness = makeHarness({ buildStatus: 'VALID', scanStatus: 'BLOCK' });
    await expect(harness.previewOnce()).rejects.toMatchObject({
      code: 'VERSION_NOT_PREVIEWABLE',
      valueObject: 'ProjectVersion.scanStatus',
    });
  });

  it('CONFIRM_REQUIRED ⇒ 允许预览（"确认"的前提正是看得见）', async () => {
    const harness = makeHarness({ scanStatus: 'CONFIRM_REQUIRED' });
    const view = await harness.previewOnce();
    expect(view.versionId).toBe(CURRENT_VERSION_ID);
    expect(harness.publisher.calls).toHaveLength(1);
  });

  it('显式 versionId 也过同一道判据（不能因为是"指定的"就放行）', async () => {
    const harness = makeHarness({ withOldVersion: true, scanStatus: 'PASS' });
    // 把旧版本改成 BLOCK：当前版本仍是 PASS，所以缺省路径会成功。
    const old = harness.store.versions.get(OLD_VERSION_ID);
    expect(old).toBeDefined();
    harness.store.versions.set(
      OLD_VERSION_ID,
      makeVersion({
        id: OLD_VERSION_ID,
        projectId: PROJECT_ID,
        sequence: 1,
        artifactSha256: OLD_ARTIFACT,
        buildStatus: 'VALID',
        scanStatus: 'BLOCK',
      }),
    );

    await expect(harness.previewOnce({ versionId: OLD_VERSION_ID })).rejects.toMatchObject({
      code: 'VERSION_NOT_PREVIEWABLE',
    });
    expect(harness.publisher.calls).toHaveLength(0);

    // 反面对照：同一个 harness、缺省路径 ⇒ 成功。证明上面那条红是因为**旧版本 BLOCK**，
    // 而不是因为替身整体坏了。
    const view = await harness.previewOnce();
    expect(view.versionId).toBe(CURRENT_VERSION_ID);
    expect(harness.publisher.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. 签发入参与红线
// ---------------------------------------------------------------------------

describe('createPreviewUseCase：签发入参与红线', () => {
  it('publishPreview 的每个入参都来自请求与版本，`now` 是入参而不是时钟', async () => {
    const harness = makeHarness();
    await harness.previewOnce();

    expect(harness.publisher.calls).toEqual([
      {
        projectId: PROJECT_ID,
        projectVersionId: CURRENT_VERSION_ID,
        artifactHash: CURRENT_ARTIFACT,
        ttlSeconds: TTL_SECONDS,
        now: String(NOW),
      },
    ]);
  });

  it('ttlSeconds 是注入的：换一个 harness 就换一个值（没有写死）', async () => {
    const short = makeHarness({ ttlSeconds: 60 });
    const long = makeHarness({ ttlSeconds: 3600 });
    await short.previewOnce();
    await long.previewOnce();

    expect(short.publisher.calls[0]?.ttlSeconds).toBe(60);
    expect(long.publisher.calls[0]?.ttlSeconds).toBe(3600);
    // 两条都成功 ⇒ 用例没有对 ttl 做任何自己的判断（数值属于部署配置）。
    expect(short.publisher.calls).toHaveLength(1);
    expect(long.publisher.calls).toHaveLength(1);
  });

  it('响应恰好三键，与 createPreviewResponseSchema 一一对应', async () => {
    const harness = makeHarness();
    const view = await harness.previewOnce();

    // 多一个键就是多一处泄漏面：`objectRef` / `artifactSha256` / `projectId` 都不得
    // 顺着响应出去（`url` 是唯一对外的读取入口）。
    expect(Object.keys(view).sort()).toEqual(['expiresAt', 'url', 'versionId']);
  });

  it('整个用例零写库（契约原文：虽然是 POST，它不改项目状态）', async () => {
    const harness = makeHarness();
    const before = harness.store.projects.get(PROJECT_ID);
    await harness.previewOnce();
    const after = harness.store.projects.get(PROJECT_ID);

    expect(harness.store.writes).toEqual([]);
    // 连项目行都不能被换成一个新对象（那意味着有人改了 revision / currentVersionId）。
    expect(after).toBe(before);
  });

  it('签发失败 ⇒ 原样传出，不吞、不降级成一个假 url', async () => {
    const harness = makeHarness();
    const boom = new Error('runtime publisher unreachable');
    harness.publisher.failWith = boom;

    await expect(harness.previewOnce()).rejects.toBe(boom);
    expect(harness.store.writes).toEqual([]);

    // 反面对照：同一个替身、开关关上 ⇒ 成功。证明上面那条红是 `failWith` 造成的。
    harness.publisher.failWith = null;
    const view = await harness.previewOnce();
    expect(view.url).toBe(PUBLISHED_URL);
    expect(harness.publisher.calls).toHaveLength(2);
  });
});

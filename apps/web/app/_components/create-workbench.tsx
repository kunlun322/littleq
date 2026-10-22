'use client';

/**
 * 四步闭环的第 2–4 步：建项目 → 发一句话 → 看到结果。
 *
 * ## 为什么浏览器要自己 pump
 *
 * `POST /tasks/{id}:pump` 的契约注释明确写着「前端轮询与多标签页都会落到
 * `COALESCED_IN_FLIGHT`」—— 也就是说**前端本来就是这条接口的预期调用方之一**，不是我们在
 * 客户端里偷偷实现了一个 worker。单飞由服务端的 `If-Match` revision CAS 与租约保证，
 * 所以两个标签页同时 pump 是安全的：一个推进，另一个拿到 200 `COALESCED_IN_FLIGHT`。
 *
 * 循环是**有界**的：`PUMP_MAX_ROUNDS` 次之后停下来，如实说「还在跑」，把继续推进交回给
 * 用户点一次按钮。无界循环等于让浏览器变成一个不知疲倦的打桩机 —— 后端一旦卡住，
 * 学生会看到一个转不完的圈，而服务端会收到一串没有尽头的请求。
 *
 * ## 第 4 步「看到真 AI 回复」到底看什么
 *
 * ⚠️ **契约里没有任何「AI 回复正文」字段。** `ProjectVersion` 只有产物摘要
 * （`artifactSha256`）与规模（`fileCount` / `totalBytes`），作品本体存在对象存储里，
 * 通过 `POST /projects/{id}/preview` 签发一个短期、独立源的地址来查看。所以这一步呈现的是
 * **这次生成的真实事实**（第几版、多少文件、构建与安全扫描结果）加上一个可打开的预览地址，
 * 而不是一个聊天气泡 —— 造一个气泡就得造一段正文，那就是硬编码假回复。
 *
 * ## 为什么「200 就算成功」是错的
 *
 * 契约规定 provider 失败**不**从 pump 同步返回，而是按 §5.5 记在任务上，以
 * **HTTP 200 + `task.error`** 暴露。所以完成判定必须同时看 `state` 与 `error`：
 * 只看状态码的话，一次模型调用失败会被显示成一切正常。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  LAYER_CODES,
  asCreatePreviewResponse,
  asGetProjectResponse,
  asProject,
  asTaskAccepted,
  asTaskPumpResult,
  callApi,
  describeCode,
  describeFailure,
  type ProjectView,
  type TaskView,
  type VersionView,
} from '../../src/api-client';
import {
  AGE_BANDS,
  EXPECTED_STATUS,
  HELP_LEVELS,
  ONLY_WORK_TYPE,
  PATHS,
  PUMP_OUTCOMES_THAT_CONTINUE,
  TERMINAL_TASK_STATES,
  newIdempotencyKey,
  toETag,
  type AgeBand,
  type HelpLevel,
} from '../../src/api-wire';
import {
  CREATE_AGE_BAND_LABEL,
  CREATE_ERROR_PREFIX,
  CREATE_HELP_LEVEL_LABEL,
  CREATE_HELP_LEVEL_LABELS,
  CREATE_PATH,
  CREATE_PREVIEW_HINT,
  CREATE_PREVIEW_LABEL,
  CREATE_PROJECT_SUBMIT_LABEL,
  CREATE_PROJECT_TITLE_LABEL,
  CREATE_PROJECT_TITLE_PLACEHOLDER,
  CREATE_TASK_ADVANCING_LABEL,
  CREATE_TASK_FACTS_LABELS,
  CREATE_TASK_HEADING,
  CREATE_TASK_IDLE_LABEL,
  CREATE_TASK_WAITING_LABEL,
  CREATE_TURN_LABEL,
  CREATE_TURN_PLACEHOLDER,
  CREATE_TURN_SUBMIT_LABEL,
  CREATE_VERSION_FACTS_LABELS,
  CREATE_VERSION_HEADING,
} from '../../src/site-content';

/** pump 循环的单次上限。到顶就停下来交回给用户，不无界打服务端。 */
const PUMP_MAX_ROUNDS = 60;

/** `nextRunAt` 缺席或已过期时的退避间隔。 */
const PUMP_IDLE_DELAY_MS = 1_000;

/** 退避的硬上限：`nextRunAt` 可以是几分钟之后，浏览器不该照着它睡那么久。 */
const PUMP_MAX_DELAY_MS = 5_000;

type PreviewView = { url: string; expiresAt: string; versionId: string };

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** 把 `nextRunAt` 换成一段毫秒数。读不出、已过期 ⇒ 用固定间隔。 */
function backoffFrom(nextRunAt: string | null): number {
  if (nextRunAt === null) return PUMP_IDLE_DELAY_MS;
  const at = Date.parse(nextRunAt);
  if (Number.isNaN(at)) return PUMP_IDLE_DELAY_MS;
  const delta = at - Date.now();
  if (delta <= 0) return PUMP_IDLE_DELAY_MS;
  return Math.min(delta, PUMP_MAX_DELAY_MS);
}

function isTerminal(state: string): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

function continues(outcome: string): boolean {
  return (PUMP_OUTCOMES_THAT_CONTINUE as readonly string[]).includes(outcome);
}

/**
 * 「形状不符合约定」这一类失败。
 *
 * 走 `describeCode(LAYER_CODES.badPayload, …)` 而不是把码写死在这里：码是本层常量，
 * 写死第二遍就等于制造了一个会漂移的副本。`detail` 追加在人话之后，指明是**哪一条**响应坏了。
 */
function badPayload(detail: string): string {
  return `${describeCode(LAYER_CODES.badPayload, CREATE_ERROR_PREFIX)}${detail}`;
}

export function CreateWorkbench({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [project, setProject] = useState<ProjectView | null>(null);
  const [task, setTask] = useState<TaskView | null>(null);
  const [version, setVersion] = useState<VersionView | null>(null);
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const [title, setTitle] = useState('');
  const [ageBand, setAgeBand] = useState<AgeBand>(AGE_BANDS[0]);
  const [helpLevel, setHelpLevel] = useState<HelpLevel>(HELP_LEVELS[1]);
  const [prompt, setPrompt] = useState('');

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /** 读一次项目聚合视图。刷新后能恢复，靠的就是 `?project=` 与这一次 GET。 */
  const loadProject = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const outcome = await callApi({
      method: 'GET',
      path: PATHS.project(projectId),
      expectedStatus: EXPECTED_STATUS.getProject,
      signal,
    });
    if (!outcome.ok) {
      setError(describeFailure(outcome.failure, CREATE_ERROR_PREFIX));
      return null;
    }
    const aggregate = asGetProjectResponse(outcome.value);
    if (aggregate === null) {
      setError(badPayload('项目数据形状不符合约定。'));
      return null;
    }
    setProject(aggregate.project);
    setTask(aggregate.activeTask);
    setVersion(aggregate.currentVersion);
    return aggregate;
  }, []);

  // 首屏：URL 上带项目 id 就把它读回来。用 ref 保证只跑一次 —— React 严格模式下
  // effect 会跑两遍，两遍都发 GET 不会出错（读是幂等的），但会白打一次服务端。
  const restoreRef = useRef(false);
  useEffect(() => {
    if (restoreRef.current) return;
    restoreRef.current = true;
    const projectId = searchParams.get('project');
    if (projectId === null || projectId === '') {
      setRestored(true);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    void loadProject(projectId, controller.signal).then(() => setRestored(true));
  }, [loadProject, searchParams]);

  /** 把项目 id 写进 URL。刷新后还能回来，靠的是地址栏，不是任何本地存储。 */
  const rememberProject = useCallback(
    (projectId: string) => {
      const query = new URLSearchParams(searchParams.toString());
      query.set('project', projectId);
      router.replace(`${CREATE_PATH}?${query.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const createProject = useCallback(async () => {
    if (busy !== null) return;
    setBusy(CREATE_PROJECT_SUBMIT_LABEL);
    setError(null);
    const outcome = await callApi({
      method: 'POST',
      path: PATHS.projects,
      expectedStatus: EXPECTED_STATUS.createProject,
      body: { title, workType: ONLY_WORK_TYPE, ageBand, helpLevel },
      csrfToken,
    });
    setBusy(null);
    if (!outcome.ok) {
      setError(describeFailure(outcome.failure, CREATE_ERROR_PREFIX));
      return;
    }
    const created = asProject(outcome.value);
    if (created === null) {
      setError(badPayload('项目数据形状不符合约定。'));
      return;
    }
    setProject(created);
    setTask(null);
    setVersion(null);
    setPreview(null);
    rememberProject(created.id);
  }, [ageBand, busy, csrfToken, helpLevel, rememberProject, title]);

  /**
   * 推进一个任务，直到它落进终态、或者用完本轮预算。
   *
   * `If-Match` 每次都用**上一次响应里的** revision，不是缓存的那个 —— 用陈旧 revision 会稳定
   * 收到 409 `REVISION_CONFLICT`。
   */
  const pumpTask = useCallback(
    async (projectId: string, initial: TaskView) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      let current = initial;
      setBusy(CREATE_TASK_ADVANCING_LABEL);
      setError(null);

      for (let round = 0; round < PUMP_MAX_ROUNDS; round += 1) {
        if (signal.aborted) break;
        if (isTerminal(current.state)) break;

        const outcome = await callApi({
          method: 'POST',
          path: PATHS.pump(current.id),
          expectedStatus: EXPECTED_STATUS.pumpTask,
          csrfToken,
          ifMatch: toETag(current.revision),
          signal,
        });
        if (!outcome.ok) {
          if (!signal.aborted) setError(describeFailure(outcome.failure, CREATE_ERROR_PREFIX));
          break;
        }
        const pumped = asTaskPumpResult(outcome.value);
        if (pumped === null) {
          setError(badPayload('pump 响应形状不符合约定。'));
          break;
        }
        current = pumped.task;
        setTask(current);

        if (isTerminal(current.state)) break;
        if (!continues(pumped.outcome)) {
          // `NO_OP_WAITING` 是「在退避窗口里，等一会儿再来」，不是错误。
          await sleep(backoffFrom(current.nextRunAt), signal);
        }
      }

      setBusy(null);
      if (signal.aborted) return;
      // 落进终态后重新读一次聚合视图：新版本挂在 `project.currentVersion` 上，
      // 而 `task.resultVersionId` 只是它的 id。
      await loadProject(projectId, signal);
    },
    [csrfToken, loadProject],
  );

  /**
   * 发一句话。
   *
   * 幂等键每次点击生成一个新的：一次点击就是一个回合。契约的 `IDEMPOTENCY_KEY_REUSED` 针对
   * 的是**重放同一个键**，所以这里不做自动重试 —— 自动重试必须复用同一个键才有意义，
   * 而「失败了到底该重试还是该换一句话」是产品判断，本切片把它交给用户点第二次。
   */
  const sendTurn = useCallback(async () => {
    if (busy !== null || project === null) return;
    setBusy(CREATE_TURN_SUBMIT_LABEL);
    setError(null);
    const outcome = await callApi({
      method: 'POST',
      path: PATHS.turns(project.id),
      expectedStatus: EXPECTED_STATUS.createTurn,
      body: { prompt, baseRevision: project.revision },
      csrfToken,
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(null);
    if (!outcome.ok) {
      setError(describeFailure(outcome.failure, CREATE_ERROR_PREFIX));
      return;
    }
    const accepted = asTaskAccepted(outcome.value);
    if (accepted === null) {
      setError(badPayload('受理响应形状不符合约定。'));
      return;
    }
    // 202 只回 `taskId` 与**项目**的新 revision，不回 Task（契约刻意如此，避免两个接口的
    // 字段集合永远同步）。pump 要的是**任务**的 revision，所以先读一次聚合视图拿它。
    const aggregate = await loadProject(project.id);
    if (aggregate === null) return;
    if (aggregate.activeTask === null) {
      setError(badPayload('受理后没有活动任务。'));
      return;
    }
    await pumpTask(project.id, aggregate.activeTask);
  }, [busy, csrfToken, loadProject, project, prompt, pumpTask]);

  const openPreview = useCallback(async () => {
    if (busy !== null || project === null) return;
    setBusy(CREATE_PREVIEW_LABEL);
    setError(null);
    const outcome = await callApi({
      method: 'POST',
      path: PATHS.preview(project.id),
      expectedStatus: EXPECTED_STATUS.createPreview,
      body: {},
      csrfToken,
    });
    setBusy(null);
    if (!outcome.ok) {
      setError(describeFailure(outcome.failure, CREATE_ERROR_PREFIX));
      return;
    }
    const issued = asCreatePreviewResponse(outcome.value);
    if (issued === null) {
      setError(badPayload('预览响应形状不符合约定。'));
      return;
    }
    setPreview(issued);
  }, [busy, csrfToken, project]);

  const resume = useCallback(async () => {
    if (busy !== null || project === null || task === null) return;
    await pumpTask(project.id, task);
  }, [busy, project, task, pumpTask]);

  if (!restored) return <p className="lq-hint">正在恢复上一次的项目…</p>;

  // 单独取出来，而不是写 `task !== null && task.error !== null`：TS 的类型收窄不穿过一个
  // 布尔中间变量，取出来才能在 JSX 里直接读 `taskError.code` 而不必处处 `?.` 加兜底空串 ——
  // 那个空串会把「没有错误码」渲染成一句只有前缀的废话。
  const taskError = task?.error ?? null;

  return (
    <div className="lq-stack">
      {error !== null ? (
        <p className="lq-error" role="alert">
          {error}
        </p>
      ) : null}

      {project === null ? (
        <form
          className="lq-form lq-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void createProject();
          }}
          noValidate
        >
          <h2 className="lq-scope-title">第 2 步 · 建一个项目</h2>
          <div className="lq-field">
            <label className="lq-label" htmlFor="create-title">
              {CREATE_PROJECT_TITLE_LABEL}
            </label>
            <input
              className="lq-input"
              id="create-title"
              type="text"
              value={title}
              maxLength={120}
              placeholder={CREATE_PROJECT_TITLE_PLACEHOLDER}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="lq-field">
            <label className="lq-label" htmlFor="create-age-band">
              {CREATE_AGE_BAND_LABEL}
            </label>
            <select
              className="lq-input"
              id="create-age-band"
              value={ageBand}
              onChange={(event) => setAgeBand(event.target.value as AgeBand)}
            >
              {AGE_BANDS.map((band) => (
                <option key={band} value={band}>
                  {band}
                </option>
              ))}
            </select>
          </div>
          <div className="lq-field">
            <label className="lq-label" htmlFor="create-help-level">
              {CREATE_HELP_LEVEL_LABEL}
            </label>
            <select
              className="lq-input"
              id="create-help-level"
              value={helpLevel}
              onChange={(event) => setHelpLevel(event.target.value as HelpLevel)}
            >
              {HELP_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {CREATE_HELP_LEVEL_LABELS[level]}
                </option>
              ))}
            </select>
          </div>
          <button className="lq-button" type="submit" disabled={busy !== null}>
            {busy === CREATE_PROJECT_SUBMIT_LABEL ? '建项目中…' : CREATE_PROJECT_SUBMIT_LABEL}
          </button>
        </form>
      ) : (
        <>
          <div className="lq-panel">
            <h2 className="lq-scope-title">项目</h2>
            <dl className="lq-definition">
              <dt>{CREATE_PROJECT_TITLE_LABEL}</dt>
              <dd>{project.title}</dd>
              <dt>项目 id</dt>
              <dd>
                <code className="lq-code">{project.id}</code>
              </dd>
              <dt>revision</dt>
              <dd>
                <code className="lq-code">{project.revision}</code>
              </dd>
            </dl>
          </div>

          <form
            className="lq-form lq-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void sendTurn();
            }}
            noValidate
          >
            <h2 className="lq-scope-title">第 3 步 · 发一句话</h2>
            <div className="lq-field">
              <label className="lq-label" htmlFor="create-prompt">
                {CREATE_TURN_LABEL}
              </label>
              <textarea
                className="lq-input lq-input-multiline"
                id="create-prompt"
                value={prompt}
                rows={3}
                maxLength={2000}
                placeholder={CREATE_TURN_PLACEHOLDER}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </div>
            <button className="lq-button" type="submit" disabled={busy !== null}>
              {busy === CREATE_TURN_SUBMIT_LABEL ? '发送中…' : CREATE_TURN_SUBMIT_LABEL}
            </button>
          </form>

          <div className="lq-panel">
            <h2 className="lq-scope-title">{CREATE_TASK_HEADING}</h2>
            {task === null ? (
              <p className="lq-legal-card-body">{CREATE_TASK_IDLE_LABEL}</p>
            ) : (
              <>
                <dl className="lq-definition">
                  <dt>{CREATE_TASK_FACTS_LABELS.state}</dt>
                  <dd>
                    <code className="lq-code">{task.state}</code>
                  </dd>
                  <dt>{CREATE_TASK_FACTS_LABELS.stage}</dt>
                  <dd>{task.stage ?? '—'}</dd>
                  <dt>{CREATE_TASK_FACTS_LABELS.progress}</dt>
                  <dd>{Math.round(task.progress * 100)}%</dd>
                </dl>
                {busy === CREATE_TASK_ADVANCING_LABEL ? (
                  <p className="lq-hint" role="status">
                    {CREATE_TASK_ADVANCING_LABEL}
                  </p>
                ) : null}
                {taskError !== null ? (
                  <p className="lq-error" role="alert">
                    {describeCode(taskError.code, CREATE_ERROR_PREFIX)}
                  </p>
                ) : null}
                {!isTerminal(task.state) && busy === null ? (
                  <>
                    <p className="lq-hint">{CREATE_TASK_WAITING_LABEL}</p>
                    <div className="lq-actions">
                      <button className="lq-button" type="button" onClick={() => void resume()}>
                        继续推进
                      </button>
                    </div>
                  </>
                ) : null}
              </>
            )}
          </div>

          {version !== null ? (
            <div className="lq-panel">
              <h2 className="lq-scope-title">{CREATE_VERSION_HEADING}</h2>
              <dl className="lq-definition">
                <dt>{CREATE_VERSION_FACTS_LABELS.sequence}</dt>
                <dd>{version.sequence}</dd>
                <dt>{CREATE_VERSION_FACTS_LABELS.fileCount}</dt>
                <dd>{version.fileCount}</dd>
                <dt>{CREATE_VERSION_FACTS_LABELS.totalBytes}</dt>
                <dd>{version.totalBytes}</dd>
                <dt>{CREATE_VERSION_FACTS_LABELS.buildStatus}</dt>
                <dd>
                  <code className="lq-code">{version.buildStatus}</code>
                </dd>
                <dt>{CREATE_VERSION_FACTS_LABELS.scanStatus}</dt>
                <dd>
                  <code className="lq-code">{version.scanStatus}</code>
                </dd>
                <dt>{CREATE_VERSION_FACTS_LABELS.artifactSha256}</dt>
                <dd>
                  <code className="lq-code">{version.artifactSha256}</code>
                </dd>
                <dt>{CREATE_VERSION_FACTS_LABELS.createdAt}</dt>
                <dd>
                  <code className="lq-code">{version.createdAt}</code>
                </dd>
              </dl>
              <div className="lq-actions">
                <button
                  className="lq-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void openPreview()}
                >
                  {CREATE_PREVIEW_LABEL}
                </button>
              </div>
              {preview !== null ? (
                <>
                  <p className="lq-hint">{CREATE_PREVIEW_HINT}</p>
                  <p className="lq-legal-card-body">
                    <a
                      className="lq-link"
                      href={preview.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {preview.url}
                    </a>
                  </p>
                  <p className="lq-hint">
                    有效期至 <code className="lq-code">{preview.expiresAt}</code>
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

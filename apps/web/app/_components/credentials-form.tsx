/**
 * 凭据录入表单（客户端组件，ZLQ-236 D-2）。
 *
 * ## 这一层能说什么、不能说什么
 *
 * **不能说值。** 后端读模型结构上就没有那个字段（§5.5「永不含 value」），`PUT` 成功只回 204
 * 且不带响应体（`packages/api-contract` 的快照里那一条 204 没有 `content`，
 * `test/api-wire.test.ts` 把这件事钉住了）。所以本组件**没有任何一条路径**能把已存的凭据
 * 渲染出来 —— 不是「记得别渲染」，是手里根本没有那个数据。`asSecretMetadata` 只认三个键，
 * 多回来的字段连类型上都读不到。
 *
 * **不能造还没接线的功能。** `:rotate` / `:revoke` 在后端没有接线（一律 404）。所以这里
 * 没有「更换」「撤销」按钮，也**没有一个 `type="button"`**：`e2e/smoke.spec.ts` 的
 * `strayButtons` 判据是「不是 submit、或不在 form 里的按钮」一律算假入口，于是「点了没反应
 * 的按钮」在 e2e 层就是红的。同理也没有「显示 / 隐藏值」的切换 —— 那需要一个手里有值的
 * 状态，而上面刚说过没有。
 *
 * ## 三件刻意的事
 *
 * 1. **成功判据是契约写死的 204**（`EXPECTED_STATUS.putSecret`），不是「任何 2xx」。
 * 2. **保存成功立刻清空输入 state**，然后重读一次元数据。重读不是装饰：它是「写进去的
 *    东西真的落到了存储里」这条因果链上唯一能被这一页自己观察到的事实。
 * 3. **失败时展示后端真实返回的码。** `describeFailure` 只在我们认识的那几个码上翻成人话，
 *    其余原样展示，绝不替后端圆场成「已保存」。
 *
 * ⚠️ 保存**失败**时不清空输入：那是用户刚粘进来的一串东西，清掉等于让他再找一遍。
 * 口令框只活在受控 state 里，不进日志、不进 URL、不进任何存储 API。
 */
'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import {
  asSecretMetadata,
  callApi,
  describeFailure,
  LAYER_CODES,
  type ApiFailure,
  type SecretMetadataView,
} from '../../src/api-client';
import { EXPECTED_STATUS, PATHS } from '../../src/api-wire';
import {
  SETTINGS_ERROR_PREFIX,
  SETTINGS_FORBIDDEN_HINT,
  SETTINGS_KIND_COPY,
  SETTINGS_LAST_ROTATED_LABEL,
  SETTINGS_LAST_ROTATED_NEVER,
  SETTINGS_LOAD_ERROR_PREFIX,
  SETTINGS_LOADING_LABEL,
  SETTINGS_PENDING_LABEL,
  SETTINGS_SAVED_HINT,
  SETTINGS_STATE_CONFIGURED,
  SETTINGS_STATE_MISSING,
  SETTINGS_SUBMIT_LABEL,
  SETTINGS_VALUE_HINT,
  SETTINGS_VALUE_LABEL,
  type SettingsKindRole,
} from '../../src/site-content';

/**
 * 一种凭据的完整描述。由服务端组件从 domain 的封闭集合算好后当 prop 传下来。
 *
 * `kind` 在这里只是**路径参数**：它会被 `encodeURIComponent` 之后拼进 `/settings/secrets/{kind}`。
 * 页面上给人看的是 `role` 对应的那段文案，`kind` 本身从不渲染成文字 —— 它长得像机器标识符，
 * 给成人用户看只会增加困惑，而且那正是原文门禁要挡的字样。
 */
export type CredentialDescriptor = {
  kind: string;
  role: SettingsKindRole;
};

type Phase = 'idle' | 'pending' | 'saved';

/** 后端表示「这个会话没有配置凭据的能力」的那个码。名字取自契约，不是前端猜的身份。 */
const FORBIDDEN_CODE = 'FORBIDDEN_CAPABILITY';

/**
 * 状态码对了、响应体却不是那三个键。
 *
 * 这一条**必须当失败处理，不能当「未配置」处理**：把读不懂的响应体解释成「还没有配置过」，
 * 等于让用户以为自己是第一次填，然后去覆盖一个其实已经存在的凭据。
 */
const BAD_PAYLOAD: ApiFailure = {
  status: 200,
  code: LAYER_CODES.badPayload,
  messageKey: null,
  retryable: false,
  traceId: null,
};

function CredentialCard({
  descriptor,
  csrfToken,
}: {
  descriptor: CredentialDescriptor;
  csrfToken: string;
}) {
  const copy = SETTINGS_KIND_COPY[descriptor.role];
  const [metadata, setMetadata] = useState<SecretMetadataView | null>(null);
  const [loading, setLoading] = useState(true);
  const [value, setValue] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const outcome = await callApi<unknown>({
        method: 'GET',
        path: PATHS.secret(descriptor.kind),
        expectedStatus: EXPECTED_STATUS.getSecretMetadata,
        signal,
      });
      if (signal?.aborted) return;
      setLoading(false);
      if (!outcome.ok) {
        setFailure(outcome.failure);
        setMessage(describeFailure(outcome.failure, SETTINGS_LOAD_ERROR_PREFIX));
        return;
      }
      const parsed = asSecretMetadata(outcome.value);
      if (parsed === null) {
        setFailure(BAD_PAYLOAD);
        setMessage(describeFailure(BAD_PAYLOAD, SETTINGS_LOAD_ERROR_PREFIX));
        return;
      }
      setFailure(null);
      setMessage(null);
      setMetadata(parsed);
    },
    [descriptor.kind],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (phase === 'pending' || value === '') return;
    setPhase('pending');
    setFailure(null);
    setMessage(null);

    const outcome = await callApi<null>({
      method: 'PUT',
      path: PATHS.secret(descriptor.kind),
      expectedStatus: EXPECTED_STATUS.putSecret,
      body: { value },
      csrfToken,
    });

    if (!outcome.ok) {
      setPhase('idle');
      setFailure(outcome.failure);
      setMessage(describeFailure(outcome.failure, SETTINGS_ERROR_PREFIX));
      return;
    }

    // 204 到手：服务端一个字节都没回。先把输入清掉，再去读一次「已配置」这个事实。
    setValue('');
    setPhase('saved');
    await load();
  }

  const busy = phase === 'pending';
  const forbidden = failure?.code === FORBIDDEN_CODE;
  const configured = metadata?.configured === true;

  return (
    <div className="lq-panel">
      <h2 className="lq-scope-title">
        {copy.name}
        <span className="lq-hint">（{copy.necessityLabel} · {copy.purpose}）</span>
      </h2>

      <p className="lq-legal-card-body">{copy.why}</p>
      <p className="lq-legal-card-body">{copy.missingImpact}</p>

      <p className="lq-hint" role="status">
        {loading
          ? SETTINGS_LOADING_LABEL
          : configured
            ? `${SETTINGS_STATE_CONFIGURED} · ${SETTINGS_LAST_ROTATED_LABEL}：${
                metadata?.lastRotatedAt ?? SETTINGS_LAST_ROTATED_NEVER
              }`
            : `${SETTINGS_STATE_MISSING} · ${SETTINGS_LAST_ROTATED_LABEL}：${SETTINGS_LAST_ROTATED_NEVER}`}
      </p>

      {forbidden ? <p className="lq-error">{SETTINGS_FORBIDDEN_HINT}</p> : null}

      <form className="lq-form" onSubmit={submit} noValidate>
        <div className="lq-field">
          <label className="lq-label" htmlFor={`secret-value-${descriptor.role}`}>
            {SETTINGS_VALUE_LABEL}
          </label>
          <input
            className="lq-input"
            id={`secret-value-${descriptor.role}`}
            name="value"
            type="password"
            autoComplete="off"
            required
            minLength={1}
            maxLength={8192}
            placeholder={copy.placeholder}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="lq-hint">{SETTINGS_VALUE_HINT}</p>
        </div>

        <button className="lq-button" type="submit" disabled={busy}>
          {busy ? SETTINGS_PENDING_LABEL : SETTINGS_SUBMIT_LABEL}
        </button>

        {phase === 'saved' ? (
          <p className="lq-hint" role="status">
            {SETTINGS_SAVED_HINT}
          </p>
        ) : null}

        {message !== null ? (
          <p className="lq-error" role="alert">
            {message}
          </p>
        ) : null}
      </form>
    </div>
  );
}

export function CredentialsForm({
  csrfToken,
  descriptors,
}: {
  csrfToken: string;
  descriptors: readonly CredentialDescriptor[];
}) {
  // 这一层刻意什么都不做：状态各自关在自己的卡片里，于是一种凭据保存失败不会把另一种的
  // 输入框一起清空，一次读状态失败也不会让另一张卡片跟着报错。
  return (
    <div className="lq-section">
      {descriptors.map((descriptor) => (
        <CredentialCard key={descriptor.kind} descriptor={descriptor} csrfToken={csrfToken} />
      ))}
    </div>
  );
}

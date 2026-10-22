/**
 * 登录表单（客户端组件）。
 *
 * 三条不能妥协的地方：
 *
 * 1. **用 `fetch`，不用表单原生提交。** `apps/web/vercel.json` 的 CSP 里 `form-action 'none'`
 *    是既有裁定，原生提交会被浏览器直接拦掉；所以这里 `preventDefault()` 之后走同源
 *    `/api/v1/*`（`connect-src 'self'` 覆盖）。
 * 2. **口令只活在受控输入的 state 里。** 不写日志、不进 URL、不进任何存储 API，
 *    也不由前端做哈希 —— 传输与存储策略是后端的事。
 * 3. **失败时展示后端真实返回的错误码。** `describeFailure` 只在码是我们认识的那几个时
 *    翻成人话，其余一律原样展示，绝不替后端圆场成「登录成功」。
 *
 * 成功判据是**契约写死的 204**（`EXPECTED_STATUS.login`），不是「任何 2xx」。
 * 这是反空壳交付的铰链：一个永远返回 200 的假端点过不了这里。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { callApi, describeFailure } from '../../src/api-client';
import { EXPECTED_STATUS, PATHS } from '../../src/api-wire';
import {
  CREATE_PATH,
  LOGIN_ERROR_PREFIX,
  LOGIN_NAME_LABEL,
  LOGIN_PASSWORD_LABEL,
  LOGIN_PENDING_LABEL,
  LOGIN_REMEMBER_LABEL,
  LOGIN_SUBMIT_LABEL,
  LOGIN_SUCCESS_HINT,
} from '../../src/site-content';

type Phase = 'idle' | 'pending' | 'done';

export function LoginForm() {
  const router = useRouter();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (phase === 'pending') return;
    setPhase('pending');
    setError(null);

    const outcome = await callApi<null>({
      method: 'POST',
      path: PATHS.login,
      expectedStatus: EXPECTED_STATUS.login,
      body: { loginName, password, rememberMe },
    });

    if (!outcome.ok) {
      setPhase('idle');
      setError(describeFailure(outcome.failure, LOGIN_ERROR_PREFIX));
      return;
    }

    // 204 到手，会话 Cookie 由后端以 HttpOnly 落下。前端一个字节都读不到，也不该读。
    setPhase('done');
    router.push(CREATE_PATH);
    router.refresh();
  }

  const busy = phase !== 'idle';

  return (
    <form className="lq-form" onSubmit={submit} noValidate>
      <div className="lq-field">
        <label className="lq-label" htmlFor="login-name">
          {LOGIN_NAME_LABEL}
        </label>
        <input
          className="lq-input"
          id="login-name"
          name="loginName"
          type="text"
          autoComplete="username"
          required
          minLength={1}
          maxLength={64}
          value={loginName}
          disabled={busy}
          onChange={(event) => setLoginName(event.target.value)}
        />
      </div>

      <div className="lq-field">
        <label className="lq-label" htmlFor="login-password">
          {LOGIN_PASSWORD_LABEL}
        </label>
        <input
          className="lq-input"
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={1}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <div className="lq-field lq-field-inline">
        <input
          id="login-remember"
          name="rememberMe"
          type="checkbox"
          checked={rememberMe}
          disabled={busy}
          onChange={(event) => setRememberMe(event.target.checked)}
        />
        <label className="lq-label" htmlFor="login-remember">
          {LOGIN_REMEMBER_LABEL}
        </label>
      </div>

      <button className="lq-button" type="submit" disabled={busy}>
        {phase === 'pending' ? LOGIN_PENDING_LABEL : LOGIN_SUBMIT_LABEL}
      </button>

      {phase === 'done' ? (
        <p className="lq-hint" role="status">
          {LOGIN_SUCCESS_HINT}
        </p>
      ) : null}

      {error !== null ? (
        <p className="lq-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

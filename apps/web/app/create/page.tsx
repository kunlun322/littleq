/**
 * 创作工作台（ZLQ-232 四步闭环的第 2–4 步）。
 *
 * ## 为什么这一页必须是服务端组件
 *
 * 因为 CSRF 令牌要由**服务端**从 Cookie 里读出来再当 prop 传给客户端组件。CSRF 令牌存在一个
 * **非** HttpOnly 的伴随 Cookie 里（`packages/application/src/usecases/auth.ts` 的
 * `IssuedSession.csrfToken`），所以浏览器侧其实读得到 —— 但 `apps/web/test/index.test.ts`
 * 里「凭证载体零命中」那条断言把**浏览器侧读 Cookie 的那个 DOM API** 一起扫，而那条断言是
 * 对的：一旦开了这个口子，下一个用它的人就会顺手把会话 Cookie 也读了。所以本仓库的规矩是
 * **浏览器侧一个字都不读 Cookie**，令牌一律从服务端下发。（那条断言扫的是原文，所以这里
 * 只能用中文描述它，不能把那个 API 的名字写出来 —— 写了就自己把它染红。）
 *
 * 调 `cookies()` 会让这条路由自动转为动态渲染，因此不需要（也不该）再写一遍
 * `export const dynamic = 'force-dynamic'`。
 *
 * ## 没有令牌时说什么
 *
 * 读不到伴随 Cookie，就说明这台浏览器上没有会话。此时**不渲染工作台**，而是如实说「需要先
 * 登录」并给一个真链接 —— 不假装登录态，也不渲染一堆点了会 401 的按钮。
 *
 * ⚠️ 这里有一个**跨文件面待协调项**：伴随 Cookie 的名字在仓库里任何地方都没有定义过
 * （`auth.ts` 只写了「非 HttpOnly 的伴随 cookie」，名字由 HTTP 适配层决定，而那一层属于
 * ZLQ-221 的文件面）。本仓库里这个名字**只出现在 `src/csrf.ts:23` 一处**，所以一旦定名不同，
 * 改一个字符串即可。名字不匹配时的表现是：本页一直显示「需要先登录」，即使会话本身有效。
 * 已在交付评论里升级给 PM，不自行裁定。
 */
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';

import { CreateWorkbench } from '../_components/create-workbench';
import { CSRF_COOKIE_NAME } from '../../src/csrf';
import {
  CREATE_HEADING,
  CREATE_LEAD,
  CREATE_NEEDS_LOGIN_BODY,
  CREATE_NEEDS_LOGIN_HEADING,
  LOGIN_PATH,
  NAV_LOGIN_LABEL,
} from '../../src/site-content';

export const metadata: Metadata = {
  title: '创作工作台',
  description: '建一个项目，用一句话描述你想要的网页，然后查看 AI 真正生成的结果。',
};

export default async function CreatePage() {
  const store = await cookies();
  const csrfToken = store.get(CSRF_COOKIE_NAME)?.value ?? null;

  return (
    <section className="lq-section" aria-labelledby="create-title">
      <div className="lq-container lq-narrow">
        <h1 id="create-title" className="lq-section-title">
          {CREATE_HEADING}
        </h1>
        <p className="lq-section-lead">{CREATE_LEAD}</p>

        {csrfToken === null ? (
          <div className="lq-panel">
            <h2 className="lq-scope-title">{CREATE_NEEDS_LOGIN_HEADING}</h2>
            <p className="lq-legal-card-body">{CREATE_NEEDS_LOGIN_BODY}</p>
            <div className="lq-actions">
              <a className="lq-cta" href={LOGIN_PATH}>
                {NAV_LOGIN_LABEL}
              </a>
            </div>
          </div>
        ) : (
          /* `useSearchParams()` 需要一个 Suspense 边界，否则整条路由会在构建期退回客户端渲染。 */
          <Suspense fallback={<p className="lq-hint">正在读取工作台…</p>}>
            <CreateWorkbench csrfToken={csrfToken} />
          </Suspense>
        )}
      </div>
    </section>
  );
}

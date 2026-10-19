/**
 * 源码与许可证页（ZLQ-190 §7 D5）。
 *
 * AGPL-3.0 §13 对「通过网络提供服务」的作品有额外义务：用户必须能从服务本身
 * 拿到对应版本的完整源码。本页就是这个义务的落点，所以它必须公开显示四样东西 ——
 * `AGPL-3.0-only`、**完整**提交 SHA、构建版本、以及**指向那个提交**的源码地址。
 *
 * 「指向那个提交」是重点：链接不能挂在浮动的 `main` 上，否则部署产物与其源码
 * 会随着后续提交悄悄错位，§13 的对应关系就断了。提交号来自 `VERCEL_GIT_COMMIT_SHA`，
 * 本地构建回落到当前 Git HEAD（见 `src/build-info.ts`）。
 *
 * `NEXT_PUBLIC_LITTLEQ_SOURCE_URL` 是给合法 fork 用的**非机密**构建变量，
 * 缺省即上游仓库。它最终会进 `<a href>`，所以 `build-info.ts` 里强制校验协议必须是
 * http(s) —— 否则就是一个 `javascript:` 注入口。
 */
import type { Metadata } from 'next';

import { resolveBuildInfo } from '../../src/build-info';
import { LEGAL_FILES, LICENSE_ID } from '../../src/site-content';

export const metadata: Metadata = {
  title: '源码与许可证',
  description: 'LittleQ 的开源许可证、构建版本与对应提交的源码获取方式（AGPL-3.0 §13）。',
};

export default function SourceAndLicensePage() {
  const build = resolveBuildInfo();

  return (
    <section className="lq-section" aria-labelledby="legal-title">
      <div className="lq-container lq-legal-grid">
        <div>
          <h1 id="legal-title" className="lq-section-title">
            源码与许可证
          </h1>
          <p className="lq-section-lead">
            LittleQ 以 AGPL-3.0 开源。按该许可证第 13 条，通过网络使用本服务的用户
            有权取得与本部署版本对应的完整源码，下面给出了精确到提交的获取方式。
          </p>
        </div>

        <div className="lq-legal-card">
          <h2 className="lq-legal-card-title">本部署版本</h2>
          <dl className="lq-definition">
            <dt>许可证</dt>
            <dd>
              <code className="lq-code">{LICENSE_ID}</code>
            </dd>
            <dt>构建版本</dt>
            <dd>
              <code className="lq-code">{build.version}</code>
            </dd>
            <dt>提交 SHA</dt>
            <dd>
              <code className="lq-code">{build.commitSha}</code>
            </dd>
            <dt>源码地址</dt>
            <dd>
              <a className="lq-link" href={build.commitTreeUrl} rel="noreferrer">
                {build.commitTreeUrl}
              </a>
            </dd>
            <dt>提交记录</dt>
            <dd>
              <a className="lq-link" href={build.commitUrl} rel="noreferrer">
                {build.commitUrl}
              </a>
            </dd>
          </dl>
        </div>

        <div className="lq-legal-card">
          <h2 className="lq-legal-card-title">法务文件</h2>
          <p className="lq-legal-card-body">
            以下文件由构建流程从仓库根目录与构建产物归因清单生成，随站点一同部署，
            不经过任何后端服务。
          </p>
          <ul className="lq-legal-file-list">
            {LEGAL_FILES.map((file) => (
              <li key={file.path}>
                <a className="lq-link" href={file.path}>
                  {file.label}
                </a>
                <code className="lq-code"> {file.path}</code>
              </li>
            ))}
          </ul>
        </div>

        <div className="lq-legal-card">
          <h2 className="lq-legal-card-title">第三方组件</h2>
          <p className="lq-legal-card-body">
            第三方组件的名称、版本、许可证与归属声明见「第三方组件许可证清单」， 由 `pnpm
            license:third-party` 从锁文件与已批准的许可证裁定生成，
            禁止手工编辑。构建产物自身的归因清单另见 `/licenses.txt`。
          </p>
        </div>
      </div>
    </section>
  );
}

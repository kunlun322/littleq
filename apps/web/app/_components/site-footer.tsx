/**
 * 常驻页脚（ZLQ-190 §5.1 第 6 块 / §7 D5）。
 *
 * §7 要求这三样东西在**每一个页面**都出现：「源码与许可证」入口、当前提交短 SHA、
 * `AGPL-3.0-only`。放进 `app/layout.tsx` 就是为了让「常驻」不依赖任何页面的自觉 ——
 * 也满足 §7 那句「白标替换或后续工作不得删除 AGPL 条目」。
 *
 * 提交号在**服务端**解析（`src/build-info.ts`）：ZLQ-232 起 `apps/web` 是服务构建，
 * 静态页在 `next build` 时预渲染、动态页在请求时渲染，两种情况都跑在 Node 里，
 * 所以这里可以安全地读 `VERCEL_GIT_COMMIT_SHA` 或回落到 `git rev-parse HEAD`。
 * 解析失败时它是抛错而不是返回 `'unknown'` —— 一个占位值会让 e2e 和发布门禁全绿，
 * 而 §13 的源码入口其实已经断了，那比构建失败糟得多。
 */
import { resolveBuildInfo } from '../../src/build-info';
import {
  FOOTER_SOURCE_LABEL,
  LICENSE_ID,
  SITE_NAME,
  SOURCE_AND_LICENSE_PATH,
} from '../../src/site-content';

export function SiteFooter() {
  const build = resolveBuildInfo();

  return (
    <footer className="lq-footer">
      <div className="lq-container lq-footer-inner">
        <ul className="lq-footer-list">
          <li>
            <a className="lq-link" href={SOURCE_AND_LICENSE_PATH}>
              {FOOTER_SOURCE_LABEL}
            </a>
          </li>
          <li>{LICENSE_ID}</li>
          <li>© 2026 LittleQ contributors</li>
        </ul>
        <p className="lq-footer-commit">
          {SITE_NAME} · 构建 {build.version} · 提交{' '}
          <a className="lq-link" href={build.commitUrl} rel="noreferrer">
            <code className="lq-code">{build.shortCommitSha}</code>
          </a>
        </p>
      </div>
    </footer>
  );
}

/**
 * 站点头部（ZLQ-190 §5.3：DOM 顺序必须是 header → main → section → footer）。
 *
 * 放在 `app/layout.tsx` 而不是各个页面里，是为了让这个顺序**在结构上不可能被单个页面破坏**：
 * 布局负责 header / main / footer 三段，页面只负责 main 内部的 section 与那唯一的 h1。
 *
 * 导航里放的都是**真实可去的目的地**，一律用次要链接样式 `.lq-link`，
 * 把主行动样式 `.lq-cta` 留给首页那一处 —— 全站只能有一个「主行动」。
 */
import {
  CREATE_PATH,
  FOOTER_SOURCE_LABEL,
  LOGIN_PATH,
  NAV_LOGIN_LABEL,
  PRIMARY_ACTION_LABEL,
  SITE_NAME,
  SOURCE_AND_LICENSE_PATH,
} from '../../src/site-content';

export function SiteHeader() {
  return (
    <header className="lq-header">
      <div className="lq-container lq-header-inner">
        <span className="lq-wordmark">
          <span className="lq-wordmark-mark" aria-hidden="true" />
          {SITE_NAME}
        </span>
        <nav className="lq-header-nav" aria-label="站内导航">
          <a className="lq-link" href={CREATE_PATH}>
            {PRIMARY_ACTION_LABEL}
          </a>
          <a className="lq-link" href={LOGIN_PATH}>
            {NAV_LOGIN_LABEL}
          </a>
          <a className="lq-link" href={SOURCE_AND_LICENSE_PATH}>
            {FOOTER_SOURCE_LABEL}
          </a>
        </nav>
      </div>
    </header>
  );
}

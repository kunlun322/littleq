/**
 * 首页（ZLQ-190 §5.1）。
 *
 * §5.1 要求首页有 **6 个真实内容块**，一个都不许省：品牌英雄区、诚实状态条、
 * 三张分龄卡片、交付范围说明、唯一主行动、常驻页脚。前 5 块在这里，
 * 第 6 块（页脚）在 `app/layout.tsx`，因为「常驻」必须是结构性的。
 *
 * 两条不能妥协的地方：
 *
 * - **不是空壳占位页**（设计 D3 的硬要求）。所以这里没有任何「即将上线」的
 *   模糊话术，状态条写死了本次真实开放的能力与真实未开放的项，交付范围块把
 *   已交付与未开放逐项列清。
 * - **不是用完即弃**（D3 的另一半）。M1 及以后是在这同一个产物上继续长，
 *   所以文案全部来自 `src/site-content.ts` 常量、卡片内容来自 `@littleq/design-system`，
 *   页面本身只负责结构。
 *
 * 唯一的 `h1` 是英雄区标题（§5.3）。全站只有一个主行动：`PRIMARY_ACTION_LABEL`
 * 指向 `CREATE_PATH`。ZLQ-190 禁的是**假入口**（点了没反应的按钮），
 * 不是「登录 / 开始创作」这些词本身 —— 所以这里的判据是**动作真实性**：
 * 每一个可点的东西背后都有一个真的会响应的端点或真的存在的页面。
 */
import { UNIT_ID } from '@littleq/design-system';

import { AgeBandCards } from './_components/age-band-cards';
import { Duckling } from './_components/duckling';
import {
  AGE_BANDS_HEADING,
  AGE_BANDS_LEAD,
  CREATE_PATH,
  FOOTER_SOURCE_LABEL,
  HERO_LEAD,
  HERO_TITLE,
  PRIMARY_ACTION_LABEL,
  SCOPE_DELIVERED_ENTRIES,
  SCOPE_DELIVERED_HEADING,
  SCOPE_DELIVERED_ITEMS,
  SCOPE_UNAVAILABLE_HEADING,
  SCOPE_UNAVAILABLE_ITEMS,
  SOURCE_AND_LICENSE_PATH,
  STATUS_BODY,
  STATUS_HEADING,
} from '../src/site-content';

export default function HomePage() {
  return (
    <>
      {/* 第 1 块：品牌英雄区。data-design-system-unit 证明视觉基线真的取自 workspace 包。 */}
      <section
        className="lq-section"
        aria-labelledby="hero-title"
        data-design-system-unit={UNIT_ID}
      >
        <div className="lq-container lq-hero">
          <div>
            <h1 id="hero-title" className="lq-hero-title">
              {HERO_TITLE}
            </h1>
            <p className="lq-hero-lead">{HERO_LEAD}</p>
          </div>
          <Duckling />
        </div>
      </section>

      {/* 第 2 块：诚实状态条。措辞固定，不得弱化成「即将上线」。 */}
      <section className="lq-section" aria-labelledby="status-title">
        <div className="lq-container">
          <div className="lq-status" role="status">
            <h2 id="status-title" className="lq-status-heading">
              {STATUS_HEADING}
            </h2>
            <p className="lq-status-body">{STATUS_BODY}</p>
          </div>
        </div>
      </section>

      {/* 第 3 块：三个分龄档位，纯展示、不可交互。 */}
      <section className="lq-section" aria-labelledby="bands-title">
        <div className="lq-container">
          <h2 id="bands-title" className="lq-section-title">
            {AGE_BANDS_HEADING}
          </h2>
          <p className="lq-section-lead">{AGE_BANDS_LEAD}</p>
          <AgeBandCards />
        </div>
      </section>

      {/* 第 4 块：本次交付范围与明确的未开放项。 */}
      <section className="lq-section" aria-labelledby="scope-title">
        <div className="lq-container">
          <h2 id="scope-title" className="lq-section-title">
            本次开放了什么
          </h2>
          <div className="lq-scope">
            <div className="lq-scope-block">
              <h3 className="lq-scope-title">{SCOPE_DELIVERED_HEADING}</h3>
              {/*
                已交付的每一项都是**真链接**，指向真能走进去的那个页面（ZLQ-236 验收项 A）。

                为什么必须可点：这一栏曾经写着「成人 AI 凭据录入」，而路由表里没有那个页面 ——
                一句纯文字宣称，既有 e2e 抓不住它，因为 `expectEveryActionIsReal` 判的是
                「有没有点了没反应的假入口」，而纯文字根本没有可点的东西。把它变成链接之后，
                那条 e2e 就会顺手实测它 200，宣称与能力之间的漂移当场可见。
                `SCOPE_DELIVERED_ENTRIES` 的键集合与 `SCOPE_DELIVERED_ITEMS` 相等、且每个路径
                在 `app/` 下真有 `page.tsx`，这两条由 `test/index.test.ts` 两侧断言。
              */}
              <ul className="lq-scope-list">
                {SCOPE_DELIVERED_ITEMS.map((item) => (
                  <li key={item}>
                    <a className="lq-link" href={SCOPE_DELIVERED_ENTRIES[item]}>
                      {item}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="lq-scope-block">
              <h3 className="lq-scope-title">{SCOPE_UNAVAILABLE_HEADING}</h3>
              {/* 未开放项**刻意不是链接**：没有页面可去，做成链接就是假入口。 */}
              <ul className="lq-scope-list">
                {SCOPE_UNAVAILABLE_ITEMS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 第 5 块：全站唯一的主行动。它是真入口 —— 点进去就是能建项目、能发指令的工作台。 */}
      <section className="lq-section" aria-labelledby="cta-title">
        <div className="lq-container">
          <h2 id="cta-title" className="lq-section-title">
            现在就能做的一件事
          </h2>
          <p className="lq-section-lead">
            登录学生账号，建一个项目，用一句话描述你想要的网页，然后看 AI 真正生成的结果并打开预览。
          </p>
          <div className="lq-actions">
            <a className="lq-cta" href={CREATE_PATH}>
              {PRIMARY_ACTION_LABEL}
            </a>
            <a className="lq-link" href={SOURCE_AND_LICENSE_PATH}>
              {FOOTER_SOURCE_LABEL}
            </a>
          </div>
        </div>
      </section>
    </>
  );
}

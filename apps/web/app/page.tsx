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
 *   模糊话术，状态条写死了「创作、账号和 AI 功能尚未开放」，交付范围块把
 *   已交付与未开放逐项列清。
 * - **不是用完即弃**（D3 的另一半）。M1 及以后是在这同一个产物上继续长，
 *   所以文案全部来自 `src/site-content.ts` 常量、卡片内容来自 `@littleq/design-system`，
 *   页面本身只负责结构。
 *
 * 唯一的 `h1` 是英雄区标题（§5.3）。全站只有一个主行动，就是那句「查看源码与许可证」；
 * 「开始创作 / 登录 / 立即体验」这类假入口一个都不出现，因为它们背后的功能还不存在。
 */
import { UNIT_ID } from '@littleq/design-system';

import { AgeBandCards } from './_components/age-band-cards';
import { Duckling } from './_components/duckling';
import {
  AGE_BANDS_HEADING,
  AGE_BANDS_LEAD,
  HERO_LEAD,
  HERO_TITLE,
  PRIMARY_ACTION_LABEL,
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
            本次切片交付了什么
          </h2>
          <div className="lq-scope">
            <div className="lq-scope-block">
              <h3 className="lq-scope-title">{SCOPE_DELIVERED_HEADING}</h3>
              <ul className="lq-scope-list">
                {SCOPE_DELIVERED_ITEMS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="lq-scope-block">
              <h3 className="lq-scope-title">{SCOPE_UNAVAILABLE_HEADING}</h3>
              <ul className="lq-scope-list">
                {SCOPE_UNAVAILABLE_ITEMS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 第 5 块：全站唯一的主行动。 */}
      <section className="lq-section" aria-labelledby="cta-title">
        <div className="lq-container">
          <h2 id="cta-title" className="lq-section-title">
            现在能做的唯一一件事
          </h2>
          <p className="lq-section-lead">
            本切片没有任何产品功能可用，因此不提供「开始创作 / 登录 / 立即体验」这类入口。
            真实可去的目的地只有一个：查看源码与许可证。
          </p>
          <a className="lq-cta" href={SOURCE_AND_LICENSE_PATH}>
            {PRIMARY_ACTION_LABEL}
          </a>
        </div>
      </section>
    </>
  );
}

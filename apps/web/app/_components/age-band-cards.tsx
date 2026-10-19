/**
 * 三个分龄档位卡片（ZLQ-190 §5.1 第 3 块 / §5.2）。
 *
 * 内容**不在本文件里**：`AGE_BANDS` 来自 `@littleq/design-system`，
 * 视觉密度（字号倍率、行长、间距、圆角、文字颜色）来自同一包的 `tokens.css`
 * 三组 `--lq-density-l{1,2,3}-*` 变量。这正是 §5.2「应用侧不得另立一套分龄变量」
 * 的落地方式：这里只做「把元数据映射到既有的密度类名」，不重复任何取值。
 *
 * §5.1 明确这三张卡片**不可交互**：没有链接、没有按钮、没有 onClick，
 * 因为「点击进入某个功能」在当前切片里还不存在，做出来就是假入口。
 */
import { AGE_BANDS } from '@littleq/design-system';
import type { DensityTier } from '@littleq/design-system';

/**
 * `.lq-band` 自身已经绑定 L2 档变量（globals.css），所以只有 L1 / L3 需要修饰类。
 * 这个判断由 `densityTier` 派生，不是把档位名抄成一张常量表。
 */
function bandClassName(tier: DensityTier): string {
  return tier === 'l2' ? 'lq-band' : `lq-band lq-band--${tier}`;
}

export function AgeBandCards() {
  return (
    <div className="lq-band-grid">
      {AGE_BANDS.map((band) => (
        <article
          key={band.id}
          className={bandClassName(band.densityTier)}
          aria-label={band.label}
          data-age-band={band.id}
          data-density-tier={band.densityTier}
        >
          <p className="lq-band-id" aria-hidden="true">
            {band.id}
          </p>
          <h3 className="lq-band-name">{band.name}</h3>
          <p className="lq-band-summary">{band.summary}</p>
          <ul className="lq-band-traits">
            {band.traits.map((trait) => (
              <li key={trait} className="lq-band-trait">
                {trait}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

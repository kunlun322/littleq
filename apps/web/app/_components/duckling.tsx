/**
 * 小黄鸭吉祥物（ZLQ-190 §5.1 第 1 块 / §5.3）。
 *
 * 全部造型来自仓库内原创的纯 CSS 几何（见 `app/globals.css` 的 `.lq-duckling-*`），
 * 不引入任何第三方图片、字体或远程 CDN —— 这是 §1.2 的硬性要求，也是 e2e
 * 「不得出现第三方资源请求」这条断言能成立的前提。
 *
 * 无障碍处理（§5.3 同时要求「有文本替代」与「装饰性片段对辅助技术隐藏」）：
 * 外层容器整体作为一张图片（`role="img"` + `aria-label`），内部五个纯装饰的
 * 几何部件逐个 `aria-hidden`，于是读屏只会听到一次文字替代，不会念出五个空 span。
 */
import { MASCOT_ALT } from '../../src/site-content';

const PARTS = ['body', 'head', 'beak', 'eye', 'wing'] as const;

export function Duckling() {
  return (
    <div className="lq-duckling" role="img" aria-label={MASCOT_ALT}>
      {PARTS.map((part) => (
        <span key={part} className={`lq-duckling-${part}`} aria-hidden="true" />
      ))}
    </div>
  );
}

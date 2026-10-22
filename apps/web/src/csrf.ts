/**
 * 双提交 CSRF 的两个名字。
 *
 * ## 为什么 apps/web 要自己写一份
 *
 * 契约包里已经有 `CSRF_HEADER_NAME`，但 `apps/web` **不许**依赖契约包
 * （`config/dependency-graph.json` 的 `api-contract-no-platform-coupling`）。所以这里重述，
 * 并由 `apps/web/test/api-wire.test.ts` 逐字比对 —— 契约改了而这里没跟上会红。
 * 那份比对同样是**读契约源文件的文本**而不是 import：那条规则的 `inbound.default: deny`
 * 对 `apps/web/test/**` 一样生效，测试目录不是豁免区。
 *
 * ## ⚠️ Cookie 名是一处**未对账**的跨文件面协调项
 *
 * 全仓搜不到这个 Cookie 名的任何既有定义（`littleq_csrf` / `CSRF_COOKIE` / `csrfCookie`
 * 在 packages、apps、config 下命中数都是 0），而下发它的是 API 层，不是这里。本切片按
 * 双提交模式的最小约定，取那个**已被常设裁定冻结的会话 Cookie 名**的同族命名
 * `littleq_csrf`，**并且只在这一个常量里出现一次**：如果后端选了别的名字，改这一个字符串
 * 即可，不需要动任何组件。
 *
 * 会话 Cookie 的名字本文件**不写出它** —— 连注释里都不写，因为
 * `apps/web/test/index.test.ts` 里「冻结的会话 Cookie 名零命中」那条断言是**连注释一起扫**
 * 的（`apps/web` 对会话 Cookie 只做不透明转发，浏览器侧从不读它的值）。这也是一个提醒：
 * 那条断言扫的是原文，所以「解释这条门禁的散文」自己也会把它染红。
 */

/** 可读（非 HttpOnly）的 CSRF Cookie 名。只由服务端组件读取，见 `app/create/page.tsx`。 */
export const CSRF_COOKIE_NAME = 'littleq_csrf';

/** 写接口必须带的 CSRF 头名。抄自契约的 `CSRF_HEADER_NAME`。 */
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/** 幂等写必须带的头名。抄自契约的 `idempotencyHeaderSchema`。 */
export const IDEMPOTENCY_HEADER_NAME = 'Idempotency-Key';

/** 条件写的头名。抄自契约的 `ifMatchHeaderSchema`。 */
export const IF_MATCH_HEADER_NAME = 'If-Match';

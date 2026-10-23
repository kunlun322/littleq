import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { AGE_BANDS } from '../packages/design-system/src/age-bands.js';
import { PROXY_ERROR_CODES } from '../apps/web/src/api-proxy.js';
import {
  AGE_BANDS_HEADING,
  CREATE_HEADING,
  CREATE_NEEDS_LOGIN_HEADING,
  CREATE_PATH,
  FOOTER_SOURCE_LABEL,
  HERO_TITLE,
  LAYER_ERROR_EXPLANATIONS,
  LEGAL_FILES,
  LICENSE_ID,
  LOGIN_ERROR_PREFIX,
  LOGIN_HEADING,
  LOGIN_NAME_LABEL,
  LOGIN_PASSWORD_LABEL,
  LOGIN_PATH,
  LOGIN_SUBMIT_LABEL,
  LOGIN_SUCCESS_HINT,
  MASCOT_ALT,
  NAV_LOGIN_LABEL,
  PRIMARY_ACTION_LABEL,
  SCOPE_DELIVERED_HEADING,
  SCOPE_DELIVERED_ITEMS,
  SCOPE_UNAVAILABLE_HEADING,
  SCOPE_UNAVAILABLE_ITEMS,
  SETTINGS_ALREADY_CONFIGURED_NOTE,
  SETTINGS_HEADING,
  SETTINGS_NEEDS_LOGIN_HEADING,
  SETTINGS_PATH,
  SITE_NAME,
  SOURCE_AND_LICENSE_PATH,
  STATUS_BODY,
  STATUS_HEADING,
} from '../apps/web/src/site-content.js';
import { BUNDLE_ORIGIN, DEAD_API_ORIGIN, SITE_ORIGIN } from './origins.js';

/**
 * ZLQ-190 §6.2 的 e2e smoke。**ZLQ-232 起加载的是服务构建产物**：`playwright.config.ts`
 * 用 `next start` 起 `apps/web/.next`，不再是静态导出的 `apps/web/out` —— 那一份已经不存在了。
 *
 * 四件事在这里被证明，缺一件就不该发布：
 *   1. 页面内容与设计文档 §5.1/§5.3 一致，且文案与分龄元数据**引自源码常量**，
 *      不是在 spec 里重抄一遍 —— 重抄会让「改文案」变成「改两处、忘一处、测试照样绿」。
 *   2. 站点自给自足：没有任何第三方资源请求，未操作时没有 API 调用（§1.2 / §8 D6）。
 *   3. AGPL §13 的源码可获取性出现在**部署产物**里，而不只是仓库里（验收标准 5）。
 *   4. 四步闭环的入口是**真的**：页面渲染出真控件与真链接，同源代理在服务形态下失败关闭。
 *
 * 另外保留 §6.1 要求的两条旧断言，但它们现在打到**另一个 origin**：esbuild 合规 bundle
 * 不再是站点产物，不能用它的绿来冒充站点的绿。
 *
 * 刻意不做的事：不断言页面元素总数、不断言某次运行的用例总数。这两者都是观测量，
 * 写进契约就变成「以后谁加了个 section 就得来改数字」，而数字本身并不表达任何要求。
 *
 * ⚠️ 也刻意**不**在这里断言四步闭环整环跑通。§8.2 已经点破这件事：「首页未操作时仍可
 * 没有 API 请求，不能借此证明功能」—— 反过来同样成立：后端还是骨架时，一条要求登录成功的
 * 断言只会把 e2e-smoke 变成结构性常红。所以这里证的是**入口真实性与失败关闭**，
 * 「用户亲手点完四步、刷新后数据还在」那条最终验收挂在【发布】单上。
 */

const BUNDLE_URL = `${BUNDLE_ORIGIN}/artifacts/bundles/web.js`;

interface BundleExports {
  unitManifest: { unitId: string; layer: string; skeletonOnly: boolean; composedOf: string[] };
  isContractLoadable: () => boolean;
}

/** AGPL §13 的源码可获取性只允许这一个站外去处。 */
const EXTERNAL_SOURCE_HOST = 'github.com';

/**
 * ZLQ-190 §5.1 禁的是**假入口**（点了没反应的按钮），不是「登录 / 开始创作」这些词本身。
 * 四步闭环上线之后那些词背后已经有真的页面了，于是判据从「禁词表」换成**动作真实性**：
 * 页面上每一个链接都必须真的能去（同源链接逐个实测 200），每一个按钮都必须挂在
 * 一个真的会被处理的表单里。
 *
 * 为什么不继续用禁词表：禁词表在骨架期是**正确**的（那时「登录」确实点了没反应），
 * 但在功能期它会反过来把真入口判成违规，逼人把文案改模糊来骗过测试 —— 那正好是 §5.1
 * 要防的「即将上线」式含糊。真实性判据没有这个反向激励：想让它绿，只能把功能做出来。
 *
 * ⚠️ 按钮那条规则只适用于**没有工作台**的页面（首页、法务页、登录页、未登录的创作页）。
 * 工作台上「继续推进」「打开作品预览」是游离按钮但有真 handler，别把这条规则搬过去，
 * 也别为了让它通用而把断言削弱成「按钮存在即可」。
 */
async function expectEveryActionIsReal(page: Page, request: APIRequestContext): Promise<void> {
  const anchors = await page.locator('a').evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: (node.textContent ?? '').trim(),
      href: (node as HTMLAnchorElement).href,
    })),
  );
  // 反向对照：上面那个循环若因为一个链接都没取到而空转，就等于没测。
  expect(anchors.length, '一个链接都没取到，真实性断言空转了').toBeGreaterThan(0);

  for (const anchor of anchors) {
    expect(anchor.href, `链接「${anchor.name}」没有目标`).not.toBe('');
    expect(anchor.href, `链接「${anchor.name}」是页内锚点，点了等于没点`).not.toMatch(/#$/);
    expect(anchor.href, `链接「${anchor.name}」不是 http(s) 目标`).toMatch(/^https?:\/\//);

    const url = new URL(anchor.href);
    if (url.origin !== SITE_ORIGIN) {
      expect(url.hostname, `链接「${anchor.name}」指向了未申报的站外主机 ${url.hostname}`).toBe(
        EXTERNAL_SOURCE_HOST,
      );
      continue;
    }
    const response = await request.get(anchor.href);
    expect(
      response.status(),
      `链接「${anchor.name}」→ ${anchor.href} 是假入口：实测 ${response.status()}`,
    ).toBe(200);
  }

  const strayButtons = await page.locator('button').evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const button = node as HTMLButtonElement;
        return button.type !== 'submit' || button.closest('form') === null;
      })
      .map((node) => (node.textContent ?? '').trim()),
  );
  expect(strayButtons, `存在不属于任何表单提交的可点按钮（假入口）`).toEqual([]);
}

/**
 * 那个必然连不上的上游地址的 `host:port` 形式。
 *
 * 泄露检查要同时挡两种写法：整条 origin（`http://127.0.0.1:1`）与只有主机（`127.0.0.1:1`）。
 * 从常量算而不是在断言里写字面量，是为了让「喂给服务的值」与「不许出现在页面里的值」
 * 只能是同一个事实 —— 改了 `playwright.config.ts` 那一侧，这里的检查自动跟着改。
 */
const DEAD_API_HOST = new URL(DEAD_API_ORIGIN).host;

/** 40 位完整 SHA / 7 位短 SHA。不钉具体值：每次提交都会变，钉了就是把观测量写成契约。 */
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{7,}$/;

function watchNetwork(page: Page) {
  const requests: Request[] = [];
  const responses: Response[] = [];
  page.on('request', (request) => requests.push(request));
  page.on('response', (response) => responses.push(response));
  return { requests, responses };
}

function describeRequests(requests: readonly Request[]) {
  return requests.map((request) => `${request.method()} ${request.url()}`).join('\n');
}

/**
 * 「没有第三方资源、没有 API、没有认证跳转」的可执行形式。
 * 允许集合只有站点自己的 origin —— 这条断言同时覆盖了 §8 D6 的零 API / 零凭证
 * 与 §1.2 的「不引第三方图片、字体或远端 CDN」。
 */
function expectSiteIsolation(requests: readonly Request[], responses: readonly Response[]) {
  const detail = describeRequests(requests);
  const offSite = requests.filter((request) => new URL(request.url()).origin !== SITE_ORIGIN);
  expect(offSite, `出现站点外的请求：\n${describeRequests(offSite)}`).toEqual([]);

  const apiCalls = requests.filter((request) =>
    new URL(request.url()).pathname.startsWith('/api/'),
  );
  expect(apiCalls, `出现 API 调用：\n${describeRequests(apiCalls)}`).toEqual([]);

  const authish = requests.filter((request) =>
    /login|signin|sign-in|authorize|oauth|session|callback/i.test(request.url()),
  );
  expect(authish, `出现认证相关请求：\n${describeRequests(authish)}`).toEqual([]);

  // 401/403 是「这里有个需要凭证的东西」的信号；本切片零认证，出现即违约。
  const denied = responses.filter((response) => [401, 403].includes(response.status()));
  expect(
    denied.map((response) => `${response.status()} ${response.url()}`),
    `出现需要凭证的响应，全量请求：\n${detail}`,
  ).toEqual([]);
}

test.describe('站点首页：内容与设计文档一致', () => {
  test('品牌、标题与设计系统单元标记都在', async ({ page }) => {
    const { requests, responses } = watchNetwork(page);
    await page.goto('/');

    expect(page.locator('header .lq-wordmark')).toContainText(SITE_NAME);
    await expect(page).toHaveTitle(new RegExp(SITE_NAME));

    // 单一 h1（§5.3）：这是设计要求，不是元素计数覆盖率。
    const h1 = page.locator('h1');
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText(HERO_TITLE);

    // §5.2 的硬要求：英雄区根节点必须自报消费了哪个设计系统单元。
    const hero = page.locator('[data-design-system-unit="@littleq/design-system"]');
    await expect(hero).toHaveCount(1);

    expectSiteIsolation(requests, responses);
  });

  test('诚实状态条逐字命中，不含糊其辞', async ({ page }) => {
    await page.goto('/');
    const status = page.locator('[role="status"]');
    await expect(status).toHaveCount(1);
    // 逐字相等，而不是「包含某个关键词」：这条文案是产品对用户的承诺，
    // 被改成模糊说法（例如只留「建设中」）必须让测试红。
    await expect(status.locator('.lq-status-heading')).toHaveText(STATUS_HEADING);
    await expect(status.locator('.lq-status-body')).toHaveText(STATUS_BODY);
  });

  test('三个分龄档位的内容与元数据全部来自设计系统包', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h2', { hasText: AGE_BANDS_HEADING })).toHaveCount(1);

    // 循环体由 AGE_BANDS 驱动：新增/删除档位不需要改这里，改元数据会自动被断言到。
    for (const band of AGE_BANDS) {
      const card = page.locator(`[data-age-band="${band.id}"]`);
      await expect(card, `${band.id} 卡片缺失`).toHaveCount(1);
      // §5.1 的完整文案（`L1 · 启蒙探索`）作为卡片的可访问名承载，
      // 视觉上则由 id 徽标 + 名称标题呈现，两者不重复。
      await expect(card).toHaveAccessibleName(band.label);
      await expect(card).toHaveAttribute('data-density-tier', band.densityTier);
      await expect(card.locator('.lq-band-name')).toHaveText(band.name);
      await expect(card.locator('.lq-band-summary')).toHaveText(band.summary);
      const traits = card.locator('.lq-band-trait');
      await expect(traits).toHaveText([...band.traits]);
    }
  });

  test('分龄密度令牌真的在浏览器里生效，而不只是躺在 CSS 文本里', async ({ page }) => {
    await page.goto('/');

    const fontSizeOf = async (tier: string) =>
      Number.parseFloat(
        await page
          .locator(`[data-density-tier="${tier}"]`)
          .evaluate((node) => getComputedStyle(node).fontSize),
      );

    // §5.1 要求 L1「大字号」、L3 信息更密。字号单调递减是这个语义的可测量后果：
    // 删掉 tokens.css、删掉修饰类、或把三档接到同一个变量上，这条都会红。
    const [l1, l2, l3] = [await fontSizeOf('l1'), await fontSizeOf('l2'), await fontSizeOf('l3')];
    expect(l1, 'L1 与 L2 字号相同 —— 密度令牌没生效').toBeGreaterThan(l2);
    expect(l2, 'L2 与 L3 字号相同 —— 密度令牌没生效').toBeGreaterThan(l3);

    // 令牌确实进了产物的自定义属性（只断言「有值」，不断言具体色值：
    // 色值是设计数据，改了不该让 e2e 红，WCAG 对比度由 tokens.css 的注释与设计系统测试负责）。
    const ink = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--lq-color-ink').trim(),
    );
    expect(ink, '--lq-color-ink 为空 —— tokens.css 没有到达浏览器').not.toBe('');
  });

  test('交付范围如实陈述，未开放的功能没有任何假入口', async ({ page, request }) => {
    await page.goto('/');

    for (const item of SCOPE_DELIVERED_ITEMS) {
      await expect(
        page.locator('.lq-scope-block', { hasText: SCOPE_DELIVERED_HEADING }),
        `「本次已交付」里少了 ${item}`,
      ).toContainText(item);
    }
    for (const item of SCOPE_UNAVAILABLE_ITEMS) {
      await expect(
        page.locator('.lq-scope-block', { hasText: SCOPE_UNAVAILABLE_HEADING }),
        `「尚未开放」里少了 ${item}`,
      ).toContainText(item);
    }

    // §5.1：唯一主行动。断言的是「主行动的文案集合恰好等于这一个」，
    // 而不是页面上有几个元素 —— 多一个假 CTA 就会让这个集合变大从而变红。
    // ZLQ-232 起它指向创作工作台；指向法务页那一份降级成次要链接 `.lq-link`。
    await expect(page.locator('.lq-cta')).toHaveText([PRIMARY_ACTION_LABEL]);
    await expect(page.locator('.lq-cta')).toHaveAttribute('href', CREATE_PATH);

    await expectEveryActionIsReal(page, request);

    // 首页是纯内容 + 链接：一个表单都不该有。这条不是元素计数覆盖率，
    // 而是「首页不该藏一个没接线的前端交互外壳」。登录表单在 /login/，见下面那一组。
    await expect(page.locator('form')).toHaveCount(0);
  });

  test('无障碍与动画约束（§5.3）', async ({ page }) => {
    await page.goto('/');

    // 地标顺序：header → main → footer，且 footer 常驻（§7 要求它在每个页面）。
    const landmarks = await page.evaluate(() =>
      [...document.querySelectorAll('body > *')].map((node) => node.tagName.toLowerCase()),
    );
    expect(landmarks.filter((tag) => ['header', 'main', 'footer'].includes(tag))).toEqual([
      'header',
      'main',
      'footer',
    ]);

    // CSS 几何小黄鸭：外层是一个整体图像并带文字替代，内部装饰片段对读屏隐藏。
    const duckling = page.locator('.lq-duckling');
    await expect(duckling).toHaveAttribute('role', 'img');
    await expect(duckling).toHaveAttribute('aria-label', MASCOT_ALT);
    const parts = duckling.locator('[aria-hidden="true"]');
    expect(await parts.count(), '装饰片段没有全部对读屏隐藏').toBeGreaterThan(0);
    await expect(duckling.locator(':not([aria-hidden])')).toHaveCount(0);

    // 键盘焦点可见：令牌里定义了 focus-ring，这里验证它真的落到了计算样式上。
    const focusRing = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--lq-focus-ring-color').trim(),
    );
    expect(focusRing, '--lq-focus-ring-color 为空').not.toBe('');

    // 无自动播放动画：任何元素都不该带 animation-name。
    const animated = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((node) => {
          const name = getComputedStyle(node).animationName;
          return name !== '' && name !== 'none';
        })
        .map((node) => `${node.tagName.toLowerCase()}.${node.className}`),
    );
    expect(animated, '出现自动播放动画，违反 §5.3').toEqual([]);
  });

  test('页脚常驻：开源入口、许可证与构建提交（§5.1 / §7）', async ({ page }) => {
    await page.goto('/');
    const footer = page.locator('footer');
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText(LICENSE_ID);

    const sourceLink = footer.locator('a', { hasText: FOOTER_SOURCE_LABEL });
    await expect(sourceLink).toHaveAttribute('href', SOURCE_AND_LICENSE_PATH);

    // 提交链接必须落到具体 commit，不能是漂浮的分支。SHA 本身不钉死 —— 每次提交都变。
    const commitLink = footer.locator('.lq-footer-commit a');
    const href = await commitLink.getAttribute('href');
    expect(href, '页脚没有提交链接').toBeTruthy();
    expect(href).toMatch(/\/commit\/[0-9a-f]{40}$/);
    await expect(commitLink.locator('code')).toHaveText(SHORT_SHA);
  });
});

test.describe('源码与许可证页：AGPL §13 在部署产物里可见', () => {
  test('许可证、完整提交 SHA 与 commit 级源码链接', async ({ page }) => {
    const { requests, responses } = watchNetwork(page);
    await page.goto(SOURCE_AND_LICENSE_PATH);

    await expect(page.locator('h1')).toHaveText('源码与许可证');
    await expect(page.locator('main')).toContainText(LICENSE_ID);

    // 完整 SHA（不是短 SHA）：§7 要求页面上给出可核对的完整提交号。
    const shas = await page.locator('code').allTextContents();
    const full = shas.filter((text) => FULL_SHA.test(text.trim()));
    expect(full, `页面上找不到 40 位完整提交 SHA，实际取到：${JSON.stringify(shas)}`).toHaveLength(
      1,
    );
    const commitSha = full[0]!.trim();

    // 链接必须落到**这个 commit**：树上与提交记录两个入口都要，且都不许指向漂浮的分支。
    const hrefs = await page
      .locator('main a')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href));
    expect(
      hrefs.some((href) => href.endsWith(`/tree/${commitSha}`)),
      `没有指向该 commit 的源码树链接，实际链接：${JSON.stringify(hrefs)}`,
    ).toBe(true);
    expect(
      hrefs.some((href) => href.endsWith(`/commit/${commitSha}`)),
      `没有指向该 commit 的提交记录链接，实际链接：${JSON.stringify(hrefs)}`,
    ).toBe(true);
    for (const href of hrefs.filter((item) => /github\.com/.test(item))) {
      expect(href, `源码链接指向了漂浮的分支而不是具体提交：${href}`).not.toMatch(
        /\/(tree|commit|blob)\/(main|master)(\/|$)/,
      );
    }

    expectSiteIsolation(requests, responses);
  });

  test('四份法务文件都随产物部署且可公开取到', async ({ page, request }) => {
    await page.goto(SOURCE_AND_LICENSE_PATH);

    // 循环体由 site-content.ts 的 LEGAL_FILES 驱动，不是一份重抄的清单。
    for (const file of LEGAL_FILES) {
      await expect(
        page.locator('main a', { hasText: file.label }),
        `法务页上缺少指向 ${file.path} 的链接`,
      ).toHaveAttribute('href', file.path);

      const response = await request.get(`${SITE_ORIGIN}${file.path}`);
      expect(response.status(), `${file.path} 没有随产物部署（prepare-web-legal 没跑？）`).toBe(
        200,
      );
      expect((await response.text()).length, `${file.path} 是空文件`).toBeGreaterThan(0);
    }
  });

  test('第三方归属出现在部署产物里，而不只在仓库里（验收标准 5）', async ({ request }) => {
    // §6.3 要求 CC-BY-4.0 的归属（名称、版本、许可证）出现在随站点部署的法律页里。
    // 这条直接对**已部署形态**取证：从站点 origin 取文件，而不是读仓库里的工作副本。
    const response = await request.get(`${SITE_ORIGIN}/legal/THIRD_PARTY_LICENSES.txt`);
    expect(response.status()).toBe(200);
    const body = await response.text();

    expect(body, '部署产物里的第三方清单没有提到 caniuse-lite').toContain('caniuse-lite');
    expect(body, '部署产物里的第三方清单没有声明 CC-BY-4.0').toContain('CC-BY-4.0');
    // 归属不只是包名，还要有 SPDX 链接与许可证全文段（由生成器从已安装包收割）。
    expect(body).toContain('https://spdx.org/licenses/CC-BY-4.0.html');
    expect(body).toContain('Attribution 4.0 International');

    // AGPL 全文与 NOTICE 同样必须在产物里。
    expect(
      (await (await request.get(`${SITE_ORIGIN}/legal/AGPL-3.0.txt`)).text()).length,
    ).toBeGreaterThan(1000);
    const notice = await (await request.get(`${SITE_ORIGIN}/legal/NOTICE.txt`)).text();
    expect(notice).toContain('AGPL-3.0');
  });
});

test.describe('站点服务器自身的边界', () => {
  test('站点已经是服务形态：仓库内部文件与源码一律不可达', async ({ request }) => {
    // 契约变更（已申报）：站点不再是 `apps/web/out` 那份静态产物，而是 `next start` 起的
    // 服务构建。静态服务器那个 `/__health` 白名单报告随之消失 —— 服务形态下没有「白名单」
    // 这个概念，取而代之的是「Next 只路由到 app/ 里声明过的路由与 public/ 里的文件」。
    // 所以下面这些路径必须 404：既不是路由，也不在 public/ 里。
    for (const path of [
      '/package.json',
      '/config/license-policy.json',
      '/pnpm-lock.yaml',
      '/.git/config',
      '/%2e%2e/package.json',
      '/next.config.ts',
      '/src/api-proxy.ts',
      '/apps/web/src/api-proxy.ts',
    ]) {
      expect(
        (await request.get(`${SITE_ORIGIN}${path}`)).status(),
        `${path} 竟然可达 —— 服务形态把仓库内部文件暴露出去了`,
      ).toBe(404);
    }
    // 目录请求不列目录：Next 只按路由表应答，没有目录索引这回事。
    expect((await request.get(`${SITE_ORIGIN}/_next/static/`)).status()).toBe(404);

    // 阳性对照：同一台服务上，真路由与真静态文件是 200。少了这两条，上面那一串 404 可能
    // 只是「服务根本没起来」—— 那样这条测试会在一个坏掉的环境里照样绿。
    expect((await request.get(`${SITE_ORIGIN}/`)).status()).toBe(200);
    expect((await request.get(`${SITE_ORIGIN}/legal/NOTICE.txt`)).status()).toBe(200);
  });
});

test.describe('四步闭环的入口（无后端也能证的那一半）', () => {
  test('登录页渲染出真表单：口令框是 password 类型，提交按钮在表单里', async ({
    page,
    request,
  }) => {
    const { requests } = watchNetwork(page);
    await page.goto(LOGIN_PATH);

    await expect(page.locator('h1')).toHaveText(LOGIN_HEADING);
    await expect(page.locator('form')).toHaveCount(1);
    await expect(page.getByLabel(LOGIN_NAME_LABEL)).toBeVisible();

    // 口令框必须是 type=password：写成 text 会让口令在屏幕上明文可见，
    // 也会被浏览器与扩展当成普通字段记下来。
    const password = page.getByLabel(LOGIN_PASSWORD_LABEL);
    await expect(password).toBeVisible();
    await expect(password).toHaveAttribute('type', 'password');

    const submit = page.locator('form button[type="submit"]');
    await expect(submit).toHaveCount(1);
    await expect(submit).toHaveText(LOGIN_SUBMIT_LABEL);
    await expect(submit).toBeEnabled();

    await expectEveryActionIsReal(page, request);

    // 打开登录页本身不发任何 API 请求。§8.2：这**不**证明功能可用，只证明没有偷偷打点。
    const apiCalls = requests.filter((item) => new URL(item.url()).pathname.startsWith('/api/'));
    expect(apiCalls, `登录页一打开就发 API 请求：\n${describeRequests(apiCalls)}`).toEqual([]);
  });

  test('浏览器里点登录：请求真的走到代理，失败如实上报，绝不假装成功', async ({ page }) => {
    await page.goto(LOGIN_PATH);

    const apiResponses: Response[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/')) apiResponses.push(response);
    });

    await page.getByLabel(LOGIN_NAME_LABEL).fill('e2e-probe');
    await page.getByLabel(LOGIN_PASSWORD_LABEL).fill('not-a-real-password');
    await page.locator('form button[type="submit"]').click();

    // ⚠️ 不用 `page.locator('[role="alert"]')`：Next 的 App Router 会在 `<body>` 末尾注入一个
    // 路由播报器（route announcer），它**也是** `role="alert"` 且常年为空，全站每个页面都有。
    // 用它当选择器会数到 2 个元素 —— 实测就是这样红的。所以按本站自己的类名定位，
    // 再反过来断言它确实带着 `role="alert"`（无障碍语义不许丢）。
    const alert = page.locator('.lq-error');
    await expect(alert).toHaveCount(1);
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText(LOGIN_ERROR_PREFIX);
    await expect(alert).toContainText(PROXY_ERROR_CODES.upstreamUnreachable);
    // 只有码没有人话，等于把失败原样丢给学生。文案表里必须有这一条，且不许是空串
    // （`toContainText('')` 恒真，所以先钉非空）。键名写死在这里：删掉那一条会在
    // typecheck 阶段就红，因为 `LAYER_ERROR_EXPLANATIONS` 是 `as const`。
    const explanation = LAYER_ERROR_EXPLANATIONS.WEB_API_UPSTREAM_UNREACHABLE;
    expect(explanation, '失败文案被清空了，学生只会看到一个裸码').not.toBe('');
    await expect(alert).toContainText(explanation);

    // 这一段把「UI 上那行红字」与「代理层的真实判定」绑在一起：红字必须来自一次
    // 真实发生的同源请求，而不是前端自己编的一句话。
    expect(apiResponses, '没有捕获到任何 /api/ 响应 —— 表单其实没发请求').toHaveLength(1);
    const response = apiResponses[0]!;
    expect(new URL(response.url()).origin, '登录请求不是同源的').toBe(SITE_ORIGIN);
    expect(response.request().method()).toBe('POST');
    // 反重定向钉子：`trailingSlash: true` 会让不带尾斜杠的 `/api/*` 先吃一个 308，
    // 代理处理器根本跑不到。客户端的 `toRoutePath` 就是为此存在的（见 `src/api-client.ts`）。
    // 少了这一条，把 `toRoutePath` 摘掉时下面那句只会报「expected 308 to be 502」，
    // 读的人得自己去猜真因 —— 而它当初正是这样把缺陷藏过去的。
    expect(response.status(), '请求被 308 重定向了：客户端没走规范的尾斜杠路径').not.toBe(308);
    expect(response.status()).toBe(502);
    // 失败响应的形状只有 `code` 一个键：多一个字段就可能被客户端误读成载荷。
    expect(await response.json()).toEqual({ code: PROXY_ERROR_CODES.upstreamUnreachable });

    // 阴性对照（反假成功）：既不许出现成功提示，也不许跳去工作台。
    // 少了这两条，一个「不管后端答什么都 router.push」的实现能让上面全部断言照样绿。
    await expect(page.getByText(LOGIN_SUCCESS_HINT)).toHaveCount(0);
    expect(page.url(), '登录没成功却跳走了 —— 这就是假成功').toContain(LOGIN_PATH);
  });

  test('同一台服务上不同的失败给出不同的码（阴性对照：证明不是「一律同一个码」）', async ({
    request,
  }) => {
    // ⚠️ 本条里每一次请求都带 `maxRedirects: 0`。Playwright 的 request 默认**跟随**重定向，
    // 而 `trailingSlash: true` 会让不带尾斜杠的 `/api/*` 先吃一个 308 —— 默认设置下测试会
    // 安安静静地跟着跳到规范路径、拿到正确结果、然后全绿，把「客户端发的是会被重定向的那个
    // 形态」这件事彻底藏起来。上一轮它就是这么漏的。所以这里一律禁跟随，并用尾斜杠形态。
    const noRedirect = { maxRedirects: 0 } as const;
    const LOGIN_API = `${SITE_ORIGIN}/api/v1/auth/login/`;

    // 先把那个陷阱本身钉住，免得日后有人以为 `toRoutePath` 是多余的：
    // 不带尾斜杠 ⇒ 308，代理处理器根本不会被执行到。
    const slashed = await request.post(`${SITE_ORIGIN}/api/v1/auth/login`, noRedirect);
    expect(slashed.status(), 'Next 不再为 /api/* 补尾斜杠了 —— toRoutePath 的前提变了').toBe(308);
    expect(slashed.headers()['location']).toBe('/api/v1/auth/login/');

    // 上一条断言 502 / upstreamUnreachable。若代理其实「不管什么都 502」，那条照样会绿 ——
    // 所以这里必须证明它能区分原因。前缀收窄到 v1，`/api/v2/*` 在**打到上游之前**就被拒：
    // 404 而不是 502，说明路径检查真的跑在了服务形态里，而不只在单测里。
    const rejectedPath = await request.get(`${SITE_ORIGIN}/api/v2/projects/`, noRedirect);
    expect(rejectedPath.status()).toBe(404);
    expect(await rejectedPath.json()).toEqual({ code: PROXY_ERROR_CODES.pathRejected });

    // 合法路径 + 目标连不上 ⇒ 502。与上面那条同一次运行、同一台服务、同一个（无效的）目标，
    // 却给出不同的码：这就是「不是一律同一个码」的证据。
    const unreachable = await request.post(LOGIN_API, noRedirect);
    expect(unreachable.status()).toBe(502);
    expect(await unreachable.json()).toEqual({ code: PROXY_ERROR_CODES.upstreamUnreachable });

    // 允许清单里的六个方法在服务形态下**全部**接得住，且全部失败关闭 —— 没有哪一个
    // 因为忘了导出而落到框架手里，也没有哪一个偷偷返回 2xx。
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await request.fetch(LOGIN_API, { method, ...noRedirect });
      expect(response.status(), `${method} 没有失败关闭（应当 502，实测见下）`).toBe(502);
      // HEAD 按规范没有响应体，所以这里不读 body。
      if (method !== 'HEAD') {
        expect(await response.json(), `${method} 的失败体形状不对`).toEqual({
          code: PROXY_ERROR_CODES.upstreamUnreachable,
        });
      }
    }

    // 清单之外的方法**到不了代理**。实测（Next 16.4.2）：OPTIONS 由框架自己答 204、
    // TRACE 是 500、未知方法是 400 —— 三个都不是本层发的，所以这里只断言两件真正要紧的事：
    //   ① 一律不是 2xx（除了 OPTIONS 那个空 204，见下）；
    //   ② 一律不是 502 —— 502 才意味着它穿过代理去打上游了。
    // 代理自己那道 methodRejected(405) 是给**直接调用者**的纵深防御，
    // 由 apps/web/test/api-proxy.test.ts 钉住；经 HTTP 走不到它，别在这里假装能走到。
    for (const method of ['TRACE', 'FOO']) {
      const response = await request.fetch(LOGIN_API, { method, ...noRedirect });
      expect(response.status(), `${method} 竟然是 2xx`).not.toBeLessThan(400);
      expect(response.status(), `${method} 穿过了代理打到上游`).not.toBe(502);
    }

    // OPTIONS 单独说：框架答一个 204 + `Allow`，请求体为空、不打上游。这个 204 **不构成
    // CORS 放宽** —— 浏览器的跨源预检要求响应里带 `access-control-allow-origin`，
    // 没有它，预检就是失败的，别的站点仍然直连不到。所以这里钉的是「不带 CORS 头」
    // 与「Allow 只列本站真支持的七个」，而不是钉状态码本身。
    const options = await request.fetch(LOGIN_API, { method: 'OPTIONS', ...noRedirect });
    expect(options.status()).toBe(204);
    const allow = options.headers()['allow'];
    // 阳性对照：先证明这个头真的在。缺了它，下面 `.split` 会抛 TypeError，
    // 报出来的是崩溃而不是断言 —— 读者就分不清是「Allow 变了」还是「Allow 没了」。
    expect(allow, 'OPTIONS 的 204 没带 Allow 头').toBeTruthy();
    expect(
      allow!
        .split(',')
        .map((part) => part.trim())
        .sort(),
    ).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    expect(options.headers()['access-control-allow-origin']).toBeUndefined();
    expect(options.headers()['access-control-allow-credentials']).toBeUndefined();
    expect(options.headers()['access-control-allow-methods']).toBeUndefined();

    // 字面量钉子：码一律带 WEB_API_ 前缀。PROXY_ERROR_CODES 是从源码 import 的，
    // 只靠它自己发现不了「有人把码改名了」—— 改名会让浏览器侧的文案映射查不到。
    for (const code of Object.values(PROXY_ERROR_CODES)) {
      expect(code, `代理错误码 ${code} 不合形状`).toMatch(/^WEB_API_[A-Z_]+$/);
    }
    expect(Object.values(PROXY_ERROR_CODES)).toContain('WEB_API_UPSTREAM_UNREACHABLE');
    expect(Object.values(PROXY_ERROR_CODES)).toContain('WEB_API_PATH_REJECTED');
  });

  test('未登录时创作页如实说要登录，给的入口是真的', async ({ page, request }) => {
    await page.goto(CREATE_PATH);

    await expect(page.locator('h1')).toHaveText(CREATE_HEADING);
    // 没有会话就渲染「需要先登录」面板，而不是渲染一个空工作台让人点了报错。
    await expect(page.getByText(CREATE_NEEDS_LOGIN_HEADING)).toHaveCount(1);
    // 面板里那个入口必须真的指向登录页（expectEveryActionIsReal 会再实测它 200）。
    await expect(page.locator('.lq-cta')).toHaveText([NAV_LOGIN_LABEL]);
    await expect(page.locator('.lq-cta')).toHaveAttribute('href', LOGIN_PATH);

    await expectEveryActionIsReal(page, request);
  });

  test('未登录时凭据设置页如实说要登录，那句「配好也改不了」的披露照样在页面上', async ({
    page,
    request,
  }) => {
    await page.goto(SETTINGS_PATH);

    await expect(page.locator('h1')).toHaveText(SETTINGS_HEADING);
    await expect(page.getByText(SETTINGS_NEEDS_LOGIN_HEADING)).toHaveCount(1);
    await expect(page.locator('.lq-cta')).toHaveText([NAV_LOGIN_LABEL]);
    await expect(page.locator('.lq-cta')).toHaveAttribute('href', LOGIN_PATH);

    // ZLQ-241：这句披露是「凭据存进去之后这一版改不了」的**用户侧告知**，此前整页零 e2e、
    // 零单测 —— 删掉它或把它改软，七道门全绿。vitest 那三条守的是源码文本；这一条守的是
    // **部署产物**：它渲染在 `app/settings/page.tsx` 那个「有没有会话」的三元**之外**，
    // 所以未登录也必须看得到。少这一条，「未登录时页面只剩一个空壳」不会被任何人发现。
    //
    // 用 `.lq-hint` 定位而不是 `getByText`：Next 会把服务端组件的渲染结果**同时**塞进
    // HTML 里的 RSC flight 脚本，裸文本匹配可能数出两份（一份 DOM、一份脚本），
    // 而脚本标签没有这个类名，所以类名定位既精确又不受那份副本影响。
    const disclosure = page.locator('.lq-hint', { hasText: SETTINGS_ALREADY_CONFIGURED_NOTE });
    await expect(disclosure).toHaveCount(1);
    // 精确相等（Playwright 会归一化空白）：只断言「包含」的话，把这句话改软一半也能过。
    await expect(disclosure).toHaveText(SETTINGS_ALREADY_CONFIGURED_NOTE);
    // ⚠️ 但这一条**测不出文案被改软**，别指望它替代 vitest 那三条：两边读的是同一个常量，
    // 改文案会同时改掉期望值。实测过（把「不能更换」改成「也可以更换」重新构建）：本条照绿、
    // `apps/web/test/index.test.ts` 的那条染红。所以分工是固定的 —— **内容**归 vitest，
    // **「未登录也真的渲染在部署产物里」**归这一条；两臂各自单独证明过会咬人。

    await expectEveryActionIsReal(page, request);
  });

  test('代理响应一律不发 CORS 放宽头，浏览器打过去的请求全部同源', async ({ request }) => {
    // ⚠️ 这里**测不到 CSP 响应头本身**，不是漏了：CSP 写在 `vercel.json` 的 `headers` 里，
    // 那是 Vercel 平台专属机制，`next start` 不读它；而仓库内唯一能让 `next start` 发头的
    // 地方是 `next.config.ts` 的 `headers()`，那一处被 `apps/web/test/index.test.ts`
    // 一条**先于本单存在**的断言钉死（「路由与安全头各由其唯一归属承担」），不许动。
    // 所以 CSP / 安全头的实测只能发生在部署后的 URL 上，归【发布】单；`connect-src 'self'`
    // 未放宽这条在仓库侧由 `index.test.ts` 读 `vercel.json` 的那几条断言承担。
    // 本条测的是本地**测得到**的那一半：我新写的这层没有偷偷放宽 CORS，也没有跨源。
    // ⚠️ 路径一律带尾斜杠 + `maxRedirects: 0`：`trailingSlash: true` 让 Next 对任何
    // 不带尾斜杠的 `/api/*` 先发 308，而 `request` 默认跟随重定向 —— 那样这四条断言量的
    // 就不是代理，而是重定向**之后**的响应。带斜杠 + 不跟重定向 ⇒ 308 无处可藏。
    const noRedirect = { maxRedirects: 0 } as const;
    const responses = [
      await request.get(`${SITE_ORIGIN}/api/v1/auth/login/`, noRedirect),
      await request.post(`${SITE_ORIGIN}/api/v1/auth/login/`, noRedirect),
      await request.get(`${SITE_ORIGIN}/api/v2/projects/`, noRedirect),
      await request.get(`${SITE_ORIGIN}/api/v1/projects/`, noRedirect),
    ];
    for (const response of responses) {
      const headers = response.headers();
      expect(response.status(), `${response.url()} 被 308 顶掉了，量到的不是代理响应`).not.toBe(
        308,
      );
      // 阳性对照：响应头不是空的 —— 少了这条，下面那几个 undefined 可能只是「整个响应没头」。
      expect(headers['content-type'], `${response.url()} 连 content-type 都没有`).toBeTruthy();
      expect(
        headers['access-control-allow-origin'],
        `${response.url()} 发了 access-control-allow-origin —— CORS 被放宽了`,
      ).toBeUndefined();
      expect(headers['access-control-allow-credentials']).toBeUndefined();
      expect(headers['access-control-allow-methods']).toBeUndefined();
      // 同源代理的意义就在这里：浏览器看到的 URL 始终是站点自己的 origin。
      expect(new URL(response.url()).origin, `${response.url()} 跨源了`).toBe(SITE_ORIGIN);
      // 代理不许把上游地址泄露给浏览器（§8 D6 的补偿控制）。
      const body = await response.text();
      expect(body, `${response.url()} 的响应体里出现了上游地址`).not.toContain(DEAD_API_ORIGIN);
      expect(body, `${response.url()} 的响应体里出现了上游主机`).not.toContain(DEAD_API_HOST);
    }
  });

  test('代理路径不出现在任何页面的 HTML 里（目标只在服务端环境变量里）', async ({ request }) => {
    // §8 D6 的补偿控制：apps/web 服务端不持有凭证，目标只来自一个环境变量。
    // 这条从**部署产物**取证：渲染出来的 HTML 里不该出现任何上游地址，
    // 否则前端就等于把 API origin 泄露给了浏览器，「禁止浏览器直连 API」也就成了空话。
    for (const path of ['/', LOGIN_PATH, CREATE_PATH, SETTINGS_PATH, SOURCE_AND_LICENSE_PATH]) {
      const response = await request.get(`${SITE_ORIGIN}${path}`);
      expect(response.status(), `${path} 取不到，下面那几条 not.toContain 就是空转`).toBe(200);
      const body = await response.text();
      // 阳性对照：先证明真的拿到了这一页的 HTML（空字符串上任何 not.toContain 都恒绿）。
      expect(body.length, `${path} 的响应体是空的`).toBeGreaterThan(500);
      expect(body, `${path} 的响应体不像 HTML`).toContain('<!DOCTYPE html>');
      expect(body, `${path} 的 HTML 里出现了上游地址`).not.toContain(DEAD_API_ORIGIN);
      expect(body, `${path} 的 HTML 里出现了上游主机`).not.toContain(DEAD_API_HOST);
      expect(body, `${path} 的 HTML 里出现了 LQ_API_ORIGIN 的值`).not.toMatch(
        /LQ_API_ORIGIN\s*=\s*\S/,
      );
    }
  });
});

test.describe('合规 bundle（另一个 origin，不再冒充站点产物）', () => {
  test('bundle 服务只服务 artifacts 前缀', async ({ request }) => {
    const health = await request.get(`${BUNDLE_ORIGIN}/__health`);
    expect(health.ok()).toBe(true);
    expect(await health.json()).toEqual({ ok: true, allow: ['artifacts'] });

    expect((await request.get(`${BUNDLE_ORIGIN}/package.json`)).status()).toBe(404);
    expect((await request.get(`${BUNDLE_ORIGIN}/config/license-policy.json`)).status()).toBe(404);
    // 目录请求：artifacts/ 下没有 index.html，所以仍然 404 —— 目录改写没有放宽这条。
    expect((await request.get(`${BUNDLE_ORIGIN}/artifacts/`)).status()).toBe(404);
    expect((await request.get(`${BUNDLE_ORIGIN}/artifacts/%2e%2e/package.json`)).status()).toBe(
      404,
    );
  });

  test('web bundle 在浏览器中可执行且保留 workspace 组合', async ({ page }) => {
    // 同源才能动态 import：静态服务器不发 CORS 头，所以先站到 bundle 服务自己的 origin 上。
    await page.goto(`${BUNDLE_ORIGIN}/__health`);
    const manifest = await page.evaluate(async (url) => {
      const mod = (await import(url)) as BundleExports;
      return {
        unitId: mod.unitManifest.unitId,
        layer: mod.unitManifest.layer,
        skeletonOnly: mod.unitManifest.skeletonOnly,
        composedOf: mod.unitManifest.composedOf,
        contractLoadable: mod.isContractLoadable(),
      };
    }, BUNDLE_URL);

    // skeletonOnly 由 true 翻成 false（PM 裁定 1）：本切片之后 apps/web 不再只是骨架。
    // 这是**规格值**，不是测量值 —— packages/api-contract/test/index.test.ts:8 已有先例。
    expect(manifest).toEqual({
      unitId: '@littleq/web',
      layer: 'app',
      skeletonOnly: false,
      composedOf: ['@littleq/design-system', '@littleq/work-contract'],
      contractLoadable: true,
    });
  });

  test('AGPL 法务横幅活过 minify', async ({ request }) => {
    const response = await request.get(BUNDLE_URL);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('text/javascript');

    const body = await response.text();
    expect(body.startsWith('/*!')).toBe(true);
    expect(body).toContain('SPDX-License-Identifier: AGPL-3.0-only');
    expect(body).toContain('LittleQ');
  });
});

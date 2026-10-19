import { expect, test, type Page, type Request, type Response } from '@playwright/test';

import { AGE_BANDS } from '../packages/design-system/src/age-bands.js';
import {
  AGE_BANDS_HEADING,
  FOOTER_SOURCE_LABEL,
  HERO_TITLE,
  LEGAL_FILES,
  LICENSE_ID,
  MASCOT_ALT,
  PRIMARY_ACTION_LABEL,
  SCOPE_DELIVERED_HEADING,
  SCOPE_DELIVERED_ITEMS,
  SCOPE_UNAVAILABLE_HEADING,
  SCOPE_UNAVAILABLE_ITEMS,
  SITE_NAME,
  SOURCE_AND_LICENSE_PATH,
  STATUS_BODY,
  STATUS_HEADING,
} from '../apps/web/src/site-content.js';
import { BUNDLE_ORIGIN, SITE_ORIGIN } from './origins.js';

/**
 * ZLQ-190 §6.2 的 e2e smoke：加载的是 `apps/web/out`，也就是**将要部署到 Vercel 的那份产物**。
 *
 * 三件事在这里被证明，缺一件就不该发布：
 *   1. 页面内容与设计文档 §5.1/§5.3 一致，且文案与分龄元数据**引自源码常量**，
 *      不是在 spec 里重抄一遍 —— 重抄会让「改文案」变成「改两处、忘一处、测试照样绿」。
 *   2. 站点自给自足：没有任何 API 调用、认证跳转或第三方资源请求（§1.2 / §8 D6）。
 *   3. AGPL §13 的源码可获取性出现在**部署产物**里，而不只是仓库里（验收标准 5）。
 *
 * 另外保留 §6.1 要求的两条旧断言，但它们现在打到**另一个 origin**：esbuild 合规 bundle
 * 不再是站点产物，不能用它的绿来冒充站点的绿。
 *
 * 刻意不做的事：不断言页面元素总数、不断言某次运行的用例总数。这两者都是观测量，
 * 写进契约就变成「以后谁加了个 section 就得来改数字」，而数字本身并不表达任何要求。
 */

const BUNDLE_URL = `${BUNDLE_ORIGIN}/artifacts/bundles/web.js`;

interface BundleExports {
  unitManifest: { unitId: string; layer: string; skeletonOnly: boolean; composedOf: string[] };
  isContractLoadable: () => boolean;
}

/** §5.1 明确列出的「假入口」文案。一个都不许出现。 */
const FORBIDDEN_ACTION_WORDS = [
  '开始创作',
  '立即体验',
  '登录',
  '注册',
  '免费试用',
  'sign in',
  'log in',
];

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

  test('交付范围如实陈述，未开放的功能没有任何假入口', async ({ page }) => {
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
    await expect(page.locator('.lq-cta')).toHaveText([PRIMARY_ACTION_LABEL]);
    await expect(page.locator('.lq-cta')).toHaveAttribute('href', SOURCE_AND_LICENSE_PATH);

    // 全站任何链接或按钮的可访问名里都不许出现这些词（大小写不敏感）。
    const actionNames = await page
      .locator('a, button')
      .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));
    for (const name of actionNames) {
      for (const word of FORBIDDEN_ACTION_WORDS) {
        expect(
          name.toLowerCase().includes(word.toLowerCase()),
          `出现了假入口「${name}」（命中禁词 ${word}）`,
        ).toBe(false);
      }
    }
    // 反向对照：上面那个循环若因为一个链接都没取到而空转，就等于没测。
    expect(actionNames.length, '页面上一个链接都没取到，禁词断言空转了').toBeGreaterThan(0);
    // 也不许有任何可点击元素挂着 form / onclick 之类的交互外壳。
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
  test('健康检查报告生效前缀，白名单语义随形态变化', async ({ request }) => {
    // 契约变更（已声明）：站点服务以 `--allow .` 启动，root 就是 apps/web/out，
    // 所以生效前缀是「整个 root」，报告为 '.'。bundle 服务仍是 ['artifacts']，见下面那条。
    const site = await request.get(`${SITE_ORIGIN}/__health`);
    expect(site.ok()).toBe(true);
    expect(await site.json()).toEqual({ ok: true, allow: ['.'] });
  });

  test('站点服务只暴露产物，仓库内部文件不可达', async ({ request }) => {
    // root 是 out，所以这些路径都在 root 之外或不存在，一律 404。
    expect((await request.get(`${SITE_ORIGIN}/package.json`)).status()).toBe(404);
    expect((await request.get(`${SITE_ORIGIN}/config/license-policy.json`)).status()).toBe(404);
    expect((await request.get(`${SITE_ORIGIN}/pnpm-lock.yaml`)).status()).toBe(404);
    expect((await request.get(`${SITE_ORIGIN}/.git/config`)).status()).toBe(404);
    expect((await request.get(`${SITE_ORIGIN}/%2e%2e/package.json`)).status()).toBe(404);
    // 没有 index.html 的目录不列目录。
    const listing = await request.get(`${SITE_ORIGIN}/_next/static/chunks/`);
    expect(listing.status()).toBe(404);
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

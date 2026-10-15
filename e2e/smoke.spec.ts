import { expect, test } from '@playwright/test';

/**
 * M1 Stage 1-1 smoke：测的是工具链，不是产品。
 *
 * 此刻仓库里没有任何页面可测，但「Playwright 装好了、入口能跑」不能只是一句声明，
 * 所以这里让真实浏览器去加载 `tools/build-bundles.mjs` 打出来的产物，验证三件事：
 *
 *   1. 静态服务器只暴露白名单前缀，路径穿越与非白名单文件一律 404；
 *   2. web bundle 能在浏览器里执行，且 workspace 组合（design-system / work-contract）
 *      没有在打包中丢失 —— 别名表如果错了，这一步会直接失败；
 *   3. AGPL 法务横幅活过了 minify（ZLQ-153 §10.2）。
 *
 * 产物由 `pnpm bundles` 生成；CI 里 e2e 之前必须先跑它。
 */
const BUNDLE_URL = '/artifacts/bundles/web.js';

interface BundleExports {
  unitManifest: { unitId: string; layer: string; skeletonOnly: boolean; composedOf: string[] };
  isContractLoadable: () => boolean;
}

test.describe('质量基座 smoke', () => {
  test('静态服务器只服务白名单前缀', async ({ request }) => {
    const health = await request.get('/__health');
    expect(health.ok()).toBe(true);
    expect(await health.json()).toEqual({ ok: true, allow: ['artifacts'] });

    expect((await request.get('/package.json')).status()).toBe(404);
    expect((await request.get('/config/license-policy.json')).status()).toBe(404);
    expect((await request.get('/artifacts/')).status()).toBe(404);
    // 编码后的 ../ 穿越：无论客户端是否先归一化，两种结果都必须是 404。
    expect((await request.get('/artifacts/%2e%2e/package.json')).status()).toBe(404);
  });

  test('web bundle 在浏览器中可执行且保留 workspace 组合', async ({ page }) => {
    await page.goto('/__health');
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

    expect(manifest).toEqual({
      unitId: '@littleq/web',
      layer: 'app',
      skeletonOnly: true,
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

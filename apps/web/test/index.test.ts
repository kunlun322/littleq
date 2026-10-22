// @littleq/web 的单元测试（ZLQ-190 §6.1 的 `test` 门禁）。
//
// 覆盖四类事实，全部是**内容级**断言，不是「组件能 import」这种空断言：
//   1. 单元自述：skeletonOnly 已翻成 false（PM 裁定 1）；
//   2. 首页文案：诚实状态条、交付范围、唯一主行动、法务链接，逐字取自 site-content.ts；
//   3. 构建期身份：提交号解析顺序、失败关闭、源码 URL 的协议校验；
//   4. §8 / §9 的安全与范围约束：零凭证、零 Cookie、零 API 路由、不得占用冻结的会话名。
//
// 为什么在 node 环境里测而不是渲染 DOM：文案与约束都是**字符串与文件事实**，
// 渲染断言交给 e2e/smoke.spec.ts（它加载的是真实的 apps/web/out 产物）。
// 两侧引用同一份 site-content.ts，不可能各说各话。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGE_BANDS } from '@littleq/design-system';

import {
  DEFAULT_SOURCE_URL,
  findRepoRoot,
  readRepoVersion,
  resolveBuildInfo,
  resolveCommitSha,
  resolveSourceUrl,
} from '../src/build-info.js';
import { UNIT_ID, isContractLoadable, unitManifest } from '../src/index.js';
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
} from '../src/site-content.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..');

function read(relativePath: string): string {
  return readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8');
}

/** `apps/web` 下所有被跟踪形态的源文件（app/ + src/ + 三份根配置），用于全量扫描类断言。 */
function sourceFiles(): string[] {
  const collected: string[] = [];
  for (const dir of ['app', 'src']) {
    for (const entry of readdirSync(join(PACKAGE_ROOT, dir), { recursive: true })) {
      const relative = `${dir}/${String(entry).replaceAll('\\', '/')}`;
      if (!statSync(join(PACKAGE_ROOT, relative)).isFile()) continue;
      collected.push(relative);
    }
  }
  return [...collected, 'next.config.ts', 'vercel.json', 'package.json'];
}

/**
 * 去掉源码里的注释，**保留字符串字面量**。全量扫描类断言必须先过这一层。
 *
 * 为什么：`src/index.ts` 的文件头注释里有一句散文正好写着 `apps/runtime`（说明作品由谁
 * 隔离托管）。裸 `includes()` 会把那句说明判成依赖 —— 一个「零命中」门禁被解释它自己的
 * 注释绊倒之后，就再也分不清「真的没有依赖」和「碰巧没写到这个词」，也就染不红了。
 *
 * 为什么必须字符串感知：`vercel.json` 的 `$schema` 是 `https://…`。按 `//` 一刀切会把
 * 该行后半截当成注释吃掉；在别的文件里这一刀可能正好吃掉一条真实的 `import`，
 * 于是门禁**假绿** —— 那比假红更危险。
 */
function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += source[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 在**去注释后**的源码里找禁用词；返回命中词，供调用方拼出可读的失败信息。 */
function forbiddenHits(source: string, tokens: readonly string[]): string[] {
  const code = stripComments(source);
  return tokens.filter((token) => code.includes(token));
}

describe('@littleq/web 单元自述', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/web');
    expect(unitManifest.layer).toBe('app');
    // 规格值而非测量值（PM 裁定 1）：本切片之后 apps/web 已经是一个可部署站点。
    expect(unitManifest.skeletonOnly).toBe(false);
  });

  it('组合根解析到设计系统与契约层', () => {
    expect(unitManifest.composedOf).toEqual(['@littleq/design-system', '@littleq/work-contract']);
  });

  it('契约层代码可随 web 产物一同执行', () => {
    expect(isContractLoadable()).toBe(true);
  });
});

describe('首页文案（§5.1 的六个区块）', () => {
  it('诚实状态条逐字固定，没有被弱化成「即将上线」', () => {
    expect(STATUS_HEADING).toBe('M0 质量基线已交付，产品功能开发中');
    expect(STATUS_BODY).toBe(
      '当前可查看品牌、分龄体验方向与开源信息；创作、账号和 AI 功能尚未开放。',
    );
    // 反空断言：措辞里必须真的点到「尚未开放」，否则换个说法就能悄悄绕开诚实要求。
    expect(STATUS_BODY).toContain('尚未开放');
  });

  it('品牌与英雄区标题按设计文档给出', () => {
    expect(SITE_NAME).toBe('Little Q');
    expect(HERO_TITLE).toBe('和 Little Q 一起，把想法变成作品');
    expect(MASCOT_ALT).toContain('Little Q');
  });

  it('交付范围如实分成「已交付」与「尚未开放」两组，且没有互相污染', () => {
    expect(SCOPE_DELIVERED_HEADING).toBe('本次已交付');
    expect(SCOPE_UNAVAILABLE_HEADING).toBe('尚未开放');
    expect([...SCOPE_DELIVERED_ITEMS]).toEqual(['可部署页面', '分龄视觉基线', '开源信息入口']);
    expect([...SCOPE_UNAVAILABLE_ITEMS]).toEqual([
      'Vibe Coding',
      '作品发布',
      '账号',
      '教师 / 家长',
      'AI 集成',
    ]);
    // 已交付项不得出现在未开放清单里（反之亦然）：否则页面会自相矛盾。
    const delivered = new Set<string>(SCOPE_DELIVERED_ITEMS);
    expect(SCOPE_UNAVAILABLE_ITEMS.filter((item) => delivered.has(item))).toEqual([]);
  });

  it('全站唯一的主行动指向源码与许可证，没有假入口', () => {
    expect(PRIMARY_ACTION_LABEL).toBe('查看源码与许可证');
    expect(SOURCE_AND_LICENSE_PATH).toBe('/source-and-license/');
    // §5.1 第 5 块：不得出现「开始创作 / 登录 / 立即体验」这类没有对应功能的入口。
    for (const forbidden of ['开始创作', '登录', '立即体验', '注册', '免费试用']) {
      expect(PRIMARY_ACTION_LABEL).not.toContain(forbidden);
    }
  });

  it('分龄区块的标题存在，且三档元数据全部来自设计系统包而不是本地副本', () => {
    expect(AGE_BANDS_HEADING).toBe('三个分龄体验方向');
    expect(AGE_BANDS.map((band) => band.label)).toEqual([
      'L1 · 启蒙探索',
      'L2 · 创意成长',
      'L3 · 项目挑战',
    ]);
    expect(AGE_BANDS.map((band) => band.densityTier)).toEqual(['l1', 'l2', 'l3']);
    // §5.1 第 3 块的三条特征逐档固定；这里从包里的真实数据取值，断言写在 app 侧，
    // 两侧任何一边被改动都会红 —— 这正是「卡片内容不属于 app」的可执行表达。
    expect(AGE_BANDS.map((band) => band.traits)).toEqual([
      ['大字号', '高对比', '单一焦点'],
      ['图文并行', '适中信息密度'],
      ['结构化信息', '更高自主度'],
    ]);
  });

  it('页脚常驻项与法务文件清单符合 §7', () => {
    expect(FOOTER_SOURCE_LABEL).toBe('源码与许可证');
    expect(LICENSE_ID).toBe('AGPL-3.0-only');
    expect(LEGAL_FILES.map((file) => file.path)).toEqual([
      '/legal/AGPL-3.0.txt',
      '/legal/NOTICE.txt',
      '/legal/THIRD_PARTY_LICENSES.txt',
      '/licenses.txt',
    ]);
    // 每条法务文件都必须有一个人类可读的标签，否则法务页渲染出来是一列裸路径。
    expect(LEGAL_FILES.every((file) => file.label.length > 0)).toBe(true);
    // 站点根相对路径（带前导斜杠），不得是浮动分支链接。
    for (const file of LEGAL_FILES) {
      expect(file.path.startsWith('/')).toBe(true);
      expect(file.path).not.toMatch(/\/(main|master)\b/);
    }
  });

  it('页面源码引用文案常量，而不是把同一份文案抄第二遍', () => {
    const page = read('app/page.tsx');
    // 结构层只认标识符；出现字面量就意味着两份事实来源，改一处漏一处。
    expect(page).toContain('STATUS_HEADING');
    expect(page).toContain('SCOPE_DELIVERED_ITEMS');
    expect(page).not.toContain(STATUS_HEADING);
    expect(page).not.toContain(SCOPE_UNAVAILABLE_ITEMS[0] ?? '');
  });
});

describe('设计令牌是 app 的唯一视觉来源（§5.2）', () => {
  it('根布局导入 @littleq/design-system/tokens.css，且排在 globals.css 之前', () => {
    const layout = read('app/layout.tsx');
    const tokensAt = layout.indexOf('@littleq/design-system/tokens.css');
    const globalsAt = layout.indexOf('./globals.css');
    expect(tokensAt).toBeGreaterThan(-1);
    expect(globalsAt).toBeGreaterThan(-1);
    expect(tokensAt).toBeLessThan(globalsAt);
  });

  it('globals.css 里没有任何十六进制颜色字面量', () => {
    // 颜色只允许来自 --lq-color-* / --lq-density-*-text-color。写死一个色值就等于
    // 在 app 里另起一套品牌色，正是 §5.2 明令禁止的事。
    const css = read('app/globals.css');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // 反空断言：这份 CSS 必须真的在消费令牌，否则「没有硬编码」是因为它什么都没写。
    expect(css).toContain('var(--lq-color-');
    expect(css).toContain('var(--lq-space-');
  });

  it('三档密度令牌在 globals.css 里都被真实消费', () => {
    const css = read('app/globals.css');
    for (const tier of ['l1', 'l2', 'l3']) {
      expect(css, `${tier} 档密度令牌没有被消费`).toContain(`var(--lq-density-${tier}-font-scale)`);
      expect(css).toContain(`var(--lq-density-${tier}-measure)`);
    }
  });

  it('package.json 导出 tokens.css，且指向源码而不是构建产物', () => {
    const manifest = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@littleq/design-system']).toBe('workspace:*');
    const designSystem = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, '../../packages/design-system/package.json'), 'utf8'),
    ) as { exports?: Record<string, unknown> };
    // 指向 src/：令牌是纯 CSS，不需要构建顺序，`next build` 也就不依赖 dist 是否已生成。
    expect(designSystem.exports?.['./tokens.css']).toBe('./src/tokens.css');
  });
});

describe('构建期站点身份（§7 D5）', () => {
  const FAKE_SHA = 'a'.repeat(40);

  it('VERCEL_GIT_COMMIT_SHA 优先，并被归一成小写', () => {
    expect(resolveCommitSha({ VERCEL_GIT_COMMIT_SHA: FAKE_SHA.toUpperCase() })).toBe(FAKE_SHA);
    expect(resolveCommitSha({ VERCEL_GIT_COMMIT_SHA: `  ${FAKE_SHA}  ` })).toBe(FAKE_SHA);
  });

  it('变量非空但不可用时抛错，而不是悄悄回落到本机 HEAD', () => {
    // 回落会让法务页展示**另一个提交**的源码链接：Vercel 构建的是推送的那个提交，
    // 而 `git rev-parse HEAD` 在构建容器里指向的是它自己的检出状态。§7 要的是
    // 「源码入口指向这次构建对应的提交」，所以这里必须失败关闭。
    expect(() => resolveCommitSha({ VERCEL_GIT_COMMIT_SHA: 'not-a-sha' })).toThrow(
      /不回落到本机 git HEAD/,
    );
    expect(() => resolveCommitSha({ VERCEL_GIT_COMMIT_SHA: 'zzzzzzz' })).toThrow(/不是合法提交号/);
    // 空值与缺席同义（Vercel 未关联 git 项目时会注入空串），这两种都必须回落到 git。
    expect(resolveCommitSha({ VERCEL_GIT_COMMIT_SHA: '   ' })).toMatch(/^[0-9a-f]{40}$/);
  });

  it('拿不到 Vercel 变量时回落到 git HEAD，且永远不是占位字符串', () => {
    // 失败关闭是这条的实现方式：解析不出来就抛错，不返回 'unknown'。
    // 所以只要这个断言能跑完，就证明本机确实拿到了真实提交号。
    const sha = resolveCommitSha({});
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe('unknown');
  });

  it('版本号由根 package.json 的 version 与短提交号组合而成', () => {
    const repoRoot = findRepoRoot(import.meta.dirname);
    const info = resolveBuildInfo({ VERCEL_GIT_COMMIT_SHA: FAKE_SHA });
    expect(info.shortCommitSha).toBe(FAKE_SHA.slice(0, 7));
    expect(info.version).toBe(`${readRepoVersion(repoRoot)}+${FAKE_SHA.slice(0, 7)}`);
  });

  it('源码链接落在具体提交上，而不是浮动分支', () => {
    const info = resolveBuildInfo({ VERCEL_GIT_COMMIT_SHA: FAKE_SHA });
    expect(info.sourceUrl).toBe(DEFAULT_SOURCE_URL);
    expect(info.commitUrl).toBe(`${DEFAULT_SOURCE_URL}/commit/${FAKE_SHA}`);
    expect(info.commitTreeUrl).toBe(`${DEFAULT_SOURCE_URL}/tree/${FAKE_SHA}`);
    expect(info.commitUrl).not.toMatch(/\/(main|master)\b/);
  });

  it('NEXT_PUBLIC_LITTLEQ_SOURCE_URL 是可选的非机密变量，且只接受 http(s)', () => {
    expect(resolveSourceUrl({})).toBe(DEFAULT_SOURCE_URL);
    expect(resolveSourceUrl({ NEXT_PUBLIC_LITTLEQ_SOURCE_URL: '  ' })).toBe(DEFAULT_SOURCE_URL);
    // 尾斜杠被去掉，避免拼出 `//commit/…`。
    expect(resolveSourceUrl({ NEXT_PUBLIC_LITTLEQ_SOURCE_URL: 'https://example.com/fork/' })).toBe(
      'https://example.com/fork',
    );
    // 这个值会直接进 <a href>，不校验协议就是给 javascript: 留口子。
    expect(() =>
      resolveSourceUrl({ NEXT_PUBLIC_LITTLEQ_SOURCE_URL: 'javascript:alert(1)' }),
    ).toThrow(/http\(s\)/);
    expect(() => resolveSourceUrl({ NEXT_PUBLIC_LITTLEQ_SOURCE_URL: 'not a url' })).toThrow(
      /不是合法 URL/,
    );
  });

  it('法务页展示完整提交 SHA 与 commit 级链接', () => {
    const page = read('app/source-and-license/page.tsx');
    expect(page).toContain('resolveBuildInfo');
    expect(page).toContain('commitSha');
    expect(page).toContain('commitTreeUrl');
    expect(page).toContain(LICENSE_ID);
  });
});

describe('安全与范围约束（§8 D6 / §9 D7）', () => {
  // 下面几条全量扫描分成两类，**不要统一**：
  //   - 会话名、NEXT_PUBLIC_ 变量、凭证载体：连注释一起扫。写进注释里的密钥同样是泄露，
  //     去掉注释就等于给「把 token 注掉先提交」留了口子。
  //   - 「不得依赖服务端单元」：去注释后再扫（见 forbiddenHits 的说明）。它判的是依赖，
  //     而 `src/index.ts` 的头注释里有一句散文正好点名 `apps/runtime`。
  it('冻结的会话 Cookie 名 littleq_session 在 apps/web 里一个字符都没出现', () => {
    // M2b 之前不得占用这个名字（既有裁定）。这条门禁可染红：任何文件写上它就红。
    const hits = sourceFiles().filter((file) => read(file).includes('littleq_session'));
    expect(hits).toEqual([]);
  });

  it('零凭证：除已声明的非机密构建变量外，没有任何 NEXT_PUBLIC_ 变量被引用', () => {
    const leaked = new Set<string>();
    for (const file of sourceFiles()) {
      for (const match of read(file).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
        leaked.add(match[0] ?? '');
      }
    }
    expect([...leaked].sort()).toEqual(['NEXT_PUBLIC_LITTLEQ_SOURCE_URL']);
  });

  it('零认证：源码里不出现凭证载体', () => {
    const forbidden = [
      'Authorization',
      'Bearer ',
      'set-cookie',
      'document.cookie',
      'apiKey',
      'API_KEY',
    ];
    const hits = sourceFiles().flatMap((file) =>
      forbidden.filter((token) => read(file).includes(token)).map((token) => `${file}: ${token}`),
    );
    expect(hits).toEqual([]);
  });

  it('零 API 路由、零 rewrite / redirect：静态路由只有设计文档列出的那几个', () => {
    // §9：apps/web 不得有 /api/*、catch-all 代理、队列或定时任务。
    expect(readdirSync(join(PACKAGE_ROOT, 'app')).includes('api')).toBe(false);
    const config = read('next.config.ts');
    // 只匹配**配置项**（行首缩进 + 键 + :/(/=），不匹配注释里的散文 ——
    // next.config.ts 的头部注释刻意写明了「不配 rewrites / redirects」，那是说明不是配置。
    expect(config).not.toMatch(/^\s*(rewrites|redirects|headers|proxy)\s*[:=(]/m);
    expect(config).toContain('unoptimized: true');
    // Q3-补-2：`trailingSlash: true` 不许借这次切换顺手摘掉（`/source-and-license/` 的
    // 尾斜杠形态对齐在它上面），所以它是正向钉子，和下面的反向钉子一样走行首锚定。
    expect(config).toMatch(/^\s*trailingSlash\s*:\s*true\s*,/m);
  });

  it('构建形态是服务构建：静态导出那个键不在配置对象里（附阳性对照）', () => {
    // ZLQ-232 按 Q3 裁定把 apps/web 翻成服务构建，旧版那条 `toContain("output: 'export'")`
    // 因此反转。反转之后仍然必须**行首锚定**：next.config.ts 的头部注释在解释这个键
    // 为什么被移除，全文 includes 会被那句说明绊住 —— 而一条被自己的说明绊红的门，
    // 之后再也分不清「真的退回了静态导出」和「碰巧又提到这个词」。
    const directive = /^\s*output\s*:/m;
    // 阳性对照：这个正则确实抓得住配置对象里的静态导出声明，且不被散文与别的键骗过。
    expect(directive.test("const nextConfig = {\n  output: 'export',\n};")).toBe(true);
    expect(directive.test(' * 只移除了 output 取 export 那一行')).toBe(false);
    expect(directive.test('const nextConfig = {\n  trailingSlash: true,\n};')).toBe(false);

    const config = read('next.config.ts');
    expect(config).not.toMatch(directive);
    // 反向对照：去注释后配置对象里剩下的键就是这四个，多一个「静态导出」都会让上面变红。
    const keys = [...stripComments(config).matchAll(/^\s{2}([A-Za-z]+)\s*:/gm)].map((m) => m[1]);
    expect(keys).toEqual(['trailingSlash', 'images', 'transpilePackages', 'reactStrictMode']);
  });

  it('不得依赖服务端单元（§9）', () => {
    const forbidden = [
      'apps/api',
      'apps/worker',
      'apps/runtime',
      '@littleq/infra',
      'packages/infra',
    ];
    // 只有这条门禁去注释后再扫：它判的是「依赖」，而 `src/index.ts` 的头注释里有一句
    // 散文正好写着 `apps/runtime`（说明作品由谁隔离托管）—— 那是说明，不是依赖。
    // 上面两条（会话名、凭证载体）**刻意不去注释**：写进注释里的密钥同样是泄露。
    const hits = sourceFiles().flatMap((file) =>
      forbiddenHits(read(file), forbidden).map((token) => `${file}: ${token}`),
    );
    expect(hits).toEqual([]);
  });

  it('去注释扫描器本身有效：能抓住真依赖，且不被散文与 URL 骗过', () => {
    // 反空对照。少了这一条，「把 stripComments 写成返回空串」也能让上面那条门禁全绿 ——
    // 扫不到任何东西当然零命中。这里用四段合成源码把扫描器的四种行为各钉一次。
    const token = 'apps/runtime';
    // ① 真的 import：必须命中。
    expect(forbiddenHits(`import { run } from '${token}/index.js';`, [token])).toEqual([token]);
    // ② 字符串路径（不走 import 也算依赖）：必须命中。
    expect(forbiddenHits(`const dir = '${token}/dist';`, [token])).toEqual([token]);
    // ③ 注释里的散文与注释掉的 import：都不得命中。
    expect(
      forbiddenHits(`// 作品由 ${token} 托管\n/* import x from '${token}'; */`, [token]),
    ).toEqual([]);
    // ④ 字符串里的 `//` 不是行注释起点：其后同行的真依赖仍须命中。
    expect(forbiddenHits(`const u = "https://x.dev"; import('${token}');`, [token])).toEqual([
      token,
    ]);
    // ⑤ 线上确实存在那句散文，且去注释后确实消失了 —— 证明①~④不是空跑。
    const real = read('src/index.ts');
    expect(real.includes(token)).toBe(true);
    expect(stripComments(real).includes(token)).toBe(false);
  });

  it('vercel.json 只承载静态响应安全头，四项最小要求齐备（§4）', () => {
    const config = JSON.parse(read('vercel.json')) as {
      headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const entries = config.headers?.flatMap((rule) => rule.headers) ?? [];
    const byKey = new Map(entries.map((entry) => [entry.key.toLowerCase(), entry.value]));

    expect(byKey.get('x-content-type-options')).toBe('nosniff');
    expect(byKey.get('referrer-policy')).toBe('strict-origin-when-cross-origin');

    const permissions = byKey.get('permissions-policy') ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(permissions, `Permissions-Policy 没有禁用 ${feature}`).toContain(`${feature}=()`);
    }

    const csp = byKey.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // 不得给任何远端源开口子：一旦出现绝对 URL 或通配符，第三方脚本/样式就能被加载，
    // 那正是 e2e「无第三方资源请求」这条断言在配置层的对应物。
    // 允许的关键字源（'self' / 'none' / data:）不是远端源，所以这里只禁 URL 与 *。
    expect(csp).not.toMatch(/\*/);
    expect(csp).not.toContain('http://');
    expect(csp).not.toContain('https://');
    expect(csp).not.toContain("'unsafe-eval'");
    for (const directive of ['script-src', 'style-src', 'img-src', 'connect-src', 'font-src']) {
      expect(csp, `CSP 缺少 ${directive}`).toContain(directive);
    }
  });

  it('vercel.json 不配置构建/路由职责：那些由 Vercel 项目设置与 next.config.ts 承担', () => {
    const raw = read('vercel.json');
    // 仓库根不得再出现第二份 Vercel 入口（§4），这份只放安全头。
    for (const key of ['builds', 'routes', 'rewrites', 'redirects', 'functions', 'regions']) {
      expect(raw, `vercel.json 里出现了 ${key}`).not.toContain(`"${key}"`);
    }
  });
});

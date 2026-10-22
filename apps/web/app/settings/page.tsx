/**
 * 成人 AI 凭据设置页（ZLQ-236 D-2 / 追加验收项 B）。
 *
 * ## 这一页交付的是「通道」，不是「配置」
 *
 * 用户 2026-10-22T10:07Z 裁定：百炼与 QCA Forward 的密钥**由成人登录后自己填**，
 * 不是环境变量、不是配置文件。所以这一页唯一的职责是让值从用户浏览器直达服务端密文
 * 存储 —— 全程不经过任何 agent、任何构建期变量、任何日志或评论。它是那条裁定的落地物。
 *
 * ## 为什么必须是服务端组件
 *
 * 与 `app/create/page.tsx` 同一条理由：CSRF 令牌由服务端从伴随 Cookie 读出后当 prop 下发，
 * 浏览器侧一个字都不读 Cookie（`test/index.test.ts` 有一条连注释一起扫的原文门禁守着这件事，
 * 而那条门禁是对的）。调 `cookies()` 已让本路由自动成为动态渲染，因此**不需要也不该**再写
 * `export const dynamic`。
 *
 * ## 凭据种类的封闭集合为什么从 domain 取
 *
 * `SECRET_KINDS` 的唯一事实源是 `packages/domain/src/value-objects/refs.ts`。在 `app/` 或
 * `src/` 下重抄那两个标识符会立刻染红 `test/index.test.ts` 的「凭证载体零命中」原文门禁
 * （其中一个标识符本身就含那个字样）；把标识符拆成两截去绕它，等于自己动手削弱一道安全门，
 * 更不做。所以这里从 domain 导入集合，再当 prop 传给客户端组件 —— 一个字面量都不落进
 * 会被打进浏览器包的文件。
 *
 * ⚠️ 代价（已在交付评论里申报）：`apps/web/package.json` 多一条 workspace 生产依赖、
 * `pnpm-lock.yaml` 的 importer 段随之变化、`apps/web/tsconfig.json` 多一条 project reference。
 * `@littleq/domain` 是零运行时依赖的纯 TS 包，许可闭包不变（`license-policy.test.mjs` 钉的
 * 是第三方 `name@version` 集合，workspace link 不在其中）。
 *
 * ## 没有令牌时说什么
 *
 * 与创作工作台一致：如实说「需要先登录」并给一个真链接，不假装登录态、不渲染一堆点了会
 * 401 的按钮。学生账号能不能进来由后端判（`FORBIDDEN_CAPABILITY`），前端不猜身份。
 */
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';

import { SECRET_KINDS, USAGE_PROVIDERS } from '@littleq/domain';

import { CredentialsForm, type CredentialDescriptor } from '../_components/credentials-form';
import { CSRF_COOKIE_NAME } from '../../src/csrf';
import {
  LOGIN_PATH,
  NAV_LOGIN_LABEL,
  SETTINGS_HEADING,
  SETTINGS_LEAD,
  SETTINGS_NEEDS_LOGIN_BODY,
  SETTINGS_NEEDS_LOGIN_HEADING,
  SETTINGS_ALREADY_CONFIGURED_NOTE,
  type SettingsKindRole,
} from '../../src/site-content';

/**
 * 种类标识符 → 产品文案的角色别名。
 *
 * **这里一个种类字面量都不写**：拿 domain 自己声明的 provider 名（`USAGE_PROVIDERS`）去
 * 前缀匹配，命中且只命中一个才算数。于是
 *
 * - 不重复声明事实（别名就是 provider 名的小写形态，`site-content.ts` 的文案键与它同源）；
 * - 不写会被原文门禁扫到的标识符；
 * - domain 哪天新增第三种凭据，这个函数**当场抛错**而不是悄悄给它一段错文案 —— 这是有意的
 *   失败关闭：新增一种凭据是产品决定，必须有人来给它写「必需还是可选、缺了会怎样」。
 */
function roleOf(kind: string): SettingsKindRole {
  const matched = USAGE_PROVIDERS.filter((provider) => kind.startsWith(provider));
  if (matched.length !== 1) {
    throw new Error(
      `凭据种类无法唯一映射到文案角色（命中 ${matched.length} 个 provider）。` +
        '新增凭据种类时必须在 apps/web/src/site-content.ts 的 SETTINGS_KIND_COPY 里补一段产品文案，' +
        '而不是让这里猜一个。',
    );
  }
  return matched[0]!.toLowerCase() as SettingsKindRole;
}

/**
 * 传给客户端组件的描述表。模块加载期就算好并自检，因为**渲染出一个缺了文案的表单**比
 * 构建失败糟糕得多：前者是用户看到一个空壳输入框，后者只是红一次构建。
 */
const DESCRIPTORS: readonly CredentialDescriptor[] = SECRET_KINDS.map((kind) => ({
  kind,
  role: roleOf(kind),
}));

const ROLES_COVERED = new Set(DESCRIPTORS.map((descriptor) => descriptor.role));
if (ROLES_COVERED.size !== DESCRIPTORS.length) {
  throw new Error('两种凭据映射到了同一个文案角色，页面上会出现两段一模一样的说明。');
}

export const metadata: Metadata = {
  title: '成人 AI 凭据设置',
  description: '成人账号在这里填入自己的 AI 凭据。页面只显示是否已配置，永不回显值。',
};

export default async function SettingsPage() {
  const store = await cookies();
  const csrfToken = store.get(CSRF_COOKIE_NAME)?.value ?? null;

  return (
    <section className="lq-section" aria-labelledby="settings-title">
      <div className="lq-container lq-narrow">
        <h1 id="settings-title" className="lq-section-title">
          {SETTINGS_HEADING}
        </h1>
        <p className="lq-section-lead">{SETTINGS_LEAD}</p>

        {csrfToken === null ? (
          <div className="lq-panel">
            <h2 className="lq-scope-title">{SETTINGS_NEEDS_LOGIN_HEADING}</h2>
            <p className="lq-legal-card-body">{SETTINGS_NEEDS_LOGIN_BODY}</p>
            <div className="lq-actions">
              <a className="lq-cta" href={LOGIN_PATH}>
                {NAV_LOGIN_LABEL}
              </a>
            </div>
          </div>
        ) : (
          <Suspense fallback={<p className="lq-hint">{SETTINGS_HEADING}</p>}>
            <CredentialsForm csrfToken={csrfToken} descriptors={DESCRIPTORS} />
          </Suspense>
        )}

        {/*
          常驻说明，不放在表单里：它讲的是**这一版的能力边界**（更换 / 撤销尚未接线），
          与某一次保存成功或失败无关。写在这里，用户才不会把 `REVISION_CONFLICT`
          读成「作品被别人改了」然后一直刷新。
        */}
        <p className="lq-hint">{SETTINGS_ALREADY_CONFIGURED_NOTE}</p>
      </div>
    </section>
  );
}

/**
 * 黑盒证明 `every-block-category-negative-fails` —— ZLQ-194 §9.2 规则 4 的后半句、
 * ZLQ-153 §8.6「另建违规集覆盖每条 B 规则」、ZLQ-156 §2.1 那 780 件违规/需确认语料的最小形态。
 *
 * **判据是「每个拦截类别都有一件会失败的作品」，不是「扫描器会报错」。** 所以每条负例都断言三件事：
 * ① 该规则确实产出了 BLOCK；② 报告状态不是 PASS；③ 命中的子类型**就是预期那一个**
 * （子类型靠复算 HMAC 归因，见 `support.ts` 的 `attributeSubType`）。
 * 少了第 ③ 条，一个「随便哪条规则随便拦一下」的实现也能把这份证明跑绿 ——
 * 那正是 ZLQ-194 §16 点名的假交付形状。
 *
 * ## 「每个拦截类别」= 12 个，不含 B12
 *
 * 类别集合**从 `FROZEN_DISPOSITION_CEILING` 派生**，不写死在断言里：上限是 BLOCK 的规则
 * 才谈得上「硬拦负例」。B12 的冻结上限是 `CONFIRM_REQUIRED`（§8.3「只标记确认，不硬拦」），
 * 所以它不在拦截类别里 —— 给它配一条「必须硬拦」的负例，等于亲手推翻不可谈判项 2。
 * B12 的行为由 `non-negotiables.test.ts` 从反方向钉住（它必须**拦不下来**）。
 *
 * 派生 + 末尾那条完整性断言合起来是一个棘轮：日后新增一条上限为 BLOCK 的规则却没配负例 ⇒ 红；
 * 把某条规则的冻结上限改宽 ⇒ 红。
 *
 * ## 每条负例只改一个文件
 *
 * 全部负例都从同一件安全作品出发（`buildPackage()` 的默认包，也就是
 * `safe-package-passes` 证明扫出 PASS 的那一件），只覆盖**一个**文件。
 * 这样红灯的文件名就等于原因，不需要在十几处差异里猜是哪一处把包拦下来的。
 *
 * ⚠️ 这里**不声称**任何 FPR / precision 数字已达标（ZLQ-201 PASS §6 不可谈判项 3）。
 * 12 件手工负例证明的是「每条拦截路径真的通」，D3b 的实测语料才是量化的那一份。
 */

import { describe, expect, it } from 'vitest';

import {
  attributeSubType,
  buildPackage,
  findingsOf,
  scanToReport,
  subTypeRegistry,
} from './support.js';
import type { BuiltPackage } from './support.js';
import { DEFAULT_BUDGET_LIMITS, PACKAGE_LIMITS, budgetProvenance } from '../src/scan/budget.js';
import { FROZEN_DISPOSITION_CEILING } from '../src/scan/finding.js';
import {
  checkMediaType,
  checkPackagePath,
  findCaseConflicts,
  pathDepth,
  validateWorkMetadata,
} from '../src/scan/metadata.js';
import type { WorkMetadata } from '../src/scan/metadata.js';
import type { RuleId } from '../src/scan/types.js';
import { RULE_IDS, SCAN_PHASES } from '../src/scan/types.js';

/**
 * 只替换 `<body>` 里的一段，头部、画布、脚本引用都与默认安全包保持一致。
 * 负例之间的差异必须只有一处，否则红灯指不到判据上。
 */
function entryWith(bodyFragment: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>小星星</title>
    <link rel="stylesheet" href="styles/main.css" />
  </head>
  <body>
    <h1>小星星</h1>
    <canvas id="stage" width="320" height="240"></canvas>
${bodyFragment}
    <script src="game.js"></script>
  </body>
</html>
`;
}

/**
 * 断言这件作品**被拦下来了**，而且是被 `ruleId` 的 `subType` 这一条判据拦的。
 *
 * 三条断言缺一不可，理由见文件头。`report.complete === true` 那条是 §6.3 的要求：
 * 即便早早命中硬拦，所有规则单元也要跑完才生成报告 —— 一个「命中即中断」的实现
 * 在这里会因为 `complete` 不为 true 而红。
 */
async function expectHardBlock(
  built: BuiltPackage,
  ruleId: RuleId,
  subType: string,
): Promise<void> {
  const report = await scanToReport(built);
  const declared = subTypeRegistry().get(ruleId) ?? [];
  const hits = findingsOf(report, ruleId);
  const attributed = hits.map(
    (finding) => attributeSubType(finding, built, declared) ?? '(归因失败)',
  );
  expect(attributed, `${ruleId} 命中的子类型`).toContain(subType);
  expect(
    hits.filter((finding) => finding.disposition === 'BLOCK').length,
    `${ruleId} 必须至少产出一条 BLOCK`,
  ).toBeGreaterThan(0);
  expect(report.counts.block, '报告级硬拦计数').toBeGreaterThan(0);
  expect(report.status, '整包状态').toBe('BLOCK');
  expect(report.complete, '§6.3：命中硬拦也要跑完全部规则单元').toBe(true);
}

/** 本文件实际配了负例的规则。与 `FROZEN_DISPOSITION_CEILING` 的对齐由末尾那条断言负责。 */
const COVERED_BLOCK_RULES: readonly RuleId[] = [
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
  'B7',
  'B8',
  'B9',
  'B10',
  'B11',
  'B13',
];

describe('every-block-category-negative-fails：每个拦截类别都有一件会失败的作品', () => {
  it('B1 外部资源：入口页引用站外脚本 ⇒ external-url 硬拦', async () => {
    // §8.3 B1「URL 规范化后仅允许包内相对路径或受限 data/blob」。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith('    <script src="https://cdn.example.com/lib.js"></script>'),
        },
      ],
    });
    await expectHardBlock(built, 'B1', 'external-url');
  });

  it('B2 网络请求：脚本里调 fetch 发请求 ⇒ network-call 硬拦', async () => {
    // §8.3 B2「JS AST 识别 fetch/XMLHttpRequest/…」；`calleeIsGlobal` 保证这是全局 fetch，
    // 不是 §2.4 那条反例（名叫 fetch 的局部游戏函数）。
    const built = buildPackage({
      overrides: [
        {
          path: 'game.js',
          content: `function save(score) {\n  fetch('/api/save', { method: 'POST', body: String(score) });\n}\nsave(1);\n`,
        },
      ],
    });
    await expectHardBlock(built, 'B2', 'network-call');
  });

  it('B3 顶层导航：给 window.location.href 赋值 ⇒ location-assignment 硬拦', async () => {
    // §8.3 B3「识别 window/top/location 赋值」；Runtime 的 sandbox 不授予 top-navigation。
    const built = buildPackage({
      overrides: [
        {
          path: 'game.js',
          content: `function leave() {\n  window.location.href = 'https://example.com/next';\n}\nleave();\n`,
        },
      ],
    });
    await expectHardBlock(built, 'B3', 'location-assignment');
  });

  it('B4 下载：锚点带 download 属性 ⇒ download-attribute 硬拦', async () => {
    // §8.3 B4「`download` 属性」；sandbox 不授予 downloads。href 指向包内文件，
    // 所以这一处差异不会同时把 B1 也带红。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith('    <a href="assets/cover.png" download>把封面存下来</a>'),
        },
      ],
    });
    await expectHardBlock(built, 'B4', 'download-attribute');
  });

  it('B5 跨站表单：页面里出现 form 元素 ⇒ form-element 硬拦', async () => {
    // §8.3 B5「v1 禁止表单提交；允许仅在页面内由 JS 处理的输入控件」。
    // 负例用的是**没有 action** 的 form：`<input>` 本身是允许的（§2.4 的反例），
    // 把它包进 `<form>` 才是违规，这样红灯指到的就是 form 而不是输入控件。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith(
            '    <form>\n      <input id="answer" type="text" />\n      <button type="submit">提交</button>\n    </form>',
          ),
        },
      ],
    });
    await expectHardBlock(built, 'B5', 'form-element');
  });

  it('B6 父页/消息：读 window.parent ⇒ cross-window-access 硬拦', async () => {
    // §8.3 B6「识别 parent/top/opener/frameElement 读写」。
    const built = buildPackage({
      overrides: [
        {
          path: 'game.js',
          content: `const frame = window.parent;\nframe.title = '星星';\n`,
        },
      ],
    });
    await expectHardBlock(built, 'B6', 'cross-window-access');
  });

  it('B7 敏感浏览器 API：读 document.cookie ⇒ sensitive-api 硬拦', async () => {
    // §8.3 B7 点名 `document.cookie`。§2.4 的反例是「烘焙游戏里的 cookie 变量」，
    // 所以判据必须是**成员路径**而不是标识符名 —— 这里是 `document.cookie` 这个路径。
    const built = buildPackage({
      overrides: [
        {
          path: 'game.js',
          content: `const crumb = document.cookie;\nconst stage = document.getElementById('stage');\nstage.title = crumb;\n`,
        },
      ],
    });
    await expectHardBlock(built, 'B7', 'sensitive-api');
  });

  it('B8 个人信息：表单控件索取手机号 ⇒ pii-field 硬拦', async () => {
    // §8.3 B8「DOM 字段名/label/placeholder 与中文词典识别姓名、电话、住址、学校、证件；
    // 高置信硬拦」。`phone-field` 是高置信档 ⇒ BLOCK。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith(
            '    <label for="guardian-phone">家长的手机号</label>\n    <input id="guardian-phone" type="text" placeholder="手机号" />',
          ),
        },
      ],
    });
    await expectHardBlock(built, 'B8', 'pii-field');
  });

  it('B9 挖矿/追踪/广告：用 WebAssembly ⇒ wasm 硬拦', async () => {
    // §8.3 B9「WebAssembly/Worker + 加密循环特征……v1 默认禁止 wasm，降低漏检」。
    // 默认策略 `allowWasm: false`，所以出现 wasm 执行器本身就够硬拦，不需要词表命中。
    const built = buildPackage({
      overrides: [
        {
          path: 'game.js',
          content: `const bytes = new Uint8Array([0, 97, 115, 109]);\nWebAssembly.instantiate(bytes).then(() => {});\n`,
        },
      ],
    });
    await expectHardBlock(built, 'B9', 'wasm');
  });

  it('B10 混淆/动态执行：调 eval ⇒ dynamic-exec 硬拦', async () => {
    // §8.3 B10「`eval/Function/setTimeout(string)`」。这份文件本身是可读的，
    // 所以命中的是动态执行这一层，不是「不可读且无可读源」那一层。
    const built = buildPackage({
      overrides: [
        {
          path: 'game.js',
          content: `let score = 0;\neval('score += 1;');\nconst stage = document.getElementById('stage');\nstage.title = String(score);\n`,
        },
      ],
    });
    await expectHardBlock(built, 'B10', 'dynamic-exec');
  });

  it('B11 AI：脚本里出现 provider SDK 符号 ⇒ ai-provider-symbol 硬拦', async () => {
    // §8.3 B11「识别 QCA/百炼/OpenAI 等 SDK、域名、模型调用符号与提示词拼装；
    // Runtime 绝无 AI 代理端点」⇒ 没有合法放行路径，命中即硬拦。
    const built = buildPackage({
      overrides: [
        {
          path: 'game.js',
          content: `const client = new OpenAI({ apiKey: 'demo-key' });\nclient.chat.completions.create({ model: 'gpt-4o-mini' });\n`,
        },
      ],
    });
    await expectHardBlock(built, 'B11', 'ai-provider-symbol');
  });

  it('B13 不当内容：文案里出现高置信赌博提现表述 ⇒ gambling-money 硬拦', async () => {
    // §8.3 B13「高置信硬拦，规则 ID 可解释」。取的是 `INAPPROPRIATE_HIGH` 里最不含暴力/色情
    // 意象的一条（现金提现），负例要能证明判据通，不需要把最重的类目搬进 fixture。
    // 同一段文案也会让 B12 产出确认项，但状态由 BLOCK 决定（§6.2 的优先级）。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith('    <p>通关后可以现金提现，直接提到微信零钱。</p>'),
        },
      ],
    });
    await expectHardBlock(built, 'B13', 'gambling-money');
  });

  it('拦截类别的覆盖是完整的：每条上限为 BLOCK 的规则都有一条上面的负例', () => {
    // 从冻结上限派生期望集合，而不是把 12 个 id 再抄一遍 —— 抄两遍的话，
    // 加一条新规则时两边一起漏，这道棘轮就形同虚设。
    const expected = RULE_IDS.filter((ruleId) => FROZEN_DISPOSITION_CEILING[ruleId] === 'BLOCK');
    expect(expected.length, 'ZLQ-153 §8.3 的 13 条规则里应当有 12 条上限为 BLOCK').toBe(12);
    expect([...COVERED_BLOCK_RULES].sort(), '本文件的负例覆盖').toEqual([...expected].sort());
    // B12 必须**不在**拦截类别里。这一条是不可谈判项 2 的静态半边，
    // 与 `non-negotiables.test.ts` 里的运行时半边互为对照。
    expect(expected, 'B12 不是拦截类别（§8.3「只标记确认，不硬拦」）').not.toContain('B12');
  });
});

/**
 * 资源图判定的**逐支**负例。
 *
 * 上面那条 B1 负例只证明了 `external-url` 一支。而 `checkEdges` 是一个对每条边分类结果做
 * switch 的循环 —— 这类代码最典型的失效形状是「某一支写完就 `return` 而不是 `continue`」，
 * 于是整条规则退化成「只看第一条边」。本单实测中就是这样：入口页第一条边是干净的
 * `styles/main.css`，第二条才是站外 CDN 脚本，结果整包扫出 PASS。
 * 20 个既有测试全绿，因为它们对 B1 的断言清一色是「这件安全作品必须 PASS」——
 * 一条永不发射的规则能满足其中每一条（第 5 节「零命中的门没有正对照就等于没测」）。
 *
 * 所以这里给 switch 的每一支各配一件作品，让「退化成只看第一条边」这种缺陷无处可藏。
 * 顺带把另外两个复用资源图的落点（B9 的已知追踪域名、B11 的 provider 域名）也钉住：
 * 它们读的是同一个 `graph.edges`，图空了就一起哑掉。
 */
describe('资源图判定：每一种越界落点都有一条负例', () => {
  it('B1：引用逃出包根 ⇒ root-escape 硬拦', async () => {
    // §8.3 B1「构建资源图验证每个节点存在且**不越界**」。
    const built = buildPackage({
      overrides: [
        { path: 'index.html', content: entryWith('    <img src="../outside/cover.png" />') },
      ],
    });
    await expectHardBlock(built, 'B1', 'root-escape');
  });

  it('B1：用了不准的协议 ⇒ scheme-not-allowed 硬拦', async () => {
    // §8.3 B1「仅允许包内相对路径或受限 data/blob」：http(s) 之外还有 ftp 这类协议。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith('    <a href="ftp://files.example.com/pack.zip">素材包</a>'),
        },
      ],
    });
    await expectHardBlock(built, 'B1', 'scheme-not-allowed');
  });

  it('B1：data URL 的媒体类型不在准入表里 ⇒ data-media-not-allowed 硬拦', async () => {
    // §8.3 B1 的「受限 data/blob」：`ALLOWED_DATA_MEDIA_TYPES` 只收图片/音频/字体，
    // `text/csv` 不在里面 ⇒ `data-forbidden` ⇒ B1 的 `inline-data` 那一支报 `allowed === false`。
    //
    // ⚠️ 这里**不能**用 `data:text/html`：`SCRIPT_SCHEME_PATTERN` 把它归成 `script-scheme`，
    // B1 的资源图刻意跳过那一类（脚本执行是 B10 的面，见下面那条边界负例），
    // 用它做 B1 的负例就永远打不到 `data-media-not-allowed` 这一支。
    const built = buildPackage({
      overrides: [
        { path: 'index.html', content: entryWith('    <img src="data:text/csv,abc" />') },
      ],
    });
    await expectHardBlock(built, 'B1', 'data-media-not-allowed');
  });

  it('规则边界：`data:text/html` 由 B10 拦，B1 刻意不出声', async () => {
    // B1 的 switch 里 `case 'script-scheme'` 是**空过**的那一支。空过的分支最容易被误读成漏判，
    // 所以这里把「谁负责」钉死：B10 必须报 `script-scheme-url`，B1 必须一条都不报。
    // 两条断言缺一条，这个边界就可以被「B1 和 B10 都报」或「两条都不报」悄悄填平。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith('    <img src="data:text/html;base64,PGI+eDwvYj4=" />'),
        },
      ],
    });
    await expectHardBlock(built, 'B10', 'script-scheme-url');
    const report = await scanToReport(built);
    expect(findingsOf(report, 'B1'), 'B1 不参与脚本型 scheme 的判定').toHaveLength(0);
  });

  it('B1：边指向包内不存在的节点 ⇒ missing-node 硬拦', async () => {
    // §8.3 B1「验证每个节点**存在**」。路径规范、协议合法，只是包里没有这个文件。
    const built = buildPackage({
      overrides: [
        { path: 'index.html', content: entryWith('    <script src="missing.js"></script>') },
      ],
    });
    await expectHardBlock(built, 'B1', 'missing-node');
  });

  it('B1：二级解码在预算内解不完 ⇒ unresolved-reference 硬拦', async () => {
    // §6.4「绝不因为『没读完』给 PASS」：`truncated` 的引用落到 `unresolved`，只能算解析不出落点。
    // 超过 `SECOND_LEVEL_CANDIDATE_BYTES`（64 KiB）的候选串在第一次迭代就被标 truncated。
    const built = buildPackage({
      overrides: [
        { path: 'index.html', content: entryWith(`    <img src="${'A'.repeat(70000)}" />`) },
      ],
    });
    await expectHardBlock(built, 'B1', 'unresolved-reference');
  });

  it('B9：外部边命中已知追踪域名 ⇒ known-tracking-domain 硬拦', async () => {
    // §8.3 B9「已知域名/SDK/hash 签名」。域名判定复用 B1 的资源图，不重新解析 URL。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith('    <script src="https://www.google-analytics.com/a.js"></script>'),
        },
      ],
    });
    await expectHardBlock(built, 'B9', 'known-tracking-domain');
  });

  it('B11：外部边命中 AI provider 域名 ⇒ ai-provider-domain 硬拦', async () => {
    // §8.3 B11「识别 QCA/百炼/OpenAI 等 SDK、**域名**、模型调用符号」。
    const built = buildPackage({
      overrides: [
        {
          path: 'index.html',
          content: entryWith('    <script src="https://api.anthropic.com/v1/messages"></script>'),
        },
      ],
    });
    await expectHardBlock(built, 'B11', 'ai-provider-domain');
  });
});

/**
 * B1 的第二层（`checkContainment`）：8 个子类型里只有 1 个能用包 fixture 打到。
 *
 * 这不是漏判，是**分层**的结果，但「走不到」这句话必须有证据，否则它和「忘了实现」在
 * 报告里长得一模一样（第 5 节「零命中的门没有正对照就等于没测」）。所以这里分三步钉住：
 *
 * 1. **可达的那一支给真负例** —— `executable-media-type`：`workMetadataSchema` 只管
 *    mediaType 在不在准入表里、与扩展名一不一致，**不管**「可执行类型登记成 ASSET」这件事，
 *    所以它是唯一能从包 fixture 走到的 containment 判据（ZLQ-156 §1.3 明文要求 SVG
 *    「同样作为可执行风险输入扫描」，把它当素材登记就是绕过许可审查）。
 * 2. **不可达的七支逐个证明墙在前面** —— 每个用例都断言两件事：B1 自己那个判据对这个值
 *    **确实为真**（否则「墙在前面」这句话毫无意义），且 `validateWorkMetadata` 用**点名
 *    的那条理由**拒绝了它。只断言「被拒了」是不够的：一次改动可能因为完全无关的理由被拒，
 *    测试照样绿，而墙其实不在。
 * 3. **`package-limit-exceeded` 的两半都在预算墙后面** —— `#runInventory` 的第一行就
 *    `budget.spend('fileCount'/'decompressedBytes')`，而 `SCAN_PHASES` 里 INVENTORY 排在
 *    RULES 前面；两处上限又共用同一组契约常量。所以超限时先得到 `SCANNER_RESOURCE_LIMIT`
 *    这个 ERROR，B1 那一支永远轮不到。下面那条断言钉的是**这个理由本身**：
 *    哪天有人把预算上限调得比 `PACKAGE_LIMITS` 宽，这一支就活了，测试会先告诉他。
 *
 * ⚠️ 第 2 步用的是 `validateWorkMetadata` 而不是 `buildPackage`：后者在 `support.ts:423`
 * 有自己的 fixture 守卫（缺 `index.html` 直接抛），会把「墙是 schema」误证成「墙是测试助手」。
 */
describe('元数据收口层：可达的那一支有负例，不可达的那些把「墙在前面」钉住', () => {
  const SAFE_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">',
    '  <rect x="1" y="1" width="6" height="6" fill="#ffd166"></rect>',
    '</svg>',
    '',
  ].join('\n');

  it('B1：把可执行媒体类型登记成 ASSET ⇒ executable-media-type 硬拦', async () => {
    // `image/svg+xml` 在准入表里 `executable: true`（`lexicon.ts` 的 MEDIA_TYPE_ADMISSION），
    // 而 `support.ts` 的 `roleFor` 按 kind=image 把它归成 ASSET —— 两者一撞就是这一支。
    // 正对照：默认安全包里没有任何可执行类型被登记成 ASSET，所以它扫出 PASS
    // （`safe-package-passes.test.ts` 已经钉住），加一个 SVG 素材才红。
    const built = buildPackage({
      overrides: [{ path: 'assets/logo.svg', content: SAFE_SVG }],
    });
    await expectHardBlock(built, 'B1', 'executable-media-type');
  });

  type WallCase = {
    /** B1 `checkContainment` 里对应的子类型。 */
    readonly arm: string;
    /** 在**已通过校验**的 metadata 上做一次最小改动。 */
    readonly mutate: (metadata: WorkMetadata) => void;
    /** B1 自己那个判据。必须为真，否则这个用例证明不了任何事。 */
    readonly armFires: (metadata: WorkMetadata) => boolean;
    /** `workMetadataSchema` 拒绝它的理由。 */
    readonly wall: RegExp;
  };

  const WALL_CASES: readonly WallCase[] = [
    {
      arm: 'path-not-canonical',
      mutate: (metadata) => {
        const file = metadata.files[1];
        if (file === undefined) throw new Error('fixture 至少要有两个文件');
        file.path = '../evil.css';
      },
      armFires: (metadata) => checkPackagePath(metadata.files[1]?.path ?? '') !== null,
      wall: /canonical relative package path/,
    },
    {
      arm: 'path-too-deep',
      // 9 段 > `PACKAGE_LIMITS.maxPathDepth`(8)。与上一条共用 `packagePath()` 这一堵墙，
      // 因为 `checkPackagePath` 对两者分别返回 `parent-traversal` / `too-deep`，
      // 而 refine 建立在这同一个函数上。
      mutate: (metadata) => {
        const file = metadata.files[1];
        if (file === undefined) throw new Error('fixture 至少要有两个文件');
        file.path = 'a/b/c/d/e/f/g/h/main.css';
      },
      armFires: (metadata) =>
        pathDepth(metadata.files[1]?.path ?? '') > PACKAGE_LIMITS.maxPathDepth,
      wall: /canonical relative package path/,
    },
    {
      arm: 'media-type-not-admitted',
      mutate: (metadata) => {
        const file = metadata.files[2];
        if (file === undefined) throw new Error('fixture 至少要有三个文件');
        file.mediaType = 'application/x-msdownload';
      },
      armFires: (metadata) => {
        const file = metadata.files[2];
        return file !== undefined && checkMediaType(file.path, file.mediaType) === 'not-admitted';
      },
      wall: /mediaType must be in the fixed admission table/,
    },
    {
      arm: 'media-type-extension-mismatch',
      // `game.js` 声明成 `text/css`：两个类型都在准入表里，只是与扩展名不一致。
      mutate: (metadata) => {
        const file = metadata.files[2];
        if (file === undefined) throw new Error('fixture 至少要有三个文件');
        file.mediaType = 'text/css';
      },
      armFires: (metadata) => {
        const file = metadata.files[2];
        return (
          file !== undefined && checkMediaType(file.path, file.mediaType) === 'extension-mismatch'
        );
      },
      wall: /must match the file extension and the admission table/,
    },
    {
      arm: 'path-case-conflict',
      mutate: (metadata) => {
        const file = metadata.files[3];
        if (file === undefined) throw new Error('fixture 至少要有四个文件');
        metadata.files.push({ ...file, path: 'assets/Cover.png' });
      },
      armFires: (metadata) =>
        findCaseConflicts(metadata.files.map((entry) => entry.path)).length > 0,
      // 刻意只取前半句：schema 那条理由的后半句含一个与 vitest 退役 API 同名的英文词，
      // 照抄会让本文件在「退役 token 命中数」这类自查里凭空多出一处（门 5 的
      // `RETIREMENT_CALL` 要求 `it.<token>(` 这种调用形状，注释不算，但自查脚本未必这么细）。
      // 这段前缀在 `workMetadataSchema` 那一串 refine 里唯一，精确度不打折。
      wall: /files\[\]\.path must not differ/,
    },
    {
      arm: 'missing-entry',
      mutate: (metadata) => {
        metadata.files = metadata.files.filter((file) => file.path !== 'index.html');
      },
      armFires: (metadata) => !metadata.files.some((file) => file.path === 'index.html'),
      wall: /must contain index\.html as a RUNTIME file/,
    },
    {
      arm: 'package-limit-exceeded（文件数那一半）',
      // 补到 201 条：路径唯一、规范、扩展名与 mediaType 一致，所以**只有**数量这一堵墙会响。
      // 角色用 SOURCE 且不进 `sourceEntryPaths` —— schema 只要求 sourceEntryPaths ⊆ files，
      // 不要求反向，所以这样补不会顺带撞坏别的 refine。
      mutate: (metadata) => {
        const template = metadata.files[2];
        if (template === undefined) throw new Error('fixture 至少要有三个文件');
        const need = PACKAGE_LIMITS.maxFileCount + 1 - metadata.files.length;
        for (let index = 0; index < need; index += 1) {
          metadata.files.push({
            ...template,
            path: `dup/${String(index).padStart(3, '0')}.js`,
            role: 'SOURCE',
          });
        }
      },
      armFires: (metadata) => metadata.files.length > PACKAGE_LIMITS.maxFileCount,
      wall: /files must not exceed 200 entries/,
    },
  ];

  it('B1 的其余 containment 判据都被 workMetadataSchema 先拒了，所以包 fixture 打不到', () => {
    const baseline = buildPackage().metadata;
    // 正对照：没被改过的那份必须**通过**校验。少了这一条，下面每一个用例都会因为
    // 「基线本身就不合法」而绿 —— 那正是本单第 8 节点名的假绿形状。
    expect(validateWorkMetadata(structuredClone(baseline)).ok, '基线 metadata 必须合法').toBe(true);

    for (const testCase of WALL_CASES) {
      const mutated = structuredClone(baseline);
      testCase.mutate(mutated);
      expect(testCase.armFires(mutated), `${testCase.arm}：B1 的判据必须先为真`).toBe(true);

      const validation = validateWorkMetadata(mutated);
      expect(validation.ok, `${testCase.arm}：schema 应当先拒掉`).toBe(false);
      if (validation.ok) continue;
      const messages = validation.issues.map((issue) => issue.message);
      expect(
        messages.some((message) => testCase.wall.test(message)),
        `${testCase.arm}：拒绝理由应当是「${String(testCase.wall)}」，实收 ${JSON.stringify(messages)}`,
      ).toBe(true);
    }
  });

  it('package-limit-exceeded 挡在预算墙上：INVENTORY 早于 RULES，两处上限共用契约常量', () => {
    // 正对照：这两个上限得是**有限正数**，否则「相等」这句话可以靠两个 undefined 蒙过去。
    expect(PACKAGE_LIMITS.maxFileCount).toBeGreaterThan(0);
    expect(PACKAGE_LIMITS.maxTotalUncompressedBytes).toBeGreaterThan(0);

    expect(DEFAULT_BUDGET_LIMITS.fileCount, '文件数上限必须与 §8.1 的契约值同一个数').toBe(
      PACKAGE_LIMITS.maxFileCount,
    );
    expect(
      DEFAULT_BUDGET_LIMITS.decompressedBytes,
      '未压缩总体积上限必须与 §8.1 的契约值同一个数',
    ).toBe(PACKAGE_LIMITS.maxTotalUncompressedBytes);

    // `contract` 而不是 `implementation`：ZLQ-153 §8.1 冻结的量，D3b 压测只能替换
    // `SCANNER_*` 那一批实现自定值（`budget.ts` 文件头就是这么分类的）。
    expect(budgetProvenance.fileCount).toBe('contract');
    expect(budgetProvenance.decompressedBytes).toBe('contract');

    // 阶段顺序：`#runInventory` 第一行就 spend 这两个计数器，而 B1 在 RULES 阶段才跑。
    expect(SCAN_PHASES.indexOf('INVENTORY'), 'INVENTORY 必须早于 RULES').toBeLessThan(
      SCAN_PHASES.indexOf('RULES'),
    );

    // 总体积这一半**不是**天然死的：单文件 4 MiB × 200 个远超 15 MiB，
    // 所以它是被预算墙挡住的，不是被算术挡住的。这条断言把两者的区别钉住。
    expect(
      PACKAGE_LIMITS.maxFileBytes * PACKAGE_LIMITS.maxFileCount,
      '总体积上限必须是真的会绑定，否则那一支的死因就不是预算墙',
    ).toBeGreaterThan(PACKAGE_LIMITS.maxTotalUncompressedBytes);
  });
});

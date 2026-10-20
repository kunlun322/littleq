/**
 * 黑盒证明 `safe-package-passes` —— ZLQ-194 §9.2 规则 4、ZLQ-153 §8.6、ZLQ-156 §2.4。
 *
 * **判据是「一件安全作品扫出 PASS、零命中」，不是「扫描器不崩」。** 所以这里的每个用例都断言
 * `findings` 为空、`status === 'PASS'`，而不是只断言 `ok === true`。
 *
 * 第二部分是 ZLQ-156 §2.4 那张表的**逐条落地**：每条 B 规则都给出了「长得像违规、其实安全」的
 * 反例，扫描器必须放行。这张表就是 §8.6「false_block_rate ≤2%」的最小可执行形态 —— D3b 的
 * 600 件安全语料是它的放大版，不是替代品。§8 的变异对照 3 也正是拿这些反例把纯正则实现染红的：
 * 任何一条退化成「看见这个词就拦」，对应的反例立刻失败。
 *
 * ⚠️ 这里**不声称**任何 FPR / precision 数字已达标（ZLQ-201 PASS §6 非协商项 3）。
 * 十几个手工反例证明的是「判定是真的」，不是「误拦率是 2%」。后者要 D3b 的实测语料。
 */

import { describe, expect, it } from 'vitest';

import {
  attributeSubType,
  buildPackage,
  ENTRY_HTML_WITH_LICENSE_NOTE,
  minimalPng,
  obfuscatedJs,
  pngDataUrl,
  ruleIdsWithFindings,
  scanToReport,
  subTypeRegistry,
} from './support.js';
import type { BuiltPackage, FixtureFile } from './support.js';
import type { ScanReport } from '../src/scan/types.js';

/** 把命中摊平成 `规则/子类型@路径:档位`，让失败信息直接说清楚是哪条判据把安全作品拦了。 */
function describeHits(report: ScanReport, built: BuiltPackage): string {
  const registry = subTypeRegistry();
  return report.findings
    .map((finding) => {
      const subType = attributeSubType(finding, built, registry.get(finding.ruleId) ?? []) ?? '?';
      return `${finding.ruleId}/${subType}@${finding.path}:${finding.disposition}`;
    })
    .join(' | ');
}

/**
 * 断言一个包**完全干净**：零 finding、状态 PASS。
 *
 * 刻意不断言「某条规则零命中」了事 —— 一个反例可能同时是另一条规则的正例，那样断言会绿得没有
 * 意义（§2.4 的每条反例都应该是**一整件能发布的作品**，不是拼出来的碎片）。
 */
async function expectClean(built: BuiltPackage): Promise<ScanReport> {
  const report = await scanToReport(built);
  expect(describeHits(report, built)).toBe('');
  expect(report.findings).toHaveLength(0);
  expect(report.counts.block).toBe(0);
  expect(report.counts.confirm).toBe(0);
  expect(report.status).toBe('PASS');
  return report;
}

/**
 * B10 反例的文件表：一份带长许可注释与长词典的**可读**源，加一份**真的不可读**的压缩产物。
 *
 * 抽成常量是因为紧接着的正对照要拿同一张表只改一个文件 —— 两边只差「可读源」这一处，
 * 因果才归得清楚（§5：零命中的门必须自带正对照）。
 */
const B10_COUNTEREXAMPLE_FILES: readonly FixtureFile[] = [
  {
    path: 'index.html',
    content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>成语接龙</title>
  </head>
  <body>
    <h1>成语接龙</h1>
    <img src="${pngDataUrl()}" alt="一枚星星" width="8" height="8" />
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
    <script src="build/game.min.js"></script>
  </body>
</html>
`,
  },
  {
    path: 'game.js',
    content: `/*
 * 成语接龙 —— 一件本机小游戏。
 *
 * 这段许可注释刻意写得很长：§2.4 点名「许可注释」不能被当成异常熵或不可读标识。
 * 度量可读性之前，注释与字符串字面量会先被空格覆盖掉，所以再长的许可头也进不了判据。
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files, to deal in the Software
 * without restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies.
 */
const stage = document.getElementById('stage');
const context = stage.getContext('2d');

// §2.4「长词典」：字符串汤不参与可读性度量。
const IDIOMS = '一心一意;意气风发;发扬光大;大公无私;私心杂念;念念不忘;忘乎所以;以理服人';

// §2.4「正常数字数组」：分数表不是加密循环，也不是高熵块。
const SCORES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];

function drawIdiom(round) {
  const idiom = IDIOMS.split(';')[round % 8];
  context.fillText(idiom === undefined ? '' : idiom, 8, 20);
  context.fillText(String(SCORES[round % 16] ?? 0), 8, 40);
}

stage.addEventListener('click', () => {
  drawIdiom(SCORES.length);
});
`,
  },
  // §2.4「可读源对应的 minified 构建文件」：压缩产物本身不可读，但包里有可读源为它作证。
  { path: 'build/game.min.js', content: obfuscatedJs() },
];

/**
 * 刻意**只**列这两个 JS：`sourceEntryPaths` 就是「可读源作证」的候选集。
 * 若放任默认值把 `styles/main.css` 也算进去，那份 CSS 会替压缩产物作证，
 * 正对照里换掉 `game.js` 也照样绿 —— 因果就断了。
 */
const B10_SOURCE_ENTRIES: readonly string[] = ['game.js', 'build/game.min.js'];

describe('safe-package-passes', () => {
  it('默认的 Canvas 小游戏包扫出 PASS，零命中', async () => {
    const built = buildPackage();
    const report = await expectClean(built);

    // 报告必须是**可复算**的确定值：同样的包两次扫，inputHash 与 confirmationScopeHash 一致。
    // §6.5 的成人确认范围就挂在这个 hash 上，不确定就等于确认失效。
    const again = await scanToReport(buildPackage());
    expect(again.inputHash).toBe(report.inputHash);
    expect(again.confirmationScopeHash).toBe(report.confirmationScopeHash);
    expect(again.complete).toBe(true);
    // `built.files` 已经含 `work.json`（§1.2：它不进自己的 `files[]`，但计入 200 个文件与 15 MiB），
    // 所以这里不再 +1 —— 扫描器读到的文件数必须与包里的文件数**相等**，少一个就是有文件被跳过。
    expect(report.counts.files).toBe(built.files.length);
  });

  it('包内相对路径、SVG 片段引用、合法 data 图片、纯文本许可 URL 都不算外部资源（B1）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          { path: 'index.html', content: ENTRY_HTML_WITH_LICENSE_NOTE },
          {
            path: 'styles/main.css',
            content: `#stage {
  mask: url(#star-mask);
  background-image: url('../assets/cover.png');
}

@font-face {
  font-family: 'handwriting';
  src: url('../assets/hand.woff2') format('woff2');
}
`,
          },
          {
            path: 'assets/hand.woff2',
            content: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]),
          },
        ],
      }),
    );
  });

  it('名叫 fetch 的局部游戏函数、教学字符串、Promise、本地事件都不算网络请求（B2）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'game.js',
            content: `const stage = document.getElementById('stage');
const context = stage.getContext('2d');

// §2.4「名叫 fetch 的局部游戏函数」：这个 fetch 是作品自己的取星星函数，与全局 fetch 无关。
function fetch(energy) {
  return energy + 1;
}

// §2.4「模拟 XMLHttpRequest 教学字符串」：讲网络的作品**提到**网络 API 不等于发起请求。
const lesson = '浏览器里用 XMLHttpRequest 或者 fetch() 向服务器发请求，我们这件作品不发。';

let energy = 0;
energy = fetch(energy);

const ready = Promise.resolve(energy);
ready.then((value) => {
  context.fillText(String(value), 8, 20);
});

document.getElementById('stage').addEventListener('click', () => {
  energy = fetch(energy);
});

context.fillText(lesson.slice(0, 6), 8, 40);
`,
          },
        ],
      }),
    );
  });

  it('hash 页内路由、history 状态、局部变量叫 location、绘本翻页按钮都不算顶层导航（B3）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'index.html',
            content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>小熊的绘本</title>
  </head>
  <body>
    <h1>小熊的绘本</h1>
    <button type="button" id="next">打开下一页</button>
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
  </body>
</html>
`,
          },
          {
            path: 'game.js',
            content: `const stage = document.getElementById('stage');
const context = stage.getContext('2d');

// §2.4「变量叫 location」：函数里的局部 location，不是全局那个。
function moveStar() {
  const location = { x: 40, y: 120 };
  location.x = location.x + 4;
  context.fillRect(location.x, location.y, 6, 6);
}

// §2.4「hash 页内路由」「history 状态」：都留在本文档内，带不走顶层窗口。
function gotoPage(name) {
  window.location.hash = '#page-' + name;
  history.pushState({ page: name }, '');
  moveStar();
}

// §2.4「绘本『打开下一页』按钮」：本地事件 + 本地状态。
document.getElementById('next').addEventListener('click', () => {
  gotoPage('2');
});
`,
          },
        ],
      }),
    );
  });

  it('Blob 给 audio 播放、createObjectURL 只用于播放、「下载能量」文案都不算下载（B4）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'index.html',
            content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>接星星</title>
  </head>
  <body>
    <h1>接星星</h1>
    <p>接到星星可以获得一次「下载能量」。</p>
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
  </body>
</html>
`,
          },
          {
            path: 'game.js',
            content: `const stage = document.getElementById('stage');

// §2.4「Blob 给 audio/img」「createObjectURL 仅播放」：本地生成的声音，只喂给播放器。
function playChime() {
  const chime = new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'audio/wav' });
  const objectUrl = URL.createObjectURL(chime);
  const player = new Audio(objectUrl);
  player.play();
}

stage.addEventListener('click', playChime);
`,
          },
        ],
      }),
    );
  });

  it('非 form 的输入组件与 button type=button 的本机答题面板不算跨站表单（B5）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'index.html',
            content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>口算练习</title>
    <link rel="stylesheet" href="styles/main.css" />
  </head>
  <body>
    <h1>口算练习</h1>
    <div class="panel">
      <label for="answer">你的答案</label>
      <input id="answer" type="text" />
      <button type="button" id="check">检查</button>
    </div>
    <p id="result"></p>
    <script src="game.js"></script>
  </body>
</html>
`,
          },
          {
            path: 'game.js',
            content: `const answer = document.getElementById('answer');
const result = document.getElementById('result');

document.getElementById('check').addEventListener('click', () => {
  const given = Number(answer.value);
  result.textContent = given === 8 ? '答对了' : '再想想';
});
`,
          },
        ],
      }),
    );
  });

  it('树节点的 parent 字段、叫 Top 的类、Canvas 内文字、无消息的布局都不算父页通信（B6）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'game.js',
            content: `const stage = document.getElementById('stage');
const context = stage.getContext('2d');

// §2.4「AST 树节点的 parent 字段」「Top 类」：都是作品自己的数据结构。
class Top {
  constructor(name) {
    this.name = name;
    this.parent = null;
  }
}

const root = new Top('根');
const leaf = new Top('叶');
leaf.parent = root;

// §2.4「Canvas 内文字」：画出来的字不是 DOM，也没有消息通道。
context.fillText('parent 和 top 在这里只是字段名', 8, 20);
context.fillText(leaf.parent.name, 8, 40);

// §2.4「无消息的页面布局」：纯本地排版，没有任何 postMessage。
function layout() {
  const panel = document.createElement('div');
  panel.className = 'panel';
  stage.after(panel);
}

layout();
`,
          },
        ],
      }),
    );
  });

  it('烘焙游戏的 cookie 变量、剪贴板写入、document.referrer 说明都不算敏感 API（B7）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'game.js',
            content: `const stage = document.getElementById('stage');
const context = stage.getContext('2d');

// §2.4「烘焙游戏 cookie 变量」：局部 cookie 与 document.cookie 无关。
function bake() {
  let cookie = 0;
  cookie += 1;
  context.fillText('饼干：' + cookie, 8, 20);
  return cookie;
}

// §2.4「Clipboard 写入」：写出去不读回来，拿不到任何本机数据。
function copyScore() {
  const score = bake();
  return navigator.clipboard.writeText('我得了 ' + score + ' 分');
}

// §2.4「document.referrer 普通说明」：冻结的 referrerpolicy="no-referrer" 让它恒为空串。
function referrerNote() {
  return document.referrer === '' ? '没有来源页' : '有来源页';
}

stage.addEventListener('click', () => {
  copyScore();
  context.fillText(referrerNote(), 8, 40);
});
`,
          },
        ],
      }),
    );
  });

  it('成人开关批准的摄像头是合法准入，不算敏感 API 违规（B7）', async () => {
    await expectClean(
      buildPackage({
        capabilities: ['CAMERA'],
        policy: { adultApprovedCapabilities: ['CAMERA'] },
        overrides: [
          {
            path: 'game.js',
            content: `const stage = document.getElementById('stage');

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  stage.srcObject = stream;
}

startCamera();
`,
          },
        ],
      }),
    );
  });

  it('虚构角色名输入、绘本人物住址、数学题里的学校人数都不算个人信息收集（B8）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'index.html',
            content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>小熊的绘本</title>
    <link rel="stylesheet" href="styles/main.css" />
  </head>
  <body>
    <h1>小熊的绘本</h1>
    <label for="hero">给你的角色起个名字</label>
    <input id="hero" type="text" placeholder="角色名" />
    <p>绘本第一页写着：小熊住在月亮街 3 号。</p>
    <p>数学题：学校有 320 人，每个班 40 人，一共有几个班？</p>
    <p>联系电话写在道具说明里：救援电话 119。</p>
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
  </body>
</html>
`,
          },
        ],
      }),
    );
  });

  it('可见的数值计算、requestAnimationFrame、WebGL 粒子、标题「探险挖矿」都不算挖矿追踪（B9）', async () => {
    await expectClean(
      buildPackage({
        title: '探险挖矿',
        description: '一件用 Canvas 画矿洞的探险小游戏，全部计算都在本机完成。',
        overrides: [
          {
            path: 'index.html',
            content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>探险挖矿</title>
  </head>
  <body>
    <h1>探险挖矿</h1>
    <p>挖到矿石可以换火把，所有数值都只在这台设备上算。</p>
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
  </body>
</html>
`,
          },
          {
            path: 'game.js',
            content: `const stage = document.getElementById('stage');
const context = stage.getContext('2d');
const particles = [];

// §2.4「可见游戏数值计算」「requestAnimationFrame」：帧循环不是加密循环。
function spawnParticle(index) {
  particles.push({ x: index * 7, y: 12, life: 60 });
}

function drawParticles() {
  for (let index = 0; index < particles.length; index += 1) {
    const particle = particles[index];
    if (particle === undefined) continue;
    particle.life -= 1;
    context.fillRect(particle.x, particle.y, 3, 3);
  }
  requestAnimationFrame(drawParticles);
}

// §2.4「WebGL 粒子」：拿到 WebGL 上下文本身是安全的图形用法。
function makeGl() {
  const gl = stage.getContext('webgl');
  return gl === null ? null : gl.getParameter(gl.VERSION);
}

for (let index = 0; index < 40; index += 1) spawnParticle(index);
makeGl();
drawParticles();
`,
          },
        ],
      }),
    );
  });

  it('许可注释、长词典、base64 图片、有可读源的压缩产物、正常数字数组都不算混淆（B10）', async () => {
    await expectClean(
      buildPackage({
        overrides: B10_COUNTEREXAMPLE_FILES,
        sourceEntryPaths: B10_SOURCE_ENTRIES,
      }),
    );
  });

  it('B10 反例的正对照：把可读源也换成不可读的，同一个包立刻被拦', async () => {
    // 上一个用例绿，可能是因为「有可读源就放行」这条豁免真的在起作用，**也可能**是因为那份压缩
    // 产物压根没被判成不可读 —— 那样豁免根本没被走到，删掉它用例照样绿（§5「零命中的门没有
    // 正对照就等于没测」）。这里把唯一的可读源换成同一份不可读代码：豁免失去依据，B10 必须开火。
    const withoutCounterpart: readonly FixtureFile[] = B10_COUNTEREXAMPLE_FILES.map((file) =>
      file.path === 'game.js' ? { path: 'game.js', content: obfuscatedJs() } : file,
    );
    const built = buildPackage({
      overrides: withoutCounterpart,
      sourceEntryPaths: B10_SOURCE_ENTRIES,
    });
    const report = await scanToReport(built);

    expect(ruleIdsWithFindings(report)).toContain('B10');
    expect(report.status).not.toBe('PASS');
    expect(describeHits(report, built)).toContain('B10/unreadable-without-source');
  });

  it('已固化的 AI 风格素材、剧情角色叫「AI」、纯本地选择式问答都不算 AI 调用（B11）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          { path: 'assets/ai-avatar.png', content: minimalPng(16, 16) },
          {
            path: 'index.html',
            content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>AI 小助手问答</title>
  </head>
  <body>
    <h1>AI 小助手问答</h1>
    <img src="assets/ai-avatar.png" alt="AI 小助手头像" width="16" height="16" />
    <p>剧情里的 AI 小助手只会问你早已写好的问题。</p>
    <button type="button" id="choice-a">选 A</button>
    <button type="button" id="choice-b">选 B</button>
    <p id="reply"></p>
    <script src="game.js"></script>
  </body>
</html>
`,
          },
          {
            path: 'game.js',
            content: `const reply = document.getElementById('reply');

// §2.4「纯本地选择式问答」：答案是写死在本机代码里的，没有任何模型调用。
const ANSWERS = { 'choice-a': '你选了 A，小助手点点头。', 'choice-b': '你选了 B，小助手笑了。' };

function bindChoice(buttonId) {
  const button = document.getElementById(buttonId);
  button.addEventListener('click', () => {
    reply.textContent = ANSWERS[buttonId] ?? '小助手没听懂。';
  });
}

bindChoice('choice-a');
bindChoice('choice-b');
`,
          },
        ],
      }),
    );
  });

  it('「本机存档」「模拟排行榜」「不支持云同步」与普通剧情对白都不算虚假能力（B12）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'index.html',
            content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>接星星</title>
  </head>
  <body>
    <h1>接星星</h1>
    <p>进度是<span>本机存档</span>，换一台设备就要重新开始。</p>
    <p>这是模拟排行榜，只显示你自己在这一台设备上的成绩。</p>
    <p>本作品不支持云同步，也没有账号。</p>
    <p>小熊说：「我们把星星都接住，就能照亮回家的路。」</p>
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
  </body>
</html>
`,
          },
        ],
      }),
    );
  });

  it('安全教育引文、正常词的子串、虚构反派情节、可解释的科学图都不算不当内容（B13）', async () => {
    await expectClean(
      buildPackage({
        overrides: [
          {
            path: 'index.html',
            content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>安全小课堂</title>
    <link rel="stylesheet" href="styles/main.css" />
  </head>
  <body>
    <h1>安全小课堂</h1>
    <p>安全教育引文：遇到火灾要用湿毛巾捂住口鼻，弯腰沿墙走出去。</p>
    <p>卫生课：医生会给你打针，打完针要按住棉签。</p>
    <p>绘本情节：反派大灰狼想骗小红帽开门，小红帽没有上当。</p>
    <p>科学图说明：水在 100 摄氏度沸腾，在 0 摄氏度结冰。</p>
    <canvas id="stage" width="320" height="240"></canvas>
    <script src="game.js"></script>
  </body>
</html>
`,
          },
        ],
      }),
    );
  });

  it('报告的版本号、缓存键与文件计数来自输入，不是写死的常量', async () => {
    const built = buildPackage({ scannerVersion: 'scanner-x', rulesetVersion: 'ruleset-x' });
    const report = await scanToReport(built);

    // §6.3：最终判定的缓存键严格是 `scannerVersion + artifactHash + rulesetVersion`。
    // 三个分量里有两个直接回显在报告上，第三个（artifactHash）就是 inputHash 的输入。
    expect(report.scannerVersion).toBe('scanner-x');
    expect(report.rulesetVersion).toBe('ruleset-x');
    expect(report.inputHash).not.toBe((await scanToReport(buildPackage())).inputHash);
    expect(ruleIdsWithFindings(report)).toEqual([]);
    // 零命中必须来自「判过且干净」，不能来自「一个文件都没读到」。
    expect(report.counts.files).toBe(built.files.length);
    expect(report.counts.bytes).toBeGreaterThan(0);
  });
});

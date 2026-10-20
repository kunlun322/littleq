/**
 * 安全样例的模板家族（ZLQ-156 §2.1「本地确定性模板生成与人工变体 240，固定 seeds」、
 * §2.2 的 12 格分布与技术覆盖标签）。
 *
 * ## 为什么模板里有「注入槽」
 *
 * §2.1 要求违规集「在这些原创合成项目上**单点变异**」，§2.4 又要求「每条至少 6 个对应安全
 * 反例」。两句话合起来只有一种做法能同时满足：**安全样例与违规样例必须是同一个模板的两种
 * 填法**。所以每个安全模板都带四个具名注入槽（head / body / script / style），安全样例把槽
 * 留空（或只填明显合法的内容），违规样例只填**一个**槽。
 *
 * 这样得到的三件事是白送的：
 * 1. **单点可归因** —— 一个违规样例与它的安全对照之间只有一个文件、一处差异，红灯指到的就是判据。
 * 2. **安全反例天然成对** —— 每条规则的安全反例不是另写一份，而是同一模板的空槽版本。
 * 3. **同构泄漏可检** —— `familyId` 就是模板家族，拆分只按 familyId 走。
 *
 * ## 「50 个不同皮肤但相同代码不算 50 个家族」
 *
 * §2.2 明令禁止用皮肤充数。所以每个家族的渲染器**必须**让变体之间在控制流、DOM 结构、
 * Canvas 调用序列上有实际差异 —— 变体参数改的是循环形状（for / while / 递归 / 事件驱动）、
 * 元素个数与嵌套、绘制调用序列、素材文件集合、存储用法，不是换个标题和配色。
 * 判定这些差异是否「实际」的不是本文件的注释，而是 `packageHash` 互不相同 + 渲染出的
 * JS AST 节点序列不同；`generator.ts` 会把两者都写进 pin 版报告。
 */

import type { AgeBand, WorkType } from '../scan/metadata.js';
import { corpusPng, corpusPngDataUrl, corpusWoff2, type CorpusFile } from './package.js';
import { createRandom, type Random } from './random.js';

/** §2.2 的四个作品类型 × 三个年龄段 = 12 格，每格 50（本单实产 20）。 */
export const CORPUS_CELLS: readonly { readonly ageBand: AgeBand; readonly workType: WorkType }[] = [
  { ageBand: 'L1', workType: 'GAME' },
  { ageBand: 'L1', workType: 'WEB' },
  { ageBand: 'L1', workType: 'ANIMATION' },
  { ageBand: 'L1', workType: 'PICTURE_BOOK' },
  { ageBand: 'L2', workType: 'GAME' },
  { ageBand: 'L2', workType: 'WEB' },
  { ageBand: 'L2', workType: 'ANIMATION' },
  { ageBand: 'L2', workType: 'PICTURE_BOOK' },
  { ageBand: 'L3', workType: 'GAME' },
  { ageBand: 'L3', workType: 'WEB' },
  { ageBand: 'L3', workType: 'ANIMATION' },
  { ageBand: 'L3', workType: 'PICTURE_BOOK' },
];

/** 每格实产样例数。§2.2 目标是 50，本单只交付生成档 240 ⇒ 每格 20（差额见报告）。 */
export const SAFE_PER_CELL = 20;
/** 每格的结构家族数。20 = 5 × 4，留出集取其中 1 个家族 ⇒ 每格 16 开发 / 4 留出。 */
export const STRUCTURES_PER_CELL = 5;
export const VARIANTS_PER_FAMILY = SAFE_PER_CELL / STRUCTURES_PER_CELL;
/** §2.2「每格 40 开发集、10 冻结留出集」按 20/格 等比缩放 ⇒ 16 / 4。 */
export const HOLDOUT_FAMILIES_PER_CELL = 1;

/** 注入槽。违规样例每次只填一个。 */
export const SLOT_IDS = ['head', 'body', 'script', 'style'] as const;
export type SlotId = (typeof SLOT_IDS)[number];

/** §2.2 的技术覆盖标签。可交叉，一件作品可以有多个。 */
export const TECH_TAGS = [
  'dom-events',
  'canvas2d',
  'webgl',
  'web-audio',
  'storage',
  'svg',
  'hash-route',
  'history-state',
  'template-string',
  'multi-file',
  'inline-csp-hash',
  'legal-data-url',
  'legal-blob-url',
  'keyboard',
  'touch',
  'license-note',
  'readable-source-plus-minified',
  'zh-copy',
  'zh-en-mixed',
  'en-copy',
  'boundary-at-limit',
  'boundary-below-limit',
] as const;
export type TechTag = (typeof TECH_TAGS)[number];

export type SafeStructureId =
  | 'canvas-loop'
  | 'dom-panel'
  | 'svg-scene'
  | 'webgl-particles'
  | 'audio-story';

export const SAFE_STRUCTURE_IDS: readonly SafeStructureId[] = [
  'canvas-loop',
  'dom-panel',
  'svg-scene',
  'webgl-particles',
  'audio-story',
];

/** 渲染出来的安全基座：文件表 + 四个注入槽的位置 + 命中的技术标签。 */
export type SafeBase = {
  readonly familyId: string;
  readonly structure: SafeStructureId;
  readonly ageBand: AgeBand;
  readonly workType: WorkType;
  readonly title: string;
  readonly description: string;
  readonly files: readonly CorpusFile[];
  /** 槽名 → 该槽所在的文件路径。违规样例据此定位「只改这一个文件」。 */
  readonly slotFile: Readonly<Record<SlotId, string>>;
  readonly tags: readonly TechTag[];
  /** 该基座声明的能力；空数组表示不碰受控设备。 */
  readonly capabilities: readonly string[];
  readonly sourceEntryPaths: readonly string[];
};

// ---------------------------------------------------------------------------
// 文案素材。全部虚构、无真实个人信息（§2.1「文本人物均虚构」）。
// ---------------------------------------------------------------------------

const HEROES = ['小星星', '月亮熊', '纸飞机', '小水滴', '橘子猫', '云朵兔', '小火箭', '叶子舟'];
const PLACES = ['月亮街', '彩虹镇', '星星港', '云朵山谷', '橘子园', '纸船湖', '灯塔岛', '风铃巷'];
const VERBS = ['收集', '点亮', '拼接', '寻找', '护送', '整理', '描绘', '运送'];
const OBJECTS = ['星星', '灯笼', '拼图', '贝壳', '钥匙', '音符', '树叶', '石子'];

/** 中英混合词表：§2.2 要求「中英混合 ≥120」（等比缩放后 ≥48）。 */
const MIXED_PAIRS: readonly (readonly [string, string])[] = [
  ['得分', 'score'],
  ['关卡', 'level'],
  ['暂停', 'pause'],
  ['继续', 'resume'],
  ['重玩', 'restart'],
  ['提示', 'hint'],
];

function copyFor(
  random: Random,
  ageBand: AgeBand,
  workType: WorkType,
): {
  readonly title: string;
  readonly description: string;
  readonly mode: 'zh' | 'zh-en-mixed' | 'en';
} {
  const hero = random.pick(HEROES);
  const place = random.pick(PLACES);
  const verb = random.pick(VERBS);
  const object = random.pick(OBJECTS);
  // 约 1/3 中英混合、1/12 纯英文，其余纯中文 ⇒ 中文覆盖远高于 §2.2 的 360/600 等比值。
  const roll = random.int(12);
  const mode: 'zh' | 'zh-en-mixed' | 'en' = roll === 0 ? 'en' : roll < 5 ? 'zh-en-mixed' : 'zh';
  if (mode === 'en') {
    return {
      title: `${hero} in ${place}`,
      description: `A ${workType.toLowerCase()} where ${hero} helps ${verb} the ${object}.`,
      mode,
    };
  }
  if (mode === 'zh-en-mixed') {
    const pair = random.pick(MIXED_PAIRS);
    return {
      title: `${hero}的${object}${pair[1]}`,
      description: `${hero}在${place}${verb}${object}，按下按钮看 ${pair[1]} 变化。`,
      mode,
    };
  }
  const ageNote =
    ageBand === 'L1' ? '玩法只有一步。' : ageBand === 'L2' ? '要先想一步。' : '可以试三种走法。';
  return {
    title: `${hero}在${place}${verb}${object}`,
    description: `${hero}在${place}${verb}${object}的小作品，${ageNote}全部计算都在这台设备上完成。`,
    mode,
  };
}

/** 按年龄段调控制流复杂度：L1 直线、L2 带条件、L3 带循环嵌套/递归。 */
function loopShape(
  random: Random,
  ageBand: AgeBand,
): 'for' | 'while' | 'recursive' | 'event-driven' {
  if (ageBand === 'L1') return random.chance(0.5) ? 'for' : 'event-driven';
  if (ageBand === 'L2') return random.pick(['for', 'while', 'event-driven'] as const);
  return random.pick(['for', 'while', 'recursive', 'event-driven'] as const);
}

function loopCode(
  shape: 'for' | 'while' | 'recursive' | 'event-driven',
  count: number,
  body: string,
): string {
  if (shape === 'for') {
    return `for (let index = 0; index < ${count}; index += 1) {\n${body}\n}`;
  }
  if (shape === 'while') {
    return `let remaining = ${count};\nwhile (remaining > 0) {\n${body}\n  remaining -= 1;\n}`;
  }
  if (shape === 'recursive') {
    return `function step(depth) {\n  if (depth <= 0) return 0;\n${body}\n  return 1 + step(depth - 1);\n}\nstep(${count});`;
  }
  return `const queue = new Array(${count}).fill(0);\nqueue.forEach(() => {\n${body}\n});`;
}

// ---------------------------------------------------------------------------
// HTML 骨架。四个槽用注释标记，渲染完成后替换掉 —— 空槽留下的是一个空行，
// 于是「安全版本」与「违规版本」的差异严格等于槽里那一段。
// ---------------------------------------------------------------------------

function htmlSkeleton(options: {
  readonly title: string;
  readonly lang: string;
  readonly csp: string | null;
  readonly headSlot: string;
  readonly bodyInner: string;
  readonly bodySlot: string;
  readonly scripts: readonly string[];
}): string {
  const cspLine =
    options.csp === null
      ? ''
      : `    <meta http-equiv="Content-Security-Policy" content="${options.csp}" />\n`;
  const scriptLines = options.scripts.map((src) => `    <script src="${src}"></script>`).join('\n');
  return `<!doctype html>
<html lang="${options.lang}">
  <head>
    <meta charset="utf-8" />
${cspLine}    <title>${options.title}</title>
    <link rel="stylesheet" href="styles/main.css" />
${options.headSlot}  </head>
  <body>
${options.bodyInner}
${options.bodySlot}${scriptLines}
  </body>
</html>
`;
}

const HEAD_SLOT = '<!--SLOT:head-->\n';
const BODY_SLOT = '<!--SLOT:body-->\n';
const SCRIPT_SLOT = '// SLOT:script\n';
const STYLE_SLOT = '/* SLOT:style */\n';

// ---------------------------------------------------------------------------
// 五个结构家族
// ---------------------------------------------------------------------------

type RenderContext = {
  readonly random: Random;
  readonly ageBand: AgeBand;
  readonly workType: WorkType;
  readonly familyId: string;
  readonly variant: number;
  readonly title: string;
  readonly description: string;
  readonly mode: 'zh' | 'zh-en-mixed' | 'en';
};

function langOf(mode: 'zh' | 'zh-en-mixed' | 'en'): string {
  return mode === 'en' ? 'en' : 'zh-CN';
}

/** 结构 1：Canvas 2D 主循环 + 键盘/触屏输入。 */
function renderCanvasLoop(ctx: RenderContext): SafeBase {
  const { random } = ctx;
  const shape = loopShape(random, ctx.ageBand);
  const spriteCount = random.between(4, 12);
  const cellSize = random.between(4, 10);
  const width = random.pick([240, 320, 400]);
  const height = random.pick([180, 240, 300]);
  const usesTouch = random.chance(0.5);
  const usesStorage = random.chance(0.4);

  const bodyInner = `    <h1>${ctx.title}</h1>
    <p>${ctx.description}</p>
    <canvas id="stage" width="${width}" height="${height}"></canvas>
    <p id="readout" aria-live="polite">${ctx.mode === 'en' ? 'score 0' : '得分 0'}</p>`;

  const drawCalls = random
    .sample(['fillRect', 'strokeRect', 'arc', 'fillText', 'moveTo', 'lineTo'], 3)
    .join(', ');

  const storageLines = usesStorage
    ? `const STORAGE_KEY = 'littleq:corpus:best';
function readBest() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? 0 : Number.parseInt(raw, 10) || 0;
}
function writeBest(value) {
  localStorage.setItem(STORAGE_KEY, String(value));
}
`
    : '';

  const script = `const stage = document.getElementById('stage');
const context = stage.getContext('2d');
const readout = document.getElementById('readout');
let score = 0;
${storageLines}
// 本作品的绘制调用序列：${drawCalls}
function drawSprite(index) {
  context.fillStyle = index % 2 === 0 ? '#ffd166' : '#06d6a0';
  context.fillRect((index * ${cellSize * 3}) % ${width}, (index * ${cellSize}) % ${height}, ${cellSize}, ${cellSize});
}

function render() {
  context.clearRect(0, 0, ${width}, ${height});
${loopCode(shape, spriteCount, '  drawSprite(score);')
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')}
  readout.textContent = ${ctx.mode === 'en' ? `'score ' + score` : `'得分 ' + score`};
}

function advance() {
  score += 1;
${usesStorage ? '  if (score > readBest()) writeBest(score);' : ''}
  render();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') advance();
});
${
  usesTouch
    ? `stage.addEventListener('pointerdown', () => {
  advance();
});
`
    : ''
}
${SCRIPT_SLOT}render();
`;

  const css = `#stage {
  display: block;
  margin: 0 auto;
  background: #101a30;
}

#readout {
  font-family: system-ui, sans-serif;
  text-align: center;
}
${STYLE_SLOT}`;

  const files: CorpusFile[] = [
    {
      path: 'index.html',
      content: htmlSkeleton({
        title: ctx.title,
        lang: langOf(ctx.mode),
        csp: null,
        headSlot: HEAD_SLOT,
        bodyInner,
        bodySlot: BODY_SLOT,
        scripts: ['game.js'],
      }),
    },
    { path: 'styles/main.css', content: css },
    { path: 'game.js', content: script },
    { path: 'assets/cover.png', content: corpusPng(8, 8, ctx.variant) },
    { path: 'assets/sprite.png', content: corpusPng(cellSize, cellSize, ctx.variant + 1) },
  ];

  const tags: TechTag[] = ['canvas2d', 'dom-events', 'keyboard', 'multi-file'];
  if (usesTouch) tags.push('touch');
  if (usesStorage) tags.push('storage');
  if (ctx.mode === 'zh') tags.push('zh-copy');
  if (ctx.mode === 'zh-en-mixed') tags.push('zh-en-mixed');
  if (ctx.mode === 'en') tags.push('en-copy');

  return {
    familyId: ctx.familyId,
    structure: 'canvas-loop',
    ageBand: ctx.ageBand,
    workType: ctx.workType,
    title: ctx.title,
    description: ctx.description,
    files,
    slotFile: {
      head: 'index.html',
      body: 'index.html',
      script: 'game.js',
      style: 'styles/main.css',
    },
    tags,
    capabilities: [],
    sourceEntryPaths: ['game.js'],
  };
}

/** 结构 2：DOM 面板 + 按钮/输入（**不含 `<form>`**，§8.3 B5 允许页内 JS 处理的输入控件）。 */
function renderDomPanel(ctx: RenderContext): SafeBase {
  const { random } = ctx;
  const itemCount = random.between(3, 7);
  // 这一族固定用本地存储，撑起 §2.2 的 Storage 覆盖；`usesSession` 决定用哪一种存储对象，
  // 于是同族变体之间的存储代码形状真的有差别（不是换皮）。
  const usesSession = random.chance(0.5);
  const mixed = ctx.mode === 'zh-en-mixed';

  const rows = Array.from({ length: itemCount }, (_, index) => {
    const label = mixed ? `第 ${index + 1} 项 item` : `第 ${index + 1} 项`;
    return `      <li class="row" data-index="${index}">
        <label for="amount-${index}">${label}</label>
        <input id="amount-${index}" type="number" min="0" max="9" value="${index % 10}" />
      </li>`;
  }).join('\n');

  const bodyInner = `    <h1>${ctx.title}</h1>
    <p>${ctx.description}</p>
    <div class="panel">
      <ul id="list">
${rows}
      </ul>
      <button type="button" id="recalc">${mixed ? '重新计算 recalc' : '重新计算'}</button>
      <output id="total">0</output>
    </div>`;

  const storageObject = usesSession ? 'sessionStorage' : 'localStorage';
  const script = `const list = document.getElementById('list');
const total = document.getElementById('total');
const recalc = document.getElementById('recalc');
const STORAGE_KEY = 'littleq:corpus:total';

function readInputs() {
  const values = [];
  const inputs = list.querySelectorAll('input[type="number"]');
  for (const input of inputs) values.push(Number.parseInt(input.value, 10) || 0);
  return values;
}

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function refresh() {
  const value = sum(readInputs());
  total.textContent = String(value);
  ${storageObject}.setItem(STORAGE_KEY, String(value));
}

recalc.addEventListener('click', () => {
  refresh();
});

const restored = ${storageObject}.getItem(STORAGE_KEY);
if (restored !== null) total.textContent = restored;
${SCRIPT_SLOT}refresh();
`;

  const css = `.panel {
  max-width: 30rem;
  margin: 0 auto;
  padding: 1rem;
  border: 1px solid #d8dce6;
  border-radius: 8px;
}

.row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  list-style: none;
}

#total {
  font-weight: 700;
}
${STYLE_SLOT}`;

  const files: CorpusFile[] = [
    {
      path: 'index.html',
      content: htmlSkeleton({
        title: ctx.title,
        lang: langOf(ctx.mode),
        csp: null,
        headSlot: HEAD_SLOT,
        bodyInner,
        bodySlot: BODY_SLOT,
        scripts: ['app.js'],
      }),
    },
    { path: 'styles/main.css', content: css },
    { path: 'app.js', content: script },
    { path: 'assets/cover.png', content: corpusPng(8, 8, ctx.variant) },
  ];

  const tags: TechTag[] = ['dom-events', 'storage', 'multi-file', 'template-string'];
  if (ctx.mode === 'zh') tags.push('zh-copy');
  if (mixed) tags.push('zh-en-mixed');
  if (ctx.mode === 'en') tags.push('en-copy');

  return {
    familyId: ctx.familyId,
    structure: 'dom-panel',
    ageBand: ctx.ageBand,
    workType: ctx.workType,
    title: ctx.title,
    description: ctx.description,
    files,
    slotFile: {
      head: 'index.html',
      body: 'index.html',
      script: 'app.js',
      style: 'styles/main.css',
    },
    tags,
    capabilities: ['LOCAL_STORAGE'],
    sourceEntryPaths: ['app.js'],
  };
}

/** 结构 3：内联 SVG 场景 + CSS 动画（§2.2 的 SVG 覆盖）。 */
function renderSvgScene(ctx: RenderContext): SafeBase {
  const { random } = ctx;
  const shapeCount = random.between(3, 8);
  const usesMask = random.chance(0.5);
  const viewBox = random.pick([64, 96, 128]);

  const shapes = Array.from({ length: shapeCount }, (_, index) => {
    const cx = (index * 13) % viewBox;
    const cy = (index * 7) % viewBox;
    const kind = random.pick(['circle', 'rect'] as const);
    return kind === 'circle'
      ? `      <circle cx="${cx}" cy="${cy}" r="${2 + (index % 4)}" fill="#ffd166" class="drift" />`
      : `      <rect x="${cx}" y="${cy}" width="${3 + (index % 5)}" height="${3 + (index % 5)}" fill="#06d6a0" class="drift" />`;
  }).join('\n');

  const defs = usesMask
    ? `      <mask id="soft-mask">
        <rect x="0" y="0" width="${viewBox}" height="${viewBox}" fill="#fff"></rect>
      </mask>
`
    : '';

  const bodyInner = `    <h1>${ctx.title}</h1>
    <p>${ctx.description}</p>
    <svg id="scene" xmlns="http://www.w3.org/2000/svg" width="${viewBox}" height="${viewBox}" viewBox="0 0 ${viewBox} ${viewBox}" role="img" aria-label="${ctx.title}">
      <defs>
${defs}      </defs>
      <g${usesMask ? ' mask="url(#soft-mask)"' : ''}>
${shapes}
      </g>
    </svg>`;

  const script = `const scene = document.getElementById('scene');
let tick = 0;

function nudge() {
  tick += 1;
  scene.setAttribute('data-tick', String(tick));
}

scene.addEventListener('click', () => {
  nudge();
});
${SCRIPT_SLOT}nudge();
`;

  const css = `.drift {
  animation: drift 3s ease-in-out infinite alternate;
}

@keyframes drift {
  from {
    opacity: 0.6;
  }
  to {
    opacity: 1;
  }
}

#scene {
  display: block;
  margin: 0 auto;
}
${STYLE_SLOT}`;

  const files: CorpusFile[] = [
    {
      path: 'index.html',
      content: htmlSkeleton({
        title: ctx.title,
        lang: langOf(ctx.mode),
        csp: null,
        headSlot: HEAD_SLOT,
        bodyInner,
        bodySlot: BODY_SLOT,
        scripts: ['scene.js'],
      }),
    },
    { path: 'styles/main.css', content: css },
    { path: 'scene.js', content: script },
    { path: 'assets/cover.png', content: corpusPng(8, 8, ctx.variant) },
  ];

  const tags: TechTag[] = ['svg', 'dom-events', 'multi-file'];
  if (ctx.mode === 'zh') tags.push('zh-copy');
  if (ctx.mode === 'zh-en-mixed') tags.push('zh-en-mixed');
  if (ctx.mode === 'en') tags.push('en-copy');

  return {
    familyId: ctx.familyId,
    structure: 'svg-scene',
    ageBand: ctx.ageBand,
    workType: ctx.workType,
    title: ctx.title,
    description: ctx.description,
    files,
    slotFile: {
      head: 'index.html',
      body: 'index.html',
      script: 'scene.js',
      style: 'styles/main.css',
    },
    tags,
    capabilities: [],
    sourceEntryPaths: ['scene.js'],
  };
}

/** 结构 4：WebGL 粒子（§2.2 的 WebGL ≥36 覆盖；拿 WebGL 上下文本身是安全图形用法）。 */
function renderWebglParticles(ctx: RenderContext): SafeBase {
  const { random } = ctx;
  const particleCount = random.between(16, 64);
  const usesRaf = random.chance(0.7);

  const bodyInner = `    <h1>${ctx.title}</h1>
    <p>${ctx.description}</p>
    <canvas id="stage" width="320" height="240"></canvas>`;

  const script = `const stage = document.getElementById('stage');
const gl = stage.getContext('webgl');
const particles = [];

function spawn(index) {
  particles.push({ x: (index * 7) % 320, y: (index * 5) % 240, life: ${random.between(30, 90)} });
}

function drawAll() {
  if (gl === null) return;
  gl.clearColor(0.06, 0.1, 0.19, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  for (let index = 0; index < particles.length; index += 1) {
    const particle = particles[index];
    if (particle === undefined) continue;
    particle.life -= 1;
    particle.y = (particle.y + 1) % 240;
  }
}

for (let index = 0; index < ${particleCount}; index += 1) spawn(index);
${
  usesRaf
    ? `function frame() {
  drawAll();
  requestAnimationFrame(frame);
}
frame();
`
    : `drawAll();
`
}${SCRIPT_SLOT}`;

  const css = `#stage {
  display: block;
  margin: 0 auto;
  background: #101a30;
}
${STYLE_SLOT}`;

  const files: CorpusFile[] = [
    {
      path: 'index.html',
      content: htmlSkeleton({
        title: ctx.title,
        lang: langOf(ctx.mode),
        csp: null,
        headSlot: HEAD_SLOT,
        bodyInner,
        bodySlot: BODY_SLOT,
        scripts: ['particles.js'],
      }),
    },
    { path: 'styles/main.css', content: css },
    { path: 'particles.js', content: script },
    { path: 'assets/cover.png', content: corpusPng(8, 8, ctx.variant) },
  ];

  const tags: TechTag[] = ['webgl', 'canvas2d', 'multi-file'];
  if (ctx.mode === 'zh') tags.push('zh-copy');
  if (ctx.mode === 'zh-en-mixed') tags.push('zh-en-mixed');
  if (ctx.mode === 'en') tags.push('en-copy');

  return {
    familyId: ctx.familyId,
    structure: 'webgl-particles',
    ageBand: ctx.ageBand,
    workType: ctx.workType,
    title: ctx.title,
    description: ctx.description,
    files,
    slotFile: {
      head: 'index.html',
      body: 'index.html',
      script: 'particles.js',
      style: 'styles/main.css',
    },
    tags,
    capabilities: [],
    sourceEntryPaths: ['particles.js'],
  };
}

/**
 * 结构 5：分页故事 + hash 路由 + 本地音频（§2.2 的 Web Audio / hash 路由 / history 状态覆盖）。
 *
 * ⚠️ 这一族刻意**只**用 `location.hash` 与 `history.pushState`，不赋值 `location.href`：
 * B3 的判据是「顶层导航赋值」，而 hash 路由与 history 状态是 Runtime 允许的合法写法，
 * 正是 §2.4 表格里 B3 那一行点名的「合法但易误判的反例」。
 */
function renderAudioStory(ctx: RenderContext): SafeBase {
  const { random } = ctx;
  const pageCount = random.between(2, 5);
  const usesHistory = random.chance(0.5);
  const usesAudio = random.chance(0.8);
  const usesHashRoute = true;

  const pages = Array.from({ length: pageCount }, (_, index) => {
    const line =
      ctx.mode === 'en'
        ? `Page ${index + 1}: the story continues.`
        : `第 ${index + 1} 页：故事还在继续。`;
    return `      <section class="page" id="page-${index}" hidden>
        <p>${line}</p>
      </section>`;
  }).join('\n');

  const bodyInner = `    <h1>${ctx.title}</h1>
    <p>${ctx.description}</p>
    <nav id="pager">
      <button type="button" id="prev">${ctx.mode === 'en' ? 'prev' : '上一页'}</button>
      <button type="button" id="next">${ctx.mode === 'en' ? 'next' : '下一页'}</button>
    </nav>
    <div id="pages">
${pages}
    </div>`;

  const audioLines = usesAudio
    ? `function makeTone() {
  // 本地合成一段提示音：Blob + createObjectURL 是 §8.3 B4 明确允许的合法用法。
  const bytes = new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);
  const blob = new Blob([bytes], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

const tone = new Audio(makeTone());
function playTone() {
  void tone.play().catch(() => {});
}
`
    : '';

  const script = `const pager = document.getElementById('pager');
const pages = Array.from(document.querySelectorAll('.page'));
let current = 0;
${audioLines}
function showPage(index) {
  current = Math.max(0, Math.min(pages.length - 1, index));
  for (let position = 0; position < pages.length; position += 1) {
    const page = pages[position];
    if (page === undefined) continue;
    page.hidden = position !== current;
  }
${usesHashRoute ? '  window.location.hash = `#page-${current}`;' : ''}
${usesHistory ? "  history.pushState({ page: current }, '', `#page-${current}`);" : ''}
${usesAudio ? '  playTone();' : ''}
}

pager.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === 'next') showPage(current + 1);
  if (target.id === 'prev') showPage(current - 1);
});

window.addEventListener('popstate', () => {
  showPage(current);
});
${SCRIPT_SLOT}showPage(0);
`;

  const css = `.page {
  padding: 0.75rem 1rem;
  border-left: 3px solid #ffd166;
}

#pager {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
}
${STYLE_SLOT}`;

  const files: CorpusFile[] = [
    {
      path: 'index.html',
      content: htmlSkeleton({
        title: ctx.title,
        lang: langOf(ctx.mode),
        csp: null,
        headSlot: HEAD_SLOT,
        bodyInner,
        bodySlot: BODY_SLOT,
        scripts: ['story.js'],
      }),
    },
    { path: 'styles/main.css', content: css },
    { path: 'story.js', content: script },
    { path: 'assets/cover.png', content: corpusPng(8, 8, ctx.variant) },
    { path: 'assets/page-1.png', content: corpusPng(12, 9, ctx.variant + 2) },
  ];

  const tags: TechTag[] = ['dom-events', 'multi-file', 'hash-route'];
  if (usesHistory) tags.push('history-state');
  if (usesAudio) {
    tags.push('web-audio', 'legal-blob-url');
  }
  if (ctx.mode === 'zh') tags.push('zh-copy');
  if (ctx.mode === 'zh-en-mixed') tags.push('zh-en-mixed');
  if (ctx.mode === 'en') tags.push('en-copy');

  return {
    familyId: ctx.familyId,
    structure: 'audio-story',
    ageBand: ctx.ageBand,
    workType: ctx.workType,
    title: ctx.title,
    description: ctx.description,
    files,
    slotFile: {
      head: 'index.html',
      body: 'index.html',
      script: 'story.js',
      style: 'styles/main.css',
    },
    tags,
    capabilities: [],
    sourceEntryPaths: ['story.js'],
  };
}

const RENDERERS: Readonly<Record<SafeStructureId, (ctx: RenderContext) => SafeBase>> = {
  'canvas-loop': renderCanvasLoop,
  'dom-panel': renderDomPanel,
  'svg-scene': renderSvgScene,
  'webgl-particles': renderWebglParticles,
  'audio-story': renderAudioStory,
};

/** 一格的 5 个结构家族 id。留出集取最后一个（下标 4），因此它是「被冻结的那一族」。 */
export function familiesOfCell(ageBand: AgeBand, workType: WorkType): readonly string[] {
  return SAFE_STRUCTURE_IDS.map((structure) =>
    `safe-${ageBand}-${workType}-${structure}`.toLowerCase(),
  );
}

/**
 * 渲染一件安全基座。
 *
 * `familyIndex` 是这一格里的结构下标（0..4），`variant` 是同家族内的变体下标（0..3）。
 * 两者一起决定 `caseId`，因此种子完全由 `(corpusVersion, caseId)` 决定 —— 可复现。
 */
export function renderSafeBase(
  corpusVersion: string,
  ageBand: AgeBand,
  workType: WorkType,
  familyIndex: number,
  variant: number,
): SafeBase {
  const structure = SAFE_STRUCTURE_IDS[familyIndex % SAFE_STRUCTURE_IDS.length];
  if (structure === undefined) throw new Error(`结构下标越界：${familyIndex}`);
  const familyId = familiesOfCell(ageBand, workType)[familyIndex % SAFE_STRUCTURE_IDS.length];
  if (familyId === undefined) throw new Error(`家族下标越界：${familyIndex}`);
  const caseId = safeCaseId(ageBand, workType, familyIndex, variant);
  const random = createRandomFor(corpusVersion, caseId);
  const copy = copyFor(random, ageBand, workType);
  const ctx: RenderContext = {
    random,
    ageBand,
    workType,
    familyId,
    variant,
    title: copy.title,
    description: copy.description,
    mode: copy.mode,
  };
  const base = RENDERERS[structure](ctx);
  // 槽标记必须原样留在文件里，违规样例才知道往哪儿填。渲染器漏掉一个槽就是模板缺陷。
  assertSlotsPresent(base);
  return base;
}

export function safeCaseId(
  ageBand: AgeBand,
  workType: WorkType,
  familyIndex: number,
  variant: number,
): string {
  return `safe-${ageBand}-${workType}-f${familyIndex}-v${variant}`.toLowerCase();
}

function createRandomFor(corpusVersion: string, caseId: string): Random {
  // 三条独立的随机流：文案、结构、素材。分开是为了改一处模板不牵动另一处的取值。
  return createRandom(corpusVersion, caseId, 'base');
}

function assertSlotsPresent(base: SafeBase): void {
  const byPath = new Map(base.files.map((file) => [file.path, file]));
  for (const slotId of SLOT_IDS) {
    const path = base.slotFile[slotId];
    const file = byPath.get(path);
    const content = typeof file?.content === 'string' ? file.content : '';
    const marker = `SLOT:${slotId}`;
    if (!content.includes(marker)) {
      throw new Error(`安全基座 ${base.familyId} 的 ${slotId} 槽没有落进 ${path}`);
    }
  }
}

/** 供违规模板使用：把槽标记替换成一段内容（只改一个文件）。 */
export function fillSlot(base: SafeBase, slotId: SlotId, payload: string): readonly CorpusFile[] {
  const targetPath = base.slotFile[slotId];
  const marker =
    slotId === 'style'
      ? '/* SLOT:style */'
      : slotId === 'script'
        ? '// SLOT:script'
        : `<!--SLOT:${slotId}-->`;
  return base.files.map((file) => {
    if (file.path !== targetPath || typeof file.content !== 'string') return file;
    if (!file.content.includes(marker)) {
      throw new Error(`${targetPath} 里没有 ${slotId} 槽标记`);
    }
    return { ...file, content: file.content.replace(marker, payload.replace(/\$/g, '$$$$')) };
  });
}

/** data URL 与包内字体：§2.2 要求覆盖「合法 data/blob」与字体资源。 */
export function legalDataUrlAsset(seed: number): CorpusFile {
  return { path: 'assets/badge.png', content: corpusPng(6, 6, seed) };
}

export function legalDataUrlMarkup(seed: number): string {
  return `    <img src="${corpusPngDataUrl(6, 6, seed)}" alt="一枚徽章" width="6" height="6" />`;
}

export function legalFontAsset(seed: number): CorpusFile {
  return { path: 'assets/hand.woff2', content: corpusWoff2(seed) };
}

export const LEGAL_FONT_CSS = `@font-face {
  font-family: 'Corpus Hand';
  src: url('../assets/hand.woff2') format('woff2');
}
`;

// CI 工作流本身也要被测试。
//
// 理由：CI 是这些门禁唯一的强制执行点。`pnpm verify` 在本地跑绿，只说明「有人愿意跑的时候
// 它能跑」；真正挡住违规提交的是 .github/workflows/。而工作流是 YAML —— 它引用的脚本名
// 打错一个字母，job 会红，但更容易发生的是**某个门禁从 CI 里被删掉而没人发现**：
// 那种情况下 CI 全绿，门禁却已经不存在了。
//
// 所以这里锁三件事：
//   1. 覆盖：`pnpm verify` 里的每一个门禁都必须出现在某个工作流的某个 step 里；
//   2. 可执行性：工作流引用的每个 `pnpm <script>` 都必须在 package.json 里真的存在，
//      安装步骤必须带 --frozen-lockfile，工具链版本必须与 packageManager / §2.1 一致；
//   3. fail-closed 未被削弱：license-check.yml 必须保留「出现无检查器的生态清单即失败」
//      这一步，并且这一步是真的用 bash 跑一遍验证的（含一个植入 pyproject.toml 的对照）。
//
// 第 3 条尤其重要：这份工作流原本**只有** fail-closed 占位，ZLQ-159 把它换成了真实门禁。
// 替换过程中最容易犯的错就是顺手把 fail-closed 删掉——那样依赖可以在没有检查器的情况下
// 从别的生态溜进来。所以它不是注释里的承诺，是这里跑出来的结果。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOWS = ['ci.yml', 'license-check.yml'].map((name) => ({
  name,
  path: join(REPO_ROOT, '.github', 'workflows', name),
}));

const tempDirs = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const scripts = rootManifest.scripts;

const docs = new Map();
for (const workflow of WORKFLOWS) {
  const text = readFileSync(workflow.path, 'utf8');
  docs.set(workflow.name, { text, yaml: parseYaml(text) });
}

function allSteps(doc) {
  return Object.entries(doc.jobs ?? {}).flatMap(([jobName, job]) =>
    (job.steps ?? []).map((step) => ({ jobName, step })),
  );
}

// `run: pnpm license:scan` / `run: |\n  pnpm bundles\n  pnpm sbom:generate` 都要抓出来。
// 只认**行首**的 pnpm：探测步骤里有一句 echo "No Node/pnpm manifests …"，
// 不锚定的话它会被当成一条不存在的脚本 `pnpm manifests`。
function pnpmScriptsOf(doc) {
  const found = new Set();
  for (const { step } of allSteps(doc)) {
    if (typeof step.run !== 'string') continue;
    for (const match of step.run.matchAll(/^\s*pnpm\s+(?:run\s+)?([a-z0-9:_-]+)/gm)) {
      const script = match[1];
      // `pnpm install` / `pnpm exec` 不是 package.json 里的脚本。
      if (script === 'install' || script === 'exec') continue;
      found.add(script);
    }
  }
  return found;
}

const ciScripts = new Set();
for (const [, doc] of docs) for (const script of pnpmScriptsOf(doc.yaml)) ciScripts.add(script);

const verifyChain = scripts.verify
  .split('&&')
  .map((part) => part.trim().replace(/^pnpm\s+/, ''))
  .filter(Boolean);

// ── 「verify 已串链、CI 尚未接线」台账 ────────────────────────────────────────
//
// 为什么会有这张表：ZLQ-195（D0）按工单 §6 的硬要求把新增的就绪门禁串进了 `pnpm verify`
// （原文「`verify` 链必须把新门禁串进去，不能只加脚本不串链」），但 `.github/workflows/**`
// 是 D6 的独占面（工单 §2 的绝对禁区），本单无权给它补 step。于是下面第 1 条覆盖锁会立刻
// 判红 —— 而它判红的后果不是「CI 少一道门」，是 **D0 落地后 D1–D5 每一单的 `pnpm test`
// 都是红的**，串行链在中途断掉。
//
// 这**不是**放宽容差。三条约束缺一不可，任何一条被破坏这张表就失去正当性：
//   ① 基线 17 道被单独钉进 BASELINE_VERIFY_CHAIN，永不可进台账。它们掉出 CI 仍然立刻红，
//      和加这张表之前一模一样 —— 豁免只可能发生在「本单新增的门禁」上。
//   ② 台账自我退役：条目一旦被某个工作流接上（D6 补了 step），本文件立刻判红，逼着补
//      step 的人在同一笔改动里把条目删掉。所以它不可能沉淀成一张长期豁免表。
//   ③ 每条必须点名 owner 与理由；写不出归属的缺口不许进台账。
//
// 替代方案（把就绪门禁只留在 `pnpm test` 里、不进 verify 链）被否掉了：那正是 §6 明文
// 禁止的「只加脚本不串链」，而且会让 D2–D6 在 `pnpm verify` 的输出里看不见这道门。
const PENDING_CI_WIRING = [
  {
    script: 'unit-readiness',
    owner: 'D6（`.github/workflows/**` 的独占单；ZLQ-195 交付时尚未建单）',
    reason:
      'ci.yml 需要补一个 `- name: 单元就绪门禁（UnitReadiness 双重 tripwire）` / `run: pnpm unit-readiness` 的 step，' +
      '位置必须在 `pnpm dep-graph:control` 之后、`pnpm build` 之前，与 verify 链同序。',
  },
];

// 基线 17 道门禁（ZLQ-192 验收口径）。这份名单是「永不可豁免」的白名单反面：
// 台账里出现其中任何一个，本文件判红。
const BASELINE_VERIFY_CHAIN = [
  'typecheck',
  'lint',
  'format:check',
  'dep-graph',
  'dep-graph:control',
  'build',
  'contract:check',
  'contract:compat',
  'contract:control',
  'license:scan',
  'bundles',
  'license:bundle',
  'license:third-party:check',
  'sbom:generate',
  'license:image',
  'license:control',
  'test',
];

const pendingScripts = new Set(PENDING_CI_WIRING.map((entry) => entry.script));

describe('工作流引用的脚本都真实存在', () => {
  it.each([...ciScripts].sort())('package.json 里有 %s', (script) => {
    expect(scripts[script], `CI 引用了不存在的脚本 pnpm ${script}`).toBeTypeOf('string');
  });

  it('CI 至少覆盖 install 之外的所有门禁脚本', () => {
    expect(ciScripts.size).toBeGreaterThanOrEqual(13);
  });
});

describe('pnpm verify 的每一项门禁都在 CI 里', () => {
  it('verify 本身就是一串 pnpm 脚本', () => {
    expect(verifyChain.length).toBeGreaterThanOrEqual(13);
    for (const item of verifyChain)
      expect(scripts[item], `verify 引用了不存在的脚本 ${item}`).toBeTypeOf('string');
  });

  // 这条是防漂移的主锁：往 verify 里加门禁却忘了加进 CI，测试立刻红。
  // 唯一的例外是 PENDING_CI_WIRING 台账里点名了归属的条目（见该常量上方的三条约束）。
  it.each(verifyChain)('%s 出现在某个工作流的 step 里，或在待接线台账里点名归属', (script) => {
    expect(
      ciScripts.has(script) || pendingScripts.has(script),
      `${script} 在 verify 里但不在任何工作流里——门禁会从 CI 静默消失。` +
        `若它是新增门禁且 CI 侧归别的单，把它连同 owner 一起写进 PENDING_CI_WIRING，不要直接放宽这条断言。`,
    ).toBe(true);
  });

  it('CI 还额外跑了 verify 没有的 e2e smoke', () => {
    expect(ciScripts.has('test:e2e:smoke')).toBe(true);
  });
});

describe('待接线台账不许变成一张长期豁免表', () => {
  it('台账条目必须真的在 verify 链里（不许留孤儿条目当免死金牌）', () => {
    for (const { script } of PENDING_CI_WIRING)
      expect(verifyChain, `${script} 在台账里却不在 verify 链里`).toContain(script);
  });

  it('台账条目必须点名 owner 与理由', () => {
    for (const entry of PENDING_CI_WIRING) {
      expect(entry.owner?.trim().length, `${entry.script} 没写 owner`).toBeGreaterThan(0);
      expect(entry.reason?.trim().length, `${entry.script} 没写理由`).toBeGreaterThan(0);
    }
  });

  // 自我退役：D6 把 step 补进 ci.yml 之后，这条立刻红，逼它在同一笔改动里删掉台账条目。
  // 少了这一条，台账只会单向增长，最终等价于把覆盖锁整个关掉。
  it.each(PENDING_CI_WIRING.map((entry) => [entry.script, entry.owner]))(
    '%s 已经被 CI 接上了 ⇒ 必须把它从台账里删掉',
    (script) => {
      expect(
        ciScripts.has(script),
        `${script} 已经出现在某个工作流里了，台账条目已经过期 —— 删掉它，` +
          `否则这张表会一直替未来的门禁提供豁免先例`,
      ).toBe(false);
    },
  );

  it('基线 17 道门禁永不可进台账，也一道都不许从 verify 里掉出去', () => {
    for (const script of BASELINE_VERIFY_CHAIN) {
      expect(pendingScripts.has(script), `${script} 是基线门禁，不许豁免`).toBe(false);
      expect(verifyChain, `${script} 从 verify 链里消失了`).toContain(script);
      expect(ciScripts.has(script), `${script} 是基线门禁且必须仍在 CI 里`).toBe(true);
    }
  });
});

describe('工具链与安装约束（issue 第 3 条）', () => {
  it.each(WORKFLOWS.map((w) => w.name))('%s 的 pnpm 版本与 packageManager 一致', (name) => {
    const doc = docs.get(name).yaml;
    const expected = rootManifest.packageManager.split('@')[1];
    const setups = allSteps(doc).filter(({ step }) =>
      String(step.uses ?? '').startsWith('pnpm/action-setup'),
    );
    expect(setups.length).toBeGreaterThan(0);
    for (const { step } of setups) expect(step.with?.version).toBe(expected);
  });

  it.each(WORKFLOWS.map((w) => w.name))('%s 用 Node 24 且缓存 pnpm store', (name) => {
    const doc = docs.get(name).yaml;
    const nodes = allSteps(doc).filter(({ step }) =>
      String(step.uses ?? '').startsWith('actions/setup-node'),
    );
    expect(nodes.length).toBeGreaterThan(0);
    for (const { step } of nodes) {
      expect(step.with?.['node-version']).toBe(24);
      expect(step.with?.cache).toBe('pnpm');
    }
  });

  it('每一个 pnpm install 都是 --frozen-lockfile', () => {
    let installs = 0;
    for (const [, doc] of docs) {
      for (const { step } of allSteps(doc.yaml)) {
        if (typeof step.run !== 'string' || !step.run.includes('pnpm install')) continue;
        installs += 1;
        expect(step.run, '存在未冻结锁文件的安装步骤').toContain('--frozen-lockfile');
      }
    }
    expect(installs).toBeGreaterThanOrEqual(3);
  });

  it('pnpm/action-setup 必须排在 setup-node 之前（后者的 cache:pnpm 要调用 pnpm store path）', () => {
    for (const [, doc] of docs) {
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        const order = (job.steps ?? []).map((step) => String(step.uses ?? ''));
        const pnpmAt = order.findIndex((use) => use.startsWith('pnpm/action-setup'));
        const nodeAt = order.findIndex((use) => use.startsWith('actions/setup-node'));
        if (pnpmAt === -1 || nodeAt === -1) continue;
        expect(pnpmAt, `${jobName} 里 setup-node 早于 pnpm/action-setup`).toBeLessThan(nodeAt);
      }
    }
  });
});

describe('最小权限与注入面', () => {
  it.each(WORKFLOWS.map((w) => w.name))('%s 只申请 contents: read', (name) => {
    const doc = docs.get(name).yaml;
    expect(doc.permissions).toEqual({ contents: 'read' });
  });

  it('没有任何 run 块内插 GitHub 事件负载（脚本注入面）', () => {
    for (const [name, doc] of docs) {
      for (const { jobName, step } of allSteps(doc.yaml)) {
        if (typeof step.run !== 'string') continue;
        expect(step.run, `${name}/${jobName} 的 run 块内插了 github.event`).not.toMatch(
          /\$\{\{\s*github\.event/,
        );
        expect(step.run, `${name}/${jobName} 的 run 块内插了 head_ref`).not.toContain(
          'github.head_ref',
        );
      }
    }
  });

  it('工作流里不含任何形似凭证的字面量', () => {
    for (const [name, doc] of docs) {
      // JS 正则不支持 (?i) 内联开关，只能用 i 标志。
      expect(doc.text, `${name} 里出现了 secret/token 赋值`).not.toMatch(
        /(secret|token|password|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/i,
      );
      // 只允许通过 secrets 上下文引用，而当前两份工作流都不需要任何 secret。
      expect(doc.text, `${name} 引用了 secrets`).not.toContain('secrets.');
    }
  });
});

describe('license-check.yml 的 fail-closed 性质没有被削弱', () => {
  const doc = docs.get('license-check.yml');
  const detectStep = allSteps(doc.yaml).find(({ step }) => step.id === 'manifests');
  const failClosedStep = allSteps(doc.yaml).find(
    ({ step }) =>
      typeof step.run === 'string' && step.run.includes('检查器') && step.run.includes('exit 1'),
  );
  const gateJob = doc.yaml.jobs['dependency-license-gate'];
  const gateSteps = gateJob?.steps ?? [];
  const requireNodeStep = gateSteps.find((step) => step.id === 'require_node_manifest');

  const NODE_GATE_IF = "steps.manifests.outputs.node == 'true'";
  const REQUIRE_NODE_IF = "steps.manifests.outputs.node != 'true'";
  const FOREIGN_IF = "steps.manifests.outputs.foreign == 'true'";

  it('工作流名保持 license-check（分支保护的必需状态上下文名）', () => {
    expect(doc.yaml.name).toBe('license-check');
  });

  it('保留了清单探测步骤，且探测范围仍覆盖非 Node 生态', () => {
    expect(detectStep, '找不到 id: manifests 的探测步骤').toBeTruthy();
    for (const foreign of [
      'pyproject.toml',
      'go.mod',
      'Cargo.toml',
      'pubspec.yaml',
      'pom.xml',
      'requirements',
    ]) {
      expect(detectStep.step.run, `探测范围里丢了 ${foreign}`).toContain(foreign);
    }
  });

  it('保留了「无检查器的生态即失败」这一步', () => {
    expect(failClosedStep, '找不到 fail-closed 步骤').toBeTruthy();
    expect(failClosedStep.step.if).toContain("steps.manifests.outputs.foreign == 'true'");
  });

  // 上面几条都是「文本里有没有」，这一条是「跑起来对不对」：把探测脚本抠出来，
  // 用真 bash 在真目录上跑一遍。没有它，一段永远输出 foreign=false 的脚本同样能过。
  function runDetect(files, cwd) {
    const dir = cwd ?? scratch('lq-ci-detect-');
    for (const rel of files) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, '{}\n', 'utf8');
    }
    const outFile = join(scratch('lq-ci-ghoutput-'), 'gh-output.txt');
    writeFileSync(outFile, '', 'utf8');
    const run = spawnSync('bash', ['-c', detectStep.step.run], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outFile },
    });
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      output: readFileSync(outFile, 'utf8'),
    };
  }

  // 真 bash 执行某个步骤的 run 块。断言步骤到底会不会失败，只能靠跑，
  // 靠 YAML 里有没有 `exit 1` 这个字符串是证明不了的。
  function runStepBash(step, cwd) {
    expect(typeof step.run, `步骤 ${step.name ?? step.id ?? step.uses} 没有 run 块`).toBe('string');
    const run = spawnSync('bash', ['-c', step.run], { cwd, encoding: 'utf8' });
    expect(run.error, `bash 起不来：${run.error?.message}`).toBeUndefined();
    return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
  }

  // 探测步骤日志里那个「遍历所得真实清单数」。它只用于日志，不参与 node 判定，
  // 但 prune 列表是否完整要靠它钉住（删掉任何一个 prune 名字，计数就会涨）。
  function traversedCount(stdout) {
    const match = /清单\s+(\d+)\s+个/.exec(stdout ?? '');
    expect(match, `探测日志里没有打印遍历计数：${stdout}`).toBeTruthy();
    return Number(match[1]);
  }

  // 按 GitHub 的语义走一遍步骤序列：没有 `if` 的步骤隐含 `success()`，
  // 前一步失败则后续（`always()` 除外）全部跳过。
  // 遇到两道断言步骤时用真 bash 执行，由**真实退出码**决定 job 是否已红。
  // `if` 只接受本工作流真实出现的写法，遇到没建模过的表达式直接抛——
  // 否则模型会静默漂移成「什么都不选」，那正是本文件要猎的假绿形状。
  function walkJob(steps, outputs, cwd) {
    const selected = [];
    const guardRuns = [];
    let failed = null;
    for (const step of steps) {
      const expr = step.if;
      let eligible;
      if (expr === undefined || expr === null) eligible = true;
      else if (String(expr).trim() === 'always()') eligible = true;
      else if (expr === NODE_GATE_IF) eligible = outputs.node === 'true';
      else if (expr === REQUIRE_NODE_IF) eligible = outputs.node !== 'true';
      else if (expr === FOREIGN_IF) eligible = outputs.foreign === 'true';
      else throw new Error(`未建模的 if 表达式：${JSON.stringify(expr)}`);
      if (!eligible) continue;
      if (failed) continue;
      selected.push(step);
      if (step === failClosedStep?.step || step === requireNodeStep) {
        const run = runStepBash(step, cwd);
        guardRuns.push({ step, run });
        if (run.status !== 0) failed = step;
      }
    }
    return { selected, guardRuns, failed };
  }

  it('对照：只有 Node 清单时 foreign=false、node=true', () => {
    const run = runDetect(['package.json', 'pnpm-lock.yaml']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.output).toContain('foreign=false');
    expect(run.output).toContain('node=true');
  });

  it('植入 pyproject.toml 后 foreign=true（这就是原来那份工作流会失败的情形）', () => {
    const run = runDetect(['package.json', 'pnpm-lock.yaml', 'backend/pyproject.toml']);
    expect(run.status).toBe(0);
    expect(run.output).toContain('foreign=true');
    expect(run.stdout).toContain('pyproject.toml');
  });

  it('零清单时探测器只报告事实（node=false / foreign=false），且**无权**宣布 job 通过', () => {
    const dir = scratch('lq-ci-zeromanifest-');
    const run = runDetect([], dir);
    // 保留并加强原有的三个事实断言：探测脚本自身退出 0，两个开关都是 false。
    expect(run.status, run.stderr).toBe(0);
    expect(run.output).toContain('foreign=false');
    expect(run.output).toContain('node=false');
    // 原来是正向断言 `toContain('passes trivially')`——那正是脚手架期语义。
    // 现在反过来：探测器只报告事实，「job 能不能过」由 require_node_manifest 决定。
    expect(run.stdout, '探测日志仍在宣称 job 白过').not.toContain('passes trivially');
    // 同一用例里执行前提断言步骤的真 run 块：真 bash 退出码必须是 1。
    expect(requireNodeStep, '找不到 id: require_node_manifest 的前提断言步骤').toBeTruthy();
    const gate = runStepBash(requireNodeStep, dir);
    expect(gate.status, `前提断言没有以 1 退出：${gate.stdout}${gate.stderr}`).toBe(1);
    expect(gate.stdout).toContain('::error::');
  });

  it('在真实仓库上跑：node=true 的判据是根 pnpm-lock.yaml，且无外来生态', () => {
    const run = runDetect([], REPO_ROOT);
    expect(run.status, run.stderr).toBe(0);
    expect(run.output).toContain('foreign=false');
    expect(run.output).toContain('node=true');
    // 判据锚点是仓库根锁文件本身，不是「树里某处出现了 Node 样文件名」。
    expect(existsSync(join(REPO_ROOT, 'pnpm-lock.yaml')), '根 pnpm-lock.yaml 不存在').toBe(true);
    // 刻意不硬编码遍历总数：它会随仓库清单增减漂移。夹具排除由下面的合成树钉住。
    expect(traversedCount(run.stdout), '真实仓库遍历不到任何 Node 清单').toBeGreaterThan(0);
    // PM 补充 B：判据与遍历计数必须**分开**打印，别让人从数字变化里反推判据变了。
    const lines = run.stdout.split('\n');
    expect(
      lines.some((line) => line.includes('判据') && line.includes('pnpm-lock.yaml')),
      '日志没有单独说明「判据 = 仓库根锁文件」',
    ).toBe(true);
    expect(
      lines.some((line) => line.includes('遍历') && /清单\s+\d+\s+个/.test(line)),
      '日志没有单独打印遍历所得的真实清单数',
    ).toBe(true);
  });

  it('prune 列表四个名字都在位，且夹具按**明确路径**排除', () => {
    const run = detectStep.step.run;
    // 只截取 `-type d … -prune` 这一段真表达式：整块 run 里还有解释性注释，
    // 注释里写着「刻意不用全局 -name __fixtures__」，拿整块做零命中断言会被自己的说明文字绊倒。
    const start = run.indexOf('-type d');
    const end = run.indexOf('-prune', start);
    expect(start, '探测步骤里没有 -type d … -prune 表达式').toBeGreaterThanOrEqual(0);
    expect(end, '找不到 -prune').toBeGreaterThan(start);
    const pruneGroup = run.slice(start, end);
    for (const name of ['node_modules', '.git', 'dist', 'build']) {
      expect(pruneGroup, `prune 列表里少了 ${name}`).toContain(`-name ${name}`);
    }
    expect(pruneGroup, '夹具没有按明确路径 ./tools/__fixtures__ 排除').toContain(
      '-path ./tools/__fixtures__',
    );
    // 全局名字匹配会连带误排未来可能属于真实依赖面的同名目录。
    expect(pruneGroup, '出现了全局 -name __fixtures__').not.toContain('-name __fixtures__');
  });

  // Q4 固定输入：这些「诱饵」清单全部位于会被 prune 的目录下，
  // 用来证明夹具与构建目录撑不起 node=true。
  // 四个 prune 名字（node_modules / .git / dist / build）逐个覆盖 —— PM 补充 A。
  const PRUNE_BAIT = [
    'node_modules/package.json',
    '.git/package.json',
    'dist/package.json',
    'build/package.json',
    'tools/__fixtures__/case/package.json',
    'tools/__fixtures__/case/pnpm-lock.yaml',
  ];
  const DOUBLE_ZERO_TREE = ['README.md', 'src/index.ts', ...PRUNE_BAIT];
  const POSITIVE_TREE = [
    'README.md',
    'src/index.ts',
    'package.json',
    'pnpm-lock.yaml',
    ...PRUNE_BAIT,
  ];

  it('合成树（无根锁文件）：被 prune 的伪清单撑不起 node=true → 双零', () => {
    const run = runDetect(DOUBLE_ZERO_TREE);
    expect(run.status, run.stderr).toBe(0);
    expect(run.output).toContain('node=false');
    expect(run.output).toContain('foreign=false');
    // 钉住 prune：任何一个 prune 名字被删掉，这里的计数就会大于 0。
    expect(traversedCount(run.stdout), 'prune 列表漏了某个名字，伪清单被算成真实依赖面').toBe(0);
  });

  it('正对照树（有根锁文件）：node=true，且遍历计数只算真实清单', () => {
    const run = runDetect(POSITIVE_TREE);
    expect(run.status, run.stderr).toBe(0);
    expect(run.output).toContain('node=true');
    expect(run.output).toContain('foreign=false');
    // 期望值来自夹具本身（根 package.json + 根 pnpm-lock.yaml 两个），
    // 不读宿主 node_modules、不读平台、不读真实仓库计数。
    expect(traversedCount(run.stdout)).toBe(2);
  });

  it('YAML 里恰有一个 require_node_manifest，条件精确、位置在 foreign 之后首道门禁之前', () => {
    const hits = allSteps(doc.yaml).filter(({ step }) => step.id === 'require_node_manifest');
    expect(hits.length, 'require_node_manifest 必须恰好一个').toBe(1);
    expect(requireNodeStep.if, '条件被改动就等于把白过路径又开回来了').toBe(REQUIRE_NODE_IF);
    const at = (predicate) => gateSteps.findIndex(predicate);
    const manifestsAt = at((step) => step.id === 'manifests');
    const foreignAt = at((step) => step.if === FOREIGN_IF);
    const requireAt = at((step) => step.id === 'require_node_manifest');
    const firstGateAt = at((step) => step.if === NODE_GATE_IF);
    expect(manifestsAt, '找不到 manifests 探测步骤').toBeGreaterThanOrEqual(0);
    expect(foreignAt, '找不到 foreign fail-closed 步骤').toBeGreaterThan(manifestsAt);
    expect(requireAt, '前提断言必须排在 foreign fail-closed 之后').toBeGreaterThan(foreignAt);
    expect(firstGateAt, '前提断言必须排在第一道 Node 门禁之前').toBeGreaterThan(requireAt);
  });

  it('require_node_manifest 之后、always() 之前的每一步都仍带精确的 node == true 条件', () => {
    const requireAt = gateSteps.findIndex((step) => step.id === 'require_node_manifest');
    expect(requireAt, '找不到 require_node_manifest 步骤').toBeGreaterThanOrEqual(0);
    const conditional = gateSteps
      .slice(requireAt + 1)
      .filter((step) => String(step.if ?? '').trim() !== 'always()');
    // 10 是 ZLQ-165 时的门禁数，这里当作**下限**：门禁被删减即红。
    expect(conditional.length, 'Node 门禁被删减了').toBeGreaterThanOrEqual(10);
    for (const step of conditional) {
      expect(step.if, `门禁「${step.name ?? step.uses}」的条件被削弱`).toBe(NODE_GATE_IF);
    }
  });

  // 契约判定函数：只看结构与条件，供 legacy 负对照使用。
  // 负对照必须能把它翻成 false，否则它就是空洞的（架构师 Q4「证明对照自身不空洞」第 3 条）。
  function holdsMissingManifestContract(job) {
    const steps = job?.steps ?? [];
    const at = (predicate) => steps.findIndex(predicate);
    const manifestsAt = at((step) => step.id === 'manifests');
    const foreignAt = at((step) => step.if === FOREIGN_IF);
    const requireAt = at((step) => step.id === 'require_node_manifest');
    const firstGateAt = at((step) => step.if === NODE_GATE_IF);
    if (manifestsAt < 0 || foreignAt < 0 || requireAt < 0 || firstGateAt < 0) return false;
    if (!(manifestsAt < foreignAt && foreignAt < requireAt && requireAt < firstGateAt))
      return false;
    const require = steps[requireAt];
    if (require.if !== REQUIRE_NODE_IF) return false;
    if (typeof require.run !== 'string' || !/^\s*exit\s+1\s*$/m.test(require.run)) return false;
    if (steps.filter((step) => step.if === NODE_GATE_IF).length < 10) return false;
    return true;
  }

  it('legacy 负对照：从 job 深拷贝里移除 require_node_manifest，契约判定必须翻成 false', () => {
    expect(holdsMissingManifestContract(gateJob), '当前 job 不满足「根锁缺失即红」契约').toBe(true);
    // 只操作固定的 YAML 对象，不从宿主推导期望。
    const legacy = structuredClone(gateJob);
    legacy.steps = legacy.steps.filter((step) => step.id !== 'require_node_manifest');
    expect(
      holdsMissingManifestContract(legacy),
      '移除该步骤后判定仍为 true —— 判定函数是空洞的，它没在检查任何东西',
    ).toBe(false);
  });

  // 四行真值表（架构师 Q1）。每一行的 node/foreign 都由**真 bash 跑探测脚本**得到，
  // 不是手写常量；决定 job 结论的那一步同样用真 bash 执行、用真实退出码判定。
  // 结论列统一为「执行 Node 门禁 或 job 失败」，两者必居其一。
  const TRUTH_TABLE = [
    {
      tree: ['package.json', 'pnpm-lock.yaml'],
      outputs: { node: 'true', foreign: 'false' },
      outcome: 'gates',
      row: 'node=true / foreign=false → 10 道 Node 门禁执行',
    },
    {
      tree: ['package.json', 'pnpm-lock.yaml', 'backend/pyproject.toml'],
      outputs: { node: 'true', foreign: 'true' },
      outcome: 'red',
      row: 'node=true / foreign=true → foreign fail-closed 步骤失败',
    },
    {
      tree: DOUBLE_ZERO_TREE,
      outputs: { node: 'false', foreign: 'false' },
      outcome: 'red',
      row: 'node=false / foreign=false → 前提断言失败（ZLQ-165 的双零）',
    },
    {
      tree: ['backend/requirements.txt'],
      outputs: { node: 'false', foreign: 'true' },
      outcome: 'red',
      row: 'node=false / foreign=true → foreign 步骤先失败，job 已红',
    },
  ];

  it.each(TRUTH_TABLE.map((item) => [item.row, item]))('%s', (_row, item) => {
    const dir = scratch('lq-ci-truth-');
    const detect = runDetect(item.tree, dir);
    expect(detect.status, detect.stderr).toBe(0);
    // 先证明这一行的 outputs 是探测脚本真跑出来的，而不是我写死的假设。
    expect(detect.output, `探测没有给出 node=${item.outputs.node}`).toContain(
      `node=${item.outputs.node}`,
    );
    expect(detect.output, `探测没有给出 foreign=${item.outputs.foreign}`).toContain(
      `foreign=${item.outputs.foreign}`,
    );

    const walk = walkJob(gateSteps, item.outputs, dir);
    const selectedGates = walk.selected.filter((step) => step.if === NODE_GATE_IF);

    if (item.outcome === 'gates') {
      expect(walk.failed, 'node=true/foreign=false 时不该有断言步骤失败').toBeNull();
      expect(selectedGates.length, 'Node 门禁被删减了').toBeGreaterThanOrEqual(10);
    } else {
      expect(
        walk.failed,
        `这一行 job 必须变红；实测 selected=${walk.selected.length}、门禁=${selectedGates.length}`,
      ).not.toBeNull();
      const deciding = walk.guardRuns.at(-1);
      expect(deciding.run.status, `决定 job 结论的步骤没有以 1 退出`).toBe(1);
      expect(deciding.run.stdout).toContain('::error::');
    }
    // 「执行 Node 门禁 或 job 失败」——绝不允许两者都不成立（那就是白过）。
    expect(
      selectedGates.length >= 10 || walk.failed !== null,
      '出现了「门禁全部跳过且 job 成功」的白过组合',
    ).toBe(true);
  });

  it('fail-closed 步骤在 foreign=true 时确实以 1 退出', () => {
    expect(failClosedStep, '找不到 fail-closed 步骤').toBeTruthy();
    const dir = scratch('lq-ci-failclosed-');
    const run = spawnSync('bash', ['-c', failClosedStep.step.run], { cwd: dir, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('::error::');
  });
});

describe('ci.yml 的门禁顺序与完整性', () => {
  const doc = docs.get('ci.yml');
  const quality = doc.yaml.jobs.quality;

  it('顺序是 install → typecheck → lint → 依赖图 → build → test', () => {
    const runs = (quality.steps ?? [])
      .filter((step) => typeof step.run === 'string')
      .map((step) => step.run.trim());
    const indexOf = (needle) => runs.findIndex((run) => run.includes(needle));
    for (const needle of [
      'pnpm install',
      'pnpm typecheck',
      'pnpm lint',
      'pnpm dep-graph',
      'pnpm build',
      'pnpm test',
    ]) {
      expect(indexOf(needle), `quality 作业里找不到 ${needle}`).toBeGreaterThanOrEqual(0);
    }
    expect(indexOf('pnpm install')).toBeLessThan(indexOf('pnpm typecheck'));
    expect(indexOf('pnpm typecheck')).toBeLessThan(indexOf('pnpm lint'));
    expect(indexOf('pnpm lint')).toBeLessThan(indexOf('pnpm dep-graph'));
    expect(indexOf('pnpm dep-graph')).toBeLessThan(indexOf('pnpm build'));
    expect(indexOf('pnpm build')).toBeLessThan(indexOf('pnpm test'));
  });

  it('依赖图门禁必须与对照用例成对出现', () => {
    const runs = (quality.steps ?? [])
      .filter((step) => typeof step.run === 'string')
      .map((step) => step.run.trim());
    expect(runs.some((run) => run === 'pnpm dep-graph')).toBe(true);
    expect(runs.some((run) => run === 'pnpm dep-graph:control')).toBe(true);
  });

  it('e2e-smoke 依赖 quality，并且先装浏览器再跑', () => {
    const e2e = doc.yaml.jobs['e2e-smoke'];
    expect(e2e.needs).toBe('quality');
    const uses = (e2e.steps ?? []).map((step) => String(step.uses ?? ''));
    expect(uses.some((use) => use.startsWith('actions/cache'))).toBe(true);
    const runs = (e2e.steps ?? [])
      .filter((step) => typeof step.run === 'string')
      .map((step) => step.run.trim());
    const installBrowser = runs.findIndex((run) => run.includes('playwright install'));
    const smoke = runs.findIndex((run) => run.includes('test:e2e:smoke'));
    const bundles = runs.findIndex((run) => run === 'pnpm bundles');
    expect(installBrowser).toBeGreaterThanOrEqual(0);
    expect(smoke).toBeGreaterThan(installBrowser);
    expect(bundles).toBeGreaterThanOrEqual(0);
    expect(smoke).toBeGreaterThan(bundles);
  });

  it('浏览器缓存的键绑在锁文件上', () => {
    const cache = (doc.yaml.jobs['e2e-smoke'].steps ?? []).find((step) =>
      String(step.uses ?? '').startsWith('actions/cache'),
    );
    expect(cache.with.key).toContain("hashFiles('pnpm-lock.yaml')");
    expect(cache.with.path).toContain('ms-playwright');
  });
});

describe('CI 实际执行的步骤顺序与 pnpm verify 的链路顺序等价', () => {
  // 真实事故（ZLQ-160 首次推送后两份工作流全红）：ci.yml 在 build 之前跑 typecheck，
  // 而 packages/*/package.json 的 types 指向 ./dist/index.d.ts —— 那个文件只有 build 才产出。
  // 干净检出下 typecheck 必然报 9 处 TS2307，而本地 `pnpm verify` 把 build 放在第一位，
  // 所以本地绿、CI 红。根因不是「步骤顺序写错了」，而是**两条自称同一道门禁的流水线
  // 其实不是同一道门禁**：verify 的顺序与 CI 的顺序各说各话，谁也不校验谁。
  //
  // 因此这里锁的是「顺序等价」而不是「某几个步骤的先后」：把每个作业里**实际会执行的**
  // pnpm 脚本按出现顺序抽出来，只保留同时出现在 verify 链路里的那些，它们在 verify 链路中
  // 的下标必须严格递增。这样任何一侧单独调序都会立刻变红，两侧无法再各自漂移。
  // verifyChain 用文件顶部那一份（同一套解析规则），不在这里再抄一遍：抄两份的结果是
  // 两边可以各自漂移，而这条测试存在的理由恰恰是「不许各说各话」。

  // 与 pnpmScriptsOf 同一套识别规则，但**保留顺序与重复**：Set 会把顺序抹掉，
  // 而顺序正是这条测试要断言的对象。
  function jobScriptSequence(job) {
    const sequence = [];
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      for (const match of step.run.matchAll(/^\s*pnpm\s+(?:run\s+)?([a-z0-9:_-]+)/gm)) {
        const script = match[1];
        if (script === 'install' || script === 'exec') continue;
        sequence.push(script);
      }
    }
    return sequence;
  }

  const jobs = [];
  for (const [name, doc] of docs) {
    for (const [jobName, job] of Object.entries(doc.yaml.jobs ?? {})) {
      jobs.push({ label: `${name}/${jobName}`, sequence: jobScriptSequence(job) });
    }
  }

  it('每个作业抽取到的脚本序列都非空（抽不出来说明解析规则失效，断言会空转）', () => {
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    for (const { label, sequence } of jobs) {
      expect(sequence.length, `${label} 没抽到任何 pnpm 脚本`).toBeGreaterThan(0);
    }
  });

  it.each(jobs.map((job) => [job.label, job.sequence]))(
    '%s 的门禁顺序是 pnpm verify 链路的子序列',
    (_label, sequence) => {
      const shared = sequence
        .map((script) => ({ script, index: verifyChain.indexOf(script) }))
        .filter((item) => item.index >= 0);
      // 至少要有一项共同门禁：一项都没有的话「严格递增」是恒真的，等于没测。
      // 不要求 ≥3 —— e2e-smoke 作业只跑 bundles 加一个 verify 里没有的 test:e2e:smoke，
      // 把阈值定高会让这条测试因为一个合法作业而假失败。防「整体空转」交给下面那条并集断言。
      expect(
        shared.length,
        `${_label} 与 verify 没有任何共同门禁，这条断言会空转`,
      ).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < shared.length; i += 1) {
        const prev = shared[i - 1];
        const cur = shared[i];
        expect(
          cur.index,
          `${_label}：${cur.script} 在 verify 里排在 ${prev.script} 之前（或同位），` +
            `但 CI 里在它之后执行 —— 两条流水线不是同一道门禁。` +
            `CI 顺序 ${sequence.join(' → ')}；verify 顺序 ${verifyChain.join(' → ')}`,
        ).toBeGreaterThan(prev.index);
      }
    },
  );

  // 单作业阈值放宽到 ≥1 之后，必须有一条整体断言兜住「所有作业加起来其实没测到什么」：
  // 全部作业覆盖到的 verify 门禁去重后要接近整条链路，否则上面的递增断言可以靠
  // 「每个作业只跑一项」而恒真。
  //
  // 减掉的 pendingScripts.size 是**点名了归属**的待接线条目，不是一个可调的容差旋钮：
  // 台账里每一条都被上面那组断言单独锁住（必须在 verify 里、必须有 owner、CI 一接上就判红、
  // 基线 17 道永不可进）。台账为空时这条断言与它原来的写法逐字等价。
  it('全部作业合起来覆盖了 verify 链路的绝大多数门禁', () => {
    const covered = new Set(
      jobs
        .flatMap((job) => job.sequence)
        .map((script) => verifyChain.indexOf(script))
        .filter((index) => index >= 0),
    );
    expect(covered.size).toBeGreaterThanOrEqual(verifyChain.length - pendingScripts.size - 1);
  });

  // 反向锁：CI 里出现的门禁不许比 verify 少一个。少一个就意味着「本地全绿但那道门禁在 CI
  // 里根本不存在」，与顺序漂移同样危险，而且不会让 CI 变红。
  it('verify 链路里的每一项门禁都在某个工作流作业里被执行', () => {
    const executed = new Set(jobs.flatMap((job) => job.sequence));
    for (const script of verifyChain) {
      if (pendingScripts.has(script)) continue;
      expect(executed.has(script), `${script} 在 verify 里但没有任何作业执行它`).toBe(true);
    }
  });
});

describe('脚本名不与 pnpm 内置命令冲突', () => {
  // 真实事故：脚本原本叫 `sbom`，而 pnpm 12 自带 `pnpm sbom` 子命令且**内置优先**，
  // 于是 `pnpm sbom` 跑的是内置命令、以「缺少 --sbom-format」退出码 2 失败，
  // 本仓库的 tools/license/sbom.mjs 一行都没执行。CI 里它会红，但错误信息指向的是
  // pnpm 自己的参数解析，看不出是命名冲突——排查成本远高于一开始就锁住。
  //
  // 内置命令列表从 `pnpm help` 实时解析，不写死：pnpm 每个大版本都在加子命令，
  // 写死的清单会在升级后变成一份假的安全感。
  //
  // 解析必须发生在**用例体内**，不能发生在 describe 收集期。
  // 真实事故：这里原本是一行 `const builtins = pnpmBuiltins();` 写在 describe 顶层，
  // 于是 pnpm 不在 PATH 时（corepack 垫片没启用、或最小化 runner）spawnSync 只填 error
  // （ENOENT），status 是 null、stderr 是 undefined，`expect(run.status).toBe(0)`
  // 在**收集期**就抛出。vitest 把收集期抛错记成整块 describe 的用例全部不注册：
  // 单文件跑出来是 `(0 test)` / `Tests no tests`，全量跑出来是总数静默缩量，
  // 而下面那条本该先红的守卫用例「解析出了内置命令表」连注册的机会都没有。
  // 门禁不是变红，是**消失**，且 job 仍然绿——正是 ZLQ-165 报的那个「双零」形状。
  //
  // 刻意不用 beforeAll 兜：beforeAll 抛错同样把用例记成 skipped，形状一模一样。
  // 刻意不用 describe.skip / skipIf：那是把这一整组门禁静默跳过，比现状更危险。
  // 失败也**不缓存**：每条用例都要各自报红，不能第一条红完剩下的就悄悄不跑了。
  let builtinsCache;
  function pnpmBuiltins() {
    if (builtinsCache !== undefined) return builtinsCache;
    const run = spawnSync('pnpm', ['help'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (run.error) {
      throw new Error(
        `无法执行 pnpm help（${run.error.code ?? 'spawn 失败'}：${run.error.message}）—— ` +
          `内置命令表解析不出来，本组「脚本名不与 pnpm 内置命令冲突」的门禁一条也判不了。` +
          `修法：启用 corepack 垫片（corepack enable pnpm；仓库已钉 packageManager: pnpm@12.11.2），` +
          `或把 pnpm 装进 PATH 后重跑。不要用 skip 让它变绿。`,
      );
    }
    expect(run.status, `pnpm help 失败：${run.stderr}`).toBe(0);
    const names = new Set();
    let inCommands = false;
    for (const line of run.stdout.split('\n')) {
      if (/^Commands:\s*$/.test(line)) {
        inCommands = true;
        continue;
      }
      if (!inCommands) continue;
      if (!/^\s{2,}\S/.test(line)) break;
      const [head, ...rest] = line.trim().split(/\s{2,}/);
      const description = rest.join(' ');
      if (head) names.add(head);
      // 别名同样会遮蔽脚本名（`pnpm ls` / `pnpm up` 都跑内置命令）。
      const alias = /\[alias(?:es)?:\s*([^\]]+)\]/.exec(description);
      if (alias) for (const item of alias[1].split(',')) if (item.trim()) names.add(item.trim());
    }
    builtinsCache = names;
    return names;
  }

  it('解析出了内置命令表（解析失败时这条会先红，而不是让下面的断言空转）', () => {
    const builtins = pnpmBuiltins();
    expect(builtins.size).toBeGreaterThan(30);
    for (const expected of ['install', 'add', 'run', 'exec', 'publish', 'sbom', 'licenses']) {
      expect(builtins.has(expected), `pnpm help 里没解析出 ${expected}`).toBe(true);
    }
  });

  it('sbom 确实是内置命令，而本仓库没有叫 sbom 的脚本', () => {
    const builtins = pnpmBuiltins();
    expect(builtins.has('sbom')).toBe(true);
    expect(scripts.sbom).toBeUndefined();
    expect(scripts['sbom:generate']).toBeTypeOf('string');
  });

  // test / start / stop / restart 是「转发到同名脚本」的内置命令，
  // 给脚本起这些名字正是它们的预期用法，不算冲突。
  const SCRIPT_FORWARDING = ['test', 'start', 'stop', 'restart'];

  it.each(Object.keys(scripts).sort())('脚本 %s 不被内置命令遮蔽', (script) => {
    if (SCRIPT_FORWARDING.includes(script)) return;
    const builtins = pnpmBuiltins();
    expect(builtins.has(script), `pnpm ${script} 会跑内置命令而不是这个脚本，请改名`).toBe(false);
  });

  it('CI 与 verify 里引用的每个脚本名都能被 pnpm <script> 直接调起', () => {
    const builtins = pnpmBuiltins();
    for (const script of ciScripts) {
      expect(
        SCRIPT_FORWARDING.includes(script) || !builtins.has(script),
        `CI 里的 pnpm ${script} 会被内置命令截走`,
      ).toBe(true);
    }
  });
});

describe('工作流是合法 YAML 且能被解析', () => {
  it.each(WORKFLOWS.map((w) => w.name))('%s 解析出 jobs 与触发条件', (name) => {
    const doc = docs.get(name).yaml;
    expect(Object.keys(doc.jobs ?? {}).length).toBeGreaterThan(0);
    // YAML 1.1 会把裸 `on` 解析成布尔键 true，两种写法都接受。
    expect(doc.on ?? doc[true], `${name} 没有触发条件`).toBeTruthy();
    for (const [jobName, job] of Object.entries(doc.jobs)) {
      expect(job['runs-on'], `${jobName} 缺少 runs-on`).toBeTruthy();
      expect((job.steps ?? []).length, `${jobName} 没有步骤`).toBeGreaterThan(0);
    }
  });
});

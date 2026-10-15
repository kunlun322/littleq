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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('工作流引用的脚本都真实存在', () => {
  it.each([...ciScripts].sort())('package.json 里有 %s', (script) => {
    expect(scripts[script], `CI 引用了不存在的脚本 pnpm ${script}`).toBeTypeOf('string');
  });

  it('CI 至少覆盖 install 之外的所有门禁脚本', () => {
    expect(ciScripts.size).toBeGreaterThanOrEqual(13);
  });
});

describe('pnpm verify 的每一项门禁都在 CI 里', () => {
  const verifyChain = scripts.verify
    .split('&&')
    .map((part) => part.trim().replace(/^pnpm\s+/, ''))
    .filter(Boolean);

  it('verify 本身就是一串 pnpm 脚本', () => {
    expect(verifyChain.length).toBeGreaterThanOrEqual(13);
    for (const item of verifyChain)
      expect(scripts[item], `verify 引用了不存在的脚本 ${item}`).toBeTypeOf('string');
  });

  // 这条是防漂移的主锁：往 verify 里加门禁却忘了加进 CI，测试立刻红。
  it.each(verifyChain)('%s 出现在某个工作流的 step 里', (script) => {
    expect(
      ciScripts.has(script),
      `${script} 在 verify 里但不在任何工作流里——门禁会从 CI 静默消失`,
    ).toBe(true);
  });

  it('CI 还额外跑了 verify 没有的 e2e smoke', () => {
    expect(ciScripts.has('test:e2e:smoke')).toBe(true);
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

  it('零清单时两个开关都是 false（保留原工作流的 trivially-pass 语义）', () => {
    const run = runDetect([]);
    expect(run.status).toBe(0);
    expect(run.output).toContain('foreign=false');
    expect(run.output).toContain('node=false');
    expect(run.stdout).toContain('passes trivially');
  });

  it('在真实仓库上跑：Node 清单存在、无外来生态', () => {
    const run = runDetect([], REPO_ROOT);
    expect(run.status, run.stderr).toBe(0);
    expect(run.output).toContain('foreign=false');
    expect(run.output).toContain('node=true');
    // tools/__fixtures__ 下的对照用 package.json 会被 find 命中，这是预期的：
    // 它们属于 Node 生态，且从不进入锁文件，所以不影响扫描结果。
    expect(run.stdout).toContain('Node/pnpm 清单');
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

describe('脚本名不与 pnpm 内置命令冲突', () => {
  // 真实事故：脚本原本叫 `sbom`，而 pnpm 12 自带 `pnpm sbom` 子命令且**内置优先**，
  // 于是 `pnpm sbom` 跑的是内置命令、以「缺少 --sbom-format」退出码 2 失败，
  // 本仓库的 tools/license/sbom.mjs 一行都没执行。CI 里它会红，但错误信息指向的是
  // pnpm 自己的参数解析，看不出是命名冲突——排查成本远高于一开始就锁住。
  //
  // 内置命令列表从 `pnpm help` 实时解析，不写死：pnpm 每个大版本都在加子命令，
  // 写死的清单会在升级后变成一份假的安全感。
  function pnpmBuiltins() {
    const run = spawnSync('pnpm', ['help'], { cwd: REPO_ROOT, encoding: 'utf8' });
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
    return names;
  }

  const builtins = pnpmBuiltins();

  it('解析出了内置命令表（解析失败时这条会先红，而不是让下面的断言空转）', () => {
    expect(builtins.size).toBeGreaterThan(30);
    for (const expected of ['install', 'add', 'run', 'exec', 'publish', 'sbom', 'licenses']) {
      expect(builtins.has(expected), `pnpm help 里没解析出 ${expected}`).toBe(true);
    }
  });

  it('sbom 确实是内置命令，而本仓库没有叫 sbom 的脚本', () => {
    expect(builtins.has('sbom')).toBe(true);
    expect(scripts.sbom).toBeUndefined();
    expect(scripts['sbom:generate']).toBeTypeOf('string');
  });

  // test / start / stop / restart 是「转发到同名脚本」的内置命令，
  // 给脚本起这些名字正是它们的预期用法，不算冲突。
  const SCRIPT_FORWARDING = ['test', 'start', 'stop', 'restart'];

  it.each(Object.keys(scripts).sort())('脚本 %s 不被内置命令遮蔽', (script) => {
    if (SCRIPT_FORWARDING.includes(script)) return;
    expect(builtins.has(script), `pnpm ${script} 会跑内置命令而不是这个脚本，请改名`).toBe(false);
  });

  it('CI 与 verify 里引用的每个脚本名都能被 pnpm <script> 直接调起', () => {
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

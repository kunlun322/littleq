// 镜像许可证扫描（ZLQ-153 §10.3 第三处目标）的测试。
//
// 这个目标在本任务里是「留接口 + 显式 TODO」，不是「留空」：判定逻辑必须已经能用，
// 否则 ZLQ-157 接通时才发现它跑不通，就等于把工作量推给了下一个任务。
// 因此这里既测纯函数（组件许可证提取 / 策略判定），也测命令行契约
// （未启用时如何留痕、--require-enabled 如何失败、--from 如何在不启用作业的前提下验证判定链路）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { componentExpressions, evaluateComponents, EXTRACTORS } from '../license/image-scan.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const IMAGE_SCAN = join(REPO_ROOT, 'tools', 'license', 'image-scan.mjs');
const policy = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'license-policy.json'), 'utf8'));

const workdir = mkdtempSync(join(tmpdir(), 'lq-image-scan-'));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

let bomIndex = 0;

function writeBom(components) {
  const file = join(workdir, `bom-${(bomIndex += 1)}.cdx.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components }, null, 2)}\n`,
    'utf8',
  );
  return file;
}

function runScan(components, extraArgs = []) {
  const from = writeBom(components);
  const out = `${from}.report.json`;
  const run = spawnSync(
    process.execPath,
    [IMAGE_SCAN, '--from', from, '--out', out, '--repo-root', REPO_ROOT, ...extraArgs],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return {
    exitCode: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    report: JSON.parse(readFileSync(out, 'utf8')),
  };
}

const component = (name, version, licenses) => ({
  name,
  version,
  ...(licenses ? { licenses } : {}),
});
const id = (license) => [{ license: { id: license } }];

describe('组件许可证字段的三种形态都能读出来', () => {
  it('licenses[].license.id / .name / licenses.expression / evidence.licenseData', () => {
    expect(componentExpressions({ licenses: [{ license: { id: 'MIT' } }] })).toEqual(['MIT']);
    expect(
      componentExpressions({ licenses: [{ license: { name: 'SEE LICENSE IN x.txt' } }] }),
    ).toEqual(['SEE LICENSE IN x.txt']);
    expect(componentExpressions({ licenses: { expression: '(MIT OR Apache-2.0)' } })).toEqual([
      '(MIT OR Apache-2.0)',
    ]);
    expect(
      componentExpressions({
        evidence: { licenseData: { licenses: [{ license: { id: 'ISC' } }] } },
      }),
    ).toEqual(['ISC']);
    expect(componentExpressions({})).toEqual([]);
  });
});

describe('镜像组件的策略判定', () => {
  it('自有工作区包豁免 —— 否则本仓库自己的 AGPL 包会被判成待裁定未登记', () => {
    // cdxgen/trivy 会把应用自身列进 SBOM，而 AGPL-3.0-only 在 reviewRequired 名单里。
    const { rows, summary } = evaluateComponents(
      { components: [component('@littleq/domain', '0.0.0', id('AGPL-3.0-only'))] },
      policy,
    );
    expect(rows[0].own).toBe(true);
    expect(rows[0].verdict).toBe('allowed');
    expect(summary.own).toBe(1);
    expect(summary.thirdParty).toBe(0);
    expect(summary.unregistered).toEqual([]);
  });

  it('第三方的 AGPL 仍然要送裁定，豁免不适用于它', () => {
    const { summary } = evaluateComponents(
      { components: [component('some-agpl-lib', '1.0.0', id('AGPL-3.0-only'))] },
      policy,
    );
    expect(summary.byVerdict['review-required']).toBe(1);
    expect(summary.unregistered).toEqual(['some-agpl-lib@1.0.0']);
  });

  it('白名单许可放行，无许可证声明判未知，禁止条款判禁止', () => {
    const { rows } = evaluateComponents(
      {
        components: [
          component('ok-lib', '1.0.0', id('MIT')),
          component('silent-lib', '1.0.0'),
          component('proprietary-lib', '1.0.0', [
            { license: { name: 'SEE LICENSE IN terms.txt' } },
          ]),
          component('sspl-lib', '1.0.0', id('SSPL-1.0')),
        ],
      },
      policy,
    );
    expect(rows.map((row) => row.verdict)).toEqual([
      'allowed',
      'unknown',
      'forbidden',
      'forbidden',
    ]);
    expect(rows[1].own).toBe(false);
    expect(rows[2].link).toContain('https://www.npmjs.com/package/proprietary-lib/v/1.0.0');
  });

  it('表达式形态按最保守的一支合并', () => {
    const { rows } = evaluateComponents(
      { components: [component('dual-lib', '2.0.0', { expression: '(MIT OR SSPL-1.0)' })] },
      policy,
    );
    expect(rows[0].verdict).toBe('forbidden');
    expect(rows[0].ids).toEqual(['MIT', 'SSPL-1.0']);
  });

  it('镜像就是分发产物：distributed:false 的批准在这里一律前提失效', () => {
    // minimatch@10.2.6（BlueOak-1.0.0）在线上策略里是 approved + distributed:false，
    // 源码扫描下它作为 devDependency 被放行。但镜像**本身就是**分发产物 —— 批准放行它的
    // 唯一理由（不随作品或镜像分发）在镜像里当场不成立，于是批准不得沿用。
    // 这条规则由 tools/lib/collect.mjs 的 approvalOutOfScope() 实现，镜像扫描传入
    // inDistributionArtifact:true；ZLQ-162 之前 approved 在这里会静默通过。
    const { rows, summary } = evaluateComponents(
      { components: [component('minimatch', '10.2.6', id('BlueOak-1.0.0'))] },
      policy,
    );
    expect(rows[0].verdict).toBe('review-required');
    expect(rows[0].adjudication).toEqual({
      id: 'minimatch-blueoak-1.0.0',
      status: 'approved',
      distributed: false,
      outOfScope:
        '裁定 minimatch-blueoak-1.0.0 的前提是 distributed:false（不随产物分发），但它已被打包进分发产物',
    });
    // 三档标签不得混标：它有裁定条目（不是「未登记」），失效原因单列一档。
    expect(summary.needsAdjudication).toEqual(['minimatch@10.2.6']);
    expect(summary.unregistered).toEqual([]);
    expect(summary.approvalsOutOfScope).toEqual([
      {
        package: 'minimatch@10.2.6',
        adjudication: 'minimatch-blueoak-1.0.0',
        reason:
          '裁定 minimatch-blueoak-1.0.0 的前提是 distributed:false（不随产物分发），但它已被打包进分发产物',
      },
    ]);
  });

  it('未登记的 reviewRequired 组件进 needsAdjudication 与 unregistered', () => {
    const { rows, summary } = evaluateComponents(
      { components: [component('some-agpl-lib', '1.0.0', id('AGPL-3.0-only'))] },
      policy,
    );
    expect(rows[0].verdict).toBe('review-required');
    expect(rows[0].adjudication).toBe(null);
    expect(summary.needsAdjudication).toEqual(['some-agpl-lib@1.0.0']);
    expect(summary.unregistered).toEqual(['some-agpl-lib@1.0.0']);
    expect(summary.approvalsOutOfScope).toEqual([]);
  });

  it('提取器按 cdxgen → trivy 顺序探测', () => {
    expect(EXTRACTORS.map((item) => item.tool)).toEqual(['cdxgen', 'trivy']);
  });
});

describe('命令行契约', () => {
  it('未启用时留痕并返回 0：阻塞任务号、待办、登记位置三样都要说出来', () => {
    const run = spawnSync(process.execPath, [IMAGE_SCAN, '--repo-root', REPO_ROOT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('未启用');
    expect(run.stdout).toContain('阻塞于：ZLQ-157');
    expect(run.stdout).toContain('scanTargets.dockerImage');
    expect(run.stdout).toContain('--from artifacts/sbom.cdx.json');
  });

  it('--require-enabled 在策略仍未启用时以退出码 3 失败', () => {
    const run = spawnSync(
      process.execPath,
      [IMAGE_SCAN, '--require-enabled', '--repo-root', REPO_ROOT],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('ZLQ-157');
  });

  it('缺 --image 与 --from 时不能悄悄成功', () => {
    // 用一份 enabled=true 的策略副本走这条分支：线上策略是 false，会先被上面的分支拦下。
    const enabledPolicy = structuredClone(policy);
    enabledPolicy.scanTargets.dockerImage.enabled = true;
    const policyFile = join(workdir, 'enabled-policy.json');
    writeFileSync(policyFile, `${JSON.stringify(enabledPolicy, null, 2)}\n`, 'utf8');
    const run = spawnSync(
      process.execPath,
      [
        IMAGE_SCAN,
        '--repo-root',
        REPO_ROOT,
        '--policy',
        policyFile,
        '--out',
        join(workdir, 'r.json'),
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--image');
  });

  it('--from 在作业未启用时也能验证判定链路，且输出显式标注「不代表已接通」', () => {
    const run = runScan([component('ok-lib', '1.0.0', id('MIT'))]);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain('scanTargets.dockerImage.enabled 仍是 false');
    expect(run.report.summary.total).toBe(1);
    expect(run.report.extractor).toBe('from-file');
  });

  it('判定结果的退出码分档：禁止/未知 1，未登记待裁定 2，合规 0', () => {
    expect(runScan([component('ok-lib', '1.0.0', id('MIT'))]).exitCode).toBe(0);
    expect(runScan([component('sspl-lib', '1.0.0', id('SSPL-1.0'))]).exitCode).toBe(1);
    expect(runScan([component('silent-lib', '1.0.0')]).exitCode).toBe(1);
    expect(runScan([component('some-agpl-lib', '1.0.0', id('AGPL-3.0-only'))]).exitCode).toBe(2);
    // minimatch 的批准以 distributed:false 为前提，而镜像就是分发产物：前提失效，退回待裁定档。
    // ZLQ-162 之前这里静默返回 0——approvalOutOfScope() 补上的正是这个洞。
    expect(runScan([component('minimatch', '10.2.6', id('BlueOak-1.0.0'))]).exitCode).toBe(2);
  });

  it('报告里不含本机绝对路径', () => {
    const run = runScan([component('ok-lib', '1.0.0', id('MIT'))]);
    expect(JSON.stringify(run.report)).not.toContain(REPO_ROOT);
    expect(JSON.stringify(run.report)).not.toContain(workdir);
  });
});

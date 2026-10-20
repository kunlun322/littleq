/**
 * B5 假阴性：最小复现 + 「不许把期望改成实测的样子」棘轮（ZLQ-156 §2.6；本单 §6）。
 *
 * ## 缺陷是什么
 *
 * 语料实测暴露出扫描器的一处真缺陷：`<form>` 只在 `action` 属性**缺失**时被 B5 命中。
 * `action=""` / `action="#top"` / `action="./index.html"` 三种写法零 finding、整包 PASS，
 * 而按 B5 自己的规则文档与 `FROZEN_DISPOSITION_CEILING.B5` 都应当硬拦
 * （冻结 CSP 是 `form-action 'none'`，包内提交同样会被拒）。
 * 受影响的是 `viol-b5-form-empty-action` 家族的 10 件样例，直接后果是 §2.6 的
 * 「全部预期硬拦样例 100% 检出预期规则」不达标：recall 764/774，
 * `recall-all-expected-hard-blocks` 与 `declared-rule-coverage` 两道门因此是红的。
 *
 * ## 这个文件做什么、不做什么
 *
 * §6 明确：语料暴露出扫描器真缺陷 = **返工**，本单不顺手改判定逻辑。所以这里不修它，
 * 只做三件让「修好」与「放弃」在报告里无法混同的事：
 *
 * 1. **把复现钉成可执行的**。四个包只差 `<form>` 开标签一处；A 变体真拦（正对照），
 *    B/C/D 真放（缺陷）。没有 A 那一盏灯，B/C/D 的 PASS 与「扫描根本没跑起来」不可区分。
 * 2. **锁死期望值不许反向漂移**。那 10 件样例的 `expectedDisposition` 必须仍是 `BLOCK`、
 *    `expectedRules` 仍含 B5、`expectedSubTypes` 仍是 `form-element`。
 *    把期望改成实测的样子就能让 recall 门变绿 —— 那正是 ZLQ-194 §16 点名的自我洗白，
 *    这条断言让它必然红。
 * 3. **锁死它已被声明**。`B5_FORM_ACTION_GAP_ID` 必须与 `gaps.ts` 里那条声明同字面量：
 *    两处各写一遍字符串，改了一处忘了另一处，缺陷就会从报告里静默消失。
 *
 * ## 谁可以改这个文件
 *
 * 只有 B5 的返工单。返工落地后的正确动作是把 B/C/D 三处 `toBe('PASS')` 翻成
 * `toBe('BLOCK')`，同时 recall 门自然转绿；**不是**删掉这个文件，也**不是**把语料期望
 * 改成 PASS —— 后者会让「修好了」与「不修了」在报告里长得一模一样。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  B5_FORM_ACTION_GAP_ID,
  B5_FORM_ACTION_RULE_ID,
  B5_FORM_ACTION_VARIANTS,
  b5FormActionRepro,
} from '../src/corpus/defects.js';
import { allCaseSpecs } from '../src/corpus/generator.js';
import { DECLARED_GAP_IDS, DECLARED_GAPS } from '../src/corpus/gaps.js';
import { CORPUS_VERSION } from '../src/corpus/versions.js';
import { FROZEN_DISPOSITION_CEILING } from '../src/scan/finding.js';
import { scanPackage } from '../src/scan/index.js';

/** 受影响的违规家族。10 件，全部在 dev 划分。 */
const AFFECTED_FAMILY_ID = 'viol-b5-form-empty-action';

/** 复现里那个**应当被拦**的正对照变体。 */
const CONTROL_LABEL = 'A-no-action-attribute';

/** 复现里三个**实测被放过**的变体。 */
const DEFECT_LABELS = [
  'B-action-empty-string',
  'C-action-fragment',
  'D-action-in-package',
] as const;

const PLAN_MANIFEST_PATH = fileURLToPath(new URL('../corpus/plan-manifest.jsonl', import.meta.url));

/**
 * pin 下来的版本三元组。
 *
 * 复现必须跑在**报告里那一版**扫描器/词表上：跑在别的版本上，「复现了」这句话就没有指称对象。
 * 读文件而不是重新推导，是为了让「报告与代码不同步」在这一步就暴露成断言失败，
 * 而不是被一次静默的重算掩盖过去（重算正是 §2.6 要挡的事）。
 */
function pinnedVersions(): {
  scannerVersion: string;
  rulesetVersion: string;
  corpusVersion: string;
} {
  const [line] = readFileSync(PLAN_MANIFEST_PATH, 'utf8').split('\n');
  if (!line) throw new Error(`plan-manifest 是空的：${PLAN_MANIFEST_PATH}`);
  const row = JSON.parse(line) as {
    scannerVersion: string;
    rulesetVersion: string;
    corpusVersion: string;
  };
  return row;
}

type ScannedVariant = {
  readonly label: string;
  readonly openTag: string;
  readonly documentedDisposition: string;
  readonly artifactHash: string;
  readonly totalBytes: number;
  readonly paths: readonly string[];
  readonly hashOf: Readonly<Record<string, string>>;
  /** 入口文档的原文。只用于**逐字比对**四个变体的差异，不进任何断言消息或报告。 */
  readonly indexHtml: string;
  readonly scanOk: boolean;
  readonly status: string | null;
  readonly rules: readonly string[];
  readonly blockedRules: readonly string[];
  readonly findingCount: number;
};

async function scanRepro(): Promise<readonly ScannedVariant[]> {
  const versions = pinnedVersions();
  const rows: ScannedVariant[] = [];
  for (const { variant, built } of b5FormActionRepro(
    versions.scannerVersion,
    versions.rulesetVersion,
  )) {
    const result = await scanPackage(built.input);
    const report = result.ok ? result.report : null;
    const entry = built.files.find((file) => file.path === 'index.html');
    if (!entry) throw new Error(`复现包缺入口文档：${variant.label}`);
    rows.push({
      label: variant.label,
      openTag: variant.openTag,
      documentedDisposition: variant.documentedDisposition,
      artifactHash: built.artifactHash,
      totalBytes: built.totalBytes,
      paths: built.files.map((file) => file.path),
      hashOf: { ...built.hashes },
      indexHtml: new TextDecoder().decode(entry.bytes),
      scanOk: result.ok,
      status: report?.status ?? null,
      rules: report ? [...new Set(report.findings.map((finding) => finding.ruleId))] : [],
      blockedRules: report
        ? [
            ...new Set(
              report.findings.filter((f) => f.disposition === 'BLOCK').map((f) => f.ruleId),
            ),
          ]
        : [],
      findingCount: report?.findings.length ?? 0,
    });
  }
  return rows;
}

const VERSIONS = pinnedVersions();
const SCANNED: readonly ScannedVariant[] = await scanRepro();

function byLabel(label: string): ScannedVariant {
  const row = SCANNED.find((candidate) => candidate.label === label);
  if (!row) throw new Error(`复现里没有这个变体：${label}`);
  return row;
}

const AFFECTED_SPECS = allCaseSpecs().filter((spec) => spec.familyId === AFFECTED_FAMILY_ID);

describe('B5 假阴性：四包最小复现', () => {
  it('正对照 —— A 变体（无 action 属性）真被 B5 硬拦，证明复现链路是通的', () => {
    const control = byLabel(CONTROL_LABEL);
    expect(control.scanOk).toBe(true);
    expect(control.status).toBe('BLOCK');
    expect(control.rules).toEqual([B5_FORM_ACTION_RULE_ID]);
    expect(control.blockedRules).toEqual([B5_FORM_ACTION_RULE_ID]);
    expect(control.findingCount).toBe(1);
    // 这一条是整组断言的前提。少了它，B/C/D 的 PASS 可以同时由「B5 漏检」和
    // 「扫描器根本没跑/整个包被前置门禁拒掉」两种原因产生，而这两者的处置完全不同。
    expect(SCANNED.every((row) => row.scanOk)).toBe(true);
  });

  it('B/C/D 三个变体实测 PASS 且零 finding ⇒ 缺陷复现（不是降级、不是部分命中）', () => {
    for (const label of DEFECT_LABELS) {
      const row = byLabel(label);
      expect(row.scanOk).toBe(true);
      expect(row.status).toBe('PASS');
      expect(row.findingCount).toBe(0);
      expect(row.rules).toEqual([]);
      expect(row.blockedRules).toEqual([]);
      // 四个变体的**文档处置**都是 BLOCK ⇒ 这三个 PASS 是假阴性，不是「本来就允许」。
      expect(row.documentedDisposition).toBe('BLOCK');
    }
  });

  it('四个包只差 index.html 的开标签一处：逐字替换即可互相还原', () => {
    // 「最小复现」这四个字必须能被机器核对，不能只写在注释里：
    // 若某个变体顺手改了别的文件，它测的就不再是 action 属性，复现也就不成立。
    expect(SCANNED).toHaveLength(4);
    expect(new Set(SCANNED.map((row) => row.paths.join('|'))).size).toBe(1);
    expect(SCANNED[0]?.paths).toEqual(['index.html', 'assets/cover.png', 'work.json']);
    // 封面是同一份字节 ⇒ 差异不可能来自图片。
    expect(new Set(SCANNED.map((row) => row.hashOf['assets/cover.png'])).size).toBe(1);
    expect(new Set(SCANNED.map((row) => row.hashOf['index.html'])).size).toBe(4);
    expect(new Set(SCANNED.map((row) => row.artifactHash)).size).toBe(4);
    // `work.json` 也各不相同，但那是 `workIdOf('repro-' + label)` 的必然结果
    // （workId 进清单，storageKeyPrefix 由它派生），不是载荷差异 —— 见 defects.ts 的注释。
    expect(new Set(SCANNED.map((row) => row.hashOf['work.json'])).size).toBe(4);

    // 真正的最小性证明：把 A 的开标签换成 X 的开标签，必须**逐字节**得到 X 的 index.html。
    // 这比「四个 hash 互不相同」强得多 —— 后者只说明有差异，前者说明差异**只有那一处**。
    const control = byLabel(CONTROL_LABEL);
    for (const row of SCANNED) {
      const rebuilt = control.indexHtml.split(control.openTag).join(row.openTag);
      expect(rebuilt).toBe(row.indexHtml);
      // 开标签在文档里只出现一次，否则上面的替换证明不了「唯一差异」。
      expect(control.indexHtml.split(control.openTag)).toHaveLength(2);
    }
    expect(SCANNED.map((row) => row.openTag)).toEqual([
      '<form>',
      '<form action="">',
      '<form action="#top">',
      '<form action="./index.html">',
    ]);
  });

  it('B5 的冻结处置上限是 BLOCK ⇒ 文档、冻结表、语料期望三处一致', () => {
    expect(FROZEN_DISPOSITION_CEILING[B5_FORM_ACTION_RULE_ID]).toBe('BLOCK');
    expect(B5_FORM_ACTION_VARIANTS.map((variant) => variant.documentedDisposition)).toEqual([
      'BLOCK',
      'BLOCK',
      'BLOCK',
      'BLOCK',
    ]);
  });
});

describe('B5 假阴性：期望值不许反向漂移（ZLQ-194 §16）', () => {
  it('受影响家族仍是 10 件、全部期望 B5 硬拦 + form-element 子类型', () => {
    expect(AFFECTED_SPECS).toHaveLength(10);
    expect(AFFECTED_SPECS.map((spec) => spec.caseId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${AFFECTED_FAMILY_ID}-v${index}`),
    );
    for (const spec of AFFECTED_SPECS) {
      expect(spec.ruleId).toBe(B5_FORM_ACTION_RULE_ID);
      expect(spec.expectation.label).toBe('HARD_BLOCK');
      expect(spec.expectation.expectedStatus).toBe('BLOCK');
      expect(spec.expectation.expectedDisposition).toBe('BLOCK');
      expect(spec.expectation.expectedConfidence).toBe('HIGH');
      expect([...spec.expectation.expectedRules]).toEqual([B5_FORM_ACTION_RULE_ID]);
      expect([...spec.expectation.expectedSubTypes]).toEqual(['form-element']);
    }
  });

  it('缺陷只影响这一个家族：其余 5 个 B5 家族仍全部期望硬拦，且未被复现牵连', () => {
    // 把「10 件漏检」说成「B5 整条规则漏检」会夸大缺陷，也会让返工单改错地方。
    const b5Specs = allCaseSpecs().filter((spec) => spec.ruleId === B5_FORM_ACTION_RULE_ID);
    expect(b5Specs).toHaveLength(60);
    const families = [...new Set(b5Specs.map((spec) => spec.familyId))];
    expect(families).toHaveLength(6);
    expect(families).toContain(AFFECTED_FAMILY_ID);
    const unaffected = b5Specs.filter((spec) => spec.familyId !== AFFECTED_FAMILY_ID);
    expect(unaffected).toHaveLength(50);
    expect(unaffected.every((spec) => spec.expectation.expectedDisposition === 'BLOCK')).toBe(true);
  });
});

describe('B5 假阴性：缺陷必须是被声明的，不是被吸收的', () => {
  it('defects.ts 的 gapId 与 gaps.ts 的声明是同一个字面量', () => {
    expect(B5_FORM_ACTION_GAP_ID).toBe('scanner-defect-b5-form-action');
    expect(DECLARED_GAP_IDS).toContain(B5_FORM_ACTION_GAP_ID);
  });

  it('声明条目点名了规则、门禁后果与返工归属', () => {
    const gap = DECLARED_GAPS.find((entry) => entry.id === B5_FORM_ACTION_GAP_ID);
    if (!gap) throw new Error(`声明里找不到 ${B5_FORM_ACTION_GAP_ID}`);
    expect(gap.spec).toContain('§2.6');
    expect(gap.severity).toBe('declared-limit');
    expect(gap.statement).toContain(AFFECTED_FAMILY_ID);
    expect(gap.statement).toContain('recallGate.pass === false');
    // 「不许反过来把期望改成 PASS」必须写在补救说明里，否则下一个人只会看到「修 B5」这一个选项。
    expect(gap.fillBy).toContain('不许反过来把期望改成 PASS');
    expect(gap.fillBy).not.toBe('');
  });

  it('复现跑在 pin 下来的版本上，且该版本不是 1.0.0 的稳定语料', () => {
    expect(VERSIONS.scannerVersion).toMatch(/^scanner-corpus-[0-9a-f]{16}$/);
    expect(VERSIONS.rulesetVersion).toMatch(/^ruleset-corpus-[0-9a-f]{16}$/);
    // pin 的版本必须就是代码里那一个：否则报告测的是上一版扫描器，复现测的是这一版，
    // 两者不一致时「缺陷仍然存在」这句话就没有唯一的指称对象。
    expect(VERSIONS.corpusVersion).toBe(CORPUS_VERSION);
    expect(VERSIONS.corpusVersion).not.toBe('1.0.0');
  });
});

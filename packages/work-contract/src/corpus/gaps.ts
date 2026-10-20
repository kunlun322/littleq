/**
 * **已声明缺口表**（ZLQ-156 §2.1 / §2.2 / §2.3 / §2.5 / §2.6 / §7.3）。
 *
 * ## 为什么缺口要写成一个模块，而不是写在交付评论里
 *
 * 评论会被翻过去，报告会被只读表头。把缺口做成**数据**，就能让「报告里必须逐条带上它们」
 * 变成一条可执行断言（`test/corpus-integrity.test.ts`：报告的 `gaps` 段必须包含本表全部
 * `id`，少一条就红）。否则最省力的失败模式不是造假，是**遗漏** —— 一份只写达标项、
 * 不写未产出项的报告，读起来和一份达标的报告一模一样。
 *
 * §7.3 那一行是这张表的授权出处：「本次只给构建方案，未制作 1380 样例、未压测 4MiB/8 秒/内存」
 * ⇒「Stage1 第一版交报告；**未通过不能派生「FPR 已 ≤2%」结论**」。
 *
 * ## 每条缺口的三件事
 *
 * - `spec`：它违背/未满足的是哪一条规格（可核对，不是「有一些限制」）；
 * - `statement`：缺什么，以及**为什么这一单补不上**（授权面、人力、还是别的单据的范围）；
 * - `fillBy`：补齐它需要谁做什么。没有这一项，缺口就只是一句免责声明。
 *
 * `severity` 只有两档：`blocking-admission` = 不补齐就不能把语料 release 成 `1.0.0`
 * （§2.5 的准入条件）；`declared-limit` = 本版报告必须带着它读，但不阻碍 RC 发布。
 */

export type GapSeverity = 'blocking-admission' | 'declared-limit';

export type DeclaredGap = {
  readonly id: string;
  readonly spec: string;
  readonly severity: GapSeverity;
  readonly statement: string;
  readonly fillBy: string;
};

export const DECLARED_GAPS: readonly DeclaredGap[] = [
  {
    id: 'source-tier-2-only',
    spec: 'ZLQ-156 §2.1',
    severity: 'blocking-admission',
    statement:
      '三档样例来源只产出了第二档「本地确定性模板生成与人工变体 240（各单元 20，固定 seeds）」。' +
      '第一档「团队人工制作教学示例 240」与第三档「可控许可明确的公共示例移植 120」**未产出**，' +
      '因此 600 件安全样例的实测规模是 240 件。违规样例的 780 件（13×60）已全部产出，' +
      '因为它们是**在安全基座上的单点变异**，不依赖另外两档的原型工程。',
    fillBy:
      '第一档需要 ≥1 名有 K12 教学背景的作者逐件手工制作（估算：240 件 × 25 min ≈ 100 人时，' +
      '不含评审）；第三档需要 ≥1 名工程师做上游许可核实（逐条记录 MIT/0BSD/CC0 证据、上游 commit、' +
      '许可文本快照，估算 120 件 × 15 min ≈ 30 人时）。' +
      '**本单刻意没有从网络拉取任何第三方示例代码**：把未经许可核实的代码放进 AGPL-3.0-only 仓库' +
      '是一次未授权的供应链动作，不在开发单的权限内。',
  },
  {
    id: 'single-annotator-non-blind',
    spec: 'ZLQ-156 §2.3.2 / §2.3.4 / §2.3.5',
    severity: 'blocking-admission',
    statement:
      '标注只有**一人、非盲**：实现者给自己生成的样例打标。§2.3.2 要求 ≥1 名 Web 安全背景 + ' +
      '≥1 名教育背景标注员，§2.3.5 要求标注员互盲，§2.3.4 的准入是「原始一致率 ≥95% 且 ' +
      'HARD_BLOCK 上 Cohen κ ≥0.80」。没有第二名标注员就没有配对样本，κ **在数学上不可计算**，' +
      '所以本语料 `admissionMet` 恒为 false、`annotationMode` 恒为 `implementer-pass`、' +
      '报告状态恒为 `provisional`、版本号冻结在 `0.1.0-rc.1`。' +
      '`agreement.ts` 的 κ / 一致率 / 准入判读已完整实现并有单测覆盖，但它**没有被真实数据喂过**。',
    fillBy:
      '需要 2 名符合 §2.3.2 背景的标注员，各独立完成全部 1026 件（估算：每人 1026 × 3 min ≈ 51 人时），' +
      '再加 §2.3.3 的第三名裁决者处理分歧、§2.3.6 的 30 件校准样本与每版 ≥10% 复审。' +
      '跑完后 `pairAnnotations(a, b)` → `agreementOf` → `admissionOf` 直接给出 κ 与准入结论，' +
      '无需改代码。',
  },
  {
    id: 'safe-total-240-not-600',
    spec: 'ZLQ-156 §2.2 / §2.6',
    severity: 'blocking-admission',
    statement:
      '§2.6 的 `false_block_rate` 分母是 600，判据是 ≤12/600；holdout 安全集分母是 120，判据 ≤2/120。' +
      '本次安全样例只有 240 件（12 格 × 20，对上 §2.1 第二档的「各单元 20」），' +
      '所以实测分母是 240，报告按等比折算给出 `scaledCeiling`，**并同时报出未折算的设计原值**。' +
      '折算只是让缺口可比，不是把缺口抹掉（不可谈判项 ③：设计里的量不得替代实测语料）。',
    fillBy: '随 `source-tier-2-only` 一起补齐：另两档到位后安全集自然到 600，分母与判据同时归位。',
  },
  {
    id: 'holdout-120-design-vs-measured',
    spec: 'ZLQ-156 §2.2 / §2.6',
    severity: 'declared-limit',
    statement:
      '§2.2 要求每格 40 dev + 10 holdout（合计 480/120）。本次每格 20 件，按**模板家族**切分后' +
      '实测 holdout 安全样例数见报告 `falseBlockRate.holdout.safeSamples`，不等于设计的 120。' +
      '切分单位是家族而不是件（§2.2「50 个不同皮肤但相同代码不算 50 个家族」），' +
      '报告的 `splits.familyLeakage` 逐条核对「同一家族不得同时出现在 dev 与 holdout」。',
    fillBy: '安全集扩到 600 件后，每格 5 个结构家族取 1 个进 holdout 即得 120 件。',
  },
  {
    id: 'manifest-file-location-null',
    spec: 'ZLQ-156 §2.3.2',
    severity: 'declared-limit',
    statement:
      'case manifest 的 `annotations[].file` 与 `locationKey` 恒为 null。' +
      '§2.3.2 要求标注者指出「文件/位置/理由」，本次能满足「理由」（`reasonRef` 指向 ' +
      '`corpus/violations.ts#<familyId>`，那里逐家族写明载荷形态与注入槽位），' +
      '但给不出逐件的文件/位置：`CorpusCaseSpec` 没有记录注入后的路径。' +
      '凭猜测填 `index.html` 是造假位置 —— `multi-file` 覆盖层的载荷可能落在 `script.js` 或 ' +
      '`style.css`，填错的位置会把 FP/FN 归因引到错的文件上，比不填更坏。',
    fillBy:
      '把注入后的路径写回 `CorpusCaseSpec`（`generator.ts` 的改动）⇒ 语料 minor 版本。' +
      '届时 `caseManifestEntry` 直接填真值，无需改 manifest 的字段形状。',
  },
  {
    id: 'exif-constants-not-in-fingerprint',
    spec: 'ZLQ-156 §2.5 / §2.6（判定缓存失效）',
    severity: 'declared-limit',
    statement:
      '规则集指纹覆盖 51 张词库表 + 策略字段 + 5 个可读性阈值，但 `src/scan/exif.ts` 里 B13 用的 ' +
      'EXIF GPS tag 常量是**模块私有、未导出**的，因此不在指纹内：改它们不会让 `rulesetVersion` 变化，' +
      '也就不会让判定缓存 key 变化。这是 §2.6「配置/词库变化必须改变 ruleset hash」的一个真实缺口。',
    fillBy:
      '需要给 `src/scan/exif.ts` 加导出。那是 D3a 已交付并被验收的扫描器代码，本单票面明令' +
      '「不重写扫描器判定算法」，故不自行改动 —— 交架构师裁定是否在 D4 收口。' +
      '注意：`scannerVersion` 取 `src/scan/**` 全部源文件的 sha256 清单哈希，' +
      '所以改 `exif.ts` **会**让 `scannerVersion` 变、判定缓存 key 变；' +
      '缺的只是「它不算 ruleset 变化」这一层归因。',
  },
  {
    id: 'scanner-defect-b5-form-action',
    spec: 'ZLQ-156 §2.6（100% 检出预期规则）/ §2.4',
    severity: 'declared-limit',
    statement:
      '**语料暴露出一个扫描器真缺陷，本单不修**（票面：「若语料暴露出扫描器真缺陷，那是返工，' +
      '须停下点名并附最小复现，不要顺手改判定逻辑」）。' +
      '`src/scan/rules/b05-cross-site-form.ts` 只在 `action` 属性**缺失**时走 `form-element` 支路；' +
      '当 `action=""` / `action="#top"` / `action="./index.html"` 时 `attributeOf` 返回空串而非 null，' +
      '于是落到 `escapes()`，而空/片段/包内相对路径都被资源图判为「不逃逸」⇒ 零 finding、整包 PASS。' +
      "这与该规则自己的行内注释矛盾：冻结 CSP 是 `form-action 'none'`，包内提交同样会被拒。" +
      '实测影响：`viol-b5-form-empty-action` 家族 10 件全部漏检，§2.6 的 ' +
      '「全部预期硬拦样例 100% 检出预期规则」门禁**失败**（报告 `recallGate.pass === false`）。',
    fillBy:
      '返工单（不是本单）：把 `action` 为空串/片段/包内路径三种形态也纳入 `form-element` 判定，' +
      "或让 `escapes()` 在 `form-action 'none'` 下对**任何** action 返回 true。" +
      '修好后本语料的 `viol-b5-form-empty-action` 家族无需改动即可转绿 —— ' +
      '**不许反过来把期望改成 PASS**（ZLQ-194 §16）。',
  },
  {
    id: 'subtype-slots-unreached',
    spec: 'ZLQ-156 §2.4（每条规则 ≥6 种实现族）',
    severity: 'declared-limit',
    statement:
      '规则注册表声明 91 个 (ruleId, subType) 槽位，语料实测走到 **68** 个，23 个未走到，' +
      '逐条列在报告 `subTypeCoverage.unmeasured`（按规则：B1 8、B2 1、B7 1、B10 3、B12 4、B13 6）。' +
      '**「≥6 种实现族」这一条本身是达标的**：13 条规则各有 6 个家族 × 10 件 = 60 件，' +
      '实测家族数见 `composition.violationFamilies`（78）与计划表。' +
      '未走到槽位里有一类是**结构上不可达**，最典型的是 B1 的 `unresolved-reference` 与 ' +
      '`path-too-deep`：前者在资源图里表现为 `unresolved` 而非「逃逸」，B1 不判它；' +
      '后者的路径深度在 `buildCorpusPackage` 的清单校验阶段就被拒（`generator.ts:327` 记了这条），' +
      '根本到不了 B1 的判定点。其余未走到的槽位是**本单的家族表没有为它们各立一个家族**：' +
      '一个家族只承载一种载荷形态，6 个家族最多覆盖 6 个槽位，' +
      '而 B13 声明 22 个、B1 声明 14 个 —— 覆盖率的上限在家族数，不在扫描器。',
    fillBy:
      '要把 68/91 推高，需要给未走到的槽位各补一个家族（⇒ 语料 minor 版本，§2.5）。' +
      '优先级建议：B13 的 `image-exif-gps` 与 `image-hash-deny-listed`（这两条依赖 `exif.ts` 的' +
      '常量与策略里的 `denyListedImageHashes`，而后者当前是空数组 ⇒ 见 `exif-constants-not-in-fingerprint`）、' +
      'B12 的 `undecodable-claim` / `unclassified-claim`（兜底分支，最容易漏判）。' +
      '结构上不可达的那几个要先裁定「它们到底属不属于该规则的判定面」，' +
      '那是扫描器返工单的事，不是语料单能自己决定的。',
  },
  {
    id: 'hard-block-design-vs-lexicon-tier',
    spec: 'ZLQ-156 §2.4（B8/B13 各 50 硬拦 + 10 确认，其余 60 条硬拦）',
    severity: 'declared-limit',
    statement:
      '§2.4 的分层设计折算成件数是「700 件期望 HARD_BLOCK + 80 件期望 CONFIRM_REQUIRED」，' +
      '实测是 **664 + 116**：有 36 件被标成 CONFIRM_REQUIRED 而不是 HARD_BLOCK。' +
      '逐件可追：B2 `viol-b2-online-probe` 10、B7 `viol-b7-storage-key-unprefixed` 10、' +
      'B7 `viol-b7-storage-database-probe` 10、B9 `viol-b9-mining-term` 3、' +
      'B9 `viol-b9-tracking-term` 3（见报告 `expectations.designDeltaPerRule`）。' +
      '原因是这些变体轮换到的词表条目在**冻结词表** `src/scan/lexicon.ts` 里就是 `tier: LOW`，' +
      '判定面只给 CONFIRM_REQUIRED。把它们标成 HARD_BLOCK 有两条路，两条都是造假：' +
      '要么改标注（替扫描器承诺它没承诺的处置，于是这 36 件立刻变成 36 个「处置降级」，' +
      '报告会更难看而且更难查），要么改载荷让它们命中 HIGH 档条目' +
      '（那就等于把「弱线索」家族改写成「强线索」家族，B2/B7/B9 各少一种实现形态，' +
      '反而伤到 §2.4 的「≥6 种实现族」）。' +
      '这 36 件**没有**从分母里消失：它们仍在 780 件违规集内，仍计入召回门禁的声明规则覆盖。',
    fillBy:
      '需要架构师裁定一件二选一的事：① 承认 §2.4 的「60 条硬拦」是**设计意图**而非硬性配额，' +
      '把判据改写成「按冻结词表的 tier 分层，逐规则报出实测分层」——本单已经这么报了；' +
      '或 ② 维持 700/80 的硬配额，那就得改 `src/scan/lexicon.ts` 的 tier（属 D3a 判定面，' +
      '会移动 `rulesetVersion`，且需要重新论证这些弱线索为什么值得硬拦）。' +
      '本单不自行选择，按 ① 报出实测并在此声明差异。',
  },
  {
    id: 'boundary-set-partial',
    spec: 'ZLQ-156 §2.2（边界样例）',
    severity: 'declared-limit',
    statement:
      '§2.2 要求「总量 / 压缩量 / 单文件 / 文件数 / 深度」五个维度各有「等于 / 低于 / 高于」' +
      '冻结上限的样例。本次只产出 3 个维度 × 2 个位置 = 6 件：' +
      '`file-count` / `path-depth` / `path-codepoints` 的 `at-limit` 与 `below-limit`。' +
      '**未产出**：这三个维度的 `above-limit`，以及 `total-bytes` / `compressed-bytes` / ' +
      '`single-file-bytes` 三个维度的全部位置。' +
      '按 §2.2，`above-limit` 属于解包门禁集，「不纳入 B 规则 precision 的 TP」，' +
      '所以它们的缺席不影响任何 precision 数字，但影响「上限被从两侧夹住」这件事的完整性。' +
      '`compressed-bytes` 尤其值得补：压缩炸弹是 §2.2 点名要单独成集的形态。',
    fillBy:
      '补 `above-limit` 三件需要一个能被解包门禁**拒绝**的路径（`scanPackage` 返回 ' +
      '`ok:false`），并单列成「解包门禁集」报告，不与 B 规则 precision 混算。' +
      '补 `compressed-bytes` 需要真实的压缩载体（zip），当前语料的包是内存文件源，没有压缩层。',
  },
  {
    id: 'shard-budget-local-only',
    spec: 'ZLQ-156 §2.6 / §7.2',
    severity: 'declared-limit',
    statement:
      '16 shard 的分配、均衡度与逐片耗时都是**本地开发机顺序执行**的实测（并发度 1）。' +
      '§2.6 的判据是「热 CI ≤3min / 冷 ≤5min」，那是 CI runner 上的墙钟；' +
      '§7.2 还要「单片真实耗时/内存」。报告的 `shardBudget.measuredOn` 恒为 ' +
      '`local-dev-machine`，`caveat` 逐字写明本地数字「只能证明量级上不像会超，不能证明达标」。' +
      '内存口径同样是「每件跑完后采样一次的进程 RSS 峰值」，含 node 与生成器，' +
      '不是单件样例的峰值占用。',
    fillBy: '在真实 CI runner 上跑 `corpus-scan-shard.mjs --all` 并回填 `shardBudget`。',
  },
  {
    id: 'ci-workflow-not-wired',
    spec: 'ZLQ-156 §2.6（CI 计划）',
    severity: 'declared-limit',
    statement:
      '§2.6 的三档 CI 计划（PR 常规 = schema/manifest/授权 + 60 smoke fixtures ≤60s；' +
      '扫描面变化 = 全 1380 + 边界集，16 shards；发布 tag/nightly = 无判定缓存全量 + 浏览器安全集）' +
      '**已回填成可执行的 runner 与分片计划**，但没有接进 GitHub Actions：' +
      '`.github/**` 在本单的禁改面上（「不要改分支保护、仓库设置、`.github/**`」）。' +
      '所以「CI 会按这个计划跑」目前是一个**已具备能力、未接线**的状态。',
    fillBy:
      '由有 `.github/**` 权限的单据把三个 runner 接成 workflow：' +
      '`corpus-plan.mjs`（校验计划未漂移）→ 16 个并行的 `corpus-scan-shard.mjs --shard N` → ' +
      '`corpus-aggregate.mjs`（缺一片即 `PLAN_INCOMPLETE` 失败）。' +
      '前置步骤必须是 `pnpm --filter @littleq/work-contract build`。',
  },
  {
    id: 'holdout-not-statistically-independent',
    spec: 'ZLQ-156 §2.5',
    severity: 'declared-limit',
    statement:
      'dev / holdout 的切分是**按模板家族**做的，且两份都在同一个公开仓库里可见。' +
      '§2.5 明说「仓库可见不等于统计独立」，所以本报告不声称任何盲测认证：' +
      'holdout 数字只证明「没有针对单个 caseId/hash 写旁路逻辑」，' +
      '不证明「扫描器没在这批形态上被调过参」。',
    fillBy:
      '真正的独立性需要一份**不进仓库**的留出集（例如只在发布流水线的私有存储里生成），' +
      '那超出本单授权面。',
  },
  {
    id: 'second-level-budget-not-replaced',
    spec: 'ZLQ-156 §6.3 / §7.2',
    severity: 'declared-limit',
    statement:
      '`src/scan/budget.ts:74-76` 的 `secondLevelDecodes: 200_000` 与 ' +
      '`secondLevelDecodeBytes: 8 MiB` 标着「实现自定（ZLQ-156 §6.3 要求按 parser 压测制定，' +
      'D3b 用实测语料替换）」，provenance 是 `implementation`。' +
      '本单**既没有改这两个常量，也没能实测它们的用量**：`Budget.counters` 只在一次 ' +
      '`scanPackage` 调用内部活着，`ScanReport` 上没有任何计数字段，所以二级解码用量' +
      '从公开扫描面**不可观测** —— 报告 `secondLevelBudget` 一节写的是「不可观测」这件事本身，' +
      '不是用量数字。可观测的替代事实只有一条：全量 1026 件里 **0 件**返回 ' +
      '`SCANNER_RESOURCE_LIMIT`，即这批语料没有触到任何预算上限；' +
      '这只证明「没触顶」，不证明「余量有多少」。' +
      '根因还是没有压测形态：语料里没有压缩炸弹与 4 MiB 级样例（见 `boundary-set-partial`），' +
      '用一个不含压测形态的语料去「替换」压测预算，等于把上限调成当前样例的最大值 —— ' +
      '那不是压测，是把判据改成实测的样子（ZLQ-194 §16）。',
    fillBy:
      '两步：① 补齐 `boundary-set-partial`（尤其 `compressed-bytes` 与 4 MiB 单文件）；' +
      '② 让用量可观测 —— 需要在 `ScanReport` 上加计数字段，那是扫描器公开契约的一次扩展，' +
      '本单不动（改 `src/scan/**` 会连带移动 `scannerVersion`，且属于 D3a 的判定面）。' +
      '两步都做完后，用真实压测峰值 + 安全余量重设这两个常量，' +
      '并把 provenance 从 `implementation` 改成 `measured`。',
  },
  {
    id: 'fpr-not-a-population-claim',
    spec: 'ZLQ-156 §2.6 / §7.3',
    severity: 'declared-limit',
    statement:
      '报告里的 `false_block_rate` 是**基准测量**，不是线上总体误拦率的证明。' +
      '240 件上观察到 0 次误拦，点估计是 0%，但 Wilson 95% 区间上界约 1.5%' +
      '（报告 `falseBlockRate.total.wilson` 给出实测值）—— 也就是说这份语料证明不了' +
      '「总体误拦率 < 2%」，只证明了「在这 240 件上没有观察到误拦」。' +
      'Wilson 区间按 §2.6 只作观察，**不改变 ≤2% 的判据**。' +
      '§7.3 的措辞是授权出处：「未通过不能派生『FPR 已 ≤2%』结论」。',
    fillBy:
      '随安全集扩到 600 件收窄区间；线上真实误拦率需要发布后的申诉/复核数据，不在语料范围内。',
  },
];

/** 缺口 id 表。完整性测试用它核对报告没有漏掉任何一条。 */
export const DECLARED_GAP_IDS: readonly string[] = DECLARED_GAPS.map((gap) => gap.id);

/** 阻碍把语料 release 成 `1.0.0` 的那几条（§2.5 的准入条件）。 */
export const ADMISSION_BLOCKING_GAP_IDS: readonly string[] = DECLARED_GAPS.filter(
  (gap) => gap.severity === 'blocking-admission',
).map((gap) => gap.id);

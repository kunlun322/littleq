/**
 * `ScanInputAssembler` 的组合根实现（端口定义在 `packages/application/src/usecases/pump.ts:213`）。
 *
 * ## 为什么这一层存在
 *
 * `StartScanInput` 还要两样用例层拿不到的东西：`metadata`（从固化产物里的 `work.json`
 * 读出来）与 `policySnapshot`（部署配置）。用例层不读环境变量，所以装配留在组合根。
 * `artifactHash` / `manifestHash` 由用例算好传进来，本文件**不**另算一份 —— 它们是
 * §5.2 `INPUT_HASH_MISMATCH` 的对照值，两处各算一次就等于没有对照。
 *
 * ## 🚨 未配置策略快照时**抛错**，不编一份空的
 *
 * `ScanPolicySnapshot` 里有两份**黑名单**：`knownTrackingDomains`（B12 已知追踪域）与
 * `denyListedImageHashes`（B13 已知违规图像）。把它们默认成 `[]` 在类型上完全合法，
 * 在语义上等于**关掉这两条规则的召回**——扫描照跑、报告照样"通过"，而没有任何一行日志
 * 说明这两条规则其实什么都没查。同理 `revision` / `lexiconRevision` 是 §6.3 那份
 * **逐文件解析缓存**的 key 组成部分：编一个 `'v1'` 出来，会让不同策略版本下的扫描结果
 * 共用同一份缓存。
 *
 * 所以 `configuration === null` ⇒ `assemble` 抛 `DomainError('SCAN_POLICY_UNCONFIGURED')`
 * …… 但错误码集合是 §5.4 冻结的 42 码，**不能新增**。这里用既有的 `INTERNAL_ERROR`：
 * 它不可重试、映射 500，语义正是"服务端自己没准备好"，而不是"学生的作品有问题"。
 * 于是失败方向是安全的：任务停在 `SCANNING` 之前，**绝不会**出现"未扫描的产物被
 * 固化成新版本"。
 *
 * ## `metadata` 的 `as` 不是校验
 *
 * `validateWorkMetadata` 是 work-contract 的**内部**函数，两个 barrel 都没导出它
 * （`packages/work-contract/src/index.ts` 只导出 `MetadataValidation` 这个**类型**）。
 * 而 `ValidatedWorkMetadata` 就是 `WorkMetadata`（`scan/types.ts:70`，一个类型别名），
 * 真正的校验发生在 `scanner.start()` 里 —— work-contract 自己的文件头逐字写着
 * 「`start` 里只做一件会抛的事：`validateWorkMetadata`」。所以这里的 `as` 只是把
 * `JSON.parse` 的 `any` 收成目标类型，**执法点是 scanner**，不是本文件。把这句话写在
 * 这里，是为了防止后来的人误以为组合根已经校验过了。
 */
import { ENVELOPE_MANIFEST_PATH, type ScanInputAssembler } from '@littleq/application';
import { DomainError } from '@littleq/domain';
import type {
  AdultApprovedCapability,
  ScanFileSource,
  ScanPolicySnapshot,
  StartScanInput,
  ValidatedWorkMetadata,
} from '@littleq/work-contract';

/**
 * 扫描装配所需的全部部署配置。
 *
 * 每一项都是**版本标识或黑名单**，没有一项可以从代码里推出来：`scannerVersion` /
 * `rulesetVersion` 跟着 work-contract 的发布走，`storageKeyPrefix` 跟着对象存储的
 * 布局走，两份黑名单跟着安全运营走。
 */
export interface ScanAssemblyConfiguration {
  readonly schemaVersion: string;
  readonly contractVersion: string;
  readonly scannerVersion: string;
  readonly rulesetVersion: string;
  readonly policyRevision: string;
  readonly lexiconRevision: string;
  readonly storageKeyPrefix: string;
  readonly knownTrackingDomains: readonly string[];
  readonly denyListedImageHashes: readonly string[];
  readonly adultApprovedCapabilities: readonly AdultApprovedCapability[];
}

export interface ScanInputAssemblerOptions {
  /** `null` = 部署没有提供扫描策略 ⇒ 装配失败（见文件头，方向是 fail-closed）。 */
  readonly configuration: ScanAssemblyConfiguration | null;
}

async function readManifest(files: ScanFileSource): Promise<unknown> {
  const declared = files.list().find((file) => file.path === ENVELOPE_MANIFEST_PATH);
  if (declared === undefined) {
    // 包络不完整是**产物**的问题，不是配置的问题：502 且不可重试（§5.4 的
    // `ARTIFACT_INCOMPLETE`），重试同一个坏包只会得到同一个结论。
    throw new DomainError('ARTIFACT_INCOMPLETE', `Artifact.${ENVELOPE_MANIFEST_PATH}`);
  }
  const chunks: Uint8Array[] = [];
  const stream = await files.open(ENVELOPE_MANIFEST_PATH);
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    // 不回显解析器的报错文本：它含 offending 片段，而 `work.json` 里可能有学生填的
    // 自由文本标题。
    throw new DomainError('ARTIFACT_INCOMPLETE', `Artifact.${ENVELOPE_MANIFEST_PATH}`);
  }
}

export function createScanInputAssembler(options: ScanInputAssemblerOptions): ScanInputAssembler {
  return {
    async assemble(input): Promise<StartScanInput> {
      const configuration = options.configuration;
      if (configuration === null) throw new DomainError('INTERNAL_ERROR', 'ScanPolicySnapshot');
      const metadata = (await readManifest(input.files)) as ValidatedWorkMetadata;
      const policySnapshot: ScanPolicySnapshot = {
        revision: configuration.policyRevision,
        adultApprovedCapabilities: configuration.adultApprovedCapabilities,
        storageKeyPrefix: configuration.storageKeyPrefix,
        lexiconRevision: configuration.lexiconRevision,
        knownTrackingDomains: configuration.knownTrackingDomains,
        denyListedImageHashes: configuration.denyListedImageHashes,
        // 两项一律 false，且类型上就是 `false` 字面量：允许 wasm 或 postMessage 桥
        // 等于给扫描器开一条它看不见的执行通道（§4.3）。这里不接受配置覆盖。
        allowWasm: false,
        allowPostMessageBridge: false,
      };
      return {
        artifactHash: input.artifactHash,
        manifestHash: input.manifestHash,
        schemaVersion: configuration.schemaVersion,
        contractVersion: configuration.contractVersion,
        scannerVersion: configuration.scannerVersion,
        rulesetVersion: configuration.rulesetVersion,
        metadata,
        files: input.files,
        policySnapshot,
      };
    },
  };
}

/**
 * BYO 凭据的四个用例（ZLQ-221 §4.1：`GET /settings/secrets/{kind}`、`PUT`、`:rotate`、`:revoke`）。
 *
 * ## 「秘密值只有入向、没有出向」在这里是**类型事实**，不是纪律
 *
 * 冻结契约把三个写操作全定成 **204 无 body**（`operations.ts` 的 `putSecret` /
 * `rotateSecret` / `revokeSecret`），`GET` 只回 `{kind, configured, lastRotatedAt}`。
 * 本文件用返回类型把这件事钉死：
 *
 * - 三个写用例的返回类型是 `Promise<void>` —— 它们**结构上**不可能把 `SecretRef`、
 *   明文或摘要放进响应体，编译器就是守卫；
 * - 唯一的读用例返回 domain 的 `SecretMetadata`，而这个类型的键集合被
 *   `packages/api-contract/test/schemas.test.ts` 钉死为三个键，没有一处能装值。
 *
 * 因此 `SecretAdmin.read()` 在本文件里**一次都不出现**。取明文只属于"真的要外呼
 * provider"那条路径（组合根里的 `TurnProviderClient` 实现），BYO 管理面碰不到它。
 *
 * ## CAS 的期望版本从哪来
 *
 * wire 上没有 `expectedVersion` 字段（`putSecretRequestSchema` 只有 `value`，
 * `rotateSecretRequestSchema` 多一个可选 `reason`），而 infra 的 `rotate` / `revoke`
 * 都要求一个 `expectedVersion`。`packages/infra/src/ports/secret-store.ts` 的文件头已经
 * 指明解法：「CAS 的期望版本由 `apps/api` 在**同一个请求内**从当前元数据读出来再传进来」。
 * 本文件就是那个"同一个请求内"：每次写之前先 `metadata()` 一次，把读到的 `version`
 * 当作期望值交下去。
 *
 * 这**不是**一个可以省掉的往返。少了它，两个并发的成人配置请求会都拿到同一个旧版本号、
 * 都认为自己该赢，后写的那个静默覆盖前一个 —— 而 `:rotate` 的全部意义就是"让当前值
 * 失效"，一次静默覆盖等于让调用方以为自己轮换成功、实际用的是别人的值。
 *
 * ## 为什么这一层不翻译下层的错误
 *
 * `SecretAdmin` 的注释（`ports.ts`）已说明：`SECRET_ALREADY_CONFIGURED` → `REVISION_CONFLICT`、
 * `SECRET_NOT_CONFIGURED` → kind-aware 的 `*_CREDENTIAL_NOT_CONFIGURED` 这张表在
 * `packages/infra/src/errors.ts` 的 `PUBLIC_ERROR_CODE` 里，是唯一事实源。本文件只**新增**
 * 契约要求、而 infra 不产出的两条判定（`rotate` 的前提与 `revoke` 的幂等），其余原样穿透。
 */
import {
  type SecretKind,
  type SecretMetadata,
  DomainError,
  createSecretMetadata,
  parseSecretKind,
} from '@littleq/domain';

import { type Actor, ownerActorId } from './authorization.js';
import type { InternalSecretMetadata, SecretAdmin } from './ports.js';

/** 读侧只需要一个端口；写侧也是同一个 —— 四个用例共享，不再各自声明一份依赖集合。 */
export interface SecretServices {
  readonly secrets: SecretAdmin;
}

/**
 * 路径参数 `{kind}` → domain 的 `SecretKind`。
 *
 * 用例收的是 `string` 而不是已解析的 `SecretKind`，为的是让 `SECRET_KIND_UNSUPPORTED`
 * 这个**专属码**保持可达：`packages/api-contract/src/schemas/settings.ts` 的注释逐字要求
 * 「语法合法却在本部署下不可配置的种类必须仍然映射到这个专属码，而不是退化成
 * `REQUEST_INVALID`」。若在适配层先用 zod 的闭集枚举解析，未识别的种类会在到达 domain
 * 之前就被判成 400 `REQUEST_INVALID`，那个专属码就成了死码。
 */
export function secretKindFromParam(value: string): SecretKind {
  return parseSecretKind(value);
}

/**
 * 请求体里的秘密值 → 字节。
 *
 * 放在这里而不是各适配层各写一遍：UTF-8 编码是**唯一**正确的一种（infra 的
 * `EncryptedSecretStore` 按字节加密，latin1 与 UTF-8 对非 ASCII 值会算出不同密文，
 * 而 QCA PAT 之外的种类将来可能含非 ASCII）。函数**不打印、不缓存、不返回**任何
 * 可反推明文的中间量。
 */
export function encodeSecretValue(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * 内部元数据 → 冻结契约的 `SecretMetadata`。
 *
 * 与 infra 的 `toPublicSecretMetadata` **同一套投影**（丢 `version` / `revokedAt`，
 * `rotatedAt` 的 `undefined` 归一成 `null`）。这里重述而不是 import，理由与整个文件头
 * 一致：本包不导入 infra。两份实现的对账由组合根的 parity 测试看守。
 *
 * `lastRotatedAt` 用 `?? null` 而不是 `?? undefined`：契约 schema 是
 * `timestampSchema.nullable()`（required + nullable，附录 A §6.4），`undefined` 会让
 * 这个键在 JSON 里**消失**，而"从未轮换过"与"没有这个字段"在客户端是两件事。
 */
export function toPublicSecretMetadata(
  kind: SecretKind,
  internal: InternalSecretMetadata,
): SecretMetadata {
  return createSecretMetadata({
    kind,
    configured: internal.configured,
    lastRotatedAt: internal.rotatedAt ?? null,
  });
}

/**
 * `configured === true` 却读不到内部代数 ⇒ 行自身不自洽。
 *
 * domain 的 `createSecretRecord` 把「`configured` ⟹ `generation >= 1`」列为不变量 3，
 * 所以这个分支在良构库里不可达。它不是"未配置"（那是 `configured: false`，正常路径），
 * 而是**已配置却没有版本号**：此时任何 CAS 都没有期望值可比，继续写下去就等于无锁覆盖。
 * 与 `authorization.ts` 里 `secretOwnerIdOf` 的 `null` 分支同一条口径 ⇒ `INTERNAL_ERROR`。
 */
function requireVersion(kind: SecretKind, internal: InternalSecretMetadata): number {
  if (internal.version === undefined) {
    throw new DomainError('INTERNAL_ERROR', `SecretRecord.generation[${kind}]`);
  }
  return internal.version;
}

/**
 * `GET /settings/secrets/{kind}` ⇒ 200 `SecretMetadata`。
 *
 * **只有成人（OWNER）能调**：`ownerActorId` 对学生抛 `FORBIDDEN_CAPABILITY`（403）。
 * 这不是"顺手加的权限检查"—— §4.2 逐字：BYO 凭据属于成人配置面，学生若能读它的配置
 * 状态，就能探测出"这个部署有没有可用的 QCA 额度"，而那是成人的账户事实。
 *
 * 判定次序：**先身份，后载荷**。一个学生带一个非法 kind 来调，得到的是 403 而不是
 * 400 —— 反过来会让未认证/越权方拿到一条"哪些 kind 是合法的"的免费预言机。
 */
export async function getSecretMetadataUseCase(
  services: SecretServices,
  input: { readonly actor: Actor; readonly kind: string },
): Promise<SecretMetadata> {
  const ownerId = ownerActorId(input.actor);
  const kind = secretKindFromParam(input.kind);
  const internal = await services.secrets.metadata(ownerId, kind);
  return toPublicSecretMetadata(kind, internal);
}

/**
 * `PUT /settings/secrets/{kind}` ⇒ **204 无 body**。
 *
 * PUT 是**幂等写入**：首次配置与"用同一个值再写一次"都走它，所以它**不**要求凭据已被
 * 配置过（那是 `:rotate` 的前提）。已配置且**异值**时 infra 抛
 * `SECRET_ALREADY_CONFIGURED`（对外 `REVISION_CONFLICT`），本层**不做自动回退到 rotate**：
 * 自动回退会静默覆盖一份正在被使用的凭据，而契约把 PUT 与 `:rotate` 分成两个操作正是
 * 为了让"覆盖"必须是一次显式动作。
 *
 * 返回 `void`：不回显 ref、不回显 hash、不回显 `configured`。客户端要新状态就再 GET 一次。
 */
export async function putSecretUseCase(
  services: SecretServices,
  input: { readonly actor: Actor; readonly kind: string; readonly plaintext: Uint8Array },
): Promise<void> {
  const ownerId = ownerActorId(input.actor);
  const kind = secretKindFromParam(input.kind);
  await services.secrets.set({ ownerId, kind, plaintext: input.plaintext });
}

/**
 * `POST /settings/secrets/{kind}:rotate` ⇒ **204 无 body**。
 *
 * 与 PUT 的差别是**前提**：`:rotate` 要求凭据已经配置过。对未配置的种类调用映射
 * `REQUEST_INVALID`（`operations.ts` 逐字：「那不是"轮换"，客户端应当改调 PUT」）。
 * 这条判定只能在这一层做 —— infra 的 `rotate` 对未配置记录抛的是 `SECRET_NOT_CONFIGURED`，
 * 而它对外映射成 kind-aware 的 `QCA_CREDENTIAL_NOT_CONFIGURED`（那是**任务受理**时的语义：
 * "成人还没配凭据，所以学生发不了任务"），用在一次显式轮换动作上会把客户端引到错误的
 * 修复路径上去。
 */
export async function rotateSecretUseCase(
  services: SecretServices,
  input: { readonly actor: Actor; readonly kind: string; readonly plaintext: Uint8Array },
): Promise<void> {
  const ownerId = ownerActorId(input.actor);
  const kind = secretKindFromParam(input.kind);
  const internal = await services.secrets.metadata(ownerId, kind);
  if (!internal.configured) {
    throw new DomainError('REQUEST_INVALID', `SecretRecord.configured[${kind}]`);
  }
  await services.secrets.rotate({
    ownerId,
    kind,
    plaintext: input.plaintext,
    expectedVersion: requireVersion(kind, internal),
  });
}

/**
 * `POST /settings/secrets/{kind}:revoke` ⇒ **204 无 body**，**幂等**。
 *
 * 契约逐字：「对已经未配置的种类再撤销一次同样返回 204，因为期望的效果已经成立，
 * 把它报成错误会逼客户端先 GET 一次才能安全地撤销。」
 *
 * 幂等在这里有两种情形，处理方式不同：
 *
 * - **从未写入过任何值**（`version === undefined`）：期望的效果（`configured: false`）
 *   自始成立，**直接返回**，不去调下层。此时根本没有一个版本号可以当 CAS 的期望值，
 *   编一个出来（比如 `0`）会让"撤销一个不存在的凭据"变成一次带版本断言的写，
 *   而 `nextSecretGeneration` 的语义是"撤销后不归零"，`0` 不是一个合法的当前代数。
 * - **曾经写入、已被撤销**（`version` 有值、`configured: false`）：照常用读到的版本号
 *   调 `revoke`。infra 的实现对此已经幂等（不改版本、不失败），而**保留**这次调用是有
 *   意义的：它让 `expectedVersion` 仍然参与 CAS，一个并发的 `:rotate` 若已把代数推进，
 *   这次撤销会正确地以 `SECRET_VERSION_CONFLICT` 失败，而不是"撤销"掉一个刚换上的新值。
 *
 * `lastRotatedAt` 与内部代数都**保留**（契约逐字："这个凭证上次被换掉是什么时候"在撤销
 * 之后仍然是一条为真的审计事实），所以撤销之后 GET 回来是
 * `{configured: false, lastRotatedAt: <旧值>}`，不是两个 null。
 */
export async function revokeSecretUseCase(
  services: SecretServices,
  input: { readonly actor: Actor; readonly kind: string },
): Promise<void> {
  const ownerId = ownerActorId(input.actor);
  const kind = secretKindFromParam(input.kind);
  const internal = await services.secrets.metadata(ownerId, kind);
  if (internal.version === undefined) return;
  await services.secrets.revoke({ ownerId, kind, expectedVersion: internal.version });
}

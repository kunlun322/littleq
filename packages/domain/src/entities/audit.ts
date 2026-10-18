/**
 * AuditEvent（附录 A §6.3 `audit_logs`）。
 *
 * domain 侧持有 `AuditEvent` 与它的 allowlist；`ip_hash`、`user_agent_class`、
 * 追加写存储与留存配置都在 infra（§6.3 右栏）。因此这个类型里没有 IP、没有
 * user-agent 原文 —— 它们进 domain 之前就已经是 hash 与分类结果，而分类本身
 * 属于日志 redactor（§6.4「必须留在 application/infra」）。
 *
 * **allowlist 是结构性的，不是约定**。`action` / `resourceType` / `result` 都是
 * 封闭字符串枚举，`safeDetails` 的每个键值都要过 `isSafeEntry`（小驼峰键名 +
 * JSON 标量 + 敏感文本判定）。这是 §7.5「审计明细里不得出现凭证、签名 URL、
 * 原始 provider body、学生 prompt 全文与 stack」在**写入前**的唯一有效拦截点：
 * 追加写的日志一旦落库就没有第二次机会。
 *
 * `resourceId` 也走 allowlist：它只接受 UUIDv7 或 `SecretKind`。放开成任意字符串
 * 等于给 prompt 全文和签名 URL 留了一个直达审计表的通道。
 */

import { DOMAIN_ERROR_CATALOG, isErrorCode } from '../errors/catalog.js';
import { DomainError } from '../errors/domain-error.js';
import { parseUserId, type UserId } from '../value-objects/identifiers.js';
import { parseTimestamp, type Timestamp } from '../value-objects/primitives.js';
import { isSecretKind } from '../value-objects/refs.js';
import { isSafeEntry, type SafeScalar } from '../value-objects/safe-text.js';
import { isUuidV7 } from '../value-objects/identifiers.js';
import { brand, type Branded } from '../value-objects/brand.js';
import { stringEnum } from '../value-objects/enum.js';

/**
 * 可审计的动作。与 §5.4 的 28 个 operation 对应，但**不是**一一对应：
 * 纯读取（`GET /tasks/{id}`、`GET /projects`）不产生审计行 —— 审计表是
 * 「谁改了什么、谁被拒绝了」的记录，把每次轮询都写进去会淹掉真正的事件。
 */
export const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'GROUP_CREATE',
  'GROUP_UPDATE',
  'GROUP_ARCHIVE',
  'GROUP_REACTIVATE',
  'STUDENT_BATCH_CREATE',
  'GROUP_MEMBER_ADD',
  'GROUP_MEMBER_REMOVE',
  'PROJECT_CREATE',
  'PROJECT_UPDATE',
  'PROJECT_ARCHIVE',
  'PROJECT_REACTIVATE',
  'PROJECT_DELETE',
  'PROJECT_RESTORE',
  'TURN_CREATE',
  'TASK_CANCEL',
  'TASK_RETRY',
  'VERSION_RESTORE',
  'PREVIEW_CREATE',
  'PROJECT_PUBLISH',
  'WORK_UPDATE',
  'WORK_DELETE',
  'WORK_RESTORE',
  'SECRET_PUT',
  'USAGE_LIMIT_UPDATE',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
const auditActionEnum = stringEnum<AuditAction>('AuditAction', AUDIT_ACTIONS);
export const isAuditAction = auditActionEnum.is;
export const parseAuditAction = auditActionEnum.parse;

export const AUDIT_RESOURCE_TYPES = [
  'SESSION',
  'USER',
  'GROUP',
  'PROJECT',
  'PROJECT_VERSION',
  'TASK',
  'WORK',
  'PUBLICATION',
  'SECRET',
  'USAGE_LIMIT',
] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];
const auditResourceTypeEnum = stringEnum<AuditResourceType>(
  'AuditResourceType',
  AUDIT_RESOURCE_TYPES,
);
export const isAuditResourceType = auditResourceTypeEnum.is;
export const parseAuditResourceType = auditResourceTypeEnum.parse;

/**
 * 结果三态。`DENIED` 与 `ERROR` 必须分开：前者是策略生效（403/409/429 中
 * 由规则给出的拒绝），后者是系统没能完成判定。把它们合并会让"有人在试探
 * 越权"与"我们坏了"在审计里长得一样。
 */
export const AUDIT_RESULTS = ['SUCCESS', 'DENIED', 'ERROR'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];
const auditResultEnum = stringEnum<AuditResult>('AuditResult', AUDIT_RESULTS);
export const isAuditResult = auditResultEnum.is;
export const parseAuditResult = auditResultEnum.parse;

/** 资源标识：UUIDv7 或 `SecretKind`，二者之外一律拒绝。 */
export type AuditResourceId = Branded<string, 'AuditResourceId'>;

export function isAuditResourceId(value: string): boolean {
  return typeof value === 'string' && (isUuidV7(value) || isSecretKind(value));
}

export function parseAuditResourceId(value: string): AuditResourceId {
  if (!isAuditResourceId(value)) throw DomainError.invalid('AuditResourceId');
  return brand<string, 'AuditResourceId'>(value);
}

/**
 * 审计明细。与 `task_events.safe_payload_json` 用同一套键名与值形状规则，
 * 因此同一个 redactor 前置检查在两处表现一致。
 */
export type AuditDetails = Readonly<Record<string, SafeScalar>>;

export function createAuditDetails(input: Readonly<Record<string, unknown>>): AuditDetails {
  const details: Record<string, SafeScalar> = {};
  /**
   * 键排序后再写入：`safe_details_json` 会被逐字节比对（`contract:check` 的
   * 规范化规则同样要求对象 key 递归排序），不排序会让同一事件在不同宿主上
   * 产生不同的 JSON 字节。
   */
  for (const key of Object.keys(input).sort()) {
    if (!isSafeEntry(key, input[key])) throw DomainError.invalid('AuditDetails');
    details[key] = input[key] as SafeScalar;
  }
  return details;
}

export type AuditEvent = {
  /** 登录失败时可能还不知道是谁，因此可为 null；但绝不用 loginName 代替。 */
  readonly actorId: UserId | null;
  readonly action: AuditAction;
  readonly resourceType: AuditResourceType;
  readonly resourceId: AuditResourceId | null;
  readonly result: AuditResult;
  readonly safeDetails: AuditDetails;
  /**
   * `audit_logs.created_at`。§6.3 的字段清单没有把它列进 `AuditEvent` 的花括号里，
   * 但没有时间的审计行无法排序、无法与任务时间轴对齐，也就无法用于事后复盘；
   * 因此这里显式带上，并在交付评论中声明这处补齐。
   */
  readonly occurredAt: Timestamp;
};

export function createAuditEvent(input: {
  readonly actorId?: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly result: string;
  readonly safeDetails?: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}): AuditEvent {
  return {
    actorId:
      input.actorId === null || input.actorId === undefined ? null : parseUserId(input.actorId),
    action: parseAuditAction(input.action),
    resourceType: parseAuditResourceType(input.resourceType),
    resourceId:
      input.resourceId === null || input.resourceId === undefined
        ? null
        : parseAuditResourceId(input.resourceId),
    result: parseAuditResult(input.result),
    safeDetails: createAuditDetails(input.safeDetails ?? {}),
    occurredAt: parseTimestamp(input.occurredAt),
  };
}

/**
 * 只有落 `DENIED`/`ERROR` 时才要求带机器码：成功路径的细节由业务响应承载，
 * 而失败路径如果连错误码都不留，审计就只能证明"发生过"，无法证明"为什么拒绝"。
 *
 * 这里校验的是 `safeDetails.errorCode` 必须是**目录内**的码，防止把 provider
 * 原始错误串当成审计事实写进去。
 */
export function assertAuditEventExplainable(event: AuditEvent): void {
  if (event.result === 'SUCCESS') return;
  const code = event.safeDetails['errorCode'];
  if (typeof code !== 'string' || !isErrorCodeInCatalog(code)) {
    throw DomainError.invalid('AuditDetails.errorCode');
  }
}

function isErrorCodeInCatalog(value: string): boolean {
  return isErrorCode(value);
}

/**
 * 目录中允许出现在审计明细里的错误码全集 —— 刻意**不另列一份**清单。
 *
 * 另列就会漂移；catalog 是冻结的 42 个码，直接由它派生。导出这个集合是为了让
 * api-contract 层与测试能引用同一个事实源，而不是各自硬编码。
 */
export const AUDIT_EXPLAINABLE_ERROR_CODES: readonly string[] = DOMAIN_ERROR_CATALOG.map(
  (definition) => definition.code,
);

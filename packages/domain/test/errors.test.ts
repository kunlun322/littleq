import { describe, expect, it } from 'vitest';

import {
  DOMAIN_ERROR_CATALOG,
  DomainError,
  ERROR_ENVELOPE_FIELDS,
  NEVER_IMPLICITLY_MOUNTED_ERROR_CODES,
  RATE_LIMIT_ERROR_CODES,
  TASK_KINDS,
  TASK_STAGES,
  assertTaskErrorRegistryComplete,
  errorDefinition,
  httpStatusOf,
  isErrorCode,
  isRetryable,
  registeredAsyncErrorCodes,
  sameRequestRetrySafetyOf,
  taskErrorCodes,
  taskErrorRegistry,
  toSafeError,
  type ErrorCode,
  type SameRequestRetrySafety,
} from '../src/index.js';

/**
 * 错误码目录与异步错误登记表。
 *
 * 目录是**冻结契约**（ZLQ-153 §5.2 的 42 个码），所以这里把整张表逐行写死：任何一行
 * 的 `code` / `httpStatus` / `messageKey` / `retryable` / `sameRequestRetrySafety` 变化
 * 都必须在这里红一次，而不是被静默地重新生成一份新快照。附录 A §4.2 B 明确把「改变
 * 既有错误码的 HTTP status、messageKey、retryable、sameRequestRetrySafety」列为破坏性
 * 变更 —— 这张表就是那道门禁的语义基线。
 *
 * 顺序也写死：`RATE_LIMIT_ERROR_CODES` 一类的派生集合是按**目录顺序**过滤出来的，
 * 目录重排会改变它的顺序，而顺序会进入生成的 OpenAPI 快照。
 */
const FROZEN_CATALOG: readonly (readonly [
  string,
  number,
  string,
  boolean,
  SameRequestRetrySafety,
])[] = [
  ['REQUEST_INVALID', 400, 'request.invalid', false, 'SAFE'],
  ['IDEMPOTENCY_KEY_REQUIRED', 400, 'request.idempotencyKey.required', false, 'SAFE'],
  ['AUTHENTICATION_REQUIRED', 401, 'auth.required', false, 'SAFE'],
  ['AUTHENTICATION_FAILED', 401, 'auth.failed', false, 'SAFE'],
  ['ACCOUNT_LOCKED', 423, 'auth.account.locked', false, 'SAFE'],
  ['CSRF_REJECTED', 403, 'auth.csrfRejected', false, 'SAFE'],
  ['FORBIDDEN_CAPABILITY', 403, 'auth.capability.forbidden', false, 'SAFE'],
  ['RESOURCE_NOT_FOUND', 404, 'resource.notFound', false, 'SAFE'],
  ['LOGIN_NAME_CONFLICT', 409, 'account.loginName.conflict', false, 'SAFE'],
  ['GROUP_ARCHIVED', 409, 'group.archived', false, 'SAFE'],
  ['GROUP_MEMBER_LIMIT_REACHED', 409, 'group.memberLimit.reached', false, 'SAFE'],
  ['REVISION_CONFLICT', 409, 'resource.revisionConflict', false, 'SAFE'],
  ['IDEMPOTENCY_KEY_REUSED', 409, 'request.idempotencyKey.reused', false, 'UNSAFE'],
  ['ACTIVE_WRITE_TASK_EXISTS', 409, 'task.activeWrite.exists', false, 'SAFE'],
  ['TASK_NOT_CANCELLABLE', 409, 'task.cancel.notAllowed', false, 'SAFE'],
  ['TASK_NOT_RETRYABLE', 409, 'task.retry.notAllowed', false, 'SAFE'],
  ['VERSION_NOT_RESTORABLE', 409, 'version.restore.notAllowed', false, 'SAFE'],
  ['VERSION_NOT_PREVIEWABLE', 422, 'version.preview.notAvailable', false, 'SAFE'],
  ['VERSION_NOT_PUBLISHABLE', 422, 'version.publish.notAllowed', false, 'SAFE'],
  ['PUBLICATION_IN_PROGRESS', 409, 'publication.inProgress', false, 'SAFE'],
  ['SECRET_KIND_UNSUPPORTED', 400, 'secret.kind.unsupported', false, 'SAFE'],
  ['SECRET_IMMUTABLE_REDEPLOY_REQUIRED', 409, 'secret.immutable.redeployRequired', false, 'SAFE'],
  ['USAGE_LIMIT_EXCEEDED', 429, 'usage.limit.exceeded', false, 'SAFE'],
  ['RATE_LIMITED', 429, 'request.rateLimited', true, 'SAFE'],
  ['QCA_CREDENTIAL_NOT_CONFIGURED', 422, 'agent.credential.missing', false, 'SAFE'],
  ['QCA_CREDENTIAL_INVALID', 422, 'agent.credential.invalid', false, 'SAFE'],
  ['QCA_QUOTA_EXHAUSTED', 429, 'agent.energy.empty', false, 'SAFE'],
  ['QCA_UNREACHABLE', 503, 'agent.connection.unavailable', true, 'REQUIRES_IDEMPOTENCY_KEY'],
  ['BAILIAN_CREDENTIAL_NOT_CONFIGURED', 422, 'media.credential.missing', false, 'SAFE'],
  ['BAILIAN_CREDENTIAL_INVALID', 422, 'media.credential.invalid', false, 'SAFE'],
  ['BAILIAN_QUOTA_EXHAUSTED', 429, 'media.energy.empty', false, 'SAFE'],
  ['BAILIAN_UNREACHABLE', 503, 'media.connection.unavailable', true, 'REQUIRES_IDEMPOTENCY_KEY'],
  ['AGENT_FAILED', 502, 'agent.run.failed', false, 'SAFE'],
  ['ARTIFACT_MISSING', 502, 'artifact.missing', false, 'SAFE'],
  ['ARTIFACT_INCOMPLETE', 502, 'artifact.incomplete', false, 'SAFE'],
  ['BUILD_FAILED', 422, 'work.build.failed', false, 'SAFE'],
  ['WORK_CONTRACT_BLOCKED', 422, 'work.contract.blocked', false, 'SAFE'],
  ['CONTENT_REJECTED', 422, 'content.rejected', false, 'SAFE'],
  ['TASK_TIMEOUT', 504, 'task.timeout', false, 'REQUIRES_IDEMPOTENCY_KEY'],
  ['USER_CANCELLED', 409, 'task.cancelled', false, 'SAFE'],
  [
    'DEPENDENCY_UNAVAILABLE',
    503,
    'system.dependency.unavailable',
    true,
    'REQUIRES_IDEMPOTENCY_KEY',
  ],
  ['INTERNAL_ERROR', 500, 'system.unavailable', false, 'UNSAFE'],
];

const ALL_CODES: readonly string[] = FROZEN_CATALOG.map(([code]) => code);

describe('error-catalog-frozen：错误码目录逐行冻结', () => {
  it('目录与 §5.2 的冻结表逐行逐字段一致（含顺序）', () => {
    expect(
      DOMAIN_ERROR_CATALOG.map((entry) => [
        entry.code,
        entry.httpStatus,
        entry.messageKey,
        entry.retryable,
        entry.sameRequestRetrySafety,
      ]),
    ).toEqual(FROZEN_CATALOG.map((row) => [...row]));
  });

  it('code 唯一', () => {
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
  });

  it('messageKey 唯一（两个码共用一个文案 key 会让前端无法区分原因）', () => {
    const keys = FROZEN_CATALOG.map(([, , messageKey]) => messageKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每行都只有目录定义的那五个字段', () => {
    for (const entry of DOMAIN_ERROR_CATALOG) {
      expect(Object.keys(entry).sort()).toEqual([
        'code',
        'httpStatus',
        'messageKey',
        'retryable',
        'sameRequestRetrySafety',
      ]);
    }
  });
});

describe('错误码目录：跨行不变量', () => {
  it('retryable 为真时，同请求重放安全度不得是 UNSAFE', () => {
    // 这两个字段是正交的：一个说「可以自动重试」，一个说「原样重放会不会新增副作用」。
    // 同时给出「可重试」和「禁止盲目重放」是自相矛盾的指令，前端无从下手。
    for (const entry of DOMAIN_ERROR_CATALOG) {
      if (entry.retryable) {
        expect(entry.sameRequestRetrySafety, entry.code).not.toBe('UNSAFE');
      }
    }
  });

  it('REQUIRES_IDEMPOTENCY_KEY 只出现在 5xx', () => {
    // 幂等键的意义是「同一个键重放不产生第二份副作用」，只有服务端可能已经动过手
    // （上游不可达、依赖不可用、硬超时）时才需要它。4xx 是请求本身的问题，重放不会
    // 产生副作用，标成 REQUIRES_IDEMPOTENCY_KEY 只会白白要求学生端存键。
    for (const entry of DOMAIN_ERROR_CATALOG) {
      if (entry.sameRequestRetrySafety === 'REQUIRES_IDEMPOTENCY_KEY') {
        expect(entry.httpStatus, entry.code).toBeGreaterThanOrEqual(500);
      }
    }
    const requiring = DOMAIN_ERROR_CATALOG.filter(
      (entry) => entry.sameRequestRetrySafety === 'REQUIRES_IDEMPOTENCY_KEY',
    ).map((entry) => entry.code);
    expect(requiring.sort()).toEqual(
      ['DEPENDENCY_UNAVAILABLE', 'QCA_UNREACHABLE', 'BAILIAN_UNREACHABLE', 'TASK_TIMEOUT'].sort(),
    );
  });

  it('retryable 的四个码就是 §5.2 里标「是」的那四个', () => {
    expect(
      DOMAIN_ERROR_CATALOG.filter((entry) => entry.retryable)
        .map((entry) => entry.code)
        .sort(),
    ).toEqual(['BAILIAN_UNREACHABLE', 'DEPENDENCY_UNAVAILABLE', 'QCA_UNREACHABLE', 'RATE_LIMITED']);
  });

  it('UNSAFE 的两个码：盲目重放会产生第二份副作用', () => {
    // IDEMPOTENCY_KEY_REUSED：键已经被用过，重放正是它检测的行为。
    // INTERNAL_ERROR：服务端可能已经写了一半，重放等于再写一次。
    expect(
      DOMAIN_ERROR_CATALOG.filter((entry) => entry.sameRequestRetrySafety === 'UNSAFE')
        .map((entry) => entry.code)
        .sort(),
    ).toEqual(['IDEMPOTENCY_KEY_REUSED', 'INTERNAL_ERROR']);
  });

  it('ARTIFACT_INCOMPLETE 自身不可重试（补交流程耗尽后才落终态）', () => {
    // §5.2 原文：「只在同一 task/session 的一次补交流程耗尽后落为终态，因此自身不再
    // 标为 retryable」。补交是 SESSION_REPAIR 机制，不是 HTTP 重放，也不是新 attempt。
    const definition = errorDefinition('ARTIFACT_INCOMPLETE');
    expect(definition.retryable).toBe(false);
    expect(definition.httpStatus).toBe(502);
  });

  it('httpStatus 都落在 4xx/5xx，且是整数', () => {
    for (const entry of DOMAIN_ERROR_CATALOG) {
      expect(Number.isInteger(entry.httpStatus), entry.code).toBe(true);
      expect(entry.httpStatus, entry.code).toBeGreaterThanOrEqual(400);
      expect(entry.httpStatus, entry.code).toBeLessThan(600);
    }
  });

  it('messageKey 是小写点开头的 i18n key，不含空格', () => {
    for (const entry of DOMAIN_ERROR_CATALOG) {
      expect(entry.messageKey, entry.code).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
    }
  });

  it('code 是全大写下划线', () => {
    for (const code of ALL_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
    }
  });
});

describe('错误码目录：查询函数', () => {
  it('isErrorCode 认得目录里的每一个码，认不得别的', () => {
    for (const code of ALL_CODES) {
      expect(isErrorCode(code), code).toBe(true);
    }
    expect(isErrorCode('NOT_A_CODE')).toBe(false);
    expect(isErrorCode('')).toBe(false);
    expect(isErrorCode('request.invalid')).toBe(false);
    // 大小写敏感：前端拿到的码必须与目录逐字节相同。
    expect(isErrorCode('request_invalid')).toBe(false);
    expect(isErrorCode('Request_Invalid')).toBe(false);
  });

  it('errorDefinition 返回目录里的那个对象（不是副本）', () => {
    const definition = errorDefinition('RATE_LIMITED');
    expect(definition).toBe(DOMAIN_ERROR_CATALOG.find((entry) => entry.code === 'RATE_LIMITED'));
    expect(definition.code).toBe('RATE_LIMITED');
  });

  it('httpStatusOf / sameRequestRetrySafetyOf / isRetryable 与目录一致', () => {
    for (const entry of DOMAIN_ERROR_CATALOG) {
      expect(httpStatusOf(entry.code), entry.code).toBe(entry.httpStatus);
      expect(sameRequestRetrySafetyOf(entry.code), entry.code).toBe(entry.sameRequestRetrySafety);
      expect(isRetryable(entry.code), entry.code).toBe(entry.retryable);
    }
  });

  it('toSafeError 只留下 envelope 需要的三个字段', () => {
    // §5.5 的 Task.error 形状是 {code, messageKey, retryable}：不含 httpStatus（那是
    // 传输层的事），更不含 sameRequestRetrySafety 之外的任何内部字段。
    expect(toSafeError('QCA_UNREACHABLE')).toEqual({
      code: 'QCA_UNREACHABLE',
      messageKey: 'agent.connection.unavailable',
      retryable: true,
    });
    expect(Object.keys(toSafeError('INTERNAL_ERROR')).sort()).toEqual([
      'code',
      'messageKey',
      'retryable',
    ]);
  });

  it('ERROR_ENVELOPE_FIELDS 是对外 envelope 的字段白名单', () => {
    expect(ERROR_ENVELOPE_FIELDS).toEqual(['code', 'messageKey', 'retryable', 'traceId']);
    // traceId 是 envelope 独有的（由传输层生成），不在目录定义里。
    for (const entry of DOMAIN_ERROR_CATALOG) {
      expect(Object.hasOwn(entry, 'traceId')).toBe(false);
    }
  });

  it('RATE_LIMIT_ERROR_CODES 按目录顺序派生自 httpStatus === 429', () => {
    const expected = DOMAIN_ERROR_CATALOG.filter((entry) => entry.httpStatus === 429).map(
      (entry) => entry.code,
    );
    expect(RATE_LIMIT_ERROR_CODES).toEqual(expected);
    // 目录顺序不是字典序 —— 这条断言钉住「派生用的是目录顺序」，避免有人改成 sorted
    // 之后前端的重试提示顺序悄悄变化。
    expect([...RATE_LIMIT_ERROR_CODES]).toEqual([
      'USAGE_LIMIT_EXCEEDED',
      'RATE_LIMITED',
      'QCA_QUOTA_EXHAUSTED',
      'BAILIAN_QUOTA_EXHAUSTED',
    ]);
  });

  it('NEVER_IMPLICITLY_MOUNTED_ERROR_CODES 只有两个', () => {
    // §5.4：「INTERNAL_ERROR 与 DEPENDENCY_UNAVAILABLE 不隐式挂载，由 operation 明确
    // 声明」。生成器不得给所有 operation 兜底加它们，否则 x-littleq-error-codes 就
    // 变成一句对每个接口都成立的空话。
    expect(NEVER_IMPLICITLY_MOUNTED_ERROR_CODES).toEqual([
      'INTERNAL_ERROR',
      'DEPENDENCY_UNAVAILABLE',
    ]);
  });
});

describe('DomainError：结构性脱敏', () => {
  it('携带 code / messageKey / retryable / valueObject，与目录一致', () => {
    const error = new DomainError('GROUP_MEMBER_LIMIT_REACHED', 'Group');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('GROUP_MEMBER_LIMIT_REACHED');
    expect(error.messageKey).toBe('group.memberLimit.reached');
    expect(error.retryable).toBe(false);
    expect(error.valueObject).toBe('Group');
  });

  it('valueObject 可省略', () => {
    expect(new DomainError('INTERNAL_ERROR').valueObject).toBeUndefined();
  });

  it('DomainError.invalid 是值对象校验的统一入口', () => {
    const error = DomainError.invalid('UuidV7');
    expect(error.code).toBe('REQUEST_INVALID');
    expect(error.valueObject).toBe('UuidV7');
    expect(error.messageKey).toBe('request.invalid');
  });

  it('message 由码与值对象名确定性拼成，没有第三个信息通道', () => {
    // §7.5：绝不携带原值、provider body、header、stack 或学生输入全文。
    // 这不是靠调用方自觉 —— 构造签名只接受 `code` 与一个**值对象名**。`Function.length`
    // 为 2（TS 会把可选参数一并编进 JS 形参表）就是「没有第三个 detail/cause 参数」的
    // 机器可读证明。
    expect(DomainError.length).toBe(2);
    expect(new DomainError('RATE_LIMITED', 'Task').message).toBe('RATE_LIMITED: Task');
    expect(new DomainError('RATE_LIMITED').message).toBe('RATE_LIMITED');
    expect(DomainError.invalid('LoginName').message).toBe('REQUEST_INVALID: LoginName');
  });

  it('类上没有可以塞进原文的字段', () => {
    const error = new DomainError('RATE_LIMITED', 'Task');
    const own = Object.getOwnPropertyNames(error);
    for (const expected of ['code', 'messageKey', 'retryable', 'valueObject']) {
      expect(own, expected).toContain(expected);
    }
    // 不存在任何形如 payload / detail / cause / context 的字段：这类字段是原文泄漏的
    // 主要通道，一旦出现就必须由 §7.5 的脱敏评审重新裁定。
    for (const forbidden of [
      'payload',
      'detail',
      'details',
      'cause',
      'context',
      'raw',
      'body',
      'value',
      'input',
    ]) {
      expect(own, forbidden).not.toContain(forbidden);
    }
    // 序列化路径同样干净：传输层只会看到 envelope 的四个字段。
    expect(
      JSON.stringify({
        code: error.code,
        messageKey: error.messageKey,
        retryable: error.retryable,
      }),
    ).toBe('{"code":"RATE_LIMITED","messageKey":"request.rateLimited","retryable":true}');
  });
});

describe('异步错误登记表：附录 A §5.4', () => {
  it('六个 TaskKind 全部登记，不留半个', () => {
    expect(Object.keys(taskErrorRegistry).sort()).toEqual([...TASK_KINDS].sort());
    for (const kind of TASK_KINDS) {
      const stages = taskErrorRegistry[kind];
      expect(Object.keys(stages).length, kind).toBeGreaterThan(0);
    }
  });

  it('登记表的键都是合法 TaskStage', () => {
    for (const kind of TASK_KINDS) {
      for (const stage of Object.keys(taskErrorRegistry[kind])) {
        expect(TASK_STAGES).toContain(stage);
      }
    }
  });

  it('登记表里的每个码都存在于目录', () => {
    for (const kind of TASK_KINDS) {
      for (const [stage, codes] of Object.entries(taskErrorRegistry[kind])) {
        for (const code of codes ?? []) {
          expect(isErrorCode(code), `${kind}/${stage}/${code}`).toBe(true);
        }
      }
    }
  });

  it('assertTaskErrorRegistryComplete 对真实登记表不抛', () => {
    expect(() => assertTaskErrorRegistryComplete()).not.toThrow();
  });

  it('assertTaskErrorRegistryComplete 拒绝留空的 TaskKind', () => {
    // `Partial<Record<…>>` 允许空对象通过编译，那正好是「留了半个 TaskKind」的形态。
    const broken = { ...taskErrorRegistry, TTS: {} };
    expect(() => assertTaskErrorRegistryComplete(broken)).toThrow(/empty for kind: TTS/);
  });

  it('assertTaskErrorRegistryComplete 拒绝未知错误码', () => {
    const broken = {
      ...taskErrorRegistry,
      STT: { AUTH: ['NO_SUCH_CODE' as ErrorCode] },
    };
    expect(() => assertTaskErrorRegistryComplete(broken)).toThrow(/unknown error code/);
  });

  it('VIBE_TURN 覆盖完整链路（唯一会跑 Agent + 产物收集 + 构建 + 契约的类型）', () => {
    expect(taskErrorCodes('VIBE_TURN')).toEqual([
      'AGENT_FAILED',
      'ARTIFACT_INCOMPLETE',
      'ARTIFACT_MISSING',
      'BUILD_FAILED',
      'CONTENT_REJECTED',
      'DEPENDENCY_UNAVAILABLE',
      'INTERNAL_ERROR',
      'QCA_CREDENTIAL_INVALID',
      'QCA_CREDENTIAL_NOT_CONFIGURED',
      'QCA_QUOTA_EXHAUSTED',
      'QCA_UNREACHABLE',
      'TASK_TIMEOUT',
      'USER_CANCELLED',
      'WORK_CONTRACT_BLOCKED',
    ]);
  });

  it('PUBLISH / RESCAN 不跑 Agent，只作用于已提交的不可变版本', () => {
    const expected = [
      'BUILD_FAILED',
      'CONTENT_REJECTED',
      'DEPENDENCY_UNAVAILABLE',
      'INTERNAL_ERROR',
      'TASK_TIMEOUT',
      'USER_CANCELLED',
      'WORK_CONTRACT_BLOCKED',
    ];
    expect(taskErrorCodes('PUBLISH')).toEqual(expected);
    expect(taskErrorCodes('RESCAN')).toEqual(expected);
    for (const kind of ['PUBLISH', 'RESCAN'] as const) {
      for (const stage of ['AUTH', 'QUOTA', 'TRANSPORT', 'AGENT_RUN', 'COLLECT'] as const) {
        expect(taskErrorRegistry[kind][stage], `${kind}/${stage}`).toBeUndefined();
      }
    }
  });

  it('三种媒体类型共享同一套 Bailian 供应商错误形状', () => {
    const expected = [
      'BAILIAN_CREDENTIAL_INVALID',
      'BAILIAN_CREDENTIAL_NOT_CONFIGURED',
      'BAILIAN_QUOTA_EXHAUSTED',
      'BAILIAN_UNREACHABLE',
      'CONTENT_REJECTED',
      'DEPENDENCY_UNAVAILABLE',
      'INTERNAL_ERROR',
      'TASK_TIMEOUT',
      'USER_CANCELLED',
    ];
    expect(taskErrorCodes('BAILIAN_IMAGE')).toEqual(expected);
    expect(taskErrorCodes('TTS')).toEqual(expected);
    expect(taskErrorCodes('STT')).toEqual(expected);
    // QCA 的错误不得漏到媒体任务上，反之亦然。
    for (const kind of ['BAILIAN_IMAGE', 'TTS', 'STT'] as const) {
      for (const code of taskErrorCodes(kind)) {
        expect(code).not.toMatch(/^QCA_/);
      }
    }
  });

  it('GET /tasks/{id} 与 SSE 自身不产生异步错误：登记表挂在 (kind, stage) 上而不是 operation 上', () => {
    // 这条断言钉住 §5.4 的归属决定。两个读接口的 operation 级专属码为空（覆盖矩阵），
    // 但 task body 会承载全部异步分类 —— 把码挂在 operation 上会让「这个接口会返回
    // 502」变成假话。
    expect(registeredAsyncErrorCodes()).toEqual([
      'AGENT_FAILED',
      'ARTIFACT_INCOMPLETE',
      'ARTIFACT_MISSING',
      'BAILIAN_CREDENTIAL_INVALID',
      'BAILIAN_CREDENTIAL_NOT_CONFIGURED',
      'BAILIAN_QUOTA_EXHAUSTED',
      'BAILIAN_UNREACHABLE',
      'BUILD_FAILED',
      'CONTENT_REJECTED',
      'DEPENDENCY_UNAVAILABLE',
      'INTERNAL_ERROR',
      'QCA_CREDENTIAL_INVALID',
      'QCA_CREDENTIAL_NOT_CONFIGURED',
      'QCA_QUOTA_EXHAUSTED',
      'QCA_UNREACHABLE',
      'TASK_TIMEOUT',
      'USER_CANCELLED',
      'WORK_CONTRACT_BLOCKED',
    ]);
  });

  it('taskErrorCodes / registeredAsyncErrorCodes 去重且升序', () => {
    for (const kind of TASK_KINDS) {
      const codes = taskErrorCodes(kind);
      expect(new Set(codes).size, kind).toBe(codes.length);
      expect([...codes].sort()).toEqual(codes);
    }
    const all = registeredAsyncErrorCodes();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(all);
  });

  it('登记表是每类任务独立的实例，就地修改不会串到别的 kind', () => {
    // 六个 kind 复用同一个 `ErrorCode[]` 实例的话，任何一处就地 push 都会同时改掉
    // 其它 kind 的登记表。这里直接验证数组身份不同。
    const a = taskErrorRegistry['VIBE_TURN']['CONTENT'];
    const b = taskErrorRegistry['PUBLISH']['CONTENT'];
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('INTERNAL_ERROR 与 DEPENDENCY_UNAVAILABLE 出现是因为被显式登记，不是因为兜底', () => {
    for (const kind of TASK_KINDS) {
      expect(taskErrorRegistry[kind]['INTERNAL'], kind).toEqual(['INTERNAL_ERROR']);
      expect(taskErrorRegistry[kind]['DEPENDENCY'], kind).toEqual(['DEPENDENCY_UNAVAILABLE']);
    }
  });
});

describe('错误码目录与异步登记表的交叉一致性', () => {
  it('目录里没有孤儿：每个码要么被登记表引用，要么属于同步 operation 的共享/专属码', () => {
    // 附录 A §5.4 要求「所有非全局错误必须至少被一个 operation 或 (taskKind, stage)
    // 引用」。operation 侧的引用在 api-contract 的生成器里做**权威**双向校验（它能看
    // 到 28 个 operation 的完整清单），domain 侧只能校验登记表这一半 —— 因此这里断言
    // 的是「登记表的码全部合法」，而不是「目录里没有孤儿」。后者由 contract 门禁负责，
    // 在 domain 里重复实现一个更弱的检测器只会制造第二个可能不同步的事实源。
    for (const code of registeredAsyncErrorCodes()) {
      expect(isErrorCode(code), code).toBe(true);
    }
  });

  it('同步专属码不出现在异步登记表里', () => {
    // 这些码只在 HTTP 请求路径上有意义：登录、幂等键、CSRF、成员上限、修订冲突……
    // 一个已经在跑的 task 不会产生它们。让它们出现在 (kind, stage) 上就说明登记表抄错了。
    const syncOnly = [
      'REQUEST_INVALID',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
      'AUTHENTICATION_REQUIRED',
      'AUTHENTICATION_FAILED',
      'ACCOUNT_LOCKED',
      'CSRF_REJECTED',
      'FORBIDDEN_CAPABILITY',
      'RESOURCE_NOT_FOUND',
      'LOGIN_NAME_CONFLICT',
      'GROUP_ARCHIVED',
      'GROUP_MEMBER_LIMIT_REACHED',
      'REVISION_CONFLICT',
      'ACTIVE_WRITE_TASK_EXISTS',
      'TASK_NOT_CANCELLABLE',
      'TASK_NOT_RETRYABLE',
      'VERSION_NOT_RESTORABLE',
      'VERSION_NOT_PREVIEWABLE',
      'VERSION_NOT_PUBLISHABLE',
      'PUBLICATION_IN_PROGRESS',
      'SECRET_KIND_UNSUPPORTED',
      'SECRET_IMMUTABLE_REDEPLOY_REQUIRED',
      'USAGE_LIMIT_EXCEEDED',
      'RATE_LIMITED',
    ];
    const registered = new Set<string>(registeredAsyncErrorCodes());
    for (const code of syncOnly) {
      expect(isErrorCode(code), code).toBe(true);
      expect(registered.has(code), code).toBe(false);
    }
    // 反向：登记表里的码 + 同步专属码 + 两个不隐式挂载的码 = 目录全集，无遗漏无重复。
    const union = new Set<string>([
      ...registered,
      ...syncOnly,
      ...NEVER_IMPLICITLY_MOUNTED_ERROR_CODES,
    ]);
    expect([...union].sort()).toEqual([...ALL_CODES].sort());
  });
});

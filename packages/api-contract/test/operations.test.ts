/**
 * `operationRegistry` 与附录 A §5.4 接口表的**逐字对应**，以及 registry 自检断言的红绿对照。
 *
 * 这一层测的是「声明」本身，不测生成结果 —— 生成产物由 `test/openapi.test.ts` 与
 * `contracts/openapi/v1/openapi.json` 快照负责。分工的理由是失败定位：registry 抄错一个
 * 专属码，应该在这里红，而不是在一份 13 万字节的 JSON diff 里红。
 *
 * ## 为什么把 §5.4 表格再抄一遍（`SPEC_TABLE`）
 *
 * 因为「registry 与规格一致」这条断言需要一个**独立于 registry** 的期望值来源。从
 * registry 自己派生期望值（例如 `expect(codes).toEqual(operationErrorCodes(op))`）是
 * 零信息量的重言式：两侧同源，改错了也一起改，永远绿。`SPEC_TABLE` 是人工从 §5.4 表格
 * 逐行转录的字面量，因此它与 `operations.ts` 之间的任何漂移都会被抓到。
 *
 * 代价是它自己也可能抄错，所以先对 `SPEC_TABLE` 做一遍自洽检查（id 唯一、路由唯一、
 * 每个 id 都能在 registry 里找到）。这不是为了替代快照，而是为了让「两侧一致」这个
 * 零命中断言不至于空转（PM §4 验收门 4）。
 *
 * ## 刻意**不**做的事
 *
 * 不把 28 条 operation 的**完整推导结果**（共享码 ∪ 专属码）再抄一份成 28 行期望值。
 * 那会造成第三个 oracle：registry、SPEC_TABLE、推导结果表三份东西互相校验，而真正的
 * 权威只有 §5.4 与已提交快照。所以共享码的推导规则只挑**能区分规则分支**的少数几条
 * 定点断言（见「共享码推导」那组），全量对应交给 §4.4(5) 的覆盖率断言与快照本身。
 *
 * ## 平台无关性（PM G6）
 *
 * 期望值全部是文件内字面量，或由字面量确定性派生。不读时钟、环境变量、文件系统、
 * git，不用 `Intl`，不扫 `node_modules`。排序一律用码点比较（`<`/`>` 或 `Array#sort`
 * 对纯 ASCII 的默认行为），与 `openapi.ts` 里 `compareCodeNames` 拒绝 `localeCompare`
 * 的理由相同。
 */
import {
  DOMAIN_ERROR_CATALOG,
  NEVER_IMPLICITLY_MOUNTED_ERROR_CODES,
  registeredAsyncErrorCodes,
  type ErrorCode,
} from '@littleq/domain';
import { describe, expect, it } from 'vitest';

import {
  assertErrorCodeCoverage,
  assertOperationRegistryWellFormed,
  assertSuccessResponseInvariant,
  CONTRACT_TAGS,
  liveHealthSchema,
  operationById,
  operationErrorCodes,
  operationRegistry,
  RESPONSE_HEADER_NAMES,
  SECURITY_SCHEMES,
  sharedErrorCodes,
  type HttpMethod,
  type OperationContract,
  type SuccessResponse,
} from '../src/index.js';

/** §5.4 表格的一行：方法、路径、operationId、右栏专属码（顺序即表格顺序）。 */
interface SpecRow {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly exclusive: readonly ErrorCode[];
}

/**
 * 附录 A §5.4 接口表的逐字转录，**顺序即表格顺序**。
 *
 * 「共享码」一栏刻意不在这里：§5.4 规定它由 method / security / path 推导，抄进来就
 * 等于把推导结果钉成常量，将来改推导规则时会同时红两处，而其中一处是假的。
 */
const SPEC_TABLE = [
  {
    method: 'post',
    path: '/auth/login',
    operationId: 'login',
    exclusive: ['AUTHENTICATION_FAILED', 'ACCOUNT_LOCKED', 'RATE_LIMITED'],
  },
  { method: 'post', path: '/auth/logout', operationId: 'logout', exclusive: [] },
  { method: 'get', path: '/groups', operationId: 'listGroups', exclusive: [] },
  {
    method: 'post',
    path: '/groups',
    operationId: 'createGroup',
    exclusive: ['FORBIDDEN_CAPABILITY'],
  },
  {
    method: 'post',
    path: '/groups/{id}/students:batch',
    operationId: 'batchCreateStudents',
    exclusive: [
      'FORBIDDEN_CAPABILITY',
      'GROUP_ARCHIVED',
      'LOGIN_NAME_CONFLICT',
      'GROUP_MEMBER_LIMIT_REACHED',
    ],
  },
  { method: 'get', path: '/projects', operationId: 'listProjects', exclusive: [] },
  {
    method: 'post',
    path: '/projects',
    operationId: 'createProject',
    exclusive: ['FORBIDDEN_CAPABILITY'],
  },
  { method: 'get', path: '/projects/{id}', operationId: 'getProject', exclusive: [] },
  {
    method: 'post',
    path: '/projects/{id}/turns',
    operationId: 'createTurn',
    exclusive: [
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
      'ACTIVE_WRITE_TASK_EXISTS',
      'USAGE_LIMIT_EXCEEDED',
      'QCA_CREDENTIAL_NOT_CONFIGURED',
    ],
  },
  { method: 'get', path: '/tasks/{id}', operationId: 'getTask', exclusive: [] },
  { method: 'get', path: '/tasks/{id}/events', operationId: 'streamTaskEvents', exclusive: [] },
  {
    method: 'post',
    path: '/tasks/{id}:cancel',
    operationId: 'cancelTask',
    exclusive: ['TASK_NOT_CANCELLABLE'],
  },
  {
    method: 'post',
    path: '/tasks/{id}:retry',
    operationId: 'retryTask',
    exclusive: ['TASK_NOT_RETRYABLE', 'ACTIVE_WRITE_TASK_EXISTS', 'USAGE_LIMIT_EXCEEDED'],
  },
  {
    method: 'get',
    path: '/projects/{id}/versions',
    operationId: 'listProjectVersions',
    exclusive: [],
  },
  {
    method: 'post',
    path: '/projects/{id}/versions/{v}:restore',
    operationId: 'restoreProjectVersion',
    exclusive: ['VERSION_NOT_RESTORABLE', 'ACTIVE_WRITE_TASK_EXISTS', 'REVISION_CONFLICT'],
  },
  {
    method: 'post',
    path: '/projects/{id}/preview',
    operationId: 'createPreview',
    exclusive: ['VERSION_NOT_PREVIEWABLE'],
  },
  {
    method: 'post',
    path: '/projects/{id}/publish',
    operationId: 'publishProject',
    exclusive: [
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
      'VERSION_NOT_PUBLISHABLE',
      'PUBLICATION_IN_PROGRESS',
      'WORK_CONTRACT_BLOCKED',
      'CONTENT_REJECTED',
    ],
  },
  { method: 'get', path: '/works/{id}', operationId: 'getWork', exclusive: [] },
  {
    method: 'patch',
    path: '/works/{id}',
    operationId: 'updateWork',
    exclusive: ['REVISION_CONFLICT', 'FORBIDDEN_CAPABILITY'],
  },
  {
    method: 'get',
    path: '/public/works/{slug}',
    operationId: 'getPublicWork',
    exclusive: ['RESOURCE_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/settings/secrets/{kind}',
    operationId: 'getSecretMetadata',
    exclusive: ['FORBIDDEN_CAPABILITY', 'SECRET_KIND_UNSUPPORTED'],
  },
  {
    method: 'put',
    path: '/settings/secrets/{kind}',
    operationId: 'putSecret',
    exclusive: [
      'FORBIDDEN_CAPABILITY',
      'SECRET_KIND_UNSUPPORTED',
      'SECRET_IMMUTABLE_REDEPLOY_REQUIRED',
    ],
  },
  {
    method: 'get',
    path: '/usage/limits',
    operationId: 'getUsageLimits',
    exclusive: ['FORBIDDEN_CAPABILITY'],
  },
  {
    method: 'put',
    path: '/usage/limits',
    operationId: 'putUsageLimit',
    exclusive: ['FORBIDDEN_CAPABILITY', 'REVISION_CONFLICT'],
  },
  {
    method: 'get',
    path: '/usage/ledger',
    operationId: 'getUsageLedger',
    exclusive: ['FORBIDDEN_CAPABILITY'],
  },
  { method: 'get', path: '/license', operationId: 'getLicense', exclusive: [] },
  { method: 'get', path: '/health/live', operationId: 'getLiveHealth', exclusive: [] },
  {
    method: 'get',
    path: '/health/ready',
    operationId: 'getReadyHealth',
    exclusive: ['DEPENDENCY_UNAVAILABLE'],
  },
] as const satisfies readonly SpecRow[];

/** §5.4「除 login/public/license/health 外」——恰好这五条是显式匿名。 */
const ANONYMOUS_OPERATION_IDS = [
  'getLicense',
  'getLiveHealth',
  'getPublicWork',
  'getReadyHealth',
  'login',
] as const;

/**
 * `operationById` 是 `Record<string, …>`，在 `noUncheckedIndexedAccess` 下取值是
 * `T | undefined`。这个 helper 把「测试自己写错了 id」变成一条明确的失败，而不是让
 * 后面的断言在 `undefined` 上空转。
 */
function mustOperation(operationId: string): OperationContract {
  const operation = operationById[operationId];
  if (!operation) throw new Error(`测试夹具错误：registry 里没有 operationId=${operationId}`);
  return operation;
}

/** 复制一条 operation 并覆盖若干字段，用于构造**只差一处**的变异体。 */
function mutate(operationId: string, patch: Partial<OperationContract>): OperationContract {
  return { ...mustOperation(operationId), ...patch };
}

/** 一个必然违反不变量的成功响应：`mediaType` 为 null 而 `schema` 不是。 */
const HALF_CONTENT_SUCCESS: SuccessResponse = {
  status: 204,
  description: '半截 content 条目：非法 OpenAPI，但生成器会静默产出。',
  mediaType: null,
  headers: [],
  schema: liveHealthSchema,
};

/** 收集一个 operation 全部成功响应里声明的响应头名。 */
function declaredHeaders(operation: OperationContract): readonly string[] {
  return operation.success.flatMap((success) => success.headers);
}

describe('SPEC_TABLE 自身是自洽的（否则下面的「两侧一致」会空转）', () => {
  it('operationId 互不重复', () => {
    const ids = SPEC_TABLE.map((row) => row.operationId);
    expect(new Set(ids).size, 'SPEC_TABLE 里有重复的 operationId').toBe(ids.length);
  });

  it('(method, path) 互不重复', () => {
    const routes = SPEC_TABLE.map((row) => `${row.method} ${row.path}`);
    expect(new Set(routes).size, 'SPEC_TABLE 里有重复的路由').toBe(routes.length);
  });

  it('每个 operationId 都能在 registry 里找到', () => {
    const missing = SPEC_TABLE.map((row) => row.operationId).filter(
      (operationId) => operationById[operationId] === undefined,
    );
    expect(missing, 'SPEC_TABLE 抄了一个 registry 里不存在的 operationId').toEqual([]);
  });

  it('专属码全部是 domain 目录里的合法码', () => {
    const known = new Set<string>(DOMAIN_ERROR_CATALOG.map((entry) => entry.code));
    const unknown = SPEC_TABLE.flatMap((row) => row.exclusive.filter((code) => !known.has(code)));
    expect(unknown, 'SPEC_TABLE 里有拼错的错误码').toEqual([]);
  });
});

describe('registry 与 §5.4 接口表逐字对应', () => {
  it('条目数一致，且 (method, path, operationId) 三元组按表格顺序逐项相等', () => {
    expect(operationRegistry.length).toBe(SPEC_TABLE.length);
    // 一条断言同时钉住三件事：顺序、路由拼写、operationId。任何一处漂移都会在这里红，
    // 而不是等到快照 diff 里以「某个 pointer 变了」的形式间接暴露。
    expect(
      operationRegistry.map((operation) => [
        operation.method,
        operation.path,
        operation.operationId,
      ]),
    ).toEqual(SPEC_TABLE.map((row) => [row.method, row.path, row.operationId]));
  });

  it.each(SPEC_TABLE.map((row) => [row.operationId, row] as const))(
    '%s 的专属码逐字等于 §5.4 表格右栏（含顺序）',
    (operationId, row) => {
      expect(mustOperation(operationId).exclusiveErrorCodes).toEqual([...row.exclusive]);
    },
  );
});

describe('§5.5 security：带会话的写接口才要 CSRF，且与会话 cookie 同对象', () => {
  it('显式匿名的恰好是 login / getPublicWork / getLicense / 两条 health', () => {
    const anonymous = operationRegistry
      .filter((operation) => operation.security.length === 0)
      .map((operation) => operation.operationId)
      .sort();
    expect(anonymous).toEqual([...ANONYMOUS_OPERATION_IDS].sort());
  });

  it('每条 operation 都**显式**声明了 security（空数组也算声明，缺省不算）', () => {
    // §5.5：空数组不等于「未声明」。未声明会继承文档顶层 security，而文档不设顶层
    // security，所以匿名的五条必须逐条写 []。这条断言与 openapi.test.ts 里
    // 「文档没有顶层 security」那条是一对：少任何一边，匿名接口都会静默变成需要登录。
    const undeclared = operationRegistry
      .filter((operation) => !Array.isArray(operation.security))
      .map((operation) => operation.operationId);
    expect(undeclared).toEqual([]);
  });

  it.each(operationRegistry.map((operation) => [operation.operationId, operation] as const))(
    '%s：带会话的写接口必须在**同一个** Security Requirement Object 里带 CookieAuth + CsrfHeader',
    (operationId, operation) => {
      const hasCookie = operation.security.some((requirement) => 'CookieAuth' in requirement);
      const hasCsrf = operation.security.some((requirement) => 'CsrfHeader' in requirement);
      if (!hasCookie) {
        // 没有会话 cookie 的五条就是上面钉死的匿名集合。其中只有 login 是写方法，
        // 它是唯一「写接口却不带 CSRF」的合法例外：此时还没有会话可保护。
        // 「非 GET ⇒ 必须 CSRF」是**错**的规则（会把 login 判红），但反过来
        // 「不带 CSRF 的写接口只能是 login」仍然有牙：多一条就得先改匿名集合那条断言。
        expect((ANONYMOUS_OPERATION_IDS as readonly string[]).includes(operationId)).toBe(true);
        expect(hasCsrf, `${operationId} 没有会话，不该要求 CSRF 头`).toBe(false);
        if (operation.method !== 'get') expect(operationId).toBe('login');
        return;
      }
      if (operation.method === 'get') {
        expect(hasCsrf, `${operationId} 是 GET，不该要求 CSRF 头`).toBe(false);
        return;
      }
      expect(hasCsrf, `${operationId} 是带会话的写接口，必须要求 CSRF 头`).toBe(true);
      const together = operation.security.some(
        (requirement) => 'CsrfHeader' in requirement && 'CookieAuth' in requirement,
      );
      // 拆成 [{CookieAuth},{CsrfHeader}] 是 OR：CSRF 头是攻击者自己能提供的，
      // 等于把防护整体拆掉。两种写法都是合法 OpenAPI，所以只能由断言拦。
      expect(together, `${operationId} 把 CSRF 拆成了独立的 OR 分支`).toBe(true);
    },
  );

  it('security 里出现的每个 scheme 名都在文档级 securitySchemes 里声明过', () => {
    const declared = Object.keys(SECURITY_SCHEMES);
    const used = new Set<string>();
    for (const operation of operationRegistry) {
      for (const requirement of operation.security) {
        for (const scheme of Object.keys(requirement)) used.add(scheme);
      }
    }
    const undeclared = [...used].filter((scheme) => !declared.includes(scheme)).sort();
    expect(undeclared).toEqual([]);
  });
});

describe('tags 与 success 的结构不变量（PM G5(1)）', () => {
  it('每条 operation 至少一个 tag，且都在 CONTRACT_TAGS 里声明过', () => {
    const declared = CONTRACT_TAGS.map((tag) => tag.name);
    const problems: string[] = [];
    for (const operation of operationRegistry) {
      if (operation.tags.length === 0) problems.push(`${operation.operationId}: 没有 tag`);
      for (const tag of operation.tags) {
        if (!declared.includes(tag)) problems.push(`${operation.operationId}: 未声明的 tag ${tag}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('每条 operation 至少一个成功响应，且 mediaType/schema 同为 null 或同时存在', () => {
    const problems: string[] = [];
    for (const operation of operationRegistry) {
      if (operation.success.length === 0) problems.push(`${operation.operationId}: success 为空`);
      for (const success of operation.success) {
        if ((success.mediaType === null) !== (success.schema === null)) {
          problems.push(`${operation.operationId}/${success.status}: mediaType 与 schema 不同步`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('§5.5 点名的响应头词汇表完整，且能落在成功响应上的三个都真的被用到（PM G5(1)）', () => {
    // G5(1) 要求的是**词汇表覆盖**，不是「每个 201/202 都带 Location」——后者是错的：
    // retryTask 是同一 task 的新 attempt（没有新资源可指），cancelTask 返回完整 Task，
    // batchCreateStudents 返回逐项结果，三者都不该有 Location（下面那条例外清单钉住）。
    expect([...RESPONSE_HEADER_NAMES].sort()).toEqual(
      ['Content-Disposition', 'ETag', 'Location', 'Retry-After', 'Set-Cookie'].sort(),
    );
    // `Retry-After` 只挂在**错误**响应上（429/503），成功响应带它是语义错误，
    // 所以不在这里比；它的实际挂载由 openapi.test.ts 的「429/503 ⇔ Retry-After」证明。
    // `Content-Disposition` 同理只属于 ledger 的 CSV 分支，由 openapi.test.ts 按产物断言。
    const used = new Set(operationRegistry.flatMap((operation) => declaredHeaders(operation)));
    const unused = ['Location', 'ETag', 'Set-Cookie'].filter((name) => !used.has(name));
    expect(unused).toEqual([]);
  });

  it('不带 Location 的 201/202 恰好是三条有理由的例外', () => {
    const withoutLocation = operationRegistry.flatMap((operation) =>
      operation.success
        .filter((success) => success.status === 201 || success.status === 202)
        .filter((success) => !success.headers.includes('Location'))
        .map((success) => `${operation.operationId}/${success.status}`),
    );
    // 期望值是**语义**清单（每条在 registry 的 description 里写了理由），不是扫描出来的计数。
    expect(withoutLocation.sort()).toEqual(
      ['batchCreateStudents/201', 'cancelTask/202', 'retryTask/202'].sort(),
    );
  });

  it('每个 304 都声明了 ETag（RFC 9110 要求 304 带上 200 会给的 ETag）', () => {
    const missing = operationRegistry.flatMap((operation) =>
      operation.success
        .filter((success) => success.status === 304)
        .filter((success) => !success.headers.includes('ETag'))
        .map((success) => `${operation.operationId}/${success.status}`),
    );
    expect(missing).toEqual([]);
  });

  it('Set-Cookie 只出现在 login 与 logout 上', () => {
    const users = operationRegistry
      .filter((operation) => declaredHeaders(operation).includes('Set-Cookie'))
      .map((operation) => operation.operationId)
      .sort();
    expect(users).toEqual(['login', 'logout']);
  });

  it('声明的响应头名都在 RESPONSE_HEADER_NAMES 词汇表里（防止拼错后静默丢失）', () => {
    const problems: string[] = [];
    for (const operation of operationRegistry) {
      for (const success of operation.success) {
        for (const header of success.headers) {
          if (!(RESPONSE_HEADER_NAMES as readonly string[]).includes(header)) {
            problems.push(`${operation.operationId}/${success.status}: ${header}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('共享码推导（§5.4）：只定点断言能区分规则分支的几条', () => {
  it('logout 没有 REQUEST_INVALID —— 它没有任何输入可校验', () => {
    expect(sharedErrorCodes(mustOperation('logout'))).not.toContain('REQUEST_INVALID');
  });

  it('getLicense 与 getLiveHealth 的完整错误码集合是空的', () => {
    expect(operationErrorCodes(mustOperation('getLicense'))).toEqual([]);
    expect(operationErrorCodes(mustOperation('getLiveHealth'))).toEqual([]);
  });

  it('getReadyHealth 只有 DEPENDENCY_UNAVAILABLE（显式声明，不是推导出来的）', () => {
    expect(operationErrorCodes(mustOperation('getReadyHealth'))).toEqual([
      'DEPENDENCY_UNAVAILABLE',
    ]);
    expect(sharedErrorCodes(mustOperation('getReadyHealth'))).toEqual([]);
  });

  it('listGroups 恰好是两条共享码，没有专属码', () => {
    expect(operationErrorCodes(mustOperation('listGroups'))).toEqual([
      'AUTHENTICATION_REQUIRED',
      'REQUEST_INVALID',
    ]);
  });

  it('getPublicWork 的 RESOURCE_NOT_FOUND 来自专属码而非路径推导（路径参数是 {slug}）', () => {
    const operation = mustOperation('getPublicWork');
    expect(sharedErrorCodes(operation)).not.toContain('RESOURCE_NOT_FOUND');
    expect(operationErrorCodes(operation)).toContain('RESOURCE_NOT_FOUND');
  });

  it('putUsageLimit 有 CSRF_REJECTED 但没有 RESOURCE_NOT_FOUND（路径没有 {id}）', () => {
    const codes = operationErrorCodes(mustOperation('putUsageLimit'));
    expect(codes).toContain('CSRF_REJECTED');
    expect(codes).not.toContain('RESOURCE_NOT_FOUND');
  });

  it('cancelTask 四条共享码全在（对象型写接口的完整推导路径）', () => {
    expect(operationErrorCodes(mustOperation('cancelTask'))).toEqual([
      'AUTHENTICATION_REQUIRED',
      'CSRF_REJECTED',
      'REQUEST_INVALID',
      'RESOURCE_NOT_FOUND',
      'TASK_NOT_CANCELLABLE',
    ]);
  });

  it('NEVER_IMPLICITLY_MOUNTED 的两个码从不出现在推导结果里', () => {
    const implicit = operationRegistry.flatMap((operation) =>
      sharedErrorCodes(operation).filter((code) =>
        (NEVER_IMPLICITLY_MOUNTED_ERROR_CODES as readonly string[]).includes(code),
      ),
    );
    expect(implicit).toEqual([]);
  });

  it('DEPENDENCY_UNAVAILABLE 只在 getReadyHealth 上出现，且来自专属码', () => {
    const users = operationRegistry
      .filter((operation) => operationErrorCodes(operation).includes('DEPENDENCY_UNAVAILABLE'))
      .map((operation) => operation.operationId);
    expect(users).toEqual(['getReadyHealth']);
  });
});

describe('错误码集合的排序与覆盖率（§4.4(5)）', () => {
  it.each(operationRegistry.map((operation) => [operation.operationId, operation] as const))(
    '%s 的集合是去重 + 码点序',
    (operationId, operation) => {
      const codes = operationErrorCodes(operation);
      expect(new Set(codes).size, `${operationId} 的集合里有重复码`).toBe(codes.length);
      const sorted = [...codes].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      expect(codes).toEqual(sorted);
    },
  );

  it('目录里的每个码都被至少一个 operation 或 (taskKind, stage) 引用（无孤儿）', () => {
    const referenced = new Set<string>();
    for (const operation of operationRegistry) {
      for (const code of operationErrorCodes(operation)) referenced.add(code);
    }
    for (const code of registeredAsyncErrorCodes()) referenced.add(code);
    const orphaned = DOMAIN_ERROR_CATALOG.map((entry) => entry.code).filter(
      (code) => !referenced.has(code),
    );
    // 期望值来自 DOMAIN_ERROR_CATALOG 本身，不是写死的 42：目录增减时这条断言自动跟随。
    expect(orphaned).toEqual([]);
  });

  it('反向也成立：被引用的每个码都在目录里（无漏项、无拼错）', () => {
    const known = new Set<string>(DOMAIN_ERROR_CATALOG.map((entry) => entry.code));
    const referenced = new Set<string>();
    for (const operation of operationRegistry) {
      for (const code of operationErrorCodes(operation)) referenced.add(code);
    }
    for (const code of registeredAsyncErrorCodes()) referenced.add(code);
    const unknown = [...referenced].filter((code) => !known.has(code)).sort();
    expect(unknown).toEqual([]);
  });

  it('INTERNAL_ERROR 不被任何 operation 声明（它只属于异步 registry）', () => {
    const users = operationRegistry
      .filter((operation) => operationErrorCodes(operation).includes('INTERNAL_ERROR'))
      .map((operation) => operation.operationId);
    expect(users).toEqual([]);
  });
});

describe('registry 自检断言：正向绿 + 逐个变异红（PM §4 验收门 4）', () => {
  it('正向：真实 registry 通过 assertOperationRegistryWellFormed 与 assertErrorCodeCoverage', () => {
    expect(() => assertOperationRegistryWellFormed(operationRegistry)).not.toThrow();
    expect(() => assertErrorCodeCoverage(operationRegistry)).not.toThrow();
  });

  it('红：重复的 operationId', () => {
    const duplicated = [mustOperation('getLiveHealth'), mustOperation('getLiveHealth')];
    expect(() => assertOperationRegistryWellFormed(duplicated)).toThrow(
      /duplicate operationId: getLiveHealth/,
    );
  });

  it('红：CSRF 被拆成独立的 OR 分支', () => {
    const split = [mutate('logout', { security: [{ CookieAuth: [] }, { CsrfHeader: [] }] })];
    expect(() => assertOperationRegistryWellFormed(split)).toThrow(
      /CsrfHeader must share one Security Requirement Object with CookieAuth/,
    );
  });

  it('红：success 为空', () => {
    expect(() =>
      assertOperationRegistryWellFormed([mutate('getLiveHealth', { success: [] })]),
    ).toThrow(/at least one success response: getLiveHealth/);
  });

  it('红：未声明的 tag', () => {
    expect(() =>
      assertOperationRegistryWellFormed([mutate('getLiveHealth', { tags: ['not-a-tag'] })]),
    ).toThrow(/undeclared tag: getLiveHealth\/not-a-tag/);
  });

  it('红：非法的路径模板', () => {
    expect(() =>
      assertOperationRegistryWellFormed([mutate('getLiveHealth', { path: 'health/live' })]),
    ).toThrow(/path is not a valid OpenAPI template: getLiveHealth health\/live/);
  });

  it('红：重复的路由', () => {
    const clash = [
      mustOperation('getLiveHealth'),
      mutate('getLiveHealth', { operationId: 'getLiveHealthAgain' }),
    ];
    expect(() => assertOperationRegistryWellFormed(clash)).toThrow(
      /duplicate route: get \/health\/live \(getLiveHealthAgain\)/,
    );
  });

  it('红：未声明的 security scheme', () => {
    const bogus = [
      mutate('getLiveHealth', {
        security: [{ NotAScheme: [] }] as unknown as OperationContract['security'],
      }),
    ];
    expect(() => assertOperationRegistryWellFormed(bogus)).toThrow(
      /undeclared security scheme: getLiveHealth\/NotAScheme/,
    );
  });

  it('红：拼错的专属码（assertErrorCodeCoverage 与 registry 自检都要拦）', () => {
    const bogus = [
      mutate('getLiveHealth', {
        exclusiveErrorCodes: ['ACCOUNT_LOCKEDD'] as unknown as readonly ErrorCode[],
      }),
    ];
    expect(() => assertOperationRegistryWellFormed(bogus)).toThrow(
      /unknown exclusive error code: getLiveHealth\/ACCOUNT_LOCKEDD/,
    );
    expect(() => assertErrorCodeCoverage(bogus)).toThrow(
      /unknown error code in operation: getLiveHealth\/ACCOUNT_LOCKEDD/,
    );
  });

  it('红：目录里的码变成孤儿（把 login 的 ACCOUNT_LOCKED 拿掉）', () => {
    const orphaning = [
      mutate('login', {
        exclusiveErrorCodes: ['AUTHENTICATION_FAILED', 'RATE_LIMITED'],
      }),
      ...operationRegistry.filter((operation) => operation.operationId !== 'login'),
    ];
    // ACCOUNT_LOCKED 不在 taskErrorRegistry 里，所以拿掉唯一声明它的 operation 就成孤儿。
    expect(() => assertErrorCodeCoverage(orphaning)).toThrow(/never referenced: ACCOUNT_LOCKED/);
  });

  it('红：半截 content 条目（mediaType 为 null 而 schema 不是）', () => {
    expect(() => assertSuccessResponseInvariant('probe', HALF_CONTENT_SUCCESS)).toThrow(
      /mediaType and schema must both be null or both present: probe\/204/,
    );
    expect(() =>
      assertOperationRegistryWellFormed([
        mutate('getLiveHealth', { success: [HALF_CONTENT_SUCCESS] }),
      ]),
    ).toThrow(/both be null or both present: getLiveHealth\/204/);
  });

  it('对照：反过来（有 mediaType 没 schema）同样被拦，证明判据是双向的', () => {
    const otherHalf: SuccessResponse = {
      status: 200,
      description: '另一半：有 media type 没 schema。',
      mediaType: 'application/json',
      headers: [],
      schema: null,
    };
    expect(() => assertSuccessResponseInvariant('probe', otherHalf)).toThrow(
      /both be null or both present: probe\/200/,
    );
  });
});

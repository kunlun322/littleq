/**
 * **生成产物**层的断言：直接检查 `createOpenApiDocument()` 的输出字节，不信生成器的自述。
 *
 * 与 `test/operations.test.ts` 的分工：那份测「声明」（registry 与 §5.4 表格逐字对应），
 * 这份测「派生结果」。分开是因为二者的失败含义不同 —— registry 对了但产物错了，说明
 * 推导规则或 zod-openapi 的行为与预期不符，而那正是 PM G5(2) 点名的风险：
 *
 * > `x-littleq-error-codes` 能否透传，架构师没核验，PM 也没核验 ⇒ 必须有一条断言
 * > **直接检查生成产物**，不能只信生成器。
 *
 * 因此这里所有断言都走**同一份序列化后的 JSON**（`JSON.parse(JSON.stringify(doc))`），
 * 也就是被提交进 `contracts/openapi/v1/openapi.json` 的那份字节的前身。凡是从
 * `document.paths` 直接取对象属性的写法，都可能在库内部结构变化时静默读到 `undefined`
 * 而让 `expect(undefined).toBeUndefined()` 变绿 —— 序列化再解析能排除这一类空转。
 *
 * ## 每条零命中断言都带一个会红的对照（PM §4 验收门 4）
 *
 * 「产物里没有 `examples`」「没有顶层 security」「没有泄漏字段名」都是零命中断言，
 * 绿的时候什么都不打印，因此最容易被写成空转（例如遍历到一个空集合）。所以每组都配了
 * 一条**故意造红**的对照：合成一份带 `examples` / 带顶层 security / 带 `leaseOwner`
 * 属性的文档，断言相应的检测确实报告它。
 *
 * ## 平台无关性（PM G6）
 *
 * 期望值全部是文件内字面量或由 registry 确定性派生。不读时钟、环境变量、文件系统、
 * git，不用 `Intl`。§4.4(1) 的确定性断言连续生成两次并比较字节，两次都在同一进程内。
 */
import { DOMAIN_ERROR_CATALOG, isErrorCode, taskErrorRegistry } from '@littleq/domain';
import { describe, expect, it } from 'vitest';

import {
  API_MAJOR,
  assertNoLeakyFieldNames,
  CONTRACT_TAGS,
  CONTRACT_VERSION,
  createOpenApiDocument,
  errorCatalogDocument,
  ERROR_CODES_EXTENSION,
  groupErrorCodesByStatus,
  HTTP_METHODS,
  isLeakyFieldName,
  OPENAPI_SPEC_VERSION,
  operationErrorCodes,
  operationRegistry,
  SECURITY_SCHEMES,
  SERVER_URL,
  type HttpMethod,
  type OpenApiDocument,
} from '../src/index.js';

interface HeaderJson {
  readonly description?: string;
  readonly required?: boolean;
  readonly schema?: unknown;
}

interface ResponseJson {
  readonly description?: string;
  readonly headers?: Readonly<Record<string, HeaderJson>>;
  readonly content?: Readonly<Record<string, { readonly schema?: unknown }>>;
}

interface OperationJson {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly responses?: Readonly<Record<string, ResponseJson>>;
  readonly parameters?: readonly unknown[];
  readonly requestBody?: unknown;
  readonly [key: string]: unknown;
}

interface DocumentJson {
  readonly openapi?: string;
  readonly security?: unknown;
  readonly info?: {
    readonly title?: string;
    readonly version?: string;
    readonly license?: { readonly name?: string; readonly identifier?: string };
  };
  readonly servers?: readonly { readonly url?: string }[];
  readonly tags?: readonly { readonly name?: string }[];
  readonly paths?: Readonly<Record<string, Readonly<Record<string, OperationJson>>>>;
  readonly components?: {
    readonly securitySchemes?: Readonly<Record<string, unknown>>;
    readonly schemas?: Readonly<Record<string, unknown>>;
  };
}

/** 一份文档里的一个 operation，连同它的路径模板与方法。 */
interface LocatedOperation {
  readonly route: string;
  readonly path: string;
  readonly method: string;
  readonly operation: OperationJson;
}

/**
 * 生成一次并序列化成纯 JSON 视图。
 *
 * 每次调用都**重新生成**，不共享模块级常量：§4.4(1) 要求「同一源码连续生成两次
 * byte-identical」，共享一份缓存会让那条断言变成自己跟自己比。
 */
function generated(): { readonly json: DocumentJson; readonly text: string } {
  const text = JSON.stringify(createOpenApiDocument(), null, 2);
  return { json: JSON.parse(text) as DocumentJson, text };
}

function operationsOf(json: DocumentJson): readonly LocatedOperation[] {
  const located: LocatedOperation[] = [];
  for (const [path, item] of Object.entries(json.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
      located.push({ route: `${method.toUpperCase()} ${path}`, path, method, operation });
    }
  }
  // 排序让失败信息里的顺序稳定：Object.entries 的顺序取决于生成器的插入序，
  // 虽然确定，但把「报告顺序」交给它是没必要的一层耦合（PM G6）。
  return located.sort((left, right) =>
    left.route < right.route ? -1 : left.route > right.route ? 1 : 0,
  );
}

/** 成功状态码：2xx 与 304。其余都是错误响应。 */
function isSuccessStatus(status: string): boolean {
  const code = Number(status);
  return (code >= 200 && code < 300) || code === 304;
}

/** 读取 operation 上的 `x-littleq-error-codes`，不做任何宽容处理。 */
function errorCodesExtension(operation: OperationJson): unknown {
  return operation[ERROR_CODES_EXTENSION];
}

const RETRY_AFTER_STATUSES: readonly string[] = ['429', '503'];

describe('§4.4(1) 确定性：同一源码连续生成两次 byte-identical', () => {
  it('两次生成的序列化字节完全相同', () => {
    const first = generated();
    const second = generated();
    expect(second.text).toBe(first.text);
  });

  it('对照：这条断言不是「两次都比了同一个空串」', () => {
    const { text } = generated();
    // 产物里必须真的有内容，否则上面那条 toBe 会在两次都失败生成时照样绿。
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain('"openapi"');
    expect(text).toContain(ERROR_CODES_EXTENSION);
  });

  it('产物里没有 examples / 时间戳 / 绝对路径（§4.1、§5）', () => {
    const { text } = generated();
    expect(text).not.toContain('"examples"');
    expect(text).not.toContain('"example"');
    // 生成期不读时钟，所以产物里不该出现任何形似 ISO 时间戳的字面量。
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('产物里没有宿主绝对路径（§4.1、PM G6）', () => {
    // 标记是**字面量**，不是对本机的一次扫描（G6(2) 拒绝后者）：三大平台的绝对路径
    // 前缀各写死一个，任何机器上跑都是同一份期望值。
    expect(hostPathMarkers(generated().text)).toEqual([]);
  });

  it('对照：绝对路径探针确实能命中，不是永真', () => {
    expect(hostPathMarkers('{"x":"/Users/someone/repo/y.json"}')).toEqual(['/Users/']);
    expect(hostPathMarkers('{"x":"/home/ci/repo"}')).toEqual(['/home/']);
    expect(hostPathMarkers('{"x":"C:\\\\repo"}')).toEqual(['C:\\']);
  });
});

describe('文档级形状', () => {
  it('openapi / info / servers / tags 与常量逐字一致', () => {
    const { json } = generated();
    expect(json.openapi).toBe(OPENAPI_SPEC_VERSION);
    expect(json.info?.version).toBe(CONTRACT_VERSION);
    expect(json.info?.license).toEqual({ name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' });
    expect(json.servers).toEqual([{ url: SERVER_URL }]);
    expect(json.tags?.map((tag) => tag.name)).toEqual(CONTRACT_TAGS.map((tag) => tag.name));
  });

  it('文档**没有**顶层 security，而每条 operation 都显式带 security', () => {
    const { json } = generated();
    // §5.5：空数组不等于「未声明」，未声明会继承文档顶层。文档不设顶层 security，
    // 所以匿名的五条必须逐条写 []。这两半合起来才构成完整保证。
    expect(json.security, '文档出现了顶层 security').toBeUndefined();
    const missing = operationsOf(json)
      .filter(({ operation }) => !Array.isArray(operation.security))
      .map(({ route }) => route);
    expect(missing).toEqual([]);
  });

  it('components.securitySchemes 原样透传，CookieAuth 用 apiKey/in:cookie 表达', () => {
    const { json } = generated();
    expect(json.components?.securitySchemes).toEqual(JSON.parse(JSON.stringify(SECURITY_SCHEMES)));
    // OpenAPI 3.1 的 SecuritySchemeType 没有 'cookie'，会话 cookie 的唯一合法表达
    // 就是 apiKey + in:cookie + name。name 因此进入契约，改名是破坏性变更（§4.2）。
    const cookieAuth = json.components?.securitySchemes?.['CookieAuth'] as
      | { readonly type?: string; readonly in?: string; readonly name?: string }
      | undefined;
    expect(cookieAuth).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'littleq_session' });
  });

  it('paths 里的 operation 与 registry 一一对应：无孤儿、无漏项', () => {
    const { json } = generated();
    const located = operationsOf(json);
    expect(located.length).toBe(operationRegistry.length);
    const inDocument = located.map(({ operation }) => operation.operationId).sort();
    const inRegistry = operationRegistry.map((operation) => operation.operationId).sort();
    expect(inDocument).toEqual(inRegistry);
    // operationId 全局唯一（附录 A §3.2）。
    expect(new Set(inDocument).size).toBe(inDocument.length);
  });

  it('每条 operation 的 path/method/summary/tags 与 registry 声明一致', () => {
    const { json } = generated();
    const problems: string[] = [];
    for (const { path, method, operation } of operationsOf(json)) {
      const declared = operationRegistry.find(
        (entry) => entry.operationId === operation.operationId,
      );
      if (!declared) {
        problems.push(`${method} ${path}: 产物里有 registry 没有的 operationId`);
        continue;
      }
      if (declared.path !== path) problems.push(`${declared.operationId}: path 不一致`);
      if (declared.method !== method) problems.push(`${declared.operationId}: method 不一致`);
      if (declared.summary !== operation.summary) {
        problems.push(`${declared.operationId}: summary 不一致`);
      }
      if (JSON.stringify([...declared.tags]) !== JSON.stringify(operation.tags)) {
        problems.push(`${declared.operationId}: tags 不一致`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('PM G5(2)：x-littleq-error-codes 在**产物**里逐条存在且等于去重排序集合', () => {
  it('每个 operation 都带这个扩展，值是字符串数组', () => {
    const { json } = generated();
    const problems = operationsOf(json)
      .filter(({ operation }) => {
        const value = errorCodesExtension(operation);
        return !Array.isArray(value) || value.some((item) => typeof item !== 'string');
      })
      .map(({ route }) => route);
    expect(problems, '有 operation 没带 x-littleq-error-codes，或值不是字符串数组').toEqual([]);
  });

  it.each(operationRegistry.map((entry) => [entry.operationId, entry.operationId, entry] as const))(
    '%s：产物里的值 === registry 推导出的去重排序集合',
    (_id, operationId, declared) => {
      const { json } = generated();
      const located = operationsOf(json).find(
        ({ operation }) => operation.operationId === operationId,
      );
      expect(located, `产物里找不到 ${operationId}`).toBeDefined();
      expect(errorCodesExtension(located!.operation)).toEqual([...operationErrorCodes(declared)]);
    },
  );

  it('对照：扩展名拼错时这条检查会红（证明它不是在读一个恒存在的键）', () => {
    const { json } = generated();
    const located = operationsOf(json).find(({ operation }) => operation.operationId === 'login');
    expect(located?.operation['x-littleq-error-code']).toBeUndefined();
    expect(Array.isArray(errorCodesExtension(located!.operation))).toBe(true);
  });

  it('产物里出现的每个码都是 domain 目录里的合法码', () => {
    const { json } = generated();
    const unknown = operationsOf(json)
      .flatMap(({ operation }) => errorCodesExtension(operation) as readonly string[])
      .filter((code) => !isErrorCode(code as never));
    expect([...new Set(unknown)].sort()).toEqual([]);
  });
});

describe('错误响应与错误码集合的对应（§5.4）', () => {
  it.each(operationRegistry.map((entry) => [entry.operationId, entry.operationId, entry] as const))(
    '%s：错误状态码集合 === 按 status 分组的结果，且每组都是 ErrorEnvelope',
    (_id, operationId, declared) => {
      const { json } = generated();
      const located = operationsOf(json).find(
        ({ operation }) => operation.operationId === operationId,
      );
      const responses = located?.operation.responses ?? {};
      const actualErrorStatuses = Object.keys(responses)
        .filter((status) => !isSuccessStatus(status))
        .sort();
      const expected = groupErrorCodesByStatus(operationErrorCodes(declared)).map((group) =>
        String(group.status),
      );
      expect(actualErrorStatuses).toEqual(expected);

      const problems: string[] = [];
      for (const group of groupErrorCodesByStatus(operationErrorCodes(declared))) {
        const response = responses[String(group.status)];
        const schema = response?.content?.['application/json']?.schema as
          | { readonly $ref?: string }
          | undefined;
        if (schema?.$ref !== '#/components/schemas/ErrorEnvelope') {
          problems.push(`${operationId}/${group.status}: 不是 ErrorEnvelope`);
        }
        // 描述里逐个列出该 status 下的码，这样读文档的人不必反查扩展。
        for (const code of group.codes) {
          if (!String(response?.description ?? '').includes(code)) {
            problems.push(`${operationId}/${group.status}: 描述里没有 ${code}`);
          }
        }
      }
      expect(problems).toEqual([]);
    },
  );

  it('429 与 503 一律带 Retry-After，其余错误响应一律不带（PM G5(1)）', () => {
    const { json } = generated();
    const problems: string[] = [];
    for (const { route, operation } of operationsOf(json)) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (isSuccessStatus(status)) continue;
        const hasRetryAfter = Object.keys(response.headers ?? {}).includes('Retry-After');
        // RFC 6585 §4（429 必须）与 RFC 9110 §15.6.4（503 SHOULD）。这里按状态码挂，
        // 不逐个错误码列举：新增一个落在 429 的码时不会静默漏掉。
        if (RETRY_AFTER_STATUSES.includes(status) !== hasRetryAfter) {
          problems.push(`${route}/${status}: Retry-After 的有无与状态码不匹配`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('对照：把 429 的 Retry-After 摘掉，上面那条检查确实会红', () => {
    const { json } = generated();
    const target = operationsOf(json).find(
      ({ operation }) => operation.operationId === 'createTurn',
    );
    const headers = target?.operation.responses?.['429']?.headers;
    expect(headers, '前提不成立：createTurn 的 429 本来就没有 Retry-After').toBeDefined();
    const mutated: DocumentJson = JSON.parse(
      JSON.stringify({
        ...json,
        paths: {
          ...json.paths,
          [target!.path]: {
            ...json.paths?.[target!.path],
            [target!.method]: {
              ...target!.operation,
              responses: {
                ...target!.operation.responses,
                '429': { ...target!.operation.responses?.['429'], headers: {} },
              },
            },
          },
        },
      }),
    ) as DocumentJson;
    const problems = operationsOf(mutated).flatMap(({ route, operation }) =>
      Object.entries(operation.responses ?? {})
        .filter(([status, response]) => {
          if (isSuccessStatus(status)) return false;
          const has = Object.keys(response.headers ?? {}).includes('Retry-After');
          return RETRY_AFTER_STATUSES.includes(status) !== has;
        })
        .map(([status]) => `${route}/${status}`),
    );
    expect(problems).toContain('POST /projects/{id}/turns/429');
  });

  it('成功响应一个都不带 Retry-After（挂到 200 上是语义错误）', () => {
    const { json } = generated();
    const offenders = operationsOf(json).flatMap(({ route, operation }) =>
      Object.entries(operation.responses ?? {})
        .filter(([status, response]) =>
          isSuccessStatus(status)
            ? Object.keys(response.headers ?? {}).includes('Retry-After')
            : false,
        )
        .map(([status]) => `${route}/${status}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('PM G5(1)：registry 声明的响应头确实落到了产物里', () => {
  it('每个成功响应的 headers 键集合与 registry 声明逐项相等（已排序）', () => {
    const { json } = generated();
    const problems: string[] = [];
    for (const declared of operationRegistry) {
      const located = operationsOf(json).find(
        ({ operation }) => operation.operationId === declared.operationId,
      );
      // 同一 status 可以由多条 registry 记录声明（`getUsageLedger` 的 200 有 JSON 与 CSV
      // 两个 media type），而 OpenAPI 的 `headers` 挂在 Response Object 上、无法按 media
      // type 收窄，所以产物里只能有一份：期望值取这些记录的**并集**，而不是第一条。
      for (const status of new Set(declared.success.map((success) => success.status))) {
        const expected = [
          ...new Set(
            declared.success
              .filter((success) => success.status === status)
              .flatMap((success) => success.headers),
          ),
        ].sort();
        const response = located?.operation.responses?.[String(status)];
        const actual = Object.keys(response?.headers ?? {}).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          problems.push(
            `${declared.operationId}/${status}: 产物 ${JSON.stringify(actual)} ≠ 声明 ${JSON.stringify(expected)}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('Content-Disposition 是文档里唯一 required:false 的响应头', () => {
    const { json } = generated();
    const optional: string[] = [];
    for (const { route, operation } of operationsOf(json)) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const [name, header] of Object.entries(response.headers ?? {})) {
          if (header.required === false) optional.push(`${route}/${status}/${name}`);
        }
      }
    }
    expect(optional).toEqual(['GET /usage/ledger/200/Content-Disposition']);
  });

  it('Set-Cookie 出现在 login 与 logout 的 204 上，且不含任何示例值', () => {
    const { json } = generated();
    const carriers = operationsOf(json)
      .filter(({ operation }) =>
        Object.values(operation.responses ?? {}).some((response) =>
          Object.keys(response.headers ?? {}).includes('Set-Cookie'),
        ),
      )
      .map(({ operation }) => operation.operationId)
      .sort();
    expect(carriers).toEqual(['login', 'logout']);
    // §5：一个 Set-Cookie 的示例就是一份会话凭证模板。
    for (const { operation } of operationsOf(json)) {
      for (const response of Object.values(operation.responses ?? {})) {
        for (const header of Object.values(response.headers ?? {})) {
          expect(Object.keys(header).sort()).toEqual(['description', 'required', 'schema']);
          expect(header.schema).toBeDefined();
        }
      }
    }
  });
});

describe('错误目录快照（errorCatalogDocument）', () => {
  it('apiMajor 来自入参，codes 按码名排序，字段集合恰好五项', () => {
    const catalog = errorCatalogDocument(API_MAJOR);
    expect(catalog.apiMajor).toBe(API_MAJOR);
    const names = catalog.codes.map((entry) => entry.code);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const entry of catalog.codes) {
      expect(Object.keys(entry).sort()).toEqual([
        'code',
        'httpStatus',
        'messageKey',
        'retryable',
        'sameRequestRetrySafety',
      ]);
    }
  });

  it('目录内容与 domain 一一对应：无增无减，四项事实逐项相等', () => {
    const catalog = errorCatalogDocument(API_MAJOR);
    const expected = expectedCatalogCodes();
    // 条数相等只是入口断言；真正有意义的是下面的逐项比较。条数从 domain 派生，
    // 不是从契约侧自己的产物算出来的（那会同义反复），也不写死 42。
    expect(catalog.codes.length).toBe(expected.length);
    expect(new Set(catalog.codes.map((entry) => entry.code)).size).toBe(catalog.codes.length);
    for (const [index, definition] of expected.entries()) {
      const entry = catalog.codes[index];
      if (!entry) throw new Error(`目录缺少第 ${index} 项 ${definition.code}`);
      expect(entry.code).toBe(definition.code);
      expect(entry.httpStatus).toBe(definition.httpStatus);
      expect(entry.messageKey).toBe(definition.messageKey);
      expect(entry.retryable).toBe(definition.retryable);
      expect(entry.sameRequestRetrySafety).toBe(definition.sameRequestRetrySafety);
    }
  });

  it('taskErrorRegistry 的两层 key 都是排序过的，数组保持 domain 声明顺序', () => {
    const catalog = errorCatalogDocument(API_MAJOR);
    const kinds = Object.keys(catalog.taskErrorRegistry);
    expect(kinds).toEqual([...kinds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(kinds).toEqual(
      Object.keys(taskErrorRegistry).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    for (const kind of kinds) {
      const stages = Object.keys(catalog.taskErrorRegistry[kind] ?? {});
      expect(stages, `${kind} 的 stage key 没排序`).toEqual(
        [...stages].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
  });

  it('不含 neverImplicitlyMounted 这个键（它是推导规则，不是快照事实）', () => {
    const catalog = errorCatalogDocument(API_MAJOR) as unknown as Record<string, unknown>;
    expect(Object.keys(catalog).sort()).toEqual(['apiMajor', 'codes', 'taskErrorRegistry']);
  });

  it('对照：把 apiMajor 改成 2，产物会如实反映（这条断言不是恒真）', () => {
    expect(errorCatalogDocument(2).apiMajor).toBe(2);
    expect(errorCatalogDocument(API_MAJOR).apiMajor).not.toBe(2);
  });
});

describe('泄漏字段名自检（§5、§7.3(10)）', () => {
  it('真实产物通过 assertNoLeakyFieldNames', () => {
    expect(() => assertNoLeakyFieldNames(createOpenApiDocument())).not.toThrow();
  });

  it('内部实现细节被拦下，规格要求的合法字段不被误伤', () => {
    for (const leaky of [
      'leaseOwner',
      'leaseUntil',
      'qcaSessionId',
      'qcaEventCursor',
      'externalOperationKey',
      'providerRequestId',
      'errorDigest',
      'accessToken',
      'refreshToken',
      'sessionToken',
      'csrfToken',
      'urlSignature',
    ]) {
      expect(isLeakyFieldName(leaky), `${leaky} 应该被判为泄漏`).toBe(true);
    }
    // 这几个是规格里明确存在的合法字段。子串匹配会把它们一起打死，所以精确匹配 ——
    // 这半边断言存在的意义是防止有人为了让上面那半边更容易过而把规则放宽成子串。
    for (const legal of ['provider', 'prompt', 'password', 'initialPassword', 'value', 'commit']) {
      expect(isLeakyFieldName(legal), `${legal} 是合法字段，不该被判为泄漏`).toBe(false);
    }
  });

  it('红：合成一份带 leaseOwner 属性的文档，自检必须报出来', () => {
    const base = createOpenApiDocument();
    const leaky = {
      ...base,
      components: {
        ...(base.components ?? {}),
        schemas: {
          ...(base.components?.schemas ?? {}),
          Probe: { type: 'object', properties: { leaseOwner: { type: 'string' } } },
        },
      },
    } as unknown as OpenApiDocument;
    expect(() => assertNoLeakyFieldNames(leaky)).toThrow(
      /leaky field names reached the wire contract: .*leaseOwner/,
    );
  });

  it('对照：同一份合成文档只把属性名换成合法名字，就不该报', () => {
    const base = createOpenApiDocument();
    const benign = {
      ...base,
      components: {
        ...(base.components ?? {}),
        schemas: {
          ...(base.components?.schemas ?? {}),
          Probe: { type: 'object', properties: { ownerDisplayName: { type: 'string' } } },
        },
      },
    } as unknown as OpenApiDocument;
    expect(() => assertNoLeakyFieldNames(benign)).not.toThrow();
  });
});

describe('产物里没有凭证、签名 URL 或 provider 原始错误（§5）', () => {
  it('不含任何形似签名 URL 或 Bearer 头的字面量', () => {
    const { text } = generated();
    expect(text).not.toMatch(/https?:\/\/[^"]*[?&](?:sig|signature|token|X-Goob-Signature)=/i);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
    // 预览地址只声明形状（不超过 512 字符的串），不含示例值。
    const preview = operationsOf(JSON.parse(text) as DocumentJson).find(
      ({ operation }) => operation.operationId === 'createPreview',
    );
    const previewSchema = preview?.operation.responses?.['200']?.content?.['application/json']
      ?.schema as { readonly $ref?: string } | undefined;
    expect(previewSchema?.$ref).toBe('#/components/schemas/CreatePreviewResponse');
  });

  it('对照：把一段签名 URL 塞进描述，上面那条正则确实会命中', () => {
    const probe = 'see https://cdn.example/x?signature=abc for details';
    expect(probe).toMatch(/https?:\/\/[^"]*[?&](?:sig|signature|token|X-Goob-Signature)=/i);
  });
});

describe('请求面与响应面的 media type', () => {
  it('ledger 的 200 同时有 JSON 与 CSV 两个 content 条目', () => {
    const { json } = generated();
    const ledger = operationsOf(json).find(
      ({ operation }) => operation.operationId === 'getUsageLedger',
    );
    expect(Object.keys(ledger?.operation.responses?.['200']?.content ?? {}).sort()).toEqual([
      'application/json',
      'text/csv; charset=utf-8',
    ]);
  });

  it('SSE 事件流的 media type 是 text/event-stream', () => {
    const { json } = generated();
    const stream = operationsOf(json).find(
      ({ operation }) => operation.operationId === 'streamTaskEvents',
    );
    expect(Object.keys(stream?.operation.responses?.['200']?.content ?? {})).toEqual([
      'text/event-stream',
    ]);
  });

  it('只有字段全 optional 的三个 body 是 required:false，其余写接口都是 true', () => {
    const { json } = generated();
    const optionalBody = new Set(['createPreview', 'restoreProjectVersion', 'retryTask']);
    const problems: string[] = [];
    for (const { operation } of operationsOf(json)) {
      const body = operation.requestBody as { readonly required?: boolean } | undefined;
      if (!body) continue;
      const expected = !optionalBody.has(String(operation.operationId));
      if (body.required !== expected) {
        problems.push(`${String(operation.operationId)}: required=${String(body.required)}`);
      }
    }
    // updateWork 的 body 必须为 true（语义是「至少改一项」），它落在 expected=true 那一侧，
    // 所以这条断言同时钉住了「不要把 required 一律写成 false」这个方向。
    expect(problems).toEqual([]);
  });
});

describe('方法词汇表', () => {
  it('产物里出现的方法都在 HTTP_METHODS 里，且 registry 用到的方法都被覆盖', () => {
    const { json } = generated();
    const used = new Set(operationsOf(json).map(({ method }) => method));
    for (const method of used) {
      expect((HTTP_METHODS as readonly string[]).includes(method)).toBe(true);
    }
    const declared = new Set(operationRegistry.map((operation) => operation.method));
    expect([...declared].sort()).toEqual([...used].sort());
  });

  it('registry 里的 method 类型是 HttpMethod 的子集（编译期已由 satisfies 保证，这里做一次运行期复核）', () => {
    const invalid = operationRegistry
      .filter((operation) => !(HTTP_METHODS as readonly string[]).includes(operation.method))
      .map((operation) => operation.method as string);
    expect(invalid).toEqual([]);
    expect(HTTP_METHODS).toContain('patch' satisfies HttpMethod);
  });
});

/**
 * domain 错误目录 → 契约错误目录的**独立期望值**。
 *
 * 契约侧的 `errorCatalogDocument()` 只是把 domain 的目录换个顺序序列化一遍，所以「条数
 * 相等」这种断言用契约侧自己的产物算期望值就是同义反复（它永远绿，包括在 domain 目录
 * 被写坏的时候）。这里改成从 `DOMAIN_ERROR_CATALOG` 出发，逐项比较五项事实，
 * 两侧才真正是两个来源。顺序按码名的码位序，与生成器的排序规则一致（§4.1）。
 */
function expectedCatalogCodes(): readonly (typeof DOMAIN_ERROR_CATALOG)[number][] {
  return [...DOMAIN_ERROR_CATALOG].sort((a, b) => compareCodeNames(a.code, b.code));
}

function compareCodeNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 宿主绝对路径的前缀标记。字面量，不读本机（PM G6(2)）。 */
function hostPathMarkers(text: string): readonly string[] {
  return ['/Users/', '/home/', 'C:\\'].filter((marker) => text.includes(marker));
}

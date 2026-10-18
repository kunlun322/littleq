#!/usr/bin/env node
// 契约门禁对照用例 `contract:control`（附录 A §4.2 C 全 7 条 + PM §4.4 / §4.5）。
//
// ## 这个门禁在证明什么
//
// `contract:compat` 是一道**只会绿或者只会红都同样没用**的门禁：
//   - 如果比较器「永远红」，开发者会学会加 allowlist 绕过，门禁形同虚设；
//   - 如果比较器「永远绿」，真正的破坏性变更会安静地合进 main。
// 所以本命令的唯一职责是**把比较器自己放到被测位置上**：拿仓库里已提交的快照当基线，
// 对它施加**恰好一处**已知方向的变异，然后断言比较器给出的方向和 §4.2 B 的方差表一致。
// 一红一绿成对出现（PM §4.4 第 4 条）—— 只给绿等于没给。
//
// ## §4.2 C 逐条落地
//
//   开头「必须调用生产使用的同一个 compatibility 入口，不得复制判断逻辑」
//     → **每一条**用例都走 `runCompat()`，也就是 CLI `contract:compat` 调的那一个函数；
//       退出码映射共用同一份 `compatExitCode()`。本文件里没有任何一条方差规则的实现，
//       连 `compareOpenApi` / `compareContracts` 都不直接调用。
//   第 1 条「从固定 fixture 基线复制到临时目录」
//     → 基线是仓库里已提交的 `contracts/{openapi,errors}/v1/*.json`（G6 第 2 条要求
//       fixture 基线必须是仓库内提交的文件，不许来自对本机扫描）。每个用例把它复制进
//       `mkdtemp` 出来的临时目录再变异，跑完删除；基线本身永不被写。
//   第 2 条「删除 POST /projects/{id}/turns → exit 1 + OPENAPI_BREAKING_OPERATION_REMOVED」
//     → 用例 `operation-removed`。
//   第 3 条「新增 optional response 字段 → exit 0」
//     → 用例 `response-field-optional-added`（防止比较器永远红）。
//   第 4 条「请求收窄/放宽、响应扩大/收窄、security OR/AND 各跑正反 fixture」
//     → `request-*` / `response-*` / `security-*` 三组，每条规则都成对。
//   第 5 条「base 缺失 → exit 2 + CONTRACT_BASE_UNAVAILABLE；再用合法 bootstrap fixture
//          证明只允许首次基线」
//     → `base-*` 与 `bootstrap-*` 两组，走 `createFixtureTransport`（仓库内目录树当
//       git 对象库用），一个 git 进程都不起。
//   第 6 条「fixture 完全来自仓库，不读取 host 的 git、node_modules 差异或平台状态」
//     → 见 `assertPlatformIndependence()`：显式钉住本命令用到的每一个输入都是仓库路径。
//   第 7 条「每个 mutation 先断言目标 JSON Pointer 存在且变异计数恰好为 1；否则先失败，
//          不能产生零变异空绿」
//     → `applyMutation()` 先解析 pointer（不存在就抛 CONTROL_POINTER_MISSING），
//       再用 `countDifferences()` 对基线与变异结果做结构差，**必须恰好等于 1**。
//       这一条正是 ZLQ-163 那个「控制用例在某平台退化成比较自身」历史缺陷的解药：
//       变异数为 0 时用例直接失败，而不是安静地通过。
//
// ## 退出码
//
//   0  全部用例通过
//   1  有用例失败（比较器方向判错、变异数不为 1、pointer 不存在…）
//   2  本命令自己出错（fixture 缺失、临时目录写不进去等前置条件问题）
//
// 用法：
//   pnpm contract:control [--json] [--quiet] [--keep-temp] [--only <idPrefix>] [--list]
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ContractCompatError,
  compatExitCode,
  createFixtureTransport,
  runCompat,
} from './compatibility.mjs';
import { CONTRACT_PATHS, REPO_ROOT, serializeSnapshot, sha256Hex } from './generate.mjs';

// ---------------------------------------------------------------------------
// 诊断码（本命令自己的，与 compat 的诊断码分开命名空间）
// ---------------------------------------------------------------------------

export const CONTROL_DIAGNOSIS = Object.freeze({
  fixtureMissing: 'CONTRACT_CONTROL_FIXTURE_MISSING',
  pointerMissing: 'CONTRACT_CONTROL_POINTER_MISSING',
  mutationCount: 'CONTRACT_CONTROL_MUTATION_COUNT',
  expectation: 'CONTRACT_CONTROL_EXPECTATION_FAILED',
  crashed: 'CONTRACT_CONTROL_CRASHED',
});

export class ContractControlError extends Error {
  constructor(diagnosis, message) {
    super(message);
    this.name = 'ContractControlError';
    this.diagnosis = diagnosis;
  }
}

// ---------------------------------------------------------------------------
// JSON Pointer（RFC 6901）
// ---------------------------------------------------------------------------

function unescapeToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** 解析到 pointer 指向的**父容器与最后一个 key**，这样 remove/set/define 都能落地。 */
function locate(document, pointer) {
  if (pointer === '') return { parent: null, key: null, value: document };
  const tokens = pointer.split('/').slice(1).map(unescapeToken);
  let cursor = document;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if (cursor === null || typeof cursor !== 'object' || !(token in cursor)) {
      throw new ContractControlError(
        CONTROL_DIAGNOSIS.pointerMissing,
        `JSON Pointer 中途断开：${pointer}（在 /${tokens.slice(0, i + 1).join('/')} 处不存在）`,
      );
    }
    cursor = cursor[token];
  }
  const key = tokens[tokens.length - 1];
  if (cursor === null || typeof cursor !== 'object') {
    throw new ContractControlError(
      CONTROL_DIAGNOSIS.pointerMissing,
      `JSON Pointer 的父节点不是对象/数组：${pointer}`,
    );
  }
  return { parent: cursor, key, value: Array.isArray(cursor) ? cursor[Number(key)] : cursor[key] };
}

function readPointer(document, pointer) {
  return locate(document, pointer).value;
}

// ---------------------------------------------------------------------------
// 变异引擎（§4.2 C 第 7 条）
// ---------------------------------------------------------------------------

/**
 * 结构差计数。刻意在**最浅的分歧层**记 1 次就停，不继续往里递归：
 *   - 删掉一整个 operation 是 1 处变异，不是「它下面 40 个键都没了」；
 *   - 数组长度不同记 1 处（下标会整体错位，逐位比较没有意义）。
 * 这样「变异计数恰好为 1」才是一个人类能核对的断言。
 */
export function countDifferences(base, head) {
  if (Array.isArray(base) || Array.isArray(head)) {
    if (!Array.isArray(base) || !Array.isArray(head)) return 1;
    if (base.length !== head.length) return 1;
    let total = 0;
    for (let i = 0; i < base.length; i += 1) total += countDifferences(base[i], head[i]);
    return total;
  }
  const baseObject = base !== null && typeof base === 'object';
  const headObject = head !== null && typeof head === 'object';
  if (baseObject !== headObject) return 1;
  if (!baseObject) return Object.is(base, head) ? 0 : 1;
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  let total = 0;
  for (const key of keys) {
    const inBase = Object.hasOwn(base, key);
    const inHead = Object.hasOwn(head, key);
    if (inBase !== inHead) total += 1;
    else total += countDifferences(base[key], head[key]);
  }
  return total;
}

/**
 * 施加恰好一处变异。返回变异后的**深拷贝**，基线对象永不被改。
 *
 * 三种 op 的区别很重要，因为它们各自对应一类空绿：
 *   remove  删掉一个已存在的键（键不存在 → pointer 断言失败）
 *   set     改写一个已存在的键（键不存在 → 断言失败，避免「以为在改，其实在新增」）
 *   define  新增一个必须不存在的键（键已存在 → 断言失败，避免「以为在新增，其实没变」）
 */
export function applyMutation(document, { pointer, op, value }) {
  const mutated = structuredClone(document);
  const { parent, key } = locate(mutated, pointer);
  const exists = Array.isArray(parent) ? Number(key) < parent.length : Object.hasOwn(parent, key);

  if (op === 'define' && exists) {
    throw new ContractControlError(
      CONTROL_DIAGNOSIS.mutationCount,
      `define 要求 ${pointer} 原本不存在，但它已经有了值 —— 这条用例会退化成零变异空绿`,
    );
  }
  if ((op === 'remove' || op === 'set') && !exists) {
    throw new ContractControlError(
      CONTROL_DIAGNOSIS.pointerMissing,
      `${op} 要求 ${pointer} 原本存在，但它不在文档里。` +
        '快照演进后这条用例的锚点失效了：先失败，不能悄悄变成零变异。',
    );
  }

  if (op === 'remove') delete parent[key];
  else parent[key] = structuredClone(value);

  const changes = countDifferences(document, mutated);
  if (changes !== 1) {
    throw new ContractControlError(
      CONTROL_DIAGNOSIS.mutationCount,
      `${op} ${pointer} 造成了 ${changes} 处结构差，要求恰好 1 处。` +
        '（§4.2 C 第 7 条：变异计数不为 1 就是控制用例失效，必须先失败。）',
    );
  }
  return mutated;
}

// ---------------------------------------------------------------------------
// 用例表：单处变异驱动（走 runCompat + 临时目录）
//
// 每条 = { id, group, target, pointer, op, value?, expect }
//   target 'openapi' | 'errorCatalog' —— 变异哪一份快照（另一份原样复制）
//   expect.exitCode  0 / 1 / 2
//   expect.rules     必须出现在 report 里的规则名（breaking 或 compatible 都算）
//   expect.mode      'compare' | 'bootstrap'
//   expect.green     true 时额外断言 breaking 为空（正向对照必须真的放行）
// ---------------------------------------------------------------------------

const GROUPS = {
  operation: 'operation 存在性（§4.2 C 第 2 条点名）',
  responseField: '响应字段与值集合（响应扩大=破坏 / 收窄=非破坏）',
  responseHeader: '响应 header（§5.5 的 ETag / Location / Retry-After / Content-Disposition）',
  request: '请求侧（请求收窄=破坏 / 放宽=非破坏）',
  security: 'security 的 OR 与 AND（§4.2 B 安全方差）',
  metadata: '纯元数据与文档级字段',
  errorCodes: 'x-littleq-error-codes 扩展',
  component: 'components 与未知 schema keyword（保守按破坏性处理）',
  errorCatalog: '错误目录（改既有码的 status/messageKey/retryable 即破坏）',
  base: '基线不可得（§4.2 C 第 5 条 + 附录 B G1）',
  bootstrap: 'bootstrap 只允许一次（附录 B「bootstrap 同步修正」）',
  fixturePair: '仓库内提交的 security 正反 fixture 对（§4.2 C 第 4 条）',
};

const TURN_OPERATION_POINTER = '/paths/~1projects~1{id}~1turns/post';

/** @type {Array<object>} */
export const MUTATION_CASES = [
  // ---- operation ----
  {
    id: 'operation-removed',
    group: 'operation',
    spec: '§4.2 C 第 2 条：删除 POST /projects/{id}/turns 必须红，且诊断名逐字给出',
    target: 'openapi',
    pointer: TURN_OPERATION_POINTER,
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_OPERATION_REMOVED'] },
  },
  {
    id: 'operation-added',
    group: 'operation',
    spec: '§4.2 B：新增 operation 是放宽，非破坏',
    target: 'openapi',
    pointer: '/paths/~1probe',
    op: 'define',
    value: {
      post: {
        operationId: 'probeOperation',
        tags: ['platform'],
        security: [{ CookieAuth: [] }],
        responses: { 204: { description: 'probe' } },
      },
    },
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_OPERATION_ADDED'] },
  },
  {
    id: 'operation-id-changed',
    group: 'operation',
    spec: '§4.2 B：改变 operationId 是破坏（客户端按它生成方法名）',
    target: 'openapi',
    pointer: '/paths/~1groups/get/operationId',
    op: 'set',
    value: 'listGroupsRenamed',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_OPERATION_ID_CHANGED'] },
  },

  // ---- response fields / value sets ----
  {
    id: 'response-field-optional-added',
    group: 'responseField',
    spec: '§4.2 C 第 3 条：新增 optional 响应字段必须放行 —— 这条是「比较器永远红」的解药',
    target: 'openapi',
    pointer: '/components/schemas/Task/properties/probeNote',
    op: 'define',
    value: { type: 'string', description: '对照用例专用的可选响应字段。' },
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_RESPONSE_FIELD_ADDED'] },
  },
  {
    id: 'response-field-removed',
    group: 'responseField',
    spec: '§4.2 B：删除响应字段是破坏',
    target: 'openapi',
    pointer: '/components/schemas/Task/properties/progress',
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_RESPONSE_FIELD_REMOVED'] },
  },
  {
    id: 'response-field-made-optional',
    group: 'responseField',
    spec: '§4.2 B：required 响应字段改成 optional 是破坏',
    target: 'openapi',
    pointer: '/components/schemas/Task/required',
    op: 'set',
    value: null, // 运行时由 withDerivedValue 填：原数组去掉 'progress'
    derive: (doc) =>
      readPointer(doc, '/components/schemas/Task/required').filter((name) => name !== 'progress'),
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_RESPONSE_FIELD_MADE_OPTIONAL'] },
  },
  {
    id: 'response-widened-enum',
    group: 'responseField',
    spec: '§4.2 B「保守按破坏性处理」：响应 enum 新成员',
    target: 'openapi',
    pointer: '/components/schemas/TaskState/enum',
    op: 'set',
    value: null,
    derive: (doc) => [...readPointer(doc, '/components/schemas/TaskState/enum'), 'PROBE_STATE'],
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_RESPONSE_WIDENED'] },
  },
  {
    id: 'response-narrowed-enum',
    group: 'responseField',
    spec: '§4.2 B：收窄响应值集合但不删字段是非破坏 —— 与 response-widened-enum 成对',
    target: 'openapi',
    pointer: '/components/schemas/TaskState/enum',
    op: 'set',
    value: null,
    derive: (doc) => readPointer(doc, '/components/schemas/TaskState/enum').slice(0, -1),
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_RESPONSE_NARROWED'] },
  },
  {
    id: 'response-widened-bound',
    group: 'responseField',
    spec: '§4.2 B：降低响应 minimum 是扩大输出集合 = 破坏',
    target: 'openapi',
    pointer: '/components/schemas/Progress/minimum',
    op: 'set',
    value: -1,
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_RESPONSE_WIDENED'] },
  },
  {
    id: 'response-narrowed-bound',
    group: 'responseField',
    spec: '§4.2 B：提高响应 minimum 是收窄输出集合 = 非破坏 —— 与上一条成对',
    target: 'openapi',
    pointer: '/components/schemas/Progress/minimum',
    op: 'set',
    value: 1,
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_RESPONSE_NARROWED'] },
  },
  {
    id: 'response-type-changed',
    group: 'responseField',
    spec: '§4.2 B：改变字段 type 是破坏',
    target: 'openapi',
    pointer: '/components/schemas/Progress/type',
    op: 'set',
    value: 'string',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_TYPE_CHANGED'] },
  },
  {
    id: 'response-removed',
    group: 'responseField',
    spec: '§4.2 B：删除一个 status 响应是破坏',
    target: 'openapi',
    pointer: '/paths/~1projects~1{id}/get/responses/404',
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_RESPONSE_REMOVED'] },
  },
  {
    id: 'response-added',
    group: 'responseField',
    spec: '§4.2 B：新增一个 status 响应是放宽',
    target: 'openapi',
    pointer: '/paths/~1groups/get/responses/503',
    op: 'define',
    value: { description: '对照用例专用的新增响应。' },
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_RESPONSE_ADDED'] },
  },

  // ---- response headers ----
  {
    id: 'response-header-removed',
    group: 'responseHeader',
    spec: '§4.2 B：删除响应 header 是破坏（ETag 是乐观并发的载体）',
    target: 'openapi',
    pointer: '/paths/~1projects~1{id}/get/responses/200/headers/ETag',
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_RESPONSE_HEADER_REMOVED'] },
  },
  {
    id: 'response-header-added',
    group: 'responseHeader',
    spec: '§4.2 B：新增响应 header 是放宽',
    target: 'openapi',
    pointer: '/paths/~1projects~1{id}/get/responses/200/headers/X-Littleq-Probe',
    op: 'define',
    value: { schema: { type: 'string' }, required: false, description: '对照用例专用。' },
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_RESPONSE_HEADER_ADDED'] },
  },
  {
    id: 'response-header-made-optional',
    group: 'responseHeader',
    spec: '§4.2 B：required 响应 header 改成 optional 是破坏',
    target: 'openapi',
    pointer: '/paths/~1projects~1{id}/get/responses/200/headers/ETag/required',
    op: 'set',
    value: false,
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_RESPONSE_HEADER_MADE_OPTIONAL'] },
  },
  {
    id: 'response-header-made-required',
    group: 'responseHeader',
    spec: '§4.2 B：optional 响应 header 改成 required 是收紧保证 = 非破坏（与上一条成对）',
    target: 'openapi',
    pointer: '/paths/~1usage~1ledger/get/responses/200/headers/Content-Disposition/required',
    op: 'set',
    value: true,
    expect: {
      exitCode: 0,
      green: true,
      rules: ['OPENAPI_COMPATIBLE_RESPONSE_HEADER_MADE_REQUIRED'],
    },
  },

  // ---- request side ----
  {
    id: 'request-narrowed-bound',
    group: 'request',
    spec: '§4.2 B：提高请求 minimum 是收窄接受集合 = 破坏',
    target: 'openapi',
    pointer: '/components/schemas/ListLimit/minimum',
    op: 'set',
    value: 2,
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_REQUEST_NARROWED'] },
  },
  {
    id: 'request-widened-bound',
    group: 'request',
    spec: '§4.2 B：降低请求 minimum 是放宽接受集合 = 非破坏（与上一条成对）',
    target: 'openapi',
    pointer: '/components/schemas/ListLimit/minimum',
    op: 'set',
    value: 0,
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_REQUEST_WIDENED'] },
  },
  {
    id: 'request-narrowed-enum',
    group: 'request',
    spec: '§4.2 B：删 enum 成员是收窄接受集合 = 破坏',
    target: 'openapi',
    pointer: '/components/schemas/LedgerExportFormat/enum',
    op: 'set',
    value: ['json'],
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_REQUEST_NARROWED'] },
  },
  {
    id: 'request-widened-enum',
    group: 'request',
    spec: '§4.2 B：加 enum 成员是放宽接受集合 = 非破坏（与上一条成对）',
    target: 'openapi',
    pointer: '/components/schemas/LedgerExportFormat/enum',
    op: 'set',
    value: ['json', 'csv', 'xml'],
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_REQUEST_WIDENED'] },
  },
  {
    id: 'request-narrowed-min-length',
    group: 'request',
    spec: '§4.2 B：提高最短长度是收窄 = 破坏（Idempotency-Key 16→32 会让既有客户端被拒）',
    target: 'openapi',
    pointer: '/components/schemas/IdempotencyKey/minLength',
    op: 'set',
    value: 32,
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_REQUEST_NARROWED'] },
  },
  {
    id: 'request-field-made-required',
    group: 'request',
    spec: '§4.2 B：把既有 optional 请求字段改成必填 = 破坏',
    target: 'openapi',
    pointer: '/components/schemas/LoginRequest/required',
    op: 'set',
    value: ['loginName', 'password', 'rememberMe'],
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_REQUEST_FIELD_MADE_REQUIRED'] },
  },
  {
    id: 'request-field-made-optional',
    group: 'request',
    spec: '§4.2 B：把必填请求字段改成 optional = 放宽（与上一条成对）',
    target: 'openapi',
    pointer: '/components/schemas/LoginRequest/required',
    op: 'set',
    value: ['loginName'],
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_REQUEST_FIELD_MADE_OPTIONAL'] },
  },
  {
    id: 'request-field-optional-added',
    group: 'request',
    spec: '§4.2 B：新增 optional 请求字段 = 非破坏',
    target: 'openapi',
    pointer: '/components/schemas/LoginRequest/properties/probeOptional',
    op: 'define',
    value: { type: 'boolean' },
    expect: {
      exitCode: 0,
      green: true,
      rules: ['OPENAPI_COMPATIBLE_REQUEST_FIELD_OPTIONAL_ADDED'],
    },
  },
  {
    id: 'request-field-removed',
    group: 'request',
    spec: '§4.2 B「保守按破坏性处理」：删除请求字段（服务端可能仍要求它）',
    target: 'openapi',
    pointer: '/components/schemas/LoginRequest/properties/password',
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_REQUEST_FIELD_REMOVED'] },
  },
  {
    id: 'request-body-removed',
    group: 'request',
    spec: '§4.2 B：删除既有 request media type / body = 破坏',
    target: 'openapi',
    pointer: '/paths/~1groups/post/requestBody',
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_REQUEST_BODY_REMOVED'] },
  },
  {
    id: 'request-default-changed',
    group: 'request',
    spec: '§4.2 B「保守按破坏性处理」：改请求默认值（省略该字段的既有客户端行为会变）',
    target: 'openapi',
    pointer: '/components/schemas/ListLimit/default',
    op: 'set',
    value: 50,
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_REQUEST_DEFAULT_CHANGED'] },
  },
  {
    id: 'parameter-required-added',
    group: 'request',
    spec: '§4.2 B：增加必填参数 = 破坏',
    target: 'openapi',
    pointer: '/paths/~1groups/get/parameters/0/required',
    op: 'define',
    value: true,
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_PARAMETER_REQUIRED_ADDED'] },
  },
  {
    id: 'parameter-removed',
    group: 'request',
    spec: '§4.2 B：删除既有参数 = 破坏',
    target: 'openapi',
    pointer: '/paths/~1groups/get/parameters/2',
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_PARAMETER_REMOVED'] },
  },
  {
    id: 'parameter-made-optional',
    group: 'request',
    spec: '§4.2 B：必填参数改成可选 = 放宽（与 parameter-required-added 成对）',
    target: 'openapi',
    pointer: '/paths/~1projects~1{id}/get/parameters/0/required',
    op: 'set',
    value: false,
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_PARAMETER_MADE_OPTIONAL'] },
  },

  // ---- security ----
  {
    id: 'security-and-added',
    group: 'security',
    spec: '§4.2 B：在现有 Security Requirement Object 内增加 AND scheme = 收紧 = 破坏',
    target: 'openapi',
    pointer: '/paths/~1groups/get/security/0/CsrfHeader',
    op: 'define',
    value: [],
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SECURITY_TIGHTENED'] },
  },
  {
    id: 'security-and-removed',
    group: 'security',
    spec: '§4.2 B：从对象移除 scheme = 放宽 = 非破坏（与上一条成对）',
    target: 'openapi',
    pointer: '/paths/~1groups/get/security/0',
    op: 'set',
    value: {},
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_SECURITY_LOOSENED'] },
  },
  {
    id: 'security-anonymous-added',
    group: 'security',
    spec: '§4.2 B：增加匿名 {} 分支 = 放宽',
    target: 'openapi',
    pointer: '/paths/~1groups/get/security',
    op: 'set',
    value: [{ CookieAuth: [] }, {}],
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_SECURITY_BRANCH_ADDED'] },
  },
  {
    id: 'security-or-branch-removed',
    group: 'security',
    spec: '§4.2 B：删除 OR 分支 = 收紧 = 破坏',
    target: 'openapi',
    pointer: '/paths/~1groups/get/security',
    op: 'set',
    value: [],
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SECURITY_BRANCH_REMOVED'] },
  },
  {
    id: 'security-csrf-split',
    group: 'security',
    spec: '§5.5 / §4.2 B：Cookie 与 CSRF 必须同对象（AND）；拆成两个 OR 分支必须红',
    target: 'openapi',
    pointer: '/paths/~1groups/post/security',
    op: 'set',
    value: [{ CookieAuth: [] }, { CsrfHeader: [] }],
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SECURITY_CSRF_SPLIT'] },
  },
  {
    id: 'security-scheme-changed',
    group: 'security',
    spec: '§5.5：cookie **名**是契约字节（OpenAPI 3.1 没有 cookie 类型，只能靠 apiKey+name 表达），改名即破坏',
    target: 'openapi',
    pointer: '/components/securitySchemes/CookieAuth/name',
    op: 'set',
    value: 'littleq_session_renamed',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SECURITY_SCHEME_CHANGED'] },
  },
  {
    id: 'security-scheme-removed',
    group: 'security',
    spec: '§4.2 B：删除既有 security scheme 定义 = 破坏',
    target: 'openapi',
    pointer: '/components/securitySchemes/CsrfHeader',
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SECURITY_SCHEME_REMOVED'] },
  },
  {
    id: 'security-scheme-added',
    group: 'security',
    spec: '§4.2 B：新增 security scheme 定义而不在任何对象里强制它 = 非破坏',
    target: 'openapi',
    pointer: '/components/securitySchemes/ProbeAuth',
    op: 'define',
    value: { type: 'apiKey', in: 'header', name: 'X-Littleq-Probe' },
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_SECURITY_SCHEME_ADDED'] },
  },

  // ---- metadata / document level ----
  {
    id: 'metadata-only',
    group: 'metadata',
    spec: '§4.2 B：只修改 description = 非破坏',
    target: 'openapi',
    pointer: '/paths/~1groups/get/description',
    op: 'set',
    value: '对照用例改写的描述，不含任何语义变化。',
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_METADATA_ONLY'] },
  },
  {
    id: 'info-major-changed',
    group: 'metadata',
    spec: '§4.2 B：info.version 的主版本变化 = 破坏（这是 /api/v2 的信号，必须由 PM/架构师裁定）',
    target: 'openapi',
    pointer: '/info/version',
    op: 'set',
    value: '2.0.0',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_INFO_MAJOR_CHANGED'] },
  },
  {
    id: 'server-url-changed',
    group: 'metadata',
    spec: '§4.2 B：改 servers[0].url 等于换掉整个前缀 = 破坏。' +
      '也钉住「不能用改 server url 的方式给 /api/v1 开绕过」',
    target: 'openapi',
    pointer: '/servers/0/url',
    op: 'set',
    value: '/api/v2',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SERVER_URL_CHANGED'] },
  },
  {
    id: 'spec-version-changed',
    group: 'metadata',
    spec: '§3.1 裁定 OpenAPI 3.1.0；改版本号会让所有下游解析器行为变化 = 破坏',
    target: 'openapi',
    pointer: '/openapi',
    op: 'set',
    value: '3.0.3',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SPEC_VERSION_CHANGED'] },
  },

  // ---- x-littleq-error-codes ----
  {
    id: 'error-codes-added',
    group: 'errorCodes',
    spec: '§5.4：给既有 operation 加错误码 = 客户端要处理新失败模式 = 保守按破坏性处理',
    target: 'openapi',
    pointer: '/paths/~1groups/get/x-littleq-error-codes',
    op: 'set',
    value: ['AUTHENTICATION_REQUIRED', 'REQUEST_INVALID', 'RESOURCE_NOT_FOUND'],
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_ERROR_CODES_ADDED'] },
  },
  {
    id: 'error-codes-removed',
    group: 'errorCodes',
    spec: '§5.4：移除一个错误码 = 少一种失败模式 = 非破坏（与上一条成对）',
    target: 'openapi',
    pointer: '/paths/~1groups/get/x-littleq-error-codes',
    op: 'set',
    value: ['AUTHENTICATION_REQUIRED'],
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_ERROR_CODES_REMOVED'] },
  },

  // ---- components / unknown keywords ----
  {
    id: 'component-removed',
    group: 'component',
    spec: '§4.2 B：删除既有 component = 破坏（所有 $ref 指向它）',
    target: 'openapi',
    pointer: '/components/schemas/GroupStatus',
    op: 'remove',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_COMPONENT_REMOVED'] },
  },
  {
    id: 'component-added',
    group: 'component',
    spec: '§4.2 B：新增 component 而没人引用 = 非破坏',
    target: 'openapi',
    pointer: '/components/schemas/ProbeComponent',
    op: 'define',
    value: { type: 'string', description: '对照用例专用，无引用。' },
    expect: { exitCode: 0, green: true, rules: ['OPENAPI_COMPATIBLE_COMPONENT_ADDED'] },
  },
  {
    id: 'schema-keyword-unknown',
    group: 'component',
    spec: '§4.2 B「保守按破坏性处理」：无法识别的 schema keyword（比较器不认识就无法判方向）',
    target: 'openapi',
    pointer: '/components/schemas/Progress/xProbeKeyword',
    op: 'define',
    value: true,
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SCHEMA_KEYWORD_UNKNOWN'] },
  },

  // ---- error catalog ----
  {
    id: 'catalog-code-status-changed',
    group: 'errorCatalog',
    spec: '§4.2 B：改变既有错误码的 HTTP status = 破坏',
    target: 'errorCatalog',
    pointer: '/codes/0/httpStatus',
    op: 'set',
    value: 422,
    expect: { exitCode: 1, rules: ['ERROR_CATALOG_BREAKING_CODE_REDEFINED'] },
  },
  {
    id: 'catalog-code-message-key-changed',
    group: 'errorCatalog',
    spec: '§4.2 B：改变既有错误码的 messageKey = 破坏（前端按它取文案）',
    target: 'errorCatalog',
    pointer: '/codes/0/messageKey',
    op: 'set',
    value: 'probe.renamed',
    expect: { exitCode: 1, rules: ['ERROR_CATALOG_BREAKING_CODE_REDEFINED'] },
  },
  {
    id: 'catalog-code-retryable-changed',
    group: 'errorCatalog',
    spec: '§4.2 B：改变既有错误码的 retryable = 破坏（客户端重试策略会跟着变）',
    target: 'errorCatalog',
    pointer: '/codes/0/retryable',
    op: 'set',
    value: true,
    expect: { exitCode: 1, rules: ['ERROR_CATALOG_BREAKING_CODE_REDEFINED'] },
  },
  {
    id: 'catalog-code-safety-changed',
    group: 'errorCatalog',
    spec: '§4.2 B：改变 sameRequestRetrySafety = 破坏（SAFE→UNSAFE 会让自动重试变成不安全）',
    target: 'errorCatalog',
    pointer: '/codes/0/sameRequestRetrySafety',
    op: 'set',
    value: 'UNSAFE',
    expect: { exitCode: 1, rules: ['ERROR_CATALOG_BREAKING_CODE_REDEFINED'] },
  },
  {
    id: 'catalog-code-removed',
    group: 'errorCatalog',
    spec: '§4.2 B：删除既有错误码 = 破坏（仍在返回它的服务端会让客户端无法归类）',
    target: 'errorCatalog',
    pointer: '/codes/0',
    op: 'remove',
    expect: { exitCode: 1, rules: ['ERROR_CATALOG_BREAKING_CODE_REMOVED'] },
  },
  {
    id: 'catalog-code-added',
    group: 'errorCatalog',
    spec: '§4.2 B「保守按破坏性处理」：新错误码（Stage 1 不静默放行）',
    target: 'errorCatalog',
    pointer: '/codes/42',
    op: 'define',
    value: {
      code: 'PROBE_CODE',
      httpStatus: 400,
      messageKey: 'probe.added',
      retryable: false,
      sameRequestRetrySafety: 'SAFE',
    },
    expect: { exitCode: 1, rules: ['ERROR_CATALOG_BREAKING_CODE_ADDED'] },
  },
  {
    id: 'catalog-api-major-changed',
    group: 'errorCatalog',
    spec: '§4.2 B：错误目录的 apiMajor 变化 = 破坏',
    target: 'errorCatalog',
    pointer: '/apiMajor',
    op: 'set',
    value: 2,
    expect: { exitCode: 1, rules: ['ERROR_CATALOG_BREAKING_API_MAJOR_CHANGED'] },
  },
  {
    id: 'catalog-task-registry-changed',
    group: 'errorCatalog',
    spec: '§5.4：异步错误表 (taskKind, stage) → codes 是契约的一部分，改动即破坏',
    target: 'errorCatalog',
    pointer: '/taskErrorRegistry/VIBE_TURN',
    op: 'remove',
    expect: { exitCode: 1, rules: ['ERROR_CATALOG_BREAKING_TASK_REGISTRY_CHANGED'] },
  },
];

// ---------------------------------------------------------------------------
// fixture 路径（全部仓库内，§4.2 C 第 6 条）
// ---------------------------------------------------------------------------

export const FIXTURE_ROOT = join(REPO_ROOT, 'tools', '__fixtures__', 'contracts');
const SECURITY_FIXTURE_DIR = join(FIXTURE_ROOT, 'security');
const BOOTSTRAP_HEAD_DIR = join(FIXTURE_ROOT, 'bootstrap', 'head');
const GIT_FIXTURE_DIR = join(FIXTURE_ROOT, 'git');

// 合成的 40 位小写 hex，形状合法但绝不可能是真 commit —— 这样万一哪天有人把 fixture
// 路径写成真 git 目录，`createFixtureTransport` 也只会读不到而 fail closed，不会误读历史。
export const FIXTURE_SHA = Object.freeze({
  baseEmpty: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  baseWithSnapshot: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  head: 'cccccccccccccccccccccccccccccccccccccccc',
  baseMissing: 'dddddddddddddddddddddddddddddddddddddddd',
  allZero: '0000000000000000000000000000000000000000',
});

/** 断言 fixture 存在并返回其路径。缺失是**本命令的前置条件问题**（exit 2），不是用例失败。 */
function readFixturePath(path, what) {
  if (!existsSync(path)) {
    throw new ContractControlError(
      CONTROL_DIAGNOSIS.fixtureMissing,
      `缺少${what}：${path}。fixture 必须提交进仓库（§4.2 C 第 6 条），不能运行时生成。`,
    );
  }
  return path;
}

function readFixtureFile(path, what) {
  return readFileSync(readFixturePath(path, what), 'utf8');
}

// ---------------------------------------------------------------------------
// 驱动：把一份 head 树写进临时目录，然后调用生产的 runCompat
// ---------------------------------------------------------------------------

function writeHeadTree(rootDir, { openapi, errorCatalog, bootstrap }) {
  const files = [
    [CONTRACT_PATHS.openapi, openapi],
    [CONTRACT_PATHS.errorCatalog, errorCatalog],
    [CONTRACT_PATHS.bootstrap, bootstrap],
  ];
  for (const [relPath, value] of files) {
    if (value === undefined) continue;
    // openapi / errorCatalog 一律是从仓库内 fixture 原样读出的字符串（必须原样落盘，否则
    // bootstrap 用例里 sha256Hex(openapi) 与 head 字节就对不上）；bootstrap 由各用例以
    // JSON 值的形式给出，这里统一序列化。两种输入都接受，但绝不混用：字符串原样写，
    // 非字符串走 serializeSnapshot。
    const text = typeof value === 'string' ? value : serializeSnapshot(value);
    const abs = join(rootDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return rootDir;
}

/**
 * 调用生产入口并把它归一成 { exitCode, report?, diagnosis?, message? }。
 * 判定逻辑一行都没复制：runCompat 是 CLI 用的同一个函数，compatExitCode 是 CLI 用的
 * 同一份退出码映射。
 */
export function invokeCompat(options) {
  try {
    const report = runCompat(options);
    return { exitCode: report.ok ? 0 : 1, report };
  } catch (error) {
    if (error instanceof ContractCompatError) {
      const { exitCode, diagnosis } = compatExitCode(error);
      return { exitCode, diagnosis, message: error.message };
    }
    throw error;
  }
}

function rulesOf(report) {
  return new Set([...report.breaking, ...report.compatible].map((item) => item.rule));
}

// ---------------------------------------------------------------------------
// 用例执行
// ---------------------------------------------------------------------------

function checkExpectation(testCase, result) {
  const { expect } = testCase;
  const problems = [];

  if (result.exitCode !== expect.exitCode) {
    problems.push(
      `退出码 ${result.exitCode}，期望 ${expect.exitCode}` +
        (result.diagnosis ? `（诊断 ${result.diagnosis}）` : '') +
        (result.message ? `\n       比较器输出：${result.message.split('\n')[0]}` : ''),
    );
  }
  if (result.diagnosis !== undefined && expect.diagnosis !== undefined) {
    if (result.diagnosis !== expect.diagnosis) {
      problems.push(`诊断 ${result.diagnosis}，期望 ${expect.diagnosis}`);
    }
  } else if (expect.diagnosis !== undefined) {
    problems.push(`期望诊断 ${expect.diagnosis}，但比较器正常返回了报告（没有抛错）`);
  }

  const report = result.report;
  if (report !== undefined) {
    if (expect.mode !== undefined && report.mode !== expect.mode) {
      problems.push(`mode ${report.mode}，期望 ${expect.mode}`);
    }
    const rules = rulesOf(report);
    for (const rule of expect.rules ?? []) {
      if (!rules.has(rule)) {
        problems.push(
          `报告里没有 ${rule}（实际 ${[...rules].sort().join(', ') || '<空>'}）`,
        );
      }
    }
    if (expect.green === true && report.breaking.length > 0) {
      problems.push(
        `正向对照却报了 ${report.breaking.length} 条破坏性变更：` +
          report.breaking.map((item) => item.rule).join(', '),
      );
    }
    if (expect.refuseReason === true && !report.refuseReason) {
      problems.push('期望 report.refuseReason 非空（bootstrap 分支必须被拒绝并退回正常比较）');
    }
    if (expect.minFindings !== undefined && report.findings.length < expect.minFindings) {
      problems.push(`findings ${report.findings.length} 条，期望至少 ${expect.minFindings} 条`);
    }
  }

  return problems;
}

/** 单处变异类用例：复制已提交快照 → 变异 → 写临时目录 → runCompat(--base-dir 仓库根)。 */
function runMutationCase(testCase, { baseline, workRoot }) {
  const source = baseline[testCase.target];
  const value = testCase.derive !== undefined ? testCase.derive(source.document) : testCase.value;
  const mutated = applyMutation(source.document, {
    pointer: testCase.pointer,
    op: testCase.op,
    value,
  });

  const caseRoot = join(workRoot, testCase.id);
  writeHeadTree(caseRoot, {
    openapi:
      testCase.target === 'openapi'
        ? serializeSnapshot(mutated)
        : baseline.openapi.text,
    errorCatalog:
      testCase.target === 'errorCatalog'
        ? serializeSnapshot(mutated)
        : baseline.errorCatalog.text,
  });

  // baseDir 指向仓库根：base 就是**已提交的那两份快照**，head 是临时目录里的变异体。
  // 走 baseDir 分支意味着 runCompat 一个 git 进程都不会起（§7.3 第 6 条）。
  const result = invokeCompat({ repoRoot: caseRoot, baseDir: REPO_ROOT });
  return { result, problems: checkExpectation(testCase, result) };
}

/**
 * security 正反 fixture 对（§4.2 C 第 4 条点名要「OR/AND 各运行正反 fixture」）。
 *
 * 走 `runCompat({ baseFile, headFile, … })`，也就是 CLI `contract:compat --base-file …`
 * 的同一条代码路径 —— 判定逻辑一行都没在这里重写。错误目录两侧故意指向**同一个**文件：
 * 这组用例只考察 security 方向，目录若也变化就会掺进无关 finding。
 */
function runFixturePairCase(testCase) {
  const dir = join(SECURITY_FIXTURE_DIR, testCase.dir);
  const baseFile = readFixturePath(join(dir, 'base.json'), `security fixture 基线（${testCase.dir}）`);
  const headFile = readFixturePath(join(dir, 'head.json'), `security fixture 变异体（${testCase.dir}）`);
  const errorCatalogFile = readFixturePath(
    join(dir, 'error-catalog.json'),
    `security fixture 的错误目录（${testCase.dir}）`,
  );

  const problems = [];
  const differences = countDifferences(
    JSON.parse(readFileSync(baseFile, 'utf8')),
    JSON.parse(readFileSync(headFile, 'utf8')),
  );
  if (differences !== 1) {
    problems.push(
      `fixture 对 ${testCase.dir} 的 base/head 相差 ${differences} 处，要求恰好 1 处` +
        '（§4.2 C 第 7 条同样适用于提交式 fixture，否则「红」可能来自无关差异）',
    );
  }

  const result = invokeCompat({
    baseFile,
    baseErrorFile: errorCatalogFile,
    headFile,
    headErrorFile: errorCatalogFile,
  });
  problems.push(...checkExpectation(testCase, result));
  return { result, problems };
}

/** 基线可得性 / bootstrap 类用例：走 createFixtureTransport（仓库内目录树当对象库）。 */
function runTransportCase(testCase, { workRoot }) {
  const headOpenApi = readFixtureFile(
    join(BOOTSTRAP_HEAD_DIR, CONTRACT_PATHS.openapi),
    'bootstrap fixture 的 head openapi 快照',
  );
  const headErrorCatalog = readFixtureFile(
    join(BOOTSTRAP_HEAD_DIR, CONTRACT_PATHS.errorCatalog),
    'bootstrap fixture 的 head 错误目录快照',
  );

  const caseRoot = join(workRoot, testCase.id);
  const bootstrap = testCase.bootstrap === undefined ? undefined : testCase.bootstrap({
    openapi: headOpenApi,
    errorCatalog: headErrorCatalog,
  });
  writeHeadTree(caseRoot, { openapi: headOpenApi, errorCatalog: headErrorCatalog, bootstrap });

  const result = invokeCompat({
    repoRoot: caseRoot,
    baseSha: testCase.baseSha,
    transport: createFixtureTransport(GIT_FIXTURE_DIR),
    allowBootstrap: testCase.allowBootstrap !== false,
  });
  return { result, problems: checkExpectation(testCase, result) };
}

// 合法的 bootstrap.json：sha256 由**仓库内 fixture 字节**算出，不是手写的常量，也不扫描宿主。
function validBootstrap({ openapi, errorCatalog }, baseSha) {
  return {
    apiMajor: 1,
    designBaseline: '88edd3f57ebf3fa34dd86c083a2757f21d969c9b',
    introducedFromBase: baseSha,
    snapshots: {
      [CONTRACT_PATHS.openapi]: sha256Hex(openapi),
      [CONTRACT_PATHS.errorCatalog]: sha256Hex(errorCatalog),
    },
  };
}

/** @type {Array<object>} */
export const BASE_CASES = [
  {
    id: 'base-dir-missing-snapshots',
    group: 'base',
    kind: 'baseDir',
    spec: '§4.2 C 第 5 条：base 文件缺失 → exit 2 + CONTRACT_BASE_UNAVAILABLE，禁止退化成 head 自比',
    expect: { exitCode: 2, diagnosis: 'CONTRACT_BASE_UNAVAILABLE' },
  },
  {
    id: 'base-sha-unreadable',
    group: 'base',
    kind: 'transport',
    baseSha: FIXTURE_SHA.baseMissing,
    spec: '附录 B G1：base commit 不可读取 → exit 2 + CONTRACT_BASE_UNAVAILABLE（不与「路径不存在」混同）',
    expect: { exitCode: 2, diagnosis: 'CONTRACT_BASE_UNAVAILABLE' },
  },
  {
    id: 'base-sha-all-zero',
    group: 'base',
    kind: 'transport',
    baseSha: FIXTURE_SHA.allZero,
    spec: '附录 B G1：全零 SHA（分支首推/强推删除时 GitHub 会给）不指向任何 commit → exit 2',
    expect: { exitCode: 2, diagnosis: 'CONTRACT_BASE_UNAVAILABLE' },
  },
  {
    id: 'base-sha-malformed',
    group: 'base',
    kind: 'transport',
    baseSha: 'not-a-commit-sha',
    spec: '附录 B G1：非 40 位 hex → exit 2，禁止回退到 HEAD^ 或工作树',
    expect: { exitCode: 2, diagnosis: 'CONTRACT_BASE_UNAVAILABLE' },
  },
  {
    id: 'base-sha-equals-head',
    group: 'base',
    kind: 'transport',
    baseSha: FIXTURE_SHA.head,
    spec: '§4.2 B：base == head 就是「head 与自身比较」，明令禁止 → exit 2',
    expect: { exitCode: 2, diagnosis: 'CONTRACT_BASE_UNAVAILABLE' },
  },
  {
    id: 'base-readable-no-snapshot-no-bootstrap',
    group: 'base',
    kind: 'transport',
    baseSha: FIXTURE_SHA.baseEmpty,
    bootstrap: undefined,
    spec: '附录 B：base 可读但没有 snapshot、head 也没有 bootstrap.json → 不是首落，exit 2',
    expect: { exitCode: 2, diagnosis: 'CONTRACT_BASE_UNAVAILABLE' },
  },
];

/** @type {Array<object>} */
export const BOOTSTRAP_CASES = [
  {
    id: 'bootstrap-allowed',
    group: 'bootstrap',
    kind: 'transport',
    baseSha: FIXTURE_SHA.baseEmpty,
    spec: '附录 B 四个前置条件全满足 → 唯一一次合法首落，exit 0 且 mode=bootstrap',
    bootstrap: ({ openapi, errorCatalog }) =>
      validBootstrap({ openapi, errorCatalog }, FIXTURE_SHA.baseEmpty),
    expect: { exitCode: 0, mode: 'bootstrap' },
  },
  {
    id: 'bootstrap-refused-base-has-snapshot',
    group: 'bootstrap',
    kind: 'transport',
    baseSha: FIXTURE_SHA.baseWithSnapshot,
    // 关键点：这里的 bootstrap.json 本身**完全合法**（sha256 对得上 head 字节、
    // introducedFromBase 等于 base SHA、designBaseline 正确），仍然必须被拒 —— 附录 B 的
    // 「base 已含任一 v1 snapshot 即永久不可再触发」是无条件短路，不是「bootstrap 无效才拒」。
    // 用合法 bootstrap 做这条用例，才能把「bootstrap 写错了」与「首落窗口已过」两种红分开。
    spec: '附录 B：base 已含 v1 snapshot → 即使 bootstrap 完全合法也必须拒绝，退回正常比较',
    bootstrap: ({ openapi, errorCatalog }) =>
      validBootstrap({ openapi, errorCatalog }, FIXTURE_SHA.baseWithSnapshot),
    expect: {
      exitCode: 1,
      mode: 'compare',
      refuseReason: true,
      // git/bbbb… fixture 里有一个 head 已经删掉的 GET /probe-gone-in-head，head 又多出一个
      // GET /probe：所以退回比较后同时触发「删除 operation」（破坏）与「新增 operation」
      // （非破坏）。断言两条规则都在，才证明「退回的是一次**真实**比较」而不是又一次短路；
      // 断言 exit 1，才对得上附录 B 那句「SHA 不匹配或 base 已有 snapshot 必须红」。
      // 首落窗口一旦过去，bootstrap 就不是「换个理由放行」，而是把判定权交还给方差表。
      rules: ['OPENAPI_BREAKING_OPERATION_REMOVED', 'OPENAPI_COMPATIBLE_OPERATION_ADDED'],
      minFindings: 2,
    },
  },
  {
    id: 'bootstrap-invalid-snapshot-sha',
    group: 'bootstrap',
    kind: 'transport',
    baseSha: FIXTURE_SHA.baseEmpty,
    spec: '附录 B：bootstrap 记录的 sha256 与 head 字节不一致 → exit 1 + CONTRACT_BOOTSTRAP_INVALID',
    bootstrap: ({ openapi, errorCatalog }) => ({
      ...validBootstrap({ openapi, errorCatalog }, FIXTURE_SHA.baseEmpty),
      snapshots: {
        [CONTRACT_PATHS.openapi]: 'f'.repeat(64),
        [CONTRACT_PATHS.errorCatalog]: sha256Hex(errorCatalog),
      },
    }),
    expect: { exitCode: 1, diagnosis: 'CONTRACT_BOOTSTRAP_INVALID' },
  },
  {
    id: 'bootstrap-invalid-base-mismatch',
    group: 'bootstrap',
    kind: 'transport',
    baseSha: FIXTURE_SHA.baseEmpty,
    spec: '附录 B：introducedFromBase 必须逐字等于本次事件解析出的 CONTRACT_BASE_SHA',
    bootstrap: ({ openapi, errorCatalog }) =>
      validBootstrap({ openapi, errorCatalog }, FIXTURE_SHA.baseWithSnapshot),
    expect: { exitCode: 1, diagnosis: 'CONTRACT_BOOTSTRAP_INVALID' },
  },
  {
    id: 'bootstrap-invalid-design-baseline',
    group: 'bootstrap',
    kind: 'transport',
    baseSha: FIXTURE_SHA.baseEmpty,
    spec: '附录 B「bootstrap 同步修正」：designBaseline 固定为设计基线 88edd3f5…，仅作溯源',
    bootstrap: ({ openapi, errorCatalog }) => ({
      ...validBootstrap({ openapi, errorCatalog }, FIXTURE_SHA.baseEmpty),
      designBaseline: 'e'.repeat(40),
    }),
    expect: { exitCode: 1, diagnosis: 'CONTRACT_BOOTSTRAP_INVALID' },
  },
  {
    id: 'bootstrap-disabled-by-caller',
    group: 'bootstrap',
    kind: 'transport',
    baseSha: FIXTURE_SHA.baseEmpty,
    allowBootstrap: false,
    spec: '§4.2 B：调用方禁用 bootstrap 又没有别的基线 → fail closed，不能悄悄跳过比较',
    bootstrap: ({ openapi, errorCatalog }) =>
      validBootstrap({ openapi, errorCatalog }, FIXTURE_SHA.baseEmpty),
    expect: { exitCode: 2, diagnosis: 'CONTRACT_BASE_UNAVAILABLE' },
  },
];

/** @type {Array<object>} */
export const SECURITY_FIXTURE_CASES = [
  {
    id: 'security-fixture-or-branch-removed',
    group: 'fixturePair',
    kind: 'fixturePair',
    dir: 'or-branch-removed',
    spec:
      '§4.2 B：从**两个** OR 分支里删掉一条 = 收紧 = 破坏。' +
      '真实快照的 security 最多只有一个分支，删到最后一条会退化成「显式匿名」，' +
      '所以这一条方向必须用提交式 fixture 对来钉（§4.2 C 第 4 条「正反 fixture」）',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SECURITY_BRANCH_REMOVED'] },
  },
  {
    id: 'security-fixture-anonymous-removed',
    group: 'fixturePair',
    kind: 'fixturePair',
    dir: 'anonymous-removed',
    spec: '§4.2 B：删除匿名 {} 分支 = 收紧 = 破坏（原本可以不带凭证访问）',
    expect: { exitCode: 1, rules: ['OPENAPI_BREAKING_SECURITY_BRANCH_REMOVED'] },
  },
];

// ---------------------------------------------------------------------------
// 平台无关性自证（§4.2 C 第 6 条 + PM G6 第 2 条）
// ---------------------------------------------------------------------------

/**
 * 钉住「本命令的每一个输入都来自仓库路径」。
 *
 * 这条断言本身就是 G6 要求的**平台无关性论证**的可执行部分：它逐个检查用例读取的文件
 * 都在 REPO_ROOT 之下，且期望值里没有一处来自「对本机扫描」。任何一条断言的期望值都写死
 * 在本文件的用例表里（规则名、退出码），基线字节全部来自已提交文件。
 *
 * 需求清单**从用例表推导**，不是另写一份硬编码列表 —— 否则新增一条用例时这里会静默漏检。
 */
export function assertPlatformIndependence() {
  const required = [
    CONTRACT_PATHS.openapi,
    CONTRACT_PATHS.errorCatalog,
    join('tools', '__fixtures__', 'contracts', 'bootstrap', 'head', CONTRACT_PATHS.openapi),
    join('tools', '__fixtures__', 'contracts', 'bootstrap', 'head', CONTRACT_PATHS.errorCatalog),
    join('tools', '__fixtures__', 'contracts', 'git', 'HEAD'),
  ];

  for (const testCase of SECURITY_FIXTURE_CASES) {
    for (const name of ['base.json', 'head.json', 'error-catalog.json']) {
      required.push(join('tools', '__fixtures__', 'contracts', 'security', testCase.dir, name));
    }
  }

  // transport 类用例的 base 取自 git fixture 树。只有**期望被读出来**的那两个 SHA 目录必须
  // 存在；其余 SHA 存在的意义恰恰是「读不到」（baseMissing）、形状非法（malformed）、
  // 或等于 head（head），为它们建目录会把用例要证明的前提反过来。
  const gitFixture = (sha, ...rel) =>
    rel.length === 0
      ? join('tools', '__fixtures__', 'contracts', 'git', sha)
      : rel.map((item) => join('tools', '__fixtures__', 'contracts', 'git', sha, item));
  required.push(gitFixture(FIXTURE_SHA.baseEmpty));
  required.push(
    ...gitFixture(FIXTURE_SHA.baseWithSnapshot, CONTRACT_PATHS.openapi, CONTRACT_PATHS.errorCatalog),
  );

  const missing = required.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
  if (missing.length > 0) {
    throw new ContractControlError(
      CONTROL_DIAGNOSIS.fixtureMissing,
      `以下 fixture 必须提交进仓库（§4.2 C 第 6 条：不读 host 的 git / node_modules / 平台状态）：\n` +
        missing.map((rel) => `     - ${rel}`).join('\n'),
    );
  }

  // baseEmpty 那个 commit 目录必须存在但**不含任何 v1 契约路径** —— 这正是「base 可读、
  // 路径不存在」与「base 不可读」的分界（附录 B）。目录里放一份 README 让 git 能提交它。
  const emptyDir = join(GIT_FIXTURE_DIR, FIXTURE_SHA.baseEmpty);
  for (const rel of [CONTRACT_PATHS.openapi, CONTRACT_PATHS.errorCatalog, CONTRACT_PATHS.bootstrap]) {
    if (existsSync(join(emptyDir, rel))) {
      throw new ContractControlError(
        CONTROL_DIAGNOSIS.fixtureMissing,
        `${emptyDir} 里不该出现 ${rel} —— 它存在的意义就是「base 可读但没有任何 v1 契约路径」`,
      );
    }
  }
  if (existsSync(join(GIT_FIXTURE_DIR, FIXTURE_SHA.baseMissing))) {
    throw new ContractControlError(
      CONTROL_DIAGNOSIS.fixtureMissing,
      `${GIT_FIXTURE_DIR}/${FIXTURE_SHA.baseMissing} 不该存在 —— 它必须是一个读不出来的 base`,
    );
  }
}

// ---------------------------------------------------------------------------
// 运行器
// ---------------------------------------------------------------------------

function readBaseline() {
  const load = (relPath) => {
    const text = readFixtureFile(join(REPO_ROOT, relPath), `已提交的契约快照 ${relPath}`);
    return { text, document: JSON.parse(text) };
  };
  return { openapi: load(CONTRACT_PATHS.openapi), errorCatalog: load(CONTRACT_PATHS.errorCatalog) };
}

export function allCases() {
  return [
    ...MUTATION_CASES.map((item) => ({ ...item, kind: item.kind ?? 'mutation' })),
    ...SECURITY_FIXTURE_CASES,
    ...BASE_CASES,
    ...BOOTSTRAP_CASES,
  ];
}

export function parseArgs(argv) {
  const args = { json: false, quiet: false, keepTemp: false, only: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--quiet') args.quiet = true;
    else if (token === '--keep-temp') args.keepTemp = true;
    else if (token === '--list') args.list = true;
    else if (token === '--only') args.only = argv[(i += 1)];
    else throw new Error(`未知参数：${token}`);
  }
  return args;
}

/**
 * 跑全部对照用例。不写 stdout —— 输出格式由 CLI 决定，测试直接断言返回的报告。
 *
 * @returns {{ok:boolean,total:number,passed:number,failed:string[],groups:object,results:Array,workRoot:string|null}}
 */
export function runControl(options = {}) {
  assertPlatformIndependence();

  const only = options.only ?? null;
  const baseline = readBaseline();
  const cases = allCases().filter((item) => only === null || item.id.startsWith(only));
  if (only !== null && cases.length === 0) {
    throw new ContractControlError(
      CONTROL_DIAGNOSIS.expectation,
      `--only ${only} 没有匹配到任何用例（--list 看全部 id）`,
    );
  }

  const workRoot = mkdtempSync(join(tmpdir(), 'littleq-contract-control-'));
  const results = [];
  try {
    for (const testCase of cases) {
      let outcome;
      try {
        if (testCase.kind === 'fixturePair') outcome = runFixturePairCase(testCase);
        else if (testCase.kind === 'transport') outcome = runTransportCase(testCase, { workRoot });
        else if (testCase.kind === 'baseDir') {
          // base 目录存在但里面没有快照 —— 这就是 §4.2 C 第 5 条的「模拟 base 文件缺失」。
          const emptyBase = join(workRoot, `${testCase.id}-empty-base`);
          mkdirSync(emptyBase, { recursive: true });
          const headRoot = join(workRoot, testCase.id);
          writeHeadTree(headRoot, {
            openapi: baseline.openapi.text,
            errorCatalog: baseline.errorCatalog.text,
          });
          const result = invokeCompat({ repoRoot: headRoot, baseDir: emptyBase });
          outcome = { result, problems: checkExpectation(testCase, result) };
        } else outcome = runMutationCase(testCase, { baseline, workRoot });
      } catch (error) {
        outcome = {
          result: null,
          problems: [
            error instanceof ContractControlError || error instanceof ContractCompatError
              ? `${error.diagnosis ?? error.name}：${error.message}`
              : `${error.name}: ${error.message}`,
          ],
        };
      }
      results.push({
        id: testCase.id,
        group: testCase.group,
        spec: testCase.spec,
        ok: outcome.problems.length === 0,
        exitCode: outcome.result?.exitCode ?? null,
        diagnosis: outcome.result?.diagnosis ?? null,
        rules: outcome.result?.report ? [...rulesOf(outcome.result.report)].sort() : [],
        problems: outcome.problems,
      });
    }
  } finally {
    if (options.keepTemp !== true) rmSync(workRoot, { recursive: true, force: true });
  }

  return {
    ok: results.every((item) => item.ok),
    total: results.length,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).map((item) => item.id),
    groups: Object.fromEntries(
      Object.keys(GROUPS)
        .sort()
        .map((key) => [key, results.filter((item) => item.group === key).length]),
    ),
    results,
    workRoot: options.keepTemp === true ? workRoot : null,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`!! ${error.message}\n`);
    process.exit(2);
  }

  if (args.list) {
    for (const item of allCases()) process.stdout.write(`${item.id}\t${item.group}\n`);
    process.exit(0);
  }

  let report;
  try {
    report = runControl({ quiet: args.quiet, keepTemp: args.keepTemp, only: args.only });
  } catch (error) {
    const diagnosis =
      error instanceof ContractControlError ? error.diagnosis : CONTROL_DIAGNOSIS.crashed;
    process.stderr.write(`!! ${diagnosis}\n${error.stack ?? error.message}\n`);
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  const line = (text = '') => {
    if (!args.quiet) process.stdout.write(`${text}\n`);
  };
  line('== 契约门禁对照用例 ==');
  line(`  基线：仓库内已提交的 ${CONTRACT_PATHS.openapi} 与 ${CONTRACT_PATHS.errorCatalog}`);
  const red = report.results.filter((item) => item.exitCode !== 0).length;
  line(`  用例：${report.total} 条（期望红 ${red} / 期望绿 ${report.total - red}）`);
  line('');
  for (const item of report.results) {
    line(`  ${item.ok ? '✓' : '✗'} ${item.id}  → exit ${item.exitCode}`);
    for (const problem of item.problems) line(`      ${problem}`);
  }
  if (report.workRoot !== null) line(`\n  （--keep-temp：临时目录保留在 ${report.workRoot}）`);
  line('');

  if (report.ok) {
    line(`结果：${report.passed}/${report.total} 条对照全部符合 §4.2 B 的方差方向。`);
    line('每条用例都先证明了「目标 JSON Pointer 存在且变异计数恰好为 1」，所以这里没有零变异空绿。');
    process.exit(0);
  }

  process.stderr.write(
    `!! ${CONTROL_DIAGNOSIS.expectation}\n` +
      `   ${report.failed.length}/${report.total} 条对照失败：${report.failed.join(', ')}\n` +
      '   比较器的方向判定与 §4.2 B 的方差表不一致，或者控制用例自己的锚点失效了。\n' +
      '   两种情况都不许放行：前者是契约门禁坏了，后者是这道门禁在空转。\n',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}


// 供 tools/test/*.test.mjs 直接驱动（同一份用例表，不在测试里重写一遍）。
export { GROUPS, SECURITY_FIXTURE_DIR, BOOTSTRAP_HEAD_DIR, GIT_FIXTURE_DIR, validBootstrap };

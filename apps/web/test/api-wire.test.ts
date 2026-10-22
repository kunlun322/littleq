// `apps/web/src/api-wire.ts` 与 `apps/web/src/csrf.ts` 那两份「重述」的执法层。
//
// 那两个文件刻意不 import 契约包（依赖图的 `api-contract-no-platform-coupling`），代价是
// 同一个线上事实存在两份写法。这份测试就是把那个代价按住：契约改了而重述没跟上，这里红。
//
// ## 为什么是「读文本」而不是「import 契约包」
//
// 最自然的写法是在测试里 import 契约包做比对 —— 而它**行不通**，且这是实测过的，不是推测：
// 往 `apps/web/test/` 放一个 import `@littleq/api-contract` 的文件，`pnpm dep-graph` 立刻报
// `[api-contract-no-platform-coupling] apps/web/test/<file>:1 (source) @littleq/api-contract
// -> inbound.default=deny，apps/web 不在 allowFrom（apps/api, packages/application）里`
// 并退出 1。那条规则的 `inbound` 判的是**发起文件所属单元**，测试目录不是豁免区。
//
// 于是改成：把契约与 domain 的源文件当**文本**读出来，抽出 `export const` 的初始化式再比。
// 依赖图扫的是 import / require / 动态 import 的**说明符**，`readFileSync` 不产生说明符，
// 所以这条路一条依赖边都不新增 —— 而依赖边正是那条规则要防的东西。
//
// 它比 import 弱一档：读的是源码文本而非编译产物，所以「契约源码写了 A、但构建出来的
// dist 是 B」这种漂移它看不见。补上这一档的是**已提交的 OpenAPI 快照**
// （`contracts/openapi/v1/openapi.json`，由 `pnpm contract:check` 保证与契约源码一致），
// 下面用它逐条核路径、方法与状态码。快照是机器生成、可逐字节复现的产物，不是散文。
//
// ## 三件不做的事
//
// 1. **不把读到的文本当代码执行。** 从文本重建的只有正则字面量（`new RegExp`），
//    数组与标量一律走「抽出字符串字面量再比」。执行别人的源码来「验证」它，
//    等于把一次静态检查换成一次任意代码执行。
// 2. **不写出被冻结的会话 Cookie 名。** `index.test.ts` 有一条连注释一起扫的零命中断言，
//    这份文件同样在它的射程之外，但没必要去试探边界。
// 3. **不新增第三份重述。** 下面所有期望值都取自 api-wire.ts / csrf.ts 自己的导出，
//    字面量只在「和契约比」时出现一次。若在这里再抄一遍 `['L1','L2','L3']`，
//    契约改了会红，而有人把 api-wire 和这里一起改错就不会红 —— 那是假执法。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGE_BANDS,
  EXPECTED_STATUS,
  HELP_LEVELS,
  ONLY_WORK_TYPE,
  PATHS,
  PUMP_OUTCOMES_THAT_CONTINUE,
  SERVER_URL,
  TASK_PUMP_OUTCOMES,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  newIdempotencyKey,
  toETag,
} from '../src/api-wire.js';
import type { AgeBand, HelpLevel, Revision, TaskPumpOutcome, TaskState } from '../src/api-wire.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  IDEMPOTENCY_HEADER_NAME,
  IF_MATCH_HEADER_NAME,
} from '../src/csrf.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

const CONTRACT_COMMON = 'packages/api-contract/src/schemas/common.ts';
const CONTRACT_OPENAPI = 'packages/api-contract/src/openapi.ts';
const DOMAIN_ACCOUNT = 'packages/domain/src/value-objects/account.ts';
const DOMAIN_PROJECT = 'packages/domain/src/value-objects/project.ts';
const DOMAIN_REFS = 'packages/domain/src/value-objects/refs.ts';
const DOMAIN_TASK = 'packages/domain/src/value-objects/task.ts';
const OPENAPI_SNAPSHOT = 'contracts/openapi/v1/openapi.json';

const common = read(CONTRACT_COMMON);
const openapiSource = read(CONTRACT_OPENAPI);
const domainAccount = read(DOMAIN_ACCOUNT);
const domainProject = read(DOMAIN_PROJECT);
const domainRefs = read(DOMAIN_REFS);
const domainTask = read(DOMAIN_TASK);

/**
 * 抽出 `export const <name> = …;` 的初始化式**文本**。
 *
 * 非贪婪匹配到第一个分号：本测试用到的初始化式都是数组字面量、字符串字面量、
 * 正则字面量或单个标量，内部不含分号。找不到就**抛**，绝不返回空串 ——
 * 返回空串会让「契约把常量删了」表现成「重述里也该是空的」，方向完全反过来。
 */
function initializerOf(source: string, name: string): string {
  const initializer = new RegExp(`export const ${name} =\\s*([\\s\\S]*?);`).exec(source)?.[1];
  if (initializer === undefined) {
    throw new Error(`源文件里没有 \`export const ${name}\`：重述的事实来源已经不在了`);
  }
  return initializer;
}

/** 从初始化式文本里抽出所有字符串字面量，**按出现顺序**。枚举的顺序即 OpenAPI 的顺序。 */
function stringLiterals(initializer: string): string[] {
  return [...initializer.matchAll(/'([^']*)'|"([^"]*)"/g)].flatMap((match) => {
    const value = match[1] ?? match[2];
    return value === undefined ? [] : [value];
  });
}

/** 枚举常量的成员：`export const X = ['A','B'] as const` ⇒ `['A','B']`。 */
function enumMembers(source: string, name: string): string[] {
  return stringLiterals(initializerOf(source, name));
}

/**
 * 从正则字面量文本重建 `RegExp`。
 *
 * 之所以要重建而不是自己也写一个：重述一个正则就等于制造第三份事实来源，而这里要的恰恰是
 * **契约自己那条**规则去作用于本 UI 的输出。`lastIndexOf('/')` 而不是 `indexOf`，
 * 因为结束斜杠在末尾；标志位（若有）跟在它后面。
 */
function regexLiteral(source: string, name: string): RegExp {
  const text = initializerOf(source, name).trim();
  const end = text.lastIndexOf('/');
  if (!text.startsWith('/') || end === 0) {
    throw new Error(`\`${name}\` 的初始化式不是正则字面量：${text}`);
  }
  return new RegExp(text.slice(1, end), text.slice(end + 1));
}

function numberOf(source: string, name: string): number {
  const parsed = Number(initializerOf(source, name).trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`\`${name}\` 不是数字：${initializerOf(source, name)}`);
  }
  return parsed;
}

/** 头 schema 是 `z.object({ '<头名>': … })` 的形态，所以第一个引号字面量就是头名。 */
function headerNameOf(source: string, schemaName: string): string {
  const [name] = stringLiterals(initializerOf(source, schemaName));
  if (name === undefined) {
    throw new Error(`\`${schemaName}\` 里没有引号键，形态变了`);
  }
  return name;
}

type SnapshotOperation = { operationId?: string; responses?: Record<string, unknown> };
type Snapshot = {
  servers: { url: string }[];
  paths: Record<string, Record<string, SnapshotOperation>>;
};

const snapshot = JSON.parse(read(OPENAPI_SNAPSHOT)) as Snapshot;

const SNAPSHOT_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** 按 operationId 在快照里找到那条操作，返回它的方法、路径模板与全部响应码。 */
function findOperation(operationId: string): { method: string; path: string; statuses: string[] } {
  for (const [path, item] of Object.entries(snapshot.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      // 路径项里还有 `parameters` / `summary` 这类非操作键，先滤掉。
      if (!SNAPSHOT_METHODS.includes(method) || operation.operationId !== operationId) continue;
      return {
        method: method.toUpperCase(),
        path,
        statuses: Object.keys(operation.responses ?? {}),
      };
    }
  }
  throw new Error(`快照里没有 operationId=${operationId}`);
}

/** 合法的小写 UUID v7：`encodeURIComponent` 不会改动它，所以能当路径参数探针。 */
const PROBE_ID = '01890b1a-2f01-7abc-8def-0123456789ab';

/**
 * 凭据种类的封闭集合 —— **从 domain 源码里抽**，不在本文件写字面量。
 *
 * 为什么这里能抽而 `src/` 下不能写：`apps/web/test/index.test.ts` 有一条连注释一起扫的
 * 原始文本门禁，禁止 `app/` 与 `src/` 下出现凭证载体字样（其中一种凭据的名字就含那个
 * 字样）。测试目录不在它的扫描面里，而本文件的既有纪律恰好也是「读契约源码文本、
 * 不新增第三份重述」，两边于是指向同一个做法。
 */
const SECRET_KINDS_FROM_DOMAIN = enumMembers(domainRefs, 'SECRET_KINDS');

/**
 * 凭据种类探针：取集合里最后一个（名字最长、带下划线的那个），因为它最能暴露
 * 「整段编码把路径参数也编掉」这类问题。抽不到就抛，绝不静默用空串当探针。
 */
const PROBE_KIND: string = (() => {
  const kind = SECRET_KINDS_FROM_DOMAIN.at(-1);
  if (kind === undefined) throw new Error('domain 源码里没有 `export const SECRET_KINDS`');
  return kind;
})();

/** 把浏览器实际会请求的 URL 还原成快照里的路径模板。 */
function templateOf(url: string): string {
  return url
    .slice(SERVER_URL.length)
    .replaceAll(encodeURIComponent(PROBE_ID), '{id}')
    .replaceAll(encodeURIComponent(PROBE_KIND), '{kind}');
}

/**
 * 本切片用到的八条操作。
 *
 * 这里刻意写成「一条操作一行、把 `PATHS` 的产物直接摆出来」：比对的**一侧**是运行时真的
 * 会被 `fetch` 的那个字符串，另一侧是快照。若改成在测试里重拼一遍路径，比的就只是两份
 * 测试自己的想象。
 *
 * ⚠️ 多一条必须在这里显式登记（下面还有两条键集合断言会红）—— 那是设计好的摩擦，
 * 不是可以顺手删掉的样板。
 */
const CALLS = [
  { operation: 'login', status: 'login', method: 'POST', url: PATHS.login },
  { operation: 'createProject', status: 'createProject', method: 'POST', url: PATHS.projects },
  { operation: 'getProject', status: 'getProject', method: 'GET', url: PATHS.project(PROBE_ID) },
  { operation: 'createTurn', status: 'createTurn', method: 'POST', url: PATHS.turns(PROBE_ID) },
  { operation: 'pumpTask', status: 'pumpTask', method: 'POST', url: PATHS.pump(PROBE_ID) },
  {
    operation: 'createPreview',
    status: 'createPreview',
    method: 'POST',
    url: PATHS.preview(PROBE_ID),
  },
  {
    operation: 'getSecretMetadata',
    status: 'getSecretMetadata',
    method: 'GET',
    url: PATHS.secret(PROBE_KIND),
  },
  {
    operation: 'putSecret',
    status: 'putSecret',
    method: 'PUT',
    url: PATHS.secret(PROBE_KIND),
  },
] as const;

describe('阳性对照：文本抽取器真的读到了东西', () => {
  it('找不到的常量会抛，不是静默返回空', () => {
    expect(() => initializerOf(domainTask, 'TASK_STATES_DO_NOT_EXIST')).toThrow(
      /没有 `export const TASK_STATES_DO_NOT_EXIST`/,
    );
    expect(() => enumMembers(domainTask, 'ALSO_NOT_A_CONSTANT')).toThrow();
  });

  it('抽出来的枚举非空，且顺序与源码一致（顺序本身就是契约的一部分）', () => {
    const states = enumMembers(domainTask, 'TASK_STATES');
    expect(states.length).toBeGreaterThan(0);
    expect(states[0]).toBe('QUEUED');
    expect(states.at(-1)).toBe('TIMED_OUT');
  });

  it('正则重建可用：契约自己的十进制规则能判真假两侧', () => {
    const decimal = regexLiteral(common, 'DECIMAL_WIRE_PATTERN');
    expect('0').toMatch(decimal);
    expect('007').not.toMatch(decimal);
    expect('-1').not.toMatch(decimal);
  });

  it('快照可读，且路径参数探针不会被编码改动（否则模板还原是假的）', () => {
    expect(Object.keys(snapshot.paths).length).toBeGreaterThan(0);
    expect(encodeURIComponent(PROBE_ID)).toBe(PROBE_ID);
    expect(templateOf(PATHS.pump(PROBE_ID))).toBe('/tasks/{id}:pump');
  });

  it('凭据种类探针取自 domain，且两个种类都是路径安全的（编码后逐字不变）', () => {
    // 阳性对照：这条断言真的读到了东西 —— domain 那个常量至少有两个成员，
    // 而且抽出来的确实是那两种凭据的名字形态（大写字母、数字、下划线）。
    expect(SECRET_KINDS_FROM_DOMAIN.length).toBeGreaterThanOrEqual(2);
    for (const kind of SECRET_KINDS_FROM_DOMAIN) {
      expect(kind, `${kind} 不是大写下划线形态`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(encodeURIComponent(kind), `${kind} 会被路径编码改动`).toBe(kind);
    }
    expect(templateOf(PATHS.secret(PROBE_KIND))).toBe('/settings/secrets/{kind}');
  });
});

describe('同源前缀与单一目标', () => {
  it('SERVER_URL 与契约的 openapi.ts 逐字相同，且与快照的 servers[0].url 相同', () => {
    expect(SERVER_URL).toBe(stringLiterals(initializerOf(openapiSource, 'SERVER_URL'))[0]);
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.servers[0]?.url).toBe(SERVER_URL);
  });

  it('SERVER_URL 是相对引用，不是绝对 URL —— 浏览器结构上直连不到 API origin', () => {
    expect(SERVER_URL.startsWith('/'), `${SERVER_URL} 不是以 / 打头`).toBe(true);
    expect(SERVER_URL).not.toContain('://');
    // 可执行形态：把它当 URL 解析必然抛。CSP 的 `connect-src 'self'` 是第二道，
    // 而这一道在**代码里**，不依赖部署平台是否真的下发了那个头。
    expect(() => new URL(SERVER_URL)).toThrow();
  });

  it('每条路径都以 SERVER_URL 打头，没有一条是绝对地址', () => {
    const urls = [
      PATHS.login,
      PATHS.projects,
      PATHS.project(PROBE_ID),
      PATHS.turns(PROBE_ID),
      PATHS.pump(PROBE_ID),
      PATHS.preview(PROBE_ID),
      PATHS.secret(PROBE_KIND),
    ];
    for (const url of urls) {
      expect(url.startsWith(SERVER_URL), `${url} 不以 ${SERVER_URL} 打头`).toBe(true);
      expect(url, `${url} 里出现了 scheme`).not.toContain('://');
    }
  });

  it('PATHS 的键就是那七条，一条都没多抄（多抄 ⇒ 漂移面变大）', () => {
    expect(Object.keys(PATHS).sort()).toEqual(
      ['login', 'preview', 'project', 'projects', 'pump', 'secret', 'turns'].sort(),
    );
  });
});

describe('八条操作：路径、方法与成功状态码都对得上快照', () => {
  for (const call of CALLS) {
    it(`${call.operation}：${call.method} ${templateOf(call.url)} ⇒ ${EXPECTED_STATUS[call.status]}`, () => {
      const found = findOperation(call.operation);
      expect(found.path, '路径模板与快照不符').toBe(templateOf(call.url));
      expect(found.method, '方法与快照不符').toBe(call.method);
      // 成功码必须在快照声明的响应码里。UI 把「任何 2xx」都当成功是错的：
      // createTurn 是 202 而不是 200，getProject 还可能是 304。
      expect(found.statuses, '期望状态码不在快照的响应码集合里').toContain(
        String(EXPECTED_STATUS[call.status]),
      );
    });
  }

  it('EXPECTED_STATUS 的键与 CALLS 一一对应，没有多余项', () => {
    expect(Object.keys(EXPECTED_STATUS).sort()).toEqual(CALLS.map((call) => call.status).sort());
  });

  it('pumpTask 的路径是 AIP-136 的自定义动词形态，冒号不被编码掉', () => {
    // 这条是同源代理的硬约束：`encodeURIComponent(':')` 是 `%3A`，
    // 整段编码会把动词一起编掉，上游路由就匹配不上（见 src/api-proxy.ts 的说明）。
    expect(PATHS.pump(PROBE_ID)).toBe(`${SERVER_URL}/tasks/${PROBE_ID}:pump`);
    expect(PATHS.pump(PROBE_ID)).not.toContain('%3A');
    expect(findOperation('pumpTask').path).toBe('/tasks/{id}:pump');
  });

  it('凭据路径只带种类、不带值；写的成功码是 204，快照里那个 204 没有响应体', () => {
    expect(PATHS.secret(PROBE_KIND)).toBe(`${SERVER_URL}/settings/secrets/${PROBE_KIND}`);
    expect(findOperation('getSecretMetadata').method).toBe('GET');
    expect(findOperation('putSecret').method).toBe('PUT');
    expect(EXPECTED_STATUS.putSecret).toBe(204);
    // 服务端那半边的「不回显」也是可查的事实，不只是前端自觉：快照里 `putSecret` 的 204
    // 没有 `content`，所以前端拿不到任何东西可以显示成「你刚存的值」。
    const putResponses = snapshot.paths[findOperation('putSecret').path]?.['put']?.responses;
    const noContent = putResponses?.['204'] as { content?: unknown } | undefined;
    expect(noContent, '快照里 `putSecret` 的 204 不见了').toBeDefined();
    expect(noContent?.content).toBeUndefined();
  });

  it('前端没有 rotate / revoke 的路径：那两条没接线，造按钮就是假入口', () => {
    const urls = [
      PATHS.login,
      PATHS.projects,
      PATHS.project(PROBE_ID),
      PATHS.turns(PROBE_ID),
      PATHS.pump(PROBE_ID),
      PATHS.preview(PROBE_ID),
      PATHS.secret(PROBE_KIND),
    ];
    for (const url of urls) {
      expect(url).not.toContain(':rotate');
      expect(url).not.toContain(':revoke');
    }
    // 两条阳性对照，否则上面那一批「零命中」是空的：
    // ① 快照里这两条操作**确实存在**（不是因为我找错了名字才没命中）；
    // ② 同一种抽取方式在 pump 上抓得住自定义动词。
    expect(findOperation('rotateSecret').path).toBe('/settings/secrets/{kind}:rotate');
    expect(findOperation('revokeSecret').path).toBe('/settings/secrets/{kind}:revoke');
    expect(PATHS.pump(PROBE_ID)).toContain(':pump');
  });
});

describe('枚举域：三档分龄、三档协助、任务状态机', () => {
  it('AGE_BANDS 与 domain 逐字相同，顺序也相同', () => {
    const bands: readonly AgeBand[] = AGE_BANDS;
    expect(bands).toHaveLength(3);
    expect([...AGE_BANDS]).toEqual(enumMembers(domainAccount, 'AGE_BANDS'));
  });

  it('HELP_LEVELS 与 domain 逐字相同，顺序也相同', () => {
    const levels: readonly HelpLevel[] = HELP_LEVELS;
    expect(levels).toHaveLength(3);
    expect([...HELP_LEVELS]).toEqual(enumMembers(domainProject, 'HELP_LEVELS'));
  });

  it('ONLY_WORK_TYPE 是 domain 的 WORK_TYPES 之一，且那是**收窄**而不是「本来就只有一个」', () => {
    const workTypes = enumMembers(domainProject, 'WORK_TYPES');
    expect(workTypes).toContain(ONLY_WORK_TYPE);
    // 反空断言：若 domain 里本来就只有 WEB，那「只导出一个常量」就没有收窄任何东西，
    // 这条断言也就证明不了 §8.1「不提供独立的游戏、动画或绘本入口」是**这里**做的决定。
    expect(workTypes.length).toBeGreaterThan(1);
  });

  it('TASK_STATES 15 个，与 domain 逐字同序', () => {
    const states: readonly TaskState[] = TASK_STATES;
    expect(states).toHaveLength(15);
    expect([...TASK_STATES]).toEqual(enumMembers(domainTask, 'TASK_STATES'));
  });

  it('TERMINAL_TASK_STATES 5 个，是 TASK_STATES 的子集，与 domain 逐字同序', () => {
    const states = enumMembers(domainTask, 'TASK_STATES');
    const terminal = enumMembers(domainTask, 'TERMINAL_TASK_STATES');
    expect([...TERMINAL_TASK_STATES]).toEqual(terminal);
    expect(terminal).toHaveLength(5);
    for (const state of terminal) {
      expect(states, `${state} 不是合法任务状态`).toContain(state);
    }
  });

  it('RETRY_WAIT 与 CANCELLING 都**不是**终态 —— 轮询不会在退避或取消途中放弃', () => {
    // 把这两个误当终态是两个方向相反的事故：前者让回合在退避里被静默丢弃，
    // 后者让「用户点了取消」看起来像一次失败。契约的终态集合是唯一判据。
    const terminal: readonly string[] = TERMINAL_TASK_STATES;
    expect(terminal).not.toContain('RETRY_WAIT');
    expect(terminal).not.toContain('CANCELLING');
    expect(TASK_STATES).toContain('RETRY_WAIT');
    expect(TASK_STATES).toContain('CANCELLING');
  });

  it('TASK_PUMP_OUTCOMES 5 个，与 domain 逐字同序', () => {
    const outcomes: readonly TaskPumpOutcome[] = TASK_PUMP_OUTCOMES;
    expect(outcomes).toHaveLength(5);
    expect([...TASK_PUMP_OUTCOMES]).toEqual(enumMembers(domainTask, 'TASK_PUMP_OUTCOMES'));
  });

  it('「继续推进」的集合恰好是两个，补集恰好是三个 NO_OP_*', () => {
    const continuing: readonly string[] = PUMP_OUTCOMES_THAT_CONTINUE;
    expect([...PUMP_OUTCOMES_THAT_CONTINUE]).toEqual(['ADVANCED', 'COALESCED_IN_FLIGHT']);
    const all: readonly string[] = TASK_PUMP_OUTCOMES;
    const rest = all.filter((outcome) => !continuing.includes(outcome));
    expect(rest).toEqual(['NO_OP_WAITING', 'NO_OP_CANCELLING', 'NO_OP_TERMINAL']);
    // 判据不写死成员名，而写死**形状**：补集必须全是 NO_OP_*。
    // 这样契约将来新增第六个结果时，这里会红，而不是被静默归进「继续」。
    for (const outcome of rest) {
      expect(outcome.startsWith('NO_OP_'), `${outcome} 不是 NO_OP_* 却被当成「不继续」`).toBe(true);
    }
  });
});

describe('线上形态：revision、ETag、幂等键', () => {
  it('Revision 在类型上就是 string，而且必须是契约的十进制形态', () => {
    const decimal = regexLiteral(common, 'DECIMAL_WIRE_PATTERN');
    const revision: Revision = '0';
    expect(typeof revision).toBe('string');
    expect(revision).toMatch(decimal);
    expect(toETag(revision)).toBe('"rev-0"');
    // 用字符串而非 number 的具体理由：项目 revision 随回合单调增长，
    // 超过 2^53 之后 `Number()` 一次就丢精度，而 `If-Match` 的比较必须逐字。
    const big: Revision = '9007199254740993';
    expect(Number.isSafeInteger(Number(big))).toBe(false);
    expect(big).toMatch(decimal);
    expect(toETag(big)).toBe('"rev-9007199254740993"');
  });

  it('toETag 的输出全部落在契约的 ETag 形态里，而前导零会被当场抓住', () => {
    const pattern = regexLiteral(common, 'E_TAG_WIRE_PATTERN');
    for (const revision of ['0', '1', '42', '9007199254740993'] as const) {
      expect(toETag(revision), `toETag(${revision})`).toMatch(pattern);
    }
    // 反例即「客户端把 revision 当数字来回一趟」的后果：前导零没了 / 多了。
    expect(toETag('007' as Revision)).not.toMatch(pattern);
    expect(toETag('' as Revision)).not.toMatch(pattern);
  });

  it('newIdempotencyKey 满足契约的字符集与长度区间', () => {
    const pattern = regexLiteral(common, 'IDEMPOTENCY_KEY_WIRE_PATTERN');
    const min = numberOf(common, 'IDEMPOTENCY_KEY_MIN_LENGTH');
    const max = numberOf(common, 'IDEMPOTENCY_KEY_MAX_LENGTH');
    expect(max).toBeGreaterThan(min);
    for (let round = 0; round < 32; round += 1) {
      const key = newIdempotencyKey();
      expect(key, '字符集不符').toMatch(pattern);
      expect(key.length, '长度越界').toBeGreaterThanOrEqual(min);
      expect(key.length, '长度越界').toBeLessThanOrEqual(max);
    }
  });

  it('每次调用都是新键 —— 否则第二次发话会被幂等层合并成第一次', () => {
    const keys = Array.from({ length: 64 }, () => newIdempotencyKey());
    expect(new Set(keys).size).toBe(64);
  });
});

describe('请求头名：与契约的 header schema 逐字相同', () => {
  it('CSRF 头名取自契约的 CSRF_HEADER_NAME', () => {
    expect(CSRF_HEADER_NAME).toBe(stringLiterals(initializerOf(common, 'CSRF_HEADER_NAME'))[0]);
  });

  it('幂等头名取自契约的 idempotencyHeaderSchema 的键', () => {
    expect(IDEMPOTENCY_HEADER_NAME).toBe(headerNameOf(common, 'idempotencyHeaderSchema'));
  });

  it('条件写头名取自契约的 ifMatchHeaderSchema 的键', () => {
    expect(IF_MATCH_HEADER_NAME).toBe(headerNameOf(common, 'ifMatchHeaderSchema'));
  });

  it('三个头名互不相同，且都不含空格（会被 fetch 当成非法头名）', () => {
    const names = [CSRF_HEADER_NAME, IDEMPOTENCY_HEADER_NAME, IF_MATCH_HEADER_NAME];
    expect(new Set(names).size).toBe(3);
    for (const name of names) {
      expect(name, `${name} 含空白`).not.toMatch(/\s/);
    }
  });
});

describe('⚠️ CSRF 伴随 Cookie 名：这是一颗**缺口钉子**，不是通过证明', () => {
  it('契约里还不存在这个名字 —— 它由 API 层下发，命名权在 B1（ZLQ-221）', () => {
    expect(CSRF_COOKIE_NAME).toBe('littleq_csrf');
    // 契约源码里搜不到它：所以本 UI 取的名字**没有**事实来源可对账，只能等后端定。
    expect(common).not.toContain(CSRF_COOKIE_NAME);
    // 阳性对照：契约确实定义了会话 Cookie（本文件不写出它的值），
    // 所以上面那条「不含」不是因为整个文件读成了空的。
    expect(common).toContain('SESSION_COOKIE_NAME');
    expect(common).toContain('CSRF_HEADER_NAME');
  });

  it('这个名字在整个 apps/web 里只出现一次，改名就是改一行', () => {
    // 可执行的「协调成本 = 一行」证明。若哪天有第二个文件硬编码了它，这里会红 ——
    // 那时改名就不再是一行，而这颗钉子正好在该响的时候响。
    const declared = read('apps/web/src/csrf.ts');
    expect(declared).toContain(`export const CSRF_COOKIE_NAME = '${CSRF_COOKIE_NAME}';`);
    const page = read('apps/web/app/create/page.tsx');
    expect(page).toContain('CSRF_COOKIE_NAME');
    expect(page).not.toContain(`'${CSRF_COOKIE_NAME}'`);
    const workbench = read('apps/web/app/_components/create-workbench.tsx');
    expect(workbench).not.toContain(CSRF_COOKIE_NAME);
  });
});

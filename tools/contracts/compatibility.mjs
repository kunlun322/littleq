#!/usr/bin/env node
// 语义兼容性门禁 `contract:compat`（附录 A §4.2 B + 附录 B G1）。
//
// 本文件分三层，边界是刻意的：
//
//   1. **判定核心**（`compareContracts` / `compareOpenApi` / `compareErrorCatalog`）是纯函数：
//      输入两份已解析的文档，输出 findings。不读文件系统、不读 git、不看 `process.platform`、
//      不碰 `node_modules`。§7.3 第 6 条「comparator 不依赖 host OS / node_modules /
//      当前 Git 安装状态」指的就是这一层，控制用例（contract:control）也只驱动这一层。
//   2. **base 获取**（`resolveBase`）是唯一允许触达外部状态的地方，而且它是**可注入**的：
//      生产用 `createGitTransport`，控制用例用 `createFixtureTransport`（仓库内固定字节）。
//      注入的是「怎么把字节取回来」，不是「怎么判定」—— 判定逻辑永远只有一份，
//      满足 §4.2 C「控制必须调用生产使用的同一个 compatibility 入口，不得复制判断逻辑」。
//   3. **bootstrap 判定**（`evaluateBootstrap`）按附录 B 的四个条件逐条走，任一不满足
//      要么退回正常比较（base 已有 snapshot），要么红（SHA 不匹配），要么 exit 2（base 不可读）。
//
// ## 基线解析（附录 B G1）
//
// | 事件 | `CONTRACT_BASE_SHA` |
// |---|---|
// | `push` | `github.event.before` |
// | `pull_request` | `github.event.pull_request.base.sha` |
// | `workflow_dispatch` | 必填 input `contract_base_sha` |
//
// 这三条都在 `.github/workflows/ci.yml` 的解析步骤里完成，通过环境变量注入本命令；
// 本命令自己**不解析 GitHub 事件负载**（那会让判定核心依赖 CI 运行时）。
// 显式优先级：`--base-dir` / `--base-file` > `--base-sha` > `$CONTRACT_BASE_SHA` > bootstrap。
//
// **基线不可得一律 fail closed**：exit 2 / `CONTRACT_BASE_UNAVAILABLE`。绝不回退到
// `HEAD^`、当前工作树、head 自身快照，也绝不因为「拿不到 base」就跳过比较（§4.2 B）。
//
// ## 退出码
//
//   0  与 base 兼容，或命中唯一一次合法 bootstrap
//   1  发现破坏性变更（含「保守按破坏性处理」的三类），或 bootstrap 前置条件不成立
//   2  基线/头快照不可得、不可读、不可解析（`CONTRACT_BASE_UNAVAILABLE` 等）
//
// 用法：
//   pnpm contract:compat [--base-dir DIR | --base-file F [--base-error-file F]]
//                        [--head-dir DIR | --head-file F [--head-error-file F]]
//                        [--base-sha SHA] [--repo-root DIR] [--git-root DIR]
//                        [--json] [--quiet] [--max-findings N]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  COMMIT_SHA_PATTERN,
  CONTRACT_PATHS,
  DESIGN_BASELINE_SHA,
  REPO_ROOT,
  compareCodePoints,
  normalizeKeys,
  sha256Hex,
} from './generate.mjs';

// ---------------------------------------------------------------------------
// 诊断码
// ---------------------------------------------------------------------------

export const DIAGNOSIS = Object.freeze({
  baseUnavailable: 'CONTRACT_BASE_UNAVAILABLE',
  headMissing: 'CONTRACT_HEAD_SNAPSHOT_MISSING',
  headUnparseable: 'CONTRACT_HEAD_SNAPSHOT_UNPARSEABLE',
  baseUnparseable: 'CONTRACT_BASE_SNAPSHOT_UNPARSEABLE',
  bootstrapInvalid: 'CONTRACT_BOOTSTRAP_INVALID',
  breakingOperationRemoved: 'OPENAPI_BREAKING_OPERATION_REMOVED',
  crashed: 'CONTRACT_COMPAT_CRASHED',
});

// 设计基线与 SHA 形状都住在 generate.mjs：bootstrap.json 由生成器写出，判定方必须读同一份
// 定义，否则「生成时用的常量」和「校验时用的常量」会各自漂移。
export { DESIGN_BASELINE_SHA };

const ZERO_SHA = '0'.repeat(40);
const MAX_SCHEMA_DEPTH = 48;

// bootstrap 一旦有其中任意一条路径存在于 base，就永久失效（附录 B）。
// 注意这里刻意**包含 bootstrap.json 自己**：把 bootstrap 文件单独留在 base 里、
// 只删两份 snapshot，不应该能再骗到一次首落。
const V1_CONTRACT_PATHS = Object.freeze([
  CONTRACT_PATHS.openapi,
  CONTRACT_PATHS.errorCatalog,
  CONTRACT_PATHS.bootstrap,
]);

// head/base 快照的 [报告字段名, 仓库相对路径] 对。两条 snapshot 永远成对处理 ——
// 只比其中一条等于给契约开了个「改错误目录不算改契约」的口子。
const SNAPSHOT_PATHS = Object.freeze([
  ['openapi', CONTRACT_PATHS.openapi],
  ['errorCatalog', CONTRACT_PATHS.errorCatalog],
]);

const SNAPSHOT_SHA_PATTERN = /^[0-9a-f]{64}$/;

export class ContractCompatError extends Error {
  constructor(diagnosis, message) {
    super(message);
    this.name = 'ContractCompatError';
    this.diagnosis = diagnosis;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// `node:fs` 没有 `isDirectory` 这个导出（它是 `Dirent` 上的方法），所以自己写一个。
// statSync 抛错（路径不存在 / 无权限）一律当作「不是目录」，与 existsSync 的语义一致：
// fixture transport 用「目录不存在」来表达「这个 commit 取不到」，那正是想要的结果。
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonicalJson(value) {
  return JSON.stringify(normalizeKeys(value));
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodePoints);
}

function describeValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '<undefined>';
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

// ---------------------------------------------------------------------------
// 1. 判定核心：schema 层事实
// ---------------------------------------------------------------------------

// 比较器**建模**了的 JSON Schema / OpenAPI 关键字。任何不在这里、又不是 `x-` 扩展的键，
// 都会产出 `keywordUnknown` 事实并按破坏性处理（§4.2 B「保守按破坏性处理：
// …无法识别的 schema keyword。Stage 1 不静默放行」）。
//
// 这份清单不是猜的：它覆盖了当前生成文档里实际出现的全部关键字，并由
// `packages/api-contract/test/openapi.test.ts` 钉住「真实文档 0 个未知关键字」。
// 将来 zod-openapi 开始产出新关键字时，那条测试会先红，逼人回来显式建模，
// 而不是让比较器在看不见的地方悄悄放行。
const KNOWN_SCHEMA_KEYWORDS = new Set([
  '$comment',
  '$defs',
  '$id',
  '$ref',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'deprecated',
  'description',
  'enum',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'not',
  'nullable',
  'oneOf',
  'pattern',
  'patternProperties',
  'properties',
  'propertyNames',
  'readOnly',
  'required',
  'title',
  'type',
  'unevaluatedProperties',
  'writeOnly',
]);

// 改了也不影响任何客户端/服务端行为的键。§4.2 B：「只修改 description/example/tag」非破坏。
const METADATA_KEYWORDS = new Set(['$comment', 'deprecated', 'description', 'examples', 'title']);

const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'];
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'];

// 事实（fact）是**方向性**的中间结论，还不是判定：
//   direction 'narrow' = 接受/产出的集合变小；'widen' = 变大；
//   'both' = 说不清方向（换了类型、换了 $ref、改了 pattern 内容…）；
//   'presence' = 讲的是「字段必然存在」这个保证，不是值集合；
//   'neutral' = 与兼容性无关。
// 方向到判定的映射由 classifyFact 按 position 完成 —— 这正是生产者/消费者方差的落点。
function fact(kind, direction, extra = {}) {
  return { kind, direction, ...extra };
}

function isRefSchema(value) {
  return isPlainObject(value) && typeof value.$ref === 'string';
}

function refName(value) {
  const prefix = '#/components/schemas/';
  return value.$ref.startsWith(prefix) ? value.$ref.slice(prefix.length) : null;
}

// 把 `$ref` 解开一层（最多 8 跳，防环）。返回 undefined 表示引用悬空 —— 那本身就是一个
// 必须报出来的事实，不能当成「schema 消失了」。
function resolveRef(value, doc, seen = new Set()) {
  if (!isRefSchema(value)) return { schema: value, dangling: false };
  const name = refName(value);
  if (name === null || seen.has(value.$ref)) return { schema: undefined, dangling: true };
  const target = doc?.components?.schemas?.[name];
  if (target === undefined) return { schema: undefined, dangling: true };
  return resolveRef(target, doc, new Set([...seen, value.$ref]));
}

function isNullSchema(value) {
  if (!isPlainObject(value)) return false;
  return value.type === 'null' || (Array.isArray(value.type) && value.type.length === 1 && value.type[0] === 'null');
}

// 把两种 nullable 编码统一成 `{ nullable, schema }`：
//   OpenAPI 3.1 的 `anyOf: [X, {type:'null'}]`（zod-openapi 对可空 $ref 的产出）
//   与 `type: ['string','null']`（对可空原始类型的产出）
// 不统一的话，同一处可空性变化会在两条分支上各报一次，或者一次都不报。
function splitNullable(schema) {
  if (!isPlainObject(schema)) return { nullable: false, schema };
  let nullable = schema.nullable === true;
  let rest = schema;

  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    nullable = true;
    const others = schema.type.filter((item) => item !== 'null');
    rest = { ...rest, type: others.length === 1 ? others[0] : others };
    if (others.length === 0) delete rest.type;
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.some(isNullSchema)) {
    nullable = true;
    const others = schema.anyOf.filter((item) => !isNullSchema(item));
    rest = { ...rest };
    delete rest.anyOf;
    if (others.length === 1) rest = { ...rest, ...others[0] };
    else if (others.length > 1) rest.anyOf = others;
  }

  return { nullable, schema: rest };
}

function typeSetOf(schema) {
  if (typeof schema.type === 'string') return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type);
  return new Set();
}

function boundOf(schema, keys) {
  for (const key of keys) {
    if (typeof schema[key] === 'number') {
      return { value: schema[key], exclusive: key.startsWith('exclusive') };
    }
  }
  return null;
}

// exclusive 比 inclusive 更紧；同值时 exclusive 收紧了一端。
function boundTighter(a, b, isLower) {
  if (a.value !== b.value) return isLower ? a.value > b.value : a.value < b.value;
  return a.exclusive !== b.exclusive ? a.exclusive : null;
}

function additionalStrictness(schema) {
  if (!Object.hasOwn(schema, 'additionalProperties')) return 'absent';
  const value = schema.additionalProperties;
  if (value === false) return 'closed';
  if (value === true) return 'open';
  return isPlainObject(value) ? 'schema' : 'open';
}

// 每一次 schema 比较都要一份**新的** ctx：`facts` 是本次的输出，`depth` 是本次的递归深度，
// 共用一份会让兄弟调用互相污染深度。
//
// `baseDoc` / `headDoc` 必须是真文档，不能是 null：`resolveRef` 靠它们解开 `$ref`。本文档
// 里每一个参数、requestBody、响应体的 schema 都是 `$ref`，传 null 会让它们**全部**被判成
// danglingRef，整份契约假红 183 处。
function schemaDiffContext(docs) {
  return { facts: [], depth: 0, baseDoc: docs.baseDoc, headDoc: docs.headDoc };
}

// 递归比较两份 schema，产出事实。pointer 用于诊断，不参与判定。
function diffSchemas(base, head, pointer, ctx) {
  if (ctx.depth >= MAX_SCHEMA_DEPTH) {
    ctx.facts.push(fact('depthExceeded', 'both', { pointer }));
    return;
  }

  const resolvedBase = resolveRef(base, ctx.baseDoc);
  const resolvedHead = resolveRef(head, ctx.headDoc);
  if (resolvedBase.dangling || resolvedHead.dangling) {
    ctx.facts.push(
      fact('danglingRef', 'both', {
        pointer,
        base: resolvedBase.dangling ? base?.$ref : undefined,
        head: resolvedHead.dangling ? head?.$ref : undefined,
      }),
    );
    return;
  }
  // 两侧都指向同一个 component：内容变化由 component 层比较负责，这里不重复报，
  // 否则一次 `UuidV7` 改动会在 28 个 operation 上各刷一遍。
  if (isRefSchema(base) && isRefSchema(head) && base.$ref === head.$ref) return;
  if (isRefSchema(base) && isRefSchema(head)) {
    ctx.facts.push(fact('refChanged', 'both', { pointer, base: base.$ref, head: head.$ref }));
    return;
  }

  const b = resolvedBase.schema;
  const h = resolvedHead.schema;
  if (b === undefined && h === undefined) return;
  if (b === undefined) {
    ctx.facts.push(fact('schemaAdded', 'widen', { pointer, head: h }));
    return;
  }
  if (h === undefined) {
    ctx.facts.push(fact('schemaRemoved', 'narrow', { pointer, base: b }));
    return;
  }
  if (!isPlainObject(b) || !isPlainObject(h)) {
    if (!Object.is(b, h)) ctx.facts.push(fact('typeChanged', 'both', { pointer, base: b, head: h }));
    return;
  }

  const depth = ctx.depth + 1;
  // 只负责把 depth +1；pointer 由 at() 单独拼，ctx 里没有 pointer 字段。
  const child = () => ({ ...ctx, depth, facts: ctx.facts });
  const at = (suffix) => `${pointer}/${suffix}`;

  // 未建模关键字：两侧都要扫。head 侧的新关键字是「比较器看不见」，base 侧的消失同样看不见。
  for (const [side, schema] of [
    ['base', b],
    ['head', h],
  ]) {
    for (const key of Object.keys(schema)) {
      if (KNOWN_SCHEMA_KEYWORDS.has(key) || key.startsWith('x-')) continue;
      ctx.facts.push(fact('keywordUnknown', 'both', { pointer, keyword: key, side }));
    }
  }

  // 元数据关键字：§4.2 B 明列「只修改 description/example/tag」是非破坏变更。这里显式比一次
  // 并报成 compatible，而不是让它们静默通过 —— 「比较过并判定为兼容」与「根本没看这个字段」
  // 必须在报告里能区分开，否则对照用例 metadata-only 拿不到任何可断言的证据。
  for (const keyword of METADATA_KEYWORDS) {
    const bv = b[keyword];
    const hv = h[keyword];
    if (canonicalJson(bv ?? null) === canonicalJson(hv ?? null)) continue;
    ctx.facts.push(fact('metadataChanged', 'neutral', { pointer, field: keyword, base: bv, head: hv }));
  }

  const bn = splitNullable(b);
  const hn = splitNullable(h);
  const bs = bn.schema;
  const hs = hn.schema;

  if (bn.nullable !== hn.nullable) {
    ctx.facts.push(
      fact(hn.nullable ? 'toNullable' : 'toNonNullable', hn.nullable ? 'widen' : 'narrow', { pointer }),
    );
  }

  const bTypes = typeSetOf(bs);
  const hTypes = typeSetOf(hs);
  if (canonicalJson(sortedUnique([...bTypes])) !== canonicalJson(sortedUnique([...hTypes]))) {
    ctx.facts.push(
      fact('typeChanged', 'both', { pointer, base: sortedUnique([...bTypes]), head: sortedUnique([...hTypes]) }),
    );
  }

  // enum：成员的增删就是接受/产出集合的放宽与收窄。
  if (Array.isArray(bs.enum) || Array.isArray(hs.enum)) {
    const bSet = new Set((bs.enum ?? []).map(canonicalJson));
    const hSet = new Set((hs.enum ?? []).map(canonicalJson));
    const added = [...hSet].filter((item) => !bSet.has(item));
    const removed = [...bSet].filter((item) => !hSet.has(item));
    if (added.length > 0) ctx.facts.push(fact('enumAdded', 'widen', { pointer, members: added }));
    if (removed.length > 0) ctx.facts.push(fact('enumRemoved', 'narrow', { pointer, members: removed }));
  }

  // const 是只有一个成员的 enum。
  const bHasConst = Object.hasOwn(bs, 'const');
  const hHasConst = Object.hasOwn(hs, 'const');
  if (bHasConst && hHasConst && canonicalJson(bs.const) !== canonicalJson(hs.const)) {
    ctx.facts.push(fact('constChanged', 'both', { pointer, base: bs.const, head: hs.const }));
  } else if (bHasConst !== hHasConst) {
    ctx.facts.push(fact(hHasConst ? 'constChanged' : 'constChanged', hHasConst ? 'narrow' : 'widen', { pointer }));
  }

  for (const [keys, isLower, kind] of [
    [LOWER_BOUNDS, true, 'lowerBound'],
    [UPPER_BOUNDS, false, 'upperBound'],
  ]) {
    const bBound = boundOf(bs, keys);
    const hBound = boundOf(hs, keys);
    if (bBound === null && hBound === null) continue;
    if (bBound === null) {
      ctx.facts.push(fact('boundTightened', 'narrow', { pointer, bound: kind, head: hBound }));
      continue;
    }
    if (hBound === null) {
      ctx.facts.push(fact('boundLoosened', 'widen', { pointer, bound: kind, base: bBound }));
      continue;
    }
    const tighter = boundTighter(hBound, bBound, isLower);
    if (tighter === null) continue;
    ctx.facts.push(
      fact(tighter ? 'boundTightened' : 'boundLoosened', tighter ? 'narrow' : 'widen', {
        pointer,
        bound: kind,
        base: bBound,
        head: hBound,
      }),
    );
  }

  for (const key of ['pattern', 'format']) {
    const bv = typeof bs[key] === 'string' ? bs[key] : null;
    const hv = typeof hs[key] === 'string' ? hs[key] : null;
    if (bv === hv) continue;
    if (bv === null) ctx.facts.push(fact(`${key}Added`, 'narrow', { pointer, head: hv }));
    else if (hv === null) ctx.facts.push(fact(`${key}Removed`, 'widen', { pointer, base: bv }));
    else ctx.facts.push(fact(`${key}Changed`, 'both', { pointer, base: bv, head: hv }));
  }

  // default 只落在 `ListLimit` / `LedgerLimit` / `LedgerExportFormat` 这类请求侧 schema 上：
  // 改了默认值，老客户端省略该字段时观察到的行为就变了。响应侧的 default 无意义。
  if (canonicalJson(bs.default) !== canonicalJson(hs.default)) {
    ctx.facts.push(fact('defaultChanged', 'both', { pointer, base: bs.default, head: hs.default }));
  }

  // 对象：properties / required / additionalProperties / propertyNames
  const bProps = isPlainObject(bs.properties) ? bs.properties : {};
  const hProps = isPlainObject(hs.properties) ? hs.properties : {};
  const bRequired = new Set(Array.isArray(bs.required) ? bs.required : []);
  const hRequired = new Set(Array.isArray(hs.required) ? hs.required : []);

  for (const name of sortedUnique([...Object.keys(bProps), ...Object.keys(hProps)])) {
    const propPointer = `${at('properties')}/${name}`;
    if (!Object.hasOwn(bProps, name)) {
      ctx.facts.push(
        fact(hRequired.has(name) ? 'propertyAddedRequired' : 'propertyAddedOptional', 'neutral', {
          pointer: propPointer,
          property: name,
        }),
      );
      // 新增属性的**方向**已经被上面那条 propertyAdded* 事实说完了（请求侧可选=兼容、
      // 请求侧必填=破坏、响应侧一律=兼容，见 classifyFact）。这里再走一遍新子树，目的
      // 只有一个：把子树里**未建模的 schema keyword** 扫出来 —— 比较器看不懂的约束不能
      // 因为「它是新加的」就静默放行（§4.2 B 把未识别 keyword 归为保守破坏性）。
      //
      // 实现上是让新 schema 与它自己比：全深度遍历、零方差事实。看起来像笔误，所以写清楚
      // 为什么不是 `diffSchemas(undefined, hProps[name], …)` —— 那样会在 propertyAdded*
      // 之外再产出一条 schemaAdded → OPENAPI_BREAKING_TYPE_CHANGED，把 §4.2 B 明列的
      // 「新增 optional 请求字段」和「新增响应字段」两类非破坏变更判成红灯。
      // 代价：新属性若是 `$ref`，两侧同 ref 会在 diffSchemas 开头提前返回，
      // 悬空 ref 不在这里报（component 层负责 components 的增删）。
      diffSchemas(hProps[name], hProps[name], propPointer, child());
      continue;
    }
    if (!Object.hasOwn(hProps, name)) {
      ctx.facts.push(fact('propertyRemoved', 'both', { pointer: propPointer, property: name }));
      continue;
    }
    diffSchemas(bProps[name], hProps[name], propPointer, child());
  }

  for (const name of sortedUnique([...bRequired, ...hRequired])) {
    if (bRequired.has(name) === hRequired.has(name)) continue;
    // 新增属性带来的 required 已经由 propertyAddedRequired 表达，这里只处理
    // 「同一个属性从可选变必填 / 从必填变可选」。
    if (!Object.hasOwn(bProps, name) || !Object.hasOwn(hProps, name)) continue;
    ctx.facts.push(
      fact(hRequired.has(name) ? 'requiredAdded' : 'requiredRemoved', 'presence', {
        pointer: at('required'),
        property: name,
      }),
    );
  }

  const bStrict = additionalStrictness(bs);
  const hStrict = additionalStrictness(hs);
  if (bStrict !== hStrict) {
    const rank = { closed: 0, schema: 1, absent: 2, open: 3 };
    ctx.facts.push(
      fact(
        rank[hStrict] < rank[bStrict] ? 'additionalTightened' : 'additionalLoosened',
        rank[hStrict] < rank[bStrict] ? 'narrow' : 'widen',
        { pointer: at('additionalProperties'), base: bStrict, head: hStrict },
      ),
    );
  }
  if (isPlainObject(bs.additionalProperties) || isPlainObject(hs.additionalProperties)) {
    diffSchemas(
      isPlainObject(bs.additionalProperties) ? bs.additionalProperties : undefined,
      isPlainObject(hs.additionalProperties) ? hs.additionalProperties : undefined,
      at('additionalProperties'),
      child(),
    );
  }
  if (isPlainObject(bs.propertyNames) || isPlainObject(hs.propertyNames)) {
    diffSchemas(bs.propertyNames, hs.propertyNames, at('propertyNames'), child());
  }

  // 数组
  if (bs.items !== undefined || hs.items !== undefined) {
    diffSchemas(bs.items, hs.items, at('items'), child());
  }

  // 组合子：anyOf 按**集合**比（增删成员就是 §4.2 B 的 union 成员增删），
  // allOf / oneOf 按下标比 —— §4.1 明确 oneOf 的顺序有语义，不能重排后当集合比。
  if (Array.isArray(bs.anyOf) || Array.isArray(hs.anyOf)) {
    const bSet = new Set((bs.anyOf ?? []).map(canonicalJson));
    const hSet = new Set((hs.anyOf ?? []).map(canonicalJson));
    const added = [...hSet].filter((item) => !bSet.has(item));
    const removed = [...bSet].filter((item) => !hSet.has(item));
    if (added.length > 0) ctx.facts.push(fact('anyOfAdded', 'widen', { pointer: at('anyOf'), members: added }));
    if (removed.length > 0) ctx.facts.push(fact('anyOfRemoved', 'narrow', { pointer: at('anyOf'), members: removed }));
  }
  for (const keyword of ['allOf', 'oneOf']) {
    const bList = Array.isArray(bs[keyword]) ? bs[keyword] : null;
    const hList = Array.isArray(hs[keyword]) ? hs[keyword] : null;
    if (bList === null && hList === null) continue;
    if (bList === null || hList === null) {
      ctx.facts.push(fact('typeChanged', 'both', { pointer: at(keyword), base: bList, head: hList }));
      continue;
    }
    if (bList.length !== hList.length) {
      ctx.facts.push(
        fact('typeChanged', 'both', { pointer: at(keyword), base: bList.length, head: hList.length }),
      );
      continue;
    }
    for (let index = 0; index < bList.length; index += 1) {
      diffSchemas(bList[index], hList[index], `${at(keyword)}/${index}`, child());
    }
  }
  if (bs.not !== undefined || hs.not !== undefined) {
    diffSchemas(bs.not, hs.not, at('not'), child());
  }
  if (isPlainObject(bs.patternProperties) || isPlainObject(hs.patternProperties)) {
    const bKeys = Object.keys(bs.patternProperties ?? {});
    const hKeys = Object.keys(hs.patternProperties ?? {});
    for (const key of sortedUnique([...bKeys, ...hKeys])) {
      diffSchemas(
        bs.patternProperties?.[key],
        hs.patternProperties?.[key],
        `${at('patternProperties')}/${key}`,
        child(),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. 判定核心：方向 → 判定
// ---------------------------------------------------------------------------

// 生产者/消费者方差的唯一落点。同一个事实在请求位与响应位得到**相反**的判定：
// 请求侧收窄 = 服务端接受得更少 = 破坏老客户端；响应侧扩大 = 服务端可能吐出更多 =
// 破坏老客户端的假设。§4.2 B 的两张清单就是这张表的自然语言版。
function classifyFact(item, position) {
  const { kind, direction } = item;

  switch (kind) {
    case 'metadataChanged':
      // 与 position 无关：元数据在请求位和响应位一样不影响线上行为。
      return { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_METADATA_ONLY' };
    case 'keywordUnknown':
      return { severity: 'conservative', rule: 'OPENAPI_BREAKING_SCHEMA_KEYWORD_UNKNOWN' };
    case 'depthExceeded':
    case 'danglingRef':
    case 'refChanged':
    case 'constChanged':
    case 'patternChanged':
    case 'formatChanged':
      return { severity: 'conservative', rule: 'OPENAPI_BREAKING_CONSERVATIVE_UNMODELLED' };
    case 'typeChanged':
    case 'schemaRemoved':
      return { severity: 'breaking', rule: 'OPENAPI_BREAKING_TYPE_CHANGED' };
    case 'schemaAdded':
      return { severity: 'breaking', rule: 'OPENAPI_BREAKING_TYPE_CHANGED' };
    case 'propertyRemoved':
      return position === 'request'
        ? { severity: 'conservative', rule: 'OPENAPI_BREAKING_REQUEST_FIELD_REMOVED' }
        : { severity: 'breaking', rule: 'OPENAPI_BREAKING_RESPONSE_FIELD_REMOVED' };
    case 'propertyAddedRequired':
      return position === 'request'
        ? { severity: 'breaking', rule: 'OPENAPI_BREAKING_REQUEST_FIELD_REQUIRED_ADDED' }
        : { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_RESPONSE_FIELD_ADDED' };
    case 'propertyAddedOptional':
      return position === 'request'
        ? { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_REQUEST_FIELD_OPTIONAL_ADDED' }
        : { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_RESPONSE_FIELD_ADDED' };
    case 'requiredAdded':
      return position === 'request'
        ? { severity: 'breaking', rule: 'OPENAPI_BREAKING_REQUEST_FIELD_MADE_REQUIRED' }
        : { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_RESPONSE_FIELD_MADE_REQUIRED' };
    case 'requiredRemoved':
      return position === 'request'
        ? { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_REQUEST_FIELD_MADE_OPTIONAL' }
        : { severity: 'breaking', rule: 'OPENAPI_BREAKING_RESPONSE_FIELD_MADE_OPTIONAL' };
    case 'additionalTightened':
      return position === 'request'
        ? { severity: 'breaking', rule: 'OPENAPI_BREAKING_REQUEST_NARROWED' }
        : { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_RESPONSE_NARROWED' };
    case 'additionalLoosened':
      // 响应侧放开 additionalProperties 等价于「以后可能多几个字段」，
      // §4.2 B 已裁定新增响应字段非破坏（JSON 客户端必须忽略未知字段）。
      return position === 'request'
        ? { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_REQUEST_WIDENED' }
        : { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_RESPONSE_FIELD_ADDED' };
    case 'defaultChanged':
      return position === 'request'
        ? { severity: 'conservative', rule: 'OPENAPI_BREAKING_REQUEST_DEFAULT_CHANGED' }
        : { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_METADATA_ONLY' };
    default:
      break;
  }

  // 其余事实都是纯方向性的，按 position 套方差。
  if (direction === 'neutral') return null;
  if (direction === 'both') {
    return { severity: 'breaking', rule: 'OPENAPI_BREAKING_TYPE_CHANGED' };
  }
  const narrowed = direction === 'narrow';
  if (position === 'request') {
    return narrowed
      ? { severity: 'breaking', rule: 'OPENAPI_BREAKING_REQUEST_NARROWED' }
      : { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_REQUEST_WIDENED' };
  }
  return narrowed
    ? { severity: 'compatible', rule: 'OPENAPI_COMPATIBLE_RESPONSE_NARROWED' }
    : { severity: 'breaking', rule: 'OPENAPI_BREAKING_RESPONSE_WIDENED' };
}

function findingFromFact(item, position, basePointer, positionNote) {
  const classified = classifyFact(item, position);
  if (classified === null) return null;
  return {
    rule: classified.rule,
    severity: classified.severity,
    position,
    fact: item.kind,
    pointer: item.pointer ?? basePointer,
    detail: [
      positionNote,
      item.property ? `属性 ${item.property}` : null,
      item.field ? `元数据字段 ${item.field}` : null,
      item.keyword ? `未建模关键字 ${item.keyword}（出现在 ${item.side}）` : null,
      item.bound ? `边界 ${item.bound}` : null,
      item.members ? `成员 ${item.members.map(describeValue).join(', ')}` : null,
      item.base !== undefined ? `base=${describeValue(item.base)}` : null,
      item.head !== undefined ? `head=${describeValue(item.head)}` : null,
    ]
      .filter(Boolean)
      .join('；'),
  };
}

// 一份 schema 的事实按它被使用的**每个位置**各判一次。同时出现在请求位与响应位的
// component（例如 `Timestamp`）会产出两条 finding —— 这不是重复，而是两个方向的
// 消费者各自受到的影响，取其中更严的那条决定门禁颜色。
function findingsFromFacts(facts, positions, basePointer, note) {
  const out = [];
  for (const item of facts) {
    for (const position of positions) {
      const finding = findingFromFact(item, position, basePointer, note);
      if (finding !== null) out.push(finding);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 判定核心：OpenAPI 文档
// ---------------------------------------------------------------------------

const HTTP_METHOD_KEYS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function operationsOf(doc) {
  const out = [];
  const paths = isPlainObject(doc?.paths) ? doc.paths : {};
  for (const pathTemplate of Object.keys(paths).sort(compareCodePoints)) {
    const item = paths[pathTemplate];
    if (!isPlainObject(item)) continue;
    for (const method of Object.keys(item).sort(compareCodePoints)) {
      if (!HTTP_METHOD_KEYS.has(method)) continue;
      out.push({ pathTemplate, method, operation: item[method] });
    }
  }
  return out;
}

function operationKey({ pathTemplate, method }) {
  return `${method.toUpperCase()} ${pathTemplate}`;
}

function escapeToken(token) {
  return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}

function operationPointer({ pathTemplate, method }) {
  return `/paths/${escapeToken(pathTemplate)}/${method}`;
}

// operationKey 的逆运算。只按**第一个**空格切分，method 之后全部算路径 ——
// path template 里出现空格不会把它切错（`key.split(' ')[1]` 会）。
function pointerOfOperationKey(key) {
  const space = key.indexOf(' ');
  const method = key.slice(0, space).toLowerCase();
  const pathTemplate = key.slice(space + 1);
  return operationPointer({ pathTemplate, method });
}

function parameterKey(parameter) {
  return `${parameter?.in ?? '?'}:${parameter?.name ?? '?'}`;
}

// security 的规范形：一组「分支」，每个分支是排序后的 scheme 名列表（AND），
// 分支之间是 OR，空列表就是匿名 `{}`。规范化成这个形状之后，§4.2 B 的六条 security
// 规则全部退化成子集关系判断。
function securityBranches(security) {
  if (security === undefined) return null; // 未声明 = 继承顶层，与 `[]`（显式匿名）不同
  if (!Array.isArray(security)) return null;
  return security.map((requirement) =>
    isPlainObject(requirement) ? Object.keys(requirement).sort(compareCodePoints) : [],
  );
}

function branchLabel(branch) {
  return branch.length === 0 ? '{}（匿名）' : `{ ${branch.join(' AND ')} }`;
}

function branchKey(branch) {
  return JSON.stringify(branch);
}

function isSubset(inner, outer) {
  const set = new Set(outer);
  return inner.every((item) => set.has(item));
}

// 返回 security 的 findings。算法：先按规范形做集合差，再把「base 分支消失 + head 分支新增」
// 配成对，用子集关系区分「在现有对象内加/减 AND scheme」与「增/删 OR 分支」。
function compareSecurity(base, head, pointer) {
  const bBranches = securityBranches(base);
  const hBranches = securityBranches(head);
  if (bBranches === null && hBranches === null) return [];
  if (bBranches === null || hBranches === null) {
    return [
      {
        rule: 'OPENAPI_BREAKING_CONSERVATIVE_UNMODELLED',
        severity: 'conservative',
        position: 'security',
        fact: 'securityDeclarationChanged',
        pointer,
        detail: `security 从「${bBranches === null ? '未声明（继承顶层）' : '显式声明'}」变成「${
          hBranches === null ? '未声明（继承顶层）' : '显式声明'
        }」，语义无法从文档本身判定，保守按破坏性处理`,
      },
    ];
  }

  const bKeys = new Map(bBranches.map((branch) => [branchKey(branch), branch]));
  const hKeys = new Map(hBranches.map((branch) => [branchKey(branch), branch]));
  const removed = bBranches.filter((branch) => !hKeys.has(branchKey(branch)));
  const added = hBranches.filter((branch) => !bKeys.has(branchKey(branch)));
  const findings = [];

  // 配对：B ⊂ H 是「在现有对象内增加 AND scheme」= 收紧；H ⊂ B 是「从对象移除 scheme」= 放宽。
  const pairedRemoved = new Set();
  const pairedAdded = new Set();
  for (const b of removed) {
    for (const h of added) {
      if (pairedAdded.has(branchKey(h))) continue;
      if (isSubset(b, h) && b.length < h.length) {
        pairedRemoved.add(branchKey(b));
        pairedAdded.add(branchKey(h));
        findings.push({
          rule: 'OPENAPI_BREAKING_SECURITY_TIGHTENED',
          severity: 'breaking',
          position: 'security',
          fact: 'andSchemeAdded',
          pointer,
          detail: `在现有 Security Requirement Object 内增加了 AND scheme：${branchLabel(b)} → ${branchLabel(h)}`,
        });
        break;
      }
      if (isSubset(h, b) && h.length < b.length) {
        pairedRemoved.add(branchKey(b));
        pairedAdded.add(branchKey(h));
        findings.push({
          rule: 'OPENAPI_COMPATIBLE_SECURITY_LOOSENED',
          severity: 'compatible',
          position: 'security',
          fact: 'andSchemeRemoved',
          pointer,
          detail: `从 Security Requirement Object 移除了 AND scheme：${branchLabel(b)} → ${branchLabel(h)}`,
        });
        break;
      }
    }
  }

  for (const branch of removed) {
    if (pairedRemoved.has(branchKey(branch))) continue;
    findings.push({
      rule: 'OPENAPI_BREAKING_SECURITY_BRANCH_REMOVED',
      severity: 'breaking',
      position: 'security',
      fact: branch.length === 0 ? 'anonymousRemoved' : 'orBranchRemoved',
      pointer,
      detail:
        branch.length === 0
          ? '删除了匿名 `{}` 分支：原本可以不带凭证访问，现在收紧了'
          : `删除了 OR 分支 ${branchLabel(branch)}：原本可用的那条鉴权路径没了`,
    });
  }
  for (const branch of added) {
    if (pairedAdded.has(branchKey(branch))) continue;
    findings.push({
      rule: 'OPENAPI_COMPATIBLE_SECURITY_BRANCH_ADDED',
      severity: 'compatible',
      position: 'security',
      fact: branch.length === 0 ? 'anonymousAdded' : 'orBranchAdded',
      pointer,
      detail:
        branch.length === 0
          ? '新增了匿名 `{}` 分支：放宽（多了一条不需要凭证的路径）'
          : `新增了 OR 分支 ${branchLabel(branch)}：放宽（多了一条可用的鉴权路径）`,
    });
  }
  return findings;
}

// §4.2 B：「Cookie + CSRF 必须位于同一对象，表示 AND」。这是文档自身的良构性，
// 与 base 无关 —— head 里只要出现拆开的写法就报。
// §4.2 B「Cookie + CSRF 必须位于同一对象」的可判定形式。
//
// 这条规则与 base 无关，是对 head 的**良构性**检查：双提交 CSRF 的全部意义在于「token 与它
// 要保护的会话 cookie 一起到达」，所以凡是带了 `CsrfHeader` 的 Security Requirement Object
// 就必须同时带 `CookieAuth`。写成 `[{CookieAuth},{CsrfHeader}]` 是 OR —— 客户端可以只发
// token 不发 cookie，防护直接失效，这是本规则要抓的那一种。
//
// 反方向**不**成立：只带 `CookieAuth` 完全合法。§5.5 只要求**写**接口成对出现，而读接口
// （`GET /groups`、`GET /tasks/{id}` …）本来就只需要会话 cookie。把 XOR 当违规会让 10 个
// 正确的读接口永久假红，进而逼出 allowlist —— 那正是 §4.2 B 明令禁止的出口。
function findCsrfSplit(security, pointer) {
  if (!Array.isArray(security)) return [];
  const out = [];
  security.forEach((requirement, index) => {
    if (!isPlainObject(requirement)) return;
    const names = Object.keys(requirement);
    if (!names.includes('CsrfHeader') || names.includes('CookieAuth')) return;
    out.push({
      rule: 'OPENAPI_BREAKING_SECURITY_CSRF_SPLIT',
      severity: 'breaking',
      position: 'security',
      fact: 'csrfSplit',
      pointer: `${pointer}/${index}`,
      detail:
        `本对象带了 CsrfHeader 却没带 CookieAuth（当前只有 ${names.join(', ') || '<空>'}）。` +
        '顶层数组元素之间是 OR，客户端因此可以只提交 CSRF token 而不带会话 cookie，' +
        '双提交防护失效。§4.2 B 要求二者位于同一个 Security Requirement Object（AND）。',
    });
  });
  return out;
}

// 收集每个 component 被用在哪些位置。请求位与响应位分开，因为方差方向相反。
function componentPositions(doc) {
  const positions = new Map();
  const mark = (name, position) => {
    if (!positions.has(name)) positions.set(name, new Set());
    positions.get(name).add(position);
  };
  const seen = new Set();
  const walk = (schema, position, trail) => {
    if (!isPlainObject(schema) && !Array.isArray(schema)) return;
    const id = `${position}|${trail}`;
    if (seen.has(id)) return;
    seen.add(id);

    if (isRefSchema(schema)) {
      const name = refName(schema);
      if (name !== null) {
        mark(name, position);
        walk(doc?.components?.schemas?.[name], position, `${trail}>${name}`);
      }
      return;
    }
    if (Array.isArray(schema)) {
      schema.forEach((item, index) => walk(item, position, `${trail}[${index}]`));
      return;
    }
    for (const key of ['items', 'not', 'additionalProperties', 'propertyNames', 'unevaluatedProperties']) {
      if (schema[key] !== undefined) walk(schema[key], position, `${trail}.${key}`);
    }
    for (const key of ['anyOf', 'allOf', 'oneOf']) {
      if (Array.isArray(schema[key])) walk(schema[key], position, `${trail}.${key}`);
    }
    if (isPlainObject(schema.properties)) {
      for (const name of Object.keys(schema.properties)) {
        walk(schema.properties[name], position, `${trail}.properties.${name}`);
      }
    }
    if (isPlainObject(schema.patternProperties)) {
      for (const name of Object.keys(schema.patternProperties)) {
        walk(schema.patternProperties[name], position, `${trail}.patternProperties.${name}`);
      }
    }
    if (isPlainObject(schema.$defs)) {
      for (const name of Object.keys(schema.$defs)) walk(schema.$defs[name], position, `${trail}.$defs.${name}`);
    }
  };

  for (const { pathTemplate, method, operation } of operationsOf(doc)) {
    const pointer = operationPointer({ pathTemplate, method });
    const requestSchemas = [];
    for (const parameter of parametersOf(operation, doc.paths?.[pathTemplate])) {
      requestSchemas.push(parameter.schema);
    }
    const content = operation?.requestBody?.content;
    if (isPlainObject(content)) {
      for (const mediaType of Object.keys(content)) requestSchemas.push(content[mediaType]?.schema);
    }
    requestSchemas.forEach((schema, index) => walk(schema, 'request', `${pointer}#req${index}`));

    const responses = isPlainObject(operation?.responses) ? operation.responses : {};
    Object.keys(responses).forEach((status, statusIndex) => {
      const responseContent = responses[status]?.content;
      if (isPlainObject(responseContent)) {
        Object.keys(responseContent).forEach((mediaType, mediaIndex) => {
          walk(responseContent[mediaType]?.schema, 'response', `${pointer}#${statusIndex}.${mediaIndex}`);
        });
      }
      const headers = responses[status]?.headers;
      if (isPlainObject(headers)) {
        Object.keys(headers).forEach((headerName, headerIndex) => {
          walk(headers[headerName]?.schema, 'response', `${pointer}#${statusIndex}.h${headerIndex}`);
        });
      }
    });
  }

  for (const [name, set] of positions) positions.set(name, [...set].sort(compareCodePoints));
  return positions;
}

function parametersOf(operation, pathItem) {
  const shared = Array.isArray(pathItem?.parameters) ? pathItem.parameters : [];
  const own = Array.isArray(operation?.parameters) ? operation.parameters : [];
  return [...shared, ...own].filter(isPlainObject);
}

function compareParameterLists(baseParams, headParams, pointer, docs) {
  const findings = [];
  const bMap = new Map(baseParams.map((item) => [parameterKey(item), item]));
  const hMap = new Map(headParams.map((item) => [parameterKey(item), item]));

  for (const [key, parameter] of bMap) {
    if (!hMap.has(key)) {
      findings.push({
        rule: 'OPENAPI_BREAKING_PARAMETER_REMOVED',
        severity: 'conservative',
        position: 'request',
        fact: 'parameterRemoved',
        pointer: `${pointer}/parameters/${escapeToken(key)}`,
        detail: `删除了请求参数 ${key}。§4.2 B 未列举这一项，按「Stage 1 不静默放行」保守判破坏：老客户端仍会发它，而收紧了 additionalProperties 的 body 会直接拒`,
      });
      continue;
    }
    const headParameter = hMap.get(key);
    const becameRequired = headParameter.required === true && parameter.required !== true;
    if (becameRequired) {
      findings.push({
        rule: 'OPENAPI_BREAKING_PARAMETER_REQUIRED_ADDED',
        severity: 'breaking',
        position: 'request',
        fact: 'parameterRequiredAdded',
        pointer: `${pointer}/parameters/${escapeToken(key)}`,
        detail: `请求参数 ${key} 从可选变成必填`,
      });
    }
    if (parameter.required === true && headParameter.required !== true) {
      findings.push({
        rule: 'OPENAPI_COMPATIBLE_PARAMETER_MADE_OPTIONAL',
        severity: 'compatible',
        position: 'request',
        fact: 'parameterRequiredRemoved',
        pointer: `${pointer}/parameters/${escapeToken(key)}`,
        detail: `请求参数 ${key} 从必填变成可选（放宽）`,
      });
    }
    const ctx = schemaDiffContext(docs);
    diffSchemas(parameter.schema, headParameter.schema, `${pointer}/parameters/${escapeToken(key)}/schema`, ctx);
    findings.push(...findingsFromFacts(ctx.facts, ['request'], pointer, `参数 ${key} 的 schema`));
  }

  for (const [key, parameter] of hMap) {
    if (bMap.has(key)) continue;
    findings.push({
      rule:
        parameter.required === true
          ? 'OPENAPI_BREAKING_PARAMETER_REQUIRED_ADDED'
          : 'OPENAPI_COMPATIBLE_PARAMETER_OPTIONAL_ADDED',
      severity: parameter.required === true ? 'breaking' : 'compatible',
      position: 'request',
      fact: parameter.required === true ? 'parameterAddedRequired' : 'parameterAddedOptional',
      pointer: `${pointer}/parameters/${escapeToken(key)}`,
      detail:
        parameter.required === true
          ? `新增了必填请求参数 ${key}`
          : `新增了可选请求参数 ${key}（§4.2 B：非破坏）`,
    });
  }
  return findings;
}

function compareContentMaps(baseContent, headContent, pointer, position, label, docs) {
  const findings = [];
  const bTypes = Object.keys(isPlainObject(baseContent) ? baseContent : {});
  const hTypes = Object.keys(isPlainObject(headContent) ? headContent : {});
  for (const mediaType of sortedUnique([...bTypes, ...hTypes])) {
    const mediaPointer = `${pointer}/${escapeToken(mediaType)}`;
    if (!bTypes.includes(mediaType)) {
      findings.push({
        rule: position === 'request' ? 'OPENAPI_COMPATIBLE_REQUEST_MEDIA_TYPE_ADDED' : 'OPENAPI_COMPATIBLE_RESPONSE_MEDIA_TYPE_ADDED',
        severity: 'compatible',
        position,
        fact: 'mediaTypeAdded',
        pointer: mediaPointer,
        detail: `${label}新增了 media type ${mediaType}`,
      });
      continue;
    }
    if (!hTypes.includes(mediaType)) {
      findings.push({
        rule: position === 'request' ? 'OPENAPI_BREAKING_REQUEST_MEDIA_TYPE_REMOVED' : 'OPENAPI_BREAKING_RESPONSE_MEDIA_TYPE_REMOVED',
        severity: 'breaking',
        position,
        fact: 'mediaTypeRemoved',
        pointer: mediaPointer,
        detail: `${label}删除了 media type ${mediaType}`,
      });
      continue;
    }
    const ctx = schemaDiffContext(docs);
    diffSchemas(baseContent[mediaType]?.schema, headContent[mediaType]?.schema, `${mediaPointer}/schema`, ctx);
    findings.push(...findingsFromFacts(ctx.facts, [position], mediaPointer, `${label}的 ${mediaType} schema`));
  }
  return findings;
}

function compareResponseHeaders(baseHeaders, headHeaders, pointer, docs) {
  const findings = [];
  const bNames = Object.keys(isPlainObject(baseHeaders) ? baseHeaders : {});
  const hNames = Object.keys(isPlainObject(headHeaders) ? headHeaders : {});
  for (const name of sortedUnique([...bNames, ...hNames])) {
    const headerPointer = `${pointer}/${escapeToken(name)}`;
    if (!bNames.includes(name)) {
      findings.push({
        rule: 'OPENAPI_COMPATIBLE_RESPONSE_HEADER_ADDED',
        severity: 'compatible',
        position: 'response',
        fact: 'headerAdded',
        pointer: headerPointer,
        detail: `新增了响应 header ${name}`,
      });
      continue;
    }
    if (!hNames.includes(name)) {
      findings.push({
        rule: 'OPENAPI_BREAKING_RESPONSE_HEADER_REMOVED',
        severity: 'breaking',
        position: 'response',
        fact: 'headerRemoved',
        pointer: headerPointer,
        detail: `删除了响应 header ${name}`,
      });
      continue;
    }
    const bHeader = baseHeaders[name] ?? {};
    const hHeader = headHeaders[name] ?? {};
    if (bHeader.required === true && hHeader.required !== true) {
      findings.push({
        rule: 'OPENAPI_BREAKING_RESPONSE_HEADER_MADE_OPTIONAL',
        severity: 'breaking',
        position: 'response',
        fact: 'headerRequiredRemoved',
        pointer: headerPointer,
        detail: `响应 header ${name} 从必然出现变成可能出现（§4.2 B：required→optional 破坏）`,
      });
    }
    if (bHeader.required !== true && hHeader.required === true) {
      findings.push({
        rule: 'OPENAPI_COMPATIBLE_RESPONSE_HEADER_MADE_REQUIRED',
        severity: 'compatible',
        position: 'response',
        fact: 'headerRequiredAdded',
        pointer: headerPointer,
        detail: `响应 header ${name} 从可能出现变成必然出现（客户端可以开始依赖它）`,
      });
    }
    const ctx = schemaDiffContext(docs);
    diffSchemas(bHeader.schema, hHeader.schema, `${headerPointer}/schema`, ctx);
    findings.push(...findingsFromFacts(ctx.facts, ['response'], headerPointer, `响应 header ${name} 的 schema`));
  }
  return findings;
}

function compareErrorCodeExtension(base, head, pointer) {
  const bCodes = Array.isArray(base) ? base : null;
  const hCodes = Array.isArray(head) ? head : null;
  if (bCodes === null && hCodes === null) return [];
  if (bCodes === null || hCodes === null) {
    return [
      {
        rule: 'OPENAPI_BREAKING_CONSERVATIVE_UNMODELLED',
        severity: 'conservative',
        position: 'errors',
        fact: 'errorCodeExtensionPresence',
        pointer,
        detail: `x-littleq-error-codes 从${bCodes === null ? '缺失' : '存在'}变成${hCodes === null ? '缺失' : '存在'}`,
      },
    ];
  }
  const bSet = new Set(bCodes);
  const hSet = new Set(hCodes);
  const added = [...hSet].filter((code) => !bSet.has(code)).sort(compareCodePoints);
  const removed = [...bSet].filter((code) => !hSet.has(code)).sort(compareCodePoints);
  const findings = [];
  if (added.length > 0) {
    findings.push({
      rule: 'OPENAPI_BREAKING_ERROR_CODES_ADDED',
      severity: 'conservative',
      position: 'errors',
      fact: 'errorCodesAdded',
      pointer,
      detail: `operation 新挂载了错误码 ${added.join(', ')}（§4.2 B：新错误码保守按破坏性处理，Stage 1 不静默放行）`,
    });
  }
  if (removed.length > 0) {
    findings.push({
      rule: 'OPENAPI_COMPATIBLE_ERROR_CODES_REMOVED',
      severity: 'compatible',
      position: 'errors',
      fact: 'errorCodesRemoved',
      pointer,
      detail: `operation 不再挂载错误码 ${removed.join(', ')}（客户端为它写的分支变成死代码，但不会被新行为打到）`,
    });
  }
  return findings;
}

// §4.2 B 把「只修改 description/example/tag」列为非破坏。要让它可判定，比较器必须**看见**
// 这些字段并显式归类，而不是不比 —— 否则「比较过、判定兼容」与「根本没看」在报告里长得
// 一模一样。schema 内部的元数据关键字由 diffSchemas 负责（METADATA_KEYWORDS）；operation
// 与文档级的元数据不在任何 schema 里，所以在这里单独走一遍，规则名与 schema 侧保持一致。
const METADATA_ONLY_FIELDS = ['summary', 'description', 'deprecated', 'externalDocs', 'examples'];

function canonicalTags(tags) {
  // tags 是集合语义（§4.1：只对语义无序集合排序），顺序变化不算改动。
  // 文档级是 TagObject 数组、operation 级是字符串数组，统一投影成排序后的字符串再比。
  if (!Array.isArray(tags)) return tags;
  return tags.map((tag) => (isPlainObject(tag) ? canonicalJson(tag) : String(tag))).sort(compareCodePoints);
}

function compareMetadataOnly(base, head, pointer, label) {
  const findings = [];
  const report = (field, baseValue, headValue) => {
    if (canonicalJson(baseValue ?? null) === canonicalJson(headValue ?? null)) return;
    findings.push({
      rule: 'OPENAPI_COMPATIBLE_METADATA_ONLY',
      severity: 'compatible',
      position: 'metadata',
      fact: 'metadataChanged',
      pointer: `${pointer}/${field}`,
      detail:
        `${label} 的 ${field} 变了：${describeValue(baseValue)} → ${describeValue(headValue)}` +
        '（§4.2 B：只改 description/example/tag 属非破坏）',
    });
  };

  for (const field of METADATA_ONLY_FIELDS) report(field, base?.[field], head?.[field]);
  report('tags', canonicalTags(base?.tags), canonicalTags(head?.tags));
  return findings;
}

function compareOperations(baseDoc, headDoc) {
  const findings = [];
  // 下面每一处 schema 比较都要能解开 `$ref`，所以把两份文档整体带下去。
  const docs = { baseDoc, headDoc };
  const baseOps = operationsOf(baseDoc);
  const headOps = operationsOf(headDoc);
  const bByKey = new Map(baseOps.map((item) => [operationKey(item), item]));
  const hByKey = new Map(headOps.map((item) => [operationKey(item), item]));

  for (const [key, entry] of bByKey) {
    if (hByKey.has(key)) continue;
    findings.push({
      rule: DIAGNOSIS.breakingOperationRemoved,
      severity: 'breaking',
      position: 'operation',
      fact: 'operationRemoved',
      pointer: operationPointer(entry),
      detail: `删除了 operation ${key}（operationId ${entry.operation?.operationId ?? '<无>'}）`,
    });
  }
  for (const [key, entry] of hByKey) {
    if (bByKey.has(key)) continue;
    findings.push({
      rule: 'OPENAPI_COMPATIBLE_OPERATION_ADDED',
      severity: 'compatible',
      position: 'operation',
      fact: 'operationAdded',
      pointer: operationPointer(entry),
      detail: `新增了 operation ${key}（§4.2 B：非破坏）`,
    });
  }

  // operationId 的稳定性单独查一次：(method,path) 还在但 id 换了，客户端生成的方法名就变了。
  const bIds = new Map(baseOps.map((item) => [item.operation?.operationId, operationKey(item)]));
  const hIds = new Map(headOps.map((item) => [item.operation?.operationId, operationKey(item)]));
  for (const [operationId, key] of bIds) {
    if (operationId === undefined) continue;
    if (!hIds.has(operationId)) {
      if (!hByKey.has(key)) continue; // 整个 operation 都没了，已经报过 OPERATION_REMOVED
      findings.push({
        rule: 'OPENAPI_BREAKING_OPERATION_ID_CHANGED',
        severity: 'breaking',
        position: 'operation',
        fact: 'operationIdChanged',
        pointer: `${pointerOfOperationKey(key)}/operationId`,
        detail: `operationId ${operationId} 在 head 里不存在了（${key} 仍在，但换了 id）`,
      });
    } else if (hIds.get(operationId) !== key) {
      findings.push({
        rule: 'OPENAPI_BREAKING_OPERATION_ID_CHANGED',
        severity: 'breaking',
        position: 'operation',
        fact: 'operationIdMoved',
        // 指向 base 里的位置：id 是从这里挪走的，review 时要在旧契约里找到它。
        pointer: `${pointerOfOperationKey(key)}/operationId`,
        detail: `operationId ${operationId} 从 ${key} 挪到了 ${hIds.get(operationId)}`,
      });
    }
  }

  for (const [key, baseEntry] of bByKey) {
    const headEntry = hByKey.get(key);
    if (headEntry === undefined) continue;
    const baseOperation = baseEntry.operation ?? {};
    const headOperation = headEntry.operation ?? {};
    const pointer = operationPointer(baseEntry);

    findings.push(...compareMetadataOnly(baseOperation, headOperation, pointer, `operation ${key}`));

    findings.push(
      ...compareParameterLists(
        parametersOf(baseOperation, baseDoc.paths?.[baseEntry.pathTemplate]),
        parametersOf(headOperation, headDoc.paths?.[headEntry.pathTemplate]),
        pointer,
        docs,
      ),
    );

    const bBody = baseOperation.requestBody;
    const hBody = headOperation.requestBody;
    if (isPlainObject(bBody) && !isPlainObject(hBody)) {
      findings.push({
        rule: 'OPENAPI_BREAKING_REQUEST_BODY_REMOVED',
        severity: 'breaking',
        position: 'request',
        fact: 'requestBodyRemoved',
        pointer: `${pointer}/requestBody`,
        detail: '删除了 requestBody',
      });
    } else if (!isPlainObject(bBody) && isPlainObject(hBody)) {
      findings.push({
        rule: hBody.required === true ? 'OPENAPI_BREAKING_REQUEST_BODY_REQUIRED' : 'OPENAPI_COMPATIBLE_REQUEST_BODY_ADDED_OPTIONAL',
        severity: hBody.required === true ? 'breaking' : 'compatible',
        position: 'request',
        fact: 'requestBodyAdded',
        pointer: `${pointer}/requestBody`,
        detail:
          hBody.required === true
            ? '新增了必填 requestBody（老客户端不会发 body）'
            : '新增了可选 requestBody（放宽）',
      });
    } else if (isPlainObject(bBody) && isPlainObject(hBody)) {
      if (bBody.required !== true && hBody.required === true) {
        findings.push({
          rule: 'OPENAPI_BREAKING_REQUEST_BODY_REQUIRED',
          severity: 'breaking',
          position: 'request',
          fact: 'requestBodyRequired',
          pointer: `${pointer}/requestBody/required`,
          detail: 'requestBody 从可选改成必填（§4.2 B：把 body 改为必填是破坏性变更）',
        });
      }
      findings.push(
        ...compareContentMaps(
          bBody.content,
          hBody.content,
          `${pointer}/requestBody/content`,
          'request',
          'requestBody',
          docs,
        ),
      );
    }

    const bResponses = isPlainObject(baseOperation.responses) ? baseOperation.responses : {};
    const hResponses = isPlainObject(headOperation.responses) ? headOperation.responses : {};
    for (const status of sortedUnique([...Object.keys(bResponses), ...Object.keys(hResponses)])) {
      const statusPointer = `${pointer}/responses/${escapeToken(status)}`;
      if (!Object.hasOwn(bResponses, status)) {
        findings.push({
          rule: 'OPENAPI_COMPATIBLE_RESPONSE_ADDED',
          severity: 'compatible',
          position: 'response',
          fact: 'responseAdded',
          pointer: statusPointer,
          detail: `新增了 ${status} 响应`,
        });
        continue;
      }
      if (!Object.hasOwn(hResponses, status)) {
        findings.push({
          rule: 'OPENAPI_BREAKING_RESPONSE_REMOVED',
          severity: 'breaking',
          position: 'response',
          fact: 'responseRemoved',
          pointer: statusPointer,
          detail: `删除了 ${status} 响应（§4.2 B：删除 response/status 是破坏性变更）`,
        });
        continue;
      }
      findings.push(
        ...compareContentMaps(
          bResponses[status]?.content,
          hResponses[status]?.content,
          `${statusPointer}/content`,
          'response',
          `${status} 响应`,
          docs,
        ),
      );
      findings.push(
        ...compareResponseHeaders(
          bResponses[status]?.headers,
          hResponses[status]?.headers,
          `${statusPointer}/headers`,
          docs,
        ),
      );
    }

    findings.push(...compareSecurity(baseOperation.security, headOperation.security, `${pointer}/security`));
    findings.push(...findCsrfSplit(headOperation.security, `${pointer}/security`));
    findings.push(
      ...compareErrorCodeExtension(
        baseOperation['x-littleq-error-codes'],
        headOperation['x-littleq-error-codes'],
        `${pointer}/x-littleq-error-codes`,
      ),
    );
  }
  return findings;
}

function compareComponents(baseDoc, headDoc) {
  const findings = [];
  const bSchemas = isPlainObject(baseDoc?.components?.schemas) ? baseDoc.components.schemas : {};
  const hSchemas = isPlainObject(headDoc?.components?.schemas) ? headDoc.components.schemas : {};
  const basePositions = componentPositions(baseDoc);
  const headPositions = componentPositions(headDoc);

  for (const name of sortedUnique([...Object.keys(bSchemas), ...Object.keys(hSchemas)])) {
    const pointer = `/components/schemas/${escapeToken(name)}`;
    const positions = sortedUnique([
      ...(basePositions.get(name) ?? []),
      ...(headPositions.get(name) ?? []),
    ]);
    // 没有任何 operation 引用它，就没有消费者，方向无从谈起 —— 记成两侧都算，
    // 让更严的那条判定生效（fail closed）。
    const effective = positions.length > 0 ? positions : ['request', 'response'];

    if (!Object.hasOwn(bSchemas, name)) {
      findings.push({
        rule: 'OPENAPI_COMPATIBLE_COMPONENT_ADDED',
        severity: 'compatible',
        position: effective.join('+'),
        fact: 'componentAdded',
        pointer,
        detail: `新增了 component schema ${name}（它被谁引用、引用在哪个位置，由那条引用处的 finding 说明）`,
      });
      continue;
    }
    if (!Object.hasOwn(hSchemas, name)) {
      findings.push({
        rule: 'OPENAPI_BREAKING_COMPONENT_REMOVED',
        severity: 'breaking',
        position: effective.join('+'),
        fact: 'componentRemoved',
        pointer,
        detail: `删除了 component schema ${name}（被 ${effective.join(' 与 ')} 位置引用过）`,
      });
      continue;
    }

    const ctx = schemaDiffContext({ baseDoc, headDoc });
    diffSchemas(bSchemas[name], hSchemas[name], pointer, ctx);
    findings.push(...findingsFromFacts(ctx.facts, effective, pointer, `component ${name}`));
  }

  // securitySchemes：cookie 名 / header 名 / type 都是线上字节，改名就是破坏。
  const bSchemes = isPlainObject(baseDoc?.components?.securitySchemes) ? baseDoc.components.securitySchemes : {};
  const hSchemes = isPlainObject(headDoc?.components?.securitySchemes) ? headDoc.components.securitySchemes : {};
  for (const name of sortedUnique([...Object.keys(bSchemes), ...Object.keys(hSchemes)])) {
    const pointer = `/components/securitySchemes/${escapeToken(name)}`;
    if (!Object.hasOwn(bSchemes, name)) {
      findings.push({
        rule: 'OPENAPI_COMPATIBLE_SECURITY_SCHEME_ADDED',
        severity: 'compatible',
        position: 'security',
        fact: 'securitySchemeAdded',
        pointer,
        detail: `新增了 security scheme ${name}`,
      });
      continue;
    }
    if (!Object.hasOwn(hSchemes, name)) {
      findings.push({
        rule: 'OPENAPI_BREAKING_SECURITY_SCHEME_REMOVED',
        severity: 'breaking',
        position: 'security',
        fact: 'securitySchemeRemoved',
        pointer,
        detail: `删除了 security scheme ${name}：所有引用它的 Security Requirement Object 都变成悬空`,
      });
      continue;
    }
    for (const key of ['type', 'in', 'name', 'scheme', 'bearerFormat', 'openIdConnectUrl']) {
      const bv = bSchemes[name]?.[key];
      const hv = hSchemes[name]?.[key];
      if (canonicalJson(bv) === canonicalJson(hv)) continue;
      if (key === 'description') continue;
      findings.push({
        rule: 'OPENAPI_BREAKING_SECURITY_SCHEME_CHANGED',
        severity: 'breaking',
        position: 'security',
        fact: 'securitySchemeChanged',
        pointer: `${pointer}/${key}`,
        detail: `security scheme ${name} 的 ${key} 从 ${describeValue(bv)} 改成 ${describeValue(hv)}。` +
          (name === 'CookieAuth' && key === 'name'
            ? 'OpenAPI 3.1 没有 cookie 类型，会话 cookie 只能编码成 apiKey+in:cookie，所以 cookie **名**是契约字节'
            : '这些字段是客户端实际要发出的线上字节'),
      });
    }
  }
  return findings;
}

export function compareOpenApi(baseDoc, headDoc) {
  const findings = [];

  if (baseDoc?.openapi !== headDoc?.openapi) {
    findings.push({
      rule: 'OPENAPI_BREAKING_SPEC_VERSION_CHANGED',
      severity: 'breaking',
      position: 'document',
      fact: 'specVersionChanged',
      pointer: '/openapi',
      detail: `OpenAPI 规范版本从 ${describeValue(baseDoc?.openapi)} 改成 ${describeValue(headDoc?.openapi)}`,
    });
  }

  const bServers = Array.isArray(baseDoc?.servers) ? baseDoc.servers.map((item) => item?.url) : [];
  const hServers = Array.isArray(headDoc?.servers) ? headDoc.servers.map((item) => item?.url) : [];
  if (canonicalJson(bServers) !== canonicalJson(hServers)) {
    findings.push({
      rule: 'OPENAPI_BREAKING_SERVER_URL_CHANGED',
      severity: 'breaking',
      position: 'document',
      fact: 'serverUrlChanged',
      pointer: '/servers',
      detail: `servers 从 ${describeValue(bServers)} 改成 ${describeValue(hServers)}：客户端拼接的 URL 前缀变了`,
    });
  }

  // info.version 只在 major 变化时算破坏：/api/v1 这个前缀与 apiMajor 是同一件事的两种写法。
  const bVersion = String(baseDoc?.info?.version ?? '');
  const hVersion = String(headDoc?.info?.version ?? '');
  if (bVersion.split('.')[0] !== hVersion.split('.')[0]) {
    findings.push({
      rule: 'OPENAPI_BREAKING_INFO_MAJOR_CHANGED',
      severity: 'breaking',
      position: 'document',
      fact: 'infoMajorChanged',
      pointer: '/info/version',
      detail: `契约 major 从 ${describeValue(bVersion)} 改成 ${describeValue(hVersion)}。破坏性变更的正确出口是新开 /api/v2 并保留 v1 快照（§4.2 B），不是原地改 major`,
    });
  }

  findings.push(...compareOperations(baseDoc, headDoc));
  findings.push(...compareComponents(baseDoc, headDoc));

  // 顶层 security（本文档不使用，但规则要完整）
  findings.push(...compareSecurity(baseDoc?.security, headDoc?.security, '/security'));
  findings.push(...findCsrfSplit(headDoc?.security, '/security'));

  return sortFindings(findings);
}

// ---------------------------------------------------------------------------
// 4. 判定核心：错误目录
// ---------------------------------------------------------------------------

const ERROR_ENTRY_FIELDS = ['httpStatus', 'messageKey', 'retryable', 'sameRequestRetrySafety'];

export function compareErrorCatalog(baseDoc, headDoc) {
  const findings = [];
  const pointerOf = (code) => `/codes/${escapeToken(code)}`;

  if (baseDoc?.apiMajor !== headDoc?.apiMajor) {
    findings.push({
      rule: 'ERROR_CATALOG_BREAKING_API_MAJOR_CHANGED',
      severity: 'breaking',
      position: 'catalog',
      fact: 'apiMajorChanged',
      pointer: '/apiMajor',
      detail: `apiMajor 从 ${describeValue(baseDoc?.apiMajor)} 改成 ${describeValue(headDoc?.apiMajor)}`,
    });
  }

  const bCodes = new Map((Array.isArray(baseDoc?.codes) ? baseDoc.codes : []).map((item) => [item?.code, item]));
  const hCodes = new Map((Array.isArray(headDoc?.codes) ? headDoc.codes : []).map((item) => [item?.code, item]));

  for (const code of sortedUnique([...bCodes.keys(), ...hCodes.keys()])) {
    if (!bCodes.has(code)) {
      findings.push({
        rule: 'ERROR_CATALOG_BREAKING_CODE_ADDED',
        severity: 'conservative',
        position: 'catalog',
        fact: 'codeAdded',
        pointer: pointerOf(code),
        detail: `新增了错误码 ${code}（§4.2 B：新错误码保守按破坏性处理）`,
      });
      continue;
    }
    if (!hCodes.has(code)) {
      findings.push({
        rule: 'ERROR_CATALOG_BREAKING_CODE_REMOVED',
        severity: 'breaking',
        position: 'catalog',
        fact: 'codeRemoved',
        pointer: pointerOf(code),
        detail: `删除了错误码 ${code}：已经为它写了处理分支的客户端会失去这条路径`,
      });
      continue;
    }
    for (const field of ERROR_ENTRY_FIELDS) {
      const bv = bCodes.get(code)?.[field];
      const hv = hCodes.get(code)?.[field];
      if (canonicalJson(bv) === canonicalJson(hv)) continue;
      findings.push({
        rule: 'ERROR_CATALOG_BREAKING_CODE_REDEFINED',
        severity: 'breaking',
        position: 'catalog',
        fact: 'codeRedefined',
        pointer: `${pointerOf(code)}/${field}`,
        detail: `既有错误码 ${code} 的 ${field} 从 ${describeValue(bv)} 改成 ${describeValue(hv)}（§4.2 B 明列的破坏性变更）`,
      });
    }
  }

  // 异步登记表：增删改都按破坏性处理。新增一条 (kind, stage) 的错误就是「新错误码」，
  // 删除或改动则会让依赖它的 UI 文案与重试策略失配。这里不做更细的方向判断，
  // 因为 taskErrorRegistry 的消费者是任务详情面板，它按 code 索引，任何变动都可见。
  if (canonicalJson(baseDoc?.taskErrorRegistry) !== canonicalJson(headDoc?.taskErrorRegistry)) {
    findings.push({
      rule: 'ERROR_CATALOG_BREAKING_TASK_REGISTRY_CHANGED',
      severity: 'conservative',
      position: 'catalog',
      fact: 'taskRegistryChanged',
      pointer: '/taskErrorRegistry',
      detail: '异步任务错误登记表发生变化。它的每一条都是「某个 (taskKind, stage) 会吐出某个错误码」的对外承诺',
    });
  }

  return sortFindings(findings);
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    return (
      compareCodePoints(a.pointer, b.pointer) ||
      compareCodePoints(a.rule, b.rule) ||
      compareCodePoints(a.position, b.position) ||
      compareCodePoints(a.fact, b.fact) ||
      compareCodePoints(a.detail, b.detail)
    );
  });
}

// ---------------------------------------------------------------------------
// 5. 判定核心：入口
// ---------------------------------------------------------------------------

export function compareContracts({ openapi, errorCatalog }) {
  const findings = [
    ...compareOpenApi(openapi.base, openapi.head),
    ...compareErrorCatalog(errorCatalog.base, errorCatalog.head),
  ];
  const breaking = findings.filter((item) => item.severity !== 'compatible');
  return {
    ok: breaking.length === 0,
    findings: sortFindings(findings),
    breaking: sortFindings(breaking),
    compatible: sortFindings(findings.filter((item) => item.severity === 'compatible')),
    diagnoses: sortedUnique(breaking.map((item) => item.rule)),
  };
}

// ---------------------------------------------------------------------------
// 6. base 获取（唯一允许触达外部状态的一层，且可注入）
// ---------------------------------------------------------------------------

function assertCommitSha(value, label) {
  if (typeof value !== 'string' || !COMMIT_SHA_PATTERN.test(value)) {
    throw new ContractCompatError(
      DIAGNOSIS.baseUnavailable,
      `${label} 不是 40 位小写 commit SHA：${describeValue(value)}。` +
        '附录 B G1 明确禁止回退到 HEAD^、当前工作树、自身 snapshot 或跳过比较。',
    );
  }
  if (value === ZERO_SHA) {
    throw new ContractCompatError(
      DIAGNOSIS.baseUnavailable,
      `${label} 是全零 SHA（GitHub 在分支首推、强推删除等场景会给出这个值），它不指向任何 commit。`,
    );
  }
}

// 生产 transport：定点读一个已 fetch 到本地的 commit。
//
// 用 `git cat-file blob <sha>:<path>` 而不是 `git show <sha>:<path>`：两者读的是同一个
// object，但 `show` 在某些 git 版本/配置下会过一遍 EOL 与 textconv 过滤器，而快照比较是
// **逐字节**的 —— 一次 CRLF 转换就能把「兼容」判成「漂移」。`cat-file blob` 保证原始字节。
// 附录 B G1 要求的三条命令（fetch / rev-parse FETCH_HEAD / cat-file -e ^{commit}）
// 在 `.github/workflows/ci.yml` 的解析步骤里逐字执行，本 transport 只负责读。
export function createGitTransport(cwd) {
  const run = (args) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

  return {
    kind: 'git',
    commitExists(sha) {
      return run(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
    },
    blobText(sha, relPath) {
      if (!this.commitExists(sha)) {
        throw new ContractCompatError(
          DIAGNOSIS.baseUnavailable,
          `base commit ${sha} 在本地仓库里读不出来。CI 需要先执行附录 B G1 的定点浅取：\n` +
            `     git fetch --no-tags --depth=1 origin "${sha}"\n` +
            `   本地运行则先 git fetch，或显式传 --base-dir / --base-file。\n` +
            `   注意「base commit 不可读取」就是 CONTRACT_BASE_UNAVAILABLE，不能与「base 可读但路径不存在」混同。`,
        );
      }
      const probe = run(['cat-file', '-e', `${sha}:${relPath}`]);
      if (probe.status !== 0) return null; // commit 可读、路径不存在 —— bootstrap 判定要用这个区别
      const shown = run(['cat-file', 'blob', `${sha}:${relPath}`]);
      if (shown.status !== 0) {
        throw new ContractCompatError(
          DIAGNOSIS.baseUnavailable,
          `读取 ${sha}:${relPath} 失败：${(shown.stderr ?? '').trim()}`,
        );
      }
      return shown.stdout;
    },
    headSha() {
      const result = run(['rev-parse', 'HEAD']);
      return result.status === 0 ? result.stdout.trim() : null;
    },
  };
}

// 控制用例 transport：一棵仓库内提交的目录树当「git 对象库」用。
//   <root>/<40-hex-sha>/            目录存在 == commit 可读
//   <root>/<40-hex-sha>/<relPath>   文件存在 == 该路径在该 commit 里有 blob
//   <root>/HEAD                     可选，head commit
// §4.2 C 第 6 条要求 fixture 不读取 host 的 git —— 这个 transport 就是那条要求的落地：
// 控制用例走它，一个 git 进程都不会起。
export function createFixtureTransport(rootDir) {
  return {
    kind: 'fixture',
    commitExists(sha) {
      return isDirectory(join(rootDir, sha));
    },
    blobText(sha, relPath) {
      if (!this.commitExists(sha)) {
        throw new ContractCompatError(
          DIAGNOSIS.baseUnavailable,
          `fixture base commit ${sha} 不存在（${join(rootDir, sha)}）—— 用来模拟「base 取不到」`,
        );
      }
      const file = join(rootDir, sha, relPath);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    headSha() {
      const file = join(rootDir, 'HEAD');
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
    },
  };
}

// ---------------------------------------------------------------------------
// 7. bootstrap（附录 B「bootstrap 同步修正」）
// ---------------------------------------------------------------------------

function parseBootstrap(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ContractCompatError(
      DIAGNOSIS.bootstrapInvalid,
      `${path} 不是合法 JSON：${error.message}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ContractCompatError(DIAGNOSIS.bootstrapInvalid, `${path} 不是一个 JSON 对象`);
  }
  return parsed;
}

// bootstrap.json 的**形状**问题（与 base、与 head 字节都无关）。两条 bootstrap 路径
// （CI 事件解析出的 base / 本地默认的首落哈希对照）共用这一份，避免各自宽松一点。
function bootstrapShapeProblems(bootstrap) {
  const problems = [];
  if (bootstrap.apiMajor !== 1) {
    problems.push(`apiMajor 必须是 1，收到 ${describeValue(bootstrap.apiMajor)}`);
  }
  if (bootstrap.designBaseline !== DESIGN_BASELINE_SHA) {
    problems.push(
      `designBaseline 必须逐字是设计基线 ${DESIGN_BASELINE_SHA}（仅作溯源），收到 ${describeValue(bootstrap.designBaseline)}`,
    );
  }
  if (typeof bootstrap.introducedFromBase !== 'string' || !COMMIT_SHA_PATTERN.test(bootstrap.introducedFromBase)) {
    problems.push(`introducedFromBase 必须是 40 位小写 commit SHA：${describeValue(bootstrap.introducedFromBase)}`);
  }
  if (!isPlainObject(bootstrap.snapshots)) {
    problems.push(`snapshots 缺失或不是对象：${describeValue(bootstrap.snapshots)}`);
  } else {
    for (const [, relPath] of SNAPSHOT_PATHS) {
      const recorded = bootstrap.snapshots[relPath];
      if (typeof recorded !== 'string' || !SNAPSHOT_SHA_PATTERN.test(recorded)) {
        problems.push(`snapshots["${relPath}"] 不是 64 位 sha256：${describeValue(recorded)}`);
      }
    }
  }
  return problems;
}

// 返回 { verdict: 'allow' | 'refuse' | 'invalid', ... }
//   allow   —— 四个条件全部成立，本次是唯一合法首落，跳过与旧 snapshot 的比较
//   refuse  —— base 已含任一 v1 路径：bootstrap 分支永久失效，退回正常兼容比较
//   invalid —— bootstrap 文件自身不成立（SHA 不匹配、字段缺失、apiMajor 不对…）→ 红
export function evaluateBootstrap({ bootstrapText, baseSha, transport, headTexts, baseShaLabel }) {
  if (bootstrapText === null || bootstrapText === undefined) {
    return { verdict: 'refuse', reason: '仓库里没有 bootstrap.json，本次不是首次落库' };
  }

  const bootstrap = parseBootstrap(bootstrapText, CONTRACT_PATHS.bootstrap);
  const problems = bootstrapShapeProblems(bootstrap);

  if (bootstrap.introducedFromBase !== baseSha) {
    // 附录 B：introducedFromBase「必须逐字等于本次事件解析出的 CONTRACT_BASE_SHA」。
    problems.push(
      `introducedFromBase（${describeValue(bootstrap.introducedFromBase)}）与本次解析出的 base（${baseShaLabel} = ${baseSha}）不逐字相等`,
    );
  }

  const snapshots = isPlainObject(bootstrap.snapshots) ? bootstrap.snapshots : {};
  for (const [key, relPath] of SNAPSHOT_PATHS) {
    const recorded = snapshots[relPath];
    if (typeof recorded !== 'string') continue; // 形状问题已经报过了
    const headText = headTexts[key];
    if (typeof headText !== 'string') {
      problems.push(`head 缺少 ${relPath}，两份 snapshot 必须完整`);
      continue;
    }
    const actual = sha256Hex(headText);
    if (actual !== recorded) {
      problems.push(`snapshots["${relPath}"] 记录的是 ${recorded}，而 head 那份字节是 ${actual}`);
    }
  }

  // base 可读取性是**前置**：附录 B 明确「base commit 不可读取仍是 CONTRACT_BASE_UNAVAILABLE，
  // 不能把 base 可读但路径不存在混同为 base 不可得」。blobText 在 commit 不可读时抛。
  const present = [];
  for (const relPath of V1_CONTRACT_PATHS) {
    if (transport.blobText(baseSha, relPath) !== null) present.push(relPath);
  }
  if (present.length > 0) {
    return {
      verdict: 'refuse',
      reason:
        `base ${baseSha} 里已经存在 ${present.join(', ')} —— 一旦 base 已含任一 v1 snapshot/bootstrap，` +
        '必须进入正常兼容比较，bootstrap 分支永久不可再触发',
      bootstrap,
      presentInBase: present,
    };
  }

  if (problems.length > 0) {
    throw new ContractCompatError(
      DIAGNOSIS.bootstrapInvalid,
      `bootstrap 前置条件不成立（base ${baseSha} 可读且其中不存在任何 v1 契约路径，所以这不是「base 不可得」，而是 bootstrap 文件自己不对）：\n` +
        problems.map((item) => `     - ${item}`).join('\n'),
    );
  }

  return { verdict: 'allow', bootstrap, baseSha };
}

// ---------------------------------------------------------------------------
// 8. 生产入口
// ---------------------------------------------------------------------------

// `missingDiagnosis` 必须由调用方给：base 缺文件是 `CONTRACT_BASE_UNAVAILABLE`（§4.2 B/C
// 第 5 条点名要 exit 2），head 缺文件是 `CONTRACT_HEAD_SNAPSHOT_MISSING`。共用一个诊断码
// 会让「基线取不到」在输出里看起来像「本次交付没提交快照」，两种红的修法完全不同。
function readTreeSnapshots(rootDir, label, missingDiagnosis) {
  const out = {};
  for (const [key, relPath] of SNAPSHOT_PATHS) {
    const file = join(rootDir, relPath);
    if (!existsSync(file)) {
      throw new ContractCompatError(
        missingDiagnosis,
        label === 'base'
          ? `base 目录 ${rootDir} 里没有 ${relPath}。基线不可得必须 fail closed，` +
              '禁止退化为 head 与自身比较，也禁止跳过比较。'
          : `${label}缺少 ${relPath}。契约快照必须提交进仓库（§4.1）：CI artifact 只能作为诊断补充。`,
      );
    }
    out[key] = readFileSync(file, 'utf8');
  }
  return out;
}

function parseSnapshot(text, label, relPath) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ContractCompatError(
      label === 'base' ? DIAGNOSIS.baseUnparseable : DIAGNOSIS.headUnparseable,
      `${label} 的 ${relPath} 不是合法 JSON：${error.message}`,
    );
  }
}

/**
 * 生产使用的**同一个** compatibility 入口 —— CLI 与 contract:control 都只调它。
 *
 * @param {object} options
 * @param {string} [options.repoRoot]       head 快照所在仓库根
 * @param {string} [options.baseDir]        base 快照目录（仓库根形状）；给了就不碰 git
 * @param {string} [options.baseFile]       base openapi 快照单文件
 * @param {string} [options.baseErrorFile]  base 错误目录单文件
 * @param {string} [options.headDir]        head 快照目录；缺省为 repoRoot
 * @param {string} [options.headFile]       head openapi 快照单文件
 * @param {string} [options.headErrorFile]  head 错误目录单文件
 * @param {string} [options.baseSha]        显式 base commit SHA
 * @param {object} [options.transport]      base 获取方式（缺省真 git；控制用例注入 fixture）
 * @param {boolean} [options.allowBootstrap] 缺省 true
 */
export function runCompat(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const transport = options.transport ?? createGitTransport(repoRoot);

  const headTexts =
    options.headFile !== undefined || options.headErrorFile !== undefined
      ? {
          openapi: readIfGiven(options.headFile, 'head openapi 快照'),
          errorCatalog: readIfGiven(options.headErrorFile, 'head 错误目录快照'),
        }
      : readTreeSnapshots(options.headDir ?? repoRoot, 'head', DIAGNOSIS.headMissing);
  for (const [key, relPath] of SNAPSHOT_PATHS) {
    if (typeof headTexts[key] !== 'string') {
      throw new ContractCompatError(DIAGNOSIS.headMissing, `head 缺少 ${relPath}`);
    }
  }

  // ---- 显式目录/文件基线：完全不碰 git ----
  if (options.baseDir !== undefined || options.baseFile !== undefined) {
    const baseTexts =
      options.baseDir !== undefined
        ? readTreeSnapshots(options.baseDir, 'base', DIAGNOSIS.baseUnavailable)
        : {
            openapi: readIfGiven(options.baseFile, 'base openapi 快照'),
            errorCatalog: readIfGiven(options.baseErrorFile, 'base 错误目录快照'),
          };
    return finishCompare({ baseTexts, headTexts, baseLabel: describeBaseLabel(options) });
  }

  // ---- 由 SHA 解析（--base-sha > $CONTRACT_BASE_SHA > bootstrap.json.introducedFromBase）----
  const explicitSha = options.baseSha ?? process.env.CONTRACT_BASE_SHA ?? null;
  const bootstrapPath = join(repoRoot, CONTRACT_PATHS.bootstrap);
  const bootstrapText = existsSync(bootstrapPath) ? readFileSync(bootstrapPath, 'utf8') : null;

  if (explicitSha !== null && explicitSha !== '') {
    const baseSha = String(explicitSha).trim();
    assertCommitSha(baseSha, 'CONTRACT_BASE_SHA');
    // 「不同于 head」属于**事件解析**这一步的职责（ci.yml 里逐字执行），但显式传进来的
    // SHA 同样要挡：base == head 的比较就是 §4.2 B 禁止的「退化为 head 与自身比较」。
    const head = transport.headSha();
    if (head !== null && head === baseSha) {
      throw new ContractCompatError(
        DIAGNOSIS.baseUnavailable,
        `CONTRACT_BASE_SHA ${baseSha} 等于 head commit —— 那就是 head 跟自己比，被 §4.2 B 明令禁止。`,
      );
    }
    const baseTexts = readBaseFromSha(transport, baseSha, bootstrapText, {
      headTexts,
      baseShaLabel: options.baseSha !== undefined ? '--base-sha' : '$CONTRACT_BASE_SHA',
      allowBootstrap: options.allowBootstrap !== false,
    });
    if (baseTexts.bootstrap !== undefined) return baseTexts.bootstrap; // 合法首落，直接返回报告
    return finishCompare({ baseTexts, headTexts, baseLabel: `commit ${baseSha}` });
  }

  // ---- 没有任何显式基线：本地默认的「首落哈希对照」，完全不碰 git ----
  return runBootstrapHashMode({ bootstrapText, headTexts, allowBootstrap: options.allowBootstrap !== false });
}

// 本地默认路径。它**不**读 git，理由有三条，缺一条这个默认值就是错的：
//
//   1. §7.3 第 6 条要求 comparator 不依赖「当前 Git 安装状态」。CI 里基线由事件负载解析
//      并通过 `CONTRACT_BASE_SHA` 注入，走的是上面那条 SHA 分支；本地这条路径一旦也要
//      起 git 进程，同一个门禁在「装了 git 的机器」和「没装的机器」上就有两种行为。
//   2. 首落的安全性从来不来自 base ≠ head，而来自 bootstrap.json 里那两个 sha256 与
//      head 字节逐字相等（附录 B 的四个前置条件之一）。这一步纯哈希就能判。
//   3. 它天然自我关闭：契约一改，head 字节就不再等于记录值，本函数立刻 exit 2 要求显式
//      基线。**不会**出现「首落凭据被反复复用、以后每次本地 verify 都跳过兼容比较」。
//
// 也就是说，这个模式只在本任务这一次落库时为绿；此后本地跑 `pnpm verify` 若改过契约，
// 必须显式给 `--base-sha` / `--base-dir` / `--base-file`，或者交给 CI 判定。
function runBootstrapHashMode({ bootstrapText, headTexts, allowBootstrap }) {
  if (!allowBootstrap) {
    throw new ContractCompatError(
      DIAGNOSIS.baseUnavailable,
      '调用方禁用了 bootstrap（--no-bootstrap），又没有给任何基线。基线不可得必须 fail closed。',
    );
  }
  if (bootstrapText === null) {
    throw new ContractCompatError(
      DIAGNOSIS.baseUnavailable,
      '没有可用基线：未给 --base-dir / --base-file / --base-sha，也没有 $CONTRACT_BASE_SHA，' +
        `且仓库里没有 ${CONTRACT_PATHS.bootstrap}（首落已经完成，bootstrap 分支永久失效）。` +
        '基线不可得必须 fail closed，禁止退化为 head 与自身比较。',
    );
  }

  const bootstrap = parseBootstrap(bootstrapText, CONTRACT_PATHS.bootstrap);
  const problems = bootstrapShapeProblems(bootstrap);
  if (problems.length > 0) {
    throw new ContractCompatError(
      DIAGNOSIS.bootstrapInvalid,
      `${CONTRACT_PATHS.bootstrap} 自身不成立：\n${problems.map((item) => `     - ${item}`).join('\n')}`,
    );
  }

  const mismatches = [];
  for (const [key, relPath] of SNAPSHOT_PATHS) {
    const recorded = bootstrap.snapshots[relPath];
    const actual = sha256Hex(headTexts[key]);
    if (actual !== recorded) mismatches.push({ relPath, recorded, actual });
  }
  if (mismatches.length > 0) {
    throw new ContractCompatError(
      DIAGNOSIS.baseUnavailable,
      '契约已经变了，而本地没有可比对的基线：\n' +
        mismatches
          .map((item) => `     - ${item.relPath}\n         bootstrap 记录 ${item.recorded}\n         当前字节     ${item.actual}`)
          .join('\n') +
        `\n   bootstrap.json 记录的是**首次落库那一刻**的字节，它不是可以反复使用的水线。` +
        '请显式给出基线（--base-sha <commit> / --base-dir <dir> / --base-file <openapi.json>），' +
        '或者让 CI 用事件解析出的 CONTRACT_BASE_SHA 判定。',
    );
  }

  return {
    ok: true,
    mode: 'bootstrap',
    baseSha: bootstrap.introducedFromBase,
    baseLabel: `bootstrap.json（首落哈希对照，introducedFromBase ${bootstrap.introducedFromBase}）`,
    diagnosis: null,
    detail:
      `首次落库：${CONTRACT_PATHS.bootstrap} 结构合法，且它记录的两个 sha256 与当前 head 的` +
      '两份 snapshot 字节逐字相等。本模式不起 git 进程、不读宿主状态（§7.3 第 6 条），' +
      '并且只在字节完全未变时为绿 —— 契约一旦改动就转为 CONTRACT_BASE_UNAVAILABLE，' +
      '要求显式基线，不会把首落凭据复用成永久水线。' +
      'bootstrap 分支此后永久失效：CI 侧只要 base commit 里存在任一 v1 契约路径就退回正常比较。',
    designBaseline: bootstrap.designBaseline,
    introducedFromBase: bootstrap.introducedFromBase,
    findings: [],
    breaking: [],
    compatible: [],
    diagnoses: [],
    headSha256: {
      openapi: sha256Hex(headTexts.openapi),
      errorCatalog: sha256Hex(headTexts.errorCatalog),
    },
  };
}

function readIfGiven(file, label) {
  if (file === undefined) return undefined;
  const abs = resolve(file);
  if (!existsSync(abs)) {
    throw new ContractCompatError(DIAGNOSIS.baseUnavailable, `${label}不存在：${abs}`);
  }
  return readFileSync(abs, 'utf8');
}

function describeBaseLabel(options) {
  if (options.baseDir !== undefined) return `目录 ${options.baseDir}`;
  return `文件 ${options.baseFile}`;
}

// 从一个 commit SHA 取 base。返回 { openapi, errorCatalog } 或 { bootstrap: <报告> }。
function readBaseFromSha(transport, baseSha, bootstrapText, { headTexts, baseShaLabel, allowBootstrap }) {
  const blobs = {};
  for (const [key, relPath] of SNAPSHOT_PATHS) {
    blobs[key] = transport.blobText(baseSha, relPath);
  }

  const evaluation = allowBootstrap
    ? evaluateBootstrap({
        bootstrapText,
        baseSha,
        transport,
        headTexts,
        baseShaLabel,
      })
    : { verdict: 'refuse', reason: '调用方禁用了 bootstrap' };

  if (evaluation.verdict === 'allow') {
    return {
      bootstrap: {
        ok: true,
        mode: 'bootstrap',
        baseSha,
        baseLabel: `commit ${baseSha}`,
        diagnosis: null,
        detail:
          `首次落库：base ${baseSha} 可读、其中不存在任何 v1 契约路径、head 两份 snapshot 完整、` +
          'bootstrap.json 记录的 SHA-256 与 head 字节逐字一致。跳过与旧 snapshot 的比较，' +
          '但 contract:check 与 contract:control 仍必须全绿（§4.2 B）。' +
          'bootstrap 分支此后永久失效：base 一旦含任一 v1 路径就再也不会走到这里。',
        designBaseline: evaluation.bootstrap.designBaseline,
        introducedFromBase: evaluation.bootstrap.introducedFromBase,
        findings: [],
        breaking: [],
        compatible: [],
        diagnoses: [],
      },
    };
  }

  if (evaluation.verdict === 'refuse') {
    // base 已有 snapshot → 正常比较；base 没有 snapshot 但也没有合法 bootstrap → fail closed。
    if (blobs.openapi === null || blobs.errorCatalog === null) {
      const missing = [
        blobs.openapi === null ? CONTRACT_PATHS.openapi : null,
        blobs.errorCatalog === null ? CONTRACT_PATHS.errorCatalog : null,
      ].filter(Boolean);
      throw new ContractCompatError(
        DIAGNOSIS.baseUnavailable,
        `base ${baseSha} 可读，但其中不存在 ${missing.join(', ')}，而 bootstrap 分支不可用（${evaluation.reason}）。` +
          '这不是「base 可读但路径不存在就等于首落」的后门：首落只允许一次，且必须带合法的 bootstrap.json。',
      );
    }
    return { openapi: blobs.openapi, errorCatalog: blobs.errorCatalog, refuseReason: evaluation.reason };
  }

  throw new ContractCompatError(DIAGNOSIS.bootstrapInvalid, 'unreachable');
}

function finishCompare({ baseTexts, headTexts, baseLabel }) {
  const base = {
    openapi: parseSnapshot(baseTexts.openapi, 'base', CONTRACT_PATHS.openapi),
    errorCatalog: parseSnapshot(baseTexts.errorCatalog, 'base', CONTRACT_PATHS.errorCatalog),
  };
  const head = {
    openapi: parseSnapshot(headTexts.openapi, 'head', CONTRACT_PATHS.openapi),
    errorCatalog: parseSnapshot(headTexts.errorCatalog, 'head', CONTRACT_PATHS.errorCatalog),
  };
  const comparison = compareContracts({
    openapi: { base: base.openapi, head: head.openapi },
    errorCatalog: { base: base.errorCatalog, head: head.errorCatalog },
  });
  return {
    ...comparison,
    mode: 'compare',
    baseLabel,
    baseSha256: {
      openapi: sha256Hex(baseTexts.openapi),
      errorCatalog: sha256Hex(baseTexts.errorCatalog),
    },
    headSha256: {
      openapi: sha256Hex(headTexts.openapi),
      errorCatalog: sha256Hex(headTexts.errorCatalog),
    },
    refuseReason: baseTexts.refuseReason ?? null,
  };
}

// ---------------------------------------------------------------------------
// 9. CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    repoRoot: REPO_ROOT,
    baseDir: undefined,
    baseFile: undefined,
    baseErrorFile: undefined,
    headDir: undefined,
    headFile: undefined,
    headErrorFile: undefined,
    baseSha: undefined,
    gitRoot: undefined,
    json: false,
    quiet: false,
    maxFindings: 40,
    allowBootstrap: true,
  };
  const need = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} 需要一个值`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--repo-root':
        args.repoRoot = resolve(need(i, token));
        i += 1;
        break;
      case '--git-root':
        args.gitRoot = resolve(need(i, token));
        i += 1;
        break;
      case '--base-dir':
        args.baseDir = resolve(need(i, token));
        i += 1;
        break;
      case '--base-file':
        args.baseFile = resolve(need(i, token));
        i += 1;
        break;
      case '--base-error-file':
        args.baseErrorFile = resolve(need(i, token));
        i += 1;
        break;
      case '--head-dir':
        args.headDir = resolve(need(i, token));
        i += 1;
        break;
      case '--head-file':
        args.headFile = resolve(need(i, token));
        i += 1;
        break;
      case '--head-error-file':
        args.headErrorFile = resolve(need(i, token));
        i += 1;
        break;
      case '--base-sha':
        args.baseSha = need(i, token);
        i += 1;
        break;
      case '--no-bootstrap':
        args.allowBootstrap = false;
        break;
      case '--json':
        args.json = true;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--max-findings':
        args.maxFindings = Number.parseInt(need(i, token), 10);
        i += 1;
        break;
      default:
        throw new Error(`未知参数：${token}`);
    }
  }
  if (args.baseDir !== undefined && args.baseFile !== undefined) {
    throw new Error('--base-dir 与 --base-file 互斥');
  }
  if (args.headDir !== undefined && args.headFile !== undefined) {
    throw new Error('--head-dir 与 --head-file 互斥');
  }
  if ((args.baseDir !== undefined || args.baseFile !== undefined) && args.baseSha !== undefined) {
    throw new Error('给了 --base-dir/--base-file 就不能再给 --base-sha');
  }
  if (!Number.isInteger(args.maxFindings) || args.maxFindings < 1) {
    throw new Error(`--max-findings 必须是正整数，收到 ${args.maxFindings}`);
  }
  return args;
}

// 退出码映射单独抽出来，是因为 `contract:control` 必须断言**退出码**（§4.2 C 第 2/3/5 条
// 逐条点名 0 / 1 / 2），而它又不许复制判断逻辑。放在这里，CLI 与控制用例共用同一份映射：
// 改一次两边一起变，不会出现「控制用例以为 2、CLI 其实给 1」。
//
//   bootstrap 前置条件不成立是「契约自己的问题」→ 红（1）；其余 ContractCompatError 都是
//   基线/头快照不可得或不可解析 → 前置条件缺失（2）。意外崩溃同样按 2 处理：门禁没能
//   得出结论，绝不能被读成「比较通过」。
export function compatExitCode(error) {
  if (!(error instanceof ContractCompatError)) return { exitCode: 2, diagnosis: DIAGNOSIS.crashed };
  const exitCode = error.diagnosis === DIAGNOSIS.bootstrapInvalid ? 1 : 2;
  return { exitCode, diagnosis: error.diagnosis };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`!! ${error.message}\n`);
    process.exit(2);
  }

  let report;
  try {
    report = runCompat({
      repoRoot: args.repoRoot,
      baseDir: args.baseDir,
      baseFile: args.baseFile,
      baseErrorFile: args.baseErrorFile,
      headDir: args.headDir,
      headFile: args.headFile,
      headErrorFile: args.headErrorFile,
      baseSha: args.baseSha,
      allowBootstrap: args.allowBootstrap,
      transport: args.gitRoot !== undefined ? createFixtureTransport(args.gitRoot) : undefined,
    });
  } catch (error) {
    // 退出码只由 compatExitCode 一处决定，CLI 与 contract:control 共用同一份映射。
    const { exitCode, diagnosis } = compatExitCode(error);
    process.stderr.write(`!! ${diagnosis}\n${error.message}\n`);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, diagnosis, message: error.message }, null, 2)}\n`);
    }
    process.exit(exitCode);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  const line = (text = '') => {
    if (!args.quiet) process.stdout.write(`${text}\n`);
  };
  line('== 契约语义兼容性门禁 ==');
  line(`  基线：${report.baseLabel ?? '<首次落库，无基线>'}`);
  line(`  模式：${report.mode}`);
  if (report.refuseReason) line(`  说明：${report.refuseReason}`);

  if (report.mode === 'bootstrap') {
    line('');
    line(report.detail);
    line('结果：合法首次落库。');
    process.exit(0);
  }

  const shown = report.findings.slice(0, args.maxFindings);
  line(`  findings：${report.findings.length} 条（破坏性 ${report.breaking.length}，非破坏 ${report.compatible.length}）`);
  if (shown.length > 0) {
    line('');
    for (const item of shown) {
      const mark = item.severity === 'compatible' ? '·' : item.severity === 'conservative' ? '▲' : '✗';
      line(`  ${mark} [${item.severity}] ${item.rule}`);
      line(`      ${item.position} @ ${item.pointer}`);
      line(`      ${item.detail}`);
    }
    if (report.findings.length > shown.length) {
      line(`  …还有 ${report.findings.length - shown.length} 条（--max-findings 调整，--json 看全部）`);
    }
  }

  line('');
  if (report.ok) {
    line('结果：相对基线无破坏性变更。');
    process.exit(0);
  }
  line(`结果：${report.breaking.length} 条破坏性变更，诊断 ${report.diagnoses.join(', ')}。`);
  line(
    '出口只有两个：把契约改回兼容，或者由 PM/架构师裁定新开 /api/v2 并保留 v1 快照（§4.2 B）。' +
      '不允许给 /api/v1 加 allowlist 绕过，也不允许用更新同一份 v1 快照来消除红灯。',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`!! ${error.stack ?? error.message}\n`);
    process.exit(2);
  }
}

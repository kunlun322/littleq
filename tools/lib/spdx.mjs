// SPDX 许可表达式求值。策略判定必须落在「表达式」层面，而不是字符串相等：
// `(MIT OR Apache-2.0)`、`Apache-2.0 WITH LLVM-exception`、`GPL-2.0-or-later` 都不能靠 indexOf 处理。
//
// 判定采取保守合并：表达式里只要出现一个禁止项就是禁止，出现一个未知项就是未知，
// 出现一个待裁定项就是待裁定。理由是本仓库以 AGPL-3.0 分发，误判放行的代价远高于误判拦截。

export const VERDICT_ALLOWED = 'allowed';
export const VERDICT_REVIEW = 'review-required';
export const VERDICT_FORBIDDEN = 'forbidden';
export const VERDICT_UNKNOWN = 'unknown';

const VERDICT_RANK = {
  [VERDICT_FORBIDDEN]: 3,
  [VERDICT_UNKNOWN]: 2,
  [VERDICT_REVIEW]: 1,
  [VERDICT_ALLOWED]: 0,
};

const OPERATORS = new Set(['AND', 'OR', 'WITH']);

// 拆出表达式中的许可 id。保留 `+` 后缀（GPL-2.0+ 与 GPL-2.0 是不同授权范围），
// 去掉 `WITH` 异常（异常本身由 policy.spdx.knownExceptions 单独白名单化）。
export function extractLicenseIds(expression) {
  const tokens = String(expression ?? '')
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const ids = [];
  const exceptions = [];
  let afterWith = false;
  for (const token of tokens) {
    if (OPERATORS.has(token)) {
      afterWith = token === 'WITH';
      continue;
    }
    if (afterWith) {
      exceptions.push(token);
      afterWith = false;
      continue;
    }
    ids.push(token);
  }
  return { ids, exceptions };
}

function normalizeForLookup(id) {
  return id.replace(/\+$/, '');
}

function inExactList(list, id) {
  if (!Array.isArray(list)) return false;
  return list.includes(id) || list.includes(normalizeForLookup(id));
}

function inSubstringList(list, id) {
  if (!Array.isArray(list)) return false;
  const haystack = id.toLowerCase();
  return list.some((needle) => haystack.includes(String(needle).toLowerCase()));
}

export function classifyLicenseId(id, policy) {
  if (inExactList(policy.forbidden?.exact, id)) return VERDICT_FORBIDDEN;
  if (inSubstringList(policy.forbidden?.substringCaseInsensitive, id)) return VERDICT_FORBIDDEN;
  if (inExactList(policy.allowed, id)) return VERDICT_ALLOWED;
  if (inExactList(policy.reviewRequired?.exact, id)) return VERDICT_REVIEW;
  if (inSubstringList(policy.reviewRequired?.substringCaseInsensitive, id)) return VERDICT_REVIEW;
  return VERDICT_UNKNOWN;
}

// 返回 { verdict, ids, exceptions, unknownExceptions }。
// 未知异常按 unknown 处理：`Apache-2.0 WITH SomeCustomThing` 不能因为前半段合规就放行。
export function evaluateExpression(expression, policy) {
  const raw = String(expression ?? '');
  const { ids, exceptions } = extractLicenseIds(raw);
  const knownExceptions = new Set(policy.spdx?.knownExceptions ?? []);
  const unknownExceptions = exceptions.filter((item) => !knownExceptions.has(item));

  let verdict = VERDICT_ALLOWED;
  const bump = (next) => {
    if (VERDICT_RANK[next] > VERDICT_RANK[verdict]) verdict = next;
  };

  // 禁止项的 substring 规则还要在**整条表达式**上跑一遍。
  // extractLicenseIds 按空白切词是给 SPDX 表达式用的，而 substring 规则针对的是
  // package.json 里的自由文本 license 字段：`Commercial Only` 会被切成 Commercial / Only，
  // 逐词都匹配不上「commercial only」，于是掉进 unknown —— 报告里看不出这是商业条款。
  // 整串匹配把这条路堵上；合法 SPDX 表达式不含这些词组，不会误伤。
  if (inSubstringList(policy.forbidden?.substringCaseInsensitive, raw)) bump(VERDICT_FORBIDDEN);

  if (ids.length === 0) bump(VERDICT_UNKNOWN);
  for (const id of ids) bump(classifyLicenseId(id, policy));
  if (unknownExceptions.length > 0) bump(VERDICT_UNKNOWN);

  return { verdict, ids, exceptions, unknownExceptions };
}

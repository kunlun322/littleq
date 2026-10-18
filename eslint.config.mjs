// LittleQ 统一 ESLint 扁平配置。
//
// 边界规则不是手写的：它们从 config/dependency-graph.json 生成，与 CI 的
// tools/check-dependency-graph.mjs 共用同一份事实来源。ESLint 负责编辑器/提交前的
// 即时反馈，依赖图脚本负责 CI 上的权威判定（含 package.json 声明与跨单元相对路径解析）。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const graph = JSON.parse(
  readFileSync(path.join(repoRoot, 'config', 'dependency-graph.json'), 'utf8'),
);

function unitExists(unitDir) {
  try {
    readFileSync(path.join(repoRoot, unitDir, 'package.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function unitPackageName(unitDir) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, unitDir, 'package.json'), 'utf8'));
    return typeof manifest.name === 'string' ? manifest.name : null;
  } catch {
    return null;
  }
}

// "apps/*" -> 该层级下真实存在的单元目录；"packages/domain" -> 原样返回。
function expandUnitGlob(unitGlob) {
  if (!unitGlob.includes('*')) return unitExists(unitGlob) ? [unitGlob] : [];
  const parent = unitGlob.slice(0, unitGlob.indexOf('/'));
  const parentDir = path.join(repoRoot, parent);
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .filter(unitExists);
}

function prefixGroups(prefix) {
  if (prefix.endsWith('/')) return [`${prefix}*`, `${prefix}**`];
  if (prefix.endsWith('-')) return [`${prefix}*`, `${prefix}*/**`];
  return [prefix, `${prefix}/*`, `${prefix}/**`, `${prefix}-*`, `${prefix}-*/**`];
}

const boundary = new Map();

// 入向白名单（`inbound.default = "deny"`）要对**全部**真实单元生效，所以这里先把
// apps/* 与 packages/* 列盘。与 check-dependency-graph.mjs 的 discoverUnits 同一套发现方式：
// 新增一个单元即自动被约束，不需要回来补 ESLint 配置。
const ALL_UNIT_DIRS = ['apps', 'packages'].flatMap((group) => expandUnitGlob(`${group}/*`));

function addRestriction(unitDir, kind, key, message) {
  const entry = boundary.get(unitDir) ?? { paths: new Map(), patterns: new Map() };
  boundary.set(unitDir, entry);
  const bucket = kind === 'path' ? entry.paths : entry.patterns;
  if (!bucket.has(key)) bucket.set(key, message);
}

for (const rule of graph.rules) {
  const message = `${rule.id}: ${rule.description}（${rule.spec}）`;
  for (const unitDir of rule.from.flatMap(expandUnitGlob)) {
    const deny = rule.deny ?? {};
    for (const pkg of deny.packages ?? []) addRestriction(unitDir, 'path', pkg, message);
    for (const prefix of deny.packagePrefixes ?? []) {
      for (const group of prefixGroups(prefix)) addRestriction(unitDir, 'pattern', group, message);
    }
    for (const glob of deny.sourcePathGlobs ?? []) {
      addRestriction(unitDir, 'pattern', glob, message);
      addRestriction(unitDir, 'pattern', glob.replace(/\/\*\*$/, '/*'), message);
    }
    for (const targetGlob of deny.units ?? []) {
      for (const target of expandUnitGlob(targetGlob)) {
        if (target === unitDir) continue;
        const name = unitPackageName(target);
        if (name) addRestriction(unitDir, 'path', name, message);
        addRestriction(unitDir, 'pattern', `**/${target}/**`, message);
      }
    }
  }

  // 入向白名单：把「谁可以依赖我」翻译成每个非白名单单元的 no-restricted-imports。
  // 目标单元尚未落地时不生成任何规则 —— 与 check-dependency-graph.mjs 的行为一致。
  const inbound = rule.inbound;
  if (inbound?.default === 'deny' && unitExists(inbound.targetUnit)) {
    const allowed = new Set(inbound.allowFrom ?? []);
    const name = unitPackageName(inbound.targetUnit);
    for (const unitDir of ALL_UNIT_DIRS) {
      if (unitDir === inbound.targetUnit || allowed.has(unitDir)) continue;
      if (name) addRestriction(unitDir, 'path', name, message);
      addRestriction(unitDir, 'pattern', `**/${inbound.targetUnit}/**`, message);
    }
  }
}

const boundaryConfigs = [...boundary.entries()].map(([unitDir, entry]) => ({
  name: `littleq/boundary/${unitDir}`,
  files: [`${unitDir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [...entry.paths.entries()].map(([name, message]) => ({ name, message })),
        patterns: [...entry.patterns.entries()].map(([group, message]) => ({
          group: [group],
          message,
        })),
      },
    ],
  },
}));

export default tseslint.config(
  {
    name: 'littleq/ignores',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'artifacts/**',
      'tools/__fixtures__/**',
      'THIRD_PARTY_LICENSES',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: 'littleq/language',
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      // ignoreRestSiblings：`({ licenseFile, ...rest }) => rest` 这种「解构即剔除」写法里，
      // 被解构出来的变量本来就不该被读 —— 它存在的唯一目的就是不出现在 rest 里。
      // 仓库里用它把 bundle 报告中的本机绝对路径剥掉（运行时路径不是交付物）。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    name: 'littleq/browser-globals',
    files: ['packages/design-system/**/*.ts', 'apps/web/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  ...boundaryConfigs,
  {
    name: 'littleq/tests',
    files: ['**/test/**/*.ts', '**/*.test.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

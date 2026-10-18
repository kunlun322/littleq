import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as domain from '../src/index.js';

/**
 * 包级自述与出口测试。
 *
 * 这里刻意不做「把全部导出名字列一遍」的快照式断言：那种测试只会在新加一个导出时红
 * 一次，然后被机械地更新，它守护的不是任何设计事实。真正需要被钉住的是两件事 ——
 * 单元自述（组合根与 e2e smoke 都读它），以及**零运行时依赖**（附录 A §3.5 的硬约束，
 * 也是 §5 的禁止出口之一）。
 *
 * 「不得导入平台 SDK / 其它 workspace 单元」由 `config/dependency-graph.json` 的三条
 * domain 规则强制，权威判定在 `tools/check-dependency-graph.mjs`（含负向 fixture 对照），
 * 编辑器侧由 `eslint.config.mjs` 同源生成 —— 这里不再重复实现一个更弱的检测器。
 */
describe('@littleq/domain 单元自述', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(domain.UNIT_ID).toBe('@littleq/domain');
  });

  it('自述为领域层且已不再是骨架', () => {
    expect(domain.unitManifest.unitId).toBe('@littleq/domain');
    expect(domain.unitManifest.layer).toBe('domain');
    expect(domain.unitManifest.skeletonOnly).toBe(false);
    expect(domain.unitManifest.spec).toContain('§1.3');
  });

  it('出口覆盖值对象、状态机、错误、实体、策略五层', () => {
    // 每一层取一个代表性导出。用属性访问而不是字符串键，因此某个导出被删掉时这里
    // 先编译不过，而不是在运行期悄悄变成 undefined。
    expect(typeof domain.parseUuidV7).toBe('function');
    expect(typeof domain.canTransition).toBe('function');
    expect(Array.isArray(domain.DOMAIN_ERROR_CATALOG)).toBe(true);
    expect(Array.isArray(domain.TRANSITION_TABLES)).toBe(true);
    expect(typeof domain.createAiTask).toBe('function');
    expect(typeof domain.decideTaskAdmission).toBe('function');
  });
});

describe('@littleq/domain 依赖边界', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;

  it('package.json 里不存在任何依赖字段', () => {
    // 断言的是**字段本身不存在**，不是「字段存在但为空对象」：后者留下了一条「顺手加
    // 一个依赖」的物理路径，而依赖图门禁只认 workspace 内的单元名，拦不住一个新加进来
    // 的第三方包 —— 它既不在 dependency-graph.json 的规则里，也不在许可证闭包之外。
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      expect(Object.hasOwn(manifest, field), `${field} 必须不存在`).toBe(false);
    }
  });

  it('构建脚本不引入 workspace 之外的可执行文件', () => {
    // `tsc -b` 来自根 node_modules 的 TypeScript，不是本包依赖 —— 这正是「零 dependencies
    // 也能构建」成立的原因。一旦这里出现别的命令，就说明本包偷偷需要了什么。
    expect(manifest['scripts']).toEqual({ build: 'tsc -b' });
  });
});

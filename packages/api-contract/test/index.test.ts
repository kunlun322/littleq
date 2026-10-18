import { describe, expect, it } from 'vitest';

import { UNIT_ID, unitManifest } from '../src/index.js';

/**
 * 包级自述钉版 —— 与其余 8 个单元的 `test/index.test.ts` 同构，本包是最后一个补上的。
 *
 * `skeletonOnly: false` 是**规格值**而不是测量值：`src/index.ts` 的注释已写明本包自创建起
 * 就是实现、不是骨架（附录 A §6.8）。钉它不违反「不许把观测量写进契约」那条纪律。
 *
 * 值得单独钉的理由是它此前**完全无保护**：把 `src/index.ts` 的这个字段翻成 `true`，整条
 * 17 道门禁链一次都不红（ZLQ-181 QA 实测 `VERIFY_EXIT=0`，测试文件数与用例数均不变），
 * 因为组合根与 e2e smoke 读它，却没有任何断言校对它。翻牌必须与实现落在同一次提交里，
 * 这条断言就是让「误翻」在提交前而不是在运行期被发现。
 *
 * 断言放在 `test/index.test.ts` 而不是塞进 `schemas.test.ts`：契约测试文件里混入「单元
 * 自述」这类断言，后续既难找也难判断它归谁维护。
 */
describe('@littleq/api-contract 单元自述', () => {
  it('暴露与 package.json 一致的单元标识', () => {
    expect(UNIT_ID).toBe('@littleq/api-contract');
    expect(unitManifest.unitId).toBe('@littleq/api-contract');
  });

  it('自述为契约层且已不再是骨架', () => {
    expect(unitManifest.layer).toBe('contract');
    expect(unitManifest.skeletonOnly).toBe(false);
    expect(unitManifest.spec).toContain('§1.3');
  });

  it('装配依赖只有领域层', () => {
    // `dependsOn` 只列 workspace 内的下层单元，第三方包（zod / zod-openapi）不进这张表：
    // 它给组合根做启动自检用，第三方依赖的边界由许可证闭包与 dependency-graph 各自管。
    expect(unitManifest.dependsOn).toEqual(['@littleq/domain']);
  });
});

import { expect, it } from 'vitest';

import { unitManifest } from '../src/index.js';

// 门 1 + 门 5 对照：下面这一行**同时**带着就绪面名字（skeletonOnly）与断言（expect / .toBe），
// 形状上完全合格 —— 但它被 it.skip 退役了，活的用例数为 0。
// 门 1 判红 1 处，门 5 判红 1 处，合计 2 处。
// 这证明门 1 查的是「tripwire 活着」，而不只是「tripwire 那行字存在」。
it.skip('skeletonOnly 冻结为 true', () => expect(unitManifest.skeletonOnly).toBe(true));

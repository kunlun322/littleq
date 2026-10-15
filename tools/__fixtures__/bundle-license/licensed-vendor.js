/*!
 * @license MIT
 * @preserve
 * SPDX-License-Identifier: MIT
 *
 * 控制用例：这段以「斜杠+两个星号+叹号」开头的法务注释，必须在 minify 之后原样活下来
 * （ZLQ-153 §10.2 / §10.3）。真实的 zod 发行产物里一条 @license 注释都没有，所以拿真
 * bundle 断言「法务注释被保留」是一条空断言 —— 0 进 0 出，怎么都通过。这里用一个确实
 * 带法务注释的假包把机制本身测出来。值用显式假哨兵，夹具不是真依赖，也不参与安装。
 */
export const licensedValue = 'LQ_TEST_SENTINEL_FAKE';

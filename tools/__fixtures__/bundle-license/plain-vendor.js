// 普通注释（不是法务注释）：minify 之后必须消失。
// 这一条是 licensed-vendor 的反向对照 —— 没有它，「注释都被保留了」也能让断言通过，
// 那就测不出 legalComments:'inline' 与普通注释的区别。
export const plainValue = 'LQ_TEST_SENTINEL_PLAIN';

/* 块注释同样应当被 minify 去掉 */
export const plainBlock = 1;

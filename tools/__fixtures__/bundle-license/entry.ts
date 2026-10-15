// 控制用例入口：把「带法务注释的假包」与「只有普通注释的假包」一起打进 bundle，
// 让 tools/test/bundle-license.test.mjs 能同时断言正向保留与反向剥离。
// 用相对导入而不是 node_modules：.gitignore 排除了任意层级的 node_modules/，
// 而 git 无法重新包含「父目录已被排除」的文件，夹具一旦放进 node_modules 就进不了仓库。
import { licensedValue } from './licensed-vendor.js';
import { plainValue, plainBlock } from './plain-vendor.js';

export const fixtureEntry = { licensedValue, plainValue, plainBlock };

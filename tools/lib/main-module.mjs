// 「我是不是被直接执行的那个脚本」—— 两道静态门禁（dep-graph、unit-readiness）共用的判定。
//
// 为什么不各自写一行 `import.meta.url === pathToFileURL(process.argv[1]).href`：
// 那种写法在**符号链接路径**下会判假，而判假的后果不是报错，是 main() 根本不跑、
// 进程以 0 退出。macOS 的 os.tmpdir() 是 /tmp → /private/tmp，Node 又把 import.meta.url
// 解析成 realpath，于是「把 checker 复制到临时目录里跑一遍」这件事会静默什么都不查。
// 实测过：一棵种满违规的夹具树，这样跑出来是 exit 0、stdout 空、stderr 空 ——
// 种了几处完全不影响这个结论（这也是为什么这里不写具体条数：条数会随夹具演进漂移）。
//
// 一道会假绿的门禁比没有门禁更危险 —— 它在 CI 里同样是绿的，而且绿得毫无痕迹。
// 所以两侧都取 realpath 再比，且这个判定只允许有一份实现（和 stripComments 同理）。
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path; // 路径不存在时按原样比：判定为 false，绝不因为读不到就当自己是入口
  }
}

export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  return real(resolve(argv1)) === real(fileURLToPath(metaUrl));
}

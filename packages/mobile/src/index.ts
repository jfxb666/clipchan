/**
 * 手机端包的源码入口占位。
 *
 * ★ 历史：根 tsconfig 的 project references 里有 packages/mobile，而 tsc -b 对
 *   「include 匹配不到任何文件」会报 TS18003。这个文件当初就是为了让根
 *   `pnpm typecheck` 能作为收口命令而存在的。
 *
 * ★ 现状（Task 11 之后）：src/ 下已有真实源码（main.tsx / platform/mobile-adapter.ts），
 *   TS18003 不会再触发，这个常量已经没有构建上的必要。
 *   保留它是为了不删掉别人可能引用的公共符号；值改为 true 以反映「壳已搭好」的事实。
 *   手机端不是库，package.json 没有 main/exports，没有模块会 import 它。
 */
export const MOBILE_SHELL_READY = true;

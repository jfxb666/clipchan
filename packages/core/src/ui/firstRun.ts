/**
 * ★ 重点：首次使用引导的纯逻辑。EmptyState.tsx 只负责把 firstRunTips() 摆到 DOM 上。
 * 为什么单独一个文件：仓库的 vitest 只跑 node 环境、没有 jsdom，组件渲染不了；
 * 判定条件（什么时候该出现）才是容易写错的部分，抽出来才测得到。
 */
import type { KindFilter } from '../types';

export interface FirstRunTip {
  /** 一句话动作，比如「复制任何东西」。 */
  text: string;
  /** 动作下面的补充说明，小一号字。 */
  hint: string;
}

/**
 * 什么时候显示首次使用引导。
 *
 * - 有搜索词 → 不显示：用户已经在找东西，再塞三条教程只会挡路。
 * - 库里已经有记录 → 不显示：那说明用户早就上手了。
 * - 只在 kind === 'all' 时显示：其它分组（文本/图片/收藏…）有自己的空状态文案，
 *   在「收藏还是空的」下面再叠三条全局教程会很吵，而且那时用户已经会用基本操作了。
 *
 * q 按 trim 后判断，与 badges.ts 的 emptyHintOf 一致：只打了几个空格等同于没搜索，
 * 那时空状态显示的就是「口袋还是空的」，教程理应跟着出现。
 */
export function shouldShowFirstRun(kind: KindFilter, q: string, hasAnyItems: boolean): boolean {
  if (q.trim() !== '') return false;
  if (hasAnyItems) return false;
  return kind === 'all';
}

/** 三条引导：覆盖「进得来 / 用得上 / 截图」三件事，与 spec 的首次体验路径一致。 */
export function firstRunTips(): FirstRunTip[] {
  return [
    { text: '复制任何东西', hint: '在别的程序里按 Ctrl+C，回到这里就有了。文本、图片、文件都认' },
    { text: '双击粘贴', hint: '双击任意一条记录，直接粘到刚才那个窗口；也可以按 Enter' },
    { text: '截图标注', hint: '按 Ctrl+Alt+S 框选屏幕，标注完自动进历史；快捷键可在设置里改' },
  ];
}

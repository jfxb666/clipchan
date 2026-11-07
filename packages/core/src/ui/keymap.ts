/**
 * 全局键盘表（spec §7.7；计划 Task 9 步骤 ⑦）。
 *
 * ★ 抽成纯函数的原因：仓库里没有 jsdom / @testing-library（vitest.config.ts 只跑 node 环境），
 *   所以键盘逻辑不能靠"渲染 App 发 keydown"来测。这里把"按键 -> 动作"的判定全部收进来，
 *   单测断言动作，App.tsx 只负责把动作派发给 store。
 *
 * 判定顺序与旧版 / 早前 App.tsx 内联实现逐条一致（顺序本身是行为的一部分）：
 *   Esc 隐藏 -> Ctrl+F 聚焦搜索 -> Ctrl+M 拼接 -> Ctrl+D 收藏 -> Delete 删除
 *   -> 搜索框内 ↑/↓ 跳出到列表（其余按键不拦）-> Ctrl+Z 撤销 -> Ctrl+C 复制
 *   -> ↑/↓ 移动 -> Ctrl+Shift+V 纯文本粘贴 -> 数字 1-9 速贴 -> Enter 粘贴。
 *
 * ★ Esc 是全局表里唯一需要"让路"的判定：浮层与整理页各有自己的关闭语义，
 *   所有权由 KeyContext 的两个开关告诉这里，App.tsx 负责如实填。
 */
export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface KeyContext {
  /** 焦点在搜索框里（元素带 data-cc-search）。 */
  inSearch: boolean;
  /**
   * ★ 焦点在任意可编辑元素里（input / textarea / contentEditable）。
   * 只约束数字速贴这一个分支：设置 / 片段 / 优化等页面的文本框（AI 表单、自定义动作、
   * 各种数字/分隔符输入）里打的数字是内容不是指令，不能被劫持成「贴第 N 条」。
   * 搜索框是 input 的特例且已被 inSearch 覆盖，inEditable 是它的一般化。
   * Enter / Delete 在这些视图的既有行为不在本字段约束范围。
   */
  inEditable?: boolean;
  /** 当前选中集（取第一条做 Ctrl+D）。 */
  selectedIds: string[];
  /**
   * ★ 有浮层正开着（右键菜单 / 整理弹窗 / 全文大图 / OCR / 二维码 / AI 助手页）。
   * 浮层自己会接 Esc，全局表这时候必须让路：否则一次按键既关掉浮层又关掉整个面板，
   * 用户想撤一步就丢了视线（审计 BL-1「Esc 双关」）。
   */
  overlayOpen: boolean;
  /** ★ 「整理」整页视图开着：Esc 先退出整理，回到列表，不关面板。 */
  organizeOpen: boolean;
}

export type KeyAction =
  | { type: 'hide' }
  | { type: 'close-organize' }
  | { type: 'focus-search' }
  | { type: 'merge' }
  | { type: 'pin'; id: string }
  | { type: 'clear-unpinned' }
  | { type: 'remove-selected' }
  | { type: 'move'; delta: number; fromSearch?: boolean }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'paste-plain' }
  | { type: 'paste-index'; index: number }
  | { type: 'undo' }
  | { type: 'none' };

/** 该动作是否需要 preventDefault（'none' 不拦，让输入框照常收字符）。 */
export function shouldPreventDefault(action: KeyAction): boolean {
  return action.type !== 'none';
}

export function resolveKey(event: KeyEventLike, ctx: KeyContext): KeyAction {
  const mod = Boolean(event.ctrlKey || event.metaKey);
  const key = event.key;

  if (key === 'Escape') {
    // ★ 让路顺序：浮层 > 整理页 > 面板。浮层由它自己的监听器关，这里给 none
    //   就是"全局表什么都不做"；整理页没有自己的监听器，所以给它一个动作。
    if (ctx.overlayOpen) return { type: 'none' };
    if (ctx.organizeOpen) return { type: 'close-organize' };
    return { type: 'hide' };
  }
  if (mod && (key === 'f' || key === 'F')) return { type: 'focus-search' };
  if (mod && (key === 'm' || key === 'M')) return { type: 'merge' };
  if (mod && (key === 'd' || key === 'D')) {
    const id = ctx.selectedIds[0];
    return id ? { type: 'pin', id } : { type: 'none' };
  }
  if (key === 'Delete') return mod ? { type: 'clear-unpinned' } : { type: 'remove-selected' };

  if (ctx.inSearch) {
    // 搜索框里按 ↑ / ↓ 跳出到列表（spec §7.7：↓ 跳列表、↑ 回搜索框）。
    if (key === 'ArrowDown') return { type: 'move', delta: 1, fromSearch: true };
    if (key === 'ArrowUp') return { type: 'move', delta: -1, fromSearch: true };
    return { type: 'none' };
  }

  // ★ Ctrl+Z 放在 inSearch 分支**之后**：搜索框里 Ctrl+Z 是浏览器/输入框自己的
  //   撤销输入，抢过来会把用户刚打的字换回上一版。这与 ↑/↓ 在搜索框里不移动选中
  //   是同一条约定（输入框优先）。
  if (mod && (key === 'z' || key === 'Z')) return { type: 'undo' };

  // ★ Ctrl+C 同样放在 inSearch 分支之后：搜索框里 Ctrl+C 是输入框自己的复制，
  //   抢过来会把用户选中的搜索词换成列表里某一条。没有选中就返回 none —— 没东西
  //   可复制时不该拦按键（与 Ctrl+D 同一条约定）。
  if (mod && (key === 'c' || key === 'C')) {
    return ctx.selectedIds.length > 0 ? { type: 'copy' } : { type: 'none' };
  }

  if (key === 'ArrowDown') return { type: 'move', delta: 1 };
  if (key === 'ArrowUp') return { type: 'move', delta: -1 };
  // ★ Ctrl+Shift+V / Ctrl+Shift+Enter = 只贴纯文本（丢掉原记录的富文本格式）。
  //   shiftKey 必须单独读：按住 Shift 时 event.key 是大写 'V'，但输入法与布局
  //   不一定给大写，只看字符大小写会漏判。判定放在 inSearch 之后 —— 搜索框里
  //   Ctrl+Shift+V 仍是输入框自己的粘贴（与 Ctrl+Z 同一条"输入框优先"约定）。
  if (mod && event.shiftKey === true && (key === 'v' || key === 'V')) return { type: 'paste-plain' };
  if (mod && event.shiftKey === true && key === 'Enter') return { type: 'paste-plain' };
  // ★ 数字键速贴：只吃主键盘不带修饰键的 1-9，直接贴主列表第 N 条。
  //   放在 inSearch 早退之后，天然不会抢搜索框的输入（那里是打字）；
  //   浮层/整理页开着时也让路（与 Esc 同一条所有权约定，BL-1）：浮层自己的
  //   交互可能用到数字键，全局表这时候不能抢。越界（列表不足 N 条）由 App 端静默忽略。
  //   ★ 还要求 !ctx.inEditable：输入框（input/textarea/contentEditable）里打的数字
  //   是内容不是指令——数字速贴让路；Enter/Delete 在这些视图的既有行为不在本改动范围。
  if (
    !ctx.overlayOpen &&
    !ctx.organizeOpen &&
    !ctx.inEditable &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    /^[1-9]$/.test(event.key)
  ) {
    return { type: 'paste-index', index: Number(event.key) };
  }
  if (key === 'Enter') return { type: 'paste' };
  return { type: 'none' };
}

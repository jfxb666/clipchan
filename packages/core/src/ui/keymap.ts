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
 *   -> ↑/↓ 移动 -> Ctrl+Shift+V 纯文本粘贴 -> Enter 粘贴。
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
  /** 当前选中集（取第一条做 Ctrl+D）。 */
  selectedIds: string[];
}

export type KeyAction =
  | { type: 'hide' }
  | { type: 'focus-search' }
  | { type: 'merge' }
  | { type: 'pin'; id: string }
  | { type: 'clear-unpinned' }
  | { type: 'remove-selected' }
  | { type: 'move'; delta: number; fromSearch?: boolean }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'paste-plain' }
  | { type: 'undo' }
  | { type: 'none' };

/** 该动作是否需要 preventDefault（'none' 不拦，让输入框照常收字符）。 */
export function shouldPreventDefault(action: KeyAction): boolean {
  return action.type !== 'none';
}

export function resolveKey(event: KeyEventLike, ctx: KeyContext): KeyAction {
  const mod = Boolean(event.ctrlKey || event.metaKey);
  const key = event.key;

  if (key === 'Escape') return { type: 'hide' };
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
  if (key === 'Enter') return { type: 'paste' };
  return { type: 'none' };
}

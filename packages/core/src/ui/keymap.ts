/**
 * 全局键盘表（spec §7.7；计划 Task 9 步骤 ⑦）。
 *
 * ★ 抽成纯函数的原因：仓库里没有 jsdom / @testing-library（vitest.config.ts 只跑 node 环境），
 *   所以键盘逻辑不能靠"渲染 App 发 keydown"来测。这里把"按键 -> 动作"的判定全部收进来，
 *   单测断言动作，App.tsx 只负责把动作派发给 store。
 *
 * 判定顺序与旧版 / 早前 App.tsx 内联实现逐条一致（顺序本身是行为的一部分）：
 *   Esc 隐藏 -> Ctrl+F 聚焦搜索 -> Ctrl+M 拼接 -> Ctrl+D 收藏 -> Delete 删除
 *   -> 搜索框内 ↑/↓ 跳出到列表（其余按键不拦）-> ↑/↓ 移动 -> Enter 粘贴。
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
  | { type: 'paste' }
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

  if (key === 'ArrowDown') return { type: 'move', delta: 1 };
  if (key === 'ArrowUp') return { type: 'move', delta: -1 };
  if (key === 'Enter') return { type: 'paste' };
  return { type: 'none' };
}

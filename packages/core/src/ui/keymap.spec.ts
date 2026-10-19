/**
 * 全局键盘表单测（计划 Task 9 步骤 ⑦）。
 *
 * 仓库没有 jsdom / @testing-library，所以断言的是纯函数动作，不是真实 keydown。
 * 判定顺序本身是行为的一部分，因此顺序相关的用例都显式钉住。
 */
import { describe, expect, it } from 'vitest';
import { resolveKey, shouldPreventDefault, type KeyAction, type KeyContext } from './keymap';

const ctx = (inSearch: boolean, selectedIds: string[] = []): KeyContext => ({ inSearch, selectedIds });
const key = (k: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe('resolveKey', () => {
  it('Escape → hide', () => {
    expect(resolveKey(key('Escape'), ctx(false))).toEqual({ type: 'hide' });
  });

  it('Ctrl+F / Cmd+F → focus-search（大小写都认）', () => {
    expect(resolveKey(key('f', { ctrl: true }), ctx(false))).toEqual({ type: 'focus-search' });
    expect(resolveKey(key('F', { meta: true }), ctx(false))).toEqual({ type: 'focus-search' });
  });

  it('Ctrl+M → merge', () => {
    expect(resolveKey(key('m', { ctrl: true }), ctx(false))).toEqual({ type: 'merge' });
  });

  it('Ctrl+D → pin 取选中集第一条', () => {
    expect(resolveKey(key('d', { ctrl: true }), ctx(false, ['a', 'b']))).toEqual({ type: 'pin', id: 'a' });
  });

  it('Ctrl+D 但没有选中 → none', () => {
    expect(resolveKey(key('d', { ctrl: true }), ctx(false))).toEqual({ type: 'none' });
  });

  it('Delete → remove-selected，Ctrl+Delete → clear-unpinned', () => {
    expect(resolveKey(key('Delete'), ctx(false))).toEqual({ type: 'remove-selected' });
    expect(resolveKey(key('Delete', { ctrl: true }), ctx(false))).toEqual({ type: 'clear-unpinned' });
  });

  it('搜索框内 ↑ / ↓ 带 fromSearch 跳出到列表', () => {
    expect(resolveKey(key('ArrowDown'), ctx(true))).toEqual({ type: 'move', delta: 1, fromSearch: true });
    expect(resolveKey(key('ArrowUp'), ctx(true))).toEqual({ type: 'move', delta: -1, fromSearch: true });
  });

  it('搜索框内其它按键一律 none（打字不被拦，Enter 也不粘贴）', () => {
    for (const k of ['a', 'Enter', 'ArrowLeft', 'ArrowRight', ' ']) {
      expect(resolveKey(key(k), ctx(true, ['a']))).toEqual({ type: 'none' });
    }
  });

  it('列表内 ↑ / ↓ 不带 fromSearch，Enter → paste', () => {
    expect(resolveKey(key('ArrowDown'), ctx(false))).toEqual({ type: 'move', delta: 1 });
    expect(resolveKey(key('ArrowUp'), ctx(false))).toEqual({ type: 'move', delta: -1 });
    expect(resolveKey(key('Enter'), ctx(false))).toEqual({ type: 'paste' });
  });

  it('列表内普通字符 → none', () => {
    expect(resolveKey(key('a'), ctx(false))).toEqual({ type: 'none' });
    expect(resolveKey(key(' '), ctx(false))).toEqual({ type: 'none' });
  });

  it('顺序：搜索框内 Ctrl+M 仍是 merge（修饰键先判，不被 inSearch 吞掉）', () => {
    expect(resolveKey(key('m', { ctrl: true }), ctx(true))).toEqual({ type: 'merge' });
    expect(resolveKey(key('Escape'), ctx(true))).toEqual({ type: 'hide' });
  });

  it('顺序：无选中时的 Ctrl+Delete 仍是 clear-unpinned 而非 none', () => {
    expect(resolveKey(key('Delete', { ctrl: true }), ctx(true))).toEqual({ type: 'clear-unpinned' });
  });

  it('Ctrl+Z / Cmd+Z → undo（大小写都认）', () => {
    expect(resolveKey(key('z', { ctrl: true }), ctx(false))).toEqual({ type: 'undo' });
    expect(resolveKey(key('Z', { meta: true }), ctx(false))).toEqual({ type: 'undo' });
  });

  it('搜索框内 Ctrl+Z 不触发撤销（那是输入框自己的撤销输入）', () => {
    expect(resolveKey(key('z', { ctrl: true }), ctx(true))).toEqual({ type: 'none' });
  });

  it('不带修饰键的 z 在列表里也不触发 undo', () => {
    expect(resolveKey(key('z'), ctx(false))).toEqual({ type: 'none' });
  });
});

describe('shouldPreventDefault', () => {
  it('除 none 外都要拦默认行为', () => {
    const actions: KeyAction[] = [
      { type: 'hide' },
      { type: 'focus-search' },
      { type: 'merge' },
      { type: 'pin', id: 'a' },
      { type: 'clear-unpinned' },
      { type: 'remove-selected' },
      { type: 'move', delta: 1 },
      { type: 'move', delta: -1, fromSearch: true },
      { type: 'paste' },
      { type: 'undo' },
    ];
    for (const action of actions) expect(shouldPreventDefault(action)).toBe(true);
    expect(shouldPreventDefault({ type: 'none' })).toBe(false);
  });
});

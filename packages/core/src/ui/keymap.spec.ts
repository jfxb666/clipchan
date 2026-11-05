/**
 * 全局键盘表单测（计划 Task 9 步骤 ⑦）。
 *
 * 仓库没有 jsdom / @testing-library，所以断言的是纯函数动作，不是真实 keydown。
 * 判定顺序本身是行为的一部分，因此顺序相关的用例都显式钉住。
 */
import { describe, expect, it } from 'vitest';
import { resolveKey, shouldPreventDefault, type KeyAction, type KeyContext } from './keymap';

const ctx = (
  inSearch: boolean,
  selectedIds: string[] = [],
  extra: Partial<Pick<KeyContext, 'overlayOpen' | 'organizeOpen'>> = {},
): KeyContext => ({ inSearch, selectedIds, overlayOpen: false, organizeOpen: false, ...extra });
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

  // ★ BL-1「Esc 双关」的回归钉：浮层开着时全局表必须让路，否则一次按键
  //   既关掉浮层（浮层自己的监听器）又关掉面板（hide），用户撤一步就丢了整个界面。
  it('★ Escape 在浮层开着时让路（none），不关面板', () => {
    // 浮层由调用方如实上报（右键菜单 / 整理弹窗 / 全文大图 / OCR / 二维码 / AI 助手页）。
    expect(resolveKey(key('Escape'), ctx(false, [], { overlayOpen: true }))).toEqual({
      type: 'none',
    });
    // 焦点在搜索框里也一样让路：搜索框曾经自己接了一次 Esc，与这条叠成双关。
    expect(resolveKey(key('Escape'), ctx(true, [], { overlayOpen: true }))).toEqual({ type: 'none' });
  });

  it('★ Escape 在「整理」页时先退出整理，不关面板', () => {
    expect(resolveKey(key('Escape'), ctx(false, [], { organizeOpen: true }))).toEqual({
      type: 'close-organize',
    });
  });

  it('★ Escape 让路顺序：整理页里还开着浮层时，浮层优先（none）', () => {
    expect(
      resolveKey(key('Escape'), ctx(false, [], { overlayOpen: true, organizeOpen: true })),
    ).toEqual({ type: 'none' });
  });

  it('★ 只有 Escape 让路：浮层开着时 Ctrl+F / Delete 等照常生效', () => {
    expect(resolveKey(key('f', { ctrl: true }), ctx(false, [], { overlayOpen: true }))).toEqual({
      type: 'focus-search',
    });
    expect(resolveKey(key('Delete'), ctx(false, ['a'], { overlayOpen: true }))).toEqual({
      type: 'remove-selected',
    });
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

  it('Ctrl+C / Cmd+C 有选中 → copy（大小写都认）', () => {
    expect(resolveKey(key('c', { ctrl: true }), ctx(false, ['a']))).toEqual({ type: 'copy' });
    expect(resolveKey(key('C', { meta: true }), ctx(false, ['a']))).toEqual({ type: 'copy' });
    expect(resolveKey(key('c', { meta: true }), ctx(false, ['a', 'b']))).toEqual({ type: 'copy' });
  });

  it('Ctrl+C 没有选中 → none（没东西可复制就不拦按键）', () => {
    expect(resolveKey(key('c', { ctrl: true }), ctx(false))).toEqual({ type: 'none' });
    expect(resolveKey(key('c', { meta: true }), ctx(false))).toEqual({ type: 'none' });
  });

  it('搜索框内 Ctrl+C 不拦（那是输入框自己的复制，与 Ctrl+Z 同一约定）', () => {
    expect(resolveKey(key('c', { ctrl: true }), ctx(true, ['a']))).toEqual({ type: 'none' });
    expect(resolveKey(key('C', { meta: true }), ctx(true))).toEqual({ type: 'none' });
  });

  it('不带修饰键的 c 在列表里也不触发 copy', () => {
    expect(resolveKey(key('c'), ctx(false, ['a']))).toEqual({ type: 'none' });
    expect(resolveKey(key('C'), ctx(false, ['a']))).toEqual({ type: 'none' });
  });

  it('Ctrl+Shift+V → paste-plain（大小写都认）', () => {
    expect(resolveKey(key('v', { ctrl: true, shift: true }), ctx(false))).toEqual({ type: 'paste-plain' });
    expect(resolveKey(key('V', { ctrl: true, shift: true }), ctx(false))).toEqual({ type: 'paste-plain' });
    expect(resolveKey(key('V', { meta: true, shift: true }), ctx(false))).toEqual({ type: 'paste-plain' });
  });

  it('Ctrl+Shift+Enter → paste-plain', () => {
    expect(resolveKey(key('Enter', { ctrl: true, shift: true }), ctx(false))).toEqual({ type: 'paste-plain' });
  });

  it('Ctrl+V 不拦（留给浏览器 / 输入框自己的粘贴）', () => {
    expect(resolveKey(key('v', { ctrl: true }), ctx(false))).toEqual({ type: 'none' });
  });

  it('新增的 paste-plain 不影响 mod+M / mod+D / mod+Z', () => {
    expect(resolveKey(key('m', { ctrl: true, shift: true }), ctx(false))).toEqual({ type: 'merge' });
    expect(resolveKey(key('d', { ctrl: true, shift: true }), ctx(false, ['a']))).toEqual({ type: 'pin', id: 'a' });
    expect(resolveKey(key('z', { ctrl: true, shift: true }), ctx(false))).toEqual({ type: 'undo' });
  });

  it('搜索框内 Ctrl+Shift+V 不拦（输入框优先，与 Ctrl+Z 同一约定）', () => {
    expect(resolveKey(key('v', { ctrl: true, shift: true }), ctx(true))).toEqual({ type: 'none' });
  });
});

describe('数字键速贴（v1.2 A1）', () => {
  it('★ 非搜索态按 1-9 → paste-index（面板主列表第 N 条）', () => {
    expect(resolveKey(key('1'), ctx(false, ['a']))).toEqual({ type: 'paste-index', index: 1 });
    expect(resolveKey(key('9'), ctx(false, ['a']))).toEqual({ type: 'paste-index', index: 9 });
  });
  it('搜索态/浮层开时数字不触发（在输入框打数字不能被抢走）', () => {
    expect(resolveKey(key('1'), ctx(true, ['a']))).toEqual({ type: 'none' });
    expect(resolveKey(key('5'), { inSearch: false, selectedIds: [], overlayOpen: true, organizeOpen: false })).toEqual({ type: 'none' });
  });
  it('数字键在 shouldPreventDefault 覆盖内', () => {
    expect(shouldPreventDefault({ type: 'paste-index', index: 1 })).toBe(true);
  });
});

describe('shouldPreventDefault', () => {
  it('除 none 外都要拦默认行为', () => {
    const actions: KeyAction[] = [
      { type: 'hide' },
      { type: 'close-organize' },
      { type: 'focus-search' },
      { type: 'merge' },
      { type: 'pin', id: 'a' },
      { type: 'clear-unpinned' },
      { type: 'remove-selected' },
      { type: 'move', delta: 1 },
      { type: 'move', delta: -1, fromSearch: true },
      { type: 'copy' },
      { type: 'paste' },
      { type: 'paste-plain' },
      { type: 'undo' },
    ];
    for (const action of actions) expect(shouldPreventDefault(action)).toBe(true);
    expect(shouldPreventDefault({ type: 'none' })).toBe(false);
  });
});

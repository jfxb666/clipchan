import { describe, expect, it } from 'vitest';
import { acceleratorLabel, isValidAccelerator, keyEventToAccelerator, type HotkeyKeyEvent } from './settingsHotkey';

function evt(key: string, mods: Partial<HotkeyKeyEvent> = {}): HotkeyKeyEvent {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

describe('keyEventToAccelerator', () => {
  it('修饰键顺序固定为 Control → Alt → Shift → Super', () => {
    expect(keyEventToAccelerator(evt('k', { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }))).toBe(
      'Control+Alt+Shift+Super+K',
    );
    expect(keyEventToAccelerator(evt('c', { shiftKey: true, altKey: true }))).toBe('Alt+Shift+C');
  });

  it('字母转大写、数字原样', () => {
    expect(keyEventToAccelerator(evt('a', { ctrlKey: true }))).toBe('Control+A');
    expect(keyEventToAccelerator(evt('7', { ctrlKey: true }))).toBe('Control+7');
  });

  it('空格与方向键换成 accelerator 的写法', () => {
    expect(keyEventToAccelerator(evt(' ', { ctrlKey: true }))).toBe('Control+Space');
    expect(keyEventToAccelerator(evt('ArrowUp', { altKey: true }))).toBe('Alt+Up');
    expect(keyEventToAccelerator(evt('ArrowLeft', { ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+Left');
  });

  it('Esc / Enter / Backspace / Delete / Tab 换名', () => {
    expect(keyEventToAccelerator(evt('Escape', { ctrlKey: true }))).toBe('Control+Esc');
    expect(keyEventToAccelerator(evt('Enter', { ctrlKey: true }))).toBe('Control+Return');
    expect(keyEventToAccelerator(evt('Backspace', { altKey: true }))).toBe('Alt+Backspace');
    expect(keyEventToAccelerator(evt('Delete', { ctrlKey: true }))).toBe('Control+Delete');
    expect(keyEventToAccelerator(evt('Tab', { ctrlKey: true }))).toBe('Control+Tab');
  });

  it('F1-F24 原样保留，F25 不认', () => {
    expect(keyEventToAccelerator(evt('F1', { ctrlKey: true }))).toBe('Control+F1');
    expect(keyEventToAccelerator(evt('F12', { altKey: true }))).toBe('Alt+F12');
    expect(keyEventToAccelerator(evt('F24', { ctrlKey: true }))).toBe('Control+F24');
    expect(keyEventToAccelerator(evt('F25', { ctrlKey: true }))).toBe('');
  });

  it('★ 只按修饰键本身不产生组合', () => {
    expect(keyEventToAccelerator(evt('Control', { ctrlKey: true }))).toBe('');
    expect(keyEventToAccelerator(evt('Shift', { shiftKey: true }))).toBe('');
    expect(keyEventToAccelerator(evt('Alt', { altKey: true }))).toBe('');
    expect(keyEventToAccelerator(evt('Meta', { metaKey: true }))).toBe('');
  });

  it('★ 裸字母 / 裸数字 / 裸空格一律拒绝（会抢占打字）', () => {
    expect(keyEventToAccelerator(evt('a'))).toBe('');
    expect(keyEventToAccelerator(evt('5'))).toBe('');
    expect(keyEventToAccelerator(evt(' '))).toBe('');
  });

  it('功能键允许不带修饰键', () => {
    expect(keyEventToAccelerator(evt('F9'))).toBe('F9');
  });

  it('★ 标点可以录（默认热键本身就是 Ctrl+反引号）', () => {
    expect(keyEventToAccelerator(evt(String.fromCharCode(96), { ctrlKey: true }))).toBe(
      'Control+' + String.fromCharCode(96),
    );
    expect(keyEventToAccelerator(evt('/', { ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+/');
  });

  it('未支持的标点与未知键返回空串', () => {
    expect(keyEventToAccelerator(evt('+', { ctrlKey: true }))).toBe('');
    expect(keyEventToAccelerator(evt('Dead', { ctrlKey: true }))).toBe('');
    expect(keyEventToAccelerator(evt('Unidentified', { ctrlKey: true }))).toBe('');
  });
});

describe('isValidAccelerator', () => {
  it('空串无效', () => {
    expect(isValidAccelerator('')).toBe(false);
    expect(isValidAccelerator('   ')).toBe(false);
  });

  it('★ 既有默认值必须通过（Control+反引号 / Alt+C）', () => {
    expect(isValidAccelerator('Control+' + String.fromCharCode(96))).toBe(true);
    expect(isValidAccelerator('Alt+C')).toBe(true);
  });

  it('接受 keyEventToAccelerator 产出的任意组合', () => {
    const produced = keyEventToAccelerator(evt('ArrowRight', { ctrlKey: true, altKey: true }));
    expect(produced).toBe('Control+Alt+Right');
    expect(isValidAccelerator(produced)).toBe(true);
  });

  it('修饰键顺序无关，但拼错的修饰键无效', () => {
    expect(isValidAccelerator('Shift+Control+K')).toBe(true);
    expect(isValidAccelerator('Ctrl+K')).toBe(false);
    expect(isValidAccelerator('Cmd+K')).toBe(false);
  });

  it('没有修饰键的普通键无效，功能键有效', () => {
    expect(isValidAccelerator('K')).toBe(false);
    expect(isValidAccelerator('F5')).toBe(true);
  });

  it('未知主键无效', () => {
    expect(isValidAccelerator('Control+Dead')).toBe(false);
    expect(isValidAccelerator('Control+')).toBe(false);
  });
});

describe('acceleratorLabel', () => {
  it('空串给空串', () => {
    expect(acceleratorLabel('')).toBe('');
  });

  it('换成短标签', () => {
    expect(acceleratorLabel('Control+' + String.fromCharCode(96))).toBe('Ctrl + ' + String.fromCharCode(96));
    expect(acceleratorLabel('Alt+C')).toBe('Alt + C');
    expect(acceleratorLabel('Control+ArrowUp')).toBe('Ctrl + ArrowUp');
    expect(acceleratorLabel('Control+Up')).toBe('Ctrl + ↑');
    expect(acceleratorLabel('Control+Return')).toBe('Ctrl + Enter');
    expect(acceleratorLabel('Super+Shift+K')).toBe('Win + Shift + K');
  });
});

/**
 * 快捷键字符串的生成 / 校验 / 显示（纯函数，node 环境可测）。
 * ★ 录制时宁可返回 '' 也不给出一个 Electron 注册不上、界面上却显示"已设置"的组合：
 *   注册失败是静默的，用户只会觉得热键坏了。
 */

export interface HotkeyKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** 单独按下的修饰键本身，不能当主键。 */
const MODIFIER_KEY_NAMES = ['Control', 'Alt', 'Shift', 'Meta'];
/** Electron accelerator 里认可的修饰键拼写（我们用 Super 表示 Win/Cmd）。 */
const ACCELERATOR_MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'];

const NAMED_KEYS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Return',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
};

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

function isFunctionKey(main: string): boolean {
  return FUNCTION_KEY.test(main);
}

function isPrintableKey(main: string): boolean {
  if (main.length !== 1) return false;
  const code = main.charCodeAt(0);
  // 可打印 ASCII，但排除空格与 '+'（'+' 是 accelerator 的分隔符，拼进去就切不开）。
  return code >= 0x21 && code <= 0x7e && main !== '+';
}

/** KeyboardEvent.key → accelerator 主键；不认识的返回 ''。 */
function mainKeyOf(key: string): string {
  const named = NAMED_KEYS[key];
  if (named !== undefined) return named;
  if (/^[A-Za-z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (isFunctionKey(key)) return key;
  // ★ 标点也要能录：默认热键本身就是 Ctrl+`，只认字母/数字会让用户改不回默认值。
  if (isPrintableKey(key)) return key;
  return '';
}

export function keyEventToAccelerator(e: HotkeyKeyEvent): string {
  if (MODIFIER_KEY_NAMES.includes(e.key)) return '';
  const main = mainKeyOf(e.key);
  if (main === '') return '';

  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  // 裸键会抢占正常打字（Space/Tab/字母都算），只有功能键允许不带修饰键。
  if (mods.length === 0 && !isFunctionKey(main)) return '';

  return [...mods, main].join('+');
}

/** 合法的具名主键：accelerator 写法与 KeyboardEvent.key 写法都收，避免把既存配置判成非法。 */
const NAMED_MAIN_KEYS = new Set([...Object.keys(NAMED_KEYS), ...Object.values(NAMED_KEYS)]);

function isSupportedMainKey(main: string): boolean {
  if (NAMED_MAIN_KEYS.has(main)) return true;
  if (isFunctionKey(main)) return true;
  return isPrintableKey(main);
}

export function isValidAccelerator(acc: string): boolean {
  const text = (acc ?? '').trim();
  if (text.length === 0) return false;

  const parts = text.split('+');
  const main = parts[parts.length - 1] ?? '';
  const mods = parts.slice(0, -1);
  if (mods.some((m) => !ACCELERATOR_MODIFIERS.includes(m))) return false;
  if (!isSupportedMainKey(main)) return false;
  // 与 keyEventToAccelerator 保持同一口径：没有修饰键时只认功能键。
  if (mods.length === 0) return isFunctionKey(main);
  return true;
}

const DISPLAY_LABELS: Record<string, string> = {
  Control: 'Ctrl',
  Super: 'Win',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Return: 'Enter',
  Esc: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  Space: 'Space',
  Tab: 'Tab',
};

/** 显示用短标签；不认识的片段原样保留，不吞字符。 */
export function acceleratorLabel(acc: string): string {
  const text = (acc ?? '').trim();
  if (text.length === 0) return '';
  return text
    .split('+')
    .map((part) => DISPLAY_LABELS[part] ?? part)
    .join(' + ');
}

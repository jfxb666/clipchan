import type { Kind } from '../types';

type TextKind = Exclude<Kind, 'image'>;

const CODE_KEYWORDS = [
  'function ', 'def ', 'class ', 'import ', 'public ', 'private ', 'void ',
  'const ', 'let ', 'var ', 'return ', 'SELECT ', 'select ', 'using ',
  'namespace ', 'console.log', 'println', '#!/', '<?xml', '<html',
  '{\n', '};', '=>', '()', ');',
];

const SYMBOLS = ['{', '}', ';', '(', ')', '=', '<', '>'];

function looksLikeCode(t: string): boolean {
  for (const kw of CODE_KEYWORDS) {
    if (t.includes(kw)) return true;
  }
  if (t.length >= 12) {
    let hits = 0;
    for (const ch of t) {
      if (SYMBOLS.includes(ch)) hits++;
    }
    if (hits / t.length >= 0.12) return true;
  }
  return false;
}

function isLink(t: string): boolean {
  const lower = t.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://')
    || lower.startsWith('www.') || lower.startsWith('ftp://');
}

function isPath(t: string): boolean {
  if (t.startsWith('\\\\')) return true;
  if (t.length > 2) {
    const c0 = t[0]!;
    const c1 = t[1]!;
    const c2 = t[2]!;
    const letter = (c0 >= 'a' && c0 <= 'z') || (c0 >= 'A' && c0 <= 'Z');
    if (letter && c1 === ':' && (c2 === '\\' || c2 === '/')) return true;
  }
  return false;
}

function isNumber(t: string): boolean {
  if (t.length === 0 || t.length > 24) return false;
  let digits = 0;
  for (const ch of t) {
    if (ch >= '0' && ch <= '9') { digits++; continue; }
    if (ch === '.' || ch === ',' || ch === '-' || ch === '+' || ch === '%' || ch === ' ') continue;
    return false;
  }
  return digits >= 1;
}

/**
 * 把一段文本归类。规则顺序与旧版 legacy/src/ClipClassifier.cs 完全一致：
 * 单行 → 链接 → 路径 → 纯数字 → 代码特征 → 文本。
 */
export function classify(text: string): TextKind {
  const t = text.trim();
  const singleLine = !t.includes('\n') && !t.includes('\r');
  if (singleLine) {
    if (isLink(t)) return 'link';
    if (isPath(t)) return 'path';
    if (isNumber(t)) return 'number';
  }
  if (looksLikeCode(t)) return 'code';
  return 'text';
}

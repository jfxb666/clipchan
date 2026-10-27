/**
 * 搜索语法提示 —— 纯函数层（零 React、零副作用），供 SearchBar 与单测共用。
 *
 * 为什么单独拆一个文件：解析器（logic/searchQuery）只负责「能不能解析」，
 * 面向用户的文案（速查表、错误翻译）属于展示层，混进解析器会让那边多出一堆
 * 与查询无关的字符串常量，也不方便单测。
 */

/**
 * 搜索框语法速查。每条一行、尽量短，因为它是 title 提示，鼠标悬停时一次性
 * 全部展示；长句会挤成一坨看不清。
 */
export const SEARCH_SYNTAX_HINTS: string[] = [
  '"a b" 短语整体匹配',
  'AND / && 并且',
  'OR / || 或者',
  'NOT / ! 取反',
  '/正则/i 正则匹配',
  're:正则 正则匹配',
  'after:2024-01-01 之后',
  'before:2024-12-31 之前',
  '(a OR b) 括号分组',
];

/** 解析器给出的错误前缀 → 中文说明。未列出的前缀一律原样透出。 */
const ERROR_LABELS: Record<string, string> = {
  'invalid-regex': '正则不合法',
  'invalid-date': '日期不合法',
};

/**
 * 把 parseSearch 的 errors 翻成人话。
 * ★ 只翻译前缀，后半段原文（用户写错的片段）必须留着：提示要告诉用户
 *   「哪里错了」，把 `/[a-` 吞掉就只剩一句无用的「正则不合法」。
 */
export function formatSearchErrors(errors: string[]): string {
  return errors
    .map((error) => {
      const sep = error.indexOf(': ');
      if (sep < 0) return error;
      const label = ERROR_LABELS[error.slice(0, sep)];
      // 未知前缀（如 unclosed-quote）原样保留，宁可露出内部格式，也不要吞掉信息。
      if (!label) return error;
      return label + '：' + error.slice(sep + 2);
    })
    .join('；');
}

/** 布尔运算符必须独立成词，否则 a&&b、ORANGE 这种字面量会被误判。 */
const BOOLEAN_WORD = /\b(AND|OR|NOT)\b/i;

/** 字段前缀（after:/before:/re:）。 */
const FIELD_PREFIX = /\b(after|before|re):/i;

/** ! 只在词首算取反：a!b 这类代码片段太常见，按词首判断可以避免误报。 */
const LEADING_NOT = /(^|\s)!/;

/**
 * 判断输入是否「看起来」用了高级语法，用来决定要不要露出语法速查入口。
 * 故意允许保守（宁可多显示一次）：它只控制一个提示按钮，误判的成本很低，
 * 而用户正卡在语法上时看不到入口的成本很高。
 */
export function looksLikeAdvancedQuery(input: string): boolean {
  const text = input.trim();
  if (text.length === 0) return false;

  // 斜杠成对才算正则；/usr/local/bin 这类路径也会命中，可接受（见函数注释）。
  const slashes = text.split('/').length - 1;
  if (slashes >= 2 && slashes % 2 === 0) return true;

  if (BOOLEAN_WORD.test(text)) return true;
  if (FIELD_PREFIX.test(text)) return true;
  if (text.includes('&&') || text.includes('||')) return true;
  if (text.includes('(') || text.includes(')')) return true;
  if (LEADING_NOT.test(text)) return true;
  return false;
}

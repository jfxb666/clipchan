import { describe, expect, it } from 'vitest';
import {
  SEARCH_SYNTAX_HINTS,
  formatSearchErrors,
  looksLikeAdvancedQuery,
} from './searchHints';

describe('SEARCH_SYNTAX_HINTS（语法速查表）', () => {
  it('非空', () => {
    expect(SEARCH_SYNTAX_HINTS.length).toBeGreaterThan(0);
  });

  it('每条都不含换行且不为空串', () => {
    for (const hint of SEARCH_SYNTAX_HINTS) {
      expect(hint.length).toBeGreaterThan(0);
      expect(hint).not.toContain('\n');
      expect(hint).not.toContain('\r');
    }
  });

  it('覆盖短语、布尔、正则、时间与括号', () => {
    const joined = SEARCH_SYNTAX_HINTS.join('\n');
    for (const keyword of ['"a b"', 'AND', '&&', 'OR', '||', 'NOT', '!', '/', 're:', 'after:', 'before:', '(', ')']) {
      expect(joined).toContain(keyword);
    }
  });
});

describe('formatSearchErrors（错误翻译）', () => {
  it('没有错误时返回空串', () => {
    expect(formatSearchErrors([])).toBe('');
  });

  it('invalid-regex 翻成中文并保留原始片段', () => {
    const text = formatSearchErrors(['invalid-regex: /[a-']);
    expect(text).toContain('正则不合法');
    expect(text).toContain('/[a-');
  });

  it('invalid-date 翻成中文并保留原始片段', () => {
    const text = formatSearchErrors(['invalid-date: 2024-13-45']);
    expect(text).toContain('日期不合法');
    expect(text).toContain('2024-13-45');
  });

  it('多条错误用「；」连接', () => {
    const text = formatSearchErrors(['invalid-regex: /[a-', 'invalid-date: 2024-13-45']);
    expect(text).toBe('正则不合法：/[a-；日期不合法：2024-13-45');
  });

  it('未知前缀原样保留', () => {
    expect(formatSearchErrors(['unclosed-quote: hello'])).toBe('unclosed-quote: hello');
  });

  it('没有冒号分隔的错误整条原样保留', () => {
    expect(formatSearchErrors(['weird'])).toBe('weird');
  });

  it('未知前缀与已知前缀混排时逐条处理', () => {
    const text = formatSearchErrors(['unclosed-quote: hi', 'invalid-regex: a[']);
    expect(text).toBe('unclosed-quote: hi；正则不合法：a[');
  });
});

describe('looksLikeAdvancedQuery（是否像高级查询）', () => {
  it('普通中文与单词返回 false', () => {
    expect(looksLikeAdvancedQuery('hello')).toBe(false);
    expect(looksLikeAdvancedQuery('中文')).toBe(false);
    expect(looksLikeAdvancedQuery('')).toBe(false);
    expect(looksLikeAdvancedQuery('   ')).toBe(false);
    expect(looksLikeAdvancedQuery('ORANGE')).toBe(false);
    expect(looksLikeAdvancedQuery('a!b')).toBe(false);
  });

  it('正则、布尔、取反、字段前缀、括号返回 true', () => {
    expect(looksLikeAdvancedQuery('/ab/')).toBe(true);
    expect(looksLikeAdvancedQuery('a AND b')).toBe(true);
    expect(looksLikeAdvancedQuery('a and b')).toBe(true);
    expect(looksLikeAdvancedQuery('!foo')).toBe(true);
    expect(looksLikeAdvancedQuery('after:2024-01-01')).toBe(true);
    expect(looksLikeAdvancedQuery('before:2024-12-31')).toBe(true);
    expect(looksLikeAdvancedQuery('re:ab')).toBe(true);
    expect(looksLikeAdvancedQuery('(a or b)')).toBe(true);
  });

  it('符号运算符返回 true', () => {
    expect(looksLikeAdvancedQuery('a && b')).toBe(true);
    expect(looksLikeAdvancedQuery('a || b')).toBe(true);
  });
});

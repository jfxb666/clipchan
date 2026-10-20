import { describe, expect, it } from 'vitest';
import hljs from 'highlight.js/lib/core';
import {
  HIGHLIGHT_MAX_CHARS,
  HLJS_LANGUAGES,
  guessLanguage,
  highlightToHtml,
  shouldHighlight,
} from './codeHighlight';

describe('guessLanguage', () => {
  it('认得出常见语言', () => {
    expect(guessLanguage('const a = 1;\nfunction f() {}')).toBe('javascript');
    expect(guessLanguage('def foo():\n    pass')).toBe('python');
    expect(guessLanguage('public class A { private void b() {} }')).toBe('java');
    expect(guessLanguage('SELECT * FROM t')).toBe('sql');
    expect(guessLanguage('随便一段中文，没有任何代码特征')).toBeNull();
  });

  it('只返回注册表里的语言或 null（不变量）', () => {
    const samples = [
      'const a = 1;\nfunction f() {}',
      'def foo():\n    pass',
      'public class A { private void b() {} }',
      'SELECT * FROM t',
      'fn main() { let mut x = 1; }',
      'package main\nfunc main() {}',
      '#include <stdio.h>',
      'using System;\nclass A {}',
      '<?xml version="1.0"?><a/>',
      '#!/bin/bash\necho hi',
      'interface A { x: string }',
      'a { color: red; }',
      '随便一段中文，没有任何代码特征',
      '',
    ];
    for (const sample of samples) {
      const language = guessLanguage(sample);
      if (language !== null) {
        expect(HLJS_LANGUAGES, `猜出了注册表外的语言：${language}`).toContain(language);
      }
    }
  });
});

describe('shouldHighlight', () => {
  it('三条边界：非代码类 / 有搜索词 / 超阈值 都不高亮', () => {
    expect(shouldHighlight('code', 'const a = 1', '')).toBe(true);
    expect(shouldHighlight('text', 'const a = 1', '')).toBe(false);
    expect(shouldHighlight('code', 'const a = 1', 'const')).toBe(false);
    expect(shouldHighlight('code', 'x'.repeat(HIGHLIGHT_MAX_CHARS + 1), '')).toBe(false);
  });

  it('阈值边界：正好等于 HIGHLIGHT_MAX_CHARS 仍然高亮', () => {
    expect(shouldHighlight('code', 'x'.repeat(HIGHLIGHT_MAX_CHARS), '')).toBe(true);
    expect(HIGHLIGHT_MAX_CHARS).toBe(8000);
  });
});

describe('highlightToHtml', () => {
  it('转义 HTML 特殊字符', () => {
    const html = highlightToHtml('<div>a && b</div>', 'xml');
    expect(html).not.toContain('<div>');
    expect(html).toContain('&lt;');
  });

  it('未知语言回落成转义后的纯文本（不抛、不返回空）', () => {
    const html = highlightToHtml('<b>a & b</b>', '不存在的语言');
    expect(html).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });
});

describe('HLJS_LANGUAGES', () => {
  it('13 种语言都已被 hljs 注册（getLanguage 非空）', () => {
    expect(HLJS_LANGUAGES.length).toBe(13);
    for (const name of HLJS_LANGUAGES) {
      expect(hljs.getLanguage(name), `未注册：${name}`).toBeTruthy();
    }
  });
});

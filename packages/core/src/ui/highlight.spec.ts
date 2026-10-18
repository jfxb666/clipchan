import { describe, expect, it } from 'vitest';
import { highlightSegments } from './highlight';

/** 拼接回原文是所有用例的硬约束：漏字或多字都会让预览显示错。 */
function joined(segments: ReturnType<typeof highlightSegments>): string {
  return segments.map((segment) => segment.text).join('');
}

describe('highlightSegments（搜索词分段）', () => {
  it('空 term 返回整段未命中', () => {
    expect(highlightSegments('hello world', '')).toEqual([{ text: 'hello world', hit: false }]);
  });

  it('term 只有空白也算空', () => {
    expect(highlightSegments('hello', '   ')).toEqual([{ text: 'hello', hit: false }]);
  });

  it('空 text 返回空数组', () => {
    expect(highlightSegments('', 'abc')).toEqual([]);
    expect(highlightSegments('', '')).toEqual([]);
  });

  it('命中一次且位于中间', () => {
    expect(highlightSegments('abcdef', 'cd')).toEqual([
      { text: 'ab', hit: false },
      { text: 'cd', hit: true },
      { text: 'ef', hit: false },
    ]);
  });

  it('命中在开头', () => {
    expect(highlightSegments('abcdef', 'ab')).toEqual([
      { text: 'ab', hit: true },
      { text: 'cdef', hit: false },
    ]);
  });

  it('命中在结尾', () => {
    expect(highlightSegments('abcdef', 'ef')).toEqual([
      { text: 'abcd', hit: false },
      { text: 'ef', hit: true },
    ]);
  });

  it('多处命中逐段切出', () => {
    expect(highlightSegments('aXbXc', 'X')).toEqual([
      { text: 'a', hit: false },
      { text: 'X', hit: true },
      { text: 'b', hit: false },
      { text: 'X', hit: true },
      { text: 'c', hit: false },
    ]);
  });

  it('大小写不敏感且保留原文大小写', () => {
    expect(highlightSegments('Hello World', 'WORLD')).toEqual([
      { text: 'Hello ', hit: false },
      { text: 'World', hit: true },
    ]);
  });

  it('未命中返回整段未命中', () => {
    expect(highlightSegments('hello', 'zzz')).toEqual([{ text: 'hello', hit: false }]);
  });

  it('term 不按空格拆词，整串匹配', () => {
    expect(highlightSegments('foo bar baz', 'foo bar')).toEqual([
      { text: 'foo bar', hit: true },
      { text: ' baz', hit: false },
    ]);
  });

  it('term 自带空白会被 trim 后再匹配', () => {
    expect(highlightSegments('abc', '  b  ')).toEqual([
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'c', hit: false },
    ]);
  });

  it('相邻命中不重叠', () => {
    expect(highlightSegments('aaaa', 'aa')).toEqual([
      { text: 'aa', hit: true },
      { text: 'aa', hit: true },
    ]);
  });

  it('各段拼接后等于原文', () => {
    const cases: [string, string][] = [
      ['Hello World', 'o'],
      ['剪贴板酱 clipboard', 'clip'],
      [' 前导空格与后置空格 ', '空格'],
      ['no-hit', 'xyz'],
      ['ABCabcABC', 'abc'],
    ];
    for (const [text, term] of cases) {
      expect(joined(highlightSegments(text, term))).toBe(text);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  SNIPPET_CONTENT_MAX,
  SNIPPET_TITLE_MAX,
  emptySnippetHint,
  snippetLabel,
  snippetMeta,
  snippetPreview,
  sortSnippets,
  validateSnippet,
} from './snippetView';
import type { Snippet } from '../types';

const snippet = (id: string, updatedAt: number): Snippet => ({
  id,
  title: 't' + id,
  content: 'c' + id,
  createdAt: 0,
  updatedAt,
  useCount: 0,
});

describe('snippetLabel', () => {
  it('有标题用标题（去掉首尾空白）', () => {
    expect(snippetLabel({ title: '  客服话术  ', content: '正文' })).toBe('客服话术');
  });

  it('标题是空白串时退回内容首行', () => {
    expect(snippetLabel({ title: '   ', content: '第一行\n第二行' })).toBe('第一行');
  });

  it('内容首行超长时截到 SNIPPET_TITLE_MAX', () => {
    const long = 'x'.repeat(SNIPPET_TITLE_MAX + 20);
    expect(snippetLabel({ title: '', content: long })).toBe(long.slice(0, SNIPPET_TITLE_MAX));
  });

  it('标题与内容都空时兜底「未命名片段」', () => {
    expect(snippetLabel({ title: '', content: '' })).toBe('未命名片段');
    expect(snippetLabel({ title: '  ', content: '\n\n' })).toBe('未命名片段');
  });
});

describe('snippetPreview', () => {
  it('换行压成空格（\\r\\n / \\n 都认）', () => {
    expect(snippetPreview('a\r\nb\nc')).toBe('a b c');
  });

  it('不超长时原样返回，不加省略号', () => {
    expect(snippetPreview('短内容')).toBe('短内容');
  });

  it('超长时截断并补省略号', () => {
    const long = 'y'.repeat(200);
    const out = snippetPreview(long);
    expect(out).toHaveLength(121);
    expect(out.endsWith('…')).toBe(true);
  });

  it('max 可自定义', () => {
    expect(snippetPreview('abcdef', 3)).toBe('abc…');
  });
});

describe('validateSnippet', () => {
  it('内容空白 -> 片段内容不能为空', () => {
    expect(validateSnippet({ title: 't', content: '   \n ' })).toBe('片段内容不能为空');
  });

  it('内容超长 -> 片段内容太长', () => {
    const long = 'z'.repeat(SNIPPET_CONTENT_MAX + 1);
    expect(validateSnippet({ title: 't', content: long })).toBe('片段内容太长');
  });

  it('标题超长 -> 标题太长', () => {
    const long = 'w'.repeat(SNIPPET_TITLE_MAX + 1);
    expect(validateSnippet({ title: long, content: 'ok' })).toBe('标题太长');
  });

  it('合法输入 -> null', () => {
    expect(validateSnippet({ title: '标题', content: '内容' })).toBeNull();
    expect(validateSnippet({ title: '', content: '内容' })).toBeNull();
  });
});

describe('snippetMeta', () => {
  const now = 1_700_000_000_000;
  const meta = (useCount: number, agoMs: number) =>
    snippetMeta({ useCount, updatedAt: now - agoMs }, now);

  it('刚刚（不足 1 分钟）', () => {
    expect(meta(3, 30_000)).toBe('用过 3 次 · 刚刚');
  });

  it('N 分钟前', () => {
    expect(meta(1, 5 * 60_000)).toBe('用过 1 次 · 5 分钟前');
  });

  it('N 小时前', () => {
    expect(meta(2, 3 * 3_600_000)).toBe('用过 2 次 · 3 小时前');
  });

  it('N 天前', () => {
    expect(meta(7, 3 * 86_400_000)).toBe('用过 7 次 · 3 天前');
  });

  it('未来时间（系统时间回拨）也显示「刚刚」，不出现负数', () => {
    expect(meta(0, -60_000)).toBe('还没用过 · 刚刚');
  });
});

describe('sortSnippets', () => {
  it('updatedAt 倒序', () => {
    const list = [snippet('a', 100), snippet('b', 300), snippet('c', 200)];
    expect(sortSnippets(list).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('同 updatedAt 按 id 倒序', () => {
    const list = [snippet('a', 100), snippet('c', 100), snippet('b', 100)];
    expect(sortSnippets(list).map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('不改原数组', () => {
    const list = [snippet('a', 100), snippet('b', 300)];
    const copy = [...list];
    sortSnippets(list);
    expect(list).toEqual(copy);
  });

  it('空数组返回空数组', () => {
    expect(sortSnippets([])).toEqual([]);
  });
});

describe('emptySnippetHint', () => {
  it('非空且说明了用途', () => {
    expect(emptySnippetHint().length).toBeGreaterThan(0);
    expect(emptySnippetHint()).toContain('片段');
  });
});

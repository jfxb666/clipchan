import { describe, expect, it } from 'vitest';
import { expandSnippet } from './snippetVars';

describe('片段变量（v1.2 C3）', () => {
  const now = new Date('2026-11-06T09:05:00');
  it('★ 日期/时间/剪贴板三类变量展开（中英文名等价）', () => {
    expect(expandSnippet('今天{{日期}}', { now, clipboard: 'x' })).toBe('今天2026-11-06');
    expect(expandSnippet('{{date}} {{time}}', { now, clipboard: 'x' })).toBe('2026-11-06 09:05');
    expect(expandSnippet('上次的剪贴板：{{剪贴板}}', { now, clipboard: 'ABC' })).toBe('上次的剪贴板：ABC');
  });
  it('★ 剪贴板为空时 {{剪贴板}} 展开为空串（不字面残留占位）', () => {
    expect(expandSnippet('a{{剪贴板}}b', { now, clipboard: '' })).toBe('ab');
  });
  it('未知占位符原样保留（用户可能就在写模板文档）', () => {
    expect(expandSnippet('{{不认识}}', { now, clipboard: '' })).toBe('{{不认识}}');
  });
  it('无变量时原样返回（快路径）', () => {
    expect(expandSnippet('plain', { now, clipboard: '' })).toBe('plain');
  });
});

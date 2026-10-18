import { describe, expect, it } from 'vitest';
import { viewerKindOf, viewerTitleOf } from './viewer';

describe('viewerKindOf', () => {
  it('null / undefined → none', () => {
    expect(viewerKindOf(null)).toBe('none');
    expect(viewerKindOf(undefined)).toBe('none');
  });

  it('图片 → image（即便没有缩略图）', () => {
    expect(viewerKindOf({ kind: 'image' })).toBe('image');
    expect(viewerKindOf({ kind: 'image', thumbUrl: 'file:///a.png' })).toBe('image');
  });

  it('文本有内容 → text', () => {
    expect(viewerKindOf({ kind: 'text', preview: '一段文本' })).toBe('text');
    expect(viewerKindOf({ kind: 'code', preview: 'const a = 1' })).toBe('text');
  });

  it('空 preview / 纯空白 → none', () => {
    expect(viewerKindOf({ kind: 'text', preview: '' })).toBe('none');
    expect(viewerKindOf({ kind: 'text', preview: '   ' })).toBe('none');
    expect(viewerKindOf({ kind: 'text' })).toBe('none');
  });

  it('图片带 preview 仍是 image（不被文本分支抢走）', () => {
    expect(viewerKindOf({ kind: 'image', preview: 'screenshot.png' })).toBe('image');
  });
});

describe('viewerTitleOf', () => {
  it('image → 图片，其余 → 全文', () => {
    expect(viewerTitleOf({ kind: 'image', preview: '' })).toBe('图片');
    expect(viewerTitleOf({ kind: 'text', preview: 'x' })).toBe('全文');
    expect(viewerTitleOf({ kind: 'code', preview: 'x' })).toBe('全文');
  });

  it('null / undefined → 空串', () => {
    expect(viewerTitleOf(null)).toBe('');
    expect(viewerTitleOf(undefined)).toBe('');
  });
});

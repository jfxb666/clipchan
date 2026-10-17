import { describe, expect, it } from 'vitest';
import { previewOfImage, previewOfText } from './preview';

describe('previewOfText', () => {
  it('把换行与制表压成单行并合并空格', () => {
    expect(previewOfText('a\r\nb\tc   d')).toBe('a b c d');
  });

  it('空文本给出占位符', () => {
    expect(previewOfText('')).toBe('(空白文本)');
    expect(previewOfText('   \n  ')).toBe('(空白文本)');
  });

  it('超长截断并加省略号', () => {
    const long = 'x'.repeat(300);
    const out = previewOfText(long, 10);
    expect(out).toBe('x'.repeat(10) + '…');
  });

  it('默认上限 200', () => {
    expect(previewOfText('y'.repeat(201)).length).toBe(201);
  });
});

describe('previewOfImage', () => {
  it('描述格式必须与 db.ts 的 SQL 拼接逐字一致', () => {
    expect(previewOfImage(1920, 1080, 1048576)).toBe('图片 1920×1080 · 1024 KB');
    expect(previewOfImage(800, 600, 1500)).toBe('图片 800×600 · 1 KB');
  });
});

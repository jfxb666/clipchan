import { describe, expect, it } from 'vitest';
import { mergeTexts } from './merge';

const t = (content: string | null, pinned = false, kind: 'text' | 'image' = 'text') =>
  ({ content, pinned, kind } as const);

describe('mergeTexts', () => {
  it('按顺序用 \\r\\n 拼接', () => {
    const r = mergeTexts([t('a'), t('b'), t('c')]);
    expect(r?.text).toBe('a\r\nb\r\nc');
  });

  it('跳过收藏项', () => {
    const r = mergeTexts([t('a'), t('b', true), t('c')]);
    expect(r?.text).toBe('a\r\nc');
  });

  it('跳过图片并计数', () => {
    const r = mergeTexts([t('a'), t(null, false, 'image'), t('b')]);
    expect(r?.text).toBe('a\r\nb');
    expect(r?.skippedImages).toBe(1);
  });

  it('有效项不足 2 条返回 null', () => {
    expect(mergeTexts([t('a')])).toBeNull();
    expect(mergeTexts([t('a'), t('b', true)])).toBeNull();
    expect(mergeTexts([])).toBeNull();
  });

  it('自定义分隔符', () => {
    expect(mergeTexts([t('a'), t('b')], ' | ')?.text).toBe('a | b');
  });
});

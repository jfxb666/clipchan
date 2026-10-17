import { describe, expect, it } from 'vitest';
import type { Kind, KindFilter } from '../types';
import { badgeOf, emptyHintOf, filterKindOf } from './badges';

/**
 * 徽章与空状态文案的单测（Task 7 硬要求）。
 * 只测纯函数，不渲染组件——仓库里没有 jsdom / testing-library，
 * 组件行为改由 store 单测与人工验收覆盖。
 */

const ALL_KINDS: Kind[] = ['text', 'link', 'code', 'path', 'number', 'image'];
const ALL_FILTERS: KindFilter[] = ['all', 'text-group', 'image', 'link', 'code', 'favorite'];

describe('badgeOf 逐字对齐 spec §6.4', () => {
  it('六类徽章字面量分别是 T / Link / </> / T / T / Img', () => {
    expect(badgeOf('text').label).toBe('T');
    expect(badgeOf('link').label).toBe('Link');
    expect(badgeOf('code').label).toBe('</>');
    expect(badgeOf('path').label).toBe('T');
    expect(badgeOf('number').label).toBe('T');
    expect(badgeOf('image').label).toBe('Img');
  });

  it('path 挂路径图标、number 挂数字图标，其余不挂图标', () => {
    expect(badgeOf('path').icon).toBe('folder');
    expect(badgeOf('number').icon).toBe('hash');
    expect(badgeOf('text').icon).toBeNull();
    expect(badgeOf('link').icon).toBeNull();
    expect(badgeOf('code').icon).toBeNull();
    expect(badgeOf('image').icon).toBeNull();
  });

  it('六类都有底色与前景色类名，且互不重复', () => {
    const classes = ALL_KINDS.map((kind) => badgeOf(kind).className);
    classes.forEach((cls) => expect(cls.length).toBeGreaterThan(0));
    expect(new Set(classes).size).toBe(6);
  });

  it('path / number 归入文本页（filterKind === text-group）', () => {
    expect(filterKindOf('path')).toBe('text-group');
    expect(filterKindOf('number')).toBe('text-group');
    expect(filterKindOf('text')).toBe('text');
    expect(filterKindOf('image')).toBe('image');
    expect(filterKindOf('link')).toBe('link');
    expect(filterKindOf('code')).toBe('code');
  });
});

describe('emptyHintOf 六条文案互不相同', () => {
  it('无搜索词时 6 个分组各一句，且互不相同', () => {
    const hints = ALL_FILTERS.map((kind) => emptyHintOf(kind));
    hints.forEach((hint) => expect(hint.length).toBeGreaterThan(0));
    expect(new Set(hints).size).toBe(6);
  });

  it('有搜索词时 6 个分组各一句，且互不相同', () => {
    const hints = ALL_FILTERS.map((kind) => emptyHintOf(kind, '会议纪要'));
    hints.forEach((hint) => expect(hint).toContain('会议纪要'));
    expect(new Set(hints).size).toBe(6);
  });

  it('同一分组下有无搜索词的文案也不相同（共 12 句互不相同）', () => {
    const all = [
      ...ALL_FILTERS.map((kind) => emptyHintOf(kind)),
      ...ALL_FILTERS.map((kind) => emptyHintOf(kind, '会议纪要')),
    ];
    expect(new Set(all).size).toBe(12);
  });

  it('搜索词只有空白时按无搜索词处理', () => {
    expect(emptyHintOf('all', '   ')).toBe(emptyHintOf('all'));
  });

  it('未知分组回退到全部页的文案', () => {
    expect(emptyHintOf('unknown' as KindFilter)).toBe(emptyHintOf('all'));
  });
});

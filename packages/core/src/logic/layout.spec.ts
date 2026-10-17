import { describe, expect, it } from 'vitest';
import { estimateTextWidth, layoutWords, rectsOverlap, type PlacedWord } from './layout';

const AREA = { w: 600, h: 400 };
const WORDS = [
  { word: '剪贴板', weight: 12 },
  { word: '图片', weight: 9 },
  { word: '快捷键', weight: 8 },
  { word: '历史记录', weight: 7 },
  { word: '收藏', weight: 6 },
  { word: '粘贴', weight: 5 },
  { word: '搜索', weight: 4 },
  { word: '幽灵模式', weight: 3 },
  { word: '词云', weight: 2 },
  { word: '托盘', weight: 1 },
];

function pairs(list: PlacedWord[]): [PlacedWord, PlacedWord][] {
  const out: [PlacedWord, PlacedWord][] = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a && b) out.push([a, b]);
    }
  }
  return out;
}

describe('layoutWords', () => {
  it('10 个词全部落位', () => {
    const placed = layoutWords(WORDS, AREA);
    expect(placed).toHaveLength(10);
    expect(placed.map((p) => p.word).sort()).toEqual(WORDS.map((w) => w.word).sort());
  });

  it('任意两个矩形不相交', () => {
    const placed = layoutWords(WORDS, AREA);
    for (const [a, b] of pairs(placed)) {
      expect(rectsOverlap(a, b, 0)).toBe(false);
    }
  });

  it('所有位置都在区域内', () => {
    const placed = layoutWords(WORDS, AREA);
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(AREA.w);
      expect(p.y + p.h).toBeLessThanOrEqual(AREA.h);
    }
  });

  it('权重最大的词面积最大', () => {
    const placed = layoutWords(WORDS, AREA);
    const areas = placed.map((p) => ({ word: p.word, area: p.w * p.h }));
    const top = areas.find((a) => a.word === '剪贴板');
    expect(top).toBeDefined();
    for (const other of areas) {
      if (other.word === '剪贴板') continue;
      expect(top!.area).toBeGreaterThan(other.area);
    }
  });

  it('权重高的词字号不小于权重低的词', () => {
    const placed = layoutWords(WORDS, AREA);
    const byWord = new Map(placed.map((p) => [p.word, p.fontSize]));
    expect(byWord.get('剪贴板')!).toBeGreaterThanOrEqual(byWord.get('托盘')!);
  });

  it('区域太小则尽力放置、不重叠（允许少放几个词）', () => {
    const placed = layoutWords(WORDS, { w: 120, h: 90 });
    expect(placed.length).toBeGreaterThan(0);
    for (const [a, b] of pairs(placed)) {
      expect(rectsOverlap(a, b, 0)).toBe(false);
    }
  });

  it('空输入与零区域返回空数组', () => {
    expect(layoutWords([], AREA)).toEqual([]);
    expect(layoutWords(WORDS, { w: 0, h: 400 })).toEqual([]);
    expect(layoutWords([{ word: '', weight: 3 }], AREA)).toEqual([]);
  });

  it('权重相同时仍能全部落位且不重叠', () => {
    const same = WORDS.map((w) => ({ word: w.word, weight: 5 }));
    const placed = layoutWords(same, AREA);
    expect(placed).toHaveLength(10);
    for (const [a, b] of pairs(placed)) {
      expect(rectsOverlap(a, b, 0)).toBe(false);
    }
  });

  it('权重为负 / NaN 的词按 0 处理，仍能落位', () => {
    const weird = [
      { word: '正常', weight: 5 },
      { word: '负数', weight: -3 },
      { word: 'NaN', weight: Number.NaN },
    ];
    const placed = layoutWords(weird, AREA);
    expect(placed).toHaveLength(3);
  });
});

describe('estimateTextWidth', () => {
  it('中文比同长度拉丁更宽', () => {
    expect(estimateTextWidth('剪贴板', 16)).toBeGreaterThan(estimateTextWidth('abc', 16));
  });

  it('宽度随字号线性增长', () => {
    expect(estimateTextWidth('剪贴板', 32)).toBe(estimateTextWidth('剪贴板', 16) * 2);
  });

  it('空串退化为一个字号宽', () => {
    expect(estimateTextWidth('', 20)).toBe(20);
  });
});

import { describe, expect, it } from 'vitest';
import { buildWordCloud, cjkRuns, extractCjkWords, isCjk, latinWords, trimParticles } from './wordcloud';

describe('isCjk / cjkRuns', () => {
  it('中日韩统一表意文字与假名、谚文都算 CJK', () => {
    expect(isCjk('中')).toBe(true);
    expect(isCjk('あ')).toBe(true);
    expect(isCjk('한')).toBe(true);
    expect(isCjk('a')).toBe(false);
  });

  it('切出连续 CJK 片段', () => {
    expect(cjkRuns('abc中文def汉字ghi')).toEqual(['中文', '汉字']);
    expect(cjkRuns('没有cjk')).toEqual(['没有']);
    expect(cjkRuns('abc123')).toEqual([]);
  });
});

describe('trimParticles', () => {
  it('剪掉首尾虚词', () => {
    expect(trimParticles('的了剪贴板是')).toBe('剪贴板');
  });

  it('全虚词剪成空串', () => {
    expect(trimParticles('的了的')).toBe('');
  });
});

describe('latinWords', () => {
  it('小写化、按非字母数字切分、丢弃单字符与停用词', () => {
    expect(latinWords('Hello World the a bb')).toEqual(['hello', 'world', 'bb']);
  });
});

describe('extractCjkWords', () => {
  it('只保留重复出现的候选，并剪掉虚词尾缀', () => {
    const runs = ['剪贴板的', '剪贴板的', '剪贴板'];
    const m = extractCjkWords(runs);
    expect(m.get('剪贴板')).toBeGreaterThanOrEqual(2);
  });

  it('出现一次的片段不入词', () => {
    const m = extractCjkWords(['独一无二词']);
    expect(m.size).toBe(0);
  });
});

describe('buildWordCloud', () => {
  it('统计当天文本，权重降序，且不含单字虚词', () => {
    // 用"剪贴板"单独成词的两句，避免 4-gram "剪贴板酱" 以更长更高分胜出（旧版就是最长优先）。
    const texts = ['剪贴板很好用', '剪贴板很方便', 'the clipboard is good'];
    const words = buildWordCloud(texts);
    expect(words.length).toBeGreaterThan(0);
    expect(words.some((w) => w.word === '剪贴板')).toBe(true);
    expect(words.some((w) => w.word === 'clipboard')).toBe(true);
    for (const w of words) {
      expect(w.word.length).toBeGreaterThanOrEqual(2);
      expect(['的', '了', '是', '在', '和']).not.toContain(w.word);
    }
    for (let i = 1; i < words.length; i++) {
      expect(words[i - 1]!.weight).toBeGreaterThanOrEqual(words[i]!.weight);
    }
  });

  it('空输入返回空数组', () => {
    expect(buildWordCloud([])).toEqual([]);
  });
});

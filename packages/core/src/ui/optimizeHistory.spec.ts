import { describe, expect, it } from 'vitest';
import type { OptimizeHistoryEntry } from '../types';
import {
  HISTORY_LIMIT,
  emptyHistoryHint,
  historySceneLabel,
  historyTimeLabel,
  truncateForList,
} from './optimizeHistory';

/** 固定「现在」为 2026-10-20 15:30（本地时区），避免用例随真实时间飘。 */
const NOW = new Date(2026, 9, 20, 15, 30, 0, 0).getTime();

describe('HISTORY_LIMIT', () => {
  it('与主进程的淘汰上限一致（100）', () => {
    expect(HISTORY_LIMIT).toBe(100);
  });
});

describe('historyTimeLabel', () => {
  it('今天 → HH:mm（补零）', () => {
    expect(historyTimeLabel(new Date(2026, 9, 20, 9, 5).getTime(), NOW)).toBe('09:05');
    expect(historyTimeLabel(new Date(2026, 9, 20, 15, 30).getTime(), NOW)).toBe('15:30');
  });

  it('昨天 → 昨天 HH:mm', () => {
    expect(historyTimeLabel(new Date(2026, 9, 19, 23, 59).getTime(), NOW)).toBe('昨天 23:59');
    expect(historyTimeLabel(new Date(2026, 9, 19, 0, 0).getTime(), NOW)).toBe('昨天 00:00');
  });

  it('今年更早 → M月D日 HH:mm（月日不补零）', () => {
    expect(historyTimeLabel(new Date(2026, 2, 3, 7, 8).getTime(), NOW)).toBe('3月3日 07:08');
    expect(historyTimeLabel(new Date(2026, 11, 1, 18, 0).getTime(), NOW)).toBe('12月1日 18:00');
  });

  it('跨年 → YYYY年M月D日 HH:mm', () => {
    expect(historyTimeLabel(new Date(2025, 11, 31, 0, 0).getTime(), NOW)).toBe('2025年12月31日 00:00');
  });

  it('不传 now 时按当前时间算（今天只显示时刻）', () => {
    const ts = Date.now();
    expect(historyTimeLabel(ts)).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('historySceneLabel', () => {
  const scenes = [
    { id: 'writing', name: '写作润色' },
    { id: 'code', name: '代码' },
  ];
  const entry = (sceneId: string): OptimizeHistoryEntry => ({
    id: '1',
    source: '原文',
    output: '结果',
    sceneId,
    mode: 'user',
    providerId: 'p1',
    providerName: '本地',
    createdAt: NOW,
  });

  it('查得到用场景名', () => {
    expect(historySceneLabel(entry('code'), scenes)).toBe('代码');
  });

  it('查不到（场景被删）回落 sceneId', () => {
    expect(historySceneLabel(entry('gone'), scenes)).toBe('gone');
    expect(historySceneLabel(entry('gone'), [])).toBe('gone');
  });
});

describe('truncateForList', () => {
  it('不超长原样返回', () => {
    expect(truncateForList('短文本')).toBe('短文本');
  });

  it('换行压成空格', () => {
    expect(truncateForList('第一行\n第二行')).toBe('第一行 第二行');
    expect(truncateForList('a\r\nb\tc')).toBe('a b c');
    expect(truncateForList('  前后有空白  ')).toBe('前后有空白');
  });

  it('超过 n 截断并补省略号', () => {
    expect(truncateForList('abcdef', 3)).toBe('abc…');
  });

  it('正好 n 个字符不加省略号', () => {
    expect(truncateForList('abc', 3)).toBe('abc');
  });

  it('默认上限 80', () => {
    const long = 'x'.repeat(120);
    const out = truncateForList(long);
    expect(out).toBe('x'.repeat(80) + '…');
    expect(out.length).toBe(81);
  });

  it('先压空白再判断长度（换行不占额外长度）', () => {
    expect(truncateForList('aaaa\nbbbb', 9)).toBe('aaaa bbbb');
  });
});

describe('emptyHistoryHint', () => {
  it('空列表的提示文案', () => {
    expect(emptyHistoryHint()).toBe('还没有优化记录');
  });
});

/**
 * 时间轴分组纯逻辑单测（不渲染 TimelineList.tsx：仓库没有 jsdom）。
 * 全部时间戳都用本地时区构造，因为 dayKeyOf / dayLabelOf 走的就是本地日历。
 */
import { describe, expect, it } from 'vitest';
import type { ClipItemDTO } from '../types';
import { dayKeyOf, dayLabelOf, groupByDay } from './timeline';

/** 固定「现在」：2026-10-20 15:30（本地时区），避免用例随真实时间飘。 */
const NOW = new Date(2026, 9, 20, 15, 30, 0).getTime();

/** 本地时区造时间戳：月份从 1 开始，便于对照「M月D日」。 */
function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour, 0, 0).getTime();
}

function dto(patch: Partial<ClipItemDTO> & { id: string }): ClipItemDTO {
  return { kind: 'text', preview: '', createdAt: 0, pinned: false, source: 'capture', ...patch };
}

describe('dayKeyOf', () => {
  it('输出 YYYY-MM-DD 且月日补零', () => {
    expect(dayKeyOf(at(2026, 1, 5))).toBe('2026-01-05');
    expect(dayKeyOf(at(2026, 12, 31, 23))).toBe('2026-12-31');
    // 同一天不同时刻必须是同一个 key，否则时间轴会把一天拆成两组。
    expect(dayKeyOf(at(2026, 10, 20, 0))).toBe(dayKeyOf(at(2026, 10, 20, 23)));
  });
});

describe('dayLabelOf', () => {
  it('今天 / 昨天 / 同年 / 跨年四种写法', () => {
    expect(dayLabelOf(at(2026, 10, 20, 0), NOW)).toBe('今天');
    expect(dayLabelOf(at(2026, 10, 19, 23), NOW)).toBe('昨天');
    expect(dayLabelOf(at(2026, 3, 5), NOW)).toBe('3月5日');
    expect(dayLabelOf(at(2025, 12, 31), NOW)).toBe('2025年12月31日');
  });
});

describe('groupByDay', () => {
  it('按首次出现顺序分组，组内保持传入顺序', () => {
    const items = [
      dto({ id: 'a', createdAt: at(2026, 10, 19, 9) }),
      dto({ id: 'b', createdAt: at(2026, 10, 20, 9) }),
      dto({ id: 'c', createdAt: at(2026, 10, 19, 18) }),
    ];

    const groups = groupByDay(items, NOW);

    // 组的先后顺序 = 首次出现顺序（不是按时间排序，列表已由 SQL 排好）。
    expect(groups.map((group) => group.key)).toEqual(['2026-10-19', '2026-10-20']);
    expect(groups.map((group) => group.label)).toEqual(['昨天', '今天']);
    expect(groups[0]!.items.map((item) => item.id)).toEqual(['a', 'c']);
    expect(groups[1]!.items.map((item) => item.id)).toEqual(['b']);
  });

  it('空列表返回空数组，不造空分组', () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

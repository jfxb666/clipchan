import type { ClipItemDTO } from '../types';

/** 时间轴的一个分组：同一天的所有记录。 */
export interface TimelineGroup {
  /** 'YYYY-MM-DD'（本地时区）。 */
  key: string;
  /** 今天 / 昨天 / M月D日 / YYYY年M月D日。 */
  label: string;
  items: ClipItemDTO[];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 时间戳 → 'YYYY-MM-DD'（本地时区，月日补零）。 */
export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * 时间戳 → 分组标题（不含时分）。
 *
 * ★ 不复用 util.formatTime：那个带 HH:mm，时间轴的组标题不该显示具体时刻。
 */
export function dayLabelOf(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  if (dayKeyOf(ts) === dayKeyOf(now)) return '今天';
  if (dayKeyOf(ts) === dayKeyOf(now - 86400000)) return '昨天';
  if (d.getFullYear() === today.getFullYear()) return d.getMonth() + 1 + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/**
 * 按天分组。
 *
 * ★ 组的先后顺序 = items 里首次出现的顺序，不重新按时间排序 ——
 *   列表已由 SQL 排好，这里再排一次只会把「置顶」等既有顺序打乱。
 */
export function groupByDay(items: ClipItemDTO[], now: number = Date.now()): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  const byKey = new Map<string, TimelineGroup>();

  for (const item of items) {
    const key = dayKeyOf(item.createdAt);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: dayLabelOf(item.createdAt, now), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  return groups;
}

import type { ClipItemDTO } from '../types';

/** 来源未知（DTO 里 sourceApp 为 undefined）时的组名。 */
export const UNKNOWN_SOURCE_LABEL = '未知来源';

/** 按来源应用分组的一组记录。 */
export interface SourceGroup {
  key: string;
  label: string;
  items: ClipItemDTO[];
}

/**
 * sourceApp → 组名。
 * 去掉尾部 .exe（大小写不敏感）—— 用户看 exe 后缀没有意义；DTO 里仍保留原名不丢信息。
 */
export function sourceLabel(app: string | undefined): string {
  if (app === undefined) return UNKNOWN_SOURCE_LABEL;
  const trimmed = app.trim();
  const stripped = trimmed.toLowerCase().endsWith('.exe') ? trimmed.slice(0, -4).trim() : trimmed;
  return stripped === '' ? UNKNOWN_SOURCE_LABEL : stripped;
}

/**
 * 按来源分组。
 *
 * 组顺序：组内最新一条 createdAt 倒序；未知来源组固定垫底
 * （它不是一个「来源」，排在最前会让人误以为是最活跃的应用）。
 * 组内保持传入顺序，不再二次排序。
 */
export function groupBySource(items: ClipItemDTO[]): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const byKey = new Map<string, SourceGroup>();

  for (const item of items) {
    const label = sourceLabel(item.sourceApp);
    let group = byKey.get(label);
    if (!group) {
      group = { key: label, label, items: [] };
      byKey.set(label, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  const latestOf = (group: SourceGroup): number =>
    group.items.reduce((max, item) => (item.createdAt > max ? item.createdAt : max), Number.NEGATIVE_INFINITY);

  return groups.sort((a, b) => {
    const aUnknown = a.label === UNKNOWN_SOURCE_LABEL;
    const bUnknown = b.label === UNKNOWN_SOURCE_LABEL;
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    return latestOf(b) - latestOf(a);
  });
}

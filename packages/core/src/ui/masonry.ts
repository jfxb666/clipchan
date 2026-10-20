import type { ClipItemDTO } from '../types';

/** 单列最小宽度：再窄卡片里的预览就没法读了。 */
export const MASONRY_MIN_COLUMN_PX = 220;

/** 列数上限：900px 窗口下再多列只会把卡片挤成豆腐块。 */
export const MASONRY_MAX_COLUMNS = 4;

/** 文本卡估算时的一行高度。 */
export const MASONRY_TEXT_LINE_PX = 20;

/** 卡片里除正文以外的固定开销（内边距 + 类型徽标 + 时间行）。 */
export const MASONRY_CARD_CHROME_PX = 52;

/** 图片没有记录宽高时的回落高度（DTO 里 width/height 是「有才给」的）。 */
export const MASONRY_FALLBACK_IMAGE_HEIGHT = 160;

/** 一列宽约 220px 时，13px 正文一行大致放得下这么多汉字。 */
export const MASONRY_TEXT_CHARS_PER_LINE = 28;

/** 文本卡估高最多按这么多行算，再长就当同样高。 */
export const MASONRY_TEXT_MAX_LINES = 6;

/**
 * 容器宽度 → 列数。
 * 宽度非法或还没量到（0）时给 1 列，宁可先竖排一列也不要算出 0 列或 NaN 列。
 */
export function columnCountOf(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
  return Math.min(MASONRY_MAX_COLUMNS, Math.max(1, Math.floor(containerWidth / MASONRY_MIN_COLUMN_PX)));
}

/**
 * 卡片在给定列宽下的大致高度，用于贪心分列。
 *
 * ★ 只用来决定「放进哪一列」，不参与渲染尺寸 —— 估歪了最多是列高不均，不会错位。
 */
export function estimateCardHeight(item: ClipItemDTO, columnWidth: number): number {
  if (item.kind === 'image') {
    const width = item.width;
    const height = item.height;
    if (width !== undefined && height !== undefined && width > 0 && height > 0) {
      return Math.round((columnWidth * height) / width) + MASONRY_CARD_CHROME_PX;
    }
    return MASONRY_FALLBACK_IMAGE_HEIGHT + MASONRY_CARD_CHROME_PX;
  }
  const length = item.preview.length;
  const lines = Math.min(MASONRY_TEXT_MAX_LINES, Math.max(1, Math.ceil(length / MASONRY_TEXT_CHARS_PER_LINE)));
  return lines * MASONRY_TEXT_LINE_PX + MASONRY_CARD_CHROME_PX;
}

/**
 * 贪心分列：每条依次放进「当前累计高度最矮」的列。
 *
 * ★ 保持 items 的传入顺序 —— 同一列内的相对顺序与传入一致，
 *   否则列表就不再是 SQL 排好的时间倒序了。
 */
export function distributeColumns(
  items: ClipItemDTO[],
  columns: number,
  columnWidth: number,
): ClipItemDTO[][] {
  const wanted = Number.isFinite(columns) ? Math.floor(columns) : 1;
  const clamped = Math.max(1, Math.min(MASONRY_MAX_COLUMNS, wanted));
  // 列数不超过条目数（2 条不该摊成 4 列）；空列表例外 —— 仍返回 clamped 个空列，
  // 让调用方能拿到稳定的列骨架，而不是 undefined。
  const count = items.length === 0 ? clamped : Math.min(clamped, items.length);
  const buckets: ClipItemDTO[][] = Array.from({ length: count }, () => []);
  const heights: number[] = Array.from({ length: count }, () => 0);

  for (const item of items) {
    // 找最矮的一列；同高时取靠前的，保证结果确定（不依赖 sort 的稳定性）。
    let target = 0;
    for (let index = 1; index < count; index += 1) {
      if ((heights[index] ?? 0) < (heights[target] ?? 0)) target = index;
    }
    buckets[target]!.push(item);
    heights[target] = (heights[target] ?? 0) + estimateCardHeight(item, columnWidth);
  }

  return buckets;
}

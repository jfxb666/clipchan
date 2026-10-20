/**
 * 瀑布流布局纯逻辑单测。
 *
 * 仓库的 vitest 只跑 node 环境、没有 jsdom（见 keymap.spec.ts 的文件头），
 * MasonryList.tsx 本身渲染不了；这里断言的是从组件里抽出来的三个纯函数，
 * 组件只负责把列数组摆到 DOM 上。
 */
import { describe, expect, it } from 'vitest';
import type { ClipItemDTO } from '../types';
import {
  MASONRY_CARD_CHROME_PX,
  MASONRY_FALLBACK_IMAGE_HEIGHT,
  MASONRY_MAX_COLUMNS,
  MASONRY_MIN_COLUMN_PX,
  MASONRY_TEXT_LINE_PX,
  MASONRY_TEXT_MAX_LINES,
  columnCountOf,
  distributeColumns,
  estimateCardHeight,
} from './masonry';

/** 造一条最小可用的 DTO：只有用例关心的字段被覆盖。 */
function dto(patch: Partial<ClipItemDTO> & { id: string }): ClipItemDTO {
  return { kind: 'text', preview: '', createdAt: 0, pinned: false, source: 'capture', ...patch };
}

describe('columnCountOf（容器宽 → 列数）', () => {
  it('宽度非法或为 0 时退回 1 列（首帧还没量到宽度就走这条路）', () => {
    expect(columnCountOf(0)).toBe(1);
    expect(columnCountOf(-100)).toBe(1);
    expect(columnCountOf(Number.NaN)).toBe(1);
    expect(columnCountOf(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('窄容器 1 列、按 220px 递进、超宽封顶 4 列', () => {
    expect(columnCountOf(MASONRY_MIN_COLUMN_PX - 1)).toBe(1);
    expect(columnCountOf(MASONRY_MIN_COLUMN_PX)).toBe(1);
    expect(columnCountOf(MASONRY_MIN_COLUMN_PX * 2)).toBe(2);
    expect(columnCountOf(MASONRY_MIN_COLUMN_PX * 3 + 10)).toBe(3);
    expect(columnCountOf(4000)).toBe(MASONRY_MAX_COLUMNS);
  });
});

describe('estimateCardHeight（卡片估高）', () => {
  it('图片按原始宽高比换算列高', () => {
    const item = dto({ id: 'a', kind: 'image', width: 800, height: 600 });
    expect(estimateCardHeight(item, 400)).toBe(300 + MASONRY_CARD_CHROME_PX);
  });

  it('图片缺宽高（DTO 里本来就不带）回落 160，不抛也不返回 0', () => {
    const expected = MASONRY_FALLBACK_IMAGE_HEIGHT + MASONRY_CARD_CHROME_PX;
    expect(estimateCardHeight(dto({ id: 'b', kind: 'image' }), 400)).toBe(expected);
    // 宽高为 0 同样算「没有尺寸」，否则会除出 Infinity。
    expect(estimateCardHeight(dto({ id: 'c', kind: 'image', width: 0, height: 0 }), 400)).toBe(expected);
  });

  it('文本按每行 28 字估行数，至少 1 行、最多 6 行', () => {
    const chrome = MASONRY_CARD_CHROME_PX;
    expect(estimateCardHeight(dto({ id: 'd', preview: '' }), 200)).toBe(MASONRY_TEXT_LINE_PX + chrome);
    expect(estimateCardHeight(dto({ id: 'e', preview: 'x'.repeat(28) }), 200)).toBe(
      MASONRY_TEXT_LINE_PX + chrome,
    );
    expect(estimateCardHeight(dto({ id: 'f', preview: 'x'.repeat(29) }), 200)).toBe(
      2 * MASONRY_TEXT_LINE_PX + chrome,
    );
    expect(estimateCardHeight(dto({ id: 'g', preview: 'x'.repeat(28 * 10) }), 200)).toBe(
      MASONRY_TEXT_MAX_LINES * MASONRY_TEXT_LINE_PX + chrome,
    );
  });
});

describe('distributeColumns（贪心最短列）', () => {
  it('同一列内保持传入顺序，且总是先往最矮的列放', () => {
    // 列宽 200 下的估高：a=72、b=202、c=92、d=72。
    const a = dto({ id: 'a', preview: 'x'.repeat(28) });
    const b = dto({ id: 'b', kind: 'image', width: 800, height: 600 });
    const c = dto({ id: 'c', preview: 'x'.repeat(56) });
    const d = dto({ id: 'd', preview: 'x'.repeat(28) });

    const columns = distributeColumns([a, b, c, d], 2, 200);

    // b 把第 2 列撑高后，c / d 都该回到更矮的第 1 列 —— 这就是「最短列优先」。
    expect(columns.map((column) => column.map((item) => item.id))).toEqual([['a', 'c', 'd'], ['b']]);
  });

  it('列数被 clamp 到 1..4 且不超过条目数，空列表也返回列数组', () => {
    const items = [dto({ id: 'a' }), dto({ id: 'b' })];
    expect(distributeColumns(items, 9, 200)).toHaveLength(2);
    expect(distributeColumns(items, 0, 200)).toHaveLength(1);
    // 空列表不能返回 undefined / 空数组冒充「有列」—— 返回 columns 个空列。
    expect(distributeColumns([], 3, 200)).toEqual([[], [], []]);
  });
});

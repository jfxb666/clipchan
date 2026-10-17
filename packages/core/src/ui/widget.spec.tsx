import { describe, expect, it } from 'vitest';
import {
  clampWidgetWidth,
  MAIN_MAX_HEIGHT,
  MAIN_MAX_WIDTH,
  MAIN_MIN_HEIGHT,
  MAIN_MIN_WIDTH,
  WIDGET_MAX_WIDTH,
  WIDGET_MIN_WIDTH,
} from './ResizeHandles';
import { visibleWidgetItems, WIDGET_PREVIEW_COUNT } from './WidgetView';

/**
 * Task 8 的纯逻辑单测。
 * 组件本身（拖拽 / 渲染）靠手工验证（验收 13 / 32），这里只钉住容易写错的数值规则。
 */

describe('visibleWidgetItems（小组件只显示最近 10 条）', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: 'i' + i }));

  it('默认取前 10 条且保持原顺序', () => {
    const out = visibleWidgetItems(items);
    expect(WIDGET_PREVIEW_COUNT).toBe(10);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ id: 'i0' });
    expect(out[9]).toEqual({ id: 'i9' });
  });

  it('不足 10 条时全给', () => {
    expect(visibleWidgetItems(items.slice(0, 3))).toHaveLength(3);
  });

  it('空列表给空数组', () => {
    expect(visibleWidgetItems([])).toEqual([]);
  });

  it('count 非法时给空数组（不抛）', () => {
    expect(visibleWidgetItems(items, 0)).toEqual([]);
    expect(visibleWidgetItems(items, -1)).toEqual([]);
    expect(visibleWidgetItems(items, Number.NaN)).toEqual([]);
  });
});

describe('clampWidgetWidth（小组件宽度 240–400）', () => {
  it('夹取边界', () => {
    expect(clampWidgetWidth(280)).toBe(280);
    expect(clampWidgetWidth(100)).toBe(WIDGET_MIN_WIDTH);
    expect(clampWidgetWidth(9999)).toBe(WIDGET_MAX_WIDTH);
  });

  it('非法值回落最小值（不抛）', () => {
    expect(clampWidgetWidth(Number.NaN)).toBe(WIDGET_MIN_WIDTH);
    expect(clampWidgetWidth(Number.POSITIVE_INFINITY)).toBe(WIDGET_MIN_WIDTH);
  });

  it('小数四舍五入', () => {
    expect(clampWidgetWidth(280.6)).toBe(281);
  });
});

describe('主窗口尺寸常量（spec §6.6：720×480 ~ 1200×900）', () => {
  it('与 spec 一致', () => {
    expect(MAIN_MIN_WIDTH).toBe(720);
    expect(MAIN_MIN_HEIGHT).toBe(480);
    expect(MAIN_MAX_WIDTH).toBe(1200);
    expect(MAIN_MAX_HEIGHT).toBe(900);
  });

  it('与主进程 windows.ts 的夹取范围不冲突', () => {
    expect(MAIN_MAX_WIDTH).toBeGreaterThan(MAIN_MIN_WIDTH);
    expect(MAIN_MAX_HEIGHT).toBeGreaterThan(MAIN_MIN_HEIGHT);
  });
});

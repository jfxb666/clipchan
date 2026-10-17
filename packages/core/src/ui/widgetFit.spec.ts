import { describe, expect, it } from 'vitest';
import {
  WIDGET_AUTO_MAX_HEIGHT,
  WIDGET_AUTO_MIN_HEIGHT,
  WIDGET_CHROME_HEIGHT,
  WIDGET_ROW_PITCH,
  widgetWindowHeight,
} from './widgetFit';

/**
 * 小组件高度自适应的纯函数单测。
 * 回归点：用户报「小组件有一大部分是空白」——条目少时窗口必须变矮。
 */
describe('widgetWindowHeight（小组件按内容变高）', () => {
  it('条目越少窗口越矮（回归：3 条时不能还是 420 高）', () => {
    const three = widgetWindowHeight(3);
    const six = widgetWindowHeight(6);
    const ten = widgetWindowHeight(10);
    // 3 条理论高度 126 + 114 = 240，正好等于下限（窗口不能塌到放不下搜索框）。
    expect(three).toBe(WIDGET_AUTO_MIN_HEIGHT);
    // 6 条 126 + 228 = 354，已经超过下限，按公式精确成立。
    expect(six).toBe(WIDGET_CHROME_HEIGHT + 6 * WIDGET_ROW_PITCH);
    expect(three).toBeLessThan(300);
    expect(ten).toBeGreaterThan(six);
    expect(six).toBeGreaterThan(three);
  });

  it('不低于下限（空列表也按一行算）', () => {
    expect(widgetWindowHeight(0)).toBe(WIDGET_AUTO_MIN_HEIGHT);
    expect(widgetWindowHeight(1)).toBe(WIDGET_AUTO_MIN_HEIGHT);
  });

  it('不超过上限（再多就滚动，不无限长高）', () => {
    expect(widgetWindowHeight(100)).toBe(WIDGET_AUTO_MAX_HEIGHT);
    expect(widgetWindowHeight(10)).toBeLessThanOrEqual(WIDGET_AUTO_MAX_HEIGHT);
  });

  it('非法条数按一行处理，不抛', () => {
    expect(widgetWindowHeight(Number.NaN)).toBe(WIDGET_AUTO_MIN_HEIGHT);
    expect(widgetWindowHeight(Number.POSITIVE_INFINITY)).toBe(WIDGET_AUTO_MIN_HEIGHT);
  });

  it('可覆盖上下限（主进程按窗口 min/max 传）', () => {
    // 1 条理论高度 126 + 38 = 164，被自定义下限 200 兜住。
    expect(widgetWindowHeight(1, { min: 200, max: 400 })).toBe(200);
    expect(widgetWindowHeight(10, { min: 200, max: 400 })).toBe(400);
  });
});

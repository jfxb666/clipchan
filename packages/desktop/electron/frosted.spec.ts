import { describe, expect, it } from 'vitest';
import {
  MAIN_HEIGHT,
  MAIN_WIDTH,
  MIN_VISIBLE_PX,
  PANEL_ABGR,
  WIDGET_HEIGHT_DEFAULT,
  WIDGET_MARGIN,
  clampWidgetWidth,
  displayForPoint,
  isOnAnyDisplay,
  positionFor,
  type DisplayLike,
} from './frosted';

/**
 * 只测**纯几何**（frosted.ts 的 ① 部分）。
 * FrostedGlass 需要 BrowserWindow 与助手进程，留给 Task 8 的手工验证（验收 33）。
 */

const primary: DisplayLike = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

const secondary: DisplayLike = {
  bounds: { x: 1920, y: 0, width: 1280, height: 1024 },
  workArea: { x: 1920, y: 0, width: 1280, height: 984 },
};

describe('displayForPoint', () => {
  it('鼠标在哪块显示器就用哪块（多显示器）', () => {
    expect(displayForPoint([primary, secondary], { x: 100, y: 100 })).toBe(primary);
    expect(displayForPoint([primary, secondary], { x: 2500, y: 300 })).toBe(secondary);
  });

  it('边界点归属：x === 右边界不算在内，落在下一块', () => {
    // 1920 正好是 secondary 的左边界
    expect(displayForPoint([primary, secondary], { x: 1920, y: 10 })).toBe(secondary);
    // 1919 仍是 primary
    expect(displayForPoint([primary, secondary], { x: 1919, y: 10 })).toBe(primary);
  });

  it('坐标不在任何显示器内时退化为中心最近的那块', () => {
    expect(displayForPoint([primary, secondary], { x: -500, y: -500 })).toBe(primary);
    expect(displayForPoint([primary, secondary], { x: 5000, y: 0 })).toBe(secondary);
  });

  it('没有显示器时返回 null（不抛）', () => {
    expect(displayForPoint([], { x: 0, y: 0 })).toBeNull();
  });
});

describe('isOnAnyDisplay', () => {
  it('完全落在主显示器内 → true', () => {
    expect(isOnAnyDisplay({ x: 100, y: 100, width: 900, height: 620 }, [primary, secondary])).toBe(true);
  });

  it('只剩不到 ' + MIN_VISIBLE_PX + 'px 可见 → false（记忆位置作废）', () => {
    // 右下角探出去，可见部分只有 10px
    const rect = { x: 1910, y: 1030, width: 900, height: 620 };
    expect(isOnAnyDisplay(rect, [primary, secondary])).toBe(false);
  });

  it('完全在屏幕外（显示器被拔掉）→ false', () => {
    expect(isOnAnyDisplay({ x: 4000, y: 3000, width: 900, height: 620 }, [primary])).toBe(false);
  });
});

describe('clampWidgetWidth', () => {
  it('夹到 240–400，非法值回落 280', () => {
    expect(clampWidgetWidth(280)).toBe(280);
    expect(clampWidgetWidth(100)).toBe(240);
    expect(clampWidgetWidth(9999)).toBe(400);
    expect(clampWidgetWidth(Number.NaN)).toBe(280);
    expect(clampWidgetWidth(undefined)).toBe(280);
  });
});

describe('positionFor - 主窗口', () => {
  it('无记忆位置时在鼠标所在显示器居中偏上', () => {
    const rect = positionFor({ mode: 'main', display: secondary, displays: [primary, secondary] });
    expect(rect.width).toBe(MAIN_WIDTH);
    expect(rect.height).toBe(MAIN_HEIGHT);
    // 水平居中
    expect(rect.x).toBe(Math.round(1920 + (1280 - MAIN_WIDTH) / 2));
    // 垂直居中再上移 40
    expect(rect.y).toBe(Math.round(0 + (984 - MAIN_HEIGHT) / 2 - 40));
    expect(rect.y).toBeLessThan(Math.round((984 - MAIN_HEIGHT) / 2));
  });

  it('记忆位置仍有效时原样沿用', () => {
    const remembered = { x: 300, y: 220, width: 900, height: 620 };
    const rect = positionFor({
      mode: 'main',
      display: primary,
      displays: [primary, secondary],
      remembered,
    });
    expect(rect).toEqual({ x: 300, y: 220, width: MAIN_WIDTH, height: MAIN_HEIGHT });
  });

  it('记忆位置已不在任何显示器内 → 回落居中偏上', () => {
    const remembered = { x: 9000, y: 9000, width: 900, height: 620 };
    const rect = positionFor({
      mode: 'main',
      display: primary,
      displays: [primary, secondary],
      remembered,
    });
    expect(rect.x).toBe(Math.round((1920 - MAIN_WIDTH) / 2));
    expect(rect.y).toBe(Math.round((1040 - MAIN_HEIGHT) / 2 - 40));
  });

  it('显示器太矮时不出现负 y', () => {
    const tiny: DisplayLike = {
      bounds: { x: 0, y: 0, width: 1024, height: 700 },
      workArea: { x: 0, y: 0, width: 1024, height: 660 },
    };
    const rect = positionFor({ mode: 'main', display: tiny, displays: [tiny] });
    expect(rect.y).toBe(0);
  });
});

describe('positionFor - 小组件', () => {
  it('贴目标显示器右下角、距边 24px', () => {
    const rect = positionFor({
      mode: 'widget',
      display: secondary,
      displays: [primary, secondary],
      widgetWidth: 320,
    });
    expect(rect.width).toBe(320);
    expect(rect.height).toBe(WIDGET_HEIGHT_DEFAULT);
    expect(rect.x + rect.width).toBe(1920 + 1280 - WIDGET_MARGIN);
    expect(rect.y + rect.height).toBe(0 + 984 - WIDGET_MARGIN);
  });

  it('宽度非法时用默认 280', () => {
    const rect = positionFor({ mode: 'widget', display: primary });
    expect(rect.width).toBe(280);
    expect(rect.x + rect.width).toBe(1920 - WIDGET_MARGIN);
  });

  it('小组件不使用记忆位置（永远贴右下角）', () => {
    const rect = positionFor({
      mode: 'widget',
      display: primary,
      displays: [primary],
      remembered: { x: 10, y: 10, width: 280, height: 420 },
      widgetWidth: 280,
    });
    expect(rect.x).toBe(1920 - 280 - WIDGET_MARGIN);
    expect(rect.y).toBe(1040 - WIDGET_HEIGHT_DEFAULT - WIDGET_MARGIN);
  });
});

describe('PANEL_ABGR', () => {
  it('是十进制 0xCCFFF8F0（助手只认十进制）', () => {
    expect(PANEL_ABGR).toBe(3439327472);
    expect(PANEL_ABGR).toBe(0xccfff8f0);
  });
});

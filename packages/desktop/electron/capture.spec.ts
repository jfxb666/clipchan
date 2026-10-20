/**
 * 截图主进程纯逻辑测试（计划 §3 T2）。
 *
 * ★ 这些函数之所以要抽成不 import electron 的纯模块：`desktopCapturer` / `screen`
 *   在 vitest 里拿不到，而"多显示器怎么配 source""CSS 像素怎么换物理像素"恰恰是最
 *   容易算错、也最值得用真实数字钉死的地方（用户双屏 + 125%/150% 缩放是常见配置）。
 */
import { describe, expect, it } from 'vitest';
import {
  clampRect,
  cropRectInImage,
  describeFinish,
  matchSource,
  thumbnailSizeFor,
  type DisplayLike,
  type SourceLike,
} from './capture';

const display = (id: number, width: number, height: number, scaleFactor: number): DisplayLike => ({
  id,
  bounds: { x: 0, y: 0, width, height },
  scaleFactor,
});

const source = (displayId: string): SourceLike => ({
  id: 'window:1:0',
  display_id: displayId,
  thumbnail: { getSize: () => ({ width: 100, height: 100 }) },
});

describe('thumbnailSizeFor', () => {
  it('scaleFactor 1：物理像素 = CSS 像素', () => {
    expect(thumbnailSizeFor(display(1, 1920, 1080, 1))).toEqual({ width: 1920, height: 1080 });
  });

  it('scaleFactor 1.25：1536x864 → 1920x1080', () => {
    expect(thumbnailSizeFor(display(2, 1536, 864, 1.25))).toEqual({ width: 1920, height: 1080 });
  });

  it('scaleFactor 1.5：1280x720 → 1920x1080', () => {
    expect(thumbnailSizeFor(display(3, 1280, 720, 1.5))).toEqual({ width: 1920, height: 1080 });
  });

  it('非整数结果四舍五入（desktopCapturer 只吃整数）', () => {
    // 1365 * 1.25 = 1706.25；769 * 1.25 = 961.25
    expect(thumbnailSizeFor(display(4, 1365, 769, 1.25))).toEqual({ width: 1706, height: 961 });
    // 1366 * 1.5 = 2049；768 * 1.5 = 1152
    expect(thumbnailSizeFor(display(5, 1366, 768, 1.5))).toEqual({ width: 2049, height: 1152 });
  });
});

describe('matchSource', () => {
  it('多屏时按 display_id 精确命中', () => {
    const sources = [source('1'), source('2')];
    expect(matchSource(sources, display(2, 1920, 1080, 1), 2)).toBe(sources[1]);
  });

  it('多屏且 display_id 全对不上 → null（绝不猜）', () => {
    const sources = [source('7'), source('8')];
    expect(matchSource(sources, display(2, 1920, 1080, 1), 2)).toBeNull();
  });

  it('0 个 source → null', () => {
    expect(matchSource([], display(1, 1920, 1080, 1), 1)).toBeNull();
  });

  it('单屏单 source 兜底（display_id 对不上也用）', () => {
    const only = source('999');
    expect(matchSource([only], display(1, 1920, 1080, 1), 1)).toBe(only);
  });

  it('单屏但多个 source → 不兜底，返回 null', () => {
    const sources = [source('7'), source('8')];
    expect(matchSource(sources, display(1, 1920, 1080, 1), 1)).toBeNull();
  });

  it('单个 source 但多屏 → 不兜底（不知道它是哪块屏）', () => {
    expect(matchSource([source('7')], display(1, 1920, 1080, 1), 2)).toBeNull();
  });
});

describe('clampRect', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };

  it('完全在内 → 原样返回', () => {
    expect(clampRect({ x: 10, y: 20, width: 300, height: 200 }, bounds)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
  });

  it('右侧越界 → 宽度被切到边界', () => {
    expect(clampRect({ x: 1800, y: 0, width: 300, height: 100 }, bounds)).toEqual({
      x: 1800,
      y: 0,
      width: 120,
      height: 100,
    });
  });

  it('左上负坐标 → 起点夹回 0，尺寸同步缩小', () => {
    expect(clampRect({ x: -50, y: -30, width: 200, height: 130 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 100,
    });
  });

  it('零面积 → 归零', () => {
    expect(clampRect({ x: 100, y: 100, width: 0, height: 0 }, bounds)).toEqual({
      x: 100,
      y: 100,
      width: 0,
      height: 0,
    });
  });

  it('完全在外 → 宽高归零（不返回负尺寸）', () => {
    const r = clampRect({ x: 3000, y: 3000, width: 200, height: 200 }, bounds);
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
  });

  it('非零原点显示器（副屏在左侧，bounds.x 为负）', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 };
    expect(clampRect({ x: -2000, y: 10, width: 200, height: 100 }, left)).toEqual({
      x: -1920,
      y: 10,
      width: 120,
      height: 100,
    });
  });
});

describe('cropRectInImage', () => {
  it('scaleFactor 1：选区即图片像素', () => {
    expect(cropRectInImage({ x: 100, y: 50, width: 400, height: 300 }, display(1, 1920, 1080, 1))).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });
  });

  it('scaleFactor 1.5：各分量乘缩放并取整', () => {
    // 100*1.5=150, 50*1.5=75, 401*1.5=601.5→602, 301*1.5=451.5→452
    expect(cropRectInImage({ x: 100, y: 50, width: 401, height: 301 }, display(1, 1280, 720, 1.5))).toEqual({
      x: 150,
      y: 75,
      width: 602,
      height: 452,
    });
  });

  it('超出底图范围时夹到物理像素尺寸内', () => {
    // 1280*1.5=1920, 720*1.5=1080
    expect(cropRectInImage({ x: 1200, y: 700, width: 400, height: 400 }, display(1, 1280, 720, 1.5))).toEqual({
      x: 1800,
      y: 1050,
      width: 120,
      height: 30,
    });
  });
});

describe('describeFinish', () => {
  it('三个动作各有中文提示', () => {
    expect(describeFinish('copy')).toBe('已复制到剪贴板');
    expect(describeFinish('paste')).toBe('已粘贴到目标窗口');
    expect(describeFinish('save')).toBe('已保存为文件');
  });

  it('未知动作有兜底文案（不让 toast 出现 undefined）', () => {
    const text = describeFinish('nope' as unknown as Parameters<typeof describeFinish>[0]);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('undefined');
  });
});

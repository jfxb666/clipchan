import { describe, expect, it, vi } from 'vitest';
import {
  BURST_COUNT,
  BURST_WINDOW_MS,
  BurstDetector,
  burstHintText,
  showBurstBalloon,
} from './burst';

describe('BurstDetector', () => {
  it('2 秒内连续 3 条触发预选，ids 恰好是那 3 条', () => {
    const d = new BurstDetector();
    expect(d.note('a', 1000).triggered).toBe(false);
    expect(d.note('b', 2000).triggered).toBe(false);
    const third = d.note('c', 3000);
    expect(third.triggered).toBe(true);
    expect(third.ids).toEqual(['a', 'b', 'c']);
  });

  it('同一轮只触发一次（后续复制继续收集但不重复提示）', () => {
    const d = new BurstDetector();
    d.note('a', 1000);
    d.note('b', 2000);
    expect(d.note('c', 3000).triggered).toBe(true);
    const fourth = d.note('d', 3500);
    expect(fourth.triggered).toBe(false);
    expect(d.isHinted).toBe(true);
  });

  it('跨 2.5 秒的慢速复制不触发', () => {
    const d = new BurstDetector();
    expect(d.note('a', 1000).triggered).toBe(false);
    expect(d.note('b', 3500).triggered).toBe(false);
    expect(d.note('c', 6000).triggered).toBe(false);
  });

  it('窗口右边界含：最早一条恰好落在 cutoff 上仍算同一串', () => {
    const d = new BurstDetector();
    d.note('a', 0);
    d.note('b', 1000);
    // c 的 cutoff 正好是 0，a 落在边界上，应仍算窗口内。
    expect(d.note('c', BURST_WINDOW_MS).triggered).toBe(true);
  });

  it('窗口左边界外：最早一条超过窗口就被丢掉', () => {
    const d = new BurstDetector();
    d.note('a', 0);
    d.note('b', 1000);
    // c 的 cutoff = 2001，a(0) 已被丢弃，只剩 b、c 两条，不触发。
    expect(d.note('c', BURST_WINDOW_MS + 1).triggered).toBe(false);
  });

  it('clear() 后归零，可以再次触发', () => {
    const d = new BurstDetector();
    d.note('a', 1000);
    d.note('b', 2000);
    d.note('c', 3000);
    d.clear();
    expect(d.ids()).toEqual([]);
    expect(d.isHinted).toBe(false);
    d.note('x', 4000);
    d.note('y', 4500);
    expect(d.note('z', 5000).triggered).toBe(true);
  });

  it('只预选、不产生任何合并动作（返回值里没有合并记录字段）', () => {
    const d = new BurstDetector();
    d.note('a', 1000);
    d.note('b', 2000);
    const note = d.note('c', 3000);
    expect(Object.keys(note).sort()).toEqual(['ids', 'triggered']);
  });

  it('空 id 被忽略', () => {
    const d = new BurstDetector();
    expect(d.note('', 1000).triggered).toBe(false);
    expect(d.ids()).toEqual([]);
  });

  it('常量与 spec §7.5 一致', () => {
    expect(BURST_WINDOW_MS).toBe(2000);
    expect(BURST_COUNT).toBe(3);
  });
});

describe('showBurstBalloon', () => {
  it('面板不可见时发一次托盘气泡', () => {
    const tray = { displayBalloon: vi.fn() };
    expect(showBurstBalloon(tray, 3)).toBe(true);
    expect(tray.displayBalloon).toHaveBeenCalledTimes(1);
    expect(tray.displayBalloon).toHaveBeenCalledWith({ title: '剪贴板酱', content: burstHintText(3) });
  });

  it('没有托盘时静默返回 false，不抛', () => {
    expect(showBurstBalloon(null, 3)).toBe(false);
  });

  it('托盘抛异常时不向外冒泡', () => {
    const tray = {
      displayBalloon: () => {
        throw new Error('not supported');
      },
    };
    expect(showBurstBalloon(tray, 3)).toBe(false);
  });
});

describe('burstHintText', () => {
  it('文案与 spec §7.5 一致', () => {
    expect(burstHintText(3)).toBe('连续复制了 3 条，按 Ctrl+M 拼接');
  });
});

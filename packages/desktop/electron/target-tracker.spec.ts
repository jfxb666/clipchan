import { describe, expect, it } from 'vitest';
import { TargetTracker } from './target-tracker';

const SELF = 0x2002;

describe('TargetTracker.noteForeground（唤起时捕获的 pending 槽位）', () => {
  it('记下外部句柄 → consume 取到它，再取一次为 null（一次性消费）', () => {
    const t = new TargetTracker();
    t.noteForeground(0x1001, SELF);
    expect(t.consume()).toBe(0x1001);
    expect(t.consume()).toBeNull();
  });

  it('hwnd === selfHwnd → 视为无目标（粘回自己面板毫无意义）', () => {
    const t = new TargetTracker();
    t.noteForeground(SELF, SELF);
    expect(t.consume()).toBeNull();
  });

  it('非法句柄（0 / 负数 / 非整数）→ 清空 pending', () => {
    const t = new TargetTracker();
    t.noteForeground(0x1001, SELF);
    t.noteForeground(0, SELF);
    expect(t.consume()).toBeNull();

    t.noteForeground(0x1001, SELF);
    t.noteForeground(-1, SELF);
    expect(t.consume()).toBeNull();

    t.noteForeground(0x1001, SELF);
    t.noteForeground(1.5, SELF);
    expect(t.consume()).toBeNull();
  });
});

describe('TargetTracker.captureTarget（生产调用路径：show() 之前捕获）', () => {
  it('查到外部窗口 → captured，并写进 pending 供 consume 取走', async () => {
    const t = new TargetTracker({ foreground: { foreground: async () => 0x1001 } });
    expect(await t.captureTarget(SELF)).toBe('captured');
    expect(t.consume()).toBe(0x1001);
  });

  it('查到的是自己 → self，pending 保持为空', async () => {
    const t = new TargetTracker({ foreground: { foreground: async () => SELF } });
    expect(await t.captureTarget(SELF)).toBe('self');
    expect(t.consume()).toBeNull();
  });

  it('查不到（0）→ unavailable，且不清掉已有目标（宁可粘错也别丢目标）', async () => {
    const values = [0x1001, 0];
    const t = new TargetTracker({ foreground: { foreground: async () => values.shift() ?? 0 } });
    await t.captureTarget(SELF);
    expect(await t.captureTarget(SELF)).toBe('unavailable');
    expect(t.consume()).toBe(0x1001);
  });

  it('助手抛异常 / 没有来源 → unavailable，不抛异常', async () => {
    const thrown = new TargetTracker({
      foreground: {
        foreground: async () => {
          throw new Error('助手没了');
        },
      },
    });
    await expect(thrown.captureTarget(SELF)).resolves.toBe('unavailable');
    expect(thrown.consume()).toBeNull();

    const bare = new TargetTracker();
    await expect(bare.captureTarget(SELF)).resolves.toBe('unavailable');
    expect(bare.consume()).toBeNull();
  });
});

describe('TargetTracker.consume（一次性消费 / Review Focus 2）', () => {
  it('优先返回 pending，其次回退 lastForeign', async () => {
    const t = new TargetTracker({ foreground: { foreground: async () => 0x3003 } });
    await t.notePanelShown(SELF);
    t.noteForeground(0x1001, SELF);
    expect(t.consume()).toBe(0x1001);
  });

  it('消费一次就把两个槽位一起清空（陈旧句柄绝不复用）', async () => {
    const t = new TargetTracker({ foreground: { foreground: async () => 0x3003 } });
    await t.notePanelShown(SELF);
    t.noteForeground(0x1001, SELF);
    expect(t.consume()).toBe(0x1001);
    expect(t.consume()).toBeNull();
    expect(t.lastForeign()).toBeNull();
  });

  it('pending 为空时回退到 lastForeign 并同样清空', async () => {
    const t = new TargetTracker({ foreground: { foreground: async () => 0x3003 } });
    await t.notePanelShown(SELF);
    expect(t.consume()).toBe(0x3003);
    expect(t.consume()).toBeNull();
  });

  it('两个槽位都空 → null', () => {
    const t = new TargetTracker();
    expect(t.consume()).toBeNull();
  });
});

describe('TargetTracker.notePanelShown（刷新 lastForeign）', () => {
  it('查到外部窗口 → 记下；查到 self / 0 / 非法句柄 → 保留旧值', async () => {
    const values = [0x3003, SELF, 0, -5];
    const t = new TargetTracker({ foreground: { foreground: async () => values.shift() ?? 0 } });
    await t.notePanelShown(SELF);
    expect(t.lastForeign()).toBe(0x3003);
    await t.notePanelShown(SELF); // self
    expect(t.lastForeign()).toBe(0x3003);
    await t.notePanelShown(SELF); // 0
    expect(t.lastForeign()).toBe(0x3003);
    await t.notePanelShown(SELF); // 负数
    expect(t.lastForeign()).toBe(0x3003);
  });

  it('lastForeign() 只读，不清空；consume() 才清', async () => {
    const t = new TargetTracker({ foreground: { foreground: async () => 0x3003 } });
    await t.notePanelShown(SELF);
    expect(t.lastForeign()).toBe(0x3003);
    expect(t.lastForeign()).toBe(0x3003);
    expect(t.consume()).toBe(0x3003);
    expect(t.lastForeign()).toBeNull();
  });

  it('没有 foreground 来源（助手不可用）时是 no-op 且不抛', async () => {
    const t = new TargetTracker();
    await expect(t.notePanelShown(SELF)).resolves.toBeUndefined();
    expect(t.lastForeign()).toBeNull();
  });

  it('前台查询抛异常时不抛、不记', async () => {
    const t = new TargetTracker({
      foreground: {
        foreground: async () => {
          throw new Error('助手没了');
        },
      },
    });
    await expect(t.notePanelShown(SELF)).resolves.toBeUndefined();
    expect(t.lastForeign()).toBeNull();
  });
});

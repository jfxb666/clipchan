import { describe, expect, it } from 'vitest';
import { autoStartClick, autoStartSettle, initialAutoStartToggle } from './autoStartToggle';

describe('开机自启动开关状态机', () => {
  it('null（尚未读到）按关闭处理', () => {
    expect(initialAutoStartToggle(null).on).toBe(false);
    expect(initialAutoStartToggle(false).on).toBe(false);
    expect(initialAutoStartToggle(true).on).toBe(true);
  });

  it('★ 回归：平台值一直是 false（读一次不刷新）时，连点两次必须一次开一次关', () => {
    // 模拟真实场景：prop 永远是 false，因为 usePlatformValue 只在挂载时读。
    const stale = initialAutoStartToggle(false);

    const first = autoStartClick(stale);
    expect(first.requested).toBe(true);
    expect(first.state.on).toBe(true);

    // 关键：第二次点击基于**自己维护的现值**，而不是再次取反那个陈旧的 prop。
    const second = autoStartClick(first.state);
    expect(second.requested).toBe(false);
    expect(second.state.on).toBe(false);
  });

  it('写入失败时回滚，不假装成功', () => {
    const opened = autoStartClick(initialAutoStartToggle(false));
    const rolled = autoStartSettle(opened.state, opened.requested, false);
    expect(rolled.on).toBe(false);
  });

  it('写入成功时保持', () => {
    const opened = autoStartClick(initialAutoStartToggle(false));
    expect(autoStartSettle(opened.state, opened.requested, true).on).toBe(true);
  });

  it('平台没回报（undefined）不回滚，避免误判', () => {
    const opened = autoStartClick(initialAutoStartToggle(false));
    expect(autoStartSettle(opened.state, opened.requested, undefined).on).toBe(true);
  });
});

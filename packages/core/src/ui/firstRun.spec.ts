/**
 * 首次使用引导的判定条件单测。
 * 组件（EmptyState.tsx）只按 showFirstRun 这个布尔值决定渲染与否，判定逻辑全在这里。
 */
import { describe, expect, it } from 'vitest';
import { firstRunTips, shouldShowFirstRun } from './firstRun';

describe('shouldShowFirstRun', () => {
  it('有搜索词就不显示', () => {
    expect(shouldShowFirstRun('all', 'foo', false)).toBe(false);
  });

  it('只有空格等同于没搜索：与 emptyHintOf 的 trim 口径对齐', () => {
    // emptyHintOf 对 '   ' 返回的是「口袋还是空的」而不是「没有找到包含「」的记录」，
    // 说明界面已经把纯空格当成空搜索；那时引导理应跟着出现，否则会出现
    // 「文案说口袋空、却没有任何上手提示」的割裂。
    expect(shouldShowFirstRun('all', '   ', false)).toBe(true);
  });

  it('库里已经有记录就不显示', () => {
    expect(shouldShowFirstRun('all', '', true)).toBe(false);
  });

  it('不是「全部」分组就不显示：其它分组有自己的空状态文案', () => {
    expect(shouldShowFirstRun('image', '', false)).toBe(false);
    expect(shouldShowFirstRun('favorite', '', false)).toBe(false);
    expect(shouldShowFirstRun('text-group', '', false)).toBe(false);
  });

  it('全部满足（全部页 + 无搜索词 + 一条记录都没有）才显示', () => {
    expect(shouldShowFirstRun('all', '', false)).toBe(true);
  });
});

describe('firstRunTips', () => {
  it('固定三条，且每条 text/hint 都非空', () => {
    const tips = firstRunTips();
    expect(tips).toHaveLength(3);
    for (const tip of tips) {
      expect(tip.text.trim().length).toBeGreaterThan(0);
      expect(tip.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('三条讲的不是同一件事', () => {
    const texts = firstRunTips().map((t) => t.text);
    expect(new Set(texts).size).toBe(3);
  });
});

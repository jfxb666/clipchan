import { describe, expect, it } from 'vitest';
import { batchActions, batchBarText, canBatchRemove } from './batchBar';

describe('batchActions', () => {
  it('0 条时没有任何动作（操作栏整条不渲染）', () => {
    expect(batchActions(0, false)).toEqual([]);
    expect(batchActions(0, true)).toEqual([]);
    expect(batchActions(-1, false)).toEqual([]);
  });

  it('1 条：粘贴 / 收藏 / 删除', () => {
    expect(batchActions(1, false)).toEqual([
      { key: 'paste', label: '粘贴为一条' },
      { key: 'pin', label: '收藏' },
      { key: 'remove', label: '删除', danger: true },
    ]);
  });

  it('多条未全收藏时是「收藏」', () => {
    expect(batchActions(3, false).map((a) => a.key)).toEqual(['paste', 'pin', 'remove']);
  });

  it('全都已收藏时是「取消收藏」', () => {
    const actions = batchActions(2, true);
    expect(actions.map((a) => a.key)).toEqual(['paste', 'unpin', 'remove']);
    expect(actions[1]?.label).toBe('取消收藏');
  });

  it('只有删除带 danger', () => {
    const actions = batchActions(2, false);
    expect(actions.filter((a) => a.danger === true).map((a) => a.key)).toEqual(['remove']);
  });

  it('顺序固定：粘贴 -> 收藏 -> 删除', () => {
    expect(batchActions(5, true).map((a) => a.key)).toEqual(['paste', 'unpin', 'remove']);
  });
});

describe('batchBarText', () => {
  it('多条', () => {
    expect(batchBarText(3)).toBe('已选 3 条');
  });

  it('一条', () => {
    expect(batchBarText(1)).toBe('已选 1 条');
  });

  it('0 条是空串', () => {
    expect(batchBarText(0)).toBe('');
  });
});

describe('canBatchRemove', () => {
  it('有选中才能删', () => {
    expect(canBatchRemove(1)).toBe(true);
    expect(canBatchRemove(9)).toBe(true);
  });

  it('没选中不能删', () => {
    expect(canBatchRemove(0)).toBe(false);
    expect(canBatchRemove(-2)).toBe(false);
  });
});

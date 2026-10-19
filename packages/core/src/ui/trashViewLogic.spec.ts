/**
 * 回收站纯逻辑单测。
 *
 * 仓库的 vitest 只跑 node 环境、没有 jsdom（见 keymap.spec.ts 的文件头），
 * 所以 TrashView.tsx 本身渲染不了；这里断言的是从组件里抽出来的判定函数，
 * 组件只负责把结果摆到 DOM 上。
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TRASH_CONFIRM_TTL_MS,
  EMPTY_TRASH_HINT,
  TRASH_MAX_LIMIT,
  TRASH_PAGE_SIZE,
  deletedAtText,
  emptyTrashLabel,
  isTrashEmpty,
  nextTrashOffset,
  purgeLabel,
  shouldShowEmptyTrash,
  trashTitle,
} from './trashViewLogic';

describe('trashTitle', () => {
  it('用真实总数，不是已加载条数', () => {
    expect(trashTitle(0)).toBe('回收站（0 条）');
    expect(trashTitle(37)).toBe('回收站（37 条）');
  });

  it('total 未知（-1）时显示 0 条而不是「-1 条」', () => {
    expect(trashTitle(-1)).toBe('回收站（0 条）');
  });
});

describe('shouldShowEmptyTrash', () => {
  it('有记录才显示清空按钮', () => {
    expect(shouldShowEmptyTrash(1)).toBe(true);
    expect(shouldShowEmptyTrash(200)).toBe(true);
  });

  it('空回收站不显示：留个永远能点的清空按钮只会让人怀疑界面坏了', () => {
    expect(shouldShowEmptyTrash(0)).toBe(false);
  });

  it('total 未知时不显示（不能对未知数量执行破坏性操作）', () => {
    expect(shouldShowEmptyTrash(-1)).toBe(false);
  });
});

describe('isTrashEmpty', () => {
  it('已加载 0 条且不在加载中才算空', () => {
    expect(isTrashEmpty(0, false)).toBe(true);
  });

  it('加载中不算空：否则首屏会先闪一下「口袋还是空的」再跳成列表', () => {
    expect(isTrashEmpty(0, true)).toBe(false);
  });

  it('有数据时不算空（即使正在加载下一页）', () => {
    expect(isTrashEmpty(5, false)).toBe(false);
    expect(isTrashEmpty(5, true)).toBe(false);
  });
});

describe('nextTrashOffset', () => {
  it('还有下一页时返回已加载条数当 offset', () => {
    expect(nextTrashOffset(0, 300)).toBe(0);
    expect(nextTrashOffset(200, 300)).toBe(200);
  });

  it('已加载满总数时返回 null（到底了，别重复拉同一页）', () => {
    expect(nextTrashOffset(300, 300)).toBeNull();
    expect(nextTrashOffset(5, 5)).toBeNull();
  });

  it('空回收站也返回 null', () => {
    expect(nextTrashOffset(0, 0)).toBeNull();
  });

  it('total 未知（-1）时只在「上一页正好是满页」才继续翻', () => {
    expect(nextTrashOffset(0, -1)).toBeNull();
    expect(nextTrashOffset(TRASH_PAGE_SIZE - 1, -1)).toBeNull();
    expect(nextTrashOffset(TRASH_PAGE_SIZE, -1)).toBe(TRASH_PAGE_SIZE);
    expect(nextTrashOffset(TRASH_PAGE_SIZE * 2, -1)).toBe(TRASH_PAGE_SIZE * 2);
  });

  it('单页条数不超过主进程的单次硬上限', () => {
    expect(TRASH_PAGE_SIZE).toBeLessThanOrEqual(TRASH_MAX_LIMIT);
  });
});

describe('二次确认文案', () => {
  it('清空：待确认态与设置页两个清空按钮逐字一致', () => {
    expect(emptyTrashLabel(false)).toBe('清空回收站');
    expect(emptyTrashLabel(true)).toBe('再点一次确认');
  });

  it('单条永久删除：同一套两次点击语义', () => {
    expect(purgeLabel(false)).toBe('永久删除');
    expect(purgeLabel(true)).toBe('再点一次确认');
  });

  it('确认窗口与 Ctrl+Delete / 设置页同为 3 秒', () => {
    expect(EMPTY_TRASH_CONFIRM_TTL_MS).toBe(3000);
  });
});

describe('deletedAtText', () => {
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime();

  it('有 deletedAt 时前缀「删除于」', () => {
    const sameDay = new Date(2026, 9, 19, 8, 30, 0).getTime();
    expect(deletedAtText({ deletedAt: sameDay }, now)).toBe('删除于 08:30');
  });

  it('缺 deletedAt 时如实说未知，不拿 createdAt 冒充', () => {
    expect(deletedAtText({}, now)).toBe('删除时间未知');
  });
});
describe('EMPTY_TRASH_HINT', () => {
  it('空回收站的文案要解释「删掉的东西去哪了」，而不是让人再去复制点什么', () => {
    expect(EMPTY_TRASH_HINT).toContain('恢复');
    expect(EMPTY_TRASH_HINT).not.toContain('复制');
  });
});

import { describe, expect, it } from 'vitest';
import type { ClipItemDTO } from '../types';
import {
  WIZARD_BATCH_SIZE,
  appliedToastText,
  collectBatch,
  defaultSelection,
  nextBatchOffset,
  wizardRowOf,
  wizardRowsOf,
} from './organizeWizard';

function dto(over: Partial<ClipItemDTO> & { id: string }): ClipItemDTO {
  return {
    kind: 'text',
    preview: '',
    createdAt: 1700000000000,
    pinned: false,
    source: 'capture',
    ...over,
  } as ClipItemDTO;
}

describe('一键整理向导纯逻辑（v1.2 C1）', () => {
  it('★ 建议只来自本地规则词表（零 AI 零网络）：链接→链接、代码→代码', () => {
    const rows = wizardRowsOf([
      dto({ id: 'a', kind: 'link', preview: 'https://example.com/page' }),
      dto({ id: 'b', kind: 'code', preview: 'const x = 1;' }),
      // 无规则命中（3 个拉丁字母、无 CJK、不是 JSON/邮箱/电话/颜色）→ 空建议，不硬凑
      dto({ id: 'c', kind: 'text', preview: 'abc' }),
    ]);
    expect(rows[0]!.suggested).toEqual(['链接']);
    expect(rows[1]!.suggested).toEqual(['代码']);
    expect(rows[2]!.suggested).toEqual([]);
    // preview 缺失等脏数据不让建行崩掉
    expect(wizardRowOf(dto({ id: 'd', preview: undefined })).preview).toBe('');
  });

  it('★ 默认勾选 = 全部非空建议；且只是建议的拷贝（改勾选不污染行）', () => {
    const row = wizardRowOf(dto({ id: 'a', kind: 'link', preview: 'https://example.com/' }));
    const picked = defaultSelection(row);
    expect(picked).toEqual(['链接']);
    picked.push('手加的');
    expect(row.suggested).toEqual(['链接']);
  });

  it('★ collectBatch 只收勾了标签的行；undo 快照记录应用前旧标签', () => {
    const rows = wizardRowsOf([
      dto({ id: 'a', kind: 'link', preview: 'https://example.com/' }),
      dto({ id: 'b', kind: 'text', preview: 'abc' }),
      dto({ id: 'c', kind: 'text', preview: 'abc', tags: ['旧标签'] }),
    ]);
    const batch = collectBatch(rows, {
      a: defaultSelection(rows[0]!),
      // b 没勾任何标签 → 整行跳过（不给它写空标签）
      b: [],
      // c 用户手勾了一个标签；undo 必须按行的旧标签记，撤销才能如实还原
      c: ['手勾'],
    });
    expect(batch.entries).toEqual([
      { id: 'a', tags: ['链接'] },
      { id: 'c', tags: ['手勾'] },
    ]);
    expect(batch.undo).toEqual([
      { id: 'a', tags: [] },
      { id: 'c', tags: ['旧标签'] },
    ]);
  });

  it('★ nextBatchOffset 推进量 = 实际应用条数；applied=0 不推进（防原地重拉死循环）', () => {
    expect(nextBatchOffset(0, 50)).toBe(50);
    expect(nextBatchOffset(200, 30)).toBe(230);
    expect(nextBatchOffset(0, 0)).toBe(0);
    // 脏输入兜底：负数/NaN 回 0，不让分页被打成非法值
    expect(nextBatchOffset(-5, 10)).toBe(10);
    expect(nextBatchOffset(Number.NaN, 10)).toBe(10);
    expect(nextBatchOffset(0, Number.NaN)).toBe(0);
  });

  it('文案与批量大小常量', () => {
    expect(WIZARD_BATCH_SIZE).toBe(200);
    expect(appliedToastText(3)).toBe('已整理 3 条，可撤销');
    expect(appliedToastText(-1)).toBe('已整理 0 条，可撤销');
  });
});

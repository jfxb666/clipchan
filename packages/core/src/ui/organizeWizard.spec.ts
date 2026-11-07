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

  it('★ nextBatchOffset 推进量 = 被跳过的行数（shown − applied）；全选应用=原地不动', () => {
    // 全选应用：applied 行从集合里消失，下一批从未展示的行顶到原 offset 位置
    expect(nextBatchOffset(0, 50, 50)).toBe(0);
    expect(nextBatchOffset(200, 30, 30)).toBe(200);
    // 部分跳过：只前进没应用的占位行数
    expect(nextBatchOffset(200, 50, 20)).toBe(230);
    expect(nextBatchOffset(0, 200, 199)).toBe(1);
    // applied=0：整批都是跳过行，整批推进（组件里有 entries=0 / 失败兜底，不会走到这里）
    expect(nextBatchOffset(0, 50, 0)).toBe(50);
    // 脏输入兜底：负数/NaN 回 0，不让分页被打成非法值；applied>shown 不往回拉（不产生负推进）
    expect(nextBatchOffset(-5, 10, 3)).toBe(7);
    expect(nextBatchOffset(Number.NaN, 10, 3)).toBe(7);
    expect(nextBatchOffset(0, Number.NaN, 3)).toBe(0);
    expect(nextBatchOffset(0, 10, Number.NaN)).toBe(10);
    expect(nextBatchOffset(40, 10, 99)).toBe(40);
  });

  /**
   * 镜像 OrganizeViewCard.applyBatch 的一批（按组件真实调用顺序摆）：
   * listUntagged 分页 → wizardRowsOf → 全批 collectBatch → applyTagsBulk（全成功时返回应用条数）
   * → nextBatchOffset 推进 → 应用行从未归类集合里消失，其余行保持相对次序。
   */
  function applyOneBatch(
    pool: string[],
    offset: number,
    select: (id: string) => string[],
  ): { shown: string[]; applied: number; nextOffset: number; remaining: string[] } {
    const ids = pool.slice(offset, offset + WIZARD_BATCH_SIZE);
    const rows = wizardRowsOf(ids.map((id) => dto({ id, kind: 'text', preview: '内容 ' + id })));
    const selections = Object.fromEntries(rows.map((row) => [row.id, select(row.id)]));
    const batch = collectBatch(rows, selections);
    const applied = batch.entries.length; // applyTagsBulk 全成功 = 应用条数（组件在 ≤0 时不推进）
    const nextOffset = nextBatchOffset(offset, rows.length, applied);
    const gone = new Set(batch.entries.map((e) => e.id));
    return {
      shown: rows.map((row) => row.id),
      applied,
      nextOffset,
      remaining: pool.filter((id) => !gone.has(id)),
    };
  }

  it('★ 回归（评审轨迹）：800 条积压、批 200 全选应用——不再跳过未展示条目、不再谎报完成', () => {
    const total = 800;
    let pool: string[] = Array.from({ length: total }, (_, i) => 'U' + (i + 1));
    let offset = 0;
    let batchNo = 0;
    let done = false;
    const batches: string[][] = [];

    // 循环上限防真死循环：正常应 4 批铺完 + 第 5 次空批进完成态
    while (batchNo < 100) {
      batchNo += 1;
      if (pool.slice(offset, offset + WIZARD_BATCH_SIZE).length === 0) {
        done = true; // 空批 = 完成态（与 fetchBatch 一致）
        break;
      }
      const result = applyOneBatch(pool, offset, () => ['手勾']); // 全选：每行至少勾一个
      expect(result.applied).toBeGreaterThan(0);
      batches.push(result.shown);
      offset = result.nextOffset;
      pool = result.remaining;
    }

    // 批 2 必须从第一个从未展示的行（U201）开始：修复前 offset 推进到 200，
    // 拿到的是 U401..U600 —— U201..U400 从未展示，最后 400 条未整理却谎报「全部整理完成」。
    expect(batches[0]).toEqual(Array.from({ length: WIZARD_BATCH_SIZE }, (_, i) => 'U' + (i + 1)));
    expect(batches[1]).toEqual(Array.from({ length: WIZARD_BATCH_SIZE }, (_, i) => 'U' + (i + 201)));

    // 终态：恰好 4 批铺完 800 条，集合清空后才进完成态（完成 = 全部打上标签）
    expect(done).toBe(true);
    expect(batches.length).toBe(4);
    expect(pool).toEqual([]);
    // 展示过的行并集覆盖全部 800 条：无缺口、无重复
    const shown = batches.flat();
    expect(shown.length).toBe(total);
    expect(new Set(shown).size).toBe(total);
    const shownSorted = [...new Set(shown)].sort(
      (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
    );
    expect(shownSorted).toEqual(Array.from({ length: total }, (_, i) => 'U' + (i + 1)));
  });

  it('★ 未应用的行仍占位：跳过 1 行时游标只前进 1，下一批从它的后一位开始', () => {
    let pool = Array.from({ length: 800 }, (_, i) => 'U' + (i + 1));
    // 批 1：200 行里 U1 的勾选被点掉（跳过），其余 199 条全应用
    const first = applyOneBatch(pool, 0, (id) => (id === 'U1' ? [] : ['手勾']));
    expect(first.applied).toBe(199);
    expect(first.nextOffset).toBe(1);
    pool = first.remaining;
    // 批 2：U1 占在第 0 位，offset=1 起才是从未展示过的 U201..；U1 本会话不再回头展示
    const secondBatch = pool.slice(first.nextOffset, first.nextOffset + WIZARD_BATCH_SIZE);
    expect(secondBatch[0]).toBe('U201');
    expect(secondBatch).not.toContain('U1');
  });

  it('文案与批量大小常量', () => {
    expect(WIZARD_BATCH_SIZE).toBe(200);
    expect(appliedToastText(3)).toBe('已整理 3 条，可撤销');
    expect(appliedToastText(-1)).toBe('已整理 0 条，可撤销');
  });
});

/**
 * 拼接服务（spec §7.5；计划 Task 9 步骤 ④）。
 *
 * ★ 语义完全照抄旧版（legacy/src/MainForm.cs MergeSelected + Store.cs MergeTexts）：
 *   跳过收藏项与图片项 → 剩余不足 2 条则**什么都不做**（只提示）→
 *   按列表顺序用 CRLF 连接 → 生成**一条新记录**（source='merge'、kind 重算）→
 *   **删除源条目** → 不走去重的"提升到最前"分支（新记录本来就是最新）。
 * ★ 本文件不 import electron，可在 Node 里用真 sqlite 单测。
 */
import { mergeTexts, type Kind } from '@clipchan/core';
import type { Db, ItemRow } from './db';

export interface MergeResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

/** 拼接失败的原因文案键（与 core 的 mergeToast 映射表一致）。 */
export const MERGE_REASON = {
  notEnough: 'not-enough',
  pinned: 'pinned',
  imagesSkipped: 'images-skipped',
} as const;

function kindOf(row: ItemRow): Kind {
  return row.kind as Kind;
}

export class MergeService {
  private readonly db: Db;

  constructor(deps: { db: Db }) {
    this.db = deps.db;
  }

  /**
   * 把选中的若干条拼接成一条。**永不抛**，失败一律返回 {ok:false, reason}。
   * ids 的顺序即拼接顺序（调用方传的是列表顺序）。
   */
  mergeSelected(ids: string[]): MergeResult {
    if (!Array.isArray(ids) || ids.length < 2) {
      return { ok: false, reason: MERGE_REASON.notEnough };
    }
    const rows: ItemRow[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) continue;
      const row = this.db.getRow(id);
      if (row) rows.push(row);
    }
    if (rows.length < 2) return { ok: false, reason: MERGE_REASON.notEnough };

    const pinned = rows.filter((r) => r.pinned === 1).length;
    const images = rows.filter((r) => kindOf(r) === 'image' || r.content === null).length;
    const merged = mergeTexts(
      rows.map((r) => ({ content: r.content, pinned: r.pinned === 1, kind: kindOf(r) })),
      '\r\n',
    );
    if (!merged) {
      if (images > 0 && rows.length - images < 2) return { ok: false, reason: MERGE_REASON.imagesSkipped };
      if (pinned > 0) return { ok: false, reason: MERGE_REASON.pinned };
      return { ok: false, reason: MERGE_REASON.notEnough };
    }

    // 先插入新记录，再删源条目：中途失败最多留下一份重复内容，绝不会丢数据。
    const inserted = this.db.insertText(merged.text, { source: 'merge' });
    // ★ 只删**真正参与了拼接**的条目：收藏项与图片项必须原样保留
    //   （旧版 MainForm.cs MergeSelected 也只 RemoveMany 选中的那些非收藏文本）。
    const sources = rows
      .filter((r) => r.pinned !== 1 && kindOf(r) !== 'image' && r.content !== null)
      .map((r) => r.id)
      .filter((id) => id !== inserted.id);
    this.db.removeMany(sources);
    return { ok: true, id: inserted.id };
  }
}

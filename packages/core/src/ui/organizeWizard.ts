/**
 * 一键整理向导的纯逻辑（v1.2 C1）。
 *
 * 与 organizeView.ts 同一纪律：不 import react、不碰 store、不碰 IO —— 仓库的 vitest
 * 只有 node 环境，能测的东西一律放在这里，OrganizeViewCard.tsx 只负责把结果摆到 DOM 上。
 *
 * ★ 范围红线（永久不进这个文件，写在这里防止后人"顺手补上"）：
 *   1. 不做文件夹自动建议 —— 标签错了点掉就行，文件夹挪错是对用户分类体系的实伤；
 *   2. 不调 AI 批量打标 —— 一批最多 200 条，批量跑模型费用不可控；
 *      建议只来自 suggestTags 的固定词表规则（与整理弹窗同源，零网络、零费用）。
 */

import { suggestTags } from '../logic/organize';
import type { ClipItemDTO, Kind } from '../types';

/** 向导每批拉取的条数（与主列表 PAGE_SIZE 同量级；一批一屏，应用后自动进下一批）。 */
export const WIZARD_BATCH_SIZE = 200;

/** 向导一行的展示数据：未归类条目 + 本地规则建议 + 应用前旧标签。 */
export interface WizardRow {
  id: string;
  kind: Kind;
  preview: string;
  /** 本地规则建议的标签（可能为空数组：没有规则命中就不建议，不硬凑）。 */
  suggested: string[];
  /** 应用前的旧标签。行来自 untagged 查询，几乎恒为空数组；仍按真实值记，撤销才能如实还原。 */
  prevTags: string[];
}

/** 本批的应盘数据：要写的 entries 与一一对应的撤销快照（collectBatch 保证对齐）。 */
export interface WizardBatch {
  /** 要应用的条目（勾了 ≥1 个标签的行）；空勾选跳过，不给它写空标签。 */
  entries: { id: string; tags: string[] }[];
  /** 应用前快照（与 entries 一一对应）：撤销时原样喂回 applyTagsBulk 即完成反向。 */
  undo: { id: string; tags: string[] }[];
}

/** 一条未归类记录 → 向导行。 */
export function wizardRowOf(item: ClipItemDTO): WizardRow {
  const preview = typeof item.preview === 'string' ? item.preview : '';
  return {
    id: item.id,
    kind: item.kind,
    preview,
    // ★ 与 OrganizeItemDialog 同源：text 用 preview（列表投影已截断，固定词表规则判定足够），
    //   不为一批 200 条逐条拉全文 —— 那是一次打开 200 个 IPC 往返。
    suggested: suggestTags({
      kind: item.kind,
      text: preview,
      sourceApp: item.sourceApp,
      createdAt: item.createdAt,
    }),
    prevTags: Array.isArray(item.tags) ? [...item.tags] : [],
  };
}

/** 一批条目 → 一批行（保持主列表的排序，不重排）。 */
export function wizardRowsOf(items: ClipItemDTO[]): WizardRow[] {
  if (!Array.isArray(items)) return [];
  return items.map(wizardRowOf);
}

/** 行的默认勾选 = 全部非空建议（★ 只勾建议，不发明词表外的标签；用户可再逐个点掉）。 */
export function defaultSelection(row: WizardRow): string[] {
  return Array.isArray(row.suggested) ? [...row.suggested] : [];
}

/**
 * 汇总本批要应用的 entries + 撤销快照（一一对应）。
 *
 * ★ 只收勾了 ≥1 个标签的行：applyTagsBulk 是整体替换语义，给它喂空 tags 会把
 *   （理论上可能新打上的）标签清掉 —— 跳过才是「这条先不整理」。
 */
export function collectBatch(rows: WizardRow[], selectionOf: Record<string, string[]>): WizardBatch {
  const entries: { id: string; tags: string[] }[] = [];
  const undo: { id: string; tags: string[] }[] = [];
  if (!Array.isArray(rows)) return { entries, undo };
  for (const row of rows) {
    const tags = selectionOf[row.id];
    if (!Array.isArray(tags) || tags.length === 0) continue;
    entries.push({ id: row.id, tags: [...tags] });
    undo.push({ id: row.id, tags: Array.isArray(row.prevTags) ? [...row.prevTags] : [] });
  }
  return { entries, undo };
}

/**
 * 下一批的 offset：推进量 = 实际应用条数。
 *
 * ★ 应用过的行已离开未归类集合；没勾标签的行仍留在原地 —— offset 只按应用数推进，
 *   意味着本会话内跳过的行不再回头展示（重开向导从第一批重新开始）。
 *   applied=0 时不推进：否则下一批原样重拉，向导会原地打转。
 */
export function nextBatchOffset(offset: number, applied: number): number {
  const at = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const n = typeof applied === 'number' && Number.isFinite(applied) ? Math.max(0, Math.floor(applied)) : 0;
  return at + n;
}

/** 「已整理 N 条」提示文案（toast 上挂着撤销按钮，文案里带上可撤销）。 */
export function appliedToastText(applied: number): string {
  return '已整理 ' + Math.max(0, applied) + ' 条，可撤销';
}

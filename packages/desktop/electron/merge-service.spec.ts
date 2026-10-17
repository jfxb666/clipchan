import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db';
import type { Db, ItemRow } from './db';
import { MERGE_REASON, MergeService } from './merge-service';

const opened: Db[] = [];

function mem(): Db {
  const db = openDb(':memory:');
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    try { db.close(); } catch { /* 已关闭 */ }
  }
});

function countRows(db: Db): number {
  const r = db.raw.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
  return r.n;
}

function row(db: Db, id: string): ItemRow {
  const r = db.getRow(id);
  if (!r) throw new Error('行不存在: ' + id);
  return r;
}

function addImage(db: Db, hash: string, at: number): string {
  return db.insertImage(
    { hash, width: 100, height: 50, bytes: 2048, imagePath: 'images/' + hash + '.png', thumbPath: 'thumbs/' + hash + '.png' },
    { createdAt: at },
  ).id;
}

describe('MergeService.mergeSelected', () => {
  it('3 条文本合并为 1 条，源条目被删除', () => {
    const db = mem();
    const a = db.insertText('第一行', { now: 1000 }).id;
    const b = db.insertText('第二行', { now: 2000 }).id;
    const c = db.insertText('第三行', { now: 3000 }).id;
    const svc = new MergeService({ db });
    const res = svc.mergeSelected([a, b, c]);
    expect(res.ok).toBe(true);
    expect(res.id).toBeTruthy();
    expect(countRows(db)).toBe(1);
    const merged = row(db, res.id!);
    expect(merged.content).toBe('第一行\r\n第二行\r\n第三行');
    expect(db.getRow(a)).toBeNull();
    expect(db.getRow(b)).toBeNull();
    expect(db.getRow(c)).toBeNull();
  });

  it('拼接结果的 kind 按内容重算、source 为 merge', () => {
    const db = mem();
    const a = db.insertText('https://example.com/a', { now: 1000 }).id;
    const b = db.insertText('https://example.com/b', { now: 2000 }).id;
    const svc = new MergeService({ db });
    const res = svc.mergeSelected([a, b]);
    const merged = row(db, res.id!);
    // 两行 URL 连起来含换行 → 不再是单行链接，重算为 text。
    expect(merged.kind).toBe('text');
    expect(merged.source).toBe('merge');
  });

  it('收藏项被跳过且原样保留', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 }).id;
    const p = db.insertText('收藏的', { now: 1500, pinned: true }).id;
    const b = db.insertText('乙', { now: 2000 }).id;
    const svc = new MergeService({ db });
    const res = svc.mergeSelected([a, p, b]);
    expect(res.ok).toBe(true);
    expect(countRows(db)).toBe(2);
    expect(row(db, p).content).toBe('收藏的');
    expect(row(db, res.id!).content).toBe('甲\r\n乙');
  });

  it('图片项被跳过且原样保留', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 }).id;
    const img = addImage(db, 'hash-img-1', 1500);
    const b = db.insertText('乙', { now: 2000 }).id;
    const svc = new MergeService({ db });
    const res = svc.mergeSelected([a, img, b]);
    expect(res.ok).toBe(true);
    expect(countRows(db)).toBe(2);
    expect(row(db, img).kind).toBe('image');
    expect(row(db, res.id!).content).toBe('甲\r\n乙');
  });

  it('只剩 1 条可用时返回 not-enough 且不改动任何记录', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 }).id;
    const p = db.insertText('收藏的', { now: 2000, pinned: true }).id;
    const svc = new MergeService({ db });
    const res = svc.mergeSelected([a, p]);
    expect(res).toEqual({ ok: false, reason: MERGE_REASON.pinned });
    expect(countRows(db)).toBe(2);
    expect(row(db, a).content).toBe('甲');
    expect(row(db, p).content).toBe('收藏的');
  });

  it('两条图片无法拼接，返回 images-skipped', () => {
    const db = mem();
    const i1 = addImage(db, 'hash-img-2', 1000);
    const i2 = addImage(db, 'hash-img-3', 2000);
    const svc = new MergeService({ db });
    const res = svc.mergeSelected([i1, i2]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(MERGE_REASON.imagesSkipped);
    expect(countRows(db)).toBe(2);
  });

  it('少于 2 个 id 直接拒绝', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 }).id;
    const svc = new MergeService({ db });
    expect(svc.mergeSelected([a])).toEqual({ ok: false, reason: MERGE_REASON.notEnough });
    expect(svc.mergeSelected([])).toEqual({ ok: false, reason: MERGE_REASON.notEnough });
    expect(countRows(db)).toBe(1);
  });

  it('不存在的 id 被忽略；全都取不到时返回 not-enough 不抛', () => {
    const db = mem();
    const svc = new MergeService({ db });
    expect(() => svc.mergeSelected(['nope-1', 'nope-2'])).not.toThrow();
    expect(svc.mergeSelected(['nope-1', 'nope-2'])).toEqual({ ok: false, reason: MERGE_REASON.notEnough });
  });

  it('拼接结果排在列表最前（seq 最新）', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 }).id;
    const b = db.insertText('乙', { now: 2000 }).id;
    const svc = new MergeService({ db });
    const res = svc.mergeSelected([a, b]);
    const list = db.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(res.id);
  });
});

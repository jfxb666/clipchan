import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@clipchan/core';
import { openDb } from './db';
import type { Db } from './db';

const opened: Db[] = [];
const tmpDirs: string[] = [];

function mem(): Db {
  const db = openDb(':memory:');
  opened.push(db);
  return db;
}

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-db-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('openDb 建表与基本读写', () => {
  it('insertText 返回 32 位十六进制 id，list 能读回', () => {
    const db = mem();
    const r = db.insertText('你好', { now: 1000 });
    expect(r.touched).toBe(false);
    expect(r.id).toMatch(/^[0-9a-f]{32}$/);
    const rows = db.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(r.id);
    expect(rows[0]!.kind).toBe('text');
    expect(rows[0]!.preview).toBe('你好');
    expect(rows[0]!.createdAt).toBe(1000);
    expect(rows[0]!.pinned).toBe(false);
    expect(rows[0]!.source).toBe('capture');
  });
});

describe('排序与 seq', () => {
  it('同一毫秒按 seq 倒序；收藏记录排最前', () => {
    const db = mem();
    const a = db.insertText('a', { now: 1000 });
    const b = db.insertText('b', { now: 1000 });
    const c = db.insertText('c', { now: 1000 });
    expect(db.list().map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    const old = db.insertText('老收藏', { now: 1, pinned: true });
    expect(db.list()[0]!.id).toBe(old.id);
  });
});

describe('整段历史去重与双刷新', () => {
  it('命中已有内容时刷新 created_at 与 seq，不新增', () => {
    const db = mem();
    const a = db.insertText('A', { now: 1000 });
    const b = db.insertText('B', { now: 1000 });
    expect(db.list().map((x) => x.id)).toEqual([b.id, a.id]);
    const a2 = db.insertText('A', { now: 2000 });
    expect(a2.id).toBe(a.id);
    expect(a2.touched).toBe(true);
    expect(db.list()).toHaveLength(2);
    expect(db.list()[0]!.id).toBe(a.id);
    expect(db.list()[0]!.createdAt).toBe(2000);
  });

  it('created_at 相同时靠 seq 排到最前，证明 seq 也被刷新', () => {
    const db = mem();
    const x = db.insertText('X', { now: 1000 });
    const y = db.insertText('Y', { now: 1000 });
    expect(db.list().map((i) => i.id)).toEqual([y.id, x.id]);
    db.insertText('X', { now: 1000 });
    expect(db.list().map((i) => i.id)).toEqual([x.id, y.id]);
  });
});

describe('touch', () => {
  it('同时刷新 created_at 与 seq，其他记录不变', () => {
    const db = mem();
    const a = db.insertText('A', { now: 1000 });
    const b = db.insertText('B', { now: 1000 });
    expect(db.list().map((x) => x.id)).toEqual([b.id, a.id]);
    db.touch(a.id);
    expect(db.list().map((x) => x.id)).toEqual([a.id, b.id]);
    expect(db.list()[1]!.createdAt).toBe(1000);
  });
});

describe('截断', () => {
  it('单条文本上限 100000 字符，超出截断并置 truncated', () => {
    const db = mem();
    const r = db.insertText('x'.repeat(100001), { now: 1 });
    const row = db.getRow(r.id)!;
    expect(row.content!.length).toBe(100000);
    expect(row.truncated).toBe(1);
    expect(db.list()[0]!.truncated).toBe(true);
  });
});

describe('分页、图片搜索与 text-group', () => {
  it('分页不重叠，q 能命中图片与文本，text-group 只含三类', () => {
    const db = mem();
    const hello = db.insertText('hello alpha', { now: 1000 });
    db.insertText('C:\\Users\\me\\file.txt', { now: 2000 });
    db.insertText('42', { now: 3000 });
    db.insertText('https://example.com', { now: 4000 });
    db.insertText('function foo() { return 1; }', { now: 5000 });
    const img1 = db.insertImage(
      { imagePath: 'images/i1.jpg', thumbPath: 'thumbs/i1.png', width: 1920, height: 1080, bytes: 187392, hash: 'hash-i1' },
      { now: 6000 },
    );
    db.insertImage(
      { imagePath: 'images/i2.jpg', thumbPath: 'thumbs/i2.png', width: 800, height: 600, bytes: 51200, hash: 'hash-i2' },
      { now: 7000 },
    );

    const p0 = db.list({ limit: 3, offset: 0 }).map((x) => x.id);
    const p1 = db.list({ limit: 3, offset: 3 }).map((x) => x.id);
    expect(p0).toHaveLength(3);
    expect(p1).toHaveLength(3);
    expect(p0.filter((id) => p1.includes(id))).toEqual([]);

    const imgHit = db.list({ q: '1920' });
    expect(imgHit).toHaveLength(1);
    expect(imgHit[0]!.id).toBe(img1.id);
    expect(imgHit[0]!.preview).toBe('图片 1920×1080 · 183 KB');
    expect(imgHit[0]!.thumbUrl).toBe('thumbs/i1.png');

    const alphaHit = db.list({ q: 'alpha' });
    expect(alphaHit).toHaveLength(1);
    expect(alphaHit[0]!.id).toBe(hello.id);

    const grouped = db.list({ kind: 'text-group' });
    expect(grouped.every((x) => x.kind === 'text' || x.kind === 'path' || x.kind === 'number')).toBe(true);
    expect(grouped.map((x) => x.kind).sort()).toEqual(['number', 'path', 'text']);

    expect(db.list({ kind: 'link' })).toHaveLength(1);
  });
});

describe('settings 持久化', () => {
  it('默认值来自 DEFAULT_SETTINGS，setSettings 合并并返回完整对象', () => {
    const db = mem();
    expect(db.getSettings()).toEqual(DEFAULT_SETTINGS);
    const s = db.setSettings({ theme: 'dark', historyLimit: 300 });
    expect(s.theme).toBe('dark');
    expect(s.historyLimit).toBe(300);
    expect(s.imageBudgetMB).toBe(DEFAULT_SETTINGS.imageBudgetMB);
    expect(s.hotkeyActivate).toBe(DEFAULT_SETTINGS.hotkeyActivate);
    expect(db.getSettings().theme).toBe('dark');
  });

  it('跨重开保持（存在 clipchan.db 里，不是 settings.json）', () => {
    const dir = tmpDir();
    const file = join(dir, 'clipchan.db');
    const db1 = openDb(file);
    db1.setSettings({ theme: 'light', autoPaste: false });
    db1.close();
    const db2 = openDb(file);
    opened.push(db2);
    const s = db2.getSettings();
    expect(s.theme).toBe('light');
    expect(s.autoPaste).toBe(false);
    expect(s.historyLimit).toBe(DEFAULT_SETTINGS.historyLimit);
  });
});

describe('historyLimit 淘汰', () => {
  it('非收藏按 historyLimit 淘汰，收藏不计入上限', () => {
    const db = mem();
    db.setSettings({ historyLimit: 3 });
    for (let i = 1; i <= 5; i++) db.insertText('t' + i, { now: i * 1000 });
    expect(db.list().map((x) => x.preview)).toEqual(['t5', 't4', 't3']);

    db.clearAll();
    db.setSettings({ historyLimit: 2 });
    db.insertText('p1', { now: 1000, pinned: true });
    db.insertText('u1', { now: 2000 });
    db.insertText('u2', { now: 3000 });
    db.insertText('u3', { now: 4000 });
    expect(db.list().map((x) => x.preview).sort()).toEqual(['p1', 'u2', 'u3']);
  });
});

describe('remove / removeMany / togglePin / clearUnpinned', () => {
  it('删除与收藏切换返回被删记录的图片路径', () => {
    const db = mem();
    const a = db.insertText('A', { now: 1000 });
    db.insertText('B', { now: 2000 });
    db.togglePin(a.id);
    expect(db.list()[0]!.pinned).toBe(true);
    const removedA = db.remove(a.id);
    expect(removedA!.id).toBe(a.id);
    expect(db.getRow(a.id)).toBeNull();
    db.insertText('C', { now: 3000 });
    const removed = db.clearUnpinned();
    expect(removed).toHaveLength(2);
    expect(db.list()).toHaveLength(0);
  });
});

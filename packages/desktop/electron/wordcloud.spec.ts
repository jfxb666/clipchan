import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db';
import type { Db } from './db';
import { collectTodayTexts, startOfLocalDay, wordCloudToday } from './wordcloud';

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

const NOON = new Date(2026, 9, 16, 12, 0, 0).getTime();

function addImage(db: Db, hash: string, at: number): string {
  return db.insertImage(
    { hash, width: 10, height: 10, bytes: 100, imagePath: 'images/' + hash + '.png', thumbPath: 'thumbs/' + hash + '.png' },
    { createdAt: at },
  ).id;
}

describe('startOfLocalDay', () => {
  it('取本地日历日零点（不是最近 24 小时）', () => {
    const d = new Date(startOfLocalDay(NOON));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getDate()).toBe(16);
    expect(d.getMonth()).toBe(9);
  });
});

describe('collectTodayTexts', () => {
  it('只收当天的文本，图片与昨天的不算', () => {
    const db = mem();
    const dayStart = startOfLocalDay(NOON);
    db.insertText('今天早上复制的中文内容', { now: dayStart + 1000 });
    db.insertText('昨天复制的内容', { now: dayStart - 60 * 60 * 1000 });
    addImage(db, 'today-image-hash', dayStart + 2000);
    const texts = collectTodayTexts(db, NOON);
    expect(texts).toEqual(['今天早上复制的中文内容']);
  });

  it('收藏与 merge 记录都算', () => {
    const db = mem();
    const dayStart = startOfLocalDay(NOON);
    db.insertText('收藏的文本内容', { now: dayStart + 1000, pinned: true });
    db.insertText('拼接出来的文本内容', { now: dayStart + 2000, source: 'merge' });
    const texts = collectTodayTexts(db, NOON);
    expect(texts).toHaveLength(2);
  });

  it('零点的记录算今天（闭区间）', () => {
    const db = mem();
    const dayStart = startOfLocalDay(NOON);
    db.insertText('刚过零点的内容', { now: dayStart });
    expect(collectTodayTexts(db, NOON)).toHaveLength(1);
  });
});

describe('wordCloudToday', () => {
  it('返回词表与参与统计的条数', () => {
    const db = mem();
    const dayStart = startOfLocalDay(NOON);
    db.insertText('剪贴板很好用，剪贴板很方便，剪贴板很快', { now: dayStart + 1000 });
    db.insertText('剪贴板很好用，剪贴板很方便', { now: dayStart + 2000 });
    const data = wordCloudToday(db, NOON);
    expect(data.totalItems).toBe(2);
    expect(data.words.length).toBeGreaterThan(0);
    expect(data.words.map((w) => w.word)).toContain('剪贴板');
  });

  it('今天没有记录时返回空词表而不是抛', () => {
    const db = mem();
    const data = wordCloudToday(db, NOON);
    expect(data).toEqual({ words: [], totalItems: 0 });
  });
});

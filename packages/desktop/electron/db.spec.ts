import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@clipchan/core';
import { SCHEMA_VERSION, openDb } from './db';
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

/** v0.2.0 形态的库：没有 deleted_at/source_app，索引谓词里也没有回收站条件。 */
function seedLegacyDb(file: string): void {
  const old = new Database(file);
  old.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT, content_hash TEXT,
      image_path TEXT, image_hash TEXT, thumb_path TEXT,
      width INTEGER, height INTEGER, bytes INTEGER,
      source TEXT NOT NULL DEFAULT 'clip', pinned INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, seq INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_content_hash ON items(content_hash) WHERE content_hash IS NOT NULL;
    CREATE UNIQUE INDEX idx_image_hash   ON items(image_hash)   WHERE image_hash   IS NOT NULL;
    CREATE INDEX idx_order ON items(pinned DESC, created_at DESC, seq DESC);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  old.prepare(
    'INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('a'.repeat(32), 'text', '老数据', 'hash-old', 'clip', 1, 0, 1000, 1);
  old.prepare(
    'INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('b'.repeat(32), 'text', '老数据2', 'hash-old-2', 'clip', 0, 0, 2000, 2);
  // v0.2.0 从没写过 user_version，默认 0
  old.pragma('user_version = 0');
  old.close();
}

describe('老库迁移（v0.2.0 → v0.3.0）', () => {
  it('user_version=0 的旧库：数据不丢、补列、索引谓词更新、版本升到 1', () => {
    const file = join(tmpDir(), 'clipchan.db');
    seedLegacyDb(file);

    const db = openDb(file);
    try {
      // ① 数据不丢（顺序与内容都在）
      expect(db.count()).toBe(2);
      // a 是收藏项，排最前（排序键没被迁移动过）
      expect(db.list().map((x) => x.id)).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
      expect(db.getText('a'.repeat(32))).toBe('老数据');
      // ② 补列（老行都是 NULL，不是 0/空串）
      expect(db.getRow('a'.repeat(32))!.deleted_at).toBeNull();
      expect(db.getRow('a'.repeat(32))!.source_app).toBeNull();
      // ③ 索引谓词已重建
      const idxSql = db.raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_content_hash') as { sql: string };
      expect(idxSql.sql).toContain('deleted_at IS NULL');
      // ④ 版本升到 1
      expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      // Windows 上没关句柄时 rmSync 会 EPERM
      db.close();
    }
  });

  it('重复打开不报错（迁移幂等）', () => {
    const file = join(tmpDir(), 'clipchan.db');
    seedLegacyDb(file);
    const first = openDb(file);
    first.insertText('迁移后新增', { now: 3000 });
    first.close();

    expect(() => {
      const second = openDb(file);
      try {
        expect(second.count()).toBe(3);
        expect(second.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
        // 迁移过的库软删照常可用
        const r = second.insertText('再来一条', { now: 4000 });
        second.remove(r.id);
        expect(second.countTrash()).toBe(1);
      } finally {
        second.close();
      }
    }).not.toThrow();
  });

  it('索引被外部删掉时重开自动补建（版本已是 1 也补）', () => {
    const file = join(tmpDir(), 'clipchan.db');
    const first = openDb(file);
    first.insertText('甲', { now: 1000 });
    // 模拟手工修库 / 备份恢复后丢了索引
    first.raw.exec('DROP INDEX idx_content_hash');
    first.raw.exec('DROP INDEX idx_image_hash');
    first.close();

    const second = openDb(file);
    try {
      const names = (second.raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(names).toContain('idx_content_hash');
      expect(names).toContain('idx_image_hash');
      // 补建的索引谓词是对的：同内容软删后能重新入库
      const r = second.insertText('乙', { now: 2000 });
      second.remove(r.id);
      expect(() => second.insertText('乙', { now: 3000 })).not.toThrow();
    } finally {
      second.close();
    }
  });

  it('全新库也是 user_version=1，且老谓词从未存在过', () => {
    const db = mem();
    expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const idxSql = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_image_hash') as { sql: string };
    expect(idxSql.sql).toContain('deleted_at IS NULL');
  });
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

describe('count：状态栏「共 N 条」用真实总数', () => {
  /** 造一批混合记录：文本/图片/链接/收藏。 */
  function seed(db: Db) {
    db.insertText('hello alpha', { now: 1000 });
    db.insertText('https://example.com', { now: 2000 });
    db.insertText('C:\\Users\\me\\file.txt', { now: 3000 });
    const pinned = db.insertText('收藏的 alpha', { now: 4000, pinned: true });
    db.insertImage(
      { imagePath: 'images/i1.jpg', thumbPath: 'thumbs/i1.png', width: 1920, height: 1080, bytes: 1024, hash: 'h1' },
      { now: 5000 },
    );
    return pinned;
  }

  it('不带条件时等于总条数，且不受 limit/offset 影响', () => {
    const db = mem();
    seed(db);

    expect(db.count()).toBe(5);
    expect(db.list({ limit: 2, offset: 0 })).toHaveLength(2);
    // ★ 关键：分页只影响 list，不能影响总数（否则「共 N 条」会跟着翻页变）。
    expect(db.count({ limit: 2, offset: 0 })).toBe(5);
  });

  it('★ 与 list 同一套条件：分类 / 搜索词 / 收藏都一样', () => {
    const db = mem();
    seed(db);

    const cases = [
      {},
      { kind: 'image' as const },
      { kind: 'text-group' as const },
      { kind: 'link' as const },
      { kind: 'favorite' as const },
      { q: 'alpha' },
      { q: '1920' },
      { kind: 'text' as const, q: 'alpha' },
      { q: '不存在的词' },
    ];
    for (const q of cases) {
      expect(db.count(q)).toBe(db.list(q).length);
    }
  });

  it('搜索词为空串时等同不带 q（界面清空搜索框的情况）', () => {
    const db = mem();
    seed(db);

    expect(db.count({ q: '' })).toBe(5);
    expect(db.count({ q: '   ' })).toBe(5);
  });

  it('收藏分类只数收藏项', () => {
    const db = mem();
    const pinned = seed(db);

    expect(db.count({ kind: 'favorite' })).toBe(1);
    expect(db.list({ kind: 'favorite' })[0]!.id).toBe(pinned.id);
  });

  it('空库返回 0（不是 undefined）', () => {
    const db = mem();

    expect(db.count()).toBe(0);
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

describe('KV 访问器（绕过 sanitizeSettings 白名单）', () => {
  it('setSettingValue 写的结构化值能深相等读回（aiProviders 这类非 Settings 键）', () => {
    const db = mem();
    const providers = [
      { id: 'p1', name: '本地 Ollama', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5' },
      { id: 'p2', name: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
    ];
    db.setSettingValue('aiProviders', providers);
    expect(db.getSettingValue('aiProviders')).toEqual(providers);
  });

  it('Key 独立成键，且不渗进 getSettings() 的载荷', () => {
    const db = mem();
    db.setSettings({ theme: 'dark' });
    db.setSettingValue('aiKey:p1', 'sk-abc');
    db.setSettingValue('aiProviders', [{ id: 'p1', name: 'A', protocol: 'openai-compat', baseUrl: 'http://a/v1', model: 'm' }]);

    expect(db.getSettingValue('aiKey:p1')).toBe('sk-abc');

    // ★ Review Focus 6/7：Key 与 provider 元数据都不许出现在 settings:get 的返回里。
    const s: Record<string, unknown> = { ...db.getSettings() };
    expect(Object.prototype.hasOwnProperty.call(s, 'aiKey:p1')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(s, 'aiProviders')).toBe(false);
    expect(JSON.stringify(s)).not.toContain('sk-abc');
    expect(s.theme).toBe('dark');
  });

  it('读不存在的键返回 undefined，不抛', () => {
    const db = mem();
    expect(db.getSettingValue('nope')).toBeUndefined();
    expect(db.getSettingValue('aiKey:missing')).toBeUndefined();
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
    // 软删：行还在库里，只是离开了活跃列表（getRow 是 raw 层读取，仍能取到）。
    expect(db.list().some((x) => x.id === a.id)).toBe(false);
    expect(db.getRow(a.id)!.deleted_at).toBeTypeOf('number');
    db.insertText('C', { now: 3000 });
    const removed = db.clearUnpinned();
    expect(removed).toHaveLength(2);
    expect(db.list()).toHaveLength(0);
    // 清空的 3 条都在回收站里（a 已删，B/C 这次进）
    expect(db.countTrash()).toBe(3);
  });
});

describe('getText 读全文（Task 7）', () => {
  it('文本行取回全文（含换行，不截断）', () => {
    const db = mem();
    const long = '第一行\n第二行\n' + 'x'.repeat(200);
    const r = db.insertText(long, { now: 1000 });
    expect(db.getText(r.id)).toBe(long);
  });

  it('图片行返回空串（图片 content 为 NULL）', () => {
    const db = mem();
    const img = db.insertImage(
      { imagePath: 'images/i1.jpg', thumbPath: 'thumbs/i1.png', width: 10, height: 20, bytes: 99, hash: 'h-i1' },
      { now: 1000 },
    );
    expect(db.getText(img.id)).toBe('');
  });

  it('不存在的 id 返回空串', () => {
    const db = mem();
    expect(db.getText('f'.repeat(32))).toBe('');
  });
});

describe('软删与回收站（v0.3.0）', () => {
  it('remove 是软删：行留在库里、list/count 都排除、countTrash 计入', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    db.insertText('乙', { now: 2000 });
    expect(db.list()).toHaveLength(2);
    expect(db.count()).toBe(2);

    db.remove(a.id);
    // ★ list 与 count 必须一致排除——两者都走 buildWhere，改一处即两处生效。
    expect(db.list().map((x) => x.id)).not.toContain(a.id);
    expect(db.list()).toHaveLength(1);
    expect(db.count()).toBe(1);
    // 行没被 DELETE，只是盖了时间戳
    expect(db.getRow(a.id)!.deleted_at).toBeTypeOf('number');
    expect(db.countTrash()).toBe(1);
  });

  it('复制 → 软删 → 同内容再复制：进列表且不撞 UNIQUE', () => {
    const db = mem();
    const first = db.insertText('同样的内容', { now: 1000 });
    db.remove(first.id);
    // 索引谓词与去重 SELECT 若有一处漏了 deleted_at IS NULL，这里会抛 UNIQUE 或静默不出现。
    expect(() => db.insertText('同样的内容', { now: 2000 })).not.toThrow();
    const list = db.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).not.toBe(first.id);
    expect(db.countTrash()).toBe(1);
  });

  it('图片同哈希也能"软删后重新入库"', () => {
    const db = mem();
    const meta = { imagePath: 'images/x.jpg', thumbPath: 'thumbs/x.png', width: 10, height: 10, bytes: 5, hash: 'h-dup' };
    const first = db.insertImage(meta, { now: 1000 });
    db.remove(first.id);
    expect(() => db.insertImage(meta, { now: 2000 })).not.toThrow();
    expect(db.list()).toHaveLength(1);
    expect(db.countTrash()).toBe(1);
  });

  it('restore 后 created_at 与 seq 保持原值（回到原来的位置）', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    const b = db.insertText('乙', { now: 2000 });
    const c = db.insertText('丙', { now: 3000 });
    const beforeA = db.getRow(a.id)!;

    db.remove(a.id);
    expect(db.restore(a.id)).toBe(true);

    const afterA = db.getRow(a.id)!;
    expect(afterA.created_at).toBe(beforeA.created_at);
    expect(afterA.seq).toBe(beforeA.seq);
    expect(afterA.deleted_at).toBeNull();
    // 位置不变：丙 > 乙 > 甲（created_at DESC）
    expect(db.list().map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    // 重复 restore 是无操作
    expect(db.restore(a.id)).toBe(false);
  });

  it('restoreMany 只影响回收站行，返回条数', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    const b = db.insertText('乙', { now: 2000 });
    const c = db.insertText('丙', { now: 3000 });
    db.removeMany([a.id, b.id]);
    expect(db.countTrash()).toBe(2);
    expect(db.restoreMany([a.id, b.id, c.id, 'nope'])).toBe(2);
    expect(db.countTrash()).toBe(0);
    expect(db.list()).toHaveLength(3);
  });

  it('恢复撞上"同内容已重新入库"时跳过而不是抛 UNIQUE', () => {
    const db = mem();
    const old = db.insertText('重复内容', { now: 1000 });
    db.remove(old.id);
    const fresh = db.insertText('重复内容', { now: 2000 });
    // 此时活跃行已占住 content_hash，恢复旧行会撞唯一索引
    expect(() => db.restore(old.id)).not.toThrow();
    expect(db.restore(old.id)).toBe(false);
    expect(db.restoreMany([old.id])).toBe(0);
    // 新行没被顶掉，旧行仍在回收站
    expect(db.list().map((x) => x.id)).toEqual([fresh.id]);
    expect(db.countTrash()).toBe(1);
  });

  it('listTrash 按删除时间倒序、分页生效、不复用 buildWhere', () => {
    const db = mem();
    const ids = ['甲', '乙', '丙'].map((t, i) => db.insertText(t, { now: 1000 + i * 1000 }).id);
    // 逐个删，删除时间递增 → 回收站里丙最前
    for (const id of ids) db.remove(id);
    const trash = db.listTrash();
    expect(trash).toHaveLength(3);
    expect(trash[0]!.id).toBe(ids[2]);
    expect(trash[0]!.deletedAt).toBeTypeOf('number');
    expect(db.listTrash({ limit: 1, offset: 1 })).toHaveLength(1);
    // 活跃列表里一条都没有
    expect(db.list()).toHaveLength(0);
  });

  it('purge 硬删回收站行（DELETE FROM items）', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    db.remove(a.id);
    expect(db.purge([a.id])).toBe(1);
    expect(db.getRow(a.id)).toBeNull();
    expect(db.countTrash()).toBe(0);
  });

  it('trashLimit 超出后 purgeTrashOverLimit 删最旧', () => {
    const db = mem();
    db.setSettings({ trashLimit: 2 });
    const ids = ['甲', '乙', '丙'].map((t, i) => db.insertText(t, { now: 1000 + i * 1000 }).id);
    for (const id of ids) db.remove(id);
    // 每次 remove 后都会自动收敛，所以这里已经只剩 2 条
    expect(db.countTrash()).toBe(2);
    const left = db.listTrash().map((x) => x.id);
    expect(left).toEqual([ids[2], ids[1]]);
    // 最旧的甲被硬删
    expect(db.getRow(ids[0]!)).toBeNull();
  });

  it('purgeTrashOverLimit 返回被删 id，供调用方删盘', () => {
    const db = mem();
    const ids = ['甲', '乙', '丙'].map((t, i) => db.insertText(t, { now: 1000 + i * 1000 }).id);
    // 绕过 remove 直接盖戳：remove 会顺带收敛，观察不到返回值。
    db.raw.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').run(1000, ids[0]);
    db.raw.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').run(2000, ids[1]);
    db.raw.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').run(3000, ids[2]);
    expect(db.countTrash()).toBe(3);

    db.setSettings({ trashLimit: 2 });
    // 默认上限 200 不触发；显式调用才收敛，返回的正是最旧的那条
    expect(db.purgeTrashOverLimit()).toEqual([ids[0]]);
    expect(db.countTrash()).toBe(2);
    expect(db.getRow(ids[0]!)).toBeNull();
  });

  it('evictOverLimit 现在是软删：超 historyLimit 的行进回收站而不是消失', () => {
    const db = mem();
    db.setSettings({ historyLimit: 3 });
    const ids = ['1', '2', '3', '4', '5'].map((t, i) => db.insertText(t, { now: 1000 + i * 1000 }).id);
    expect(db.list()).toHaveLength(3);
    // 被淘汰的两条还在库里（回收站），不是 DELETE FROM items
    expect(db.getRow(ids[0]!)).not.toBeNull();
    expect(db.getRow(ids[1]!)).not.toBeNull();
    expect(db.getRow(ids[0]!)!.deleted_at).toBeTypeOf('number');
    expect(db.countTrash()).toBe(2);
  });

  it('clearAll 只清活跃行，不动已在回收站里的删除时间', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    db.insertText('乙', { now: 2000 });
    db.remove(a.id);
    const stamp = db.getRow(a.id)!.deleted_at;
    expect(db.clearAll()).toBe(1);
    expect(db.countTrash()).toBe(2);
    // 甲的时间戳没被"清空列表"这次操作改写
    expect(db.getRow(a.id)!.deleted_at).toBe(stamp);
  });

  it('rowToDto 投影 sourceApp / deletedAt；未知来源是 undefined 不是兜底串', () => {
    const db = mem();
    const withApp = db.insertText('甲', { now: 1000, sourceApp: 'Code.exe' });
    const noApp = db.insertText('乙', { now: 2000 });
    const list = db.list();
    const a = list.find((x) => x.id === withApp.id)!;
    const b = list.find((x) => x.id === noApp.id)!;
    expect(a.sourceApp).toBe('Code.exe');
    expect(a.deletedAt).toBeUndefined();
    // ★ 绝不写 "__unknown__" 这种兜底串
    expect(b.sourceApp).toBeUndefined();
    expect(db.getRow(noApp.id)!.source_app).toBeNull();

    db.remove(withApp.id);
    const trashed = db.listTrash()[0]!;
    expect(trashed.deletedAt).toBeTypeOf('number');
    expect(trashed.sourceApp).toBe('Code.exe');
  });

  it('sourceApp 传空串/空白落 NULL，不落空串', () => {
    const db = mem();
    const r = db.insertText('甲', { now: 1000, sourceApp: '   ' });
    expect(db.getRow(r.id)!.source_app).toBeNull();
    expect(db.list()[0]!.sourceApp).toBeUndefined();
  });

  it('trashLimit 走 sanitizeSettings 白名单（clamp 1–9999）', () => {
    const db = mem();
    expect(db.getSettings().trashLimit).toBe(DEFAULT_SETTINGS.trashLimit);
    expect(db.setSettings({ trashLimit: 0 }).trashLimit).toBe(1);
    expect(db.setSettings({ trashLimit: 99999 }).trashLimit).toBe(9999);
    expect(db.setSettings({ trashLimit: 7 }).trashLimit).toBe(7);
  });
});

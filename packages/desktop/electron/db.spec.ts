import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSearch } from '@clipchan/core';
import {
  SCHEMA_VERSION,
  SIMILAR_HAMMING_THRESHOLD,
  SNIPPET_LIMIT,
  buildSearchIndex,
  hammingDistance,
  openDb,
} from './db';
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

  it('listLayout 走 sanitizeSettings 白名单（非法值回落 list）', () => {
    const db = mem();
    expect(db.getSettings().listLayout).toBe('list');
    expect(db.setSettings({ listLayout: 'timeline' }).listLayout).toBe('timeline');
    expect(db.setSettings({ listLayout: 'masonry' }).listLayout).toBe('masonry');
    expect(db.setSettings({ listLayout: 'source' }).listLayout).toBe('source');
    expect(db.setSettings({ listLayout: 'bogus' as never }).listLayout).toBe('list');
  });

  it('图片 DTO 带原始 width/height（瀑布流算列高用）', () => {
    const db = mem();
    db.insertImage(
      { imagePath: 'images/a.jpg', thumbPath: 'thumbs/a.png', width: 800, height: 600, bytes: 1000, hash: 'hash-a' },
      { now: 1000 },
    );
    const dto = db.list()[0]!;
    expect(dto.width).toBe(800);
    expect(dto.height).toBe(600);
  });

  it('非图片 DTO 不带 width/height（有才给的写法）', () => {
    const db = mem();
    db.insertText('甲', { now: 1000 });
    const dto = db.list()[0]!;
    expect(dto.width).toBeUndefined();
    expect(dto.height).toBeUndefined();
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

describe('v0.5.0 T1：hotkeyCapture + optimize_history', () => {
  it('hotkeyCapture 走 sanitizeSettings 白名单：默认值 / 空串回落 / 生效', () => {
    // 默认值必须在 DEFAULT_SETTINGS 里，否则下面两行断言的就是同一个"错值"
    expect(DEFAULT_SETTINGS.hotkeyCapture).toBe('Control+Alt+S');
    const db = mem();
    // 与 db.spec.ts 的 toEqual(DEFAULT_SETTINGS) 是同一条保证：白名单漏一个键这里就红
    expect(db.getSettings().hotkeyCapture).toBe('Control+Alt+S');
    expect(db.setSettings({ hotkeyCapture: '' }).hotkeyCapture).toBe('Control+Alt+S');
    expect(db.setSettings({ hotkeyCapture: 'Alt+Shift+X' }).hotkeyCapture).toBe('Alt+Shift+X');
    // 非字符串（旧库被手改成数字）也回落默认值，不是变成 '123'
    expect(db.setSettings({ hotkeyCapture: 123 as unknown as string }).hotkeyCapture).toBe('Control+Alt+S');
  });

  it('addOptimizeHistory 写入后能读回，字段逐一对齐且 id 是字符串', () => {
    const db = mem();
    const created = db.addOptimizeHistory({
      source: '原文一段',
      output: '优化后一段',
      sceneId: 'polish',
      mode: 'user',
      providerId: 'p1',
      providerName: '我的 DeepSeek',
      createdAt: 1000,
    });
    expect(typeof created.id).toBe('string');
    expect(created.id.length).toBeGreaterThan(0);

    const list = db.listOptimizeHistory();
    expect(list).toHaveLength(1);
    // id 出库必须是 string：库里是 INTEGER AUTOINCREMENT，直接透传会变 number
    expect(list[0]).toEqual(created);
    expect(list[0]!.source).toBe('原文一段');
    expect(list[0]!.output).toBe('优化后一段');
    expect(list[0]!.sceneId).toBe('polish');
    expect(list[0]!.mode).toBe('user');
    expect(list[0]!.providerId).toBe('p1');
    expect(list[0]!.providerName).toBe('我的 DeepSeek');
    expect(list[0]!.createdAt).toBe(1000);
  });

  it('listOptimizeHistory 按 createdAt 倒序（最新的在最前）', () => {
    const db = mem();
    const at = (ts: number) => db.addOptimizeHistory({
      source: 's' + ts, output: 'o' + ts, sceneId: 'sc', mode: 'system',
      providerId: 'p', providerName: 'P', createdAt: ts,
    });
    at(3000); at(1000); at(2000);
    expect(db.listOptimizeHistory().map((e) => e.createdAt)).toEqual([3000, 2000, 1000]);
  });

  it('历史上限 100 条：写 105 条只剩最新的 100 条（最旧 5 条被硬删）', () => {
    const db = mem();
    const idAt = (ts: number) => db.addOptimizeHistory({
      source: 's' + ts, output: 'o' + ts, sceneId: 'sc', mode: 'user',
      providerId: 'p', providerName: 'P', createdAt: ts,
    }).id;
    const firstIds: string[] = [];
    for (let i = 0; i < 105; i += 1) {
      const id = idAt(1000 + i);
      if (i < 5) firstIds.push(id);
    }

    const list = db.listOptimizeHistory();
    expect(list).toHaveLength(100);
    // 留下的是最新的 100 条：最旧那 5 条（1000–1004）必须消失
    expect(list[0]!.createdAt).toBe(1104);
    expect(list[99]!.createdAt).toBe(1005);
    for (const id of firstIds) {
      expect(db.listOptimizeHistory().some((e) => e.id === id), '最旧的那条没被淘汰: ' + id).toBe(false);
    }
    // 是硬删而不是软删：表里真的只剩 100 行
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM optimize_history').get() as { n: number };
    expect(rows.n).toBe(100);
  });

  it('listOptimizeHistory(limit) 只取前 N 条', () => {
    const db = mem();
    for (let i = 0; i < 5; i += 1) {
      db.addOptimizeHistory({
        source: 's' + i, output: 'o' + i, sceneId: 'sc', mode: 'user',
        providerId: 'p', providerName: 'P', createdAt: 1000 + i,
      });
    }
    expect(db.listOptimizeHistory(2).map((e) => e.createdAt)).toEqual([1004, 1003]);
  });

  it('removeOptimizeHistory 删掉返回 true；删不存在的返回 false', () => {
    const db = mem();
    const a = db.addOptimizeHistory({
      source: 's', output: 'o', sceneId: 'sc', mode: 'user',
      providerId: 'p', providerName: 'P', createdAt: 1000,
    });
    expect(db.removeOptimizeHistory(a.id)).toBe(true);
    expect(db.listOptimizeHistory()).toHaveLength(0);
    // 同一个 id 再删一次就是"不存在"
    expect(db.removeOptimizeHistory(a.id)).toBe(false);
    expect(db.removeOptimizeHistory('999999')).toBe(false);
  });

  it('clearOptimizeHistory 返回删除条数，之后列表为空', () => {
    const db = mem();
    for (let i = 0; i < 3; i += 1) {
      db.addOptimizeHistory({
        source: 's' + i, output: 'o' + i, sceneId: 'sc', mode: 'user',
        providerId: 'p', providerName: 'P', createdAt: 1000 + i,
      });
    }
    expect(db.clearOptimizeHistory()).toBe(3);
    expect(db.listOptimizeHistory()).toEqual([]);
    // 空表再清一次是 0，不是抛
    expect(db.clearOptimizeHistory()).toBe(0);
  });

  it('老库升级：user_version 1 → 2 后 optimize_history 表存在', () => {
    const dir = tmpDir();
    const file = join(dir, 'clipchan.db');
    // v0.4.0 形态的库：有 items / settings、user_version = 1，但没有 optimize_history
    const old = new Database(file);
    old.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT, content_hash TEXT,
        image_path TEXT, image_hash TEXT, thumb_path TEXT,
        width INTEGER, height INTEGER, bytes INTEGER,
        source TEXT NOT NULL DEFAULT 'clip', pinned INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, seq INTEGER NOT NULL,
        deleted_at INTEGER, source_app TEXT
      );
      CREATE INDEX idx_order ON items(pinned DESC, created_at DESC, seq DESC);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    old.prepare('INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('c'.repeat(32), 'text', '老库数据', 'hash-v1', 'clip', 0, 0, 1000, 1);
    old.pragma('user_version = 1');
    old.close();

    // ★ 断言写成"升到当前版本"而不是写死 2：每加一版 schema 都改这里毫无意义。
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    const db = openDb(file);
    opened.push(db);

    const table = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='optimize_history'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('optimize_history');
    const index = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_opt_hist'")
      .get() as { name: string } | undefined;
    expect(index?.name).toBe('idx_opt_hist');
    expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    // 升级不该动老数据
    expect(db.list()).toHaveLength(1);
    // 表真的可用
    expect(db.addOptimizeHistory({
      source: 's', output: 'o', sceneId: 'sc', mode: 'user',
      providerId: 'p', providerName: 'P', createdAt: 2000,
    }).id).toBeTypeOf('string');
  });

  it('全新库也直接拿到 optimize_history 表（SCHEMA_SQL 幂等建表）', () => {
    const db = mem();
    const table = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='optimize_history'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('optimize_history');
  });
});

// ---------------- v0.6.0：schema v3 / 拼音搜索 / 文件记录 / 富文本 / 片段库 ----------------

/** v0.5.0 形态的库：items 有 deleted_at/source_app，但还没有 file_paths/rich_html/search_index。 */
function seedV2Db(file: string): void {
  const old = new Database(file);
  old.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT, content_hash TEXT,
      image_path TEXT, image_hash TEXT, thumb_path TEXT,
      width INTEGER, height INTEGER, bytes INTEGER,
      source TEXT NOT NULL DEFAULT 'clip', pinned INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, seq INTEGER NOT NULL,
      deleted_at INTEGER, source_app TEXT
    );
    CREATE UNIQUE INDEX idx_content_hash ON items(content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX idx_image_hash   ON items(image_hash)   WHERE image_hash   IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX idx_order ON items(pinned DESC, created_at DESC, seq DESC);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE optimize_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, output TEXT NOT NULL,
      scene_id TEXT NOT NULL, mode TEXT NOT NULL, provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_opt_hist ON optimize_history(created_at DESC, id DESC);
  `);
  old.prepare(
    'INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('d'.repeat(32), 'text', '手工验收已完成', 'hash-v2', 'clip', 0, 0, 1000, 1);
  old.pragma('user_version = 2');
  old.close();
}

describe('v0.6.0：schema v3 迁移', () => {
  it('v2 老库升级：三列补齐、老行 search_index 回填出拼音、snippets 表建好', () => {
    const file = join(tmpDir(), 'clipchan.db');
    seedV2Db(file);

    const db = openDb(file);
    opened.push(db);

    const cols = new Set(
      (db.raw.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
    );
    expect(cols.has('file_paths')).toBe(true);
    expect(cols.has('rich_html')).toBe(true);
    expect(cols.has('search_index')).toBe(true);

    const row = db.getRow('d'.repeat(32))!;
    expect(row.search_index).toBeTruthy();
    // 全拼与首字母都要在（小写）
    expect(row.search_index).toContain('yanshou');
    expect(row.search_index).toContain('ysyw');
    expect(row.file_paths).toBeNull();
    expect(row.rich_html).toBeNull();

    const snip = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snippets'")
      .get() as { name: string } | undefined;
    expect(snip?.name).toBe('snippets');
    expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    // 迁移不该动老数据
    expect(db.list()).toHaveLength(1);
  });

  it('回填过的老行直接能按两字中文词搜到（不需要重新复制一次）', () => {
    const file = join(tmpDir(), 'clipchan.db');
    seedV2Db(file);
    const db = openDb(file);
    opened.push(db);

    expect(db.list({ q: '验收' })).toHaveLength(1);
    expect(db.list({ q: 'ysyw' })).toHaveLength(1);
  });
});

describe('v0.6.0：buildSearchIndex', () => {
  it('中文带全拼与首字母，且整体小写', () => {
    const idx = buildSearchIndex('手工验收');
    expect(idx.startsWith('手工验收 ')).toBe(true);
    expect(idx).toContain('shougongyanshou');
    expect(idx).toContain('sgys');
    expect(idx).toBe(idx.toLowerCase());
  });

  it('英文小写化（原文里的 Hello 也变成 hello）', () => {
    expect(buildSearchIndex('Hello World')).toContain('hello world');
  });

  it('空串 / 非字符串回空串', () => {
    expect(buildSearchIndex('')).toBe('');
    expect(buildSearchIndex(undefined as unknown as string)).toBe('');
  });
});

describe('v0.6.0：中文两字词搜索（P1-4）', () => {
  it('两字中文词 / 拼音首字母都能命中，list 与 count 一致', () => {
    const db = mem();
    db.insertText('手工验收已完成', { now: 1000 });
    db.insertText('完全无关的一段', { now: 2000 });

    const hit = db.list({ q: '验收' });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.preview).toBe('手工验收已完成');

    expect(db.list({ q: 'ysyw' })).toHaveLength(1);
    expect(db.list({ q: 'shougong' })).toHaveLength(1);
    expect(db.count({ q: '验收' })).toBe(1);
    expect(db.count({ q: 'ysyw' })).toBe(1);
    // 命中不到的词是 0，不是全部
    expect(db.count({ q: 'zzz' })).toBe(0);
  });

  it('英文搜索大小写无关（search_index 是小写副本）', () => {
    const db = mem();
    db.insertText('Hello Alpha', { now: 1000 });
    expect(db.list({ q: 'ALPHA' })).toHaveLength(1);
    expect(db.list({ q: 'alpha' })).toHaveLength(1);
  });
});

describe('v0.6.0：文件记录（P0-1）', () => {
  const paths = ['C:\Users\me\a.txt', 'C:\Users\me\b.txt'];

  it('kind=files、fileCount 正确、getFilePaths 往返一致', () => {
    const db = mem();
    const r = db.insertFiles(paths, { now: 1000 });
    expect(r.touched).toBe(false);
    expect(r.id).toMatch(/^[0-9a-f]{32}$/);

    const dto = db.list()[0]!;
    expect(dto.kind).toBe('files');
    expect(dto.fileCount).toBe(2);
    expect(dto.preview).toContain('a.txt');
    expect(db.getFilePaths(r.id)).toEqual(paths);
  });

  it('同一路径列表插两次：touched=true、库里只有 1 行、路径不被覆盖', () => {
    const db = mem();
    const first = db.insertFiles(paths, { now: 1000 });
    const again = db.insertFiles(paths, { now: 2000 });
    expect(again.id).toBe(first.id);
    expect(again.touched).toBe(true);
    expect(db.count()).toBe(1);
    expect(db.getFilePaths(first.id)).toEqual(paths);
  });

  it('路径列表不同则是两条（去重键是整段列表，不是文件名）', () => {
    const db = mem();
    db.insertFiles(paths, { now: 1000 });
    db.insertFiles(['C:\Users\me\a.txt'], { now: 2000 });
    expect(db.count()).toBe(2);
  });

  it('空数组不落库', () => {
    const db = mem();
    expect(db.insertFiles([], { now: 1000 })).toEqual({ id: '', touched: false });
    expect(db.count()).toBe(0);
  });

  it('getFilePaths 对不存在的 id / 坏 JSON 都回 []，不抛', () => {
    const db = mem();
    expect(db.getFilePaths('nope')).toEqual([]);

    const r = db.insertFiles(paths, { now: 1000 });
    db.raw.prepare('UPDATE items SET file_paths = ? WHERE id = ?').run('{不是数组', r.id);
    expect(db.getFilePaths(r.id)).toEqual([]);
    // 坏数据不该让列表崩，fileCount 按 0 显示
    expect(db.list()[0]!.fileCount).toBe(0);
  });

  it('文件记录也能按文件名搜索（search_index 覆盖 content）', () => {
    const db = mem();
    db.insertFiles(paths, { now: 1000 });
    expect(db.list({ q: 'a.txt' })).toHaveLength(1);
  });
});

describe('v0.6.0：富文本（P2-7）', () => {
  it('带 richHtml 插入后能读回，DTO 上 hasRich=true', () => {
    const db = mem();
    const r = db.insertText('加粗的一段', { now: 1000, richHtml: '<b>加粗的一段</b>' });
    expect(db.getRichHtml(r.id)).toBe('<b>加粗的一段</b>');
    expect(db.list()[0]!.hasRich).toBe(true);
  });

  it('不带 richHtml：getRichHtml 回 null，hasRich 是 undefined', () => {
    const db = mem();
    const r = db.insertText('纯文本', { now: 1000 });
    expect(db.getRichHtml(r.id)).toBeNull();
    expect(db.list()[0]!.hasRich).toBeUndefined();
  });

  it('★ 去重命中：旧空新非空会补写（否则从网页复制的同一段永远拿不到富文本）', () => {
    const db = mem();
    const a = db.insertText('同一段文字', { now: 1000 });
    expect(db.getRichHtml(a.id)).toBeNull();

    const b = db.insertText('同一段文字', { now: 2000, richHtml: '<i>同一段文字</i>' });
    expect(b.id).toBe(a.id);
    expect(b.touched).toBe(true);
    expect(db.getRichHtml(a.id)).toBe('<i>同一段文字</i>');
    expect(db.list()[0]!.hasRich).toBe(true);
  });

  it('去重命中但旧值非空：不覆盖（首次拿到的富文本更可能是用户看到的那份）', () => {
    const db = mem();
    const a = db.insertText('同一段文字', { now: 1000, richHtml: '<b>旧的</b>' });
    db.insertText('同一段文字', { now: 2000, richHtml: '<b>新的</b>' });
    expect(db.getRichHtml(a.id)).toBe('<b>旧的</b>');
  });

  it('getRichHtml 对不存在的 id 回 null', () => {
    expect(mem().getRichHtml('nope')).toBeNull();
  });
});

describe('v0.6.0：批量收藏（P2-8）', () => {
  it('批量置位只影响传入的活跃行', () => {
    const db = mem();
    const a = db.insertText('a', { now: 1000 });
    const b = db.insertText('b', { now: 2000 });
    const c = db.insertText('c', { now: 3000 });

    expect(db.pinMany([a.id, b.id], true)).toBe(2);
    expect(db.list({ kind: 'favorite' }).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(db.getRow(c.id)!.pinned).toBe(0);

    db.pinMany([a.id], false);
    expect(db.getRow(a.id)!.pinned).toBe(0);
    expect(db.getRow(b.id)!.pinned).toBe(1);
  });

  it('回收站里的行不受影响', () => {
    const db = mem();
    const a = db.insertText('a', { now: 1000 });
    const b = db.insertText('b', { now: 2000 });
    db.remove(b.id);

    expect(db.pinMany([a.id, b.id], true)).toBe(1);
    expect(db.getRow(b.id)!.pinned).toBe(0);
  });

  it('空数组回 0', () => {
    expect(mem().pinMany([], true)).toBe(0);
  });
});

describe('v0.6.0：片段库（P1-6）', () => {
  /** saveSnippet 返回的是全表（同一毫秒写入时顺序由 id 决定），按内容取回刚写的那条。 */
  function saveOne(db: Db, title: string, content: string): { id: string } {
    db.saveSnippet({ title, content });
    const row = db.raw.prepare('SELECT id FROM snippets WHERE content = ?').get(content) as { id: string };
    return row;
  }

  it('save 新增：created_at = updated_at，use_count = 0', () => {
    const db = mem();
    const list = db.saveSnippet({ title: '签名', content: '此致敬礼' });
    expect(list).toHaveLength(1);
    const s = list[0]!;
    expect(s.id.length).toBeGreaterThan(0);
    expect(s.title).toBe('签名');
    expect(s.content).toBe('此致敬礼');
    expect(s.createdAt).toBe(s.updatedAt);
    expect(s.useCount).toBe(0);
    expect(db.getSnippet(s.id)).toEqual(s);
  });

  it('title 允许空串（UI 用内容首行兜底）', () => {
    const db = mem();
    const s = db.saveSnippet({ title: '', content: '无标题片段' })[0]!;
    expect(s.title).toBe('');
  });

  it('save 更新：created_at 与 use_count 不变，title/content/updated_at 变', () => {
    const db = mem();
    const s = db.saveSnippet({ title: '旧', content: '旧内容' })[0]!;
    db.touchSnippet(s.id);
    const used = db.getSnippet(s.id)!;
    expect(used.useCount).toBe(1);

    const after = db.saveSnippet({ id: s.id, title: '新', content: '新内容' })[0]!;
    expect(after.id).toBe(s.id);
    expect(after.title).toBe('新');
    expect(after.content).toBe('新内容');
    expect(after.createdAt).toBe(s.createdAt);
    expect(after.useCount).toBe(1);
    expect(after.updatedAt).toBeGreaterThanOrEqual(used.updatedAt);
  });

  it('listSnippets 按 updated_at DESC', () => {
    const db = mem();
    // ★ 必须按内容取回，不能取 [0]：saveSnippet 返回整表，同一毫秒写入时
    //   ORDER BY updated_at DESC, id DESC 只能靠随机 uuid 决胜负，[0] 可能是另一条。
    const a = saveOne(db, 'a', 'a');
    const b = saveOne(db, 'b', 'b');
    // 同理，排序断言必须先把时间戳钉死，否则测的是 uuid 的字典序。
    db.raw.prepare('UPDATE snippets SET updated_at = ? WHERE id = ?').run(1000, a.id);
    db.raw.prepare('UPDATE snippets SET updated_at = ? WHERE id = ?').run(2000, b.id);
    expect(db.listSnippets().map((x) => x.id)).toEqual([b.id, a.id]);
    // 改 a 之后 a 的 updated_at 变成当前时间，排最前
    db.saveSnippet({ id: a.id, title: 'a2', content: 'a' });
    expect(db.listSnippets().map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('touchSnippet 递增 use_count 且 updated_at 不变', () => {
    const db = mem();
    const s = db.saveSnippet({ title: 't', content: 'c' })[0]!;
    db.touchSnippet(s.id);
    db.touchSnippet(s.id);
    const after = db.getSnippet(s.id)!;
    expect(after.useCount).toBe(2);
    expect(after.updatedAt).toBe(s.updatedAt);
  });

  it('touchSnippet 对不存在的 id 原样返回全表', () => {
    const db = mem();
    const s = db.saveSnippet({ title: 't', content: 'c' })[0]!;
    expect(db.touchSnippet('nope')).toEqual([s]);
  });

  it('removeSnippet 删后返回全表；getSnippet 找不到回 null', () => {
    const db = mem();
    const a = saveOne(db, 'a', 'a');
    const b = saveOne(db, 'b', 'b');
    expect(db.removeSnippet(a.id).map((x) => x.id)).toEqual([b.id]);
    expect(db.getSnippet(a.id)).toBeNull();
    expect(db.getSnippet('nope')).toBeNull();
  });

  it('超过 SNIPPET_LIMIT 淘汰 updated_at 最旧的', () => {
    const db = mem();
    const firstIds: string[] = [];
    for (let i = 0; i < SNIPPET_LIMIT + 5; i += 1) {
      db.saveSnippet({ title: 't' + i, content: 'c' + i });
      const written = db.raw.prepare('SELECT id FROM snippets WHERE content = ?').get('c' + i) as { id: string };
      // ★ 钉死 updated_at：同一毫秒写入 205 条的话，淘汰谁只由随机 uuid 决定，测不出东西。
      db.raw.prepare('UPDATE snippets SET updated_at = ? WHERE id = ?').run(1000 + i, written.id);
      if (i < 5) firstIds.push(written.id);
    }
    const list = db.listSnippets();
    expect(list).toHaveLength(SNIPPET_LIMIT);
    for (const id of firstIds) {
      expect(list.some((x) => x.id === id), '最旧的片段没被淘汰: ' + id).toBe(false);
    }
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM snippets').get() as { n: number };
    expect(rows.n).toBe(SNIPPET_LIMIT);
  });
});

/** v0.6.0 形态的库：items 已有 search_index 等列，但还没有 tags/folder_id（user_version=3）。 */
function seedV3Db(file: string): void {
  const old = new Database(file);
  old.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT, content_hash TEXT,
      image_path TEXT, image_hash TEXT, thumb_path TEXT,
      width INTEGER, height INTEGER, bytes INTEGER,
      source TEXT NOT NULL DEFAULT 'clip', pinned INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, seq INTEGER NOT NULL,
      deleted_at INTEGER, source_app TEXT, file_paths TEXT, rich_html TEXT, search_index TEXT
    );
    CREATE UNIQUE INDEX idx_content_hash ON items(content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX idx_image_hash   ON items(image_hash)   WHERE image_hash   IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX idx_order ON items(pinned DESC, created_at DESC, seq DESC);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  old.prepare(
    'INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq, search_index) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run('e'.repeat(32), 'text', '升级前的老行', 'hash-v3', 'clip', 0, 0, 1000, 1, 'shengjiqianlaohang');
  old.pragma('user_version = 3');
  old.close();
}

/** 从平表里按名字取文件夹：createFolder 的返回顺序由 created_at 决定，同毫秒建的两个不能靠下标。 */
function folderNamed(list: ReturnType<Db['listFolders']>, name: string) {
  const found = list.find((f) => f.name === name);
  if (!found) throw new Error('没建出文件夹：' + name);
  return found;
}

/**
 * v1.0.0 ⑥ 智能整理 + ⑧ 搜索升级的库层。
 *
 * ★ 除「列是否真的落盘」这类断言外一律走公开 API：以后若把标签拆成关联表，
 *   这些用例不该跟着重写。
 */
describe('v1.0.0 ⑥：schema v4（标签 + 文件夹）', () => {
  it('全新库：版本 5，tags/folder_id 两列与 folders 表、索引就位', () => {
    const db = mem();
    expect(SCHEMA_VERSION).toBe(5);
    expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const cols = new Set(
      (db.raw.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
    );
    expect(cols.has('tags')).toBe(true);
    expect(cols.has('folder_id')).toBe(true);

    const table = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='folders'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('folders');

    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_items_folder'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_items_folder');

    // 文件夹树的父子查找走 parent_id，没有这条索引就只能全表扫
    const parentIdx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_folders_parent'")
      .get() as { name: string } | undefined;
    expect(parentIdx?.name).toBe('idx_folders_parent');
  });

  it('v3 老库升级到 v4：补两列、建 folders 表，老数据与搜索不受影响', () => {
    const file = join(tmpDir(), 'clipchan.db');
    seedV3Db(file);

    const db = openDb(file);
    opened.push(db);

    expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const cols = new Set(
      (db.raw.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
    );
    expect(cols.has('tags')).toBe(true);
    expect(cols.has('folder_id')).toBe(true);

    const table = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='folders'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('folders');

    // 迁移不该动老行：还在列表里，两列是 NULL（= 无标签、未归类）
    const row = db.getRow('e'.repeat(32))!;
    expect(row.tags).toBeNull();
    expect(row.folder_id).toBeNull();
    expect(db.list()).toHaveLength(1);
    expect(db.list({ q: '老行' })).toHaveLength(1);
    // 升级后老库也能立刻用上新表
    expect(db.listFolders()).toEqual([]);
    expect(db.createFolder({ name: '升级后新建' })).toHaveLength(1);
  });
});

describe('v1.0.0 ⑥：标签', () => {
  it('setTags 归一化：去 # / 压空白 / 截 24 码点 / 去重 / 丢含引号与反斜杠 / 空数组存 NULL', () => {
    const db = mem();
    const a = db.insertText('打标签的记录', { now: 1000 });

    // '  #代码 ' 归一后与 '#代码' 相同 → 去重；含 " 与 \ 的会被丢掉（否则 LIKE 过滤会误判）
    db.setTags(a.id, ['#代码', '  #代码 ', 'JSON', 'a"b', 'c\\d', '   ']);
    expect(db.getTags(a.id)).toEqual(['代码', 'JSON']);

    // 按码点切 24，不是按 UTF-16 单元
    db.setTags(a.id, ['标'.repeat(30)]);
    expect(db.getTags(a.id)).toEqual(['标'.repeat(24)]);

    db.setTags(a.id, []);
    const stored = db.raw.prepare('SELECT tags FROM items WHERE id = ?').get(a.id) as {
      tags: string | null;
    };
    expect(stored.tags).toBeNull();
    expect(db.getTags(a.id)).toEqual([]);
  });

  it('DTO：有标签才给 tags 字段，清空后字段整个消失', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    // ★ 断言的是"键不存在"而不是"值为 undefined"：IPC 结构化克隆会保留 undefined 键，
    //   界面用 'tags' in dto 判断有没有标签，两者必须真的等价。
    expect('tags' in db.list()[0]!).toBe(false);
    expect(db.list()[0]!.tags).toBeUndefined();

    db.setTags(a.id, ['代码']);
    expect('tags' in db.list()[0]!).toBe(true);
    expect(db.list()[0]!.tags).toEqual(['代码']);

    db.setTags(a.id, []);
    expect('tags' in db.list()[0]!).toBe(false);
    expect(db.list()[0]!.tags).toBeUndefined();
  });

  it('list({tags}) 是 AND 语义，且能与 kind / q 叠加', () => {
    const db = mem();
    const both = db.insertText('function a() {}', { now: 1000 });
    const codeOnly = db.insertText('const b = 1;', { now: 2000 });
    const link = db.insertText('https://example.com/doc', { now: 3000 });
    db.setTags(both.id, ['代码', 'JSON']);
    db.setTags(codeOnly.id, ['代码']);
    db.setTags(link.id, ['代码', 'JSON']);

    expect(db.list({ tags: ['代码'] }).map((x) => x.id).sort()).toEqual(
      [both.id, codeOnly.id, link.id].sort(),
    );
    // 两个标签要同时命中：只有 codeOnly 缺 JSON，被排除
    expect(db.list({ tags: ['代码', 'JSON'] }).map((x) => x.id).sort()).toEqual([both.id, link.id].sort());
    expect(db.count({ tags: ['代码', 'JSON'] })).toBe(2);

    expect(db.list({ tags: ['代码', 'JSON'], kind: 'link' }).map((x) => x.id)).toEqual([link.id]);
    expect(db.list({ tags: ['代码'], q: 'const' }).map((x) => x.id)).toEqual([codeOnly.id]);

    // 空数组 / 非数组标签等于不加条件
    expect(db.list({ tags: [] })).toHaveLength(3);
    expect(db.list({ tags: ['   '] })).toHaveLength(3);
  });

  it('★ 过滤按 JSON 元素边界匹配：["ab"] 不会命中 ["abc"]', () => {
    const db = mem();
    const short = db.insertText('短标签', { now: 1000 });
    const long = db.insertText('长标签', { now: 2000 });
    db.setTags(short.id, ['ab']);
    db.setTags(long.id, ['abc']);

    // 库里存 ["ab"] / ["abc"]，条件串是 '"ab"'：前缀相同的 'abc' 不该被误命中
    expect(db.list({ tags: ['ab'] }).map((x) => x.id)).toEqual([short.id]);
    expect(db.list({ tags: ['abc'] }).map((x) => x.id)).toEqual([long.id]);

    // AND 语义下一条记录不可能既是 ["ab"] 又是 ["abc"]
    expect(db.list({ tags: ['ab', 'abc'] })).toEqual([]);
    expect(db.count({ tags: ['ab', 'abc'] })).toBe(0);
  });

  it('★ 脏数据兜底：坏 JSON / 非数组 / 非字符串元素都不让整页读不出来', () => {
    const db = mem();
    const badJson = db.insertText('坏 JSON', { now: 1000 });
    const notArray = db.insertText('非数组', { now: 2000 });
    const mixed = db.insertText('混了非字符串', { now: 3000 });
    const writeRaw = (id: string, v: string) =>
      db.raw.prepare('UPDATE items SET tags = ? WHERE id = ?').run(v, id);
    // 直接写原始列，模拟 setTags 之前（或别的版本）留下的脏行
    writeRaw(badJson.id, '{不是 JSON');
    writeRaw(notArray.id, '"一个字符串"');
    writeRaw(mixed.id, '["代码", 42, "", null, "JSON"]');

    // ★ parseTags 对坏数据一律回 []：这些行只是"没有标签"，不是"读列表时抛异常"
    for (const id of [badJson.id, notArray.id]) {
      expect('tags' in db.list().find((x) => x.id === id)!).toBe(false);
      expect(db.getTags(id)).toEqual([]);
    }
    // 非字符串与空串元素丢掉，好的照留
    expect(db.getTags(mixed.id)).toEqual(['代码', 'JSON']);
    // 脏行不该把筛选面板的计数弄错（这里只数到 mixed 那一条）
    expect(db.listTags().map((t) => t.tag).sort()).toEqual(['JSON', '代码'].sort());
    expect(db.listTags().every((t) => t.count === 1)).toBe(true);
  });

  it('回收站往返不动标签：remove 只是软删，restore 后标签原样回来', () => {
    const db = mem();
    const a = db.insertText('带标签的记录', { now: 1000 });
    db.setTags(a.id, ['代码', 'JSON']);

    db.remove(a.id);
    // 回收站里的记录不进统计（面板枚举的是活跃记录）
    expect(db.listTags()).toEqual([]);
    // 但标签列本身没被删
    expect(db.getTags(a.id)).toEqual(['代码', 'JSON']);

    expect(db.restore(a.id)).toBe(true);
    expect(db.getTags(a.id)).toEqual(['代码', 'JSON']);
    expect(db.listTags()).toEqual([
      { tag: '代码', count: 1 },
      { tag: 'JSON', count: 1 },
    ]);
  });
});

describe('v1.0.0 ⑥：文件夹与 folderId 三态', () => {
  it('folderId：string=该文件夹、null=只看未归类、undefined=不限', () => {
    const db = mem();
    const f = db.createFolder({ name: '归类' })[0]!;
    const inside = db.insertText('已归类', { now: 1000 });
    const outside = db.insertText('未归类', { now: 2000 });
    db.setFolder(inside.id, f.id);

    expect(db.list({ folderId: f.id }).map((x) => x.id)).toEqual([inside.id]);
    expect(db.list({ folderId: null }).map((x) => x.id)).toEqual([outside.id]);
    expect(db.list().map((x) => x.id)).toEqual([outside.id, inside.id]);
    // ★ 显式传 undefined 必须等于"没传"，不能退化成"未归类"
    expect(db.list({ folderId: undefined })).toHaveLength(2);

    expect(db.count({ folderId: f.id })).toBe(1);
    expect(db.count({ folderId: null })).toBe(1);
    expect(db.list()[0]!.folderId).toBeUndefined();
    expect(db.list().find((x) => x.id === inside.id)!.folderId).toBe(f.id);
  });

  it('setFolder 指向不存在的文件夹时落 NULL；id 不存在时静默无操作', () => {
    const db = mem();
    const f = db.createFolder({ name: '存在' })[0]!;
    const a = db.insertText('甲', { now: 1000 });

    db.setFolder(a.id, 'ghost-folder');
    // 悬空 id 会让记录从界面彻底消失，所以宁可当"未归类"
    expect(db.getRow(a.id)!.folder_id).toBeNull();
    expect(db.list({ folderId: null }).map((x) => x.id)).toEqual([a.id]);

    db.setFolder(a.id, f.id);
    expect(db.getRow(a.id)!.folder_id).toBe(f.id);
    db.setFolder(a.id, null);
    expect(db.getRow(a.id)!.folder_id).toBeNull();

    expect(() => db.setFolder('不存在的记录', f.id)).not.toThrow();
    expect(() => db.setTags('不存在的记录', ['代码'])).not.toThrow();
    expect(db.getTags('不存在的记录')).toEqual([]);
  });

  it('folderId 指向不存在的文件夹时是空列表，不退化成"不限"', () => {
    const db = mem();
    db.insertText('甲', { now: 1000 });
    db.insertText('乙', { now: 2000 });

    // ★ 传了一个已被删掉的 folderId（另一个窗口刚删完）时，宁可空列表也不能
    //   悄悄返回全部——那会让用户以为"这个文件夹里有 200 条"。
    expect(db.list({ folderId: 'ghost-folder' })).toEqual([]);
    expect(db.count({ folderId: 'ghost-folder' })).toBe(0);
    // 空串是 string 分支：同样不该命中任何行（记录里存的是 NULL，不是 ''）
    expect(db.list({ folderId: '' })).toEqual([]);
  });
});

describe('v1.0.0 ⑧：时间范围含端点', () => {
  it('from/to 两端都闭合，count 与 list 同一套条件', () => {
    const db = mem();
    const t1 = 1000;
    const t2 = 2000;
    const t3 = 3000;
    const a = db.insertText('最早', { now: t1 });
    const b = db.insertText('中间', { now: t2 });
    const c = db.insertText('最晚', { now: t3 });

    // 端点正好压在两条记录的时间戳上：两条都要在
    expect(db.list({ time: { from: t1, to: t2 } }).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(db.list({ time: { from: t2 } }).map((x) => x.id)).toEqual([c.id, b.id]);
    expect(db.list({ time: { to: t2 } }).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(db.count({ time: { from: t1, to: t2 } })).toBe(2);
    expect(db.count({ time: { from: t3 + 1 } })).toBe(0);
    // 非法值（NaN/字符串）当没给
    expect(db.list({ time: { from: Number.NaN } })).toHaveLength(3);
  });

  it('parseSearch 解析出的 time 能直接喂给 list', () => {
    const db = mem();
    const t1 = new Date(2024, 0, 1, 12, 0, 0).getTime();
    const t2 = new Date(2024, 0, 2, 12, 0, 0).getTime();
    const t3 = new Date(2024, 0, 3, 12, 0, 0).getTime();
    const a = db.insertText('一月一日', { now: t1 });
    const b = db.insertText('一月二日', { now: t2 });
    const c = db.insertText('一月三日', { now: t3 });

    const spec = parseSearch('after:2024-01-02 before:2024-01-02');
    expect(spec.errors).toEqual([]);
    expect(spec.expr).toBeUndefined();

    // after 取当日 00:00:00.000、before 取当日 23:59:59.999 → 只落在二日那条
    expect(db.list({ time: spec.time }).map((x) => x.id)).toEqual([b.id]);
    expect(db.count({ time: spec.time })).toBe(1);
    expect(db.list({ time: { from: t1, to: t3 } })).toHaveLength(3);
    expect(db.list({ time: { from: t1, to: t3 } }).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });

  it('只给 from 或只给 to 时是单边过滤，另一端不限', () => {
    const db = mem();
    const a = db.insertText('早', { now: 1000 });
    const b = db.insertText('中', { now: 2000 });
    const c = db.insertText('晚', { now: 3000 });

    expect(db.list({ time: { from: 2000 } }).map((x) => x.id)).toEqual([c.id, b.id]);
    expect(db.list({ time: { to: 2000 } }).map((x) => x.id)).toEqual([b.id, a.id]);
    // 缺端 / 空对象 / undefined 都等于不限，不能退化成"到 0"或"从现在起"
    expect(db.list({ time: {} })).toHaveLength(3);
    expect(db.list({ time: undefined })).toHaveLength(3);
    expect(db.count({ time: { from: 3000 } })).toBe(1);
    expect(db.count({ time: { to: 1000 } })).toBe(1);
  });
});

describe('v1.0.0 ⑧：结构化搜索（expr 走应用层求值）', () => {
  it('逐行 matchSearch 判定，count 与 list 条数一致', () => {
    const db = mem();
    const hit = db.insertText('bar foo', { now: 1000 });
    db.insertText('foo bar', { now: 2000 });
    db.insertText('foo', { now: 3000 });
    db.insertText('bar', { now: 4000 });

    const spec = parseSearch('foo AND /^ba/');
    expect(spec.errors).toEqual([]);
    const expr = spec.expr!;

    const rows = db.list({ expr });
    // /^ba/ 是"以 ba 开头"：'foo bar' 里的 bar 不算命中——这正是 SQL LIKE 做不到的部分
    expect(rows.map((x) => x.id)).toEqual([hit.id]);
    expect(db.count({ expr })).toBe(rows.length);

    expect(db.list({ expr: parseSearch('NOT foo').expr! }).map((x) => x.preview)).toEqual(['bar']);
    expect(db.list({ expr: parseSearch('foo OR bar').expr! })).toHaveLength(4);
  });

  it('expr 与 q 同时给时以 expr 为准（不再叠一层 LIKE）', () => {
    const db = mem();
    const a = db.insertText('foo', { now: 1000 });
    db.insertText('bar', { now: 2000 });
    const expr = parseSearch('foo').expr!;
    expect(db.list({ q: '根本不存在的词', expr }).map((x) => x.id)).toEqual([a.id]);
    expect(db.count({ q: '根本不存在的词', expr })).toBe(1);
  });

  it('expr 时 limit/offset 在命中之后切片，夹取规则与 SQL 路径一致', () => {
    const db = mem();
    for (let i = 1; i <= 5; i += 1) db.insertText('foo ' + i, { now: 1000 * i });
    const expr = parseSearch('foo').expr!;

    expect(db.list({ expr }).map((x) => x.preview)).toEqual(['foo 5', 'foo 4', 'foo 3', 'foo 2', 'foo 1']);
    expect(db.list({ expr, limit: 2 }).map((x) => x.preview)).toEqual(['foo 5', 'foo 4']);
    expect(db.list({ expr, limit: 2, offset: 2 }).map((x) => x.preview)).toEqual(['foo 3', 'foo 2']);
    expect(db.list({ expr, limit: 2, offset: 4 }).map((x) => x.preview)).toEqual(['foo 1']);
    expect(db.list({ expr, limit: 2, offset: 99 })).toEqual([]);
    // limit 至少 1（与 buildListSql 同一套夹取）
    expect(db.list({ expr, limit: 0 })).toHaveLength(1);
    // 命中总数不受分页影响
    expect(db.count({ expr })).toBe(5);
    // 同一个词：SQL 三路 LIKE 与应用层求值必须给出同样多的结果
    expect(db.list({ q: 'foo' })).toHaveLength(5);
  });

  it('expr 也能命中图片行的尺寸描述', () => {
    const db = mem();
    const img = db.insertImage(
      { imagePath: 'images/i1.jpg', thumbPath: 'thumbs/i1.png', width: 1920, height: 1080, bytes: 187392, hash: 'hash-expr-i1' },
      { now: 1000 },
    );
    db.insertText('纯文本行', { now: 2000 });

    const expr = parseSearch('/^图片/').expr!;
    expect(db.list({ expr }).map((x) => x.id)).toEqual([img.id]);
    expect(db.count({ expr })).toBe(1);
  });

  it('re: 正则分别命中 content 与 search_index 两路', () => {
    const db = mem();
    const code = db.insertText('const token = 1;', { now: 1000 });
    // 中文行 content 里没有拼音，只有 search_index 带拼音——用来验证第二路
    const chinese = db.insertText('工作日志', { now: 2000 });
    db.insertText('无关内容', { now: 3000 });

    // 第一路：content 直接匹配（. 是任意字符，token 中间的 e 被吃掉）
    expect(db.list({ expr: parseSearch('re:tok.n').expr! }).map((x) => x.id)).toEqual([code.id]);
    // 第二路：content 里没有 'gongzuo'，命中只能来自 buildSearchIndex 写进去的拼音
    expect(db.list({ expr: parseSearch('re:gongzuo').expr! }).map((x) => x.id)).toEqual([chinese.id]);
    // 正则不命中任何一行时是空数组，不是"退化成不过滤"
    expect(db.list({ expr: parseSearch('re:zzz').expr! })).toEqual([]);
    expect(db.count({ expr: parseSearch('re:zzz').expr! })).toBe(0);
  });

  it('★ 布尔 NOT / OR 与括号按优先级求值（应用层才做得到）', () => {
    const db = mem();
    const apple = db.insertText('apple', { now: 1000 });
    const banana = db.insertText('banana', { now: 2000 });
    db.insertText('cherry', { now: 3000 });

    // 括号把 NOT 绑在 banana 上：apple 命中 OR 左侧；banana 命中右侧；cherry 两侧都不中
    const spec = parseSearch('apple OR (banana NOT cherry)');
    expect(spec.errors).toEqual([]);
    expect(db.list({ expr: spec.expr! }).map((x) => x.id)).toEqual([banana.id, apple.id]);
    expect(db.count({ expr: spec.expr! })).toBe(2);

    // 去掉括号就是另一套语义：(apple OR banana) NOT cherry —— 结果恰好一样，
    // 但 NOT 的否定域变了，这里靠 NOT cherry 单独成立来确认 NOT 不是"整句取反"
    expect(db.list({ expr: parseSearch('NOT cherry').expr! }).map((x) => x.id)).toEqual([banana.id, apple.id]);
  });

  it('expr 与 tags / folderId 叠加：先 SQL 收窄再应用层求值', () => {
    const db = mem();
    const folder = folderNamed(db.createFolder({ name: '工作' }), '工作');
    const inFolder = db.insertText('foo 在文件夹里', { now: 1000 });
    const tagged = db.insertText('foo 带标签', { now: 2000 });
    db.insertText('foo 什么都没有', { now: 3000 });
    db.setFolder(inFolder.id, folder.id);
    db.setTags(tagged.id, ['重要']);

    const expr = parseSearch('foo').expr!;
    // SQL 侧先按 folderId 收窄，应用层只对候选行求值
    expect(db.list({ expr, folderId: folder.id }).map((x) => x.id)).toEqual([inFolder.id]);
    expect(db.list({ expr, tags: ['重要'] }).map((x) => x.id)).toEqual([tagged.id]);
    // 两个条件同时给是交集
    expect(db.list({ expr, tags: ['重要'], folderId: folder.id })).toEqual([]);
    // 不加任何收窄条件时三行都在
    expect(db.count({ expr })).toBe(3);
  });

  it('expr 命中时 count 返回命中总数而不是分页长度', () => {
    const db = mem();
    for (let i = 1; i <= 4; i += 1) db.insertText('hit ' + i, { now: 1000 * i });
    const expr = parseSearch('hit').expr!;

    expect(db.list({ expr, limit: 1 })).toHaveLength(1);
    // ★ 分页只影响 list 的返回条数；「共 N 条」必须说总数，否则界面上页码会少算
    expect(db.count({ expr, limit: 1, offset: 3 })).toBe(4);
    expect(db.count({ expr, limit: 1, offset: 99 })).toBe(4);
  });

  it('非法正则降级为文本叶子：errors 非空但不抛', () => {
    const db = mem();
    const literal = db.insertText('这一行里就有 [unclosed 这几个字', { now: 1000 });
    db.insertText('普通一行', { now: 2000 });

    const spec = parseSearch('re:[unclosed');
    expect(spec.errors.length).toBeGreaterThan(0);
    expect(spec.errors[0]).toContain('invalid-regex');

    // ★ 降级后按字面量当普通文本搜：用户输错正则不该换来一个空列表 + 崩溃
    expect(() => db.list({ expr: spec.expr! })).not.toThrow();
    expect(db.list({ expr: spec.expr! }).map((x) => x.id)).toEqual([literal.id]);
  });
});

describe('v1.0.0 ⑥：文件夹 CRUD', () => {
  it('create：归一化名字、父不存在当顶层、空名不建、返回变更后的平表', () => {
    const db = mem();
    expect(db.listFolders()).toEqual([]);

    const created = db.createFolder({ name: '工作' });
    expect(created).toHaveLength(1);
    const work = created[0]!;
    expect(work.name).toBe('工作');
    expect(work.parentId).toBeNull();
    expect(work.itemCount).toBe(0);
    expect(work.id.length).toBeGreaterThan(0);

    // 名字与标签同一套归一：# 去掉、空白压成单空格
    const spaced = db.createFolder({ name: '  #生活  用品 ' });
    expect(folderNamed(spaced, '生活 用品')).toBeTruthy();

    // 父不存在 → 当顶层，不抛
    const orphan = db.createFolder({ name: '孤儿', parentId: '不存在的父' });
    expect(folderNamed(orphan, '孤儿').parentId).toBeNull();

    // 空名（含只有空白）→ 不建、原表返回
    expect(db.createFolder({ name: '   ' })).toHaveLength(orphan.length);
    expect(db.createFolder({ name: '#  #' })).toHaveLength(orphan.length);

    const nested = db.createFolder({ name: '子目录', parentId: work.id });
    expect(folderNamed(nested, '子目录').parentId).toBe(work.id);
  });

  it('rename：正常改名；id 不存在或新名为空 → 原表不变（不抛）', () => {
    const db = mem();
    const f = db.createFolder({ name: '旧名' })[0]!;

    const renamed = db.renameFolder(f.id, '#新  名字');
    expect(folderNamed(renamed, '新 名字').id).toBe(f.id);

    const before = db.listFolders();
    expect(() => db.renameFolder('不存在的 id', '随便')).not.toThrow();
    expect(db.listFolders()).toEqual(before);
    expect(db.renameFolder(f.id, '   ')).toEqual(before);
  });

  it('move：正常改父；成环 / 自指 / 目标不存在 / 超深 → 原表不变', () => {
    const db = mem();
    const a = folderNamed(db.createFolder({ name: 'A' }), 'A');
    const b = folderNamed(db.createFolder({ name: 'B', parentId: a.id }), 'B');
    const c = folderNamed(db.createFolder({ name: 'C', parentId: b.id }), 'C');

    // 成环：把 A 挂到自己的后代 B 下面 → 整棵树会退化成环，必须拒绝
    expect(folderNamed(db.moveFolder(a.id, b.id), 'A').parentId).toBeNull();
    // 自指
    expect(folderNamed(db.moveFolder(a.id, a.id), 'A').parentId).toBeNull();
    // 目标不存在
    expect(folderNamed(db.moveFolder(a.id, '不存在的父'), 'A').parentId).toBeNull();
    // id 不存在
    expect(() => db.moveFolder('不存在的 id', null)).not.toThrow();

    // 超深：A(1) → B(2) → C(3)，再往下挂就第 4 层，拒绝
    const beforeDepth = db.listFolders().length;
    const deep = db.createFolder({ name: 'D', parentId: c.id });
    expect(deep).toHaveLength(beforeDepth);
    expect(deep.some((x) => x.name === 'D')).toBe(false);

    // 正常路径：C 提到顶层
    expect(folderNamed(db.moveFolder(c.id, null), 'C').parentId).toBeNull();
    // 提到顶层后空出来的位置能再挂回来
    expect(folderNamed(db.moveFolder(c.id, a.id), 'C').parentId).toBe(a.id);
  });

  it('remove：记录回到未归类、子文件夹提升为顶层、文件夹行删掉', () => {
    const db = mem();
    const root = folderNamed(db.createFolder({ name: '待删' }), '待删');
    const kid = folderNamed(db.createFolder({ name: '子夹', parentId: root.id }), '子夹');
    const a = db.insertText('放进文件夹的记录', { now: 1000 });
    const b = db.insertText('放进子夹的记录', { now: 2000 });
    db.setFolder(a.id, root.id);
    db.setFolder(b.id, kid.id);

    const after = db.removeFolder(root.id);
    expect(after.map((x) => x.name)).not.toContain('待删');
    expect(folderNamed(after, '子夹').parentId).toBeNull();

    // ★ 记录一条都不许跟着删，只是回到未归类
    expect(db.list()).toHaveLength(2);
    expect(db.getRow(a.id)!.folder_id).toBeNull();
    // 只有原属于「待删」的那条回到未归类；子夹里的那条仍归子夹
    expect(db.list({ folderId: null }).map((x) => x.id)).toEqual([a.id]);
    // 子夹里的记录也还在（子夹本身被提升，不是被删）
    expect(db.getRow(b.id)!.folder_id).toBe(kid.id);
    expect(db.list({ folderId: kid.id }).map((x) => x.id)).toEqual([b.id]);

    // 删不存在的 id 不抛，表不变
    const before = db.listFolders();
    expect(() => db.removeFolder('不存在的 id')).not.toThrow();
    expect(db.listFolders()).toEqual(before);
  });

  it('itemCount：只数未删且直属本文件夹的记录（不含回收站、不含子文件夹）', () => {
    const db = mem();
    const f = folderNamed(db.createFolder({ name: '计数' }), '计数');
    const a = db.insertText('甲', { now: 1000 });
    const b = db.insertText('乙', { now: 2000 });
    db.setFolder(a.id, f.id);
    db.setFolder(b.id, f.id);
    expect(folderNamed(db.listFolders(), '计数').itemCount).toBe(2);

    // 软删一条：回收站里的记录不该还占着文件夹的计数
    db.remove(a.id);
    expect(folderNamed(db.listFolders(), '计数').itemCount).toBe(1);

    const kid = folderNamed(db.createFolder({ name: '子夹', parentId: f.id }), '子夹');
    const c = db.insertText('丙', { now: 3000 });
    db.setFolder(c.id, kid.id);
    const flat = db.listFolders();
    expect(folderNamed(flat, '计数').itemCount).toBe(1);
    expect(folderNamed(flat, '子夹').itemCount).toBe(1);
    // 平表把父子关系原样给出，树由渲染层自己搭
    expect(folderNamed(flat, '子夹').parentId).toBe(f.id);
  });
});

describe('v1.0.0 ⑥：listTags 标签统计（筛选面板枚举用）', () => {
  it('多标签计数正确：数的是用到它的记录条数，不是标签出现次数', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    const b = db.insertText('乙', { now: 2000 });
    const c = db.insertText('丙', { now: 3000 });
    db.setTags(a.id, ['代码', 'JSON']);
    db.setTags(b.id, ['代码']);
    db.setTags(c.id, ['代码', 'JSON', '链接']);

    expect(db.listTags()).toEqual([
      { tag: '代码', count: 3 },
      { tag: 'JSON', count: 2 },
      { tag: '链接', count: 1 },
    ]);
  });

  it('回收站里的记录不计入', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    const b = db.insertText('乙', { now: 2000 });
    db.setTags(a.id, ['代码']);
    db.setTags(b.id, ['代码', 'JSON']);
    expect(db.listTags()).toEqual([
      { tag: '代码', count: 2 },
      { tag: 'JSON', count: 1 },
    ]);

    // 软删掉那条：它的 JSON 标签不该还挂在面板上
    db.remove(b.id);
    expect(db.listTags()).toEqual([{ tag: '代码', count: 1 }]);
  });

  it('同一条记录里重复的标签只算一次', () => {
    const db = mem();
    const a = db.insertText('甲', { now: 1000 });
    const b = db.insertText('乙', { now: 2000 });
    // setTags 内部会去重，这里直接写原始列，模拟 setTags 之前就存在的重复标签行
    db.raw.prepare('UPDATE items SET tags = ? WHERE id = ?').run('["代码","代码","代码"]', a.id);
    db.raw.prepare('UPDATE items SET tags = ? WHERE id = ?').run('["代码"]', b.id);

    expect(db.listTags()).toEqual([{ tag: '代码', count: 2 }]);
  });

  it('按 count 降序；同频按 tag 升序（localeCompare zh，面板位置不抖）', () => {
    const db = mem();
    // 插入顺序刻意与期望顺序不同：不排序就会得到 b / a / c 的 Map 顺序
    const first = db.insertText('甲', { now: 1000 });
    const second = db.insertText('乙', { now: 2000 });
    const third = db.insertText('丙', { now: 3000 });
    db.setTags(first.id, ['b', 'a']);
    db.setTags(second.id, ['a']);
    db.setTags(third.id, ['c']);

    expect(db.listTags()).toEqual([
      { tag: 'a', count: 2 },
      { tag: 'b', count: 1 },
      { tag: 'c', count: 1 },
    ]);
  });

  it('无标签返回 []（空库 / 记录都没标签 / 标签被清空）', () => {
    const db = mem();
    expect(db.listTags()).toEqual([]);

    const a = db.insertText('甲', { now: 1000 });
    expect(db.listTags()).toEqual([]);

    db.setTags(a.id, []);
    expect(db.listTags()).toEqual([]);
  });
});



/**
 * v1.1.0：URL 预览缓存表。
 *
 * ★ 这是**纯缓存**：写进去的东西随时可以清空重建，所以这里断言的重点不是"数据多重要"，
 *   而是"同 url 不会长出两行"与"没缓存时字段根本不存在"这两件会影响调用方判断的事。
 */
describe('v1.1.0：url_previews 缓存表', () => {
  const preview = (url: string, title: string, fetchedAt = 1000) => ({
    url,
    title,
    domain: 'example.com',
    iconUrl: 'https://example.com/favicon.ico',
    fetchedAt,
  });

  it('写入后能原样读回（iconUrl ↔ icon_url 映射正确）', () => {
    const db = mem();
    db.upsertUrlPreview(preview('https://example.com/a', '甲页面'));

    const got = db.getUrlPreviews(['https://example.com/a']);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      url: 'https://example.com/a',
      title: '甲页面',
      domain: 'example.com',
      iconUrl: 'https://example.com/favicon.ico',
      fetchedAt: 1000,
    });
  });

  it('同 url 二次写入是更新而不是插入两行', () => {
    const db = mem();
    db.upsertUrlPreview(preview('https://example.com/a', '旧标题', 1000));
    db.upsertUrlPreview(preview('https://example.com/a', '新标题', 2000));

    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM url_previews').get() as { n: number };
    expect(rows.n).toBe(1);
    const got = db.getUrlPreviews(['https://example.com/a']);
    expect(got).toHaveLength(1);
    expect(got[0]!.title).toBe('新标题');
    expect(got[0]!.fetchedAt).toBe(2000);
  });

  it('url 为空串不写（不落垃圾行）', () => {
    const db = mem();
    db.upsertUrlPreview(preview('', '空 url'));
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM url_previews').get() as { n: number };
    expect(rows.n).toBe(0);
    expect(db.getUrlPreviews([''])).toEqual([]);
  });

  it('getUrlPreviews([]) 返回 []；批量查 2 个 url 命中 1 个时只返回 1 条', () => {
    const db = mem();
    expect(db.getUrlPreviews([])).toEqual([]);

    db.upsertUrlPreview(preview('https://example.com/a', '甲页面'));
    const got = db.getUrlPreviews(['https://example.com/a', 'https://example.com/missing']);
    expect(got).toHaveLength(1);
    expect(got[0]!.url).toBe('https://example.com/a');
  });

  it('api.list：kind=link 且有缓存的挂 urlPreview，无缓存的不挂该键', () => {
    const db = mem();
    const cached = db.insertText('https://example.com/cached', { now: 1000 });
    const uncached = db.insertText('https://example.com/uncached', { now: 2000 });
    const plain = db.insertText('一段普通文字', { now: 3000 });
    db.upsertUrlPreview(preview('https://example.com/cached', '有缓存的页面'));

    const list = db.list();
    const byId = new Map(list.map((x) => [x.id, x]));

    const hit = byId.get(cached.id)!;
    expect(hit.kind).toBe('link');
    expect(hit.urlPreview?.title).toBe('有缓存的页面');
    expect(hit.urlPreview?.domain).toBe('example.com');

    // ★ 未命中必须是"没有这个键"，而不是"键存在但值是 undefined"
    const miss = byId.get(uncached.id)!;
    expect('urlPreview' in miss).toBe(false);
    expect('urlPreview' in byId.get(plain.id)!).toBe(false);

    // count 不该因为挂缓存而改变（挂预览只在 list 里做）
    expect(db.count()).toBe(3);
  });
});

/**
 * v1.1.0：items.phash 与相似图片判定。
 *
 * ★ 这里最要紧的一条断言是"相近的图**照样入库**"：相似不等于相同，
 *   静默丢掉用户刚复制的东西比留一条重复记录糟得多。
 */
describe('v1.1.0：图片感知哈希 phash 与相似判定', () => {
  const BASE = '0123456789abcdef';
  const imgMeta = (hash: string, phash?: string) => ({
    imagePath: 'images/' + hash + '.jpg',
    thumbPath: 'thumbs/' + hash + '.png',
    width: 100,
    height: 100,
    bytes: 2048,
    hash,
    ...(phash === undefined ? {} : { phash }),
  });

  it('hammingDistance：相同串=0、全异=长度、不等长=999', () => {
    expect(hammingDistance(BASE, BASE)).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(16);
    expect(hammingDistance('0123456789abcdef', '0123456789abcde')).toBe(999);
    expect(hammingDistance('', BASE)).toBe(999);
    // 差 1 个字符就是 1，不是"差几位"
    expect(hammingDistance('0123456789abcdee', BASE)).toBe(1);
  });

  it('phash 落库后能读回；不传 phash 时该列是 NULL', () => {
    const db = mem();
    const withHash = db.insertImage(imgMeta('hash-a', BASE), { now: 1000 });
    const without = db.insertImage(imgMeta('hash-b'), { now: 2000 });

    expect(db.getRow(withHash.id)!.phash).toBe(BASE);
    expect(db.getRow(without.id)!.phash).toBeNull();
  });

  it('相近 phash（差 ≤ 阈值）返回 similarTo，且新记录照样入库', () => {
    const db = mem();
    const first = db.insertImage(imgMeta('hash-a', BASE), { now: 1000 });
    expect(first.touched).toBe(false);
    expect(first.similarTo).toBeUndefined();

    // 后 10 个字符全不同 → 汉明距离正好 10（= 阈值，算相近）
    const near = '012345' + '0000000000';
    expect(hammingDistance(BASE, near)).toBe(SIMILAR_HAMMING_THRESHOLD);

    const second = db.insertImage(imgMeta('hash-b', near), { now: 2000 });
    expect(second.touched).toBe(false);
    expect(second.similarTo).toBe(first.id);
    // ★ 相似不等于相同：新记录必须真的进了库
    expect(second.id).not.toBe(first.id);
    expect(db.count()).toBe(2);
    expect(db.getRow(second.id)!.phash).toBe(near);
  });

  it('差异 > 阈值时不返回 similarTo', () => {
    const db = mem();
    const first = db.insertImage(imgMeta('hash-a', BASE), { now: 1000 });

    // 从第 6 个字符起 11 位全换成 '0'（BASE 那 11 位是 5..f，无一相同）→ 距离 11 > 10
    const far = '01234' + '00000000000';
    expect(hammingDistance(BASE, far)).toBeGreaterThan(SIMILAR_HAMMING_THRESHOLD);

    const second = db.insertImage(imgMeta('hash-b', far), { now: 2000 });
    expect(second.touched).toBe(false);
    expect(second.similarTo).toBeUndefined();
    expect(db.count()).toBe(2);
    expect(second.id).not.toBe(first.id);
  });

  it('phash 缺省时不返回 similarTo 也不报错', () => {
    const db = mem();
    db.insertImage(imgMeta('hash-a', BASE), { now: 1000 });
    expect(() => db.insertImage(imgMeta('hash-b'), { now: 2000 })).not.toThrow();
    const plain = db.insertImage(imgMeta('hash-c'), { now: 3000 });
    expect(plain.similarTo).toBeUndefined();
    expect(plain.touched).toBe(false);
    expect(db.count()).toBe(3);
  });

  it('完全相同的图仍走 touched（命中既有行），此时不填 similarTo', () => {
    const db = mem();
    const first = db.insertImage(imgMeta('hash-a', BASE), { now: 1000 });
    const again = db.insertImage(imgMeta('hash-a', BASE), { now: 2000 });
    expect(again.id).toBe(first.id);
    expect(again.touched).toBe(true);
    expect(again.similarTo).toBeUndefined();
    expect(db.count()).toBe(1);
  });

  it('回收站里的相近图片不算（已删的不该被提示）', () => {
    const db = mem();
    const first = db.insertImage(imgMeta('hash-a', BASE), { now: 1000 });
    db.remove(first.id);
    const second = db.insertImage(imgMeta('hash-b', '012345' + '0000000000'), { now: 2000 });
    expect(second.similarTo).toBeUndefined();
  });
});

/** v1.1.0 形态之前的库：items 有 tags/folder_id，但没有 phash，也没有 url_previews（user_version=4）。 */
function seedV4Db(file: string): void {
  const old = new Database(file);
  old.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT, content_hash TEXT,
      image_path TEXT, image_hash TEXT, thumb_path TEXT,
      width INTEGER, height INTEGER, bytes INTEGER,
      source TEXT NOT NULL DEFAULT 'clip', pinned INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, seq INTEGER NOT NULL,
      deleted_at INTEGER, source_app TEXT, file_paths TEXT, rich_html TEXT, search_index TEXT,
      tags TEXT, folder_id TEXT
    );
    CREATE UNIQUE INDEX idx_content_hash ON items(content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX idx_image_hash   ON items(image_hash)   WHERE image_hash   IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX idx_order ON items(pinned DESC, created_at DESC, seq DESC);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_folders_parent ON folders(parent_id);
  `);
  old.prepare(
    'INSERT INTO items (id, kind, content, content_hash, source, pinned, truncated, created_at, seq) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('f'.repeat(32), 'text', 'v4 的老行', 'hash-v4', 'clip', 0, 0, 1000, 1);
  old.pragma('user_version = 4');
  old.close();
}

describe('v1.1.0：schema v5（URL 预览缓存 + phash）', () => {
  it('v4 老库自动补 phash 列与 url_previews 表，openDb 不抛', () => {
    const file = join(tmpDir(), 'clipchan.db');
    seedV4Db(file);

    let db: Db | null = null;
    expect(() => { db = openDb(file); }).not.toThrow();
    const openedDb = db as unknown as Db;
    opened.push(openedDb);

    expect(openedDb.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(5);

    const cols = new Set(
      (openedDb.raw.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
    );
    expect(cols.has('phash')).toBe(true);

    const table = openedDb.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='url_previews'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('url_previews');

    // 老数据不受影响，且新列/新表立刻可用
    expect(openedDb.count()).toBe(1);
    expect(openedDb.getRow('f'.repeat(32))!.phash).toBeNull();
    expect(openedDb.getUrlPreviews([])).toEqual([]);
    openedDb.upsertUrlPreview({
      url: 'https://example.com/x', title: '升级后写的', domain: 'example.com',
      iconUrl: '', fetchedAt: 1,
    });
    expect(openedDb.getUrlPreviews(['https://example.com/x'])).toHaveLength(1);
  });

  it('全新库：phash 列与 url_previews 表一开始就在', () => {
    const db = mem();
    const cols = new Set(
      (db.raw.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
    );
    expect(cols.has('phash')).toBe(true);
    const table = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='url_previews'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('url_previews');
  });
});

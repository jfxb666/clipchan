import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db';
import type { Db } from './db';
import { runLegacyMigration } from './migrate-runner';

const opened: Db[] = [];
const tmpDirs: string[] = [];
const lines: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-migrun-'));
  tmpDirs.push(d);
  return d;
}

function sink() {
  return {
    log: (m: string) => lines.push('LOG ' + m),
    warn: (m: string) => lines.push('WARN ' + m),
    error: (m: string) => lines.push('ERROR ' + m),
  };
}

function legacyHistory(): string {
  return JSON.stringify({
    version: 1,
    items: [
      { id: 'a'.repeat(32), text: '第一条 中文多行\n第二行', at: '2026-10-01T10:00:00+08:00', seq: 1, pin: false, trunc: false },
      { id: 'b'.repeat(32), text: 'C:\\temp\\a.txt', at: '2026-10-01T10:01:00+08:00', seq: 2, pin: true, trunc: false },
      { id: 'c'.repeat(32), text: '带"引号"的第三行', at: '2026-10-01T10:02:00+08:00', seq: 3, pin: false, trunc: true },
    ],
  });
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  lines.length = 0;
});

describe('runLegacyMigration（Task 10 启动迁移包装）', () => {
  it('新库 + 旧 history.json → 导入 3 条，改名 .migrated，日志格式与内联版一致', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'history.json'), legacyHistory());
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', autopaste: false }));
    const settingsBefore = readFileSync(join(dir, 'settings.json'));
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);

    const r = runLegacyMigration(db, dir, true, sink());

    expect(r.attempted).toBe(true);
    expect(r.imported).toBe(3);
    expect(r.skipped).toBe(0);
    expect(lines).toContain('LOG [migrate] 导入 3 条，跳过 0 条');
    expect(db.getRow('a'.repeat(32))!.content).toBe('第一条 中文多行\n第二行');
    expect(db.getRow('b'.repeat(32))!.content).toBe('C:\\temp\\a.txt');
    expect(db.getRow('c'.repeat(32))!.content).toBe('带"引号"的第三行');
    expect(db.getRow('b'.repeat(32))!.pinned).toBe(1);
    expect(db.getRow('c'.repeat(32))!.truncated).toBe(1);
    expect(existsSync(join(dir, 'history.json'))).toBe(false);
    expect(existsSync(join(dir, 'history.json.migrated'))).toBe(true);
    expect(readFileSync(join(dir, 'settings.json')).equals(settingsBefore)).toBe(true);
  });

  it('库已存在（isFresh=false）时不尝试：不读旧文件、不改名', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'history.json'), legacyHistory());
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);

    const r = runLegacyMigration(db, dir, false, sink());

    expect(r).toEqual({ attempted: false, imported: 0, skipped: 0, settingsFromLegacy: false });
    expect(db.list()).toHaveLength(0);
    expect(existsSync(join(dir, 'history.json'))).toBe(true);
    expect(lines).toHaveLength(0);
  });

  it('没有旧 history.json 时保持沉默（不写日志）', () => {
    const dir = tmpDir();
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    const r = runLegacyMigration(db, dir, true, sink());
    expect(r.attempted).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it('坏 JSON 不抛异常：migrateLegacy 自己吞掉并只记 WARN，启动继续、旧文件保留', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'history.json'), '{ 这不是 JSON');
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    const r = runLegacyMigration(db, dir, true, sink());
    expect(r.attempted).toBe(true);
    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(0);
    expect(lines.some((l) => l.startsWith('WARN [migrate] history.json 解析失败'))).toBe(true);
    // ★ 解析失败时**不改名**：留给人工补救，绝不假装迁移完成
    expect(existsSync(join(dir, 'history.json'))).toBe(true);
    expect(existsSync(join(dir, 'history.json.migrated'))).toBe(false);
  });

  it('包装层自身出错时记 ERROR 且不抛（模拟底层抛异常）', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'history.json'), legacyHistory());
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    db.close();
    opened.length = 0;
    const r = runLegacyMigration(db, dir, true, sink());
    expect(r.attempted).toBe(true);
    expect(r.imported).toBe(0);
    expect(lines.some((l) => l.startsWith('ERROR [migrate] 迁移失败（不阻断启动）：'))).toBe(true);
  });

  it('缺短键的记录计入 skipped 并留下警告，其余照常导入', () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'history.json'),
      JSON.stringify({
        version: 1,
        items: [
          { id: 'd'.repeat(32), text: '好', at: '2026-10-01T10:00:00+08:00', seq: 1, pin: false, trunc: false },
          { seq: 2 },
        ],
      })
    );
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    const r = runLegacyMigration(db, dir, true, sink());
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(1);
    expect(lines.some((l) => l.startsWith('WARN [migrate] 跳过一条'))).toBe(true);
  });
});

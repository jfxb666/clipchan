import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db';
import type { Db } from './db';
import { migrateLegacy } from './migrate';

const FIX = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const opened: Db[] = [];
const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-mig-'));
  tmpDirs.push(d);
  return d;
}

function withFixtures(): string {
  const d = tmpDir();
  copyFileSync(join(FIX, 'legacy-history.json'), join(d, 'history.json'));
  copyFileSync(join(FIX, 'legacy-settings.json'), join(d, 'settings.json'));
  return d;
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('migrateLegacy（Review Focus 3：短键）', () => {
  it('按短键导入 3 条，内容逐字一致，pin/trunc/at 正确', () => {
    const dir = withFixtures();
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    const r = migrateLegacy(db, dir);
    expect(r.imported).toBe(3);
    expect(r.skipped).toBe(0);
    expect(r.settingsFromLegacy).toBe(true);

    const raw = JSON.parse(readFileSync(join(FIX, 'legacy-history.json'), 'utf8')) as {
      items: { id: string; text: string; at: string; pin: boolean; trunc: boolean }[];
    };
    const rows = db.list();
    expect(rows).toHaveLength(3);
    for (const item of raw.items) {
      const row = db.getRow(item.id);
      expect(row).not.toBeNull();
      expect(row!.content).toBe(item.text);
      expect(row!.created_at).toBe(Date.parse(item.at));
      expect(row!.pinned).toBe(item.pin ? 1 : 0);
      expect(row!.truncated).toBe(item.trunc ? 1 : 0);
    }
    // 多行/制表文本逐字保留
    expect(db.getRow('a'.repeat(32))!.content).toBe('第一行\n第二行\t第三行');
    // 引号与反斜杠逐字保留
    expect(db.getRow('b'.repeat(32))!.content).toContain('C:\\temp\\a.txt');
  });

  it('用 C# 属性名写的文件导入 0 条（钉死陷阱）', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'history.json'), JSON.stringify({
      version: 1,
      items: [
        { Id: 'd'.repeat(32), Text: '不会进来', CreatedUtc: '2026-10-14T01:00:00.000Z', Seq: 1, Pinned: true, Truncated: false },
      ],
    }));
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    const r = migrateLegacy(db, dir);
    expect(r.imported).toBe(0);
    expect(db.list()).toHaveLength(0);
  });

  it('seq 缺失按当前最大 seq+1 补齐，且后续新插入更大', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'history.json'), JSON.stringify({
      version: 1,
      items: [
        { id: 'e'.repeat(32), text: '有 seq', at: '2026-10-14T01:00:00.000Z', seq: 5, pin: false, trunc: false },
        { id: 'f'.repeat(32), text: '无 seq', at: '2026-10-14T02:00:00.000Z', pin: false, trunc: false },
      ],
    }));
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    const r = migrateLegacy(db, dir);
    expect(r.imported).toBe(2);
    const withSeq = db.getRow('e'.repeat(32))!;
    const noSeq = db.getRow('f'.repeat(32))!;
    expect(withSeq.seq).toBe(5);
    expect(noSeq.seq).toBe(6);
    const fresh = db.insertText('迁移后新增', { now: Date.now() });
    expect(db.getRow(fresh.id)!.seq).toBeGreaterThan(noSeq.seq);
  });

  it('单条 at 解析失败只跳过该条并计入 skipped', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'history.json'), JSON.stringify({
      version: 1,
      items: [
        { id: 'g'.repeat(32), text: '好1', at: '2026-10-14T01:00:00.000Z', seq: 1, pin: false, trunc: false },
        { id: 'h'.repeat(32), text: '坏', at: 'not-a-date', seq: 2, pin: false, trunc: false },
        { id: 'i'.repeat(32), text: '好2', at: '2026-10-14T03:00:00.000Z', seq: 3, pin: false, trunc: false },
      ],
    }));
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    const r = migrateLegacy(db, dir);
    expect(r.imported).toBe(2);
    expect(r.skipped).toBe(1);
    expect(db.getRow('h'.repeat(32))).toBeNull();
    expect(db.getRow('g'.repeat(32))).not.toBeNull();
  });

  it('成功后 history.json 改名 .migrated，settings.json 字节不变', () => {
    const dir = withFixtures();
    const settingsPath = join(dir, 'settings.json');
    const before = readFileSync(settingsPath);
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    migrateLegacy(db, dir);
    expect(existsSync(join(dir, 'history.json'))).toBe(false);
    expect(existsSync(join(dir, 'history.json.migrated'))).toBe(true);
    expect(readFileSync(settingsPath).equals(before)).toBe(true);
    expect(db.getSettings().theme).toBe('dark');
    expect(db.getSettings().autoPaste).toBe(false);
    // 热键按 §9.3 重置为默认，不翻译 WinForms Keys 数值
    expect(db.getSettings().hotkeyActivate).toBe('Control+' + '\u0060');
  });

  it('history.json 不存在时不导入也不报错', () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    const db = openDb(join(dir, 'clipchan.db'));
    opened.push(db);
    const r = migrateLegacy(db, dir);
    expect(r).toEqual({ imported: 0, skipped: 0, settingsFromLegacy: false });
  });
});

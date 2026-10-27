import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKUP_INTERVAL_MS, backupFileName } from './backup';
import type { RestoreBackupResult } from './backup';
import { backupsDir } from './paths';
import { maybeBackup, recoverCorruptDb } from './storage-guard';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clipchan-storage-guard-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个真库（能过 quick_check），内容可由 tag 区分。 */
function makeDb(file: string, tag = 'seed'): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, content TEXT)');
    db.prepare('INSERT INTO items (id, content) VALUES (?, ?)').run('a'.repeat(32), tag);
  } finally {
    db.close();
  }
}

/** 读库里的 tag；打不开返回 undefined。 */
function readTag(file: string): string | undefined {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT content FROM items LIMIT 1').get() as { content: string } | undefined;
    return row?.content;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 固定时刻（本地时间），避免测试跑在不同时区/时刻上抖动。 */
function at(day: number, hour: number, minute: number, second: number): number {
  return new Date(2024, 0, day, hour, minute, second).getTime();
}

/**
 * 一个能区分「真恢复」和「只是没报错」的替身：
 * 校验备份文件确实存在、通过 quick_check，再把内容复制回 dbPath。
 * ★ 不用真 restoreBackup 的场合（想验证调用次数/参数），用它保持行为等价。
 */
function copyRestore(dbPath: string, backupPath: string): RestoreBackupResult {
  if (!existsSync(backupPath)) return { ok: false, reason: 'missing-backup: 备份文件不存在' };
  copyFileSync(backupPath, dbPath);
  return { ok: true, path: backupPath };
}

describe('recoverCorruptDb：库健康时什么都不做', () => {
  it('looksCorrupt=false → 返回空结果，且不碰备份目录、不改名', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    makeDb(dbPath, 'healthy');

    const findBackup = vi.fn(() => undefined);
    const quarantine = vi.fn(() => 'should-not-be-called.db');

    const res = recoverCorruptDb({ dataDir, dbPath, looksCorrupt: () => false, quarantine, findBackup });

    expect(res).toEqual({});
    expect(findBackup).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
    // 现库原地未动，内容还在。
    expect(readTag(dbPath)).toBe('healthy');
    expect(readdirSync(dataDir)).toEqual(['clipchan.db']);
  });
});

describe('recoverCorruptDb：有健康备份 → 自动恢复', () => {
  it('restore 成功 → 返回 restoredFrom（备份 basename），且绝不 quarantine', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    // 现库是坏的（截断的半截文件，打不开），备份是好的。
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dbPath, 'this is not a sqlite file at all');
    const backupPath = join(backupsDir(dataDir), backupFileName(at(10, 12, 0, 0)));
    makeDb(backupPath, 'from-backup');

    const quarantine = vi.fn(() => 'should-not-be-called.db');
    const res = recoverCorruptDb({
      dataDir,
      dbPath,
      looksCorrupt: () => true,
      quarantine,
      findBackup: () => backupPath,
      restore: copyRestore,
    });

    expect(res).toEqual({ restoredFrom: basename(backupPath) });
    expect(quarantine).not.toHaveBeenCalled();
    // 用户数据真的回来了。
    expect(readTag(dbPath)).toBe('from-backup');
  });

  it('走真 findLatestHealthyBackup / restoreBackup 也能恢复（端到端）', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dbPath, 'corrupted');
    // 造两个备份：新的坏、旧的好 —— 必须挑到好的那个。
    const dir = backupsDir(dataDir);
    const good = join(dir, backupFileName(at(9, 12, 0, 0)));
    const bad = join(dir, backupFileName(at(10, 12, 0, 0)));
    makeDb(good, 'good-backup');
    mkdirSync(dir, { recursive: true });
    writeFileSync(bad, 'broken backup');

    const res = recoverCorruptDb({ dataDir, dbPath, looksCorrupt: () => true, quarantine: () => 'x.db' });

    expect(res.restoredFrom).toBe(basename(good));
    expect(res.quarantinedFrom).toBeUndefined();
    expect(readTag(dbPath)).toBe('good-backup');
  });
});

describe('recoverCorruptDb：备份不可用 → 兜底挪开坏库', () => {
  it('有备份但 restore 失败 → quarantine，并带上 restoreFailure', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dbPath, 'corrupted');
    const backupPath = join(backupsDir(dataDir), backupFileName(at(10, 12, 0, 0)));
    makeDb(backupPath, 'unusable');

    const quarantine = vi.fn((p: string, d: string) => {
      const name = 'clipchan.corrupt-x.db';
      writeFileSync(join(d, name), 'moved');
      rmSync(p, { force: true });
      return name;
    });

    const res = recoverCorruptDb({
      dataDir,
      dbPath,
      looksCorrupt: () => true,
      quarantine,
      findBackup: () => backupPath,
      restore: () => ({ ok: false, reason: 'unhealthy-backup: 备份未通过 quick_check' }),
    });

    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      quarantinedFrom: 'clipchan.corrupt-x.db',
      restoreFailure: 'unhealthy-backup: 备份未通过 quick_check',
    });
    // 坏库被挪走了 → 调用方据此判 isFresh=true，会新建空库。
    expect(existsSync(dbPath)).toBe(false);
  });

  it('没有任何备份 → quarantine，restoreFailure=no-backup', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dbPath, 'corrupted');

    const quarantine = vi.fn(() => 'clipchan.corrupt-y.db');
    const res = recoverCorruptDb({
      dataDir,
      dbPath,
      looksCorrupt: () => true,
      quarantine,
      findBackup: () => undefined,
    });

    expect(res).toEqual({ quarantinedFrom: 'clipchan.corrupt-y.db', restoreFailure: 'no-backup' });
    expect(quarantine).toHaveBeenCalledTimes(1);
  });

  it('备份目录为空时也走 no-backup 兜底（端到端）', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dbPath, 'corrupted');

    const res = recoverCorruptDb({
      dataDir,
      dbPath,
      looksCorrupt: () => true,
      quarantine: (p, d) => {
        rmSync(p, { force: true });
        return 'clipchan.corrupt-z.db';
      },
    });

    expect(res.restoreFailure).toBe('no-backup');
    expect(res.restoredFrom).toBeUndefined();
    expect(existsSync(dbPath)).toBe(false);
  });

  it('主库已不存在时不调用 quarantine（rename 会 ENOENT 炸启动）', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    mkdirSync(dataDir, { recursive: true });

    const quarantine = vi.fn(() => 'nope.db');
    const res = recoverCorruptDb({
      dataDir,
      dbPath,
      looksCorrupt: () => true,
      quarantine,
      findBackup: () => undefined,
    });

    expect(quarantine).not.toHaveBeenCalled();
    expect(res.quarantinedFrom).toBeUndefined();
    expect(res.restoreFailure).toBe('no-backup');
  });

  it('restore 抛异常 → 当作失败走兜底，异常信息进 restoreFailure，不冒泡', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dbPath, 'corrupted');
    const backupPath = join(backupsDir(dataDir), backupFileName(at(10, 12, 0, 0)));
    makeDb(backupPath, 'whatever');

    const quarantine = vi.fn(() => 'clipchan.corrupt-t.db');
    const res = recoverCorruptDb({
      dataDir,
      dbPath,
      looksCorrupt: () => true,
      quarantine,
      findBackup: () => backupPath,
      restore: () => {
        throw new Error('EACCES: 拒绝访问');
      },
    });

    expect(res.quarantinedFrom).toBe('clipchan.corrupt-t.db');
    expect(res.restoreFailure).toBe('threw: EACCES: 拒绝访问');
  });
});

describe('maybeBackup：到间隔才备份', () => {
  const now = at(10, 12, 0, 0);

  /** 在备份目录里放一份"上一份备份"（只放名字，内容不重要）。 */
  function seedBackup(dataDir: string, stamp: number): string {
    const dir = backupsDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, backupFileName(stamp));
    makeDb(file, 'old-backup');
    return file;
  }

  it('距上次不到间隔 → ran=false，且不做备份、不 checkpoint', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    makeDb(dbPath, 'current');
    seedBackup(dataDir, now - 60 * 60 * 1000);

    const checkpoint = vi.fn();
    const res = maybeBackup({ dataDir, dbPath, checkpoint, now: () => now });

    expect(res).toEqual({ ran: false });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(readdirSync(backupsDir(dataDir))).toHaveLength(1);
  });

  it('距上次超过间隔 → ran=true 且真的落了一份新备份', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    makeDb(dbPath, 'current');
    seedBackup(dataDir, now - 25 * 60 * 60 * 1000);

    const checkpoint = vi.fn();
    const res = maybeBackup({ dataDir, dbPath, checkpoint, now: () => now });

    expect(res.ran).toBe(true);
    expect(res.result?.ok).toBe(true);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    const expected = join(backupsDir(dataDir), backupFileName(now));
    expect(res.result?.path).toBe(expected);
    expect(readTag(expected)).toBe('current');
  });

  it('从未备份过 → ran=true（首启动就留一份）', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    makeDb(dbPath, 'current');

    const res = maybeBackup({ dataDir, dbPath, checkpoint: () => {}, now: () => now });

    expect(res.ran).toBe(true);
    expect(res.result?.ok).toBe(true);
  });

  it('createBackup 内部失败（主库不存在）→ ran=true + ok:false，不抛', () => {
    const dataDir = tmpDir();
    const res = maybeBackup({
      dataDir,
      dbPath: join(dataDir, 'missing.db'),
      checkpoint: () => {},
      now: () => now,
    });

    expect(res.ran).toBe(true);
    expect(res.result?.ok).toBe(false);
    expect(res.result?.reason).toContain('no-db');
  });

  it('checkpoint 抛异常 → createBackup 收成 checkpoint-failed，不冒泡', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    makeDb(dbPath, 'current');

    const res = maybeBackup({
      dataDir,
      dbPath,
      checkpoint: () => {
        throw new Error('checkpoint 炸了');
      },
      now: () => now,
    });

    expect(res.ran).toBe(true);
    expect(res.result?.ok).toBe(false);
    expect(res.result?.reason).toContain('checkpoint-failed');
  });

  it('备份路径上任何异常（如时间源抛）→ 翻译成 ok:false/threw，绝不冒泡', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    makeDb(dbPath, 'current');

    const res = maybeBackup({
      dataDir,
      dbPath,
      checkpoint: () => {},
      now: () => {
        throw new Error('时钟坏了');
      },
    });

    expect(res.ran).toBe(true);
    expect(res.result).toEqual({ ok: false, reason: 'threw: 时钟坏了' });
  });

  it('自定义 intervalMs 生效', () => {
    const dataDir = tmpDir();
    const dbPath = join(dataDir, 'clipchan.db');
    makeDb(dbPath, 'current');
    seedBackup(dataDir, now - 2 * 60 * 60 * 1000);

    // 间隔 1 小时 → 2 小时前那份已经过期，该备份。
    expect(maybeBackup({ dataDir, dbPath, checkpoint: () => {}, now: () => now, intervalMs: 60 * 60 * 1000 }).ran).toBe(true);
    // 默认 24 小时 → 还不到点（注意上一步已经落了新备份，所以这里必然 false）。
    expect(maybeBackup({ dataDir, dbPath, checkpoint: () => {}, now: () => now, intervalMs: DEFAULT_BACKUP_INTERVAL_MS }).ran).toBe(false);
  });
});
